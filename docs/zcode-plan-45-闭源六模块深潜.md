# 45 · 闭源六模块深潜（3.15.1 逐模块落位与还原）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)；接续 [43 · 官方未开源清单](zcode-plan-43-官方未开源清单.md)
> 日期：2026-10-13 · 对象：`C:\Program Files\ZCode` 3.15.1
> 证据面：`resources/glm/zcode.cjs`（14.43 MB）+ asar 五束：`out/host/index.js`、`out/main/index.js`、`out/main/chunk-CENYP6FK.js`、`out/renderer/assets/styles-*.js`、`out/host/chunk-MR7X55B4.js`（host 伴生束——`uO`/`Co` 真身在彼）。回查：`node tools/asar_pick.js get <束路径> <输出>`（源=本机装机 `C:\Program Files\ZCode\resources\app.asar`）
> 工具链说明：本文落笔时（10-13）rea MCP `rea_analyze_javascript_application` 三连返 `-32602`，后定性为 rea-agents ≤4.0.1 错误路径的 outputSchema 缺陷（上游 6.4.0 已修复；本项调查提报并结案 issue morluto/rea#3020）。本文取证不依赖 rea，全部由本地链（asar_pick get + grab 窗口 + count 矩阵）完成，与 43 号同源同法，结论不受影响；rea 应用图可随时补跑增核。

## 1. 符号落位矩阵（43 号清单逐符号 × 3.15.1 五束）

| 符号 | cjs | host | main | mchunk | rstyles |
|---|---|---|---|---|---|
| `HostDetector` / `ATTR_HOST_ID` / `MachineGuid` | 1 / 3 / 1 | 0 | 0 | 0 | 0 |
| `GetVolumeInformation` / `baseboard` | 0 | 0 | 0 | 0 | 0 |
| `ZCODE_CUA_HELPER_TEAM_ID` / `DOWNLOAD_BASE_URL` / `VERSION` | 0 | 2 / 1 / 1 | 0 | 1 / 1 / 1 | 0 |
| `expectedBundleId` / `allowUnsignedLocalDev` | 0 | 7 / 6 | 0 | 3 / 6 | 0 |
| `claimManualPlan` / `getManualClaimPlanPreviews` / `failureEndsAt` | 0 | 4 / 4 / 1 | 0 | 0 | 1 / 0 / 0 |
| `getBillingDiscount` / `entanglement` / `agent_teams` / `getUserInfo` | 0 | 4 / 0 / 0 / 0 | 0 | 0 | 2 / 0 / 0 / 0 |
| V4 七件套（Manager/Signer/KDF_SALT/getSignKey_hmac/ed25519_priv/sanitize/KeyCache） | 各 1 | 0 | 0 | 0 | 0 |
| `TestClient` / `zcode-test` / `no8xfe` / `11xygtvd` | 0 | 0 | 0 | 0 | 0 |
| `X-Aliyun-Captcha-Verify-Param` | 2 | 0 | 0 | 0 | 1 |

**要点**：闭源面已从 43 号时的"asar 单侧"迁移分布——CUA 钉定与领取/门控现在同时在 host、main、renderer 三束有落点；硬件层符号缩回 cjs（vendored 性质，见 §2.4）；`TestClient` 族与 43 号的 `no8xfe/11xygtvd` 一样在 3.15.1 全 0（消失或改名，登记为已非闭源面）。**注**：矩阵 host 列只数了 `out/host/index.js`；验证码头构造与支付家族判定实际位于同束 `chunk-MR7X55B4.js`（§2.3/§2.5），不在矩阵五束内——首版矩阵据此曾误判 host 无验证码头面，已纠。

## 2. 逐模块还原

### 2.1 V4 请求签名（真闭源，细节从 05）
七件套 token 在 cjs 各 1 命中、asar 侧 0——**整块仍只活在 CLI 束**。协议环、KDF、Ed25519、PoW、7 头与 A/B 实测全部见 [05 §2/§3/§8](zcode-plan-05-V4请求签名协议.md)，不复述。跨版变化仅两处：`UNSIGNED_PATHS` 连续两版缺席（路径排除面重组）；`Signer`/`KeyCache` 独立名存活但注册形式并入 `r(fn,"name")` 面。gate 开启态验证仍开（`tools/probe_sig_gate.py`）。

