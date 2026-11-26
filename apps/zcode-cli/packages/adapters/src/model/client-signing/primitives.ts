/**
 * ClientRequestSigningV4 密码学原语——按发行版 cjs 语义逐函数还原。
 * 对照基准：zcode.cjs 偏移 3918300-3923100（signing-full-4.0.txt）。
 * 全部基于 WebCrypto（Node ≥ 20 支持 Ed25519 importKey pkcs8）。
 */

const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
const PRIVATE_KEY_INFO = "ed25519_priv";
const HANDSHAKE_HMAC_INFO = "getSignKey_hmac";
const GET_SIGN_KEY = "get_sign_key";
const APP_ID = "zcode";

const encoder = new TextEncoder();

function encodeUtf8(str: string): Uint8Array {
  return encoder.encode(str);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64ToBytes(b64: string): Uint8Array {
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new Error("invalid base64");
  }
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function randomHex(bytes: number): string {
  const t = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToHex(t);
}

/** HKDF-SHA256 派生 256 bit（发行版 deriveBytes）。 */
export async function deriveBytes(secret: string, info: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encodeUtf8(secret).buffer as ArrayBuffer, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { hash: "SHA-256", info: encodeUtf8(info).buffer as ArrayBuffer, name: "HKDF", salt: (encodeUtf8(KDF_SALT).buffer) as ArrayBuffer },
      key,
      256,
    ),
  );
}

/** 握手签名（发行版 createHandshakeSignature）：HMAC-SHA256(KDF(secret,"getSignKey_hmac"), msg)。 */
export async function createHandshakeSignature(secret: string, message: string): Promise<string> {
  const derived = await deriveBytes(secret, HANDSHAKE_HMAC_INFO);
  const key = await crypto.subtle.importKey("raw", derived.buffer as ArrayBuffer, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encodeUtf8(message).buffer as ArrayBuffer));
  return bytesToBase64(sig);
}

/** 私钥解封（发行版 decryptSigningPrivateKey）：AES-256-GCM（AD=apiKeyId）→ PKCS#8 Ed25519。 */
export async function decryptSigningPrivateKey(apiKeyId: string, secret: string, privateCipher: string): Promise<CryptoKey> {
  let derived;
  let plain;
  let pkcs8;
  try {
    const ciphertext = base64ToBytes(privateCipher);
    if (ciphertext.byteLength <= 12 + 128 / 8) {
      throw new Error("privateCipher is too short");
    }
    derived = await deriveBytes(secret, PRIVATE_KEY_INFO);
    const aesKey = await crypto.subtle.importKey("raw", derived.buffer as ArrayBuffer, "AES-GCM", false, ["decrypt"]);
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { additionalData: encodeUtf8(apiKeyId).buffer as ArrayBuffer, iv: ciphertext.slice(0, 12), name: "AES-GCM", tagLength: 128 },
        aesKey,
        ciphertext.slice(12),
      ),
    );
    pkcs8 = base64ToBytes(new TextDecoder().decode(plain));
    return await crypto.subtle.importKey("pkcs8", pkcs8.buffer as ArrayBuffer, "Ed25519", false, ["sign"]);
  } finally {
    derived?.fill(0);
    plain?.fill(0);
    pkcs8?.fill(0);
  }
}

/** 业务签名（发行版 signBusinessMessage）：Ed25519。 */
export async function signBusinessMessage(privateKey: CryptoKey, message: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, encodeUtf8(message).buffer as ArrayBuffer));
  return bytesToBase64(sig);
}

/** 前导零校验（发行版 hasLeadingZeroBits）：前 t bit 全 0。 */
export function hasLeadingZeroBits(digest: Uint8Array, bits: number): boolean {
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) {
    if (digest[i] !== 0) return false;
  }
  const rest = bits % 8;
  if (rest === 0) return true;
  const mask = (255 << (8 - rest)) & 255;
  return ((digest[full] ?? 255) & mask) === 0 ? false : true;
}

/** PoW 求解（发行版 createClientRequestProofOfWork）：8 bit 前导零 SHA-256。 */
export async function createClientRequestProofOfWork(input: { apiKeyId: string; appId: string; powBits: number; sessionId: string; ts: string; signal?: AbortSignal }): Promise<string> {
  const n = bytesToHex(encodeUtf8(`${input.apiKeyId}\n${input.appId}\n${input.sessionId}\n${input.ts}`)).slice(0, 32);
  const nonce = randomHex(12);
  for (let i = 0; i <= 4294967295; i++) {
    input.signal?.throwIfAborted();
    const candidate = `${nonce}${i.toString(16).padStart(8, "0")}`;
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encodeUtf8(`${n}\n${candidate}`).buffer as ArrayBuffer),
    );
    if (hasLeadingZeroBits(digest, input.powBits)) {
      return candidate;
    }
  }
  throw new Error("Unable to solve client request proof of work");
}

export { KDF_SALT, PRIVATE_KEY_INFO, HANDSHAKE_HMAC_INFO, GET_SIGN_KEY, APP_ID };
