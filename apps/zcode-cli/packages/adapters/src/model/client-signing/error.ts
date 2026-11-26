/** ClientRequestSigningV4 错误（发行版 Xbe/lwe 语义）。 */
export type ClientRequestSigningErrorKind =
  | "invalid-config"
  | "disposed"
  | "cryptography"
  | "handshake-network"
  | "handshake-timeout"
  | "handshake-protocol"
  | "handshake-server"
  | "handshake-business";

export class ClientRequestSigningV4Error extends Error {
  kind: ClientRequestSigningErrorKind;
  failOpenEligible: boolean;
  reason?: string;
  httpStatus?: number;
  businessCode?: number;

  constructor(options: {
    kind: ClientRequestSigningErrorKind;
    message: string;
    cause?: unknown;
    failOpenEligible?: boolean;
    reason?: string;
    httpStatus?: number;
    businessCode?: number;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ClientRequestSigningV4Error";
    this.kind = options.kind;
    this.failOpenEligible = options.failOpenEligible ?? false;
    this.reason = options.reason;
    this.httpStatus = options.httpStatus;
    this.businessCode = options.businessCode;
  }
}

export function makeSigningError(
  kind: ClientRequestSigningErrorKind,
  message: string,
  extra: { cause?: unknown; failOpenEligible?: boolean; reason?: string; httpStatus?: number; businessCode?: number } = {},
): ClientRequestSigningV4Error {
  return new ClientRequestSigningV4Error({ kind: kind, message, ...extra });
}

export function isFailOpenEligible(error: unknown): boolean {
  return error instanceof ClientRequestSigningV4Error && error.failOpenEligible;
}

/** 验签拒绝 reason 提取（发行版 dBr/pdt）：msg/reason 里找已知常量。 */
export const VERIFY_SIGNATURE_INVALID = "VERIFY_SIGNATURE_INVALID";
export const VERIFY_APIKEY_EXPIRED = "VERIFY_APIKEY_EXPIRED";

export function extractVerifyRejectReason(envelope: unknown): string | undefined {
  const walk = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const root = walk(envelope);
  if (!root) return undefined;
  const data = walk(root.data);
  const error = walk(root.error);
  const candidates = [root.msg, root.reason, data?.reason, error?.reason, error?.message];
  return candidates.find(
    (v) => v === VERIFY_SIGNATURE_INVALID || v === VERIFY_APIKEY_EXPIRED,
  );
}
