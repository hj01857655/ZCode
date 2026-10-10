# 19 · 命令风险评分机制

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)、权限引擎的消费端见 [15 §3](zcode-plan-15-工具与权限体系.md)
> 来源：`zcode.cjs` 的 Bash 分析器（`analyzeBashCommand` / `isBashCommandPermissionSafe`，函数名完整保留）

## 0. 结论

Bash 命令的风险判定 = **AST 解析 + 逐命令白名单分析器**。它不靠正则黑名单（全文件 0 处 "rm -rf"），而是把命令解析成语法树，再对每条具体命令的**旗标组合**做"危险模式"判定——判定该命令是否**权限安全（permission safe）**，即是否可视为只读。

## 1. 两层结构

### 1.1 AST 层（`O2` = analyzeBashCommand）

- 内嵌完整 bash 解析器（词法器 TokenValue/34 种 token 类型 → Statement/AndOr/Pipeline 层级），命令长度上限 `aia = 1e4`。
- 输出：`{hasRedirects, hasUnsupportedSyntax, unsupportedNodeTypes, commands[]}`——**动态内容检测**（`wordHasDynamicParts`/`partHasDynamicExecution`）：含变量展开/子执行的部分不可静态判定 → 直接不安全。
- `collectStatementCommands` / `collectAndOrCommands` / `collectPipelineCommands` / `collectSimpleCommand` 拆出每条简单命令；`redirectTargetValue` / `redirectsHaveDynamicWords` 分析重定向目标。

### 1.2 命令层（每命令一个 analyzer）

对已知命令逐一分析旗标组合，**"危险"的判定方向是"输出不可信/可能写文件"**：

| analyzer（原始名） | 命令 | 危险判定 |
|---|---|---|
| `gitListLikeCommandIsDangerous` 等 7 个 | git branch/tag/reflog/ls-remote/remote show/revision format | 带 `--format/--sort/--contains` 等输出定制旗标 → 输出不可解析 → 危险 |
| `jq` 分支 | jq | `-f/--argfile/--from-file/--library-path/--rawfile/--run-tests`（读任意文件）或表达式含 `$ENV/env/include/import` |
| `sed` 分支 | sed | `-i/--in-place`（写文件）或表达式含 `w` 命令（写文件） |
| `date` 分支 | date | 参数非 `+` 格式（`-f/--file` 可读任意文件） |
| `printf` 系 | — | 参数匹配 `[a-zA-Z]*e[a-zA-Z]*`（可能带解释器旗标） |
| `watch` 系 | watch | `--watch/-w`（重复执行） |
| `man` 系 | man | `-k/-f/--apropos/--whatis` 组合 |
| echo | echo | 无 `-n` 或参数不满足 `[a-zA-Z0-9_][a-zA-Z0-9_-]*`（防参数注入到管道消费方） |

另有巨型**命令选项 schema 表**（`smt`，如 `@commercelayer/cli` 全部子命令的旗标清单）——对已知第三方 CLI 做选项级白名单。

## 2. 与权限引擎的对接

```
Bash 工具调用
  → analyzeBashCommand(text)
      ├─ 不支持的语法/动态部分 → 权限不安全
      └─ 拆出 N 条简单命令
            └─ 每条: 已知命令? → 专属 analyzer 判危险
                      未知命令? → 按 resolveCapability 兜底（Bash → destructive→high）
  → isBashCommandPermissionSafe
      → 全部安全 → readOnly=true（riskLevel=low，plan/build 直接放行）
      → 任一危险 → 维持 destructive（build→ask / plan→deny）
```

即：**Plan 模式下并非禁掉整个 Bash，而是逐命令分析——安全的只读命令可以执行**（`mode.plan.readOnly` 分支 + 这套分析器共同实现）。

## 3. 设计观察

1. 白名单式判定（"证明它只读"）而非黑名单式（"列出危险命令"）——黑名单天然漏，白名单漏的是便利性不是安全性。
2. git 系列的"危险"定义很独特：不是"会破坏仓库"，而是**输出会被旗标改造成不可解析形态**（可能藏住破坏性管道的输出）。
3. 未知命令一律走保守路径（destructive/需审批）——分析器只对认识的世界放行。
