/**
 * ClientRequestSigningV4 Signer（发行版 lCn 完整状态机）：
 * origin 校验 → bypass → 握手取私钥 → 签名发送 → 验签失败两次进入永久旁路。
 */
import {
  createClientRequestProofOfWork,
  createHandshakeSignature,
  decryptSigningPrivateKey,
  signBusinessMessage,
  randomHex,
  GET_SIGN_KEY,
  APP_ID,
} from "./primitives.js";
import {
  ClientRequestSigningV4Error,
  extractVerifyRejectReason,
  isFailOpenEligible,
  makeSigningError,
  VERIFY_SIGNATURE_INVALID,
  VERIFY_APIKEY_EXPIRED,
} from "./error.js";
import { resolveSigningCredential, type SigningCredential } from "./credential.js";

const HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";
const HANDSHAKE_TIMEOUT_MS = 10_000;
const POW_BITS = 8;
const NONCE_BYTES = 16;
/** 验签拒绝后重签次数上限（发行版：第 2 次失败进入 bypass）。 */
const MAX_SIGNED_ATTEMPTS = 2;

/** 签名涉及的请求头（发送前摘除防透传，发行版 S4s）。 */
const SIGNED_HEADERS = [
  "X-Client-Ts",
  "X-Client-Version",
  "X-Client-Sig",
  "X-Client-Nonce",
  "X-Client-Pow",
  "X-App-Id",
  "X-Client-Sign-Verified",
] as const;

export interface SigningTransportRequest {
  url: string;
  method?: string;
  headers?: Record<string, string> | Headers;
  body?: Uint8Array;
  signal?: AbortSignal;
  [extra: string]: unknown;
}

export type Transport = (
  url: string,
  init: RequestInit & { timeoutMs?: number },
) => Promise<Response>;

export interface SigningObserver {
  (observation: {
    observation:
      | { kind: "signed_sent"; signedAttempt: number }
      | { kind: "unsigned_sent"; reason: string }
      | { kind: "verify_rejected"; reason: string; signedAttempt: number }
      | { kind: "handshake_failed"; errorKind: string; httpStatus?: number; businessCode?: number; reason?: string }
      | { kind: "request_failed_closed"; errorKind: string }
      | { kind: "bypass_entered" };
    providerId: string;
    requestId?: string;
    sessionId?: string;
  }): void;
}

export interface KeyState {
  epoch: number;
  privateKey?: CryptoKey;
  handshakePromise?: Promise<CryptoKey>;
}

export function newKeyState(): KeyState {
  return { epoch: 0 };
}

function stripSignedHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of headers.entries()) {
    if (!SIGNED_HEADERS.some((name) => name.toLowerCase() === key.toLowerCase())) {
      out.set(key, value);
    }
  }
  return out;
}

export class ClientRequestSigningV4Signer {
  private readonly apiKey: string;
  private readonly clientVersion: string;
  private readonly handshakeUrl: string;
  private readonly businessOrigin: string;
  private readonly keyState: KeyState;
  private readonly ownsKeyState: boolean;
  private readonly transport: Transport;
  private readonly observer?: SigningObserver;
  private readonly providerId: string;
  private credential?: SigningCredential;
  private activeRequestCount = 0;
  private bypassSigning = false;
  private disposed = false;
  private disposeRequested = false;

  constructor(
    input: { apiKey: string; clientVersion?: string; baseURL: string; providerId: string },
    transport: Transport,
    opts: { allowInsecureHttp?: boolean; keyCache?: { resolve(apiKey: string, handshakeUrl: string): KeyState }; observer?: SigningObserver } = {},
  ) {
    this.apiKey = input.apiKey;
    this.clientVersion = input.clientVersion?.trim() || "v4";
    this.handshakeUrl = this.resolveHandshakeUrl(input.baseURL, opts.allowInsecureHttp ?? false);
    this.businessOrigin = new URL(this.handshakeUrl).origin;
    this.keyState = opts.keyCache?.resolve(this.apiKey, this.handshakeUrl) ?? newKeyState();
    this.ownsKeyState = !opts.keyCache;
    this.transport = transport;
    this.observer = opts.observer;
    this.providerId = input.providerId;
  }

