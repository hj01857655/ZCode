/**
 * ClientRequestSigningV4 Manager + KeyCache（发行版 R_t/A_t/Wgt 语义）：
 * 按 providerId 管理 signer scope，按 apiKey 缓存 keyState（跨 signer 复用，epoch 共享）。
 */
import { ClientRequestSigningV4Signer, newKeyState, type KeyState, type SigningObserver, type Transport } from "./signer.js";

export interface ManagerInput {
  apiKey: string;
  baseURL: string;
  clientVersion?: string;
  providerId: string;
}

export class ClientRequestSigningV4KeyCache {
  private entries = new Map<string, Map<string, KeyState>>();

  resolve(apiKey: string, handshakeUrl: string): KeyState {
    let perKey = this.entries.get(apiKey);
    if (!perKey) {
      perKey = new Map();
      this.entries.set(apiKey, perKey);
    }
    const origin = new URL(handshakeUrl).origin;
    let state = perKey.get(origin);
    if (state) return state;
    state = newKeyState();
    perKey.set(origin, state);
    return state;
  }
}

export class ClientRequestSigningV4Manager {
  private scopes = new Map<string, { disposed: boolean; signer?: ClientRequestSigningV4Signer; entry?: ManagerInput }>();
  private readonly allowInsecureHttp: boolean;
  private readonly keyCache: ClientRequestSigningV4KeyCache;
  private readonly observer?: SigningObserver;

  constructor(opts: { allowInsecureHttp?: boolean; keyCache?: ClientRequestSigningV4KeyCache; observer?: SigningObserver } = {}) {
    this.allowInsecureHttp = opts.allowInsecureHttp ?? false;
    this.keyCache = opts.keyCache ?? new ClientRequestSigningV4KeyCache();
    this.observer = opts.observer;
  }

  /** 创建受签名保护的 fetch（发行版 createFetch）。 */
  createFetch(input: ManagerInput, transport: Transport): (url: string, init: Parameters<Transport>[1]) => Promise<Response> {
    const scope = { ...input };
    let entry = this.scopes.get(scope.providerId);
    if (!entry) {
      entry = { disposed: false };
      this.scopes.set(scope.providerId, entry);
    }
    const scopeRef = entry;
    return async (url, init) => {
      if (scopeRef.disposed) {
        throw new Error("Client request signer has been disposed.");
      }
      return this.resolveSigner(scopeRef, scope, transport).request({ ...init, url } as never);
    };
  }

  dispose(providerId?: string): void {
    if (providerId) {
      const scope = this.scopes.get(providerId);
      if (scope) {
        scope.disposed = true;
        scope.signer?.dispose();
        this.scopes.delete(providerId);
      }
      return;
    }
    for (const scope of this.scopes.values()) {
      scope.disposed = true;
      scope.signer?.dispose();
    }
    this.scopes.clear();
  }

  private resolveSigner(
    scope: { disposed: boolean; signer?: ClientRequestSigningV4Signer; entry?: ManagerInput },
    input: ManagerInput,
    transport: Transport,
  ): ClientRequestSigningV4Signer {
    scope.signer?.dispose();
    const signer = new ClientRequestSigningV4Signer(
      input,
      transport,
      { allowInsecureHttp: this.allowInsecureHttp, keyCache: this.keyCache, observer: this.observer },
    );
    scope.signer = signer;
    scope.entry = input;
    return signer;
  }
}

export type { KeyState, SigningObserver, Transport };
