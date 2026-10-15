# 44 · 3.15.1 机级安装与配置层（2026-10-13 全量复验）

> 调查日期：2026-10-13
> 对象：`C:\Program Files\ZCode`（`@zcode/desktop` **3.15.1**，exe 3.15.1.8093，2026-10-10 装机）
> 复验工具：`tools/reverify_build.js`（全量标识符验尸，报告 `tools/_reverify_2026-10-13.md`）+ `tools/count_strings.js`（定点计数）
> 性质：本机静态核对（A 级 = manifest/文件系统实据；B 级 = bundle/配置读码）

## 1. 安装态（A · 实测）

1. **路径迁移**：桌面端从用户级 `%LOCALAPPDATA%\Programs\ZCode` 迁至机器级 `C:\Program Files\ZCode`；旧路径已清空。43 篇文档与 `tools/asar_pick.js`、`tools/grab.js` 的旧默认路径均已失效——两个工具的默认路径已改为新位置（`ASAR_PATH` / `ZCODE_CJS` 环境变量覆盖仍可用）。
2. **版本线**：桌面 3.14.3 → **3.15.1**。asar 根 `package.json`：`@zcode/desktop@3.15.1`，main `out/main/index.js`，依赖 40 个（ARMS/OTel 组与 09 月一致）。
3. **产物**：`app.asar` 340,511,069 B（324.7 MB）；`resources/glm/zcode.cjs` 15,126,820 B（14.43 MB）——注意这**不是** 09-27 自更新出来的 15.87 MB/0.16.x 束，而是 10-10 装机覆盖回来的安装器内嵌版本（时间戳与全目录一致）。
4. **`.node-bundle-meta.json`**：`source: "apps/zcode-cli/packages/cli/dist/zcode.cjs"`——CLI 束出自 monorepo 的 `apps/zcode-cli` 包（与官方开源仓结构对得上）。
5. **装机完整性**：`.zcode-install-manifest`（1108 条）与磁盘逐条比对，仅差 4 个 NSIS 安装器产物（`Uninstall ZCode.exe`、`elevate.exe`、`uninstallerIcon.ico`、manifest 自身），**无任何重打包/替换痕迹**。
6. **更新源配置实据**：`resources/app-update.yml` generic 更新源 `url: http://localhost:8081`——官方构建出厂自带且跨版本稳定，本机监听者为 zcode-switch，属**适配官方预留通道而非篡改**。供应链面：静默自更的信任链实际落在「谁监听 8081」，electron-updater 仅校验同源 manifest 的 sha512，无独立签名钉扎（详见 46 C13）。

## 2. 全量标识符复验（方法论沿 09-28「验尸」）

