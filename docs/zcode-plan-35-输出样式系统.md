# 35 · 输出样式系统（Output Style）

> 归属：[ZCode Start Plan 逆向分析总览](zcode-start-plan-逆向分析.md)
> 来源：`zcode.cjs` identity 提示词节（`CJs`）+ `output-style` IPC 通道

## 1. 机制

输出样式 = **注入身份层的一段附加规范**，改变助手的回复风格/角色，而不改变工具与能力：

```js
// CJs(outputStyleActive):
[
  ["", outputStyleActive
    ? "You respond to the user according to the active Output Style below while using ZCode's tools and instructions."
    : "You are an interactive ZCode agent that helps users with software engineering tasks.",
    "", IMPORTANT 安全前言].join(" "),
  "", Harness 规则
]
```

- 未启用时是默认身份句；启用后身份句被替换，并要求"把激活的 Output Style 当作规范来回应"——样式正文作为独立 section 注入在身份层之后。
- 样式激活状态属于会话/工作区配置（`output-style` IPC 通道管理，样式文件在配置目录，类似 Claude 的 output styles）。

## 2. 与其他层的关系

- 只影响**文本风格与角色扮演**；工具清单、权限引擎、模型选择均不受影响（`using ZCode's tools and instructions` 保留了工具合规性）。
- 与 AGENTS.md（[13](zcode-plan-13-AGENTS.md支持.md)）的分工：AGENTS.md 是项目级长期指令，Output Style 是即时可切的"人格/文风"层。
- UI：设置里可切换样式；系统提示词装配器（[18 §2](zcode-plan-18-系统提示词与上下文管理.md)）在 identity 节动态反映选择。
