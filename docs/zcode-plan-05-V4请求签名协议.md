# 05 · V4 请求签名协议（codingPlanSignature）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> ⚠️ **官方未开源**（2026-09-28 核对）：本文全部主题在 `zai-org/ZCode`（Apache-2.0）开源仓库中**一行都没有**——`ClientRequestSigningV4Manager` / `WD_CLIENT_SIGN_KDF_SALT` / `getSignKey_hmac` / `ed25519_priv` / `sanitizeClientSigningHeaders` 全部 0 命中。**唯一可靠来源是构建产物 `app.asar` / `zcode.cjs`**。详见 [43 官方未开源清单](zcode-plan-43-官方未开源清单.md) §2。
> 核心类：`lPe` = `ClientRequestSigningV4Manager`、`KJt` = `ClientRequestSigningV4Signer`（zcode.cjs）
> 第二来源：`bacnh85/pi-extensions` → `pi-model-tools/extensions/lib/zcode-signing.ts`（MIT，移植自 `TriDefender/zcode-api` @ `cba566b9` / `3b80aa60`）。该实现为独立第二方，与本项目逆向结论逐项一致处已就地标注。

## 0. 结论先行

"codingPlanSignature" 不是简单的请求 HMAC，而是一套**远端开关 + 密钥握手 + Ed25519 请求签名 + 工作量证明**的请求签名协议：

1. 远端 feature gate 决定是否启用（每 key 独立判定）；
2. 启用后先向服务端握手换取一次性 Ed25519 私钥；
3. 每个模型请求附加 6 个 `X-Client-*` 签名头（含 `X-App-Id` 共 7 个发送头，另剥离服务端回显的 `X-Client-Sign-Verified`）+ 8-bit PoW；
4. 服务端校验失败有且仅有一次重签机会，再失败则**永久旁路**（明文发送）。

**适用范围**（`cRs`）：仅 `zhipu-coding-plan-api-key` 与 `zhipu-account` 的 individual/team 通道；**start-plan 与 off-peak 明确不签名**。

**2026-09-28 重验（0.16.x bundle）**：`lPe`（Manager）与 `KJt`（Signer）同名存活（isEnabled/keyCache/businessOrigin/handshakeUrl 结构不变），gate 端点 `agent/configs` 存活；`UNSIGNED_PATHS` 常量消失——路径排除机制重组，start-plan 的免签名行为待 live 复测。

**当前状态（2026-09-27）**：实现环**全跑通并 A/B 实测**（握手 200 → HKDF → 双层解包 → Ed25519 → 8-bit PoW → 7 头；gate 关闭时服务端不校验签名头，两组归一化一致，见 §8 末）。gate 开启态的验证无载体且客户端不可达（不伪造权益）——开通付费订阅后先跑 `tools/probe_sig_gate.py`。

2026-09-27 第二来源确认：`bacnh85/pi-extensions` 的 `pi-model-tools/extensions/lib/zcode-signing.ts`（MIT，移植自 `TriDefender/zcode-api`）以 `UNSIGNED_PATHS` 常量逐条列出不签名路径，与上句完全对应：

```ts
const UNSIGNED_PATHS = new Set([
  "/api/v1/zcode-plan/anthropic/v1/messages",   // start-plan
  "/api/v1/zcode-plan/chat/completions",        // start-plan
  "/api/v1/off-peak/anthropic/v1/messages",     // off-peak
]);
```

**推论（对本项目）**：[37 §10](zcode-plan-37-排障手册.md) 记录的 `zcodejwttoken` + `zcode-plan/anthropic` 端到端 200 之所以不需要签名，是**协议设计如此**，不是侥幸；该链路上的 UA / `X-Platform` 形态差异同样不影响判定。

## 1. Feature Gate（开关）

```js
xHa = createCodingPlanSignatureConfig(env, opts)
  = { configUrl: YAe(env, JJt), headers: iHo(env, opts) }   // iHo 见 02 文档默认头
JJt = "/api/v1/agent/configs"        // 配置端点路径
Ylr = 3600 * 1e3                     // gate 缓存 TTL：1 小时
Xlr = 15e3                           // gate 拉取超时
```

