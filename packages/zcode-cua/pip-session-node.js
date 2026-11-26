// PiP 会话客户端：Host 用 `role:"presentation"` 身份连同一个 broker，把稿件里的事件
// 推给 Helper 的 PiP 协调器。实现对齐发行包内 dist/pip-session/node 的行为：
// 握手协议版本 2、runtimeId 固定、事件先过官方 schema、broker_unavailable 有界重连。
// 握手返回不同协议/运行时时一次性禁用（version_mismatch），避免每帧都重试。
import {
  PermissionBrokerClient,
  PermissionBrokerError,
  pipSessionEventSchema,
} from "./vendor/official-runtime.js";

const PIP_SESSION_PROTOCOL_VERSION = 2;
const PIP_SESSION_RUNTIME_ID = "zcode-cua-pip-session-v2";
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_RECONNECT_ATTEMPTS = 2;
const DEFAULT_RECONNECT_DELAY_MS = 50;

function mismatchError(message) {
  return new PermissionBrokerError(message, { code: "version_mismatch" });
}

export function createPipSessionClient(options = {}) {
  const client = new PermissionBrokerClient(options.socketPath, {
    authenticateParams: { role: "presentation" },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    peerChecker: options.peerChecker,
  });
  const reconnectAttempts = Math.max(0, options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS);
  const reconnectDelayMs = Math.max(0, options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);

  let closed = false;
  let handshaken = false;
  // 致命版本不匹配：保留异常实例，之后每次调用都直接抛出同一原因。
  let fatal = null;
  let queue = Promise.resolve();
  // 诊断回调只报第一件事：客户端随后要么禁用要么继续可用，重复上报没有新信息。
  let diagnosticEmitted = false;

  const emitDiagnostic = (diagnostic) => {
    if (diagnosticEmitted) return;
    diagnosticEmitted = true;
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {}
  };

  const disableForMismatch = (error) => {
    handshaken = false;
    fatal = error;
    emitDiagnostic({ code: "version_mismatch", message: error.message });
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const callWithReconnect = async (method, params) => {
    let lastError;
    for (let attempt = 0; attempt <= reconnectAttempts; attempt += 1) {
      try {
        return await client.call(method, params);
      } catch (error) {
        lastError = error;
        if (error instanceof PermissionBrokerError && error.code === "version_mismatch") {
          disableForMismatch(error);
          throw error;
        }
        if (
          !(error instanceof PermissionBrokerError) ||
          error.code !== "broker_unavailable" ||
          attempt === reconnectAttempts
        ) {
          if (error instanceof PermissionBrokerError && error.code === "broker_unavailable") {
            emitDiagnostic({ code: "transport_unavailable", message: error.message });
          }
          throw error;
        }
        if (reconnectDelayMs > 0) await sleep(reconnectDelayMs);
      }
    }
    throw lastError;
  };

  const connectInner = async () => {
    if (closed) throw new Error("PiP session client is closed");
    if (fatal) throw fatal;
    if (handshaken) return;
    const response = await callWithReconnect("pip_session_handshake", {
      protocolVersion: PIP_SESSION_PROTOCOL_VERSION,
      runtimeId: PIP_SESSION_RUNTIME_ID,
    });
    if (
      response?.ready !== true ||
      response?.protocolVersion !== PIP_SESSION_PROTOCOL_VERSION ||
      response?.runtimeId !== PIP_SESSION_RUNTIME_ID
    ) {
      const error = mismatchError(
        "PiP session handshake returned a different protocol/runtime; Auto-PiP is disabled",
      );
      disableForMismatch(error);
      throw error;
    }
    handshaken = true;
  };

  // 所有调用串行化：官方客户端一条连接一次只等一个响应，并发调用会互相劫持 id 匹配。
  const enqueue = (operation) => {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  return {
    connect: () => enqueue(connectInner),
    send: (event) =>
      enqueue(async () => {
        if (fatal) throw fatal;
        const parsed = pipSessionEventSchema.parse(event);
        await connectInner();
        return await callWithReconnect("pip_session_event", { event: parsed });
      }),
    get enabled() {
      return !closed && fatal === null;
    },
    close() {
      closed = true;
      handshaken = false;
    },
  };
}