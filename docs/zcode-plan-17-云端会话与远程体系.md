# 17 · 云端会话与远程体系（v4 RPC / relay WS / remote）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：`zcode.cjs` 的 v4 协议常量表（`h0` 请求方法 + `jV` 推送帧，字段级完整提取）

## 0. 定位

这套体系是 **ZCode 桌面/agent 与 zcode.z.ai 之间的实时同步与远程控制层**——网页端看会话、远程下发任务、云持久化、分享都走它。与模型请求（[08](zcode-plan-08-聊天对话接口.md)）完全分离。

```
传输:  REST  https://zcode.z.ai/remote/v4      （v3 为旧版）
       WS    wss://zcode.z.ai/ws               （relay 长连接）
回调:  /web-remote/callback                   （网页远程控制回调）
       /cn/share/callback                     （会话分享回调）
```

## 1. v4 请求方法全表（h0，字段级提取）

| 类别 | 方法 |
|---|---|
| 连接 | `v4/connection/flow` |
| 控制器订阅 | `v4/controller/subscribe` / `resync` / `unsubscribe` |
| 会话订阅 | `v4/conversation/subscribe` / `resync` / `unsubscribe` |
| 会话数据 | `v4/conversation/rowsRange`（消息行区间）、`plans`、`fileChanges`、`backgroundBashOutput`、`fileRewindPreview`（**文件回退预览**） |
| 工作流运行 | `v4/conversation/workflowRunEvents` / `workflowRuns` / `workflowRunArtifacts` / `workflowRunArtifactData` / `workflowRunArtifactRead` / `workflowRunWorkspace` / `workflowRunNodeResult` |
| 用量 | `v4/usage/stats`、`v4/conversation/usage` |
| 附件 | `v4/attachment/begin` / `chunk` / `commit` / `abort` / `read`、`v4/conversation/attachmentRead` / `attachmentStat`、`v4/attachment/previewSource` |
| 命令 | `v4/commands/query`、`v4/command` |

**推送帧（jV）**：`v4/conversation/frame`（会话增量帧）、`v4/telemetry/event`、`v4/telemetry/local-ttft`（本地首 token 延迟遥测）、`v4/cua/permission-observation`（Computer Use 权限观测）。

## 2. 订阅模型（pub/sub over relay）

- **主题（topic）带类型前缀 + 长度校验**：`conversation/<id>`、`sessions-index/<…>`、`workspace-config/<…>`（superRefine 校验前缀与长度，如 conversation topic 长度 ≠ 13）。
- **订阅断点**：`{subscriptionId, base: {logEpoch, seq} | null, forceSnapshot}`——**log epoch + 序号游标**做增量续传，可强制快照。
- 客户端连接声明：`{connectionId, clientMode, workspace?, legacyTaskIds[](≤200), resumeThoughtLevel?, workflowRunDeltas?}`。

## 3. 两种客户端模式

```js
wV = m.enum(["desktop-continuous", "web-remote-replayable"])
```

- `desktop-continuous`：桌面端常连接（本地会话实时上云）。
- `web-remote-replayable`：网页端远程接入（可回放）——网页端可以**远程下发命令到桌面**。

## 4. 远程命令（web → 桌面）

| 命令 | 说明 |
|---|---|
| `enqueue_task_command` | 网页端把任务入队到桌面 |
| `promote_task_command` / `cancel_task_command` | 提升/取消（均带 `clientMode: web-remote-replayable`） |
| `attach-service-port` / `detach-service-port` | **远程端口转发**——把桌面侧服务端口附加到远程会话（带 scope） |
| `broadcast` / `dispose` | 广播 / 会话销毁 |
| 请求都带 `requestId` + `remoteSessionId` | |

CUA（Computer Use）tab 协议方法：`listUserTabs`、`claimTab`、`markDeliverable`、`markHandoff`、`nameSession`、`turnEnded`、`closeSession`、`cancelRequest`、`close`、`list`。

消息来源枚举（`Lpe`）：`background_task`、`fork`、`goal_state_change`、`goal-continuation`、`plugin_reference`、`rewind`、`selection_side_chat`、`subagent`…——标记每条输入/事件的产生路径。

