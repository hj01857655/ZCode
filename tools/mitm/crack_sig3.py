"""crack_sig v3: per-request key derivation (HKDF with info='atomcode-signing-v1',
salt from ts/nonce) x comprehensive message formats. This is the most likely design:
the 'atomcode-signing-v1' string found in the binary is almost certainly the HKDF info."""
import glob, json, hmac, hashlib

TOK = "5D-DUTvKpk-x57ezQrkex8oi"
UID = "67aee901cb032f6b8cbb3b75"
VER = "5.1.0"
ALG = "1"

def hkdf(ikm, salt, info, length=32):
    if salt is None:
        salt = b"\x00" * 32
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm, t, i = b"", b"", 1
    while len(okm) < length:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        okm += t
        i += 1
    return okm[:length]

def load():
    out = []
    for f in sorted(glob.glob(r"E:/VSCodeSpace/ZCode/tools/mitm/llm_*.json")):
        r = json.load(open(f, encoding="utf-8"))
        if "chat/completions" not in r["path"]:
            continue
        h = r["headers"]
        sig = h["x-atomcode-sig"]
        sig = sig[3:] if sig.startswith("v1:") else sig
        out.append({
            "sig": sig, "ts": h["x-atomcode-ts"], "nonce_hex": h["x-atomcode-nonce"],
            "method": r["method"], "path": r["path"],
            "body": r["body"].encode(), "bh": hashlib.sha256(r["body"].encode()).hexdigest(),
        })
    return out

S = load()
print(f"{len(S)} samples")

def keys_for(s):
    ts, nh = s["ts"].encode(), s["nonce_hex"].encode()
    nr = bytes.fromhex(s["nonce_hex"])
    ikms = [("tok", TOK.encode()), ("uid", UID.encode())]
    salts = [("zero", None), ("ts", ts), ("nonce-hex", nh), ("nonce-raw", nr),
             ("empty", b""), ("sigv1", b"atomcode-signing-v1")]
    infos = [("empty", b""), ("sigv1", b"atomcode-signing-v1"),
             ("sigv1n", b"atomcode-signing-v1\n"), ("v1", b"v1"), ("ac", b"atomcode")]
    yield "tok", TOK.encode()
    yield "uid", UID.encode()
    for ikm_n, ikm in ikms:
        for sl_n, sl in salts:
            slv = sl if sl is not None else b"\x00" * 32
            for in_n, inf in infos:
                yield f"hkdf[{ikm_n}|s={sl_n}|i={in_n}]", hkdf(ikm, sl, inf)
    yield "sha256(tok)", hashlib.sha256(TOK.encode()).digest()
    yield "sha256(tok|sigv1)", hashlib.sha256(TOK.encode() + b"atomcode-signing-v1").digest()

def msgs_for(s):
    m, p = s["method"], s["path"]
    ts, nh, bh = s["ts"], s["nonce_hex"], s["bh"]
    nr = bytes.fromhex(s["nonce_hex"])
    body = s["body"]
    T = {"m": m, "p": p, "ts": ts, "n": nh, "bh": bh, "uid": UID, "ver": VER, "alg": ALG}
    R = {"m": m.encode(), "p": p.encode(), "ts": ts.encode(), "n": nh.encode(),
         "nr": nr, "bh": bh.encode(), "body": body, "uid": UID.encode(),
         "ver": VER.encode(), "alg": ALG.encode()}
    # text field orders
    orders = [
        ["m","p","ts","n","bh"], ["p","ts","n","bh"], ["ts","n","bh"],
        ["m","p","ts","n","bh","uid"], ["m","p","ts","n","bh","ver"],
        ["ts","n","bh","uid"], ["ts","n","bh","ver"], ["m","p","ts","n","ver","bh"],
        ["m","p","ts","n","alg","ver","bh"], ["ts","n","ver","bh"], ["ts","n","uid","bh"],
        ["m","p","n","ts","bh"], ["n","ts","p","bh"], ["m","ts","n","p","bh"],
        ["m","p","ts","n","bh","uid","ver"], ["ts","n","uid","ver","bh"],
        ["ts","n","ver","uid","bh"], ["m","p","ts","n","bh","alg"],
        ["p","ts","n","uid","bh"], ["m","p","ts","uid","n","bh"],
        ["ts","n","m","p","bh"], ["ts","n","m","p","bh","uid"],
        ["m","p","ts","n","ver","uid","bh"], ["ts","n","bh","ver","uid"],
    ]
    for sep in ["\n","|",":","",";",","," "]:
        for o in orders:
            name = sep.join(o) + "~sep" + repr(sep)
            yield name, sep.join(T[f] for f in o).encode()
        # with trailing newline
        for o in orders[:8]:
            name = sep.join(o) + "~sep" + repr(sep) + "~nl"
            yield name, (sep.join(T[f] for f in o) + "\n").encode()
    # raw body variants
    for o in [["m","p","ts","n"],["p","ts","n"],["ts","n"],["m","p","ts","n","uid"]]:
        for sep in ["\n","|"]:
            name = "RAW-" + sep.join(o) + repr(sep)
            yield name, sep.encode().join(R[f] for f in o) + sep.encode() + body
    # raw nonce in middle
    for o in [["m","p","ts","bh"],["p","ts","bh"],["ts","bh"]]:
        name = "RAWN-" + "-".join(o)
        yield name, b"\n".join(R[f] for f in o if f not in ("bh",)) + b"\n" + R["nr"] + b"\n" + R["bh"]

def main():
    first = S[0]
    mcv = list(msgs_for(first))
    kcv = list(keys_for(first))
    total = len(mcv) * len(kcv)
    print(f"per-sample space: {len(mcv)} msgs x {len(kcv)} keys = {total} combos/sample")
    hits = []
    for kn, k in kcv:
        for mn, m in mcv:
            if hmac.new(k, m, hashlib.sha256).hexdigest() == first["sig"]:
                ok = True
                for s in S[1:]:
                    k2 = dict(keys_for(s)).get(kn)
                    m2 = [mm for nm, mm in msgs_for(s) if nm == mn]
                    if k2 is None or not m2 or hmac.new(k2, m2[0], hashlib.sha256).hexdigest() != s["sig"]:
                        ok = False
                        break
                hits.append((kn, mn, ok))
                print("CANDIDATE:", kn, "||", mn, "=>", "ALL-OK" if ok else "sample0-only")
    if not hits:
        print("=> No per-request key derivation matched. The key is very likely a STATIC EMBEDDED SECRET in the binary (not derivable from token/uid/ts/nonce). Extraction from the binary or an oracle approach is required.")

if __name__ == "__main__":
    main()
