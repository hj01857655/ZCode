# 03 · billing/balance 接口与实调结果

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 核心函数：`$y` = `fetchZaiStartPlanBalanceEnvelope`（app.asar host 侧）

## 1. 接口定义

```
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<clientVersion>
Authorization: Bearer <zcodejwttoken>
超时: Rpe = 15000ms
```

- URL 由 `Es` = `buildZaiStartPlanBalanceUrl` 构造：`em(env).zcodePlanBillingBalanceUrl`（`jv` = `buildZCodeEndpointUrls` 派生自 origin `https://zcode.z.ai`）+ `app_version` 查询参数。
- 认证令牌：Z.ai Start Plan 用 `zcodejwttoken`（`ufe`/`dfe`），bigmodel Start Plan 用 `zcodejwttoken`（需 `oauth:active_provider === "bigmodel"`）或 provider.apiKey（`uj`）。

### 1.1 必需请求头（缺任意一组可能返回 `HTTP 400 {code:3001, msg:"parameter error"}`）

复刻 `buildZCodeSourceHeadersFromContext` + `withRequestIdHeader`（实测通过）：

```
Authorization: Bearer <token>
User-Agent: ZCode/3.14.3
HTTP-Referer: https://zcode.z.ai
X-Title: Z Code@electron
X-ZCode-App-Version: 3.14.3
X-Platform: win32-x64
X-Release-Channel: stable
X-Client-Language: zh-CN
X-Client-Timezone: Asia/Shanghai
X-Os-Category: windows
X-Os-Version: <os version>
X-Device-Mid: <deviceMid>
x-request-id: <uuid>
```

#### 移植陷阱：`platform` 的 arch 必须与 Node 对齐（2026-09-28 实测）

`X-Platform` 与 `client/configs` 的 `?platform=` **都要求 Node 的 `process.arch` 取值**
（官方 `resolveClientPlatformKey()` = `` `${process.platform}-${process.arch}` ``，即 `win32-x64`）。

**Python 的 `platform.machine()` 在同一台机上返回 `AMD64`**，直接拼会得到 `win32-amd64` 并被拒：

```
win32-x64      -> 200  {"code":0,"data":{"providers":[…]}}
win32-amd64     -> 400  {"code":3001,"msg":"parameter error"}     ← 只这一个是 400
linux-x64      -> 200
```

**上游校验的是 arch 字符串的字面值**，不是判断「这台机是不是 64 位」。
移植到非 Node 运行时必须做映射：`amd64|x86_64 → x64`、`aarch64 → arm64`、`i386|i686 → ia32`。
本项目在 `app/clientconfig.py::ARCH_MAP` 处理。

> 该失败模式很隐蔽：`client/configs` 400 会让 `catalog` 静默回落到 4 个硬编码兜底模型，
> `/v1/models` 看起来仍然正常（只是少了几个），不报错。

### 1.2 客户端缓存

`$y` 内部：`WeakMap<apiClient, Map<key, Promise>>`，key = `JSON.stringify({authorization: token.trim(), url})`；命中直接复用 Promise，**1 秒后自动逐出**（`finally` 中 `setTimeout(evict, 1000 - elapsed)`），`invalidateBalanceCache=true` 时先删除。多路并发同 key 共享同一次请求。

## 2. 响应结构（信封）

```jsonc
{
  "code": 0,                // 成功；!==0 时抛 "Start Plan balance failed: <code>"
  "msg": "",
  "data": { "server_time": 1790378206, "plans": [...], "balances": [...] },
  "logid": "20260925231653..."       // 服务端日志 id
}
```

成功判定 `a_` = `isSuccessfulBusinessEnvelope`：`success !== false && (code === undefined || 0 || 200)`。

### 2.1 plans[]（订阅的套餐）

