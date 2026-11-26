/** apiKey 凭据双形态解析（发行版 cBr）。 */

export interface SigningCredential {
  apiKeyId: string;
  secret: string;
  credential: string;
  handshakeField: "accessToken" | "apiKey";
}

/** JWT header 校验：alg=HS256、typ=JWT、sign_type=SIGN（发行版 w4s）。 */
function decodeJwtHeader(headerB64: string): { alg?: string; typ?: string; sign_type?: string } | undefined {
  try {
    const json = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atobJs(headerB64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))),
    );
    return typeof json === "object" && json !== null ? json : undefined;
  } catch {
    return undefined;
  }
}

function atobJs(s: string): string {
  return Buffer.from(s, "base64").toString("binary");
}

export function resolveSigningCredential(apiKey: string): SigningCredential | undefined {
  const parts = apiKey.split(".");

  // 形态 A：JWT 三段式（header.payload.signature），header 含 sign_type=SIGN
  if (parts.length === 3 && parts[2]) {
    try {
      const header = decodeJwtHeader(parts[0]);
      if (header?.alg !== "HS256" || header?.typ !== "JWT" || header?.sign_type !== "SIGN") {
        return undefined;
      }
      const payload = decodeJwtHeader(parts[1]);
      const apiKeyId = (payload as Record<string, unknown> | undefined)?.api_key;
      if (typeof apiKeyId !== "string" || !apiKeyId.trim()) {
        return undefined;
      }
      return {
        apiKeyId,
        secret: apiKey,
        credential: apiKey,
        handshakeField: "accessToken",
      };
    } catch {
      return undefined;
    }
  }

  // 形态 B：apiKeyId.secret 两段式（恰好一个 "."）
  const dot = apiKey.indexOf(".");
  if (dot <= 0 || dot !== apiKey.lastIndexOf(".")) return undefined;
  const id = apiKey.slice(0, dot).trim();
  const secret = apiKey.slice(dot + 1).trim();
  if (!id || !secret) return undefined;
  return {
    apiKeyId: id,
    secret,
    credential: apiKey,
    handshakeField: "apiKey",
  };
}
