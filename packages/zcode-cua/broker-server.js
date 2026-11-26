// broker/server 子路径：官方发行包提供的那一层直接转发，保持单一实现。
// 下面保留的符号只存在于桌面 host 编排名（发行包把这一层与本仓 TS 实现一起打包，
// 没有独立模块边界可切），Windows Helper 的完整执行层不在其中，因此维持本仓实现。
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CuaHelperError, BROKER_SOCKET_ENV } from "./broker.js";
import { createWindowsProductHelperHost, resolveWindowsPermissionSubjectIdentity } from "./broker-server-windows-host.js";

export {
  HELPER_ADDON_ENV,
  buildHelperOpenArgs,
  isCuaLocalDevelopmentRuntime,
  createCuaHelperInstaller,
  defaultCuaHelperVerifierDependencies,
  createAxReadOnlyMethods,
  ROLE_TO_KIND,
  roleToKind,
  loadRealNativeAddon,
  resolvePackagedNativeAddonPath,
  resolveInTreeAddonPath,
  resolveHelperAppName,
  resolveCuaHelperInstallRoot,
  standaloneHelperCandidatePaths,
} from "./vendor/official-runtime.js";

export const WINDOWS_DEV_CONTROL_PROTOCOL = "zcode-cua-windows-dev/v1";

const UNAVAILABLE = "Computer Use is not available in this build.";

function unavailableReject() {
  return Promise.reject(new CuaHelperError("helper_unavailable", UNAVAILABLE));
}

export async function resolveHelperPermissionSubjectIdentity(appPath, options = {}) {
  // Windows 没有 macOS 的 TCC 权限主体：返回基于安装根的稳定主体标识而非抛错。
  if ((options.platform ?? process.platform) === "win32") {
    return await resolveWindowsPermissionSubjectIdentity(appPath);
  }
  throw new CuaHelperError("helper_unavailable", UNAVAILABLE);
}

// macOS 专用的刷新型号：socket 同目录的伴随文件。Windows 的 socket 是命名管道
// （\\.\pipe\...），没有可写目录语义，保持 undefined 由 agent 侧跳过。
export function cuaBrokerRefreshMarkerPath(socketPath) {
  const trimmed = socketPath?.trim();
  if (!trimmed || process.platform === "win32") return undefined;
  return `${trimmed}.permission-refresh.json`;
}

export async function publishCuaBrokerRefreshMarker(socketPath, _options) {
  return { path: cuaBrokerRefreshMarkerPath(socketPath) };
}

export class CuaHelperLifecycleManager {
  #dispose;
  #current;
  #disposed = false;
  constructor(dispose) {
    this.#dispose = dispose;
    this.#current = undefined;
  }
  async acquire(options) {
    if (typeof options?.isAdmitted === "function" && !options.isAdmitted()) {
      return undefined;
    }
    const managed = options?.create?.();
    this.#current = managed;
    return managed;
  }
  peek() {
    return this.#current;
  }
  get disposed() {
    return this.#disposed;
  }
  async dispose(managed) {
    this.#disposed = true;
    await this.#dispose?.(managed ?? this.#current);
  }
}

export class CuaProductHelperWorkspaceRegistry {
  setEnabled(_context, _enabled) {}
}

export function createProductCuaHelperHost(options = {}) {
  // win32：真身宿主（spawn dist/windows-helper.js，named pipe 控制协议）。
  // 运行时缺失或非 win32（含 darwin 产品链——走 createMacHost，不经过这里）回落 unavailable。
  const host = createWindowsProductHelperHost(options);
  if (host) return host;
  return createUnavailableCuaHelperHost();
}