- `aPe` = `CodingPlanSignatureFeatureGate`：拉取 `{codingPlanSignature: {enable: boolean}}`，`enable === true` 才启用签名；失败/畸形 → `enabled:false`（`cacheable` 区分业务码失败与网络失败）。
- scopeKey（`uRs`）= `JSON.stringify({configUrl, headers(按名排序), network{caCertFile,httpProxy,noProxy}})`——同 scope 复用 gate 实例。
- 签名管理器 `Bit` = `AiSdkModelExecution` 按apiKey 维度创建/缓存 signer；请求头若缺 `Authorization`（`tzr="Authorization"`）自动注入 `Bearer <apiKey>`（`dRs`）。

## 2. 常量

```js
n7i = "get_sign_key"                          // 握手签名域分离串
r7i = "/api/paas/c1f3a7e2/v2/client"          // 握手端点路径
cur = "zcode"                                 // appId → X-App-Id
o7i = 10_000                                  // 握手超时 10s
lur = 16                                      // nonce：16 随机字节 → 32 hex
i7i = 8                                       // PoW 难度：8 个前导零 bit
HL  = __ZCODE_VERSION__ ?? "0.0.0-dev"        // 客户端版本（签名串成分）
HKDF salt = "WD_CLIENT_SIGN_KDF_SALT" (Yzi)
HKDF info  = "getSignKey_hmac" (Qzi) / "ed25519_priv" (Xzi)
```

2026-09-27 第二来源确认：`zcode-signing.ts` 中同名常量逐字一致，且额外给出本项目未记录的两个参数——`POW_BITS = 8`（本文档 §4 推导一致）与 nonce 长度区分（握手 nonce 16 字节，PoW candidate 12 字节）。

**握手 origin（第二来源实测，2026-09-06）**：

```ts
const DEFAULT_ORIGIN = "https://zcode.z.ai";
/** Handshake plane. Live-verified 2026-09-06: /api/paas/* 404s on zcode.z.ai;
 *  the get_sign_key endpoint answers on the api.z.ai origin. */
const HANDSHAKE_ORIGIN = "https://api.z.ai";
```

即**握手走 `api.z.ai`、业务走 `zcode.z.ai`**，与本文档 §3 记录的基址一致，且由独立实现方实测确认。

## 3. 握手（performHandshake）

```
nonce = random_hex(16 字节)
ts    = String(Date.now())
sig   = base64( HMAC-SHA256( HKDF-SHA256(secret, salt="WD_CLIENT_SIGN_KDF_SALT", info="getSignKey_hmac"),
                             "get_sign_key\n{apiKeyId}\n{ts}\n{nonce}" ) )
POST {baseURL.origin}/api/paas/c1f3a7e2/v2/client
  body: { apiKey, nonce, sig, ts }
  headers: { Authorization: <credential>, Content-Type: application/json }
  → 返回加密私钥
私钥解密（nur = decryptSigningPrivateKey）:
  key2 = HKDF-SHA256(secret, salt, info="ed25519_priv")      // AES 密钥
  iv = cipher[0:12], AAD = apiKeyId
  plaintext = AES-256-GCM 解密 cipher[12:]
  privateKey = importPKCS8(plaintext, "Ed25519")
```

失败分类 `Hee` = `ClientRequestSigningV4Error{kind, failOpenEligible, reason, httpStatus, businessCode}`；`failOpenEligible` 的失败（如握手失败）→ 明文发送（`getKeyOrSendUnsigned`）。

## 4. 请求签名（sendSigned）

前置：请求 origin 必须等于握手 businessOrigin，否则 `origin_mismatch` 明文发送。

```
powSeed = hex( sha256("{apiKeyId}\n{appId}\n{sessionId}\n{ts}") )       // 取前 32 hex
prefix = random_hex(12 字节)                                          // 24 hex 字符
for counter in 0..2^32-1:
    candidate = "{prefix}{counter:08x}"
    if sha256("{powSeed}\n{candidate}") 前 8 bit 全 0: PoW = candidate; break   // 前 8 bit = 首字节为 0
sigMsg = "{apiKeyId}\n{ts}\n{clientVersion}\n{sessionId}\n{nonce}"
sig    = base64( Ed25519.sign(privateKey, sigMsg) )                     // rur
```

