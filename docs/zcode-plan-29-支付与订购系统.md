# 29 · 支付与订购系统

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：app.asar host 侧 `createCodingPlanSubscriptionService` 支付方法簇（实现全在 host，CLI 无支付代码）

## 0. 三套支付通道

| 通道 | 家族 | 支付方式 |
|---|---|---|
| 国内聚合签约 | bigmodel（`open.bigmodel.cn/api/pay/*`） | **支付宝代扣签约**（payType: "ALI"）；zai 国际调用直接抛 `coding_plan_zai_overseas_payment_required` |
| 国际卡/钱包 | zai（zaiPay 专用 host） | **Stripe**（绑卡/扣款）+ **PayPal**（订阅） |
| 企业批量 | bigmodel | 企业订单四件套 + 余额查询 |

## 1. 标准购买流（按量/套餐，两家族通用）

```
GET  {biz}/api/biz/product/info?productId=…            # 商品信息
POST {biz}/api/biz                                     # 下单预览：{productId, invitationCode,
                                                       #   imRef, ticket, randstr, salesChannel:"zcode"}
POST {biz}/api/pay/create-sign                          # 聚合签约（仅国内）：{bizId, payType:"ALI",
                                                       #   invitationCode, renew, isDelay, effectiveTime}
POST {biz}/api/pay/product/update/sign                  # 更新签约
GET  {biz}/api/biz/pay/check?bizId=…                    # 支付结果查询
GET  {biz}/api/biz/pay/check-pending-orders             # 待支付订单
```

- `invitationCode`（邀请码）贯穿所有下单/支付方法；`salesChannel` 固定 `"zcode"`（渠道归因）。
- `ticket` + `randstr` 是**腾讯云防水墙（TCaptcha）**验证码字段——下单预览也带人机验证（与阿里云验证码并存，见 [12](zcode-plan-12-阿里云验证码体系.md)）。
- `createSign/updateSign` 对 zai 家族硬拒绝（海外支付限制常量 `o_`）。

## 2. Stripe（zai 国际，专用 zaiPay host）

```
GET  {zaiPay}/stripe/query            # 查卡
POST {zaiPay}/stripe/bind            # 绑卡 {paymentMethodId, returnUrl, trackingContext}
POST {zaiPay}/stripe/unbind          # 解绑
POST {zaiPay}/stripe/pay             # 支付 {productId, paymentMethodId, isSubscribe(默认true),
                                     #   returnUrl, channelCode, estimatePayAmount,
                                     #   invitationCode, bizId, renew}
GET  {zaiPay}/paypal/isSupport       # PayPal 可用性
POST {zaiPay}/paypal/setupToken      # {returnUrl, cancelUrl} → setupTokenId
POST {zaiPay}/paypal/subscribe       # {productId, productDesc, setupTokenId, amount,
                                     #   isSubscribe, estimatePayAmount, invitationCode, bizId, channelCode}
```

## 3. 企业批量（bigmodel host）

```
GET  /api/biz/subscription/enterprise/v2/pricing            # 定价（zai 侧匿名变体:
                                                            #  /api/biz/campaign/partner/enterprise/pricing）
GET  /api/biz/subscription/enterprise/v2/balance            # 企业余额
POST /api/biz/subscription/enterprise/v2/order/calculate    # 计价
POST /api/biz/subscription/enterprise/v2/order              # 下单
GET  /api/biz/subscription/enterprise/v2/orders/pending     # 待处理
POST /api/biz/subscription/enterprise/v2/order/{orderNo}/cancel
POST …/continueEnterpriseOrderPayment                       # 续付
```

企业定价响应带 `enrichEnterprisePricingTeamProjects`（团队项目 enrich）。

## 4. 折扣与配置

- `getBillingDiscount` ← client config `configs.codingPlanBillingDiscount`（远端下发折扣）。
- `getStaticProducts / getStaticTeamProducts` ← `configs.codingPlanStaticProducts / …TeamProducts`（静态商品目录，与 CDN 目录双源）。
