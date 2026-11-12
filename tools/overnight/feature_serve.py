#!/usr/bin/env python3
"""Feature policies for play arms (busho LLM_BACKEND=features; docs/plan-2026-11-09.md, Fable's 11-11 review).

busho POSTs {type, options, record} to FEATURES_URL (http://host:port/<policy>), where record is the danger record
(tools/danger/record.ts) at the decision; the reply is {choice, pred}. Policies, all fit at startup on --train
(labelled records, tools/rollout/run.ts output) with m1_offline's features (--run, --seldir map records to games):
  trees     LightGBM per option on u_mean (as m1_offline.py trees); the argmax of the predictions
  stump     the best one-split rule on the training labels: one feature, one threshold, one option on each side,
            chosen by the mean u_mean of the chosen option (the rung between a constant and the trees)
  const-X   always option X (with busho MODEL_COOLDOWN, "X at the first ask, then not again for N actions")
  diff      (--diff) one regressor on u[o1] − u[o0] with the gap to the deepest level as a feature (busho sends
            max_depth); o1 when the prediction is above 0. The 11-12 recall trees.
  rand-P    o1 with probability P at each ask (hashed from the turn: the same in base and arm games), the
            matched-rate comparator: as many recalls as a decider, at random asks
Run in the pipenv with lightgbm (tools/overnight/native).

Usage: feature_serve.py --train TRAIN.jsonl --run COLLECT_RUN --seldir SELDIR [--port 8020] [--log PATH] [--diff]
"""
import argparse, json, os, sys, threading  # noqa: E401
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import m1_offline as M  # noqa: E402


def fit(train, run, seldir, diff=False):
    import lightgbm as lgb, numpy as np  # noqa: E401
    src = {}
    for f in ("check.jsonl", "train.jsonl"):
        p = os.path.join(seldir, f)
        if os.path.exists(p):
            for r in M.load(p): src[r["game_id"]] = r["src_game"]
    rows, metas = [], []
    for r in sorted(train, key=lambda r: (src.get(r["meta"]["game_id"]) or "", r["meta"]["turn"])):  # cache by game
        u = r["meta"].get("u_mean"); g = src.get(r["meta"]["game_id"])
        f = u and g and M.features(run, g, r["meta"]["turn"])
        if f: rows.append((f, u)); metas.append(r["meta"])
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
    out = {"opts": opts, "trees": trees, "stump": best, "const_u": const, "n": len(rows)}
    if diff and len(opts) == 2:
        o0, o1 = opts
        X = [f + [max(0, (m.get("max_depth") or m["depth"]) - m["depth"])] for (f, u), m in zip(rows, metas) if o0 in u and o1 in u]
        Y = [u[o1] - u[o0] for (f, u), m in zip(rows, metas) if o0 in u and o1 in u]
        out["diff"] = lgb.train(P, lgb.Dataset(np.array(X, float), np.array(Y, float)), 200)
        # the stump refitted on the same rows (every feature incl. the gap, deciles, either side)
        best = None
        for j in range(len(X[0])):
            vals = sorted({x[j] for x in X})
            for t in sorted({vals[int(q * (len(vals) - 1))] for q in [i / 10 for i in range(1, 10)]}) if len(vals) > 1 else []:
                for lo_is_o1 in (True, False):
                    v = sum((y if ((x[j] <= t) == lo_is_o1) else 0.0) for x, y in zip(X, Y)) / len(Y)
                    if best is None or v > best[0]: best = (v, (M.FEATURES + ["gap_to_deepest"])[j], j, t, lo_is_o1)
        out["stump2"] = best
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True); ap.add_argument("--run", required=True); ap.add_argument("--seldir", required=True)
    ap.add_argument("--port", type=int, default=8020); ap.add_argument("--log", default=None)
    ap.add_argument("--diff", action="store_true", help="also fit the u-difference trees and stump with the gap feature")
    a = ap.parse_args()
    import numpy as np
    F = fit(M.load(a.train), a.run, a.seldir, a.diff)
    v, name, j, t, lo, hi = F["stump"]
    info = {"n": F["n"], "opts": F["opts"], "stump": {"feature": name, "threshold": t, "at_or_below": lo, "above": hi,
            "mean_u": round(v, 4)}, "const_mean_u": {o: round(x, 4) for o, x in F["const_u"].items()}}
    if "stump2" in F:
        v2, n2, j2, t2, lo2 = F["stump2"]
        info["stump2"] = {"feature": n2, "threshold": t2, "o1_at_or_below": lo2, "mean_gain": round(v2, 4)}
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
            elif policy in ("diff", "stump2") and "diff" in F:
                o0, o1 = F["opts"]
                gap = max(0, (body.get("max_depth") or x[3]) - x[3])
                if policy == "diff":
                    d = float(F["diff"].predict(np.array([x + [gap]], float))[0]); pred = {o0: 0.0, o1: d}
                    choice = o1 if d > 0 else o0
                else:
                    xs = x + [gap]; choice = o1 if ((xs[j2] <= t2) == lo2) else o0
            elif policy == "leaverand":
                # the matched-rate comparator for the leave question (Fable, 11-12): stairs at random at Jev's rate by
                # trigger (arrival 0; new monster 35% when a staircase is known, else 0; escape 30%; poisoned 70%;
                # bleeding 65%), hashed from the turn and the event so base and arm games share the draws
                import hashlib
                c = body.get("ctx") or {}; ev = c.get("event", "")
                p_ = (0.0 if ev.startswith("arrived") else 0.30 if ev.startswith("escaped") else 0.70 if "poisoned" in ev
                      else 0.65 if "bleeding" in ev else (0.35 if c.get("stairsKnown") else 0.0) if ev.startswith("a new kind") else 0.0)
                h = int(hashlib.sha1(f"{body.get('turn', 0)}:{ev}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
                choice = "stairs" if h < p_ else "stay"
            elif policy.startswith("rand-"):
                import hashlib
                h = int(hashlib.sha1(str(body.get("turn", 0)).encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
                choice = F["opts"][1] if h < float(policy[len("rand-"):]) else F["opts"][0]
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
