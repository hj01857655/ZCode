"""Definitive atomcode-signing-v1 crack: comprehensive static + per-request key
derivations x comprehensive message formats. ALL samples must match."""
import glob, json, hmac, hashlib, base64, sys

TOK = "5D-DUTvKpk-x57ezQrkex8oi"
UID = "67aee901cb032f6b8cbb3b75"
VER = "5.1.0"
ALG = "1"
HOST = "llm-api.atomgit.com"
INFO = b"atomcode-signing-v1"

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

S = []
for f in sorted(glob.glob(r"E:/VSCodeSpace/ZCode/tools/mitm/llm_*.json")):
    r = json.load(open(f, encoding="utf-8"))
    if "chat/completions" not in r["path"]:
        continue
    h = r["headers"]
    sig = h["x-atomcode-sig"]
    sig = sig[3:] if sig.startswith("v1:") else sig
    S.append({
        "sig": sig, "ts": h["x-atomcode-ts"], "nh": h["x-atomcode-nonce"],
        "m": r["method"], "p": r["path"], "body": r["body"].encode(),
    })
print(f"{len(S)} samples", flush=True)

# ---- message formats ----
def fmts(s):
    bh = hashlib.sha256(s["body"]).hexdigest()
    bhU = bh.upper()
    bh64 = base64.b64encode(hashlib.sha256(s["body"]).digest()).decode()
    ts, nh = s["ts"], s["nh"]
    m, p = s["m"], s["p"]
    raw = s["body"]
    F = {}
    # newline-joined field orders (most likely API-signing shape)
    for tag, o in [
        ("mp-tn-bh", [m, p, ts, nh, bh]),
        ("mp-tn-bh-uid", [m, p, ts, nh, bh, UID]),
        ("mp-tn-bh-uid-ver", [m, p, ts, nh, bh, UID, VER]),
        ("mp-tn-bh-ver", [m, p, ts, nh, bh, VER]),
        ("p-tn-bh", [p, ts, nh, bh]),
        ("p-tn-bh-uid", [p, ts, nh, bh, UID]),
        ("tn-bh", [ts, nh, bh]),
        ("tn-bh-uid", [ts, nh, bh, UID]),
        ("tn-bh-ver", [ts, nh, bh, VER]),
        ("tn-uid-bh", [ts, nh, UID, bh]),
        ("tn-ver-bh", [ts, nh, VER, bh]),
        ("tn-uid-ver-bh", [ts, nh, UID, VER, bh]),
        ("tn-ver-uid-bh", [ts, nh, VER, UID, bh]),
        ("mt-n-p-bh", [m, ts, nh, p, bh]),
        ("mp-n-ts-bh", [m, p, nh, ts, bh]),
        ("n-ts-bh", [nh, ts, bh]),
        ("bh-tn", [bh, ts, nh]),
        ("tn-m-p-bh", [ts, nh, m, p, bh]),
        ("tn-m-p-bh-uid", [ts, nh, m, p, bh, UID]),
        ("uid-tn-bh", [UID, ts, nh, bh]),
        ("ver-tn-bh", [VER, ts, nh, bh]),
        ("host-tn-bh", [HOST, ts, nh, bh]),
        ("host-mp-tn-bh", [HOST, m, p, ts, nh, bh]),
        ("mp-tn", [m, p, ts, nh]),
        ("tn", [ts, nh]),
    ]:
        F["nl-" + tag] = "\n".join(o).encode()
        F["nl-" + tag + "-nl"] = ("\n".join(o) + "\n").encode()
    for sep in ["|", ":", " ", ";", ","]:
        F[f"{sep}-mp-tn-bh"] = sep.join([m, p, ts, nh, bh]).encode()
        F[f"{sep}-tn-bh"] = sep.join([ts, nh, bh]).encode()
        F[f"{sep}-tn-bh-uid"] = sep.join([ts, nh, bh, UID]).encode()
    F["concat-tn-bh"] = (ts + nh + bh).encode()
    F["concat-tn-bh-uid"] = (ts + nh + bh + UID).encode()
    F["bhU-nl"] = ("\n".join([m, p, ts, nh, bhU])).encode()
    F["bh64-nl"] = ("\n".join([m, p, ts, nh, bh64])).encode()
    # raw body as payload (not hash)
    F["nl-mp-tn-raw"] = ("\n".join([m, p, ts, nh]) + "\n").encode() + raw
    F["nl-tn-raw"] = (ts + "\n" + nh + "\n").encode() + raw
    F["nl-p-tn-raw"] = ("\n".join([p, ts, nh]) + "\n").encode() + raw
    F["no-nl-mp-tn-raw"] = (m + p + ts + nh).encode() + raw
    # ts + nonce + body (no method/path)
    F["raw-tn-body"] = (ts.encode() + nh.encode() + raw)
    return F

