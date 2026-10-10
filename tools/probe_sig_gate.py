# -*- coding: utf-8 -*-
"""探测 coding plan key 的 V4 签名 gate 状态。

doc 05 §8：本账号（Start Plan 通道）的
  GET https://api.z.ai/api/v1/agent/configs  → {"code":500,"msg":"404 NOT_FOUND"}
  即 feature_gate 未配置 → 签名休眠。

本脚本对每个可用 key 跑一次该 gate，比对结果，判断是否有通道启用了签名。
只读 GET，不消耗额度。

    python tools/probe_sig_gate.py
"""
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import zk                                                       # noqa: E402

GATE = "https://api.z.ai/api/v1/agent/configs"
MODEL_INFO = "https://api.z.ai/api/v1/models"


def call(url, headers, method="GET"):
    try:
        with urllib.request.urlopen(
                urllib.request.Request(url, method=method, headers=headers), timeout=15) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)[:120]


def probe(label, headers):
    print("\n  %s" % label)
    st, body = call(GATE, headers)
    print("    HTTP %-4s %s" % (st, body[:230]))
    # 与 zcode-signing.ts fetchGate 同款判据
    try:
        p = json.loads(body)
    except Exception:
        print("    → fetchGate 归类: unavailable（非 JSON / 请求失败）")
        return
    if st == 200 and p.get("code") == 0:
        d = p.get("data") or {}
        if not isinstance(d, dict) or "codingPlanSignature" not in d:
            print("    → fetchGate 归类: **disabled**（有响应但无 codingPlanSignature 字段）")
        elif (d.get("codingPlanSignature") or {}).get("enable") is True:
            print("    → fetchGate 归类: **ENABLED** —— 签名已启用！")
        else:
            print("    → fetchGate 归类: **disabled**（enable 不为 true）")
    elif st == 200 and p.get("code") != 0:
        print("    → fetchGate 归类: **unavailable**（code=%s）—— 负缓存 30s，持续重试"
              % p.get("code"))
    else:
        print("    → fetchGate 归类: unavailable（HTTP %s）" % st)


def identity_headers(drop_agent=True):
    """zcode-signing.ts fetchGate 用的身份头：刻意**不带** X-ZCode-Agent / X-Device-Mid，
    也不带 Accept。UA 用裸串（模型请求才加 ai-sdk 后缀）。"""
    h = {"User-Agent": "ZCode/3.14.3", "X-Platform": "win32-x64",
         "X-Os-Category": "windows", "X-Os-Version": "10.0.26100",
         "X-Title": "Z Code@electron", "X-ZCode-App-Version": "3.14.3",
         "X-Client-Version": "3.14.3", "X-App-Id": "zcode",
         "X-Client-Ts": str(int(time.time() * 1000)),
         "X-Client-Nonce": os.urandom(16).hex()}
    if not drop_agent:
        h["X-ZCode-Agent"] = "ZCode/3.14.3"
        h["X-Device-Mid"] = "probe-device-mid"
    return h


def main():
    print("V4 签名 gate 探测 —— 只读，不消耗额度")
    print("判据与 zcode-signing.ts fetchGate 完全一致\n")

    # A) 旧方式：Authorization: Bearer + Accept（我最初用的，疑似错误）
    probe("A) individual key，Authorization: Bearer（我最初的错误方式）",
          dict(identity_headers(), Authorization="Bearer " + zk.plan_key("individual"),
               Accept="*/*"))

    # B) 官方方式：x-api-key 头，无 Accept，剥掉 X-ZCode-Agent / X-Device-Mid
    k = zk.plan_key("individual")
    probe("B) individual key，x-api-key 头（zcode-signing.ts 官方方式）",
          dict(identity_headers(), **{"x-api-key": k}))

    # C) 同上但保留 Agent/Device-Mid 头，验证"剥掉"是否必要
    probe("C) individual key，x-api-key + 保留 X-ZCode-Agent / X-Device-Mid",
          dict(identity_headers(drop_agent=False), **{"x-api-key": k}))

    # D) Start Plan
    probe("D) Start Plan zcodejwttoken，x-api-key 头",
          dict(identity_headers(), **{"x-api-key": zk.token()}))

    print("\n" + "=" * 66)
    print("三种归类的行为差异（第二来源 zcode-signing.ts probeGate）：")
    print("  disabled     → 正向缓存 1 小时（GATE_TTL_MS），认定关闭")
    print("  unavailable  → 负缓存 30 秒（GATE_UNAVAILABLE_COOLDOWN_MS），持续重试")
    print("  enabled      → 客户端才会进入签名路径")
    print("\n注意：code !== 0 归类为 unavailable，不是 disabled。")


if __name__ == "__main__":
    main()
