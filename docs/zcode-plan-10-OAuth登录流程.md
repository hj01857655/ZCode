# 10 · OAuth 登录流程

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 证据：`zcode.cjs` 登录编排层（原始函数名齐全：`loginZCodeCli`/`loginBigmodelCodingPlan`/`persistStandaloneCodingPlanConnection` 等）
> 关联：凭证加密见 [02](zcode-plan-02-认证与凭证存储.md)，balance 接口见 [03](zcode-plan-03-billing-balance-接口与实调.md)

## 0. 两条登录链路总览

| | Z.ai（zai 家族） | BigModel（bigmodel 家族） |
|---|---|---|
| 模式 | **纯轮询设备流**（无本地回调） | **标准授权码流 + 本地回调服务器** |
| 编排函数 | `VHa` = `loginZCodeCli` | `HHa` = `loginBigmodelCodingPlan` |
| 后端 | `https://zcode.z.ai/api/v1/oauth/cli/{init,poll}` | `https://open.bigmodel.cn/login` + `/api/auth/tokenByAuthCode` |
| 浏览器打开的 URL | **服务端下发**的 `authorize_url` | 客户端拼接的 `{origin}/login?appId=zcode&redirect=…&state=…` |
| 产物 | `zcodejwttoken` + `oauth:zai:access_token` + user_info | `oauth:bigmodel:access_token`(+refresh) + user_info |

> **命名澄清**：账号家族只有 `zai` 和 `bigmodel` 两种（`wXe` 数组仅此二者，`oauth:active_provider` 取值亦然）。"zcode" 出现的三处都不是第三种家族：① ZCode 是客户端产品名；② `loginZCodeCli` 是 CLI 登录编排函数名，它登的是 **zai 家族**；③ BigModel 授权 URL 里的 `appId=zcode` 是 bigmodel 开放平台上注册的第三方应用 ID，不是家族名。两条链路最终都在各自业务域（api.z.ai / open.bigmodel.cn）创建名为 `zcode-api-key` 的 API key。

> **接线现状（2026-09-28 复核，实证已修正上一版）**
>
> 上一版称"桌面端两族都走统一的 `startOAuthWithPolling(provider)`"。**该结论错误**，复核结论如下（`%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`，15.9 MB；提取工具 `_re/grab.js`）：
>
> 1. **`startOAuthWithPolling` 符号不存在**（bundle 内 0 命中）。
> 2. **设备流客户端 `Xdn` 只支持 zai**：`init()` 的 body 是 `JSON.stringify({ provider: j7s })`，`j7s` 是模块常量 `"zai"`，**不是参数**。编排函数 `VHa = loginZCodeCli` 同样写死 `saveZaiLoginCredentials` / `g.zai.access_token` / `providerId:"zai"`。**客户端不存在 bigmodel 版设备流。**
> 3. **BigModel 授权码流实现完整且对外导出，但既无人调用、调了也失败**：
>    - `HHa = loginBigmodelCodingPlan` 全 bundle 仅 3 次引用——定义、`r(HHa,"loginBigmodelCodingPlan")` 注册、SDK 导出表 `loginBigmodelCodingPlan: () => HHa`。**零调用点。**
>    - `OZr = createBigmodelOAuthClient` 的 `appSecret` 取 `e.appSecret?.trim() ?? ""`，**无默认值**；`exchangeCode` 开头 `if (!n) throw new kct("BigModel OAuth appSecret is required.")`。
>    - 而 `HHa` 内是 `OZr({ httpClient: n })` —— **只传了 httpClient**，故 `appSecret` 恒为 `""`，走到换 token 必抛 `BigmodelOAuthError`。
>    - 结论：上一版"appSecret 无来源"应更正为 **"调用方 `HHa` 压根没传"**；外部调用者需自建 `OZr` 并传 appSecret 才走得通。
> 4. **实际可用的 bigmodel 路径是服务端扩展**：统一设备流 + 服务端回调代换。`zcode.z.ai` 在 `/api/v1/oauth/cli/callback/bigmodel` 处校验 state↔flow、拿 code 去 bigmodel 换 token（appId 的 secret 在它服务端手里），客户端因此**永远不需要 appSecret**。`POST cli/init {"provider":"bigmodel"}` 实测 HTTP 200 并下发 `bigmodel.cn/login?appId=zcode&redirect=…&state=…`；实测 ready 载荷为 `{status, token, user, bigmodel:{access_token}}`，与 §1.4 同形。
>
> 即：设备流在**客户端**是 zai-only，在**服务端**是两族通用——本项目走的正是后者。

