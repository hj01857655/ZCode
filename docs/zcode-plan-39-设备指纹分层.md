# 39 · 设备指纹分层组成

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> ⚠️ **硬件探测层官方未开源**（2026-09-28 核对）：`HostDetector` / `MachineGuid` / `baseboard` / `ATTR_HOST_ID` / `GetVolumeInformation` 在 `zai-org/ZCode` 中**全部 0 命中**。其中 `HostDetector` 是否真被 CLI 执行，至今无源码可判。详见 [43 官方未开源清单](zcode-plan-43-官方未开源清单.md) §2/§5。
> 证据：`resources\glm\zcode.cjs` 符号追踪 + 本机 `~/.zcode/v2/` 实态 + 外部报告交叉（[38 §3.1](zcode-plan-38-外部报告交叉核对.md)）
> 实测日期：2026-09-27

## 0. 四层总览

| 层 | 内容 | 谁采集 | 存放 | 关联强度 |
|---|---|---|---|---|
| **L1** | `deviceMid`（随机 UUID） | **ZCode** | `telemetry-state.json` | 弱，删文件即换 |
| **L2** | 登录态 / token / 内嵌浏览器 session | **ZCode** | `credentials.json`、`config.json`、浏览器 profile | 中 |
| **L3** | 阿里云设备指纹 | **阿里云**（第三方） | 服务端 | **强** |
| **L4** | 硬件层标识 | **ZCode**（CLI 侧，见 §4 更正）+ 风控间接 | 内存 / 遥测资源 | **强** |

**L1 与 L4 是两回事**：L1 是纯随机软件标识，L4 是真硬件标识。**只清 L1 不改变 L4。**

---

## 1. L1 · deviceMid

本机实态（`~/.zcode/v2/telemetry-state.json`，**全文只有两个字段**）：

```json
{
  "deviceMid": "f8eea726-8424-4560-bc4e-3e310bd0d558",
  "lastDailyActiveDate": "2026-09-27"
}
```

- bundle 内 `deviceMid` 20 处、`DEVICE_MID` 9 处、`X-Device-Mid` 2 处
- 形态：**随机 UUID v4**，与硬件无关
- 经 IPC `init-local` 消息下发（`{ type:"init-local", deviceMid?, hostId?, … }`）
- 作为请求头 `X-Device-Mid` 随每个业务请求发出（见 [38 §7](zcode-plan-38-外部报告交叉核对.md) 的头表）

**判据**：改这个值不影响任何硬件关联性。

---

## 2. L2 · 登录态

