export const REQUEST_VERIFICATION_REJECTED_MESSAGE =
  "Captcha verification failed or the verify token was rejected.";

/** 验证码失败文案识别（发行版 ytt）：中英文多种变体。 */
function isCaptchaRejectionText(message: string): boolean {
  if (!message?.trim()) {
    return false;
  }
  const lower = message.toLowerCase();
  return (
    message.includes("Captcha verification failed or the verify token was rejected.") ||
    message.includes("verify token was rejected") ||
    lower.includes("captcha verify failed") ||
    message.includes("验证码校验失败") ||
    lower.includes("captcha verification failed")
  );
}

/** 错误码归一化（发行版 DO）：3007 / CAPTCHA_VERIFY_FAILED / 文案命中 → "3007"。 */
export function resolveRequestVerificationBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "3007" | undefined {
  return code === "3007" ||
    code === "CAPTCHA_VERIFY_FAILED" ||
    isCaptchaRejectionText(message ?? "")
    ? "3007"
    : undefined;
}

export function isRequestVerificationTerminalError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  return resolveRequestVerificationBusinessCode(error?.code, error?.message) !== undefined;
}

export function isRequestVerificationRejectedMessage(message: string | undefined): boolean {
  return isCaptchaRejectionText(message ?? "");
}

/** 3007 对应的恢复动作：retry-captcha（发行版 btt/xtt）。 */
export const requestVerificationRecoveryAction = "retry-captcha";
export type RequestVerificationRecoveryAction = "retry-captcha";

export const requestVerificationActionMessages = {
  "retry-captcha": "chat.error.action.retryCaptcha",
} as const satisfies Record<RequestVerificationRecoveryAction, string>;

export const requestVerificationErrorAttribution: Record<string, unknown> = {
  CAPTCHA_VERIFY_FAILED: { source: "provider", reason: "auth_failed" },
};

export const requestVerificationClaimFailureMessageId = "manualClaimPlan.claim.failure.captcha";

/** 阿里云验证码弹窗 DOM 选择器（发行版 wtt）。 */
export const additionalRequestModalSelectors: readonly string[] = [
  ".aliyunCaptcha-mask",
  ".aliyunCaptcha-window",
];

/** 配置错误分类（发行版 OO/Ttt）。 */
function requestVerificationConfigErrorId(error: {
  code?: string;
  message?: string;
}): string | undefined {
  if (
    error.code === "configNetwork" ||
    error.message === "Request verification configuration read failed"
  ) {
    return "chat.configReadFailed";
  }
  if (error.message === "Request verification configuration is invalid") {
    return "chat.configInvalid";
  }
  return undefined;
}

export function isRequestVerificationConfigNetworkError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  return !!(error && requestVerificationConfigErrorId(error) === "chat.configReadFailed");
}

/** 3007 错误 → 错误横幅文案 id（发行版 Dtt：zcode.error.providerBusiness.3007）。 */
export function resolveRequestSecurityErrorMessageId(error: {
  code?: string;
  message?: string;
}): string | undefined {
  return isRequestVerificationTerminalError(error)
    ? "zcode.error.providerBusiness.3007"
    : undefined;
}
