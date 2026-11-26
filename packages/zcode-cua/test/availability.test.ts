import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createComputerUseRuntime } from "../index.js";
import { callBrokerMethod } from "../broker.js";
import { startInProcessComputerUseBroker } from "../broker-in-process.js";
import { BROKER_SOCKET_ENV, IN_PROCESS_BROKER_SOCKET, mintBrokerSocketPath } from "../broker-socket-path.js";

const context = { sessionId: "example", runtimeScope: "main", workspaceKey: "example" } as const;

/** 不可达 broker + 立即失败的就绪探测：整条链路不 spawn Helper。 */
function unavailableRuntime() {
  return createComputerUseRuntime({
    brokerSocketPath: "unused",
    ensureBrokerAvailable: async () => {
      throw new Error("no helper");
    },
  });
}

describe("Computer Use 运行时的失败边界", () => {
  it("未知方法直接抛错，且不触发 broker 准备", async () => {
    let prepared = false;
    const runtime = createComputerUseRuntime({
      brokerSocketPath: "unused",
      ensureBrokerAvailable: async () => {
        prepared = true;
      },
    });
    await expect(
      runtime.execute({ toolName: "computer_use", arguments: {}, context: { ...context } }),
    ).rejects.toThrow(/Unknown Computer Use tool/u);
    expect(prepared).toBe(false);
    await runtime.dispose();
  }, 20_000);

  it("subagent 作用域在触达 broker 之前就被拒绝", async () => {
    let prepared = false;
    const runtime = createComputerUseRuntime({
      brokerSocketPath: "unused",
      ensureBrokerAvailable: async () => {
        prepared = true;
      },
    });
    const result = await runtime.execute({
      toolName: "list_apps",
      arguments: {},
      context: { ...context, runtimeScope: "subagent" },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "SUBAGENT_COMPUTER_USE_UNAVAILABLE" },
    });
    expect(prepared).toBe(false);
    await runtime.dispose();
  }, 20_000);

  it("broker 未就绪时返回软错误 CUA_NOT_READY，而不是崩溃", async () => {
    const runtime = unavailableRuntime();
    const result = await runtime.execute({ toolName: "list_apps", arguments: {}, context: { ...context } });
    expect(result.isError).not.toBe(true);
    const [block] = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(block.text) as { kind: string; reasonCode: string; retryable: boolean };
    expect(payload).toMatchObject({ kind: "CUA_NOT_READY", reasonCode: "broker_not_accepting", retryable: true });
    await runtime.dispose();
  }, 20_000);

  it("stop 之后 kill switch 锁定，后续调用不可恢复", async () => {
    const runtime = unavailableRuntime();
    const stopped = await runtime.execute({
      toolName: "stop_computer_control",
      arguments: { reason: "test" },
      context: { ...context },
    });
    expect(stopped.isError).not.toBe(true);
    const after = await runtime.execute({ toolName: "list_apps", arguments: {}, context: { ...context } });
    expect(after.isError).toBe(true);
    expect((after.content as Array<{ text: string }>)[0].text).toContain("Computer control was stopped (test)");
    await runtime.dispose();
  }, 20_000);

  it("无 Helper 时报告 broker_unavailable，进程内 broker 走官方实现", async () => {
    // 连不上管道时官方客户端归为 broker_unavailable，而不是笼统的 unavailable。
    await expect(
      callBrokerMethod({ method: "example", socketPath: "unused", timeoutMs: 500 }),
    ).rejects.toMatchObject({ code: "broker_unavailable" });
    expect(BROKER_SOCKET_ENV).toBe("ZCODE_CUA_PERMISSION_BROKER_SOCKET");
    expect(IN_PROCESS_BROKER_SOCKET).toBe("in-process");

    // Windows 的本地套接字是命名管道，Helper 只接受该命名空间；%TEMP% 下的普通
    // 文件路径 listen 会 EACCES。
    const socketPath = mintBrokerSocketPath();
    if (process.platform === "win32") expect(socketPath).toMatch(/^\\\\\.\\pipe\\zcode-cua-helper-/u);
    else expect(socketPath).toMatch(/\.sock$/u);

    if (process.platform !== "win32") return;
    // 进程内 broker 需要本仓构建出的 addon；缺失时只校验命名契约，不伪造成功。
    const addonPath = fileURLToPath(new URL("../build/Release/ax_native.node", import.meta.url));
    if (!existsSync(addonPath)) return;
    const broker = await startInProcessComputerUseBroker({ socketPath, addonPath });
    try {
      expect(broker.socketPath).toBe(socketPath);
      const info = await callBrokerMethod<{ platform: string }>({
        socketPath: broker.socketPath,
        method: "broker_info",
        timeoutMs: 5_000,
      });
      expect(info.platform).toBe("win32");
    } finally {
      await broker.stop();
    }
  });
});