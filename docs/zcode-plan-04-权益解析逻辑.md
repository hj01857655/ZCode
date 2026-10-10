# 04 · 权益解析逻辑（Entitlement）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 核心函数：`KKi` = `resolvePlanIdentitySnapshot`、`Odr` = `resolvePlanEntitlementState`（zcode.cjs，逻辑完整保留）

## 1. 快照结构

```js
// lXe = createPlanIdentitySnapshot
{ generatedAt: number, planStatus: string, planProductId: string }
// planStatus ∈ "coding_plan" | "start_plan" | "no_plan" | "unknown"
```

输入是两份权益快照（UI/host 侧产出，随 RPC 传递）：

```js
{
  authenticated: boolean,
  unavailableReason: "unavailable" | "not_authenticated" | "not_configured" | "no_plan",
  quota:    { level, limits[] } | null,
  subscription: { identityType, identityMasked, details[] } | null,
  remaining: { count, isShow, percentage?, nextResetTime? } | null,
  generatedAt: number,
  startPlanExpired?: boolean,   // no_plan 时附带：是否曾有已过期的 start plan
  provider?: { id, name }, context?: { scope: "personal" }, serverTime?
}
```

`planProductId` 取自 `subscription.details[0].productId`（即 balance 响应里的 `plan_id`）。

## 2. resolvePlanEntitlementState（`Odr`）— 单快照判定

```js
function Odr({snapshot, now, entitlementCacheTtlMs}) {
  if (!snapshot) return {kind: "unknown"};
  if (now - snapshot.generatedAt > entitlementCacheTtlMs) return {kind: "unknown"};  // 过期
  if (!snapshot.authenticated || snapshot.unavailableReason === "unavailable")
    return {kind: "unknown"};
  if (snapshot.unavailableReason === "not_authenticated" ||
      snapshot.unavailableReason === "not_configured") return {kind: "unknown"};
  if (snapshot.unavailableReason === "no_plan") return {kind: "none"};
  if (snapshot.quota || snapshot.subscription || snapshot.remaining)
    return {kind: "active", generatedAt, planProductId};
  return {kind: "unknown"};
}
```

> **TTL 数值（已确认）**：`entitlementCacheTtlMs` 的注入值 `iUe = 600 * 1e3` = **10 分钟**。同模块还揭示渲染层持久化：快照缓存在 `window.localStorage`，键前缀 `rUe = "zcode:usage-entitlement:subscription-v2:"`，完整键为 `<prefix><providerId>:<providerFingerprint>`（`dE` 构造），即按供应商 + 账号指纹分键的 10 分钟本地缓存。

## 3. resolvePlanIdentitySnapshot（`KKi`）— 双快照优先级

```js
function KKi({now, providerFamilyDomain, codingPlanEntitlement,
              startPlanEntitlement, entitlementCacheTtlMs}) {
  if (!providerFamilyDomain) return create(now, "unknown", "");
  const n = Odr({snapshot: codingPlanEntitlement, ...});     // 先看付费档位
  if (n.kind === "active") return create(n.generatedAt, "coding_plan", n.planProductId);
  if (n.kind !== "none")   return create(now, "unknown", "");
  const o = Odr({snapshot: startPlanEntitlement, ...});      // 付费无计划时再看 start plan
  if (o.kind === "active") return create(o.generatedAt, "start_plan", o.planProductId);
  if (o.kind === "none")   return create(now, "no_plan", "");
  return create(now, "unknown", "");
}
```

**语义**：付费 coding plan 处于 active 时完全遮蔽 Start Plan；付费"确定无计划"（`none`）时才落到 Start Plan；其余情况 `unknown`。UI 的用量面板据此决定显示哪套数据、侧边栏按钮显示哪个计划的用量。

## 4. 快照的生产端（host，`getStartPlanSnapshot`）

`BigModelUsageQuotaProvider.getStartPlanSnapshot(providerId, accountAccess, invalidateBalanceCache)`：

1. `resolveStartPlanAuthorization`（`accountAccess.planKind !== "start-plan"` → null → `unavailableReason: "not_configured"`）；
2. 调 `$y`（balance 接口，见 [03](zcode-plan-03-billing-balance-接口与实调.md)），日志事件 `usage-stats`；
3. 组装快照：
   - 有效套餐：`{authenticated: true, provider, remaining: Gme(balances), subscription: Kme(plans), quota: Vme(balances, plans), serverTime?}`；
   - 无套餐：`{unavailableReason: "no_plan", startPlanExpired: plans.some(status==="expired")}`；
   - `server_time`（秒）× 1000 透传为 `serverTime`。

MCP 配额快照 `dK` = `fetchMcpQuotaSnapshot` 同族：响应含 `total_usage`、`level`、`next_refresh_at`、`server_time`。

## 5. 付费档位的用量/重置窗口（bigmodel）

`Dme` schema 揭示的重置模型：

```js
{
  available_five_hour_resets: [{expire_at}],   // 5 小时窗口批次
  available_week_resets:      [{expire_at}],   // 周窗口批次
  latest_five_hour_reset_history: {used_at} | null,
  latest_week_reset_history:      {used_at} | null,
  has_unread_history: boolean
}
```

辅助 schema：`Nme={used:true}`（已用）、`Lme={granted:true}`（已发放）、`Fme={granted:false, next_try_at}`（领取冷却）——对应 claim/领取状态机。

## 6. 请求级账号访问（Agent 侧）

`Rp`（host）解析每次模型请求的 `accountAccess`：

- `providerFamilyDomain !== access.accountType` → null；
- `mode === "start-plan"` → 账号身份存在即 `{type:"zhipu-account", family, planKind:"start-plan"}`；
- `mode === "off-peak"` → 借用所选 individual/team 的 `{productId, organizationId, projectId}`；
- 其余要求 `selections[accountType].kind === mode`。

配合 `qqt`/`lee`（zcode.cjs）把 builtin GLM 模型 id（`OfficialGlmModelId`）在 plan 通道上做规范化映射。

## 7. 本地用量记录（交叉验证源）

`~/.zcode/cli/db/db.sqlite`：

- `model_usage`：逐请求记录 `provider_id, model_id, permission_mode, agent_type, status, input/output/reasoning/cache tokens, finish_reason, duration` 等（本次会话多条 `account:zai-start-plan + GLM-5.3-Flash`）。
- `turn_usage`：按轮次聚合（含 TTFT、模型请求数、工具调用数、错误码）。
- 用量查询 SQL 直接对 JSON 字段过滤：`$.modelSelection.providerId IN ('account:zai-start-plan', ...)`（六种 plan providerId 枚举）。
