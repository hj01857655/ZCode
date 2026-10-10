# -*- coding: utf-8 -*-
"""Live call: GET zcode.z.ai/api/v1/zcode-plan/billing/balance (read-only, own account).

Replicates the client's default request headers (buildZCodeSourceHeadersFromContext).
凭据经 tools/zk.py 在内存中解密，明文不落盘；无需任何参数。
（兼容旧的明文文件参数，已废弃。）
"""
import io
import json
import platform
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import zk                                                       # noqa: E402

token = zk.token()
device_mid = zk.device_mid()

ORIGIN = "https://zcode.z.ai"
VERSION = "3.14.3"
url = f"{ORIGIN}/api/v1/zcode-plan/billing/balance?app_version={VERSION}"

headers = {
    "Authorization": f"Bearer {token}",
    "User-Agent": f"ZCode/{VERSION}",
    "HTTP-Referer": ORIGIN,
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": VERSION,
    "X-Platform": f"{sys.platform}-{platform.machine().lower()}",
    "X-Release-Channel": "stable",
    "X-Client-Language": "zh-CN",
    "X-Client-Timezone": "Asia/Shanghai",
    "X-Os-Category": "windows",
    "X-Os-Version": platform.version(),
    "X-Device-Mid": device_mid,
    "x-request-id": str(uuid.uuid4()),
    "Accept": "*/*",
}

req = urllib.request.Request(url, method="GET", headers=headers)
try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        print("HTTP", resp.status)
except urllib.error.HTTPError as e:
    print("HTTP", e.code)
    body = e.read().decode("utf-8", errors="replace")

try:
    data = json.loads(body)
    print(json.dumps(data, ensure_ascii=False, indent=1))
except Exception:
    print(body[:2000])
