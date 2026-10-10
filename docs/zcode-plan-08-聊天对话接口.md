# 08 · 聊天对话接口（模型请求协议）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 证据：model-io 运行日志（真实请求/响应）+ `zcode.cjs` 内嵌 AI SDK 的 Anthropic/OpenAI 兼容层

## 0. 结论先行

ZCode 的聊天对话走 **Anthropic Messages 协议**（内嵌 Vercel AI SDK 的 `anthropic.messages` provider），GLM 服务端完全兼容该协议并做了 GLM 专属扩展（`thinking`/`output_config.effort`）。Start Plan 当前会话的实况：

```
POST https://api.z.ai/api/anthropic/v1/messages
```

**协议不止一种**：模型层枚举 `Vji = m.enum(["anthropic-messages", "openai-chat-completions", "openai-responses"])`，三种协议共存，按接入模板自动选择——但 **Start Plan / Coding Plan 通道固定使用 `anthropic-messages` 一种**。全量协议矩阵见 §9。

## 1. 通道体系（四通道）

ZCode 的模型与额度访问按**四个通道**组织：凭据、端点、闸门互不通用（交叉实测见各节）。请求体/响应协议见 §4–§6。

### 1.1 四通道总表（通道拓扑）

**不同档位的 baseUrl 完全不同**，由 runtime 配置 `providerRules` 逐 provider 下发（`~/.zcode/v2/runtime/provider/<platform>/<ver>/endpoint-<hash>/zcode-builtin.json`，platform 段用 `windows-x86_64` 形态，见 [14 §4](zcode-plan-14-本地存储全schema.md)），而非统一走 zai-api 模板。**0.16.x 起目录由服务端经 `client/configs` 的 `builtin_provider_config_json`（URL）下发后抓取**，本地缓存路径不变：

| 通道 | providerId | 凭证（resolveCurrent） | 模型端点 | 额度/订阅端点 | 闸门 | 签名 |
|---|---|---|---|---|---|---|
| **Start Plan** | `account:zai/bigmodel-start-plan` | `zcodejwttoken` | `zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` | `…/billing/balance`（额度桶）+ `billing/preview\|claim`（领取） | 验证码 3007 + 构建 3012 + 模型名 3006 | **不签名** |
| **Individual** | `account:zai/bigmodel-individual-coding-plan` | API key `{id}.{secret}` | `api.z.ai \| open.bigmodel.cn /api/anthropic/v1/messages` | `{biz}/api/biz/subscription/list`（订阅份） | 无验证码；计费 1113 | V4（gate 404 关闭，A/B 定案） |
| **Team** | `account:zai/bigmodel-team-coding-plan` | 团队项目 key（运行时投影） | 同 Individual 端点 | `{biz}/api/biz/customer/getCustomerInfo`（入口校验） | 同付费族 | 同 V4 |
| **off-peak** | `account:zai/bigmodel-offpeak-idle-plan`（隐藏 provider） | 票据体系 | `zcode.z.ai/api/v1/off-peak/anthropic` | 票据（`server_ticket_id`） | 无验证码 | 不签名 |

模型白名单见 **§1.8 模型目录**（平台上限，CDN 下发）；账号**实际**授权见
[03 §2.2](zcode-plan-03-billing-balance-接口与实调.md) 的 `buckets[].capabilities`——两者是**包含关系**。

**凭证互斥实测**（[05 §8](zcode-plan-05-V4请求签名协议.md) gate 探针表）：individual key 打 Start Plan balance → **401**；打团队入口 → **403 APIKey not allow access**；JWT 打 api.z.ai → 401 audience 不对。

### 1.2 Start Plan 通道（JWT）

```
POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
Authorization: Bearer <zcodejwttoken>        # resolveCurrent 对 start-plan 返回的 apiKey 即此 JWT
x-api-key: <zcodejwttoken>                   # dRs/AI SDK 双发同值
x-aliyun-captcha-verify-param: <阿里云验证码令牌>   # 真实客户端请求必带（风控触发后颁发）
x-aliyun-captcha-verify-region: cn
```

实测错误码谱系（网关层）：

| 场景 | 响应 |
|---|---|
| 用 coding plan API key（individual 槽位）打代理/官方端点 | `HTTP 429 {"type":"error","error":{"type":"rate_limit_error","code":"1113","message":"Insufficient balance or no resource package"}}` — key 认证通过但名下无资源包 |
| 用 `zcodejwttoken` 打 api.z.ai 官方端点 | `HTTP 401 "token expired or incorrect"` — JWT audience 不对 |
| 用 `zcodejwttoken` 打 zcode-plan 代理但缺验证码头 | `HTTP 400 {"code":3007,"msg":"captcha verify failed"}` — **JWT 认证通过**，卡在验证码闸门 |
| IDE 内真实请求 | 200（携带有效 captcha 参数） |