| 字段 | 实测值/含义 |
|---|---|
| `user_plan_id` | 用户-套餐实例 id（`upl_*`） |
| `plan_id` | 套餐 id，如 `zcode-v3-start-plan-0817` |
| `name` / `description` | "ZCode Start Plan" / "免费 GLM 旗舰模型体验" |
| `priority` | 套餐优先级（Start=90/110，用于多套餐并存时取舍） |
| `status` | `active`；`normalizeStartPlanExpiry` 会把 `ends_at <= server_time` 的改写为 `expired` |
| `starts_at` / `ends_at` | Unix 秒 |
| `entitlements[]` | `{entitlement_id, show_name, meter, unit_type, capabilities[], grant_units, period, priority, effective_at}` |

Start Plan 判定：`zj` = `hasActiveStartPlan` + `Dj` = `isZaiStartPlanIdentity`（`plan_id`/`name` 含 `"start-plan"` 或 `"start plan"` 子串）；`Yme` = `pickCurrentZaiStartPlan` 从中选当前套餐。

### 2.2 balances[]（额度桶）

| 字段 | 实测值/含义 |
|---|---|
| `bucket_id` | 额度桶 id（`bucket_*`） |
| `user_plan_id` / `plan_id` / `entitlement_id` | 三级归属（孤儿桶会被 `qme` 告警："返回无法归属到 active 套餐的额度桶"） |
| `show_name` / `meter` / `unit_type` | `GLM-5.3` / `model_usage` / `token` |
| `capabilities[]` | `["model:glm-5.3"]` —— 模型授权来源 |
| `total_units` / `used_units` / `remaining_units` / `available_units` | 数值（token 数） |
| `priority` / `plan_priority` / `entitlement_priority` | 多桶排序用 |
| `period_start` / `period_end` / `expires_at` | Unix 秒，日窗为当天 00:00:00–23:59:59（本地时区） |

## 2.3 桶路由：客户端不选桶，服务端按优先级扣

**多个桶可以覆盖同一个模型**，`capabilities` 里有重复的 `model:*` 就说明这种情况。请求时**客户端不指定用哪个额度**——服务端按 `entitlement_priority` 从高到低依次扣，扣完一个再扣下一个。

实测样本（同一账号两个 active 套餐，`glm-5.3-flash` 同时命中两个桶）：

| 桶 | capabilities | 额度 | 周期 | entitlement_priority |
|---|---|---|---|---|
| Weekend Build | `model:glm-5.3-flash` | 300,000,000 | `one_time` | **110** |
| Start Plan | `model:glm-5.3` | 3,000,000 | `daily` | 110 |
| Start Plan | `model:glm-5.3-flash` | 5,000,000 | `daily` | **80** |

因此实际消耗顺序：

```
调 glm-5.3-flash → 先扣 Weekend Build(110) 扣完 3 亿
                 → 再扣 Start Plan 每日桶(80)  500 万/日
调 glm-5.3       → 只有 Start Plan 那个桶     300 万/日
```

**推论**：客户端唯一能"选"的是**模型名**，不是桶。`glm-5.3` 每天只有 300 万且 `priority` 与 flash 同为 110，若把它当默认会当天先烧光。

**认证与桶无关**——所有桶共用同一个端点（`zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`）和同一套 `Authorization: Bearer <zcodejwttoken>`。

## 3. 实调结果（2026-09-26 23:16 CST，HTTP 200）

本账号同时存在两个 active 套餐：

| | ZCode Global Build | ZCode Start Plan |
|---|---|---|
| plan_id | `zcode-v3-start-plan-0925` | `zcode-v3-start-plan-0817` |
| 描述 | "ZCode Global Build" | "免费 GLM 旗舰模型体验" |
| period | `one_time`（一次性 1 亿 token） | `daily`（每日重置） |
| entitlements | GLM-5.3-Flash × 100,000,000 tokens | GLM-5.3 × 3,000,000 + GLM-5.3-Flash × 5,000,000 tokens/天 |
| 有效期 | 当日 23:00 截止（starts_at=领取时刻, ends_at≈23:00） | 至 2026-09-30 23:59:59（ends_at=1790783999） |
| 实测余量 | 94,083,403 / 100,000,000（已用 5,916,597） | 两桶均 3,000,000 / 5,000,000 满额未用 |

