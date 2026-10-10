"""Full-binary key scan (all sections) x wider algo + message space.
Algos: hmac-sha256, hmac-sha512[:32], hmac-sha384[:32], sha256(k||m), sha256(m||k).
Key sizes: 16/24/32/48/64 bytes at 8-byte alignment, entropy >= 3.0."""
import json, glob, hmac, hashlib, math

PE = r"C:/Users/12925/AppData/Roaming/npm/node_modules/@atomgit.com/atomcode/node_modules/@atomgit.com/atomcode-win32-x64/bin/atomcode.exe"
TOK = "5D-DUTvKpk-x57ezQrkex8oi"
UID = "67aee901cb032f6b8cbb3b75"

samples = []
for f in sorted(glob.glob(r"E:/VSCodeSpace/ZCode/tools/mitm/llm_*.json")):
    r = json.load(open(f, encoding="utf-8"))
    if "chat/completions" not in r["path"]:
        continue
    h = r["headers"]
    sig = h["x-atomcode-sig"]
    sig = sig[3:] if sig.startswith("v1:") else sig
    samples.append({
        "sig": sig, "ts": h["x-atomcode-ts"], "nonce_hex": h["x-atomcode-nonce"],
        "method": r["method"], "path": r["path"], "body": r["body"].encode(),
        "cl": str(len(r["body"])),
    })
print(f"{len(samples)} samples")

def entropy(b):
    freq = [0] * 256
    for x in b:
        freq[x] += 1
    e = 0.0
    n = len(b)
    for c in freq:
        if c:
            p = c / n
            e -= p * math.log2(p)
    return e

def msgs_for(s):
    bh = hashlib.sha256(s["body"]).hexdigest()
    ts, nh = s["ts"], s["nonce_hex"]
    m, p, cl = s["method"], s["path"], s["cl"]
    T = {"m": m, "p": p, "ts": ts, "n": nh, "bh": bh, "uid": UID, "ver": "5.1.0", "alg": "1", "cl": cl, "host": "llm-api.atomgit.com"}
    orders = [
        ["m", "p", "ts", "n", "bh"], ["p", "ts", "n", "bh"], ["ts", "n", "bh"],
        ["ts", "n", "bh", "uid"], ["ts", "n", "ver", "bh"], ["ts", "n", "bh", "cl"],
        ["m", "p", "ts", "n", "ver", "bh"], ["m", "ts", "n", "p", "bh"],
        ["ts", "n", "cl", "bh"], ["m", "p", "ts", "n", "bh", "cl"],
        ["ts", "n", "bh", "ver"], ["ts", "n", "uid", "ver", "bh"],
        ["m", "p", "n", "ts", "bh"], ["n", "ts", "bh"], ["ts", "n", "m", "p", "bh"],
    ]
    for sep in ["\n", "|", ":", "", ";"]:
        for o in orders:
            yield sep.join(T[f] for f in o).encode()

def check_key(k, s, msgs):
    for m in msgs:
        if hmac.new(k, m, hashlib.sha256).hexdigest() == s["sig"]:
            return ("hmac256", m)
        if hmac.new(k, m, hashlib.sha512).hexdigest()[:64] == s["sig"]:
            return ("hmac512", m)
        if hmac.new(k, m, hashlib.sha384).hexdigest()[:64] == s["sig"]:
            return ("hmac384", m)
        if hashlib.sha256(k + m).hexdigest() == s["sig"]:
            return ("sha256(k||m)", m)
        if hashlib.sha256(m + k).hexdigest() == s["sig"]:
            return ("sha256(m||k)", m)
    return None

def main():
    buf = open(PE, "rb").read()
    sections = [
        ("text", 0x400, 0x400 + 0xae9000),
        ("rdata", 0xae9400, 0xae9400 + 0x1899a00),
        ("data", 0x2382e00, 0x2382e00 + 0xe600),
    ]
    first = samples[0]
    msgs = list(msgs_for(first))
    print(f"msg variants: {len(msgs)}")
    found_any = False
    for sname, start, end in sections:
        reg = buf[start:end]
        sizes = [16, 24, 32, 48, 64]
        cand = 0
        for sz in sizes:
            for i in range(0, len(reg) - sz, 8):
                b = reg[i:i + sz]
                if b.count(0) > sz // 4:
                    continue
                e = entropy(b)
                if e < 3.0:
                    continue
                cand += 1
                if check_key(b, first, msgs):
                    # verify on all samples
                    ok = True
                    for s in samples[1:]:
                        if not check_key(b, s, msgs_for(s)):
                            ok = False
                            break
                    print(f"*** MATCH section={sname} off=0x{i:x} size={sz} ent={e:.2f} all-ok={ok} key={b.hex()[:64]}")
                    found_any = True
        print(f"section {sname}: {cand} candidates tested", flush=True)
    if not found_any:
        print("NO static key found in any section. Likely: XOR-encrypted key material, key constructed at runtime, or non-standard construction. Recommend: (1) Ghidra data-flow on sign_v1, (2) dynamic breakpoint on HMAC entry.")

if __name__ == "__main__":
    main()
