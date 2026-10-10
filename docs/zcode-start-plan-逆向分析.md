# ZCode "Start Plan" 逆向分析 · 总览与索引

> 调查日期：2026-09-26
> 对象：ZCode Desktop 3.14.3（Windows）+ 内置 CLI（resources/glm/zcode.cjs）
> 性质：本机软件与内置 bundle 静态分析；阿里云验证码部分**已扩展为实包验证**（真实调用 `InitCaptcha` 成功、动态包已抓取解析，见 [12 §5m](zcode-plan-12-阿里云验证码体系.md)）。本机账号凭证以脱敏引用记录，SDK/客户端静态常量按原值记录（见 [12 §5c](zcode-plan-12-阿里云验证码体系.md)）

## 0. 一句话结论

**Start Plan 是 Z.ai 面向 ZCode 用户的免费体验计划**（UI 文案："Try platform GLM flagship model quota for free"），实测每日发放 GLM-5.3 × 300万 tokens + GLM-5.3-Flash × 500万 tokens。它不是独立产品，而是 ZCode 内部 **"账号家族（family）× 计划档位（planKind）"** 矩阵中的一格；本会话的模型标识 `account:zai-start-plan/GLM-5.3-Flash` 即"zai 家族 Start Plan 供应商标识下的 GLM-5.3-Flash"。

## 1. 架构总图

```
┌─ Electron UI (app.asar) ──────────────────────────────────────────┐
│  设置页/领取横幅/推荐弹窗/用量侧边栏  →  RPC → host                │
├─ Host 进程 (out/host/index.js) ───────────────────────────────────┤
│  BigModelUsageQuotaProvider / CodingPlanSubscriptionProvider      │
│  ├─ GET zcode.z.ai/api/v1/zcode-plan/billing/balance (Start Plan) │
│  ├─ GET api.z.ai /api/biz/subscription/list          (individual) │
│  ├─ GET api.z.ai /api/biz/customer/getCustomerInfo   (team 入口)  │
│  └─ 凭证读写 credentialService  ←→ credentials.json (enc:v1 加密)  │
├─ Agent/CLI (resources/glm/zcode.cjs) ─────────────────────────────┤
│  模型请求 → 四通道分流（start-plan 代理 / 付费端点 / off-peak）    │
│  可选 V4 请求签名：握手换 Ed25519 私钥 + PoW + 6 个签名头           │
│  权益快照解析 resolvePlanIdentitySnapshot（codingPlan→startPlan）   │
└───────────────────────────────────────────────────────────────────┘
```

## 2. 专项文档索引

