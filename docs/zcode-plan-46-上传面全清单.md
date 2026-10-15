# 46 · 上传面全清单（客户端到底把什么发给了谁）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 日期：2026-10-14 · 对象：3.15.1（证据混合 3.14.3 时代，各格注明）
> 性质：**汇总收口文档**——不新增取证，把散在 08/10/11/12/17/26/29/39/40/45 号的上传证据拼成一张全表；每行标证据级与出处锚点，个别口径冲突如实并记
> 触发问题：设备相关数据到底上传了什么、上传到哪（3012 排查的取证副产品）

## 0. 结论先行

接收方共三类，敏感度高到低：

1. **ZCode 自有服务端**（`zcode.z.ai` / `api.z.ai` / `open.bigmodel.cn` / `zcode.chatglm.site`）：**收对话正文、工作区绝对路径、设备标识 deviceMid、公网 IP（经阿里云回写间接）、每次请求 12+ 个环境头**。
2. **阿里云风控栈（10-14 修正：单一接收方 = SAF 产品线，`appName: saf-captcha`；上传面为两条通道域组，非三家）**：①业务 RPC 组 `captcha-{pro-}open*.aliyuncs.com`（Init/Verify/UploadLog）；②**设备通道域组** `cloudauth-device-*` 与 `device.saf.*` 互备用端点（含 dualstack/ga/pre 变体，共 9 主机见 O1）——原述 captcha/cloudauth/SAF「三家」实为同一 SDK 的两组 endpoint 路由。收**设备指纹合成物**（双层 AES 的 Data 六元组、飞廉采集执行结果、logInfo 明文上报）——ZCode 只转发不解读，但它是 3007/3012 判定的原料。**ARMS 不属此栈**（运营遥测，表在 C17）。
3. **第三方基础设施**（`api.keygen.sh` 更新——已改判库自带未用、`g.alicdn.com`/`o.alicdn.com` 脚本分发）：收**产品版本 + 平台 + 更新检查行为**。

**不上传清单**（负面结论，同重要）：硬件标识（MachineGuid/主板/序列号）不进任何业务请求（39 §4）；凭据明文只在认证头形态出现且遥测通道有脱敏黑名单 `RFs`（authorization/cookie/x-api-key/x-client-sig/x-off-peak-ticket-id 被剥，26 §1）；`GetVolumeInformation`/`baseboard` 在 3.15.1 全产物 0（45 §2.4）。

## 1. 通道矩阵

