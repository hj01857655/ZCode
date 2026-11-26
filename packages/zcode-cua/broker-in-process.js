// 进程内 broker 用官方实现：首次调用才加载 native addon 并在本进程监听。
// Windows 上同样有效——Helper 运行时含 win32 执行层，dev 桌面只是选择 fork 独立 Helper。
export { startInProcessComputerUseBroker } from "./vendor/official-runtime.js";