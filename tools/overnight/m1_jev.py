#!/usr/bin/env python3
"""M1: hosted Jev zero-shot on a label set's decisions (docs/plan-2026-11-09.md). Answers go to OUT as
{game_id, turn, choice, probabilities, confidence, served} for m1_offline.py score.

Every call goes through jev_probe.Client: the key from .env (never printed), the ledger runs/jev/spend.jsonl, and
a cap on this run's estimated spend. The model version is pinned (never jev-latest).

Usage: m1_jev.py LABELS.jsonl OUT.jsonl [--model jev-1.13.0] [--cap 0.10] [--conc 4]
"""
import argparse, concurrent.futures as cf, json, os, sys  # noqa: E401

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import jev_probe as J  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("labels"); ap.add_argument("out")
    ap.add_argument("--model", default="jev-1.13.0"); ap.add_argument("--cap", type=float, default=0.10)
    ap.add_argument("--conc", type=int, default=4)
    a = ap.parse_args()
    if a.model.endswith("latest"): sys.exit("pin a version (jev-1.13.0 or jev-1.14.0), never jev-latest")
    recs = [json.loads(l) for l in open(a.labels) if l.strip()]
    ledger = open(os.path.join(J.REPO, "runs", "jev", "spend.jsonl"), "a")
    cl = J.Client(J.api_key(), ledger, a.cap)
    with cf.ThreadPoolExecutor(a.conc) as ex:
        res = list(ex.map(lambda r: cl.ask(a.model, r), recs))
    n_ok = 0
    with open(a.out, "w") as f:
        for r, x in zip(recs, res):
            d = (x.get("answers") or {}).get("decision") if x.get("ok") else None
            if d: n_ok += 1
            f.write(json.dumps({"game_id": (r.get("meta") or r)["game_id"], "turn": (r.get("meta") or r)["turn"], "choice": d and d.get("choice"),
                                "probabilities": d and d.get("probabilities"), "confidence": d and d.get("confidence"),
                                "served": x.get("served"), "ok": bool(d)}) + "\n")
    print(json.dumps({"records": len(recs), "answered": n_ok, "spent_usd_est": round(cl.spent, 5), "model": a.model}))


if __name__ == "__main__":
    main()
