import { resolveUserActionCatalogEntry } from "@/lib/userActionTraceCatalog.js";

/**
 * 用户操作观测的公开包装接口。
 *
 * 上报链路已整体移除；这里只保留 startUserAction / runUserAction 的调用形状，
 * 让业务侧 try/catch + 失败语义保持不变，默认实现为 no-op。
 */

export type UserActionTrigger =
  | "button"
  | "keyboard"
  | "shortcut"
  | "menu"
  | "switch"
  | "select"
  | "drag";

export type UserActionResultSource =
  | "local_commit"
  | "shared_settings"
  | "setting_service"
  | "platform_result"
  | "authority_ack"
  | "optimistic_projection";

export interface StartUserActionInput {
  featureId: Parameters<typeof resolveUserActionCatalogEntry>[0];
  action: string;
  trigger: UserActionTrigger;
  surface?: string;
  timeoutMs?: number;
  workspaceKind?: "local" | "remote";
  remoteKind?: "ssh" | "wsl" | "docker" | "server";
  automationKind?: "scheduled" | "off_peak";
}

export interface UserActionResult {
  resultSource?: UserActionResultSource;
  failureStage?: string;
  stateAfter?: "enabled" | "disabled";
  configured?: boolean;
  requiresRestart?: boolean;
  sectionId?: string;
  valueAfter?: string;
  admissionResult?:
    | "accepted"
    | "rejected"
    | "stale"
    | "duplicate"
    | "noop"
    | "not_applicable";
}

export interface UserActionFailure extends UserActionResult {
  failureStage: string;
}

export interface UserActionHandle {
  complete(result?: UserActionResult): void;
  fail(failure: UserActionFailure): void;
  reject(result?: UserActionResult): void;
  cancel(): void;
  noop(): void;
}

export interface UserActionTelemetry {
  start(input: StartUserActionInput): UserActionHandle;
}

const NOOP_ACTION_HANDLE: UserActionHandle = {
  complete() {},
  fail() {},
  reject() {},
  cancel() {},
  noop() {},
};

let activeUserActionTelemetry: UserActionTelemetry = {
  start: () => NOOP_ACTION_HANDLE,
};

export function setUserActionTelemetry(telemetry: UserActionTelemetry | null): void {
  activeUserActionTelemetry = telemetry ?? { start: () => NOOP_ACTION_HANDLE };
}

export function startUserAction(input: StartUserActionInput): UserActionHandle {
  return activeUserActionTelemetry.start(input);
}

export async function runUserActionAsync<T>(options: {
  input: StartUserActionInput;
  operation: () => Promise<T>;
  completed?: UserActionResult | ((value: T) => UserActionResult);
  failureStage: string;
}): Promise<T> {
  const handle = startUserAction(options.input);
  try {
    const value = await options.operation();
    handle.complete(
      typeof options.completed === "function" ? options.completed(value) : options.completed,
    );
    return value;
  } catch (error) {
    handle.fail({ failureStage: options.failureStage });
    throw error;
  }
}

export function runUserAction<T>(options: {
  input: StartUserActionInput;
  operation: () => T;
  completed?: UserActionResult | ((value: T) => UserActionResult);
  failureStage: string;
}): T {
  const handle = startUserAction(options.input);
  try {
    const value = options.operation();
    handle.complete(
      typeof options.completed === "function" ? options.completed(value) : options.completed,
    );
    return value;
  } catch (error) {
    handle.fail({ failureStage: options.failureStage });
    throw error;
  }
}