## 5. 认证

- 会话同步建立在 ZCode 云身份上：`zcodejwttoken`（同 balance 接口，见 [02 §5](zcode-plan-02-认证与凭证存储.md)）；WS 建立点在 host 进程（CLI bundle 内无 WS 连接代码）。
- 401 时由 `NodeApiClient` 的 `isZcodeJwtRequest` / `onZcodeJwtInvalid` 链路感知 JWT 失效（见 [10 §6](zcode-plan-10-OAuth登录流程.md)）。

## 6. 未实测项

WS 握手帧格式与 `v4/connection/flow` 的完整握手序列未实测（该通道承载当前活跃会话）；以上为协议常量与 schema 的完整静态还原。分享功能（`/cn/share/callback`、`session.share_url` 字段）的服务端行为未实测。

## 7. 会话事件存储与驻留（2026-09-27 函数体实读，B 级；锚点 `J_r`/`BQe`/`aGo`/`UKo`/`n1o`）

**① 事件保留策略**（`createSessionEventRetentionPolicy` = `J_r`）：`"unbounded"` → 不限；否则 **`turn-window`**（默认）。**瞬态事件集**（不入长期保留）：`ModelStreaming`、`ToolCallProgress`、`StreamingToolLedgerUpdated`、`ModelNetworkStatus`，窗口常量 `G_r = 12e4` = **120 秒**。存储器 `InMemorySessionEventStore`（会话 Map + 每 session 独立 policy）——§2 pub/sub 与 logEpoch 断点的底座。

**② 会话驻留池**（`createSessionResidentPoolHost` = `aGo`）：会话运行时是否常驻由 **residency facts** 判定——`hasPendingInteractions`（v4 交互挂起）、`hasQueuedCommands`（v4 网关有阻驻留命令）、`hasLegacySubscriber`（旧流订阅）、`hasResidencyBlockingWork`（活跃 abort 控制器 / finalization 计数 >0 / runtime 自报）、`hasSubscribers`（会话订阅者）、`lastActivityAt`、`persisted === "immediate"`。`deactivate` 显式下电。

**③ v4 `session/create` 校验语义**（`createSessionWithProjection` = `UKo`）：**`sessionId` 参数仅允许在 imported history 创建时传入**，否则 JSON-RPC `-32602`；workspace 以 `{workspaceKey, workspacePath}` 声明；初始 model/thoughtLevel 可选；persistence 模式随创建声明；观测事件 `zcode_protocol.session_create.started`（module `bootstrap.zcode_protocol`）。

**④ 会话级 shell 选择**（`getSessionShellEnvironment` = `t6e` 族）：`config.bashShellSelection` 会话级存取，切换即刷新 pre-conversation context（`Wwa`）；promptShell 显示名随 selection 走。bash 工具的运行 shell 由会话持有，非全局（[15](zcode-plan-15-工具与权限体系.md) 的执行环境侧）。

**⑤ 子会话端口派生**（`getSessionEventStore` 闭包 = `n1o`/`o1o`）：父会话对子运行时暴露 `eventStore` 与派生端口（permissionBroker/providerRuntimeHeadersPort 重路由，见 [21 §5.3](zcode-plan-21-子代理运行时.md)）；contextBuilder 惰性初始化于 config-only 快照（`persistEnvInfo:false`）。

## 8. workflow artifact 云同步（2026-09-28 确认，B 级）

`v4/conversation/` 下的 workflowRun 族**恰好七个方法**（与 [20 §5](zcode-plan-20-动态工作流执行器.md) 记录吻合，逐一核实）：`workflowRunEvents` / `workflowRuns` / `workflowRunArtifacts` / `workflowRunArtifactData` / `workflowRunArtifactRead` / `workflowRunWorkspace` / `workflowRunNodeResult`。

