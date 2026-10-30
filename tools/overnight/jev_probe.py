#!/usr/bin/env python3
"""Hosted Jev probe: functionality, latency, rate limits, and a first offline score on labelled decisions.

  1. sequential: N requests one at a time (latency without contention);
  2. concurrency ramp: 2, 4, 8, 16 in flight; stops raising at the first 429;
  3. score: every held-out record against each model, at the highest clean concurrency (<= 8), scored like
     evaluate.py (acc against tied rollout winners, p_gold, Brier) plus regret (u_mean best - u_mean chosen).

Reads TYPESAFE_API_KEY from .env (never printed). Every call is appended to runs/jev/spend.jsonl; the probe stops
itself once the estimated spend for this run passes --cap dollars. Usage:
  jev_probe.py --heldout runs/session2/2026-10-13/trainB/data/heldout.jsonl --out runs/jev/probe-<date> [--cap 0.25]
"""
import argparse, collections, concurrent.futures as cf, json, os, statistics as st, sys, threading, time, urllib.error, urllib.request  # noqa: E401

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
import evaluate  # noqa: E402

URL = "https://api.typesafe.ai/v1/systemone"
PRICE = 0.042 / 1e6  # $ per input token
MODELS = ["jev-1.13.0", "jev-1.14.0"]


def api_key():
    for l in open(os.path.join(REPO, ".env")):
        if l.startswith("TYPESAFE_API_KEY="): return l.split("=", 1)[1].strip().strip("'\"")
    sys.exit("TYPESAFE_API_KEY not in .env")


class Client:
    def __init__(self, key, ledger, cap):
        self.key, self.ledger, self.cap = key, ledger, cap
        self.lock, self.spent, self.headers_seen = threading.Lock(), 0.0, None

    def ask(self, model, rec):
        body = json.dumps({"model": model, "state": rec["state"], "questions": rec["questions"]}).encode()
        n429 = 0
        for attempt in range(6):
            with self.lock:
                if self.spent > self.cap: raise RuntimeError(f"spend cap ${self.cap} reached")
            req = urllib.request.Request(URL, body, {"Content-Type": "application/json", "Authorization": f"Bearer {self.key}"})
            t0 = time.time()
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    data, hdr = json.load(r), dict(r.headers)
                ms = (time.time() - t0) * 1000
                u = data.get("usage") or {}
                tok = u.get("input_tokens") or len(body) / 3  # estimate when not reported
                with self.lock:
                    self.spent += tok * PRICE
                    if self.headers_seen is None: self.headers_seen = hdr
                    self.ledger.write(json.dumps({"ts": time.time(), "model": model, "served": data.get("model"),
                                                  "input_tokens": u.get("input_tokens"), "est_tokens": round(tok),
                                                  "usd": tok * PRICE}) + "\n"); self.ledger.flush()
                return {"ok": True, "ms": ms, "n429": n429, "answers": data.get("answers"), "served": data.get("model"),
                        "usage": u, "status": 200}
            except urllib.error.HTTPError as e:
                ms = (time.time() - t0) * 1000
                if e.code == 429:
                    n429 += 1
                    ra = e.headers.get("retry-after")
                    time.sleep(float(ra) if ra and ra.replace(".", "").isdigit() else 2 * (attempt + 1)); continue
                if e.code >= 500 and attempt < 2: time.sleep(2); continue
                return {"ok": False, "ms": ms, "n429": n429, "status": e.code, "error": e.read()[:300].decode(errors="replace")}
            except Exception as e:
                if attempt < 2: time.sleep(2); continue
                return {"ok": False, "ms": (time.time() - t0) * 1000, "n429": n429, "status": None, "error": str(e)[:300]}
        return {"ok": False, "ms": None, "n429": n429, "status": 429, "error": "429 after retries"}


def pct(xs, q): return round(sorted(xs)[min(len(xs) - 1, int(q * len(xs)))], 1) if xs else None