function createUnavailableCuaHelperHost() {
  return {
    get running() {
      return false;
    },
    get socketPath() {
      return null;
    },
    get pluginAuthority() {
      return null;
    },
    get reservedTransport() {
      return undefined;
    },
    start: unavailableReject,
    stop: async () => {},
    restart: unavailableReject,
    restartAfterCurrentStart: unavailableReject,
    waitForTransport: unavailableReject,
    checkHealth: unavailableReject,
    queryScreenCaptureProbe: async () => ({
      ok: false,
      reason: UNAVAILABLE,
    }),
    queryScreenRecordingPreflight: async () => undefined,
    queryPermissionStatus: async () => ({}),
  };
}

// ---------------------------------------------------------------------------
// CUA agent MCP server 识别与 broker 凭据注入
//
// 移植自 ZCode 4.0.0 host bundle（injectPermissionBrokerAgentMcpServers /
// isPotentialZCodeCuaAgentMcpServer / createCuaProductMcpServerResolver）。
// 语义与上游逐条对应，不再自创分支；插件的 server 描述符里 env 是 {name,value}
// 数组而不是 record，这一形状由 CLI 侧的插件 MCP 适配器产生，不能改成 object。
// ---------------------------------------------------------------------------

const OFFICIAL_CUA_SERVER_NAME = "plugin:computer-use:computer-use";
const OFFICIAL_CUA_PLUGIN_ID = "computer-use@zcode-plugins-official";
const COMPUTER_USE_SERVER_NAME = "computer-use";
const PLUGIN_ID_ENV_KEY = "ZCODE_PLUGIN_ID";
const CUA_PACKAGE_SPEC_ENV_KEY = "ZCODE_CUA_PACKAGE_SPEC";
const PLUGIN_AUTHORITY_ENV_KEY = "ZCODE_CUA_PLUGIN_AUTHORITY";
const REFRESH_MARKER_ENV_KEY = "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER";
const PERMISSION_BROKER_SOCKET_FLAG = "--permission-broker-socket";
const DEFAULT_HELPER_STARTUP_TIMEOUT_MS = 10_000;

function commandServerOf(value) {
  return typeof value !== "object" || value === null || typeof value.command !== "string"
    ? null
    : value;
}

function envEntriesOf(env) {
  return Array.isArray(env)
    ? env.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.name === "string" &&
          typeof entry.value === "string",
      )
    : [];
}

function stringArgsOf(args) {
  return Array.isArray(args) ? args.filter((arg) => typeof arg === "string") : [];
}

function upsertEnvEntry(entries, name, value) {
  const next = entries.filter((entry) => entry.name !== name).map((entry) => ({ ...entry }));
  next.push({ name, value });
  return next;
}

function trailingSegment(path) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

// 上游 BI：命令行/参数里出现的 zcode-cua 包标识（区分大小写）。
function matchesCuaPackageToken(raw) {
  const token = raw.replace(/_/g, "-");
  return (
    token === "zcode-cua" ||
    token.startsWith("zcode-cua[") ||
    token.startsWith("zcode-cua@") ||
    token.startsWith("zcode-cua==") ||
    token.startsWith("zcode-cua.")
  );
}

// 上游 dMe：先小写，再把「字母.字母」折成「字母-字母」后重判。
function matchesCuaPackageTokenLoose(raw) {
  const lower = raw.toLowerCase().replace(/_/g, "-");
  if (matchesCuaPackageToken(lower)) return true;
  return matchesCuaPackageToken(lower.replace(/([a-z0-9])\.(?=[a-z0-9])/g, "$1-"));
}

// 上游 IQ：command / args / packageSpec 里有任何一个解析到 zcode-cua 包。
function resolvesToCuaPackage({ command, args, packageSpec }) {
  const tokens = [];
  const push = (value) => {
    if (!value) return;
    tokens.push(value);
    const base = trailingSegment(value);
    if (base !== value) tokens.push(base);
  };
  push(command);
  for (const arg of args ?? []) push(arg);
  push(packageSpec);
  return tokens.some(matchesCuaPackageTokenLoose);
}

