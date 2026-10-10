# -*- coding: utf-8 -*-
"""用 zcode2api 的完整头 + 身份块复刻官方 CLI 形态，验证 3012。

对照（单变量）：
  A 裸请求 + 简版头              → 基线
  B 裸请求 + 完整 CLI 头          → 单独检验请求头的作用
  C 身份块 + 简版头               → 单独检验请求体的作用
  D 身份块 + 完整 CLI 头（官方）   → 两者齐备

用法：python tools/e2e_3012b.py
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
sys.path.insert(0, str(ROOT / "zcode2api"))
import zk  # noqa: E402

ENDPOINT = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
MODEL = "GLM-5.3-Flash"
VER = "3.14.4"
TMP = Path(os.environ.get("TEMP", r"C:\Users\12925\AppData\Local\Temp"))
SYSJSON = TMP / "zcode-system.json"


def minimal(jwt):
    return {
        "Authorization": f"Bearer {jwt}", "x-api-key": jwt,
        "Content-Type": "application/json", "anthropic-version": "2023-06-01",
        "X-Title": "Z Code@electron", "X-Platform": "win32-x64",
    }


def full(jwt):
    """对齐 zcode2api src/upstream/headers.js:buildZcodePlanHeaders（CLI 形态）"""
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


def post(body, hdrs, timeout=60):
    req = urllib.request.Request(
        ENDPOINT, data=json.dumps(body).encode(), headers=hdrs, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(500).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(500).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return -1, f"{type(e).__name__}: {e}"


def build(cfg):
    dyn, env, cp, sr = (cfg["dynamicSections"], cfg["environment"],
                        cfg["contextPrefix"], cfg["systemReminder"])
    S = [{"role": "system", "content": cfg["cliPrefix"]}]
    for s in cfg["stableSections"]:
        S.append({"role": "system", "content": s})
    S.append({"role": "system", "content": dyn["beforeEnvironment"]})
    S.append({"role": "system", "content": "\n".join([
        env["heading"], env["invokedLine"],
        f"- {env['cwdLabel']}: {ROOT}",
        f"- {env['gitLabel']}: no",
        f"- {env['platformLabel']}: win32",
        f"- {env['shellLabel']}: powershell",
        f"- {env['osVersionLabel']}: {platform.version()}",
        env["poweredByLine"].replace("{provider}", "account:zai-start-plan").replace("{model}", MODEL),
    ])})
    S.append({"role": "system", "content": dyn["afterEnvironment"]})
    S.append({"role": "system", "content": "\n".join([
        f"{sr['open']}", cp["intro"], "", cp["currentDateHeading"],
        cp["currentDateLine"].replace("{date}", "2026-09-29"), cp["outro"],
        f"{sr['close']}",
    ])})
    return S


def main():
    if not SYSJSON.exists():
        print("!! 缺 zcode-system.json:", SYSJSON)
        return
    cfg = json.loads(SYSJSON.read_text(encoding="utf-8"))
    jwt = zk.token()
    S = build(cfg)
    body_s = {"model": MODEL, "max_tokens": 16,
              "messages": S + [{"role": "user", "content": "hi"}]}
    body_b = {"model": MODEL, "max_tokens": 16,
              "messages": [{"role": "user", "content": "hi"}]}

    for name, body, hf in [
        ("A 裸 + 简版头", body_b, minimal),
        ("B 裸 + 完整CLI头", body_b, full),
        ("C 身份块 + 简版头", body_s, minimal),
        ("D 身份块 + 完整CLI头", body_s, full),
    ]:
        st, txt = post(body, hf(jwt))
        print("[%s]  %d B" % (name, len(json.dumps(body).encode())))
        print("  HTTP %s  %s\n" % (st, txt[:230].replace("\n", " ")))


if __name__ == "__main__":
    main()

