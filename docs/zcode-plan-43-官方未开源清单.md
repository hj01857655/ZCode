# 43 · 官方未开源清单

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 证据：`zai-org/ZCode`（★6892，Apache-2.0，TypeScript）**产物 vs 源码逐符号对照**
> 建立时间：2026-09-28

## 0. 这份文档解决什么问题

doc 05（V4 签名）、doc 39（设备指纹）里的主题，在开源仓库里**一行都没有**。反复去找只会得出「没找到」的结论。

本文把这部分**显式登记为「官方未开源」**，让后续不必再把它当「待解的谜」重复挖。

**唯一可靠的信息来源是构建产物**：

```
%LOCALAPPDATA%\Programs\ZCode\resources\app.asar     311.8 MB  桌面端
%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs 15.9 MB  CLI 主 bundle
```

提取：`node _re/asar_pick.js get out/host/index.js <输出>`，再 `ZCODE_CJS=<输出> node _re/grab.js <符号>`

## 1. 仓库形态

```
29628c9  2026-09-23  feat: update v3.14.3        283 files
872ad96  2026-09-21  feat: open source       6973 files, +1033262   ← 103 万行一次性进入
77432b6  2026-09-20  Initial commit
```

**历史只有 3 个提交，`Initial commit` 与 `open source` 相隔一天。** 这是「开源前新建空仓库 + 灌入当前快照」，
**不是持续开发史**。故 `git log -S` 无法用于判断「是否删过代码」——那些字符串历史上从未出现过，
既不能证明被删，也不能证明曾存在。

## 2. 未开源清单（2026-09-28 逐符号核对）

判据：同一符号在 `app.asar` 产物中存在、在开源仓库中 0 命中。

| # | 模块 | 关键符号（产物有 / 仓库无） | 关联文档 |
|---|---|---|---|
| 1 | **V4 请求签名** | `ClientRequestSigningV4Manager` `WD_CLIENT_SIGN_KDF_SALT` `getSignKey_hmac` `ed25519_priv` `sanitizeClientSigningHeaders` `Signer` `KeyCache` | [05](zcode-plan-05-V4请求签名协议.md) |
| 2 | **CUA Helper 钉定** | `ZCODE_CUA_HELPER_{TEAM_ID,DOWNLOAD_BASE_URL,VERSION}` `expectedBundleId` `allowUnsignedLocalDev` | [22](zcode-plan-22-CUA与浏览器自动化.md) |
| 3 | **手工领取** | `claimManualPlan` `getManualClaimPlanPreviews` `failureEndsAt` | [11](zcode-plan-11-签到领取接口.md) |
| 4 | **设备指纹 / 硬件探测** | `HostDetector` `MachineGuid` `baseboard` `ATTR_HOST_ID` `GetVolumeInformation` | [39](zcode-plan-39-设备指纹分层.md) |
| 5 | **企业计费 / 权益门控** | `getBillingDiscount` `entanglement` `agent_teams` `getUserInfo` | [29](zcode-plan-29-支付与订购系统.md) |
| 6 | **阿里云验证码 param 生成** | 请求头 `X-Aliyun-Captcha-Verify-Param` 产物有 2 处、仓库 0；**`no8xfe` / `11xygtvd` 产物亦无** | [12](zcode-plan-12-阿里云验证码体系.md) |

> 第 6 项注意：产物里**也只有请求头，没有生成逻辑**。param 生成走运行时动态加载的阿里云无痕 SDK，
> 不在任何 bundle 内。**唯一已知路径是 doc 12 §5c 逆向出的 `WEB_AES_SECRET_KEY` 5 项明文 + IV 派生。**

### 对照：确实开源的部分

`packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts`（**51.7 KB，完整**）
含 `/pay/batch-preview`、`/pay/zai-preview`、`checkPayment`、`bindStripeCard`、`subscribePaypal`、`createSign` 等全部支付逻辑。
`ZaiCodingPlanSubscriptionProvider.ts` 3.0 KB。**支付侧一行未藏。**

分界不在「商业 vs 开源」，而在于**能直接发放/消耗权益**与**能证明客户端身份**的模块被单独剔除。

