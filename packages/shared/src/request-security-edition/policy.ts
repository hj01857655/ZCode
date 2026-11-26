/** 安全校验涉及的头（与发行版 nEr/请求头白名单一致）。 */
export const requestSecuritySensitiveHeaders: readonly string[] = [
  "X-Aliyun-Captcha-Verify-Param",
  "X-Aliyun-Captcha-Verify-Region",
];

/**
 * 安全校验失败识别（发行版 Bwe）：body 的 providerErrorCode 命中 codes 即为安全失败。
 * 发行版场景：3007 = coding_plan_security_verification_required / CAPTCHA_VERIFY_FAILED。
 */
export function isRequestSecurityFailure(
  body: unknown,
  codes: readonly (string | undefined)[],
): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }
  const providerErrorCode =
    (body as Record<string, unknown>).providerErrorCode ??
    (body as Record<string, unknown>).providerCode ??
    (body as Record<string, unknown>).code;
  return (
    typeof providerErrorCode === "string" &&
    (codes as readonly (string | undefined)[]).includes(providerErrorCode)
  );
}