> 3007 的含义：免费通道要求携带阿里云验证码令牌，该令牌由 IDE 客户端交互式获取并随请求携带。


额度端点 `…/billing/balance` 完整规范见 [03](zcode-plan-03-billing-balance-接口与实调.md)；领取 `billing/preview|claim` 见 [11](zcode-plan-11-签到领取接口.md)。**e2e 决定性实锤**：官方构建 + 现解 param → 200（[37 §8.2](zcode-plan-37-排障手册.md)）。

### 1.3 Individual 付费通道（API-key）

- **认证双头皆可**（§1.4 矩阵）：`Authorization: Bearer` 与 `x-api-key` 都过认证层——只发 `x-api-key` 的客户端（Breezell 类）可直连官方端点，前提是账户有余额/订阅。
- **V4 签名**：仅此通道族启用，gate = `/api/v1/agent/configs` 下发，当前对本 key 404 = **关闭**；**A/B 定案：gate 关闭时服务端不校验签名头**（`tools/v4_sign_e2e.py`，两组归一化一致，[05 §8](zcode-plan-05-V4请求签名协议.md)）。开通付费订阅后先跑 `tools/probe_sig_gate.py`。
- **额度语义是订阅份**：`subscription/list` 返回订阅列表；本账号实测 `data:[]` = 无订阅 → 打模型端点 `429 code 1113`。
- **2026-09-28 补测：Key 通道的额度面比"订阅份"宽，"免费账号的 Key 必 1113"不成立**——Start Plan 免费账号自动创建的 `zcode-api-key`（`{id}.{secret}` 49 字符形）打 `api.z.ai/api/anthropic/v1/messages`（`x-api-key`，模型 `GLM-4.5-Flash`，无验证码无签名头）实测 **HTTP 200** 真实回复。Key 名下的按量付费余额（新号赠送 / 活动发放 / 充值）同样驱动该通道；`1113` 仅在订阅与余额皆空时出现，是"认证已过、计费层拒"的判据而非协议故障。同请求另证 **Key 通道的模型面 = 按量付费 API 清单**：`GLM-4.5-Flash` 既不在 CDN coding-plan 目录 4 模型内（§1.8），也不在 Start Plan 余额桶 `capabilities` 内——目录/桶都不是 Key 通道模型面的上界。

  完整响应实录（2026-09-28 22:33 CST，最小请求体 `{"model":"GLM-4.5-Flash","max_tokens":32,"stream":false,"messages":[{"role":"user","content":"reply with: pong"}]}`）：

  ```jsonc
  {"id":"msg_202609282233022c4a8eaa85f24d3b","type":"message","role":"assistant",
   "model":"GLM-4.5-Flash",
   "content":[{"type":"thinking","thinking":"…","signature":"6dc53c67b21a49b6a3d6f664"}],
   "stop_reason":"max_tokens","stop_sequence":null,
   "usage":{"input_tokens":7,"output_tokens":50,"cache_read_input_tokens":6,
            "server_tool_use":{"web_search_requests":0},"service_tier":"standard"}}
  ```

  要点：认证头仅需 `x-api-key` + `anthropic-version`；**按量通道也有提示词缓存**（`cache_read_input_tokens: 6`）；`thinking` 块带 `signature` 字段，与免费通道同形。

  按量清单端点：`GET {api.z.ai|open.bigmodel.cn}/api/paas/v4/models`（`Authorization: Bearer <key>`，OpenAI 形 `{"data":[{id,object,created,owned_by}]}`）实测 zai 侧 **11 个**：`glm-4.5 / 4.5-air / 4.6 / 4.7 / 5 / 5-turbo / 5.1 / 5.2 / 5.3 / 5.3-flash / 5.3-flashx`（全 `owned_by: z-ai`，无 embedding 类需过滤）。

### 1.4 认证头与端点的实测矩阵（2026-09-26 23:50 CST，付费通道诊断）


同一把 coding plan key（`{32hex}.{16char}` 格式）打四个端点 × 两种认证头，用来定位"到底是认证挂了还是余额挂了"。**判定方法：401 = 认证失败，429/400 = 认证已过**。