## 3. 端点环境变量：不是删除，是改名收敛

`.env.example` 实际内容：

```
ZCODE_BASE_URL=https://zcode.z.ai
BIGMODEL_API_BASE_URL=https://bigmodel.cn
ZAI_BUSINESS_BASE_URL=https://api.z.ai
ZCODE_CDN_BASE_URL=https://cdn-zcode.z.ai
ZCODE_REMOTE_ASSET_CDN_BASE_URL=https://cdn-zcode.z.ai/zcode/electron/releases/3.14.0
```

`.env.production` 注明：

> 默认线上地址由 shared endpoint resolver 提供；覆盖请使用通用变量。

即 doc 10 §0.1 记录的 `ZCODE_{PRODUCTION,TEST}_BASE_URL` 双轨，在开源版改为
**通用 `ZCODE_BASE_URL` + `ZCODE_ENV` 开关**（`buildZCodeApiUrlFromEnv` → `buildRuntimeZCodeApiUrl`）。

**这是主动收敛而非遗漏**——测试后端地址不外泄，但保留了可配置性。doc 10 §0.1 的变量名仅适用于产物，不适用于开源仓。

## 4. 已开源、可直接读源码的部分

| 主题 | 位置 |
|---|---|
| OAuth 设备流（含 `startOAuthWithPolling`） | `packages/services/src/oauth/oauthService.ts` |
| CLI 登录编排 | `apps/zcode-cli/packages/bootstrap/src/auth-login.ts` |
| api-key 解析 | `apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts` |
| 反馈上传 `upload-credential` | `packages/desktop/src/main/networkTelemetryAggregator.ts` |
| 端点常量表 | `packages/shared/src/zcodeEndpoint.ts` |

**`oauthService.ts` 是唯一能用真源码校验 OAuth 实现的入口**（此前所有结论均来自 minified 或 host 层反推）。

## 5. 仍未验证的开放项

| 项 | 状态 |
|---|---|
| **V4 签名门在启用态的表现** | 官方闭源。doc 05 的结论全部来自产物/实测，无源码可对 |
| **HostDetector 是否真的执行** | 同上，硬件探测层整块未开源 |
| **telemetry 资源出口** | 事件上报在 `telemetryCore.ts`（开源），但服务端接收端不在本仓 |
| **plan_id 递增规则** | 需观察 2026-09-28 09:00 窗口到期后 diff（基线 `_re/plan_baseline.json`） |

> 前两项的性质已从「逆向未完成」变为「**无官方答案**」。继续静态挖掘的边际收益趋零，
> 剩余信息只能来自 `out/host/index.js`。

## 6. 2026-10-13 改判复核（见 [45](zcode-plan-45-闭源六模块深潜.md)，对象换为 3.15.1）

- **模块 4 撤销**：`HostDetector`/`ATTR_HOST_ID`/`MachineGuid` 系 `@opentelemetry/resources@2.6.1` vendored 逐字打包（仓不含 node_modules 才造成「仓库 0 命中」口径差）；`GetVolumeInformation`/`baseboard` 3.15.1 全束 0。
- **模块 5 部分撤销**：`entanglement`/`agent_teams`/`getUserInfo` 判为当时误报（命中皆 playwright/OTel 噪声）；真门控 = 服务端配置键 `codingPlanBillingDiscount` + `jR="coding_plan_zai_overseas_payment_required"` 封禁国内代扣。
- **模块 6 撤销**：`TestClient`/`zcode-test` 全束 0（消失或改名）；验证码 param 生成本就在外部 SDK（12 号），不算 bundle 闭源。
- **模块 2/3 已完整还原**：钉定值 Apple TeamID `8A5X4JJ39T`、buildId `pipeline-304023-f18d6db7`、下载默认源内网 `studio.zcode-ai.com:12345/zcode/deps`；claim 全协议 + `failureEndsAt` 冷却语义——见 45 §2.2/2.3。
- **模块 1 维持**：V4 七件套全在 cjs，细节仍在 05；gate 开启态仍开。
