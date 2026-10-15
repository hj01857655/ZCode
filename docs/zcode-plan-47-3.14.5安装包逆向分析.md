# 47 · ZCode 3.14.5 Windows 安装包逆向分析（2026-10-14）

**调查日期**：2026-10-14
**对象**：`D:\Downloads\Programs\ZCode-3.14.5-win-x64.exe`
**SHA256**：`50DD7533BC2F64FFD762465AA825072DD3F801E80027F3DC96A07CDF413F816E`
**大小**：178,454,296 B（170.19 MiB）
**复验工具**：7-Zip 26.04（`7zr`，仅用于列表与解包，只读）、PowerShell 7（`Get-FileHash` / `ConvertFrom-Json` / 字节级头解析）、自行构造的 asar 头部解码脚本
**性质**：A 级 = 本次实测字节与计数直接支撑；B 级 = 读码/结构推断，未做装机运行验证
**产出目录**：解包工作区 `E:\VSCodeSpace\Agent\ZCode\re\zcode-3.14.5-extracted\`（注意是 `re\`，不是 `dist\`；`dist\` 属于另一项 mitm 工程，禁止混写）

---

## 1. 安装包外壳：NSIS v3.04 + PE32

| 项 | 值 | 级别 |
| --- | --- | --- |
| 可执行格式 | PE32（32 位）—— 安装包外壳自身为 x86，与被投递的 x64 载荷无关 | A |
| 打包器 | NSIS v3.04 | A |
| ProductName | ZCode | A |
| ProductVersion | 3.14.5 | A |
| FileVersion | 3.14.5.7961 | A |
| 载荷形式 | 外壳尾部内嵌单个 7z 归档（NSIS 常见做法：安装器仅负责解包 + 快捷方式 + 注册表） | A |

> 说明：`FileVersion` 第四段 `7961` 是构建号，与 `build-meta.json` 的 `buildCommitId 639500b6` 一起构成该安装包唯一可追溯标识。

## 2. 内嵌 7z 归档与块统计

`7zr l` 头部原文关键字段：

```
Path = D:\Downloads\Programs\ZCode-3.14.5-win-x64.exe
Type = 7z
WARNINGS:
There are data after the end of archive
Offset = 282499
Physical Size = 177712447
Tail Size = 459350
Headers Size = 13802
Method = LZMA2:20 LZMA:20 BCJ2
Solid = -
Blocks = 1076
```

### 2.1 结构自洽校验（两条独立等式）

| 校验 | 计算 | 结论 |
| --- | --- | --- |
| 文件总长闭合 | 282,499（外壳+头偏移） + 177,712,447（归档体） + 459,350（Tail） = **178,454,296** | 与实文件大小逐字节相等 ✅ |
| 载荷与头部拆分 | 177,712,447 − 13,802（Headers） = **177,698,645** | 与列表尾行"压缩后总字节"相等 ✅ |

两条等式同时成立，说明 `There are data after the end of archive` 是**预期的 NSIS 尾部附加数据**，不是篡改或截断信号。

### 2.2 压缩策略

- `Method = LZMA2:20 LZMA:20 BCJ2`：同时启用 LZMA2 流与 BCJ2 x86 分支转换，针对 Electron/Chromium 大量 Win32 DLL 的机器码优化。
- `Solid = -` + `Blocks = 1076`：**非固实**，每文件独立成块，共 1076 块 —— 恰好等于文件数，因此安装器可选择性释放/更新单文件，代价是跨文件冗余不可共享。
- 列表尾行：`765085507  177698645  1076 files, 311 folders`
  → 解包 765,085,507 B（≈730 MiB） / 打包 177,698,645 B（≈169.4 MiB），比率 **4.306×**。

## 3. 解包结果与落地布局

计数复核：`re\zcode-3.14.5-extracted\` = **311 目录 / 1076 文件 / 765,085,507 B**，与 7z 列表尾行逐项一致 ✅（A 级）。

| 层 | 内容 |
| --- | --- |
| 应用主程序 | `ZCode.exe` = 222,866,328 B（单文件最大项，解包 65,847,737 B 打包） |
| Electron/Chromium 运行时（根目录） | `chrome_100_percent.pak`、`chrome_200_percent.pak`、`resources.pak`、`d3dcompiler_47.dll`、`dxcompiler.dll`、`dxil.dll`、`ffmpeg.dll`、`icudtl.dat`、`libEGL.dll`、`libGLESv2.dll`、`snapshot_blob.bin`、`v8_context_snapshot.bin`、`vk_swiftshader.dll`、`vk_swiftshader_icd.json`、`vulkan-1.dll`、`LICENSE.electron.txt`、`LICENSES.chromium.html` |
| `locales\` | **仅 2 个**：`en-US.pak`、`zh-CN.pak`（Electron 区域裁剪，非常规全量） |
| `resources\` | `app.asar`、`app.asar.unpacked\`、`config\`、`glm\`、`tools\`、`elevate.exe`、`icons\`、`app-update.yml` |

`resources\tools\` 三个子工具实测：

| 工具 | 解包大小 | 说明 |
| --- | --- | --- |
| `cua-helper` | 22,607.40 KB | 含 `ax_native.node`(394 KB) + `windows-helper.js`(996 KB) |
| `ripgrep` | 5,274.70 KB | — |
| `ugrep` | 2,123.20 KB | `ugrep.exe` = 2,173,848 B 解包 / 698,306 B 打包 |

## 4. `.zcode-install-manifest` 与安装完整性盲区

文件：`re\zcode-3.14.5-extracted\.zcode-install-manifest`，74,638 B / **1074 行**，格式为**纯相对路径清单**（无哈希列）。前 8 行：

```
LICENSE.electron.txt
LICENSES.chromium.html
ZCode.exe
chrome_100_percent.pak
chrome_200_percent.pak
d3dcompiler_47.dll
dxcompiler.dll
dxil.dll
```

路径集合对差实测：

| 方向 | 数量 | 具体项 |
| --- | --- | --- |
| 仅在清单中 | 0 | — |
| 仅在磁盘上 | 2 | `.zcode-install-manifest` 自身、`resources\elevate.exe` |

→ 恒等式 **1076 = 1074 + 清单自身 + elevate.exe** ✅

**结论（A 级）**：该清单是"装机路径清单"而非哈希清单，其作用是列举应存在的文件；`elevate.exe`（UAC 提权辅助件，NSIS 常见外挂组件）**不在清单覆盖范围内**，即安装自检不会发现它被替换。该结论与 plan-44 §1 记录的 3.15.1 形态（1108 条、仅 4 个 NSIS 工件缺失、无重打包证据）同构。

## 5. app.asar 二进制头部格式

`resources\app.asar` 实测 **326,914,395 B（311.77 MiB）**。

前 16 字节按 4 × uint32 小端解读：

| 字段 | 值 | 语义 |
| --- | --- | --- |
| u32[0] | 4 | pickle 长度字段本身的大小 |
| u32[1] | 7,088,360 | header pickle 总长 |
| u32[2] | 7,088,356 | 内部 payload 长度 |
| u32[3] | 7,088,351 | JSON 字符串长度（含对齐填充前的标称值） |

- JSON 头起始偏移 = **16**，实际以 `{"files":{"` 开头（A 级）。
- **有效 JSON 头部大小 = 7,088,352 B**（不是 7,088,351；差 1 由对齐/ terminator 造成 —— 早先误读已更正）。
- 数据区起始偏移 = **7,088,368**。

**反向自洽校验（A 级）**：
`7,088,368（数据起始） + 319,824,377（末位文件偏移…） … ` → 用两个已知内部条目闭合：
`7,088,368 + 319,824,377 + 1,650 = 326,914,395` 与文件实际字节数**逐字节相等** ✅
（其中 `package.json` 位于偏移 319,824,377，长度 1,650 B，即归档中最后一个条目。）

## 6. asar 内部结构

计数：**27,068 文件 / 3,097 目录**。顶层三项：

| 条目 | 规模 |
| --- | --- |
| `node_modules\` | **460 个顶层包** |
| `out\` | 构建产物（下节） |
| `package.json` | 1,650 B |

### 6.1 `out/` 树（各子目录均含 25 字节 `.xxx-build-ready` 标记文件）

| 子目录 | 文件数 | 内容 |
| --- | --- | --- |
| `out/host/` | **18** | 16 个 chunk（`chunk-3RFWSRX3`、`4I7RNSUK`、`4RHDQOPX`、`6MDKW5YA`、`AUZZ66CO`、`BPMMBPK6`、`IKTGKLU2`、`IYVG6UP7`、`KSJDXDKL`、`LNGNUNBX`、`NZC7DO6E`、`OVJK236Q`、`QV75VDA4`、`TVWDPSHD`、`UHHNTW2R`、`Y3R65CLN`）+ `index.js` + `tasksStorageWorker.js` |
| `out/main/` | **22** | 18 个 chunk（`chunk-3ZKPHZED`、`5NE3TPF2`、`6XZK2GQP`、`7MOB5AP3`、`B27WMHNN`、`BMP2VTTL`、`BTD2TF4G`、`CXHP7IVG`、`FINM7U7O`、`HH7N2YVI`、`HTTS5LDQ`、`I2LYT35J`、`KFK7GBTO`、`M6RG7CA4`、`TQ36IJU5`、`VP4LANBJ`、`Y6ER4WS4`、`ZGEWVKPD`）+ `index.js` + `storageScanWorker.js` + `zcodeDataSizeWorker.js` + `browserWebmRecorder.js` |
| `out/preload/` | **7** | `browserVideoRecorder.cjs`、`codingPlanWebview.cjs`、`cuaPermissionPanel.cjs`、`embeddedBrowserJavaScriptDialog.cjs`、`index.cjs`、`resourceManager.cjs`、`rewardsWebview.cjs` |
| `out/renderer/` | **6** | `assets/`、`cua-permission-panel.html`、`index.html`、`material-icons/`、`pdfjs/`、`resource-manager.html` |
| `out/scheduler/` | **3** | `chunk-F6SSJBPP.js`、`chunk-KP22P5UF.js`、`index.js` |
| `out/metadata/` | **1** | `build-meta.json` |

> 观察（B 级）：`preload` 中 `codingPlanWebview` / `rewardsWebview` / `cuaPermissionPanel` 三个独立预加载脚本对应三类隔离 webview 上下文；`main` 侧存在 `storageScanWorker` + `zcodeDataSizeWorker` 两个数据体积类 worker，说明容量统计在主进程外异步执行。

### 6.2 `package.json`（偏移 319,824,377 / 1,650 B，A 级）

- 包名 `@zcode/desktop`，版本 **3.14.5**
- `main` = `out/main/index.js`
- `description` = `ZCode Desktop App`；`author` = `ZCode (dev@zcode.z.ai)`；`homepage` = `https://zcode.z.ai`
- **38 个依赖**，关键项：`@zcode/*`（workspace 内部包）、`react ^19.2.4`、`playwright-core 1.59.1`、`electron-updater ^6.8.3`、`node-pty ^1.0.0`、`@larksuiteoapi/node-sdk 1.61.1`、`@opentelemetry/*`、`@babel/runtime ^7.24.5`、`@arms/rum-electron ^0.0.3`、`node-forge ^1.4.0`、`semver ^7.7.4`

### 6.3 `out/metadata/build-meta.json`（偏移 266,843,096 / 141 B，A 级）

```json
{"appVersion":"3.14.5","buildCommitId":"639500b6","buildTime":"2026-09-30T07:57:24.840Z","electronBuilderVersion":"26.8.1"}
```

## 7. `resources/glm/` CLI 载荷

- `resources\glm\zcode.cjs` = **14,820,968 B**
- `.node-bundle-meta.json`：`runtime=electron-node`、`entry=zcode.cjs`、`platform=win32-x64`、`source=apps/zcode-cli/packages/cli/dist/zcode.cjs`
- `resources\glm\packages\` = 15 个插件目录（见 §9）

> 结构推断（B 级）：CLI 以单文件 esbuild 打包形式随桌面包分发，`source` 字段直接暴露上游 monorepo 路径 `apps/zcode-cli/packages/cli`。

## 8. 配置层

### 8.1 `resources/config/provider/zcode-builtin.json`（184.10 KB，A 级）

顶层为 `{config, revision: 30, schemaVersion: 1}`。**注意解析路径**：正确入口是 `config.providerConfigRules.providerRules` 与 `config.modelConfigRules.builtinProviderModelRules`，顶层并无 `providers` 键（早期误用 `.providers` 得到计数 0）。

- `providerRules` = **8 条内建模板**：
  `zai-individual-coding-plan`、`zai-team-coding-plan`、`zai-start-plan`、`bigmodel-individual-coding-plan`、`bigmodel-team-coding-plan`、`bigmodel-start-plan`、`zai-offpeak-idle-plan`、`bigmodel-offpeak-idle-plan`
  → 站点维度 `zai` × `bigmodel` 双份，计划维度 individual / team / start / offpeak-idle。
- `modelConfigRules` = `{builtinProviderModelRules(26), modelApiRules, modelRules, providerSiteRules, templateModelRules}`

模型 × 计划覆盖矩阵（26 条 `builtinProviderModelRules` 归纳）：

| 模型 | 覆盖计划 |
| --- | --- |
| GLM-5.3-Flash | **全部 8 条** |
| GLM-5.3 | individual / team / offpeak-idle |
| GLM-5.2 | individual / team / start |
| GLM-5-Turbo | individual / team / start |

### 8.2 `resources/config/default.json`（A 级）

```json
{"feedback_url":"https://zhipu-ai.feishu.cn/share/base/form/shrcnrXlh93cJIUFYBFndnnL7pe",
 "feedback_use_external_form":false,
 "community_urls":{"zh-CN":"https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&qr_code=true",
                   "en-US":"https://discord.gg/z9aBcQXZQ3"}}
```

### 8.3 `resources/app-update.yml`（A 级）

`provider: generic` + `url: http://localhost:8081` —— 安装包内**未配置生产更新源**，为本地联调占位；实际更新地址应由运行时/远端配置覆盖。

## 9. 插件系统（15 个）

位置：`resources\glm\packages\`。

| 插件 | 版本 | 特征 |
| --- | --- | --- |
| `android-emulator-plugin` | 0.1.0 | MCP=**stdio**；含 `.mcp.json`、`commands/`、`dist/lib`、`dist/mcp/server.js`、`dist/providers/` |
| `browser-use-plugin` | 0.5.1 | skills + 内置 `@img/sharp-win32-x64` |
| `bundled-skills` | — | 仅 skills |
| `documents-plugin` | 0.1.7 | skills + agents |
| `image-search-plugin` | 0.1.1 | MCP=**http** + `jwt_token` 鉴权 |
| `ios-simulator-plugin` | 0.1.0 | MCP=stdio |
| `node-repl-host` | 0.6.0 | 宿主进程 |
| `pdf-plugin` | 0.1.7 | — |
| `plugin-creator-plugin` | 0.1.1 | — |
| `presentations-plugin` | 0.1.7 | — |
| `restore-legacy-sessions-plugin` | 0.1.0 | skills + commands |
| `skill-creator-plugin` | 0.1.0 | — |
| `spreadsheets-plugin` | 0.1.7 | — |
| `zcode-cua-plugin` | 0.6.3 | `name = "computer-use"` |
| `zcode-guide-plugin` | 0.3.0 | — |

> 3.14.5 **无 `visualize-plugin`**（A 级，目录实测）。

## 10. MCP 服务器配置模式

- **stdio 型**：`command: "node"` + `args`（脚本相对路径）+ `env`
- **http 型**：`type: "http"` + `url` + `auth`
- 用户可填项通过 `userConfig` 声明，运行时以 `${user_config.*}` 占位符注入
- 持久化位置：插件根 `.mcp.json` 与 `.zcode-plugin/plugin.*`

## 11. 原生模块清单

| 模块路径 | 内容 |
| --- | --- |
| `node-pty/prebuilds/win32-x64/` | `conpty.node`、`conpty_console_list.node`、`pty.node`、`winpty-agent.exe`、`winpty.dll`、`OpenConsole.exe`、`conpty.dll` |
| `node-pty/third_party/conpty/1.23.251008001/` | `win10-x64`、`win10-arm64` 两套 ConPTY 版本 |
| `ssh2/util/pagent.exe` | Pageant 桥接 |
| `resources/tools/cua-helper/` | `ax_native.node`（394 KB，无障碍/UI 自动化原生件）、`windows-helper.js`（996 KB） |
| `@img/sharp-win32-x64` | `libvips-42.dll`、`libvips-cpp-8.17.3.dll`、`sharp-win32-x64.node`、`package.json`、`versions.json`、`LICENSE` |
| `resources/tools/ugrep/ugrep.exe` | 2,173,848 B |
| `resources/tools/ripgrep/` | — |
| `resources/elevate.exe` | NSIS 提权辅助件（**不在装机清单覆盖内**，见 §4） |
| `app.asar.unpacked` | **12 文件 / 5,265,696 B**（node-pty 预编译件 + third_party ConPTY + ssh2/util，因asar只读必须由文件系统承载） |

取证留档：`re\conpty_evidence\conpty_console_list.node`。

## 12. 关键文件大小对比

| 文件 | 解包字节 | 归档内字节 | 比率 |
| --- | --- | --- | --- |
| `ZCode.exe` | 222,866,328 | 65,847,737 | 3.38× |
| `resources\app.asar` | 326,914,395 | — | — |
| `resources\tools\ugrep\ugrep.exe` | 2,173,848 | 698,306 | 3.11× |
| `resources\glm\zcode.cjs` | 14,820,968 | — | — |
| `resources\app.asar.unpacked`（合计） | 5,265,696 | — | — |
| **全包** | **765,085,507** | **177,698,645** | **4.306×** |

## 13. 与 3.15.1 的差异（单节，仅作对照）

基线来源：plan-44（3.15.1.8093，装机 2026-10-10）。

| 维度 | 3.14.5（本文） | 3.15.1 |
| --- | --- | --- |
| `app.asar` | 326,914,395 B | 340,511,069 B |
| `zcode.cjs` | 14,820,968 B | 15,126,820 B |
| `package.json` 依赖数 | 38 | 40 |
| 插件数 | 15 | 16（新增 `visualize-plugin`） |
| provider 配置 | `providerRules`(8) × `builtinProviderModelRules`(26)，`revision: 30` | `access.type × api.type × baseUrl × builtinModelIds`，`revision: 31`；api 型 `anthropic-messages` / `openai-chat-completions` / `openai-responses` |
| 装机清单 | 1074 条（差 2 = 清单自身 + elevate） | 1108 条（仅 4 个 NSIS 工件缺失，无重打包证据） |
| 标识符复验 | 未做 | 1,477 项：561 双活(38.0%) / 359 仅 cjs(24.3%) / 279 仅 asar(18.9%) / 278 消失(18.8%) |

配置层范式迁移（B 级）：3.14.5 仍是**按供应商/套餐枚举模板**，3.15.1 改为**按接入类型 × API 协议族 × baseUrl 组合**——即从"套餐枚举"转向"协议适配矩阵"。

## 14. 更正记录

1. **`ugrep` 并非 3.15.1 新增。** plan-44 §4 将 `resources/tools/ugrep` 列为 3.15.1 `tools/` 的新增项，本次实测 3.14.5 已存在 `resources\tools\ugrep\ugrep.exe`（2,173,848 B 解包 / 698,306 B 归档，见 §3 与 7z 列表尾行原文）。plan-44 表述需按本文更正；ugrep 在 3.14.5 中的调用位置尚未定位，保留为开放问题。
2. **asar 有效 JSON 头大小 = 7,088,352 B**，不是 uint32[3] 读出的 7,088,351（§5 已由文件总长反向闭合确认）。
3. 早期"`resources\config\provider` 顶层 providers 计数 0"为解析路径错误，非数据缺失（§8.1）。

## 15. 风险面观察

| 编号 | 观察 | 级别 |
| --- | --- | --- |
| R1 | `app-update.yml` 的 `provider=generic` + `url=http://localhost:8081`：electron-updater 仅校验清单内 `sha512`，无独立签名固定，更新通道可被路由到任意 HTTP 源（延续 plan-46 C13） | A（配置）/ B（利用性） |
| R2 | `elevate.exe` 不在 `.zcode-install-manifest` 覆盖集合内 → 装机自检无法发现其被替换 | A |
| R3 | 清单为路径列表、无逐文件哈希 → 完整性判定只能是"存在性"，不能检出内容篡改 | A |
| R4 | 非固实 1076 块使单文件可被独立替换而不破坏归档读取 | B |
| R5 | `locales` 仅 2 项，提示存在区域裁剪构建，与官方通用发行构建可能有别 | B |

## 16. 开放问题

1. 本文全部数据来自**解包产物**，未在真机安装 3.14.5 并核对安装器落盘行为（快捷方式、注册表卸载项、`app-update.yml` 是否被安装器改写）。
2. ugrep 的调用点（是否经 `grep` 抽象层选择 ripgrep/ugrep）未定位。
3. `conpty.node` / `pty.node` / `ax_native.node` 的 Ghidra 反编译未执行 —— REA 会话断开，工具族当前不可用。
4. `app.asar` 内部 JS 应用图（`analyze_javascript_application`）未构建，§6.1 的进程边界推断仍是 B 级。
5. `providerRules` 8 条模板的实际鉴权字段差异未逐条展开。

## 17. 受影响文档

| 文档 | 影响 |
| --- | --- |
| `zcode-plan-44-3.15.1机级安装与配置层.md` | §4 关于 `ugrep` "3.15.1 新增"的表述需更正，指向本文 §14.1 |
| `zcode-plan-46-*.md` | C13（electron-updater 无签名固定）由本文 R1 在 3.14.5 侧取得同一形态证据 |
| `zcode-plan-47-*.md`（本文） | 新增：3.14.5 安装包逆向基线 |