| 文档 | 内容 |
|---|---|
| [01-计划体系与供应商标识](zcode-plan-01-计划体系与供应商标识.md) | 家族/档位枚举、providerId 生成规则、账号 schema、可用性判定与 connectionKey |
| [02-认证与凭证存储](zcode-plan-02-认证与凭证存储.md) | OAuth 设备流、credentials.json 结构、**enc:v1 加密方案完整还原**（可本地解密） |
| [03-billing-balance 接口与实调](zcode-plan-03-billing-balance-接口与实调.md) | Start Plan 余额接口完整规范、必需请求头、**实调成功响应全文**、解析函数族；**§5 `billing/current` 响应结构**、**§6 `usage` 端点 404 否证**（2026-09-27 补测）；§7 `code!==0` 错误体待验 |
| [04-权益解析逻辑](zcode-plan-04-权益解析逻辑.md) | resolvePlanIdentitySnapshot / resolvePlanEntitlementState 完整控制流、快照字段、5小时/周重置窗口 |
| [05-V4请求签名协议](zcode-plan-05-V4请求签名协议.md) | codingPlanSignature feature gate、握手换钥、Ed25519 签名、PoW、旁路策略；**§8 握手实测通过**（独立实现获服务端接受，双层编码私钥解出）；复现脚本 `tools/v4_handshake.py` **已于 2026-09-28 按规格重建**（离线自测 6/6 + live 握手 200） |
| [06-off-peak 档位](zcode-plan-06-off-peak档位.md) | 空闲算力队列机制、票据模型、与 start-plan/付费档位的关系 |
| [07-UI 文案与行为](zcode-plan-07-UI文案与行为.md) | 领取横幅、推荐弹窗、设置页状态机、全部相关 i18n key 与 testId |
| [08-聊天对话接口](zcode-plan-08-聊天对话接口.md) | 模型请求完整协议：URL 构造（`/api/anthropic/v1/messages`）、请求头、Anthropic Messages 请求体、SSE 流与 GLM 兼容层、全量协议矩阵 |
| [09-OpenAI兼容与Responses协议](zcode-plan-09-OpenAI兼容与Responses协议.md) | 另外两种协议的完整逆向：`chat/completions` 与 `responses` 的请求体、认证、流格式、reasoning 映射、三协议差异速查 |
| [10-OAuth 登录流程](zcode-plan-10-OAuth登录流程.md) | Z.ai 设备流（init/poll）与 BigModel 授权码流全链路、API key 解析（`/api/auth/z/login` + `zcode-api-key`）、凭证/配置持久化、登出与刷新现状；**§0.1 家族与域名机制**（`providerFamilyDomain` 切国际 `z.ai` / 国内 `bigmodel.cn`、域名与 client_id 常量表、六个端点解析器 production/test 对照、11 个环境变量、运行时迁移）；授权页实抓与 Web 流差异 |
| [11-签到领取接口](zcode-plan-11-签到领取接口.md) | Weekend Build 等周期计划的领取：`billing/preview` + `billing/claim`（阿里云验证码）、计划实例生命周期、UI 卡片 ↔ plan_id 对照 |
| [12-阿里云验证码体系](zcode-plan-12-阿里云验证码体系.md) | `X-Aliyun-Captcha-Verify-*` 两头全链路：`configs.captcha` 真实配置、SDK 无痕验证、param 生命周期（单次有效）、RPC 下发链、错误码谱系；**§5c 静态加密层**（`WEB_AES_SECRET_KEY` 5 项明文、IV 派生、双层 `Data` 构造、HMAC-SHA1 签名）、**§5d DeviceConfig 9 字段 schema**（RES 密钥 → `#` 分段 → 三份采集清单 + 飞廉 FeiLin 资源路径）、**§5e 响应 8 字段**、**§5f 日志上报链与 UPLOAD/PREID 定论** |
| [13-AGENTS.md 支持](zcode-plan-13-AGENTS.md支持.md) | 指令文件发现（用户级 ~/.zcode + 工作区向上遍历至 git 根）、100KB 上限、/init 命令、子代理注入开关、Claude 配置迁移 |
| [14-本地存储全 Schema](zcode-plan-14-本地存储全schema.md) | db.sqlite 22 业务表 + tasks-index.sqlite 9 表全量：会话/消息/用量/工作流/定时任务/off-peak |
| [15-工具与权限体系](zcode-plan-15-工具与权限体系.md) | 34 个内置工具清单、四种权限模式判定引擎全逻辑（allow/ask/deny 决策树）、风险分级、项目规则匹配 |
| [16-插件系统](zcode-plan-16-插件系统.md) | .zcode-plugin manifest、marketplace 分发（zip+sha256）、缓存布局、官方目录 26+ |
| [17-云端会话与远程体系](zcode-plan-17-云端会话与远程体系.md) | v4 RPC 全方法表、pub/sub 主题与 logEpoch/seq 断点模型、两种 clientMode、web 远程命令、relay WS |
| [18-系统提示词与上下文管理](zcode-plan-18-系统提示词与上下文管理.md) | 分节装配器（name/source/cacheHint/tokens）、八类 section、auto-compact 与 fork 守卫、工具级 cache_control |
| [19-命令风险评分](zcode-plan-19-命令风险评分.md) | bash AST 解析 + 逐命令白名单分析器（git/jq/sed/date…）、"证明只读"式判定 |
| [20-动态工作流执行器](zcode-plan-20-动态工作流执行器.md) | DWF 节点五类型、actor 网格调度、硬限制表、journal 重放与裁剪 |
| [21-子代理运行时](zcode-plan-21-子代理运行时.md) | 内置/插件/自建代理、模型覆盖通道、派生与通信、隔离边界 |
| [22-CUA与浏览器自动化](zcode-plan-22-CUA与浏览器自动化.md) | browser-use/zcode-cua 插件、tab 协议、OfficialCua 能力组、node-repl 执行底座 |
| [23-Hooks与MCP客户端](zcode-plan-23-Hooks与MCP客户端.md) | 七个 hook 事件、lane 泳道、blocked 拦截能力、MCP 配置与 OAuth |
| [24-文件变更与回滚](zcode-plan-24-文件变更与回滚.md) | 回合动作位、fileRewindPreview/applyFileRewind、checkpoint 与 rewind 的分离 |
| [25-远程目标](zcode-plan-25-远程目标.md) | SSH/WSL/Docker/Server 四形态 schema、凭证剥离 |
| [26-外围子系统](zcode-plan-26-外围子系统.md) | 遥测事件全表、记忆双分支、自更新、附件管线（64 chunks/64MB/TTL）、反馈诊断 |
| [27-IPC通道注册表](zcode-plan-27-IPC通道注册表.md) | 39 个 IPC 通道全量、agent 64 方法路径表、一天真实 RPC 流量统计、双向架构（含 agent→host 反向通道） |
| [28-记忆系统](zcode-plan-28-记忆系统.md) | 三作用域×按代理分目录存储、"Persistent Agent Memory" 提示词全文、双分支召回（MEMORY.md 直载 / 模型自选文件的 semantic-recall 预取管线）、60KB 预算与启用条件 |
| [29-支付与订购系统](zcode-plan-29-支付与订购系统.md) | 三套支付通道：国内支付宝代扣签约、国际 Stripe/PayPal、企业订单四件套；邀请码/销售渠道/防水墙字段 |
| [30-CEL模型选项映射](zcode-plan-30-CEL模型选项映射.md) | 内嵌受限 CEL 引擎：运算符白名单、JSON 对象输出约束、路径冲突检测——reasoningLevel 到各协议参数的翻译层 |
| [31-Cron调度循环](zcode-plan-31-Cron调度循环.md) | CronCreate 链路、nextRunAt/scheduleRule、wake 请求、30s 巡检、错触发补偿 |
| [32-Skills系统](zcode-plan-32-Skills系统.md) | SKILL.md 格式（轻量 YAML frontmatter）、目录发现规则、user-invocable 与模型自主调用 |
| [33-搜索系统](zcode-plan-33-搜索系统.md) | rg 检索栈、统一 context 搜索、无向量库——模型自选替代 embedding |
| [34-Git集成层](zcode-plan-34-Git集成层.md) | git 工具函数群、no-throw 封装、六大消费方 |
| [35-输出样式系统](zcode-plan-35-输出样式系统.md) | Output Style 注入机制、与 AGENTS.md 的分工 |
| [36-Bots投递体系](zcode-plan-36-Bots投递体系.md) | botDeliveryTarget、automation/off-peak 互斥、本机未配置 |
| [37-排障手册](zcode-plan-37-排障手册.md) | **方法论 + 实测矩阵**：端点 × 认证头判别、错误码速查（401/1113/3006/3007/3012/403）、额度桶路由、多号身份核对；含一次完整误判复盘（一个笔误伪装成五个问题）与三道已落地的闸门。**§8 记验证码→3007→3012→200 全链路实测闭环。排障前先读** |
| [38-外部报告交叉核对](zcode-plan-38-外部报告交叉核对.md) | 与 [HardworkingChen/zcode-tools](https://github.com/HardworkingChen/zcode-tools) 报告的逐项比对：6 处相互印证、3 处冲突（多为**产物差异非矛盾**）、6 个本文档未收录的端点、指纹四层 |
| [39-设备指纹分层](zcode-plan-39-设备指纹分层.md) | L1 `deviceMid`（随机 UUID）/ L2 登录态 / L3 阿里云指纹 / L4 **硬件层标识**——外部报告「ZCode 不读硬件指纹」的核对结果（拆 `app.asar` 全包确认成立）、误命中清单、可执行检查 |
| [40-反馈日志打包与上传](zcode-plan-40-反馈日志打包与上传.md) | 反馈工单 vs 导出日志两条路径；前者**全量打包** `~/.zcode/v2` + `cli/rollout`（全部聊天）+ `tasks-index.sqlite` + `about.txt`。含外部 `log_guard` 补丁的**符号映射表**（3.9.1→3.14.3）与本机 fuse 核对 |
| [41-未探索子系统地图](zcode-plan-41-未探索子系统地图.md) | **长尾定量**：bundle 长名 20,753 中约一半为 vendored TS；自有面 10,936、文档触达 2.1%、零触碰家族 7,902——按家族列出的未开挖子系统清单与建议顺序 |
| [42-AppAsar自有面地图](zcode-plan-42-AppAsar自有面地图.md) | **asar 前线**：8 束自有长名 10,957、触达 4.4%；飞书/微信 Bot 通道实体、独立 scheduler 进程、ARMS 上报、CUA helper 安装体系——36/06/17/22 号的 host 侧证据 |
| [43-官方未开源清单](zcode-plan-43-官方未开源清单.md) | **`zai-org/ZCode`（Apache-2.0）产物 vs 源码逐符号对照**：V4 签名、领取、硬件探测层、企业计费、验证码 param 生成**一行都没有**；支付侧 51.7 KB 完整开源。仓库仅 3 个提交，**`git log -S` 无法判断是否删过代码**。05/39 的主题在此登记为「无官方答案」 |

辅助脚本（`tools/` 为 Python 侧、`_re/` 为 JS bundle 逆向侧；**排障时先看 [37 排障手册 §6](zcode-plan-37-排障手册.md)**）：

| 脚本 | 用途 |
|---|---|
| ~~`captcha_node/solver.js`~~（**2026-09-27 已清理**） | 无浏览器验证码求解器（happy-dom 加载真实 SDK）。**param 产出改由 `tools/e2e_captcha_gate.py` 完成** |
| `tools/which_account.py` | 确认 ZCode 侧与 Breezell 侧是不是同一个号（换号后必查） |
| `tools/list_plans.py` | 列出当前账号的套餐与额度桶（含已用/可用/优先级） |
| `tools/dump_creds.py` | 完整导出凭据，按用途标注认证头与端点，自动解 JWT payload |
| `tools/find_by_tail.py` | 按 token 尾部指纹反查是哪一把 |
~~`tools/zcode_bridge.py`~~（**已清理**；桥接结论见 §7，功能已由 `tools/e2e_captcha_gate.py` 覆盖） |
|---|---|
| `zcode_decrypt.py` | 本地解密 credentials.json（`--out` 可导出解密结果） |
| `call_balance.py` | 用解密出的 `zcodejwttoken` 实调 balance 接口 |
| `tools/v4_handshake.py` | V4 握手复现（05 §2/§3/§8）：`--self-test` 离线 6 断言；`--live` / `--api-key {id}.{secret}` 重拍握手环 |
| `mine_model_io.py` | model-io 日志结构化挖掘（37 §9）：真实观测/会话文本污染分流，阴性证明可重跑 |
| `cluster_symbols.py` | bundle 长名聚类（41 号）：官方 TS 差集剔 vendored → 自有面家族地图，`--family` 可下钻 |
| `asar_symbols.py` | app.asar 自有面扫描（42 号）：头解析按需读 8 束，不解包 311MB；TS 差集 + 聚类 |
| `tools/e2e_captcha_gate.py` | start-plan 全链 e2e 门测：现解 param + 官方构建直打 messages（37 §8.2） |
| `tools/v4_sign_e2e.py` | V4 签名环 A/B 实测（05 §8 末）：签名实现 vs 不带签名头，归一化对比 |
| `tools/probe_sig_gate.py` | gate 状态探针：开通付费订阅后先跑它确认 gate 是否开启 |
| `_re/asar_pick.js` / `_re/ctx.js` | 从 app.asar 按需抽取（不整包解）/ 抽取关键词上下文 |
| `_re/extract_web_aes_secret_key.js` | 阿里云验证码 SDK 静态加密层提取：抠字符串表 → 执行解码器 → 去混淆 → 定位配置 → 解密，用法 `node extract_web_aes_secret_key.js [js路径]` |
| `_re/tables.js` / `_re/deobf.js` | JS bundle 字符串表解码器（`G`/`er`）/ 批量去混淆器，对同款 obfuscator.io bundle 通用 |
| `_re/verify_decrypt.js` | 还原结果的 PKCS7 回环校验与交叉验证 |
| `_re/check_docs.js` | 文档结构校验（围栏/链接/锚点/表列数/编码行尾），**43 份文档全通过** |
| `_re/decode_device_config.js` | DeviceConfig 解密器（`node decode_device_config.js <密文>` / `--selftest`） |

## 3. 关键事实速览

1. **计划矩阵**：`{zai, bigmodel} × {start-plan, individual-coding-plan, team-coding-plan, off-peak}`，另有独立的 `*-offpeak-idle-plan` 供应商标识。
2. **Start Plan 实体**（实调确认）：`plan_id: zcode-v3-start-plan-0817`，名称 "ZCode Start Plan"，描述 "免费 GLM 旗舰模型体验"，`period: daily`。
3. **请求通道（PoC 实测修正）**：Start Plan 的模型请求走 **`https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`** 专用代理，认证用 `zcodejwttoken`，并要求携带阿里云验证码参数（缺则 `3007 captcha verify failed`）；付费 individual/team 走各自官方端点 + 按账号 API key；off-peak 走 `.../api/v1/off-peak/anthropic`。配额走 `.../zcode-plan/billing/balance`。详见 [08](zcode-plan-08-聊天对话接口.md)。
4. **认证**：OAuth 本地回调设备流拿 JWT；Z.ai Start Plan 的 balance 请求用 `zcodejwttoken` 作 Bearer；付费档位用按账号存的 API key。
5. **凭证加密**：`enc:v1:IV.tag.密文`（base64url），AES-256-GCM，密钥 = sha256(环境变量 `ZCODE_CREDENTIAL_SECRET` 或机器信息 fallback 字符串)——无需 OS 密钥链即可本地解密。
6. **请求签名**：远端 feature gate（`/api/v1/agent/configs`，1h 缓存）决定是否启用；仅 individual/team/API-key 通道启用，**start-plan 与 off-peak 明确不签名**。
7. **配额消费**：`model_usage` 计量项按 token 计；余额以"额度桶（balance bucket）"下发，桶与 entitlement 通过 `entitlement_id` 关联。
8. **验证码 SDK 加密层全链路已还原**（新增）：设备指纹上行 `Data` 是**双层 AES-128-CBC**（内层 `FLAG` 密钥加密平台承诺串、外层 `REQ` 密钥加密六元组）+ **HMAC-SHA1(KEY_SECRET)** 签名；`DeviceConfig` 用 `RES` 密钥解出 **9 字段 schema**（三份采集清单 `pluginElements`/`pluginResource`/`globalVariable` + `version` 驱动的飞廉 FeiLin 动态脚本）。5 项 `WEB_AES_SECRET_KEY` 明文全部可读，静态层与动态下发层都不再是黑盒。详见 [12 §5c–§5f](zcode-plan-12-阿里云验证码体系.md)。
9. **PoW 已完整解出，且验证链路已端到端闭环**（A 级）：动态包入口 `window.AliyunCaptcha`，挑战串 = `PowVerifyString` 的 **AES-128-ECB 明文**（密钥 `3e627e1b4c63f913`，为包内字符串表常量），PoW = `SHA256(挑战|16位随机hex nonce)`、digest 首字节 `0x00` 通过（难度 2^8、期望 256 次）。`trace_pow.js` 用记录型桩跑通完整入口并做伪造密文端到端往返，`solve_pow.js` 13/13 断言。**2026-09-27 起真实提交已跑通**：`captcha_node/solver.js`（happy-dom 加载真实 SDK，SDK 自行 PoW+提交）端到端拿到 `VERIFY_PARAM`，`VerifyCode:"T001"`；注意 TRACELESS 通道不下发 `PowVerifyString`（挑战串仅在拼图链路出现）。详见 [12 §5m.7–§5m.13](zcode-plan-12-阿里云验证码体系.md)。**模型请求全链已实证 200**（[37 §8.2](zcode-plan-37-排障手册.md)：最后一环是请求构建层，非验证码）。
10. **证据强度不均**：本项目结论分 A/B/C 三级，**混读会把静态推测当成实测**。读任何结论前先看 [§4 证据分级](#4-证据分级读任何结论前先看这张表)。

## 4. 证据分级（读任何结论前先看这张表）

本项目 43 篇文档的结论强度**不等价**。混着读容易把"读码推测"当成"实测确认"。三级定义：

| 级别 | 含义 | 判定标准 | 复现方式 |
|---|---|---|---|
| **A · 实测** | 打过真实服务器或跑通可执行验证 | 记录了 HTTP 状态码 / 响应全文 / 往返一致 | 脚本在 `_re/` 或 `tools/`，能重跑 |
| **B · 静态** | 从 bundle 读出的常量与控制流，未打服务端 | 给出常量值、类名、调用链 | 可回查 `zcode.cjs` / `app.asar` |
| **C · 推断** | 基于 A/B 的推理，未经直接验证 | 措辞含"应为/推测/推定" | 需补证据才能升 A |

### 4.1 A 级证据清单（全部有留存脚本）

| 结论 | 文档 | 脚本 | 备注 |
|---|---|---|---|
| 凭证 `enc:v1` 可本地解密 | 02 | `tools/zcode_decrypt.py` | 自带对拍 |
| balance 接口 200 + 响应解析 | 03 | `tools/call_balance.py`、~~`tools/poc_e2e.py`~~（已清理，功能由 `tools/e2e_captcha_gate.py` 覆盖） | 只读 |
| 端到端最小聊天请求 | 08 | ~~`tools/poc_e2e.py`~~（已清理，功能由 `tools/e2e_captcha_gate.py` 覆盖） | 一次极小调用 |
| **e2e 全链决定性实锤（3012→200）** | 08 §1.8 / 37 §8.2 | `tools/e2e_captcha_gate.py`（可复跑） | 构建层修正后模型正常回复；模型名大小写敏感 |
| 阿里云 `InitCaptcha` 成功 | 12 §5m.2 | `_re/send_init_captcha.js` | 13 参数 + `Cr()` 签名 |
| 验证码 SDK 静态加密层 | 12 §5c | `_re/extract_web_aes_secret_key.js` + `verify_decrypt.js` | PKCS7 回环 |
| DeviceConfig 9 字段 | 12 §5d | `_re/decode_device_config.js` | 带 `--selftest` |
| **PoW 引擎完整** | 12 §5m.7 | `_re/trace_pow.js` + `solve_pow.js` + ~~`pow_samples.json`~~（**样本集已清理**） | **1,900+ 样本；13/13 断言；端到端往返一致** |
| 挑战串 = AES 明文 | 12 §5m.8 | `_re/trace_pow.js` | 伪造密文往返证明 |
| **验证码端到端（VERIFY_PARAM）** | 12 §5m.13 | ~~`captcha_node/solver.js`~~（已清理）→ 现 `tools/e2e_captcha_gate.py` | **真实提交跑通**：`T001`/`VerifyResult:true`；TRACELESS 不下发 `PowVerifyString` |
| **V4 签名环 A/B（gate 关闭不校验）** | 05 §8 末 | `tools/v4_sign_e2e.py` | 实现环全跑通；两组归一化一致——服务端 gate 关闭时忽略签名头 |

### 4.2 证据链缺口（**结论强度 > 实测强度**）

| 项 | 文档声称 | 实际 | 处理 |
|---|---|---|---|
| V4 握手 | 05 §8「**握手环实测**（协议逐环验证）」 | 握手环已验（独立实现获服务端 200 + 私钥解包成功）；**签名环已完整实现并 A/B 实测**（`tools/v4_sign_e2e.py`：gate 关闭时服务端不校验签名头，两组归一化后完全一致） | 剩余 = gate 开启态的验证：无载体且客户端不可达（不伪造权益），开通付费后先跑 `probe_sig_gate.py` |
| V4 握手的独立实现 | 「独立 Python 实现对拍」 | ~~曾实现后清理~~ → **已重建（2026-09-28）**：`tools/v4_handshake.py`（按 05 §2/§3/§8 规格），离线自测 6/6 + live 握手 HTTP 200 | 原始脚本不可考；现存为按文档规格的重建并已复验 |
| ~~阿里云 PoW 提交~~ | 12 §5m.12 客户端生成器各环已定 | **已闭环（2026-09-27）**：原 `captcha_node/solver.js`（已清理）端到端实跑通过 | 剩余：限流分支（`LimitFlow`/`403 + x-auth-*`）待实包，见 12 §5g.4 与 [§5m.2](zcode-plan-12-阿里云验证码体系.md#5m2-跑通结果协议全部实测通过)（§5m.12「剩余工作」已作废，勿据其判读） |

### 4.3 13–36 号的定位

那 24 篇（UI、工具、IPC、存储、子代理等）**弱标记全为 0**，因为它们是**纯静态读码**（B 级）——不涉及协议，不打服务端。这是合理取舍，但**文档里没有一处标注这一点**，容易被误读成实测。本表即为该声明。

- `resources/glm/zcode.cjs` — CLI 主 bundle（压缩混淆，`r(fn,"name")` 保留大量原始函数名）。**2026-09-27 19:17 自动更新**（14.13MB→15.87MB，版本线 3.14.3 内嵌 → 0.16.x 独立线，26 号自更新机制的实例）：注册名与 minified 名跨构建**存活（40/40 抽检，`fetchZaiStartPlanBalanceEnvelope` 除外）**；@偏移量失效——**引用优先用注册名**（如 `ClientRequestSigningV4Signer`、`createBigmodelOAuthClient`、`loginBigmodelCodingPlan`）。

**开源版差异面**：73 个闭源符号聚成六模块（V4 签名整块 / CUA helper 钉定 / 领取族 / 设备指纹硬件层 / 企业权益门控 / 测试 client），支付侧反而全开源（bigmodel 订阅 Provider 51.7KB 一行未藏）；分界 = 「能发放权益 + 能证明客户端身份」的模块。**详见 [43 · 官方未开源清单](zcode-plan-43-官方未开源清单.md)**（含快照仓史法证、单轨 env 收敛定性、四项开放项重定性）。。

**2026-09-28 全量重验（更新后）**：43 篇文档引用的 813 个标识符逐一验尸——cjs 存活 585；asar(host) 存活 123（host 未更新，涉及结论全部有效）；验证码 SDK/第三方实现名约 105（来源本就不在 cjs，未变故有效）。**协议级事实零消失**：`zcode-plan/anthropic`、`billing/balance`、`zcodejwttoken`、`start-plan`×33、`agent/configs` 全部存活。**架构变化**：0.16.x CLI 把计费/领取/付费路由的执行收敛至 host（`buildZaiStartPlan*`/`claimManualPlan` 在 asar 同名存活），协议端点不变。待实测收敛：① 0.16.x CLI 的 start-plan 模型请求 live 复测（仍开）；② 已定位——签名 `lPe`/`KJt` 与 gate 存活、`UNSIGNED_PATHS` 常量消失（路径排除重组，行为随①复测）；captcha 配置经 `client/configs`（×2 存活）。
- `resources/app.asar` — Electron UI 与 host（i18n、testId、Provider 实现）
- `~/.zcode/v2/{credentials.json, setting.json, telemetry-state.json}` — 本机状态（已脱敏引用）
- `~/.zcode/v2/logs/2026-09-26.log` — host 运行日志（含 balance 接口完整响应样例与账号配置下发快照）
- `~/.zcode/cli/db/db.sqlite` — 每请求用量记录（model_usage 表）
- `%TEMP%\aliyun_captcha.js` — 阿里云验证码 SDK 静态样本（273,948 B，`VERSION: "1.3.4"`），[12 §5c](zcode-plan-12-阿里云验证码体系.md) 加密层还原的唯一依据；配套脚本在 `_re/`
- 实调：`GET zcode.z.ai/api/v1/zcode-plan/billing/balance` HTTP 200（只读，本账号）

## 5. 可继续推进项

1. ~~**权益快照 TTL 具体数值**~~ → 已解决：`entitlementCacheTtlMs = 600*1e3` = **10 分钟**，且快照持久化于 localStorage（键 `zcode:usage-entitlement:subscription-v2:<providerId>:<providerFingerprint>`），详见 [04](zcode-plan-04-权益解析逻辑.md)。
2. ~~**V4 签名握手的服务端实调验证**~~ → **握手环已实测通过**（05 §8，独立实现获服务端 200 + 私钥解包成功）。**但两个缺口仍在**：① 独立实现未留档 → **已按文档规格重建为 `tools/v4_handshake.py`**（2026-09-27，离线自测 6/6；**该脚本后于同日清理，现以 05 §2/§3/§8 规格为准，可随时重建**）；② 请求签名环 → **已 A/B 实测闭环**（`tools/v4_sign_e2e.py`，2026-09-27）：实现侧全环可跑（握手→HKDF→解包→Ed25519→PoW→7 头），gate 关闭时服务端**不校验签名头**（两组归一化一致，无 `VERIFY_*`/`x-client-sign-verified`）。gate 开启态无载体且客户端不可达（不伪造权益）——开通付费订阅后先跑 `tools/probe_sig_gate.py`。
3. **其他 period 取值**：实测出现 `daily` / `one_time`；`period` 在 schema 上是自由字符串，可通过服务端配置侧枚举周/月档位来验证。
4. **off-peak 服务端排队细节**：客户端侧 `x-off-peak-ticket-id` 头与过期重试策略已还原，票据签发/续期接口可在运行期抓包补全。
5. ~~**阿里云 PoW 的真实提交**~~ → **已解决（2026-09-27）**：原 `captcha_node/solver.js`（已清理）走 happy-dom + 真实 SDK 端到端跑通（无痕链路，SDK 自行 PoW+提交），详见 12 §5m.13 与 §4.1 新增行。剩余边角：限流分支（`LimitFlow`/`LimitedFlowToken`、`403 + x-auth-*`）仍需一次被限流的实包。
6. ~~**补齐 V4 握手的复现脚本**（§4.2 第 2 项）~~ → **已解决（2026-09-28 重建并复验）**：`tools/v4_handshake.py` 按 05 §2/§3/§8 规格重建，`--self-test` 离线 6/6 断言通过，`--live` 实拍握手 HTTP 200 + 双层编码私钥解包成功。注：§8 当时的原始脚本不可考，此为按文档规格的重建实现，A 级证据的可复现性由此恢复。