| # | 通道 | 端点 | 时机 | 上传内容 | 设备相关 | 级 | 出处 |
|---|---|---|---|---|---|---|---|
| C1 | 业务请求公共头 | zcode/api 域名全部 | 每请求 | `User-Agent: ZCode/<ver>`、`HTTP-Referer`、`X-Title`、`X-ZCode-App-Version`、`X-Platform`（`win32-x64`）、`X-Release-Channel`、`X-Client-Language`、`X-Client-Timezone`、`X-Os-Category`、`X-Os-Version`（`platform.version()`）、`X-Device-Mid`、`x-request-id` | **deviceMid + OS 版本 + 架构** | A | 08 §2 实录 + 39 §1 |
| C2 | 认证头 | 同上 | 每请求 | Bearer `zcodejwttoken`（免费）/ `x-api-key`+`Authorization`（付费）/ `zcode-api-key`（API key 解析） | JWT payload 含 user_id | A | 02/08 |
| C3 | 模型请求体 | `zcode-plan/anthropic/v1/messages`（免费代理）等三协议 | 每条消息 | **system 身份块**（Agent Identity + Harness + Environment Info——内含 **cwd 绝对路径、git 仓库标志、platform、shell、OS 版本、providerId/modelId 行**）、`metadata.user_id`（`{device_id: deviceMid, account_uuid:"", session_id}`）、messages 全文、tools 定义 | **工作区路径+deviceMid+会话 ID** | A | 08/18 §1-2 + 37 §8.2（开源 `anthropic-request-metadata.ts` 源码级） |
| C4 | 验证码头 | 免费代理 | start-plan 每请求 | `X-Aliyun-Captcha-Verify-Param`（一次性）、`-Region` | param 与阿里云指纹会话绑定 | A | 12/45 §2.3 |
| C5 | trace 三件套 | 免费代理 | start-plan 每请求 | `x-request-id`/`x-zcode-session-type`/`x-zcode-trace-id`（**不发** `x-query-id`/`x-session-id`，发错触发 3012——历史归因见 37 §8.2） | 会话拓扑 | A/B | 37 §8.2 旁证 |
| C6 | V4 签名头 | 付费通道（gate 开时） | 每请求 | Ed25519 签名 7 头（`x-client-sig-*` 族）+ PoW | 客户端身份密钥证明 | A | 05 |
| C7 | off-peak 票据 | off-peak 代理 | 每请求 | `x-off-peak-ticket-id` | — | B | 06 |
| C8 | 计费/领取 | `billing/preview·claim·balance·current` | 交互/轮询 | claim 体 `{plan_id}` + 验证码头；preview 仅 Authorization | — | A | 11/03 |
| C9 | 支付 | `/api/biz`、`/api/pay` 族（`create-sign`/`check`/`product/info`/batch/zai-preview） | 订阅操作 | productId、`invitationCode`、`imRef`、`ticket`、`randstr`、`salesChannel`（默认 "zcode"）、payType/ALI | 账号绑定 | B/A | 29/45 §2.5 |
| C10 | OAuth/登录 | `cli/init·poll`、`/auth/z/login`、bigmodel 授权码 | 登录/刷新 | user_id、code、client_id | **设备名进 bigmodel 授权页**（"AtomCode-xx · ZCode"形态，登录页可见） | A | 10 |
| C11 | 配置轮询 | `client/configs`（60s）、`agent/configs`（1h） | 周期 | 仅身份头 | — | A | 12 §1/05 §1 |
| C12 | 内置资源刷新 | `zcode-builtin-refresh.json` + CDN `fetchRelease` | 周期 | `platform=windows-x86_64` 参数 | OS 架构 | B | 26 §3 |
| C13 | 更新检查 | `app-update.yml` 的 **generic provider**，`url: http://localhost:8081` 为**官方出厂内置**（10-14 定论：官方构建出厂自带、跨版本逐字节一致，见 44 §1.6；本机监听者恰为 zcode-switch，属适配非篡改）；供更信任链落在「谁占 8081」，electron-updater 仅校验同源 sha512；产物下载源 `https://cdn-zcode.z.ai/zcode/electron/releases`（out/main 伴生块出厂字面量，38 号 §3 的 cdn 域就此实锤）；~~Keygen~~ | 周期 | 产品、channel、当前版本 | 装机身份 | B（**10-14 改判**：`keygen.sh` 全包仅 1 处，在 `node_modules/electron-updater/out/providers/KeygenProvider.js` 库自带可选 provider；ZCode 自有四束 0 引用——26 号旧述「Win 更新后端=Keygen」为误读） | 26 §3 更正/44 §1.6 |
| C14 | 云会话/远程 | REST `zcode.z.ai/remote/v4`；relay WS 选择链 `GZi`（cjs @769264）：overrideUrl > **国内家族线（endpointOrigin=bigmodel 侧）→ `wss://zcode.chatglm.site/ws`** > 默认 `wss://zcode.z.ai/ws`（@771836 `smr`）——**两域名是两族线路由，非口径冲突（10-14 定论）** | 远程功能开启时 | 会话增量帧 `v4/conversation/frame`（**对话内容**）、`workspace-config/<…>`（工作区配置）、`v4/telemetry/event`、**`v4/telemetry/local-ttft`**（本地首 token 延迟直报）、`v4/cua/permission-observation`（Computer Use 权限观测） | 工作区键+会话+性能 | B | 17/26/46 本轮 |
| C15 | 附件管线 | `v4/attachment/begin→chunk→commit` | 上传附件时 | 文件分块（≤64 chunks/64MB） | — | B | 26 §4 |
| C16 | 反馈工单 | 反馈上传（`upload-credential`） | 用户提交时 | **全量打包 `~/.zcode/v2` + `cli/rollout`（全部聊天）+ `tasks-index.sqlite` + `about.txt`** | deviceMid、路径、日志、完整对话 | A | 40 |
| C17 | ARMS RUM | `si.init` 配置面 @main @50404（B）：`enable: Ms!==""`（**endpoint 常量非空才启用**，Ms 构建期注入）、`sessionConfig.sampleRate:1` **全量采样**、`collectors:{jsError,consoleError,crash,application,api,rpc}`、`browserCollectors:{perf,webvitals,exception,whiteScreen,api,staticResource,click,longTask}` 全开、`app:{name,version,env,type:"electron",framework:"react"}`、**`user:{name:r_}` 附用户身份字段**、`tracing` 段尾未采全；**10-14 补**：endpoint=`Ms`=硬编码 xtrace RUM URL（chunk-KL4L7SET 导出 q；workspace=智谱云账号 UID 1936221977589032，service_id `j2c03hoppk@7023210754a92ac5d1971`，**打包版恒非空=出厂启用**）；tracing 采样 prod 0.1/非 prod 1；`useReporter` 钩子记录投递回执、`beforeReport` 对 native crash 补 crash_id/telemetry_schema_version（26 §1） | 周期/事件 | 前端性能/行为/`aliyun_captcha_verification` 自定义事件；头经 `RFs` 脱敏 | 浏览器环境信息+用户名字段 | B | 26 §1/46 本轮 |
| C18 | **OTLP 模型遥测管线（ZCode 自有，构造已取穿）** | 端点**仅读本地 env**（`FOn`：TRACES_ENDPOINT ?? ENDPOINT+`/v1/traces`；`znc`：METRICS ?? +`/v1/metrics`）；CLI cjs 无内置默认（OTEL_* 赋值位 0 命中）；**但桌面伴生块出厂内置一块 OTEL 默认 env**（xtrace endpoint + x-arms headers + `zcode-cli-agent` + packaged，26 §1）——向子进程的注入链未证实（装配时真实 env 后置覆盖）→ 定性：默认值存在，开关仍看本地 env | 启用时 `createOwnedAgentTelemetryRuntime` 建 span/metrics，shutdown 1500ms（`WIt`）；调用方 `XEt(e=process.env)` 合入 `ZCODE_APP_VERSION` | 资源属性：`installationId=deviceMid`、`serviceInstanceId=每启 randomUUID`、`serviceName: OTEL_SERVICE_NAME??"zcode-cli-agent"`、buildCommitId/cliVersion/deploymentEnvironment/RUNTIME_SURFACE/RUNTIME_DISTRIBUTION + 白名单六件套 `ZCODE_TELEMETRY_{DEVICE_MID,USER_ID,USER_ID_HASH,USER_SUBJECT_ID,IDENTITY_STATE,…}`；实现 `vYo/$nc/FOn` @cjs 13.99M | **deviceMid+用户身份（hash/subject 双形态）** | B 静态全链 + A 本机未启用（env 扫描 0） | 46 本轮 |
| C19 | **桌面 main 独立 OTLP 导出（本轮新发现）** | `OTLPTraceExporter`/`OTLPMetricExporter`+`MeterProvider`+`PeriodicExportingMetricReader` @main @8237；span 构于 @6225：scope `"@zcode/local-ttft" v1`，`first_output` 事件→`local_ttft` span（attributes+resource 合并） | 启用时（端点默认值与 C18 同块同源：chunk-HH7N2YVI 的 `/apm/trace/opentelemetry`；实际注入门未证实） | 每回合 TTFT span | 会话级性能 | B | 46 本轮（与 C18/17 §1 local-ttft 呼应） |
| C20 | **ProjectAccessToken 链（凭据第四形态，10-14 新登）** | host 束内 `ProjectAccessTokenCache` 体系（两版 host 束同存，此前未收录）：`{location}/{apiKeyId}/access_tokens` POST（体 `{clientType:"zcode", clientVersion}`）换项目级访问令牌；scope 校验 `GET {r}/api/biz/customer/getCustomerInfo` 比对 `organizations[].projects[]`（team 模式需 organizationId+projectId 双匹配，否则 `project_token_project_unavailable`）；错误码族 `project_token_scope_invalidated/invalid_response/transient_failure/token_login_required`；404 自动 eviction+locationStore.delete | 项目 API key 使用时 | clientType/版本/组织项目归属查询 | 项目/团队拓扑 | B（静态实据；两版 host 束同存，本机 asar 可重抽：`asar_pick get out/host/chunk-MR7X55B4.js`） | 46 本轮 |
| O2 | **内网/studio 机器面（非上传，主动探测）** | `INTRANET_MACHINE_HOST` env 可覆盖，默认 `studio.zcode-ai.com`；拼装 `http://{host}:12345/zcode`、`/zcode/deps`、`http://{host}:3850/api/intranet/probe`（另 `coding_plan_system_busy` 错码同块）——38 号 §3 外部报告列的 `studio.zcode-ai.com` 域名就此**客户端实锤**（原「待验证后并入」现结） | host 解析时 | 探活请求（出方向） | 内网可达性 | B | 46 本轮/38 §3 |
| A1 | 阿里云验证码/指纹（**单一接收方=SAF 产品线，双通道域组；10-14 修正「三家」口径**） | 业务 RPC 组：`no8xfe.captcha-open.aliyuncs.com`（InitCaptcha/V2/V3、VerifyCaptcha*；1.0 走 `captcha-pro-open.*`）；**设备通道域组**（`Mr()`→`Hr()`，互备用端点）：cn=`cloudauth-device-pre.aliyuncs.com` ⇄ `pre-cn-shanghai.device.saf.aliyuncs.com`，sgp=`cloudauth-device-pre.ap-southeast-1…` ⇄ `pre-ap-southeast-1…`（另见 O1 的 dualstack/ga 变体）、`static-captcha.aliyuncs.com`（题图）、`g.alicdn.com`（`FeiLin/<ver>.js`、`aliyunFP/fp.min.js`、dynamicJS 动态包） | SDK 初始化/验证/上报 | **InitCaptcha `Data`=双层 AES-128-CBC 六元组**（外层 REQ 密钥：`appKey#WEB#内层FLAG密文#APP_VERSION#CLOUD#`；内层 FLAG 密钥：承诺串 `PLATFORM#appName#sceneId#captcha-{front\|normal}#prefix#region`）+ 明文参数 `AaduaneId=KEY_ID`、`Version=2020-10-15`、`SignatureMethod=HMAC-SHA1`、`Signature`、`SignatureNonce`；**UploadLog `logInfo` 明文 JSON**（`sId/pfx/cId/hst/ip/js/bInit/mInit`+计时点 10-23，走业务通道 jr()）；飞廉按 `DeviceConfig` 三清单（`pluginElements`/`pluginResource`/`globalVariable`）执行浏览器指纹采集（canvas/WebGL/字体/插件等）→ 产出 `deviceToken`（`SG_WEB#deviceId32hex-h-<ms>-uuid32hex#158B 加密体#0#校验`） | **这是最重设备面**；公网 IP 由服务端在 `DeviceConfig.ip` 回写、客户端再在 logInfo 回报（`xe("ip",…)` 链路） | A/B | 12 §5c.5/§5d/§5f/§5l |
| A2 | 登录页指纹 | `no8xfe.captcha-open.aliyuncs.com` SceneId=**36qgs6xb**（登录页） vs **11xygtvd**（产品内） | 登录时 | 同 A1 机制 | 独立 sceneId 通道 | A | 39 §3/12 §1 |
| A3 | ~~SAF 设备风控端点族~~ **改判并入 A1（10-14 二次核验）** | `*.device.saf.aliyuncs.com`（含 pre-/ga-/dualstack 变体）——**不是独立上传通道**：12 §5l.2 设备指纹端点表里它就是 `cloudauth-device-pre.*` 的**同通道备用端点**（cn 主=cloudauth-device-pre，备=pre-cn-shanghai.device.saf；`Yr()`/-b 机制决定实际命中，logInfo 记 bInit/mInit）；appName 本身就叫 **`saf-captcha`**（1.0 为 `saf-captcha-waf`）——验证码产品线内建于 SAF 风险识别引擎 | 同 A1 | **字段集与 cloudauth-device 完全同构**（同一 `Rr()/Hr()` 拼装器），无任何独有字段 | 设备级 | A/B | 12 §5l.2/§5l.3/46 |
| O1 | **main 束观察面（非上传）** | `ET` 集合 @main @1952：9 主机全量 = cloudauth-device-pre ×2 + **cloudauth-device-dualstack.cn-shanghai / .ap-southeast-1**（SDK v1.3.4 表里没有）+ device.saf ×5；`Wg()` 归类 `device_api`/captcha-open 族；`dd()` 挂在 `subscribeBeforeRequest(*.alicdn/*.aliyuncs)` 上做 **300s/128 条观测缓存**——即 12 §5n `[captcha-network]` 子系统的实现体，**只观测不上传** | 被动 | 主机/路径/耗时/状态 | — | B | 12 §5n/46 本轮 |

