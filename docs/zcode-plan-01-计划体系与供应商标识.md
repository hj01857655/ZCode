# 01 · 计划体系与供应商标识

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 主要证据：`resources/glm/zcode.cjs`（CLI bundle，保留原始函数名）

## 0. 术语与分层

### 0.1 术语表

「余额 / 资源包 / 额度桶 / 订阅」是四件不同的事，不可混用。**服务端错误原文是 `Insufficient balance **or** no resource package`——两个独立的 `or` 分支。**

| 词 | 是什么 | 证据 | 怎么查 |
|---|---|---|---|
| **额度桶**<br>`entitlement` | **量**，账户下每个可计费模型一行：`entitlement_id` / `show_name` / `total_units` / `used_units` / `remaining_units` / `available_units`；`balanceCount` 为其条数 | [04](zcode-plan-04-权益解析逻辑.md)、`GET /api/v1/zcode-plan/billing/balance` | Start Plan 侧可读；本账号 `balanceCount=3`、`remaining=221,711,254` |
| **订阅**<br>`subscription` | **份**，付费档位的有效期凭证，按 planKind 归属 | `GET {biz}/api/biz/subscription/list` | 本账号 individual key 返回 `{"code":200,"data":[]}` → **无订阅** |
| **资源包**<br>resource package | **买**，充值购买的额度包，挂在订阅之下；key 本身不代表已购 | 仅见于服务端错误文案；**尚无接口可枚举** | 只能由 1113 文案间接推断 |
| **余额**<br>balance | **钱**，账户充值余额 | 1113 文案首个分支 | **尚无接口可枚举** |

> 额度桶与订阅均已有可读端点；**「余额」与「资源包」目前只有错误文案这一个信号源**。要区分 1113 的三个分支，需先找到这两者的枚举接口。

### 0.1.1 国内/国际额度接口是否分开（2026-09-27 实测定案）

**问：zai（国际）与 bigmodel（国内）的额度接口是同一套还是分开的？
答：分界线在「凭据 → 网关域」，不在「国内/国际」。Start Plan 额度不分开，付费档额度分开。**

复跑：`tools/probe_region_quota.py`（只读）

| 额度种类 | 端点 | 凭据 | 家族间是否共用 |
|---|---|---|---|
| **Start Plan 额度桶** | `zcode.z.ai/api/v1/zcode-plan/billing/{balance,current}` | `zcodejwttoken` | **共用**——两个家族同一端点、同一认证（见 [03 §3.1](zcode-plan-03-billing-balance-接口与实调.md) 换号实测） |
| **付费档订阅** | `{biz}/api/biz/subscription/list` | `api-key` | **分域**：`api.z.ai`（国际）/ `open.bigmodel.cn`（国内） |
| **MCP 配额** | `{biz}/api/monitor/usage/quota/limit` | `api-key` | **分域**，同上 |
| **余额 / 资源包** | — | — | **两端均无可枚举接口**（§0.1 已记，仅有 1113 文案信号源） |

**三条实测证据：**

1. **付费域上没有 `zcode-plan` 路径** —— `api.z.ai` 与 `open.bigmodel.cn` 打
   `/api/v1/zcode-plan/billing/{balance,current}` 均返回
   `{"code":500,"msg":"404 NOT_FOUND"}`。⇒ Start Plan 额度**只在 `zcode.z.ai` 一处**，
   不存在"国内版 Start Plan 额度接口"。
2. **两域是两套独立部署**（非同一后端多域名）—— 同一路径 `/api/biz/subscription/list`
   同一 api-key：`api.z.ai` → `msg:"Operation successful"`（英文），
   `open.bigmodel.cn` → `msg:"操作成功"`（中文）。⇒ 业务后端是**两套**，
   响应文案本地化不同，故**付费档订阅/配额必须按家族分别查**。
3. **交叉访问双向不通**（复现 §0.2 的结论）：
   `zcodejwttoken` → `api.z.ai` = `{"code":401,"msg":"token expired or incorrect"}`；
   `api-key` → `zcode.z.ai` = HTTP `401`。
   ⇒ 换家族必须**同时**换凭据和换域，没有"一个 key 打天下"。

**对实现的影响：**

