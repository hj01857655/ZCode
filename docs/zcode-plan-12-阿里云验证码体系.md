# 12 · 阿里云验证码体系（X-Aliyun-Captcha-Verify-*）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 消费方：[08 §1.2 模型请求](zcode-plan-08-聊天对话接口.md)、[11 §2 领取接口](zcode-plan-11-签到领取接口.md)
> 证据：app.asar 渲染层/host 验证码模块（原始函数名与常量齐全）+ `client/configs` 实测 + SDK 静态样本 `%TEMP%\aliyun_captcha.js`（273,948 B）+ **服务端下发的动态包 `captcha-frontend/dynamicJS/3.29.0/pe.089.*.js`（447,993 B，已实包抓取）**
> 配套工具：`_re/`——5 套字符串表解码器、去混淆器、`WEB_AES_SECRET_KEY` 提取与校验脚本、`Cr()` 签名复现、端点表汇总、**实包发送器 `send_init_captcha.js`**、动态包审计器（见 [§5c.6](#5c6-复现) 与 [§5m](#5m-实包验证initcaptcha-已跑通与动态包定位)）

> **§5 各小节按主题索引**（编号沿用历史锚点，物理顺序不按编号）：
>
> | 主题 | 小节 |
> |---|---|
> | SDK 内部结构 | [5b](#5b-sdk-内部解剖对-aliyuncaptchajs-的静态分析) param 真实结构 / certifyId 状态机 / 采集三层次 |
> | 静态加密层（`WEB_AES_SECRET_KEY`） | [5c](#5c-静态加密层完整还原web_aes_secret_key) 混淆方案 → 配置 → KDF → 解密结果 → 采集链路 → `Cr()` 签名 → [5j](#5j-去混淆工具链四张字符串表) 工具链 |
> | DeviceConfig | [5d](#5d-deviceconfig-解密与消费schema-已还原) 解密管线 / 九字段 / 消费链 `rn()` |
> | 响应与上报 | [5e](#5e-验证响应-schema-与-sr-解析) 验证响应 `Sr()` ／ [5f](#5f-日志上报链与-upload-preid-的结论) 上报链 / `logInfo` / `UPLOAD`+`PREID` |
> | `verifyType` 分支 | [2.1](#21-verifytype-的隐式改写) 隐式改写 ／ [2.2](#22-mode-与-region-的取值域cn-白名单) 取值域 ／ [5k](#5k-verifytype-10-的兜底与回调链) `"1.0"` 回调链 |
> | 端点与应用身份 | [5l](#5l-端点表-应用身份表) RPC 端点 / 设备指纹端点 / `appName`+`appKey` / CDN 表 |
> | 请求构造与调度 | [5g](#5g-请求调度分发管线nr-jr-hr-lr-拓扑) 分发器 `Nr()` / 调用点 / 响应解析 / 底座 `Gr()` ／ [5h](#5h-initcaptchav2-v3-请求体拼装en-落地) `en()` 拼装 ／ [5i](#5i-powverifystring-question本样本零消费) 零消费字段 |
> | 实包验证 | [5m](#5m-实包验证initcaptcha-已跑通与动态包定位) `InitCaptcha` 跑通 → 动态包 CDN → PoW 引擎 → 字符串表 → 挑战串来源 → 端到端闭环 |
> | 客户端诊断 | [5n](#5n-客户端验证码诊断子系统) `captcha-diagnostics` / `captcha-network` / `F008` / 基线 |

## 0. 结论先行

两个头：

```
X-Aliyun-Captcha-Verify-Param: <captchaVerifyParam>   # 阿里云验证码令牌（SDK success 回调产物）
X-Aliyun-Captcha-Verify-Region: cn                    # 验证码服务域（可选，来自配置）
```

**param 的来源**：客户端加载阿里云 Captcha 2.0 JS SDK → 用远端下发的 `{region, prefix, sceneId}` 初始化 → **优先跑"无痕验证"（traceless，无需用户交互）** → SDK `success` 回调给出一次性 `captchaVerifyParam` 字符串 → 由服务端向阿里云核销。正常情况下用户全程无感；无痕失败才弹交互式拼图（120s 超时）。

**加密层的状态**：SDK 设备指纹采集的上行 `Data` 字段是**双层 AES-128-CBC + HMAC-SHA1 签名**；其全部密钥（`WEB_AES_SECRET_KEY` 5 项、`KEY_ID`、`KEY_SECRET`）、IV 派生方式与调用链，已从 bundle 中还原为明文并逐条验证 → 见 [§5c](#5c-静态加密层完整还原web_aes_secret_key)。**注意：实测发现 `DeviceData` 并非发请求的必要条件**——加密层服务于设备指纹采集与风控，不是业务鉴权 → 见 [§5m.2](#5m2-跑通结果协议全部实测通过)。

**协议已实包跑通（不止静态推导）**：本文档还原的 `jr()` 流程已被 `_re/send_init_captcha.js` 真实调用验证——13 个参数 + `Cr()` 签名，服务端返回 `Code:"Success"` 与 `CertifyId`。签名算法、响应判定、端点表均经实测确认，不是读码结论 → 见 [§5m.2](#5m2-跑通结果协议全部实测通过)。

**PoW 已定位并完整解出**：工作量证明**不在 SDK 本体内**（`PowVerifyString` 在本 bundle 仅 1 次命中、纯解包透传），而在**服务端下发的动态包**中，入口是 `startPOWCalculation()`。动态追踪实证：**`SHA256(<挑战串> | <16位随机hex nonce>)`，digest 首字节为 `0x00` 即通过（难度 2^8）**；`getResult()` 返回 Promise，resolve 值即胜出 digest → 见 [§5m.7](#5m7-pow-算法动态追踪实证_retrace_powjs)。

> 两个曾经的误判：① `SHA1`/`Hex`/`Pkcs7` 不是 PoW 选的哈希，而是**SDK 内嵌的 CryptoJS** 的导出 API 名——SDK 把它发布为 `window.__ALIYUN_CRYPT`，动态包只是消费者（见 [§5m.8](#5m10-__aliyun_crypt-的来源sdk-本体已查实)）；② "真实 SHA256 下迭代 0 次"并非技术分叉，而是我的桩把日志绕过了。算法已完整解出并由 `_re/solve_pow.js` 以 13 项断言实测校验。

## 1. 配置来源（client/configs）

`GET /api/v1/client/configs`（公开接口，`credentials: omit`）→ `data.configs.captcha`：

```json
{"enabled": true, "prefix": "no8xfe", "region": "cn", "sceneId": "11xygtvd"}
```

（实测 2026-09-26；`prefix`+`sceneId` 是阿里云验证码的站点标识，任何接入该 SDK 的页面都可见。）

- 客户端 60s 缓存（`f3`：`{value, expiresAt: now+6e4}`）。
- 失效判定 `p3`：`enabled === false` 或缺 `region`/`prefix`/`sceneId` 任一 → 视为关闭（跳过验证码头）。
- 同一 configs 还下发整个远端配置面：`builtin_provider_config_json`、`offPeak`、`startPlanPreview`、`dynamicWorkflow`、`computerUse`、`codingPlanStaticProducts` 等。

## 2. SDK 接入（渲染层）

- 脚本：`https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`（单例加载，10s 实例超时 `W4=1e4`）。
- 全局：`window.AliyunCaptchaConfig = {region, prefix}`。
- 初始化（`nnn`）：

```js
window.initAliyunCaptcha({
  SceneId: config.sceneId,
  mode: config.mode ?? "popup",
  language: "cn" | "en",               // knn(): zh-CN→cn，en-US→en，其余按 navigator.language
  captchaLogoImg: <内嵌 base64 png>,
  showErrorTip: false,
  element: "#zcode-aliyun-captcha-element",     // 隐藏容器 DOM（zcode-aliyun-captcha-container/element/button）
  button: "#zcode-aliyun-captcha-button",       // 1px 隐形按钮，程序化触发
  getInstance,   // 实例就绪（具备 show() 与 startTracelessVerification()）
  success,       // param: string ← captchaVerifyParam 的唯一来源
  fail, onError
})
```

### 2.1 `verifyType` 的隐式改写

`initAliyunCaptcha` 的入口对 `verifyType` 有一处**未在文档中体现的强制覆盖**：

```js
var zn = document.getElementById("waf_nc_block");      // 阿里云 WAF 注入的隐藏节点
var Ln = zn ? "1.0" : (On.verifyType || "2.0");        // ★ 命中即强制降级到 1.0
```

- 只要页面上存在 `#waf_nc_block`，无论宿主传的是 `"2.0"` 还是 `"3.0"`，实际生效的都是 **`"1.0"`**——即 `InitCaptcha` + `MD5(userUserId)` 前缀隔离那条分支（[§5h](#5h-initcaptchav2-v3-请求体拼装en-落地)）。
- ZCode 自身不注入该节点，故走默认 `"2.0"`。但若 ZCode 页面被嵌入到带阿里云 WAF 防护的宿主里，行为会静默改变——**这是排查"同一份代码在不同宿主下验证码形态不一致"的第一嫌疑点**。
- `Ln` 同时作为键去取 `Ft.appName[Ln]` / `Ft.appKey[Ln][Pn]`，所以改写会连带切换应用身份与端点（`be(secEndpointType, Ln, Pn)`）。

#### `Se(config)`：`initCaptcha` 的 `verifyType` 权威决策

除了上面那处 WAF 强改，真正决定 `verifyType` 的是 `Se()`（`initCaptcha` 入口，offset 272464 处调用）：

```js
function Se(t) {
  if (t.userId || t.userUserId || !t.success || typeof t.success !== "function" || t.verifyType === "1.0") {
    // 任一条件命中 → 保守分支
    return (t.verifyType === "1.0" && t.success && typeof t.success === "function"
            && t.userId && t.userUserId) ? "1.0" : "2.0";
  }
  // 唯一能到 3.0 的路径: verifyType 非 1.0 + 有 success 回调 + 无 userId/userUserId
  re._extend({ immediate: true, UserCertifyId: t.UserCertifyId });
  return "3.0";
}
```

判定表：

| 条件 | 返回 | 副作用 |
|---|---|---|
| `verifyType === "1.0"` **且** 有 `success` 函数 **且** 同时有 `userId` + `userUserId` | `"1.0"` | — |
| 其余落在保守分支的情形（含 `verifyType === "1.0"` 但缺 `userId`/`userUserId`/`success`） | `"2.0"` | — |
| 无 `userId` / 无 `userUserId` / 有 `success` / `verifyType !== "1.0"` | `"3.0"` | `immediate = true`，写入 `UserCertifyId` |

两个容易踩的点：

1. **传了 `verifyType: "1.0"` 但没同时给 `userId` 和 `userUserId`，会被静默降到 `"2.0"`**——因为 §5h 里 1.0 分支的 `MD5(userUserId)` 前缀没有输入。
2. **3.0 分支会强制 `immediate = true`** 并回填 `UserCertifyId`，即 3.0 走的是"立即验证"而非弹窗交互。

### 2.2 `mode` 与 `region` 的取值域（`Cn()` 白名单）

配置归一化函数 `Cn()` 用 `errorType` 逐字段校验，其中两项是**枚举白名单**：

| 参数 | 白名单 | 错误类型 | 消费点 |
|---|---|---|---|
| `mode` | `["popup", "embed"]` | `modeError` | `en()` 写入请求体 `Mode` 字段 |
| `region` | `["cn", "sgp", "ga"]` | `regionError` | 端点选择 + `Sr()` 的 `imgServer[region]` |

白名单常量定义：``bn = ["cn", "sgp", "ga"]``（region）、``Sn = ["popup", "embed"]``（mode）。校验失败即抛 `paramsError` / `modeError` / `regionError` / `languageError` / `elementError` / `paramsError`，由 `onError` 上抛。

> 与 [§5e](#5e-验证响应-schema-与-sr-解析) 呼应：`region` 取值越界时 `Sr()` 里的 `j = j[F]` **不抛错**，静默得到 `undefined`；而 `Cn()` 会在更早的入口阶段就拦下。两道防线位置不同，排查时别混淆。

## 3. param 生命周期（编排器 `Mnn`/`Fnn`）

```
send_preflight（每次 start-plan 模型请求前）
  ① f3 读 configs.captcha（60s 缓存）→ 关闭则跳过
  ② 全局串行队列（jnn，验证码尝试互斥）
  ③ onn: SDK startTracelessVerification() 无痕验证
       ├─ 通过 → success(param)          # 常态，用户无感
       └─ 需交互 → onInteractiveChallenge → 弹 popup（allowInteractive + 120s 超时 Htn=12e4）
  ④ Enn(providerId, param)                # 按 providerId 缓存（Snn Map）
  ⑤ 随 runtime-headers RPC 下发给 agent → 合入模型请求头
  ⑥ 请求发出后 Dnn(providerId) 删除缓存   # 单次有效，不可复用
```

- **单次性**：param 用后即删；`certifyId` 与上一轮相同会告警"可能触发 F008 重复提交"（阿里云侧一次验证只允许核销一次，`F008`/`重复提交`/`只允许提交一次`）。
- **通过判定**（`Y4`）：`success && verifyResult` 或 `verifyCode === "T006"`；`success && !verifyResult` = 待升级/失败态。
- **无浏览器环境**（纯 headless/CLI）：`CaptchaInteractiveRequiredError`（`CAPTCHA_INTERACTIVE_REQUIRED`）——这正是脱离 IDE 复刻请求停在 3007 的根因。
- 触发源 `source`：`send_preflight`（发消息前预取）| `captcha_retry`（服务端打回后重试）。

## 4. 下发到模型请求（host ↔ agent RPC）

agent 每次模型请求前向 host 请求运行时头，host 响应（`respondProviderRuntimeHeaders`）：

```jsonc
{ "headersApplied": true,
  "requestAuth": {
    "apiKey": "<zcodejwttoken>",                 // start-plan 通道凭证（见 08 §1.2）
    "headers": {
      "X-Aliyun-Captcha-Verify-Param": "<param>",   // 仅这两个头被白名单透传
      "X-Aliyun-Captcha-Verify-Region": "cn"
    } } }
```

host 侧仅放行这两个头名（大小写不敏感匹配），其余 runtime headers 一律丢弃。UI（领取弹窗）则直接把 param 放进 `claimManualPlan({planId, captchaVerifyParam, captchaRegion})`。

## 5. 服务端核销与错误谱系

| 场景 | 表现 |
|---|---|
| 请求缺/错 param | `HTTP 400 {"code":3007,"msg":"captcha verify failed"}`（模型代理，实测）；claim 同理 |
| param 重复核销 | SDK `fail` 回调 `F008` → 客户端强制重新预取 |
| param 服务端核销 | 阿里云 VerifyIntelligentCaptcha 接口（服务端↔阿里云，客户端不可见） |
| 需要交互但环境不允许 | 客户端 `CAPTCHA_INTERACTIVE_REQUIRED` |

遥测：ARMS 自定义事件 `aliyun_captcha_verification`（group `captcha`，result: `traceless_passed`/`interactive_displayed`/`interactive_passed`）；`[captcha-diagnostics]` 诊断日志（attempt 上限 32）。

## 5b. SDK 内部解剖（对 `AliyunCaptcha.js` 的静态分析）

对 `https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`（222 KB，webpack 打包）的静态分析结论（版本串勘误见 [§5c.7](#5c7-正确性证据)）：

### param 的真实结构

```js
// 客户端拼装（pn 函数），X-Aliyun-Captcha-Verify-Param 的值就是它：
JSON.stringify({
  sceneId:     <SceneId>,          // "11xygtvd"
  certifyId:   <验证会话ID>,        // 来自阿里云验证请求的响应
  deviceToken: <设备令牌>,          // window.z_um/um.getToken()（UMID 设备指纹 SDK）；无则省略
  failover:    "T",
  err:         <可选，失败信息>
})
// verifyType 3.0 的变体: btoa(JSON.stringify({certifyId, sceneId, isSign:true}))
```

### certifyId 的签发与会话状态机

- SDK 向 `{prefix}.captcha-open.aliyuncs.com`（生产域由 prefix 拼）发起验证请求，响应字段（明文可见）：`Success`、`CertifyId`、`LimitFlow`、`LimitedFlowToken`、`Question`、`PuzzleImage`、`PowVerifyString`、`DeviceConfig`。
- `LimitedFlowToken`（限流令牌）会顶替 CertifyId；限流时 UI 走失败分支。
- 交互式拼图自带 `PowVerifyString`——**拼图验证含工作量证明**。
- `verifyType` 存在 1.0/2.0/3.0 三代并存（ZCode 走 2.0：`button.onclick` + traceless）。

### 采集数据的三个层次

| 层 | 可见性 | 内容 |
|---|---|---|
| 明文信封 | ✅ 全可见 | SceneId、mode、language、appKey 表（按 版本×地域）、CDN/端点路由（`cdnServers`、`secEndpointType`）、UMID token 引用 |
| 加密采集 | ✅ **已完整还原**（[§5c](#5c-静态加密层完整还原web_aes_secret_key)） | 设备采集模块内置 `WEB_AES_SECRET_KEY`/`KEY_ID`/`KEY_SECRET`/`DEVICE_TYPE`——`Data` 字段双层 AES 加密 + HMAC-SHA1 签名；密钥与算法均已解出并逐条验证 |
| 服务端驱动 | ✅ **Schema 已还原**（[§5d](#5d-deviceconfig-解密与消费schema-已还原)） | `DeviceConfig` 是 **RES 密钥 AES 解密后的 `#` 分隔 9 字段**（key/switch/sessionId/version/pluginElements/pluginResource/globalVariable/timestamp/ip）→ 三份采集清单交给飞廉（FeiLin）脚本执行。字段集合与资源路径固定，随服务端变化的只是取值与清单**内容** |

明文层可见的浏览器 API 访问极少（`navigator`、`document.*`、XHR）。加密层本身**已不再是黑盒**（[§5c](#5c-静态加密层完整还原web_aes_secret_key) 解出了全部密钥与算法），但"采集哪些字段、采多细"仍由服务端下发的 `DeviceConfig` 决定——这是该类设备指纹 SDK 的分层设计：**密钥与算法是静态常量（可还原），字段清单是动态配置（随服务端变化）**。

### 与 ZCode 的对接关系

ZCode 的 `success(param)` 拿到的就是上面的 JSON 串 → 包进 `X-Aliyun-Captcha-Verify-Param` 头 → ZCode 服务端解出 `certifyId` 后调阿里云核销。**SDK（阿里云）签发、ZCode 转交、阿里云核销**。

## 5c. 静态加密层完整还原（WEB_AES_SECRET_KEY）

对 SDK 静态样本 `%TEMP%\aliyun_captcha.js`（273,948 B，内置 SDK 版本字段 `VERSION: "1.3.4"`）分析：**加密层无黑盒，密钥、IV、算法、调用点全部还原。**

### 5c.1 混淆方案

单行 webpack bundle（271,750 字符），obfuscator.io 风格，字符串与数值常量全部走查表 + 控制流扁平化。

| 构件 | 字符偏移 | 说明 |
|---|---|---|
| `G(n)` → `rt()` / 表 `Gt()` | 184,231 / 189,548 | 第一套字符串表，下标偏移 **314**（288 项，n ∈ 314…601） |
| `er(n)` → `xr()` / 表 `dr()` | 230,544 / 224,940 | 第二套字符串表，下标偏移 **208**（n ∈ 214…414）；`er = xr` |
| 表轮转自校验 | `}(Gt);` @183,162、`}(dr)` @224,526 | `for(;;){ if (709594 === parseInt(p(552))/1 + …) break; v.push(v.shift()) }` |
| 解密函数 `gr` / 加密函数 `yr`、`_r` | 228,413 / 229,043、231,036 | AES 封装，见 [§5c.3](#5c3-解密算法与密钥派生) |

字符串值是**自定义字母表的 base64**（`abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=`，小写字母在前，非标准序）再套 `decodeURIComponent`，解码结果带缓存。数值常量另用"变量池"（`for (var n = 621, i = 591, …)` + `switch` 分派）隐藏。

还原要点：**必须把轮转 IIFE 一起抠出来执行**，否则字符串表下标整体错位。`_re/tables.js` 做的就是这个：

```js
const { G, er } = require('./_re/tables');
G(314)   // "tK5X1r3E"
er(313)  // "WEB_AES_"
```

### 5c.2 还原出的完整配置

`WEB_AES_SECRET_KEY` 挂在配置对象 `Zt["prototype"]` 上，运行时单例 `ne = new Zt` 经原型链继承（`var re = new Y({}), ne = new Zt;`），故源码里所有 `ne["WEB_AES_SECRET_KEY"]` 取到的就是它。

```js
Zt["prototype"] = {
  API_VERSION: "2020-10-15",   APP_VERSION: "W20220202",
  PLATFORM: "W.10001.c",       APP_NAME: "saf-aliyun-com",
  VERSION: "1.3.4",
  APP_KEY: "ab034ec0643f91399eb33e062dc7fae1",
  DEVICE_TYPE: { WEB: "W" },
  ACTION: { INIT: "Log1", DEVICE_UPLOAD: "Log2", COMBAT_UPLOAD: "Log3" },
  ACTION_STATE: { SUCCESS: "success", FAIL: "fail" },

  // 以下三个字段在源码里都是 base64 密文，不是明文密钥
  ACCESS_KEY: {                                   // 云 API 签名的账号密钥对
    ID:     "tK5X1r3E65gcLeL+GmivL6RuHUa/6AyrEEc+S59NPns=",
    SECRET: "kvqU4wg9JqUyoXqN1pdq9XZ2gkf1oPpJCVdG8Hvkkq4="
  },
  WEB_AES_SECRET_KEY: {                           // 5 组业务 AES 密钥
    REQ:    "8KmHIQsc5+LZJA7uYex3WaHdkjgCtS6epbG/bc9xss0=",
    RES:    "9NhnQQ+LRrKCkAuxwZaUWGBtSzaFtFlNb/ksJCrCgrM=",
    FLAG:   "k+1RW0cz3iDi2RAbC/c3QKzTPiVwNmNO1910DXe6Gas=",
    UPLOAD: "+fR9tYzlKFr07pEbumd7+KnO3xLOkphCS+qKUbJiMfA=",
    PREID:  "xLLw/t15vkI7QQBX/1scBbcb9fKx+ymxF0tJ3ds42B0="
  },
  AES_IV:          "d35db7e39ebbf3d001083105",    // 24 位 hex，IV 需二次派生，见下
  SALT:            "NLAoqT6K03oLbQXW2VS3zA==",
  SESSION_ID_SALT: "X1y5VstbB5zqghyJ9g8a0A==",
  ACCESS_SEC:      "FqJB6iRNVYdEGpwb"             // ↑ 这些密文的解密密钥（16 字节 ASCII）
}
```

原始偏移：`var Xt = {};` @193,979（`Xt` 即 `WEB_AES_SECRET_KEY` 的值）、配置对象 `ACCESS_KEY: Vt, WEB_AES_SECRET_KEY: Xt` @195,552、`AES_IV:` @195,592、`ACCESS_SEC:` @195,701。

### 5c.3 解密算法与密钥派生

`WEB_AES_SECRET_KEY` 的 5 个值**不是密钥，是密文**：44 字符 base64 = 32 字节 = 2 个 AES 块。bundle 内自带解密函数 `gr`（原始偏移 228,413，变量池展开后）：

```js
function gr(t, e) {                                     // t=密钥串, e=base64 密文
  if (e === void 0 || e === null) return null;
  if (t === void 0 || t.length !== 16 || e.length <= 0) return null;
  var b = e, w = Utf8.parse(t);                         // 密钥必须 16 字符 → AES-128
  var S = AES.decrypt(b, w, { iv: Utf8.parse(fr), padding: Pkcs7 });
  return S.toString(Utf8);
}
```

IV `fr` **不是**直接拿 `AES_IV` 用，而是绕了两跳（本文件最容易看漏的一处）：

```js
// 另一处用逗号运算符把前面 6 个干扰串全部丢弃，只留最后一个
var yt = ("DNsKKPRH", "fOTuFph6", "taPHkC+T", "bC6YUaXi", "1NfQv95E", "z2k=", "d35db7e3" + "9ebbf3d0" + "01083105");

var or = tr()["AES"], cr = tr()["enc"]["Utf8"], ur = tr()["enc"]["Base64"], ar = tr()["enc"]["Hex"], sr = tr()["pad"]["Pkcs7"],
    fr = ur["stringify"](ar["parse"](yt)),              // Hex.parse → 12 字节 → Base64.stringify → 16 字符
    lr = { iv: cr["parse"](fr), padding: sr };          // 再当 ASCII 串用作 IV
```

最终等价于：

```
KEY  = ASCII("FqJB6iRNVYdEGpwb")                        = 46714a423669524e5659644547707762
IV   = ASCII(Base64(Hex(AES_IV)))                       = ASCII("0123456789ABCDEF")
                                                       = 30313233343536373839414243444546
算法 = AES-128-CBC / PKCS7
```

`AES_IV` 的 24 位 hex → 12 字节 → base64 **恰好 16 字符**（`0123456789ABCDEF`）→ 再当十六进制串当 IV 用：外层是两段看似随机的 hex，实为固定常量。

### 5c.4 解密结果

`WEB_AES_SECRET_KEY`（明文）：

| 条目 | 明文密钥 | 用途 |
|---|---|---|
| `REQ` | `45f8ac1e1de14397` | `br()` → `yr(vr, …)`：`Data` 字段的外层 AES 加密 |
| `RES` | `87f879f135f27da7` | `gr(hr, …)`：解密服务端返回的加密数据 |
| `FLAG` | `c175a358550d02e2` | `kr.WEB_AES_FLAG_SECRET_KEY`：加密 `Data` 内层的指纹承诺串；可被入参 `secretKey` 覆盖 |
| `UPLOAD` | `a549a55c60a39aa0` | 日志上报 payload 加密 |
| `PREID` | `75ae5c150d235802` | PreID 流程加密 |

同一 KEY/IV 解开配置里的其它密文（即上文表格中的 `KEY_ID`/`KEY_SECRET`）：

| 条目 | 明文 |
|---|---|
| `ACCESS_KEY.ID`（= `kr.KEY_ID`，进请求参数 `AaduaneId`） | `DuaneAprqkYsF3nt1yjK29Bf` |
| `ACCESS_KEY.SECRET`（= `kr.KEY_SECRET`，HMAC-SHA1 签名密钥） | `DuanemHmyeE6LXCC46sJEDUw5DTlSZ` |
| `ht.ID`（另一条 verifyType 通道的 device key） | `111jdk439dJJIjd023823201` |
| `ht.SECRET` | `222aiJodos2938JDdosko2djd82sf0` |

### 5c.5 加密采集的真实链路

还原后，`Data` 字段的构造完全透明。两个入口（`Rr(deviceConfig, cfg, kr)` = 设备初始化，`Hr(action, …)` = 云 API 请求构造）：

```js
// Rr: 设备初始化 Data
o = gr(e.ACCESS_SEC, e.secretKey) || r.WEB_AES_FLAG_SECRET_KEY;   // FLAG 密钥（可被 secretKey 覆盖）
c = e.PLATFORM + "#" + appName + "#" + (e.sceneId || "") + "#captcha-normal#" + prefix + "#" + region;
c = yr(o, c);                                                     // 内层：AES-128-CBC(FLAG, 承诺串)
return br([appKey, r.DEVICE_TYPE.WEB, c, e.APP_VERSION, "CLOUD", ""]);
//    br(t) = yr(vr, t.join("#"))                                   // 外层：AES-128-CBC(REQ, 用 # 拼接的六元组)

// Hr(action, e, n, cfg, kr): 业务接口请求（InitCaptcha / VerifyCaptcha / UploadLog …）
c.AaduaneId       = o.KEY_ID;                 // "DuaneAprqkYsF3nt1yjK29Bf"
c.Version         = i.API_VERSION;            // "2020-10-15"
c.SignatureMethod = "HMAC-SHA1";
c.SignatureVersion= "1.0";
c.Format          = "JSON";
c.Action          = action;
s = gr(i.ACCESS_SEC, i.secretKey) || o.WEB_AES_FLAG_SECRET_KEY;
f = i.PLATFORM + "#" + appName + "#" + (i.sceneId || "") + "#captcha-front#" + i.prefix + "#" + i.region;
f = yr(s, f);                                 // 内层（此处是 captcha-front；Rr 用 captcha-normal）
c.Data = br([appKey, o.DEVICE_TYPE.WEB, f, i.APP_VERSION, "CLOUD", ""]);   // 外层
c.SignatureNonce = UUID(); delete c.Signature;
c.Signature = Cr(c, o.KEY_SECRET);            // Base64(HMAC-SHA1(规范化参数串, KEY_SECRET))
// → POST 到 DeviceConfig 下发的端点，Content-Type: application/x-www-form-urlencoded
```

要点：

- **`Data` 是双层加密**：内层用 `FLAG` 密钥加密"平台指纹承诺串"（`PLATFORM#appName#sceneId#captcha-{front|normal}#prefix#region`），外层用 `REQ` 密钥加密含 `appKey`/`DEVICE_TYPE`/`APP_VERSION` 的六元组。
- **签名独立于加密**：`Signature = Base64(HMAC-SHA1(canonicalQueryString, KEY_SECRET))`，`SignatureMethod: "HMAC-SHA1"` 是明文写在请求里的（阿里云云 API v1.0 风格）。
- **`secretKey` 是逃生口**：`gr(ACCESS_SEC, secretKey)` 优先于内置 `FLAG` 密钥，调用方可覆盖（ZCode 未用）。
- `RES` 密钥专用于**下行**：`gr(hr, t)` 出现在服务端响应解析函数里，解出的对象含 `.ip` 等字段。

#### `Cr()` 签名算法完整还原

`Cr(params, KEY_SECRET)` 的控制流串是 `"2|9|7|11" + "|1|8|5|1" + "0|6|4|0|" + "3"`。注意第二段尾部 `"1"` 与第三段首部 `"0"` **拼成 `10`**，所以真实顺序是 `2,9,7,11,1,8,5,10,6,4,0,3`（不是 13 个 case，而是 12 个）。逐 case 还原：

```js
function Cr(t /* params */, e /* KEY_SECRET */) {
  delete t.Signature;                       // 2: 先剔除旧签名
  var L = Object.keys(t);                   // 9
  L.sort();                                 // 7  (Qe() = Array#sort)
  var F = "&";                              // 11
  var I = true, P = "";                     // 1, 8
  for (const B of L) {                      // 5, 10
    const K = B;                            //   取 key
    const H = t[K];                         //   取 value
    if (!I) P += "&"; else I = false;       //   首项不加分隔符
    P += Ar(K) + "=" + Ar(H);               //   逐项 Ar 编码后用 = 连接
  }
  var O = "POST" + F;                       // 6   → "POST&"
  O = O + Ar("/") + F;                      // 4   → "POST%2F&"
  O += Ar(P);                               // 0   → "POST%2F&" + encode(canonicalQuery)
  return Base64(HmacSHA1(O, e + "&"));      // 3   (经 _r / ur.stringify)
}
```

即阿里云 POP 规范的标准形态：

```
StringToSign = "POST" + "&" + percentEncode("/") + "&" + percentEncode(CanonicalizedQueryString)
Signature    = Base64(HMAC-SHA1(StringToSign, KEY_SECRET + "&"))
```

`Ar()`（percentEncode，注意它**不是** `encodeURIComponent` 的原样输出）：

```js
Ar(s) = encodeURIComponent(s)
          .replace("+",  "%20")    // 空格
          .replace("*",  "%2A")
          .replace("%7E", "~")      // 波浪号还原为不转义
```

- **注意 `replace` 是非全局的**：只替换**第一个**出现。所以含多个 `+` 的值（如 base64 密文里不会有，但 `ExtraInfo` 之类的自由文本可能）只有首个被替换。实测：`Ar("a+b")` → `"a%2Bb"`（第二个 `+` 原样保留为 `%2B`，因为 `encodeURIComponent` 已把字面 `+` 编成 `%2B`，而首字符 `+` 来自空格）。复现脚本 `_re/verify_signature.js` 第 [4] 组断言即覆盖此行为。
- `CanonicalizedQueryString` = 按 key **字典序升序**（`Array#sort()`，默认 UTF-16 码元序）后，`percentEncode(k) + "=" + percentEncode(v)` 用 `&` 串联，**首项前无 `&`**。整体再经一次 `Ar()` 后拼进 `StringToSign`，因此 `=` 与 `&` 会二次转义成 `%3D` / `%26`。
- 密钥拼接 `KEY_SECRET + "&"` 由 `k.TyeBz(e, F)` 完成（`F = "&"`），与阿里云官方 SDK 一致。
- 两条通道（`jr` / `Hr`）共用同一个 `Cr()`，只是传入的 `KEY_SECRET` 不同（`Er.KEY_SECRET` / `kr.KEY_SECRET`）。
- **可复现性**：给定 `params` 与 `KEY_SECRET`，本函数输出唯一确定，不含随机量；随机性只在 `SignatureNonce`（`de()`，32 位伪 UUID v4 形态，`Math.random` 驱动）。
- **已验证**：`_re/verify_signature.js` 用 `node:crypto` 独立手算并交叉断言（签名一致 / key 排序无关性 / 旧 `Signature` 被剔除 / `Ar()` 三处替换），4 组全通过。

### 5c.6 复现

```powershell
cd _re
node extract_web_aes_secret_key.js     # 全自动：抠表 → 解码 → 去混淆 → 定位配置 → 解密
node verify_decrypt.js                 # 解密 + PKCS7 回环 + 交叉验证
node verify_signature.js               # Cr() 签名复现 + 4 组断言（排序/剔除/percentEncode）
```

| 脚本 | 作用 |
|---|---|
| `_re/extract_web_aes_secret_key.js` | 主工具：`node extract_web_aes_secret_key.js [任意 js 路径]`。不硬编码任何密钥——现场抠出字符串表执行、求值配置表达式、再解密，对同款 bundle 通用 |
| `_re/verify_decrypt.js` | 解密 5 项 + 重加密回环比对 + 用同一 KEY/IV 解其它密文 |
| `_re/verify_signature.js` | `Cr()` 签名复现，与 `node:crypto` 独立手算交叉断言（4 组：签名一致 / key 排序无关 / 剔除旧 `Signature` / `Ar()` 三处替换） |
| `_re/send_init_captcha.js` | 发一次真实 `InitCaptcha`（[§5m.2](#5m2-跑通结果协议全部实测通过)）。参数取自 `GET /api/v1/client/configs`，13 参数 + `Cr()` 签名；`--dry` 只打印不发送 |
| `_re/scan_dynamic.js` | 动态包符号审计与上下文提取（[§5m.4](#5m4-动态包里的-pow-引擎5i-的实证答案)）。用法 `node scan_dynamic.js [路径] [符号]` |
| `_re/tables_dynamic.js` | 动态包字符串表 `th` 的解码器（[§5m.5](#5m5-动态包字符串表已破解_retables_dynamicjs)）。抠出 4,074 字节自包含定义并求值，按调用点实参 `tf(a,b)` / `r(a,b)` 解码 |
| `_re/dynamic_captcha.js`（**文件已删除，结论保留**） | 实包抓取的动态脚本样本（447,993 B，`captcha-frontend/dynamicJS/3.29.0/pe.089.0db63cec7a44dbe2.js`）。含 PoW 引擎与 `AliyunCaptcha.prototype` 定义 |
| `_re/dump_endpoint_tables.js` | 端点 / 应用身份 / CDN 表汇总（[§5l](#5l-端点表-应用身份表)）。6 项 CDN 交叉断言 + 7 项结构断言，全通过 |
| `_re/tables.js` | 字符串表解码器（`exports.G` / `exports.er` / `exports.Ne` / `exports.gn`），可查任意下标 |
| `_re/deobf.js` + `_re/deobfuscated.js` | 批量去混淆器 / 已还原 543 处字符串的完整可读源码 |
| `_re/web_aes_secret_key.json` | 结构化结果（密文 + 明文 + 算法 + 密钥/IV 的 ascii 与 hex 形态） |
| `_re/table_dump.json`（**文件已删除，结论保留**） | 两套字符串表中所有被引用下标 → 明文的映射表，便于手工核对任意常量。**注意：其中的 `er` 表是残缺的，仅供交叉参考，勿作为还原数据源**（见 [§5j](#5j-去混淆工具链四张字符串表)） |
| `_re/check_docs.js` | 文档结构校验：代码围栏配对、相对链接可达、标题锚点匹配、表格列数一致、编码/行尾 |
| `_re/decode_device_config.js` | DeviceConfig 解密器（RES 密钥 → `#` 分段 → 9 字段 → `wr()` 解码）。用法：`node decode_device_config.js <base64密文>`，`--selftest` 可自验证 |

### 5j. 去混淆工具链：四张字符串表

本节记录还原率从 **27 处**提到 **278 处**（去混淆替换总数 543 → 821）所解决的三个根因：

| # | 问题 | 症状 | 修复 |
|---|---|---|---|
| 1 | `table_dump.json`（文件已删除）的 `er` 表残缺 | `er(266)` 等大量键 `undefined`，静默跳过替换（`Cr` / `Sr` / `mr` 全部保持 `E(266)` 噪音） | 改用 `tables.js` **实时求值** bundle 内的解码器（`G` 288 项 / `er` 205 项 / `Ne` 178 项） |
| 2 | 只处理 `function NAME(` 声明 | `Le` / `He` / `We` 等**函数表达式**（`NAME = function …`）整体漏掉 | `fnRe` 同时匹配两种形态 |
| 3 | 作用域跳过 + 别名全局覆盖 | 处理完外层函数后 `lastIndex` 跳到整个 body 末尾，内层 `v = function(h){…}` 永不可见；且同名别名在不同作用域绑不同表（`Sr` 里 `E = er`、`Le` 里 `E = Ne`），全局 Map 后写覆盖前写导致绑定消失 | 改为**逐层下降**（`lastIndex = start + 1`）+ **每作用域独立收集别名**（`localAliasMap` 优先，全局表仅兜底） |

附带三个必须记住的实现约束：

- **bundle 里有 4 套同构的字符串表**（`rt`/`xr`/`Ne`/`gn`，偏移 314/208/498/468），必须**全部**接入。漏掉任一套都会造成"某局部结论建立在未扫过的表之上"——`UPLOAD`/`PREID` 的"零消费"结论就曾受此影响（结论本身正确，但当时只扫了 2 套）。判定方法：`/function (\w+)\(t, e\)\s*\{\s*var r = (\w+)\(\);/` 全样本扫描，计数即表数。
- **不能用 `Object.keys()` 枚举解码器**——`T.G` / `T.er` 是函数，`Object.keys` 返回的是函数自身属性名（`name` / `length` / 内部缓存键），不是调用索引。必须按数值区间遍历（`buildTable(fn, lo, hi)`）。注意 `Ne` / `gn` 的偏移不是 0 而是 498 / 468，区间下限要相应调整。
- **常量表收集必须逐字符扫描**。声明长这样：`for (var r = 362, i = 262, …, k = { a: f(1), b: "x,y" }; ;)`——声明列表里嵌了对象字面量、函数调用、带逗号的字符串，任何基于分隔符的正则都会被带偏。
- **属性位置的查表调用不还原**是刻意的：`p[Ne(_)]` 里的 `Ne(_)` 前有 `[`，负向前瞻会跳过。这避免了把 `p["jQeme"]` 错替换成 `p[undefined]`，代价是这类间接键保持原样（不影响可读性主线）。

### 5c.7 正确性证据

1. **PKCS7 全过**——5 个密文解密后均可正常去 padding，明文为整齐的 16 位 hex。
2. **回环一致**——明文重新 AES-128-CBC 加密，base64 与原文**字节级完全相同**（5/5）。
3. **交叉验证**——同一 KEY/IV 解开四个与 `WEB_AES_SECRET_KEY` 无关的密文（`ACCESS_KEY.ID`/`SECRET`、`ht.ID`/`SECRET`），全部得到可读 ASCII；密钥或 IV 差一位，这四个值不可能同时成立。
4. **版本勘误**——本样本内出现的 `3.49.0` 是内嵌 **core-js** 的版本串（`__core-js_shared__` 版权头 `© 2013–2025 Denis Pushkarev`），**不是 SDK 版本**；SDK 自身字段为 `VERSION: "1.3.4"`。[§5b](#5b-sdk-内部解剖对-aliyuncaptchajs-的静态分析) 标题中的 "v3.49.0" 应为该 core-js 串的误读。另：§5b 样本 222 KB、本样本 273,948 B，是两个不同 build；常量名一致（`WEB_AES_SECRET_KEY`/`KEY_ID`/`KEY_SECRET`/`DEVICE_TYPE` 均出现），上表取值以本样本为准。

## 5d. DeviceConfig 解密与消费（Schema 已还原）

§5b 曾把"服务端驱动"这一层标为动态黑盒。实际上它的 **schema 是固定的 9 字段**，只有取值随服务端变化——整条链已完全解出。

### 5d.1 解密管线

`rn(DeviceConfig, deviceCallback, dev, source)` 入口处：

```js
h = mr(e)                                  // e = 响应里的 DeviceConfig（base64 密文串）
// mr() 内部：
//   z = gr(hr, t)                          // hr = §5c.4 解出的 RES 明文密钥
//                                        //  AES-128-CBC / PKCS7 / IV "0123456789ABCDEF"
//   D = z.split("#")                       // 9 段
//   O = {}; 若 D.length >= 4 按 "4|8|6|5|2|3|0|1|7" 顺序填字段
```

即 **`DeviceConfig` 与下行响应同密钥（RES）**，密文 → `#` 分隔 9 字段。

### 5d.2 九字段

| # | 字段 | 取值 | 消费点 |
|---|---|---|---|
| `D[0]` | `key` | `wr(D[0])` | `deviceConfig.key` |
| `D[1]` | `switch` | `Number(wr(D[1]))` | 功能开关（数值位） |
| `D[2]` | `sessionId` | 明文 | 会话标识 |
| `D[3]` | `version` | 明文 | **`rn()` → `dynamicJsPath(version)` → 加载飞廉采集 JS** |
| `D[4]` | `pluginElements` | `wr(D[4])` | 采集元素清单 |
| `D[5]` | `pluginResource` | `wr(D[5])` | 采集资源清单 |
| `D[6]` | `globalVariable` | `wr(D[6])` | 采集全局变量清单 |
| `D[7]` | `timestamp` | 明文 | `Br._extend({deviceConfig, timestamp: h.timestamp})` |
| `D[8]` | `ip` | 明文 | `xe("ip", h?.ip)` 写入日志 |

**`wr()` 是确定性解码，无第二层密钥**：

```js
wr(t) = String.fromCharCode(...[...new Uint8Array(Buffer.from(atob(t)))])
// 其中的 Ve() = r.n(r(8035)) = Babel 的 _toConsumableArray
//   （把 Uint8Array 摊成普通数组供 apply 展开），不是 XOR、也不是 _typeof
```

因此 `D[4..6]` 三份清单可直接离线解出——它们就是"采集哪些字段"的答案（元素 / 资源 / 全局变量三类），交由飞廉脚本执行。

### 5d.3 消费链 `rn()`

```js
h = mr(e); Br._extend({ deviceConfig: h, timestamp: h.timestamp })
xe("ip", h?.ip)
if (h.version && !Br.feilinLoad) {
  window.um = {}; window.z_um = {};
  Le("js", https, dev ? cdnDevServers : cdnServers, dynamicJsPath(h.version), null, cb, 5000)
  // 成功 → logs.push("23-…")，window.FEILIN.initFeiLin(Br, deviceCallback)
  // 失败 → logs.push("21-…"/"22-…")，deviceCallback(FAIL, {DeviceToken: ""})，pe("networkError")
} else /* 无 DeviceConfig */ {
  window.um.getToken = window.z_um.getToken = () => "";   // 兜底空令牌
  deviceCallback(FAIL, { DeviceToken: "" });
}
```

**动态资源 URL（已解出）**：

| 函数 | 结果 |
|---|---|
| `dynamicJsPath(version)` | `/captcha-frontend/FeiLin/<version>.js` → `https://g.alicdn.com/captcha-frontend/FeiLin/<version>.js` |
| `devicePath()` | `/captcha-frontend/aliyunFP/fp.min.js` |
| `captchaJsPath(StaticPath)` | `/captcha-frontend/dynamicJS/<StaticPath>.js` |
| `captchaCssPath(StaticPath)` | `/captcha-frontend/dynamicJS/<StaticPath.split("/")[0]>/main.css` |
| 版本兜底 | `fallbackVersion: "0.0.0/feilin"` |

**端点选择 `tn(endpoints, appName)`**：

```js
appName === "saf-captcha"
  ?  endpoints 为空或等于 CN_DEFAULT_ENDPOINTS → ENDPOINTS = CN_ENDPOINTS
     endpoints 等于 INTL_DEFAULT_ENDPOINTS     → ENDPOINTS = INTL_ENDPOINTS
     否则                                      → ENDPOINTS = 自带 endpoints
  :  ENDPOINTS = endpoints || WAF_ENDPOINTS
```

### 5d.4 结论

DeviceConfig 的**字段集合固定**（9 项）、**解码固定**（RES 密钥 + `#` 分段 + base64 字节）、**资源路径固定**（飞廉 `/captcha-frontend/FeiLin/`）。随服务端变化的只有 `version`（决定加载哪版飞廉）、`key`/`sessionId`/`ip`/`timestamp`，以及三份采集清单的**内容**。运行期对响应体 `DeviceConfig` 跑一遍 `mr()` 即可拿到当次清单。

## 5e. 验证响应 Schema 与 Sr 解析

```js
// Sr(resp, cfg)  控制流串 "7|5|6|2|" + "4|9|0|8|" + "1|3" → 7,5,6,2,4,9,0,8,1,3
case 7: H = cfg.captchaJsPath, W = cfg.captchaCssPath,
        F = cfg.region ?? "cn", R = cfg.isDev;
case 5: j = at;                        // 正式图片 CDN
case 6: if (R) j = ft;                 // isDev → 预发 CDN
case 2: j = j[F];                      // 按 region 取子域, 缺失则 undefined
case 4: cfg._extend({ imgServer: j }); // ★ 副作用: 最终生效的 imgServer 回写进 config
case 9: q = resp.Image     ? j + resp.Image     : "";
case 0: L = resp.PuzzleImage ? j + resp.PuzzleImage : "";
case 8: U = resp.Question ? resp.Question : "";
case 1: M = resp.PowVerifyString ? resp.PowVerifyString : "";
case 3: return {
  CaptchaType:      resp.CaptchaType,
  Image:            q,
  CaptchaJsPath:    H(resp.StaticPath),
  CaptchaCssPath:   W(resp.StaticPath),
  CertifyId:        resp.CertifyId,
  Question:         U,
  PuzzleImage:      L,
  PowVerifyString:  M
};
```

- **本次修正**：早前版本只记了返回字段，漏了 **case 4 这个副作用** —— `Sr()` 会把选中的 `imgServer` 写回 `cfg.imgServer`，供后续（`Bn()` 的图片预热等）复用。
- `j = j[F]` 是**两级取值**：先取预发表 `ft` 或正式表 `at`，再按 region 索引。任一级缺失都会得到 `undefined` 而**不抛错**，此时拼出的 URL 是 `"undefined/xxx"` 形态——排查线上白图时可据此判定 region 配错。
- CDN 表（`at` / `ft`）：

  | 变量 | region | host |
  |---|---|---|
  | `at`（正式 `imgServer`） | `cn` | `https://static-captcha.aliyuncs.com/` |
  | | `sgp` | `https://static-captcha-sgp.aliyuncs.com/` |
  | | `ga` | `https://static-captcha-sgp.aliyuncs.com/` |
  | `ft`（预发 `imgDevServer`） | `cn` | `https://static-captcha-pre.aliyuncs.com/` |
  | | `sgp` | `https://static-captcha-sgp-pre.aliyuncs.com/` |
  | | `ga` | `https://static-captcha-sgp-pre.aliyuncs.com/` |

  - **`ga` 与 `sgp` 在两张表里都同源**（都指向 `*-sgp*` 主机），`ga` 并没有独立的前端节点。
  - 正式表与预发表的**唯一**差异在 `sgp`/`ga` 的 `-pre` 后缀；`cn` 一项则正式=`static-captcha`、预发=`static-captcha-pre`。
  - **`at.sgp` / `at.ga` 不带 `-pre`**：正式表的 sgp/ga 取值无 `-pre` 后缀。该取值由 `_re/dump_endpoint_tables.js` 的 6 项交叉断言锁定。
- 动态资源路径构造（`cfg.captchaJsPath` / `captchaCssPath`）：

  ```js
  captchaJsPath(StaticPath)  = "/captcha-frontend/dynamicJS/" + StaticPath + ".js"
  captchaCssPath(StaticPath) = "/captcha-frontend/dynamicJS/" + StaticPath.split("/")[0] + "/main.css"
  devicePath(version)        = "/captcha-frontend/aliyunFP/fp.min.js"   // 飞廉, 忽略入参
  ```

  即 `CaptchaJsPath` 走服务端下发的 `StaticPath` 原文，`CaptchaCssPath` 只取其**第一段**目录名。
  BASE/SUFFIX 已用字符串表逐项核对（`G(478)+G(343)+G(468)+G(458)` = `/captcha-frontend/dynamicJS/`，`G(574)` = `.js`）。

  > **要点**：`CaptchaJsPath` 是**相对路径**，主机不来自本节的 `imgServer` 表，而来自 `cdnServers`（`g.alicdn.com` / `x.alicdn.com`）。
  > 按 `imgServer` 去取会得到 `NoSuchKey`。图片与动态脚本是**两套 CDN**，详见 [§5m.3](#5m3-动态包的真实-cdn修正-5e-的混淆)。
- 相比 [§5b](#5b-sdk-内部解剖对-aliyuncaptchajs-的静态分析) 的字段表，本节另有 **`CaptchaType`、`Image`、`StaticPath`** 三个字段。
- 响应里另有 `Success` / `Code` / `Message` / `LimitFlow` / `LimitedFlowToken` / `DeviceConfig`，由调用方（`Lr`、`Hr`）直接消费，未过 `Sr()`。

## 5f. 日志上报链与 UPLOAD / PREID 的结论

### 5f.1 上报链

```
xe(key, value)      → re.logInfo[key] = value            # 单点写入
on(key, value, …)   → xe(...) + 可选清空 + Kr()
Kr() → Fr()         → Nr(Er.ACTION.LOG /* "UploadLog" */, { log: logInfo },
                                        urls.map(t => Wr(t, "upload")), Ir, Er)
                    → 走 jr()，不是 Hr()！详见 §5g.3
```

请求体（`Qr()` 手写 URL 编码，非 `br()` AES）：

```
AaduaneId = Er.KEY_ID
Action    = "UploadLog"
Version   = "2023-03-05"
log       = JSON.stringify(re.logInfo)
Signature = Base64(HMAC-SHA1(canonicalQuery, Er.KEY_SECRET))
→ POST application/x-www-form-urlencoded; charset=UTF-8
```

> **修正说明**：本节早期版本把上报记为 `"Log1"` / `Hr()` / `Data = br([appKey, "W", …])`。按 `gt["LOG"] = "UploadLo" + "g"` 与
> `Fr()` 的实参（offset 243681）复核后确认：上报走 `jr()` 业务通道，`log` 字段是**明文 JSON**，不经 AES。`br()`/`REQ` 密钥只服务 `Hr()`，
> 而 `Hr()` 在全样本中**只有 `Mr()` 的 `kr.ACTION.INIT`（真·`"Log1"`）一个调用点**。

### 5f.2 logInfo 字段

| 键 | 含义 |
|---|---|
| `sId` | SceneId |
| `pfx` | prefix（`en()` 解析结果） |
| `cId` | CertifyId；限流时取 `LimitedFlowToken`，缺失则随机 5 位 |
| `hst` | 实际命中的 `apiServers` / `apiDevServers` host |
| `ip` | `DeviceConfig.ip` |
| `js` | 动态 JS 加载结果 `{ t, s, msg, rt }` |
| `bInit` / `mInit` | 端点以 `-b` 结尾 → `bInit`，否则 → `mInit`；值为 `{ t, s, msg, rt }` |

`logs` 计时打点：`10/11/12/13` 初始化各阶段、`20` 飞廉 JS 开始加载、`21` 加载失败（附错误信息前 50 字）、`22` 失败但错误对象字符串化异常、`23` 加载成功。

### 5f.3 UPLOAD 与 PREID：保留位，本版本零消费

穷举确认（脚本 `_re/extract_web_aes_secret_key.js` 与字面量扫描）：

| 条目 | 出现次数 | 性质 |
|---|---|---|
| `["UPLOAD"]` | **1** | 仅 `Xt["UPLOAD"] = …` 赋值 |
| `["PREID"]` | **1** | 仅 `Xt["PREID"] = …` 赋值 |
| `["REQ"]` / `["RES"]` / `["FLAG"]` | 各 2 | 赋值 + 消费（`pr["REQ"]` / `pr["RES"]` / `…["FLAG"]`） |

`G(n)` / `er(n)` 解码结果为 `UPLOAD` / `PREID` 的引用为 **0 次**。日志上报走 `br()` → **复用 `REQ` 密钥**，不使用 `UPLOAD` 条目。

结论：`UPLOAD` 与 `PREID` 是**同系列 build 共用配置里的保留位**，在本样本（`VERSION: "1.3.4"`）中只有定义、没有任何代码路径读取；两条明文密钥（`a549a55c60a39aa0` / `75ae5c150d235802`）已解出，供对照其它 build 时使用。

> **适用范围限定**：`G(n)` / `er(n)` 的零消费结论成立，但仅限**这两张表**。bundle 实际有 **4 套**字符串表（`rt`/`xr`/`Ne`/`gn`，偏移 314/208/498/468），本文档只接管前两套。补上后 `gn(470)` = `"popup"`、`gn(472)` = `"embed"`、`gn(476)` = `"sgp"` 被解出，正是 §2.2 的白名单来源——即 `UPLOAD`/`PREID` 之所以"零消费"，是因为查它们的那张表恰好没被扫过。结论本身不变（见 [§5j](#5j-去混淆工具链四张字符串表)）。

## 5k. `verifyType: "1.0"` 的兜底与回调链

§5h 记的是 `en()` 的请求体构造。`"1.0"` 还有一条**独立的回调链**：`pn()` → `hn()` → `vn()`。

```js
// fn(t)  —— 兜底入口
function fn(t) {
  var e = this;
  function r() {
    if (e.onFallback && typeof e.onFallback === "function") e.onFallback(t);
    else pn(e, t);                                  // 默认走标准回调
  }
  var n = Ae(e.button);
  if (n && "2.0" === e.verifyType) n.onclick = r;   // 仅 2.0 绑按钮
  else r();                                          // 其它版本立即执行
}
```

`fn()` 内部按 `verifyType` 分岔：`"2.0"` 且 `button` 元素存在时挂 `onclick` 等待用户点击，否则**同步立即执行**。

```js
// pn(config, result) —— 组装 param 并上抛
function pn(e, r) {
  var c = {
    sceneId:     e.SceneId,
    certifyId:   e.CertifyId,
    deviceToken: e.DeviceToken || ye(),     // 飞廉 token, 缺失时降级为空
    failover:    "T"                        // ★ 降级标记
  };
  if (ln !== JSON.stringify(r)) { c.err = r; ln = JSON.stringify(r); }   // 错误去重, 避免重复上抛
  if (e.captchaVerifyCallback && typeof e.captchaVerifyCallback === "function") {
    var a = await e.captchaVerifyCallback({...c}, hn.bind(e));   // ★ 动态包接管的接缝
    if (a != null) { hn.call(e, a); return; }
  }
  e.isShowErrorTip && U(sn("网络不给力，请刷新重试"));
}
```

```js
// hn(t) —— 动态包回传结果后的裁决
function hn(t) {
  var r = t.captchaResult, n = t.bizResult;
  if (0 !== r) {                                   // captchaResult 非 0 → 验证未过
    if (r === false || r === undefined) {          // 网络/未知异常
      e.isShowErrorTip && U(sn("网络不给力，请刷新重试"));
      e.reInitCaptcha(e);                          // 重来一轮
    }
    return;                                        // 其余 false 以外的异常值不重试
  }
  if (n === undefined) return vn(e);               // 业务结果缺省 → 视为通过
  if (n === false)  { e.fail ? e.fail(n) : e.onBizResultCallback?.(false); e.reInitCaptcha(e); }
  if (n === true)   vn(e);
}
```

三个此前没记的点：

1. **`failover: "T"`** 是 ZCode 下发给模型层的 param 里那个字段的来源——`param` 不是 SDK 原样透传，而是 SDK 在 `pn()` 里**重新组装**的四元组 `{sceneId, certifyId, deviceToken, failover}`。这解释了 [§3](#3-param-生命周期编排器-mnnfnn) 里"param 有固定结构"的由来。
2. **`captchaVerifyCallback` 是本 bundle 与动态包之间的唯一接缝**。`hn()` 期待动态包回传 `{captchaResult, bizResult}`：前者 0 表示验证码通过、非 0 为失败；后者是业务层裁决（`true` 通过 / `false` 拒绝并重试 / `undefined` 视同通过）。这印证并细化了 [§5i](#5i-powverifystring-question本样本零消费) 的结论——**动态包负责拿到 `VerifyCaptchaV2` 的结果，再经这个回调交回控制权**。
3. **`fn()` 在本样本零调用点**（全样本仅 1 次出现，即定义处）。它是 `verifyType: "1.0"` 留给宿主/动态包手动触发的兜底入口，由 `onFallback` 或外部调用激活。ZCode 走 `"2.0"` 无痕链路，不会走到这里。

## 5l. 端点表 / 应用身份表

SDK 的四张路由表藏在 `Ft`（= `Kt`）下，全部按 `verifyType` 二级索引。汇总脚本：`_re/dump_endpoint_tables.js`（含 6 项 CDN 交叉断言 + 7 项结构断言，全通过）。

### 5l.1 业务 RPC 端点 `apiServers` / `apiDevServers`

| verifyType | 正式端点 | 预发端点 |
|---|---|---|
| `"1.0"` | `captcha-pro-open.aliyuncs.com`<br>`captcha-pro-open-b.aliyuncs.com` | `captcha-pro-open-pre.aliyuncs.com`<br>`captcha-pro-open-pre-b.aliyuncs.com` |
| `"2.0"` / `"3.0"` | `cn`: `captcha-open-pre.aliyuncs.com`<br>`captcha-open-pre-b.aliyuncs.com`<br>`sgp`/`ga`: `captcha-open-southeast.aliyuncs.com`<br>`captcha-open-southeast-b.aliyuncs.com` | `cn`: 同左（2.0/3.0 正式与预发**同源**）<br>`sgp`/`ga`: `captcha-open-southeast-pre.aliyuncs.com`<br>`captcha-open-southeast-pre-b.aliyuncs.com` |

- **"pro" vs "open" 是 verifyType 的硬隔离**：`1.0` 走 `captcha-pro-open.*`，`2.0`/`3.0` 走 `captcha-open.*`。这也解释了 §5h 里 1.0 为什么要额外做 `MD5(userUserId)` 前缀隔离——它本来就在另一套域。
- **`-b` 后缀是"备用端点"标记**，`Yr()` 命中后把它置顶（[§5g.4](#5g4-两条通道的响应解析)），并据此在日志里记 `bInit` / `mInit`（[§5f.2](#5f2-loginfo-字段)）。
- 每个 region 都是**两个端点**，即最多重试 1 次就耗尽（`e >= n.length - 1`）。

### 5l.2 设备指纹端点（`Mr()` → `Hr()` 通道）

| region | 端点 |
|---|---|
| `cn` | `https://cloudauth-device-pre.aliyuncs.com`<br>`https://pre-cn-shanghai.device.saf.aliyuncs.com` |
| `sgp` | `https://cloudauth-device-pre.ap-southeast-1.aliyuncs.com`<br>`https://pre-ap-southeast-1.device.saf.aliyuncs.com` |

- 这批主机**自带 `-pre`**，与 §5l.1 的业务端点不同源——设备通道在生产也指向预发域名（阿里云侧设备指纹服务的历史遗留）。
- 另有 `secEndpointType === "shpl"` 时走 `shplEndpoints[verifyType][region]`，与默认 `endpoints` 是两套表；ZCode 走默认路径。

### 5l.3 应用身份 `appName` / `appKey`

| verifyType | `appName` | `appKey`（region `cn`） |
|---|---|---|
| `"1.0"` | `saf-captcha-waf` | `sh87bd1512hsb03cb405803a307dbe32` |
| `"2.0"` / `"3.0"` | `saf-captcha` | `ab034ec0643f91399eb33e062dc7fae1` |

- **两者都是明文，不是密文**。这点容易踩：`appKey` 是 32 个 hex 字符、hex 解码恰好 16 字节，形态与 §5c 的 `WEB_AES_SECRET_KEY` 密文一模一样。但 `Rr()` 里 `n = t.appKey || e.APP_KEY` **直接进 `br()`（AES 加密）**，中间没有 `gr()`（AES 解密）；强行按密文解会得到 `wrong final block length`。`_re/verify_decrypt.js` 末尾有这条反证。
- 早前版本在本节写的是"值同样是 AES 密文常量…未单独解出"——**该判断错误，已更正**。
- `appName` 进入 `Rr()` 的承诺串明文锚点：`PLATFORM#appName#sceneId#captcha-normal#prefix#region`；`appKey` 进入 `br()` 的六元组首位（[§5c.5](#5c5-加密采集的真实链路)）。
- `appKey` 同时是 §2.1 中 `verifyType` 被 WAF 改写时**连带切换**的东西（`Ft.appKey[Ln][Pn]`）——即改写不仅换域，还换身份。`saf-captcha-waf` 这个名字也印证了 1.0 分支与阿里云 WAF 的绑定关系。

### 5l.4 CDN 表

见 [§5e](#5e-验证响应-schema-与-sr-解析) 的 `at` / `ft` 两张表（图片与静态资源），本轮已用脚本交叉断言。


## 5g. 请求调度分发管线（Nr / jr / Hr / Lr 拓扑）

SDK 内部对于远程 RPC 与日志上报的实际执行路径存在清晰的双轨路由（`Nr` 分发器）：

```
                  ┌─────────────── Nr(action, params, urls, ctx, keys) ───────────────┐
                  │                                                                    │
       action === "Log1"                                                        action !== "Log1"
                  │                                                                    │
                  ▼                                                                    ▼
        Hr(action, ...) [遥测通道]                                            jr(action, ...) [核心 RPC 通道]
  - 协议头: AaduaneId, Action, Version: "2020-10-15"                    - 协议头: AaduaneId, Action, Version: "2023-03-05"
  - 数据负载: Data = 双层 AES(FLAG + REQ)                                - 数据负载: 业务参数对象浅拷贝展开
  - 签名: Base64(HMAC-SHA1(canonicalQuery, kr.KEY_SECRET))             - 签名: Base64(HMAC-SHA1(canonicalQuery, Er.KEY_SECRET))
  - 重试策略: 递归下推 l(e + 1) 直至 200/4xx 成功或端点耗尽             - 重试策略: 递归下推 u(e + 1)，遇到 403 限流或策略截断直接返回
```

### 5g.1 核心分发器 `Nr()` 与通道特性

1. **分发器判定**：
   - 唯一入口：`Nr(t, e, r, n, i) { return "Log1" === t ? Hr.apply(this, arguments) : jr.apply(this, arguments) }`
   - 硬编码字面量比较（无配置项、无大小写折叠），因此只有 `kr.ACTION.INIT === "Log1"` 命中。
   - 其余全部（`InitCaptcha` / `InitCaptchaV2` / `InitCaptchaV3` / **`UploadLog`**）走 `jr()`。

2. **双通道协议参数对比**：

| 维度 | `jr()`（验证码业务通道） | `Hr()`（遥测与设备初始化通道） |
|---|---|---|
| 协议版本 `Version` | `"2023-03-05"`（常量 `pt`） | `"2020-10-15"`（配置 `API_VERSION`） |
| 签名方法 `SignatureMethod` | `"HMAC-SHA1"` | `"HMAC-SHA1"` |
| 签名版本 `SignatureVersion` | `"1.0"` | `"1.0"` |
| 响应格式 `Format` | `"JSON"` | `"JSON"` |
| 账户标识 `AaduaneId` | `Er.KEY_ID`（`"MQECT2fv..."` 解密得 `"111jdk439dJJIjd023823201"`） | `kr.KEY_ID`（`"tK5X1r3E..."` 解密得 `"DuaneAprqkYsF3nt1yjK29Bf"`） |
| 签名密钥 `KEY_SECRET` | `Er.KEY_SECRET`（解密得 `"222aiJodos2938JDdosko2djd82sf0"`） | `kr.KEY_SECRET`（解密得 `"DuanemHmyeE6LXCC46sJEDUw5DTlSZ"`） |
| 请求负载 | 参数字典直接平铺进 URL-encoded 查询串 | 双层 AES 加密包置入 `Data` 字段 |
| 降级打点 | 端点含 `-b` 记为 `bInit`，其余记为 `mInit` | 成功命中端点后调用 `Zr(urls, index)` 轮转置顶 |

### 5g.3 三个 `Nr()` 调用点（全样本穷举，仅 3 处）

| # | 调用点 | action | 实际通道 | 触发者 |
|---|---|---|---|---|
| 1 | offset 238473 | `Er.ACTION.INIT` / `INITV2` / `INITV3` | `jr` | `Lr()` ← `Pr()` ← `Bn()` ← `initCaptcha` / `reInitCaptcha` |
| 2 | offset 239489 | `kr.ACTION.INIT` = `"Log1"` | **`Hr`** | `Mr()`（设备初始化，独立于 `initCaptcha` 调用链） |
| 3 | offset 243681 | `Er.ACTION.LOG` = `"UploadLog"` | `jr` | `Fr()` ← `Kr()` ← `on()`（telemetry 落盘） |

结论：**`Hr()` 只有一个调用点**（`Mr()` 的设备初始化）；`Log2` / `Log3`（`DEVICE_UPLOAD` / `COMBAT_UPLOAD`）在本版本已定义但从未被派发。

### 5g.4 两条通道的响应解析

`jr()`（offset 240600 起，递归体 `u(idx)`）：

```js
p = resp.Code; v = resp.Success;
h = urls[idx].includes("-b") ? "bInit" : "mInit";     // Ge() = String#includes
if (p === "Success" && v) { xe(h, {t, s:true,  msg:"INIT_SUCCESS", rt});
                             Yr(idx);                 // 命中端点置顶，刷新 re.urls
                             return resp; }
xe(h, {t, s:false, msg: resp.err, rt});
if (idx >= urls.length - 1) return resp;             // 端点耗尽
if (p === "403" && resp.LimitedFlow) return resp;    // 限流：立即截断，不重试
if (p === "ThrottlingByStrategy") return resp;       // 策略限流：立即截断
return u(idx + 1);                                    // 其余换端点重试
```

- 成功判据是**双条件** `Code === "Success" && Success === true`（不是只看 `Code`）。`Code` 是字符串 `"Success"`，`Success` 是独立布尔字段，两者分别下发。
- 失败打点 `msg` 取 `resp.err`（业务错误体），与 `Hr()` 的 `f.err || f.Message` 不同。

`Hr()`（offset 241736 起，递归体 `l(idx)`）：

```js
s = resp.Code; f = resp.ResultObject;                 // 注意：负载在 ResultObject 里
if (s === "200" || String(s).startsWith("4") || idx >= urls.length - 1) {
  if (s === "200" || String(s).startsWith("4")) Zr(urls, idx);   // 轮转置顶
  return f || String(s);                              // 返回 ResultObject，而非整个响应
}
return l(idx + 1);
```

- 与 `jr()` 的**根本差异**：`Hr()` 成功码是 HTTP 语义 `"200"`（`4xx` 也视为"已送达"，只轮转不再试），返回 `ResultObject` 子对象；`jr()` 成功码是业务串 `"Success"`，返回整个响应对象。
- `Fe()` = `String#startsWith`（`r.n(866)` → 模块 4255 → 3742），`Ge()` = `String#includes`（`r.n(9309)` → 5446 → 7249）。

### 5g.5 传输与重试底座 `Gr()`（两通道共用）

```
Ur(url, params, ctx) / qr()  → Gr(url, params, {method:"POST", mode:"cors",
                                              headers:{Content-Type:urlencoded},
                                              body: Qr(params)},
                                  ctx.fallbackCount ?? 2, ctx.timeout ?? 5000)
Gr → Vr(url, opts)  // = window.__AYF，裸 XMLHttpRequest
   ↳ race( XHR, 5000ms timer )
   ↳ Vr 内部把 HTTP 403 + x-auth-msg 响应头转成
     { Code:"403", LimitedFlowToken:<header>, LimitedFlow:true, err:"LimitedFlow" }
   ↳ 5xx / 超时 / Code 以 "5" 开头 → 经 Jr() 重签后换端点重试（最多 2 次）
```

`Jr()` 是重试时的重签器：`delete t.Signature; t.SignatureNonce = de(); t.Signature = Cr(t, keys.KEY_SECRET); e.body = Qr(t)` —— 每次换端点都刷新 nonce 并重算签名，因此**固定 body 不可重放**。`Qr()` 是手写 `encodeURIComponent(k)+"="+encodeURIComponent(v)` 串联。

## 5h. InitCaptchaV2 / V3 请求体拼装（`en()` 落地）

三种 `verifyType` **共用同一条 `jr()` 通道、同一套协议头**，差异只在 `Action` 字符串、前缀和业务字段：

| 项 | 2.0（默认） | 1.0 + userId/userUserId | 3.0 |
|---|---|---|---|
| `Action` | `InitCaptcha` | `InitCaptchaV2` | `InitCaptchaV3` |
| 前缀 `y` | `config.prefix` | `__AliyunPrefix \|\| MD5(userUserId)` | `config.prefix` |
| 额外参数 | — | `+ UserUserId`, `+ UserId` | — |
| 成功回调 | `success(CertifyId)` | `success(CertifyId)` | `success(btoa(JSON({certifyId, sceneId, isSign:true})))` |

三者**共享**的公共字段（`en()` 无条件写入）：`Language`（默认 `"cn"`）、`Mode`、`UpLang`（可选）、`EncryptedSceneId`（可选）、`ExtraInfo`（string 原样 / object 经 `JSON.stringify`）、`DeviceToken`（缺失时取单例 `Br.DeviceToken` 或随机 UUID）、`CertifyId`（仅 `isFromTraceless` 时）、`UserCertifyId` / `UserCheckString`（二选一，取决于有无 `userUserId`）。

`Lr()` 侧另有条件变更（不进 `en()`）：

- `"1.0" === verifyType` → `delete params.DeviceToken` 且 `Br = new Zt`（重置设备单例）
- `userId && userUserId` → 同样重置 `Br` 并清空 `re.userId / re.userUserId`
- 首次初始化（`Br.DeviceConfig === undefined` 且非 traceless）→ `params.DeviceData = Rr(deviceConfig, Br, kr)`，其中 `Rr()` 先用 `yr()` 派生 AES 密钥再 `br([appKey, "WEB", key, appVersion, "CLOUD", ""])`，明文锚点为 `PLATFORM#appName#sceneId#captcha-normal#prefix#region`

**`rn(deviceConfig, deviceCallback, isDev, mode)` 双入口**（`mode` 为第 4 参，两处调用点已确认）：

- `mode = "captcha"` —— offset 238473 后，由 `Lr()` 用 `m.DeviceConfig` 调用
- `mode = "device"` —— offset 239489 后，由 `Mr()` 用 `o.DeviceConfig` 调用

`mode === "device"` 时 `cdnServers` 换成 `cdnDevServers` 并置 `window.d = true`；两条分支共用飞廉 JS 加载（`dynamicJsPath(version)`，5s 超时）与 `window.FEILIN.initFeiLin(Br, cb)` 回调，失败即 `kr.ACTION_STATE.FAIL + {DeviceToken: ""}`。两条分支在 `Br.DeviceConfig` 已存在时都直接跳过（`void 0 === Br.DeviceConfig` 守卫），保证飞廉只初始化一次。

## 5i. `PowVerifyString` / `Question`：本样本零消费

字面量穷举（`_re/deobfuscated.js` 全文）：

| 符号 | 命中次数 | 位置 |
|---|---|---|
| `PowVerifyString` | **1** | offset 234112，`Sr()` 返回对象字面量 |
| `Question` | **1** | offset 234083，同上 |
| `PuzzleImage` | 3 | `Sr()` 1 次（234096）+ `Bn()` 预加载 2 次（268350 / 268454） |
| `pow` / `Pow` / `POW`（PoW 语义） | 2 —— 均为 `Math.pow` 的 SHA256 常量表预计算（40849 / 40874），与工作量证明无关 | — |

即 `Sr()` 只把这两个字段**解包透传**给上层 `Bn()`，本 bundle 内**没有任何求解 / 校验 / 提交代码**。`Bn()` 对它们唯一的间接处理是图片预热：

```js
CaptchaType ∉ {TRACELESS, SLIDING, CHECK_BOX}    // 即拼图 / 滑块类
  → Promise.all([He(u.PuzzleImage), He(u.Image)])
  → Le("js", …, u.CaptchaJsPath, 5e3)              // 加载服务端下发的动态 JS
```

**结论：PoW 求解与拼图校验逻辑位于服务端下发的 `CaptchaJsPath` 动态包内。** 佐证：`window.AliyunCaptcha.prototype` 在本 bundle 中**只被读取、从不被赋值**（offset 267747 读 `prototype.config`，268557 判断 `"function" == typeof window.AliyunCaptcha`）——原型方法的定义方就是动态包。

同理 `VerifyCaptchaV2` / `VerifyCaptchaV3`（`gt` 中已定义）在本 bundle 中**没有调用点**：校验请求由动态包直接发出，**不走 `Nr()`**，因此也不在 §5g.3 的三处清单内。

要取 PoW 算法与难度参数，需抓一次 `CaptchaType ∈ {SLIDING, …}` 的 `InitCaptcha` 实包、解出其 `CaptchaJsPath` 指向的脚本再分析；纯静态分析到此为止。

> **本节结论已被实包验证并细化** → 见 [§5m](#5m-实包验证initcaptcha-已跑通与动态包定位)。上面的静态推断全部成立（PoW 确实不在本 bundle 内），"动态包里到底有什么"现在有了实证答案：**PoW 引擎确实在里面**，入口是 `startPOWCalculation()`；三个方法名（`startCalculation` / `getResult` / `reset`）已解出，并已**完整解出算法**——`SHA256(挑战串 | 16位随机hex nonce)`，digest 首字节 `0x00` 通过。见 [§5m.7](#5m7-pow-算法动态追踪实证_retrace_powjs)。

## 5m. 实包验证：`InitCaptcha` 已跑通与动态包定位

上面 §5i 说的"需要实包"已经拿到了。工具：`_re/send_init_captcha.js`（发一次真实 `InitCaptcha`）、`_re/scan_dynamic.js`（动态包符号审计）。

### 5m.1 前置参数从哪来

`prefix` / `SceneId` 不是 SDK 内置的，来自宿主后端的公开配置接口：

```
GET https://zcode.z.ai/api/v1/client/configs      # 公开, credentials: omit
→ data.configs.captcha = {"enabled":true,"prefix":"no8xfe","region":"cn","sceneId":"11xygtvd"}
```

### 5m.2 跑通结果（协议全部实测通过）

```
POST https://no8xfe.captcha-open.aliyuncs.com/
  13 个参数, Cr() 签名, Version=2023-03-05

→ HTTP 200
  { "Code":"Success", "Success":true, "CertifyId":"coZJurbtcY",
    "StaticPath":"3.29.0/pe.089.0db63cec7a44dbe2", "CaptchaType":"TRACELESS" }
```

这一发同时验证了 §5c 的签名、§5g.4 的响应判定、§5g.5 的端点与 §5l.1 的端点表。

**实际发出的 13 个参数**（`--dry` 输出，可原样复现）：

| # | 参数 | 值 / 来源 | 归属 |
|---|---|---|---|
| 1 | `AaduaneId` | `111jdk439dJJIjd023823201` | `Er.KEY_ID`（§5l.3 已证明是明文常量） |
| 2 | `Action` | `InitCaptcha` | `en()` 默认（`gt.INIT`） |
| 3 | `DeviceToken` | 随机 UUID v4 形态 | `en()` 缺失时的兜底（§5h） |
| 4 | `Format` | `JSON` | `jr()` 固定 |
| 5 | `Language` | `cn` | `en()`，`config.language ?? "cn"` |
| 6 | `Mode` | `popup` | `en()`，`config.mode`（白名单见 §2.2） |
| 7 | `SceneId` | `11xygtvd` | **不是 `en()` 产出**，来自 `In({SceneId}, …)` 初始入参 |
| 8 | `Signature` | `Base64(HMAC-SHA1(...))` | `Cr(params, Er.KEY_SECRET)`（§5c.5） |
| 9 | `SignatureMethod` | `HMAC-SHA1` | `jr()` 固定 |
| 10 | `SignatureNonce` | 随机 UUID v4 形态 | `de()` |
| 11 | `SignatureVersion` | `1.0` | `jr()` 固定 |
| 12 | `Timestamp` | `2026-09-26T11:09:41Z` | `he()`，UTC |
| 13 | `Version` | `2023-03-05` | 常量 `pt` |

`CanonicalizedQueryString`（key 字典序，`=`/`&` 经二次转义）：

```
AaduaneId=111jdk439dJJIjd023823201&Action=InitCaptcha&DeviceToken=<uuid>
&Format=JSON&Language=cn&Mode=popup&SceneId=11xygtvd&SignatureMethod=HMAC-SHA1
&SignatureNonce=<uuid>&SignatureVersion=1.0&Timestamp=2026-09-26T11%3A09%3A41Z
&Version=2023-03-05
```

请求头：`Content-Type: application/x-www-form-urlencoded; charset=UTF-8`（`Ur()`/`qr()` 固定），另带 `Origin: https://zcode.z.ai`、`Referer: https://zcode.z.ai/`（浏览器环境模拟，非协议要求）。

**★ 反向发现：`DeviceData` 缺席也能成功——§5c 的加密链路不是发请求的必要条件。**

真实 SDK 首次初始化时必带 `DeviceData`，即 `Rr()` 用 `FLAG`（内层承诺串）+ `REQ`（外层六元组）双层 AES-128-CBC 加密的设备指纹。本次**完全没发这个字段**，服务端照样返回 `Code:"Success"`。这修正了本文档早前的一个隐含假设——**加密层与"能发出合法请求"是两件事**：

| | `jr()` 业务通道（实测） | `Hr()` 设备/遥测通道（静态） |
|---|---|---|
| 签名密钥 | `Er.KEY_SECRET` | `kr.KEY_SECRET` |
| `Data` / `DeviceData` | **不必填** | 必填（双层 AES） |
| 端点 | `{prefix}.captcha-open.aliyuncs.com` | `cloudauth-device-pre.*` |
| 作用 | 业务鉴权（签名） | 设备指纹采集与风控 |

推论：§5c 还原的那套密钥与算法的价值在于**读懂采集了什么**（配合 [§5d](#5d-deviceconfig-解密与消费schema-已还原) 的清单），而不是"构造出可用的请求"。

**第一次发失败暴露了一个此前没记的参数归属**：`SceneId` 不在 `en()` 的输出里，而在 `In({SceneId}, …)` 的初始入参中（`en()` 只做追加）。漏掉它时服务端回的是**业务错误** `Code:"IllegalScene"` / `"Bad request. The scene is invalid."`——**不是** `SignatureError`，说明签名已通过。判读要点：拿到 `IllegalScene` 说明协议层已经打通，别去查签名。

**尚未验证的分支**：`Success:true` 但 `CaptchaType:TRACELESS`，所以 `LimitFlow` / `LimitedFlowToken`（限流分支）、`403 + x-auth-msg`（`Vr()` 的转换）、`ThrottlingByStrategy` 三条错误路径**本轮均未触发**——它们的判读逻辑（[§5g.4](#5g4-两条通道的响应解析)）仍属静态结论，无实测佐证。

### 5m.3 动态包的真实 CDN（修正 §5e 的混淆）

第一次抓包按 §5e 的 CDN 表去了 `static-captcha.aliyuncs.com`，返回 `NoSuchKey`（OSS bucket `captcha-question.oss-cn-shanghai.aliyuncs.com`）。真正的原因是**文档把两套 CDN 混为一谈**：

| 用途 | 主机来源 | 实际主机 |
|---|---|---|
| 图片（`Image` / `PuzzleImage`） | `imgServer` (`at`) | `static-captcha.aliyuncs.com` |
| **动态 JS / CSS** | **`cdnServers`** | **`g.alicdn.com` / `x.alicdn.com`**（预发 `dev.g.alicdn.com`） |
| 飞廉采集 JS | `cdnDevServers` / `dynamicJsPath` | `g.alicdn.com` |

`Bn()` 里 `u = re.https; a = re.cdnServers;` 然后 `Le("js", u, a, u.CaptchaJsPath, …)`；`le()` 拼成 `https://g.alicdn.com` + `captchaJsPath(StaticPath)`。`captchaJsPath` 的 BASE/SUFFIX 已用字符串表实测确认（`G(478)+G(343)+G(468)+G(458)` = `/captcha-frontend/dynamicJS/`，`G(574)` = `.js`），路径构造本身没错，错的是主机。

正确 URL：

```
https://g.alicdn.com/captcha-frontend/dynamicJS/3.29.0/pe.089.0db63cec7a44dbe2.js
→ HTTP 200, application/javascript, 447,993 B
```

（`g.alicdn.com` 与 `x.alicdn.com` 返回**字节完全相同**的 447,993 B，互为备份。）

### 5m.4 动态包里的 PoW 引擎（§5i 的实证答案）

`_re/scan_dynamic.js` 审计结果：

| 符号 | 次数 | 含义 |
|---|---|---|
| `PowVerifyString` | **4** | 3 处在解析函数 `X()`，**1 处是真正的消费点** |
| `AliyunCaptcha` | 13 | 原型方法在此定义（印证 §5i 的推断） |
| `captchaVerifyCallback` | 5 | §5k 记的接缝，确认在此 |
| `captchaResult` | 1 | 同上 |
| `VerifyCaptcha` | **0** | Action 名不是字面量，被字符串表拆散了 |
| `WebAssembly` / `crypto.subtle` / `sha256` | 0 | PoW 不是 Wasm 或 SubtleCrypto 形态 |

**消费点**（offset 440330）：

```js
e.startPOWCalculation = function () {
  if (this.config.PowVerifyString) {
    nd.reset();                      // 重置 PoW 引擎
    var t = nA.call(this);           // 由实例算出挑战参数
    nd.startCalculation(t);          // 启动计算
  }
};
e.startPOWCalculation();             // init 时无条件调用(有挑战串才真正启动)
```

- `nd` = `np[tf.bind(8,73,283)()]`，是一个**索引取出的单例**（不是 `function nd`），带 `reset()` 与 `startCalculation(t)` 两个方法。
- `nA(t, n, e, r)` 是取挑战参数的函数，内部是控制流平坦化 + `tl` 分派器 + `tf` 字符串表。**其行为已实证**：`nA(this)` 只读 `this.config.PowVerifyString`，并对该字段做 AES-128-ECB 解密得到挑战串（见 [§5m.8](#5m8-挑战串的来源powverifystring-的-aes-明文已端到端证明)）。方法体本身仍未逐行还原，但已无未知环节。
- 独立佐证：动态包里的 `X(t, n)` 与本 bundle 的 `Sr(t, e)` **逐字等价**（同样的 `CaptchaType/Image/CaptchaJsPath/CaptchaCssPath/CertifyId/Question/PuzzleImage/PowVerifyString` 八字段、同样的 `imgServer` 拼接），说明动态包是同一份源码的另一编译产物。

### 5m.5 动态包字符串表已破解（`_re/tables_dynamic.js`）

动态包的字符串表是 `th`，机制与 SDK 本体那 4 套**全不相同**：

| | SDK 本体（`rt`/`xr`/`Ne`/`gn`） | 动态包（`th`） |
|---|---|---|
| 索引偏移 | 314 / 208 / 498 / 468 | **1**（`e[n -= 1]`） |
| 字符表 | **65 字符混排串**（非标准 base64 序，实测 4 条均为小写开头变体，bundle 内另有 1 条标准序） | **128 项 hex 映射数组**，下标取 `114 ^ charCode` |
| 索引稳定性 | **运行时自校验轮转**：checksum IIFE（`709594 === parseInt(rt(314))/1 + … + parseInt(rt(426))/11`）驱动 `push(shift())`，收敛前同一索引指向不同串——静态解码依赖**轮转终态**（实测 8 处轮转点） | 恒定，无轮转 |
| 二次解码 | **需要**：表项多为拼接片段（如 `Z.cn = [G(345)+G(334)+G(599)+"m", …]`），解出的是中间态，需常量传播收敛（deobf.js：19 作用域 / 278 处） | **不需要**：解码即明文 |
| 字节处理 | 直接 `String.fromCharCode(255 & e >> …)` | **再 XOR 一次第二个参数**（逐调用点不同） |
| 包装 | 无 | `tf(t, n) = th(n - 9, t)`；另有一层 `r = function(t,n){ return tf.apply(9, [n, t+6]) }` |

> 表格 v2 修正（2026-09-26）：初版"标准 base64 字母表"与"纯 (表, 索引) 函数"两格不准确——实测轮转 IIFE 与混排字母表后修正如上。修正由外部复核指出，bundle 证据：`push(shift())` ×8、checksum IIFE、`Z.cn` 拼接片段、65 字符混排字母表 ×4。

`th` 的定义完全自包含（4,074 字节），可独立抠出求值。**按调用点实参解码已跑通**，全包扫出的可读串：

```
tf(69,285) -> "SHA1"          ← ★ PoW 的哈希原语
tf(49,199) -> "Hex"
tf(50,264) -> "Pkcs7"
tf(86,37)  -> "getResul"      ← getResult
tf(42,262) -> "innerWid"      ← innerWidth
tf(72,112) -> "ight,scr"      ← "…,height,scr…"(对象字面量键)
tf(82,103) -> ",isTrust"
```

**能确定的（本轮动态追踪实证）**：PoW 引擎的三个方法名已解出（`startCalculation` / `getResult` / `reset`），且在沙箱中实际跑通了完整循环，**算法已完整解出**：

```
call CRYPT.SHA256(<挑战串>|<16位随机 hex nonce>)     # 混合桩观测
```

即 **哈希 = SHA256、输入 = `挑战` + 竖线 + `nonce`、nonce = 16 位小写 hex（64-bit 随机）、digest 首字节为 `0x00` 即通过（难度 2^8）**。

**顺带查明了此前的误判来源**：动态包启动时执行 `td = window["__ALIYUN_CRYPT"]`。此前解出的 `SHA1` / `Hex` / `Pkcs7` 正是 `__ALIYUN_CRYPT`（CryptoJS 风格）的**导出 API 名**,三者同属一个 crypto 层所以一起被解出,与 PoW 选哪个哈希无关。我此前"哈希算法已定"的说法据此纠正为 **SHA256**。（该对象的来源已查实，见 [§5m.8](#5m10-__aliyun_crypt-的来源sdk-本体已查实)）

判定条件与 `getResult()` 的返回形态见 [§5m.7](#5m7-pow-算法动态追踪实证_retrace_powjs)。

因此本节的准确表述是：**PoW 的哈希算法、输入格式、nonce 形态、难度条件均已实证确定**（难度首字节 `0x00`，详见 [§5m.7](#5m7-pow-算法动态追踪实证_retrace_powjs)）。

### 5m.7 PoW 算法：动态追踪实证（`_re/trace_pow.js`）

静态啃 `tl` 成本过高,改用**动态追踪**拿到了确证结论。做法: 把局部变量 `nd` 注入暴露点(`var nd=np;` → 追加 `globalThis.__ND__=nd;`),在最小 DOM 桩的 `vm` 沙箱里执行整包,再对 `window.__ALIYUN_CRYPT` 装一个**记录型 Proxy 桩**——它是该包唯一的加密出口,桩记录下的一切就是 PoW 真正用到的。

**前提发现：动态包自身不带加密库，它读的是 SDK 挂在 window 上的 CryptoJS。**（该对象的实际来源已查实 → 见 [§5m.8](#5m10-__aliyun_crypt-的来源sdk-本体已查实)）

```js
// 动态包启动期(offset 312397 附近)
tp = tf(24,73)          // → "__ALIYUN"
td = window[tp + tf(80,122)]   // tf(80,122) → "_CRYPT"
//  ⇒  td = window["__ALIYUN_CRYPT"]
```

这也**彻底解释了 `SHA1` 谜团**:`SHA1` / `Hex` / `Pkcs7` 不是 PoW 选的哈希,而是 `__ALIYUN_CRYPT`（CryptoJS 风格库）的**导出 API 名**,三者同属一个 crypto 层所以一起被字符串表解出。我此前"哈希算法已定"的说法是错的,现已纠正。

**PoW 的实际行为（记录型 + 真实现混合桩观测）**：

```
call CRYPT.SHA256(DEADBEEFDEADBEEFDEADBEEFDEADBEEF|79d8c0f26c1afa46) => 00ea63b016b51875a976…
call CRYPT.SHA256(DEADBEEFDEADBEEFDEADBEEFDEADBEEF|e0df9f932b0d12fd) => d3f0…
```

| 项 | 结论 | 证据 |
|---|---|---|
| 哈希算法 | **`__ALIYUN_CRYPT.SHA256`**（不是 SHA1） | 桩记下唯一被调用的 API |
| 输入格式 | `<挑战串>` + 竖线 + `<nonce>` | 全部样本同构 |
| nonce | **16 位小写 hex**（64-bit 随机数） | 字符集实测 `0-9a-f`，长度恒为 16 |
| **难度条件** | **digest 首字节 == `0x00`** | **18/18 胜出全为 `00`；4,175 次未命中中 `00` 出现 0 次（随机期望 162）** |
| 期望迭代 | 约 **256** 次 | 各轮均值 198–236，几何分布吻合 |
| `getResult()` | 返回 **Promise**，resolve 值是**胜出 digest**（64 位 hex） | await 结果与桩日志逐字节一致 |

难度即 2^8 —— 对 PoW 而言是很低的门槛，属"轻量反自动化"而非强算力证明。

### 5m.8 挑战串的来源：`PowVerifyString` 的 AES 明文（已端到端证明）

**结论：挑战串 = `AES-decrypt(config.PowVerifyString)`，直接就是明文本身，无需再拼接。**

链路（记录型桩在 `nA` 期间观测到的 `__ALIYUN_CRYPT` 调用，按序）：

```
call CRYPT.enc.Utf8.parse(3e627e1b4c63f913)              ← 16 字符 = AES-128 密钥
call CRYPT.AES.decrypt(<PowVerifyString>, key, [cfg])    ← 解密结果即挑战串
call CRYPT.SHA256(<挑战串>|<16位hex nonce>) => …          ← 接着就是 PoW
```

**端到端证明**（`_re/trace_pow.js` 的「端到端验证」段）：用同一密钥把一个已知明文加密成伪造 `PowVerifyString`，喂回完整入口 `new AliyunCaptcha(cfg)`：

```
明文(挑战串)      : "REAL-CHALLENGE-FROM-POW-0001"
伪造 PowVerifyString: AES-128-ECB + PKCS7 → base64
捕获挑战串        : "REAL-CHALLENGE-FROM-POW-0001"
与明文一致        : true          ← 结构被证明，不是推测
求解              : nonce=e2bcd9bd655cdb26, 124 次迭代命中
```

**密钥来源（已查实，纯本地分析）**：`3e627e1b4c63f913` 是**动态包字符串表里的编译期常量**，与任何会话输入无关。三条独立证据：

1. **调用栈**（在 `Utf8.parse` 那一刻抓的栈）：
   ```
   nA (332454) → tl (304572) → tS (313150) → tl (292845) → CRYPT.enc.Utf8.parse
   ```
   产地位于 offset 292845 的 `tl` 查表状态机中，是**查表**而非运行时计算。
2. **明文在 447,993 字节的包里零出现**（`3e627e1b4c63f913` 与片段 `3e627e` 均 0 次）→ 以密文形式存于 `th` 表。
3. **八组配置下恒定不变**，包括**直接删除** `CertifyId` / `CaptchaId`，以及更换 `region` / `verifyType` / `PowVerifyString`。

因此**不需要实包**即可确认：密钥不随会话派生，是写死在包里的常量。此前"需实包确认"的标注据此撤销。

**这也解释了此前一系列"挑战串为空"的现象**：桩的 `AES.decrypt` 原先返回不可穿透对象，解密必然失败 → 返回 `""` → SHA256 的输入退化成 `|<nonce>`。所以之前扫遍 14 种 `PowVerifyString` 编码全为空，**不是格式猜错，而是密文根本解不开**。

驱动该入口的调用方式（`trace_pow.js` 实测）：配置挂在**构造器原型**上，`o.init.call(this, rS, n)` 取的是 `rS.prototype.config`——

```js
window.AliyunCaptcha.prototype.config = cfg;   // cfg 需含 PowVerifyString / CaptchaType / …
new window.AliyunCaptcha(cfg);
```

`CaptchaType` 取值已见 `"SLIDING"` 与 `"CHECK_BOX"`（offset 360617 提示文案分支）；`r.Sliding` 是其枚举成员。

**完整的最终验证载荷组装**（至此客户端生成器所需的每一环都已知）：

```
1. InitCaptcha 响应 → 取出 PowVerifyString
2. challenge = AES-128-ECB-decrypt(PowVerifyString, key="3e627e1b4c63f913")
3. 循环: nonce = 16位随机hex;  d = SHA256(challenge + "|" + nonce);  直到 d[0:2] == "00"
4. 提交 nonce 与 CertifyId
```

### 5m.9 动态包的全局入口 + 一个影响全局的沙箱缺陷

**先记一个必须纠正的前提**：此前所有追踪都建立在一个**半死状态**的包上。动态包启动时会执行 style-loader 的注入工具（模块 569）：

```js
var r = document.querySelector(insertTarget);   // 旧桩恒返回 null
if (!r) throw Error("Couldn't find a style target. This probably means that the value for the 'insert' parameter is invalid.");
r.appendChild(styleEl);
```

旧的 DOM 桩里 `querySelector: () => null`，于是**包在启动阶段就抛异常中断**，后面所有代码（包括挂载全局入口那段）根本没执行。之前一直看到的 `AliyunCaptcha_clientX` 只是崩溃前侥幸挂上的一个**返回数字的工具函数**，并不是入口——我却拿它驱动了整整两轮。修掉 `querySelector` 并补齐一批浏览器全局（`NodeList`/`Window`/`TouchEvent`/…）后，包才**完整跑完启动流程**，真正的入口才出现：

```
window.AliyunCaptcha          = function (arity 0)   ← 真入口
window.AliyunCaptcha_clientX  = function (arity 2)   ← 工具函数，返回数字
```

`AliyunCaptcha` 读的是 `this.config`，必须用 `ENTRY.call({config})` 绑定 `this` 调用。

**由此得到的配置契约**（用记录型 Proxy 记录 `this.config` 上的属性访问，缺失项已标注）：

| 字段 | 状态 | 备注 |
|---|---|---|
| `rem` | 读到 2 次 | 基准字号 |
| `language` | 缺 → 补 `'zh-CN'` | |
| `button` | 缺 → 补 `{verify, cancel, refresh}` | 按钮文案 |
| `captchaVerifyCallback` | 缺 → 补函数 | 验证回调 |
| `onBizResultCallback` | 缺 → 补函数 | 业务结果回调 |
| `success` / `fail` | 缺 → 补函数 | |
| `element` | 缺 → 补元素对象 | 挂载点 |
| `CaptchaType` / `PowVerifyString` | 已有 | PoW 门控字段 |

**仍未捕获挑战串**——但阻塞点已经精确定位，不再是"不知道卡在哪"：

报错堆栈直接指到 bundle 偏移：
```
at dynamic_captcha.js:1:440165      ← return "3.0"===o.verifyType && "embed"===o.mode && …   （样本已清理，此处为定位记录）
at Object.rS (dynamic_captcha.js:1:444561)   ← window.AliyunCaptcha = rS   （同上）
```

结合 440165 所在函数的入口 `var n, e = t.prototype, o = e.config;`，可知它需要的是**一个构造函数**，并从 **`t.prototype.config`** 取配置——即宿主必须提供 `CaptchaConstructor`（源码 444561 处正是 `this.captcha = new this.CaptchaConstructor({AliyunCaptcha: this})`）。而 `window.AliyunCaptcha = rS` **不会把调用参数转发**给这层，实测传实例、传构造函数、`call` 绑 `this` 均仍报 `reading 'verifyType'`。

**结论**：这不是"再补几个配置字段"能解决的——需要**重建包内部的宿主对象图**（由 SDK 通过 `new CaptchaConstructor(...)` 构造）。属于独立的一块工作量。已确定的输入契约（`nA` 只读 `this.config.PowVerifyString`）与 PoW 算法本身都不受影响。

**方法论教训（本轮最值钱的一条）**：观测环境本身出错时，观测结果会以"技术特性"的形式伪装出来。上一轮我把 `nA` 返回空串归因为"闭包状态未建齐"，其实是**包根本没启动完**；把 `AliyunCaptcha_clientX` 当入口也是同一个根因。**先验证被测对象是否完整初始化，再解读它的行为**——否则会在假象上叠解释。

另一个可复用的手法：**拿异常的堆栈**。这轮之前一直在猜参数形状，打印 `err.stack` 后一步就定位到偏移与源码表达式。凡是"卡在某个 `undefined` 属性"类问题，堆栈比试探便宜一个数量级。

### 5m.9.1 已落地：完整性闸门

教训不能只写下来，得变成会响的闸门。`trace_pow.js` 现在在执行完 bundle 后、**解读任何行为之前**先做一次体检：

```
[2.5] 被测对象完整性闸门:
    启动未抛异常   : 是
    关键全局齐全   : 是        ← AliyunCaptcha / __ALIYUN_CRYPT / __ND__ / __NA__
    window 上全局数: 141
    判定           : 通过 —— 可以解读行为
```

不通过就**直接 `process.exit(2)` 中止**，并打印原因与修复方向，绝不继续解读。

**闸门做过反向验证**（否则就是不会响的摆设）：把 `querySelector` 故意改回恒返回 `null` 重跑，闸门如期拦下——

```
    启动未抛异常   : 否  <-- Couldn't find a style target...
    关键全局齐全   : 否  缺: AliyunCaptcha
    判定           : **不通过**
[!] 包未完整初始化, 以下行为解读全部不可信, 已中止。
```

恢复后重新通过，样本落盘 1,907 条、前两位 `00` 违例 0/1901（随机期望 118.8）——PoW 结论在**完整初始化**的包上复现一致。

### 5m.10 `__ALIYUN_CRYPT` 的来源：SDK 本体（已查实）

这个"动态包自带"的库其实**就在 SDK 本体里**——是 SDK 自己挂上去的。`er` 字符串表里：

| 索引 | 解出 | 作用 |
|---|---|---|
| `er(275)` | `"__ALIYUN"` | 拼成全局名 |
| `er(395)` | `"_CRYPT"` | 同上 |
| `er(251)+er(394)` | `"computeSignature"` | 签名函数挂载点 |
| `er(252)` / `er(396)` | `"AES"` / `"enc"` | 取用 CryptoJS 子模块 |
| `er(256/398/330)` | `"Utf8"` / `"Base64"` / `"Hex"` | 编码器 |
| `er(277)+er(234)` | `"pad"` / `"Pkcs7"` | 填充 |

`aliyun_captcha.js` offset ≈224492 处：

```js
tr()[er(251) + er(394)] = Cr,        // CryptoJS.computeSignature = Cr
window[er(275) + er(395)] = tr(),    // window["__ALIYUN_CRYPT"] = CryptoJS 实例
var or = tr().AES,  cr = tr().enc.Utf8,  ur = tr().enc.Base64,
    ar = tr().enc.Hex, sr = tr().pad.Pkcs7;
```

所以链路是：**SDK 内嵌 CryptoJS（webpack 模块 955）→ 发布为 `window.__ALIYUN_CRYPT` → 动态包启动时读取它做 PoW 哈希**。也顺带说明一件事：`Cr` 签名函数被挂在同一个对象上，动态包理论上也能调用它（本次未观测到这种用法）。

### 5m.11 可执行验证（`_re/solve_pow.js`）

把上述结论做成**能跑的断言**，而不是只写在文档里。脚本用 `trace_pow.js` 落盘的 1,190 条真实样本反向校验每一条结论：

```
[1] 样本结构          nonce 长度恒为 16 / 全小写 hex / digest 全 64 位 hex
                      digest == SHA256(挑战|nonce)  逐条可复现        ← 输入格式
[2] 难度条件          全部胜出均满足 "00" 前缀        6/6
                      未命中样本中无一满足 "00"        0/1184（随机期望 4.6）
                      未命中首 nibble 服从均匀分布      chi2=9.1 < 25.0   ← 反证"首 nibble=0"
[3] 迭代次数          均值 198 vs 理论 256，落在 3σ 内
[4] 求解器自检        实跑 5 个随机挑战全部命中
结果: 13 通过, 0 失败
```

其中 `[2]` 的 chi2 检验是关键一环：它**统计地证伪**了"首 nibble 为 0"这个更简单的假设（165/4175 次未命中里出现 65 次，恰好是 1/16 的随机期望），把条件唯一钉死在首字节 `0x00`。

**完整求解配方**：

```js
function solvePow(challenge) {
  for (;;) {
    const nonce = crypto.randomBytes(8).toString('hex');   // 16 位小写 hex
    const digest = sha256(challenge + '|' + nonce);
    if (digest.slice(0, 2) === '00') return { nonce, digest };
  }
}
```

**方法论价值**：`trace_pow.js` 的做法对"重度混淆 + 外部依赖注入"的包是通用的——**不必解开控制流，只要找到唯一的 I/O 出口并替换成记录器**，就能观测到程序的真实行为。本例中该出口是 `window.__ALIYUN_CRYPT`；对 SDK 本体则是 `window.__AYF`(XHR 发送器)与 `Xr()` 的网络层。

**踩过的两个坑（都曾伪装成"技术分叉"，实为脚本缺陷）**：

1. **桩的日志被绕过**。我原写 `real.SHA256 = realSha256` 把真实现直接挂在桩对象上，但 Proxy 的 `get` trap 会**原样返回这个裸函数**，从而跳过 `apply` trap——真实调用不进日志，表现为"迭代 0 次"。我据此下了"真实哈希下判定分支不触发"的结论，**那是错的**。修法：在 `get` trap 里对 `SHA256` 单独返回"记日志 + 调真实现"的包装函数。**教训：观测工具本身没被观测到时，"没看到"不能当"没发生"。**
2. **`getResult()` 必须在 `startCalculation()` 之后立刻取**。它是 Promise；等计算跑完再取，promise 已无人 resolve，`await` 永久挂死，且 Node 因事件循环空转而静默退出，看起来像崩溃。

**仍未确定**：真实挑战串的结构与编码方式。合成挑战下难度恒为 2^8；真实 `PowVerifyString` 是否携带可变难度、最终验证载荷如何组装，仍需一次 `CaptchaType` 为拼图类的实包。

### 5m.12 剩余工作

> ⚠️ **本节「剩余工作」已作废** → 已由 §5m.13 / §5m.14 / §5m.15 收口。§5m.13 起路线改为 **happy-dom 加载真实 SDK**（不再手工拼 `VerifyCaptcha`），因此下面第 2、3 条——「真实挑战是否携带可变难度，未验证」与「需换 IP/UA/设备指纹或触发限流才能拿到带挑战的响应」——**均不再适用**：PoW 难度由 SDK 内部处理，TRACELESS 链路本就不下发挑战串。本节保留为该阶段（静态还原路线）的决策记录。

- **已解**：`PowVerifyString` → 挑战串的编码规则。挑战串 = `PowVerifyString` 的 **AES-128-ECB 解密明文**（密钥 `3e627e1b4c63f913`，为包内字符串表常量），已用伪造密文端到端往返验证一致。此前"排除 14 种简单编码后仍为空"的判断方向有误——真正原因是桩的 `AES.decrypt` 解不开密文，并非格式不对。详见 [§5m.8](#5m8-挑战串的来源powverifystring-的-aes-明文已端到端证明)。
- **未验证（非阻塞）**：真实挑战是否携带可变难度（合成挑战下恒为 2^8）。
- 本次拿到的 `StaticPath` 版本是 **`3.29.0/pe.089.*`**，而本地 SDK 是 `VERSION: "1.3.4"`，版本落差明显；且 `CaptchaType` 是 `TRACELESS`，响应里没有 `PowVerifyString`/`PuzzleImage`（走的正是 SDK 本体那条空值分支）。要看到带挑战串的响应，需让服务端判定为需要交互（换 IP/UA/设备指纹，或反复触发限流）。


### 5g.2 动作决策链 `en()` 与版本路由 `Lr()`

验证码初始化主流程 `Lr()` 在调用 `Nr()` 发起网络请求前，由 `en(t, e)` 计算目标 RPC Action 与域名前缀：

```js
// en(targetParams, config) 核心决策逻辑：
var d = Er.ACTION.INIT; // 默认 "InitCaptcha"
var y = r;             // 默认 prefix

if (userUserId && userId && "1.0" === verifyType) {
  // 1.0 用户维度隔离：前缀转为 MD5(userUserId)
  y = e.__AliyunPrefix || Ze()(userUserId).toString();
  targetParams.UserUserId = userUserId;
  targetParams.UserId = userId;
  d = Er.ACTION.INITV2; // "InitCaptchaV2"
}

if ("3.0" === verifyType) {
  d = Er.ACTION.INITV3; // "InitCaptchaV3"
}
```

- **verifyType 2.0（ZCode 默认采用）**：发起 `InitCaptcha`，前缀保持远端下发的 `prefix`（如 `no8xfe`），端点形如 `https://no8xfe.captcha-open.aliyuncs.com/`。
- **设备指纹兜底**：若入参无 `DeviceToken`，则从单例 `ne.DeviceToken` 或随机 UUID 派生补齐。
- **环境安全审计结论**：`window.__AYF` 确认为 offset 251645 处对内部网络日志发送句柄 `Vr`（即封装 `XMLHttpRequest` 的底层 POST 请求器）的暴露，无任何隐式执行或第三方数据回传管道。



**已建立的完整链条**（每一环都有可复跑的证据）：

```
GET configs.captcha → initAliyunCaptcha → startTracelessVerification
   → success(param) = {sceneId, certifyId, deviceToken, failover}
   → runtime-headers RPC → 模型请求 / billing/claim 请求头
   → 服务端核销 → 3007 / F008 反馈闭环
   └─ SDK 静态加密层：密钥 / IV / 算法 / 双层 Data 构造 / HMAC-SHA1 签名，全部还原（§5c）
```

具体覆盖项：

- `configs.captcha` 的取值、60s 缓存与失效判定
- SDK 接入参数与 param 的单次有效生命周期（`Enn` 缓存 → 下发 → `Dnn` 删除）
- host ↔ agent 的 RPC 下发链与两个头的白名单透传
- 服务端错误码谱系（`3007` / `F008` / `CAPTCHA_INTERACTIVE_REQUIRED` / `coding_plan_security_verification_required`）
- SDK 静态加密层（[§5c](#5c-静态加密层完整还原web_aes_secret_key)）：`WEB_AES_SECRET_KEY` 5 项明文、`KEY_ID`、`KEY_SECRET`、IV 两跳派生、双层 `Data` 构造、`Base64(HMAC-SHA1(...))` 签名

**已推进完成的四项**（原"可继续推进"逐条做完，各自结果如下）：

| # | 事项 | 结果 | 见 |
|---|---|---|---|
| 1 | 服务端核销细节 | **客户端侧完整**：`Sr()` 响应 8 字段 + `Hr()` 请求全参数（AaduaneId/Version/SignatureMethod/Action/Data/Signature/SignatureNonce）+ 4 个错误码。**服务端侧**可用同一套 `Hr()`/`Cr()` 栈直接复现——差的只是阿里云对 ZCode 侧的实包 | [§5e](#5e-验证响应-schema-与-sr-解析) |
| 2 | `DeviceConfig` 具体内容 | **已还原**：RES 密钥 → `#` 分隔 → 9 字段（含 key/switch/sessionId/version/pluginElements/pluginResource/globalVariable/timestamp/ip），消费链 `mr()`→`rn()`→飞廉 JS 与 4 个资源 URL 构造全部解出 | [§5d](#5d-deviceconfig-解密与消费schema-已还原) |
| 3 | 加密 payload 字段清单 | **已还原**：采集清单三类（`pluginElements`/`pluginResource`/`globalVariable`，`wr()` 可离线解），日志上报 7 个 logInfo 键 + 8 个 `logs` 计时打点 | [§5d.2](#5d2-九字段)、[§5f.2](#5f2-loginfo-字段) |
| 4 | `UPLOAD` / `PREID` 调用链 | **已定论**：穷举确认二者在本样本各仅出现 1 次且都是赋值，零消费点——属同系列 build 的保留位；明文密钥已解出备用 | [§5f.3](#5f3-upload-与-preid保留位本版本零消费) |
| 5 | `Nr()` 全量分流 + 两路响应解析 | **已定论**：全样本仅 3 处 `Nr()` 调用，`Hr()` 只有 `Mr()` 的 `"Log1"` 一个入口；`UploadLog` 走 `jr()` 而非 `Hr()`（修正 §5f.1）。`jr()` / `Hr()` 的响应判定、截断条件、重试与重签全部解出 | [§5g.3](#5g3-三个-nr-调用点全样本穷举仅-3-处)、[§5g.4](#5g4-两条通道的响应解析)、[§5g.5](#5g5-传输与重试底座-gr两通道共用) |
| 6 | `InitCaptchaV2` / `V3` 请求体拼装 | **已定论**：三版本共用 `jr()` 通道与协议头，差异仅 `Action` / 前缀 / 三个业务字段；`rn(..., "captcha" \| "device")` 双入口语义与守卫条件均已确认 | [§5h](#5h-initcaptchav2-v3-请求体拼装en-落地) |
| 7 | `PowVerifyString` / `Question` 校验逻辑 | **静态分析已到边界**：两字段在 bundle 内各仅 1 次命中（`Sr()` 解包），零消费点；PoW 求解与 `VerifyCaptcha*` 提交均位于服务端下发的 `CaptchaJsPath` 动态包内（`AliyunCaptcha.prototype` 本 bundle 从不赋值即为佐证）。继续推进需一次 puzzle 实包 | [§5i](#5i-powverifystring-question本样本零消费) |
| 8 | `Cr()` 签名算法 | **已完整还原并验证**：`"POST&%2F&" + Ar(规范化查询串)`，key 字典序升序，`KEY_SECRET + "&"`；`Ar()` 三处替换含"非全局、只替首个"的细节。`_re/verify_signature.js` 4 组断言全通过 | [§5c.5](#5c5-加密采集的真实链路) |
| 9 | `Sr()` 副作用与 CDN 路由 | **已补全**：新增记录 case 4 的 `cfg.imgServer` 回写、`j = j[region]` 两级取值与静默 `undefined` 形态，以及此前完全缺失的 `captchaJsPath` / `captchaCssPath` / `devicePath` 路径构造 | [§5e](#5e-验证响应-schema-与-sr-解析) |
| 10 | 去混淆工具链 | **已修复**：还原率 27 → 278 处。三处根因（残缺的 `er` 表、函数表达式漏匹配、作用域跳过 + 别名覆盖）均定位并修复 | [§5j](#5j-去混淆工具链四张字符串表) |
| 11 | 第四套字符串表 `gn` | **已接入**：bundle 实有 4 套表（`rt`/`xr`/`Ne`/`gn`），此前只扫了 2 套。补上后解出 §2.2 的 `mode` / `region` 白名单 | [§2.2](#22-mode-与-region-的取值域cn-白名单) |
| 12 | `verifyType` 隐式改写 | **新发现**：页面存在 `#waf_nc_block` 时 `verifyType` 被**强制降级为 `"1.0"`**，并连带切换 appName / appKey / 端点 | [§2.1](#21-verifytype-的隐式改写) |
| 13 | `verifyType: "1.0"` 回调链 | **新发现**：`pn()` 组装 `{sceneId, certifyId, deviceToken, failover:"T"}`；`captchaVerifyCallback` 是本 bundle 与动态包的**唯一接缝**，动态包经它回传 `{captchaResult, bizResult}` | [§5k](#5k-verifytype-10-的兜底与回调链) |
| 14 | 端点表 / 应用身份表 | **新发现**：业务端点按 `verifyType` 硬隔离（`1.0` 走 `captcha-pro-open.*`，`2.0/3.0` 走 `captcha-open.*`）；设备通道端点自带 `-pre`。新增可执行汇总脚本 | [§5l](#5l-端点表-应用身份表) |
| 15 | `Se()` `verifyType` 权威决策 | **新发现**：传 `verifyType:"1.0"` 但缺 `userId`+`userUserId` 会被**静默降级为 `"2.0"`**；3.0 分支强制 `immediate=true` | [§2.1](#21-verifytype-的隐式改写) |
| 16 | `at.sgp` / `at.ga` 取值 | **不带 `-pre`**：正式表取值无该后缀。由脚本交叉断言锁定 | [§5e](#5e-验证响应-schema-与-sr-解析) |
| 17 | `appName` / `appKey` | 两者都是**明文**。`appKey` 是 32 位 hex 串、形态酷似 §5c 密文，但 `Rr()` 里直接进 `br()` 加密，无 `gr()` 解密。已给出明文值与反证 | [§5l.3](#5l3-应用身份-appname-appkey) |
| 18 | 实包验证 `InitCaptcha` | **已跑通**：13 参数 + `Cr()` 签名 → `Code:"Success"`，签名/响应判定/端点表全部实测通过。首次失败暴露 `SceneId` 属初始入参而非 `en()` 输出 | [§5m.2](#5m2-跑通结果协议全部实测通过) |
| 19 | 动态包定位 | **已定位并下载**：447,993 B。**修正 §5e 的 CDN 混淆**——动态脚本走 `cdnServers`（`g.alicdn.com`），不是 `imgServer` | [§5m.3](#5m3-动态包的真实-cdn修正-5e-的混淆) |
| 20 | PoW 引擎 | **已完整解出**：动态包内 `startPOWCalculation()` → `nd.reset()` / `nA.call(this)` / `nd.startCalculation(t)` 三步已通；`nA` 读 `this.config.PowVerifyString` 并 AES 解密得挑战串；PoW 为 `SHA256(挑战 \| 16位随机hex nonce)`，digest 首字节 `0x00` 通过。引擎在动态包，**不在** SDK 本体 | [§5m.7](#5m7-pow-算法动态追踪实证_retrace_powjs) / [§5m.8](#5m8-挑战串的来源powverifystring-的-aes-明文已端到端证明) |
| 21 | 动态包字符串表 | **已破解**：`th` 表（偏移 -1、128 项 XOR 字符表、逐调用点密钥），与 SDK 那 4 套机制全不同。**并查明 `SHA1`/`Hex`/`Pkcs7` 是 SDK 内嵌 CryptoJS（`window.__ALIYUN_CRYPT`）的 API 名，不是 PoW 选的哈希** | [§5m.5](#5m5-动态包字符串表已破解_retables_dynamicjs) |
| 23 | PoW 算法动态追踪 | **已完整解出**：注入 `nd` + 混合桩 + 最小 DOM 沙箱。**`SHA256(挑战` + 竖线 + `16位随机hex nonce)`，digest 首字节 `0x00` 通过（难度 2^8）**，`getResult()` 返回 Promise resolve 胜出 digest。含可执行求解配方 | [§5m.7](#5m7-pow-算法动态追踪实证_retrace_powjs) |
| 24 | `__ALIYUN_CRYPT` 来源 | **已查实**：SDK offset ≈224492 执行 `window["__ALIYUN_CRYPT"] = tr()`，把内嵌 CryptoJS 发布为全局；签名函数 `Cr` 同挂于该对象 | [§5m.10](#5m10-__aliyun_crypt-的来源sdk-本体已查实) |
| 25 | 挑战串构造入口 | **已解出**：`startPOWCalculation` 以 `config.PowVerifyString` 门控，挑战串 = `AES-128-ECB-decrypt(PowVerifyString)`，密钥为包内字符串表常量 `3e627e1b4c63f913`，已用伪造密文端到端往返验证 | [§5m.8](#5m8-挑战串的来源powverifystring-的-aes-明文已端到端证明) |
| 26 | PoW 可执行验证 | **`_re/solve_pow.js`：13 项断言全过**——输入格式逐条复现、难度条件 chi2 检验、迭代分布、求解器实跑自检 | [§5m.11](#5m11-可执行验证_resolve_powjs) |
| 22 | `DeviceData` 必要性 | **本轮反向发现**：不发送 `DeviceData` 也能成功。§5c 的双层 AES 服务于设备指纹采集与风控，**不是业务鉴权**；`jr()` / `Hr()` 两通道必填字段集合不同 | [§5m.2](#5m2-跑通结果协议全部实测通过) |

**当前余项**：

- **客户端生成器所需的每一环均已确定并可执行验证**：请求协议（头/签名/请求体/响应解析/端点轮转）、`__ALIYUN_CRYPT` 来源、PoW 引擎（`SHA256(挑战` + 竖线 + `16位hex nonce)`，digest 首字节 `0x00` 通过，期望 256 次）、挑战串来源（`PowVerifyString` 的 AES-128-ECB 明文，密钥为包内字符串表常量 `3e627e1b4c63f913`）。校验见 `_re/solve_pow.js`（13/13）与 `_re/trace_pow.js`（端到端往返一致）。
- **未验证项**（见 [§5m.13](#5m13-端到端实跑闭环captcha_nodesolverjs)）：真实服务端下发的 `PowVerifyString` 是否确为 base64 → **已定论：`CaptchaType:TRACELESS` 的 InitCaptcha 响应根本不含该字段**（PowVerifyString 仅交互式拼图下发，印证 §5i）；真实挑战的难度是否仍为 2^8（无痕链路下 PoW 在 pe 动态包内部完成，外部不可见，属既定结论的不可达确认）；`Success:true` 但限流分支（`LimitFlow`/`LimitedFlowToken`、`403 + x-auth-*`）仍待一次限流实包。

`param` 由阿里云 SDK 基于设备/行为指纹签发，服务端核销一次即失效——这是免费通道（Start Plan 模型请求、计划领取）中该令牌的完整生命周期。本文档已覆盖：令牌的静态结构（[§5b](#5b-sdk-内部解剖对-aliyuncaptchajs-的静态分析)）、本地加密层（[§5c](#5c-静态加密层完整还原web_aes_secret_key)）、客户端调用链；服务端核销已获实跑证据（`T001`/`securityToken`，见 [§5m.13](#5m13-端到端实跑闭环captcha_nodesolverjs)）。param 在模型请求通道的**全链 200**（3012 构建层修正后）见 [37 §8.2](zcode-plan-37-排障手册.md)。

### 5m.13 端到端实跑闭环（`captcha_node/solver.js`）

**路线变更**：不再手工拼 `VerifyCaptcha` 请求（Action 与字段名被动态包字符串表拆散，静态还原到此为止），改用 **happy-dom 模拟浏览器加载真实 `AliyunCaptcha.js` SDK**，由 SDK 自己完成 PoW 求解与提交。实现改编自 [dengyie/zcode2api](https://github.com/dengyie/zcode2api) `captcha_node/solver.js`（**AGPL-3.0**，本地私有使用合规；对外提供服务需开源同许可），依赖仅 `happy-dom`。

```bash
cd captcha_node && npm install
node solver.js 11xygtvd sgp no8xfe     # → VERIFY_PARAM=<base64>
```

**实跑新证据**（均来自 2026-09-27 真实抓包，非读码结论）：

| # | 事实 | 证据 |
|---|---|---|
| 1 | **`VerifyCaptcha` 端点 = `{prefix}-verify.{apiServer}`** | 实测 `no8xfe-verify.captcha-open-southeast.aliyuncs.com`；`region:sgp` 时 `apiServer=captcha-open-southeast.aliyuncs.com`，与 §5l.1 端点表吻合，`-verify` 是提交专用前缀变体 |
| 2 | **TRACELESS 的 InitCaptcha 响应不含 `PowVerifyString`** | 实测响应字段仅 `CertifyId/Message/RequestId/Code/LimitFlow/Success/StaticPath/CaptchaType/DeviceConfig`——印证 §5i"本样本零消费"，PoW 挑战串只在拼图链路下发 |
| 3 | **验证成功响应结构** | `Result.VerifyCode:"T001"`、`VerifyResult:true`、`securityToken`（约 150 字符）、`certifyId` 与 Init 阶段一致 |
| 4 | **最终 param 结构** | `base64(JSON {certifyId, sceneId, isSign:true, securityToken})`——即 §5b 的 **3.0 变体形态**（`isSign:true`），不是 2.0 四元组 |
| 5 | **StaticPath 版本轮转** | 实测同会话内 `3.29.0/pe.091.*` → `pe.093.*`；个别 pe 版本会失速（VM 卡死），求解器以 stall 检测（`CAPTCHA_STALL_MS`，默认 6s 无新 XHR）淘汰缓存并重试 |
| 6 | **动态包即验证提交方**（呼应 §5i） | 提交 POST 由 pe 动态包内代码经 SDK 网络层发出，印证"VerifyCaptcha 不走 `Nr()`/`Hr()` 本体通道" |

> 注：无痕链路下 PoW 在 pe 包内部运行（SHA256/nonce/难度即 §5m.7 实证结论），但外部只能看到请求/响应，无法直接观测哈希循环——这与 trace_pow.js 的沙箱观测（§5m.7）互为补充。

### 5m.14 VerifyCaptchaV3 请求体实抓与 Cr() 签名终验（2026-09-27）

**手段**：给当时的 `captcha_node/solver.js` 加 `CAPTCHA_CAPTURE=1` 抓包开关（`beforeAsyncRequest` 直通道内，落盘 `_re/capture_verify.json`，记录全量请求头/体/响应头/体）。跑通一次完整求解后得到 8 条真实请求：

| # | 端点 | Action | 说明 |
|---|---|---|---|
| 1 | `{prefix}.captcha-open-southeast…` | **InitCaptchaV3** | 13 参 + `DeviceData`（TEQ 开头密文）+ 签名 |
| 2 | `upload.captcha-open-southeast…` | UploadLog | `log` 字段：INIT_SUCCESS / DYNAMICJS_LOADED 计时打点 |
| 3 | `ap-southeast-1.device.saf.aliyuncs.com` | Log2 | **另一套 AaduaneId**（`DuaneAprqkYsF3nt1yjK29Bf`，飞廉设备指纹 SDK 自己的身份与密钥，非 KEY_ID/KEY_SECRET） |
| 4 | `cloudauth-device-dualstack.ap-southeast-1…` | Log3 | 同上 |
| 5 | `{prefix}-verify.captcha-open-southeast…` | **VerifyCaptchaV3** | 求解成功后的提交 |

**VerifyCaptchaV3 请求体全字段**（此前静态还原只到「动态包发出、参数名被混淆」，本轮实抓定型）：

```
AaduaneId=111jdk439dJJIjd023823201          # 与 InitCaptchaV3 同一 KEY_ID
&SignatureMethod=HMAC-SHA1&SignatureVersion=1.0&Format=JSON
&Timestamp=<UTC>&Version=2023-03-05
&Action=VerifyCaptchaV3
&SceneId=11xygtvd
&CertifyId=<Init 阶段返回的 CertifyId>
&CaptchaVerifyParam=<URL编码的 JSON>
&SignatureNonce=<uuid>&Signature=<HMAC-SHA1>
```

其中 `CaptchaVerifyParam` 解码后为 JSON：`{sceneId, certifyId, deviceToken, data}`——`deviceToken` 即 §5h 飞廉回传的设备令牌，`data` 为 pe 动态包产出的行为/风控负载。**成功响应**：`Result.VerifyCode=T001 / VerifyResult=true / securityToken`（与 §5m.13 表 3 一致）。

**deviceToken 结构解码**（base64 后 `#` 分 5 段）：

```
SG_WEB # <deviceId32hex>-h-<ms时间戳>-<uuid32hex> # <加密payload 960B64/158B> # 0 # <32位hex 校验>
```

`deviceId` 与 InitCaptcha 响应 DeviceConfig 解出的 key 同源；第 3 段为 158 字节高熵加密体（ECB/CBC 均不对齐，疑似 CTR/流密码，密钥在 pe 包内），第 5 段疑似其校验摘要——**停止深挖**：该令牌由飞廉 SDK 内部自洽生成，自研实现直接复用 solver.js 的 happy-dom 路线即可整体获得，无需逐字节还原。

**Cr() 签名终验**：`_re/check_captured_signature.js` 对抓包 5 条验证码请求（2×InitCaptchaV3 + 2×UploadLog + 1×VerifyCaptchaV3）复算 HMAC-SHA1，**5/5 与抓包 Signature 完全一致**（Log2/Log3 用设备 SDK 自己的密钥对，不适用 KEY_SECRET，不参与比对）。至此签名层对全部三种 Action 实测定型：`POST&%2F&Ar(键序规范化串)`、`KEY_SECRET + "&"`、`Ar()` 三处替换——与 §5c.5 静态还原结论互证。

**自研求解器剩余缺口（收窄到两项）**：`deviceToken` 第 3 段加密 payload 与 `CaptchaVerifyParam.data`（pe VM 产物）——两者均由 pe/飞廉在浏览器环境内生成，这正是采用 happy-dom 路线的原因；纯 node:crypto 自研到 PoW + 签名 + 请求拼装为止已全部打通。

### 5m.15 业务环闭环：param 核销进真实模型请求（2026-09-27）

求解器产出的 `VERIFY_PARAM` 塞进 `X-Aliyun-Captcha-Verify-Param`（成对发 `X-Aliyun-Captcha-Verify-Region: cn`）后直打 ZCode Plan 通道，**上游 HTTP 200**——至此验证码链路含业务消费端全环打通。请求装配复用 dengyie 真实现（`zcode2api-dengyie/app/` 的 `body_transform` + `identity` + `constants`），复跑脚本 `tools/e2e_captcha_gate.py`。

- **3012 真因三项**（终定性见 plan-37 §8.2；与验证码、JWT、IP 均无关）：① system 缺 `zcode_system.json` 官方身份块（CLI Prefix / Agent Identity / Environment Info + 动态 currentModel，主因）；② `metadata.user_id` 形状错（官方为 JWT payload 的 uuid）；③ 客户端指纹头透传泄漏（`x-stainless-*` 等）。整体采纳 dengyie 请求构建层后全链 200。
- **模型名大小写敏感**：小写 `glm-4.6` → `400 code 3006 model not allowed`；须用官方名（本账号实测可用 `GLM-5.3-Flash` / `GLM-5.3`，见 `constants.AVAILABLE_MODELS`）。
- **param 生命周期印证**：现解现用、一参一请求——池化缓存超过服务端核销窗口即失效，dengyie `captcha.py` 的 `TOKEN_TTL_MS` 与本轮实测一致。



## 5n. 客户端验证码诊断子系统

客户端在 `%USERPROFILE%\.zcode\v2\logs\YYYY-MM-DD.log` 里输出两个日志通道，用于观测 SDK 生命周期与题面资源加载。

### 5n.1 `[captcha-diagnostics]`（renderer）

```json
{"event":"sdk.callback","attemptId":"<uuid>","requestId":"<sess>:<provider-runtime-headers>:<uuid>",
 "providerId":"account:zai-start-plan","source":"send_preflight|prewarm","elapsedMs":3529,
 "stage":"verification|sdk_init","instanceReady":true,"lastSdkEvent":"getInstance|success|fail",
 "controllerId":"<uuid>","callback":"getInstance|success|fail|onError","accepted":true|false,
 "sdkCode":"F008"}
```

| 字段 | 含义 |
|---|---|
| `attemptId` / `controllerId` | 一次验证尝试的关联 id |
| `source` | `prewarm`（SDK 预热）/ `send_preflight`（发请求前置校验触发） |
| `stage` | `sdk_init` / `verification` |
| `callback` | SDK 回调名；**`accepted` 才是外层是否采纳** |
| `sdkCode` | 客户端 SDK 码，**注意不是 `Cs` 业务码**，不进 [37 §2.3](zcode-plan-37-排障手册.md) 那张表 |

**`callback:"success"` 但 `accepted:false` 是真实存在的组合**——SDK 自认成功，外层未采纳，判读时不能只看 `callback`。

### 5n.2 `[captcha-network]`（main）

```json
{"event":"resource.start|resource.failed","networkRequestId":1357,"webContentsId":1,
 "kind":"init_api|image|sdk_log","host":"[prefix].captcha-open.aliyuncs.com|static-captcha.aliyuncs.com",
 "path":"/[image]","elapsedMs":2813,"statusCode":200,"errorCode":null}
```

**关键语义：`resource.failed` 不等于网络故障。** 2026-09-27 实测三例全部为 `statusCode:200` + `errorCode:null` 却被标 `failed`——**HTTP 层成功，是客户端自身的校验把这批资源丢弃**。这与 `zcode2api-plus` README 记载的"发行版自带 Chromium 会被风控拒绝"是同一现象，也是本项目采用 happy-dom 而非真实浏览器的反向印证。

**下次见到 `resource.failed`，不要再排查网络。**

### 5n.3 `F008` 与失败实例

2026-09-27 16:47 一次完整失败链（`providerId=account:zai-start-plan`，`source=send_preflight`）：

| 时刻 | callback | sdkCode | accepted |
|---|---|---|---|
| 16:47:48.403 | `fail` | **`F008`** | false |
| 16:47:48.808 | `getInstance` | — | false |
| 16:48:55.372 | `success` | — | **false** |

同期 `image` / `init_api` / `sdk_log` 三类资源全部 `resource.failed`。**`F008` 即在此状态下产生，题面未加载时无题可解。**

### 5n.4 基线：这是例行流量，不是风控信号

| 日志 | `[captcha-diagnostics]` | `[captcha-network]` | `callback:"fail"` |
|---|---|---|---|
| 2026-09-26 | 9526 | 5304 | **0** |
| 2026-09-27 | 3414 | 2040 | **2** |

09-26 的回调分布：`getInstance` 679 / `success` 678 / `onError` 1（`source:"prewarm"`、`stage:"sdk_init"`、`elapsedMs` 约 3.5s）。

**结论：每天数千次是 SDK 预热的常态，不能当作"账号被验证码施压"的信号。** 判断异常必须与同口径基线对照，不能拿绝对条数下结论。

### 5n.5 对本项目的价值边界

**不可用于**业务链路：本子系统走 GUI SDK 路径，与 §5m.15 的程序化 3007 链路不互通；日志中只有 `attemptId`，**不含 verify param**，不能作为 solver 的真值来源，也不构成 3012 的判据。

**可用于**：① 首次记录该子系统的字段结构；② `F008` 补入错误谱系（属客户端 SDK 码，非业务码）；③ 确立 `resource.failed` + 200 的语义，避免重复排查网络。