# ---- key candidates ----
def static_keys():
    Y = []
    Y.append(("tok", TOK.encode()))
    Y.append(("uid", UID.encode()))
    Y.append(("tok+uid", TOK.encode() + UID.encode()))
    Y.append(("uid+tok", UID.encode() + TOK.encode()))
    Y.append(("tok:uid", TOK.encode() + b":" + UID.encode()))
    Y.append(("sigv1-lit", INFO))
    Y.append(("sha256-tok", hashlib.sha256(TOK.encode()).digest()))
    Y.append(("sha256-uid", hashlib.sha256(UID.encode()).digest()))
    Y.append(("sha256-sigv1", hashlib.sha256(INFO).digest()))
    Y.append(("sha256-tok-sigv1", hashlib.sha256(TOK.encode() + INFO).digest()))
    Y.append(("sha256-sigv1-tok", hashlib.sha256(INFO + TOK.encode()).digest()))
    Y.append(("sha256-uid-sigv1", hashlib.sha256(UID.encode() + INFO).digest()))
    Y.append(("hmac-tok-sigv1", hmac.new(TOK.encode(), INFO, hashlib.sha256).digest()))
    Y.append(("hmac-sigv1-tok", hmac.new(INFO, TOK.encode(), hashlib.sha256).digest()))
    Y.append(("hmac-uid-sigv1", hmac.new(UID.encode(), INFO, hashlib.sha256).digest()))
    for ikm_n, ikm in [("tok", TOK.encode()), ("uid", UID.encode()), ("tok+uid", (TOK + UID).encode())]:
        for sl_n, sl in [("zero", b""), ("empty32", None), ("sigv1", INFO), ("info-empty", b"")]:
            for in_n, inf in [("empty", b""), ("sigv1", INFO), ("sigv1-nl", INFO + b"\n"), ("v1", b"v1"), ("ac", b"atomcode"), ("ac-sig", b"atomcode-signing")]:
                Y.append((f"hkdf-{ikm_n}-s{sl_n}-i{in_n}", hkdf(ikm, sl, inf)))
    return Y

def perreq_keys(s):
    Y = static_keys()
    ts, nh = s["ts"].encode(), s["nh"].encode()
    nr = bytes.fromhex(s["nh"])
    for ikm_n, ikm in [("tok", TOK.encode()), ("uid", UID.encode())]:
        Y.append((f"pr-hkdf-{ikm_n}-s-ts-i-sigv1", hkdf(ikm, ts, INFO)))
        Y.append((f"pr-hkdf-{ikm_n}-s-nh-i-sigv1", hkdf(ikm, nh, INFO)))
        Y.append((f"pr-hkdf-{ikm_n}-s-nr-i-sigv1", hkdf(ikm, nr, INFO)))
        Y.append((f"pr-sha256-{ikm_n}-ts", hashlib.sha256(ikm + ts).digest()))
        Y.append((f"pr-sha256-{ikm_n}-nh", hashlib.sha256(ikm + nh).digest()))
        Y.append((f"pr-hmac-{ikm_n}-ts", hmac.new(ikm, ts, hashlib.sha256).digest()))
        Y.append((f"pr-hmac-{ikm_n}-nh", hmac.new(ikm, nh, hashlib.sha256).digest()))
    return Y

def algos(k, msg):
    return [
        ("hmac256", hmac.new(k, msg, hashlib.sha256).hexdigest()),
        ("hmac512/64", hmac.new(k, msg, hashlib.sha512).hexdigest()[:64]),
        ("sha256(k||m)", hashlib.sha256(k + msg).hexdigest()),
        ("sha256(m||k)", hashlib.sha256(msg + k).hexdigest()),
    ]

def main():
    # precompute per-sample format dicts
    all_fmts = [fmts(s) for s in S]
    first_names = list(all_fmts[0].keys())
    print(f"message formats: {len(first_names)}", flush=True)

    def verify_static(k):
        # find (format, algo) that matches ALL samples consistently
        for fn in first_names:
            for an in ["hmac256", "hmac512/64", "sha256(k||m)", "sha256(m||k)"]:
                ok = True
                for i, s in enumerate(S):
                    msg = all_fmts[i][fn]
                    val = dict(algos(k, msg))[an]
                    if val != s["sig"]:
                        ok = False
                        break
                if ok:
                    return (fn, an)
        return None

    # static key pass
    sk = static_keys()
    print(f"static keys: {len(sk)}", flush=True)
    for kn, k in sk:
        res = verify_static(k)
        if res:
            print(f"*** STATIC MATCH key={kn} format={res[0]} algo={res[1]} key={k.hex()}", flush=True)

    # per-request key pass
    pr = perreq_keys(S[0])
    print(f"per-request keys: {len(pr)} (per sample)", flush=True)
    for kn, k0 in pr:
        # key depends on sample; recompute per sample
        ok = True
        mf = ma = None
        for i, s in enumerate(S):
            k = dict(perreq_keys(s))[kn]
            matched = False
            for fn in first_names:
                msg = all_fmts[i][fn]
                for an, av in algos(k, msg):
                    if av == s["sig"]:
                        if not matched:
                            matched = True
                            mf, ma = fn, an
                        break
                if matched:
                    break
            if not matched:
                ok = False
                break
        if ok:
            print(f"*** PER-REQ MATCH key={kn} format={mf} algo={ma}", flush=True)
    print("DONE", flush=True)

if __name__ == "__main__":
    main()
