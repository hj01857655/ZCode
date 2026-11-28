import { useEffect } from "react";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
import type { RequestVerificationConfig, RequestVerificationProof } from "@zcode/shared";
import { logger } from "@/logger.js";
import { CAPTCHA_LOGO_DATA_URI } from "./captcha-logo.js";

const SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const SDK_LOAD_TIMEOUT_MS = 10_000;
// 4.0.0 发行版：实例就绪等待 10s（rV），交互验证总超时 120s（$zt）。
const INSTANCE_TIMEOUT_MS = 10_000;
const VERIFICATION_TIMEOUT_MS = 120_000;
// 实例复用窗口 12 分钟（发行版 12e5）：超时后重建，避免长期持有过期实例。
const CONTROLLER_TTL_MS = 12 * 60 * 1_000;
// 脚本落地后补足 2s 再触发（发行版 Qzt/SBt），给 SDK 内部初始化留出时间。
const TRIGGER_DELAY_MS = 2_000;
// 服务端验证配置缓存 60s（发行版 qBt）：多入口同时触发时只发一次配置请求。
const CONFIG_CACHE_TTL_MS = 60_000;
// 初始化 drain 上限（发行版 yBt/dV）：上一次 init 返回的 thenable 未完成时，重建前最多等 10s。
const INIT_DRAIN_TIMEOUT_MS = 10_000;

// 宿主 DOM 由 RequestSecurityHost 常驻挂载，与发行版 uBt/sV/cV 同 id。
const CAPTCHA_ELEMENT_ID = "zcode-aliyun-captcha-element";
const CAPTCHA_BUTTON_ID = "zcode-aliyun-captcha-button";

const CONFIG_INVALID_MESSAGE = "Request verification configuration is invalid";
const CAPTCHA_FAILED_MESSAGE = "Captcha verification failed. Please try again.";

// 与发行版 ZBt/XBt 同源：界面语言偏好优先于 navigator。
const LOCALE_PREFERENCE_KEY = "zcode-locale-preference";

type AliyunCaptchaInstance = {
  startTracelessVerification?: () => void;
  show?: () => void;
};

type AliyunCaptchaWindow = Window & {
  initAliyunCaptcha?: (options: Record<string, unknown>) => void;
  AliyunCaptchaConfig?: { region?: string; prefix?: string };
};

type Attempt = {
  resolve: (param: string) => void;
  reject: (error: Error) => void;
};

type ControllerEntry = {
  configKey: string;
  initStartedAt: number;
  /** 实例由 getInstance 回调兑现；初始化失败时 reject。 */
  instance: Promise<AliyunCaptchaInstance>;
};

type AttemptDiagnostics = {
  id: string;
  source: string;
  startedAt: number;
  requestId?: string;
  providerId?: string;
};

export type RequestVerificationAttemptContext = {
  source?: string;
  requestId?: string;
  providerId?: string;
};

// SDK 实例按配置缓存：重复 init 会让 SDK 在同 id 宿主上叠加实例。
let controllerEntry: ControllerEntry | null = null;
// 上一次 init 尚未返回时，下一次重建必须等它落地（发行版 dV/yBt）。
let initializationDrain: Promise<void> | null = null;
// 脚本加载完成时刻；发行版用 fBt 控制触发前至少等待 2s。
let sdkLoadedAt = 0;
// 脚本加载 promise 复用（发行版 lV）：并发调用只挂一次 script。
let sdkLoadPromise: Promise<void> | null = null;
// 当前验证 attempt。SDK 回调是全局的，必须按事件发生时读取，而不是 init 时闭包捕获。
let pendingAttempt: Attempt | null = null;
// 全局串行队列（发行版 QBt）：验证码是窗口级单例，自动领取与模型请求必须排队而不是互斥失败。
let verificationQueue: Promise<unknown> = Promise.resolve();
// certifyId 复用检测（发行版 HBt + nVt）：同一 scene 连续复用可能触发 F008 重复提交。
const lastCertifyIdByScene = new Map<string, string>();

// 配置读取缓存与 in-flight 去重（发行版 qBt）。
let configCache: { value: RequestVerificationConfig | null; expiresAt: number } | null = null;
let configRequest: Promise<RequestVerificationConfig | null> | null = null;

