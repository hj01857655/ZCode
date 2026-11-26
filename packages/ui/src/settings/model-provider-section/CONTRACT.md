# ui-model-provider-section

一页以内。只写类型与测试表达不了的三样：模块存在的意图、不变量、与其它模块的交集在哪个 hook 点处理。

不变量：

- Provider endpoint 草稿是拉取模型列表的唯一输入；按钮只使用当前卡片里的 apiFormat、baseUrl 和 apiKey，不读取 Repo 或持久化状态。
- UI 只调用 ProviderSettingsService.fetchProviderModelIds，实际 /models 请求由目标 Environment 的 Host 用 Node fetch 发出，避免 renderer 直接请求用户 endpoint 触发 preflight/CORS；Host 侧统一 15s 超时，失败要打开结果弹窗显示错误，不允许静默失败。
- 导入只新增 Personal Model 成员；远端批量导入在一次导入动作内逐个通过 addPersonalModel 保存，手动添加沿用带 personalConfig 的现有链路，远端重复 ID 和空 ID 不进入候选列表。