> `used_units` 与本地 `db.sqlite` 的 token 用量记录可交叉验证。`effective_at: 0` 表示即时生效；`one_time` 套餐 `effective_at` 为具体时刻（用于 `lfe` 的 pending 判定）。

### 3.1 第二次实调：换号后的对照样本（2026-09-26 23:41 CST，HTTP 200）

同一接口换了一个账号，结构完全一致，可用于确认**额度形状随账号不同**（下面这份是 `bigmodel` 家族 / 微信登录的号）：

| | ZCode Weekend Build | ZCode Start Plan |
|---|---|---|
| plan_id | `zcode-v3-start-plan-0924-wk-2` | `zcode-v3-start-plan-0817` |
| priority | 100 | 90 |
| 有效期 | `1790405975` → `1790557200` | `1790370670` → `1790783999` |
| 桶 1 | GLM-5.3-Flash × **300,000,000** `one_time` | GLM-5.3 × 3,000,000 `daily` |
| 桶 2 | — | GLM-5.3-Flash × 5,000,000 `daily` |
| 实测余量 | **300,000,000 / 300,000,000（未用）** | 两桶均满额未用 |

与 §3 那个账号的差异，值得注意的两点：

1. **一次性额度的量级不同**：1 亿（`Global Build`）vs **3 亿**（`Weekend Build`），活动不同。
2. **第二个账号的 `glm-5.3` 桶满额，而第一个账号两个 daily 桶也满额**——说明 `daily` 桶在 `starts_at` 当天不会被历史消耗影响。

> 换号也换 provider：ZCode 侧 `oauth:active_provider` 从 `zai` 变为 `bigmodel`，但 **Start Plan 的端点与认证不变**（`zcode.z.ai` + `zcodejwttoken`），变的是付费档的 `baseUrl`（见 [08 §1.1](zcode-plan-08-聊天对话接口.md)）。

## 4. 响应解析函数族（app.asar，原始名齐全）

| 函数 | 原始名 | 作用 |
|---|---|---|
| `$y` | `fetchZaiStartPlanBalanceEnvelope` | 发请求 + 1s memo + 过期归一化 |
| `Epe` | `normalizeStartPlanExpiry` | 过期套餐改写 `expired`；过滤仅剩过期套餐的桶；serverTime = 响应 date 头 ?? `data.server_time` ?? 本地时间 |
| `Yme` | `pickCurrentZaiStartPlan` | 选当前 active Start Plan |
| `z_` | `readZaiStartPlanBalances` | `data.balances` |
| `vK` | （桶构建器） | 桶 → `{bucketId, userPlanId, periodStart/End, period, meter, unitType, type, planId, unit, number, usage, currentValue, remaining, percentage, nextResetTime...}`，`period` 通过 entitlement_id 关联 plans 取 |
| `Gme` | `buildZaiStartPlanRemaining` | 汇总：`{count, isShow:true, percentage, nextResetTime(最早)}` |
| `Vme` | `buildZaiStartPlanQuota` | `{level: "Start", limits: [桶...]}` |
| `Kme` | `buildZaiStartPlanSubscription` | 订阅视图：`{productId: plan_id, productName: name ?? "编程套餐", beginTime, expireTime, billingCycle, entitlements: [{entitlementId, showName, effectiveTime}]}` |
| `pj` | `resolveZaiStartPlanBalanceModelIds` | 从 `capabilities` 的 `model:<id>` 提取授权模型列表（无则回退 show_name），大小写不敏感去重 |
| `Xme`/`Qme` | `summarizeStartPlans` 等 | 日志脱敏摘要（只留 name/plan_id/status；balances 摘要只留 id/名称/数值） |
| `a_` | `isSuccessfulBusinessEnvelope` | 信封成功判定 |
| `zj`/`Dj` | `hasActiveStartPlan`/`isZaiStartPlanIdentity` | Start Plan 身份匹配 |

