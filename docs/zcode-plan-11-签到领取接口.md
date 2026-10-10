# 11 · 计划领取（签到）接口：billing/preview + billing/claim

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 证据：host 侧 `createCodingPlanSubscriptionService`（RPC 通道 `coding-plan-subscription`）+ 实测
> **实现位置（2026-09-28 补）**：官方实现在 **`app.asar` → `out/host/index.js`** 的
> `getManualClaimPlanPreviews` / `claimManualPlan`，**不在 `resources/glm/zcode.cjs` 里**
> ——CLI bundle 与桌面端是两个 bundle，这两个函数名在 `zcode.cjs` 中 0 命中。
> 提取：`node _re/asar_pick.js get out/host/index.js <输出>`，再 `ZCODE_CJS=<输出> node _re/grab.js <符号>`。
> 关联：balance 见 [03](zcode-plan-03-billing-balance-接口与实调.md)，验证码体系见 [08 §1.2](zcode-plan-08-聊天对话接口.md)

## 0. 结论

ZCode 的"签到式"计划领取（如 **ZCode Weekend Build**，3 亿 tokens，周期性领取）由两个接口构成：

```
GET  https://zcode.z.ai/api/v1/zcode-plan/billing/preview   → 当前可领取的计划列表（只读）
POST https://zcode.z.ai/api/v1/zcode-plan/billing/claim     → 领取（需阿里云验证码）
```

**是否需要「领取」看 entitlement 的 `period`**：`daily`（Start Plan）服务端按天自动发，不用领；
`one_time`（Weekend Build / Global Build）发一次即止，过期需重新 claim。详见 §5。

每日重置的 **ZCode Start Plan**（`zcode-v3-start-plan-0817`）不走领取——配额由服务端按天自动发放到 balance 桶。

> ⚠️ **领取历史查不到**。`zcode-plan/billing` 只有 `balance` 与 `current` 两个端点，无 history/records/list，
> 且二者都只返回 `status:"active"` 的实例。详见 §5.3。

## 1. billing/preview（可领取预览，GET）

```
GET https://zcode.z.ai/api/v1/zcode-plan/billing/preview?app_version=<ver>&platform=<platform-key>
Authorization: Bearer <zcodejwttoken>
```

- `platform` = `resolveClientPlatformKey()` = `${process.platform}-${process.arch}`（如 `win32-x64`）。
- 实现：`getManualClaimPlanPreviews`（host，`Ki` = `readCodingPlanApiJson` 信封包装）。

响应：

```jsonc
{
  "code": 0, "msg": "",
  "data": {
    "server_time": 1790401882,
    "plans": [                       // 当前可领取的套餐；空 = 暂无可领（实测已领取后为 []）
      { "plan_id": "...", "name": "...", "description": "...", "priority": 0,
        "entitlements": [ { "entitlement_id", "show_name", "meter", "unit_type",
                            "capabilities", "grant_units", "period", "priority", "effective_at" } ] }
    ]
  }
}
```

**实测（2026-09-26 13:51 CST）**：`{"code":0,"data":{"server_time":1790401882,"plans":[]}}`——已领取、窗口未开。

## 2. billing/claim（领取，POST）

```
POST https://zcode.z.ai/api/v1/zcode-plan/billing/claim
Authorization: Bearer <zcodejwttoken>
Content-Type: application/json
X-Aliyun-Captcha-Verify-Param: <captchaVerifyParam>    ← 必带（与模型请求同一套验证码体系）
X-Aliyun-Captcha-Verify-Region: <region>               # 可选（如 "cn"）
X-ZCode-App-Version: <ver>
X-Platform: <platform-key>

Body: {"plan_id": "<planId>"}
```

响应（`claimManualPlan` 解析）：

```jsonc
// 成功
{ "code": 0, "msg": "", "data": { "server_time": <sec>,
    "plan": { "user_plan_id": "upl_…", "plan_id": "…", "status": "active",
              "starts_at": <sec>, "ends_at": <sec>,
              "entitlements": [{ "entitlement_id", "show_name", "effective_at" }] } } }

// 失败
{ "code": <非0>, "msg"/"data.message": "…",
  "data": { "plan": { "ends_at": <sec> }?, "server_time": <sec> } }
```

