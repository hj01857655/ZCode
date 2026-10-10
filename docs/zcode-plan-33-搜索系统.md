# 33 · 搜索与语义召回后端

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 记忆侧召回见 [28 §3.2](zcode-plan-28-记忆系统.md)；本文覆盖代码/文件/会话搜索

## 1. 检索栈分层

| 层 | 实现 | 用途 |
|---|---|---|
| 文本搜索 | **内嵌 ripgrep**（bundle 内 45 处 rg/code-index 引用，含平台二进制分发） | Grep 工具、composer 文件搜索的候选生成 |
| 文件候选 | `Glob` + 目录遍历（skills 发现器同款遍历规则） | @ 引用、上下文搜索 |
| 会话检索 | `tasks-index.sqlite` 的 `searchable_text` 列 + LIKE/FTS 式过滤 | 历史任务/会话搜索 |
| 语义召回 | **无向量库**——模型自选文件（见 [28 §3.2](zcode-plan-28-记忆系统.md)），依赖 `supportsJsonSchemaOutput` 模型 | project memory |

## 2. nativeSearchEnhancementsEnabled

设置开关（本机 true），对应"原生搜索增强"：启用后 composer 的 `contextSearchHint`（"Type to search plugins, files, and chats"）由本地索引驱动，跨**插件、文件、会话**三类对象做统一搜索；关闭则回退基础文件搜索。开关经 RPC 下发到 agent（`syncAppRuntimePreferences`）。

## 3. 观察与边界

- 语义层没有 embedding 服务调用（bundle 内 embedding 引用均属 AI SDK 的通用 embedding 接口，未见实际接入）——ZCode 的"智能搜索"策略是**用模型 judgment 替代向量索引**（与记忆召回同思路）。
- 大仓库场景依赖 rg 的性能；无本地持久化倒排索引（未发现索引文件产物）。