> **外部报告的 `POST /api/v1/oauth/token` 已排除（2026-09-28）**：plan-38 从第三方报告收录的「code 直换 token」端点（body `{provider, code, redirect_uri, state}`），在 `zcode.cjs`（0.16.x 线，15.87 MB）全量检索 `oauth/token` **0 命中**；全 bundle 仅 3 处 `/token` 字面量，均属 MCP OAuth OIDC 标准库的 `grant_type=refresh_token`（见 [23 §2](zcode-plan-23-Hooks与MCP客户端.md)），与 ZCode 自有登录链路无关。本文件的 `cli/init` + `cli/poll`（zai 设备流）与 §2 bigmodel 本地回调授权码流即 bundle 内**全部** OAuth 通道，不存在第三条。

两条链路最终都汇聚到同一步：**解析出 coding plan API key 并写入凭证 + 默认供应商配置**。

## 0.1 家族与域名机制（`providerFamilyDomain`）

**国际版与国内版在同一个 bundle 内**，`providerFamilyDomain` 是切换开关（2026-09-27 逆向 `resources\glm\zcode.cjs` @14.1 MB）。

### 取值（`normalizeProviderFamilyDomain` = `bpr`）

```js
$rr = m.object({
  providerFamilyDomain: m.enum(["zai", "bigmodel"]).nullable(),
  providerFamilyConnectionSelections: Dpe
}).strict()
```

三个取值：`"zai"` / `"bigmodel"` / `null`。

实机佐证（2026-09-27，`setting.json`）：`providerFamilyDomain: "zai"`、`providerFamilyDomainMigrated: true`、`providerFamilyDomainUpdatedAt: 1790446539339`（本地时间 2026-09-27 02:15:39）——迁移字段实存，本机当日发生过一次运行时迁移，当前取国际域。

函数级校验层（2026-09-27，B 级）：`resolveModelProviderFamilySpecByProviderId`（`vpr`）链上 `bpr` 只认 `zai`/`bigmodel` 两值，`WKt` 由 activeOAuthProvider 反推家族（`oXe`→bigmodel，否则 zai），`VKt`/`Spr` 校验 familyId 与 `providerFamilyDomain` 一致（domain 为 null 时放行）——上方迁移字段就是这组校验的落点。

### 家族规格表（`wXe` = `MODEL_PROVIDER_FAMILY_SPECS` @959100）

```js
wXe = [
  { id:"zai",     label:"Z.ai",     rootDomain:"z.ai",         oauthProviderId:"zai",
    startPlanProviderId, individualCodingPlanProviderId, teamCodingPlanProviderId,
    teamCodingPlanManageUrl:"https://z.ai/manage-apikey/subscription" },
  { id:"bigmodel", label:"BigModel", rootDomain:"bigmodel.cn", oauthProviderId:oXe,
    …, teamCodingPlanManageUrl: bHt({ ZCODE_ENV: Epe }) }
]
```

**`rootDomain` 是国际/国内的直接判据**：

| `id` | `rootDomain` | 版本 | 账号 |
|---|---|---|---|
| `zai` | `z.ai` | **国际版** | doc 10 §1 设备流产物（`zcodejwttoken`） |
| `bigmodel` | `bigmodel.cn` | **国内版** | doc 10 §2 授权码流产物 |

导出函数：`getModelProviderFamilySpec`、`resolveModelProviderFamilyIdByProviderId` / `ByBaseURL`、`resolveProviderFamilyLabel…`、`shouldShowModelProviderFamilyForDomain` / `ForActiveOAuth`。

### 显示与过滤（关键逻辑）

```js
function VKt(e) {                       // shouldShowModelProviderFamilyForDomain
  let t = bpr(e.providerFamilyDomain);
  return t ? e.familyId === t : !0;      // ← 未设 = 不过滤，两族都显示
}
```

