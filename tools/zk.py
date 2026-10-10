# -*- coding: utf-8 -*-
"""ZCode 凭据访问helper —— 全程内存解密，明文不落盘。

所有 tools/*.py 共用本模块，不再需要 `zcode_decrypt.py --out _creds.json`。
读取 ~/.zcode/v2/credentials.json 的 enc:v1 值，在内存中解密后直接使用。

    import zk
    token = zk.token()
    key   = zk.plan_key("individual")
"""
import base64
import hashlib
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PREFIX = "enc:v1:"


def _secret() -> str:
    env = os.environ.get("ZCODE_CREDENTIAL_SECRET", "").strip()
    if env:
        return env
    try:
        user = os.getlogin()
    except Exception:
        user = Path.home().name
    return f"zcode-credential-fallback:{sys.platform}:{Path.home()}:{user}"


def _key() -> bytes:
    return hashlib.sha256(_secret().encode("utf-8")).digest()


def _decrypt(value: str, key: bytes) -> str:
    if not value.startswith(PREFIX):
        return value                      # 本来就是明文
    iv_b64, tag_b64, ct_b64 = value[len(PREFIX):].split(".")
    pad = lambda s: s + "=" * (-len(s) % 4)
    iv = base64.urlsafe_b64decode(pad(iv_b64))
    tag = base64.urlsafe_b64decode(pad(tag_b64))
    ct = base64.urlsafe_b64decode(pad(ct_b64))
    if len(iv) != 12:
        raise ValueError("invalid IV length %d" % len(iv))
    if len(tag) != 16:
        raise ValueError("invalid tag length %d" % len(tag))
    return AESGCM(key).decrypt(iv, ct + tag, None).decode("utf-8")


def load() -> dict:
    """解密全部凭据。只在内存中，调用方不要写盘。"""
    raw = json.loads((Path.home() / ".zcode" / "v2" / "credentials.json").read_text(encoding="utf-8"))
    key = _key()
    out = {}
    for k, v in raw.items():
        try:
            out[k] = _decrypt(v, key)
        except Exception as e:            # noqa: BLE001
            out[k] = "<decrypt-failed: %s>" % e
    return out


def token() -> str:
    """zcodejwttoken —— 免费额度走它（Authorization: Bearer）。"""
    v = load().get("zcodejwttoken", "").strip()
    if not v or v.startswith("<decrypt-failed"):
        raise SystemExit("zcodejwttoken 不可用：%s" % (v or "缺失"))
    return v


def plan_key(family: str = "individual") -> str:
    """coding plan 的 api-key。family: individual | team"""
    creds = load()
    tag = "%s-coding-plan" % family
    for k, v in creds.items():
        if "api-key" in k and tag in k:
            return str(v).strip()
    raise SystemExit("凭据里没有 %s coding plan 的 api-key" % family)


def device_mid() -> str:
    p = Path.home() / ".zcode" / "v2" / "telemetry-state.json"
    return json.loads(p.read_text(encoding="utf-8"))["deviceMid"]


def user_info() -> dict:
    """当前账号身份 —— 排障第一步（doc 37 §4：多号并存先确认在测谁）。"""
    v = load().get("oauth:zai:user_info") or load().get("oauth:bigmodel:user_info") or "{}"
    try:
        return json.loads(v)
    except Exception:                      # noqa: BLE001
        return {}


def base_headers(origin: str = "https://zcode.z.ai", version: str = "3.14.3") -> dict:
    """客户端默认请求头（对齐 buildZCodeSourceHeadersFromContext）。"""
    import platform
    import uuid
    return {
        "User-Agent": "ZCode/%s" % version,
        "HTTP-Referer": origin,
        "X-Title": "Z Code@electron",
        "X-ZCode-App-Version": version,
        "X-Platform": "%s-%s" % (sys.platform, platform.machine().lower()),
        "X-Release-Channel": "stable",
        "X-Client-Language": "zh-CN",
        "X-Client-Timezone": "Asia/Shanghai",
        "X-Os-Category": "windows",
        "X-Os-Version": platform.version(),
        "X-Device-Mid": device_mid(),
        "x-request-id": str(uuid.uuid4()),
        "Accept": "*/*",
    }