- `zcodejwttoken` 在两个家族下都走 `zcode.z.ai`，故 Start Plan 额度查询对**两家族的 JWT 账号通用**。
- **API-key 账号查不到 Start Plan 额度**——`zcode.z.ai` 认它但返 401；
  应改查 `{biz}/api/biz/subscription/list`（付费订阅），
  且**按家族选域**：`provider == "bigmodel"` → `open.bigmodel.cn`，否则 `api.z.ai`。
- 付费档的余额/资源包**没有查询接口**——apiKey 账号的耗尽判定只能靠请求失败信号
  （402 与错误体关键字 `quota/insufficient/余额`）。这不是实现缺陷，是上游接口缺失。

### 0.2 通道是怎么分的：三层闸

**不是"付费/免费"一条线，而是三个独立开关，逐层收窄：**

```
① 账号家族 family      zai(z.ai) │ bigmodel(bigmodel.cn)
        ↓
② 计划档位 planKind    start-plan │ individual-coding-plan │ team-coding-plan │ off-peak
        ↓
③ 凭据类型             zcodejwttoken(JWT) │ api-key({id}.{secret}) │ oauth:access_token
        ↓
   能打到哪个域 → 该端点要不要签名 → 有没有额度
```

**6 个 providerId = 2 家族 × 3 档位**（off-peak 每家族单独命名）：

```
account:zai-individual-coding-plan      account:bigmodel-individual-coding-plan
account:zai-team-coding-plan            account:bigmodel-team-coding-plan
account:zai-start-plan                  account:bigmodel-start-plan
account:zai-offpeak-idle-plan           account:bigmodel-offpeak-idle-plan
```

**分界线是"凭据 → 网关域"，不是套餐。** 实测两向互打均为 `401`——不是权限不足，是路由不通：

| | Start Plan | individual / team |
|---|---|---|
| 凭据 | `zcodejwttoken` | `{apiKeyId}.{apiKeySecret}` |
| 网关域 | `zcode.z.ai` | `api.z.ai` / `open.bigmodel.cn` |
| 模型路径 | `/api/v1/zcode-plan/anthropic/v1/messages` | `/api/anthropic/v1/messages`<br>`/api/paas/v4/chat/completions` |
| V4 签名 | **不签**（在 `UNSIGNED_PATHS` 内） | **要签** |
| 额度来源 | 领取，按天发 | 订阅 + 资源包 |
| 交叉访问 | JWT → `api.z.ai` = **401** | api-key → `zcode.z.ai` = **401** |

**两个推论：**

1. **充值不解决签名问题。** 有了额度，JWT 依然打不到 `api.z.ai`——要动付费通道得**换凭据 + 换域**。
2. **同一域内部还要再分。** `api.z.ai` 上模型端点要签名，账户端点不要；逐端点的凭据类型见 [02 §5.1](zcode-plan-02-认证与凭证存储.md)。

**三条必须记住的区分：**

1. **凭据 ≠ 权益。** api key 形态正确、握手 200、`/models` 200，都**不证明**有订阅或余额。
2. **资源包不挂 api key 名下。** individual/team 的 key 与 Start Plan 的包互不可见。
3. **权益判定是先付费、后回退。** `KKi` 先读 `codingPlanEntitlement`，付费无计划才读 `startPlanEntitlement`（[04 §3](zcode-plan-04-权益解析逻辑.md)）。

## 1. 账号家族（family）

```js
wXe = [
  { id: "zai",      label: "Z.ai",     rootDomain: "z.ai",
    oauthProviderId: "zai", startPlanProviderId: rm.zaiStartPlan, ... },
  { id: "bigmodel", label: "BigModel", rootDomain: "bigmodel.cn",
    oauthProviderId: oXe,   startPlanProviderId: rm.bigmodelStartPlan, ... }
]
```

设置项 `providerFamilyDomain`（"zai" | "bigmodel"）记录当前激活家族，本机实测为 `"zai"`。

## 2. 计划档位（planKind）

```js
Hji = m.enum(["start-plan", "individual-coding-plan", "team-coding-plan", "off-peak"])
```

| planKind | 含义 | 获取方式 | 计费 |
|---|---|---|---|
| `start-plan` | 免费体验计划 | 手动领取（claim） | 免费，按天发放 |
| `individual-coding-plan` | 个人版订阅 | 付费 | 订阅制 |
| `team-coding-plan` | 团队版订阅 | 付费（绑定组织/项目） | 订阅制 |
| `off-peak` | 空闲算力 | 复用已连付费档位 | 不消耗套餐配额（详见 [06](zcode-plan-06-off-peak档位.md)） |

