#!/usr/bin/env python3
"""Feature policies for play arms (busho LLM_BACKEND=features; docs/plan-2026-11-09.md, Fable's 11-11 review).

busho POSTs {type, options, record} to FEATURES_URL (http://host:port/<policy>), where record is the danger record
(tools/danger/record.ts) at the decision; the reply is {choice, pred}. Policies, all fit at startup on --train
(labelled records, tools/rollout/run.ts output) with m1_offline's features (--run, --seldir map records to games):
  trees     LightGBM per option on u_mean (as m1_offline.py trees); the argmax of the predictions
  stump     the best one-split rule on the training labels: one feature, one threshold, one option on each side,
            chosen by the mean u_mean of the chosen option (the rung between a constant and the trees)
  const-X   always option X (with busho MODEL_COOLDOWN, "X at the first ask, then not again for N actions")
Run in the pipenv with lightgbm (tools/overnight/native).

Usage: feature_serve.py --train TRAIN.jsonl --run COLLECT_RUN --seldir SELDIR [--port 8020] [--log PATH]
"""
import argparse, json, os, sys, threading  # noqa: E401
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import m1_offline as M  # noqa: E402


def fit(train, run, seldir):
    import lightgbm as lgb, numpy as np  # noqa: E401
    src = {}
    for f in ("check.jsonl", "train.jsonl"):
        p = os.path.join(seldir, f)
        if os.path.exists(p):
            for r in M.load(p): src[r["game_id"]] = r["src_game"]
    rows = []
    for r in sorted(train, key=lambda r: (src.get(r["meta"]["game_id"]) or "", r["meta"]["turn"])):  # cache by game
        u = r["meta"].get("u_mean"); g = src.get(r["meta"]["game_id"])
        f = u and g and M.features(run, g, r["meta"]["turn"])
        if f: rows.append((f, u))
    opts = sorted({o for _, u in rows for o in u})
    P = dict(objective="regression", learning_rate=0.05, num_leaves=15, min_data_in_leaf=40, verbose=-1, seed=0)
    trees = {o: lgb.train(P, lgb.Dataset(np.array([f for f, u in rows if o in u], float),
                                         np.array([u[o] for f, u in rows if o in u], float)), 200) for o in opts}
    # stump: every feature, thresholds at the deciles, either option on either side
    best = None
    for j, name in enumerate(M.FEATURES):
        vals = sorted({f[j] for f, _ in rows})
        cuts = sorted({vals[int(q * (len(vals) - 1))] for q in [i / 10 for i in range(1, 10)]}) if len(vals) > 1 else []
        for t in cuts:
            for lo in opts:
                for hi in opts:
                    if lo == hi: continue
                    v = sum((u.get(lo) if f[j] <= t else u.get(hi)) or 0.0 for f, u in rows) / len(rows)
                    if best is None or v > best[0]: best = (v, name, j, t, lo, hi)
    const = {o: sum(u.get(o, 0.0) for _, u in rows) / len(rows) for o in opts}
    return {"opts": opts, "trees": trees, "stump": best, "const_u": const, "n": len(rows)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True); ap.add_argument("--run", required=True); ap.add_argument("--seldir", required=True)
    ap.add_argument("--port", type=int, default=8020); ap.add_argument("--log", default=None)
    a = ap.parse_args()
    import numpy as np
    F = fit(M.load(a.train), a.run, a.seldir)
    v, name, j, t, lo, hi = F["stump"]
    info = {"n": F["n"], "opts": F["opts"], "stump": {"feature": name, "threshold": t, "at_or_below": lo, "above": hi,
            "mean_u": round(v, 4)}, "const_mean_u": {o: round(x, 4) for o, x in F["const_u"].items()}}
    print(json.dumps(info), flush=True)
    log = open(a.log, "a") if a.log else None
    lock = threading.Lock()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *args): pass

        def do_GET(self):
            self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(info).encode())

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            policy = self.path.strip("/"); opts = [o for o in body.get("options", F["opts"]) if o in F["opts"]]
            x = M.feature_vector(body["record"]); pred = None
            if policy == "trees":
                pred = {o: float(F["trees"][o].predict(np.array([x], float))[0]) for o in opts}
                choice = max(pred, key=pred.get)
            elif policy == "stump":
                choice = lo if x[j] <= t else hi
            elif policy.startswith("const-"):
                choice = policy[len("const-"):]
            else:
                self.send_response(404); self.end_headers(); return
            out = {"choice": choice, "pred": pred}
            if log:
                with lock: log.write(json.dumps({"policy": policy, "type": body.get("type"), "choice": choice, "pred": pred}) + "\n"); log.flush()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps(out).encode())

    ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()


if __name__ == "__main__":
    main()