def lat(results):
    ms = [r["ms"] for r in results if r["ok"]]
    return {"n": len(results), "ok": len(ms), "p50_ms": pct(ms, 0.5), "p90_ms": pct(ms, 0.9), "max_ms": pct(ms, 1.0),
            "n429": sum(r["n429"] for r in results), "errors": collections.Counter(str(r["status"]) for r in results if not r["ok"])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--heldout", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--cap", type=float, default=0.25); ap.add_argument("--sequential", type=int, default=20)
    a = ap.parse_args()
    recs = [json.loads(l) for l in open(a.heldout)]
    os.makedirs(a.out, exist_ok=True)
    os.makedirs(os.path.join(REPO, "runs", "jev"), exist_ok=True)
    ledger = open(os.path.join(REPO, "runs", "jev", "spend.jsonl"), "a")
    cl = Client(api_key(), ledger, a.cap)
    cache = {}  # (model, idx) -> result
    summary = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "records": len(recs)}

    def run(model, idxs, conc):
        t0 = time.time()
        with cf.ThreadPoolExecutor(conc) as ex:
            res = list(ex.map(lambda i: cl.ask(model, recs[i]), idxs))
        for i, r in zip(idxs, res): cache[(model, i)] = r
        return res, time.time() - t0

    # 1. functionality + sequential latency
    res, wall = run(MODELS[0], list(range(a.sequential)), 1)
    first = next((r for r in res if r["ok"]), None)
    if not first: summary["fatal"] = res[:3]; json.dump(summary, open(os.path.join(a.out, "summary.json"), "w"), indent=1, default=str); sys.exit("no successful call")
    summary["sample_answer"] = first["answers"]; summary["served_model"] = first["served"]; summary["usage_sample"] = first["usage"]
    summary["response_headers"] = {k: v for k, v in (cl.headers_seen or {}).items() if k.lower() not in ("set-cookie",)}
    summary["sequential"] = lat(res) | {"req_per_s": round(len(res) / wall, 2)}
    print("sequential", summary["sequential"], flush=True)

    # 2. concurrency ramp
    nxt, ramp, safe = a.sequential, {}, 1
    for conc in (2, 4, 8, 16):
        idxs = list(range(nxt, nxt + 3 * conc)); nxt += 3 * conc
        res, wall = run(MODELS[0], idxs, conc)
        ramp[conc] = lat(res) | {"req_per_s": round(len(res) / wall, 2)}
        print("concurrency", conc, ramp[conc], flush=True)
        if ramp[conc]["n429"] or ramp[conc]["errors"]: break
        safe = conc
    summary["ramp"] = ramp; summary["safe_concurrency"] = safe

    # 3. offline score on every record, both models
    conc = min(safe, 8)
    scores = {}
    for m in MODELS:
        todo = [i for i in range(len(recs)) if (m, i) not in cache]
        res, wall = run(m, todo, conc)
        summary.setdefault("score_pass", {})[m] = lat(res) | {"req_per_s": round(len(res) / max(wall, 1e-9), 2), "concurrency": conc}
        allres = [cache[(m, i)] for i in range(len(recs))]
        summary.setdefault("served", {})[m] = dict(collections.Counter(r.get("served") for r in allres if r["ok"]))
        ok_idx = [i for i in range(len(recs)) if cache[(m, i)]["ok"] and (cache[(m, i)]["answers"] or {}).get("decision")]
        probs = {i: cache[(m, i)]["answers"]["decision"].get("probabilities") or {cache[(m, i)]["answers"]["decision"]["choice"]: 1.0}
                 for i in ok_idx}
        sub = [recs[i] for i in ok_idx]
        idx_of = {id(r): i for i, r in zip(ok_idx, sub)}
        scores[m] = evaluate.score(sub, lambda r: probs[idx_of[id(r)]])
        regret = [max(recs[i]["meta"]["u_mean"].values()) - recs[i]["meta"]["u_mean"][max(probs[i], key=probs[i].get)]
                  for i in ok_idx if recs[i]["meta"].get("u_mean")]
        conf = [cache[(m, i)]["answers"]["decision"].get("confidence") for i in ok_idx]
        scores[m]["all"]["regret"] = round(sum(regret) / max(1, len(regret)), 4)
        scores[m]["all"]["mean_confidence"] = round(st.mean([c for c in conf if c is not None]), 4) if conf else None
        scores[m]["all"]["answered"] = len(ok_idx)
        print(m, scores[m]["all"], flush=True)
    # baselines on the same records
    for name, f in (("rules", lambda r: r["meta"]["rules_choice"]),):
        scores[name] = evaluate.score(recs, f)
        rg = [max(r["meta"]["u_mean"].values()) - r["meta"]["u_mean"].get(r["meta"]["rules_choice"], min(r["meta"]["u_mean"].values()))
              for r in recs if r["meta"].get("u_mean")]
        scores[name]["all"]["regret"] = round(sum(rg) / len(rg), 4)
    summary["scores"] = scores
    summary["spent_usd_est"] = round(cl.spent, 5)
    summary["ended"] = time.strftime("%Y-%m-%d %H:%M:%S")
    json.dump(summary, open(os.path.join(a.out, "summary.json"), "w"), indent=1, default=str)
    with open(os.path.join(a.out, "answers.jsonl"), "w") as f:
        for (m, i), r in sorted(cache.items()):
            f.write(json.dumps({"model": m, "idx": i, "game_id": recs[i]["meta"]["game_id"], "turn": recs[i]["meta"]["turn"], **r}) + "\n")
    print("spent ~$%.4f" % cl.spent)


if __name__ == "__main__":
    main()
