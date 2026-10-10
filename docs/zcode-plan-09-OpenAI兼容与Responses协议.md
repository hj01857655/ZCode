# 09 · openai-chat-completions 与 openai-responses 协议

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)、姊妹篇 [08-聊天对话接口](zcode-plan-08-聊天对话接口.md)（anthropic-messages 主通道）
> 证据：`zcode.cjs` 内嵌 Vercel AI SDK 的 `openai-compatible`（`NUr`）与 `openai` responses（`kan`）实现

## 0. 三协议选择逻辑

```js
// aRs: 模板配置 → SDK 工厂
switch (api.type) {
  case "anthropic-messages":      return {kind: "anthropic", ...};
  case "openai-responses":        return {kind: "openai", ...};
  case "openai-chat-completions": return {kind: "openai-compatible", name, ...};
}
```

`api.type` 由模板决定（见 [08 §9](zcode-plan-08-聊天对话接口.md) 矩阵）。三种协议共享同一套：会话/工具/用量抽象、源请求头组、`mRs` 之外的 baseURL 原样使用、本地 model-io 日志。

## 1. openai-chat-completions（`NUr`，openai-compatible）

### 1.1 端点与认证

```
POST {baseUrl}/chat/completions          # baseURL 原样使用，不补 /v1
Authorization: Bearer <apiKey>           # SDK 标准；无 anthropic 分支的 dRs 二次注入
```

> 差异：anthropic 分支独有的 `mRs` /v1 归一化和 `dRs` Bearer 补注入**都不作用于本协议**——账号通道走本协议时，认证头必须由 `resolveRequest` 的运行时头自带。

### 1.2 请求体（getArgs 构造，实测字段全集）

```jsonc
{
  "model": "<modelId>",
  "max_tokens": 64000,                    // ⚠️ 兼容版用 max_tokens（官方 openai 用 max_completion_tokens）
  "temperature": ..., "top_p": ...,
  "frequency_penalty": ..., "presence_penalty": ...,
  "response_format": {                    // 仅 supportsStructuredOutputs=true 时支持 json_schema
    "type": "json_schema", "json_schema": {"schema", "strict", "name", "description"}
    // 否则降级 {"type": "json_object"}
  },
  "stop": [...], "seed": ..., "user": "...",
  "reasoning_effort": "none|minimal|low|medium|high|xhigh",
  "verbosity": "...",                     // textVerbosity 透传
  "<providerOptions 透传字段>": ...,       // provider 命名空间下的自定义字段直接并入 body
  "messages": [...], "tools": [...], "tool_choice": {...}
}
```

- **providerOptions 透传**：provider 命名空间里未被 schema 识别的字段原样并入请求体（每供应商扩展点）；另有 `transformRequestBody` 钩子可整体改写。
- **消息转换**（`lPs`）：
  - assistant 历史带推理时输出 **`reasoning_content`** 字段（DeepSeek/GLM 风格）；Gemini 系兼容端点的工具调用透传 `extra_content.google.thought_signature`；
  - 工具结果 → `{role: "tool", tool_call_id, content}`（error-text/error-json 亦字符串化）。

### 1.3 工具映射（`uPs`）

```jsonc
// 请求
"tools": [{"type": "function", "function": {"name", "description", "parameters", "strict?"}}]
"tool_choice": "auto" | "none" | "required" | {"type":"function","function":{"name"}}
// provider-defined 工具不兼容 → 产出 warning（"unsupported"）
```

### 1.4 响应解析

- 非流式：`choices[0].message` → `content` 文本、**`reasoning_content ?? reasoning`** → reasoning 文本、`tool_calls[].function.{name,arguments}`（`thought_signature` 回填 providerMetadata）、`annotations[].url_citation` → source。
- finishReason 映射（`IUr`）：`stop→stop`、`length→length`、`content_filter→content-filter`、`function_call|tool_calls→tool-calls`、其余 `other`。
- usage：`prompt_tokens_details`/`completion_tokens_details`（cached/accepted/rejected prediction tokens）。

### 1.5 流式协议