**`providerFamilyDomain` 为 `null` 时不做家族过滤**（`!0` 即 `true`）；一旦设为某族，就只显示该族。设置项里的 `providerFamilyConnectionSelections` 与之配对。

### 域名与 client_id 常量表（`Gpe` @711094）

| 符号 | 值 | 用途 |
|---|---|---|
| `jee` | `https://zcode.z.ai` | ZCode 生产（国际） |
| `sYe` | `https://zcode.chatglm.site` | ZCode 测试 |
| `Zor` | `http://localhost:3000` | 本地 dev |
| `Yor` | `https://bigmodel.cn` | BigModel 生产（国内） |
| `Xor` | `https://dev.bigmodel.cn` | BigModel dev（国内） |
| `Qor` | `https://chat.z.ai` | 授权页（国际） |
| `eir` | `https://zai-test.chatglm.site` | zai 测试 |
| `tir` | `https://api.z.ai` | zai API（国际） |
| `nir` | `https://api.chatglm.site` | zai API 测试 |
| `rir` | `client_P8X5CMWmlaRO9gyO-KSqtg` | **生产 OAuth client_id**（`DEFAULT_ZAI_OAUTH_CLIENT_ID`） |
| `oir` | `client_RzngVdSk8sYsG2_3HzOMdQ` | **测试 OAuth client_id**（`TEST_ZAI_OAUTH_CLIENT_ID`） |
| `iir` | `wss://zcode.z.ai/ws` | WebSocket |
| `sir` | `3.4.0` | 客户端版本号 |

### 端点解析：三层环境选择（`Gpe` 全套）

**环境判定**（`resolveRuntimeZCodeEnv` = `YL`）：

```js
function YL(e = {}) {
  return e.ZCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production";
}
```

**默认即 production**——只有 `ZCODE_ENV=test` 才进测试环境。这解释了 §1.2b 为什么抓到的是生产 `client_id`。

六个解析器，**结构完全一致**：`环境 → 环境变量覆盖 → 常量兜底`：

| 解析器 | 导出名 | production | test |
|---|---|---|---|
| `SHt` | `resolveZaiOAuthOrigin` | `chat.z.ai`(`Qor`) | `zai-test.chatglm.site`(`eir`) |
| `cir` | **`resolveZaiOAuthClientId`** | `rir` | `oir` |
| `wHt` | `resolveZaiBusinessBaseUrl` | `api.z.ai`(`tir`) | `api.chatglm.site`(`nir`) |
| `XAe` | `resolveBigModelApiOrigin` | `bigmodel.cn`(`Yor`) | `dev.bigmodel.cn`(`Xor`) |
| `air` | `resolveZCodeEndpointOrigin` | `zcode.z.ai`(`jee`) | `zcode.chatglm.site`(`sYe`) |
| `Y8i` | `resolveWebRemoteControlRelayWsUrl` | `wss://zcode.z.ai/ws`(`iir`) | `wss://zcode.chatglm.site/ws` |

`cir` 完整形态（`client_id` 的四级回退链）：

```js
function cir(e = {}) {
  let t = YL(e),
      n = vHt(e, t, "ZAI_TEST_OAUTH_CLIENT_ID", "ZAI_PRODUCTION_OAUTH_CLIENT_ID"),
      o = t === "production" ? rir : oir;
  return qO(e,"ZAI_OAUTH_CLIENT_ID") ?? n ?? qO(e,"ZAI_OAUTH_APP_ID") ?? o
}
// 优先级：ZAI_OAUTH_CLIENT_ID > 环境变量 > ZAI_OAUTH_APP_ID > 常量兜底
```

**两个 `client_id` 不是国内/国际之分，是生产/测试之分**——`resolveZaiOAuthClientId` 属于 zai 家族专属（`SHt`/`wHt`/`cir` 三个都是 zai 侧）。

BigModel 侧的 URL 构造走独立路径，不经 OAuth client_id：

```js
function Hpe(e = {}, t) { …return `${XAe(e)}${n}` }        // buildBigModelApiUrl
function X8i(e = {}) { return Hpe(e, "/coding-plan/personal/overview") }
function bHt(e = {}) { return Hpe(e, "/coding-plan/team/plans") }
```

