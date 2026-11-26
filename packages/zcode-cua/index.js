// Computer Use 运行时入口：直接转发发行包内 `@zcode/zcode-cua/dist/index.js` 的实现
//（见 vendor/official-runtime.js 的生成说明）。14 个工具的参数解析、帧绑定、
// 动作策略、会话与 kill switch 都在那一份代码里，这里不再维护平行实现。
export { createComputerUseRuntime } from "./vendor/official-runtime.js";