## 2. 设备数据专列（回答"到底上传了设备什么"）

| 数据 | 产生处 | 去向 | 强/弱 |
|---|---|---|---|
| `deviceMid` 随机 UUID | `telemetry-state.json`（删即重置） | **C1 每请求头 + C3 metadata.user_id + C14 relay URL + C16 工单过滤** | 弱标识、高频出现 |
| OS 版本/平台/架构/时区/语言 | `platform.version()` 等 | C1 头族 + C3 env 块 | 中 |
| 工作区绝对路径（cwd） | 会话运行时 | C3 身份块明文字段 + C14 workspace-config | **中（可定位目录结构）** |
| 浏览器/渲染环境指纹 | 阿里云 SDK 合成（canvas/WebGL/字体/插件…，清单由 DeviceConfig 下发） | A1 加密上行 | **强（L3）** |
| 公网 IP | 阿里云侧判定 → `DeviceConfig.ip` 回写 → logInfo 回报 | A1 | 强 |
| deviceToken（5 段，deviceId 与 DeviceConfig key 同源） | 飞廉 SDK | A1 上行 + param 解码可见 | 强 |
| 硬件标识（MachineGuid/主板/序列号） | 未采集进业务面 | **不上传**（39 §4 双端核对） | — |

## 3. 跨重装存活性汇总（"device 级"的技术定义，10-14）

