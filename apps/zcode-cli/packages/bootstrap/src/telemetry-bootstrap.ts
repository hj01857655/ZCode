import type { AgentExecutionTelemetryPort, ModelStatusSink } from "@zcode/contracts";
import {
  AgentTelemetryOperation,
  type AgentTelemetryCausation,
} from "@zcode/contracts";
import type { Logger } from "@zcode/contracts";

/**
 * 遥测拔除后的 no-op 替身：原 @zcode/telemetry 包（OTLP 导出、agent trace/metrics）
 * 已整体移除，这里保留 create-app 等装配点依赖的接口形状，全部操作为空实现，
 * 不产生任何上报与落盘。
 */

function noopCausation(): AgentTelemetryCausation | undefined {
  return undefined;
}

function makeNoopAgentExecutionTelemetry(): AgentExecutionTelemetryPort {
  const noopScope = {
    captureCausation: noopCausation,
    run: <T>(execute: () => T): T => execute(),
  };
  return {
    captureCausation: noopCausation,
    startCompaction: () => ({
      ...noopScope,
      setInputTokens: () => {},
      setOutputTokens: () => {},
      markFallbackSelected: () => {},
      finishCompleted: () => {},
      finishDiscarded: () => {},
      finishFailed: () => {},
      finishCancelled: () => {},
    }),
    startDetachedOperation: () => ({
      ...noopScope,
      setResultType: () => {},
      finishCompleted: () => {},
      finishFailed: () => {},
      finishCancelled: () => {},
    }),
    startStep: () => ({
      ...noopScope,
      finishCompleted: () => {},
      finishDiscarded: () => {},
      finishFailed: () => {},
      finishCancelled: () => {},
    }),
    startTool: () => ({
      ...noopScope,
      markPermissionRequested: () => {},
      setPermissionDecision: () => {},
      setOutputBytes: () => {},
      setOutputTruncated: () => {},
      startCommand: () => ({
        ...noopScope,
        markFirstOutput: () => {},
        markTerminationRequested: () => {},
        setExitCode: () => {},
        setSignal: () => {},
        setOutputBytes: () => {},
        setTimedOut: () => {},
        finishCompleted: () => {},
        finishFailed: () => {},
        finishCancelled: () => {},
        finishBackgrounded: () => {},
      }),
      finishCompleted: () => {},
      finishDenied: () => {},
      finishFailed: () => {},
      finishCancelled: () => {},
    }),
    startTurn: () => ({
      ...noopScope,
      finishCompleted: () => {},
      finishFailed: () => {},
      finishCancelled: () => {},
    }),
    abandonSession: () => {},
  };
}

export interface ModelTelemetry {
  agentExecution: AgentExecutionTelemetryPort;
  statusSink?: ModelStatusSink;
  shutdown(): Promise<void>;
}

export function createModelTelemetry(_options?: {
  owner?: unknown;
  sessionId?: string;
}): ModelTelemetry {
  void AgentTelemetryOperation;
  return {
    agentExecution: makeNoopAgentExecutionTelemetry(),
    statusSink: undefined,
    shutdown: async () => {},
  };
}

export interface PrepareModelTelemetryOptions {
  cliVersion?: string;
  productVersion?: string;
  runtimeSurface?: string;
}

export async function prepareModelTelemetryEnv(
  env: NodeJS.ProcessEnv,
  _options: PrepareModelTelemetryOptions = {},
): Promise<NodeJS.ProcessEnv> {
  return env;
}

export async function shutdownPreparedModelTelemetry(
  _logger?: Logger,
): Promise<void> {
  void _logger;
}

/**
 * 兼容旧入口签名：原实现会准备 device MID 环境区，现在直接原样返回传入 env。
 */
export async function prepareZCodeTelemetryEnv(
  env: NodeJS.ProcessEnv = process.env,
  _options: PrepareModelTelemetryOptions = {},
): Promise<NodeJS.ProcessEnv> {
  return env;
}

/**
 * 与 prepareZCodeTelemetryEnv 对称的关闭钩子，遥测拔除后为空操作。
 */
export async function shutdownZCodeTelemetry(): Promise<void> {}