| 端点 | `Authorization: Bearer` | `x-api-key` | 结论 |
|---|---|---|---|
| `open.bigmodel.cn/api/paas/v4/models` | **200** | — | key 有效 |
| `api.z.ai/api/paas/v4/models` | **200** | — | key 有效 |
| `api.z.ai/api/coding/paas/v4/models` | **200** | — | key 有效 |
| `open.bigmodel.cn/api/anthropic/v1/messages` | 429 | **429** | 两种头**都过认证** |
| `api.z.ai/api/anthropic/v1/messages` | 429 | **429** | 两种头**都过认证** |
| `open.bigmodel.cn/api/paas/v4/chat/completions` | **429 `code 1113` 余额不足** | — | key 有效、余额空 |
| `zcode.z.ai/…/zcode-plan/anthropic` | 400 `code 3007` | **401** | 见下（2026-09-26 记录；3007 已于次日解除，见 [37 §8](zcode-plan-37-排障手册.md)） |

两条可用结论：

1. **官方 anthropic 端点接受 `x-api-key`**（不是 401）。这意味着 Breezell 一类只发 `x-api-key` 的客户端**可以直连官方端点**，无需协议桥接——只要该 key 账户有余额。
2. **ZCode 代理端点只认 `Authorization: Bearer`**：同一 JWT 用 `x-api-key` 发会 **401**，用 Bearer 发是 **400/3007**。两种状态码的差值就是"认证过 vs 没过"的分界。

### 1.5 Team 通道

`account:zai/bigmodel-team-coding-plan`，团队项目 key（运行时投影）。入口校验 `GET {biz}/api/biz/customer/getCustomerInfo`（组织/项目）再验订阅；individual key 打它 = `403 APIKey not allow access`。**四通道中细节最薄**——无 team 凭据，无完整实测，结构同付费族。

### 1.6 off-peak 通道

`account:zai/bigmodel-offpeak-idle-plan`（隐藏 provider）。模型端点 `zcode.z.ai/api/v1/off-peak/anthropic`；票据制（`x-off-peak-ticket-id` 头，`server_ticket_id`）；宿主为独立 scheduler 进程（[31](zcode-plan-31-Cron调度循环.md)）；**不验证码、不签名**。票据签发/续期服务端细节待运行期实包（[06 §8](zcode-plan-06-off-peak档位.md)）。

### 1.8 模型目录（2026-09-27 实测定案）

**平台模型上限不在 `zcode.z.ai/api/v1/zcode-plan/` 下**——实测四条候选路径全部 `404`：

| 路径 | 结果 |
|---|---|
| `zcode-plan/models` | `404 page not found` |
| `zcode-plan/v1/models` | `404 page not found` |
| `zcode-plan/billing/models` | `404 page not found` |
| `zcode-plan/anthropic/v1/models` | `404 page not found` |

**真正的目录在 CDN 上，经 `client/configs` 两跳拿到：**

```
GET zcode.z.ai/api/v1/client/configs?app_version=<ver>&platform=<platform-key>
  → data.configs.builtin_provider_config_json
       = https://cdn-zcode.z.ai/zcode/config/zcode-builtin-23.json      （150 KB）
    → config.modelConfigRules.builtinProviderModelRules
      = [{providerId, modelId, config:{enabled}}, …]      实测 28 条 / 8 个 providerId
```

> 该 CDN 文件名带版本号（`zcode-builtin-23.json`），上游改版即 404——实现必须缓存 + 降级。
> 本地副本落 `~/.zcode/v2/runtime/provider/<platform>/<ver>/endpoint-<hash>/zcode-builtin.json`
> （[14 §4](zcode-plan-14-本地存储全schema.md)），与 §1.1 说的 `providerRules` 同源。

**2026-09-28 二次实调补测**（重新拉取 `zcode-builtin-23.json` 全量核对）：

- `builtinProviderModelRules` 28 条规则的 **distinct modelId = 4**：`GLM-5.3`、`GLM-5.3-Flash`、`GLM-5.2`、`GLM-5-Turbo`（规则仅 `{providerId, modelId, config:{enabled}}` 三字段，无 contextWindow 等元数据）；
- 覆盖矩阵：`GLM-5.3-Flash / 5.2 / 5-Turbo` 挂在全部 8 个 providerId（两族 × start-plan/individual/team/offpeak-idle）；**`GLM-5.3` 只挂在 4 个付费槽位（individual/team × 两族），start-plan 规则里没有**——而 [03 §3](zcode-plan-03-billing-balance-接口与实调.md) 实测 Start Plan 账号的 balance 桶确有 `model:glm-5.3` 授权。即**服务端发桶不遵循这份客户端规则**，CDN 规则只是模型行为配置，授权清单以 balance 的 `capabilities` 为准（「配置面 ≠ 授权面」实证）；
- 同文件另有 `templateModelRules`（219 条）：全模板 distinct modelId 158 个，含第三方供应商（claude/gpt/qwen/kimi/minimax/deepseek/grok/mimo 等）及 `z-ai/glm-*`、`openai/gpt-*` 别名形态——这是完整的多供应商注册表模板，**与 coding-plan 内置通道的可用面无关**；
- `data.builtinProviders` 实测 5 项（`builtin:bigmodel` / `builtin:bigmodel-coding-plan` / `builtin:zai-coding-plan` / `builtin:zai` / `team-plan:builtin`），每项 `models` 均只有 GLM-5.3、GLM-5.3-Flash 两条。

