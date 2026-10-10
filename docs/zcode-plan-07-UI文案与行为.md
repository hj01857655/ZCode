# 07 · UI 文案与行为（Start Plan 相关）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 证据：`resources/app.asar` 中的 i18n 资源与 testId 常量

## 1. 手动领取（manual claim）

- 横幅 testId：`manual-claim-plan-banner`
- 流程状态机（schema）：`{used: true}` / `{granted: true}` / `{granted: false, next_try_at}`（已领 / 可领 / 冷却至指定时刻）

| key | zh-CN 文案 |
|---|---|
| `manualClaimPlan.claim.success.title` | `{plan} 领取成功` |
| `manualClaimPlan.claim.success.description` | `Start Plan 已可使用。`（带 prefix/suffix 插槽：`You now have access to {plan}`） |
| `manualClaimPlan.claim.failure.generic` | `领取失败，请稍后重试。` |
| `manualClaimPlan.claim.startUsingUnavailable` | `Start Plan 当前还不可用，模型设置未改变，请稍后刷新重试。` |
| `manualClaimPlan.claim.dialog.confirm` | `开始体验` |
| `manualClaimPlan.claim.dialog.modelSettings` | `查看模型设置`（英文 "View model settings"） |

## 2. Start Plan 推荐弹窗（recommendation dialog）

- testId：`start-plan-recommendation-dialog`
- 触发：检测到 Start Plan 对某模型仍有配额，而当前所选模型不在 Start Plan 上。
- 关闭持久化：`setting.json → startPlanRecommendationDismissed`（本机 `false`）。

| key | 文案 |
|---|---|
| `startPlan.recommendation.title` | `Start Plan quota available` |
| `startPlan.recommendation.description` | `Your Start Plan still has quota for {model}. Would you like to switch...?` |
| `startPlan.recommendation.subagentDescription` | `Your Start Plan has quota available for {model}. Switch this subagent's model to the Start Plan?` |
| `startPlan.recommendation.preferenceS...` | 偏好设置相关（"continuing with your choice for this operation."） |

## 3. 设置页 / 侧边栏

| key | 文案 |
|---|---|
| `settings.modelProvider.connectionMode.startPlan` | `Start Plan` |
| `settings.modelProvider.connectionMode.startPlanCount` | `Start Plan × {count}` |
| `settings.modelProvider.connectionMode.switchToStartPlan` | `Switch to Start Plan` |
| `settings.modelProvider.connectionMode.individualCodingPlan` | `Individual Plan` |
| `settings.modelProvider.startPlan.status.loginRequired` | `Log in to view and use your Start Plan` |
| `settings.modelProvider.startPlan.status.expired` | `Start Plan expired` |
| `settings.modelProvider.codingPlan.purchaseBanner.startPlanTitle` | `Start Plan` |
| `settings.modelProvider.codingPlan.purchaseBanner.startPlanDescription` | `Try platform GLM flagship model quota for free` |

testId 体系：`model-provider-start-plan-count-shortcut`、`model-provider-start-plan-switch-prefix`、`model-provider-connection-mode-trigger/item`、`sidebar-coding-plan-usage-button`。

## 4. 状态与文案的对应关系

服务端 `unavailableReason`（host 校验产出，见 [01 §5](zcode-plan-01-计划体系与供应商标识.md)）→ UI 状态：

| reason | UI 状态 | 对应文案 |
|---|---|---|
| `coding_plan_not_authenticated` | `not-authenticated` | loginRequired |
| `coding_plan_not_connected` | `not-connected` | （提示登录/连接） |
| `coding_plan_auth_failed` | `credential-failed` | （凭证失效） |
| `coding_plan_not_entitled` | `not-entitled` | expired / noPlan 分支 |

`expired` 判定来自 balance 响应中 `plans[].status === "expired"`（`normalizeStartPlanExpiry` 归一化后仍存在的过期记录）。

## 5. off-peak 相关 UI（摘录，机制见 [06](zcode-plan-06-off-peak档位.md)）

key 前缀 `offPeak.*`：

- `action.{cancel, continue, continueHint, pause, pauseHint}`
- `badge.{queuePosition, pausedPosition}`
- `create.{defaultTitle, limitReachedAt, remaining.{hours,hoursMinutes,lessThanMinute,minutes}, availabilityUnavailable, codingPlanOnly, codingPlanToast}`
- `boundSession.{label, hint}`、`chatCreated.{defaultTitle, open, queued, queuedAt, boundHint}`
- `cancel.{title, description}`
- testId：`offpeak-create-card`、`offpeak-create-open`

## 6. 其他相关文案

- `settings.modelProvider.*` 下的 purchaseBanner 家族还有 coding plan 购买入口文案（For Teams 等）。
- 错误映射：`bj` = `normalizeRemoteErrorMessage`——把 HTML 错误页（阿里云拦截页 `errors.aliyun.com`）、`request has been blocked`、安全验证提示（"请完成安全验证" / `/security verification/i`）归一化为友好错误。
- 强制升级：client config `data.configs.forceUpdate.minimalVersion`（`unwrapClientConfigForceUpdate`），Start Plan 预览配置同样经 `unwrapClientConfigStartPlanPreview` 校验 `{planId, name, entitlements[]}`。
