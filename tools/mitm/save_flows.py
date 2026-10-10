from mitmproxy import http, ctx
import json, os, time

OUT = r"E:/VSCodeSpace/ZCode/tools/mitm"

def response(flow: http.HTTPFlow):
    if "llm-api.atomgit.com" in (flow.request.host or ""):
        ts = time.strftime("%H%M%S")
        fname = f"{OUT}/llm_{ts}_{flow.request.method}_{flow.request.path.replace('/','_')}.json"
        rec = {
            "method": flow.request.method,
            "url": flow.request.url,
            "path": flow.request.path,
            "headers": {k: v for k, v in flow.request.headers.items()},
            "body": flow.request.get_text(),
            "resp_status": flow.response.status_code if flow.response else None,
            "resp_headers": dict(flow.response.headers.items()) if flow.response else None,
            "resp_body": (flow.response.get_text() or "")[:2000] if flow.response else None,
        }
        with open(fname, "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False, indent=1)
        print("SAVED", fname, flush=True)
