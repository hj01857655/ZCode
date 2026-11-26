import {
  NodeModelSelectionConfigRepository,
  createNodeModelSelectionFacade,
} from "@zcode/provider-node";
import {
  ProviderRegistryService,
  ProviderSettingsFacade,
  createFailClosedAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSettingsMutationTarget,
  type ProviderSource,
} from "@zcode/provider";
import {
  createProviderConfigRuntime,
  type ProviderConfigRuntime,
  type ProviderConfigRuntimeOptions,
} from "./providerConfigRuntime.js";
import {
  createModelSelectionService,
  createProviderSettingsService,
  type FetchProviderModelIdsRequest,
  type IModelSelectionService,
  type IProviderSettingsService,
  type ModelSelectionConfiguredDefaultSource,
  type ProviderModelListTester,
  type ProviderSettingsConnectivityTester,
} from "./providerFacadeServices.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const log = createServiceLogger("provider-runtime");

export interface ProviderRuntimeOptions extends ProviderConfigRuntimeOptions {
  readonly accountSource?: RefreshableProviderSource<AccountProviderConfigSnapshot>;
  readonly testConnectivity?: ProviderSettingsConnectivityTester;
  readonly fetchModelList?: ProviderModelListTester;
}

export interface ProviderRuntimeDependencies {
  readonly configRuntime: ProviderConfigRuntime;
  readonly accountSource?: RefreshableProviderSource<AccountProviderConfigSnapshot>;
  readonly disposeAccountSource?: () => void;
  readonly testConnectivity?: ProviderSettingsConnectivityTester;
  readonly fetchModelList?: ProviderModelListTester;
  readonly modelSelectionConfiguredDefaultSource?: ModelSelectionConfiguredDefaultSource;
  readonly disposeModelSelectionConfiguredDefaultSource?: () => void;
}

interface RefreshableProviderSource<TSnapshot> extends ProviderSource<TSnapshot> {
  refresh?(reason: string): Promise<TSnapshot>;
}

/**
 * 普通 API Provider 可以在账号能力尚未装配时独立运行。
 * Account Provider 由当前 Built-in revision 对齐的 access.entitled=false Overlay 显式 fail-closed。
 */
export class EmptyAccountProviderConfigSource implements ProviderSource<AccountProviderConfigSnapshot> {
  constructor(readonly configSource: ProviderSource<ProviderConfigSnapshot>) {}

  async read(): Promise<AccountProviderConfigSnapshot> {
    return createFailClosedAccountProviderConfigSnapshot(await this.configSource.read());
  }

  onDidChange(): () => void {
    return () => {};
  }
}

/** 组装一个进程内共享的 Provider Config、Registry 与 Facade。 */
export class ProviderRuntime {
  readonly configService: ProviderConfigRuntime["configService"];
  readonly registryService: ProviderRegistryService;
  readonly providerSettings: IProviderSettingsService;
  readonly modelSelection: IModelSelectionService;
  readonly #configRuntime: ProviderConfigRuntime;
  readonly #disposeAccountSource?: () => void;
  readonly #disposeBuiltinRecovery: () => void;
  readonly #modelSelectionRuntime: IModelSelectionService & { dispose(): void };
  readonly #disposeModelSelectionConfiguredDefaultSource?: () => void;
  #startPromise: ReturnType<ProviderRegistryService["start"]> | null = null;
  #disposed = false;

