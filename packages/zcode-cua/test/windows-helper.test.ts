import { fork, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callBrokerMethod, mintBrokerSocketPath, probeHelperHealth } from "../broker.js";

const packageRoot = join(import.meta.dirname, "..");

// entry 与 addon 以 runtime-manifest.json 为唯一事实：打包暂存、Helper 启动、
// 本测试都读同一份声明，避免测试钉住某条硬编码路径而放走契约漂移。
function readRuntimeContract(): { entry: string; nativeAddon: string } {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "runtime-manifest.json"), "utf8")) as {
    entry: string;
    addon: string;
  };
  return {
    entry: join(packageRoot, manifest.entry),
    nativeAddon: join(packageRoot, manifest.addon),
  };
}

const { entry: entryPath, nativeAddon: nativeAddonPath } = readRuntimeContract();

const children: ChildProcess[] = [];

function spawnHelper(socketPath: string): { child: ChildProcess; messages: unknown[] } {
  const child = fork(entryPath, ["--socket", socketPath, "--parent-pid", String(process.pid)], {
    cwd: packageRoot,
    env: { ...process.env, ZCODE_CUA_ADDON_PATH: nativeAddonPath },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages: unknown[] = [];
  child.on("message", (message) => messages.push(message));
  children.push(child);
  return { child, messages };
}

async function waitForReady(child: ChildProcess, messages: unknown[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ready = messages.find(
      (message) => (message as { type?: string }).type === "ready",
    ) as { pid?: number } | undefined;
    if (ready) {
      // Host 会强校验 ready.pid 与子进程 pid 一致，这里提前暴露不一致。
      expect(ready.pid).toBe(child.pid);
      return;
    }
    const failed = messages.find(
      (message) => (message as { type?: string }).type === "error",
    ) as { message?: string } | undefined;
    if (failed) throw new Error(`helper 启动失败：${failed.message ?? "unknown"}`);
    if (Date.now() >= deadline) throw new Error("helper 未在 30s 内 ready");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.send({ protocol: "zcode-cua-windows-dev/v1", type: "shutdown" });
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve(undefined);
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
    }
  }
});

describe.skipIf(process.platform !== "win32")("Windows Helper 控制面", () => {
  it("ready 后能响应 broker_info / permission_status / ping / 工具方法，并按 IPC shutdown 退出", async () => {
    const socketPath = mintBrokerSocketPath();
    const { child, messages } = spawnHelper(socketPath);
    await waitForReady(child, messages);

    const health = await probeHelperHealth(socketPath, { timeoutMs: 5_000 });
    expect(health.pid).toBe(child.pid);
    expect(health.bundleId).toBe("dev.zcode.cua-helper");

    const info = await callBrokerMethod({ method: "broker_info", socketPath });
    expect(info).toMatchObject({ pid: child.pid, bundle_id: "dev.zcode.cua-helper", platform: "win32" });

    const permissions = await callBrokerMethod({ method: "permission_status", socketPath });
    expect(permissions).toMatchObject({ grant_owner: "dev.zcode.cua-helper" });
    expect(permissions).toHaveProperty("accessibility");

    // Helper 的 ping 应答带服务端协议版本；Host 用它判断能力代际。
    await expect(callBrokerMethod({ method: "ping", socketPath })).resolves.toHaveProperty("serverApiVersion");

    // Windows Helper 承担执行层：工具方法必须由它应答，而不是 unimplemented。
    await expect(callBrokerMethod({ method: "list_applications", socketPath })).resolves.toBeInstanceOf(Array);

    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.send({ protocol: "zcode-cua-windows-dev/v1", type: "shutdown" });
    expect(await exited).toBe(0);
  }, 60_000);

  // 打包暂存只复制 entry + addon（packages/desktop/scripts/windows-cua-helper-assets.mjs）；
  // entry 一旦 import 包内相对路径文件，安装目录里就没有它，Helper 会以 ERR_MODULE_NOT_FOUND 退出。
  it("entry 自包含，不引用包内其它文件", () => {
    const source = readFileSync(entryPath, "utf8");
    const relativeImports = [...source.matchAll(/from\s+"(\.[^"]*)"/gu)].map((match) => match[1]);
    expect(relativeImports).toEqual([]);
  });

  it("runtime 契约声明的 entry 与 nativeAddon 都是包内普通文件且 addon 可加载", () => {
    expect(existsSync(entryPath)).toBe(true);
    expect(existsSync(nativeAddonPath)).toBe(true);
    const addon = createRequire(import.meta.url)(nativeAddonPath) as Record<string, unknown>;
    // 执行层原语由 addon 导出；缺任何一个都说明 build/Release 的产物不是正式构建。
    for (const name of ["listApplications", "windowsOperationScene", "captureWindowImage"]) {
      expect(addon).toHaveProperty(name);
      expect(typeof addon[name]).toBe("function");
    }
  });
});