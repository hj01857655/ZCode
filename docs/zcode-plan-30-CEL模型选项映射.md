# 30 · CEL 模型选项映射引擎

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)、消费方见 [15 §3](zcode-plan-15-工具与权限体系.md) 与 [09](zcode-plan-09-OpenAI兼容与Responses协议.md)
> 来源：`zcode.cjs` 内嵌的受限 CEL（Common Expression Language）实现：`Ttr` 分词器、`Nji` 解析器、`rAe` 编译器、`Atr` 冲突检测，函数名完整保留

## 0. 是什么

模型配置里可以写**CEL 表达式规则**（"model option map"）：输入会话参数（如 `reasoningLevel`、`maxOutputTokens`），输出一个 JSON 对象——即**该次请求的 provider 选项补丁**。这就是"会话的 reasoningLevel=max 如何变成 anthropic `output_config.effort` / openai `reasoning_effort`"的翻译层。

```js
compileModelOptionMaps(optionSpecs) → [Dtr(option, patch)]   // 每条规则编译为 {option, patch}
evaluate(modelInput) → JSON 对象                              // 运行时按会话参数求值
```

## 1. 受限 CEL 的能力面

- **运算符白名单**（`Cji/Eji/Aji` 三个集合）：
  - 逻辑/比较：`&& || == != <= >=`
  - 算术：`+ - * / % ! < >`
  - 结构：`{ } [ ] ( ) , : ? .`（对象/数组/三元/成员访问）
- 字符串（单双引号 + 转义表 `Dji`）、数字字面量（`Pji`）。
- **输出约束**（`iWt` = `assertObjectResultExpression`）：表达式必须求值为 JSON 对象；三元分支的两侧也递归检查——"model option map must return a JSON object"。

## 2. 编译与求值

```js
rAe(source, env)                  # 编译（normalizeSource → parse → 校验 → 冻结）
  → { source, evaluate(modelInput) }
Itr / Ctr                          # 按 (规范化源码, 环境) 双层 Map 缓存编译结果
```

## 3. 冲突检测（`Atr`）

多条规则写**同一 JSON 路径** → 编译期报错：

```
Model option maps write conflicting JSON path <path>: <规则A的option> and <规则B的option>
```

即每个 option 路径只能被一条规则拥有——保证 reasoningLevel 等参数来源唯一。

## 4. 数据流（谁在用）

```
provider 模板/账号配置的 optionSpecs（[01 §4] 的 Zod schema）
  └─ compileModelOptionMaps(specs) → 规则集
会话每次请求带 options {reasoningLevel, maxOutputTokens}
  └─ Dtr("reasoningLevel", patch.evaluate(input)) → 合成 providerOptions
       → anthropic: output_config.effort / thinking.budget_tokens（[08 §4.1]）
       → openai: reasoning_effort / max_completion_tokens（[09 §1.2]）
```

规则来源：provider 模板与个人配置（`provider_config.json` 的 `modelConfigRules` / `providerModelRules`），运行时 `zcode-builtin.json` 修订合并（[01 §7](zcode-plan-01-计划体系与供应商标识.md)）。
