#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""zcode.cjs 保留函数名的子系统聚类器 —— 41 号文档的可重跑工具。

方法（2026-09-27 定版）：
  1. 抽 bundle 内 ≥10 字符 camelCase 字符串字面量（保留的原始函数名/键）；
  2. **减去官方 TypeScript 5.9.2 全部标识符**——bundle vendored 了 TS 语言服务，
     约一半长名是它（开源，无逆向价值），不减会把长尾误读成未知区；
  3. 差集按 camelCase 前两段聚类成"命名空间家族"，与 41 篇文档求交，
     产出 ZCode 自有面的 已覆盖/未探索 地图。

用法：
  python cluster_symbols.py                 # 概览 + top 家族表
  python cluster_symbols.py --top 60        # 家族表条数
  python cluster_symbols.py --family session --words 1   # 看单个家族全部成员
  python cluster_symbols.py --json          # 机器可读
TS 缓存：tools/_ts_cache/typescript.js（缺失时自动从 npm 拉 5.9.2，~4.4MB）。
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import re
import sys
import tarfile
import urllib.request

BUNDLE = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "ZCode",
                      "resources", "glm", "zcode.cjs")
DOCS_GLOB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "*.md")
TS_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_ts_cache", "typescript.js")
TS_URL = "https://registry.npmjs.org/typescript/-/typescript-5.9.2.tgz"
TS_MEMBER = "package/lib/typescript.js"

TOKEN_RE = re.compile(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])")


def load_names():
    src = open(BUNDLE, encoding="utf-8", errors="replace").read()
    names = set(re.findall(r'"([a-z][a-zA-Z0-9]{9,63})"', src))
    names |= set(re.findall(r"'([a-z][a-zA-Z0-9]{9,63})'", src))
    return names


def load_ts_ids():
    if not os.path.exists(TS_CACHE):
        os.makedirs(os.path.dirname(TS_CACHE), exist_ok=True)
        tgz, _ = urllib.request.urlretrieve(TS_URL)
        with tarfile.open(tgz, "r:gz") as tf:
            with tf.extractfile(TS_MEMBER) as f, open(TS_CACHE, "wb") as out:
                out.write(f.read())
    ts = open(TS_CACHE, encoding="utf-8", errors="replace").read()
    return set(re.findall(r'\b([a-z][a-zA-Z0-9]{9,63})\b', ts)), TS_CACHE


def family_of(name: str, words: int = 2) -> str:
    toks = TOKEN_RE.findall(name)
    return ".".join(t.lower() for t in toks[:words])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--family", default="", help="列出单个家族的全部成员")
    ap.add_argument("--words", type=int, default=2, help="家族键取前几段（默认 2）")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    names = load_names()
    ts_ids, ts_path = load_ts_ids()
    own = names - ts_ids
    doc_text = ""
    for f in glob.glob(DOCS_GLOB):
        doc_text += open(f, encoding="utf-8", errors="replace").read()

    if a.family:
        members = sorted(n for n in own if family_of(n, a.words) == a.family.lower()
                         or n.lower().startswith(a.family.lower()))
        print(json.dumps({"family": a.family, "count": len(members),
                          "members": members}, ensure_ascii=False, indent=2))
        return 0

    fams = collections.defaultdict(list)
    for n in own:
        fams[family_of(n, a.words)].append(n)
    for k in fams:
        fams[k].sort()

    rows = []
    for k, members in fams.items():
        covered = sum(1 for m in members if m in doc_text)
        rows.append({"family": k, "count": len(members), "covered_members": covered,
                     "untouched": covered == 0,
                     "sample": members[:4]})
    rows.sort(key=lambda r: -r["count"])

    result = {
        "bundle": BUNDLE,
        "ts_source": ts_path,
        "bundle_long_names": len(names),
        "ts_identifiers": len(ts_ids),
        "own_names": len(own),
        "total_families": len(fams),
        "untouched_names": sum(1 for n in own if n not in doc_text),
        "untouched_families": sum(1 for r in rows if r["untouched"]),
        "top": rows[:a.top],
    }
    if a.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    print("bundle 长名 %d − 官方 TS 标识符 %d = 自有面 %d → %d 个家族（前 %d 段聚类）"
          % (len(names), len(ts_ids), len(own), len(fams), a.words))
    print("文档未触碰的自有长名 %d 个；完全未触碰的家族 %d 个"
          % (result["untouched_names"], result["untouched_families"]))
    print("\n%-34s %5s %6s  %s" % ("家族", "成员", "已覆盖", "样例"))
    for r in rows[:a.top]:
        flag = "-" if r["untouched"] else ("%d" % r["covered_members"])
        print("%-34s %5d %6s  %s" % (r["family"], r["count"], flag, ", ".join(r["sample"][:3])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
