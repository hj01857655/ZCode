// Broker 协议面对外入口：协议常量、错误分类、管道命名、请求/响应编解码全部转发
// vendor/official-runtime.js（ZCode 4.0.0 发行包内 `@zcode/zcode-cua` 的编译产物）。
// 本文件只补发行包未导出的两个薄封装（单次 RPC / 健康探测）与本仓消费方仍在引用的
// 历史名，不再维护平行实现。
export { HELPER_GHOST_CURSOR_OVERLAY_ARG } from "./broker-helper-constants.js";
export {
  BROKER_SOCKET_ENV,
  BrokerError,
  CuaHelperError,
  notAuthorized,
  notSelectable,
  notSettable,
  elementUnavailable,
  actionUnavailable,
  foregroundRequired,
  parseRequestLine,
  okResponse,
  errorResponse,
  errorResponseFromException,
  serializeResponse,
  dispatchRequest,
  isBrokerMethod,
  isReadOnlyBrokerMethod,
  mintBrokerSocketPath,
  resolveBrokerSocketPath,
} from "./vendor/official-runtime.js";

import {
  CuaHelperError,
  PermissionBrokerClient,
  dispatchRequest as officialDispatchRequest,
  parseRequestLine as officialParseRequestLine,
  serializeResponse as officialSerializeResponse,
} from "./vendor/official-runtime.js";

// CLI 与 bootstrap 仍以这个键告知子进程「本机没有可用 broker」；官方发行包没有
// 对应常量，值必须与 packages/shared/runtimeEnv.ts 保持一致。
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

// 官方 PermissionBrokerClient 要求显式正数超时；这里给与 Helper 服务端
// DEFAULT_REQUEST_TIMEOUT_MS 一致的默认值，调用方仍可逐次覆盖。
const DEFAULT_RPC_TIMEOUT_MS = 15_000;

/**
 * 单次 broker RPC。握手（authenticate 首帧）与错误分类由官方 PermissionBrokerClient
 * 负责：抛出的 PermissionBrokerError.code 保留 Helper 的原始错误码。
 */
export async function callBrokerMethod(args) {
  const client = new PermissionBrokerClient(args.socketPath, {
    timeoutMs: args.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
  });
  return await client.call(args.method, args.params ?? {});
}

/**
 * Host 在 spawn 后立刻探测，Helper 可能还在 bind 管道；按 poll 重试而不是一次失败就判死。
 * 每次探测新建客户端：官方客户端把「已经发送过」的请求状态记录在实例上，复用会污染
 * 后续失败分类。
 */
export async function probeHelperHealth(socketPath, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 3_000);
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const perTryTimeoutMs = options.perTryTimeoutMs ?? 1_000;
  let lastError;
  for (;;) {
    try {
      const info = await callBrokerMethod({
        socketPath,
        method: "broker_info",
        timeoutMs: perTryTimeoutMs,
      });
      return {
        bundleId: typeof info?.bundle_id === "string" ? info.bundle_id : null,
        pid: Number.isInteger(info?.pid) ? info.pid : null,
      };
    } catch (error) {
      lastError = error;
    }
    if (Date.now() + pollIntervalMs >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw lastError instanceof Error
    ? lastError
    : new CuaHelperError("helper_unavailable", "Computer Use Helper health probe failed");
}

/**
 * 官方 brokerServer 自己按行取请求；发行包未把「读一行 → 分派 → 序列化」导成函数，
 * 这里用它的三个原语拼出本仓历史上暴露的 handleRequestLine。
 */
export async function handleRequestLine(backend, line) {
  const parsed = officialParseRequestLine(line);
  if (!parsed.ok) {
    return officialSerializeResponse({
      id: parsed.id,
      ok: false,
      error: { code: parsed.code, message: parsed.message },
    });
  }
  const response = await officialDispatchRequest(backend, parsed.request);
  return officialSerializeResponse(response);
}