客户端归一化结果：`{success, code, message, serverTime?, plan?}`，失败时若响应带 `data.plan.ends_at` 则暴露为 `failureEndsAt`（下次可领时间/当前周期截止，供 UI 倒计时——对应 i18n `manualClaimPlan.claim.startUsingUnavailable` 等文案）。

**本地前置**：无 `zcodejwttoken` 直接返回 `{success:false, code:401}`，不发请求。

### 2.1 成功判定（官方源码，2026-09-28 补）

`out/host/index.js` 的 `claimManualPlan` 原文：

```js
if (s !== 0 || !r.data?.plan) {          // ← code 必须为 0 **且** data.plan 必须存在
  return { success: false, code: s, message: r.data?.message ?? "", failureEndsAt: … }
}
```

**只看 `code == 0` 会误报成功**：`code=0` 但没返回 `plan` 时，UI 会显示"领取成功"而 `plan` 全为空，实际什么都没发生。本项目已按此对齐，并把该情形单列为可区分的失败原因。

### 2.2 请求头（官方）

`claim` 只发 5 个头（`Authorization` / `Content-Type` / `X-Aliyun-Captcha-Verify-Param` / `X-Aliyun-Captcha-Verify-Region?` / `X-ZCode-App-Version` / `X-Platform`），
`preview` **只发 `Authorization` 一个**。本项目统一沿用 billing 族的全套身份头——实测能通，且与 `balance` 保持一致。

## 3. 验证码从哪来

完整机制（配置、SDK 接入、param 生命周期、单次有效性）见 **[12-阿里云验证码体系](zcode-plan-12-阿里云验证码体系.md)**。摘要：

- `getCaptchaConfig`（RPC）读取远端 client config：`GET /api/v1/client/configs → data.configs.captcha`，实测值 `{"enabled":true,"prefix":"no8xfe","region":"cn","sceneId":"11xygtvd"}`。
- UI 据此渲染阿里云验证码 → 通过后拿到 `captchaVerifyParam` → 随 claim（以及 start-plan 模型请求）一起提交。
- 服务端错误码谱系中的 `coding_plan_security_verification_required` 即"需要过验证码"信号。

## 4. UI/RPC 调用链

```
横幅 manual-claim-plan-banner（claim 前置状态: used / granted:true / granted:false+next_try_at）
  → coding-plan-subscription.getManualClaimPlanPreviews()   # 领取按钮渲染
  → 用户点击「开始体验」→ 弹验证码（configs.captcha）
  → coding-plan-subscription.claimManualPlan({planId, captchaVerifyParam, captchaRegion})
  → 成功: 「{plan} 领取成功 / Start Plan 已可使用」→ 刷新 balance/供应商可用性
```

同通道的相关方法：`getStartPlanPreview`（client config 内置预览，`unwrapClientConfigStartPlanPreview` 校验 `{planId, name, entitlements[{grantUnits, meter, period, showName, unitType}]}`）、`getOffPeakClientConfig`、`getForceUpdateConfig` 等。

## 5. 计划实例生命周期（实测数据串讲）

| 阶段 | 证据 |
|---|---|
| 领取 | `POST billing/claim` → 生成 `user_plan_id (upl_*)`，`starts_at` = 领取时刻 |
| 生效 | balance 出现对应 plan + 额度桶（如 `zcode-v3-start-plan-0924-wk-2`：GLM-5.3-Flash × 300,000,000，`period_end` ≈ 领取后 ~2 天） |
| 消耗 | 模型请求按桶优先级扣减；日桶耗尽自动落到周桶（实测 5M 日桶 → 0 后，周桶 300M 开始消耗） |
| 过期 | `ends_at` < server_time → `normalizeStartPlanExpiry` 把 plan 改写 `expired`、孤儿桶剔除；UI 显示 "Start Plan expired"（实测 `zcode-v3-start-plan-0925` Global Build 一夜之间消失） |
| 下轮 | `billing/preview` 重新出现该计划 → 再领取，plan_id 日期后缀/`-wk-N` 递增 |