/**
 * 领奖前预热（发行版 tVt/CBt）：
 * 配置启用且字段完整时完成脚本加载与 SDK 初始化，不触发无痕验证；
 * 初始化失败不影响正式领取，正式领取会重新走 ensureController。
 */
export function useRequestVerificationPrewarm(
  visible: boolean,
  service?: Pick<ICodingPlanSubscriptionService, "getRequestVerificationConfig">,
): void {
  useEffect(() => {
    if (!visible || typeof window === "undefined") {
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const diagnostics = startDiagnostics("prewarm");
      try {
        const config = await readCachedRequestVerificationConfig(service);
        if (signal.aborted || !isUsableConfig(config)) {
          endDiagnostics(diagnostics, "skipped");
          return;
        }
        // 已有验证在跑时不能再重建实例，否则会把进行中的弹窗宿主清掉（发行版 bBt 的 prewarmOnly 分支）。
        if (pendingAttempt) {
          endDiagnostics(diagnostics, "skipped");
          return;
        }
        await ensureAliyunCaptchaSdk(signal);
        await ensureController(config, diagnostics, signal);
        endDiagnostics(diagnostics, "init_dispatched");
      } catch (error) {
        endDiagnostics(diagnostics, signal.aborted ? "cancelled" : "error", error);
        // 预热失败只影响首次点击的等待时间，领取时仍会重试。
      }
    })();
    return () => controller.abort();
  }, [visible, service]);
}

/**
 * 申领验证 proof（4.0.0 发行版语义）：
 * start-plan 场景下先完成阿里云验证码（无痕优先、命中风控再交互），
 * 拿到 captchaVerifyParam 后连同 region 返回；由 claimManualPlan 展开成验证头。
 */
export async function prepareRequestVerificationClaim(
  service: ICodingPlanSubscriptionService,
  signal: AbortSignal,
  onVerifying: () => void,
): Promise<RequestVerificationProof | undefined> {
  signal.throwIfAborted();
  onVerifying();
  const config = await awaitAbortable(readCachedRequestVerificationConfig(service), signal);
  if (!config || config.enabled === false) {
    return {};
  }
  if (!isUsableConfig(config)) {
    throw new Error(CONFIG_INVALID_MESSAGE);
  }
  const captchaVerifyParam = await verifyRequestCaptcha(
    config,
    { source: "manual_plan_claim" },
    signal,
  );
  trackCertifyId(config.sceneId!.trim(), captchaVerifyParam);
  // 发行版 DBt：有 region 时同时带 X-Aliyun-Captcha-Verify-Region。
  return { captchaVerifyParam, captchaRegion: config.region };
}

/**
 * 模型请求（`model-request` / `captcha-retry`）的验证入口。
 * 与领取共用同一个窗口级实例与全局队列；取消由 AbortSignal 收口。
 */
export async function verifyRequestCaptcha(
  config: RequestVerificationConfig,
  context: RequestVerificationAttemptContext = {},
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!isUsableConfig(config)) {
    throw new Error(CONFIG_INVALID_MESSAGE);
  }
  const diagnostics = startDiagnostics(context.source ?? "send_preflight", context);
  try {
    const param = await withVerificationQueue(signal, async () => {
      await ensureAliyunCaptchaSdk(signal);
      diagnosticsStage(diagnostics, "script_load");
      const entry = await ensureController(config, diagnostics, signal);
      diagnosticsStage(diagnostics, "trigger_delay");
      await waitForTriggerDelay(signal);
      signal?.throwIfAborted();
      return runAttempt(entry, diagnostics, signal);
    });
    endDiagnostics(diagnostics, "success");
    return param;
  } catch (error) {
    endDiagnostics(diagnostics, signal?.aborted ? "cancelled" : "error", error);
    throw error;
  }
}

/**
 * 读取验证配置：60s 缓存 + in-flight 去重，读取失败不写缓存（发行版 qBt）。
 * 领取、预热、模型请求三条路径共用，避免同一时刻重复请求服务端配置。
 */
