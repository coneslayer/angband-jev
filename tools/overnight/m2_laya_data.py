#!/usr/bin/env python3
"""Laya training data from labelled two-option records (Fable's 11-11 recipe, items 2.iii–iv): a target that keeps the
magnitude, p(o1) = sigmoid((u[o1] − u[o0]) / T), in place of win shares; flat records (difference 0) dropped; the
deepest level appended to the state text ("Deepest level reached: DLn", which the UI shows); a hold-out by lineage.

Usage: m2_laya_data.py LABELS.jsonl OUTDIR --clusters JSON {game_id: lineage} [--temp 1.0] [--eval-share 0.2]
       m2_laya_data.py --state-only LABELS.jsonl OUT.jsonl     (the state augmentation alone, for check sets)
"""
import argparse, json, math, os, random, sys  # noqa: E401


def augment(r):
    m = r["meta"]; md = m.get("max_depth")
    if md is not None and "Deepest level reached" not in r["state"]:
        lines = r["state"].split("\n")
        r["state"] = "\n".join(lines[:2] + [f"Deepest level reached: DL{md}"] + lines[2:])
    return r


def main():
    if sys.argv[1] == "--state-only":
        with open(sys.argv[3], "w") as fh:
            for l in open(sys.argv[2]): fh.write(json.dumps(augment(json.loads(l))) + "\n")
        return
    ap = argparse.ArgumentParser()
    ap.add_argument("labels"); ap.add_argument("out"); ap.add_argument("--clusters", required=True)
    ap.add_argument("--temp", type=float, default=1.0); ap.add_argument("--eval-share", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    cl = json.load(open(a.clusters)); rows = []; flat = 0
    for l in open(a.labels):
        r = json.loads(l); m = r["meta"]; u = m.get("u_mean") or {}
        opts = list(r["questions"]["decision"]["criteria"])
        if len(opts) != 2 or not all(o in u for o in opts): continue
        o0, o1 = sorted(opts); d = u[o1] - u[o0]
        if abs(d) < 1e-9: flat += 1; continue
        p1 = 1 / (1 + math.exp(-d / a.temp))
        r["gold"] = {"decision": {"probabilities": {o0: round(1 - p1, 4), o1: round(p1, 4)}}}
        rows.append(augment(r))
    lins = sorted({cl.get(r["meta"]["game_id"], r["meta"]["game_id"]) for r in rows})
    random.Random(a.seed).shuffle(lins); ev = set(lins[:int(len(lins) * a.eval_share)])
    tr = [r for r in rows if cl.get(r["meta"]["game_id"], r["meta"]["game_id"]) not in ev]
    te = [r for r in rows if cl.get(r["meta"]["game_id"], r["meta"]["game_id"]) in ev]
    os.makedirs(a.out, exist_ok=True)
    for name, rs in (("train", tr), ("eval", te)):
        with open(os.path.join(a.out, f"{name}.jsonl"), "w") as fh:
            for r in rs: fh.write(json.dumps(r) + "\n")
    print(json.dumps({"kept": len(rows), "flat_dropped": flat, "train": len(tr), "eval": len(te), "eval_lineages": len(ev)}))


if __name__ == "__main__":
    main()
