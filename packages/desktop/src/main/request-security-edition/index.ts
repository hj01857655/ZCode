import type { WebRequest } from "electron";

/** 验证码相关网络 filter（发行版 Su）。 */
const CAPTCHA_URL_FILTER = {
  urls: ["https://*.alicdn.com/*", "https://*.aliyuncs.com/*"],
} as const;

/** URL 分类（发行版 sS）：device_api / init_api / sdk_log / image / sdk_script。 */
function classifyCaptchaUrl(url: string): { kind: string; host: string; path: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const hostname = parsed.hostname;
  if (CAPTCHA_HOSTS.has(hostname)) {
    return { kind: "device_api", host: hostname, path: "/" };
  }
  if (/^(?:[a-z0-9-]+\.)?captcha-(?:pro-)?open(?:-[a-z0-9-]+)?\.aliyuncs\.com$/.test(hostname)) {
    return {
      kind: hostname.startsWith("upload.") ? "sdk_log" : "init_api",
      host: hostname.replace(/^[^.]+\.(?=captcha-)/, "[prefix]."),
      path: "/",
    };
  }
  if (/^static-captcha(?:-[a-z0-9-]+)?\.aliyuncs\.com$/.test(hostname)) {
    return { kind: "image", host: hostname, path: "/[image]" };
  }
  if (
    ["o.alicdn.com", "g.alicdn.com", "x.alicdn.com"].includes(hostname) &&
    parsed.pathname.startsWith("/captcha-frontend/")
  ) {
    const kind = parsed.pathname.endsWith("/AliyunCaptcha.js") ? "sdk_script" : "sdk_script";
    return { kind, host: hostname, path: parsed.pathname };
  }
  return;
}

const CAPTCHA_HOSTS = new Set(["api.chatglm.site", "zcode.chatglm.site"]);

/**
 * 桌面端安全诊断注入（发行版 Cu = installCaptchaNetworkDiagnostics）：
 * 监听验证码相关网络请求（start/completed/failed），写入 [captcha-network] 诊断日志。
 */
export function installRequestSecurityDiagnostics(
  request: WebRequest,
  logger: { info(tag: string, fields: Record<string, unknown>): void },
): void {
  const startedAt = new Map<string, number>();
  const prune = (now: number): void => {
    for (const [id, ts] of startedAt) {
      if (now - ts > 300_000) {
        startedAt.delete(id);
      }
    }
    if (startedAt.size >= 128) {
      startedAt.delete(startedAt.keys().next().value!);
    }
  };
  const onStart = (details: { id: string; url: string; webContentsId?: number }): void => {
    const info = classifyCaptchaUrl(details.url);
    if (!info) {
      return;
    }
    const now = Date.now();
    prune(now);
    startedAt.set(details.id, now);
    logger.info("[captcha-network]", {
      event: "resource.start",
      networkRequestId: details.id,
      webContentsId: details.webContentsId,
      ...info,
    });
  };
  const onFinish = (details: {
    id: string;
    url: string;
    webContentsId?: number;
    error?: string;
    statusCode?: number;
  }): void => {
    const start = startedAt.get(details.id);
    startedAt.delete(details.id);
    const info = classifyCaptchaUrl(details.url);
    if (!info) {
      return;
    }
    const now = Date.now();
    prune(now);
    logger.info("[captcha-network]", {
      event: details.error ? "resource.failed" : "resource.completed",
      networkRequestId: details.id,
      webContentsId: details.webContentsId,
      ...info,
      elapsedMs: start === undefined ? null : now - start,
      statusCode: details.statusCode ?? null,
      errorCode: details.error && /^net::ERR_[A-Z_]+$/.test(details.error) ? details.error : null,
    });
  };
  request.onCompleted(CAPTCHA_URL_FILTER as never, onFinish as never);
  request.onErrorOccurred(CAPTCHA_URL_FILTER as never, onFinish as never);
  // Electron WebRequest 没有 onBeforeSend，请求发出前的事件是 onBeforeRequest。
  // 这里用 cast 绕过类型检查会变成运行时 TypeError（实测 dev 启动直接 unhandledRejection）。
  request.onBeforeRequest(CAPTCHA_URL_FILTER as never, onStart as never);
}

/** 开发版：不做日志包装/脱敏，原样透传。 */
export function decorateRequestSecurityLogArgs(args: unknown[], _webContentsId: number): unknown[] {
  return args;
}
