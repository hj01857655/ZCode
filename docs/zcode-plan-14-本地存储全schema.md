# 14 · 本地存储全 Schema

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：`~/.zcode/cli/db/db.sqlite`（22 业务表 + 2 内部表，2026-09-27 实测核对）与 `~/.zcode/v2/tasks-index.sqlite`（9 表）的 `sqlite_master` 全量提取

## 1. db.sqlite（会话主库，22 业务表）

### 1.1 会话核心

| 表 | 关键字段 | 说明 |
|---|---|---|
| `session` | id, project_id, workspace_id, parent_id, slug, directory, title, version, share_url, summary_additions/deletions/files/diffs, revert, permission, task_type(默认 interactive), title_source(default/first_input/generated/custom), trace_id | 会话主表；title 来源可追溯（title_message_id + time_title_updated） |
| `message` | session_id→session, sequence, data(JSON) | 消息体（JSON 存储，sequence 排序） |
| `part` | message_id→message, sequence, data(JSON) | 消息分片（工具调用块、文本块等） |
| `session_entry` | session_id, type, data | 会话事件流（泛化 entry） |
| `session_input` | kind, delivery(startNow/queue/guide), payload, admitted_sequence, status(admitted/promoted/cancelled/discarded/failed) | **输入投递队列**——用户消息的准入/提升/排队状态机 |
| `session_target` | target_id, objective, status(active/paused/budget_limited/complete), token_budget, tokens_used, time_used_seconds | 会话目标/预算控制 |
| `session_task_link` | root_workflow_run_id, parent/child_session_id, role, depth, path, agent_type, model | 会话-工作流-父子代理 的链接树 |
| `todo` | (session_id, position), content, status, priority | TodoWrite 工具的持久层 |
| `input_history` | project_id, text, kind, attachments | 输入历史（@引用附件单独存） |
| `local_setting` | (scope, scope_id, namespace, key) → value | 作用域化 KV 设置 |
| `permission` | project_id → data(JSON) | 项目权限规则（allow/deny 规则，见 [15](zcode-plan-15-工具与权限体系.md)） |

### 1.2 用量遥测

| 表 | 说明 |
|---|---|
| `model_usage` | 逐模型请求：provider_id, model_id, variant, agent, mode, task_type, status, TTFT/duration, finish_reason, tool_call_count, token 明细（input/output/reasoning/cache，截断可见部分外还有 reasoning 等） |
| `turn_usage` | 逐轮聚合：model_request/retry_count, tool_call/error_count, tokens, retryable/cancelled_by_user/context_exceeded/error_code |
| `tool_usage` | 逐工具调用：tool_name, **side_effect_scope**, read_only(0/1), destructive(0/1), approval_status, duration, output/stdout/stderr bytes, truncated |

> `tool_usage.side_effect_scope` 与权限引擎的 `sideEffectScope` 同源（见 [15](zcode-plan-15-工具与权限体系.md)）。

### 1.3 工作流（dynamic workflow / DWF）

| 表 | 说明 |
|---|---|
| `workflow_definition` | name, source(builtin/user), trusted, enabled, script_path/hash, scope(builtin/explicit/project/user) |
| `workflow_run` | definition_id, kind(script), status(pending/running/paused/completed/failed/cancelled), budget_total/spent, args_hash（**缓存键**——同 args 可命中 cache） |
| `workflow_activity` | run 的调用树：call_index/call_path, attempt, status(queued/running/completed/failed/skipped/cancelled/**cached**/lost), child_session_id, result_json |
| `workflow_event` | run 事件流（sequence 排序） |
| `dwf_run` / `dwf_node` / `dwf_actor` / `dwf_event` | 动态工作流第二套存储：node kind(ask/world-read/world-run/report/artifact)，actor 带 persona_json/resolved_model |

## 2. tasks-index.sqlite（任务索引，9 表）

| 表 | 说明 |
|---|---|
| `tasks` | (workspace_key, task_id) 主键：title, task_status, provider, **mode(默认 build)**, model, forked_from_task_id, pinned/archived/deleted, searchable_text, cron_automation_id, off_peak_task_id |
| `task_groups` / `task_group_members` / `task_group_view_node_orders` / `task_group_workspace_bootstraps` | 任务分组与视图排序 |
| `automations` | 定时任务：cron_expr, prompt, model/provider/mode/thought_level, recurring, max_runs, end_at, schedule_rule, lifecycle_status |
| `automation_runs` | 每次 cron 触发：dispatch_status(claimed→…), outcome, session_id, attempts |
| `off_peak_tasks` | off-peak 任务：server_ticket_id, prompt, permission_mode, status, queued/started/ended, failure_reason, schedulable |

## 3. 存储拓扑小结

```
~/.zcode/
├── cli/db/db.sqlite            # 会话/消息/用量/工作流（agent 进程写）
├── v2/tasks-index.sqlite       # 任务索引/定时/off-peak（host 进程写）
├── v2/credentials.json         # 加密凭证（enc:v1，见 02）
├── v2/setting.json             # 用户设置（家族域、连接选择等）
├── v2/provider_config.json     # 个人 provider 规则（见 10）
└── cli/rollout/model-io-*.jsonl # 模型 IO 日志（认证头剥离）
```

两个库由不同进程写入（agent vs host），以 session/task id 关联；`tasks.session_id` ↔ `session.id`、`tasks.cron_automation_id` ↔ `automations.automation_id`。

## 4. 补充（2026-09-27）：v2/runtime/provider/

`v2/runtime/provider/<platform>/<appVersion>/endpoint-<sha256(origin)前32hex>/` 下存 `zcode-builtin.json`（内置模型目录，来源见 [08 §9](zcode-plan-08-聊天对话接口.md)）与 `zcode-builtin-refresh.json`（刷新控制）。`<platform>` 用 **`windows-x86_64` 形态**（`resolveZCodeBuiltinClientPlatform` 计算：win32→windows、x64→x86_64、arm64→aarch64）——本机实存 `windows-x86_64/3.14.3/endpoint-78d7c3bef4024722642626fe3669a799/`。

## 5. 输入提升的 yolo 语义（2026-09-28 源码级，B 级）

`session_input` 队列的**提升（promote）路径**是事务化的：按 `queueItemIds` 取 pending payload → 解析后对 `intent`/`conversationInputIntent` 字段**强制 `mode:"yolo"`** → `run(payload, …)` → 事务 commit/rollback。语义：**排队/计划输入提升执行时按无人值守（yolo）权限运行**——与 [31](zcode-plan-31-Cron调度循环.md) 的定时触发、[06](zcode-plan-06-off-peak档位.md) 的 off-peak 运行共用此语义（无人值守场景无法交互确认，权限前置为 yolo）。
