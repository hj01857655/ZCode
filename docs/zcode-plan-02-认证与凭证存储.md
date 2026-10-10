# 02 · 认证与凭证存储

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 涉及文件：`resources/glm/zcode.cjs`、`~/.zcode/v2/credentials.json`、`~/.zcode/v2/telemetry-state.json`
> **登录全链路（授权、API key 解析、登出、刷新现状）见 [10-OAuth 登录流程](zcode-plan-10-OAuth登录流程.md)**；本文聚焦凭证形态与加密。

## 1. OAuth 设备流（CLI 侧实现，摘要）

### 1.1 本地回调服务器

`YOe`（原始名未标注，行为完整还原）：

1. 在 `127.0.0.1` 随机端口起 HTTP 服务（`tpn` = localhost 常量）；
2. 校验回调路径 `callbackPath` 与 `state` 参数；
3. 接受 `authCode` 或 `code` 查询参数（错误时读 `error` + `error_description`，映射为 `OAuthError`，code=`X7s`）;
4. 成功页面 `Y7s` / 失败页面 `ZOe`（内嵌 HTML 常量）。

### 1.2 CLI 轮询接口

```
POST {origin}/oauth/cli/init
  Headers: Authorization: Bearer <pollToken>
  → { flowId, ... }
GET  {origin}/oauth/cli/poll/{flowId}        （flowId encodeURIComponent）
  → 轮询直至登录完成/拒绝
```

- `pollToken` = `randomBytes(B7s).toString("hex")`（本地随机）。
- bigmodel 家族回调路径：`/oauth/callback/bigmodel`；另有 `/oauth/callback/mcp/` 前缀供 MCP OAuth。

### 1.3 OAuth Client ID 解析

`p2` = `resolveZaiOAuthClientId(e, env)`，优先级：

```
ZAI_OAUTH_CLIENT_ID > (ZAI_TEST|ZAI_PRODUCTION)_OAUTH_CLIENT_ID 按环境
  > ZAI_OAUTH_APP_ID > 内置默认（production: $A / test: zA 两个常量）
```

URL 构造：`BA` = `buildZaiOAuthUrl`、`m2` = `buildRuntimeZaiOAuthUrl`（均拼接 `{origin}{path}`）。

## 2. credentials.json 结构（本机实测，值已脱敏）

路径：`~/.zcode/v2/credentials.json`

| 键 | 值形态 | 说明 |
|---|---|---|
| `oauth:zai:access_token` | JWT 形式（解密后 ~1.4KB） | Z.ai OAuth access token |
| `oauth:zai:user_info` | JSON：`user_id` / `email` / `avatar` / `name` | 用户信息 |
| `oauth:active_provider` | `"zai"` 或 `"bigmodel"` | 当前 OAuth 家族（实测明文仅 3 字节） |
| `zcodejwttoken` | ~255 字符 JWT | ZCode 云端会话令牌，Start Plan balance 的 Bearer |
| `oauth:login_attribution` | `{"utm_source":"z.ai"}` | 登录归因 |
| `account-provider:coding-plan:account:zai-individual-coding-plan:account:<uuid>:api-key` | 49 字符 | 按账号维度存的 coding plan API key |

键名规律：`account-provider:coding-plan:account:<family>-<planKind>:account:<accountUuid>:api-key`。

常量对照（host bundle）：`Ipe="oauth:active_provider"`、`_pe="zcodejwttoken"`、`Nj/Rme="zcodejwttoken"`、`Ame="oauth:zai:access_token"`、`Eme="oauth:bigmodel:access_token"`、团队 API key 名 `mj="zcode-team-api-key"`（keyType=2）。

## 3. 凭证加密方案（enc:v1）· 完整还原

出处：`zcode.cjs` 中 `ZZr` = `createZCodeCredentialCipher`（模块 `epn`）。

### 3.1 常量

```js
Qdn = "enc:v1:"
JZr = "aes-256-gcm"
KZr = 12        // IV 字节数
H7s = 16        // auth tag 字节数
G7s = "ZCODE_CREDENTIAL_SECRET"   // 环境变量名（可覆盖密钥来源）
```

### 3.2 密钥派生（`K7s`/`Z7s`）

```
secret = env.ZCODE_CREDENTIAL_SECRET?.trim()
       || `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`
key    = sha256(secret)          // 32 字节，直接作 AES-256 密钥
```

- `username` 取 `os.userInfo().username`，异常时为 `"unknown"`。
- **不含 OS 密钥链/TPM**——在同一台机器、同一用户下可离线解密；跨机器则因 homedir/username 不同而无法解密。

