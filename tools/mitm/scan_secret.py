"""Scan .rdata/.data of the official binary for 32-byte high-entropy arrays
that could be the static HMAC key; verify each candidate against captured samples."""
import json, glob, hmac, hashlib, math, struct

PE = r"C:/Users/12925/AppData/Roaming/npm/node_modules/@atomgit.com/atomcode/node_modules/@atomgit.com/atomcode-win32-x64/bin/atomcode.exe"

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
    })
print(f"{len(samples)} samples")

def entropy(b):
    if not b:
        return 0
    freq = [0] * 256
    for x in b:
        freq[x] += 1
    e = 0.0
    for c in freq:
        if c:
            p = c / len(b)
            e -= p * math.log2(p)
    return e

def msg_variants(s):
    bh = hashlib.sha256(s["body"]).hexdigest()
    ts, nh = s["ts"], s["nonce_hex"]
    m, p = s["method"], s["path"]
    orders = [
        ["m", "p", "ts", "n", "bh"], ["p", "ts", "n", "bh"], ["ts", "n", "bh"],
        ["ts", "n", "bh", "uid"], ["m", "p", "ts", "n", "ver", "bh"],
        ["ts", "n", "ver", "bh"], ["m", "ts", "n", "p", "bh"],
    ]
    T = {"m": m, "p": p, "ts": ts, "n": nh, "bh": bh, "ver": "5.1.0", "uid": "67aee901cb032f6b8cbb3b75"}
    for sep in ["\n", "|", ":", "", ";"]:
        for o in orders:
            yield sep.join(T[f] for f in o).encode()

def main():
    buf = open(PE, "rb").read()
    # .rdata raw 0xae9400 len 0x1899a00 ; .data raw 0x2382e00 len 0xe600
    regions = [("rdata", buf[0xae9400:0xae9400 + 0x1899a00]), ("data", buf[0x2382e00:0x2382e00 + 0xe600])]
    first = samples[0]
    msgs = list(msg_variants(first))
    candidates = []
    for rname, reg in regions:
        for i in range(0, len(reg) - 32):
            # alignment 8
            if i % 8:
                continue
            b = reg[i:i + 32]
            e = entropy(b)
            # must be printable-agnostic high entropy, not zeros/ascii-text run
            if e < 3.5:
                continue
            # skip if looks like UTF-8 text
            if all(32 <= x < 127 for x in b):
                continue
            candidates.append((rname, i, e, b))
    print(f"candidates: {len(candidates)}")
    tested = 0
    for rname, i, e, b in candidates:
        for m in msgs:
            tested += 1
            if hmac.new(b, m, hashlib.sha256).hexdigest() == first["sig"]:
                ok = all(
                    any(hmac.new(b, mm, hashlib.sha256).hexdigest() == s["sig"] for mm in msg_variants(s))
                    for s in samples[1:]
                )
                print("MATCH!", rname, hex(i), "ent=%.2f" % e, "key=" + b.hex(), "all-ok=", ok)
            # also sha256(key) as actual key
            k2 = hashlib.sha256(b).digest()
            if hmac.new(k2, m, hashlib.sha256).hexdigest() == first["sig"]:
                print("MATCH via sha256(key)!", rname, hex(i))
    print(f"tested {tested} (key,msg) pairs")
    if not any(True for _ in ()):
        pass
    print("scan complete")

if __name__ == "__main__":
    main()
