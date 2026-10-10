# 27 · Desktop ↔ Agent IPC 通道注册表

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：通道常量表（两个 bundle 中一致）+ agent 方法路径表（`va`，64 方法）+ **一天真实 host 日志的 RPC 流量统计**（80+ 对 channel.method 实测）

## 0. 架构

```
Electron UI ──IPC──> host 进程 ──stdio RPC──> agent (zcode.cjs app-server)
                         │
                         └──> zcode.z.ai 云（REST/WS，见 17）

通道注册：ServiceCollection.register(channel, service)
        exposeOnChannelServer → channel.registerChannel(name, P.fromService(service))
        （P.fromService 把普通对象反射成 RPC 服务面——所有 public 方法自动暴露）
```

## 1. 通道名注册表（39 个，全量）

| 组 | 通道名 |
|---|---|
| 文件/系统 | `file`、`media-preview`、`system`、`terminal`、`file-watcher`、`setting` |
| Git | `git`、`git-checkpoint` |
| 凭证/账号 | `credential`、`oauth`、`provider-settings`、`model-selection`、`provider-provisioning-target` |
| 会话/任务 | `zcode-session`、`zcode-task`、`zcode-agent`、`window-controller`、`subagents` |
| 计划/商业 | `usage-stats`、`coding-plan-subscription`、`client-config`、`client-scenes`、`cloud-content`、`marketing-touch`、`conversation-share` |
| 插件/技能 | `plugins`、`plugin-management`、`plugin-sync`、`skill-sync`、`skills`、`mcp-sync`、`commands` |
| 扩展机制 | `hooks`、`memory`、`output-style`、`settings-sync`、`bots`、`feedback`、`prompt-attachment-transfer`、`off-peak-task` |
| CUA | `cua-permission`、`cua-pip-session` |
| 其他 | `broadcast`、`onboarding-record`（日志实测） |

## 2. Agent 方法路径表（`va`，64 个，全量）

**会话生命周期**：`session/create|resume|list|read|messages|events|debug|subscribe|send|stop|close|fork|compact`、`session/cancelBackgroundTask`、`session/goal`、`session/subagents`、`session/setModel|setThoughtLevel|setMode`、`session/requestRuntimePreferences`
**工作区**：`workspace/readPresentation`、`workspace/hooks/trustGrant`、`workspace/updateInteractionPreferences|updateModelIoPreferences|updateOffPeakToolPolicy|updateDynamicWorkflowPolicy`、`workspace/generateText|cancelGenerateText`
**运行时**：`runtime/capabilities`、`computer-use/operation-event`、`process/childProcesses`
**交互回调**（agent→host 反向请求）：`interaction/requestPermission`、`requestUserInput`、**`requestProviderRuntimeHeaders`**（验证码头下发通道，见 [12 §4](zcode-plan-12-阿里云验证码体系.md)）、`requestOfficialMcpAuthHeaders`、`browserList`、`browserExecute`
**Provider**：`provider/updateAccountConfig`、`provider/testModelConnectivity`
**插件**：`plugins/list|referenceCatalog|referenceCatalogWithCategory|skills/referenceCatalog|resolveSuggestedReference|setEnabled|overview|marketplace/add|remove|update|install|cancelOperation|uninstall|update|restoreBuiltin|configure|resetConfig|validate|describe`
**自动化**：`automation/create|update|checkTaskBinding|list|delete`、`offPeak/create|list`
**工作流**：`workflows/list|get|updateMeta|delete|runs|move`
**用量**：`usage/stats`、`session/usage`
**MCP**：`mcp/list`

## 3. 一天真实流量（v2 日志聚合，Top 30）

| 调用 | OK | FAIL | avg ms | 说明 |
|---|---|---|---|---|
| `zcode-agent.queryConversationCommandsV4` | 7745 | 0 | 3 | UI 轮询命令面板（最高频） |
| `setting.update` | 1664 | 0 | 12 | |
| `off-peak-task.list` | 936 | 0 | 0 | |
| `zcode-agent.respondProviderRuntimeHeaders` | 383 | 0 | 6 | **每模型请求的验证码头下发**（[12 §4](zcode-plan-12-阿里云验证码体系.md)） |
| `oauth.pollPendingOAuth` | 348 | 0 | 28 | |
| `credential.load` | 306 | 0 | 2 | 凭证热读 |
| `marketing-touch.query` | 267 | 0 | 115 | |
| `usage-stats.getEntitlementSnapshot` | 162 | 0 | 85 | 权益快照（[04](zcode-plan-04-权益解析逻辑.md)） |
| `coding-plan-subscription.getCaptchaConfig` | 141 | 0 | 2 | |
| `zcode-agent.sendConversationCommandV4` | 81 | 0 | 290 | 用户发送消息 |
| `provider-settings.refresh` | 55 | 2 | 897 | provider 配置刷新（含 builtin 下载） |
| `window-controller.listTaskList` | 40 | 0 | 152 | |
| `oauth.startOAuthWithPolling` | 14 | 0 | 61 | 登录 |
| `coding-plan-subscription.claimManualPlan` | 4 | 0 | 165 | **签到领取**（[11](zcode-plan-11-签到领取接口.md)） |

失败观察：`provider-settings.refresh` 2 次 FAIL（builtin CDN 拉取超时）；`zcode-agent.subscribeSessionsIndexV4` 6 次 FAIL（agent 启动竞态）；`oauth.handleCallback` 3 次 FAIL（回调超时重试）。

## 4. 双向性

- **host→agent**：上表绝大多数（UI 发起的调用经 host 转发）。
- **agent→host（interaction/* 反向通道）**：agent 执行中向 host 要权限确认、要运行时头（验证码）、要用户输入、要浏览器操作——host 是 agent 的"系统服务提供方"。
- **推送（非请求-响应）**：`subscribe*` 系列建立订阅后走推送帧（[17 §2](zcode-plan-17-云端会话与远程体系.md) 的 logEpoch/seq 模型）。

**补充（2026-09-28）：interaction RPC 四方法**（host JSON-RPC 分发，参数错回 `-32602`）：`interaction/requestPermission`（权限交互）、`interaction/requestUserInput`（用户输入提示）、`interaction/requestProviderRuntimeHeaders`（provider 头刷新）、`interaction/requestOfficialMcpAuthHeaders`（**MCP trusted-origins 校验**：mcpKey+targetOrigin+pluginId → `isTrusted`，通过才供官方 MCP 认证头）。分发器形态见 host bundle @316669 一带。
