# 活动展示控制器契约

`createMarketingTouchController` 是同步工厂。每个控制器独占其 banner/dialog、generation、待展示资源与动作状态。查询、准备、上报、执行和刷新由调用方注入；UI 观察同一个 store，不另存已确认活动列表。

```text
用户动作 / 自动领取 → 关闭当前展示并作废旧查询 → 执行动作 → 异步上报 confirm
                                                            └─ 领取成功 → 刷新资格
```

自动领取是第二条进入动作路径的入口：`refresh()` 拿到含 `claim_zcode_plan` 的投递后，若 `canAutoClaim()`（登录态）为真则直接执行该动作，每个 `scope + 资源位 + campaign_id` 只尝试一次。验证码走 4.0.0 发行版接口（`getInstance / success / fail / onError` + `startTracelessVerification`）：无痕由 SDK 直接回调参数，命中风控时 SDK 升级为交互弹窗交给用户，控制器与 UI 都不伪造验证结果；失败/中止后保留投放，等用户手动重试。

外链、导航和复制不改变资格，不立即刷新，避免异步 confirm 前重新查询并打开旧活动。以后服务端再次投放仍可展示。dispose 作废未完成查询并释放资源，旧回执不得重新打开弹窗。

现行 E2E 入口为 `packages/desktop/test/e2e/ui-shell/marketing/marketing-touch-delivery.test.ts`。原 App 单测已退役，其控制器竞态断言不再计入覆盖。本次登记保留原入口和依赖方向。