  private resolveHandshakeUrl(baseURL: string, allowInsecureHttp: boolean): string {
    let url: URL;
    try {
      url = new URL(baseURL);
    } catch (cause) {
      throw makeSigningError("invalid-config", "Client signing requires a valid baseURL.", { cause });
    }
    if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
      throw makeSigningError("invalid-config", "Client signing handshake requires HTTPS.");
    }
    return new URL(HANDSHAKE_PATH, url.origin).toString();
  }

  dispose(): void {
    if (this.disposeRequested || this.disposed) return;
    this.disposeRequested = true;
    if (this.activeRequestCount > 0) return;
    this.finalizeDispose();
  }

  private beginRequest(): void {
    if (this.disposeRequested || this.disposed) {
      throw makeSigningError("disposed", "Client request signer has been disposed.");
    }
    this.activeRequestCount += 1;
  }

  private endRequest(): void {
    this.activeRequestCount -= 1;
    if (this.activeRequestCount === 0 && this.disposeRequested) this.finalizeDispose();
  }

  private finalizeDispose(): void {
    this.disposed = true;
    if (this.ownsKeyState) {
      this.keyState.epoch += 1;
      this.keyState.privateKey = undefined;
      this.keyState.handshakePromise = undefined;
    }
  }

  private observe(
    request: SigningTransportRequest | undefined,
    observation: Parameters<SigningObserver>[0]["observation"],
  ): void {
    if (!this.observer) return;
    const headers = request?.headers;
    const requestId =
      headers instanceof Headers ? headers.get("x-request-id")?.trim() || undefined : undefined;
    const sessionId =
      headers instanceof Headers ? headers.get("x-session-id")?.trim() || undefined : undefined;
    try {
      this.observer({
        observation,
        providerId: this.providerId,
        ...(requestId ? { requestId } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
    } catch {
      // observer 异常不影响主流程
    }
  }

  /** 主入口：签名请求状态机（发行版 request）。 */
  async request(request: SigningTransportRequest): Promise<Response> {
    this.beginRequest();
    let normalized: SigningTransportRequest | undefined;
    try {
      normalized = this.normalizeRequest(request);
      if (new URL(normalized.url).origin !== this.businessOrigin) {
        return await this.sendUnsigned(normalized, "origin_mismatch");
      }
      if (this.bypassSigning) {
        return await this.sendUnsigned(normalized, "bypass");
      }
      let privateKey = await this.getKeyOrSendUnsigned(normalized);
      if (privateKey instanceof Response) return privateKey;

      const first = await this.sendSigned(normalized, privateKey, 1);
      const firstReason = await this.extractVerifyRejection(first);
      if (!firstReason) return first;

      this.observe(normalized, { kind: "verify_rejected", reason: firstReason, signedAttempt: 1 });
      this.invalidatePrivateKey();
      privateKey = await this.getKeyOrSendUnsigned(normalized);
      if (privateKey instanceof Response) return privateKey;

      const second = await this.sendSigned(normalized, privateKey, 2);
      const secondReason = await this.extractVerifyRejection(second);
      if (secondReason) {
        this.observe(normalized, { kind: "verify_rejected", reason: secondReason, signedAttempt: 2 });
        this.invalidatePrivateKey();
        this.bypassSigning = true;
        this.observe(normalized, { kind: "bypass_entered" });
        return await this.sendUnsigned(normalized, "verify_refresh_exhausted");
      }
      return second;
    } catch (error) {
      if (
        error instanceof ClientRequestSigningV4Error &&
        !(normalized?.signal?.aborted)
      ) {
        this.observe(normalized, { kind: "request_failed_closed", errorKind: error.kind });
      }
      throw error;
    } finally {
      this.endRequest();
    }
  }

  private normalizeRequest(input: SigningTransportRequest): SigningTransportRequest {
    const headers = input.headers instanceof Headers ? input.headers : new Headers(input.headers);
    return { ...input, headers: stripSignedHeaders(headers) };
  }

  private async sendUnsigned(request: SigningTransportRequest, reason: string): Promise<Response> {
    this.observe(request, { kind: "unsigned_sent", reason });
    return this.transport(request.url, this.mergeInit(request, request.headers as Headers));
  }

  private async sendSigned(
    request: SigningTransportRequest,
    privateKey: CryptoKey,
    attempt: number,
  ): Promise<Response> {
    const credential = this.resolveCredential();
    const headers = request.headers as Headers;
    const sessionId = headers.get("X-Session-Id")?.trim();
    if (!sessionId) {
      throw makeSigningError("invalid-config", "Client request signing requires X-Session-Id.");
    }
    const ts = String(Date.now());
    const nonce = randomHex(NONCE_BYTES);
    const pow = await createClientRequestProofOfWork({
      apiKeyId: credential.apiKeyId,
      appId: APP_ID,
      powBits: POW_BITS,
      sessionId,
      signal: request.signal,
      ts,
    });
    const sig = await signBusinessMessage(
      privateKey,
      `${credential.apiKeyId}\n${ts}\n${this.clientVersion}\n${sessionId}\n${pow}`,
    );
    headers.set("X-Client-Ts", ts);
    headers.set("X-Client-Version", this.clientVersion);
    headers.set("X-Client-Sig", sig);
    headers.set("X-Session-Id", sessionId);
    headers.set("X-Client-Nonce", nonce);
    headers.set("X-App-Id", APP_ID);
    headers.set("X-Client-Pow", pow);
    this.observe(request, { kind: "signed_sent", signedAttempt: attempt });
    return this.transport(request.url, this.mergeInit(request, headers));
  }

  private mergeInit(request: SigningTransportRequest, headers: Headers): RequestInit & { timeoutMs?: number } {
    return {
      ...(request.body ? { body: request.body.slice() } : {}),
      method: request.method,
      signal: request.signal,
      headers,
    } as RequestInit & { timeoutMs?: number };
  }

  private invalidatePrivateKey(): void {
    this.keyState.epoch += 1;
    this.keyState.privateKey = undefined;
    this.keyState.handshakePromise = undefined;
  }

  private async getKeyOrSendUnsigned(request: SigningTransportRequest): Promise<CryptoKey | Response> {
    try {
      return await this.ensurePrivateKey(request);
    } catch (error) {
      if (isFailOpenEligible(error)) {
        return this.sendUnsigned(request, "handshake_failed");
      }
      throw error;
    }
  }

  private async ensurePrivateKey(request: SigningTransportRequest): Promise<CryptoKey> {
    const signal = request.signal;
    if (this.disposed) {
      throw makeSigningError("disposed", "Client request signer has been disposed.");
    }
    if (this.keyState.privateKey) return this.keyState.privateKey;
    this.resolveCredential();
    if (this.keyState.handshakePromise) return this.keyState.handshakePromise;

    const epoch = this.keyState.epoch;
    const handshake = this.performHandshake()
      .catch((error: unknown) => {
        if (error instanceof ClientRequestSigningV4Error) {
          this.observe(request, {
            kind: "handshake_failed",
            errorKind: error.kind,
            ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
            ...(error.businessCode !== undefined ? { businessCode: error.businessCode } : {}),
            ...(error.reason ? { reason: error.reason } : {}),
          });
        }
        throw error;
      })
      .then((key: CryptoKey) => {
        if ((this.ownsKeyState && this.disposed) || this.keyState.epoch !== epoch) {
          throw makeSigningError("disposed", "Client request signer changed during handshake.");
        }
        this.keyState.privateKey = key;
        return key;
      });
    this.keyState.handshakePromise = handshake;
    return handshake;
  }

  private async performHandshake(): Promise<CryptoKey> {
    const credential = this.resolveCredential();
    const ts = String(Date.now());
    const nonce = randomHex(NONCE_BYTES);
    let sig: string;
    try {
      sig = await createHandshakeSignature(credential.secret, `${GET_SIGN_KEY}\n${credential.apiKeyId}\n${ts}\n${nonce}`);
    } catch (cause) {
      throw makeSigningError("cryptography", "Client signing handshake signature failed.", {
        cause,
        failOpenEligible: true,
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await this.transport(this.handshakeUrl, {
          body: new TextEncoder().encode(
            JSON.stringify({ [credential.handshakeField]: credential.credential, nonce, sig, ts }),
          ),
          headers: { Authorization: credential.credential, "Content-Type": "application/json" },
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (cause) {
        const timedOut = controller.signal.aborted;
        throw makeSigningError(
          timedOut ? "handshake-timeout" : "handshake-network",
          timedOut ? "Client signing handshake timed out." : "Client signing handshake failed.",
          { cause, failOpenEligible: true },
        );
      }

      if (response.status !== 200) {
        throw makeSigningError("handshake-protocol", "Client signing handshake HTTP status is invalid.", {
          failOpenEligible: true,
          httpStatus: response.status,
        });
      }

      let envelope: { code?: number; msg?: string; data?: { privateCipher?: string } };
      try {
        envelope = (await response.json()) as typeof envelope;
      } catch (cause) {
        throw makeSigningError("handshake-protocol", "Client signing handshake JSON is invalid.", {
          cause,
          failOpenEligible: true,
        });
      }

      if (envelope.code === 500) {
        throw makeSigningError("handshake-server", "Client signing handshake reported code 500.", {
          businessCode: 500,
          failOpenEligible: true,
        });
      }
      if (envelope.code !== 200) {
        const reason = this.extractBusinessReason(envelope);
        throw makeSigningError("handshake-business", "Client signing handshake was rejected.", {
          ...(typeof envelope.code === "number" ? { businessCode: envelope.code } : {}),
          failOpenEligible: true,
          reason,
        });
      }

      const privateCipher = envelope.data?.privateCipher;
      if (typeof privateCipher !== "string" || !privateCipher) {
        throw makeSigningError("handshake-protocol", "Client signing handshake omitted privateCipher.", {
          failOpenEligible: true,
        });
      }
      try {
        return await decryptSigningPrivateKey(credential.apiKeyId, credential.secret, privateCipher);
      } catch (cause) {
        throw makeSigningError("cryptography", "Client signing private key is invalid.", {
          cause,
          failOpenEligible: true,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private extractBusinessReason(envelope: { msg?: string }): string | undefined {
    const candidates = [envelope.msg];
    return candidates.find(
      (v) => v === VERIFY_SIGNATURE_INVALID || v === VERIFY_APIKEY_EXPIRED,
    );
  }

  private async extractVerifyRejection(response: Response): Promise<string | undefined> {
    if (response.status !== 401) return undefined;
    try {
      const body = await response.clone().json();
      return extractVerifyRejectReason(body);
    } catch {
      return undefined;
    }
  }

  private resolveCredential(): SigningCredential {
    if (this.credential) return this.credential;
    const parsed = resolveSigningCredential(this.apiKey);
    if (!parsed) {
      throw makeSigningError("invalid-config", "Client request signing requires a valid API key.");
    }
    this.credential = parsed;
    return parsed;
  }
}

export { MAX_SIGNED_ATTEMPTS };
