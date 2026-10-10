"""验证语法门有效：喂真实出现过的坏产物，必须被拦住。

注意：不能随便砍几个字符来模拟 —— 砍在属性名中间得到的是
`this.config.la`，语法合法（只是属性不存在），node --check 不会报。
当初真实的坏产物是 IIFE 闭合后紧跟字母：

    ...return this.config.systemPrompt}})()ge: this.config.language

`})()ge` 是非法记号，这才是能被语法门拦住的形态。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prompt_injector as p                                       # noqa: E402

runtime = p.read_runtime(p.DEFAULT_RUNTIME)
span = p._find_span(runtime)
start, end = span

BAD = "customSystemPrompt: (()=>{try{return this.config.systemPrompt}})()ge"
broken = runtime[:start] + BAD + runtime[end + len("language: this.config.language"):]

i = broken.index("customSystemPrompt: (()=>")
print("reproduced bad site:")
print("  %r" % broken[i:i + 96])
print()

try:
    p.syntax_ok(broken)
    print("[FAIL] gate did NOT catch it")
    sys.exit(1)
except p.InjectorError as e:
    print("[OK] gate blocked it: %s" % e)

print()
print("control - the real, unpatched runtime:")
try:
    p.syntax_ok(runtime)
    print("[OK] real runtime passes node --check")
except p.InjectorError as e:
    print("[note] flagged: %s" % e)