- **Artifacts**：入参 `{sessionId, runId}` 列举 run 的工件清单；
- **ArtifactData**：入参 `{sessionId, runId, artifactId, afterSequence?}`——**`afterSequence` 增量分页**，工件数据按序号断点续传（与 §2 的 logEpoch/seq 断点模型同思路）；
- **Workspace / NodeResult**：run 的工作区视图与逐节点结果；
- 同表还确认了跨文档方法名：`fileChanges`、`fileRewindPreview`（[24](zcode-plan-24-文件变更与回滚.md)）、`backgroundBashOutput`、`rowsRange`、`plans` 均在 v4/conversation 命名空间下。

## 9. 会话分享协议（2026-09-28 字段级还原，B 级）

§6 挂过的"分享功能服务端行为未实测"——客户端协议面已**字段级还原**：cjs 导出表 20+ 个 `conversationShare*` zod schema（`conversationShareService` 在 host 侧）。

### 9.1 访问模式与核心词汇

- `AccessMode` = **`private` | `public_readonly` | `public_importable`**（可导入 = 接收方可把会话导入自己的客户端）
- sha256 字段统一 `^[0-9a-f]{64}$`；schema_version 常量 = 1
- 工件描述符基座：`{artifact_id, logical_artifact_key, producer_product_turn_id, artifact_version, state:"current", ref:"zcode-artifact://share/…"}`

### 9.2 四阶段协议（字段级）

**① 准备**
- 请求：`{client_request_id, title, schema_version:1, access_mode, payload_sha256, artifact_count}`
- 响应：`discriminatedUnion("status")` —— `{preparation_id, access_mode, expires_at, status:"preparing"}` 或 `{…, status:"confirmed", share:{share_code, share_url, access_mode, expires_at}}`

**② 能力协商**（服务端下发限额；Data/Wire 双形态，`narrowConversationShareCapabilities` 收窄）
- 限额六项：`ttl_ms` / `max_rows` / `max_payload_bytes` / `max_artifact_count` / `max_artifact_bytes` / `max_total_artifact_bytes`
- Wire 的 access_modes/allowed_artifacts 为字符串形态，Data 为枚举/强类型

**③ 确认（含披露确认）**
- 请求：`{selected_product_turn_ids≥1, projection:{rows≥1}, integrity:{projection_sha256, artifact_set_sha256}, disclosure_confirmation:{version:1, accepted_at, acknowledged_no_secret_detection:true}}`
  —— **分享者必须确认"已知晓密钥扫描"**（acknowledged_no_secret_detection 恒为 true）
- 响应：`{share_code, share_url, access_mode, expires_at}`

**④ 工件上传**
- 每工件：`{artifact_id, size_bytes, sha256, status:"uploaded", safety_status}` —— 上传后带 **safety_status（安全扫描状态）**
- 媒体白名单：.mp4/.mov/.webm/.m4v（video 类）

**⑤ 续接/导入**
- 请求：`{schema_version, client_request_id}`
- 响应：`{schema_version, import_grant_id, import_grant_expires_at, share:{title, access_mode, created_at, expires_at, share_id}, rows[], artifacts:[…+download_url+download_url_expires_at], integrity}`
  —— `import_grant_id` + 过期时间：public_importable 模式下接收方凭 grant 导入

### 9.3 错误码族（新）

KnownErrorCode = **3001, 3002, 3200–3215**（16 个分享专属码）+ ErrorEnvelope `{code, msg}`。3200 系为分享协议专有——[37 §2.3](zcode-plan-37-排障手册.md) 业务码表的补充。

### 9.4 完整性模型

双层 sha256：`projection_sha256`（会话行投影）+ `artifact_set_sha256`（工件集合）——行与工件分开校验。工件上传逐个带 sha256 与 safety_status。

### 9.5 判读（C 级）

分享 = **带披露确认与安全扫描的多阶段上传协议**：准备→能力协商→确认→分块上传→续接/导入。密钥扫描 + safety_status 说明服务端对分享内容有安全审查管道；import_grant 说明 public_importable 的接收端有一段限时的导入授权窗口。§6 的"服务端行为未实测"收敛为：客户端字段面已还原，**服务端各阶段端点的实际行为仍待实测**。