export function readCachedRequestVerificationConfig(
  service?: Pick<ICodingPlanSubscriptionService, "getRequestVerificationConfig">,
): Promise<RequestVerificationConfig | null> {
  // 没有服务实例时不能写入 null 缓存：会把后续真正可用的读取挡在 60s 窗口外。
  if (!service) {
    return Promise.resolve(null);
  }
  if (configCache && configCache.expiresAt > Date.now()) {
    return Promise.resolve(configCache.value);
  }
  if (configRequest) {
    return configRequest;
  }
  configRequest = (async () => {
    try {
      const value = (await service?.getRequestVerificationConfig()) ?? null;
      configCache = { value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
      return value;
    } catch {
      return null;
    }
  })().finally(() => {
    configRequest = null;
  });
  return configRequest;
}

/** 配置可用性（发行版 JBt）：enabled=false 或三要素缺失都视为不可用。 */
function isUsableConfig(
  config: RequestVerificationConfig | null | undefined,
): config is RequestVerificationConfig {
  if (!config || config.enabled === false) return false;
  return Boolean(config.region?.trim() && config.prefix?.trim() && config.sceneId?.trim());
}

function getInitAliyunCaptcha(): ((options: Record<string, unknown>) => void) | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as AliyunCaptchaWindow).initAliyunCaptcha;
}

/**
 * 等待阿里云验证码 SDK 就绪。
 * 预热与直接领取都可能先到：已就绪直接返回；否则复用/新建 script 并等 load/error。
 * 加载失败必须移除 script 节点（发行版 _Bt）：否则下次 querySelector 会命中同一个失败节点，
 * 新挂的 load/error 永不触发，只能等超时。
 */
function ensureAliyunCaptchaSdk(signal?: AbortSignal): Promise<void> {
  if (getInitAliyunCaptcha()) {
    return Promise.resolve();
  }
  if (!sdkLoadPromise) {
    sdkLoadPromise = loadAliyunCaptchaSdk().catch((error) => {
      sdkLoadPromise = null;
      throw error;
    });
  }
  return awaitAbortable(sdkLoadPromise, signal);
}

function loadAliyunCaptchaSdk(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      reject(new Error("Captcha requires browser environment."));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void) => {
      if (timer !== undefined) clearTimeout(timer);
      action();
    };
    const failed = (script: HTMLScriptElement | null) =>
      finish(() => {
        script?.remove();
        reject(new Error("Failed to load captcha script."));
      });
    const loaded = () =>
      finish(() => {
        sdkLoadedAt = Date.now();
        resolve();
      });
    let script = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    const created = !script;
    if (!script) {
      script = document.createElement("script");
      script.src = SDK_URL;
      script.async = true;
    }
    timer = setTimeout(() => failed(script), SDK_LOAD_TIMEOUT_MS);
    // 事件按 once 绑定；脚本节点失败后会被移除，监听随之失效，不需要手动解绑。
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", () => failed(script), { once: true });
    if (created) document.head.appendChild(script);
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}

function toError(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string" && value.trim()) return new Error(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["Message", "message", "errorMessage", "ErrorMessage", "msg"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) return new Error(candidate);
    }
  }
  return new Error(fallbackMessage);
}

function readLocalePreference(): string | null {
  try {
    if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") {
      return null;
    }
    const value = localStorage.getItem(LOCALE_PREFERENCE_KEY);
    return value?.trim() || null;
  } catch {
    return null;
  }
}

/** 语言判定（发行版 XBt）：zh-CN → cn；其它非 system 偏好 → en；否则看 navigator。 */
function captchaLanguage(): "cn" | "en" {
  const preference = readLocalePreference();
  if (preference === "zh-CN") return "cn";
  if (preference && preference !== "system") return "en";
  const language = typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
  return language.startsWith("zh") ? "cn" : "en";
}

/** 从 fail 载荷里读发行版 aV 关注的字段。 */
function readFailInfo(payload: unknown): {
  verifyCode?: string;
  success?: boolean;
  verifyResult?: boolean;
} {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  const verifyCode =
    typeof record.verifyCode === "string"
      ? record.verifyCode
      : typeof record.VerifyCode === "string"
        ? record.VerifyCode
        : undefined;
  return {
    verifyCode,
    success: typeof record.success === "boolean" ? record.success : undefined,
    verifyResult: typeof record.verifyResult === "boolean" ? record.verifyResult : undefined,
  };
}