- 自动提取：44 篇 docs/*.md 反引号片段 → **1,477** 个标识符（口径比 09-28 的 813 大：含 vendored/SDK/自有脚本名）。
- 逐 token 验尸（cjs 全文 + asar 的 js/cjs/mjs/json + 头 JSON，host 面单列）：

| 存活面 | 数量 | 占比 |
|---|---|---|
| cjs+asar 双活 | 561 | 38.0% |
| 仅 cjs | 359 | 24.3% |
| 仅 asar | 279 | 18.9% |
| 两产物均消失 | 278 | 18.8% |

- **278 个"消失"中三类先天不在包内**（误报，与 09-28 段"约 105 个 SDK/第三方名"同类）：本项目自有脚本名（`call_balance`/`dump_creds`/`solve_pow`…）、阿里云验证码 SDK/服务端配置面符号（`InitCaptcha`/`PowVerifyString`/`WEB_AES_SECRET_KEY`/`FeiLin`/`LimitFlow`/`ACCESS_KEY`…，12 号已声明其来源在 `%TEMP%` SDK 样本与动态下发包）、以及服务端响应值（`zcode-v3-start-plan-0817` 是 plan_id 取值，非 bundle 文本）。
- 扣除误报类后，**真实协议级漂移只有以下四条**（§3），其余各面（V4 签名、off-peak 头、enc:v1、credentialService、getMachineId-win、usage-entitlement localStorage 键、start-plan×34/121 等）全部存活，计数表见 `tools/_reverify_2026-10-13.md` §协议级事实。

## 3. 真实漂移（B · 静态）

1. **OAuth 命名族整体改名**（09-28 复验点名的注册名失效）：`createBigmodelOAuthClient` / `BigmodelOAuthError` / `ZaiCliOAuthError` 在 cjs+host 全 0 命中 → 3.15.1 改为 **`createCliOAuthClient` / `createCliOAuthPollToken` / `CliOAuthError`**（cjs @4388180，`r(fn,"name")` 注册名保留机制仍有效）；zai 侧端点解析注册名族：`resolveZaiOAuthOrigin` / `resolveZaiOAuthClientId` / `buildZaiOAuthUrl` / `resolveRuntimeProductEndpointConfig`（cjs @770576/772544）。`loginBigmodelCodingPlan`（cjs×4）存活。**文档引用规则更新：优先用注册名，且 09 月点名的 OAuth 名以本节新名为准。**
2. **`UNSIGNED_PATHS` 连续两版缺席**（09-28 已登记），路径排除机制重构后未再以该常量名出现；V4 签名六件套（`ClientRequestSigningV4*`/`WD_CLIENT_SIGN_KDF_SALT`/`getSignKey_hmac`/`ed25519_priv`/`sanitizeClientSigningHeaders`）照旧全在 cjs。
3. **URL 字面量 → 配置驱动**：`api/anthropic/v1/messages` 全产物 0 命中（09-28 曾记"协议端点不变"），现形态为 host 侧 `/v1/messages`×20 + `anthropic/v1/messages`×1，端点由 §4 的模板配置（`baseUrl: https://api.z.ai/api/anthropic` + `type: anthropic-messages`）拼装。**协议本身未变，常量拼装面迁移。**
4. **计费/领取收敛 host 定性维持**：`buildZaiStartPlan`/`claimManualPlan`/`getManualClaimPlanPreviews`/`fetchZaiStartPlanBalanceEnvelope` 在 cjs 全 0、host 束各 1–5 命中（与 09-28 结论一致，3.15.1 未回流）。`billing/preview|claim|balance` 同型分布；`agent/configs` 仅 cjs×1。

## 4. 3.15.1 新增明文配置面（B · 静态，本轮最大增量）

### 4.1 `resources/config/provider/zcode-builtin.json`（schemaVersion 1, **revision 31**）

内置供应商模板注册表——**官方版已是多厂商聚合器**。模板 = `access.type` × `api.type` × `baseUrl` × `builtinModelIds`：

| templateId | access | api.type | baseUrl |
|---|---|---|---|
| `zai-api` | `zhipu-coding-plan-api-key` | `anthropic-messages` | `api.z.ai/api/anthropic` |
| `zai-standard-api` | `api-key` | `openai-chat-completions` | `api.z.ai/api/paas/v4` |
| `bigmodel-api` / `bigmodel-standard-api` | 同上两型 | 同上两型 | `open.bigmodel.cn/api/anthropic` / `…/api/paas/v4` |
| `moonshot-kimi` | `api-key` | `anthropic-messages` | `api.moonshot.cn/anthropic` |
| `minimax` | `api-key` | `anthropic-messages` | `api.minimaxi.com/anthropic` |
| `deepseek` | `api-key` | `anthropic-messages` | `api.deepseek.com/anthropic` |
| `qwen-alibaba-model-studio-cn` / `-intl` | `api-key` | `anthropic-messages` / `openai-chat-completions` | `dashscope(.intl).aliyuncs.com/…` |
| `xiaomi-mimo` | `api-key` | `anthropic-messages` | `api.xiaomimimo.com/anthropic` |
| `openai` / `xai` | `api-key` | `openai-responses` | `api.openai.com/v1` / `api.x.ai/v1` |
| `anthropic` / `openrouter` | `api-key` | `anthropic-messages` | `api.anthropic.com/v1` / `openrouter.ai/api` |
| `opencode-go-chat` / `-messages` | `api-key` | 双协议两型 | `opencode.ai/zen/go/v1` |

同文件尾部是 `providerId × modelId` 启用映射，出现 `account:bigmodel-start-plan`、`account:zai-offpeak-idle-plan`、`account:bigmodel-offpeak-idle-plan`，以及 **01 号矩阵未收录的新家族 `account:zai-highspeed-card` / `account:bigmodel-highspeed-card`（极速卡）**（cjs `highspeed`×140、今日日志×11，量级不小）。01 号文档的 `{family}×{planKind}` 矩阵需补 highspeed-card 行。
对 09 号：协议枚举面直接落明文——`anthropic-messages` / `openai-chat-completions` / `openai-responses` 三型即 09 号三协议的配置侧名字。

### 4.2 `resources/config/default.json`

反馈渠道明文实据（26 号外围面）：`feedback_url` = 飞书分享表单（zhipu-ai.feishu.cn），`community_urls` 中文=飞书加群 applink、英文=Discord `z9aBcQXZQ3`。

### 4.3 `resources/glm/packages/` —— 安装器直装 16 个官方插件

`browser-use-plugin`、`zcode-cua-plugin`、`node-repl-host`、`documents-plugin`、`pdf-plugin`、`presentations-plugin`、`spreadsheets-plugin`、`image-search-plugin`、`android-emulator-plugin`、`ios-simulator-plugin`、`visualize-plugin`、`zcode-guide-plugin`、`bundled-skills`、`plugin-creator-plugin`、`skill-creator-plugin`、`restore-legacy-sessions-plugin`。
其中 `bundled-skills/skills/dynamic-workflows/`（SKILL.md + patterns.md + examples.md）＝ 20 号 DWF 的官方技能文档随包分发；`node-repl-host` 带 `.zcode-plugin` manifest（22 号 node-repl 执行底座现以实体包形态装机）。16 号插件系统的"marketplace 分发"面新增一条：核心插件不再只走 zip+sha256 远端分发，**装机即带**。

### 4.4 `resources/tools/`

`cua-helper/`：`windows-helper.js`（1,023,966 B，打包 Node 应用）+ 自带 `node_modules`（express + **sharp** 等）+ `runtime-manifest.json`——22 号 CUA helper 钉定层在本机的实体。`ripgrep/` 与新增的 **`ugrep/`**——33 号搜索栈现在装机带了第二把 grep。

### 4.5 main→host 子进程 env 装配面（B · 静态，10-14 补）

`buildHostProcessEnv`（10-14 对 3.15.3 抽取束取证，装机 3.15.1 同存——现可直接从 `out/main/index.js` 用 asar_pick 复验）：`ZCODE_ENV`、`ZCODE_DATA_BASE_DIR`（**数据目录整体重定向句——桌面侧可指定，透传 CLI 子进程，官方状态隔离面**）、`ZCODE_CUA_HELPER_INSTALL_VARIANT=preview`（预览版专用）、`GLM_BINARY_PATH`、`ZCODE_LARK_CLI_BINARY`，均按条件注入。对 3012 线的实用处：不重装不换号即可用独立数据目录跑独立登录态/状态机（与「伪造 deviceMid」红线无关，纯官方 env）；开发机隔离实验可用。

## 5. 开放项

1. highspeed-card 权益的接口面（balance/entitlement 是否出现 card 类桶）——按 03 号脚本顺带可测。
2. OAuth 改名后设备流/poll 协议是否有变（本节只证"改名"，未证"改协议"）——10 号文档的端点集重跑一次 `count_strings.js` 即可覆盖。
3. 装机内嵌 CLI（14.43 MB）与自更新线（0.16.x）的先后关系：本次 10-10 装机覆盖了 09-27 自更新产物；机级目录下自更新是否还写 `resources/glm`（权限）待下一次自更新观察。

## 6. 受影响文档

| 文档 | 需要的动作 |
|---|---|
| 01 矩阵 | **已补（10-14）**：highspeed-card 两格（baseUrl 标待观察）；providerId 实据（§4.1） |
| 05 V4 | `UNSIGNED_PATHS` 缺席定性延续；签名六件套在 3.15.1 存活 |
| 08/09 | URL 字面量→配置模板拼装（§3.3）；协议三型明文名（§4.1） |
| 10 OAuth | 命名族改名 `createCliOAuthClient`/`CliOAuthError`（§3.1） |
| 11 领取 | 收敛 host 定性维持（§3.4） |
| 12/39/41/42 | 复验数字重定基（§2）；SDK 面不在包内的误报口径同 09-28 |
| 16/20/22/26/32/33 | 装机明文面（§4.3/4.4/default.json/bundled-skills） |
