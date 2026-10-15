# 38 · 外部报告交叉核对

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 对象：[HardworkingChen/zcode-tools · 逆向分析报告-ZCode-智谱.md](https://github.com/HardworkingChen/zcode-tools)
> 核对日期：2026-09-27；§6 追加 GitHub 搜索面（330 命中）× oh-my-pi #8802 核对，2026-10-13

## 0. 前提差异（先对齐再比）

| | 外部报告 | 本文档集 |
|---|---|---|
| 日期 | 2026-08-18 | 2026-09-26/27 实测 |
| 版本 | 桌面端 **3.7.7** | CLI **3.4.0**（`sir`）/ 请求头 **3.14.3** |
| 载体 | `app.asar` 297 MB（Electron 桌面端） | `resources\glm\zcode.cjs` 14.1 MB（**CLI 独立产物**） |
| 方法 | 浏览器被动观测 + asar 静态分析 | bundle 符号追踪 + **实调接口** |
| 实调 | 无（纯静态） | 有（balance / preview / 聊天端点） |

**关键：`app.asar` 与 `zcode.cjs` 是两个不同产物。** 报告分析的桌面端走 `zcode://` 自定义 scheme 回调；本机 CLI 走服务端回调。**§2 的冲突多半源于此，不是谁错。**

---

## 1. 相互印证的部分（高置信）

| 结论 | 外部 | 本文档 | 备注 |
|---|---|---|---|
| 生产 `client_id` = `client_P8X5CMWmlaRO9gyO-KSqtg` | ✅ | [10 §1.2b](zcode-plan-10-OAuth登录流程.md) 实测一致 | |
| 测试 `client_id` = `client_RzngVdSk8sYsG2_3HzOMdQ` | ✅ | [10 §0.1](zcode-plan-10-OAuth登录流程.md) 从 `oir` 解出 | 报告直接写明 |
| `zcode.z.ai` 统一兑换 zcodejwt | ✅ | [10](zcode-plan-10-OAuth登录流程.md) 一致 | |
| `api.z.ai/api/auth/z/login` 换业务 token | ✅ | [10 §3.1](zcode-plan-10-OAuth登录流程.md) 一致 | |
| 双 OAuth 体系（zai / bigmodel） | ✅ | [01](zcode-plan-01-计划体系与供应商标识.md) 一致 | |
| 生产固定走 `z.ai`，`chatglm.site` 系为测试 | ✅ | [10 §0.1](zcode-plan-10-OAuth登录流程.md) `YL()` 一致 | 独立佐证 |
| 阿里云负责采集设备指纹（非 ZCode 自算） | ✅ | [12](zcode-plan-12-阿里云验证码体系.md) 一致 | |

**六个独立佐证点**，其中 `client_id` 生产/测试这一条两边各自从不同来源得出（我方从 CLI 常量表，报告从 asar provider 配置），**互为交叉验证**。

---

## 2. 冲突项

### 2.1 `redirect_uri` 形态（**产物不同，非矛盾**）

| | 外部报告 | 本机实测 |
|---|---|---|
| 桌面端 3.7.7 | `zcode://oauth/callback`（**自定义 scheme**） | — |
| CLI（zcode.cjs 3.4.0） | — | `https://zcode.z.ai/api/v1/oauth/cli/callback/zai`（**服务端 HTTP**） |

两者都自洽——**CLI 不需要本地监听端口，桌面端需要**。10-14 第三方源码旁证坐实三事：桌面回调协议名实为 **`zcode://zai-auth/callback`**（唤起入口 `zcode://zai-auth/`）；桌面 OAuth 流量走系统代理且**无证书钉扎**（本地 MITM 可解密）。[10 §1.2b](zcode-plan-10-OAuth登录流程.md) 记的"回调是服务端侧的"仅对 CLI 成立，已在文中限定。

### 2.2 `app.asar` 里没有 `zcodejwttoken` 这一说法

报告称兑换响应为 `data.token` / `data.bigmodel.{access_token,refresh_token}`。本机 `credentials.json` 实际键名是 `zcodejwttoken` + `oauth:{zai,bigmodel}:access_token`。**字段名不同，可能经了不同的归一化层**（桌面端 host 适配器 vs CLI）。**未验证**——需要解包 `app.asar` 才能定。

### 2.3 版本号不一致

报告 3.7.7；本机 `sir = "3.4.0"`、`X-ZCode-App-Version: 3.14.3`（沿用既有工具值，**未经核对**）。三个数都不一样，跨文档引用时勿混用。

### 2.4 硬件指纹读取（**已核对：报告成立**）

报告称 ZCode 不读硬件指纹。**本机拆 `app.asar` 核对后确认成立**——`MachineGuid` / `getMachineId` / `HostDetector` / `host.id` 的命中**全部落在 `node_modules/@opentelemetry/**`**，ZCode 自身代码 `out/**` 零引用。实际遥测 SDK 是 `@arms/rum-electron`。

> **版本差异**：报告分析 `@zcode/desktop` **3.7.7**，本机为 **3.14.3**（`resources\app.asar` 311.8 MB）。
>
> **CLI 侧另有一层疑点**：`zcode.cjs` 3.4.0 内联了同一套 OTel 代码，但**是否实际执行未验证**。

逐层分析、证据分级与工具坑见 **[39-设备指纹分层](zcode-plan-39-设备指纹分层.md) §4 / §6.1**。

---

## 3. 外部有、本文档未覆盖

以下端点**本文档集尚未收录**，待验证后并入：

| 端点 | 用途 | 应归 |
|---|---|---|
| `GET zcode.z.ai/api/v1/zcode-plan/billing/current` | 当前订阅态 | [03](zcode-plan-03-billing-balance-接口与实调.md) |
| `GET /api/biz/subscription/list` | 订阅列表 | [29](zcode-plan-29-支付与订购系统.md) |
| `GET /api/monitor/usage/quota/limit` | 用量限额 | [03](zcode-plan-03-billing-balance-接口与实调.md) |
| `GET /api/auth/z/login`（`api.z.ai`） | 业务登录 | [10 §3.1](zcode-plan-10-OAuth登录流程.md) 已有 |
| 域名 `cdn.zcode-ai.com`、`studio.zcode-ai.com` | CDN / SSH 远程资源 | [25](zcode-plan-25-远程目标.md)（**10-14 部分实锤：`studio.zcode-ai.com` 已是客户端内网机器面默认 host（`INTRANET_MACHINE_HOST` 可覆盖，12345/zcode + 3850 probe），见 46 号 O2；cdn 待验**） |

> **`POST /api/v1/oauth/token` 已排除（2026-09-28）**：对外部报告声称的「code 直换 token」端点，在 `resources/glm/zcode.cjs`（15.87 MB，0.16.x 线）全量检索 `oauth/token` **0 命中**；全 bundle 仅 3 处 `/token` 字面量，均属 MCP OAuth 的 OIDC 标准库（`grant_type=refresh_token`，见 [23 §2](zcode-plan-23-Hooks与MCP客户端.md)），与 ZCode 自有登录端点无关。CLI 侧不存在该端点，也不存在「桌面端内嵌浏览器走 `/api/v1/oauth/token`」的证据——本机文档的 `cli/init` + `cli/poll` 轮询流（zai）与 bigmodel 本地回调授权码流即为 bundle 内完整的 OAuth 通道（见 [10](zcode-plan-10-OAuth登录流程.md)）。外部报告的此条为**误判**（很可能是拿通用 OAuth 流的 `/oauth/token` 形态套了 ZCode 域名）。

### 3.1 指纹分层（外部给的更完整）

```
第 1 层  deviceMid           随机 UUID → telemetry-state.json，删文件即重置
第 2 层  OAuth token / 登录态   credentials.json、config.json、内嵌浏览器 session
第 3 层  阿里云设备指纹       cloudauth-device.aliyuncs.com Action=Log1
                          no8xfe.captcha-open.aliyuncs.com InitCaptchaV3 SceneId=36qgs6xb
第 4 层  硬件指纹           MachineGUID / MAC / 磁盘序列号 / EDID / BIOS-DMI
```

**`SceneId` 不一致**：[12 §3](zcode-plan-12-阿里云验证码体系.md) 记 `captcha:{enabled,prefix:"no8xfe",region:"cn",sceneId:"11xygtvd"}`；报告记登录页用 `36qgs6xb`。

**不矛盾**——登录页与产品内是两个 sceneId。`captcha_node/solver.js` 默认传 `11xygtvd`，与 `client config` 一致。

> **ℹ 第 4 层的核对结果 —— 详见 [39-设备指纹分层](zcode-plan-39-设备指纹分层.md)**
>
> **报告「ZCode 本身不读硬件指纹」的说法成立。** 本机拆 `app.asar`（`@zcode/desktop` 3.14.3，311.8 MB）全包扫描：`MachineGuid` / `getMachineId` / `HostDetector` / `host.id` 命中**全部在 `node_modules/@opentelemetry/**`**，`out/**` 零引用。`@opentelemetry/resources@2.6.1` 只是声明依赖带进来，实际遥测用 `@arms/rum-electron`。
>
> 报告 L4 清单中的 **MAC / 磁盘序列号 / 卷序列号 / EDID / BIOS-DMI 在两个产物中均无读取代码**。
>
> **遗留疑点**：CLI（`zcode.cjs` 3.4.0）内联了同一套代码，但是否实际执行**未验证**。

---

## 4. 不并入的部分

该仓库另含**临时邮箱注册流程**（`tempmail_zcode_flow.py`、`auto_reg_config.json`）与设备信息重置脚本（`device_reset.py`、`clean_zai_data.py`）。

**本文档集不收录此类内容**——它属于账号批量化的操作工具，不属于协议分析。外部报告自身在 §九 亦声明「不提供验证码自动识别/绕过、登录态伪造、批量撞接口」。

> 记录此事实是为了标明**边界位置**，非评价。

---

## 6. 2026-10-13 · GitHub 搜索面核对（用户报 330 命中）

GitHub 代码搜 `X-Aliyun-Captcha-Verify-Param` 约 **330 命中**。判读：**头已广泛外泄，但 330 ≠ 330 个独立来源**——主体是同生态 fork/拷贝与消费方工具。已知集群：**生成链**（D3-vin/Zcode2Api Go、dengyie/zcode2api Python（AGPL，37 §8.2 源头）、zcode-proxy Go 移植——后两者本机副本已随 `e:\VSCodeSpace\ZCode` 清理，可从公开仓重拉）。**10-14 近况核对（dengyie 2.6.4→2.6.8，10-01/02 提交）**：他们与我们同期撞上同一波风控收紧，操作轨迹含大量**外部运行实证**价值的语义——①`3012 风控硬禁用→指数退避冷却`（2.6.4）：证实 3012 存在"硬禁用"形态且业界共识处置=退避零流量；②`429 body 1113=Key 无资源包永久态，别重试快速换号`：1113 三态判据独立佐证；③`风控流量行为整改——对齐 zcode-switch 人节奏`（2.6.5）：行为节奏是判定输入的自供；④`激活时序/strikes 衰减`（2.6.6）：**服务端 strikes 有衰减机制**（惩罚随时间消退的运营侧旁证）；⑤`风控禁用自动换设备重生：新 SKU+新 device_mid+清 installed_at+补跑安装序，重新启用即全新身份`（2.6.8，RISK_AUTO_ROTATE 默认开）——证明**封禁执行维度含设备身份（SKU/installed_at）**、且生态所谓"安装序/激活"即 zcode-switch 那条 event/report 伪造链。⚠ 边界：2.6.8 属**自动轮换设备身份绕风控**，是本档集红线（37 §8.5-C），只作逆向证据引用，不引入不使用。另其 APP_VERSION 已跟进 **3.14.4**（2.6.7）——官方版本号又动（3.14.3→3.14.4→3.15.1），跨文档引用注意。**消费链**（can1357/oh-my-pi、cpa 系插件仓等）。**10-14 新登**：[binggao1230/glm-zcode-2api](https://github.com/binggao1230/glm-zcode-2api)（MIT/Go）——包装的是**付费订阅的 anthropic 端点**（默认 provider `builtin:bigmodel-coding-plan`），不走 start-plan 三道门，所以无验证码/无身份块实现；"凭据零搬运"= 直读本机 ZCode 登录态（文档称 `~/.zcode/v2/config.json`，本机 v2 现无此文件——macOS/版本口径差，待考）；工程面有亮点（0700/0600 原子写+fsync、audit.jsonl 本地审计、fcntl 单例、AI_SETUP.md+skill 的 agent-first 安装、LAN 共享自带口令），但**对无订阅账号同样只会撞 1113，不是 3012 的解**。

**逐项比对 oh-my-pi issue #8802**（Z.AI Coding Plan 登录丢官方 JWT → 1113 后等 30 分钟）：

| 类别 | 条目 |
|---|---|
| 互证（4） | balance/quota GET **不受验证码门**，仅 inference 受门（=03/12）；带/不带 ZCode 指纹均 3007——**3007 与指纹无关**（=37 §8.1 分层：param 门前置）；`captcha-retry` 触发源命名（=12 §3 `source`）；配置源 `data.configs.captcha`（=12 §1） |
| 新增（2） | ① **`omitAliyunCaptchaHeaderFromProviderHeaders`**：防陈旧 token 随 provider 头持久化重放而剪除两头（B 引用，待源码核验后升入 12 号生命周期表）；② 作者对照结论：**指纹必要不充分**；代理换出口≠换信誉，curl-impersonate 换 Chrome TLS≠换 JA3——与 37 §8.2「3012 与 IP/指纹无关」不矛盾（他们卡在 3007 门，未触 body 层） |
| 待查（1） | issue 摘要有「3.14.4 README 未提 captcha / 现行端点认证不涉及 captcha」说法——疑似作者走付费直连端点后的另一面，**不构成与本档集矛盾**（本档 3007/3012 均在 zcode-plan 代理实测），需读其仓库代码定性 |

边界重申（§4）：330 命中中含绕过类/批量化操作工具，本文档集仅引其协议证据，不引入代码与操作流程；对这类工具的阅读仅限提取 ZCode 行为旁证（已归 §2.1），不对其本身作形态/链路/代码展开。

## 5. 核对方法（可复用）

```powershell
# 取原始报告
curl --ssl-no-revoke -L -o _ext.md `
  "https://raw.githubusercontent.com/HardworkingChen/zcode-tools/main/%E9%80%86%E5%90%91%E5%88%86%E6%9E%90%E6%8A%A5%E5%91%8A-ZCode-%E6%99%BA%E8%B0%B1.md"

# 抽端点做交集/差集
Select-String -Path _ext.md,'docs\*.md' -Pattern '/api/[a-z0-9_\-/:]+' -AllMatches |
  ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Sort-Object -Unique
```

**教训**：外部来源**先对齐版本与载体再比**，否则会把产物差异读成结论矛盾（§2.1 即是）。

