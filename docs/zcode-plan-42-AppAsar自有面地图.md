# 42 · app.asar 自有面地图（host / main / scheduler / preload / renderer）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 工具：`tools/asar_symbols.py`（asar 头按需读取，不解包 311MB 归档；TS 差集 + 聚类 + 文档求交，可重跑）
> 性质：**B 级静态**——名字与聚类；语义列均为 **C 级**推断
> 关联：CLI 侧地图见 [41](zcode-plan-41-未探索子系统地图.md)（本篇是其 §4 边界的兑现）

## 0. 结论

1. 54 个自有束（扫描器已升级为**目录模式匹配**，哈希文件名随版本更新自动跟随）TS 差集后 **自有长名 11,944 个**，43 篇文档触达 526（**4.4%**）——比 CLI 侧（3.0%）高，因为多份专题的证据源本来就是 host 侧；聚成 9,066 个家族。
2. **Bot 投递体系（[36](zcode-plan-36-Bots投递体系.md)）拿到实体证据**：host 侧有成体系的**飞书通道**（`read.feishu`×16 + `build.feishu`×11：app secret/display name/附件/卡片/elicitation）与**微信通道**（`read.weixin`×12：chatId/附件）+ `format.bot`×11 回复格式化——"本机未配置"只是没接线，实现是全的。
3. **独立 scheduler 进程**（`out/scheduler/index.js`，2,708 名）——[31](zcode-plan-31-Cron调度循环.md)/[06](zcode-plan-06-off-peak档位.md) 的宿主不在 host/main 里，是单独进程。
4. **远程体系带 ARMS 上报**：`create/build/report.remote`×58（新 chunk 涌现 `createRemoteAssetInstaller`/`buildRemoteAgentBundleWrapper`）——远程连接 + **阿里云 ARMS RUM 遥测**（node_modules 的 `@arms/rum-electron` 印证）；[26](zcode-plan-26-外围子系统.md) 遥测表的云端去向。
5. **CUA helper 是独立下载组件**（`resolve.cua`：downloadBaseUrl/installPlan/installRoot）——[22](zcode-plan-22-CUA与浏览器自动化.md) 的 BrowserView 管理族（`browser.view`/`on.browser`×20）在 host 侧。

## 1. 束分布（TS 差集后长名数）

| 束 | 长名 | 角色 |
|---|---|---|
| `out/host/index.js` | 6,213 | host 主束：RPC provider、工具执行、验证码闸（[03](zcode-plan-03-billing-balance-接口与实调.md)/[08](zcode-plan-08-聊天对话接口.md) 的证据源） |
| `out/host/chunks` ×16 | 4,145（最大 B7L5SK4K 2,247 / EBZ6RJTQ 693 / NKOHJ4QI 571 / 6KPGI2BV 388） | host 分包（模式匹配新纳入） |
| `out/scheduler/` ×3 | 2,551 | 独立调度器进程：cron/off-peak **+ 会话运行面**（conversation/attachment/interaction 家族在列） |
| `out/main/index.js` + chunks×20 + workers×3 | 6,860（最大 GJUBRD53 2,199 / DWFG5IO7 388 / WL3GKHVV 340） | Electron 主进程 + 存储/数据量 worker |
| `out/preload` ×6 | 11,332（各 1,859–1,995） | 场景 preload 全量：主/codingPlan/rewards/cuaPermission/resourceManager/browserDialog |
| `out/renderer/assets/src-*` ×4 | 1,550 | UI 应用代码（其余 assets 大多为 vendor：mermaid/echarts/pdf） |

## 2. 家族地图（top 40 按成员数；语义 = C 级）

### 2.1 Bot 投递通道（36 号的实体层）

| 家族 | 成员 | 样例 |
|---|---|---|
| `read.feishu` | 16 | readFeishuAppDisplayName/AppSecret/Attachment |
| `build.feishu` | 11 | buildFeishuButtonElement/ElicitationAnswerElements/ElicitationCardPayload |
| `read.weixin` | 12 | readWeixinAttachmentItem/Attachments/ChatId |
| `format.bot` | 11 | formatBotAssistantReplyBlocks/ChangeSummary/DiffCount |

elicitation（卡片问答）支持说明 bot 通道可承载交互，不止单向通知（C 级）。

### 2.2 远程与遥测

| 家族 | 成员 | 样例 |
|---|---|---|
| `create.remote` | 20 | createRemoteBackend/ConnectionProgressContext/**AssetInstaller**/ConversationShareArtifactSource |
| `build.remote` | 29 | buildRemote*ArmsPayload×N / **AgentBundleWrapper** |
| `report.remote` | 9 | reportRemoteConnectResultToArms(Safely)/RemoteConnectionStateChanged |
| `conversation.workflow` | 14 | conversationWorkflowRunArtifactData(V4)/ArtifactRead |

