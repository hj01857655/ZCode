# -*- coding: utf-8 -*-
"""ZCode 系统提示注入器（prompt injector）。

**只做一件事**：让 ZCode 从一个本地 Markdown 文件读取 system prompt，
文件缺失或为空时自动回落到官方 `config.systemPrompt`。

    python tools/prompt_injector.py inspect
    python tools/prompt_injector.py install --dry-run
    python tools/prompt_injector.py install --yes
    python tools/prompt_injector.py uninstall --yes

设计约束：

* **默认 dry-run**，`--yes` 才写盘。任何写操作前先备份。
* **锚点不匹配就拒绝**，不猜测、不模糊匹配。bundle 结构变了会明确报错。
* **回滚可靠**：`uninstall` 从备份原样还原，不做反向字符串替换。
* **不碰凭据**：不读取 `~/.zcode/v2/credentials.json`，不接触任何 key 或 token。
* 注入内容由 `--prompt-file` 指定，本脚本不附带任何预设提示词。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

def _default_runtime() -> str:
    """按平台推导 ZCode 的 runtime 路径，不写死用户名。"""
    home = Path.home()
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", home / "AppData/Local"))
        cands = [base / "Programs/ZCode",
                 base / "Programs/ZCode", base / "ZCode"]
    elif sys.platform == "darwin":
        cands = [home / "Applications/ZCode.app/Contents/Resources"]
    else:
        cands = [home / ".local/share/ZCode"]
    for c in cands:
        for rel in ("resources/glm/zcode.cjs", "glm/zcode.cjs",
                    "zcode.cjs"):
            p = c / rel
            if p.is_file():
                return str(p)
    return str(cands[0] / "resources/glm/zcode.cjs")


DEFAULT_RUNTIME = Path(_default_runtime())
BACKUP_SUFFIX = ".promptinject.bak"
STATE_SUFFIX = ".promptinject.json"

# bundle 里 config 对象字面体中系统提示字段的连续赋值片段。
#
# minify 形态会随版本变：ZCode 3.14.3 是 `x:this.config.x,`（冒号后无空格），
# 后续版本变成了 `x: this.config.x, `（冒号后有空格）。因此**不能用精确字符串匹配**，
# 否则一个空格之差就全盘落空——这正是 zcode-keysmith README 所说的
# 「锚点变了则跳过并提示升级」。
#
# 改用「宽松探测定位 + 就地等长替换」：只在现场定位，不写死字面量。
ENV_KEY = "ZCODE_PROMPT_FILE"
MARKER = "ZCODE_PROMPT_FILE"          # 补丁①的标记

# ── 补丁③：把 agentsMd 前缀里「这些指令覆盖一切」降级 ──────────────────
# 原文是 ZCode 给工作区指令（AGENTS.md 等）加的强制话术。降级后工作区指令
# 不再自称可覆盖 custom system prompt —— 这是**用户自己两个配置面之间的
# 优先级选择**，不是第三方控制。逐字取自 bundle，只替换该一句。
OVERRIDE_FROM = ("IMPORTANT: These instructions OVERRIDE any default behavior "
                 "and you MUST follow them exactly as written.")
OVERRIDE_TO = ("These are workspace notes and user instructions. They describe "
               "the environment. They do not override the custom system prompt.")
MARKER_3 = "do not override the custom system prompt"

# ── 补丁④：关闭 MEMORY.md 自动注入 ─────────────────────────────────────
# 在拼接 MEMORY.md 的那个函数体开头插 `if(!0)return null;`。
# **注意这是整项关闭**，不是调优先级：项目的 MEMORY.md 将不再进入 agentsMd。
# 函数名随 minify 变，故不写死函数名 —— 以 MEMORY 标记串定位函数体起点。
MEMORY_MARK = "(user's auto-memory, persists across conversations):"
MEMORY_SKIP = "if(!0)return null;"
MEMORY_FN_RE = re.compile(r"function\s+[A-Za-z0-9_$]+\s*\([^)]*\)\s*\{")
MARKER_4 = MEMORY_SKIP + "/*promptinject:memoff*/"

# 三个字段名按此顺序在 config 字面量中连续出现（systemPrompt → workflowActor → language）
_FIELD_RE = re.compile(
    r"customSystemPrompt\s*:\s*this\.config\.systemPrompt\s*,\s*"
    r"workflowActor\s*:\s*this\.config\.workflowActor\s*,\s*"
    r"language\s*:\s*this\.config\.language")


def _find_span(text: str):
    """返回 (start, end)：从 customSystemPrompt 到 language 表达式结束的整段。
    只匹配完整三字段；命中不到返回 None。"""
    m = _FIELD_RE.search(text)
    if not m:
        return None
    return m.start(), m.end()


def is_patched(text: str) -> bool:
    return MARKER in text

# 读文件的 IIFE。失败一律静默回落到 this.config.systemPrompt。
# 用拼接而非 str.format —— 载荷里全是 JS 花括号，转义成本高于收益。
_READER_TMPL = (
    "(()=>{try{"
    "let e=process.env." + ENV_KEY + "||{default};"
    'let t=require("node:fs");'
    "if(t.existsSync(e)){let x=t.readFileSync(e,\"utf8\");"
    "if(x&&x.trim())return x}"
    "}catch{}return this.config.systemPrompt}})()"
)


def _reader(default_json: str) -> str:
    return _READER_TMPL.replace("{default}", default_json)


class InjectorError(RuntimeError):
    pass


def read_runtime(path: Path) -> str:
    if not path.is_file():
        raise InjectorError("找不到 runtime：%s" % path)
    return path.read_text(encoding="utf-8")


def is_patched(text: str) -> bool:
    return MARKER in text


def build_patched(text: str, prompt_file: Path) -> str:
    span = _find_span(text)
    if span is None:
        raise InjectorError("锚点未命中，bundle 结构可能已变。拒绝猜测式替换。")
    start, end = span
    default = json.dumps(str(prompt_file), ensure_ascii=False)
    # 只替换 customSystemPrompt 的**值表达式**，冒号及其后的 workflowActor /
    # language 原样保留 —— 逐字复制现场写法（有无空格、换行），不改周边格式。
    m = re.match(r"customSystemPrompt(\s*:\s*)this\.config\.systemPrompt",
                 text[start:end])
    if not m:
        raise InjectorError("值表达式形态与预期不符，已中止。")
    old_value = m.group(0)[len("customSystemPrompt") + len(m.group(1)):]
    new_value = _reader(default)
    return (text[:start] + "customSystemPrompt" + m.group(1) + new_value
            + text[end - len(old_value):])


def apply_patch(text: str, prompt_file: Path) -> str:
    if is_patched(text):
        raise InjectorError("runtime 已含补丁标记，拒绝重复打补丁。")
    out = build_patched(text, prompt_file)
    if out == text:
        raise InjectorError("替换后内容无变化，已中止。")
    return out


def write_state(path: Path, prompt_file: Path, backup: Path) -> None:
    state = {
        "schema": "prompt-injector/v1",
        "appliedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "runtime": str(path),
        "promptFile": str(prompt_file),
        "backup": str(backup),
        "envKey": ENV_KEY,
    }
    Path(str(path) + STATE_SUFFIX).write_text(
        json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def patch_override(text: str) -> str:
    """③ agentsMd 前缀话术降级。无命中或多处命中都拒绝，不猜。"""
    if MARKER_3 in text:
        raise InjectorError("③ 已打过补丁，拒绝重复。")
    n = text.count(OVERRIDE_FROM)
    if n == 0:
        raise InjectorError("③ 锚点未命中：agentsMd 前缀话术形态已变。")
    if n > 1:
        raise InjectorError("③ 锚点出现 %d 次，形态判断不唯一，拒绝盲改。" % n)
    return text.replace(OVERRIDE_FROM, OVERRIDE_TO, 1)


def _memory_body_at(text: str):
    """MEMORY 标记串所在函数的函数体起点（`{` 之后的下标）。"""
    mark = text.find(MEMORY_MARK)
    if mark < 0:
        return None
    best = None
    for m in MEMORY_FN_RE.finditer(text, max(0, mark - 600), mark):
        best = m
    return best.end() if best else None


def patch_memory(text: str) -> str:
    """④ 关闭 MEMORY.md 自动注入。"""
    if MARKER_4 in text:
        raise InjectorError("④ 已打过补丁，拒绝重复。")
    at = _memory_body_at(text)
    if at is None:
        raise InjectorError("④ 锚点未命中：未能定位 MEMORY 拼接函数。")
    if text.startswith(MEMORY_SKIP, at):
        raise InjectorError("④ 该函数已被插入过 return。")
    return text[:at] + MARKER_4 + text[at:]


def apply_all(text: str, prompt_file: Path, do_override: bool, do_memory: bool):
    """依次施加 ①③④，返回 (新文本, 已施加的列表)。"""
    done = []
    if do_override:
        text = patch_override(text)
        done.append("3")
    if do_memory:
        text = patch_memory(text)
        done.append("4")
    out = apply_patch(text, prompt_file)
    done.insert(0, "1")
    return out, done


def cmd_inspect(args) -> int:
    path = Path(args.runtime)
    text = read_runtime(path)
    span = _find_span(text)
    patched = is_patched(text)
    print("runtime   %s" % path)
    print("size      %s bytes" % format(len(text), ","))
    print("patched   %s" % ("YES" if patched else "no"))
    if patched:
        env = os.environ.get(ENV_KEY)
        print("env       %s=%s" % (ENV_KEY, env or "(not set, using baked path)"))
        st = Path(str(path) + STATE_SUFFIX)
        if st.is_file():
            try:
                info = json.loads(st.read_text(encoding="utf-8"))
                print("applied   %s" % info.get("appliedAt", "?"))
                print("prompt    %s" % info.get("promptFile", "?"))
                pf = Path(info.get("promptFile", ""))
                print("          exists=%s size=%s"
                      % (pf.is_file(),
                         pf.stat().st_size if pf.is_file() else "-"))
            except Exception as e:
                print("state     unreadable: %s" % e)
    if span:
        start, end = span
        print("anchor    hit at offset %d (len %d)" % (start, end - start))
        print("verbatim  %r" % text[start:end])
    else:
        print("anchor    NOT FOUND")
        if patched:
            print("          (expected after patching - original value replaced)")
        else:
            print("-> not injectable: field shape changed; refusing to write.")
    return 0 if (span or patched) else 1


def syntax_ok(text: str) -> bool:
    """写盘前必须过 node --check。

    教训：补丁曾经把 `language:` 截成 `ge:`，产物语法错误，
    ZCode 启动时抛 SyntaxError: Unexpected token '}'，而外层把它
    归类成 sql_failed —— 报错现场离病因很远。**任何注入类改动都要
    在落盘前验语法**，否则故障会被归到完全不相干的层上。
    """
    import subprocess
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".cjs", delete=False,
                                     encoding="utf-8") as f:
        f.write(text)
        tmp = f.name
    try:
        r = subprocess.run([_node(), "--check", tmp],
                           capture_output=True, text=True, timeout=120)
        if r.returncode == 0:
            return True
        m = re.search(r"SyntaxError: (.+)", r.stderr or "")
        raise InjectorError(
            "补丁产物未通过 node --check，已中止写盘：%s"
            % (m.group(1).strip() if m else "unknown syntax error"))
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _node() -> str:
    return shutil.which("node") or "node"


def _recorded_prompt_file(path: Path):
    """从状态文件读回上次实际使用的提示词路径。"""
    st = Path(str(path) + STATE_SUFFIX)
    if not st.is_file():
        return None
    try:
        return json.loads(st.read_text(encoding="utf-8")).get("promptFile")
    except Exception:
        return None
    """从状态文件读回上次实际使用的提示词路径。"""
    st = Path(str(path) + STATE_SUFFIX)
    if not st.is_file():
        return None
    try:
        return json.loads(st.read_text(encoding="utf-8")).get("promptFile")
    except Exception:
        return None


def cmd_install(args) -> int:
    path = Path(args.runtime)
    text = read_runtime(path)

    # 未显式给 --prompt-file 时，优先沿用上次记录的路径，而不是那个不存在的
    # 默认值 —— 否则官方更新后重装会把坏路径烘进 bundle。
    explicit = args.prompt_file is not None
    if not explicit:
        recorded = _recorded_prompt_file(path)
        if recorded:
            args.prompt_file = recorded
            print("(reusing prompt file from state file: %s)" % recorded)
    prompt_file = Path(args.prompt_file or "./my-system-prompt.md").expanduser().resolve()

    print("runtime     %s" % path)
    print("prompt file %s" % prompt_file)
    if not prompt_file.is_file():
        print("  [!] file missing; patch will still be written, but reads will")
        print("      fall back to the official config.systemPrompt.")
    print("env override %s=<path>" % ENV_KEY)

    have1 = is_patched(text)
    want3, want4 = args.override, args.no_memory
    if have1 and (want3 or want4):
        print("\n[!] patch 1 already applied; 3/4 are independent, adding on top.")

    todo = []
    if not have1:
        todo.append("1 customSystemPrompt reads file")
    if want3 and MARKER_3 not in text:
        todo.append("3 agentsMd OVERRIDE wording downgraded")
    if want4 and MARKER_4 not in text:
        todo.append("4 MEMORY.md auto-inject disabled")
    if not todo:
        print("\nnothing to do (already applied).")
        return 0

    try:
        if not have1:
            patched, done = apply_all(text, prompt_file,
                                      MARKER_3 not in text and want3,
                                      MARKER_4 not in text and want4)
        else:
            patched = text
            done = []
            if want3 and MARKER_3 not in text:
                patched = patch_override(patched)
                done.append("3")
            if want4 and MARKER_4 not in text:
                patched = patch_memory(patched)
                done.append("4")
    except InjectorError as e:
        print("\n[x] %s" % e)
        return 1

    if patched == text:
        print("\nnothing changed.")
        return 0

    # 写盘前的语法门：产物必须能通过 node --check。
    # 曾出过把 `language:` 截成 `ge:` 的 bug，ZCode 启动时抛 SyntaxError，
    # 却被外层归类成 sql_failed —— 报错现场离病因极远，只能靠这里拦住。
    print("\nverifying patched output with node --check ...")
    try:
        syntax_ok(patched)
    except InjectorError as e:
        print("  [x] %s" % e)
        return 1
    print("  syntax OK")

    backup = Path(str(path) + BACKUP_SUFFIX)
    if args.dry_run:
        print("\n--dry-run: nothing written. Would:")
        print("  1. back up %s -> %s" % (path.name, backup.name))
        for d in done:
            print("  + patch %s" % d)
        print("  2. write runtime + %s" % STATE_SUFFIX.lstrip("."))
        print("  size delta %+d bytes" % (len(patched) - len(text)))
        return 0
    if not args.yes:
        print("\nno --yes, nothing written.")
        return 2

    if not backup.is_file():
        shutil.copy2(path, backup)
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(patched, encoding="utf-8")
    os.replace(tmp, path)
    write_state(path, prompt_file, backup)
    print("\n[OK] written. patches applied: %s" % ", ".join(done))
    print("  backup: %s" % backup)
    print("  revert: python %s uninstall --yes" % Path(__file__).name)
    print("  effect: fully quit ZCode, reopen, start a new conversation.")
    return 0


def cmd_uninstall(args) -> int:
    path = Path(args.runtime)
    backup = Path(str(path) + BACKUP_SUFFIX)
    state_file = Path(str(path) + STATE_SUFFIX)

    if not backup.is_file():
        print("找不到备份 %s" % backup)
        print("未做任何改动。")
        return 1
    if not is_patched(read_runtime(path)):
        print("当前 runtime 不含补丁标记，但备份存在。仍按备份还原。")

    if args.dry_run:
        print("--dry-run：将用备份覆盖 %s" % path)
        return 0
    if not args.yes:
        print("未指定 --yes，未写盘。")
        return 2

    state = {}
    if state_file.is_file():
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
        except Exception:
            state = {}
    shutil.copy2(backup, path)
    backup.unlink()
    if state_file.is_file():
        state_file.unlink()
    print("[OK] 已从备份还原。")
    if state.get("promptFile"):
        print("  原提示词文件未改动：%s" % state["promptFile"])
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="ZCode 系统提示注入器（默认 dry-run）")
    ap.add_argument("action", choices=["inspect", "install", "uninstall"])
    ap.add_argument("--runtime", default=str(DEFAULT_RUNTIME))
    ap.add_argument("--prompt-file", default=None,
                    help="system prompt markdown path; default reuses the "
                         "path recorded in the state file, else ./my-system-prompt.md")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", action="store_true", help="confirm write")
    ap.add_argument("--override", action="store_true",
                    help="patch 3: downgrade agentsMd OVERRIDE wording")
    ap.add_argument("--no-memory", action="store_true",
                    help="patch 4: disable MEMORY.md auto-injection")
    args = ap.parse_args()
    try:
        return {"inspect": cmd_inspect, "install": cmd_install,
                "uninstall": cmd_uninstall}[args.action](args)
    except InjectorError as e:
        print("[x] %s" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