**UI 名称 ↔ API 实测对照**（本机观察）：

| UI 卡片 | API plan_id | 量级 | period | 要领? |
|---|---|---|---|---|
| ZCode Start Plan（每日重置） | `zcode-v3-start-plan-0817` | GLM-5.3 × 3,000,000/天 + GLM-5.3-Flash × 5,000,000/天 | `daily` | ❌ 服务端按天自动发 |
| ZCode Weekend Build（周期领取） | `zcode-v3-start-plan-0924-wk-2` | GLM-5.3-Flash × 300,000,000 | `one_time` | ✅ |
| ZCode Global Build（活动加餐） | `zcode-v3-start-plan-0927` | GLM-5.3-Flash × 100,000,000 | `one_time` | ✅ |

> **`period` 是「要不要领」的唯一判据**（2026-09-28 实测）：`daily` 由服务端按天重置、必然已发放；`one_time` 发一次即止，过期需重新 claim。
> 这同时**填上了此前「Global Build 是否 claim 型」的空白**——它与 Weekend Build 同为 `one_time`，故同属 claim 型。原表把它记为「每日自动发放的夜间加餐，无需领取」，与实测的 `period` 冲突。

### 5.1 有效窗口实测（修正 23:00 说法）

同批 `one_time` 套餐，`starts_at` 各不相同而 `ends_at` 完全一致：

| plan_id | starts_at（本地） | ends_at（本地） | 实际时长 |
|---|---|---|---|
| `…-0927` | 09-27 **14:03** | 09-28 **09:00:00** | 18.9 小时 |
| `…-0924-wk-2` | 09-27 **02:11** | 09-28 **09:00:00** | 30.8 小时 |
| `…-0817`（daily） | 09-27 02:11 | 10-01 **23:59:59** | 117.8 小时 |

**结论：起点是领取时刻，不是固定 23:00；终点是次日 09:00 整点。** 原表「`effective_at` = 当日 23:00，实际可用窗口 23:00→次日 09:00」**与实测不符**——`…-0927` 的 entitlement 实测 `effective_at = 0`（立即生效），且 `starts_at` 随领取时刻浮动。

#### 两类套餐的窗口机制不同（2026-09-28 实测）

`one_time`（Weekend / Global Build）—— **批次制**：领取时刻横跨，同批一起到期。
`daily`（Start Plan）—— **滚动制**：`ends_at` 跟着 `starts_at` 一起平移，固定跨度 4 天。

`…-0817`（daily）四个实例：

| 账号 | starts_at | ends_at | 跨度 |
|---|---|---|---|
| bigmodel-472566 | 09-26 05:11:10 | 2026-09-30 23:59:59 | 4 天 |
| zai-c1cdacc4 | 09-26 07:11:49 | 2026-09-30 23:59:59 | 4 天 |
| zai-a5de2e3f | 09-27 02:07:10 | 2026-10-01 23:59:59 | 4 天 |
| zai-355c54b9 | 09-27 02:11:42 | 2026-10-01 23:59:59 | 4 天 |

**09-26 领的 → 截止 09-30；09-27 领的 → 截止 10-01，整整推后一天，跨度恒为 4 天。**
故 `daily` 档的「每日更新」表现为窗口滚动，不是按自然日重置。

对比 `…-0924-wk-2` 的 5 个实例（`starts_at` 从 09-26 13:26 跨到 09-27 02:11，共 17 小时）
—— `ends_at` **全部**为 09-28 09:00:00。起点浮动、终点不动，正是批次制的特征。

#### plan_id 与领取时刻不是一一对应

`…-0924-wk-2` 有 **5 个 `user_plan_id`**、`starts_at` 跨 17 小时；`…-0927` 有 2 个（相隔 11 秒）。
即**一次 plan_id 可对应多次领取**，plan_id ≠ 领取时刻。