### 2.2 CUA Helper 钉定（真闭源，全链路还原 · host @530029/@550526/@552608）

**安装计划** `resolveCuaHelperInstallPlan`（ule）：仅 macOS 自动安装（非 darwin 直接 `install_failed`，dev 态可用 `ZCODE_TARGET_OS`/`ZCODE_TARGET_ARCH`/`npm_config_arch` 跨目标）；`ZCODE_HOME`→`~/.zcode`，installRoot = `<home>/computer-use[/dev|/preview]`（变体 `resolveCuaHelperInstallVariant`：env `ZCODE_CUA_HELPER_INSTALL_VARIANT` ∈ 白名单 `[stable, preview, dev-desktop, standalone]` → 否则内部 dev→`dev-desktop` → `ZCODE_ENV==="test"`→`preview` → `stable`；dev 判定 `Un`=`ZCODE_RUNTIME_ENV!=="production"`；`ta`=`isUnsignedHelperLocalDevRequested`= dev 且（`ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL`∈{1,true,on} 或 `xy(e)`）；dev 态另可用 `ZCODE_CUA_HELPER_BUNDLE_ID` 覆盖钉定 bundle id（`Vy`））。**packaged 态拒绝无身份**：缺内嵌 `embeddedBuildId` →「refusing an unpinned Helper install」；缺 bundled appPath →「missing its bundled ZCode Computer Use.app path」。

**钉定值（装机实据，B 级）**：

| 常量 | 值 | 语义 |
|---|---|---|
| `ic` | `8A5X4JJ39T` | **Apple Team ID 钉定值**（packaged 唯一信任锚，dev 可 `ZCODE_CUA_HELPER_TEAM_ID` 覆盖） |
| `Pb` | `pipeline-304023-f18d6db7` | 内嵌 build identity（CI 管线号+commit，`Tle` 校验 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`） |
| bundle id | `dev.zcode.app` / `dev.zcode.app.preview`（host 面）；mchunk 面另有 `dev.zcode.cua-helper` / `dev.zcode.cua-helper.dev` | 两进程束各自钉定不同名的 bundle 面，并存无冲突（`aJe` 冻结 host 面） |
| helper 应用名 | `ZCode Computer Use.app` / `ZCode Computer Use Dev.app` | `resolveHelperAppName`（host `Fd`/mchunk `mr`）按 dev+unsigned 分支选 |
| packaged 版本常量 `$d` | `3.15.1` | packaged 态 runtime version 直接取桌面版本号（与 44 号同版坐实） |
| 下载 URL | `ZCODE_CUA_HELPER_DOWNLOAD_BASE_URL` env 优先；默认 `resolveIntranetDepsBaseUrl` = `http://\${INTRANET_MACHINE_HOST\|\|studio.zcode-ai.com}:12345/zcode/deps/zcode-cua-helper-<版本>[/<buildId>]` | **默认源是内网域名**（3850 端口另有 `/api/intranet/probe`）；文件名 `ZCode-CUA-Helper-<ver>-mac-<arch>.zip`，可用 `ZCODE_CUA_HELPER_DOWNLOAD_URL` 整串覆盖 |
| 限额 | `BH=200 MiB`（`ZCODE_CUA_HELPER_MAX_DOWNLOAD_BYTES`）、超时 30s（`ZCODE_CUA_HELPER_DOWNLOAD_TIMEOUT_MS`）、锁租约 120s（重试 50/退避 32） | 流式字节计数器超限即断（`createDownloadSizeLimiter`） |

**校验链**（`Ky`/`verifyInstalled`，逐环 throw `verification_failed`）：bundleId===expectedBundleId → 版本匹配（bundled 源跳过版本比对）→ buildId===expectedBuildId → Info.plist `CFBundleExecutable` 存在 → `LC_BIN` 架构含预期 → `allowUnsignedLocalDev` 分支（local_dev_unsigned，releaseEligible:false）→ codesign verify → `adHoc` 或无 TeamID 拒绝 → **release 必须有钉定 TeamID：「refusing to trust an unpinned signing team as the TCC owner」** → TeamID===expected。安装面另有 `assertOwnedSecureDirectory`/`assertOwnedSecureLockFile`：安装锁目录禁 symlink/禁 group-write、锁文件必须 owner-only `0600` 且 `nlink===1`（防符号链接抢注/TOCTOU）；`clearQuarantine` 显式去 Gatekeeper 隔离位。元数据落 `.zcode-cua-helper-meta.json`；`ensureInstalled`（Sle）以 appPath 为键的 in-flight Map 去重并发安装、installRoot `mkdir mode 0o700`；`Ple` 对 bundled 源先验现装载荷——变更则整体替换、未变更仅补写 meta。**Windows 无此钉定链**——win 侧 helper 是装机实体 `resources/tools/cua-helper/windows-helper.js`（44 §4.4），钉定体系只保护 macOS TCC 身份。

