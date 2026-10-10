# -*- coding: utf-8 -*-
"""V4 握手复现脚本（doc 05 §2/§3/§8 规格）——独立 Python 实现对拍。

历史：05 §8 的握手实测（2026-09-26，HTTP 200 + 私钥解包成功）最初由本脚本
的前身完成，后于 2026-09-27 清理；本文件是**按文档规格的重建**（总览 §5.6
「可随时重建」即指此）。签名环 + A/B 实测在 tools/v4_sign_e2e.py，不复述。

协议一页纸（doc 05 §2/§3）：
  握手  POST https://api.z.ai/api/paas/c1f3a7e2/v2/client
        body  {apiKey, nonce(16B→32hex), sig, ts(ms)}
        sig   = base64(HMAC-SHA256(HKDF(secret, salt="WD_CLIENT_SIGN_KDF_SALT",
                                       info="getSignKey_hmac"),
                                   "get_sign_key\\n{id}\\n{ts}\\n{nonce}"))
        header Authorization: <完整 {id}.{secret}>，Content-Type: application/json
  解包  privateCipher = base64(AES-256-GCM)
        iv = cipher[:12]，AAD = apiKeyId，key = HKDF(secret, info="ed25519_priv")
        明文**又是一层 base64**（双层编码）→ 48 字节 PKCS8 DER → Ed25519

    python tools/v4_handshake.py                # 离线自测（不打网络）
    python tools/v4_handshake.py --api-key {id}.{secret}   # live 重拍握手环
    python tools/v4_handshake.py --live         # live，key 取 zk.plan_key("individual")

私钥仅内存使用/自检后丢弃，不落盘、不打印（只打公钥指纹）。
"""
import argparse
import base64
import hashlib
import hmac
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from cryptography.exceptions import InvalidTag                            # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization          # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ed25519             # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM            # noqa: E402
from cryptography.hazmat.primitives.kdf.hkdf import HKDF                  # noqa: E402

# ── 常量（doc 05 §2，与 zcode-signing.ts 第二来源逐字一致）────────────
HANDSHAKE_ORIGIN = "https://api.z.ai"          # 握手走 api.z.ai，业务走 zcode.z.ai
HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client"
KDF_SALT = b"WD_CLIENT_SIGN_KDF_SALT"
KDF_INFO_HMAC = b"getSignKey_hmac"
KDF_INFO_ED25519 = b"ed25519_priv"
SIG_DOMAIN = "get_sign_key"                    # 握手签名域分离串
NONCE_BYTES = 16                               # → 32 hex
PKCS8_ED25519_LEN = 48                         # Ed25519 PKCS8 DER 固定 48 字节


class HandshakeError(Exception):
    """带分类的握手失败（doc 05 §3 Hee 的简化版）。"""


def hkdf(secret: bytes, info: bytes, length: int = 32) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=KDF_SALT,
                info=info).derive(secret)


def build_handshake_sig(api_key_id: str, secret: bytes, ts: str, nonce_hex: str):
    """doc 05 §3：msg = "get_sign_key\\n{id}\\n{ts}\\n{nonce}"，HMAC 密钥经 HKDF。"""
    msg = "%s\n%s\n%s\n%s" % (SIG_DOMAIN, api_key_id, ts, nonce_hex)
    hmac_key = hkdf(secret, KDF_INFO_HMAC)
    sig = base64.b64encode(hmac.new(hmac_key, msg.encode(), hashlib.sha256).digest()).decode()
    return sig, msg


