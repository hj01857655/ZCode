export function isCuaPermissionStatusAvailable(result) {
  return Boolean(result) && typeof result === "object" && result.available === true;
}

/**
 * 截图功能探针会真实抓屏，只有用户显式发起（`includeFunctionalProbes`）且
 * Screen Recording 已授权时才允许执行；后台只读刷新必须保持不抓屏。
 * 与 UI 侧展示口径一致：展示态不看该探针结果。
 */
export function shouldRunCuaScreenCaptureProbe(state, options) {
  return options?.includeFunctionalProbes === true && state === "granted";
}