## 3. 供应商标识（providerId）

```js
rm = {
  zaiIndividualCodingPlan:      "account:zai-individual-coding-plan",
  zaiTeamCodingPlan:            "account:zai-team-coding-plan",
  zaiStartPlan:                 "account:zai-start-plan",
  bigmodelIndividualCodingPlan: "account:bigmodel-individual-coding-plan",
  bigmodelTeamCodingPlan:       "account:bigmodel-team-coding-plan",
  bigmodelStartPlan:            "account:bigmodel-start-plan",
}
// off-peak 独立命名（fXe / resolveOffPeakProviderId）:
fXe = { zai: "account:zai-offpeak-idle-plan", bigmodel: "account:bigmodel-offpeak-idle-plan" }
```

内置别名映射（switch 语句实测）：

| builtin | → account 形式 |
|---|---|
| `builtin:zai` | zai-api 模板（API key 直连） |
| `builtin:bigmodel` | bigmodel-api 模板 |
| `builtin:zai-start-plan` | `account:zai-start-plan` |
| `builtin:bigmodel-start-plan` | `account:bigmodel-start-plan` |
| `builtin:zai-coding-plan`（旧名） | `account:zai-individual-coding-plan` |
| `builtin:bigmodel-coding-plan`（旧名） | `account:bigmodel-individual-coding-plan` |

合法性正则：

```
^(?:builtin:(?:zai|bigmodel)(?:-start-plan|-coding-plan)?
  |account:(?:zai|bigmodel)-(?:start-plan|individual-coding-plan|team-coding-plan))$
```

判别函数（原始名均保留）：

| 函数 | 判定 |
|---|---|
| `atr(e)` | zai 家族 coding plan（individual/team/start） |
| `aji(e)` | bigmodel start-plan |
| `zqt(e)` | 任一家族 start-plan |
| `cji(e)` / `lji(e)` | individual / 全体 coding plan |

## 4. 账号数据模型（Zod schema 片段）

```js
// 计划 kind 判别联合
SVt = m.discriminatedUnion("kind", [
  m.object({ kind: m.literal("start-plan") }).strict(),
  m.object({ kind: m.literal("individual-coding-plan") }).strict(),
  m.object({ kind: m.literal("team-coding-plan") }).strict(), ...
])

// zhipu 账号 + 计划档位（配置静态形态）
m.object({ type: m.literal("zhipu-account"),
           family: m.enum(["zai", "bigmodel"]),
           planKind: m.literal("start-plan") }).strict()
// individual / team 同构，team 多 productId/organizationId/projectId

// 运行时账号状态（动态下发形态）
m.object({ type: m.literal("zhipu-account"),
           accountType: m.enum(["zai", "bigmodel"]),
           mode: m.enum(["start-plan", "individual-coding-plan",
                         "team-coding-plan", "off-peak"]),
           entitled: m.boolean() }).strict()

// 家族连接选择枚举
aAe = m.enum(["standard-personal", "zai-family", "bigmodel-family"])
```

## 5. 供应商可用性判定（host 侧）

关键函数（均出自 host bundle，`i()` 标注原始名）：

- `Bj` = `validateFamilyAccountProviders` — 对某家族的 start/individual/team 三个 provider 逐一校验，产出 `{availability, entitled, unavailableReason, current, connectionKey, models?, effectiveAt?}`。
- `Uj` = `validateStartPlanAvailability`：
  1. `dfe` = `resolveStartPlanAuthorization` 取 Bearer：
     - bigmodel：`uj` = `resolveBigModelStartPlanZcodeJwt`（要求 `oauth:active_provider === "bigmodel"` 且存在 `zcodejwttoken`，否则回退 provider.apiKey）
     - zai：`ufe` = `loadZaiProviderConnectionZcodeJwtToken`（直接读 `zcodejwttoken`）或 provider.apiKey
  2. 调 balance 接口（见 [03](zcode-plan-03-billing-balance-接口与实调.md)）
  3. `lfe` = `resolveStartPlanBalanceAvailability` 判定：
     - 信封失败 → `coding_plan_auth_failed`
     - 无 active start plan → `coding_plan_not_entitled`
     - 有 plan 但所有 entitlement 的 `effective_at`/`starts_at` 均晚于 server_time → `{kind: "pending", effectiveAt: min(...)}`（未生效，倒计时态）
     - 否则 `{kind: "available", models: [...]}`