```
请求: {"stream": true, "stream_options": {"include_usage": true}}   // ZCode 固定 includeUsage=true
SSE: data: {"id","model","choices":[{"delta":{"content"|"reasoning_content"|"tool_calls"},"finish_reason"}]}
     data: {"choices":[], "usage": {...}}      // include_usage 的收尾统计块
     data: [DONE]
     data: {"error": {"message"}}              // 错误块 → unified error
```

支持 `includeRawChunks`（原始块旁路透出）。

## 2. openai-responses（`kan`，OpenAI Responses API）

### 2.1 端点与认证

```
POST {baseUrl}/responses                 # 流式另加 "stream": true
Authorization: Bearer <apiKey>
OpenAI-Organization / OpenAI-Project     # 可选（模板/账号配置时）
```

### 2.2 请求体（getArgs 构造）

```jsonc
{
  "model": "...",
  "input": [...],                         // Responses 输入项（message/function_call/function_output…）
  "instructions": "...",                  // 系统指令（替代 system 字段）
  "temperature": ..., "top_p": ..., "max_output_tokens": ...,
  "text": { "format": {"type":"json_schema","strict","name","description","schema"} | {"type":"json_object"},
            "verbosity": "..." },
  "reasoning": { "effort": "...", "summary": "..." },     // 推理模型（o 系/gpt-5 系）
  "include": ["message.output_text.logprobs", "reasoning.encrypted_content", ...],
  "store": false,                          // store=false 时自动 include reasoning.encrypted_content
  "previous_response_id": "...", "conversation": "...",
  "max_tool_calls": ..., "parallel_tool_calls": ..., "metadata": {...},
  "truncation": "...", "service_tier": "auto|flex|priority",
  "prompt_cache_key": ..., "prompt_cache_retention": ..., "safety_identifier": ...,
  "top_logprobs": ..., "user": "...",
  "tools": [...], "tool_choice": {...}     // 含 web_search/code_interpreter/shell 等内置工具映射
}
```

- 推理模型（`reasoningEffort != null`）自动剥离 `temperature`/`top_p`（与 chat-completions 同逻辑）；非推理模型带 reasoning 参数则产出 warning。
- `service_tier: flex/priority` 有模型白名单校验（o3/o4-mini/gpt-5 系），不符则删除并告警。

### 2.3 SSE 事件集（流式解析器识别的事件名，实测提取）

```
response.created
response.output_item.added / response.output_item.done
response.output_text.delta / response.output_text.annotation.added
response.function_call_arguments.delta
response.custom_tool_call_input.delta
response.image_generation_call.partial_image
response.code_interpreter_call_code.delta / .done
response.apply_patch_call_operation_diff.delta / .done
response.completed / response.incomplete / response.failed
error
```

### 2.4 内置服务端工具与扩展流块载荷（函数族挖掘 2026-09-27，B 级静态）

来源：`isResponse*` 判定族 + 各 zod schema（符号锚点 `hEs`/`gEs`/`fEs`/`mEs`/`pEs`、`z8r`/`$8r`、`cCs`/`DCs`）。

**① provider 内置工具 id → 线上 tool type 映射表**（请求体 `tools[]` 用）：

| ZCode 内部 id | 线上 type | 备注 |
|---|---|---|
| `openai.apply_patch` | `apply_patch` | 文件补丁，inputSchema 见下 |
| `openai.image_generation` | `image_generation` | 流式回传 partial_image |
| `openai.code_interpreter` | `code_interpreter` | 流式回传 code delta |
| `openai.local_shell` / `openai.shell` | `local_shell` / `shell` | |
| `openai.web_search` / `openai.web_search_preview` | 同名 | 参数：`externalWebAccess`/`filters.allowedDomains`/`searchContextSize(low\|medium\|high)`/`userLocation{type:"approximate",country?,city?}` |
| `openai.mcp` | `mcp` | |
| `openai.tool_search` | `tool_search` | input `{tools:[record]}`，output `{tools:[record]}`——把候选工具规格发给服务端检索 |
| `openai.custom` | `resolveProviderToolName` → `args.name` | 自定义具名工具 |

