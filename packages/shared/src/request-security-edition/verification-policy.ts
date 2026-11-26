export type RequestVerificationConfig = Readonly<{
  enabled?: boolean;
  skipModelRequest?: boolean;
  region?: string;
  prefix?: string;
  sceneId?: string;
}>;
export type RequestVerificationProof = Record<string, unknown>;
export type RequestVerificationClientConfig = Record<string, unknown>;
export const requestVerificationReasons = ["model-request", "captcha-retry"] as const;
export type RequestVerificationReason = (typeof requestVerificationReasons)[number];
export const requestVerificationTimeoutMessage =
  "Captcha verification request timed out. Please send your message again.";
export const REQUEST_VERIFICATION_REQUIRED = "coding_plan_security_verification_required";

/** 验证请求头白名单（与发行版 aN 一致）。 */
const REQUEST_VERIFICATION_HEADERS = [
  "X-Aliyun-Captcha-Verify-Param",
  "X-Aliyun-Captcha-Verify-Region",
] as const;

/** 读取原始 captcha 配置；skip_model_request → skipModelRequest 归一化（发行版 iN）。 */
export function readRequestVerificationConfig(
  configs: RequestVerificationClientConfig | null | undefined,
): RequestVerificationConfig | null {
  const captcha = (configs as Record<string, unknown> | null | undefined)?.captcha;
  if (!captcha) {
    return null;
  }
  const { skip_model_request: skipModelRequestRaw, ...rest } = captcha as Record<string, unknown>;
  return {
    ...rest,
    ...(typeof skipModelRequestRaw === "boolean" ? { skipModelRequest: skipModelRequestRaw } : {}),
  } as RequestVerificationConfig;
}

/**
 * 读取并校验 captcha 配置（发行版 koe）：
 * enabled / skip_model_request 必为 boolean；启用时 region / prefix / sceneId 三字符串必填。
 */
export function readValidatedRequestVerificationConfig(
  configs: RequestVerificationClientConfig | null | undefined,
): RequestVerificationConfig | null {
  const captcha = (configs as Record<string, unknown> | null | undefined)?.captcha;
  const config = readRequestVerificationConfig(configs);
  if (
    !captcha ||
    typeof captcha !== "object" ||
    Array.isArray(captcha) ||
    ((captcha as Record<string, unknown>).enabled !== undefined &&
      typeof (captcha as Record<string, unknown>).enabled !== "boolean") ||
    ((captcha as Record<string, unknown>).skip_model_request !== undefined &&
      typeof (captcha as Record<string, unknown>).skip_model_request !== "boolean") ||
    (config?.enabled !== false &&
      config?.skipModelRequest !== true &&
      ![config?.region, config?.prefix, config?.sceneId].every(
        (value) => typeof value === "string" && value.trim(),
      ))
  ) {
    throw new Error("Request verification configuration is invalid");
  }
  return config;
}

/** 产出验证请求头（发行版 _oe）。 */
export function requestVerificationClaimHeaders(
  proof: RequestVerificationProof,
): Record<string, string> {
  return {
    "X-Aliyun-Captcha-Verify-Param": proof.captchaVerifyParam as string,
    ...(proof.captchaRegion
      ? { "X-Aliyun-Captcha-Verify-Region": proof.captchaRegion as string }
      : {}),
  };
}

/** 摘除验证请求头（发行版 Gdn / aN 白名单过滤）。 */
export function withoutRequestVerificationHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([key]) =>
        !REQUEST_VERIFICATION_HEADERS.some((name) => name.toLowerCase() === key.toLowerCase()),
    ),
  );
}

/** 验证头白名单过滤：大小写不敏感、trim、非空才保留（发行版 Coe）。 */
export function allowRequestVerificationHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const matched = REQUEST_VERIFICATION_HEADERS.find(
      (name) => name.toLowerCase() === key.trim().toLowerCase(),
    );
    if (matched && value.trim()) {
      result[matched] = value.trim();
    }
  }
  return result;
}

/** 触发判定：start-plan 且配置启用且未跳过 model request（发行版 Roe）。 */
export function requiresRequestVerification(
  access: { mode: string } | undefined,
  config?: RequestVerificationConfig | null,
): boolean {
  return (
    access?.mode === "start-plan" && config?.enabled !== false && config?.skipModelRequest !== true
  );
}

/** 3007 验证消息识别：中文文案或 /security verification/i（发行版 Ioe）。 */
export function isRequestVerificationMessage(message: string): boolean {
  return message.includes("请完成安全验证") || /security verification/i.test(message);
}

export function summarizeRequestVerificationHeaders(
  headers: Record<string, string>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (REQUEST_VERIFICATION_HEADERS.some((name) => name.toLowerCase() === key.toLowerCase())) {
      summary[key] = typeof value === "string" && value.length > 0 ? value.length : 0;
    }
  }
  return summary;
}

export function requestVerificationDiagnostics(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    hasCaptchaVerifyParam: input.hasCaptchaVerifyParam === true,
    captchaParamLength: input.captchaParamLength ?? 0,
  };
}

export const requestVerificationInteractionAvailable = true;