#### `client/configs` 响应的完整形状（2026-09-28 实测）

`data` 顶层共 4 个键，**我们只读了 `configs`**：

```
{ code:0, msg:"", logid:"…",
  data: { configs:{…15 项}, providers:[…4], builtinProviders:[…], builtinModels:[…2] } }
```

| 字段 | 实测 | 用途 |
|---|---|---|
| `data.configs.builtin_provider_config_json` | CDN URL | **模型目录的真相源**（本节链路） |
| `data.configs.startPlanPreview` | `{name, planId, entitlements[]}` | Start Plan 每日额度，见 [11 §5.4](zcode-plan-11-签到领取接口.md) |
| `data.configs.offPeak` | `{allowed_models, enable_offpeak_task}` | 闲时档模型白名单（[06](zcode-plan-06-off-peak档位.md) 那半边） |
| `data.providers` | 4 项，含 `baseUrl` / `apiKeyUrl` / `defaultModel` / `modelMapping` | provider 注册表，含**模型映射**（如 `ANTHROPIC_DEFAULT_HAIKU_MODEL → glm-4.5-air`） |
| `data.builtinModels` | **仅 2 条** | ⚠️ 见下 |

> ⚠️ **`data.builtinModels` 是裁剪版，不能当模型目录用**：实测只有 `GLM-5.3` 等 2 条，
> 而 CDN 那份是 **28 条 / 8 个 providerId**。拿它实现 `/v1/models` 会丢掉大部分模型。
> 目录仍须走 `configs.builtin_provider_config_json` → CDN 两跳。

**8 个 providerId 的完整授权表（实测）——两家族逐字相同：**

| providerId | 启用模型 |
|---|---|
| `account:{zai,bigmodel}-start-plan` | `GLM-5.3-Flash` `GLM-5.2` `GLM-5-Turbo` |
| `account:{zai,bigmodel}-offpeak-idle-plan` | `GLM-5.3-Flash` `GLM-5.2` `GLM-5-Turbo` |
| `account:{zai,bigmodel}-individual-coding-plan` | `GLM-5.3` `GLM-5.3-Flash` `GLM-5.2` `GLM-5-Turbo` |
| `account:{zai,bigmodel}-team-coding-plan` | `GLM-5.3` `GLM-5.3-Flash` `GLM-5.2` `GLM-5-Turbo` |

**这是家族不影响模型授权的第三次独立印证**（前两次：[01 §0.1.1](zcode-plan-01-计划体系与供应商标识.md) 端点、[03 §3.1](zcode-plan-03-billing-balance-接口与实调.md) 认证）。家族只决定请求打向哪个域。

**平台上限 ≠ 账号授权（两层，包含关系）：**

| 层 | 来源 | 语义 | 本账号实测 |
|---|---|---|---|
| 平台上限 | `builtinProviderModelRules` | 该档位**理论上**能用哪些 | Start Plan **4** 个 |
| 账号授权 | `billing/balance` 的 `buckets[].capabilities` | 这个账号**实际**拿到哪些 | **2** 个（`GLM-5.3` / `GLM-5.3-Flash`） |

所以对外公布模型时应**以桶为准**，平台目录只作上限与兜底 —— 否则会给客户端报出必然 `3006` 的模型。

**付费档另有一个独立目录**（api-key 专用，JWT 读不到，实测 401）：

| 端点 | 结果 |
|---|---|
| `api.z.ai/api/paas/v4/models` | `200`，11 个 |
| `open.bigmodel.cn/api/paas/v4/models` | `200`，11 个，与上者**逐字相同** |
| `api.z.ai/api/coding/paas/v4/models` | `200`，11 个，与上者**逐字相同** |

11 个：`glm-4.5` `glm-4.5-air` `glm-4.6` `glm-4.7` `glm-5` `glm-5-turbo` `glm-5.1` `glm-5.2` `glm-5.3` `glm-5.3-flash` `glm-5.3-flashx`