/** fail 载荷偶尔直接携带终态参数（发行版 rBt）。 */
function readVerifyParam(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const value =
    typeof record.captchaVerifyParam === "string"
      ? record.captchaVerifyParam
      : typeof record.CaptchaVerifyParam === "string"
        ? record.CaptchaVerifyParam
        : undefined;
  return value?.trim() || undefined;
}

type FailInfo = ReturnType<typeof readFailInfo>;

/** 终态通过（发行版 iBt）。 */
function isTerminalPass(info: FailInfo): boolean {
  return (info.success === true && info.verifyResult === true) || info.verifyCode === "T006";
}

/** 无痕未过、等待 SDK 升级交互（发行版 aBt）。 */
function isAwaitingUpgrade(info: FailInfo): boolean {
  return (
    info.success === true &&
    info.verifyResult === false &&
    (!info.verifyCode || info.verifyCode === "F015")
  );
}

/**
 * 从验证参数里解析 certifyId 并检测复用（发行版 nBt/nVt）：
 * 同一 scene 连续拿到相同 certifyId，服务端可能按 F008 重复提交拒绝。
 * 这里只告警，不阻断领取——是否重复由服务端最终判定。
 */
function trackCertifyId(sceneId: string, param: string): void {
  const trimmed = param.trim();
  if (!trimmed.startsWith("{")) return;
  let certifyId: string | undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>).certifyId;
      if (typeof value === "string" && value.trim()) certifyId = value.trim();
    }
  } catch {
    return;
  }
  if (!certifyId) return;
  const previous = lastCertifyIdByScene.get(sceneId);
  if (previous && previous === certifyId) {
    logger.warn("[request-security] certifyId 与上一轮相同，请求可能触发 F008 重复提交", {
      certifyId,
    });
  }
  lastCertifyIdByScene.set(sceneId, certifyId);
}

/**
 * fail 分流（发行版 vBt）：
 * - success 已结算后的迟到 fail：终态无参数或等待交互都丢弃，不误伤下一轮；
 * - 终态通过（verifyResult=true / T006）且有参数：直接采用，无参数则等 success 补发；
 * - F015 且 verifyResult=false：无痕未通过，SDK 会升级为交互界面，继续等 success；
 * - F008：重复提交，丢弃实例后失败；
 * - 其余：失败，交回 controller 保留投放供手动重试。
 */
function handleCaptchaFail(payload: unknown): void {
  const info = readFailInfo(payload);
  const param = readVerifyParam(payload);
  const attempt = pendingAttempt;
  const summary = {
    verifyCode: info.verifyCode ?? null,
    success: info.success ?? null,
    verifyResult: info.verifyResult ?? null,
  };
  // 没有 attempt 说明上一轮已结算；这类事件属于陈旧回调（发行版 oBt）。
  if (!attempt && (isAwaitingUpgrade(info) || (isTerminalPass(info) && !param))) {
    logCaptchaDebug("sdk.fail.stale_after_success", summary);
    return;
  }
  logCaptchaDebug("sdk.fail", summary);
  if (isTerminalPass(info)) {
    if (param) {
      pendingAttempt = null;
      attempt?.resolve(param);
      return;
    }
    // 终态通过但载荷未带参数：等 success 回调补发，不按失败收口。
    return;
  }
  if (isAwaitingUpgrade(info)) {
    logger.info("[request-security] captcha awaiting interactive verification", summary);
    return;
  }
  if (info.verifyCode === "F008") {
    logCaptchaDebug("sdk.fail.duplicate", summary);
    logger.warn("[request-security] captcha duplicate submission");
    // 重复提交后实例已被服务端判定重复，继续复用只会持续失败（发行版 vBt → hV）。
    pendingAttempt = null;
    resetController();
    attempt?.reject(new Error("Captcha verification data was already submitted."));
    return;
  }
  logger.warn("[request-security] captcha verification failed", summary);
  pendingAttempt = null;
  attempt?.reject(toError(payload, CAPTCHA_FAILED_MESSAGE));
}

