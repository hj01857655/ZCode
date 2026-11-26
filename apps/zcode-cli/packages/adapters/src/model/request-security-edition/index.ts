import type { Logger, ModelRequestObservation } from "@zcode/contracts";
import type { ModelRequestSecurityPort, ModelRequestSecurityState } from "../request-security.js";
import {
  ClientRequestSigningV4Manager,
  ClientRequestSigningV4KeyCache,
  type SigningObserver,
} from "../client-signing/index.js";
import { RequestObservationStore, readRequestObservationId } from "../request-observations.js";

const ZAI_ROOT_DOMAIN = "z.ai";
const BIGMODEL_ROOT_DOMAIN = "bigmodel.cn";
const ZAI_FAMILY_ROOT_DOMAINS = [ZAI_ROOT_DOMAIN, BIGMODEL_ROOT_DOMAIN] as const;
const LEGACY_OFFICIAL_HOSTS = new Set(["api.chatglm.site", "zcode.chatglm.site"]);
const UNSIGNED_ACCESS_MODES = new Set(["start-plan", "off-peak", "highspeed"]);
const SIGNED_ACCESS_MODES = new Set(["individual-coding-plan", "team-coding-plan"]);

function resolveHostname(baseURL: string | undefined): string | undefined {
  if (!baseURL) return undefined;
  try {
    return new URL(baseURL).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isZaiFamilyRootDomain(hostname: string | undefined): boolean {
  if (!hostname) return false;
  return ZAI_FAMILY_ROOT_DOMAINS.some(
    (rootDomain) => hostname === rootDomain || hostname.endsWith(`.${rootDomain}`),
  );
}

function readClientVersion(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "x-zcode-app-version",
  );
  return entry?.[1]?.trim() || undefined;
}

function requiresClientRequestSigning(input: {
  access: { type: string; mode?: string };
  baseURL: string | undefined;
}): boolean {
  const { access, baseURL } = input;
  if (access.type === "zhipu-account" && access.mode && UNSIGNED_ACCESS_MODES.has(access.mode)) {
    return false;
  }
  if (
    access.type === "zhipu-coding-plan-api-key" ||
    (access.type === "zhipu-account" && access.mode && SIGNED_ACCESS_MODES.has(access.mode)) ||
    isZaiFamilyRootDomain(resolveHostname(baseURL))
  ) {
    return true;
  }
  const hostname = resolveHostname(baseURL);
  return hostname !== undefined && LEGACY_OFFICIAL_HOSTS.has(hostname);
}

export function createModelRequestSecurityState(): ModelRequestSecurityState {
  // 共享 keyCache，跨 execution 复用 keyState/epoch；观测按 execution 独立归属 requestId。
  const keyCache = new ClientRequestSigningV4KeyCache();
  let disposed = false;

  return {
    createExecution: ({ logger }: { logger?: Logger } = {}) => {
      const observations = new RequestObservationStore();
      const recordedUnsignedProviders = new Set<string>();
      const writeObservation = (observation: ModelRequestObservation, level: "debug" | "info" = "debug") => {
        if (level === "info") logger?.info?.("Client request signing observation", observation);
        else logger?.debug?.("Client request signing observation", observation);
      };
      const observer: SigningObserver = ({ observation, providerId, requestId }) => {
        if (requestId) {
          observations.record(requestId, { ...observation });
        }
        writeObservation({ ...observation, event: `model.client_signing.${observation.kind}`, providerId, requestId });
      };
      const createAccessModeUnsignedFetch = (providerId: string, transport: typeof globalThis.fetch) => {
        return (input: RequestInfo | URL, init?: RequestInit) => {
          const requestId = readRequestObservationId(input, init);
          const observation = { kind: "unsigned_sent", reason: "access_mode" } as const;
          if (requestId) {
            observations.record(requestId, observation);
          }
          if (!recordedUnsignedProviders.has(providerId)) {
            recordedUnsignedProviders.add(providerId);
            logger?.info?.("Client request signing skipped by provider access mode", {
              event: "model.client_signing.unsigned_sent",
              providerId,
              reason: "access_mode",
              requestId,
            });
          }
          return transport(input, init);
        };
      };

      return {
        protectTransport: (input: Parameters<ModelRequestSecurityPort["protectTransport"]>[0]) => {
          const { providerId, providerConfig, transport } = input;
          if (disposed) {
            return transport;
          }
          const baseURL = providerConfig.baseURL;
          const signed = requiresClientRequestSigning({ access: providerConfig.access, baseURL });
          // 发行版 protectTransport 的 false 分支仍按 Yut(baseURL) 包一层 access-mode 观测 fetch；
          // 不能在 qpa=false 时直接透传，否则 start-plan/off-peak/highspeed 的观测语义会丢失。
          if (!signed) {
            return isZaiFamilyRootDomain(resolveHostname(baseURL))
              ? (createAccessModeUnsignedFetch(providerId, transport) as unknown as typeof globalThis.fetch)
              : transport;
          }
          // 签名路径的 baseURL 由调用契约保证为 string；这里只给运行时畸形输入保留透传退路。
          if (!baseURL) {
            return transport;
          }
          const manager = new ClientRequestSigningV4Manager({
            allowInsecureHttp: false,
            keyCache,
            observer,
          });
          const signedFetch = manager.createFetch(
            {
              apiKey: providerConfig.apiKey ?? "",
              baseURL: providerConfig.baseURL,
              clientVersion: readClientVersion(providerConfig.headers),
              providerId,
            },
            transport as never,
          );
          return signedFetch as unknown as typeof globalThis.fetch;
        },
        take: (requestId: string) => observations.take(requestId),
      };
    },
  };
}
