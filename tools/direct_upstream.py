# -*- coding: utf-8 -*-
"""绕过 zcode2api 的池判据（remaining<=0 会把号排除），直连 zcode.z.ai 发一发。

用途：额度耗尽时也能验证「请求形态 + 账号状态」是否真的正常——
上游对耗尽账号应回业务码 1005（额度尽），而不是 3012（被拦）。

用法：python tools/direct_upstream.py [model]
"""
import io
import json
import os
import platform
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import zk  # noqa: E402

ENDPOINT = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
VER = "3.14.4"
TMP = Path(os.environ.get("TEMP", r"C:\Users\12925\AppData\Local\Temp"))
SYSJSON = TMP / "zcode-system.json"


def headers(jwt):
    return {
        "accept-encoding": "gzip",
        "anthropic-version": "2023-06-01",
        "authorization": f"Bearer {jwt}",
        "content-type": "application/json",
        "http-referer": "https://zcode.z.ai",
        "user-agent": f"ZCode/{VER} ai-sdk/anthropic/3.0.81",
        "x-api-key": jwt,
        "x-client-language": "zh-CN",
        "x-client-timezone": "Asia/Shanghai",
        "x-os-category": "windows",
        "x-os-version": platform.version(),
        "x-platform": "win32-x64",
        "x-release-channel": "production",
        "x-request-id": str(uuid.uuid4()),
        "x-title": "Z Code@cli",
        "x-zcode-agent": "glm",
        "x-zcode-app-version": VER,
        "x-zcode-session-type": "main",
        "x-zcode-trace-id": str(uuid.uuid4()),
    }


def build(cfg, model):
    dyn, env, cp, sr = (cfg["dynamicSections"], cfg["environment"],
                        cfg["contextPrefix"], cfg["systemReminder"])
    S = [{"role": "system", "content": cfg["cliPrefix"]}]
    for s in cfg["stableSections"]:
        S.append({"role": "system", "content": s})
    S.append({"role": "system", "content": dyn["beforeEnvironment"]})
    S.append({"role": "system", "content": "\n".join([
        env["heading"], env["invokedLine"],
        f"- {env['cwdLabel']}: {ROOT}", f"- {env['gitLabel']}: no",
        f"- {env['platformLabel']}: win32", f"- {env['shellLabel']}: powershell",
        f"- {env['osVersionLabel']}: {platform.version()}",
        env["poweredByLine"].replace("{provider}", "account:zai-start-plan").replace("{model}", model),
    ])})
    S.append({"role": "system", "content": dyn["afterEnvironment"]})
    S.append({"role": "system", "content": "\n".join([
        sr["open"], cp["intro"], "", cp["currentDateHeading"],
        cp["currentDateLine"].replace("{date}", "2026-09-30"), cp["outro"], sr["close"],
    ])})
    return S


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else "glm-5.3-flash"
    cfg = json.loads(SYSJSON.read_text(encoding="utf-8"))
    # 优先用 zcode2api 账号池里的凭据（可能与当前 ZCode 登录的号不同）
    acc_dir = ROOT / "zcode2api" / "accounts"
    jwt, src = zk.token(), "credentials.json"
    for f in sorted(acc_dir.glob("*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            if d.get("jwt"):
                jwt, src = d["jwt"], f.name
                break
        except Exception:
            pass
    body = {"model": model, "max_tokens": 16,
            "messages": build(cfg, model) + [{"role": "user", "content": "hi"}]}
    print("凭据来源: %s" % src)
    print("model=%s  body=%d B  (直连，绕过池判据)\n" % (model, len(json.dumps(body).encode())))
    req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(),
                                 headers=headers(jwt), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            print("HTTP", r.status)
            print(r.read(700).decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        print("HTTP", e.code)
        print(e.read(700).decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001
        print("ERR", type(e).__name__, e)


if __name__ == "__main__":
    main()
