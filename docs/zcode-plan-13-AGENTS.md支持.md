# 13 · AGENTS.md 支持

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 证据：`zcode.cjs` 上下文源装配（`NodeContextSourceAdapter`）+ app.asar UI/settings-sync

## 0. 结论

**是的——AGENTS.md 是 ZCode 唯一原生识别的指令文件**（优先文件列表 `pls = ["AGENTS.md"]`，硬编码），并有用户级/工作区级双层发现、`/init` 命令、子代理注入开关和 Claude 配置迁移四件套。**不读取 CLAUDE.md / .cursorrules**（bundle 里的 CLAUDE.md 字样仅存在于 memory 技能的提示词中："不要保存 CLAUDE.md 里已记录的内容"）。

## 1. 发现与加载（`mls`，`resolveContextSources` 内）

```
用户级:  ~/.zcode/AGENTS.md            （HOME 或 USERPROFILE；仅当优先列表含 "AGENTS.md"）
工作区级: 从 workingDirectory 逐级向上找 AGENTS.md，
         边界 = 最近的含 .git 的祖先目录（项目根 KTr）；命中即停
合并:    用户级内容 + "\n\n" + 工作区级内容 → 作为上下文源注入系统提示
报告:    filePath 优先展示工作区级文件
```

要点：

- **每层只取第一个命中的文件**——不是全目录树聚合（与部分工具的逐目录嵌套合并不同）。
- 向上搜索被项目根（git root）截断，不会越过仓库边界。
- 文件不存在时静默跳过；读取失败记入 `user_instructions_read_failed` 告警，不阻断会话。

## 2. 大小限制

```js
fls = 100 * 1024   // 单文件最多读 100KB，超出置 truncated: true
```

截断的文件内容仍会注入（截断到上限），并带 `truncated` 标记。

## 3. `/init` 斜杠命令

```
/init [notes]
```

内置描述（原文）："Runs a normal agent turn that inspects the current workspace and creates or updates AGENTS.md. **Existing AGENTS.md files should be edited rather than overwritten.** This command targets the workspace root, not the user default ~/.zcode/AGENTS.md."

即：以普通 agent 回合检查工作区并创建/更新工作区根的 AGENTS.md（增量编辑优先），不触碰用户级文件。

## 4. 子代理粒度开关

设置页的 subagent 表单含独立开关：

| i18n key | 文案 |
|---|---|
| `settings.subagents.form.injectAgentsMd.label` | `注入 AGENTS.md` |

每个子代理可单独选择是否把 AGENTS.md 注入其上下文。

## 5. 从其他工具迁移（settings-sync）

- `copyClaudeAgentsFileToZcodeAgentsFile({overwrite})`：把 Claude 系配置文件迁移为 ZCode 的 AGENTS.md，返回 `{sourcePath, targetPath, status, overwritten, skippedReason}`，日志事件 `[settings-sync] Claude AGENTS.md migration completed`。
- 更通用的 `detect` / `importSelected`：检测其他编码代理（Claude/Codex/Cursor 等）的 **skills、commands、plugins、mcpServers**，按 `sourceScope→targetScope`、`importMode` 批量导入。
- 首 run 提示：`settingsSyncFirstRunPromptHandled`（本机 setting.json 中已置 true）。

## 6. 与 memory 的关系

AGENTS.md（静态、仓库内、随代码走）与 memory 系统（`~/.zcode` 下按主题分文件 + MEMORY.md 索引，本机 `memoryEnabled: false`）是两套独立机制。memory 技能的提示词把"repo 已记录的内容 / CLAUDE.md 已有内容"排除在保存范围外——AGENTS.md 与 memory 分工：前者是项目指令，后者是跨会话记忆。