即 `wXe[1].teamCodingPlanManageUrl = bHt({ZCODE_ENV: Epe})` → **由环境动态算出**，而非硬编码——与 `zai` 侧硬编码的 `https://z.ai/manage-apikey/subscription` 形成对比。

**汇总入口** `resolveRuntimeProductEndpointConfig`(`t5i`) 一次性返回全部：`{zcodeEnv, zcodeEndpointOrigin, zcodeEndpointUrls, zaiOAuthOrigin, zaiBusinessBaseUrl, zaiOAuthClientId, bigModelApiOrigin}`。

可用的环境变量：`ZCODE_ENV`、`ZCODE_BASE_URL`、`ZCODE_PRODUCTION_BASE_URL`、`ZCODE_TEST_BASE_URL`、`ZAI_OAUTH_CLIENT_ID`、`ZAI_OAUTH_APP_ID`、`ZAI_OAUTH_ORIGIN`、`ZAI_BUSINESS_BASE_URL`、`BIGMODEL_API_BASE_URL`、`BIGMODEL_PRODUCTION_API_BASE_URL`、`BIGMODEL_TEST_API_BASE_URL`。

**`oXe` = `"bigmodel"`**（`BIGMODEL_PROVIDER_ID`），`wKt` = `"zai"`，二者是 §0 家族枚举的底层常量。

### 运行时迁移

`setting.json` 实存三个键：

```json
"providerFamilyDomainUpdatedAt": 1790442049804,
"providerFamilyDomainMigrated": true,
"providerFamilyConnectionSelections": { "zai": {…}, "bigmodel": {…} }
```

**家族域名是运行时刷新的，不是编译期定死**——切换国际/国内不需要重装。schema 中 `providerFamilyDomain` 有两处写法：设置侧 `_ir.optional()`，同步侧 `m.union([_ir, m.literal("")])`（**空串亦为合法值**，与 `null` 的语义差异未验证）。

### 修正：上一版的一处错误结论

本文档早期版本称 `client_P8X5CMWmlaRO9gyO-KSqtg` "不在 bundle 中"。**该结论错误**——检索时只扫了 `_re/`（该目录只有阿里云验证码 SDK，**不含** `zcode.cjs`），未扫安装目录。CLI 主 bundle 实际位于：

```
%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs     ← 14.1 MB
%LOCALAPPDATA%\Programs\ZCode\resources\app.asar          ← 319 MB 桌面端
```

**教训**：`deobfuscated.js` 是验证码 SDK（首行 `aliyun-captcha-iconfont`，ZCode 符号 0 个），**不是 ZCode 主 bundle**。在 `_re/` 下的检索结论不可外推到 ZCode。提取工具见 `_re/asar_pick.js`（`list`/`get`/`find`，按需抽取不整包解）。

## 1. Z.ai 设备流（`Xdn` 客户端）

### 1.1 常量与握手

```js
F7s = "https://zcode.z.ai/api/v1"    // baseUrl（可被 e.baseUrl 覆盖；KHa 默认取 p1(env) 派生）
j7s = "zai"                          // init 请求体里的 provider
B7s = 32                             // pollToken = randomBytes(32).toString("hex")  ← 客户端生成
```

### 1.2 init

```
POST https://zcode.z.ai/api/v1/oauth/cli/init
Headers: Authorization: Bearer <pollToken>      ← pollToken 先于服务端存在，绑定流
         Content-Type: application/json
Body:    {"provider": "zai"}

→ {code:0, data: {flow_id, poll_token, authorize_url, expires_at, poll_interval_sec}}
```

- `authorize_url` 由服务端生成（客户端不拼参数、无 PKCE）。init 无 Bearer 头的实测判据：`400 code 3004 invalid_flow`（2026-09-28）——pollToken 与轮询同源，客户端 `randomBytes(32)` 生成。
- `expires_at`（秒）与 `poll_interval_sec` 均由服务端下发。
- 响应经 `WZr` 信封校验：`code!==0` → `ZaiCliOAuthError`（带 businessCode）；非 JSON → 同类错误。
- **init 接口有限频**：连续快速调用第二次即 HTTP 429。