> ⚠️ 该端点返回的是**小写**名，而 messages 端点大小写敏感（[12](zcode-plan-12-阿里云验证码体系.md)：
> 小写 `glm-4.6` → `400 code 3006`）。**必须先过大小写映射表再发请求。**
> 且它是"平台有什么"而非"你能用什么"——本账号无订阅无余额，真能调的远少于 11 个。

**同一次 `client/configs` 里另有两个模型相关字段：**

```jsonc
"offPeak":       { "allowed_models": ["GLM-5.3", "GLM-5.3-Flash"],
                   "enable_offpeak_task": true },
"startPlanPreview": { "planId": "zcode-v3-start-plan",
                   "entitlements": [ {showName:"GLM-5.3",        period:"daily", grantUnits:3000000},
                                     {showName:"GLM-5.3-Flash",  period:"daily", grantUnits:5000000} ] }
```

`startPlanPreview` 是**标准 Start Plan 档包含什么**（固定值），与 `billing/preview` 的"当前可领取什么"互补——后者实测 `plans: []`（无可领）。

### 1.9 工厂分支与 URL 归一化


```js
switch (kind) {
  case "anthropic":         return fan({apiKey: f, baseURL: mRs(n.baseURL), fetch: BUr(T), headers: dRs(f, g)});
  case "openai":            return kan({apiKey: f, baseURL: n.baseURL, fetch, headers: g}).responses;
  case "openai-compatible": return NUr({name, baseURL: n.baseURL, apiKey: f, fetch: T, headers: g,
                                        includeUsage: !0, supportsStructuredOutputs: u});
}
```

`mRs`（**仅 anthropic 分支使用**的 baseURL 归一化）：

```js
// 去尾部斜杠；pathname 不以 /v1 结尾（大小写不敏感）则补 /v1
"https://zcode.z.ai/api/v1/zcode-plan/anthropic" → ".../anthropic/v1"
```

AI SDK 的 `buildRequestUrl`（无任何覆盖）= `${baseURL}/messages`。

### 1.8 五类失败的判别（别混，跨通道）


| 现象 | 含义 | 该做什么 |
|---|---|---|
| `HTTP 401` | 认证没过（头错、audience 不对、token 过期） | 换认证头或换端点 |
| `HTTP 429` + `code 1113` | **认证过了，卡在计费层**。文案 `Insufficient balance or no resource package` 是**两个独立 or 分支**——可能是余额空、可能无资源包、也可能无订阅，需分别查（术语见 [01 §0](zcode-plan-01-计划体系与供应商标识.md)） | 先查 `subscription/list` 判订阅；充值；换 key 无用 |
| `HTTP 400` + `code 3007` | 认证过了，卡在阿里云验证码 | 需要交互式挑战 |
| `HTTP 400/405` + `code 3012` | 认证与验证码**都过了**，请求构建层被拒。真因三项：①缺官方 system 身份块（主因）②`metadata.user_id` 形状错 ③客户端指纹头透传泄漏——与验证码/JWT/IP 均无关（终定性见 [37 §8.2](zcode-plan-37-排障手册.md)） | 整体采纳官方构建：身份块 4 块 + `metadata.user_id`（JWT uuid）+ trace 三件套；start-plan **不发** `x-query-id`/`x-session-id`、剥离 `x-stainless-*` 透传 |
| `HTTP 400` + `code 3006` | 模型名不在通道允许集（**大小写敏感**） | 官方名 `GLM-5.3-Flash` / `GLM-5.3` |

`/models` 返回 200 **不能**作为"key 可用"的结论——它不校验余额。**必须发一次 chat 才能区分 401 / 1113 / 3007 / 3012 / 3006。**（e2e 决定性实锤见 [37 §8.2](zcode-plan-37-排障手册.md)：构建层修正后 200）

## 2. 请求头（model-io 日志实录，认证头被日志器剥离）

```jsonc
{
  // 来源头组（buildCliZCodeSourceHeaders，见 02 文档 §5）
  "http-referer": "https://zcode.z.ai",
  "user-agent": "ZCode/3.14.3",
  "x-zcode-app-version": "3.14.3",
  "x-title": "Z Code@electron",
  "x-release-channel": "production",
  "x-client-language": "zh-CN",
  "x-client-timezone": "Asia/Shanghai",
  "x-zcode-agent": "glm",
  "x-platform": "win32-x64",
  "x-os-category": "windows",
  "x-os-version": "10.0.26100",
  // 安全验证（风控触发时携带）
  "x-aliyun-captcha-verify-param": "[REDACTED]",
  "x-aliyun-captcha-verify-region": "cn",
  // 会话追踪
  "x-request-id": "<uuid>",
  "x-zcode-session-type": "main",      // main / 子代理等其他类型
  "x-zcode-trace-id": "<trace uuid>",
  "x-query-id": "<uuid>",
  "x-session-id": "<session uuid>"
  // 认证头（日志剥离，未出现在日志中，见 §3）
}
```

