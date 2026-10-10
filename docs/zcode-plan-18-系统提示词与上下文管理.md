# 18 · 系统提示词组装与上下文管理

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：`zcode.cjs` 提示词装配器（`Qmn/whn/jno/Fno/bhn/nhn/rhn` 等 builder，函数名完整保留）

## 1. 分节装配器架构

系统提示词不是一整块字符串，而是**命名分节（section）装配**：

```js
{ name: "Agent Identity", source: "identity",
  injectionTarget: "system",
  cacheHint: "stable" | "dynamic",   // 缓存断点提示
  chars, tokens: wm(content),        // 每节独立 token 计数
  content, preview: content.slice(0,100) }
```

最终注入 system 数组时按 `cacheHint` 分组打 `cache_control: ephemeral` 断点（本会话实测 3 块：identity / harness / 其余合并）。

## 2. 已识别的 Section（source 清单）

| source | name | cacheHint | 内容要点 |
|---|---|---|---|
| `identity` | Agent Identity | stable | 身份句（"You are an interactive ZCode agent…"）+ Output Style 切换句 + **IMPORTANT 安全前言**（授权安全测试/拒绝对恶意目标的检测规避……）+ Harness 规则 |
| `desktop_context` | ZCode Desktop Context | stable | 文件/URL 引用规范、`::code-comment{...}` 行内评论指令 |
| `env_info` | Environment Info | **dynamic** | "You have been invoked in the following environment:" + cwd/平台/git 状态/项目类型探测（node/python/rust/go/java + 包管理器 pnpm/yarn/bun/npm + Makefile/Dockerfile 检测，`wls`） |
| `system_context` | System Context | dynamic | 系统级上下文（条件注入） |
| `session_guidance` | Session-specific guidance | — | Skill 斜杠命令提示（仅当 Skill 工具在场） |
| `dynamic_behavior` | Dynamic Behavior | — | 不可逆操作先确认、外部发送即发布、删除/覆盖前先查看 |
| `memory` | Memory | — | memory 文件规范（MEMORY.md 索引、不保存 repo 已记录内容等） |
| （上下文源） | 用户/工作区 AGENTS.md | — | 经 `mls` 发现后作为独立 context source 注入（见 [13](zcode-plan-13-AGENTS.md支持.md)） |

工具定义**单独**走 tools 数组，每个工具可带自己的 `cache_control`，并支持 anthropic 扩展 beta：`eager_input_streaming`、`defer_loading`、`allowed_callers`、`input_examples`（beta 头 `advanced-tool-use-2025-11-20`、`structured-outputs-2025-11-13`）。

## 3. 上下文管理

### 3.1 窗口状态

```js
contextWindow: { usedTokens, maxTokens,
                 autoCompactThresholdTokens,   // 自动压缩阈值（可空）
                 cache?, breakdown? }
```

### 3.2 压缩与回退事件

会话事件流（`createSessionEvent` 类型表）中的上下文生命周期事件：

```
CompactStarted / CompactCompleted / CompactFailed / CompactBoundary
MicrocompactBoundary          # 微压缩（工具结果裁剪级）
RewindTriggered / CheckpointCreated
```

compact 的执行记录结构：`{type:"compact", origin: manual|auto, status: running|success|failed|noop|cancelled, tokensBefore, tokensAfter, summaryRef}`——压缩产生摘要引用，后续上下文从摘要续接。

### 3.3 Fork

`{type:"forkNotice", parentSessionId, parentRowId}`——从消息行分叉新会话（`/fork` 命令），UI 侧守卫：只能从**已完成的 assistant 段落行** fork，compact 进行中锁定（`guard.compactOperationLock`）。

### 3.4 压缩管线函数层（2026-09-27 函数体实读，B 级；锚点 `q1a`/`sJs`/`Xto`/`EQa`/`SEo`/`s_t`/`Hdt`）

**① 管线本体**（`compactActiveConversationImpl` = `q1a`）：
- trigger `Manual|Auto` → 派生 phase/compactReason；摘要请求用**会话当前模型**，max_tokens 取该模型 `optionSpecs.maxOutputTokens.max`
- `midConversationSystem` 生效条件：config `midConversationSystem.mode==="force"` 或模型 `supportsMidConversationSystem`——摘要请求是否携带系统节由此决定
- 入口切分（`H1a`）：运行时消息条目 → **preservedEntries（保留段）+ entriesForSummary（送摘要段）**
- Auto 触发时系数 `jPo = 3`（Manual 为 1）——疑为摘要预算/重试倍率，语义未定（C 级）；operationId 形如 `cmp_<uuid>`

**② 保留段策略**（`compactPreservedSegmentMessages` = `sJs` + `Jmn`）：
- 数据源：compactBoundary part 的 `preservedSegment{headMessageId, tailMessageId}`，按 id 切片
- 可保留判定：**仅 user/assistant 角色**；排除 provider 语义 hidden、含压缩 part、出错 assistant
- 保留的 assistant 消息 tokens 经 `ldt` 重算（防旧计数污染）

**③ 压缩后时间线拼装**（`_xo`）：`[前缀条目, 摘要消息, preservedEntries, postCompactReminderEntries]` 四段——"后置提醒"是独立可注入段。

**④ microcompact 实名**（`Hdt` = `maybeLocalMicrocompactMessages`）：
- 决策返回 `{decision, payload{clearedToolCallIds}}`，对 tool 角色消息按 toolCallId **原地替换内容占位**（`uNe`）——即 §3.2 的"工具结果裁剪级"，本地即时、不产摘要
- `applyCacheControl:false` 下运行；bundle 内 microcompact 引用 26 处

**⑤ timeline part 归一**（`compactTriggerOfPart` = `EQa`）：`context_compaction` → 完整字段集 `{operationId, messageId, partId, status, trigger, display, sourceCommandId?, anchorMessageId?, anchorTurnId?, phase?, compactReason?, reason?, boundaryId?, summaryMessageId?, preCompactTokenCount?, postCompactTokenCount?}`——§3.2 记录结构的全字段版。

**⑥ 用量快照**（`compactContextUsageSnapshot` = `SEo`）：`/context` 类观测的数据源——`categories + categoryBreakdown{contributors 按 tokens 降序 top5}`、`mcpToolCount/skillCount/systemPromptSectionCount/systemToolCount/warningCount`。

**⑦ 失败分类**（`compactFailureReasonFromError` = `s_t`）：typed reason → Error.message → `"unknown"` 三级；`compactKnownNetworkCauseMessage` 归并网络成因文案。

**⑧ 触发阈值**：`autoCompactThresholdTokens` 由 config 下发（schema `rHt`：`contextWindow{usedTokens, maxTokens, autoCompactThresholdTokens nullable}`，可空 = 未配置不自动）；used≥threshold 的比较点未逐行追（C 级）。

## 4. 本会话实证

model-io 日志中 system 数组 3 块（42B 身份 / 2.3KB harness / 5.4KB 其余），全部带 `cache_control: ephemeral`；`usage.cacheReadTokens` 长期高位（45K/46K）——分节缓存命中率极高，说明 stable 断点设计有效。