| 标识 | 存得过 10-10 重装吗 | 谁在用 |
|---|---|---|
| `deviceMid` | ❌ 新随机 UUID（已实测换代） | C1/C3/C14 |
| JWT/登录态 | ❌ 重新签发 | C2 |
| hostname / MAC / 序列号 / BIOS | — **未见采集**：3.15.1 重扫 `hostname`（全为 URL 校验噪声）、`getmac`/`smbios`/`machine-id`/`IOPlatformUUID` 全落 vendored 不执行带（systeminformation/OTel），host/main 无身份用途调用 | — |
| **阿里云 L3 指纹（deviceToken/Data）+ SAF 设备 API（A3）** | ✅ 天然跨重装（硬件/环境合成特征） | A1/A2/A3 |
| 出口 IP + TLS 指纹 | ✅（除非换网） | 网关侧 |
| 行为节奏（请求模式/实验流量史） | ✅（存在服务端口径） | 判定引擎 |

→ 机主口径的「device 级封禁」在技术上只能落在最后三行；前三行已全部排除。**补（10-14）：SAF 并入 A1 后，跨重装设备关联的全部承载＝阿里云栈（captcha-open + cloudauth-device + 同集备用 device.saf 端点）+ IP/TLS/行为；main 侧 `ET/Wg/dd` 为纯观测面（O1），设备标识的生成与存储都在 SDK/飞廉内部，产物内只有 appKey 明文与加密上行，无本地持久化设备指纹文件。**

