# -*- coding: utf-8 -*-
"""直连阿里云 InitCaptcha 接口，看 init 响应给什么（CaptchaType / JsPath / PowVerifyString）。"""
import io
import json
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PREFIX = "no8xfe"
SCENE = "11xygtvd"
URL = f"https://{PREFIX}.captcha-open.aliyuncs.com/?appid={SCENE}"

body = {
    "appId": SCENE,
    "sceneId": SCENE,
    "prefix": PREFIX,
    "region": "cn",
    "userAgent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    ),
    "isH5": True,
    "platform": "win32",
    "width": 1920,
    "height": 1080,
    "lang": "zh-CN",
    "devicePlatform": "web",
    "sdkVersion": "3.29.0",
}

req = urllib.request.Request(
    URL,
    data=json.dumps(body).encode(),
    headers={
        "Content-Type": "application/json",
        "User-Agent": body["userAgent"],
        "Referer": "https://zcode.z.ai/",
        "Origin": "https://zcode.z.ai",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        txt = r.read(4000).decode("utf-8", "replace")
        print("HTTP", r.status)
        try:
            d = json.loads(txt)
            print(json.dumps(d, ensure_ascii=False, indent=1)[:2200])
        except Exception:
            print(txt[:1500])
except Exception as e:  # noqa: BLE001
    print("ERR", type(e).__name__, e)
    if hasattr(e, "read"):
        print(e.read(600).decode("utf-8", "replace"))
