# 06 · off-peak 档位（空闲算力）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 与 start-plan 的关系：同为"免费/低成本"通道，但机制完全不同——start-plan 是配额计划，off-peak 是**服务端空闲算力队列**。

## 1. 语义

UI 工具 `OffPeakCreate` 的描述原文：

> "Create a one-off idle-time task queued for free off-peak execution... takes a queue ticket immediately and later runs unattended... **at no plan-quota cost**. There is no guaranteed start time."

即：off-peak 任务**不消耗套餐配额**，提交后拿票排队，由服务端在低峰期调度执行，无确定开始时间。与 `CronCreate`（定时/周期）相对。

## 2. 供应商标识与专属网关

```js
fXe = { zai: "account:zai-offpeak-idle-plan", bigmodel: "account:bigmodel-offpeak-idle-plan" }
SZi = resolveOffPeakProviderId
```

命名差异：档位叫 `off-peak`，供应商叫 `offpeak-idle-plan`。

**专属网关（runtime providerRules 实锤）**：off-peak 供应商的 `api.baseUrl` 为 `https://zcode.z.ai/api/v1/off-peak/anthropic`（隐藏 provider，`visibility: "hidden"`）——与 Start Plan 的 `.../zcode-plan/anthropic`、付费档的官方端点完全分离，空闲算力走独立通道。

## 3. 启用与可用性

### 3.1 远端开关

`_j` = `resolveOffPeakClientConfig`：

```js
enabled = clientConfigs.data.configs.offPeak.enable_offpeak_task === true   // 远端下发
       && providers.some(p => p.models.length > 0)                          // 至少一个可用模型
// 测试后门: env ZCODE_OFFPEAK_MOCK=1（配 ZCODE_OFFPEAK_MOCK_NO_PLAN=1 模拟无计划）
```

### 3.2 可用性规则（`Wj` = `createAccountProviderConnectionResolver`）

off-peak provider 的 `availability` 由已连接的付费档位决定：

```
available ⇔ providerFamilyDomain === accountType
         && 该家族的连接选择 kind ∈ {individual-coding-plan, team-coding-plan}
         && 同家族同 kind 的 provider 校验为 available
```

即 **off-peak 不独立 entitlement，而是"借用"已连付费档位在空闲窗口跑任务**；UI 文案 `offPeak.create.codingPlanOnly`（"仅限编程套餐"）与此吻合。

### 3.3 请求级鉴权

`ApiProviderModelRuntime.#r`：`mode === "off-peak"` 时注入 `requestDependencies.requestAuth.source`，模型执行时动态解析（`resolve(L)`），缺失抛 `ModelRequestAuthMissing`。配合服务端票据（见 §4）。

## 4. 票据（ticket）模型

- 请求头 `x-off-peak-ticket-id`（出现在日志脱敏集合 `RFs` 中）。
- 失败决策 `KDe` = `resolveOffPeakFailureDecision({offPeak, failure, error})`：
  - `ticketExpired`（错误串含 `opr = "off-peak-ticket-expired"`，`bZi` = `isOffPeakTerminalStatus` 相关）→ `retryable: false`，消息包装为 `"off-peak-ticket-expired: <原错误>"`（`ZDe`）；
  - `queued` → `retryable: true, retryAfterMs`，退避区间 `aLs=60s` ~ `sLs=5min`。
- 提示 `are`（abort 异常类型）→ 不可重试。

## 5. 任务与消息类型（RPC 协议）

| 类型 | 载荷 |
|---|---|
| `off-peak-run` | `{offPeakTaskId, workspacePath, workspaceIdentity?, prompt, permissionMode, modelSelection, conversationId}` |
| `off-peak-run-result` | `{offPeakTaskId, ok, conversationId?, sessionId?, error?}` + `failureKind: "transient"\|"permanent"` |
| `off-peak-scheduler-wake-request` | `{offPeakTaskId?}` —— 调度器唤醒 |
| 持久化组 | `OffPeakTask: "off-peak-task"`（存储命名空间）、默认组 `gZi = "zcode-default-group-off-peak"` |

终态集合：`completed / failed / cancelled`。

## 6. UI 能力（i18n key 清单，值见 [07](zcode-plan-07-UI文案与行为.md)）