### 2.3 手工领取（真闭源，全还原 · host @1006055）

- `getManualClaimPlanPreviews`：GET `/api/v1/zcode-plan/billing/preview?app_version&platform`，`Authorization: Bearer <credentialService.load("zcodejwttoken")>`，15s 超时（`Ai=15e3`）；`code!==0` 抛 `msg || manual_claim_preview_failed`；plans[].entitlements[] 展开为 `entitlementId/showName/meter/unitType/capabilities/grantUnits/period/priority/effectiveAt`。
- `claimManualPlan`：POST `/api/v1/zcode-plan/billing/claim`，头 = Bearer + `...uO(t)` + `X-ZCode-App-Version` + `X-Platform`；体仅 `{plan_id}`。**`uO` 真身已取穿**：host 经 import 别名 `Gb as uO` 引自 `chunk-MR7X55B4.js`（该束导出表 `r9 as Gb`，@819538），指向注册名 `requestVerificationClaimHeaders`（chunk @581179）——返回 `{"X-Aliyun-Captcha-Verify-Param": t.captchaVerifyParam, "X-Aliyun-Captcha-Verify-Region"?}`；CLI 侧 cjs @757814 另有同名实现 `IZi` + 头名组 `dfr` + `withoutRequestVerificationHeaders`（FYt，剥离面）+ 门码 `coding_plan_security_verification_required`（xZi）。**即 12 号验证码链在 CLI/host 两侧同构，claim 必带 verify-param 头**；renderer 营销触点 `claimManualPlan({planId,...t})`（rstyles @4624017）先走 `verifying` 态拿 param，终码 `[1001..1005]`，成功后 force 刷新权益 + `refresh("marketing-plan-claim")`。
- **`failureEndsAt` 语义（本轮新证）**：失败分支（`code!==0` 或无 plan）时服务端回体仍携带 `data.plan.ends_at`，客户端以 `failureEndsAt` 返回——**失败也拿到本期窗口终点，供 UI 冷却/不再重试**；成功分支返回完整 `plan{userPlanId,planId,status,startsAt,endsAt,entitlements}`。`server_time` 秒→毫秒（`readServerTimeMilliseconds`）。
- 同 Provider 常量面：`Ti="/api/biz"`、`jK="/api/pay"`、`Whe="/api/v1/client/configs"`、缓存 `$he=3600*1e3`（**1h client-config 缓存实据**，05/11 的"1h 缓存"由此坐实）。

### 2.4 设备指纹/硬件探测层（**改判：vendored OTel，非 ZCode 自有闭源** · cjs @13638938）

`HostDetector`/`OSDetector`/`ProcessDetector`/`getMachineId` 平台 switch、`ATTR_HOST_*` 语义约定键——cjs 该段是 **`@opentelemetry/resources` 逐字打包**（asar 根 package.json 依赖 `@opentelemetry/resources@2.6.1`，开源仓不含 node_modules 故"仓库 0 命中"）。`GetVolumeInformation`/`baseboard` 在 3.15.1 全束 0 命中（3.14.3 时代为旧 OTel 实现的残留）。结合 39 号「拆全包确认 ZCode 自有码不读硬件指纹」：**43 号模块 4 撤销「官方未开源」定性，登记为依赖面口径差。**

### 2.5 企业计费/权益门控（部分真闭源 · host @1008244/@1003651）

