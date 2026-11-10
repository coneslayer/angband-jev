#!/usr/bin/env python3
"""M1 label sets from a collection run (tools/overnight/collect.py; docs/plan-2026-11-09.md, phase M1).

From each game, up to --per-game decision records of --type with a snapshot (random, seeded); games are split so
that the check set and the training set never share a game. Each record gets its game's RULEFIX ("rulefix", which
tools/rollout/run.ts passes to the rollout players) and its snapshot is copied to OUT/snap. Writes OUT/check.jsonl
(--check records) and OUT/train.jsonl (up to --train records).

Usage: m1_select.py RUN OUT [--type blind] [--per-game 4] [--check 400] [--train 4000] [--seed 1]
"""
import argparse, json, os, random, shutil  # noqa: E401


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run"); ap.add_argument("out")
    ap.add_argument("--type", default="blind"); ap.add_argument("--per-game", type=int, default=4)
    ap.add_argument("--check", type=int, default=400); ap.add_argument("--train", type=int, default=4000)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    rf = {g["id"]: g["rulefix"] for g in map(json.loads, open(os.path.join(a.run, "collect.jsonl")))}
    rng = random.Random(a.seed)
    games = []
    for gid in sorted(rf):
        d = os.path.join(a.run, "games", gid)
        p = os.path.join(d, "decisions.jsonl")
        if not os.path.exists(p): continue
        recs = [r for r in map(json.loads, open(p)) if r["decision_type"] == a.type and r.get("snapshot")
                and os.path.exists(os.path.join(d, r["snapshot"])) and len(r["questions"]["decision"]["criteria"]) >= 2]
        if recs: games.append((gid, d, rng.sample(recs, min(a.per_game, len(recs)))))
    rng.shuffle(games)
    os.makedirs(os.path.join(a.out, "snap"), exist_ok=True)
    sets, n = {"check": [], "train": []}, {"check": 0, "train": 0}
    for gid, d, recs in games:
        which = "check" if n["check"] < a.check else "train"
        if which == "train" and n["train"] >= a.train: break
        for r in recs:
            name = f"{gid}-{r['turn']}-{a.type}.json.gz"
            shutil.copy(os.path.join(d, r["snapshot"]), os.path.join(a.out, "snap", name))
            sets[which].append({**r, "snapshot": f"snap/{name}", "rulefix": rf[gid], "src_game": gid})
            n[which] += 1
    for k, rs in sets.items():
        with open(os.path.join(a.out, f"{k}.jsonl"), "w") as f:
            for r in rs: f.write(json.dumps(r) + "\n")
    print(json.dumps({"games_with_records": len(games), **{k: len(v) for k, v in sets.items()},
                      "check_games": len({r["src_game"] for r in sets["check"]}),
                      "train_games": len({r["src_game"] for r in sets["train"]})}))


if __name__ == "__main__":
    main()
