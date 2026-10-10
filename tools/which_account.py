#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""确认当前是哪个号：ZCode 侧 vs Breezell 侧是否同一个账号。

排障第一步（见 doc 37 §4：多号并存先确认在测谁）。
凭据经 tools/zk.py 在内存中解密，明文不落盘；无需任何参数。
"""
import io
import json
import os
import sqlite3
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import zk                                                       # noqa: E402

print("=" * 66)
print("A) ZCode 侧（~/.zcode/v2/credentials.json 内存解密）")
print("=" * 66)
d = zk.load()
for k, v in sorted(d.items()):
    s = str(v)
    if any(x in k for x in ("user_info", "access_token", "jwttoken", "api-key",
                            "active_provider", "login_attribution")):
        print("  %s" % k)
        print("      -> %s" % (s if len(s) < 150 else s[:150] + "…"))

print()
print("=" * 66)
print("B) Breezell 侧（userInfo.cache）")
print("=" * 66)
p = os.path.join(os.environ["APPDATA"], "Breezell", "User", "globalStorage", "state.vscdb")
con = sqlite3.connect(p)
r = con.execute("SELECT value FROM ItemTable WHERE key=?", ("breezell.userInfo.cache",)).fetchone()
con.close()
if r:
    b = json.loads(r[0])
    print("  email  = %s" % b.get("email"))
    print("  plan   = %s    tokens = %s" % (b.get("plan"), b.get("tokens")))
    ma = (b.get("modeAccess") or {}).get("entanglement") or {}
    print("  modeAccess.entanglement = %s" % json.dumps(ma, ensure_ascii=False))
else:
    print("  (无缓存)")
