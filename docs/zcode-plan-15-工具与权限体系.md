# 15 · 内置工具清单与权限体系

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：本会话 model-io 日志（真实请求的 34 个工具）+ `zcode.cjs` 权限决策引擎（`checkPlanMode/checkBuildMode/checkEditMode/checkAlwaysAsk`，函数名完整保留）

## 1. 内置工具清单（34 个，实测）

**文件/执行**：`Read`、`Write`、`Edit`、`Bash`
**任务组织**：`TodoRead`、`TodoWrite`、`Agent`（子代理）、`AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode`
**信息获取**：`WebSearch`、`WebFetch`
**技能**：`Skill`
**后台任务**：`TaskOutput`（已标 deprecated）、`TaskStop`
**定时自动化**：`CronCreate`、`CronDelete`、`CronList`、`CronUpdate`
**Off-peak**：`OffPeakCreate`、`OffPeakList`
**多代理通信**：`SendMessage`、`ReadSessionContext`（读取别的 ZCode 会话上下文）
**动态工作流（10 个）**：`CreateWorkflow`、`AmendWorkflow`、`SaveWorkflow`、`EvalWorkflowSnippet`、`ListWorkflowRuns`、`GetWorkflowRun`、`ResumeWorkflowRun`、`ResolveWorkflowQuestion`、`ListSavedWorkflows`、`ListModels`
**MCP**：`mcp__node_repl__js`（node-repl-host 插件提供，Browser Use / Computer Use 专用）

## 2. 权限模式（permissionMode）

```js
Npe = m.enum(["build", "edit", "plan", "yolo"])
// 别名归一（uYa）：
//   dontAsk / bypassPermissions → yolo
//   default / auto / acceptEdits / autoEdit → build
//   auto 模式本身：deny("mode.auto.unimplemented", "Auto mode is reserved but not implemented yet")
```

## 3. 能力解析（resolveCapability）

每个工具调用先解析出能力向量（工具静态声明 + 兜底推断）：

| 字段 | 兜底逻辑 |
|---|---|
| `readOnly` | 白名单：`Read, Glob, Grep, WebSearch, WebFetch, TodoRead, TodoWrite, AskUserQuestion, Agent, Task, Skill` |
| `isWriteTool` | `Write, Edit, ApplyPatch, Bash` |
| `isDestructive` | 仅 `Bash` |
| `sideEffectScope` | 只读→`none`，否则→`workspace`（可选 `session`/`userInteraction`） |
| `riskLevel` | 只读→low；write→medium；destructive→high；默认 medium |
| `needsApproval` | 默认 = 非只读 |
| `allowedInPlanMode` / `alwaysAsk` / `permissionName` / `permissionCapabilityGroup` | 工具/服务端声明 |

## 4. 决策流程（完整还原）

```
1. requiresUserInteraction          → ask("tool.userInteraction")
2. alwaysAsk                        → checkAlwaysAsk:
      mode==="auto"                 → deny(mode.auto.unimplemented)
      disallowedTools               → deny(rule.disallowedTools)
      项目 deny 规则命中            → deny(rule.project.deny)
      会话 allow 规则命中           → allow(rule.session.allow)
      本会话启动的 workflow amend   → allow(rule.session.workflowOwner)
      否则                          → ask(tool.alwaysAsk)
3. mode==="yolo" && !planEnabled    → allow("mode.yolo", "Yolo mode bypasses permission prompts")
4. mode==="auto"                    → deny(mode.auto.unimplemented)
5. 项目 deny 规则                   → deny
6. 会话 allow 规则                  → allow
7. 项目 ask 规则                    → ask
8. 按模式分发：
   plan  → checkPlanMode
   build → checkBuildMode
   edit  → checkEditMode
```

### 各模式判定

```js
checkPlanMode:
  readOnly && !destructive                          → allow(mode.plan.readOnly)
  permissionName==="mcp" && !destructive            → allow(mode.plan.mcp)
  allowedInPlanMode && scope==="session"
    && !destructive && !needsApproval               → allow(mode.plan.explicitSessionCapability)
  否则                                              → deny(mode.plan.nonReadOnly)

checkBuildMode:
  readOnly && !destructive && !needsApproval        → allow(mode.build.readOnly)
  riskLevel==="critical"                            → ask(mode.build.criticalRisk)
  riskLevel==="high" && !autoApproveHighRisk        → ask(mode.build.highRisk)
  scope==="session" && risk==="low"
    && !destructive && !needsApproval               → allow(mode.build.sessionState)
  needsApproval || destructive || scope!=="none"    → ask(mode.build.sideEffect)
  否则                                              → allow(mode.build.lowRisk)

checkEditMode:
  permissionName==="edit" && scope==="workspace"    → allow(mode.edit.fileEdit)
  否则                                              → 落入 checkBuildMode
```

## 5. 规则匹配（project permission rules）

- 规则按工具名组织，`Write` 与 `Edit` 互相视为同一工具（`matchesRuleToolName`）。
- CUA 类工具有独立能力组（`OfficialCua`），scope 用 capabilityGroup 匹配而非工具名。
- 规则主体从工具输入提取：优先 `command` / `url` / `file_path` / `path` / `pattern` / `patch_text`；`WebFetch` 专门做 URL 主体提取（`lso`）。
- 规则内容匹配：`前缀:*` 形式（前缀 + 空白边界）或含 `*` 的通配（`zpt` 编译），否则全等。
- 有 `isPreapprovedWebFetchRequest`（WebFetch 预批准名单）。
- 决策结果结构：`{decision: allow|ask|deny, allowed, escalated, mode, reason, riskLevel, ruleId, sideEffectScope, alwaysAsk?}`。

## 6. 对应持久化

- 项目规则存 `db.sqlite.permission`（project_id → JSON）；决策遥测落 `tool_usage.approval_status` + `read_only/destructive/side_effect_scope` 列。
- 本会话运行在 `yolo` 模式（DB `model_usage.mode` 列实测 "yolo"）——即 `mode.yolo` 直接放行分支。

## 7. 能力解析的函数锚点（2026-09-27，B 级）

§3 resolveCapability 的运行时实现在 `resolveRuntimePermissionCapability`（`HNe`）+ `resolveToolCallCapabilityFlags`（`yoo`）：**权限上下文三元组 = `{runtimeScope, workingDirectory, workspaceRoot}`**（`GNe`），工具 capability = metadata 与工具自定义解析器结果合并（`permissionCapabilityGroup` 保持），最终产出 §4 决策树消费的 `{readOnly, sideEffectScope}`。