# ── 解包（doc 05 §3 nur = decryptSigningPrivateKey；§8 双层编码实测）──
def parse_private_cipher(cipher_b64: str, api_key_id: str, secret_b: bytes) -> ed25519.Ed25519PrivateKey:
    try:
        cipher = base64.b64decode(cipher_b64)
    except Exception as e:
        raise HandshakeError("privateCipher 不是合法 base64: %s" % e)
    if len(cipher) <= 12:
        raise HandshakeError("privateCipher 过短: %d 字节" % len(cipher))
    iv, ct = cipher[:12], cipher[12:]
    aes_key = hkdf(secret_b, KDF_INFO_ED25519)
    try:
        plain = AESGCM(aes_key).decrypt(iv, ct, api_key_id.encode())
    except InvalidTag:
        raise HandshakeError("AES-256-GCM 解密失败（AAD=apiKeyId 绑定不匹配或密文损坏）")
    # doc 05 §8：明文**又是一层 base64 文本**（双层编码），再解出 PKCS8 DER
    try:
        der = base64.b64decode(plain)
    except Exception:
        raise HandshakeError("内层 base64 解码失败（明文 %d 字节，非 base64 文本）" % len(plain))
    if len(der) != PKCS8_ED25519_LEN:
        raise HandshakeError("DER 长度异常: %d 字节（预期 %d）" % (len(der), PKCS8_ED25519_LEN))
    try:
        key = serialization.load_der_private_key(der, password=None)
    except Exception as e:
        raise HandshakeError("PKCS8 导入失败: %s" % e)
    if not isinstance(key, ed25519.Ed25519PrivateKey):
        raise HandshakeError("私钥类型异常: %s" % type(key).__name__)
    return key


