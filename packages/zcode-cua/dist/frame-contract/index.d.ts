// 官方最终栅格帧契约的公开子路径类型入口（zcode-cua 0.6.6 契约）。
//
// 与 dist/frame-contract/index.js 配对：官方 producer 的 exports["./frame-contract"]
// 指向构建产物 dist/frame-contract/index.{d.ts,js}；开源树的实现扁平化在包根
// frame-contract.d.ts，这里转发到同一份类型声明，避免移动上游文件。
export * from "../../frame-contract.d.ts";