// 上游 CN：server 名是否是 Computer Use（裸名，或官方命名空间 + 官方插件 id）。
function isCuaServerName(name, pluginId) {
  const normalized = name.trim().toLowerCase();
  if (normalized === COMPUTER_USE_SERVER_NAME) return true;
  return (
    normalized === OFFICIAL_CUA_SERVER_NAME &&
    pluginId?.trim().toLowerCase() === OFFICIAL_CUA_PLUGIN_ID
  );
}

// 上游 AN：正是官方命名空间 server，且 ZCODE_PLUGIN_ID 等于官方插件 id。
function isOfficialCuaPluginServer(server) {
  const withCommand = commandServerOf(server);
  if (!withCommand) return false;
  const name = ("name" in server && typeof server.name === "string" ? server.name : "")
    .trim()
    .toLowerCase();
  if (name !== OFFICIAL_CUA_SERVER_NAME) return false;
  const pluginId = envEntriesOf(withCommand.env)
    .find((entry) => entry.name === PLUGIN_ID_ENV_KEY)
    ?.value.trim()
    .toLowerCase();
  return pluginId === OFFICIAL_CUA_PLUGIN_ID;
}

// 上游 tp：看起来是 Computer Use 的 agent MCP server（名字、包标识、命令行三者任一）。
export function isPotentialZCodeCuaAgentMcpServer(server) {
  const withCommand = commandServerOf(server);
  if (!withCommand) return false;
  const name = "name" in server && typeof server.name === "string" ? server.name : "";
  if (name.trim().toLowerCase().startsWith("plugin:")) {
    const env = envEntriesOf(withCommand.env);
    const pluginId = env.find((entry) => entry.name === PLUGIN_ID_ENV_KEY)?.value;
    if (isCuaServerName(name, pluginId)) return true;
    const packageSpec = env.find((entry) => entry.name === CUA_PACKAGE_SPEC_ENV_KEY)?.value;
    if (packageSpec && matchesCuaPackageTokenLoose(packageSpec)) return true;
  } else if (name && isCuaServerName(name)) {
    return true;
  }
  if (matchesCuaPackageToken(withCommand.command)) return true;
  return stringArgsOf(withCommand.args).some(matchesCuaPackageToken);
}

// 上游 BQ：把 `--permission-broker-socket <value>` 插到 `--` 之前，覆盖旧值。
function upsertPermissionBrokerSocketFlag(args, socketPath) {
  const separatorIndex = args.indexOf("--");
  const head = separatorIndex === -1 ? args.slice() : args.slice(0, separatorIndex);
  const tail = separatorIndex === -1 ? [] : args.slice(separatorIndex);
  const kept = [];
  for (let index = 0; index < head.length; index += 1) {
    const arg = head[index];
    if (arg === PERMISSION_BROKER_SOCKET_FLAG) {
      const next = head[index + 1];
      if (next !== undefined && next !== "--" && !next.startsWith("--")) index += 1;
      continue;
    }
    if (arg?.startsWith(`${PERMISSION_BROKER_SOCKET_FLAG}=`)) continue;
    kept.push(arg);
  }
  args.splice(0, args.length, ...kept, PERMISSION_BROKER_SOCKET_FLAG, socketPath, ...tail);
}

// 上游 LI：这个 server 正是官方 CUA server，且携带给定的 pluginAuthority。
function serverCarriesAuthority(server, pluginAuthority) {
  const authority = pluginAuthority?.trim();
  if (!authority || !isOfficialCuaPluginServer(server)) return false;
  return envEntriesOf(server.env).some(
    (entry) => entry.name === PLUGIN_AUTHORITY_ENV_KEY && entry.value === authority,
  );
}

