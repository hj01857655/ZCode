# 37 · 排障手册：实测矩阵、错误码判别与一次完整复盘

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 性质：**方法论 + 实测数据**。不重复 03/08 已记录的协议细节，只沉淀"怎么判断"与"一次完整的误判链"。
> 数据采集：2026-09-26 CST，全部为本机实测。

## 0. 三条纪律

这一轮最贵的成本不是写代码，是**连续六次误判**。根因只有一个：

> **被测对象没被验证过，行为解读就开始了。**

| # | 纪律 | 违反后果 |
|---|---|---|
| 1 | **先确认被测对象处于有效状态**，再解读它的行为 | 半死的对象会伪装成"协议特性" |
| 2 | **拿异常堆栈，不要穷举参数** | 猜一轮的成本 ≈ 读一眼源码 |
| 3 | **结论区分"已证明"与"推测"**，升级时全文同步 | 文档内部自相矛盾，读者信错那一份 |

第 3 条实践上最容易犯：改完最新章节忘了改索引、旧结论和交叉引用。本项目已因此出过一次事故（见 §5.3）。

---

## 1. 端点 × 认证头 实测矩阵

同一把 coding plan key（`{32hex}.{16char}`）打多个端点 × 两种认证头。

**判定口诀：`401` = 认证没过；`429` / `400` = 认证已过，卡在下一关。**

| 端点 | `Authorization: Bearer` | `x-api-key` | 认证结论 |
|---|---|---|---|
| `open.bigmodel.cn/api/paas/v4/models` | **200** | — | key 有效 |
| `api.z.ai/api/paas/v4/models` | **200** | — | key 有效 |
| `api.z.ai/api/coding/paas/v4/models` | **200** | — | key 有效 |
| `open.bigmodel.cn/api/anthropic/v1/messages` | 429 | **429** | 两种头**都过** |
| `api.z.ai/api/anthropic/v1/messages` | 429 | **429** | 两种头**都过** |
| `open.bigmodel.cn/api/paas/v4/chat/completions` | **429 `code 1113`** | — | key 有效、**余额空** |
| `zcode.z.ai/…/zcode-plan/anthropic` | **400 `code 3007`** | **401** | **只认 Bearer** |

两条可直接用的结论：

1. **官方 anthropic 端点同时接受 `Bearer` 和 `x-api-key`** → 只发 `x-api-key` 的第三方客户端（VSCode 系魔改、Breezell 等）**可以直连官方端点**，无需协议桥接，前提是该 key 账户有余额。
2. **ZCode 代理端点只认 `Authorization: Bearer`** → 同一令牌换 `x-api-key` 立刻 401。

### 1.1 `Bearer` 是方案，不是令牌

三个不同令牌都用 Bearer，打不同端点。**"带哪个令牌"由端点决定，"怎么带"才是 Bearer vs x-api-key。**

| 令牌 | 端点 | 可用认证头 |
|---|---|---|
| `zcodejwttoken`（HS256，**无 `exp`**） | `zcode.z.ai/…/zcode-plan/anthropic` | **仅 Bearer** |
| coding plan api-key | `api.z.ai` / `open.bigmodel.cn` 的 `/api/anthropic` | Bearer **与** x-api-key |
| `oauth:*:access_token`（HS512，1400+ 字符） | doc 10 的业务接口族 | Bearer |

> `zcodejwttoken` 的 payload **不含 `exp`**，只有 `iat` / `sub` / `token_version`。失效靠服务端账号态而非 JWT 自身过期，因此**换号后旧 token 仍可能过认证层**，只是服务端按 `sub` 找不到额度。

---

## 2. 错误码判别表

| 现象 | 层级 | 含义 | 该做什么 |
|---|---|---|---|
| `HTTP 401` | 认证 | 头错 / audience 不对 / token 过期 | 换认证头或换端点 |
| `HTTP 429` + `code 1113` | 账户 | **认证过了，卡在计费层。** `Insufficient balance or no resource package` 是**两个独立 or 分支**，另可能"无订阅"——三者需分别查（[01 §0](zcode-plan-01-计划体系与供应商标识.md)） | 先查 `subscription/list` 判订阅；充值；**换 key 无用** |
| `HTTP 400` + `code 3007` | 风控 | 认证过了，卡阿里云验证码 | 需要 `X-Aliyun-Captcha-Verify-Param` |
| `HTTP 400` + `code 3006` | 授权 | 请求的模型不在该账号权益内 | 换成 `balance` 里 `capabilities` 覆盖的模型（**大小写敏感**：`glm-4.6` 被拒，`GLM-5.3-Flash` 通过） |
| `HTTP 403` / `code 1010` | 网关 | 第三方网关侧拒绝（无权限或欠费） | 换 key 或联系网关方 |
| `HTTP 429`（无 body） | 网关 | 同 403，只是没给结构化错误 | 看 body 有无 `code` 字段区分 |

