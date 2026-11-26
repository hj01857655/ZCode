import { useEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import type { RequestSecurityWorkspaceTab } from "@/request-security.js";

/** 验证码弹窗容器 DOM id（发行版 wtt：.aliyunCaptcha-mask / .aliyunCaptcha-window）。 */
const CAPTCHA_HOST_ID = "request-security-captcha-host";

/**
 * 安全验证宿主（发行版 UI 宿主语义）：
 * 挂载验证码弹窗容器节点（.aliyunCaptcha-window / .aliyunCaptcha-mask 由阿里云 SDK 填充），
 * 并在卸载时清理，保证 prepareRequestVerificationClaim 的弹窗有挂载点。
 */
export function RequestSecurityHost() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    host.classList.add("aliyunCaptcha-window");
    const mask = document.createElement("div");
    mask.className = "aliyunCaptcha-mask";
    host.appendChild(mask);
    return () => {
      host.classList.remove("aliyunCaptcha-window");
      mask.remove();
    };
  }, []);
  return <div id={CAPTCHA_HOST_ID} ref={hostRef} style={{ display: "none" }} />;
}

/**
 * workspace 桥（发行版 RequestSecurityWorkspaceBridge 语义）：
 * 把各 workspace 的安全验证状态桥接到宿主；当前发行版实现仅登记 tabs，
 * 弹窗状态由阿里云 SDK 全局单例管理，这里保持 tabs 同步供宿主消费。
 */
export function RequestSecurityWorkspaceBridge(_props: {
  workspaceTabs: readonly RequestSecurityWorkspaceTab[];
}) {
  return null;
}

/** 当前注册的 reporter（desktop platform 或 null）。 */
let activeReporter: IPlatformService | null = null;

/** reporter 注册（发行版 setRequestSecurityReporter 语义：desktop 注册、Web/mobile 注销）。 */
export function setRequestSecurityReporter(reporter: IPlatformService | null): void {
  activeReporter = reporter;
}

/** 供 claim.ts / diagnostics 读取当前 reporter 上报诊断事件。 */
export function getRequestSecurityReporter(): IPlatformService | null {
  return activeReporter;
}