- `ofe` = `validateCodingPlanProviderAvailability`：individual 走 `GET /api/biz/subscription/list`（`Oj`/`By` 链路）；team 走 `ife` = `validateSelectedTeamPlanAvailability`（`GET /api/biz/customer/getCustomerInfo` 校验组织/项目，再验订阅）。
- `Ky` = `classifyAvailabilityError`：HTTP 401/403 → `coding_plan_auth_failed`。

unavailableReason → UI 状态映射（`hfe`）：

| 服务端 reason | UI 状态 |
|---|---|
| `coding_plan_not_authenticated` | `not-authenticated` |
| `coding_plan_not_connected` | `not-connected` |
| `coding_plan_auth_failed` | `credential-failed` |
| `coding_plan_not_entitled` | `not-entitled` |

## 6. connectionKey（连接指纹）

`Wj` = `createAccountProviderConnectionResolver` 中计算：

```
connectionKey = sha256(JSON.stringify([
  identity,          // loadAccountIdentity(family) 的账号标识
  accountType,       // "zai" | "bigmodel"
  mode === "start-plan" ? { kind: "start-plan" } : selections[accountType]
]).digest("hex")
```

同一账号 + 同一家族 + start-plan 恒定；individual/team 则随选择（组织/项目/产品）变化。身份在查询期间发生变化会抛错："账号查询期间连接或身份发生变化，丢弃过期结果"。

## 7. 运行时账号配置下发样例（本机日志实录，2026-09-26 05:11）

```json
{"providerId":"account:zai-individual-coding-plan","config":{"access":{"type":"zhipu-account","entitled":false}}},
{"providerId":"account:zai-start-plan","config":{"access":{"type":"zhipu-account","entitled":false}}},
{"providerId":"account:bigmodel-start-plan","config":{"access":{"type":"zhipu-account","entitled":true},
 "builtinModelIds":["GLM-5.3","GLM-5.3-Flash"]}},
{"providerId":"account:zai-offpeak-idle-plan","config":{"access":{"type":"zhipu-account","entitled":false}}},
{"providerId":"account:bigmodel-offpeak-idle-plan","config":{"access":{"type":"zhipu-account","entitled":false}}}
```

> 注：该时刻 `account:bigmodel-start-plan` 为 `available/current:true`；当前会话实际运行在 `account:zai-start-plan`——账号状态在会话间可切换，两份快照均为真实状态。

**通道拓扑（runtime `providerRules`，PoC 实测验证）**——各账号 provider 的 `api.baseUrl` 不同：

| providerId | baseUrl | 模型白名单 |
|---|---|---|
| `account:zai/bigmodel-start-plan` | `https://zcode.z.ai/api/v1/zcode-plan/anthropic` | GLM-5.3-Flash, GLM-5.2, GLM-5-Turbo |
| `account:zai-individual/team-coding-plan` | `https://api.z.ai/api/anthropic` | GLM-5.3, GLM-5.3-Flash |
| `account:bigmodel-individual/team-coding-plan` | `https://open.bigmodel.cn/api/anthropic` | GLM-5.3, GLM-5.3-Flash |
| `account:zai/bigmodel-offpeak-idle-plan` | `https://zcode.z.ai/api/v1/off-peak/anthropic`（hidden） | GLM-5.3, GLM-5.3-Flash |

凭证分配（`AccountProviderRequestAuthService.resolveCurrent`，host）：start-plan → `zcodejwttoken`；individual → 该账号 API key；team → 运行时投影的项目 key（`{id}.{secret}`）。

## 8. 模型请求通道的档位差异

`cRs({access, baseURL})` 决定是否走 V4 请求签名：

```js
if (access.type === "zhipu-account" &&
    (access.mode === "start-plan" || access.mode === "off-peak")) return false;   // 不签名
if (access.type === "zhipu-coding-plan-api-key" ||
    (access.type === "zhipu-account" &&
     (access.mode === "individual-coding-plan" || access.mode === "team-coding-plan")))
  return true;                                                                    // 启用签名
```

即：**免费/空闲通道（start-plan、off-peak）不做 V4 签名；付费与 API-key 通道强制启用（受 feature gate 控制）**。协议详见 [05](zcode-plan-05-V4请求签名协议.md)。
