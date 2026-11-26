# 桌面开发态 React Scan

## 目的与范围

在桌面 renderer 开发时高亮 React 组件的渲染，帮助发现输入、切换任务、流式回复期间的重复更新。
高亮表示发生了渲染，不直接判定为性能问题；耗时和更新原因仍结合 Performance 面板分析。

只接入桌面主入口 `index.html`。不修改业务组件、store 或协议，不注入插件沙箱、资源管理器、
CUA 权限浮窗及 Web/手机入口。

## 加载规则

- React Scan 是 `@zcode/desktop` 的开发依赖，锁定版本，脚本由本地 Vite 服务提供，不依赖 CDN。
- 仅 `vite serve` 且 mode 非 `production` 时**可以**启用，默认关闭。
- `ZCODE_REACT_SCAN=1` 才注入；未设置、`0` 或其它取值都不注入。该变量与连接哪个后端的 `ZCODE_ENV` 无关。
  默认关闭的原因：Scan 会 hook 每次 React commit 并在右下角挂常驻工具栏，对不排查渲染问题的开发
  （CLI、网关、main 进程等）只有开销和遮挡，没有收益。
- 使用 head 中的普通 script，先于 React/React DOM 模块执行，避免首次挂载前未安装 hook 而漏报。
- `vite build`（包括非 production mode）与 preview 不注入脚本；生产 renderer 不携带 React Scan。
- `ZCODE_REACT_SCAN` 不影响 E2E 构建产物，不进入构建缓存环境变量指纹。构建配置的变量审计仅在 `vite.config.ts` 中排除此开发开关；其他构建变量仍须登记。
- Scan 自己管理工具栏和暂停状态，不在业务层增加第二套渲染计数或持久化。

```text
vite serve + ZCODE_REACT_SCAN=1 → 本地 Scan 脚本 → React 初始化 → 应用挂载 → 渲染高亮
vite serve + 开关未开 ──────────────→ React 初始化 → 应用挂载
vite build / preview ────────────────→ React 初始化 → 应用挂载
```

## 使用

正常执行 `pnpm dev:desktop` 不会出现 Scan 工具栏。排查渲染问题时显式开启：

macOS / Linux：

```sh
ZCODE_REACT_SCAN=1 pnpm dev:desktop
```

Windows PowerShell：

```powershell
$env:ZCODE_REACT_SCAN = "1"
pnpm dev:desktop
```

也可在仓库根 `.env.local` 设置 `ZCODE_REACT_SCAN=1` 让本机每次开发都开启；移除变量并重启即恢复默认关闭。
工具栏可暂停高亮；做耗时基准测量时，去掉开关后重新启动以排除调试开销。

## 验证合同

| 用例 | 验证                                                                                      |
| ---- | ----------------------------------------------------------------------------------------- |
| RS01 | 开发服务默认不注入；显式开启时注入本地脚本，且先于 React 执行；生产后端不影响开发工具开关 |
| RS02 | 未设置、显式关闭、非 `1` 取值、production mode 服务、任意 mode 构建均不注入              |
| RS03 | 辅助窗口和插件沙箱不注入                                                                  |
| RS04 | 真实 Electron renderer 首次挂载后工具栏可见，点击组件产生可观测渲染；刷新不重复挂载工具栏 |
| RS05 | 关闭 Scan 的真实 renderer 保持交互可用且没有 Scan；构建产物没有 Scan 脚本或代码           |

配置回归在 `packages/desktop/test/viteRendererConfig.test.ts`。
开发工具 E2E 位于 `packages/desktop/test/e2e/ui-shell/performance/manual-review/pending/react-scan-dev.test.mjs`，
使用隔离的 Vite fixture 和真实 Electron，不连接业务账号或模型，不进入产品回放套件。

```sh
node --test packages/desktop/test/e2e/ui-shell/performance/manual-review/pending/react-scan-dev.test.mjs
```

参考：[React Scan Vite 接入](https://github.com/aidenybai/react-scan/blob/main/docs/installation/vite.md)。
