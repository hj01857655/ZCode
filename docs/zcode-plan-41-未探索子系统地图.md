# 41 · 未探索子系统地图（zcode.cjs 自有面长尾）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 工具：`tools/cluster_symbols.py`（TS 差集 + 聚类 + 文档求交，全程可重跑）
> 性质：**B 级静态**——只读名字与聚类结果，未读函数体；本文所有"语义推断"列均为 **C 级**

## 0. 结论

1. bundle 保留长名 20,753 个中，**约一半是 vendored 的 TypeScript 语言服务**（官方 5.9.2 标识符即可对上）——开源代码，无逆向价值。直接按"名字覆盖率"看长尾会严重误读。
2. 减去 TS 后 **ZCode 自有面 = 10,936 个长名**，42 篇文档触达 329 个（**3.0%**），完全未触碰 10,607 个（2026-09-27 八锹后回填）。此前"0.5% 覆盖"的口径是未剔 TS 的毛估值，以本篇为准。
3. 自有面聚成 8,112 个两段家族，**文档零触碰的家族 7,902 个**。头部家族词汇清晰指向已文档化子系统的**函数族层**——41 篇专题写的是"承重墙 + 存储结构 + 协议"，各子系统的运行时函数族基本没点名，这就是本篇的地图。

## 1. 方法（三步，可复现）

```
① bundle 内 ≥10 字符 camelCase 字符串字面量        → 20,753 个
② 减去官方 TypeScript 5.9.2 全部标识符（21,254 个） → 自有面 10,936 个
③ camelCase 前两段聚类 → 家族；与 docs/*.md 原文求交 → 已覆盖/未触碰
```

残差说明：`parse.jsx`/`create.node` 等少量家族仍是 TS 残留（bundle 内嵌 TS 版本与 5.9.2 的命名差异），占比小（<2%），不影响地图判读。TS 副本缓存在 `tools/_ts_cache/`，脚本缺失时自动从 npm 拉。

## 2. 家族地图（top 40 按成员数；语义列 = C 级推断）

### 2.1 ZCode 专属判定与解析（`*ZCode*` 直呼其名，52 个）

| 家族 | 成员 | 语义推断 |
|---|---|---|
| `is.z` | 20 | ZCode 实体判定：provider/telemetry key/attachment 错误码 |
| `resolve.z` | 12 | API origin、后台任务控制类型、内置缓存路径 |
| `get.z` | 11 | agent 模式清单/选项/运行时 |
| `normalize.z` | 9 | 重试状态、端点 origin 归一化（26 号遥测的外围） |

### 2.2 会话与任务

| 家族 | 成员 | 语义推断 |
|---|---|---|
| `get.session` | 16 | ✅ **已挖（落 17 §7）**：事件存储（保留策略 unbounded/turn-window、瞬态集 120s 窗口）、驻留池 residency facts、v4 session/create 校验（-32602）、会话级 shell 选择、子会话端口派生 |
| `read.session` | 13 | ✅ **已挖关键件（落 24 §5）**：rewind 事件链过滤（strategy ActiveChain + scope Conversation/Both 才进链）；goal 完成验证事件独立持久化读取 |
| `create.session` | 13（触 2→5） | ✅ **已挖关键件（落 17 §7①③）**：保留策略工厂、驻留池 host、WithProjection 的 imported-history 限定 |
| `runtime.task` | 9 | 后台任务描述/完成时刻/错误（26 号"背景任务"的函数层） |
| `wait.for` | 24（触 2） | 浏览器 spawn、回调、abort 组合的等待原语 |

### 2.3 工作流与子代理（20/21 号的函数族缺口）

| 家族 | 成员 | 语义推断 |
|---|---|---|
| `create.workflow` | 15 | ✅ **已挖（落 20 §6）**：座位闸 FIFO 停泊、AIMD 并发治理器（连续 4 成功 cap+1 / 限流回退 lastGood + Retry-After 冷却）、escalation 注册表三态拒绝 |
| `build.workflow` | 12 | ✅ **已挖（落 20 §6.4 / 21 §5.4）**：roster 三块（phases/subagents/health，含 stalledSince 停滞检测）；actor 身份提示词全文 |
| `format.workflow` | 12 | ✅ **已挖（落 20 §6.4）**：GetWorkflowRun 观测四 block 渲染层 |
| `create.subagent` | 12 | ✅ **已挖（落 21 §5）**：生命周期文件布局（zcode-agents 三件套）、活动看门狗（CHILD_RUNTIME_FAILED/retryable）、权限重路由父会话、身份提示词全文 |

### 2.4 模型与协议（08/09/30 号的函数族缺口）