### 2.1 UA 与 platform 的官方双形态（2026-09-27，zcode2api-plus `profile.go` 交叉核对 + bundle 验证）

- **User-Agent 两种官方形态**：desktop（Electron 内嵌 CLI，本会话 model-io 实录）= 裸 `ZCode/3.14.3`；standalone CLI 形态 = `ZCode/<ver> ai-sdk/provider-utils/4.0.27 runtime/node.js/22`——后缀机制在 bundle 内实存（`ZBr="4.0.27"`；`kit()` 运行时段）。**2026-09-27 自动更新后的 zcode.cjs 实锤为 0.16.x 独立版本线**（含 `"0.16.5"/"0.16.9"` 字符串、无 3.14.x）——golden 的 `0.16.9` 即 CLI 自身版本；desktop 的 `3.14.3` UA 由 host 以应用版本组装。对齐哪个取决于伪装的是哪种分发形态。
- **`platform` 参数两种官方形态，按端点区分**：`X-Platform` 头与 billing/preview 的 `platform=` = `win32-x64`（`resolveClientPlatformKey`）；**builtin 目录刷新**（`fetchRelease`，standalone 路径）= `platform=windows-x86_64`（`resolveZCodeBuiltinClientPlatform` 计算）。
- 本机佐证：`~/.zcode/v2/runtime/provider/windows-x86_64/3.14.3/endpoint-78d7c3bef4024722642626fe3669a799/zcode-builtin.json` 实存（[14 §4](zcode-plan-14-本地存储全schema.md)）。

## 3. 认证

| 通道 | 凭证来源 | 发送方式 |
|---|---|---|
| API-key 模板（`zhipu-coding-plan-api-key` 等） | `access.apiKey` | AI SDK 发 `x-api-key: <key>`；包装层 `dRs` 再补 `Authorization: Bearer <key>`（双发） |
| 账号通道（`zhipu-account`，即 start-plan/individual/team） | 运行时 `resolveRequest(..., requestAuth)` 按次解析（`accountRequestAuthService.resolveCurrent`） | 同上：`x-api-key` + `Authorization: Bearer`（`dRs(f, g)` 在缺 Authorization 时注入） |
| off-peak | `requestDependencies.requestAuth.source.resolve()` 动态解析，缺失抛 `ModelRequestAuthMissing` | 同上 |

- AI SDK 层：`anthropic-version: 2023-06-01` 固定头；UA 追加 `ai-sdk/anthropic/<ver>`。
- individual/team 通道在传输层包 V4 签名 fetch（见 [05](zcode-plan-05-V4请求签名协议.md)）；start-plan/off-peak 不签名。
- 请求头可带 `anthropic-beta`（`getBetasFromHeaders` 合并到 beta 集）。

## 4. 请求体（Anthropic Messages 格式，实测全文结构）

```jsonc
{
  "model": "GLM-5.3-Flash",        // 展示 id；响应侧归一为 "glm-5.3-flash"
  "max_tokens": 128000,
  "stream": true,                  // 主对话恒为流式
  "metadata": { "user_id": "<hash>" },
  "system": [                      // 数组形态，逐块 cache_control
    { "type": "text", "text": "...", "cache_control": {"type": "ephemeral"} }  // ×3
  ],
  "messages": [...],               // 标准 Anthropic 消息（role: user/assistant + content 块）
  "tools": [                       // Anthropic 工具格式（实测 34 个）
    { "name": "Agent", "description": "...",
      "input_schema": {"type":"object", "properties": {...}, "required": [...],
                        "additionalProperties": false, "$schema": "...2020-12/schema"} }
  ],
  "tool_choice": { "type": "auto" },
  "thinking": { "type": "enabled" },        // 扩展思考
  "output_config": { "effort": "max" }      // GLM 扩展：推理努力档位
}
```

### 4.1 thinking / output_config 生成规则（AI SDK body 构造器）

