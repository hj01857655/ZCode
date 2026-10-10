# -*- coding: utf-8 -*-
"""查 Start Plan 额度与可领取套餐。

- probe：只读，查余额 + 试若干 preview 路径（不消耗额度）
- claim：真正领取（写操作，会消耗每日额度），需 plan_id
用法：
  python tools/probe_claim.py probe
  python tools/probe_claim.py claim <plan_id>
"""
import io
import json
import platform
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import zk  # noqa: E402

ORIGIN = "https://zcode.z.ai"
VER = "3.14.4"


def hdrs(extra=None):
    h = {
        "Authorization": f"Bearer {zk.token()}",
        "User-Agent": f"ZCode/{VER}",
        "HTTP-Referer": ORIGIN,
        "X-Title": "Z Code@electron",
        "X-ZCode-App-Version": VER,
        "X-Platform": f"{sys.platform}-{platform.machine().lower()}",
        "X-Release-Channel": "stable",
        "X-Client-Language": "zh-CN",
        "X-Client-Timezone": "Asia/Shanghai",
        "X-Os-Category": "windows",
        "X-Os-Version": platform.version(),
        "X-Device-Mid": zk.device_mid(),
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def call(url, method="GET", body=None, extra=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=hdrs(extra), method=method)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, r.read(900).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(900).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return -1, f"{type(e).__name__}: {e}"


def probe():
    print("== 1. balance ==")
    st, txt = call(f"{ORIGIN}/api/v1/zcode-plan/billing/balance?app_version={VER}")
    print("  HTTP", st)
    print("  ", txt[:500])

    print("\n== 2. preview 候选路径（只读） ==")
    for p in ["/api/v1/zcode-plan/billing/preview?platform=windows-x86_64"]:
        st, txt = call(ORIGIN + p)
        print("  %-58s HTTP %s" % (p.replace(ORIGIN, ""), st))
        if st == 200:
            try:
                d = json.loads(txt)["data"]
                for pl in d.get("plans", []):
                    print("    plan_id  :", pl.get("plan_id"))
                    print("    name     :", pl.get("name"))
                    print("    priority :", pl.get("priority"))
                    for e in pl.get("entitlements", []):
                        print("      - %-20s meter=%-14s grant=%-8s unit=%s"
                              % (e.get("show_name"), e.get("meter"),
                                 e.get("grant_units"), e.get("unit_type")))
                        print("        caps:", e.get("capabilities"))
            except Exception as ex:  # noqa: BLE001
                print("    (parse fail %s)" % ex, txt[:400])



def solve(tries=4):
    """调 node tools/captcha_solve.js 解 param（一次性，用完即弃）。阿里云轮换 PoW 包，
    happy-dom 环境偶尔过不去，重试若干次。"""
    import subprocess
    node = Path(__file__).resolve().parent / "captcha_solve.js"
    for i in range(tries):
        r = subprocess.run(
            ["node", str(node)], capture_output=True, text=True, timeout=150,
            encoding="utf-8", errors="replace",      # node 输出是 UTF-8，Windows 默认 GBK 会炸
            cwd=str(Path(__file__).resolve().parent.parent),
        )
        out = (r.stdout or "").strip().splitlines()
        if out:
            try:
                d = json.loads(out[-1])
                if d.get("ok") and d.get("param"):
                    info = "certifyId=%s  hasToken=%s  len=%s  (第%d次)" % (
                        d.get("certifyId"), d.get("hasToken"), d.get("len"), i + 1)
                    return d["param"], info
                last = json.dumps(d, ensure_ascii=False)[:160]
            except Exception:
                last = "bad json: " + out[-1][:120]
        else:
            last = "no output: " + (r.stderr or "")[-160:]
        print("     尝试 %d 未成功：%s" % (i + 1, last))
    return None, "全部尝试失败"


def claim(plan_id):
    print("== 1. 解验证码（完整流程：FeiLin + PoW）==")
    param, info = solve()
    if not param:
        print("  FAILED:", info)
        return
    print("  OK  %s" % info)

    print("\n== 2. 领取 plan_id=%s ==" % plan_id)
    st, txt = call(
        f"{ORIGIN}/api/v1/zcode-plan/billing/claim",
        method="POST",
        body={"plan_id": plan_id},
        extra={
            "X-Aliyun-Captcha-Verify-Param": param,
            "X-Aliyun-Captcha-Verify-Region": "cn",
        },
    )
    print("  HTTP", st)
    print("  ", txt[:900])

    print("\n== 3. 复查余额 ==")
    st2, txt2 = call(f"{ORIGIN}/api/v1/zcode-plan/billing/balance?app_version={VER}")
    print("  HTTP", st2)
    print("  ", txt2[:600])


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)   # 实时输出，便于观察重试
    if len(sys.argv) > 1 and sys.argv[1] == "claim" and len(sys.argv) > 2:
        claim(sys.argv[2])
    else:
        probe()
