# 24 · 文件变更追踪与回滚

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：`zcode.cjs` 会话行 schema（actions/canRewindFiles）、`v4/conversation/fileChanges|fileRewindPreview`、git stash 引用

## 1. 变更追踪的载体

- **会话行（turn row）**携带动作位：`{canFork?, canEdit?, canRetry?, canRewindFiles?}`——回滚能力按**回合头（turnHeader）**粒度标注，仅当该回合产生过文件变更（row.fileChanges）时才解锁 `canRewindFiles`。
- turnHeader 元数据：`origin: userInput|backgroundResult|goalContinuation|editRerun|workflowLaunch`、`state: running|completedSuccess|completedInterrupted|failed`、`historyRoundCount`。
- 云侧：`v4/conversation/fileChanges`（回合文件变更清单）、`v4/conversation/fileRewindPreview`（**回滚前预览**——先看哪些文件会被改回什么状态，再执行）。

## 2. 回滚执行（applyFileRewind）

UI 守卫链（实测代码）：

```
行类型必须是 turnHeader 且 fileChanges 存在且 canRewindFiles
→ 收集该 turnId 下所有 message ids
→ 执行回滚（恢复文件内容 + 会话行标记 RewindTriggered 事件）
```

guard 拒绝码：`guard.actionUnavailable` 等——预览/回滚是对同一行的两个 action，共享可用性判定。

## 3. 与 checkpoint 的关系

- 会话事件区分两件事：`CheckpointCreated`（检查点=上下文快照，配合 `/fork`）与 `RewindTriggered`（文件回滚）——**上下文回退**和**文件回滚**是两个独立操作，可组合。
- 文件状态恢复的底层引用 git（bundle 内含 `gitStash` 系列逻辑——变更快照以 git 对象形式管理；`v4/conversation/fileRewindPreview` 只做预览计算）。

## 4. 编辑工具侧

- `Edit` 工具 = 精确串替换（要求先 Read）；`Write` 覆盖写；`ApplyPatch` 补丁格式（权限引擎里与 Write/Edit 同级 medium 风险，见 [15 §3](zcode-plan-15-工具与权限体系.md)）。
- 每次写操作落 `tool_usage`（read_only=0, side_effect_scope=workspace）——文件变更清单的原始数据源。

## 5. 回滚事件链过滤（2026-09-27 函数体实读，B 级；锚点 `cZo`/`PRn`）

`readSessionRewindEvents`（`cZo`）从 eventStore 取 `RewindTriggered` 事件后，**只有满足以下条件的载荷才进入回滚链**（`$Xa`/`zXa`）：

- `strategy === ActiveChain`（其余策略不成链）
- `scope === Conversation` 或 `Both`（纯工具级 scope 不进）
- 必带 `createdMessageId` + `targetMessageId`

链的累积（`AKo`）以 `revert.createdMessageID/revert.targetMessageID/keptMessageIDs` 逐段拼接——§2 的 applyFileRewind 消费的就是这条过滤后的链。goal/target 的完成验证事件另有独立持久化读取（`readSessionTargetCompletionVerificationEvents`，失败静默降级为空表并 warn）。

## 6. fork 函数族（2026-09-28 源码级枚举，B 级）

fork 有**三种切法**（注册名实录）：`forkConversationFromMessage`（从消息起）、`forkStableConversationAtMessage`（稳定切于消息）、`forkConversationBeforeMessage`（切于消息**之前**）——`conversationHistoryBeforeInput` 即"取输入点之前的历史"的装配函数。切分同时**复制 goal 状态**：`copyGoalStateForFork` + `copyGoalVerificationEntriesForFork`/`cloneGoalVerificationEntryForFork`/`deriveForkedGoalStatusFromCopiedVerifications`——goal 的验证条目逐条克隆并派生新状态。§3 的 forkNotice UI 守卫（只能从已完成 assistant 段落 fork）对应 `stableForkHistoryMessages` 的稳定性语义。