| 内容 | 位置 | 形态 |
|---|---|---|
| `zcodejwttoken` | `credentials.json` | `enc:v1` 加密，HS256，**无 `exp`** |
| `oauth:{zai,bigmodel}:access_token` | 同上 | HS512，1400+ 字符 |
| coding plan `api-key` | 同上 | `{32hex}.{16char}` |
| 内嵌浏览器 session | `AppData\Roaming\ZCode\session\` | Cookie / LS / IDB |
| ARMS 埋点标识 | `rum-electron-store` | session / UID |

> 读取与内存解密见 `tools/zk.py`（明文不落盘）。

---

## 3. L3 · 阿里云设备指纹（第三方采集）

登录页加载 `AliyunCaptcha.js`，**指纹由阿里云在浏览器内合成，ZCode 不参与计算**：

| 接口 | 参数 | 作用 |
|---|---|---|
| `cloudauth-device.aliyuncs.com` | `Action=Log1` | 设备指纹上报 |
| `no8xfe.captcha-open.aliyuncs.com` | `InitCaptchaV3`, `SceneId=36qgs6xb` | 验证码初始化（登录页） |
| 同上 | `SceneId=11xygtvd` | **产品内**（`client config` 实值） |

采集内容：canvas、WebGL、时区、字体、浏览器环境等合成指纹。

> **两个 sceneId 不是冲突**：登录页 `36qgs6xb` 与产品内 `11xygtvd` 是两条独立通道。原 `captcha_node/solver.js`（已清理）默认传 `11xygtvd`，与 `client config` 一致。

详见 [12-阿里云验证码体系](zcode-plan-12-阿里云验证码体系.md)。

---

## 4. L4 · 硬件层标识 —— **两处更正**

### 4.1 外部报告称「ZCode 本身不读」——**该结论成立（在本机版本上）**

外部报告分析 `app.asar` **3.7.7**。本机是 `@zcode/desktop` **3.14.3**，直接拆包核对（`_re/asar_pick.js`，不整包解，只读头 + 按需抽取）：

```
app.asar 311.8 MB · 27,068 个文件 · 目录 JSON 6922 KB
name: @zcode/desktop   version: 3.14.3   main: out/main/index.js
dep : @opentelemetry/resources@2.6.1
dep : @arms/rum-electron@^0.0.3
```

**全包关键词扫描结果：**

| 关键词 | 命中位置 | ZCode 自身代码（`out/**`） |
|---|---|---|
| `MachineGuid` | 3 处，**全在** `node_modules/@opentelemetry/resources/build/{src,esm,esnext}/…/getMachineId-win.js` | **0** |
| `getMachineId` | 3 处，同上（同一文件的 3 份构建） | **0** |
| `hostDetector` / `HostDetector` | 17 处，**全在** `node_modules/@opentelemetry/resources/**` | **0** |
| `host.id` | 15 处，**全在** `node_modules/@opentelemetry/**` | **0** |
| `deviceMid` | — | `out/host/index.js` 内 **16** 处 |
| `X-Device-Mid` | — | `out/host/index.js` 内 **4** 处 |

**结论：`@opentelemetry/resources` 是声明依赖，包里带着完整的 `HostDetector` + `getMachineId-win.js`，但 ZCode 的业务代码从不引用它。** 实际使用的遥测 SDK 是 `@arms/rum-electron`。

**「ZCode 不读硬件指纹」在桌面端成立。** 报告没错。

### 4.2 但 CLI 侧要打个问号

`zcode.cjs`（3.4.0）里 `getMachineId` + `HostDetector` + `ATTR_HOST_ID` **是内联在 ZCode 自己的代码段里**（非 node_modules），并有平台分发实现（`REG.exe … MachineGuid` / `ioreg … IOPlatformUUID` / `/etc/machine-id`）。

**但「代码存在」≠「会执行」。** 追踪结果：

- `hostDetector` 在 CLI 中 14 处、`ATTR_HOST_ID` 3 处、`detectResources` 聚合器存在
- 聚合器签名是 `(e={}) => (e.detectors || []).map(n => n.detect(e))`——**从参数取 detectors**
- **没有找到 ZCode 侧调用 `detectResources({detectors:[…HostDetector…]})` 的位置**

**结论：CLI 是否真的实例化 `HostDetector`，静态分析无法判定，需运行时追踪。**

> 附带发现：CLI 压缩包中 `wBt` 既是 OTel `HostDetector` 的模块变量，又是 TypeScript 编译器的 `isPropertyAccessible`——**同名符号碰撞**，`wBt` 命中 5 处里 3 处是 TS 编译器。靠符号名统计必然出错。

### 4.3 桌面端 CLI 都未发现的硬件项

`wmic` / 磁盘序列号 / 卷序列号 / `GetVolumeInformation` / `EDID` / `baseboard`（BIOS-DMI）/ `node-mac` / `os.networkInterfaces`——**两个产物均无读取代码**。若风控需要这些，只能经由 L3 或服务端推断。

---

## 5. 误命中清单（本轮踩过的坑）

搜索指纹相关关键词时的**假阳性**，记录以免重复：

| 关键词 | 实际含义 | 命中 |
|---|---|---|
| `getmac` | `netsh interface` 命令串表里的 `-getmacaddress` | 1 |
| `fingerprint` | ① GPG 的 `--fingerprint` 选项表 ② 遥测采样去重 `hasSameSampleFingerprints` / `fingerprintCollectionSamples` / `fingerprintValue` | 8 + 16 |
| `canvas` | 渲染相关，非指纹采集 | 7 |
| `clientId` | OAuth client_id / 各种 client 标识 | 99 |

**`fingerprint` 的 24 处命中里没有一处是设备指纹。** 只看计数必然误判——[37 §5.5](zcode-plan-37-排障手册.md) 闸门 C 的另一个实例。

---

## 6. 证据分级

| 结论 | 级别 | 依据 |
|---|---|---|
| 桌面端 `out/**` **零引用**硬件指纹 | **A 实测** | 拆 `app.asar` 全包扫描 11,594 → 20,762 候选文件，命中全在 `node_modules` |
| 桌面端版本 `@zcode/desktop` 3.14.3 | **A 实测** | 根级 `package.json` |
| CLI 内联 `getMachineId` / `HostDetector` 代码 | **A 实测** | bundle 符号追踪 |
| **CLI 是否实际执行 `HostDetector`** | **未验证** | 压缩包内同名符号碰撞 + `detectResources` 从参数取 detectors，静态追不到调用点 |
| L1 `deviceMid` 为随机 UUID | **A 实测** | 读取本机 `telemetry-state.json` |
| L3 阿里云采集 | **B 静态** | 外部报告 + 本机 `client config` 印证 |
| 遥测资源实际发往何处 | **未验证** | 未抓到遥测上报的 URL 与 payload |

### 6.1 本轮踩的两个坑（都是自己的工具造成的）

1. **asar 头 JSON 尾部有填充**——`headerStringSize` 声明 6922.22 KB，实际 JSON 6922.21 KB，尾部 5 字节 `\0` + 垃圾。直接 `JSON.parse` 会报 "Unexpected non-whitespace character"。按括号深度截断才对。
2. **文件大小过滤把目标滤掉了**——`getMachineId-win.js` 只有 **1012 字节**，而过滤条件是 `size > 1024`，**差 12 字节**。第一轮扫出「`MachineGuid` 0 命中」正是这个 bug 造成的，若不追下去就会得出「桌面端不读硬件指纹」的**错误**结论——而那个结论恰好还是对的，纯属巧合。

> **教训**：过滤器会静默地制造假阴性。**任何「0 命中」都要先验证过滤器本身没把目标排掉**——把阈值降到 200 重扫，`MachineGuid` 立刻出现 3 处。

## 7. 可执行检查

```powershell
# L1 现值
Get-Content "$env:USERPROFILE\.zcode\v2\telemetry-state.json" -Raw

# 拆 asar（不整包解）
node _re\asar_pick.js root              # 桌面端版本与依赖
node _re\asar_pick.js list machine-id    # OTel machine-id 相关文件
node _re\asar_pick.js find MachineGuid   # 全包关键词扫描
node _re\asar_pick.js get <路径> <输出>   # 按需抽取

# CLI 侧
node _re\asar_pick.js find getMachineId MachineGuid

# L3 当前配置走 GET /api/v1/client/configs → data.configs.captcha（见 12 §3）
```

## 8. 0.16.x 重验 + 官方源码核验（2026-09-28）

**背景**：zcode.cjs 自动更新（3.14.3 内嵌 → 0.16.x 独立线，15.87MB）+ 官方开源仓 `zai-org/ZCode` v3.14.3 发布。分层逐层重验：

- **L1 deviceMid → 升级为源码级（S）**：`apps/zcode-cli/packages/adapters/src/device/cli-device-mid.ts` 实证——`createUuid` 随机 UUID，持久化于 telemetry state 文件（与 Desktop 共享同文件同字段），文件锁（200×10ms 重试、5 分钟 stale 判定），FS 异常时内存 fallback **不阻断模型请求**，`ZCODE_DATA_BASE_DIR` 可重定向基目录。§L1 原结论（随机 UUID）维持并细化。
- **L2 登录态**：asar 未随更新（09-27 02:28 时间戳未变），结论不变。
- **L3 阿里云指纹**：SDK 样本未更新（09-26，273,948B），§5d DeviceConfig 三采集清单结论维持。
- **L4 硬件层——定性修正**：旧语料引用的 `HostDetector`/`MachineGuid` 实为 **OpenTelemetry host/windows resource detector**（遥测属性 `ATTR_HOST_NAME`/hostname/注册表 MachineGuid，vendor 库），`baseboard`/`GetVolumeInformation` 在 0.16.x 已不在。它们从来不是反滥用指纹采集——**§L4"ZCode 不读硬件指纹"的结论维持且加强**；真正的设备画像采集在阿里云 SDK 内部（L3，未变）。
- **误判根因入册**：`HostDetector`/`MachineGuid` 是 vendor OTel 词汇——与 37 §9"grep 命中≠证据"同族的第 4 条陷阱：**vendor 库词汇不算目标程序行为**。

**新发现（非指纹，资源监控子系统）**：`device/process-probe-{darwin,linux,windows,shared}.ts` 四平台**进程树采样器**——对受控 pid 回 RSS 与累计 CPU 时间；Windows 仅允许 `tasklist`（无 ppid/CPU，只回直连进程），源码明文红线"严禁 WMI 脚本宿主实现（历史事故：数秒一拉重进程拖慢用户机器）"。用途是自 家子进程的资源监控，与指纹无关。
