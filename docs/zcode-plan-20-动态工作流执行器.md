# 20 · 动态工作流执行器（DWF）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 存储层见 [14 §1.3](zcode-plan-14-本地存储全schema.md)；本文覆盖执行侧
> 来源：`zcode.cjs` DWF 运行时（`Xj` 限制表、节点 schema、actor 解析）

## 1. 双层工作流体系

| | workflow_*（脚本工作流） | dwf_*（动态工作流） |
|---|---|---|
| 定义 | TypeScript 脚本（CreateWorkflow/SaveWorkflow，definition 表，trusted 位） | 内联编排（dwf_run.script_text + args_json） |
| 执行 | workflow_run/activity 事件驱动 | dwf_node 按 site_id+ordinal 网格调度 |
| 节点状态 | queued/running/completed/failed/skipped/cancelled/cached/lost | running/completed/failed |

## 2. 节点类型（dwf_node.kind，CHECK 约束）

```
ask          # 向人提问（ResolveWorkflowQuestion 对接）
world-read   # 世界读取（只读操作）
world-run    # 世界执行（副作用操作）
report       # 汇报节点
artifact     # 产物节点（artifact_id 关联）
```

每个节点绑定 actor（`dwf_actor`：persona_json 人设 + resolved_model），构成 **"角色 × 站点 × 序号"** 的三维调度网格（unique(run_id, site_id, ordinal)）。

## 3. 节点 schema 与硬限制（`Xj` 限制表）

```js
Xj = { maxNodes: 2000, maxOpLength: 32, maxArgs: 16,
       maxErrorMessageLength: 2000, resultMaxBytes: 32*1024 }

KQi = enum(["world-read", "world-run"])   # 世界操作两类
YQi = { siteId(≤64), ordinal, kind, op(≤32字符), args(≤16), status, error{code≤64,message}, ... }
ZQi = { resultBytes, resultCount?, exitCode?, stdoutBytes?, stderrBytes? }
```

- 节点输入带 `input_hash`（幂等/缓存键）+ `input_truncated` 标记（截断存库）。
- 结果截断到 32KB 入库，完整结果走 artifact（`artifact_id`）。

## 4. 运行容量与续跑

- `dwf_run.caps_max_concurrency`（每次运行显式声明并发上限）+ `spent_tokens` 累计。
- `resumed_from`（被 amend 的旧 run id）——AmendWorkflow 的新 run 继承旧 run 成果（journal 重放），与 `workflow_run.args_hash` 缓存键配合实现"只重付变更部分"。
- 快照裁剪：`clampWorkflowRunsForLegacy` + `clampKeepingLive`——旧客户端兼容时保活 run、裁剪历史节点（上限 2000 节点）。

## 5. 与会话/工具层的接口

- `dwf_run.tool_call_id` —— DWF 由某个工具调用（CreateWorkflow）发起。
- `dwf_actor.session_id` —— actor 绑定到实际执行的子会话（[21](zcode-plan-21-子代理运行时.md)）。
- 节点 `ask` 类型阻塞时通过 `ResolveWorkflowQuestion` 升格给用户（云侧 parked，见 [17](zcode-plan-17-云端会话与远程体系.md) 的会话命令通道）。
- 云同步：`v4/conversation/workflowRun*` **七个方法逐一核实**（[17 §8](zcode-plan-17-云端会话与远程体系.md)）+ `workflowRunDeltas` 订阅选项；ArtifactData 支持 **`afterSequence` 增量分页**（工件数据断点续传）。

## 6. 运行时控制流（函数族挖掘 2026-09-27，B 级）

以下为 `create.workflow`/`build.workflow`/`format.workflow` 家族函数体实读（锚点：`TWo`/`hWa`/`Mye`/`jAn`/`pVo`/`cH`/`LAn`）。

### 6.1 座位闸（`createWorkflowRunSeatGate` = `TWo`）

- actor 级并发闸：`limit = max(1, floor(limit))` 个座位；座位满时 ask **FIFO 停泊**，`unpark` 补位。
- 让座条件不是 ask 结束：`needsSeat = 有座位 && toolsInFlight()===0`——**工具全部落定才释放**。
- AbortSignal 感知：abort 时从停泊队列摘除并 refuse；`setLimit` 运行中可调并立即补位。

### 6.2 并发治理器（`createWorkflowConcurrencyGovernor` = `hWa`；`Mye` = ConcurrencyController）

- 按 key 分桶，每桶一个自适应控制器：`{ceiling 配置上限, cap 当前帽, epoch, successStreak, cooldownUntil, lastGood/lastBad}`。
- **AIMD 算法**：连续 4 次成功且有排队者、cap<ceiling → `cap += 1`（"recovered" 变更事件，慢爬）；被限流 → successStreak 清零、cap 回退到 `lastGood`（原帽记 `lastBad`），并按服务端 retry-after 设 `cooldownUntil` 冷却。
- 事件面：`model_request_started` 忽略 / `model_request_completed` → succeeded / `model_retry_scheduled` → throttled；`epoch` 不匹配的信号忽略——amend 重置并发后旧世代响应不污染新世代。
- 与 §4 `caps_max_concurrency` 的关系：静态声明是 ceiling，cap 是运行时自适应值。

### 6.3 运行控制与升格注册表

- `createWorkflowRunControl`（`jAn`）：`setMaxConcurrency` 运行中**双写** run 引擎 + seatGate——AmendWorkflow `max_concurrency` 参数的执行通道。
- `createWorkflowEscalationRegistry`（`pVo`）：ask 升格的本地权威注册表——`park/withdraw/resolve`，退役表上限 256。`resolve` 三态拒绝：`already_resolved`（子代理已带答案继续，无需再答）、`run_not_in_flight`（run 已取消或 ask 已失败，先 GetWorkflowRun）等——即 [17](zcode-plan-17-云端会话与远程体系.md) 云侧 parked 的本地实现。

### 6.4 阶段模型与运行体格

- `createWorkflowPhaseAlongside`（`cH`/`Bbr`）：run 可声明 `phases[{name, alongside[]}]`，alongside 为并行阶段 id，解析为索引映射；阶段数有上限常量（`Mte`）。
- `buildWorkflowRunRoster`（`LAn`）输出 `phases`/`subagents`/`health` 三块：health 含 `stalledSince`（停滞检测）、`consecutiveFailures`、`cachedSteps`、`leftoverRunning`、`pendingQuestionsKnown`、`concurrency{limit/ceiling/cap}`；由 `format.workflow` 家族渲染为 GetWorkflowRun 的观测文本（health/logTail/phases/subagents 四个 block）。
