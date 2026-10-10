"""验证 api.z.ai 账户类端点到底认哪种凭据。

起因：此前断言「api.z.ai 的账户/认证接口与付费无关，两类凭据都能打」——
该断言**未经实测**，且与同域 `getCustomerInfo` 对 api-key 返回
`403 APIKey not allow access` 相矛盾。此脚本用两类凭据分别打同一批端点，
只读，不消耗额度，不打印凭据。

    python tools/check_credential_scopes.py
"""
import io
import sys
from pathlib import Path

import requests

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import zk                                                       # noqa: E402

HOST = "https://api.z.ai"
ENDPOINTS = [
    ("/api/biz/subscription/list", "GET", None),
    ("/api/biz/customer/getCustomerInfo", "GET", None),
    ("/api/monitor/usage/quota/limit", "GET", None),
    ("/api/v1/agent/configs", "GET", None),
    ("/api/anthropic/v1/messages", "POST", {"model": "GLM-5.3-Flash", "max_tokens": 8,
                                            "messages": [{"role": "user", "content": "ping"}]}),
    ("/api/auth/z/login", "POST", {"token": "<invalid-probe>"}),
]


def probe(label, cred):
    print("\n" + label)
    for path, method, body in ENDPOINTS:
        h = {"Content-Type": "application/json", "User-Agent": "ZCode/3.14.3"}
        h.update(cred)
        try:
            if method == "POST":
                r = requests.post(HOST + path, headers=h, json=body, timeout=20)
            else:
                r = requests.get(HOST + path, headers=h, timeout=20)
            txt = " ".join(r.text[:110].split())
            print("  %-38s %-4s %s" % (path, r.status_code, txt))
        except Exception as e:
            print("  %-38s ERR  %s" % (path, str(e)[:60]))


def main():
    print("api.z.ai 端点 × 凭据类型 对照（只读探测）\n" + "=" * 62)
    probe("A) individual api-key  {id}.{secret}", {"Authorization": "Bearer " + zk.plan_key("individual"),
                                                  "x-api-key": zk.plan_key("individual")})
    probe("B) Start Plan  zcodejwttoken（JWT）", {"Authorization": "Bearer " + zk.token()})


if __name__ == "__main__":
    main()