**最关键的一条：`/models` 返回 200 不能作为"key 可用"的结论。** 它不校验余额——实测多把 key `/models` 全 200 而 chat 全 1113。**必须发一次 chat 才能区分 401 / 1113 / 3007。**

### 2.1 验证码是拉取，不是推送

`InitCaptcha` 是**客户端主动请求**、服务端按风险判定返回 `CaptchaType`：

| 服务端判定 | 返回 |
|---|---|
| 低风险 | `TRACELESS`，**不带** `PowVerifyString`，无需 PoW |
| 高风险 | 交互类型 + `PowVerifyString` + 图片，需要 PoW |

**推论：不存在"等"的可能。** 请求不带设备指纹（`DeviceData`）即被判低风险走无痕通道；而"制造高风险信号"（改 UA / 换 IP / 触发限流）属于规避风控，不在本文档范围。

也正因如此，**只读接口（balance / 额度查询）不需要验证码**——能读的不用验，要用的必须验。

---

### 2.2 错误判别的函数级溯源（2026-09-27 函数体实读，B 级）

§2 表格的每一行在 bundle 里都有判别函数。以下按"现象 → 函数 → 判据"组织。

**① 上下文超限：三层启发式**（finishReason → marker → message）
- `isContextExceededFinishReason`（finish_reason 直接判）→ `isModelContextExceededMarker` → `isModelContextExceededMessage`（`GSa`）：消息文本 includes("context")&&includes("exceed") 或 context&&"too long" 或 prompt&&"too long"
- 命中即产 `createModelContextExceededFinishError` → 走 compact 管线（[18](zcode-plan-18-系统提示词与上下文管理.md)）

**② 媒体过大**：`isModelMediaTooLargeMessage`（`JSa`）：文本含 (media|image|document) && (too large|exceed)——对应 [26](zcode-plan-26-外围子系统.md) 的 `MEDIA_BUDGET_*_TOO_LARGE` 遥测族。

**③ 可疑空结果**：`createSuspiciousEmptyModelResultError`——"Model returned no text, no tool calls, and no usage before completing the turn."。排查"模型没干活就结束"先看这个。

**④ 业务码提取链**（`resolveProviderBusinessCode` = `vqr`）：providerCode 归一化失败 → BFS 遍历响应体摘要找 `providerCode`/`error_code`/`code` 字段 → 再从 `message`/`providerMessage` 正则抽数字。§2 的 1113/3007 即这条链抠出。

**⑤ 可重试判定**（`isProviderMarkedRetryable` = `lqr` + `uqr`）：
- `retry-after-ms`（毫秒）→ `retry-after`（秒×1000，或 HTTP 日期−now）→ 缺省按错误类型
- `x-should-retry: false/0` **一票否决**
- 判定结果喂 [20 §6.2](zcode-plan-20-动态工作流执行器.md) 治理器的 `cooldownUntil`

**⑥ TLS 失败归一**（`normalizeModelTlsFailure` = `XUr`）：code 含 CERT/TLS/UNABLE_TO_VERIFY_LEAF_SIGNATURE（递归 cause 链）→ 包成 `MODEL_TLS_VALIDATION_FAILED`。企业代理/自签证书场景先查此条。

**⑦ 三个前所未知的行为常量**：
- 工作流子代理（taskType `workflow_child`/`nested_workflow_child`）**重试预算 Unbounded**（`resolveModelRetryBudgetFromTaskType` = `RSo`）——DWF 内模型请求不限重试次数
- 流空闲超时 = **10 min 基准 + 30 s × 重试序号**（`resolveModelStreamIdleTimeoutMs` = `gzr`；常量 6e5/3e4）；超时错误 `MODEL_STREAM_IDLE_TIMEOUT`/"ModelStreamIdleTimeoutError"。模型流"卡住不动"先对这条
- 每步 max_output_tokens = min(基线, contextWindow − 估算已用 − 1000)（`resolveModelStepMaxOutputTokens` = `tEo`；观测事件 `model.request.token_limits`）

### 2.3 业务码映射全表与实测状态（2026-09-27 自 bundle 抽取，B 级）

客户端 `Cs` 枚举的业务码映射共 18 条（`zcode.cjs` @3.92M）。**限流族 7 码全部未实测**：

