# 22 · CUA 与浏览器自动化体系

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：`zcode-cua-plugin` / `browser-use-plugin` 包结构 + bundle 内 CUA 协议常量

## 1. 两个插件

| 插件 | 技能 | 形态 |
|---|---|---|
| `browser-use` | `control-browser`、`web-gui-tester` | 浏览器自动化：**Desktop IAB（内置浏览器）** + CLI 侧可选 headless **CDP**；open/navigate/inspect/click/type/screenshot、录 WebM 视频、验证页面与本地 dev 端点 |
| `zcode-cua` | `computer-use` | **Computer Use**：整机 GUI 操作（Windows 辅助进程 `cua-product-helper`） |

宿主进程另有 `Windows Computer Use Helper`（日志实测："Windows Computer Use Helper ready {generation:1}"）。

## 2. 协议层（v4/cua）

- 推送帧：`v4/cua/permission-observation` —— CUA 权限动作观测上云。
- Tab 协议方法（CUA 会话）：`list` / `listUserTabs` / `claimTab` / `markDeliverable` / `markHandoff` / `nameSession` / `turnEnded` / `closeSession` / `cancelRequest` / `close`——把浏览器 tab 当作可认领/移交的会话资源。
- 无头会话实例：`{id, generation, type:"cdp", name:"ZCode Headless Chromium", capabilities:{browser,tab}, apiSupportOverrides}`——对 PlaywrightAPI.waitForEvent、下载路径、FileChooser 等做了**能力裁剪覆盖**（host 无法交付的 API 显式关闭）。

## 3. 权限集成

- CUA 工具有独立能力组 `OfficialCua`——项目权限规则按 **capabilityGroup** 而非工具名匹配（见 [15 §5](zcode-plan-15-工具与权限体系.md)）。
- 权限决策结果中的 `permission-observation` 帧上云，供 web 端审计 GUI 操作。

## 4. 执行底座

- `mcp__node_repl__js`（node-repl-host 插件）作为 Browser Use / Computer Use 的**官方脚本执行入口**——SDK bootstrap 后在受限 REPL 里驱动（每次调用重新引导，禁止裸全局复用）。
- 浏览器自动化栈：Playwright core（bundle 内含 playwright-core/lib/server）。

## 6. CUA Helper 安装体系（2026-09-28 asar 静态还原，B 级；锚点 `Yie`/`Nie`/`eb`）

CUA 的实际 OS 控制由**独立 helper 组件**执行，host 负责下载、校验、安装：

- **下载源**：`{origin}/zcode-cua-helper-<platform>[/<buildId>]`（`resolveCuaHelperDownloadBaseUrl` = `Yie`），可用 `ZCODE_CUA_HELPER_DOWNLOAD_BASE_URL` 覆盖；
- **构建标识**：`ZCODE_CUA_HELPER_BUILD_ID`（1-128 ASCII 严格校验，`normalizeHelperBuildId` = `Xie`）；
- **版本钉定**：非 dev 运行时用内置默认版本常量 `qc`；dev 运行时可 `ZCODE_CUA_HELPER_VERSION` 覆盖（`resolveCuaHelperRuntimeVersion` = `Lie`）；
- **安装根**：`<dataDir>/computer-use/<flavor>`（`resolveCuaHelperInstallRoot` = `eb`），flavor 分 `dev`/`preview`/正式——互不覆盖；识别的全部候选根见 `recognizedCuaHelperInstallRoots`（`Hz`）；
- **签名钉定（supply-chain 防护）**：安装计划（`resolveCuaHelperInstallPlan` = `Nie`）携带 `expectedBundleId` + `expectedTeamIdentifier`（`ZCODE_CUA_HELPER_TEAM_ID` 或内置默认 `ya`），macOS 侧按 bundleId+团队签名校验；`allowUnsignedLocalDev` 仅限本地开发。

computerUse 相关字符串 ×121（host 侧）+ computer-use ×50——helper 是 CUA 能力的执行底座，host 的 browser.view/operation 事件族驱动它。
