export {
  ClientRequestSigningV4Error,
  makeSigningError,
  isFailOpenEligible,
  extractVerifyRejectReason,
  VERIFY_SIGNATURE_INVALID,
  VERIFY_APIKEY_EXPIRED,
  type ClientRequestSigningErrorKind,
} from "./error.js";
export {
  deriveBytes,
  createHandshakeSignature,
  decryptSigningPrivateKey,
  signBusinessMessage,
  createClientRequestProofOfWork,
  hasLeadingZeroBits,
  randomHex,
  bytesToBase64,
  bytesToHex,
  base64ToBytes,
} from "./primitives.js";
export { resolveSigningCredential, type SigningCredential } from "./credential.js";
export {
  ClientRequestSigningV4Signer,
  newKeyState,
  type SigningTransportRequest,
  type Transport,
  type SigningObserver,
  type KeyState,
} from "./signer.js";
export {
  ClientRequestSigningV4Manager,
  ClientRequestSigningV4KeyCache,
  type ManagerInput,
} from "./manager.js";