/** 丢弃缓存的实例并清空 SDK 在宿主里留下的 DOM（发行版 hV）。 */
function resetController(): void {
  if (controllerEntry) {
    logCaptchaDebug("controller.reset", { configKey: controllerEntry.configKey });
  }
  controllerEntry = null;
  pendingAttempt = null;
  if (typeof document === "undefined") return;
  document.getElementById(CAPTCHA_ELEMENT_ID)?.replaceChildren();
}

function controllerKeyFor(config: RequestVerificationConfig): string {
  return [config.region, config.prefix, config.sceneId, "popup", captchaLanguage()].join("::");
}

function isControllerReusable(key: string): boolean {
  return (
    controllerEntry !== null &&
    controllerEntry.configKey === key &&
    Date.now() - controllerEntry.initStartedAt < CONTROLLER_TTL_MS
  );
}

/** 等上一次 init 返回；超时只告警，不阻塞重建（发行版 yBt）。 */
async function drainInitialization(signal?: AbortSignal): Promise<void> {
  const drain = initializationDrain;
  if (!drain) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.warn("[request-security] captcha initialization drain timed out", {
        timeoutMs: INIT_DRAIN_TIMEOUT_MS,
      });
      resolve();
    }, INIT_DRAIN_TIMEOUT_MS);
  });
  try {
    await awaitAbortable(Promise.race([drain, timeout]), signal);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 初始化（或复用）SDK 实例（发行版 bBt）：
 * 回调是全局的，统一路由到 pendingAttempt，缓存才能跨多次领取复用。
 * 复用窗口 12 分钟；配置（含语言）变化或超时后重建。
 * 所有回调先校验 controller 身份：实例重建后旧实例的迟到 success/fail 不能命中新的 attempt。
 */
async function ensureController(
  config: RequestVerificationConfig,
  diagnostics: AttemptDiagnostics,
  signal?: AbortSignal,
): Promise<ControllerEntry> {
  signal?.throwIfAborted();
  const region = config.region!.trim();
  const prefix = config.prefix!.trim();
  const sceneId = config.sceneId!.trim();
  const key = controllerKeyFor(config);
  if (isControllerReusable(key)) {
    diagnosticsStage(diagnostics, "controller_reuse");
    return controllerEntry!;
  }
  if (controllerEntry) resetController();
  if (initializationDrain) {
    diagnosticsStage(diagnostics, "initialization_drain");
    await drainInitialization(signal);
  }
  if (isControllerReusable(key)) {
    return controllerEntry!;
  }
  (window as AliyunCaptchaWindow).AliyunCaptchaConfig = { region, prefix };
  diagnosticsStage(diagnostics, "script_load");
  await ensureAliyunCaptchaSdk(signal);
  if (initializationDrain) {
    diagnosticsStage(diagnostics, "initialization_drain");
    await drainInitialization(signal);
  }
  if (isControllerReusable(key)) {
    return controllerEntry!;
  }
  const init = getInitAliyunCaptcha();
  if (typeof init !== "function") {
    throw new Error("Captcha SDK is unavailable.");
  }
  const element = document.getElementById(CAPTCHA_ELEMENT_ID);
  const button = document.getElementById(CAPTCHA_BUTTON_ID);
  if (!(element instanceof HTMLElement)) {
    throw new Error("Captcha host element is not mounted.");
  }
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Captcha fallback button is not mounted.");
  }

  let resolveInstance!: (instance: AliyunCaptchaInstance) => void;
  let rejectInstance!: (error: Error) => void;
  const instance = new Promise<AliyunCaptchaInstance>((resolve, reject) => {
    resolveInstance = resolve;
    rejectInstance = reject;
  });
  const entry: ControllerEntry = { configKey: key, initStartedAt: Date.now(), instance };
  controllerEntry = entry;
  const current = () => controllerEntry === entry;

  let resolveDrain!: () => void;
  const drain = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });
  initializationDrain = drain;
  diagnosticsStage(diagnostics, "sdk_init");
  try {
    const result: unknown = init({
      SceneId: sceneId,
      region,
      prefix,
      // 无痕验证只支持弹出式，不能用嵌入式接入。
      mode: "popup",
      language: captchaLanguage(),
      // 发行版默认内置 ZCode logo；配置没有覆盖入口时始终用同一张图。
      captchaLogoImg: CAPTCHA_LOGO_DATA_URI,
      // 错误由业务层统一提示，关掉 SDK 自带气泡。
      showErrorTip: false,
      element: `#${CAPTCHA_ELEMENT_ID}`,
      button: `#${CAPTCHA_BUTTON_ID}`,
      getInstance: (value: unknown) => {
        const accepted = current();
        diagnosticsCallback(diagnostics, "getInstance", accepted);
        if (!accepted || !value || typeof value !== "object") return;
        resolveInstance(value as AliyunCaptchaInstance);
      },
      // 成功参数只在这里返回一次；空参数不是有效凭证，交给 fail/超时路径收口。
      success: (param: unknown) => {
        const accepted = current();
        diagnosticsCallback(diagnostics, "success", accepted);
        if (!accepted) return;
        const value = typeof param === "string" ? param.trim() : "";
        if (!value) return;
        const attempt = pendingAttempt;
        pendingAttempt = null;
        attempt?.resolve(value);
      },
      fail: (payload: unknown) => {
        const accepted = current();
        diagnosticsCallback(diagnostics, "fail", accepted);
        if (accepted) handleCaptchaFail(payload);
      },
      onError: (error: unknown) => {
        const accepted = current();
        diagnosticsCallback(diagnostics, "onError", accepted);
        if (!accepted) return;
        const reason = toError(error, "Captcha initialization failed");
        // 实例就绪前的错误属于初始化失败；之后的错误只影响当前 attempt。
        rejectInstance(reason);
        pendingAttempt?.reject(reason);
      },
    });
    // SDK 的 init 可能返回 thenable；drain 等它落地后再允许重建（发行版 dV）。
    await Promise.resolve(result);
  } catch (error) {
    controllerEntry = null;
    rejectInstance(toError(error, "Captcha initialization failed"));
    throw error;
  } finally {
    resolveDrain();
    if (initializationDrain === drain) initializationDrain = null;
  }
  // 初始化失败（onError）必须重置缓存，否则后续领取永远复用一个 rejected instance。
  instance.catch(() => {
    if (controllerEntry === entry) resetController();
  });
  return entry;
}

