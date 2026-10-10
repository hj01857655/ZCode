# 32 · Skills 系统本体

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 插件壳见 [16](zcode-plan-16-插件系统.md)；本文覆盖技能文件格式与发现机制
> 来源：`zcode.cjs` 技能发现器（`ffe="SKILL.md"`、目录遍历规则 `EXe`、frontmatter 解析器）

## 1. 技能文件格式

一个技能 = 一个目录 + 一个 `SKILL.md`。SKILL.md 由 **frontmatter（key: value 的轻量 YAML）+ 正文**组成：

- frontmatter 解析器逐行找 `key:`；值支持**折叠块（`>`）与字面块（`|`，含 `+-` 变体）**——多行 description/说明可折叠书写。
- 格式错误行不致命：记 warning `skill_invalid_frontmatter`（含文件名/行号），继续解析其余字段。
- 常见字段：`name`、`description`（供模型与用户判断何时调用）、`allowed-tools`（104 处命中——Claude 风格的技能级工具白名单）。

## 2. 发现机制（目录遍历规则 `EXe`）

```
扫描目录时跳过: node_modules, dist, build, out, target,
               vendor, coverage, .cache, .next, .turbo, .venv, __pycache__
隐藏目录: 一律跳过，唯独 .system 放行（系统级技能）
遍历深度上限: 8 层（UXi=8）
```

发现来源（分层）：**插件 skills/**（[16](zcode-plan-16-插件系统.md)）→ **用户/项目目录** → **系统目录（.system）**。`skills.list` RPC 汇总后供 UI 与模型使用。

## 3. 调用语义

- **用户可调用**（user-invocable）：出现在输入框 `/` 补全列表；`Skill` 工具的系统提示词明确要求"只调用用户可调用技能清单里的，不要猜"。
- **模型可调用**：模型按 description 自主决定经 `Skill` 工具加载——技能以"渐进披露"方式注入：先见 name/description，调用后展开正文，避免全量塞进系统提示词。
- 技能内部可再引用脚本/资源（技能目录整体可用）。

## 4. 与权限的关系

技能本身不是工具——它展开后是**提示词内容 + 可能的工具用法指引**；其中建议的每一次工具调用仍要过 [15](zcode-plan-15-工具与权限体系.md) 的权限引擎（`allowed-tools` 是技能建议的收窄，不是权限豁免）。
