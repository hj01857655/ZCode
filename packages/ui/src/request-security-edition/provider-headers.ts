import type { IServiceAccessor } from "@zcode/services";
import type {
  ZCodeAgentProviderRuntimeHeadersRequest,
  ZCodeAgentWorkspaceTarget,
} from "@zcode/services";
import type { ZCodeProviderRuntimeHeadersCancelled } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  readCachedRequestVerificationConfig,
  verifyRequestCaptcha,
  type RequestVerificationAttemptContext,
} from "./claim.js";

// 验证配置无效时对模型请求方的统一文案（发行版 BBt），不向界面泄露配置细节。
const CAPTCHA_FAILED_MESSAGE = "Captcha verification failed. Please try again.";

type PendingRequest = {
  promise: Promise<void>;
  controller: AbortController;
};

// 合并 key 与发行版 iVt 一致：workspace 身份（identity 优先）:: sessionId :: requestId。
// 同一请求可能同时经 session 级与 workspace 级入口投递，重复进入时只等待已有应答。
const pendingByKey = new Map<string, PendingRequest>();

function requestKey(request: {
  workspace: { workspacePath: string; workspaceIdentity?: string };
  sessionId: string;
  requestId: string;
}): string {
  return [
    request.workspace.workspaceIdentity?.trim() || request.workspace.workspacePath,
    request.sessionId,
    request.requestId,
  ].join("::");
}

/** 验证错误分类（发行版 Jzt），只用于诊断事件，不改变应答语义。 */
function classifyCaptchaError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Captcha instance timed out after ")) return "instance_timeout";
  if (message.startsWith("Captcha initialization timed out.")) return "initialization_timeout";
  if (message === "Failed to load captcha script.") return "script_load_failed";
  if (message.startsWith("Captcha verification timed out after ")) return "verification_timeout";
  if (message.startsWith("Traceless captcha timed out after ")) return "traceless_timeout";
  return "unknown";
}

type AccessLike = { type?: string | null; mode?: string | null };

function isStartPlanAccess(access: AccessLike | undefined): boolean {
  return access?.type === "zhipu-account" && access.mode === "start-plan";
}

/**
 * 请求未携带 accountAccess 时回落到当前 Provider 设置视图（发行版 aVt）。
 * Host 正常会绑定 access；回落只覆盖旧 Host / 测试 double 未注入的场景。
 */