function awaitInstance(
  entry: ControllerEntry,
  signal?: AbortSignal,
): Promise<AliyunCaptchaInstance> {
  return new Promise<AliyunCaptchaInstance>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Captcha instance timed out after ${INSTANCE_TIMEOUT_MS}ms.`)),
      INSTANCE_TIMEOUT_MS,
    );
    awaitAbortable(entry.instance, signal).then(
      (instance) => {
        clearTimeout(timer);
        resolve(instance);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 发起一次验证：无痕优先，实例不支持无痕时退回点击隐藏按钮的交互式。
 * 结束（成功/失败/超时/取消）后一律丢弃实例（发行版 wBt 的 finally → hV）：
 * SDK 的挂载状态与这一次 attempt 绑定，复用会让下一轮拿到上一轮残留的弹窗状态。
 */
async function runAttempt(
  entry: ControllerEntry,
  diagnostics: AttemptDiagnostics,
  signal?: AbortSignal,
): Promise<string> {
  if (pendingAttempt) {
    throw new Error("Captcha verification is already in progress.");
  }
  signal?.throwIfAborted();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt!: Attempt;
  const finish = (action: () => void) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (pendingAttempt === attempt) pendingAttempt = null;
    if (controllerEntry === entry) resetController();
    action();
  };
  const onAbort = () => attempt.reject(abortReason(signal!));
  const promise = new Promise<string>((resolve, reject) => {
    attempt = {
      resolve: (param) => finish(() => resolve(param)),
      reject: (error) => finish(() => reject(error)),
    };
  });
  pendingAttempt = attempt;
  signal?.addEventListener("abort", onAbort, { once: true });
  timer = setTimeout(
    () =>
      attempt.reject(
        new Error(`Captcha verification timed out after ${VERIFICATION_TIMEOUT_MS}ms.`),
      ),
    VERIFICATION_TIMEOUT_MS,
  );
  try {
    diagnosticsStage(diagnostics, "instance_wait");
    const instance = await awaitInstance(entry, signal);
    if (settled) return promise;
    if (controllerEntry !== entry) {
      attempt.reject(new Error("Captcha instance was replaced."));
      return promise;
    }
    diagnosticsStage(diagnostics, "verification");
    if (typeof instance.startTracelessVerification === "function") {
      // 无风险时 SDK 直接 success；F015 时 SDK 自行升级为交互界面。
      logger.lifecycle.info("[captcha] aliyun start traceless verification", {
        attemptId: diagnostics.id,
      });
      instance.startTracelessVerification();
      return promise;
    }
    const button = document.getElementById(CAPTCHA_BUTTON_ID);
    if (!(button instanceof HTMLButtonElement)) {
      attempt.reject(new Error("Captcha fallback button is not mounted."));
      return promise;
    }
    logger.lifecycle.info("[captcha] aliyun fallback button click", {
      attemptId: diagnostics.id,
    });
    button.click();
  } catch (error) {
    attempt.reject(toError(error, CAPTCHA_FAILED_MESSAGE));
  }
  return promise;
}

/** 全局串行队列（发行版 QBt/UBt）：队尾 promise 链保证同一时刻只有一个验证。 */
async function withVerificationQueue<T>(
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const previous = verificationQueue;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  verificationQueue = previous.then(() => current);
  try {
    await awaitAbortable(previous, signal);
    signal?.throwIfAborted();
    logCaptchaDebug("verification queue slot acquired");
    return await task();
  } finally {
    release();
  }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function awaitAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return signal ? untilAborted(promise, signal) : promise;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(abortReason(signal!));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 脚本刚落地时补足 2s 再触发（发行版 SBt）：SDK 内部初始化未完成就触发会拿不到实例。 */
async function waitForTriggerDelay(signal?: AbortSignal): Promise<void> {
  if (!sdkLoadedAt) return;
  const remaining = TRIGGER_DELAY_MS - (Date.now() - sdkLoadedAt);
  if (remaining <= 0) return;
  await abortableDelay(remaining, signal);
}

function startDiagnostics(source: string, context: RequestVerificationAttemptContext = {}) {
  const diagnostics: AttemptDiagnostics = {
    id:
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    source,
    startedAt: Date.now(),
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.providerId ? { providerId: context.providerId } : {}),
  };
  logger.lifecycle.info("[captcha-diagnostics]", {
    event: "attempt.start",
    attemptId: diagnostics.id,
    source,
    requestId: diagnostics.requestId ?? null,
    providerId: diagnostics.providerId ?? null,
  });
  return diagnostics;
}

function diagnosticsStage(diagnostics: AttemptDiagnostics, stage: string): void {
  logger.lifecycle.info("[captcha-diagnostics]", {
    event: "attempt.stage",
    attemptId: diagnostics.id,
    stage,
    elapsedMs: Date.now() - diagnostics.startedAt,
  });
}

function diagnosticsCallback(
  diagnostics: AttemptDiagnostics,
  callback: string,
  accepted: boolean,
): void {
  logger.lifecycle.info("[captcha-diagnostics]", {
    event: "sdk.callback",
    attemptId: diagnostics.id,
    callback,
    accepted,
    elapsedMs: Date.now() - diagnostics.startedAt,
  });
}

function endDiagnostics(diagnostics: AttemptDiagnostics, outcome: string, error?: unknown): void {
  const reason = error instanceof Error ? error : undefined;
  logger.lifecycle.info("[captcha-diagnostics]", {
    event: "attempt.end",
    attemptId: diagnostics.id,
    outcome,
    errorName: reason?.name ?? null,
    message: reason?.message ?? null,
    durationMs: Date.now() - diagnostics.startedAt,
  });
}

function logCaptchaDebug(event: string, details: Record<string, unknown> = {}): void {
  logger.debug(`[captcha] ${event}`, details);
}