## 5. `billing/current` 的响应结构（2026-09-27 实调，HTTP 200）

> **本节为补记**——原「相关接口」表只写了"当前账单/订阅"五个字，无任何字段记录。
> 实调确认它与 `billing/balance` **同构但少一个键**：

```jsonc
{
  "code": 0, "msg": "",
  "data": { "server_time": 1790524736, "plans": [ /* 3 条，字段与 balance 的 plans[] 完全相同 */ ] },
  "logid": "..."
}
```

| 差异点 | 说明 |
|---|---|
| `data` 键 | `balance` = `{server_time, plans, balances}`；**`current` = `{server_time, plans}`，无 `balances`** |
| 顶层键 | 两者一致 `{code, msg, data, logid}` |
| `plans[]` | 字段集与 `balance` 的 `plans[]` 逐字段一致（§2.1） |

**实现含义**（本条是踩坑点）：额度桶的 `period` 关联所需的 `plans[].entitlements[]`
**只能从 `balance` 取**——`current` 不返回 `balances`，若从它取会误以为"端点不带 plans"。
反之 `current` 相对 `balance` **无信息增量**（plans 完全重复），单独再打一次只是多一个
请求、多一份 WAF 暴露面。

## 6. `zcode-plan/usage` 端点不存在（2026-09-27 实测否证）

> **本节为补记**——用于防止重复踩「猜 billing 端点」的坑。
> `check_individual_balance.py:8` 已记录过一次教训：早期凭猜测拼的四个 URL **全部 404**。

实测三个候选变体，**全部 404**（网关层拒绝，非鉴权失败）：

| 请求 | 结果 |
|---|---|
| `GET .../zcode-plan/usage` | `404 page not found` |
| `GET .../zcode-plan/usage/summary` | `404 page not found` |
| `GET .../zcode-plan/usage/current` | `404 page not found` |

**结论**：`zcode-plan` 下不存在 `usage` 端点。"近期用量"数据只能从
`billing/balance` 的 `used_units` 推，或走 `{biz}` 侧的其它端点。
任何调用该路径的实现都是猜的，应删除。

## 7. 待验：`code !== 0` 的错误响应体

§2 只记了客户端行为——`!==0` 时抛 `"Start Plan balance failed: <code>"`，
**没有错误响应样本**。因此以下均未实测，实现时不要假定：

- 错误体是否仍是 `{code, msg, data, logid}` 信封
- `data` 在失败时是 `null`、缺省还是 `{}`
- 鉴权过期（401/403）与业务错误（`code != 0` 且 HTTP 200）如何区分

> 需要一个**已过期或额度耗尽**的 token 才能触发。解决此项需要那种状态的凭据，
> 当前凭据均为 active，属未闭合项。

---

## 8. 相关接口（同族）

| 端点 | 用途 |
|---|---|
| `GET .../zcode-plan/billing/current` | 当前账单/订阅（`zcodePlanBillingCurrentUrl`） |
| `GET {biz}/api/biz/subscription/list` | individual 订阅有效性（`nfe`/`rfe`） |
| `GET {biz}/api/biz/customer/getCustomerInfo` | 团队入口组织/项目校验 |
| `GET …/api/v1/zcode-plan/billing/current` | 当前生效计划快照（0.16.x CLI 端点注册表新增；语义 C 级） |
| `GET\|POST {biz}/api/biz/v1/organization/{orgId}/projects/{projectId}/api_keys` | bigmodel 团队 API key 列表/创建（名 `zcode-team-api-key`，keyType=2）；`.../copy/{apiKey}` 取 secret |
| `GET /api/monitor/usage/quota/limit` | 官方 MCP 配额（`dK` = `fetchMcpQuotaSnapshot`） |
| `POST /api/v1/coding-plan/reset` | 配额重置相关（`rw`，客户端仅持有常量） |
| `POST {origin}/api/paas/c1f3a7e2/v2/client` | V4 签名握手（见 [05](zcode-plan-05-V4请求签名协议.md)） |