## 4. 与风控判定（3007/3012）的关系

37 §8.5-A 的门模型对应到通道：**判定输入 = C1（每请求身份）× C4（param 核销结果）× A1（阿里云双域组通道上的指纹分）× 行为节奏**；C3 身份块构成"请求构建层"检查（历史 3012 主因）；判定输出全部在推理网关（其余通道不受门：C8/C11 实测正常）。**"掐过采集"之所以危险：A1 设备通道域组断流本身就是行为异常信号**（37 §8.5-B logguard 条目；hosts 钉的 `cloudauth-device-pre` 恰是设备通道 cn 主端点，备用 saf 端点当时未钉——故未完全断流，只造成双端点降级路由）。

## 5. 口径冲突与未决（如实记录）

1. ~~relay WS 域名两处记载~~ → **已定论（10-14，§1 C14）**：`GZi` 三择——override > 国内家族线 `chatglm.site` > 默认 `zcode.z.ai`，两域名是线路由非矛盾。
2. `X-Os-Version` 桌面头实测为 Windows `platform.version()`（如 `10.0.26100`），C3 env 块的 `OS Version` 行为 CLI 自采——两处并存非矛盾。
3. **改判（10-14）**：遥测 `event/report`——旧述「官方产物 0 命中」只查了 CLI 四束；桌面 main 伴生块 KL4L7SET 内有常量 `Kk=https://zcode.z.ai/api/v1/event/report` 与开关 `Hk=!0` 且导出给 main/index，但 out/main 全量扫**无调用点**（疑 renderer 侧消费，未展开）——属官方产物面存在、发送方与载荷未证；「仅第三方切换器在用」口径作废，待 renderer 束展开后终判。
4. ~~ARMS 具体上报 endpoint/字段明细未逐包还原~~ → **endpoint 已闭环（10-14，out/main 全 124 件扫描）**：`si.init` 的 `Ms` = chunk-KL4L7SET 导出 q = 硬编码 xtrace RUM 端点（全文见 26 §1/C17），打包版出厂启用；字段 payload 明细层仍 B 级，剩余 = @arms SDK 内部实现，非客户端字段缺口。
5. **已闭环（10-14）**：39 号 §4.2 遗留的「CLI 侧 HostDetector 是否执行」问号——**判定为无执行路径**：`detectResources` 全束 6 处、`hostDetector` 14 处，vendored 带（cjs 13.627M–13.646M）**外引用均为 0**；带外仅 OTel SDK 自身 MeterProvider/NodeSDK 构造器的 `defaultResource()` 兜底 2 处，而 2.x 的 defaultResource 探测器集不含 hostDetector——**machine-id（MachineGuid）不进入任何上传**；同时新发现 C18 自有 OTLP 管线（默认关，本机未启用）。
6. **已闭环（10-14）**：曾疑「桌面端 asar 完整性校验会把本机 log_guard 补丁作为篡改信号暴露/上报」。rea-agents 6.4.0 对 `C:\Program Files\ZCode\resources\app.asar` 实跑 `analyze-javascript-application --integrity-policy record-and-continue`：唯一不匹配点是解包条目 `node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node`（声明 sha256 `879dd94c…` ≠ 实算 `19f33155…`）；而实算值 = **磁盘字节的完整 sha256**（证据件现存 `re/conpty_evidence/conpty_console_list.node`），且 app.asar mtime=装机时刻从未变（44 §1.5/§1.6）——**未经本机改动的官方原包同样不通过自身完整性校验**；官方报错文案自供原因：打包器写档后对解包原生二进制签名/剥离。定性：本机补丁不会也无法通过该机制被区分；且这是本地校验，不在任何上传通道（C1-C20 无对应字段）——从暴露面嫌疑名单移除。