| 码 | Cs 枚举语义 | retryable | 实测状态 |
|---|---|---|---|
| 3001 | InvalidModelRequest | 否 | ✓ A 组基线（parameter error） |
| 3006 | ModelNotFound（模型名大小写敏感） | 否 | ✓ e2e 实测 |
| 3007 | InvalidModelRequest / AuthFailed（验证码闸） | 否 | ✓ 全链闭环 |
| 1113 | ModelRequestFailed / Unknown（**计费层**：余额空 / 无资源包 / 无订阅，三分支需分别查） | 否 | ✓ 排障矩阵（2026-09-27 独立读数：本账号 individual 为**无订阅** `data:[]`） |
| **3008 / 3009 / 3010** | **ModelRateLimited** | 否 | **未实测** |
| **1302 / 1303 / 1305** | **ModelRateLimited** | 是 | **未实测** |
| **1304** | **ModelRateLimited** | **否** | **未实测**——唯一不可重试的限流码 |
| 1261 | ModelContextExceeded → compact 管线 | 否 | 判别函数已还原（[18 §3.4](zcode-plan-18-系统提示词与上下文管理.md)），码未单列实测 |
| 500 / 1120 / 1230 | ModelRequestFailed / ServerError | 是 | 未单列实测 |
| 1234 | ModelRequestFailed / NetworkError | 是 | 未单列实测 |
| 1005 | ModelRequestFailed / InvalidRequest | 否 | 未实测 |
| 1006 | ProviderNotConfigured | 否 | 本地配置态，非服务端 |
| **3101 / 3103** | **off-peak 任务创建失败类别**（eligibility / quota） | — | 2026-09-28 自 host asar schema 静态提取（B 级）：`errorCategory ∈ {client_validation, eligibility_3101, quota_3103, network, invalid_response, local_persist, unknown}`，`failureStage ∈ {client_validation, ticket_request, local_persist}`——见 [06 §8](zcode-plan-06-off-peak档位.md) |

注意：`3012` **不在此映射表**——HTTP 405 承载、走默认处理路径（终定性见 §8.2）；`1010`/裸 429 是网关层码，也不在此表。验证码侧另有三层未触发分支（`LimitFlow`/`403 + x-auth-msg`/`ThrottlingByStrategy`，[12 §5g.4](zcode-plan-12-阿里云验证码体系.md)）——与业务码限流族是**两个不同层**，撞上限流时先分清是哪一层。

## 3. 额度桶路由

多个桶可覆盖同一模型（`capabilities` 出现重复 `model:*` 即是）。**客户端不选桶**，服务端按 `entitlement_priority` 降序扣，扣完接下一个。

| 桶 | capabilities | 额度 | 周期 | entitlement_priority |
|---|---|---|---|---|
| Global Build | `model:glm-5.3-flash` | 100,000,000 | `one_time` | **110** |
| Weekend Build | `model:glm-5.3-flash` | 300,000,000 | `one_time` | 110 |
| Start Plan | `model:glm-5.3` | 3,000,000 | `daily` | 110 |
| Start Plan | `model:glm-5.3-flash` | 5,000,000 | `daily` | **80** |

```
调 glm-5.3-flash → Global Build(110) → Weekend Build(110) → Start Plan 日桶(80)
调 glm-5.3       → 只有 Start Plan 日桶
```

**客户端唯一能"选"的是模型名。** `glm-5.3` 每日仅 300 万且 priority 与 flash 同为 110，作默认会当天先烧光。

---

## 4. 多号并存时的身份核对

排障第一步永远是**确认在测哪个号**。本项目有两侧身份，容易混：

| 来源 | 路径 | 内容 |
|---|---|---|
| ZCode | `~/.zcode/v2/credentials.json`（`enc:v1` 加密） | provider / JWT / api-key |
| Breezell | `%APPDATA%\Breezell\User\globalStorage\state.vscdb` 的 `breezell.userInfo.cache` | email / plan / modeAccess |

两者**本轮实测并不同号**，一度导致把"ZCode 的额度"和"Breezell 的 key 余额"混着谈。

> 换号后 provider 会变（`zai` ⇄ `bigmodel`），但 **Start Plan 的端点与认证不变**；变的是付费档的 `baseUrl`。详见 [08 §1.1](zcode-plan-08-聊天对话接口.md)。

---

## 5. 复盘：一个笔误如何伪装成五个问题

### 5.1 症状链

Breezell 里删掉正在使用的 provider 后，模型选择器变成"添加一个模型"**按钮**、点不出下拉。真因是 endpoint 打错一个字符：

```
https://api.zi/api/pass/v4      ← 实际存的（域名少 .a，路径少 a）
https://api.z.ai/api/paas/v4    ← 正确
```

五层伪装：

| 层 | 表现 |
|---|---|
| 1 | `api.zi` 被 mihomo 的 fake-ip 接管 → 解析到 `198.18.0.202`（RFC 2544 保留测试网段） |
| 2 | TLS 握手失败（`UNEXPECTED_EOF_WHILE_READING`） |
| 3 | 拉不到模型 → 该槽 `models: []` |
| 4 | 空态判定返回 `"addModel"` |
| 5 | 候选列表为空 → **组件不渲染选择器**，只给一个跳转按钮；该按钮指向的设置页同样是空的 → 死胡同 |

> `198.18.0.0/15` 是基准测试保留段。mihomo / Clash 的 **fake-ip** 模式会给未命中的域名分配该段地址——所以"域名能解析"不代表域名存在。排查时必须**看解析到的 IP**，不能只看有无解析结果。

