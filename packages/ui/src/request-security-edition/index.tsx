import { useEffect, useMemo } from "react";
import type { RequestSecurityWorkspaceTab } from "@/request-security.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { subscribeProviderRuntimeHeaders } from "./provider-headers.js";

/**
 * 验证码宿主 DOM id（与 4.0.0 发行版 uBt/sV/cV 一致）。
 * 只保留一份挂载点：SDK 弹窗由阿里云脚本填充到 element 内，按钮是无痕失败时升级交互的触发器。
 */
const CAPTCHA_CONTAINER_ID = "zcode-aliyun-captcha-container";
const CAPTCHA_ELEMENT_ID = "zcode-aliyun-captcha-element";
const CAPTCHA_BUTTON_ID = "zcode-aliyun-captcha-button";

/**
 * 安全验证宿主（发行版 dBt 同构）：
 * 容器与触发按钮必须常驻，`prepareRequestVerificationClaim` 初始化 SDK 前会校验它们存在。
 * 尺寸为 0 / 1px、不可见、不可聚焦，只作为 SDK 的挂载与点击目标。
 */
export function RequestSecurityHost() {
  return (
    <div
      id={CAPTCHA_CONTAINER_ID}
      aria-hidden="true"
      className="fixed left-0 top-0 z-[2147483647] h-0 w-0 overflow-visible"
    >
      <div id={CAPTCHA_ELEMENT_ID} className="absolute left-0 top-0 h-0 w-0 overflow-visible" />
      <button
        id={CAPTCHA_BUTTON_ID}
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="fixed left-1/2 top-1/2 h-px w-px -translate-x-1/2 -translate-y-1/2 border-0 p-0 opacity-0"
      />
    </div>
  );
}

function workspaceKey(tab: RequestSecurityWorkspaceTab): string {
  return tab.workspaceIdentity?.trim() || tab.workspacePath;
}

/**
 * workspace 桥（发行版 D6n）：
 * 模型请求的验证应答方必须常驻桌面窗口并为每个打开的 workspace tab 各维持一份订阅，
 * 与正在展示的 pane 解耦——否则 web 远控新建会话时 headers 请求无人应答，任务永久滞留。
 * 同一身份 key 只挂一份，避免重复 tab 产生重复应答。
 */
export function RequestSecurityWorkspaceBridge({
  workspaceTabs,
}: {
  workspaceTabs: readonly RequestSecurityWorkspaceTab[];
}) {
  const uniqueTabs = useMemo(() => {
    const seen = new Set<string>();
    return workspaceTabs.filter((tab) => {
      const key = workspaceKey(tab);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [workspaceTabs]);
  return (
    <>
      {uniqueTabs.map((tab) => (
        <WorkspaceProviderRuntimeHeadersResponder key={workspaceKey(tab)} tab={tab} />
      ))}
    </>
  );
}

function WorkspaceProviderRuntimeHeadersResponder({ tab }: { tab: RequestSecurityWorkspaceTab }) {
  const { services, rpcReady } = useWorkspaceServicesResolution(
    tab.workspacePath,
    tab.remoteSessionId ?? null,
    tab.workspaceIdentity ?? null,
    tab.remoteTarget,
  );
  const workspaceIdentity = tab.workspaceIdentity?.trim();
  useEffect(() => {
    // 远程 workspace 断连期（remote-waiting）订阅会落到断连代理并产生无效 RPC；
    // 连接恢复、services 换成真实远端 host 后再订阅。
    if (!rpcReady) return;
    return subscribeProviderRuntimeHeaders({
      services,
      workspace: {
        workspacePath: tab.workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      },
    });
  }, [services, rpcReady, tab.workspacePath, workspaceIdentity, tab.remoteSessionId]);
  return null;
}