统一超时 `s_/di = 15000ms`；错误常量 `o_ = "coding_plan_zai_overseas_payment_required"`（Z.ai 海外支付限制）。

## 10. 源码核验与额度重置机会族（2026-09-28，S 级）

来源：官方开源仓 `packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts`（1,595 行）——本文档 §1/§3 的客户端逻辑全部可源码对拍。

**① 源码确认的原有结论**：balance 端点/信封/`zcodejwttoken` 三凭证键（含 `oauth:{zai,bigmodel}:access_token`）/15s 超时/`entitlement_id` flatMap 解析。

**② 精确化三条**：
1. **balance 单请求设计**：源码注释明示"`billing/current` 已废弃，balance 会同时返回 plans 与 balances；Start Plan 快照只发一次请求"——`billing/current` 判废弃（§ 相关端点表的补注）。
2. **`server_time` 配对语义**：源码注释"balance 的服务端时间与本响应的 `effective_at` 配对，不能用本机时钟覆盖"——且 `server_time` 为**秒**，客户端 ×1000 转 ms。
3. **孤儿桶告警**：`warnOnUnattributedStartPlanBuckets(plans, balances)`——桶无法归属到 plan 时专门告警（§3 额度桶路由的服务端侧印证）；无 plan → `unavailableReason:"no_plan"`，`plans[].status=="expired"`（小写比较）→ `startPlanExpired`。

**③ 新功能族：额度重置机会（`/api/v1/coding-plan/reset`，付费档）**：

| 端点/操作 | schema |
|---|---|
| 状态 | `available_five_hour_resets[]` / `available_week_resets[]`（各含 `expire_at`）+ `latest_{five_hour,week}_reset_history{used_at}` + `has_unread_history` |
| 使用 | `{used: true}` |
| 机会下发 | `{granted: true}` 或 `{granted: false, next_try_at}`（**拒绝时节流**） |

——即 [04](zcode-plan-04-权益解析逻辑.md) 记录的"5 小时/周重置窗口"的**客户端操作面**：窗口内可领取重置机会（granted/denied + next_try_at 节流）、可使用、有已读历史。**Start Plan 免费档未见此族**（路径为 coding-plan 付费域）。

**④ 监控限额端点（2026-09-28 实测，A 级）**：`GET {biz}/api/monitor/usage/quota/limit`——zai 侧与 business login 共用 `api.z.ai` 域（源码注释明示，测试 token 不得发往生产域）。
- **认证要 OAuth access token，不是 zcodejwttoken**（JWT 打它 → 信封 `code:401 token expired or incorrect`；OAuth token → 过认证）；
- **业务语义 = 付费 coding plan 的限额查询**：Start Plan 账号实测 → `{"code":500,"msg":"当前用户不存在coding plan"}`——与 [02](zcode-plan-02-认证与凭证存储.md)"Start Plan 资源包不挂在 API key 名下"同构：监控限额是 coding-plan 域，Start Plan 额度只在 balance。
- bigmodel 家族对称端点 `buildBigModelApiUrl` 同路径。
- **响应形状**（mapper 源码实录）：顶层 `{level, limits[]}`；每项限额 `{type, unit, number, usage, currentValue, remaining, percentage, nextResetTime, usageDetails:[{modelCode, displayName, usage}]}`——**按模型细分的已用量 + 下次重置时间 + 百分比**，`normalizeLimits` 归一化、`pickPrimaryLimit` 选主限额供 UI。
- 对照：Start Plan 的 balance 桶只有 total/used/remaining/available，**无** percentage/nextResetTime/usageDetails——付费档的额度可观测性高一个量级。
- 附带：`subscription/list` 的条目形状也一并还原（`productId/productName/status/inCurrentPeriod/purchaseTime/valid/autoRenew/currentRenewTime/nextRenewTime/billingCycle`）。