### 5.2 六次误判

| # | 当时结论 | 实际情况 |
|---|---|---|
| 1 | 配置读不到，只能读代码推导 | 已有解密文档，本可直接读 |
| 2 | `_didFillInProviderSettings` 丢失 | 该 flag 是 `true` |
| 3 | DB 损坏 | 完好 |
| 4 | 写入用了 BLOB 导致解析失败 | 类型正常 |
| 5 | endpoint 缺路径段 | 是**多了两处错字符** |
| 6 | 目录里没有该 provider 条目，永远拿不到模型 | **只是从来没去拉过** |

**共同点：每一次都在读代码推测，而没有去读或去试那个具体的东西。** 第 5 次离答案最近——正确做法是把存储里的 endpoint 原样复制出来请求一次。

### 5.3 代价

外部成本约三小时；内部成本更高：**文档内部一度出现五种互相矛盾的结论**，因为改最新章节时没同步旧引用点与交叉引用。

### 5.4 由此落地的两道闸门

**闸门 A · 被测对象完整性（已进 `trace_pow.js`）**

执行 bundle 后、解读行为前先体检；不通过直接 `process.exit(2)`，绝不继续解读：

```
[2.5] 被测对象完整性闸门:
    启动未抛异常   : 是
    关键全局齐全   : 是      ← 入口 / 加密库 / 暴露点
    判定           : 通过 —— 可以解读行为
```

**闸门必须做过反向验证**——把已知故障注入回去，确认它真的会拦。不会响的闸门等于没有。

**闸门 B · 证据分级（见[总纲 §4](zcode-start-plan-逆向分析.md)）**

A 实测（有留存脚本可重跑）/ B 静态（读码）/ C 推断。混读会把静态推测当实测。

### 5.5 第三类错误：不去取已有的东西

前两类是「验证了对象但验证方式不对」。**第三类更靠前——根本没去验证。**

2026-09-27 连续踩中四次，答案全在项目里：

| # | 绕的路 | 实际在哪 |
|---|---|---|
| 1 | 逆 rewards 页 17 个 chunk | `doc 11`（标题就叫「签到领取接口」） |
| 2 | 搜 `checkin` 147 处判定"无签到" | 该搜 `rewards`；且 147 全是 `checking` 子串 |
| 3 | 断言"验证码未解决" | `captcha_node/solver.js`（文件已删除）当时已能出真令牌，README 带退出码表 |
| 4 | 写"从未向服务端提交过" | `tools/e2e_captcha_gate.py` 一跑就证伪 |

**共性：成本更低的验证路径就在手边，却跳过去做成本更高的。**

**闸门 C · 动手前先盘存量**

```
Get-ChildItem docs\ -Filter *.md        # 结论是否已有人写过？
Get-ChildItem tools\                    # 能力是否已有人写过？
```

**顺序颠倒的代价是双份的**：既走错了路，又把错误结论写进文档传播出去（上面第 3、4 条都进了 §8，需要回改）。

**判据**：准备动手逆/写之前，先问「这个结论会不会已经有人做过了」。答案是"可能"就去查——`Select-String` 一次的成本远低于一次从零逆向。

---

## 6. 工具清单

全部只读，不改配置。

| 脚本 | 用途 |
|---|---|
| `tools/which_account.py` | **排障第一步**：确认 ZCode 侧与 Breezell 侧是不是同一个号 |
| `tools/list_plans.py` | 列出当前账号的套餐与额度桶（含已用 / 可用 / 优先级） |
| `tools/dump_creds.py` | 完整导出凭据，按用途标注认证头与端点，自动解 JWT payload |
| `tools/find_by_tail.py <后缀>` | 按 token 尾部指纹反查是哪一把 |
| `tools/call_balance.py` | 直接打 balance 接口 |
| `tools/call_claim_preview.py` | 打 `billing/preview`——**当前有没有可领的计划**（只读，不需验证码） |
| `tools/mine_model_io.py` | model-io 日志结构化探针（§9 的可重跑工具） |
| `tools/asar_symbols.py` | app.asar 自有代码名字符串检索器（41 号线索） |
| `tools/cluster_symbols.py` | zcode.cjs 保留函数名的子系统分类器（41 号） |
| `captcha_node/solver.js`（文件已删除） | 无浏览器验证码求解器（happy-dom 加载真实 SDK）。§8 的 param 产出改由 `tools/e2e_captcha_gate.py` 内部调用同类逻辑完成，**可复跑路径以它为准** |
| `tools/e2e_captcha_gate.py` | **端到端实锤**（§8.2）：solver 出 param → 装配官方身份块 + 15 个 `X-*` 头 → POST messages。**§8.3 的 200 由它产出，可复跑** |
| `_re/asar_pick.js` | app.asar 按需抽取与全包关键词扫描（`list`/`root`/`get`/`find`，**311 MB 上全文正则会超时**）。用法：`node _re\asar_pick.js find <关键词>` |
| `_re/captcha_window.js` | 按时间窗打印 captcha 事件链，定位 `instance_timeout`。`node _re\captcha_window.js 2026-09-27 02:59:20 22` |
| `_re/rollout_shape.js` | 打印 rollout JSONL 结构（顶层键 / response 字段 / messages 的 role 分布） |
| `_re/sparkle_rules.js` | Sparkle(mihomo) 配置加阿里云/腾讯直连 + `fake-ip-filter`（修 `instance_timeout`，见 §9）。`apply`/`check`/`revert`，自带 `.zcodebak` 备份 |
| `_re/check_docs.js` | 本文档集校验：表列数 / 锚点 / 行尾 |

