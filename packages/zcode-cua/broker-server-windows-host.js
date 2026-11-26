// Windows 产品 Helper 宿主的真身实现：spawn 仓库内 dist/windows-helper.js（独立 node
// 进程，经 Windows named pipe 与 broker 通信），等控制协议就绪后算 healthy。
// macOS 走 createMacHost（LaunchServices/TCC），不经过本模块。

import { randomBytes, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { callBrokerMethod, probeHelperHealth } from "./broker.js";
import { mintBrokerSocketPath } from "./broker-socket-path.js";
import { HELPER_ADDON_ENV, standaloneHelperCandidatePaths, resolveCuaHelperInstallRoot } from "./vendor/official-runtime.js";

export const WINDOWS_DEV_CONTROL_PROTOCOL = "zcode-cua-windows-dev/v1";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const GHOST_CURSOR_OVERLAY_ARG = "--ghost-cursor-overlay";

function isWindowsNamedPipePath(path) {
  return typeof path === "string" && path.startsWith("\\\\.\\pipe\\");
}

/**
 * 解析 Windows helper 运行时（entry/addon/command）。
 * 优先级：ZCODE_CUA_DEV_ROOT 显式开发目录 → 本仓 in-tree 产物（dist/ + build/Release）→
 * standaloneHelperCandidatePaths（按 ZCODE_HOME 安装根）。
 */
export function resolveWindowsHelperRuntime(env = process.env, platform = process.platform) {
  if (platform !== "win32") return null;
  const packageRoot = dirname(fileURLToPath(new URL("./package.json", import.meta.url)));
  const roots = [];
  const devRoot = env.ZCODE_CUA_DEV_ROOT?.trim();
  if (devRoot) roots.push(devRoot);
  roots.push(packageRoot);
  const installRoot = resolveCuaHelperInstallRoot(env);
  if (installRoot) roots.push(installRoot);
  for (const root of roots) {
    const entry = join(root, "dist", "windows-helper.js");
    const addon = join(root, "build", "Release", "ax_native.node");
    if (existsSync(entry) && existsSync(addon)) {
      return { root, entryPath: entry, addonPath: addon, command: process.execPath };
    }
  }
  // 兜底：standalone 安装形态（可执行体直接放在安装根下）。
  for (const candidate of standaloneHelperCandidatePaths(env)) {
    if (existsSync(candidate)) {
      return {
        root: dirname(candidate),
        entryPath: candidate,
        addonPath: process.env[HELPER_ADDON_ENV] ?? "",
        command: process.execPath,
      };
    }
  }
  return null;
}

function parseControlMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (message.protocol !== WINDOWS_DEV_CONTROL_PROTOCOL) return "ignore";
  if (message.type === "error") {
    return typeof message.message === "string" && message.message.length > 0
      ? { type: "error", message: message.message }
      : null;
  }
  if (message.type !== "ready" && message.type !== "transport_ready") return "ignore";
  if (
    typeof message.socketPath !== "string" ||
    !message.socketPath ||
    !Number.isInteger(message.pid) ||
    message.pid <= 0
  ) {
    return null;
  }
  return { type: message.type, socketPath: message.socketPath, pid: message.pid };
}

/**
 * Windows 产品 Helper 宿主。接口语义对齐 CuaHelperHost（broker-server.d.ts）：
 * start 后等 helper 子进程在控制协议上报 transport_ready/ready（named pipe 已 bind），
 * 再经 broker_info 健康探测确认 pid 后才算 healthy。
 */
class WindowsProductHelperHost {
  constructor(options) {
    this.runtime = options.runtime;
    this.logger = options.logger;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.child = null;
    this.handle = null;
    this.startInFlight = null;
  }

  get running() {
    return this.handle !== null;
  }

  get socketPath() {
    return this.handle?.socketPath ?? null;
  }

  get pluginAuthority() {
    return this.handle?.pluginAuthority ?? null;
  }

  get reservedTransport() {
    return undefined;
  }

  async start() {
    if (this.handle) return this.handle;
    this.startInFlight ??= this.startNow().finally(() => {
      this.startInFlight = null;
    });
    return await this.startInFlight;
  }

