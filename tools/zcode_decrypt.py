# -*- coding: utf-8 -*-
"""Decrypt ZCode credentials.json (enc:v1 values) locally.

Format (reverse-engineered from zcode.cjs createZCodeCredentialCipher):
  enc:v1:<b64url(12B iv)>.<b64url(16B tag)>.<b64url(ciphertext)>
  key = sha256(secret), aes-256-gcm
  secret = env ZCODE_CREDENTIAL_SECRET | fallback string (see resolve_credential_secret)
"""
import base64
import hashlib
import json
import os
import secrets
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def resolve_credential_secret() -> str:
    env_secret = os.environ.get("ZCODE_CREDENTIAL_SECRET", "").strip()
    if env_secret:
        return env_secret
    username = "unknown"
    try:
        username = os.getlogin()
    except Exception:
        username = Path.home().name
    return f"zcode-credential-fallback:{sys.platform}:{Path.home()}:{username}"


def derive_key() -> bytes:
    return hashlib.sha256(resolve_credential_secret().encode("utf-8")).digest()


def encrypt_value(plain: str, key: bytes) -> str:
    """Same wire format as ZCode: enc:v1:<b64url iv>.<b64url tag>.<b64url ct>"""
    iv = secrets.token_bytes(12)
    ct_and_tag = AESGCM(key).encrypt(iv, plain.encode("utf-8"), None)
    ct, tag = ct_and_tag[:-16], ct_and_tag[-16:]
    b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
    return "enc:v1:" + b64(iv) + "." + b64(tag) + "." + b64(ct)


def decrypt_value(value: str, key: bytes) -> str:
    prefix = "enc:v1:"
    if not value.startswith(prefix):
        return value  # stored as plaintext
    parts = value[len(prefix):].split(".")
    if len(parts) != 3:
        raise ValueError("invalid ciphertext format")
    iv = base64.urlsafe_b64decode(parts[0] + "==")
    tag = base64.urlsafe_b64decode(parts[1] + "==")
    ct = base64.urlsafe_b64decode(parts[2] + "==")
    if len(iv) != 12:
        raise ValueError(f"invalid IV length {len(iv)}")
    if len(tag) != 16:
        raise ValueError(f"invalid auth tag length {len(tag)}")
    aes = AESGCM(key)
    # python cryptography AESGCM expects ct||tag
    return aes.decrypt(iv, ct + tag, None).decode("utf-8")


def main() -> None:
    cred_path = Path.home() / ".zcode" / "v2" / "credentials.json"
    raw = json.loads(cred_path.read_text(encoding="utf-8"))
    key = derive_key()
    out = {}
    for k, v in raw.items():
        try:
            plain = decrypt_value(v, key)
        except Exception as e:  # noqa: BLE001
            plain = f"<decrypt-failed: {e}>"
        out[k] = plain
    # secrets are NOT persisted by default; pass --out <path> to write plaintext
    # to a file (at your own risk, delete it right after use).
    if "--out" in sys.argv:
        dest = Path(sys.argv[sys.argv.index("--out") + 1])
        dest.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"[!] plaintext credentials written to {dest} - delete after use")
    # structural info only, never secret values
    for k, v in out.items():
        sensitive = any(s in k.lower() for s in ("token", "key", "secret"))
        shown = v if not sensitive else f"<len {len(v)}>"
        print(f"{k} -> {shown}")


if __name__ == "__main__":
    main()
