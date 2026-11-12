#!/usr/bin/env python3
"""Laya diagnostic (Fable's 11-11 review, item 2.ii): can Laya fit a known function of numbers that are in its text?

Labels a collection's logged decisions of one type with the trees' own answers (feature_serve.fit on --train, the
argmax of the per-option predictions) as hard targets, and splits by game into TRAIN and EVAL (--eval-share). If
Laya can't fit this, the fault is the recipe or reading numbers, not the rollout labels; the steps it takes to fit
give the step budget for the real labels. Also writes OVERFIT (the first --overfit items of TRAIN) for the usual
memorisation check.

Usage: m2_known.py --collect RUN --type recall --train TRAIN_LABELS --seldir SELDIR --out DIR [--n 4000] [--eval-share 0.2]
"""
import argparse, glob, json, os, random, sys  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import m1_offline as M  # noqa: E402
import feature_serve as FS  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--collect", required=True); ap.add_argument("--type", default="recall")
    ap.add_argument("--train", required=True); ap.add_argument("--seldir", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=4000); ap.add_argument("--eval-share", type=float, default=0.2)
    ap.add_argument("--overfit", type=int, default=64); ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    import numpy as np
    F = FS.fit(M.load(a.train), a.collect, a.seldir)
    rows = []
    for p in sorted(glob.glob(os.path.join(a.collect, "games", "*", "decisions.jsonl"))):
        game = os.path.basename(os.path.dirname(p))
        for r in M.load(p):
            if r["decision_type"] != a.type: continue
            f = M.features(a.collect, game, r["turn"])
            if not f: continue
            opts = list(r["questions"]["decision"]["criteria"])
            pred = {o: float(F["trees"][o].predict(np.array([f], float))[0]) for o in opts}
            c = max(pred, key=pred.get)
            rows.append({"state": r["state"], "questions": r["questions"],
                         "gold": {"decision": {"probabilities": {o: 1.0 if o == c else 0.0 for o in opts}}},
                         "meta": {"game": game, "turn": r["turn"], "tree_pred": pred, "known": c}})
    rng = random.Random(a.seed)
    games = sorted({r["meta"]["game"] for r in rows}); rng.shuffle(games)
    ev = set(games[:int(len(games) * a.eval_share)])
    tr = [r for r in rows if r["meta"]["game"] not in ev]; te = [r for r in rows if r["meta"]["game"] in ev]
    rng.shuffle(tr); rng.shuffle(te)
    tr = tr[:a.n]; te = te[:max(200, int(a.n * a.eval_share))]
    os.makedirs(a.out, exist_ok=True)
    for name, rs in (("train", tr), ("eval", te), ("overfit", tr[:a.overfit])):
        with open(os.path.join(a.out, f"{name}.jsonl"), "w") as fh:
            for r in rs: fh.write(json.dumps(r) + "\n")
    share = lambda rs: round(sum(r["meta"]["known"] == F["opts"][-1] for r in rs) / max(1, len(rs)), 3)  # noqa: E731
    print(json.dumps({"logged": len(rows), "train": len(tr), "eval": len(te), "games_eval": len(ev),
                      f"share_{F['opts'][-1]}": {"train": share(tr), "eval": share(te)}}))


if __name__ == "__main__":
    main()
