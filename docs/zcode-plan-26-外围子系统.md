# 26 · 外围子系统（遥测 / 记忆 / 自更新 / 附件 / 反馈）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)

## 1. 遥测与统计

- **会话事件全类型**（`createSessionEvent` 枚举）：hook 五事件、Compact 四事件、MicrocompactBoundary、RewindTriggered、CheckpointCreated、TargetChanged/TargetCompletionVerification、Subagent 三事件、Interrupt/Cancel/Resume/Error。
- **ARMS 自定义事件**：`aliyun_captcha_verification`（[12 §5](zcode-plan-12-阿里云验证码体系.md)）等。
- **云遥测通道**：`v4/telemetry/event`、`v4/telemetry/local-ttft`（本地 TTFT 直报，见 [17 §1](zcode-plan-17-云端会话与远程体系.md)）。
- 上报脱敏：模型网络头黑名单 `RFs`（authorization/cookie/x-api-key/x-client-sig/x-off-peak-ticket-id 等，见 [05 §7](zcode-plan-05-V4请求签名协议.md)）。

## 2. 记忆系统

- 开关：`setting.memoryEnabled`（本机 false）。
- 双分支检索：`resolveProjectMemoryRetrievalBranch` → `semantic-recall`（语义检索）vs `default-index`（MEMORY.md 索引加载，当前固定走 default-index）。
- 文件规范（注入的 memory section 提示词）：一主题一文件 + frontmatter（name/description/type: user|feedback|project|reference）+ `[[slug]]` 互链 + MEMORY.md 单行索引；明确不保存 repo 已记录内容。

## 2b. 官方开发工具面（2026-09-28：开源仓发现）

`packages/formal-proof` = **产品行为状态空间枚举器**（ZCode 团队自用模型检查）：枚举对话场景的 compact × fork × goal × 消息队列 × query 编辑组合行为，web 界面（localhost:4176）。dev 工具，不进发行包——但证明官方对 compact/fork 交互矩阵有自己的枚举测试（[18](zcode-plan-18-系统提示词与上下文管理.md) §3.4 的函数级行为可对照它）。

## 3. 自更新机制（后端补充 2026-09-28：Keygen）

**Windows 侧更新后端 = Keygen**（asar 内嵌 keygen API 客户端）：`https://api.keygen.sh/v1/accounts/<account>/artifacts?product=<product>`，`channel` 默认 `stable`——`getLatestVersion` 按 channel 拉工件清单（SHA256 分块校验）。macOS 侧为 Sparkle（`_re/sparkle_rules.js` 分析线）。

- **Electron 更新**：`app-update.yml` + `skippedElectronUpdateVersions`（用户可跳过特定版本）、`autoDownloadAndInstallUpdates` 开关。
- **Built-in 资源更新**：`downloadZCodeBuiltinRelease` 从 CDN 拉运行时配置，`zcode-builtin-refresh.json` 控制文件做刷新协调；CLI 侧通过 **SEA 资产**（`zcode-provider/zcode-builtin.json` 内嵌于可执行）materialize 到 `~/.zcode/v2/runtime/provider/`（哈希目录 `endpoint-<sha256(origin)前32位>`，见 [01](zcode-plan-01-计划体系与供应商标识.md)）。
- 版本兼容：`G8i(appVersion)` 决定 remote v3/v4；`MA(appVersion)` 同理。

## 4. 附件管线

```
v4/attachment/begin → chunk（≤64 chunks，并发≤16，暂存≤64MB）→ commit | abort
读取: attachment/read / conversation/attachmentRead / attachmentStat / previewSource
TTL: 暂存 5min，未引用 24h，读取缓存 30s
```

（常量表：`attachmentUploadMaxChunks:64, MaxConcurrent:16, MaxStagedBytes:64MB, UploadTtlMs:5min, UnreferencedTtlMs:24h, ReadCacheTtlMs:30s`）

## 5. 反馈/诊断

- 反馈工单本地存储：`tickets.json`（≤200 条，按 deviceMid 过滤/去重），工单状态含"已解决/已上线"等中文枚举。
- 诊断日志导出：zip 打包（yazl），`decodeDiagnosticLog` 支持 UTF-16LE/BE BOM 检测与控制字符校验。
- 身份记录：`deviceMid`（见 [02 §4](zcode-plan-02-认证与凭证存储.md)）+ 用户身份 entries/decisions 双文件（version 1→2 迁移，`deviceMid mismatch` 保持既有值）。

## 6. 运行时特性开关、端点环境与命令队列（2026-09-27 函数体实读，B 级）

**① 特性开关**（`resolve.runtime` 族）：`browserUse` = **config.runtimeFeatures.browserUse===true 且 browserControlPort 已注入**（双条件，[22](zcode-plan-22-CUA与浏览器自动化.md)）；`dynamicWorkflowEnabled !== false`（**缺省开**）；embeddedSearch 同族判定。

**② 运行面与分发形态**（`resolveRuntimeSurface` = `x7a`）：surface 枚举 **`standalone_cli` | `desktop_local_host` | `remote_workspace_host`**（缺省 standalone_cli）；distribution `source|development_bundle|packaged|unknown`；`OTEL_RESOURCE_ATTRIBUTES` 逗号 KV 解析入遥测资源。

**三种形态的差异清单**（bundle `t.standalone` 分支，2026-09-27 补）：
- **独立环境变量源**：standalone 走 `e[OXe]` 专属变量，非桌面共享配置；
- **fetch 可注入**：`t.standalone?.request ?? globalThis.fetch`；
- **builtin 目录刷新**（`fetchRelease`）传 `platform=windows-x86_64`（`resolveZCodeBuiltinClientPlatform`），desktop 不走此形态；
- **UA 分野**：desktop 内嵌 CLI 显式拼裸 `ZCode/<ver>`；standalone CLI 落 AI SDK 默认组装（后缀形态，[08 §2.1](zcode-plan-08-聊天对话接口.md)）。
- **双版本线**：desktop 3.14.3 / standalone CLI 0.16.x（后者来源 zcode2api-plus golden capture，C 级）。
- 第四种嵌入形态：Breezell（VS Code fork 内嵌 CLI），不在 surface 枚举内（[37 §7](zcode-plan-37-排障手册.md) 桥接的对端）。

**③ 端点环境矩阵**（`resolveRuntimeZCodeEndpointOrigin` = `p1` + `air`/`FR`/`K8i`）：
- `ZCODE_ENV` production/test 双轨：production 用 `ZCODE_PRODUCTION_BASE_URL`（缺省 `jee`），test 用 `ZCODE_TEST_BASE_URL`；覆盖链 `ZCODE_BASE_URL` ?? `ZCODE_ENDPOINT_ORIGIN` ?? env 专属值；origin 必须 http(s)（`FR` 校验）
- **relay WS**：生产 origin 下固定 `wss://zcode.chatglm.site/ws`（`Y8i`）——[17](zcode-plan-17-云端会话与远程体系.md) relay 通道的线上地址首次落名
- BigModel 侧对称：`BIGMODEL_PRODUCTION/TEST_API_BASE_URL`（`XAe`）；e2e 场景 localhost/127.0.0.1/::1 白名单（`K8i` + `e2eStoreBridgeEnabled`）

**④ 命令队列**（`createRuntimeCommandQueue` = `L1o`）：优先级表 `j_t` 驱动的 selectNextIndex；**`task-notification` 模式按同优先级批量出队**（其余单条）；cancelPending 两段式（clear/consume）——背景任务通知与用户命令的统一排队层。