// 上游 IMe：给单个 Computer Use server 注入 socket flag + 两个 env 键。
function injectOneServer(server, options) {
  if (!serverCarriesAuthority(server, options.pluginAuthority)) return server;
  const socketPath = options.socketPath ?? "";
  if (!socketPath.trim()) {
    throw new Error(
      "injectPermissionBrokerAgentMcpServers requires a non-empty socketPath",
    );
  }
  const args = stringArgsOf(server.args);
  upsertPermissionBrokerSocketFlag(args, socketPath);
  const refreshMarker = cuaBrokerRefreshMarkerPath(socketPath);
  let env = upsertEnvEntry(envEntriesOf(server.env), BROKER_SOCKET_ENV, socketPath);
  if (refreshMarker) env = upsertEnvEntry(env, REFRESH_MARKER_ENV_KEY, refreshMarker);
  return { ...server, args, env };
}

// 上游 FQ。
export function injectPermissionBrokerAgentMcpServers(servers, options) {
  if (!servers || servers.length === 0 || !options?.pluginAuthority?.trim()) return servers;
  const injected = servers.map((server) => injectOneServer(server, options));
  return injected.some((server, index) => server !== servers[index]) ? injected : servers;
}

// 上游 bMe：声明了 zcode-cua 包却没有 broker socket 的 server —— 留着只会让模型
// 看到一套永远连不上的工具，统一剔除。
function isCuaServerWithoutBrokerSocket(server) {
  const withCommand = commandServerOf(server);
  if (!withCommand) return false;
  const env = envEntriesOf(withCommand.env);
  const packageSpec = env.find((entry) => entry.name === CUA_PACKAGE_SPEC_ENV_KEY)?.value;
  if (
    !resolvesToCuaPackage({
      command: withCommand.command,
      args: stringArgsOf(withCommand.args),
      packageSpec,
    })
  ) {
    return false;
  }
  return !env.find((entry) => entry.name === BROKER_SOCKET_ENV)?.value?.trim();
}

// 上游 LQ：剔除「像 CUA 但没有 broker socket」的 server。
function stripUninjectedCuaServers(servers) {
  if (!servers || servers.length === 0) return servers;
  const kept = servers.filter((server) => !isCuaServerWithoutBrokerSocket(server));
  return kept.length === servers.length ? servers : kept;
}

// 上游 mb / QNe / x7 / aw / e0e：按 host 记录「agent 侧 env 曾发布不可用代」，
// 用来保证 restart 的 beforeFreshStart 回调早于 fresh helper 上线。
const helperAdmissionByHost = new WeakMap();

function admissionStateOf(host) {
  let state = helperAdmissionByHost.get(host);
  if (!state) {
    state = { generation: 0, pendingGeneration: null };
    helperAdmissionByHost.set(host, state);
  }
  return state;
}

export function markCuaProductHelperAgentEnvUnavailable(host) {
  const state = admissionStateOf(host);
  state.generation += 1;
  state.pendingGeneration = state.generation;
  return state.generation;
}

export function hasCuaProductHelperAgentEnvUnavailable(host) {
  return (helperAdmissionByHost.get(host)?.pendingGeneration ?? null) !== null;
}

export function clearCuaProductHelperAgentEnvUnavailable(host) {
  const state = helperAdmissionByHost.get(host);
  if (!state || state.pendingGeneration === null) return false;
  state.pendingGeneration = null;
  return true;
}

// 上游 E7：等待启动完成，超时抛 caller_timeout（10s）。
export async function waitForCuaHelperStartup(startup, deadlineMs = DEFAULT_HELPER_STARTUP_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      startup,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new CuaHelperError(
              "caller_timeout",
              `ZCode Computer Use is still starting after ${deadlineMs}ms; retry the task shortly`,
            ),
          );
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isScreenCaptureProbeSuccess(probe) {
  return probe?.ok === true;
}

