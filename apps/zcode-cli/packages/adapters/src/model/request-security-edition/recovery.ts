import type { RequestVerificationReason } from "@zcode/shared";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "../runner-runtime.js";
import type { ProviderBusinessError, AiSdkProviderKind } from "../model-execution.js";

/** 3007 业务码（发行版 $ba）。 */
const CAPTCHA_BUSINESS_CODE = "3007";

/** 从业务错误 body 提取 providerErrorCode 并判定 3007（发行版 Bwe/c2）。 */
function isCaptchaRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const body = error as Record<string, unknown>;
  const inner = (body.body ?? body) as Record<string, unknown>;
  return (
    inner.providerErrorCode === CAPTCHA_BUSINESS_CODE ||
    inner.providerCode === CAPTCHA_BUSINESS_CODE ||
    body.providerErrorCode === CAPTCHA_BUSINESS_CODE
  );
}

/** 3007 后验证码重试链（发行版 C3e = CaptchaRequestRetry 完整语义）。 */
export class RequestVerificationRetry {
  private used = false;
  private pending = false;

  constructor(
    private readonly request: AiSdkModelTextRequest,
    private readonly model: ResolvedAiSdkModel,
  ) {}

  get extraAttempts(): number {
    return Number(this.used);
  }

  takeReason(): RequestVerificationReason {
    const reason: RequestVerificationReason = this.pending ? "captcha-retry" : "model-request";
    this.pending = false;
    return reason;
  }

  claim(error: unknown, blocked = false): boolean {
    if (
      blocked ||
      this.used ||
      this.request.abortSignal?.aborted ||
      !this.request.refreshRuntimeHeadersBeforeAttempt ||
      this.model.accountAccess?.mode !== "start-plan" ||
      !isCaptchaRejection(error)
    ) {
      return false;
    }
    this.used = true;
    this.pending = true;
    return true;
  }
}

export function isRequestVerificationRejection(error: unknown): boolean {
  return isCaptchaRejection(error);
}

/** 空流错误构造（发行版 hEn = createZcodePlanCaptchaEmptyStreamBusinessError）。 */
export function createRequestVerificationEmptyStreamError(input: {
  accountMode?: string;
  headers: Record<string, string> | undefined;
  providerId: string;
  providerKind: AiSdkProviderKind;
}): ProviderBusinessError | undefined {
  if (
    !(
      input.providerKind === "openai-compatible" &&
      input.accountMode === "start-plan"
    ) ||
    !readCaptchaVerifyParam(input.headers)
  ) {
    return undefined;
  }
  return {
    providerCode: CAPTCHA_BUSINESS_CODE,
    providerId: input.providerId,
    providerKind: input.providerKind,
    providerMessage: "Captcha verification failed or the verify token was rejected.",
    responseStatus: 200,
    statusCode: 403,
  } as ProviderBusinessError;
}

/** 从请求头读取 x-aliyun-captcha-verify-param（发行版 Bwo/qba）。 */
function readCaptchaVerifyParam(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) {
    return;
  }
  const value = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "x-aliyun-captcha-verify-param",
  )?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}
