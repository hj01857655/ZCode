"""crack_sig v2: AWS-SigV4 style + raw nonce + wide orders + derived keys.
If nothing matches token/uid-derived keys, conclusion: static embedded secret."""
import glob, json, hmac, hashlib, itertools

TOK = "5D-DUTvKpk-x57ezQrkex8oi"
UID = "67aee901cb032f6b8cbb3b75"
VER = "5.1.0"
HOST = "llm-api.atomgit.com"

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
        "nonce_raw": bytes.fromhex(h["x-atomcode-nonce"]),
        "alg": h["x-atomcode-alg"], "ver": h["x-atomcode-ver"],
        "method": r["method"], "path": r["path"], "host": HOST,
        "body": r["body"].encode(), "body_hash": hashlib.sha256(r["body"].encode()).hexdigest(),
    })

print(f"{len(samples)} samples")

def keys():
    base = {"tok": TOK.encode(), "uid": UID.encode(), "ver": VER.encode(), "host": HOST.encode()}
    yield "tok", TOK.encode()
    yield "uid", UID.encode()
    for a, b in [("tok", "uid"), ("uid", "tok"), ("tok", "ver"), ("ver", "tok"), ("tok", "host"), ("uid", "ver")]:
        for op in ["+", "|", "-", ":", "\n"]:
            yield f"{a}{op}{b}", base[a] + op.encode() + base[b]
    for k in ("tok", "uid"):
        yield f"sha256({k})", hashlib.sha256(base[k]).digest()
        yield f"md5({k})", hashlib.md5(base[k]).digest()

def msg_variants(s):
    bh, ts, nh = s["body_hash"], s["ts"], s["nonce_hex"]
    nr = s["nonce_raw"]
    m, p, alg, ver, host = s["method"], s["path"], s["alg"], s["ver"], s["host"]
    pool = {"m": m, "p": p, "ts": ts, "n": nh, "bh": bh, "alg": alg, "ver": ver, "host": host}
    rawpool = {"m": m.encode(), "p": p.encode(), "ts": ts.encode(), "nr": nr, "n": nh.encode(),
               "bh": bh.encode(), "alg": alg.encode(), "ver": ver.encode(), "host": host.encode()}
    # text-join orders (use bh hex + nonce hex)
    field_sets = [
        ["m", "p", "ts", "n", "bh"],
        ["p", "ts", "n", "bh"],
        ["ts", "n", "bh"],
        ["m", "p", "ts", "n", "alg", "ver", "bh"],
        ["m", "p", "ts", "n", "ver", "bh"],
        ["ts", "n", "alg", "ver", "bh"],
        ["host", "m", "p", "ts", "n", "bh"],
        ["m", "p", "ts", "n", "ver", "alg", "bh"],
        ["ts", "n", "ver", "bh"],
        ["m", "p", "n", "ts", "bh"],
        ["n", "ts", "bh"],
        ["ts", "n", "host", "p", "bh"],
    ]
    for fs in field_sets:
        for sep in ["\n", "|", ":", "", ";", " "]:
            name = "/".join(fs) + f"#{sep!r}"
            yield name, sep.join(pool[f] for f in fs).encode()
    # raw nonce byte variants with \n
    for fs in [["m", "p", "ts", "bh"], ["p", "ts", "bh"], ["ts", "bh"]]:
        pre = "\n".join(pool[f] for f in fs[:3]).encode() if fs[0] != "ts" else pool[fs[0]].encode()
        # simple: pre-part + rawnonce + bh
        name = "raw-" + "-".join(fs)
        yield name, b"\n".join(rawpool[f] for f in fs if f != "bh") + b"\n" + nr + b"\n" + rawpool["bh"]
    # AWS SigV4 canonical request
    for sh in [["host"], ["host", "x-atomcode-ts", "x-atomcode-nonce"]]:
        canon_headers = "host: %s\n" % host
        canon_headers += "x-atomcode-nonce: %s\n" % nh
        canon_headers += "x-atomcode-ts: %s\n" % ts
        signed = ";".join(sh)
        cr = m + "\n" + p + "\n" + "\n" + canon_headers + "\n" + signed + "\n" + bh
        yield "aws-sigv4-" + signed, cr.encode()
    # raw body as the trailing hash-substitute
    for fs in [["m", "p", "ts", "n"], ["p", "ts", "n"], ["ts", "n"]]:
        name = "RAWBODY-" + "-".join(fs)
        yield name, b"\n".join(rawpool[f] for f in fs) + b"\n" + s["body"]

def main():
    first = samples[0]
    mcv = list(msg_variants(first))
    kv = list(keys())
    total = len(mcv) * len(kv)
    print(f"combos: {len(mcv)} msgs x {len(kv)} keys = {total}")
    found = 0
    for kn, k in kv:
        for mn, m in mcv:
            try:
                if hmac.new(k, m, hashlib.sha256).hexdigest() == first["sig"]:
                    # verify all
                    ok = True
                    for s in samples[1:]:
                        match = [mm for nm, mm in msg_variants(s) if nm == mn]
                        if not match or hmac.new(k, match[0], hashlib.sha256).hexdigest() != s["sig"]:
                            ok = False
                            break
                    found += 1
                    print("CANDIDATE:", kn, "|", mn, "=>", "ALL-OK" if ok else "only-sample0")
            except Exception:
                pass
    if not found:
        print("=> No token/uid-derived key matched. Strong indication the HMAC key is a STATIC EMBEDDED SECRET in the official binary (not derivable from the OAuth token). Next step: extract the secret byte-array from the v1.rs code/data section, or use the binary as a signing oracle.")

if __name__ == "__main__":
    main()