/**
 * 移植自官方 createCuaProductMcpServerResolver。
 *
 * 三段职责：
 * 1. resolveMcpServers —— 每次解析 agent 的 MCP server 列表时确保 helper 在线，
 *    只把 socket/authority 注入到*官方* Computer Use server，其余 CUA-like server 剔除。
 * 2. restart / restartAfterPermissionGrant —— 不重启 agent，只重启 helper；重启期间
 *    先发布 unavailable 代，避免 agent 拿到一个新 socket 却还连着旧 transport。
 * 3. reconcileRecoveredHelper —— 上一次 restart 半途失败时，在下一次解析边界收口。
 */
export function createCuaProductMcpServerResolver(host, options = {}) {
  let startPromise = null;
  let restartPromise = null;
  let permissionRestartPromise = null;
  let reconcilePromise = null;
  let anonymousGrantSeq = 0;
  let grantChain = Promise.resolve();
  const grantInFlight = new Map();
  const settledGrants = new Set();

  function startHelper() {
    if (permissionRestartPromise) return permissionRestartPromise.then((result) => result.handle);
    if (startPromise) return startPromise;
    const pending = host.start().finally(() => {
      if (startPromise === pending) startPromise = null;
    });
    startPromise = pending;
    return pending;
  }

  function restartForPermission(onBeforeFreshStart) {
    let published = false;
    const beforeFreshStart = () => {
      if (published) return;
      published = true;
      onBeforeFreshStart();
    };
    const restart = host.restartAfterCurrentStartPreservingTransport
      ? host.restartAfterCurrentStartPreservingTransport({ beforeFreshStart })
      : Promise.resolve().then(() => {
          beforeFreshStart();
          return host.restartAfterCurrentStart().then((handle) => ({ handle, reused: false }));
        });
    return restart.then((result) => {
      if (!result.reused && !published) {
        throw new CuaHelperError(
          "launch_failed",
          "Computer Use Helper fresh permission restart launched before the unavailable generation was published",
        );
      }
      return result;
    });
  }

  function restartHelper() {
    if (permissionRestartPromise) return permissionRestartPromise.then((result) => result.handle);
    if (restartPromise) return restartPromise;
    const previous = permissionRestartPromise;
    const pending = Promise.resolve()
      .then(() => previous?.catch(() => {}))
      .then(() => restartForPermission(() => markCuaProductHelperAgentEnvUnavailable(host)))
      .then((result) => result.handle)
      .finally(() => {
        if (restartPromise === pending) restartPromise = null;
      });
    restartPromise = pending;
    return pending;
  }

  function restartHelperAfterPermissionGrant() {
    if (permissionRestartPromise) return permissionRestartPromise;
    const previous = restartPromise;
    const pending = Promise.resolve()
      .then(() => previous?.catch(() => {}))
      .then(() => restartForPermission(() => markCuaProductHelperAgentEnvUnavailable(host)))
      .finally(() => {
        if (permissionRestartPromise === pending) permissionRestartPromise = null;
      });
    permissionRestartPromise = pending;
    return pending;
  }

  function currentLifecyclePromise() {
    if (permissionRestartPromise) {
      return permissionRestartPromise.then((result) => result.handle);
    }
    return restartPromise ?? startPromise;
  }

  function readLiveHelperTuple() {
    const running = host.running;
    const socketPath = host.socketPath;
    const pluginAuthority = host.pluginAuthority;
    if (!running || !socketPath || !pluginAuthority) return null;
    return { socketPath, pluginAuthority };
  }

  function helperTupleChanged(previous) {
    const current = readLiveHelperTuple();
    return (
      current !== null &&
      (current.socketPath !== previous.socketPath ||
        current.pluginAuthority !== previous.pluginAuthority)
    );
  }

  // 上一次 restart 失败留下的「已发布不可用代」在下一次解析边界收口：等 lifecycle
  // 落定后清掉 pending，必要时重新拉起 helper。
  async function reconcileSpawnAdmissionIfNeeded() {
    for (;;) {
      if (!reconcilePromise) {
        if (!hasCuaProductHelperAgentEnvUnavailable(host)) return;
        reconcilePromise = (async () => {
          for (;;) {
            const lifecycle = currentLifecyclePromise();
            if (lifecycle) {
              await waitForCuaHelperStartup(lifecycle);
              continue;
            }
            const pending = helperAdmissionByHost.get(host)?.pendingGeneration ?? null;
            if (pending === null) return;
            if (readLiveHelperTuple()) {
              clearCuaProductHelperAgentEnvUnavailable(host);
            }
            return;
          }
        })().finally(() => {
          reconcilePromise = null;
        });
      }
      await reconcilePromise;
      if (!hasCuaProductHelperAgentEnvUnavailable(host)) return;
    }
  }

  async function stabilizeHelperTuple() {
    for (;;) {
      const lifecycle = currentLifecyclePromise();
      if (lifecycle) {
        try {
          await waitForCuaHelperStartup(lifecycle);
        } catch (error) {
          if (!hasCuaProductHelperAgentEnvUnavailable(host)) markCuaProductHelperAgentEnvUnavailable(host);
          throw error;
        }
        continue;
      }
      await reconcileSpawnAdmissionIfNeeded();
      if (currentLifecyclePromise() || hasCuaProductHelperAgentEnvUnavailable(host)) continue;
      const live = readLiveHelperTuple();
      if (live) return live;
      markCuaProductHelperAgentEnvUnavailable(host);
      throw new CuaHelperError(
        "launch_failed",
        "ZCode Computer Use lifecycle completed without a live broker credential tuple",
      );
    }
  }

  async function ensureHelperReady() {
    const live = readLiveHelperTuple();
    if (!currentLifecyclePromise() && live) {
      try {
        await host.checkHealth(1000);
      } catch {
        if (options.hasActiveTurn?.()) {
          throw new CuaHelperError(
            "restart_deferred_active_turn",
            "cua helper is unhealthy but an agent turn is active; deferring restart to the next request boundary",
          );
        }
        if (!currentLifecyclePromise() && !helperTupleChanged(live)) restartHelper();
      }
    } else if (!currentLifecyclePromise() && !live) {
      startHelper();
    }
    return stabilizeHelperTuple();
  }

  async function resolveMcpServersImpl(servers) {
    const candidates = servers?.filter(isPotentialZCodeCuaAgentMcpServer);
    if (!servers || !candidates?.length) {
      if (!host.running) return servers;
      try {
        await ensureHelperReady();
      } catch {
        /* helper 起不来时保留原列表，交由调用方观察到的运行时错误处理 */
      }
      return servers;
    }
    const authority = host.pluginAuthority ?? undefined;
    if (!candidates.some((server) => isOfficialCuaPluginServer(server) && serverCarriesAuthority(server, authority))) {
      return servers.filter((server) => !isPotentialZCodeCuaAgentMcpServer(server));
    }
    let tuple;
    try {
      tuple = await ensureHelperReady();
    } catch {
      if (!hasCuaProductHelperAgentEnvUnavailable(host)) markCuaProductHelperAgentEnvUnavailable(host);
      return servers.filter((server) => !isPotentialZCodeCuaAgentMcpServer(server));
    }
    const injectable = servers.filter(
      (server) => !isPotentialZCodeCuaAgentMcpServer(server) || serverCarriesAuthority(server, tuple.pluginAuthority),
    );
    return injectPermissionBrokerAgentMcpServers(injectable, tuple);
  }

  async function restartAfterPermissionGrant(onboardingSessionId) {
    const key = onboardingSessionId?.trim() || `anonymous-grant-${++anonymousGrantSeq}`;
    if (settledGrants.has(key)) return;
    const inFlight = grantInFlight.get(key);
    if (inFlight) return inFlight;
    const previous = grantChain;
    const pending = Promise.resolve()
      .then(() => previous.catch(() => {}))
      .then(async () => {
        await restartHelperAfterPermissionGrant();
        await reconcileSpawnAdmissionIfNeeded();
        settledGrants.add(key);
        if (settledGrants.size > 64) {
          const oldest = settledGrants.values().next().value;
          if (oldest) settledGrants.delete(oldest);
        }
      })
      .finally(() => {
        if (grantInFlight.get(key) === pending) grantInFlight.delete(key);
      });
    grantInFlight.set(key, pending);
    grantChain = pending.catch(() => {});
    return pending;
  }

  return {
    async resolveMcpServers(servers) {
      return stripUninjectedCuaServers(await resolveMcpServersImpl(servers));
    },
    async restart() {
      await restartHelper();
      await reconcileSpawnAdmissionIfNeeded();
    },
    async restartAfterPermissionGrant(onboardingSessionId) {
      await restartAfterPermissionGrant(onboardingSessionId);
    },
    async reconcileRecoveredHelper() {
      if (currentLifecyclePromise()) return;
      if (hasCuaProductHelperAgentEnvUnavailable(host) && readLiveHelperTuple()) {
        await reconcileSpawnAdmissionIfNeeded();
      }
    },
  };
}