async function readRequestAccess(
  services: IServiceAccessor,
  request: ZCodeAgentProviderRuntimeHeadersRequest,
): Promise<AccessLike | undefined> {
  if (request.accountAccess) return request.accountAccess;
  try {
    const view = await services.providerSettingsService.getView();
    const provider = view.providers.find((entry) => entry.providerId === request.providerId);
    return provider?.effectiveConfig.access ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 应答一次 provider runtime headers 请求（发行版 oVt）：
 * 只有 start-plan 且验证配置启用时执行验证码；`enabled:false` / `skipModelRequest`
 * 直接回空 headers（headersApplied=true），其余错误回 headersApplied=false + 原文。
 * 取消时不应答，由 Host 侧清理 pending。
 */
async function respondToProviderRuntimeHeaders(params: {
  services: IServiceAccessor;
  request: ZCodeAgentProviderRuntimeHeadersRequest;
  signal: AbortSignal;
}): Promise<void> {
  const { services, request, signal } = params;
  const context: RequestVerificationAttemptContext = {
    source: request.reason === "captcha-retry" ? "captcha_retry" : "send_preflight",
    providerId: request.providerId,
    requestId: request.requestId,
  };
  logger.lifecycle.info("[captcha-diagnostics]", {
    event: "request.received",
    requestId: request.requestId,
    providerId: request.providerId,
    source: request.reason,
  });
  let runtimeProviderHeaders: Record<string, string> | undefined;
  let errorMessage: string | undefined;
  let errorKind: string | undefined;
  try {
    const access = await readRequestAccess(services, request);
    signal.throwIfAborted();
    if (isStartPlanAccess(access)) {
      const config =
        request.requestVerificationConfig ??
        (await readCachedRequestVerificationConfig(services.codingPlanSubscriptionService));
      signal.throwIfAborted();
      if (config?.enabled === false || config?.skipModelRequest === true) {
        runtimeProviderHeaders = {};
      } else if (!config) {
        throw new Error(CAPTCHA_FAILED_MESSAGE);
      } else if (!config.region?.trim() || !config.prefix?.trim() || !config.sceneId?.trim()) {
        throw new Error(CAPTCHA_FAILED_MESSAGE);
      } else {
        const captchaVerifyParam = await verifyRequestCaptcha(config, context, signal);
        signal.throwIfAborted();
        runtimeProviderHeaders = {
          "X-Aliyun-Captcha-Verify-Param": captchaVerifyParam,
          ...(config.region?.trim()
            ? { "X-Aliyun-Captcha-Verify-Region": config.region.trim() }
            : {}),
        };
      }
    } else {
      // 非 start-plan：不需要验证，但必须应答，否则该请求会一直等待界面。
      runtimeProviderHeaders = {};
    }
  } catch (error) {
    if (signal.aborted) {
      logger.lifecycle.info("[captcha-diagnostics]", {
        event: "request.cancelled",
        requestId: request.requestId,
        providerId: request.providerId,
      });
      return;
    }
    errorKind = classifyCaptchaError(error);
    errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn("[captcha] provider runtime headers refresh failed", {
      providerId: request.providerId,
      requestId: request.requestId,
      errorKind,
      error: errorMessage,
    });
  }
  if (signal.aborted) return;
  logger.lifecycle.info("[captcha-diagnostics]", {
    event: "request.respond",
    requestId: request.requestId,
    headersApplied: Boolean(runtimeProviderHeaders),
    errorKind: errorKind ?? null,
  });
  await services.zcodeSessionService.respondProviderRuntimeHeaders({
    workspacePath: request.workspace.workspacePath,
    ...(request.workspace.workspaceIdentity
      ? { workspaceIdentity: request.workspace.workspaceIdentity }
      : {}),
    ...(request.workspace.remoteSessionId
      ? { remoteSessionId: request.workspace.remoteSessionId }
      : {}),
    sessionId: request.sessionId,
    requestId: request.requestId,
    response: runtimeProviderHeaders
      ? { headersApplied: true, runtimeProviderHeaders }
      : {
          headersApplied: false,
          ...(errorMessage ? { errorMessage } : {}),
        },
  });
}

/**
 * 常驻订阅一个 workspace 的模型请求验证事件（发行版 D6n）：
 * 返回的 dispose 会撤销订阅并 abort 本 workspace 所有在途验证。
 * 必须在 rpcReady 之后调用：远程 workspace 断连期订阅会拿到断连代理并产生无效 RPC。
 */
export function subscribeProviderRuntimeHeaders(params: {
  services: IServiceAccessor;
  workspace: ZCodeAgentWorkspaceTarget;
}): () => void {
  const { services, workspace } = params;
  const ownedKeys = new Set<string>();

  const start = (request: ZCodeAgentProviderRuntimeHeadersRequest): void => {
    const key = requestKey(request);
    const existing = pendingByKey.get(key);
    if (existing) {
      logger.info("[captcha] provider runtime headers request coalesced", {
        providerId: request.providerId,
        requestId: request.requestId,
        sessionId: request.sessionId,
      });
      void existing.promise.catch((error: unknown) => {
        logger.warn("[captcha] provider runtime headers coalesced response failed", {
          error: error instanceof Error ? error.message : String(error),
          requestId: request.requestId,
        });
      });
      return;
    }
    const controller = new AbortController();
    const promise = respondToProviderRuntimeHeaders({
      services,
      request,
      signal: controller.signal,
    })
      .catch((error: unknown) => {
        logger.warn("[captcha] provider runtime headers response failed", {
          error: error instanceof Error ? error.message : String(error),
          providerId: request.providerId,
          requestId: request.requestId,
        });
      })
      .finally(() => {
        pendingByKey.delete(key);
        ownedKeys.delete(key);
      });
    pendingByKey.set(key, { promise, controller });
    ownedKeys.add(key);
  };

  const cancel = (cancelled: ZCodeProviderRuntimeHeadersCancelled): void => {
    const entry = pendingByKey.get(requestKey(cancelled));
    if (!entry || entry.controller.signal.aborted) return;
    logger.info("[captcha] provider runtime headers request cancelled", {
      requestId: cancelled.requestId,
      sessionId: cancelled.sessionId,
    });
    entry.controller.abort(new Error("Provider runtime headers request cancelled."));
  };

  const agent = services.zcodeAgentService;
  const requestSubscription = agent.onDynamicWorkspaceProviderRuntimeHeadersRequest(workspace)(
    start,
  );
  const cancelSubscription =
    agent.onDynamicWorkspaceProviderRuntimeHeadersCancelled(workspace)(cancel);
  return () => {
    requestSubscription.dispose();
    cancelSubscription.dispose();
    for (const key of ownedKeys) {
      pendingByKey
        .get(key)
        ?.controller.abort(new Error("Provider runtime headers subscriber disposed."));
    }
    ownedKeys.clear();
  };
}