### 1.2b authorize_url 实抓与端到端验证（2026-09-26 实测）

`provider=zai` 的服务端下发结果：

```
https://chat.z.ai/api/oauth/authorize
    ?client_id=client_P8X5CMWmlaRO9gyO-KSqtg
    &redirect_uri=https://zcode.z.ai/api/v1/oauth/cli/callback/zai
    &state=f0b2027d6f5f6522690e0609546d716c
    &response_type=code
```

- 标准 OAuth2 授权码形态；`client_id` 运行时实值 `client_P8X5CMWmlaRO9gyO-KSqtg`。`provider=bigmodel` 变体（2026-09-28 复抓全文）：`https://bigmodel.cn/login?appId=zcode&redirect=https://zcode.z.ai/api/v1/oauth/cli/callback/bigmodel&state=<32hex>`——统一流按家族下发各自风格的授权页（bigmodel 用 `/login` 页而非 OAuth 标准端点、以 `appId=zcode` 标识应用），回调统一收敛到 zcode.z.ai 服务端。

**bigmodel 链路的验证分层（别把推断当实证）**：
- init 环：**A**（2026-09-28 实测下发）；
- 中段（bigmodel.cn 页面 → 回调 → 服务端换 token）：**C**——未单独抓包，按 zai 全链同构推断；
- 终态：**A**（[03](zcode-plan-03-billing-balance-接口与实调.md) 换号实测：active_provider=bigmodel、zcodejwttoken 同代理同认证可用）。
- 两条 C 级推论（流能闭环的最简解释）：① `appId=zcode` 对应的 appSecret 由 zcode.z.ai 后端持有并代为完成换 token——客户端无 appSecret 来源而统一流能闭环，唯此解释；② bigmodel 登录产物里的 `zcodejwttoken` 是 zcode.z.ai 后端签发的自有 JWT，非 bigmodel 颁发（故额度接口家族无关）。
- **回调是服务端侧的**（非 localhost）：浏览器授权后落在 `…/cli/callback/zai?code=code-<12hex>&state=<原样回传>`；state 绑定与 code 格式（`code-` 前缀）实测确认。**统一设备流全程不需要本地回调服务器**（`YOe` 只属于 §2 独立授权码路径）。
- 有效期 300 秒；`poll_interval_sec: 2`（服务端强制 2 秒间隔）；响应另含服务端签发的 64 hex `poll_token`（CLI 轮询用的是自己生成的那个，服务端下发版疑似供 web 端）。
- **端到端全流程实测通过**：init → 浏览器授权 → 回调 → poll 首轮即 `ready`，载荷含 `zcodejwttoken`(255B) + `zai.access_token`(404B，与本机存量 1404B 版本不同) + user 信息。实测中轮询以客户端自生成的 pollToken 作 Bearer 即可领走。

### 1.3 轮询（`YHa` = `pollUntilReady`）

```
GET https://zcode.z.ai/api/v1/oauth/cli/poll/{flowId}     （flowId encodeURIComponent）
Headers: Authorization: Bearer <pollToken>

→ {status: "pending"} | {status: "failed"} | {status: "ready", token, user{…}, zai{access_token}}
```

- 截止时间 = `min(now + timeoutMs, expires_at×1000)`；`timeoutMs = IHo = 300*1e3`（**5 分钟**）。
- 间隔 = `max($Ha=1000ms, poll_interval_sec×1000)`（下限 1s，实际以服务端下发为准）。
- `failed` → `ZCodeCliLoginError("auth_failed")`；超时 → `"auth_timeout"`。

### 1.4 ready 载荷（`W7s` 解析）

```js
{
  status: "ready",
  token: "<zcodejwttoken>",              // ZCode 云端 JWT（balance 接口的 Bearer，见 03 文档）
  user: { user_id, email?, name?, avatar? },
  zai:  { access_token: "<Z.ai OAuth access token>" }
}
```

## 2. BigModel 授权码流（`OZr` 客户端）

### 2.1 常量

```js
x7s = "/login"                          // 授权页路径
T7s = "/api/auth/tokenByAuthCode"       // 换 token 端点
I7s = "zcode"                           // appId
C7s = 32                                // state = randomBytes(32).hex（MZr）
qHa = "/oauth/callback/bigmodel"        // 本地回调路径
```

