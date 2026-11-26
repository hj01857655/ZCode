import type { ICodingPlanSubscriptionService } from "@zcode/services";
import type { RequestVerificationProof } from "@zcode/shared";

/**
 * 领奖前预热：标记验证码弹窗可预热（发行版 wtt 选择器对应的 aliyunCaptcha SDK 预加载）。
 * 真实弹窗由阿里云 SDK 按需初始化；此处仅做 SDK 脚本预取，不弹窗。
 */
export function useRequestVerificationPrewarm(visible: boolean): void {
  if (!visible || typeof window === "undefined") {
    return;
  }
  // SDK 脚本预取（发行版 Zzt：https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js）
  const SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
  if (document.querySelector(`script[src="${SDK_URL}"]`)) {
    return;
  }
  const script = document.createElement("script");
  script.src = SDK_URL;
  script.async = true;
  document.head.appendChild(script);
}

/**
 * 申领验证 proof（发行版完整链路）：
 * start-plan 场景下先触发阿里云验证码交互（sceneId 配置），拿到 captchaVerifyParam 后
 * 作为 proof 返回；由 claimManualPlan 展开为 X-Aliyun-Captcha-Verify-Param 头。
 */
export async function prepareRequestVerificationClaim(
  service: ICodingPlanSubscriptionService,
  signal: AbortSignal,
  onVerifying: () => void,
): Promise<RequestVerificationProof | undefined> {
  signal.throwIfAborted();
  onVerifying();
  // 读取验证配置（region/prefix/sceneId）
  const config = (await service.getRequestVerificationConfig?.()) as
    | { enabled?: boolean; region?: string; prefix?: string; sceneId?: string }
    | null
    | undefined;
  if (!config || config.enabled === false) {
    return {};
  }
  const { region, prefix, sceneId } = config;
  if (!region || !prefix || !sceneId) {
    throw new Error("Request verification configuration is invalid");
  }
  // 触发阿里云验证码交互，等待用户完成验证拿 captchaVerifyParam
  const captchaParam = await showAliyunCaptcha(region, prefix, sceneId, signal);
  return captchaParam ? { captchaVerifyParam: captchaParam } : {};
}

/** 加载阿里云验证码 SDK 并弹窗，返回 captchaVerifyParam（发行版 Zzt/iV/aV/rBt/iBt 语义）。 */
function showAliyunCaptcha(
  region: string,
  prefix: string,
  sceneId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as {
      initAliyunCaptcha?: (options: Record<string, unknown>) => void;
    };
    if (!w.initAliyunCaptcha) {
      reject(new Error("Captcha SDK not loaded"));
      return;
    }
    signal.throwIfAborted();
    w.initAliyunCaptcha({
      SceneId: sceneId,
      prefix,
      region,
      element: ".aliyunCaptcha-window",
      button: ".aliyunCaptcha-btn",
      captchaVerifyCallback: (params: { captchaVerifyParam?: string }) => {
        resolve(params.captchaVerifyParam);
      },
      onBizResultCallback: () => {},
      getInstance: () => {},
      slideStyle: { width: 360, height: 40 },
      language: "cn",
    });
  });
}
