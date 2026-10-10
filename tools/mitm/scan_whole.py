"""Final offline pass: scan the WHOLE binary for 32-byte candidate keys
(8-byte aligned, entropy>=3.4) and test against sample[0] with the full
message-format set. Early-exit per candidate on sample[0]."""
import glob, json, hmac, hashlib, math, sys

PE = r"C:/Users/12925/AppData/Roaming/npm/node_modules/@atomgit.com/atomcode/node_modules/@atomgit.com/atomcode-win32-x64/bin/atomcode.exe"
UID = "67aee901cb032f6b8cbb3b75"
S = []
for f in sorted(glob.glob(r"E:/VSCodeSpace/ZCode/tools/mitm/llm_*.json")):
    r = json.load(open(f, encoding="utf-8"))
    if "chat/completions" not in r["path"]:
        continue
    h = r["headers"]
    sig = h["x-atomcode-sig"]
    sig = sig[3:] if sig.startswith("v1:") else sig
    S.append({"sig": sig, "ts": h["x-atomcode-ts"], "nh": h["x-atomcode-nonce"],
              "m": r["method"], "p": r["path"], "body": r["body"].encode()})
print(len(S), "samples", flush=True)

def fmts(s):
    bh = hashlib.sha256(s["body"]).hexdigest()
    ts, nh, m, p = s["ts"], s["nh"], s["m"], s["p"]
    out = []
    for o in [[m, p, ts, nh, bh], [p, ts, nh, bh], [ts, nh, bh], [ts, nh, bh, UID],
              [ts, nh, bh, UID, "5.1.0"], [m, p, ts, nh, bh, UID, "5.1.0"],
              [ts, nh, m, p, bh], [ts, nh, m, p, bh, UID], [m, ts, nh, p, bh],
              [m, p, nh, ts, bh], [UID, ts, nh, bh], ["5.1.0", ts, nh, bh],
              [m, p, ts, nh, bh, "1", "5.1.0"], [ts, nh, bh, "1", "5.1.0"],
              [ts, nh, UID, "5.1.0", bh], ["5.1.0", ts, nh, UID, bh]]:
        out.append("\n".join(o).encode())
    for sep in ["|", ":", " "]:
        out.append(sep.join([m, p, ts, nh, bh]).encode())
        out.append(sep.join([ts, nh, bh, UID]).encode())
    out.append((ts + nh + bh).encode())
    out.append((ts + "\n" + nh + "\n").encode() + s["body"])
    return out

def ent(b):
    fr = [0] * 256
    for x in b:
        fr[x] += 1
    n = len(b); e = 0.0
    for c in fr:
        if c:
            pp = c / n; e -= pp * math.log2(pp)
    return e

def main():
    buf = open(PE, "rb").read()
    m0 = fmts(S[0])
    total = tested = 0
    # scan whole file at 8-byte alignment for 32-byte high-entropy windows
    n = len(buf)
    for i in range(0, n - 32, 8):
        b = buf[i:i + 32]
        if b.count(0) > 8:
            continue
        if ent(b) < 3.4:
            continue
        total += 1
        k = b
        for m in m0:
            tested += 1
            if hmac.new(k, m, hashlib.sha256).hexdigest() == S[0]["sig"]:
                ok = all(any(hmac.new(k, mm, hashlib.sha256).hexdigest() == s["sig"] for mm in fmts(s)) for s in S[1:])
                print(f"*** MATCH off=0x{i:x} all={ok} key={k.hex()}", flush=True)
            if hashlib.sha256(k + m).hexdigest() == S[0]["sig"]:
                print(f"*** MATCH sha256(k||m) off=0x{i:x} key={k.hex()}", flush=True)
            if hashlib.sha256(m + k).hexdigest() == S[0]["sig"]:
                print(f"*** MATCH sha256(m||k) off=0x{i:x} key={k.hex()}", flush=True)
    print(f"candidate windows={total} msg-tests={tested} DONE", flush=True)

if __name__ == "__main__":
    main()