### 2.2 流程（`HHa`）

1. `state = randomBytes(32).hex`；起本地回调服务器 `YOe({callbackPath: "/oauth/callback/bigmodel", state})`（127.0.0.1 随机端口，校验 pathname + state，取 `authCode`/`code` 参数；错误码映射 `Q7s`）。
2. 授权 URL（客户端拼接）：
   ```
   https://open.bigmodel.cn/login?appId=zcode&redirect=http://127.0.0.1:<port>/oauth/callback/bigmodel&state=<hex64>
   ```
3. 打开浏览器（`Ydn`：win32 `cmd.exe /c start "" <url>`、darwin `open`、linux `xdg-open`，detached），等待回调（同 5 分钟超时，`auth_timeout`）。
4. 换 token：
   ```
   POST https://open.bigmodel.cn/api/auth/tokenByAuthCode
   Body: {"appId": "zcode", "appSecret": <必填>, "authCode": "<code>"}
   → {data: {accessToken, refreshToken?}}
   ```
   `appSecret` 未配置时直接抛 `BigmodelOAuthError`（`kct`）。
5. 写凭证（`saveMany`）：`oauth:active_provider="bigmodel"`、`oauth:bigmodel:access_token`、`oauth:bigmodel:refresh_token?`、`oauth:bigmodel:user_info={"id": <apiKey派生身份>}`。

**双版本确证（2026-09-28 复核）**：本流实现于两份 bundle 中均实存——09-26 的 3.14.3 内嵌版（文档原始提取源）与 09-27 19:17 自动更新后的 15.87MB 独立 CLI 版（0.16.x 线，注册名 **`createBigmodelOAuthClient`** / `createBigmodelOAuthState`）。`buildAuthorizeUrl`（URLSearchParams 拼 appId/redirect/state）、`exchangeCode`（POST appId+appSecret+authCode → accessToken/refreshToken）、`MZr` 状态生成逐字匹配 §2.2 记录。锚点稳定性（2026-09-28 抽检 40/40）：minified 名跨构建**存活**（`HHa` 现登记为 `loginBigmodelCodingPlan`）；仅 @偏移量失效——**引用一律用注册名**。另注：新构建的登记语法为 `r(var, "名")`（逗号后带空格），检索正则须容空格。

## 3. 汇聚步骤：API key 解析（`EHo` → `$Zr`）

登录成功后统一执行 `resolve({accessToken, family})`：

### 3.1 Z.ai（两跳）

```
① M7s = resolveZaiBizToken:
   POST https://api.z.ai/api/auth/z/login     Body: {"token": "<zai access_token>"}
   → {access_token: "<业务 token>"}

② BZr = resolveBizApiKey（Authorization: Bearer <业务token>，host=https://api.z.ai，requireSecretKey=true）:
   a. GET  /api/biz/customer/getCustomerInfo
      → N7s 选组织：名称含 "默认机构" 者优先，否则第一个；项目同理（"默认项目"）
   b. GET  /api/biz/v1/organization/{orgId}/projects/{projectId}/api_keys
      → 找 name === "zcode-api-key" 的 key；没有则 POST 同路径 {"name": "zcode-api-key"} 创建
   c. GET  /api/biz/v1/.../api_keys/copy/{apiKey}   → {secretKey}
   d. 最终凭证 = "{apiKey}.{secretKey}"              ← secretKey 缺失即抛错（zai 必须有）
```

### 3.2 BigModel（一跳）

`BZr` 直接以 OAuth accessToken 作 `Authorization` 头（**无 Bearer 前缀**），host = `open.bigmodel.cn`，同样默认机构/项目 + `zcode-api-key`；`requireSecretKey=false`——copy 不到 secretKey 时仅返回 apiKey 本体。

> 这就解释了 credentials.json 里那把 49 字符的 key（`account-provider:coding-plan:…:api-key`）的来源：`{apiKey}.{secretKey}` 拼接形态。

## 4. 持久化

### 4.1 凭证（`jM` = `createSharedZCodeCredentialStore`）

键名全集（`R1`）：