```js
...(thinking && { thinking: { type: <enabled...>, budget_tokens?, display? } }),
...(effort || taskBudget || (jsonSchema && { output_config: {
      effort,                                   // ← reasoningLevel 映射（"max" 等）
      task_budget: { type, total, remaining? },
      format: { type: "json", schema }          // 结构化输出
}})),
// 其余标准字段: temperature, top_k, top_p, stop_sequences ...
```

- 会话的 `reasoningLevel`（DB `model_usage.reasoning_level` 列，本会话为 `max`）→ `output_config.effort`；`/effort` 斜杠命令可切换。
- 兼容层会改写请求体：`xPs` = `applyAnthropicRequestBodyCompatibility`（thinking 块兼容改写）、`TPs`/`IPs`（memory 选择器消息边界还原）。

### 4.2 转换层架构（2026-09-27 函数体实读，B 级）

§4 的请求体不是直接拼 JSON——中间隔一层 **AI SDK 语言模型消息规范化**（`convert.to` 家族，13 函数，大半为 vendored AI SDK 适配层）：

1. 运行时消息 → `convertToLanguageModelMessage`（`UMs`）：字符串 content 包装成块数组；**过滤空 text 块**（assistant 块带 providerOptions 才豁免）与 **`tool-approval-request` 块类型**——权限审批请求是内部 content 类型，永不出网
2. 按协议分发：anthropic 走 `convertToAnthropicMessagesPrompt`（`cIs`）——**§4 的 `cache_control` 就在这里经 validator 注入**（system 块起逐块判定）；两个 provider-option 钩子：`citations.enabled` 引用开关、文档块 `{title, context}` 元数据。openai 系走 `convertToOpenAIResponsesInput` / `convertToOpenAICompatibleChatMessages` / `convertToOpenAICompletionPrompt`——[09](zcode-plan-09-OpenAI兼容与Responses协议.md) §1/§2 getArgs 的本体
3. 媒体工具：`convertToFormData`（数组走 `key[]` 括号约定）、`convertToBase64`；远端媒体下载带 **Content-Length 与流式累计双 maxBytes 上限**，超限即抛
4. `convertToZCodeAgentMcpServer`：ZCode agent 定义 → MCP server 配置的转换（名称推断：agent 可作为 MCP server 暴露，C 级）

## 5. 流式响应协议（SSE）

标准 Anthropic 事件流：

```
event: message_start        → {message:{id, usage{...}}}    // id 形如 msg_20260926065324cd30b5b433a54a9b
event: content_block_start  → {index, content_block:{type: text|thinking|tool_use|...}}
event: content_block_delta  → {index, delta:{type: text_delta|input_json_delta|thinking_delta|signature_delta, ...}}
event: content_block_stop   → {index}
event: message_delta        → {delta:{stop_reason}, usage:{output_tokens}}
event: message_stop
event: ping / error
```

**GLM 兼容层**（`BUr` = `createAnthropicCompatFetch`，流经 `LPs` = `createAnthropicStreamCompatTransform`）：

| 修复 | 函数 | 行为 |
|---|---|---|
| signature_delta 补发 | `FPs`/`jPs`/`UUr` | GLM 在 `content_block_start` 声明了 thinking `signature` 但流中无 `signature_delta` 时，于 `content_block_stop` 前合成注入 `content_block_delta{signature_delta}` |
| tool_result 过滤 | `NPs`/`FPs` | 流中出现 `tool_result` 块时整块压制（suppressedIndexes） |
| 无签名 thinking 清理 | `MPs`/`RPs` | 非流式响应里剥掉既无 signature 也无 redactedData 的 thinking 块（`rewriteAnthropicJsonThinkingResponse`） |
| memory 边界还原 | `TPs`/`IPs` | 把 memory 选择器合并消息拆回两条 user 消息 |

## 6. 响应汇聚结构（model-io 记录形态）

```jsonc
{
  "finishReason": "stop",             // stop | tool-calls | length ...
  "modelId": "glm-5.3-flash",         // 服务端归一化小写
  "responseId": "msg_20260926...",
  "text": "...", "reasoningText": "...",
  "toolCalls": [ { "toolCallId", "toolName", "input" } ],
  "usage": { "inputTokens", "outputTokens", "totalTokens",
             "cacheReadTokens", "cacheWriteTokens" },
  "providerMetadata": { "anthropic": {
      "usage": { "input_tokens", "output_tokens", "cache_read_input_tokens",
                 "server_tool_use": {"web_search_requests": 0},
                 "service_tier": "standard" } } }
}
```

