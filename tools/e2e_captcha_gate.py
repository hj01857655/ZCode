# e2e: 新鲜 solver param + dengyie 身份块请求体 + JWT 直打上游 Plan 通道
# 验证目标：3012 是否复现（身份块/头集/param 全按 dengyie 实现装配）
import base64
import hashlib
import json
import os
import subprocess
import sys

import requests

DENG = r"e:\VSCodeSpace\ZCode\zcode2api-dengyie"
sys.path.insert(0, DENG)
os.environ.setdefault("ZCODE_DATA_DIR", os.path.join(DENG, "data"))

from app import body_transform, constants, identity, settings  # noqa: E402

BACKUP = r"e:\VSCodeSpace\ZCode\accounts-backup.json"
PREFIX = "enc:v1:"


def derive_key(secret: str) -> bytes:
    return hashlib.sha256(secret.encode()).digest()


def decrypt_value(value: str, secret: str) -> str:
    body = value.removeprefix(PREFIX)
    n_b64, t_b64, c_b64 = body.split(".")
    pad = lambda s: s + "=" * (-len(s) % 4)
    nonce = base64.urlsafe_b64decode(pad(n_b64))
    tag = base64.urlsafe_b64decode(pad(t_b64))
    ct = base64.urlsafe_b64decode(pad(c_b64))
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    return AESGCM(derive_key(secret)).decrypt(nonce, ct + tag, None).decode()


def load_jwt() -> str:
    d = json.load(open(BACKUP, encoding="utf-8"))
    snap = d["accounts"]["jfhj-google（当前活跃）"]["credentials_snapshot"]
    secret = f"zcode-credential-fallback:win32:{os.path.expanduser('~')}:{os.environ['USERNAME']}"
    return decrypt_value(snap["zcodejwttoken"], secret)


def solve_param() -> str:
    out = subprocess.run(
        ["node", "solver.js", "11xygtvd", "cn", "no8xfe"],
        cwd=os.path.join(DENG, "captcha_node"), capture_output=True, text=True, timeout=60,
    )
    for line in out.stdout.splitlines():
        if line.startswith("VERIFY_PARAM="):
            return line[len("VERIFY_PARAM="):].strip()
    print("solver fail, stderr:", out.stderr[-400:], file=sys.stderr)
    raise SystemExit(2)


def main() -> None:
    jwt = load_jwt()
    user_id = body_transform.jwt_user_id(jwt)
    print(f"user_id={user_id}")

    param = solve_param()
    print(f"param_len={len(param)} head={param[:40]}...")

    body = {
        "model": "glm-4.6",
        "max_tokens": 32,
        "stream": False,
        "messages": [{"role": "user", "content": "reply with: pong"}],
    }
    body = body_transform.transform_body(body, user_id, "glm-4.6")
    sys_blocks = body["system"]
    print(f"system_blocks={len(sys_blocks)} first_head={sys_blocks[0]['text'][:30]!r}")

    headers = {
        "content-type": "application/json",
        "Authorization": f"Bearer {jwt}",
        "anthropic-version": constants.ANTHROPIC_VERSION,
        **identity.build_identity_headers(None),
        **identity.build_trace_headers("start-plan"),
        constants.CAPTCHA_HEADER: param,
        constants.CAPTCHA_REGION_HEADER: "cn",
    }
    url = settings.UPSTREAM["zai"]
    print(f"POST {url} identity_keys={sorted(k for k in headers if k.lower().startswith('x-'))}")

    r = requests.post(url, json=body, headers=headers, timeout=60)
    print(f"HTTP {r.status_code}")
    print("resp:", r.text[:500])
    if r.status_code == 200:
        try:
            data = r.json()
            content = data.get("content", [])
            print("RESULT content:", json.dumps(content, ensure_ascii=False)[:300])
        except Exception:
            pass


if __name__ == "__main__":
    main()
