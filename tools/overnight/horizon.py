#!/usr/bin/env python3
"""Session 7: do the short rollout labels agree with long rollouts scored like the tournament?

Joins long-horizon labels (run.ts --utility game --checkpoints ..., same seeds as the short labels) with the short
labels they re-label, and reports, at each horizon h read from the checkpoints:
  agreement   the short label's strict winner vs the long rollouts' best mean value, and the long rollouts' own
              split-half agreement (seeds 1-4 vs 5-8), which is the ceiling noise allows
  vs_last     the long rollouts' winner at h vs at the longest horizon (how short a horizon could stand in for it)
  vs_rules    where a chooser (the short label, a model) differs from the rules' choice: per record, the mean value
              of its choice minus the rules' choice over the paired seeds; wins, losses and one-sided sign p
  prefix      canary: long rollouts replay the short ones (same seed, same first actions)
Value at h = deepest level gained by h - 3 if dead by h (the tournament's score over the rollout).

Usage: horizon.py --long valG/labels.jsonl --short labelF/labels.jsonl [--answers trainE=a.jsonl ...] [--out x.json]
"""
import argparse, collections, json, os, sys  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from driver3 import sign_p  # noqa: E402

HORIZONS = (50, 150, 500, 1500, 5000)


def key(m): return (m["game_id"], m["turn"], m["decision_type"])


def value(run, d0, h):
    """Tournament score of one long run, cut at h actions."""
    if not run.get("act"): return None
    dead = run["dead"] and run["act"] <= h
    dmax = run.get("dmax", d0)
    if run["act"] > h:  # still going at h: the last checkpoint at or before h
        cps = [c for c in run.get("cp", []) if c[0] <= h]
        if not cps: return None
        dmax = cps[-1][1]
    return max(0, dmax - d0) - (3 if dead else 0)


def means(rec, h, seeds):
    m = rec["meta"]
    runs = {o: {r["k"]: r for r in m["runs"][o]} for o in m["options"]}
    out = {}
    for o in m["options"]:
        vs = [value(runs[o].get(k, {}), m["depth"], h) for k in seeds]
        if any(v is None for v in vs) or not vs: return None
        out[o] = sum(vs) / len(vs)
    return out


def strict(scores):
    if not scores: return None
    best = max(scores.values())
    top = [o for o, v in scores.items() if v >= best - 1e-9]
    return top[0] if len(top) == 1 else None


def paired(rec, h, a, b):
    """Mean over paired seeds of value(a) - value(b), or None."""
    m = rec["meta"]
    runs = {o: {r["k"]: r for r in m["runs"][o]} for o in (a, b)}
    ds = []
    for k in m["paired_seeds"]:
        va, vb = value(runs[a].get(k, {}), m["depth"], h), value(runs[b].get(k, {}), m["depth"], h)
        if va is None or vb is None: return None
        ds.append(va - vb)
    return sum(ds) / len(ds) if ds else None


def prefix_check(long, short):
    """Same seed, same option: the long run's first H actions should be the short run (H = the short horizon)."""
    same = diff = 0
    for rec in long:
        s = short.get(key(rec["meta"]))
        if not s: continue
        H = s["meta"]["horizon"]
        for o in rec["meta"]["options"]:
            lk = {r["k"]: r for r in rec["meta"]["runs"][o] if r.get("act")}
            for sr in s["meta"]["runs"].get(o, []):
                lr = lk.get(sr["k"])
                if not lr or not sr.get("act"): continue
                l_dead = lr["dead"] and lr["act"] <= H
                if sr["dead"] or l_dead:
                    ok = sr["dead"] == l_dead and sr["act"] == lr["act"]
                else:
                    cp = [c for c in lr.get("cp", []) if c[0] == H]
                    ok = bool(cp) and abs(cp[0][2] - sr["hp"]) < 0.0015
                same += ok; diff += not ok
    return {"compared": same + diff, "identical": same, "rate": round(same / max(1, same + diff), 4)}


def chooser_vs_rules(long, choose, h):
    w = l = t = 0
    total = 0.0
    n = 0
    for rec in long:
        m = rec["meta"]
        c, r = choose(rec), m.get("rules_choice")
        if not c or not r or c == r or r not in m["options"] or c not in m["options"]: continue
        d = paired(rec, h, c, r)
        if d is None: continue
        n += 1; total += d
        if d > 1e-9: w += 1
        elif d < -1e-9: l += 1
        else: t += 1
    return {"n": n, "wins": w, "losses": l, "ties": t, "mean_diff": round(total / n, 3) if n else None,
            "sign_p": sign_p(w, l), "sign_p_rules": sign_p(l, w)}


def analyse(long, short, answers):
    res = {"records": len(long), "by_type": dict(collections.Counter(r["meta"]["decision_type"] for r in long)),
           "prefix": prefix_check(long, short), "horizons": {}}
    short_choice = lambda rec: strict((short.get(key(rec["meta"])) or {}).get("gold", {}).get("decision", {}).get("probabilities"))  # noqa: E731
    for h in HORIZONS:
        agree = n = sh_agree = sh_n = ties = last_agree = last_n = 0
        for rec in long:
            seeds = rec["meta"]["paired_seeds"]
            lw = strict(means(rec, h, seeds))
            if lw is None: ties += 1
            last = strict(means(rec, HORIZONS[-1], seeds))
            if lw and last: last_n += 1; last_agree += lw == last
            sw = short_choice(rec)
            if lw and sw: n += 1; agree += lw == sw
            a = strict(means(rec, h, [k for k in seeds if k <= 4]))
            b = strict(means(rec, h, [k for k in seeds if k > 4]))
            if a and b: sh_n += 1; sh_agree += a == b
        row = {"long_tie": ties, "short_vs_long": {"n": n, "agree": round(agree / n, 4) if n else None},
               "long_split_half": {"n": sh_n, "agree": round(sh_agree / sh_n, 4) if sh_n else None},
               "vs_last": {"n": last_n, "agree": round(last_agree / last_n, 4) if last_n else None},
               "label_vs_rules": chooser_vs_rules(long, short_choice, h)}
        for name, ans in answers.items():
            row[f"{name}_vs_rules"] = chooser_vs_rules(long, lambda rec, ans=ans: (ans.get(key(rec["meta"])) or {}).get("choice"), h)
        deaths = collections.Counter()
        for rec in long:
            for o in rec["meta"]["options"]:
                for r in rec["meta"]["runs"][o]:
                    if r.get("act"): deaths[o, "n"] += 1; deaths[o, "dead"] += r["dead"] and r["act"] <= h
        row["death_rate"] = {o: round(deaths[o, "dead"] / deaths[o, "n"], 3) for o, x in deaths if x == "n"}
        res["horizons"][str(h)] = row
    return res


def load_answers(spec):
    out = {}
    for s in spec or []:
        name, path = s.split("=", 1)
        out[name] = {(a["game_id"], a["turn"], a["type"]): a["answer"] for a in map(json.loads, open(path)) if a}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--long", required=True); ap.add_argument("--short", required=True)
    ap.add_argument("--answers", nargs="*"); ap.add_argument("--out")
    a = ap.parse_args()
    long = [json.loads(l) for l in open(a.long) if l.strip()]
    short = {key(r["meta"]): r for r in map(json.loads, open(a.short))}
    res = analyse(long, short, load_answers(a.answers))
    text = json.dumps(res, indent=1)
    print(text)
    if a.out: open(a.out, "w").write(text)


if __name__ == "__main__":
    sys.exit(main())
