# 31 · Cron 调度循环

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 存储层见 [14 §2](zcode-plan-14-本地存储全schema.md)；本文覆盖调度运行时
> 来源：`zcode.cjs` `CronCreate` 工具链（`Dpa`/`Hvn`）、automation 服务、调度常量

## 1. 创建链路（`Dpa`，CronCreate 工具）

```
用户/agent 调 CronCreate({cron, prompt, model?, …})
  → pet.parse(e)                # 参数 schema 校验（含 mode 别名归一 uYa，见 15 §2）
  → assertAutomationPort       # host 的 automation 服务必须在场
  → automationPort.create({…, model: "providerId/modelId", sessionId})
      → automations 表插入一行（[14 §2]）
  → 返回 {automation: {automationId, title, cronExpr, prompt, enabled,
       lifecycleStatus, nextRunAt, lastRunAt, runCount, recurring, maxRuns, scheduleRule}}
```

- 互斥约束：一次派发要么挂 `automationId`（cron 触发）要么挂 `offPeakTaskId`（空闲队列），不能同时（superRefine）。
- `scheduleRule`：非 cron 的补充调度规则（如 intervalUnit/interval 结构，见 CronCreate 工具描述）。
- 模式归一：`dontAsk/bypassPermissions→yolo`、`default/auto/acceptEdits→build`（[15 §2](zcode-plan-15-工具与权限体系.md)）。

## 2. 调度运行时

- **下一次执行时间** `nextRunAt` 由调度器按 `cronExpr` / `scheduleRule` 计算，随 automation 暴露给 UI 倒计时。
- **唤醒机制**：调度器到点后投递 `cron-scheduler-wake-request`（[26 §1](zcode-plan-26-外围子系统.md) 事件表 / off-peak 有对称的 `off-peak-scheduler-wake-request`），host 唤醒对应工作区的 agent 并注入 prompt。
- **轮询节拍**：调度常量 `Y_e = 30_000`（30s 巡检）与 `koe = 32_000`（自动化通道相关超时）。
- **单次/有限执行**：`recurring=false` 时按 `maxRuns` 计数（`run_count/scheduled_run_count`），`end_at` 硬截止；`lifecycle_status` 管停用。
- **每次运行的记录**：`automation_runs`（dispatch_status: claimed→…、outcome、session_id、attempts、error）——错过的触发以 `scheduled_at` + attempts 补偿语义管理。

## 3. 派发后的世界

到点的 automation ≈ 一次无人值守会话：`tasks.cron_automation_id` 关联任务、会话以配置的 provider/model/mode 打开（权限模式同样走 [15](zcode-plan-15-工具与权限体系.md) 引擎）、结果可经 `botDeliveryTarget` 投递到 bot（[36](zcode-plan-36-Bots投递体系.md)）。

## 6. scheduler 进程面（2026-09-28 静态还原，B 级）

`out/scheduler/`（3 束 / 自有长名 2,551，见 [42 §2.5](zcode-plan-42-AppAsar自有面地图.md)）不是纯 cron 宿主，调度之外还携带会话运行面（conversation artifact / attachment upload / interaction / computer use / workspace preferences 家族）。

**scheduler → host RPC 方法表**（schema 实录节选）：`offPeak/create`、`offPeak/list`、`automation/create|update|list|delete|checkTaskBinding`、`usage/stats`、`session/usage`、`process/childProcesses` 等——[27](zcode-plan-27-IPC通道注册表.md) 的 host RPC 由此进程消费。

**唤醒机制**：两种唤醒事件——`cron-scheduler-wake-request`（automationId）与 **`off-peak-scheduler-wake-request`**。

**off-peak run 类型**：`offPeakRunType ∈ {"init", "resume"}`——off-peak 会话支持 **`expectedRevision` 乐观并发**（automationId / offPeakTaskId 二选一绑定）。30 秒巡检（§4）之外，这是定时系统的第二 half：唤醒 → host `offPeak/create` → host 发起 ticket HTTP（[06 §8](zcode-plan-06-off-peak档位.md)）。

**流式帧装配限额**（`logical.frame` 七件套，实值）：MaxBytes **16MB** / MaxStagedBytes **32MB** / MaxFragments **1024** / MaxConcurrent **32** / TimeoutMs **30s**——本进程承载的流式会话装配资源上限。
