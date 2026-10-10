# 38 · 外部报告交叉核对

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 对象：[HardworkingChen/zcode-tools · 逆向分析报告-ZCode-智谱.md](https://github.com/HardworkingChen/zcode-tools)
> 核对日期：2026-09-27

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

两者都自洽——**CLI 不需要本地监听端口，桌面端需要**。[10 §1.2b](zcode-plan-10-OAuth登录流程.md) 记的"回调是服务端侧的"仅对 CLI 成立，已在文中限定。

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
| 域名 `cdn.zcode-ai.com`、`studio.zcode-ai.com` | CDN / SSH 远程资源 | [25](zcode-plan-25-远程目标.md) |

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

