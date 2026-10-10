"""Crack atomcode-signing-v1 from captured samples.

Inputs: captured requests (headers + exact body bytes) + known credentials.
Strategy: exhaustive over message format x key derivation candidates.
"""
import glob, json, hmac, hashlib

AUTH_TOKEN = "5D-DUTvKpk-x57ezQrkex8oi"
USER_ID = "67aee901cb032f6b8cbb3b75"
VERSION = "5.1.0"
ALG = "1"

samples = []
for f in sorted(glob.glob(r"E:/VSCodeSpace/ZCode/tools/mitm/llm_*.json")):
    rec = json.load(open(f, encoding="utf-8"))
    if "chat/completions" not in rec["path"]:
        continue
    h = rec["headers"]
    sig = h["x-atomcode-sig"]
    if sig.startswith("v1:"):
        sig = sig[3:]
    samples.append({
        "sig": sig,
        "sig_raw": h["x-atomcode-sig"],
        "ts": h["x-atomcode-ts"].encode(),
        "nonce": bytes.fromhex(h["x-atomcode-nonce"]),
        "body": rec["body"].encode(),
        "method": rec["method"].encode(),
        "path": rec["path"].encode(),
        "ua": h.get("user-agent", "").encode(),
    })

print(f"loaded {len(samples)} samples")
for s in samples:
    print(" sig:", s["sig_raw"][:24], "ts:", s["ts"], "nonce:", s["nonce"].hex()[:12], "bodylen:", len(s["body"]))

def hkdf_sha256(ikm, salt=None, info=None, length=32):
    if salt is None:
        salt = b"\x00" * 32
    if info is None:
        info = b""
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm, t, i = b"", b"", 1
    while len(okm) < length:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        okm += t
        i += 1
    return okm[:length]

def key_candidates():
    yield "token", AUTH_TOKEN.encode()
    yield "user_id", USER_ID.encode()
    yield "token+uid", AUTH_TOKEN.encode() + USER_ID.encode()
    yield "uid+token", USER_ID.encode() + AUTH_TOKEN.encode()
    for ikm_name, ikm in [("token", AUTH_TOKEN.encode()), ("uid", USER_ID.encode())]:
        for salt_name, salt in [("none", b"\x00" * 32), ("uid", USER_ID.encode()), ("token", AUTH_TOKEN.encode()), ("ver", VERSION.encode()), ("ts0", b"")]:
            for info_name, info in [("none", b""), ("sigv1", b"atomcode-signing-v1"), ("sigv1n", b"atomcode-signing-v1\n"), ("v1", b"v1"), ("signing", b"signing"), ("ac", b"atomcode"), ("hkdf", b"hkdf")]:
                yield f"hkdf[{ikm_name}|{salt_name}|{info_name}]", hkdf_sha256(ikm, salt, info)

def msg_candidates(s):
    bh = hashlib.sha256(s["body"]).hexdigest()
    ts, nc = s["ts"].decode(), s["nonce"].hex()
    m, p = s["method"].decode(), s["path"].decode()
    uid, tok, ver = USER_ID, AUTH_TOKEN, VERSION
    pool = {"m": m, "p": p, "ts": ts, "n": nc, "bh": bh, "uid": uid, "tok": tok, "ver": ver, "alg": ALG}
    for sep in ["", "|", "\n", ":", "."]:
        specs = [
            "m p ts n bh", "m p ts n bh uid", "m p ts n bh ver",
            "m p ts n bh uid ver", "p ts n bh", "p ts n bh uid",
            "ts n bh", "ts n bh uid", "ts n bh ver", "p ts n",
            "ts n p bh", "n ts p bh", "ts n bh p", "ts n uid bh",
            "ts n ver bh", "p ts n uid bh", "m ts n p bh uid",
            "m ts n p bh", "ts n bh tok", "ts n tok bh", "tok ts n bh",
            "p ts n ver bh", "m p ts n ver bh", "ts n uid ver bh",
            "ts n ver uid bh", "m p ts n bh alg ver", "ts n bh uid ver",
            "m p ts n bh ver uid", "m p n ts bh", "m p n ts bh uid",
            "m p ts n bh uid alg", "uid ts n bh", "ver ts n bh",
            "ts n m p bh", "ts n m p bh uid", "m p ts n bh uid ver alg",
        ]
        for spec in specs:
            parts = [pool[c] for c in spec.split()]
            yield spec + f"/sep={sep!r}", (sep.join(parts)).encode()
    for sep in ["|", "\n", ""]:
        for spec in ["m p ts n", "p ts n", "m p ts n uid", "m p ts n ver"]:
            parts = [pool[c] for c in spec.split()]
            yield spec + f"/RAWBODY/{sep!r}", sep.join(parts).encode() + s["body"]
    # sha256 hex of body with no separator before
    yield "ts|n|bh-nosep-check", b""

def main():
    if not samples:
        print("no samples")
        return
    first = samples[0]
    mc = list(msg_candidates(first))
    kc = list(key_candidates())
    print(f"testing {len(mc)} msgs x {len(kc)} keys = {len(mc) * len(kc)} combos")
    found = []
    for kname, k in kc:
        for mname, m in mc:
            if m == b"":
                continue
            if hmac.new(k, m, hashlib.sha256).hexdigest() == first["sig"]:
                ok = True
                for s in samples[1:]:
                    match = [mm for nm, mm in msg_candidates(s) if nm == mname]
                    if not match or hmac.new(k, match[0], hashlib.sha256).hexdigest() != s["sig"]:
                        ok = False
                        break
                found.append((kname, mname, ok))
                print("CANDIDATE:", kname, mname, "ALL-OK" if ok else "sample0-only")
    if not found:
        print("NO MATCH. Next: capture >=2 samples with same body diff analysis, or static analysis of v1.rs code section.")

if __name__ == "__main__":
    main()