附加头（`HYe` = `sanitizeClientSigningHeaders` 先剥离旧签名头，含 `X-Client-Sign-Verified`）：

| 头 | 值 |
|---|---|
| `X-Client-Ts` | 毫秒时间戳（签名串中的 ts） |
| `X-Client-Version` | `HL`（客户端版本） |
| `X-Client-Sig` | Ed25519 签名（base64） |
| `X-Session-Id` | 请求自带会话 id（缺失则抛 `invalid-config`） |
| `X-Client-Nonce` | 32 hex 随机 |
| `X-App-Id` | `"zcode"` |
| `X-Client-Pow` | PoW candidate |

## 5. 校验失败与旁路策略

```
sendSigned(第1次) → HTTP 401 且 body reason ∈ {VERIFY_SIGNATURE_INVALID, VERIFY_APIKEY_EXPIRED}
  → observe(verify_rejected, attempt 1)
  → 作废私钥（epoch+1）→ 重新握手 → sendSigned(第2次)
  → 仍 401/拒绝 → observe(verify_rejected, attempt 2)
  → bypassSigning = true（永久）→ observe(bypass_entered) → 明文发送
```

其他明文发送原因：`origin_mismatch`、`bypass`、`feature_gate_disabled`、`feature_gate_unavailable`、`handshake_failed`。观测事件含请求/会话 id（读 `x-request-id`/`x-session-id` 头）。

## 6. 密钥状态管理

- `cPe` = `ClientRequestSigningV4KeyCache`：按 `(apiKey, handshakeOrigin)` 共享 keyState `{epoch, privateKey, handshakePromise}`；并发请求共享同一次握手（`sPe` = `waitForSigningPromiseOrAbort`）。
- `lPe` 按 `providerId` 缓存 signer，`apiKey/baseURL/clientVersion/transport` 任一变化即重建。
- dispose 语义：活跃请求计数归零才真正销毁；ownsKeyState 时 epoch+1 清私钥。
- 请求体先经 `Jlr` = `makeReplayableSigningRequest` 复制以保证可重放（body 转静态 buffer）。

## 8. 握手实测（2026-09-26，协议逐环验证）

用当前账号的 coding plan key（`{id}.{secret}`）以独立 Python 实现对拍，**全链路与服务器行为一致**：

| 环节 | 实测结果 |
|---|---|
| `POST /api/paas/c1f3a7e2/v2/client`（HKDF→HMAC-SHA256 签名，body `{apiKey,nonce,sig,ts}`） | **HTTP 200**，返回 `data.privateCipher` —— 独立实现的签名被服务端接受 |
| 私钥信封解密 | `privateCipher` = base64(AES-256-GCM)；**明文又是一层 base64 文本**（双层编码），解出 48 字节 PKCS8 DER → Ed25519 |
| 派生参数确认 | HKDF salt `WD_CLIENT_SIGN_KDF_SALT`、info `getSignKey_hmac`（握手签名）/ `ed25519_priv`（私钥解包）、AAD = apiKeyId —— 与 §3/§4 推导一致 |
| Ed25519 自检 | 对 sendSigned 签名串格式签名成功（标准 64 字节签名，base64 后 88 字符） |

实测附带发现：

1. **gate 端点（`GET https://api.z.ai/api/v1/agent/configs`）不可用，且其响应是零信息的。**

   实测返回 `{"code":500,"msg":"404 NOT_FOUND"}`（HTTP 状态是 **200**，信号在 body 的 `code`）。按 `zcode-signing.ts` 的 `fetchGate` 判据，`code !== 0` 归类为 **`unavailable`** 而非 `disabled`——前者负缓存 30 秒持续重试，后者正向缓存 1 小时认定关闭。

   **但这个区分在本账号上无法转化为结论**：该端点**根本不校验凭据**，两类凭据拿到逐字相同的响应（[02 §5.1](zcode-plan-02-认证与凭证存储.md)）。因此**不能**把 404 读作"该账号未启用签名"或"服务端未部署"——任何账号读到的都是同一个错。**唯一有信息量的响应是 `code:0` 且 `data.codingPlanSignature.enable === true`。**

   头部形式已排除：`Authorization: Bearer`、`x-api-key`、带/不带 `X-ZCode-Agent`+`X-Device-Mid`、无 `Accept`——四组结果一致（`tools/probe_sig_gate.py`）。运行史侧证：本机 model-io 日志 126 条 attempt 中 `x-client-sig`/`x-client-pow` 真实出现 0 次（[37 §9](zcode-plan-37-排障手册.md)）。