# ── 握手（doc 05 §3 performHandshake；§8 实测 200 的请求形态）────────
def handshake(api_key: str, timeout: int = 15):
    if api_key.count(".") < 1:
        raise HandshakeError("api-key 形如 {id}.{secret}，缺少 '.' 分隔")
    api_key_id, api_key_secret = api_key.split(".", 1)
    secret_b = api_key_secret.encode()

    nonce_hex = os.urandom(NONCE_BYTES).hex()
    ts = str(int(time.time() * 1000))
    sig, _ = build_handshake_sig(api_key_id, secret_b, ts, nonce_hex)

    body = json.dumps({"apiKey": api_key, "nonce": nonce_hex,
                       "sig": sig, "ts": ts}).encode()
    req = urllib.request.Request(
        HANDSHAKE_ORIGIN + HANDSHAKE_PATH, data=body, method="POST",
        headers={"Authorization": api_key, "Content-Type": "application/json",
                 "User-Agent": "ZCode/3.14.3"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status = r.status
            js = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise HandshakeError("HTTP %s  %s" % (e.code, e.read().decode("utf-8", "replace")[:200]))
    except Exception as e:
        raise HandshakeError("%s: %s" % (type(e).__name__, str(e)[:160]))

    if not js.get("success", False):
        raise HandshakeError("业务失败 code=%s msg=%s" % (js.get("code"), js.get("msg")))
    cipher = (js.get("data") or {}).get("privateCipher")
    if not cipher:
        raise HandshakeError("响应缺 data.privateCipher: %s" % json.dumps(js)[:200])
    key = parse_private_cipher(cipher, api_key_id, secret_b)
    return status, key


# ── 自测支撑：本地构造一枚合法信封（服务端同构行为，用于离线回环）────
def make_envelope(key: ed25519.Ed25519PrivateKey, secret_b: bytes, api_key_id: str,
                  double_encode: bool = True) -> str:
    der = key.private_bytes(serialization.Encoding.DER,
                            serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption())
    plain = base64.b64encode(der) if double_encode else der   # §8：明文又是一层 base64
    iv = os.urandom(12)
    ct = AESGCM(hkdf(secret_b, KDF_INFO_ED25519)).encrypt(iv, plain, api_key_id.encode())
    return base64.b64encode(iv + ct).decode()


def _hkdf_manual(ikm: bytes, salt: bytes, info: bytes, length: int = 32) -> bytes:
    """RFC 5869 extract+expand 手写实现，用于和 cryptography 交叉对拍。"""
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm, t, i = b"", b"", 1
    while len(okm) < length:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        okm += t
        i += 1
    return okm[:length]


# ── 离线自测：6 断言，不打网络 ────────────────────────────────────────
def self_test() -> int:
    ok = []

    # 1. HKDF 原语：手写 extract/expand 与 cryptography 在本协议参数下一致
    secret = b"id123.secretXYZ"
    ok.append(("HKDF 手写 vs cryptography", _hkdf_manual(secret, KDF_SALT, KDF_INFO_HMAC)
               == hkdf(secret, KDF_INFO_HMAC)))

    # 2. RFC 5869 Test Case 1 已知向量（IKM=0x0b*22）—— 证明上面的手写实现本身正确
    tc1 = _hkdf_manual(b"\x0b" * 22, bytes(range(0x00, 0x0D)), bytes(range(0xF0, 0xFA)), 42)
    ok.append(("RFC 5869 TC1 向量", tc1.hex() ==
               "3cb25f25faacd57a90434f64d0362f2a"
               "2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
               "34007208d5b887185865"))

    # 3. 域分离：两个 info 派生出不同密钥（握手签名 ≠ 私钥解包）
    ok.append(("info 域分离", hkdf(secret, KDF_INFO_HMAC) != hkdf(secret, KDF_INFO_ED25519)))

    # 4. 握手签名复算：独立用手工 HKDF 密钥重算 HMAC，与 build_handshake_sig 一致且可验
    key_m = _hkdf_manual(secret, KDF_SALT, KDF_INFO_HMAC)
    ts, nonce_hex = "1727300000000", "ab" * 16
    sig, msg = build_handshake_sig("id123", secret, ts, nonce_hex)
    expect = base64.b64encode(hmac.new(key_m, msg.encode(), hashlib.sha256).digest()).decode()
    ok.append(("握手签名复算", sig == expect and msg == "get_sign_key\nid123\n%s\n%s" % (ts, nonce_hex)))

    # 5. 信封回环：本地造信封 → parse → 同一密钥（签名/验签互换成功）
    priv = ed25519.Ed25519PrivateKey.generate()
    back = parse_private_cipher(make_envelope(priv, secret, "id123"), "id123", secret)
    probe = b"v4-handshake-roundtrip"
    ok.append(("信封回环（双层编码）",
               back.public_key().verify(priv.sign(probe), probe) is None
               and isinstance(back, ed25519.Ed25519PrivateKey)))

    # 6. 防伪：单层编码（明文非 base64 文本）与错 AAD 都必须报错，否则回环是自说自话
    neg1 = neg2 = False
    try:
        parse_private_cipher(make_envelope(priv, secret, "id123", double_encode=False),
                             "id123", secret)
    except HandshakeError:
        neg1 = True
    try:
        parse_private_cipher(make_envelope(priv, secret, "id123"), "other-id", secret)
    except HandshakeError:
        neg2 = True
    ok.append(("防伪（单层编码/错 AAD 均拒绝）", neg1 and neg2))

    failed = 0
    for name, passed in ok:
        print("  %-32s %s" % (name, "PASS" if passed else "FAIL"))
        failed += (not passed)
    print("自测 %d/%d 通过" % (len(ok) - failed, len(ok)))
    return 1 if failed else 0


def live(api_key: str) -> int:
    try:
        status, key = handshake(api_key)
    except HandshakeError as e:
        print("握手    [失败] %s" % e)
        return 1
    pub = key.public_key().public_bytes(serialization.Encoding.Raw,
                                        serialization.PublicFormat.Raw).hex()
    print("握手    [OK] HTTP %s，私钥解包成功（Ed25519，双层编码）" % status)
    print("        公钥指纹 %s...（私钥已丢弃，未落盘）" % pub[:16])
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="V4 握手复现（doc 05 §2/§3/§8）")
    ap.add_argument("--api-key", help="{id}.{secret} 形式的 coding plan key，触发 live 握手")
    ap.add_argument("--live", action="store_true", help="live 握手，key 取 zk.plan_key('individual')")
    ap.add_argument("--self-test", action="store_true", help="仅离线自测（默认行为）")
    args = ap.parse_args()

    if args.api_key:
        return live(args.api_key)
    if args.live:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import zk
        return live(zk.plan_key("individual"))
    return self_test()


if __name__ == "__main__":
    sys.exit(main())
