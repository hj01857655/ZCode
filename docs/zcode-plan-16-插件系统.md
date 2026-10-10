# 16 · 插件系统

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：内置插件包（`resources/glm/packages/*`）、本机插件缓存与 marketplace 清单

## 1. 插件包结构

```
<plugin>/
├── .zcode-plugin/
│   └── plugin.json        # 清单
├── skills/                # 技能目录（plugin.json "skills" 指向）
├── agents/                # 子代理定义（可选，"agents" 键）
├── commands/              # 斜杠命令（可选）
├── hooks/                 # 生命周期钩子（可选）
├── dist/  scripts/  docs/ node_modules/ ...
```

**plugin.json schema**（实测两例）：

```jsonc
// browser-use-plugin
{ "name": "browser-use", "version": "0.5.1",
  "description": "...", "description_i18n": {"en": "...", "zh-CN": "..."}?,
  "author": {"name": "Z.ai"}, "license": "MIT",
  "skills": "skills" }

// presentations-plugin（带 agents）
{ ..., "skills": "skills", "agents": "agents" }
```

- `agents/` 内是 Markdown 定义的子代理（如 `visual-judge.md`——视觉验收评审 agent，即文档验收用的那个）。
- `description_i18n` 支持双语。

## 2. 分发：Marketplace

本机 `~/.zcode/cli/plugins/marketplaces/zcode-plugins-official/`：

```
marketplace.json          # 官方插件目录
bundled-marketplace.json  # 随安装包内置的子集
cdn-marketplace.json      # CDN 版目录
known_marketplaces.json   # 已知 marketplace 注册表（上级目录）
```

**marketplace.json 结构**：

```jsonc
{ "name": "zcode-plugins-official",
  "plugins": [ { "name": "cloudbase-skills",
                 "source": { "source": "url", "type": "zip",
                             "url": "https://cdn-zcode.z.ai/zcode/official-plugin/plugins/<name>/<version>/plugin.zip",
                             "sha256": "<内容哈希>",     // 完整性校验
                             "path": "<解包子路径>" },
                 "description": "...", "description_i18n": {...} } ] }
```

**官方目录实测（26+ 个）**，按类分：基础设施（github、gitlab、alibaba-cloud-cli、lark-cli、tencent-meeting-cli、dingtalk-cli、wecom-cli、obsidian）、金融（hexin、wind、tianyancha、finance-search、assess-credit、find-clients、model-deals、pick-funds、read-macro、run-fpa、vet-companies、watch-positions、write-research、accounting-and-reporting）、内容（video-agent-kit、video2code、mimosa）、云（cloudbase-skills）。

## 3. 本机布局

```
~/.zcode/cli/plugins/
├── marketplaces/<marketplace>/     # 目录清单（json）
├── cache/<marketplace>/            # 下载的 plugin.zip 与解包产物
└── data/<name>@<marketplace>/      # 插件运行时数据目录
    # 实测 10 个已装：browser-use / documents / image-search / node-repl-host /
    # pdf / plugin-creator / presentations / skill-creator / spreadsheets / zcode-guide
```

- 插件 ID 形如 `browser-use@zcode-plugins-official`（name@marketplace）。
- 安装来源三级：**随包内置**（`resources/glm/packages/*`，`enabledBuiltinAgentCliProviders` 控制，本机 `["glm"]`）→ **marketplace 下载**（zip + sha256 校验）→ 用户自建（plugin-creator）。
- 插件注入产物：skills 进 `Skill` 工具可选清单、agents 进 `Agent` 的 `subagent_type` 枚举、commands 进斜杠命令、MCP server 进 `mcp__*` 工具命名空间（如 `mcp__node_repl__js`）。

## 4. 与其他体系的关系

- 插件的 agents/skills 受 [15](zcode-plan-15-工具与权限体系.md) 权限引擎管（每个工具调用照常过 capability/risk 判定）。
- 迁移通道：settings-sync 可从 Claude/Codex/Cursor 等导入 skills/commands/plugins/mcpServers（见 [13 §5](zcode-plan-13-AGENTS.md支持.md)）。
- 升级：marketplace 条目带版本号 URL，`sha256` 钉住内容——客户端按版本增量拉取。

## 5. 配置来源与运行时解析（2026-09-27 函数体实读，B 级；锚点 `Yjs`/`Ow`/`Rje`/`qfr`）

- **配置来源合并 + 逐键溯源**（`resolvePluginConfigSources` = `Yjs`）：`userConfig.plugins` 与 `projectConfig.plugins` 的 `enabledPlugins`/`extraKnownMarketplaces`/`options` 合并时，**每个 plugin/marketplace/option-key 都记录来源 `"user"|"workspace"`**（options 按键级合并，workspace 不覆盖 user 已有键的来源标记）；`dirs` 双列（user 数组 + workspace 数组）；`paths{userPath, workspacePath}`。
- **上下文解析**（`resolvePluginContext` = `Ow`）：workingDirectory（缺省 cwd）→ 配置装载（`K0`，可 skipUserConfig/指定 userConfigPath）→ **pluginStorageRoot 从 `config.storage.dir` 派生**（`bbe(k8(dir))`），可显式覆盖。
- **marketplace 路径解析**（`Rje`/`A$a`）：`extraKnownMarketplaces` 的 source 为 file/directory 时，相对路径**相对 user 配置文件所在目录**解析为绝对路径。
- **商店目录排序算法**（`resolvePluginStoreCategory` = `qfr` + `JXi`）：category `"guides"` 归一化为 `"utilities"`，缺省 `"other"`；排序键依次为 `categoryOrder` 自定义序 → category（other 恒最后）→ `pluginOrder` 自定义序 → id 多重比较 → `displayName.localeCompare` → 输入序稳定收尾。

## 6. 插件可携带 MCP 服务（函数名佐证）

`resolvePluginMcpServers` 在册——插件 manifest 可声明 MCP servers，由插件系统解析后并入 MCP 客户端层（[23](zcode-plan-23-Hooks与MCP客户端.md)）；`resolvePluginRuntimeFeatures`/`resolvePluginSelector` 为 schema getter 类（函数体未展开）。