| 家族 | 成员 | 语义推断 |
|---|---|---|
| `create.model` | 17 | ✅ **部分已挖**：catalog/config/selection 构造族（30 号映射层的上游） |
| `resolve.model` | 14（触 1→3） | ✅ **已挖关键件（落 37 §2.2⑦）**：workflow_child 重试预算 Unbounded、流空闲超时 10min+30s×retry、每步 max_output 预算公式；家族规格解析链落 [10 §0.1](zcode-plan-10-OAuth登录流程.md) |
| `is.model` | 10 | ✅ **已挖（落 37 §2.2①②③）**：context-exceeded 三层启发式、media-too-large、suspicious-empty |
| `convert.to` | 13 | ✅ **已挖（落 08 §4.2）**：性质判定——大半为 vendored AI SDK 适配层；增量 = cache_control 注入点（`cIs`）、`tool-approval-request` 内部块永不出网、agent→MCP server 转换（C 级） |
| `is.response` | 14 | ✅ **已挖（2026-09-27，落 09 §2.4）**：18 类 `response.*` 流块载荷 schema + 8 项 provider 内置工具映射 + apply_patch 工具本体；假设"08 号缺 apply-patch"修正为"09 号已有事件名、缺载荷与工具层" |
| `create.provider` / `is.provider` / `resolve.provider` / `normalize.provider` | 12/11/9/9 | ✅ **已挖（落 37 §2.2④⑤⑥）**：业务码 BFS 提取链、retry-after 三格式 + x-should-retry 否决、TLS 归一；三协议→AI-SDK kind 映射（`aRs`）补 09 号 |

### 2.5 运行时与执行

| 家族 | 成员 | 语义推断 |
|---|---|---|
| `create.runtime` | 14 | ✅ **已挖关键件（落 26 §6④ / 23 §4）**：HookRunner 三层构造条件、命令队列 task-notification 批量出队 |
| `resolve.runtime` | 11（触 2→9） | ✅ **已挖（落 26 §6①②③ / 21 §5.5 / 15 §7）**：browserUse 双条件、surface/distribution 枚举、ZCODE_ENV 端点矩阵 + **relay WS `wss://zcode.chatglm.site/ws`** 落名、权限上下文三元组、workflow_child 五工具禁用 |
| `read.runtime` | 10 | ✅ **部分已挖（落 26 §6③）**：env-scoped 值选择、origin 校验、e2e localhost 白名单；issue 读取族未展开 |
| `create.bash` | 11 | bash 工具 schema/handler/性能遥测（15/19 号的工具层函数族） |
| `create.tool` | 10 | 工具执行器、调用 id、失败错误 |
| `is.compact` | 11 | ✅ **已挖（落 18 §3.4）**：管线切分/保留段策略/时间线拼装；**microcompact 实名 `maybeLocalMicrocompactMessages`**（工具结果原地裁剪）；auto 阈值 config 下发 nullable、Auto 系数 `jPo=3` |

### 2.6 周边子系统

| 家族 | 成员 | 语义推断 |
|---|---|---|
| `resolve.workspace` / `create.workspace` | 14/10 | 工作区/git 分支解析；hook 注册表快照与声明摘要（23 号） |
| `resolve.plugin` | 12 | ✅ **已挖（落 16 §5/§6）**：配置来源逐键溯源（user/workspace）、storageRoot 派生、marketplace 排序算法（guides→utilities、other 恒最后）；插件可携带 MCP servers |
| `create.mcp` | 10 | ✅ **已挖（落 23 §3）**：连接池（空闲宽限 30s）、deadline 竞速、传输层代理/CA + PATH 自修复、工具准入三档权限 + node_repl artifact 特判 |
| `format.read` / `format.human` / `format.command` | 11/10/9 | 工具输出与人读格式化（35 号输出样式的消费端） |
| `is.valid` | 34 | 杂项校验（token/base64/payload），低优先 |
| `parse.jsx` / `create.node` | 19/19 | TS 残留噪声，忽略 |

## 3. 建议开挖顺序（C 级）

1. ~~**`is.response`**~~ → **已完成（2026-09-27）**：18 类流块载荷 + 内置工具映射表已落 [09 §2.4](zcode-plan-09-OpenAI兼容与Responses协议.md)，08 号矩阵确认无缺口；
2. ~~**`create/build/format.workflow` + `create.subagent`**~~ → **已完成（2026-09-27）**：运行时控制流落 [20 §6](zcode-plan-20-动态工作流执行器.md) 与 [21 §5](zcode-plan-21-子代理运行时.md)；
3. ~~**`create/resolve.model` + provider 错误家族**~~ → **已完成（2026-09-27）**：落 [37 §2.2](zcode-plan-37-排障手册.md)；剩余：`createModelCatalogPort`/`createModelAdapter` 等目录层未展开；
4. ~~**`is.compact` + compaction**~~ → **已完成（2026-09-27）**：落 [18 §3.4](zcode-plan-18-系统提示词与上下文管理.md)；compact 词根 38 个长名中管线/保留/裁剪/快照/失败五层已读，事件与 UI 层归 07/14 号；
5. ~~`resolve.plugin`/`create.mcp`~~ → **已完成（2026-09-27）**：落 [16 §5](zcode-plan-16-插件系统.md) 与 [23 §3](zcode-plan-23-Hooks与MCP客户端.md)。**建议顺序五条全部关闭**——后续按 §2 各带剩余家族与 §4 边界（app.asar 侧）另立节奏。

## 4. 边界

- 本篇只覆盖 `zcode.cjs`（agent/CLI 侧）；`app.asar` 侧已于 2026-09-27 开线，见 [42](zcode-plan-42-AppAsar自有面地图.md)（工具 `tools/asar_symbols.py`）。
- 家族语义均为名字推断，读函数体并落回对应专题文档后才升级；每挖一个家族应把成员函数回填到 01–40 号对应章节，而不是堆在本篇。
