# 21 · 子代理运行时

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：`zcode.cjs` agent 状态管理（`createAgentStateId`、内置/插件代理模型覆盖）+ DB 关联表

## 1. 代理类型体系

- **内置代理**：`Explore`（只读检索）、`general-purpose`（全能力）——两者有专属的**模型覆盖通道**：`builtInModelSelectionOverrides`（新版）或 `builtInModelOverrides + builtInThoughtLevelOverrides`（旧版），覆盖值经 `Pu`/`uee` schema 校验，`builtin:` 前缀 provider 会被规范化。
- **插件代理**：来自插件 `agents/` 目录（Markdown 定义，见 [16](zcode-plan-16-插件系统.md)），有独立的覆盖通道 `pluginAgentModelSelectionOverrides`。
- **用户自建代理**：设置页表单（`settings.subagents.form.*`：name/description/tools 禁用清单/skills/后台运行/**注入 AGENTS.md** 开关/系统提示词）。

每类代理有独立状态 ID（`createAgentStateId` / `createPluginAgentStateId`）。

## 2. 派生与通信

| 机制 | 实现 |
|---|---|
| 派生 | `Agent` 工具 → 新建子会话（session.parent_id 指向父会话）+ `session_task_link` 记录（role/depth/path 构成链接树） |
| 事件 | 会话事件 `subagent_spawned` / `subagent_message` / `subagent_stopped` |
| 父→子 | `SendMessage`（agentId 寻址 `agent_<uuid>`，完成后的 agent 可 resume 到后台） |
| 子→父 | 完成时最终消息作为工具结果返回父会话 |
| 后台 | `run_in_background` + `TaskOutput`/`TaskStop` 管理（输出走文件而非上下文） |
| 上下文读取 | `ReadSessionContext`——按 sessionId 读取**别的**持久化会话（relevant 摘要 / handoff 全量交接两种策略） |

## 3. 隔离边界

- 子代理有独立上下文装配（AGENTS.md 注入按代理开关，见 [13 §4](zcode-plan-13-AGENTS.md支持.md)）。
- 权限模式继承父会话（`model_usage.mode` 记录的是当时会话模式），但工具能力按代理定义的 disallowedTools 收窄。
- Start Plan 推荐弹窗专门支持把**子代理**的模型切到 Start Plan（`startPlan.recommendation.subagentDescription`，见 [07 §2](zcode-plan-07-UI文案与行为.md)）——父子代理可以分属不同 provider。

## 4. 与工作流的衔接

- `session_task_link.root_workflow_run_id`——子代理会话可挂在某个 workflow run 之下（深度树）。
- `dwf_actor.session_id`——DWF 的 actor 执行体就是子会话（见 [20 §2](zcode-plan-20-动态工作流执行器.md)）。
- 云同步：每个子会话独立同步（`sessions-index` 主题 + `SubagentSpawned` 事件，见 [17](zcode-plan-17-云端会话与远程体系.md)）。

## 5. 运行时函数族（2026-09-27 函数体实读，B 级；锚点 `_So`/`Jya`/`mko`/`RJs`）

### 5.1 生命周期与文件布局（`createSubagentLifecycle` = `_So`）

- `agentId = agent_<uuid>`；`childSessionId = subagent_<agentId>` 前缀派生。
- 输出目录默认 `os.tmpdir()/zcode-agents/<parentSessionId>/<agentId>/`，三件套：`metadata.json`、`output.txt`、`task.output`。
- 双 trace 上下文：父侧（sessionId/turnId + agentId/agentType/parentToolCallId）与子侧（childSessionId + parentSessionId）——`model_usage` 的 trace 关联由此而来。

### 5.2 活动看门狗（`createSubagentActivityWatchdog` = `Jya`）

- `timeoutMs` 有效才启用，活动即重置；超时 → `ToolTimeout`（code `CHILD_RUNTIME_FAILED`，**recoverable + retryable**）并 abort；日志事件 `subagent.activity_timeout`（模块 core.subagent）。Explore 型子代理挂此看门狗。

### 5.3 交互代理（`createSubagentInteractionBroker` = `mko`）

- 子代理权限请求**重路由到父会话**（sessionId 换 parentSessionId，origin 注入溯源元数据）；`providerRuntimeHeadersPort` 同样按父会话重定向（`Nba`）——模型请求头的会话级刷新挂父会话。

### 5.4 Workflow Actor 身份提示词（`buildWorkflowActorIdentityPrompt` = `RJs`，全文实录）

> You are a subagent inside a dynamic workflow run[, named "X"]. A script created you and hands you work one ask at a time; the script — not a person — consumes what you return. There is no user in this conversation to talk to.

后接 persona（`dwf_actor.persona_json`，见 [14](zcode-plan-14-本地存储全schema.md)）与两段固定节：

> You have the regular working tools — reading, searching, editing, running commands — plus `submit_result` and `escalate`. There is no tool that asks a person anything.
> Ground every claim in something you read or ran in this ...（地面化要求，接具体约束）

注入为 section：`{name:"Workflow Actor Identity", source:"workflow_actor_identity", injectionTarget:"system", cacheHint:"stable"}`——与 [18](zcode-plan-18-系统提示词与上下文管理.md) 装配器 schema 对接。actor 可用工具即普通工作工具 + `submit_result`/`escalate`，显式无问人通道。

## 5.5 工具集解析（2026-09-27 函数体实读，B 级；锚点 `STo`/`X4e`/`Bkn`）

- **`workflow_child` 强制禁用集**（`resolveRuntimeDisallowedTools` = `STo`）：工作流子运行时的 toolDisallowlist 并入固定五项 `Rwa = [Mv, Q_, Lte, u3, lH]`——`Mv` 即 `CreateWorkflow`（**工作流里不能再开工作流**），其余四项为同类元工具（minified，未逐一展开）。
- **`subagent_child` 强制注入**（`appendChildControlTool` = `Bkn`）：allowlist 末尾追加 `iF`（子代理控制工具，即 `submit_result`/`escalate` 通道），已有则不重复。
- **`toolset==="explore"` 过滤**（`resolveBuiltInToolAllowlist` = `X4e`）：Explore 型只保留基础集 `boe` 内的工具；`dynamicWorkflowEnabled !== false` 缺省开（`P_t`）。