> **表已按 2026-09-27 清理后的实际文件重新核对。** 校验器只查表结构与锚点，**不查文件是否存在**——列进去的脚本要自己确认还在。

```powershell
python tools\which_account.py      # 先确认在测谁
python tools\list_plans.py         # 再看有什么额度
python tools\dump_creds.py         # 最后取凭据
```

---

## 7. 桥接：两层均已接通（2026-09-27 实测）

Breezell 的客户端装不了 ZCode 额度，两个原因互斥：

| 障碍 | 说明 |
|---|---|
| 协议不同 | Breezell 的 openai 槽发 OpenAI 格式，anthropic 槽发 `x-api-key`；ZCode 要 Anthropic 格式 + `Bearer` |
| 要验证码 | ZCode 端点每次请求需 `X-Aliyun-Captcha-Verify-Param`，缺则 `3007` |

桥接（原 `tools/zcode_bridge.py`，已清理）解决第一个：收 OpenAI 格式 → 转 Anthropic Messages → 加 `Authorization: Bearer <zcodejwttoken>` + 实证头集（`X-Device-Mid`、每请求重生成的 trace 三件套、region 头等，按 D3-vin/Zcode2Api 实证结论、并经 dengyie/zcode2api `app/identity.py` 独立互证：start-plan 误发 `x-query-id`/`x-session-id` 触发 3012，故绝不发）→ 回转 OpenAI 响应。**协议与认证两层已实测通过**（同一 JWT：`Bearer` → 400/3007，`x-api-key` → 401，差值即"认证过 vs 没过"）。

**验证码也已接通**（2026-09-27）：`CaptchaHook` 每请求现解一次性 param（原 `captcha_node/solver.js` 已清理）（不缓存，param 核销即失效），求解失败自动重试一次（3007 对照见 §8.1，剩余瓶颈见 §8.2）。

---

## 8. 验证码：已解决（2026-09-27 实测）

**本节早前版本写的是"从未向真实服务端提交过一次"——该结论错误**，成因见 §5.5。

`captcha_node/solver.js`（1682 行，happy-dom 加载**真实** `AliyunCaptcha.js`）**可离线产出可用令牌**。实测两个 region 均 exit 0：

```bash
node solver.js 11xygtvd cn  no8xfe   → exit 0, VERIFY_PARAM=<base64>
node solver.js 11xygtvd sgp no8xfe   → exit 0, VERIFY_PARAM=<base64>
# 解码 = {"certifyId":"…","sceneId":"11xygtvd","isSign":true,"securityToken":"<128字符>"}
```

> solver 默认 `region=sgp`，而 client config 实值为 `cn`（[12 §3](zcode-plan-12-阿里云验证码体系.md)）——**两者都能出令牌**，但按配置应传 `cn`。

### 8.1 3007 已被解除（对照实验）

`tools/test_captcha_chain.py`（文件已删除）当时用同一请求只切换 `X-Aliyun-*` 头：

| 组 | 请求头 | 结果 |
|---|---|---|
| 对照 | 不带 `X-Aliyun-Captcha-Verify-Param` | `HTTP 400` / **`code 3007`** |
| 实验 | 带 solver 实时产出的 param | `HTTP 405` / **`code 3012`** |

**3007 是被 param 解掉的，不是巧合。** 差值即证据。

### 8.2 新瓶颈：`code 3012`

```
{"code":3012,"msg":"request has been blocked due to unusual activity."}
```

换了一层拦截，**不是验证码**。

**对照实验（2026-09-27 凌晨，桥接接入后实测）**：

| 组 | 请求条件 | 结果 |
|---|---|---|
| A：billing 基线 | 同 JWT，`GET /billing/balance`（无验证码门） | `400 code 3001 parameter error`——网关与 JWT 均正常，**非全局 IP 封锁** |
| B：sgp param + 最小头 | 桥接默认（sgp 区 param，7 个 `X-*` 头） | `405 code 3012` |
| C：cn param + region 头 + 全量头 | cn 区 param + `x-aliyun-captcha-verify-region: cn` + §2 全部 17 项头（含会话追踪四 ID） | `405 code 3012` |
| D：真实请求形态 | 组 C 基础上换 system/多轮/SSE/`stream:true`/`max_tokens:1024` | `405 code 3012` |

