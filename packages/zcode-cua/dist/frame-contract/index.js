// 官方最终栅格帧契约的公开子路径入口（zcode-cua 0.6.6 / check-version-coherence.mjs 契约）。
//
// 官方 producer 的源码布局是 src/frame-contract/ → 构建产物 dist/frame-contract/index.*，
// 且 package.json 的 exports["./frame-contract"] 恰好指向这两个构建产物。开源导出把
// 这一层目录结构扁平化成了包根的 frame-contract.js / frame-contract.d.ts，于是官方
// 的版本一致性校验（assertFinalRasterFrameContract）判定"producer 缺少最终栅格契约"。
//
// 这里不移动上游文件（11 处 @zcode/zcode-cua/frame-contract 消费方与 index.js 的相对
// 导入都依赖包根那份），只在官方契约要求的路径上提供同构入口，两条路径指向同一实现。
export * from "../../frame-contract.js";