2. **签名环实现完整，服务端当前不校验——A/B 实测**（`tools/v4_sign_e2e.py`）

   同一 key、同一 model、同一 body，**唯一变量是有无签名头**：

   | 端点 | A 带 7 头 + PoW | B 不带签名头 | 归一化后 |
   |---|---|---|---|
   | `api.z.ai/api/anthropic/v1/messages` | `429 code 1113` | `429 code 1113` | **完全一致** |
   | `open.bigmodel.cn/api/paas/v4/chat/completions` | `429 code 1113` | `429 code 1113` | **完全一致** |

   两者均未返回 `x-client-sign-verified`，也无 `VERIFY_*` 理由。

   **实现侧无缺口**：握手 200 → HKDF → AES-GCM 解包（双层 base64 → 48 字节 PKCS8 DER）→ Ed25519 → 8-bit PoW 收敛 → 7 头构造，全环可跑，自检三项通过（PoW 前 8 bit 零 / 签名 64 字节 / 公钥验签）。算法与第二来源 `zcode-signing.ts` 逐行一致。

3. **`429 / code 1113` 是本项目全部可控层之下的拒绝——它本身就是"实现无误"的证据。**

   错误码分层：`3001`（参数）→ `3006`（模型）→ `3007`（验证码）→ `3012`（身份块）依次拦截，**`1113` 在它们之下**。能收到 1113，说明上述各层**一层都没拦**。叠加握手 200（服务端接受我方 HMAC）与 `/models` 200（凭据被识别），可确认**唯一缺口是账户付费状态**。

   该账号的具体状态由独立读数确定（`tools/check_individual_balance.py`，端点出自 [03](zcode-plan-03-billing-balance-接口与实调.md)）：

   | 端点 | 响应 |
   |---|---|
   | `/api/biz/subscription/list` | `{"code":200,"data":[]}` —— **无订阅** |
   | `/api/monitor/usage/quota/limit` | `{"code":500,"msg":"当前用户不存在coding plan"}` |
   | `/api/v1/zcode-plan/billing/balance` | `401`（Start Plan 端点，api key 非该类凭据） |

   **即"无订阅"，而非"余额不足"**——两者在 1113 文案里是并列的独立分支（[01 §0 术语表](zcode-plan-01-计划体系与供应商标识.md)）。

4. **结论：V4 无待办。** 实现侧完整且自检通过；服务端侧当前不可用，且不可由客户端影响。若日后开通付费订阅，先跑 `tools/probe_sig_gate.py` 看 gate 是否返回 `code:0`，再决定是否需要走签名路径——届时以 `zcode-signing.ts` 为对拍基准，无需从头逆向。**不应通过推测、伪造权益或修改本地权限制造验证条件。**

   **判读本项的三条规则：**

   1. **端点必须选对。** Start Plan 的 `/api/v1/zcode-plan/anthropic/v1/messages` 在 `UNSIGNED_PATHS` 内，既不收签名也不收 api-key；拿 coding plan api-key 打过去只会 401。
   2. **429/1113 不代表签名失败**，它位于所有可控层之下。判读签名要看 `VERIFY_*` 理由或 A/B 差异。
   3. **A/B 前先归一化 body**——错误体嵌了每次都变的 `request_id`，直接比会误判为"响应不同"。
3. 私钥仅内存自检后丢弃，未落盘。

## 7. 日志脱敏

`RFs`（`sanitizeModelNetworkHeaders` 的 redact 集合）：

```
authorization, proxy-authorization, cookie, set-cookie,
x-api-key, api-key, openai-api-key,
x-off-peak-ticket-id,
x-client-sig, x-client-pow,
x-aliyun-captcha-verify-param
```

（`x-aliyun-captcha-verify-param` 的存在印证了 `coding_plan_security_verification_required` 走阿里云验证码。）
