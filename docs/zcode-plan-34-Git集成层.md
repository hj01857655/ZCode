# 34 · Git 集成层

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：`zcode.cjs` git 工具函数群（原始名完整保留）

## 1. 函数清单（原始名）

| 函数 | 用途 |
|---|---|
| `resolveGitSnapshot`（HTr） | 工作区 git 快照（状态聚合） |
| `gitStatus`（Uqa） | 分状态解析（`splitGitStatusForContext`：staged/unstaged/untracked 分组供上下文注入） |
| `resolveGitUser`（als） | user.name/email |
| `resolveGitBranch`（ils） | 当前分支 |
| `resolveMainBranch`（sls） | 主分支判定（main/master/mainline 等探测） |
| `resolveGitHubArchiveSource`（ndn） | GitHub 仓库 → tarball 归档 URL（插件/资源安装通道，见 [16](zcode-plan-16-插件系统.md)） |
| `resolveGitPluginSource`（y8s） | 插件源解析 |
| `gitStatusToolName`（uls） | git 状态的工具化命名 |

执行底座：`execGitNoThrow` / `readGitOutput` / `readTrimmedGitOutput` / `gitCommandSucceeds` / `splitNonEmptyLines`——全部 no-throw 封装（失败返回空态而非抛错，env 检测靠它兜底）。

## 2. 消费方

| 消费方 | 用途 |
|---|---|
| 项目根解析（`KTr`） | AGENTS.md 向上搜索的边界（[13 §1](zcode-plan-13-AGENTS.md支持.md)） |
| env_info 提示词节 | "This session is being run in a git repository" + git 状态注入（[18 §2](zcode-plan-18-系统提示词与上下文管理.md)） |
| 文件回滚/检查点 | 变更快照以 git 对象管理（[24 §3](zcode-plan-24-文件变更与回滚.md)） |
| 危险命令分析器 | 7 个 git 命令的旗标级危险判定（[19 §1.2](zcode-plan-19-命令风险评分.md)） |
| 插件安装 | GitHub 归档源（resolveGit*PluginSource） |
| 云同步 | `git` / `git-checkpoint` 两个 IPC 通道 + `git.refresh` RPC（流量表 [27 §3](zcode-plan-27-IPC通道注册表.md)） |