### 2.3 配置、迁移与路径

| 家族 | 成员 | 样例 |
|---|---|---|
| `get.user` | 18 | getUserAgentsSkillRoot/**getUserClaudeSettingsPath**/getUserCliConfigPath |
| `get.workspace` / `resolve.workspace` | 15/13 | getWorkspaceConfigFrameEmitter / resolveWorkspaceHookConfiguredGates |
| `migrate.legacy` | 9 | migrateLegacyAccountConnectionSettings/BuiltinAgentCliProviders/CommonMcp |
| `resolve.desktop` | 10 | resolveDesktopContextPromptConfig/ForceUpdateRequirement |

`getUserClaudeSettingsPath` 印证 [13](zcode-plan-13-AGENTS.md支持.md) 的 Claude 配置迁移层；`migrate.legacy` 三件套对应 [10](zcode-plan-10-OAuth登录流程.md) 的运行时迁移。

### 2.4 其余带

| 家族 | 成员 | 备注 |
|---|---|---|
| `is.z` / `resolve.z` / `get.z` / `create.z` / `build.z` | 18/17/15/9/9 | ZCode 专属判定/解析（与 CLI 侧同词表，host 侧另一份） |
| `browser.view` + `on.browser` | 20 | BrowserView 挂载/关闭/ready 事件族 |
| `resolve.cua` | 9 | ✅ **已挖（落 [22 §6](zcode-plan-22-CUA与浏览器自动化.md)）**：下载源/构建校验/签名钉定/安装根目录全链 |
| `resolve.off` | 12（触 2） | off-peak host 侧：AllowedModels/ClientConfig/CodingPlanSupport |
| `is.coding` + `coding.plan` | 9+12（触 4） | coding plan 嵌入 webview 判定（[11](zcode-plan-11-签到领取接口.md)/[07](zcode-plan-07-UI文案与行为.md)） |
| `register.host` / `create.host` | 19 | host 进程注册与命令信封（[27](zcode-plan-27-IPC通道注册表.md)） |
| `resolve.model` / `normalize.model` / `create.provider` | 10/9/10 | host 侧模型目录与 provider 配置 |
| `wait.for` | 33（触 1） | 等待原语 |
| `frame.assembly` | 14 | frameAssemblyBudgetExceeded/**ChecksumMismatch**——帧装配子系统（模式匹配升级后新现身，语义 C 级） |
| `get.task` | 16 | getTaskConfigOptions/Emitter/Meta——任务配置层 |
| `u.ff` | 17 | **噪声**（全角括号 `uFF08` 伪名），忽略 |

### 2.5 scheduler 束首扫（2026-09-28，3 束 / 自有长名 2,551 / B 级）

调度器不止 cron：`off.peak`×5（create/list/runType，[06](zcode-plan-06-off-peak档位.md) 的进程侧）、`logical.frame`×7（帧装配限额：MaxBytes/MaxConcurrent/MaxFragments——与 host 侧 `frame.assembly` 呼应，流式断点相关）、`build.conversation`×5（artifact 候选/分享快照）、`interaction.request`×4（权限/provider 头）、`workspace.update`×4、`attachment.upload`×4、`max.concurrency`×3、`provider.family`×4、`zcode.plan`×4（端点注册表副本，含 `BillingCurrentUrl`）。**判定（C 级）**：scheduler 是"定时触发 + 会话运行面"的宿主，不是纯 cron——[31](zcode-plan-31-Cron调度循环.md)/[17](zcode-plan-17-云端会话与远程体系.md) 的进程归属需要按此修正。下一锹：`off.peak` 五函数 + `logical.frame` 限额常量。

## 3. 边界与下一步

- 名字抽取 = 字符串字面量 + 标识符双通道；TS 差集剔除 vendored；未减其他 vendor（react 等在 renderer 侧占比高，见 `src-*.js` 仅 1,550 名）。**扫描器按目录模式选束**（`out/host|main|scheduler|preload|renderer assets/src-*`），ZCode 更新换哈希名不失效。
- preload 6 个场景已**全量扫描**（2026-09-27 模式匹配升级）——[29](zcode-plan-29-支付与订购系统.md) 的支付 webview 与 [36](zcode-plan-36-Bots投递体系.md) 的 rewards webview 入口在库。
- 建议开挖顺序（C 级）：① `read/build.feishu` + `format.bot` → 36 号从"投递目标"升级为"通道实现"；② `resolve.off` + scheduler 束 → 06 号拿到 host 侧队列实现；③ `conversation.workflow` → 17 号 artifact 同步；④ `resolve.cua` → 22 号安装体系。