```js
R1 = {
  activeProvider:      "oauth:active_provider",
  bigmodelAccessToken: "oauth:bigmodel:access_token",
  bigmodelRefreshToken:"oauth:bigmodel:refresh_token",
  bigmodelUserInfo:    "oauth:bigmodel:user_info",
  zaiAccessToken:      "oauth:zai:access_token",
  zaiRefreshToken:     "oauth:zai:refresh_token",
  zaiUserInfo:         "oauth:zai:user_info",
  zcodeJwtToken:       "zcodejwttoken"
}
```

- Z.ai 登录写入：`saveZaiLoginCredentials({accessToken → zaiAccessToken, jwtToken → zcodeJwtToken, user → zaiUserInfo})`，并置 `activeProvider = "zai"`。
- 存储路径：`n$s`（可被环境变量 `t$s = "ZCODE_DATA_BASE_DIR"` 重定位）；所有值经 `ZZr` 的 `enc:v1` AES-256-GCM 加密（见 [02 §3](zcode-plan-02-认证与凭证存储.md)）。

### 4.2 供应商配置（`aPn` = `persistStandaloneCodingPlanConnection`）

```
1. 写凭证: { [Yie(providerId)]: accountIdentity,        # 账号身份键
             [t3e({providerId, accountIdentity})]: apiKey }  # 即 account-provider:coding-plan:…:api-key
2. 写默认模型到 personalProviderConfigPath:
   env ZCODE_PERSONAL_PROVIDER_CONFIG_FILE（tte）
   ?? dirname(credentials.json)/"provider_config.json"   # MXe
   → saveConfiguredDefault({providerId, modelId})
3. 返回 {mainModel: "<providerId>/<modelId>", path}
```

本机 `~/.zcode/v2/provider_config.json` 实测为空规则骨架（`schemaVersion:1`）。

## 5. 登出（`JHa` = `logoutZCodeCli`）

- 枚举所有键：`Object.values(R1)` + 各 standalone provider 的身份键与 api-key 键 → `loadMany` → `deleteIfValues`（非 null 全删）。
- Z.ai 专用 `clearZaiLoginCredentials`：删 `zaiAccessToken/zaiRefreshToken/zaiUserInfo/zcodeJwtToken`；`activeProvider` 仅在其值为 `"zai"` 时删除。

## 6. Token 刷新现状（重要结论）

| 键 | 现状 |
|---|---|
| `oauth:zai:refresh_token` | **有键无流**：登录链路从不下发/写入，仅在登出时删除。Z.ai CLI 流无刷新机制——`zcodejwttoken` 过期即需重新登录。 |
| `oauth:bigmodel:refresh_token` | 授权码响应若带 `refreshToken` 则写入，但 **CLI bundle 内无任何刷新调用**（`grant_type=refresh_token` 的 13 处命中全部属于通用 OIDC 库，服务于 MCP OAuth，见 [23 §2](zcode-plan-23-Hooks与MCP客户端.md)）。 |

ZCode 端点的 401 处理：`NodeApiClient` 在 401 时回调 `isZcodeJwtRequest(url, headers)` → 命中则触发 `onZcodeJwtInvalid`（宿主侧提示重新登录/刷新 web 会话），而非客户端静默刷新。

## 7. 错误类型汇总

| 错误类 | code/来源 | 场景 |
|---|---|---|
| `ZCodeCliLoginError`（`m9`） | `auth_timeout` | 轮询/回调等待超 5 分钟 |
| | `auth_failed` | poll 返回 failed |
| | `credential_write_failed` | 登录成功但写凭证失败 |
| | `config_update_failed` | 写默认供应商配置失败（含 API key 为空） |
| `ZaiCliOAuthError`（`Q7`） | businessCode/httpStatus | init/poll 信封错误、非 JSON、字段缺失 |
| `BigmodelOAuthError`（`kct`） | — | appSecret 缺失、accessToken 缺失 |
| `CodingPlanApiKeyError`（`yG`） | — | 业务 token/组织项目/`zcode-api-key`/secretKey 任一环失败 |
| `OAuthError`（`Q7s`，code `X7s`） | oauthError + description | 本地回调收到 `error` 参数（用户拒绝授权） |