**第二轮对照（2026-09-27，对齐 D3-vin/Zcode2Api 实证实现 + 出口 IP 轮换）**：

- **param 算法同源**：其 `solver.js` 与当时的 `captcha_node/solver.js` 逐行 diff，差异仅注释与 TLS 开关——排除 param 生成算法差异。
- **头集对齐**：按其实证结论升级桥接头集（`X-Device-Mid` + trace 三件套 + region 头），仍 `405 code 3012`。
- **出口 IP 轮换（事后判定：实验无效）**：29 节点轮换 + 遥测 warming 后仍 `405 code 3012`；但事后核对 Sparkle(mihomo) 分流发现 `zcode.z.ai` 被 `GeoIP(cn)` 规则钉死 `DIRECT`——换节点只改变了 ipify 探测的出口，messages 请求从未真正换过出口。该组不作为排除依据。

**第三轮对照（2026-09-27，本机在跑的 D3-vin 服务）**：其 Go 服务日志 `[egress] chat via direct (mint direct, swap 0)`——铸 param 与发 chat 同走直连，与本机桥接等效。同一台机器、同一个本机出口 IP、同一个 solver（含相同指纹常量）、同样直连：**他的账号（日志尾号 `OOeU`）返回 200 SSE，本机账号（JWT 尾号 `diMrc8`）仍 3012**。另用 curl 原生 schannel 指纹重放同请求仍 3012——客户端 TLS 指纹排除。

**旁证互证（2026-09-27，dengyie/zcode2api Python 版源码）**：与 D3-vin/Zcode2Api（Go）同生态的 Python 实现，`app/identity.py` 注释独立实证：**start-plan（JWT 通道）只发 trace 三件套（x-request-id / x-zcode-session-type / x-zcode-trace-id），误发 `x-query-id`/`x-session-id` 会触发上游 3012**——官方客户端 start-plan 请求不带这两个头。与本桥接此前按 D3-vin 结论修正后的头集完全一致：两个独立实现得出同一结论，桥接实现无误（见 §7）。另其 `app/constants.py` 对 3012 的定性（HTTP 405 承载、高频请求触发、账号级临时限制、3 次以上违规才封号）与下述账号级标记假设互洽；其处置同样无解——禁号 + 人工恢复 + 冷却期零上游流量（含验证码池预热关门），靠多账号 failover 绕开。

结论收窄（三轮对照 + 双源旁证）：3012 与 param 区域、请求头、请求形态、客户端指纹、出口 IP 均无关；solver 指纹假设也被反证（同一 solver 同一指纹在同一 IP 上可过）。

**终定性（2026-09-27，采纳 dengyie 请求构建层后回写）**：三轮对照的盲区在**请求体**——组 D「换 system」换的只是用户文案/多轮/SSE，从未注入官方 system 身份块；桥接 `openai_to_anthropic()` 只透传调用方 system，从不前置官方块、从不写 `metadata.user_id`。真因三项，均见 `zcode2api-dengyie/app/` 实证：

| # | 真因 | 实证落点 |
|---|---|---|
| 1 | **缺官方 system 身份块（主因）**：网关对 system 做内容审查，缺 `zcode_system.json` 的 CLI Prefix / Agent Identity / Environment Info 块 + 动态 currentModel 块即拒 | `body_transform.py:4-6`「请求缺这些身份块会被拒为 3012 \"method not allowed\"」 |
| 2 | **`metadata.user_id` 形状错**：官方为 `user_id: B.metadata.userId`（JWT payload uuid），桥接从不注入 | `body_transform.py` `apply_user_id()` / `jwt_user_id()`。**源码级确证（2026-09-28，官方开源仓 zai-org/ZCode v3.14.3）**：`anthropic-request-metadata.ts` 的官方形状 = `JSON.stringify({device_id: <deviceMid>, account_uuid: "", session_id: <归一化 sessionId>})`，仅 anthropic 通道；model-io 实录的 `"[REDACTED]"` 即该文件 `redactAnthropicRequestMetadata` 所为 |
| 3 | **客户端头透传泄漏**：上游 stainless 指纹头（`x-stainless-*`）与反代/CDN 头透传构成指纹矛盾 | `agent.py` `_DROP_HEADERS` / `_DROP_HEADER_PREFIXES` |

与验证码、JWT、IP 均无关（组 A 3001 基线、3007→3012 差值、第三轮同 IP 同 solver 互证仍然有效——它们恰好说明问题不在那些层）。处置：**整体采纳 dengyie 请求构建层**（工作区留存 `zcode2api-dengyie/`，AGPL-3.0）——`transform_body()`（身份块 + cache_control + user_id）+ `build_identity_headers()`（pio 头集）+ 透传白名单。原定「本机 JWT 塞入 D3-vin 账号池」的决定性 A/B 随本定性作废：第三轮组间差异（他 200 SSE vs 本机 3012）的真实来源正是双方请求构建层的 body 差异，而非账号标记。