### 3.3 存储格式与加解密

```
密文 = "enc:v1:" + b64url(IV[12]) + "." + b64url(TAG[16]) + "." + b64url(CT)
明文写入时不加前缀，读取时 startsWith("enc:v1:") 判别，否则原样透传（明文兼容）
```

```js
encrypt(n):
  iv = randomBytes(12); cipher = aes-256-gcm(key, iv)
  ct = update(n, "utf8") + final(); tag = getAuthTag()
  return "enc:v1:" + b64url(iv) + "." + b64url(tag) + "." + b64url(ct)

decrypt(n):
  [a, l, u] = n.slice(7).split(".")           // a=IV, l=TAG, u=CT
  decipher = createDecipheriv("aes-256-gcm", key, a); setAuthTag(l)
  return update(u) + final()                  // utf-8
```

### 3.4 验证

本机 `oauth:active_provider` 密文 `enc:v1:LWg-cIv9Y5cyf5P5._mM-3Tz7Q0c7GkMEp4bmAg.Hm2F`：
- 第一段 `LWg-cIv9Y5cyf5P5` = 16 个 b64url 字符 = 12 字节 IV ✓
- 第二段 `_mM-3Tz7Q0c7GkMEp4bmAg` = 22 字符 = 16 字节 TAG ✓
- 第三段 `Hm2F` = 3 字节密文，解出 `"zai"` ✓（与 OAuth 家族一致）

复现脚本：[tools/zcode_decrypt.py](../tools/zcode_decrypt.py)（默认只打印结构不落盘；`--out` 可导出明文）。

## 4. 设备指纹（X-Device-Mid）

`~/.zcode/v2/telemetry-state.json`：

```json
{ "deviceMid": "f8eea726-8424-4560-bc4e-3e310bd0d558", "lastDailyActiveDate": "2026-09-26" }
```

host 侧 `dpe` = `readExistingDeviceMid` 从该文件读取；CLI 侧另有 `keyCache`（按 apiKey+origin 的 epoch 缓存，`uur()`）。`deviceMid` 作为 `X-Device-Mid` 头随 ZCode 端点请求发送，并用于反馈工单/身份记录去重（`deviceMid mismatch` 日志）。

## 5. 各凭证的实际用途（PoC 实测确认）

| 凭证 | 有效域 | 用途 |
|---|---|---|
| `zcodejwttoken` | `zcode.z.ai` | ① balance/账单接口的 Bearer；② **Start Plan / off-peak 模型请求的认证**（`resolveCurrent` 对 start-plan 返回它作为 apiKey）；在 api.z.ai 上 401 |
| `account-provider:…:api-key`（`{id}.{secret}` 49 字符） | `api.z.ai` / `open.bigmodel.cn` | individual/team 付费档的模型请求；Start Plan 资源包**不挂在它名下**（用它打模型网关 → `429 code=1113 Insufficient balance or no resource package`） |
| `oauth:zai:access_token` | Z.ai OAuth 域 | 换业务 token（`/api/auth/z/login`）、团队客户信息查询；不能直接打模型网关（同样 1113） |

### 5.1 端点 × 凭据类型实测矩阵

同一批 `api.z.ai` 端点用两类凭据分别打的结果。**要点：`api.z.ai` 上的账户类端点同样是付费凭据专用**——该域并非"通用账户 API"。

| 端点 | individual api-key | Start Plan JWT | 实际认哪种凭据 |
|---|---|---|---|
| `/api/biz/subscription/list` | `200` `{"code":200,"data":[]}` | `401 token expired or incorrect` | api-key |
| `/api/biz/customer/getCustomerInfo` | **`403 APIKey not allow access`** | `401` | **仅 `oauth:zai:access_token`**（两类皆拒） |
| `/api/monitor/usage/quota/limit` | `200` `{"code":500,"msg":"当前用户不存在coding plan"}` | `401` | api-key |
| `/api/v1/agent/configs` | `{"code":500,"msg":"404 NOT_FOUND"}` | **逐字相同** | **不校验凭据** |
| `/api/anthropic/v1/messages` | `429 code 1113` | `401` | api-key + V4 签名 |
| `/api/auth/z/login` | 解析 body 后抛 JWT 结构异常 | 解析 body 后抛签名异常 | **凭据在 body 内**，不读认证头 |

