#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把当前账号所有凭据完整导出，按用途分类，标出认证头格式。

凭据经 tools/zk.py 在内存中解密，明文不落盘；无需任何参数。
"""
import io
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import zk                                                       # noqa: E402

d = zk.load()

KIND = [
    ("zcodejwttoken", "Start/Build 额度", "Authorization: Bearer",
     "zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"),
    ("access_token", "OAuth 业务 token", "Authorization: Bearer", "按 doc 10 的接口族"),
    ("api-key", "付费 coding plan", "Authorization: Bearer",
     "api.z.ai|open.bigmodel.cn 的 /api/anthropic"),
    ("pass_hash", "远程控制", "—", "—"),
]

print("=" * 78)
print("当前账号凭据（完整值）")
print("=" * 78)
for k, v in sorted(d.items()):
    s = str(v)
    kind = auth = ep = ""
    for frag, a, b, c in KIND:
        if frag in k:
            kind, auth, ep = a, b, c
            break
    if not kind:
        kind = "其他"
    print()
    print("KEY      %s" % k)
    print("用途     %s" % kind)
    if auth != "—":
        print("认证头   %s" % auth)
        print("端点     %s" % ep)
    print("长度     %d" % len(s))
    print("值       %s" % s)
    if len(s) > 60 and s.count(".") >= 2:
        import base64
        try:
            pad = lambda x: x + "=" * (-len(x) % 4)
            payload = s.split(".")[1]
            dec = base64.urlsafe_b64decode(pad(payload)).decode("utf-8", "replace")
            print("JWT载荷  %s" % dec)
        except Exception as e:
            print("JWT载荷  (解不开: %s)" % e)