- 操作：`offPeak.action.{cancel,continue,continueHint,pause,pauseHint}`
- 状态徽标：`offPeak.badge.{queuePosition,pausedPosition}`
- 创建：`offPeak.create.{defaultTitle,limitReachedAt,remaining.*,availabilityUnavailable,codingPlanOnly,codingPlanToast}`（有任务数量上限与剩余时间展示）
- 会话绑定：`offPeak.boundSession.*`、`offPeak.chatCreated.*`
- testId：`offpeak-create-card`、`offpeak-create-open`；设置里 "添加计划"（addSchedule）

## 7. 与 start-plan 的对照总结

| | start-plan | off-peak |
|---|---|---|
| 本质 | 免费配额计划（额度桶） | 空闲算力队列（票据） |
| entitlement | 独立 balance/entitlement 快照 | 无独立 entitlement，借用付费档位 |
| 消耗 | 消耗每日 token 额度 | 明确"不消耗套餐配额" |
| 请求签名 | 不启用（`cRs` false） | 不启用（`cRs` false） |
| 触发方式 | 作为普通模型供应商随时用 | 提交任务排队，服务端低峰调度 |
| 供应商 id | `account:<family>-start-plan` | `account:<family>-offpeak-idle-plan` |

## 8. 进程分工与票据 API 面（2026-09-28 静态还原，B 级）

**进程分工**（asar host + scheduler 束交叉验证）：**host 持有票据端点的请求构造与错误分类；scheduler 经 host RPC（`offPeak/create`、`offPeak/list`，见 [31 §6](zcode-plan-31-Cron调度循环.md)）触发，自身不打任何 off-peak HTTP**（scheduler 束内 `/api/v1/off-peak` 0 命中，仅有 `off-peak-scheduler-wake-request` 唤醒事件与任务状态机）。off-peak 会话 `offPeakRunType ∈ {init, resume}`，带 `expectedRevision` 乐观并发。

**票据 API 面**（端点注册表实抓，5 条路由）：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/v1/off-peak/ticket/availability` | 票据可用性查询 |
| `POST` | `/api/v1/off-peak/ticket` | **签票** |
| `POST` | `/api/v1/off-peak/ticket/status` | 票据状态轮询 |
| `SETTLE` | `/api/v1/off-peak/ticket/<ticketId>/settle` | 核销/结算 |
| `POST` | `/api/v1/off-peak/anthropic/v1/messages` | 模型请求（带票） |

**双凭证**（模型与票据请求同构）：`authorization: Bearer <zcodejwttoken>` + **`x-coding-plan-api-key: <codingPlanApiKey>`** 同时携带——"借用付费档位"的机制层：off-peak 的身份由两把钥匙共同构成。响应经信封校验（`safeParse`），超时用 `AbortSignal` 组合。

**任务创建失败分类**（schema 实录）：`failureStage ∈ {client_validation, ticket_request, local_persist}`；`errorCategory ∈ {client_validation, eligibility_3101, quota_3103, network, invalid_response, local_persist, unknown}`——**`3101`（资格）与 `3103`（配额）为 37 号未收录的新业务码**。任务运行时形状：`{serverTicketId?, conversationId?, sessionId?, prompt, permissionMode, modelSelection}`。

**仍未实测（剩两样）**：① 上述端点的**响应载荷**（availability 的返回结构、status 的状态枚举）——静态 schema 已定位但值域待真包；② 真跑一次任务的全链行为。本机运行史（1773 处巡检、0 签票）见下。

## 9. 实测附注：本机运行史（2026-09-27）

host 日志（`~/.zcode/v2/logs/*.log`，两天存量）中 off-peak 相关 1773 处**全部**是 30 秒巡检 RPC `off-peak-task.list`（见 [31](zcode-plan-31-Cron调度循环.md)）；票据签发/续期事件 **0 次**——本机没有任何 off-peak 任务真正运行过。因此 §8 的端点面（availability/签票/status/settle）在本机存量中无一次真实调用，响应载荷仍待真跑一个任务取实包；届时 `tasks-index.sqlite` 的 `off_peak_tasks.server_ticket_id`（见 [14](zcode-plan-14-本地存储全schema.md)）即可直接核对。