1. **`getCustomerInfo` 只认 OAuth `access_token`**，与上表第 3 行一致。
2. **`/api/auth/z/login` 不读认证头**，凭据在 body 的 `token` 字段；不能用它判断"某凭据能否访问"。
3. **`/api/v1/agent/configs` 不校验凭据**——两类凭据响应逐字相同。**故该端点的响应无法用于推断任何账号的权益或开关状态**（见 [05 §8.2](zcode-plan-05-V4请求签名协议.md)）。

### 5.2 三种 JWT 形态的判别（2026-09-27 实测）

**`zcodejwttoken` 与 `oauth:zai:access_token` 都是 JWT（都是 2 个点、3 段 base64），
但用途完全不相交。** 仅凭"点数"无法区分二者。

| 凭据 | 长度 | 段数 | `alg` | payload 键 | 有效域 |
|---|---|---|---|---|---|
| `zcodejwttoken` | 255 | 2 点 | `HS256` | `iat` / `sub` / `token_version` / `user_id` | **`zcode.z.ai`**（balance + Start Plan 模型请求） |
| `oauth:zai:access_token` | 1402 | 2 点 | `HS512` | `api_key` / `customer` / `customer_id` / `user_id` / `user_key` / `user_type` / `username` | **`api.z.ai` OAuth 域**（`/api/auth/z/login` 换业务 token、`getCustomerInfo`） |
| `account-provider:…:api-key` | 49 | **1 点** | 非 JWT | — | `api.z.ai` / `open.bigmodel.cn`（individual/team 模型请求） |

**实调后果（把 `access_token` 当 `zcodejwttoken` 用）：**

| 凭据 | `GET zcode.z.ai/api/v1/zcode-plan/billing/balance` |
|---|---|
| `oauth:zai:access_token` | **HTTP 401** |
| `zcodejwttoken`（对照） | **HTTP 200** |

**可用的判别规则**（比点数可靠，按优先级）：
1. `alg` 解码后为 `HS512` 且 payload 含 `api_key`/`customer` → **`access_token`，不是 Start Plan 凭据**
2. 1 个点 → api-key（`{id}.{secret}`）
3. 2 个点且 `alg=HS256`、payload 含 `token_version` → `zcodejwttoken`
4. 兜底：加完账号先打一次 balance 探活，401 即判定凭据类型错误

> **实现陷阱**：任何用 `secret.count(".") == 2` 判定"是不是 JWT"的逻辑，
> 都会把 `access_token` 误判为可用凭据——`access_token` 同样含两个 `.`，
> 必须 按 §1 的 alg/`token_version` 形状区分，不能只数点。

复跑：`tools/probe_cred_shape.py`（只读，仅解码非敏感字段）


复现：`tools/check_credential_scopes.py`（只读，不消耗额度）。

## 6. 请求默认头（ZCode 端点专用）

`zy` = `buildZCodeSourceHeaders`（host）/ `iHo` = `buildCliZCodeSourceHeaders`（CLI）→ `p5` = `buildZCodeSourceHeadersFromContext`：

| 头 | 值 |
|---|---|
| `User-Agent` | `ZCode/<appVersion>` |
| `HTTP-Referer` | 端点 origin（如 `https://zcode.z.ai`） |
| `X-Title` | `Z Code@electron`（host）或 `Z Code@cli`（CLI，`CHa` 按 argv 判定） |
| `X-ZCode-App-Version` | `<appVersion>`（存在时） |
| `X-Platform` | `<platform>-<arch>`，如 `win32-x64` |
| `X-Release-Channel` | 如 `stable` |
| `X-Client-Language` | locale（如 `zh-CN`） |
| `X-Client-Timezone` | IANA 时区（如 `Asia/Shanghai`） |
| `X-Os-Category` | `windows` / `macos` / `linux`（`dU`/`kHa` 归一化） |
| `X-Os-Version` | OS 版本串 |
| `X-Device-Mid` | deviceMid（host 侧；CLI 的 `nHo` 不带此项） |
| `X-ZCode-Agent` | `"glm"`（仅 CLI 签名头组） |
| `x-request-id` | 每请求 UUID（`dd` = `withRequestIdHeader` 补齐） |

头值经 `it`/`Zie` = `normalizeZCodeSourceHeaderValue` 校验：非空且全部为可打印 ASCII（`/^[\x20-\x7e]+$/`），否则丢弃。

## 7. 凭证读取链路（RPC）

host 日志可见 UI→host 的 `credential.load` RPC 调用；`accountRequestAuthService.resolveCurrent({providerId, accountAccess, reason})` 汇聚出 `{apiKey}`，再由各 Provider 包成 `Authorization: Bearer <token>`（`/^Bearer\s/i` 已带前缀时不重复包装）。
