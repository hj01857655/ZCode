#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""列出当前账号的所有套餐与额度桶（只读）。

复用 tools/call_balance.py 的取数逻辑，凭据全程在内存中处理。

注：响应结构的权威记录在 docs/zcode-plan-03（§2.1 plans / §2.2 balances / §2.3 多桶）。
结构探针见 tools/probe_billing_shape.py。
"""
import io
import json
import subprocess
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
HERE = Path(__file__).resolve().parent

out = subprocess.run([sys.executable, str(HERE / "call_balance.py")],
                     capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
try:
    d = json.loads(out[out.index("{"):])
except Exception as e:
    raise SystemExit("call_balance.py 无输出：\n" + out[:400])

print("=" * 74)
print("当前账号的套餐")
print("=" * 74)
for p in d["data"]["plans"]:
    print("PLAN  %-34s priority=%s" % (p["plan_id"], p["priority"]))
    print("      %s   status=%s" % (p["name"], p["status"]))
    print("      %s" % p["description"])
    print("      %s -> %s" % (p["starts_at"], p["ends_at"]))
    for e in p["entitlements"]:
        print("      - %-16s %14s  %-9s caps=%s" % (
            e["show_name"], format(e["grant_units"], ","), e["period"],
            ",".join(e["capabilities"])))
    print()

print("=" * 74)
print("额度桶（实际可扣的）")
print("=" * 74)
tot = 0
for b in d["data"]["balances"]:
    print("%-16s 可用 %14s / 共 %14s   已用 %12s" % (
        b["show_name"], format(b["available_units"], ","),
        format(b["total_units"], ","), format(b["used_units"], ",")))
    print("%-16s 周期 %s -> %s   prio=%s/%s/%s" % (
        "", b["period_start"], b["period_end"],
        b["priority"], b["plan_priority"], b["entitlement_priority"]))
    tot += b["available_units"]
print()
print("合计可用: %s" % format(tot, ","))
