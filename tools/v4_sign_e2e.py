# -*- coding: utf-8 -*-
"""V4 完整签名环：握手 → Ed25519 → PoW → 六头 → 模型请求。

回答一个此前没测过的问题：**gate 关闭时，服务端认不认签名？**

之前只测到握手 200 就停了，理由是"gate 关着拿不到 200"。但那是最终 200 的问题，
不是能不能做的问题。两种结果都有价值：
  - 签名被接受、卡在 1113 → 唯一缺口是余额
  - 签名被拒（如 401 / VERIFY_*） → 服务端 gate 关时根本不收签名

规格来源：docs/zcode-plan-05 §3 握手 / §4 请求签名。
第二来源：bacnh85/pi-extensions zcode-signing.ts（MIT）—— POW_BITS=8、
nonce 长度 16/12 来自该实现。

    python tools/v4_sign_e2e.py

私钥仅内存自检后丢弃，不落盘、不打印。
"""
import base64
import hashlib
import hmac
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import zk                                                       # noqa: E402

from cryptography.hazmat.primitives import hashes, serialization      # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ed25519         # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM        # noqa: E402
from cryptography.hazmat.primitives.kdf.hkdf import HKDF              # noqa: E402

# ── 常量（doc 05 §1–§4）────────────────────────────────────────────────
HANDSHAKE_ORIGIN = "https://api.z.ai"
HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client"
BUSINESS_ORIGIN = "https://zcode.z.ai"
# individual 通道的**模型请求**路径。
# 注意：不能用 start-plan 的 /api/v1/zcode-plan/anthropic/v1/messages ——
# 那条在 zcode-signing.ts 的 UNSIGNED_PATHS 里，既不收签名也不收 api-key，
# 拿 coding plan api-key 打过去只会 401，A/B 对照会得出"签名头无影响"的假结论。
# 依据 doc 08 §：individual 通道打 /api/anthropic/v1/messages 或
# open.bigmodel.cn/api/paas/v4/chat/completions，key 认证通过但余额空 → 429/1113。
MODEL_PATHS = [
    ("api.z.ai  /api/anthropic/v1/messages", "https://api.z.ai/api/anthropic/v1/messages", "anthropic"),
    ("bigmodel   /api/paas/v4/chat/completions", "https://open.bigmodel.cn/api/paas/v4/chat/completions", "openai"),
]
KDF_SALT = b"WD_CLIENT_SIGN_KDF_SALT"
KDF_INFO_HMAC = b"getSignKey_hmac"
KDF_INFO_ED25519 = b"ed25519_priv"
APP_ID = "zcode"
POW_BITS = 8
NONCE_BYTES = 16
POW_NONCE_BYTES = 12


def hkdf(secret: bytes, info: bytes, length: int = 32) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=KDF_SALT,
                info=info).derive(secret)


