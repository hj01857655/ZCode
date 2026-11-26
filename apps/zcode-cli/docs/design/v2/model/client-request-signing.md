# Client Request Signing

## 状态

本文是 ZCode CLI 默认 AI SDK provider transport 的客户端请求签名契约；只影响 adapter 的
`protectTransport`，不修改 provider 配置、ZCode Protocol、Desktop/Web renderer、WebFetch、MCP、
OAuth、插件下载或 tool 子进程。

## 签名门控

每个模型执行器调用 `ModelRequestSecurityPort.protectTransport`，由
`createModelRequestSecurityState` 决定是否给该 provider 的最终 HTTP transport 套上
`ClientRequestSigningV4Manager`。判定只使用 `providerConfig.access` 与 `baseURL`，顺序固定：

1. `access.type = "zhipu-account"` 且 `mode` 是 `start-plan`、`off-peak` 或 `highspeed`：不签名。
2. `access.type = "zhipu-coding-plan-api-key"`：签名。
3. `access.type = "zhipu-account"` 且 `mode` 是 `individual-coding-plan` 或 `team-coding-plan`：签名。
4. `baseURL` 的 hostname 是 `z.ai`、`bigmodel.cn` 或以 `.z.ai`、`.bigmodel.cn` 结尾：签名。
5. `baseURL` 的 hostname 精确是 `api.chatglm.site` 或 `zcode.chatglm.site`：签名。
6. 其它情况不签名。

根域匹配在第 4 步，兼容 `https://api.z.ai/...`、`https://zcode.z.ai/...`、`https://open.bigmodel.cn/...`；
`chatglm.site` 仅精确匹配历史兜底域名，不扩展到子域。`access` 是套餐身份的唯一来源，provider id
不参与签名门控。签名 fetch 的 `clientVersion` 从 provider headers 的 `X-ZCode-App-Version`
大小写不敏感读取；缺失时使用 client-signing 包自己的默认版本。

## 不签名访问模式

第 1 步的账号访问模式虽然不签名，但 baseURL 属于 `z.ai` / `bigmodel.cn` 根域时仍保留一个
观测 wrapper：它不改变 HTTP 请求，只按请求里的 `x-request-id` 记录一次
`kind = "unsigned_sent"`、`reason = "access_mode"` observation；同 providerId 只写一次 info 日志。
`ModelRequestObservationSource.take(requestId)` 返回并清空该请求观测。第 6 步的第三方 provider
不使用 wrapper，直接透传原 transport。

签名路径的 observer 由 `ClientRequestSigningV4Manager` 写入同一观测 store。观测只进入进程内
telemetry statusSink，不进入 session event 或回放协议；字段不得携带凭据、body 或用户内容。

## 状态与边界

- 单个 CLI 进程共享一个 `ClientRequestSigningV4KeyCache`，跨 execution 复用 keyState/epoch。
- 每个 execution 持有自己的 `RequestObservationStore`，按 `requestId` 归属观测；每个请求 ID 最多
  保留 64 个请求条目。
- 门控命中签名且 `baseURL` 存在但 `apiKey` 为空时，仍走签名 fetch；后续握手与请求错误按
  client-signing 实现处理，不在门控里静默降级。
- `disposed = true` 后 `protectTransport` 只返回原 transport，不再创建签名或观测 wrapper。

## 验收场景

- `zcode.z.ai`、`api.z.ai`、`open.bigmodel.cn` 命中根域签名。
- `api.chatglm.site`、`zcode.chatglm.site` 命中兜底签名。
- `zhipu-coding-plan-api-key` 命中签名。
- `zhipu-account` 的 `individual-coding-plan`、`team-coding-plan` 命中签名。
- `zhipu-account` 的 `start-plan`、`off-peak`、`highspeed` 在智谱根域上只观测不签名。
- 自定义 provider 或第三方域名不签名，也不产生签名观测。
- 观测按 `x-request-id` 可取出一次并在读取后清空。