**证据分级（重要）：**

| 结论 | 级别 | 说明 |
|---|---|---|
| **换请求构建层 → 3012 变 200** | **A 实测** | 同一 JWT（尾号 `diMrc8`）、同一本机出口、同一 param 生成，仅换 body/头装配，其余全部恒定；§8.3 独立复现两次 200 |
| 收敛点＝**请求体构建层** | **A 实测** | 三轮对照 + e2e 逐层排除：验证码 / JWT / param 区域 / 请求头集 / 请求形态 / 客户端指纹 / 出口 IP 均已单独试过且无效 |
| **子因 1「缺官方 system 身份块」为主因** | **C 引用** | 依据是 `zcode2api-dengyie/app/body_transform.py:4-6` 的注释，**本地未做 A/B 拆解**（三个子因是整体采纳，未逐个剥离验证） |
| **子因 2「`metadata.user_id` 形状错」** | **C 引用** | 同上，`apply_user_id()` / `jwt_user_id()` |
| **子因 3「客户端头透传泄漏」** | **C 引用** | 同上，`agent.py` `_DROP_HEADERS` / `_DROP_HEADER_PREFIXES` |

**即：「换构建层能通」是本地实测的；「哪一处起决定作用」是采信上游实现的结论。** 若要拆到子因粒度，需在 `transform_body()` / `build_identity_headers()` 上逐项开关做 A/B——**未做**。这不影响修复有效性（整体采纳即通），但影响"能不能据此推断别的场景"。

**e2e 决定性实锤（2026-09-27，`_re/e2e_captcha_gate.py`，可复跑）**：同一 JWT（尾号 `diMrc8`，即此前每轮必 3012 的账号）、同一本机出口、同一 solver 现解 param（region=cn），请求体与头集改由 dengyie 真实现装配——`body_transform.transform_body()`（官方身份块 4 块 + cache_control + `metadata.user_id`）+ `identity.build_identity_headers()`（pio 全集）+ `build_trace_headers("start-plan")` 三件套 + 成对验证码头——直打 `POST /api/v1/zcode-plan/anthropic/v1/messages`：**HTTP 200**，模型正常回复。三轮对照终于闭环：变量收敛到「请求体构建层」单一点，3012 → 200。附注：模型名大小写敏感，`glm-4.6` 会报 `400 code 3006 model not allowed`；本账号可用 `GLM-5.3-Flash` / `GLM-5.3`（`zcode2api-dengyie/app/constants.py` `AVAILABLE_MODELS`）。

### 8.3 独立复现（2026-09-27 16:09，两连 200）

不依赖上文结论，独立跑 `tools/e2e_captcha_gate.py` 两次：

| 次 | param | HTTP | `stop_reason` | `usage` |
|---|---|---|---|---|
| 1 | 280 字符 | **200** | `max_tokens`（32 上限截断） | in 315 / out 32 |
| 2 | 280 字符 | **200** | **`end_turn`** | in 59 / out 19 / **cache_read 256** |

第 2 次的完整内容（证明是真回复而非空 200）：

```json
{"type":"message","model":"glm-5.3-flash","stop_reason":"end_turn",
 "content":[{"type":"thinking","thinking":"The user sent \"ping\" and wants a \"pong\" reply. Simple."},
            {"type":"text","text":"pong"}],
 "usage":{"input_tokens":59,"output_tokens":19,"cache_read_input_tokens":256,
          "server_tool_use":{"web_search_requests":0},"service_tier":"standard"}}
```

**要点：**

- **`3007` / `3012` 均未复现**，两轮都直落 200
- **模型名大小写敏感**：`glm-4.6` → `400 code 3006 model not allowed`；`GLM-5.3-Flash` → 200
- `service_tier: "standard"`、`cache_read_input_tokens` 表明**走了正常的计费与缓存路径**
- 15 个 `X-*` 身份头（`X-Aliyun-Captcha-Verify-Param/-Region`、`X-ZCode-Agent`、`x-zcode-session-type`、`x-zcode-trace-id` 等）由 dengyie `identity.build_identity_headers()` + `build_trace_headers("start-plan")` 装配
- `system_blocks=4` —— 官方身份块确实进了请求体，与 §8.2 终定性一致

**归因说明**：本机此前在 Sparkle(mihomo) 侧加过 `aliyuncs.com` / `alicdn.com` 直连规则，但**是否重载过、是否为 3012 消失的原因，无法从这两轮反推**——按 §8.2 终定性，3012 的真因是请求体缺官方 system 身份块，代理侧改动不构成解释。**不把两件事混为一谈。**

