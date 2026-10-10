# 23 · Hooks 与 MCP 客户端

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：`zcode.cjs` hookInvocation schema + MCP 会话导入/连接 schema

## 1. Hooks 系统

### 1.1 七个事件（hookEventName 枚举）

```
SessionStart → UserPromptSubmit → PreToolUse → PermissionRequest → PostToolUse → PostToolUseFailure → Stop
```

### 1.2 执行模型（hookInvocation 结构）

- **lane（泳道）**：`assistantWork` / `toolBefore` / `toolAfter`——钩子挂在助手回合或工具调用前后（anchorToolCallId 锚定）。
- **每次调用**（KVt）：`{hookRunId, hookIndex, didExecute, state, outcome: success|blocked|failed|cancelled|timed_out, blockReason, durationMs, sourceKind: user|plugin|project, pluginName?, toolName?}`。
- **关键能力：`blocked`**——PreToolUse 钩子可以**拦截工具调用**（outcome=blocked + blockReason），配合权限引擎形成"用户规则 → 引擎判定 → 用户钩子"三道闸。
- **执行形态**：`executionType: process|command`，`executionMode: foreground|background`，带 `timeoutMs`；来源三级 user/project/**plugin**（插件 hooks/ 目录）。
- 遥测事件：`hook_run_started/progress/completed/failed/blocked`（见 [26](zcode-plan-26-外围子系统.md)）。

## 2. MCP 客户端

- **服务器配置**：`mcpServers` 数组；连接模式 `connect` / `status`。
- **MCP OAuth**：per-server 授权，`oauth_authorization_code` 状态记录 authorizationUrl。`oauth/callback/mcp/` 前缀的回调走**标准 OIDC 库**（bundle 内含完整 openid-client 风格 schema），与 Z.ai/bigmodel 用户登录私有链路（[10](zcode-plan-10-OAuth登录流程.md)）完全独立：

  - 发现文档解析（issuer/authorization_endpoint/token_endpoint/scopes_supported/`code_challenge_methods_supported`…）
  - PKCE（`code_verifier`/`code_challenge`）、`grant_type` 全套（含 `refresh_token`）
  - 动态客户端注册（registration_endpoint，`yut`/`vut` schema）
  - token 响应 schema `OMe = {access_token, id_token?, token_type, expires_in?, scope?, refresh_token?}`
- **工具注入**：MCP 工具以 `mcp__<server>__<tool>` 命名空间进入工具清单（实测：`mcp__node_repl__js`）。
- **MCP 配额**：官方 MCP 走 `GET /api/monitor/usage/quota/limit`（`fetchMcpQuotaSnapshot`，见 [03 §5](zcode-plan-03-billing-balance-接口与实调.md)）。
- **会话导入**：MCP 之外还有 `source: "claudeCode"` 的会话导入（title + messages 数组）——从 Claude Code 导入历史对话（与 [13 §5](zcode-plan-13-AGENTS.md支持.md) 的迁移体系同族）。

## 3. 连接池、deadline 与工具准入（2026-09-27 函数体实读，B 级；锚点 `emn`/`Pto`/`ito`/`QMe`/`pva`）

**① 连接池**（`createMcpConnectionPool` = `emn` + `createMcpAdapterConnectionPool` = `Pto`）：
- 按 key 池化 adapter；**空闲宽限 `idleGraceMs` 默认 3e4 = 30s**，到期 `closeTimer` 触发 `adapter.close()`；日志事件 `mcp.pool.connection.closed` / `close.failed`（module `adapters.mcp.pool`），telemetry 随连接注销。
- `Pto` 在池上包一层工厂：每连接注入 `connectionContext`（trace/tenant 字段见 `vGs`：trace_id/span_id/parent_span_id/session_id/turn_id/runtime_scope/workspace_path/workspace_identity/workspace_key）。

**② deadline 模式**（`createMcpDeadline` = `ito`）：`{expiresAt, timeoutMs}` + 竞速 Promise（setTimeout 与 AbortSignal 双通道），超时/中止抛 `Fge`（deadline 错误）——MCP 调用统一挂死线。

**③ 传输层**（`createMcpTransportFetch` = `QMe`）：HTTP 传输走统一网络配置（`caCertFile`/`httpProxy`/`noProxy`，与模型请求同源）；env 过滤仅留字符串值；**PATH 自修复**（`fHs`）：execPath 为 node 且 PATH 不含其目录时自动注入（win32 判 node.exe）——stdio 子进程 spawn 的保活细节。

**④ 工具准入与输出预算**（`createMcpToolEntry` = `pva`）：
- 注解映射：`readOnlyHint` → safe / `destructiveHint` → destructive；权限级 **destructive 或 node_repl→`high`，readOnly→`low`，其余 `medium`**
- **`node_repl` 服务器的 `js` 工具特判**：capability 面 `system`（非 network）、默认超时 3e4=30s（其他工具可带 `timeoutMs`）、输出走 **artifact 策略**（inline 1MB / model 64KB、preview tail 64KB、`retention:"session"`）
- 普通工具输出三档：权限相关 256KB truncate head / 默认 100KB truncate head（model 50KB）；capability 文案 `MCP tool exposed by <server>: <tool>` + 权限组 `cva`

## 4. HookRunner 构造（2026-09-27 函数体实读，B 级；锚点 `uCa`）

`createRuntimeHookRunner`（`uCa`）的构造条件链：**`config.hooks.enabled || workspaceHookSnapshot` 且有 executionPort** 才建 runner（`Npt`，emitEvent 走 `appendEvent`）；**sessionMailboxPort 存在时再包一层 mailbox runner**（`Mpt`，emitEvent 先过 `K_t` 去重判定）；`Lpt` 组合 steerTurn 的 pending-input 入队。§1.2 的 hookInvocation 结构即由该 runner 产出。
