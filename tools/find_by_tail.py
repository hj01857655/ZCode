#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""按尾部指纹检索当前凭据。

    python find_by_tail.py OOeU

凭据经 tools/zk.py 在内存中解密，明文不落盘。
"""
import io
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import zk                                                       # noqa: E402

SUFFIX = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
d = zk.load()

print("检索后缀: %r" % SUFFIX)
print("-" * 70)
found = False
for k, v in sorted(d.items()):
    s = str(v)
    tail = s[-6:] if len(s) > 6 else s
    hit = (not SUFFIX) or s.endswith(SUFFIX)
    mark = "  <<< 命中" if hit else ""
    if hit:
        found = True
    print("%-6s %-24s len=%-5d  %s%s" % (tail, k.split(":")[-1][:24], len(s), tail, mark))
print("-" * 70)
print("命中: %s" % ("是" if found else "否 —— 当前凭据里没有以该串结尾的"))