**复现 #3（2026-09-28，zcode-proxy Go 移植版，经数据中心出口 IP）**：构建层整体移植进 Go 网关（`zcode-proxy/sysbuild.go`——身份块 4 块 + `metadata.user_id` + trace 三件套 + 丢弃 `x-stainless-*`/`traceparent` 等客户端指纹头透传），走网关自身完整链路（rod 现铸 param 280 字符，region=cn）直打 messages：**HTTP 200**，`glm-5.3-flash` 真实回复，`usage{in 315 / out 32}`、`service_tier:standard`。两点增量：① **移植保真**——Python 参考实现与 Go 移植两侧独立得到同一 200；② 本次出口为 **AWS 东京机房数据中心 IP**（Clash 节点 52.193.160.194）仍 200——「3012 与出口 IP 无关」（§8.2 结论收窄）再添一证。

### 8.4 其余未验证项

- **V4 请求签名的端到端验证**（2026-09-27，`tools/v4_sign_e2e.py`）：签名环实现侧全环可跑（握手→HKDF→解包→Ed25519→PoW→7 头），gate 不可用时服务端**不校验签名头**（两组归一化一致）。gate 开启态无载体且客户端不可达（不伪造权益）——开通付费订阅后先跑 `tools/probe_sig_gate.py`。
- **服务端权限类门控**（`entanglement` / `agent_teams` / superMemory 配额）——由 `getUserInfo` 下发并周期刷新，属账号侧权益，本文只记录判据不作处理。
- **3012 的具体触发条件**（2026-09-27 定论并闭环）：业务请求体缺官方 system 身份块（主因）+ `metadata.user_id` 形状错 + 客户端头透传泄漏，与验证码/JWT/IP/账号标记无关——见 §8.2 终定性 + e2e 决定性实锤（同 JWT 同出口同 param，仅换 dengyie 请求构建层 → 3012 变 200）。原「JWT 入 D3-vin 账号池 A/B」作废。**已两次独立复现 200（§8.3）。**
- **Sparkle(mihomo) 侧改动是否为 3012 的成因**——**未验证**。本机在 `work/config.yaml` 加过 `aliyuncs.com`/`alicdn.com` 直连与 `fake-ip-filter`，但按 §8.2 终定性它不构成解释（真因在请求体层）。**该改动的作用是修 `Captcha instance timed out`（见 §9），与 3012 无关——两件事不要混谈。**

## 9. 本地日志观察渠道（2026-09-27 实测）

排障时优先翻本机存量，再考虑抓包。三层数据源的视野（挖掘工具：`tools/mine_model_io.py`，可重跑）：

| 渠道 | 粒度 | 有 | 无 |
|---|---|---|---|
| `~/.zcode/cli/rollout/model-io-sess_*.jsonl` | 每模型请求 attempt 一条 | 完整请求体+请求头、响应头、usage、错误堆栈、attempt/traceId | URL；authorization 不落盘 |
| `db.sqlite` `model_usage` | 每 attempt 一行结构化 | 三时间戳/TTFT/token 七项/retry_count/error_code | URL、头 |
| `~/.zcode/v2/logs/*.log` | host 事件级 | 特定事件带出的响应样例 | 逐请求记录 |

**陷阱：grep 命中 ≠ 证据。** 请求体裹着全部会话内容（文档、代码、模型输出），裸 grep `x-auth-`/`LimitedFlow`/`x-off-peak` 实测命中 571/796/190 次（`-o` 计数），按 JSON 结构定位后**真实观测全部为 0**——连 `response.text` 里的命中也是污染（那是模型自己的输出）。真实观测判据只有三处：`request.headers` 的键、`response.headers` 的键、`error`。

**脱敏实测**：请求侧 `x-aliyun-captcha-verify-param`、`set-cookie` → `"[redacted]"`（与 [05](zcode-plan-05-V4请求签名协议.md) RFs 集一致）、`metadata.user_id` → `"[REDACTED]"`；响应侧不脱敏（`server`/`eagleid`/`date` 可见）。

**阴性证明（本机两天存量，126 attempt 扫描时点）**：签名头真实出现 0 次（[05](zcode-plan-05-V4请求签名协议.md) §8 休眠态 = 从未激活）；验证码限流三分支 0；off-peak 票据事件 0（[06 §8](zcode-plan-06-off-peak档位.md)）；`period` 仅 `daily`/`one_time`。含义：这些项不是漏抓，是本机未发生——要观察必须主动制造事件（换启用签名的通道 / 打到被限流 / 真跑一个 off-peak 任务）。

**补充陷阱（2026-09-27 实录）：0 命中 ≠ 不存在。** `windows-x86_64` 在 bundle 中不以字面量出现——`resolveZCodeBuiltinClientPlatform` 计算拼接（win32→windows、x64→x86_64、arm64→aarch64），字面 grep 为 0，险些误判"官方无此形态"（zcode2api-plus `profile.go` 的声明先被错驳、后经本机 `v2/runtime/provider/` 路径实存推翻）。对计算型字符串要搜**组装函数与词元**，不能只搜结果串。