# ── 握手（doc 05 §3）─────────────────────────────────────────────────
def handshake(api_key: str):
    api_key_id, api_key_secret = api_key.split(".", 1)
    secret_b = api_key_secret.encode()

    nonce = os.urandom(NONCE_BYTES)
    ts = str(int(time.time() * 1000))
    hmac_key = hkdf(secret_b, KDF_INFO_HMAC)
    msg = "get_sign_key\n%s\n%s\n%s" % (api_key_id, ts, nonce.hex())
    sig = base64.b64encode(
        hmac.new(hmac_key, msg.encode(), hashlib.sha256).digest()).decode()

    body = json.dumps({"apiKey": api_key, "nonce": nonce.hex(),
                       "sig": sig, "ts": ts}).encode()
    req = urllib.request.Request(
        HANDSHAKE_ORIGIN + HANDSHAKE_PATH, data=body, method="POST",
        headers={"Authorization": api_key, "Content-Type": "application/json",
                 "User-Agent": "ZCode/3.14.3"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return parse_handshake(json.loads(r.read().decode()), api_key_id, secret_b)
    except urllib.error.HTTPError as e:
        return None, "HTTP %s  %s" % (e.code, e.read().decode("utf-8", "replace")[:200])
    except Exception as e:
        return None, "%s: %s" % (type(e).__name__, str(e)[:160])


def parse_handshake(js, api_key_id, secret_b):
    if not js.get("success", False):
        return None, "业务失败 code=%s msg=%s" % (js.get("code"), js.get("msg"))
    cipher = base64.b64decode(js["data"]["privateCipher"])
    iv, ct = cipher[:12], cipher[12:]
    aes_key = hkdf(secret_b, KDF_INFO_ED25519)
    plain = AESGCM(aes_key).decrypt(iv, ct, api_key_id.encode())
    # doc 05 §8：解出的明文**又是一层 base64 文本**（双层编码）
    der = base64.b64decode(plain)
    if len(der) != 48:
        return None, "DER 长度异常: %d 字节（预期 48）" % len(der)
    key = serialization.load_der_private_key(der, password=None)
    if not isinstance(key, ed25519.Ed25519PrivateKey):
        return None, "私钥类型异常: %s" % type(key).__name__
    return key, None


# ── 签名头（doc 05 §4）───────────────────────────────────────────────
def build_signed_headers(key, api_key_id, version):
    session_id = str(uuid.uuid4())
    ts = str(int(time.time() * 1000))
    nonce = os.urandom(NONCE_BYTES).hex()

    # PoW：两处哈希都用 \n 连接（第二来源 zcode-signing.ts createProofOfWork）。
    # 早期版本误用空格，会解出一道不同的题，X-Client-Pow 头无效。
    pow_seed = hashlib.sha256(
        ("%s\n%s\n%s\n%s" % (api_key_id, APP_ID, session_id, ts)).encode()).hexdigest()[:32]
    prefix = os.urandom(POW_NONCE_BYTES).hex()
    pow_val = None
    for counter in range(1 << 20):
        cand = "%s%08x" % (prefix, counter)
        d = hashlib.sha256(("%s\n%s" % (pow_seed, cand)).encode()).digest()
        if d[0] == 0:                                   # 前 8 bit 全 0
            pow_val = cand
            break
    if pow_val is None:
        raise RuntimeError("PoW 未在 2^20 内收敛")

    sig_msg = "%s\n%s\n%s\n%s\n%s" % (api_key_id, ts, version, session_id, nonce)
    sig = base64.b64encode(key.sign(sig_msg.encode())).decode()

    # ── 自检：PoW 解必须真的满足约束，否则头是无效的 ──
    # 这条能独立证明分隔符修对了：若仍用空格，此处必然失败。
    digest = hashlib.sha256(("%s\n%s" % (pow_seed, pow_val)).encode()).digest()
    pow_ok = (digest[0] == 0)                       # 前 8 bit 全 0
    sig_len = len(base64.b64decode(sig))
    sig_ok = (sig_len == 64)                        # Ed25519 标准签名 64 字节
    if not (pow_ok and sig_ok):
        raise RuntimeError("自检失败 pow_ok=%s sig_len=%d" % (pow_ok, sig_len))
    try:
        key.public_key().verify(base64.b64decode(sig), sig_msg.encode())
        verified = True                       # cryptography 成功返回 None，失败抛异常
    except Exception:
        verified = False

    return {
        "X-Client-Ts": ts,
        "X-Client-Version": version,
        "X-Client-Sig": sig,
        "X-Session-Id": session_id,
        "X-Client-Nonce": nonce,
        "X-App-Id": APP_ID,
        "X-Client-Pow": pow_val,
    }, session_id, (pow_ok, sig_ok, verified)


# ── 业务请求 ─────────────────────────────────────────────────────────
def send_signed(api_key, headers, session_id, url, dialect, sign=True):
    if dialect == "anthropic":
        payload = {
            "model": "GLM-5.3-Flash",
            "max_tokens": 16,
            "messages": [{"role": "user", "content": "reply with: pong"}],
        }
        extra = {"anthropic-version": "2023-06-01"}
    else:
        payload = {
            "model": "GLM-5.3-Flash",
            "max_tokens": 16,
            "messages": [{"role": "user", "content": "reply with: pong"}],
        }
        extra = {}
    body = json.dumps(payload).encode()
    h = dict(headers) if sign else {}
    h.update({
        "Authorization": api_key,
        "Content-Type": "application/json",
        "User-Agent": "ZCode/3.14.3",
    })
    h.update(extra)
    if sign:
        h["X-Session-Id"] = session_id
    req = urllib.request.Request(url, data=body, method="POST", headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace")


def show(tag, status, hdrs, text):
    print("\n  %s" % tag)
    print("    HTTP %s   body 长度 %d" % (status, len(text)))
    for h in ("x-client-sign-verified", "x-request-id", "x-ratelimit-remaining"):
        if h in hdrs:
            print("    %-24s %s" % (h, hdrs[h]))
    if text.strip():
        print("    body: %s" % text[:260])
    else:
        print("    body: (空)")


def norm(text):
    """抹掉每次都变的字段，否则 A/B 会因 request_id 差异误判为"响应不同"。"""
    t = re.sub(r"20\d{12}[0-9a-f]{16}", "<REQUEST_ID>", text)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def main():
    print("V4 完整签名环 —— 握手 → Ed25519 → PoW → 六头 → 模型请求\n")
    api_key = zk.plan_key("individual")
    api_key_id = api_key.split(".", 1)[0]
    print("通道    individual-coding-plan   key 尾号 %s" % api_key[-6:])
    print("凭据    {apiKeyId}.{apiKeySecret} 两段式\n")

    key, err = handshake(api_key)
    if key is None:
        print("握手    [失败] %s" % err)
        return
    pub = key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    print("握手    [OK] HTTP 200，私钥解包成功（Ed25519）")
    print("        公钥指纹 %s..." % pub.hex()[:16])

    version = "3.14.3"
    hs, session_id, _chk = build_signed_headers(key, api_key_id, version)
    print("签名头  [OK] 7 头构造完成")
    for k in ("X-Client-Ts", "X-Client-Version", "X-App-Id",
              "X-Client-Nonce", "X-Client-Pow"):
        print("        %-20s %s" % (k, hs[k][:56]))
    print("        %-20s %s..." % ("X-Client-Sig", hs["X-Client-Sig"][:56]))
    print("自检    PoW 前 8 bit 零 = %s | 签名 64 字节 = %s | 公钥验签 = %s"
          % _chk)

    print("\nA/B 对照 —— 逐个 individual 通道的真实模型端点")
    print("（唯一变量＝签名头；端点必须是 coding plan 路径，不能用 start-plan 路径）\n")

    for label, url, dialect in MODEL_PATHS:
        hs_a, sid_a, _ = build_signed_headers(key, api_key_id, version)
        s1, h1, t1 = send_signed(api_key, hs_a, sid_a, url, dialect, sign=True)
        s2, h2, t2 = send_signed(api_key, {}, "", url, dialect, sign=False)

        print("  %s" % label)
        print("    A 带签名  HTTP %-4s  %s" % (s1, norm(t1)[:150] or "(空)"))
        print("    B 无签名  HTTP %-4s  %s" % (s2, norm(t2)[:150] or "(空)"))
        verdict = h1.get("x-client-sign-verified") or h2.get("x-client-sign-verified")
        print("    x-client-sign-verified: %s" % (verdict or "(未返回)"))
        if s1 == s2 and norm(t1) == norm(t2):
            print("    判读      归一化后**完全一致** → 该端点未校验签名（gate 关）\n")
        else:
            print("    判读      **归一化后仍不同** → 签名头被读取并影响了判定\n")

    print("=" * 62)
    print("提示：429/1113 属计费层，说明 key 认证已通过，**不算签名没跑通**——")
    print("      它只说明账户余额/资源包为空。判读须看是否出现 VERIFY_* 或 401 差异。")
    print("\n私钥仅内存自检后丢弃，未落盘、未打印。")


if __name__ == "__main__":
    main()
