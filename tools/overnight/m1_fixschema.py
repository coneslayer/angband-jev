#!/usr/bin/env python3
"""Give every labelled blind record the full four-option question (one schema per question, for laya-train).

Records labelled with the 11-09 filtered option lists (an option offered only when it can be carried out) get the
missing options with rest's utility in every seed, which is what they do in play (an option that can't be carried
out falls back to "rest"); the gold win shares are recomputed from the extended per-seed matrix as
tools/rollout/labels.ts does (ties split). meta.u_mean gains the same entries; meta.schema_fixed lists what was added.

Usage: m1_fixschema.py IN.jsonl OUT.jsonl
"""
import json, sys  # noqa: E401

ORDER = ["rest", "cure", "stairs", "walk"]
CRITERIA = {
    "rest": "wait it out: rest until the blindness passes",
    "cure": "drink a potion that cures blindness (Cure Light, Serious or Critical Wounds)",
    "stairs": "take the stairs I am standing on to leave the level",
    "walk": "step away from where the threat was last seen",
}


def main():
    src, dst = sys.argv[1], sys.argv[2]
    n = added = 0
    with open(dst, "w") as out:
        for line in open(src):
            r = json.loads(line); m = r["meta"]
            have = list(r["questions"]["decision"]["criteria"])
            miss = [o for o in ORDER if o not in have]
            mat = m.get("u_matrix") or {}
            if miss and "rest" in mat:
                for o in miss: mat[o] = list(mat["rest"])
                seeds = [i for i in range(len(mat["rest"])) if all(mat[o][i] is not None for o in ORDER)]
                wins = {o: 0.0 for o in ORDER}
                for i in seeds:
                    best = max(mat[o][i] for o in ORDER)
                    w = [o for o in ORDER if mat[o][i] >= best - 1e-9]
                    for o in w: wins[o] += 1 / len(w)
                if seeds:
                    r["gold"]["decision"]["probabilities"] = {o: round(wins[o] / len(seeds), 3) for o in ORDER}
                if m.get("u_mean"):
                    for o in miss: m["u_mean"][o] = m["u_mean"]["rest"]
                m["schema_fixed"] = miss; added += 1
            r["questions"]["decision"] = {**r["questions"]["decision"], "criteria": dict(CRITERIA)}
            m["options"] = ORDER
            out.write(json.dumps(r) + "\n"); n += 1
    print(json.dumps({"records": n, "extended": added}))


if __name__ == "__main__":
    main()
