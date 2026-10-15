# -*- coding: utf-8 -*-
"""start-plan 全链 e2e 门测（3.15.1 重建版，替代坏死的 e2e_captcha_gate.py）。

三段，全部极小调用（max_tokens=32，"reply with: pong"）：
  A 负向：无验证码头打 zcode-plan 代理 → 预期 400/3007（证明闸门在新构建仍活）
  B 正向：captcha_solve.js 现解一次性 param → 带 X-Aliyun-Captcha-Verify-* 打同一代理
          → 预期 **非** 3007（本号当前 plans 为空，可能停在校权/额度层——记录真实码即达标）
  C 付费：zk.plan_key("individual") 打 api.z.ai/api/anthropic/v1/messages → 预期 200
          （验证 08/09 协议面在 3.15.1 存活；key 若失效则记录状态码）

param 单次有效，B 紧接 solve 之后。凭据全程经 zk 内存解密，输出不打印密钥。
用法：python tools/e2e_startplan_gate.py [--skip-b]
"""
import json
import sys
import time
import platform
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import probe_claim  # 复用 solve()/hdrs()/call()；它在 import 时已把 stdout 包成 utf-8，本脚本不可再包（双包装会 GC 关掉共享缓冲）  # noqa: E402
sys.stdout.reconfigure(line_buffering=True)

VER = "3.15.1"
PROXY = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
PAID = "https://api.z.ai/api/anthropic/v1/messages"
MODEL = "GLM-5.3-Flash"  # 37 §8：大小写敏感


def body():
    return {"model": MODEL, "max_tokens": 32, "stream": False,
            "messages": [{"role": "user", "content": "reply with: pong"}]}


def post(url, extra=None, raw_body=None):
    h = probe_claim.hdrs(extra)
    h["anthropic-version"] = "2023-06-01"
    data = json.dumps(raw_body or body()).encode()
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read(600).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(600).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return -1, f"{type(e).__name__}: {e}"


def identity_body():
    """37 §8.6 离线重建：按官方 builder 形状（kla/Vla + 18 号 §1 cacheHint 分组）装配身份块。
    静态文本全量来自 tools/zcode_system.json（cjs 3.15.1 提取）。默认零流量：仅 --send 才发。"""
    z = json.loads((Path(__file__).resolve().parent / "zcode_system.json").read_text(encoding="utf-8"))
    ident, env = z["identity"], z["environment"]
    labels = env["labels"]
    identity_text = "\n" + ident["sentence_no_output_style"] + "\n\n" + ident["security_preamble"]
    is_git = "yes"  # 与发送侧环境一致即可；网关审查的是块存在性/形状（37 §8.2 子因①，C 引用）
    env_text = "\n".join([
        env["prefix"], env["intro"],
        f"- {labels['cwd']}: {Path.cwd()}",
        f"- {labels['is_git']}: {env['yes'] if is_git else env['no']}",
        f"- {labels['platform']}: {sys.platform}",
        f"- {labels['shell']}: pwsh" if os_shell() == "windows" else f"- {labels['shell']}: bash",
        f"- {labels['os_version']}: {platform.version()}",
        env["model_line"].replace("{providerId}", "account:zai-start-plan").replace("{modelId}", MODEL),
    ])
    system = [
        {"type": "text", "text": identity_text},
        {"type": "text", "text": ident["harness"], "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": env_text, "cache_control": {"type": "ephemeral"}},
    ]
    b = body()
    b["system"] = system
    # 官方形状（开源仓 anthropic-request-metadata.ts 源码级确证，37 子因②）
    b["metadata"] = {"user_id": json.dumps({"device_id": zk.device_mid(), "account_uuid": "", "session_id": str(uuid.uuid4())})}
    return b


def os_shell():
    return "windows" if sys.platform == "win32" else sys.platform


def main():
    import zk  # noqa: PLC0415
    globals()["zk"] = zk

    if "--with-identity" in sys.argv:
        print("== 身份块装配（37 §8.6 离线重建）==")
        b = identity_body()
        print("  system_blocks=%d first_head=%r" % (len(b["system"]), b["system"][0]["text"][:46]))
        print("  metadata.user_id keys=%s" % sorted(json.loads(b["metadata"]["user_id"])))
        if "--send" in sys.argv:
            print("  ⚠ 即将发 live 请求——先确认 3012 冷却已清（37 §8.6 第 3 条：当日 A 段无 param 也 3012）")
            st, txt = post(PROXY, extra={
                "x-zcode-session-type": "main",
                "x-zcode-trace-id": str(uuid.uuid4()),
            }, raw_body=b)
            print("  HTTP", st, "|", txt[:300])
        else:
            print("  已装配未发送（零流量）；真发加 --send，且需另接 param（solver 复活后）")
        return

    print("== A 负向：无 param 无身份块 → §8.1 历史对照 3007；2026-10-13 实测已变 3012（37 §8.6）==")
    st, txt = post(PROXY)
    print("  HTTP", st, "|", txt[:300])

    if "--skip-b" not in sys.argv:
        print("\n== B 现解 param（完整无痕链）==")
        t0 = time.time()
        param, info = probe_claim.solve(tries=4)
        print("  %s (%.1fs)" % (info, time.time() - t0))
        if not param:
            print("  FAILED：正向过闸未测（solver 未过）")
        else:
            print("== B 正向：带 param 打同一代理 → §8.1 历史结果 3012（无身份块）；叠身份块后预期 200/计费层码 ==")
            st2, txt2 = post(PROXY, extra={
                "X-Aliyun-Captcha-Verify-Param": param,
                "X-Aliyun-Captcha-Verify-Region": "cn",
            })
            print("  HTTP", st2, "|", txt2[:300])

    print("\n== C 付费 individual：x-api-key 直打官方端点 → 预期 200 ==")
    try:
        key = __import__("zk").plan_key("individual")
    except SystemExit as e:
        key = None
        print("  无 individual api-key：", e)
    if key:
        h = {"x-api-key": key, "anthropic-version": "2023-06-01",
             "content-type": "application/json"}
        req = urllib.request.Request(PAID, data=json.dumps(body()).encode(),
                                     headers=h, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                txt = r.read(400).decode("utf-8", "replace")
                print("  HTTP", r.status, "|", txt[:300])
        except urllib.error.HTTPError as e:
            print("  HTTP", e.code, "|", e.read(300).decode("utf-8", "replace"))
        except Exception as e:  # noqa: BLE001
            print("  ", type(e).__name__, e)

    print("\n判定：A 出 3007 或 3012 均为闸门活着（码序变迁见 37 §8.6）；B 非 3007=param 被接、配合 --with-identity 验 3012 解除；C 200=付费全活，429/1113=认证过仅缺额度。发 live 前先读 37 §8.5/8.6（3012 冷却约束）。")


if __name__ == "__main__":
    main()
