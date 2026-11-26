# Desktop 调试入口

桌面端把开发和诊断相关的入口统一收口到 `Help` 菜单，避免调试能力分散在多个顶层菜单里。

当前 `Help` 菜单里的调试入口包括：

- `Toggle Developer Tools`
- `Resource Manager`（资源管理器，见 `docs/electron/resource-manager.md`）

这样调整后，开发排查时只需要从一个固定位置进入对应工具。

`Toggle Developer Tools` 在两个菜单里都只按「本地开发运行形态」判断可见性，与 stdio tap 开关无关：原生菜单用 `!app.isPackaged`，Windows 自绘标题栏菜单用 `platform.isLocalDevelopmentRuntime`（renderer 由 `__ZCODE_LOCAL_DEVELOPMENT_RUNTIME__` 注入）。stdio tap 关闭时也必须能看到开发者工具入口。

Windows/Linux 没有原生菜单栏，箭头菜单 `WindowsCaptionMenuButton` 也已不再挂载（见 `docs/windows-caption-help-menu.md`），所以这两个平台上开发者工具的唯一菜单入口是右上角问号帮助菜单 `WorkspaceHelpMenuButton`：同样只在 `platform.isLocalDevelopmentRuntime` 为真时渲染「切换开发者工具」，位于「预装工具」之后、「检查更新」之前，不改变「关于」仍是最后一项。