  async startNow() {
    const socketPath = mintBrokerSocketPath({ env: process.env });
    // 注意：fork(entryPath, args) 的子进程 argv = [exec, entryPath, ...args]，
    // helper 端 parseWindowsDevHelperConfig 读 argv.slice(2) 并要求恰好
    // `--socket X --parent-pid Y`（+ 允许的 flag）；entryPath 不能再出现在 args 里，
    // 否则被当成多余 positional 直接退出码 2（"failed to start"）。
    const args = [
      "--socket",
      socketPath,
      "--parent-pid",
      String(process.pid),
      GHOST_CURSOR_OVERLAY_ARG,
    ];
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      // addon 绝对路径：helper 内部 loadRealNativeAddon 依赖该 env 找到 ax_native.node。
      [HELPER_ADDON_ENV]: this.runtime.addonPath,
    };
    const child = fork(this.runtime.entryPath, args, {
      cwd: this.runtime.root,
      env,
      execPath: this.runtime.command,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.child = child;
    const authority = randomBytes(16).toString("hex");
    return await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.handle = null;
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error("Windows Computer Use Helper startup timed out")),
        this.startupTimeoutMs,
      );
      timer.unref?.();
      const onMessage = (message) => {
        const parsed = parseControlMessage(message);
        if (parsed === "ignore") return;
        if (!parsed) {
          return fail(new Error("Invalid Windows Computer Use Helper control message"));
        }
        if (parsed.type === "error") return fail(new Error(parsed.message));
        if (parsed.socketPath !== socketPath) return;
        if (parsed.pid !== child.pid) {
          return fail(new Error("Windows Computer Use Helper ready pid mismatch"));
        }
        if (parsed.type === "transport_ready") {
          // 两阶段：pipe 已 bind。完整健康握手交给 waitForTransport/调用方；
          // 这里直接补一次 broker_info 确认可用。
          probeHelperHealth(socketPath, { timeoutMs: this.startupTimeoutMs })
            .then((health) => {
              if (settled) return;
              settled = true;
              cleanup();
              this.handle = {
                socketPath,
                launchSocketPath: socketPath,
                pluginAuthority: authority,
                helperAppPath: this.runtime.entryPath,
                bundleId: health.bundleId,
                pid: health.pid,
              };
              resolve(this.handle);
            })
            .catch(fail);
          return;
        }
        probeHelperHealth(socketPath, { timeoutMs: this.startupTimeoutMs })
          .then((health) => {
            if (settled) return;
            settled = true;
            cleanup();
            this.handle = {
              socketPath,
              launchSocketPath: socketPath,
              pluginAuthority: authority,
              helperAppPath: this.runtime.entryPath,
              bundleId: health.bundleId,
              pid: health.pid,
            };
            resolve(this.handle);
          })
          .catch(fail);
      };
      const onError = (error) => fail(error);
      const onExit = (code) => {
        if (!settled) {
          fail(new Error(`Windows Computer Use Helper exited before ready (${String(code)})`));
          return;
        }
        // ready 之后意外退出：清 handle，让下一次 start 重新拉起。
        this.handle = null;
        this.child = null;
      };
      child.on("message", onMessage);
      child.on("error", onError);
      child.on("exit", onExit);
    });
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.handle = null;
    if (!child) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, this.shutdownTimeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", onExit);
      try {
        child.send({ protocol: WINDOWS_DEV_CONTROL_PROTOCOL, type: "shutdown" });
      } catch {
        // 通道已关：靠 kill 兜底。
      }
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 进程已退出。
        }
      }, this.shutdownTimeoutMs).unref?.();
    });
  }

  async restart() {
    await this.stop();
    return await this.start();
  }

  async restartAfterCurrentStart() {
    if (this.startInFlight) await this.startInFlight.catch(() => undefined);
    return await this.restart();
  }

  async waitForTransport(timeoutMs = this.startupTimeoutMs) {
    const previousTimeout = this.startupTimeoutMs;
    this.startupTimeoutMs = timeoutMs;
    try {
      const handle = await this.start();
      return { socketPath: handle.socketPath, pluginAuthority: handle.pluginAuthority };
    } finally {
      this.startupTimeoutMs = previousTimeout;
    }
  }

  async checkHealth(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
    if (!this.handle) {
      throw new Error("Computer Use is not available in this build.");
    }
    return await probeHelperHealth(this.handle.socketPath, { timeoutMs });
  }

  async queryScreenCaptureProbe() {
    if (!this.handle) return { ok: false, reason: "helper_not_running" };
    try {
      const probe = await callBrokerMethod({
        socketPath: this.handle.socketPath,
        method: "screen_capture_probe",
        timeoutMs: 15_000,
      });
      // 真实判定：helper 抓到了像素即 ok。失败时带 classification/reason。
      const ok = probe?.ok === true;
      return ok
        ? { ok: true }
        : { ok: false, reason: probe?.classification ?? probe?.reason ?? "screen_capture_denied" };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async queryScreenRecordingPreflight() {
    if (!this.handle) return undefined;
    try {
      const status = await callBrokerMethod({
        socketPath: this.handle.socketPath,
        method: "permission_status",
        timeoutMs: 5_000,
      });
      return typeof status?.screen_recording === "string" ? status.screen_recording : "unknown";
    } catch {
      return "unknown";
    }
  }

  async queryPermissionStatus() {
    if (!this.handle) return {};
    try {
      const status = await callBrokerMethod({
        socketPath: this.handle.socketPath,
        method: "permission_status",
        timeoutMs: 5_000,
      });
      return status && typeof status === "object" ? status : {};
    } catch {
      return {};
    }
  }
}

/**
 * win32 下构造真身宿主；非 win32（含 darwin——产品链走 createMacHost，不经过这里）
 * 维持 unavailable 语义。
 */
export function createWindowsProductHelperHost(options = {}) {
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) !== "win32") return null;
  const runtime = resolveWindowsHelperRuntime(env, "win32");
  if (!runtime) {
    options.logger?.warn?.(
      undefined,
      "Windows CUA runtime not found: dist/windows-helper.js or ax_native.node missing",
    );
    return null;
  }
  return new WindowsProductHelperHost({ runtime, logger: options.logger });
}

/**
 * Windows 没有 macOS 的 TCC 权限主体：返回基于安装根路径哈希的稳定主体标识而非抛错。
 */
export async function resolveWindowsPermissionSubjectIdentity(appPath) {
  const normalized = String(appPath ?? "").toLowerCase();
  const subjectId = `win-${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
  return {
    appPath: String(appPath ?? ""),
    executablePath: String(appPath ?? ""),
    displayName: "ZCode Computer Use Helper",
    bundleId: "com.zcode.cua-helper",
    subjectId,
  };
}