  constructor(dependencies: ProviderRuntimeDependencies) {
    this.#configRuntime = dependencies.configRuntime;
    this.#disposeAccountSource = dependencies.disposeAccountSource;
    this.#disposeModelSelectionConfiguredDefaultSource =
      dependencies.disposeModelSelectionConfiguredDefaultSource;
    this.configService = this.#configRuntime.configService;
    const accountSource: RefreshableProviderSource<AccountProviderConfigSnapshot> =
      dependencies.accountSource ?? new EmptyAccountProviderConfigSource(this.configService);
    this.#disposeBuiltinRecovery = this.#configRuntime.onDidCheckZCodeBuiltin(async () => {
      const [config, account] = await Promise.all([
        this.configService.read(),
        accountSource.read(),
      ]);
      if (!this.#disposed && config.zcodeBuiltinRevision !== account.basedOnZCodeBuiltinRevision) {
        await accountSource.refresh?.("builtin-account-recovery");
      }
    });
    this.registryService = new ProviderRegistryService({
      configSource: this.configService,
      accountSource,
    });
    const mutations = createSettingsMutationTarget(
      this.#configRuntime,
      this.registryService,
      accountSource,
    );
    const ensureReady = () => this.start();
    const settingsFacade = new ProviderSettingsFacade(this.registryService, mutations);
    this.providerSettings = createProviderSettingsService(
      settingsFacade,
      ensureReady,
      dependencies.testConnectivity,
      // /models 请求必须由 Host 的 Node fetch 发出；renderer 直接请求用户 endpoint 会被 CORS/CSP 拦截。
      dependencies.fetchModelList ?? createProviderModelListFetcher(),
    );
    this.#modelSelectionRuntime = createModelSelectionService(
      createNodeModelSelectionFacade(this.registryService),
      ensureReady,
      dependencies.modelSelectionConfiguredDefaultSource,
    );
    this.modelSelection = this.#modelSelectionRuntime;
  }

  start(): Promise<void> {
    if (this.#disposed) throw new Error("ProviderRuntime 已 dispose");
    if (this.#startPromise) return this.#startPromise;
    const startPromise = this.#configRuntime.start().then(() => this.registryService.start());
    this.#startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeBuiltinRecovery();
    this.#modelSelectionRuntime.dispose();
    this.registryService.dispose();
    this.#disposeAccountSource?.();
    this.#disposeModelSelectionConfiguredDefaultSource?.();
    this.#configRuntime.dispose();
  }
}

const FETCH_MODEL_LIST_TIMEOUT_MS = 15_000;

/**
 * 在 Host 进程发起 provider /models 请求。renderer 带自定义鉴权头直接请求用户 endpoint
 * 会触发 preflight，而目标服务通常不返回 CORS 头，浏览器会拦掉；这里用 Node fetch 绕开该限制。
 */
export function createProviderModelListFetcher(): ProviderModelListTester {
  return async (input: FetchProviderModelIdsRequest) => {
    const response = await fetch(resolveModelsUrl(input.baseUrl), {
      headers: resolveModelListHeaders(input),
      signal: AbortSignal.timeout(FETCH_MODEL_LIST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`http-${response.status}`);
    const body: unknown = await response.json();
    const ids = extractModelIds(body);
    if (!ids) throw new Error("unexpected-response");
    return ids;
  };
}

function resolveModelsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("empty-base-url");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("invalid-base-url");
  }
  const path = url.pathname.replace(/\/+$/, "");
  // baseUrl 可能已经带 /v1 或其它版本段；保留已有版本段，缺省才补 /v1，
  // 否则会把 .../v1 改写成 .../models，或在已有版本段后叠出 /v1/v1。
  url.pathname = /\/models$/i.test(path)
    ? path
    : `${/\/v\d+$/i.test(path) ? path : `${path}/v1`}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function resolveModelListHeaders(input: FetchProviderModelIdsRequest): Record<string, string> {
  if (input.apiFormat === "anthropic-messages") {
    return {
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  return { Authorization: `Bearer ${input.apiKey}` };
}

function extractModelIds(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    const value =
      typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined;
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function createSettingsMutationTarget(
  configRuntime: ProviderConfigRuntime,
  registryService: ProviderRegistryService,
  accountSource: RefreshableProviderSource<AccountProviderConfigSnapshot>,
): ProviderSettingsMutationTarget {
  const configService = configRuntime.configService;
  return {
    createPersonalProvider: (input) => configService.createPersonalProvider(input),
    savePersonalProviderOverlay: (providerId, config, membership, metadata) =>
      configService.savePersonalProviderOverlay(providerId, config, membership, metadata),
    deletePersonalProvider: (providerId) => configService.deletePersonalProvider(providerId),
    reorderPersonalProviders: (providerIds) => configService.reorderPersonalProviders(providerIds),
    reorderPersonalModels: (providerId, modelIds, membership) =>
      configService.reorderPersonalModels(providerId, modelIds, membership),
    // 手工四参数转发曾丢掉新增的配置模式；直接绑定完整签名，避免装配层截断写入意图。
    addPersonalModel: configService.addPersonalModel.bind(configService),
    renamePersonalModel: (providerId, currentModelId, nextModelId, membership) =>
      configService.renamePersonalModel(providerId, currentModelId, nextModelId, membership),
    deletePersonalModel: (providerId, modelId, membership) =>
      configService.deletePersonalModel(providerId, modelId, membership),
    setPersonalModelEnabled: (providerId, modelId, enabled, membership) =>
      configService.setPersonalModelEnabled(providerId, modelId, enabled, membership),
    savePersonalModelDraft: (
      providerId,
      originalModelId,
      nextModelId,
      config,
      expectedPersonalRevision,
      useRecommendedConfig,
      membership,
    ) =>
      configService.savePersonalModelDraft(
        providerId,
        originalModelId,
        nextModelId,
        config,
        expectedPersonalRevision,
        useRecommendedConfig,
        membership,
      ),
    refresh: (reason) => registryService.refresh(reason),
    refreshSources: async (reason) => {
      const [builtinResult, accountResult] = await Promise.allSettled([
        configRuntime.refreshZCodeBuiltin({ force: true }),
        accountSource.refresh?.(reason) ?? Promise.resolve(),
      ]);
      // 远端更新失败不代表本地配置不可用；此前统一抛错会让套餐切换回滚，
      // 并掩盖真正的账号失败。只降级远端更新，Config/Registry 和权益错误仍保留。
      if (builtinResult.status === "rejected") {
        log.warn(undefined, "Builtin 远端更新失败，继续使用本地配置", {
          reason,
          error: builtinResult.reason,
        });
      }
      const snapshot = await registryService.refresh(reason);
      if (accountResult.status === "rejected") throw accountResult.reason;
      return snapshot;
    },
  };
}

export function createProviderRuntime(options: ProviderRuntimeOptions): ProviderRuntime {
  const { accountSource, testConnectivity, fetchModelList, ...configRuntimeOptions } = options;
  const configRuntime = createProviderConfigRuntime(configRuntimeOptions);
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: configRuntime.personalRepository,
  });
  return createProviderRuntimeFromConfigRuntime({
    configRuntime,
    accountSource,
    testConnectivity,
    fetchModelList,
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
  });
}

export function createProviderRuntimeFromConfigRuntime(
  dependencies: ProviderRuntimeDependencies,
): ProviderRuntime {
  return new ProviderRuntime(dependencies);
}