- `getBillingDiscount()` = `unwrapClientConfigBillingDiscount(await client/configs)`——**纯薄壳，读服务端配置键 `codingPlanBillingDiscount`**；同族还有 `startPlanPreview`（`sye`）、`getRequestVerificationConfig`（验证码）、`getForceUpdateConfig`。"闭源"实际闭在**服务端配置面**，客户端逻辑无秘密。
- 真门控实据：`createSign`/`updateSign`（支付宝代扣 `/pay/create-sign`、`/pay/product/update/sign`）头部即 `if (Co(providerId)) throw new Error(jR)`（`jR="coding_plan_zai_overseas_payment_required"`）——**`Co` 真身已取穿**：`isZaiCodingPlanProviderId`（chunk @503158，导出 `WE as Ra`）= `providerId ∈ {zaiIndividualCodingPlan, zaiTeamCodingPlan, zaiStartPlan}`，**zai 三格（含免费 start-plan）代码封死国内代扣**。同函数族给出 01 号矩阵的代码级枚举：`isStartPlanModelProviderId`={zai,bigmodel}×startPlan、`isCodingPlanModelProviderId`=两族×三型全 6 格、`FE={zai:"account:…"}` providerId 前缀映射；`preview` 走 `eye(providerId)` 路由，默认 `salesChannel="zcode"`，携带 `invitationCode/imRef/ticket/randstr`。与 29 号"三套支付通道"咬合。
- **改判**：43 号本模块的 `entanglement`/`agent_teams`/`getUserInfo` 三个符号在 3.15.1 五束 0 命中（asar 全扫命中皆 playwright/OTel 噪声）——登记为**当时的误报**（与 39 号误命中清单同类），不属于闭源面。

### 2.6 验证码 param 与测试 client（无新面）

param 生成仍不在任何 bundle（头字符串 cjs×2/rstyles×1，生成走动态 SDK——12 号结论维持）；`no8xfe/11xygtvd` 连续缺席；`TestClient`/`zcode-test` 全 0，43 号模块 6 在 3.15.1 判**已消失或改名**，不再追。

## 3. 定性汇总

| 43 号模块 | 3.15.1 定性 | 状态 |
|---|---|---|
| 1 V4 签名 | 真闭源（cjs 独有） | 细节在 05，gate 开启态仍开 |
| 2 CUA 钉定 | 真闭源，**全链路已还原**（§2.2，含钉定值） | 完成 |
| 3 手工领取 | 真闭源，**协议+语义+头注入全取穿**（§2.3） | 完成；live 复测并入 37 §8 |
| 4 硬件探测 | **改判：vendored OTel**（§2.4） | 撤销闭源定性 |
| 5 企业门控 | 部分真闭源：门控在**服务端配置键**与 `jR` 封禁（§2.5）；三符号误报撤销 | 完成 |
| 6 验证码 param / 测试 client | 生成在外部 SDK（12）；测试 client 符号消失 | 无新面 |

## 4. 本轮新增环境变量清单（B · 静态，节选自 §2）

`ZCODE_TARGET_OS` `ZCODE_TARGET_ARCH` `npm_config_arch` `ZCODE_CUA_HELPER_{VERSION,BUILD_ID,TEAM_ID,DOWNLOAD_URL,DOWNLOAD_BASE_URL,DOWNLOAD_TIMEOUT_MS,MAX_DOWNLOAD_BYTES,INSTALL_VARIANT,BUNDLE_ID,ALLOW_UNSIGNED_LOCAL}` `ZCODE_RUNTIME_ENV` `ZCODE_DEPS_BASE_URL` `INTRANET_MACHINE_HOST` `ZCODE_OFFPEAK_MOCK`（off-peak 本地 mock 后门）`ZCODE_E2E_COVERAGE`+`NODE_V8_COVERAGE`（host 覆盖率刷写门）`ZCODE_ENV=test`（preview 变体）。

## 5. 受影响文档

- [43](zcode-plan-43-官方未开源清单.md)：§2 模块 4/5/6 需按 §2.4/2.5/2.6 改判（43 已加标注）。
- [22](zcode-plan-22-CUA与浏览器自动化.md)：补钉定安装链与内网默认源（§2.2）。
- [11](zcode-plan-11-签到领取接口.md)/[12](zcode-plan-12-阿里云验证码体系.md)：`failureEndsAt` 冷却语义、`uO` 头注入别名、1h config 缓存（§2.3）。
- [29](zcode-plan-29-支付与订购系统.md)：`coding_plan_zai_overseas_payment_required` 封禁面（§2.5）。
- [39](zcode-plan-39-设备指纹分层.md)：与本文 §2.4 的改判一致，互证成立。
