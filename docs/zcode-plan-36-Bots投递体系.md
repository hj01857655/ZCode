# 36 · Bots 投递体系

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：`zcode.cjs` 会话发送 payload schema（`botDeliveryTarget`/`Wpe`）+ IPC 通道 `bots`

## 1. 是什么

`botDeliveryTarget` 是**会话输入/自动化结果的投递目标**：定时任务（automation）或 off-peak 任务跑完后，把结果投递到一个"bot 端点"——即用户不在场时的结果送达通道。

## 2. 结构与约束

- 会话发送 payload 可携带 `botDeliveryTarget`（`Wpe` schema，详见 automations 表的 `bot_delivery_target` 列，见 [14 §2](zcode-plan-14-本地存储全schema.md)）。
- **互斥约束**（superRefine）：同一 payload 里 `automationId` 与 `offPeakTaskId` 互斥——一次派发只能源于 cron 或 off-peak 之一；`offPeakRunType: "init"|"resume"` 标记空闲任务的初始/续跑派发。
- 附带字段：`expectedProviderRevision`（provider 配置版本一致性）、`toolDenylist`（本次派发的工具黑名单）——无人值守运行的能力收窄。

## 3. 现状（本机实测）

- `~/.zcode/v2/bot-config.v3.json` / `bot-state.v3.json` 各 33 字节（空骨架）——Bots 子系统在本机**未配置任何目标**。
- IPC 通道 `bots` 与 `bots.syncAppRuntimePreferences`（流量表 [27 §3](zcode-plan-27-IPC通道注册表.md)，5 次调用）仅做偏好同步。
- 结论：投递通道已接线但目标生态未启用；结合 [31](zcode-plan-31-Cron调度循环.md)，定时/off-peak 任务的结果目前主要落在任务列表与通知，而非外部 IM。

## 4. 通道实现（2026-09-28 asar 静态还原，B 级；模块聚落 asar @27.1M）

**① 飞书 / Lark 双域通道**（实现主体）：

- **域二选一**（`getFeishuDomainProvider`）：`feishu` → `https://open.feishu.cn`；`lark` → `https://open.larksuite.com`——国内飞书与国际 Lark 同一套代码（内嵌 `@larksuiteoapi/node-sdk`，asar node_modules 在列）。
- **应用凭据**：`feishuAppId` + `credentialRef` → `loadCredential`（`readFeishuAppSecret` = `Dde`）——bot 应用密钥由 ZCode 凭证系统托管，不落配置文件。
- **接收 = 事件订阅**（`Nde`）：SDK 事件回调 `im.message.receive_v1`（收消息，payload 带 `botId`/`zcodeProvider`）+ `im.message.reaction.created_v1`——WebSocket 长连接模式，非 webhook 轮询。
- **回复 = Lark SDK 消息 API**：`POST {domain}/open-apis/im/v1/messages`（httpInstance，paramsSerializer repeat 风格）；另有 `sendFeishu` 快捷发送。
- **交互式卡片（elicitation）**：`buildFeishuElicitationCardPayload`（`op`）产出 **schema 2.0** 卡片（`wide_screen_mode`、`body.elements`），文案 locale 化（`elicitationCancelledCard`）——bot 支持**卡片问答**，不只是单向通知。

**② 微信通道**（解析层）：

- `readWeixinChatId`（`Nce`）按 `room/room_id/roomId/chat/chat_id/chatId` 六种字段读群 ID；`readWeixin*` 解析 `from/sender/nickname/sender_nickname`——**个人微信消息字段风格**（企业微信 `qyapi.weixin` 全包 0 命中）。
- 传输方式未还原（C 级）：无官方 API 调用，疑经外部桥接注入该消息形状。

**③ 格式化层**（`format.bot` 族）：`formatBotAssistantReplyBlocks`（`vy`）把 assistant 回复/工具调用/**变更摘要**（`changeSummary`，locale 化）组装为消息块；配套 `formatBotChangeSummary`/`DiffCount`——投递内容是**结构化的工作结果摘要**，非裸文本。

**④ 第四通道：Telegram**（官方源码 `packages/services/src/bots/providers/telegramProvider.ts`，1,900+ 行）：标准 Bot API（`getMe` 验证、`file_path` 附件下载 30s 超时、`BOT_MENU_COMMAND_ORDER` 命令菜单注册、`SelectionPrompt` 选择提示）。**开源后新增确认**——官方开源仓 `packages/services/src/bots/` 有完整服务端实现（`botsService.ts` 6,363 行 + 四通道 ChannelRuntime + `feishuAppRegistration`/`weixinRegistration` 应用注册流 + `commandParser`/`replyFormatter`/`statusFormatting`）。

**⑤ 源码指针（2026-09-28 起 bot 子系统可源码核验）**：官方开源仓 `packages/services/src/bots/`（~30 文件）+ `packages/formal-proof`（产品行为状态空间枚举器：compact×fork×goal×消息队列×query 编辑组合的模型检查，dev 工具不进发行包）。

## 5. 现状判定（修正 §3）

通道实现**完整在库**（飞书为主力、微信为解析层、elicitation 卡片可交互），本机"未配置"仅指 `bot-config.v3.json` 为空骨架。即：配一个 `feishuAppId`+凭据即可激活飞书通道，无需任何开发。
