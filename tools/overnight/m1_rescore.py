#!/usr/bin/env python3
"""Re-score labelled records (utility "game") with progress counted from the deepest level reached so far, PH's clock
(Fable's 11-11 note). The labels' "levels gained" was dmax − depth at the decision, so a character standing above its
deepest level was credited for walking back down (or for Word of Recall's return to its deepest level).

Needs meta.max_depth (snap_probe.py, or records that log it). Per seed: max(0, dmax − max(depth, max_depth)) − 3 if
dead. Rewrites meta.u_matrix, meta.u_mean and the gold win shares (ties split, as tools/rollout/labels.ts); sets
meta.progress_from (m1_offline.per_seed reads it) and meta.rescored = "from-deepest". Records without max_depth are
dropped and counted. --checkpoint N scores at that checkpoint's dmax/dead instead (records labelled with
--checkpoints), for the persistence test.

Usage: m1_rescore.py IN.jsonl OUT.jsonl [--checkpoint N]
"""
import argparse, json, statistics as st  # noqa: E401


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inp"); ap.add_argument("out"); ap.add_argument("--checkpoint", type=int)
    a = ap.parse_args()
    n = kept = changed = 0
    with open(a.out, "w") as fh:
        for line in open(a.inp):
            r = json.loads(line); m = r["meta"]; n += 1
            if m.get("max_depth") is None: continue
            base = max(m["depth"], m["max_depth"]); m["progress_from"] = base
            opts = list(r["questions"]["decision"]["criteria"])
            K = max((x["k"] for o in opts for x in m["runs"].get(o, [])), default=0)
            mat = {o: [None] * K for o in opts}
            for o in opts:
                for x in m["runs"].get(o, []):
                    if "dead" not in x: continue
                    dmax, dead = x.get("dmax") or 0, x["dead"]
                    if a.checkpoint is not None:
                        # cp rows are [actions, dmax, hp/mhp, exp]; a run that died before N has no row for N
                        cp = next((c for c in (x.get("cp") or []) if c[0] == a.checkpoint), None)
                        if cp is not None: dmax, dead = cp[1], False
                        elif dead and (x.get("act") or 0) <= a.checkpoint + 1: pass  # died by N: its final dmax
                        else: x.pop("dead", None); continue  # ended before N alive: not scorable (per_seed skips it)
                    mat[o][x["k"] - 1] = max(0, dmax - base) - (3 if dead else 0)
                    if a.checkpoint is not None: x["dmax"], x["dead"] = dmax, dead  # m1_offline.per_seed reads runs
            seeds = [i for i in range(K) if all(mat[o][i] is not None for o in opts)]
            if not seeds: continue
            wins = {o: 0.0 for o in opts}
            for i in seeds:
                best = max(mat[o][i] for o in opts)
                w = [o for o in opts if mat[o][i] >= best - 1e-9]
                for o in w: wins[o] += 1 / len(w)
            old = dict(m.get("u_mean") or {})
            m["u_matrix"] = mat
            m["u_mean"] = {o: round(st.mean(mat[o][i] for i in seeds), 4) for o in opts}
            r["gold"]["decision"]["probabilities"] = {o: round(wins[o] / len(seeds), 3) for o in opts}
            m["rescored"] = "from-deepest" + (f"@{a.checkpoint}" if a.checkpoint is not None else "")
            changed += any(abs(m["u_mean"][o] - old.get(o, m["u_mean"][o])) > 1e-9 for o in opts)
            fh.write(json.dumps(r) + "\n"); kept += 1
    print(json.dumps({"records": n, "kept": kept, "changed": changed}))


if __name__ == "__main__":
    main()