**但递增/复用规则尚未验证**——已知仅 `0924-wk-2` / `0927` / `0817` 三个 id，
批次如何滚动（新 id？复用？）**无观测数据**。基线快照：`_re/plan_baseline.json`（2026-09-28 采集），
待 `…-0924-wk-2` / `…-0927` 于 09-28 09:00 到期后 diff 即可确认。

### 5.2 `event/report`（资格激活）——非官方流程

`zcode-switch` `claim.rs:130` 有 `POST /api/v1/event/report`（`element_name` = `app_launch` / `app_daily_active`），
其文案称「每号先激活一次活动资格」。**但这不是 ZCode 官方行为**：

- 官方桌面端 `out/host/index.js` 中 `event/report` / `app_launch` / `app_daily_active` **全部 0 命中**；
- 官方 `getManualClaimPlanPreviews` **只发一个 `Authorization` 头**，无任何激活前置。

故「不激活 preview 就一定返回空」**无依据**。本项目保留该调用（实测 HTTP 2xx、无害），但仅作**对照实验**用途；
「`preview` 返回 `plans: []`」的成因（未到窗口 / 已领 / 需激活）**至今未能区分**。

### 5.3 查不到领取历史

官方 `zcode-plan/billing` 只有 `balance` 与 `current` 两个端点，**无 history / records / list**。
且实测（2026-09-28）：

- `current` 是 `balance` 的**严格子集**（独有字段 0 个；`balance` 多 19 个 `balances[]` 额度字段），重叠部分逐字相同——**接 `current` 无增量价值**；
- 两个端点**只返回 `status: "active"` 的计划实例**，已过期的一律查不到。

即「这个号领过什么」只能查到**当前持有 + 各自 `starts_at`**，查不到流水。

> 每日桶当日耗尽后 UI 显示"已用完，明天重置"（`period_start/period_end` 为本地自然日 00:00–23:59:59，Unix 秒实测吻合）。

### 5.4 Start Plan 的额度从哪来（2026-09-28 补）

`client/configs` 的 `data.configs.startPlanPreview` 给出 Start Plan 的**权威额度**：

```json
{ "name": "Start Plan", "planId": "zcode-v3-start-plan",
  "entitlements": [
    { "grantUnits": 3000000,  "meter": "model_usage", "period": "daily",
      "showName": "GLM-5.3",      "unitType": "token" },
    { "grantUnits": 5000000,  "meter": "model_usage", "period": "daily",
      "showName": "GLM-5.3-Flash", "unitType": "token" } ] }
```

**3,000,000 + 5,000,000，`period: daily`——与 `billing/balance` 中 `…-0817` 桶的
`total_units`（3M / 5M）逐项吻合**，交叉印证该字段即为每日额度的下发处。

注意两点：

- `planId` 是 **`zcode-v3-start-plan`，不带日期后缀**，与 balance 里的
  `zcode-v3-start-plan-0817` **不是同一个 id**，两者关系尚未验证；
- 该字段是**平台级常量**（不随账号变化），而 balance 桶是账号实态。
  判断「这个号今天有多少」仍须读 balance，`startPlanPreview` 只用于展示与核对。

> 同一次响应里还有 `data.configs.offPeak`（`{allowed_models, enable_offpeak_task}`），
> 是闲时档的模型白名单——补上了 [06](zcode-plan-06-off-peak档位.md) 的配置侧，
> 但票据体系本身仍未接入。完整响应形状见 [08 §1.8](zcode-plan-08-聊天对话接口.md)。

## 6. 领取请求构成

- **验证码令牌**：服务端可验的阿里云验证码令牌，与账号 JWT 绑定；令牌由 IDE 客户端交互式获取，机制见 [12](zcode-plan-12-阿里云验证码体系.md)。
- **plan_id**：由 preview 下发，客户端只透传（`{"plan_id": t.planId}`），无本地枚举。
