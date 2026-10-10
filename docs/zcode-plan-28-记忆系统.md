# 28 · 记忆系统全解析

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：`zcode.cjs` 记忆运行时（`CCo` 提示词构造、`vxa` 存储解析、`hTa`/`XEo` 召回管线，函数名完整保留）
> 替代 [26 §2](zcode-plan-26-外围子系统.md) 的摘要版

## 0. 一句话

ZCode 的记忆 = **Markdown 文件库**（按代理分目录、三作用域）+ **两种召回方式**（MEMORY.md 索引直载 / 模型自选文件的"语义召回"预取）。没有向量库、没有 embedding——所谓 semantic，是一个结构化输出模型调用在挑文件。

## 1. 存储：三作用域 × 按代理分目录（`vxa`）

```js
scope === "user"    → <storageRoot>/agent-memory/<agentNameSlug>/        # 跨项目
scope === "project" → <workspaceRoot>/.zcode/agent-memory/<agentNameSlug>/      # 随版本库共享
scope === "local"   → <workspaceRoot>/.zcode/agent-memory-local/<agentNameSlug>/ # 仅本机
```

- `agentNameSlug`：代理名做 `[^a-zA-Z0-9_-] → "-"` 归一——**每个代理（主 agent/子代理/插件代理）有自己的记忆库**。
- 启用条件（`ACo`）：`enabled===true && use!==false && storageRoot 存在`（远端/设置下发）。
- 开关：`setting.memoryEnabled`（**本机当前为 false**）。

## 2. 注入的提示词（`CCo` = buildPersistentAgentMemoryPrompt）

每次会话注入 `# Persistent Agent Memory` 段（`<MEMORY_ROOT>/` 替换为实际目录、`<SCOPE_GUIDANCE>` 按 scope 替换）：

- **四类记忆**（XML `<types>` 结构）：
  - `user`：用户角色/目标/知识水平（"对资深工程师和新手的协作方式应该不同"）
  - `feedback`：用户给的行为反馈（含 why/how to apply）
  - `project`：进行中的工作/约束（相对日期转绝对日期）
  - `reference`：外部资源指针
- **写入协议**：两步（写记忆文件 → 更新 MEMORY.md 索引行）；显式要求记住→立即存；要求忘记→找到并删除
- **不存**：repo 已记录内容、git 历史能推导的、修 bug 配方、临时状态
- 旧记忆"反映写入时状态"——引用前先验证

## 3. 召回：双分支（`resolveProjectMemoryRetrievalBranch`）

```js
function ZKs(e) { return e ? "semantic-recall" : "default-index" }
UG = ZKs(!1)          // ← 当前硬编码 false：本版本实际走 default-index
```

### 3.1 default-index（现行路径）

每次会话把 **MEMORY.md 索引整体注入**上下文（"one line per memory, never put memory content there"）——代理靠索引里的描述自己决定何时用 Read 读哪条。

### 3.2 semantic-recall（已实现未启用）

**不是向量检索**，而是一条 turn 级后台预取管线（`hTa`，telemetry operation `project_memory_recall`，trigger `turn`）：

```
① 扫描记忆清单（Ixn：memoryRoot 下的文件清单）
   ├─ 全部已在本次已召回集合 → 直接返回
② Axn：模型调用（结构化输出，query 取自借用只读运行时条目的消息历史）
   → 返回 {selectedMemories: [相关文件名]}          ← "语义"就在这一步
③ pyt：选中的文件名 ∩ 清单 − 已召回路径
④ Pxn：读文件 → 格式化为附件（每条带 header：
   "Memories may be outdated. Verify against current code… Memory: <描述>:")
⑤ 注入本轮上下文
```

**硬约束**：

| 约束 | 值 |
|---|---|
| 召回内容字符预算 | `mTa = 61440`（60KB，超了 `canStartMemoryRecall=false`） |
| 模型要求 | `supportsJsonSchemaOutput === true`（结构化输出选文件） |
| 执行时机 | turn 开始时的后台预取（独立 AbortController，跟随回合中止） |
| 去重 | 按 filePath 全局去重（`recalledPaths`） |
| 失败降级 | 静默空集（catch → memories=[]），不阻塞主回合 |

## 4. 与其他层的接口

- RPC：host 侧 `memory.listProjectMemories`（UI 列出记忆，[27 §3](zcode-plan-27-IPC通道注册表.md) 流量表实测 9 次调用）；channel 名 `memory`。
- 遥测：`agentTelemetry` 记录每次召回（causation/耗时/结果类型 metadata）。
- 提示词：记忆段作为 section 注入（[18 §2](zcode-plan-18-系统提示词与上下文管理.md) 的装配器）。
- 语义召回用的模型调用也走 `refreshRuntimeHeadersBeforeAttempt`——**Start Plan 通道的召回请求同样要过验证码头**。