**② `openai.apply_patch` 工具本体**（`cCs`，input `z8r` / output `$8r`）：

```jsonc
input:  { "callId": "...",
          "operation": { "type": "create_file", "path": "...", "diff": "..." }     // 三选一
                      | { "type": "delete_file", "path": "..." }
                      | { "type": "update_file", "path": "...", "diff": "..." } }
output: { "status": "completed" | "failed", "output": "..." }                     // output 可选
```

**③ 三个服务端工具流块的载荷**（§2.3 事件名的 payload，解析器 zod union 实录）：

| 事件 | 载荷字段 |
|---|---|
| `response.apply_patch_call_operation_diff.delta` | `item_id, output_index, delta(string), obfuscation?(string)` |
| `response.apply_patch_call_operation_diff.done` | `item_id, output_index, diff(string)` |
| `response.code_interpreter_call_code.delta` | `item_id, output_index, delta(string)` |
| `response.code_interpreter_call_code.done` | `item_id, output_index, code(string)` |
| `response.image_generation_call.partial_image` | `item_id, output_index, partial_image_b64(string)` |
| `error` | `sequence_number, error{type, code, message, param?}` |

解析器对未知 `type` 走 `{type: string}.loose() → "unknown"` 兜底（前向兼容）。识别层 = 14 个 `isResponse*Chunk` 判定 + `isErrorChunk`；输出侧配套 `mapWebSearchOutput`、`escapeJSONDelta`。

## 3. reasoningLevel 在三协议上的取值域

会话档位（DB `reasoning_level`，`/effort` 命令可切换）按协议走不同字段，且**必须在该模型 `optionSpecs.reasoningLevel.values` 白名单内**（`_$o` 校验，否则报 "Unsupported reasoning effort"）：

| 协议 | 字段 | 枚举 |
|---|---|---|
| anthropic-messages | `output_config.effort` | `low, medium, high, xhigh, max`（GLM 扩展） |
| openai-chat-completions | `reasoning_effort` | `none, minimal, low, medium, high, xhigh` |
| openai-responses | `reasoning.effort` | 同 OpenAI（`minimal..high` 系） |

> 本会话的 `max` 即 GLM 专属档位——`zai-api` 模板模型声明了这个值域，其他协议模型白名单里没有 `max`。

## 4. 三协议差异速查

| | anthropic-messages | openai-chat-completions | openai-responses |
|---|---|---|---|
| URL | `{base}` → 补 `/v1` + `/messages` | `{base}/chat/completions` | `{base}/responses` |
| 认证 | `x-api-key` + `Authorization: Bearer`（`dRs` 注入） | `Authorization: Bearer` | `Authorization: Bearer`（+ Org/Project） |
| 系统提示 | `system[]`（可 cache_control） | messages 内 system role | `instructions` 字段 |
| 推理 | `thinking:{type}` + `output_config.effort` | `reasoning_effort` / `reasoning_content` 回传 | `reasoning:{effort,summary}` + 加密推理内容回传 |
| 上下文缓存 | `cache_control: ephemeral`（显式） | 无（隐式/服务端 `prompt_cache_key`） | `prompt_cache_key/retention` |
| token 上限字段 | `max_tokens` | `max_tokens`（兼容版） | `max_output_tokens` |
| 结构化输出 | `output_config.format` | `response_format` | `text.format` |
| 流式统计 | `message_delta.usage` | 收尾 usage 块（`include_usage`） | `response.completed.usage` |
| GLM 专属 | GLM 兼容层四修复 | `reasoning_content` 读取 | — |
| V4 签名 | ✅（仅付费/API-key 通道） | 传输层同样包装（签名头按 anthropic 设计，openai 分支未注入 `dRs`） | 同左 |

## 5. 遗留说明

- `bzo`（URL→协议分类器）还能识别 Google `:generateContent` 形态，但 CLI 未内置 Gemini provider（`generativelanguage` 零命中），仅 openai-compatible 端点上透传 Gemini 的 `thought_signature`。
- `zai-standard-api`/`bigmodel-standard-api` 模板未配置额外 `api.headers`，即纯 OpenAI 兼容头。