响应头（实测）：`x-request-id`、`x-log-id`（阿里 CDN `eagleid`/`server: ESA`）、`content-type: text/event-stream`。**无 ratelimit 头**——配额走 balance 接口（[03](zcode-plan-03-billing-balance-接口与实调.md)），超限时以业务错误码（如 `coding_plan_required`）返回。

## 7. 重试与失败

- model-io 每条记录带 `attempt`（重试计数）；provider 层按 `retryAfterMs` 决策（off-peak 票据过期则不可重试，见 [06](zcode-plan-06-off-peak档位.md)）。
- 业务错误经 `tG` = `isProviderBusinessError` / `ProviderBusinessError` 通道归一（含 64KB 响应截断 `IDe=64e3`）。
- 风控：`coding_plan_security_verification_required` → UI 弹验证码 → 通过后后续请求带 `x-aliyun-captcha-verify-param`（日志实测存在）。

## 8. 与其他接口的关系

- balance/配额：`zcode.z.ai/api/v1/zcode-plan/billing/balance`（[03](zcode-plan-03-billing-balance-接口与实调.md)）——模型请求不查余额，服务端在网关层校验并返回业务错误。
- 会话/工作流统计：`zcode.z.ai/api/v1/v4/usage/stats`、`v4/conversation/*`（ZCode 云端会话，与模型请求分离）。
- 本地留痕：`~/.zcode/cli/db/db.sqlite`（逐请求 token 用量）+ `~/.zcode/cli/rollout/model-io-*.jsonl`（请求/响应全文，认证头剥离）。

## 9. 协议矩阵（zcode-builtin.json 全量模板 → 协议映射）

三种协议的工厂分支差异：

| 协议 | AI SDK 工厂 | URL 规则 | 特有行为 |
|---|---|---|---|
| `anthropic-messages` | `fan`（anthropic.messages） | `mRs` 补 `/v1` + `/messages` | GLM 兼容层（§5）、`anthropic-version: 2023-06-01`、`thinking`/`output_config` 扩展 |
| `openai-chat-completions` | `NUr`（openai-compatible） | baseURL 原样 + `/chat/completions` | `includeUsage: true`（流末尾发 usage 块） |
| `openai-responses` | `kan`（responses API） | baseURL 原样 + `/responses` | OpenAI Responses 协议 |

内置模板 → 协议 → 端点（运行时配置 revision 30 实测）：

| 模板 | 协议 | 端点 |
|---|---|---|
| `zai-api`（Z.ai Coding Plan / Start Plan） | anthropic-messages | `https://api.z.ai/api/anthropic`（→ `/v1/messages`） |
| `zai-standard-api`（Z.ai API） | openai-chat-completions | `https://api.z.ai/api/paas/v4` |
| `bigmodel-api` | anthropic-messages | `https://open.bigmodel.cn/api/anthropic` |
| `bigmodel-standard-api` | openai-chat-completions | `https://open.bigmodel.cn/api/paas/v4` |
| `moonshot-kimi` | anthropic-messages | `https://api.moonshot.cn/anthropic` |
| `minimax` | anthropic-messages | `https://api.minimaxi.com/anthropic` |
| `deepseek` | anthropic-messages | `https://api.deepseek.com/anthropic` |
| `qwen-alibaba-model-studio-cn` | anthropic-messages | `https://dashscope.aliyuncs.com/apps/anthropic` |
| `qwen-alibaba-model-studio-intl` | openai-chat-completions | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| `xiaomi-mimo` | anthropic-messages | `https://api.xiaomimimo.com/anthropic` |
| `openrouter` | anthropic-messages | `https://openrouter.ai/api` |
| `anthropic`（官方） | anthropic-messages | `https://api.anthropic.com/v1` |
| `openai`（官方） | openai-responses | `https://api.openai.com/v1` |
| `xai` | openai-responses | `https://api.x.ai/v1` |
| `opencode-go-{chat,messages,responses}` | 三种各一 | `https://opencode.ai/zen/go/v1` |
| `opencode-zen-{chat,messages,responses}` | 三种各一 | `https://opencode.ai/zen/v1` |

> 观察：国内模型厂商（GLM/Kimi/MiniMax/DeepSeek/Qwen/MiMo/OpenRouter）清一色提供 Anthropic 兼容端点——Anthropic Messages 已是 coding agent 生态的事实标准协议；`zai-api` 是唯一吃 GLM 私有扩展（`output_config.effort`/GLM 兼容层）的通道。

> 另外两种协议（`openai-chat-completions`、`openai-responses`）的请求体/认证/流式格式完整逆向见 **[09-OpenAI兼容与Responses协议](zcode-plan-09-OpenAI兼容与Responses协议.md)**。