export function isOfficialCuaPluginEnabledForWorkspace(options = {}) {
  const env = options.env ?? process.env;
  if (env.ZCODE_CUA_PRODUCT_HELPER === "1") return true;
  if (env.ZCODE_CUA_PRODUCT_HELPER === "0") return false;
  // 与 node.ts 的 isZCodeCuaInternalFeatureEnabled 门控对齐：内部 dev 特性开启即启用。
  if (env.ZCODE_CUA_DEV_MODE === "1") return true;
  // 生产路径：用户级 config.json 里的官方 Computer Use 插件开关。
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) return false;
  const configPath = join(home, ".zcode", "cli", "config.json");
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return false;
  }
  if (!config || typeof config !== "object") return false;
  const computerUse = config.computerUse;
  return (
    computerUse === true ||
    (typeof computerUse === "object" && computerUse !== null && computerUse.enabled === true)
  );
}

export async function reapOrphanedHelpers(options = {}) {
  // 按 launcher pid 清理孤儿 helper：helper 自带 --parent-pid 看门狗，但父进程被
  // 强杀时看门狗可能晚到。best-effort，绝不抛错阻塞启动。
  if (process.platform !== "win32") return;
  let pids = [];
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='zcode.exe'\" | " +
            "Where-Object { $_.CommandLine -match 'windows-helper.js' } | " +
            "ForEach-Object { $p = Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue; " +
            "if (-not $p) { Write-Output $_.ProcessId } }",
        ],
        { timeout: 10_000, windowsHide: true },
        (error, out) => (error && !out ? reject(error) : resolve(String(out ?? ""))),
      );
    });
    pids = stdout
      .split(/\r?\n/u)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    if (pids.length > 0) {
      const args = ["/T", "/F", ...pids.flatMap((pid) => ["/PID", String(pid)])];
      await new Promise((resolve) => {
        execFile("taskkill.exe", args, { timeout: 10_000, windowsHide: true }, () => resolve());
      });
    }
  } catch (error) {
    options.logger?.warn?.(
      undefined,
      "Orphaned Windows CUA helper reaper failed",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return;
  }
  if (pids.length > 0) {
    options.logger?.info?.(undefined, "Reaped orphaned Windows CUA helper processes", {
      pids,
    });
  }
}

export async function requestHelperAccessibilityPermissionViaLaunchServices(options = {}) {
  // Windows 无 LaunchServices/TCC：无权限需要请求，语义化成功 no-op。
  if ((options.platform ?? process.platform) === "win32") return { ok: true };
  return { ok: false, reason: UNAVAILABLE };
}

export async function requestHelperScreenRecordingPermissionViaLaunchServices(options = {}) {
  if ((options.platform ?? process.platform) === "win32") return { ok: true };
  return { ok: false, reason: UNAVAILABLE };
}