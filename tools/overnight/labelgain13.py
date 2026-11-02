#!/usr/bin/env python3
"""Do the labels' gains show up in game results? (after session 13)

1. Calibration: on session 7's long rollouts (valG, re-run from labelF's states with the same seeds), regress the
   long result (tournament score over h actions) of option vs rules on the short label's gain. The label comes from
   seeds 1-4 and the result from seeds 5-8 (and the reverse), so the two share no randomness, as in play; the slope
   is then scaled to an 8-seed label by the ratio of the label variances.
2. Label gains of trainH's overrides on its own states (labelL, labelM), split into acted and blocked by the cooldown.
3. Prediction per game (changes per game x mean gain x slope) against the tournaments' paired mean differences.

Usage: labelgain13.py RUNS_DIR
"""
import collections, json, math, os, sys  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import horizon as Hz  # noqa: E402

RUNS = sys.argv[1]
S13 = os.path.join(RUNS, "session13/2026-10-24")
FINALS = (("session11/2026-10-22", "finalK"), ("session12/2026-10-23", "finalL"), ("session13/2026-10-24", "finalM"))


def mean_se(v):
    n = len(v); m = sum(v) / n
    return m, math.sqrt(sum((x - m) ** 2 for x in v) / (n - 1) / n)


def var(v):
    m = sum(v) / len(v)
    return sum((x - m) ** 2 for x in v) / (len(v) - 1)


def slope(xs, ys):
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    s2 = sum((y - my - b * (x - mx)) ** 2 for x, y in zip(xs, ys)) / (len(xs) - 2)
    return b, math.sqrt(s2 / sxx)


def paired(rec, h, a, b, ks):
    m = rec["meta"]; runs = {o: {r["k"]: r for r in m["runs"][o]} for o in (a, b)}
    ds = []
    for k in ks:
        va, vb = Hz.value(runs[a].get(k, {}), m["depth"], h), Hz.value(runs[b].get(k, {}), m["depth"], h)
        if va is None or vb is None: return None
        ds.append(va - vb)
    return sum(ds) / len(ds)


def calibrate(h):
    long = [json.loads(l) for l in open(os.path.join(RUNS, "session7/2026-10-17/valG/labels.jsonl")) if l.strip()]
    short = {Hz.key(r["meta"]): r for r in map(json.loads, open(os.path.join(RUNS, "session6/2026-10-16/labelF/labels.jsonl")))}
    x8, xa, xb, ya, yb = [], [], [], [], []
    for rec in long:
        m = rec["meta"]; s = short.get(Hz.key(m)); r = m.get("rules_choice")
        if not s or r not in m["options"]: continue
        um = s["meta"].get("u_matrix") or {}
        if len(um.get(r, [])) != 8: continue
        for o in m["options"]:
            if o == r or len(um.get(o, [])) != 8: continue
            d = [um[o][i] - um[r][i] for i in range(8)]
            a, b = paired(rec, h, o, r, [1, 2, 3, 4]), paired(rec, h, o, r, [5, 6, 7, 8])
            if a is None or b is None: continue
            x8.append(sum(d) / 8); xa.append(sum(d[:4]) / 4); xb.append(sum(d[4:]) / 4); ya.append(a); yb.append(b)
    (s1, e1), (s2, e2) = slope(xa, yb), slope(xb, ya)
    k = (var(xa) + var(xb)) / 2 / var(x8)
    return len(x8), (s1 + s2) / 2 * k, math.sqrt(e1 ** 2 + e2 ** 2) / 2 * k


def gains():
    out = collections.defaultdict(list)
    for lab in ("labelL", "labelM"):
        dec = {}
        for l in open(os.path.join(S13, lab, "decisions.jsonl")):
            r = json.loads(l); dec[(r["game_id"], str(r["turn"]), r["decision_type"])] = r
        for l in open(os.path.join(S13, lab, "labels.jsonl")):
            m = json.loads(l)["meta"]; d = dec.get((m["game_id"], str(m["turn"]), m["decision_type"]))
            if not d: continue
            u = m["u_mean"]; u = json.loads(u.replace("'", '"')) if isinstance(u, str) else u
            mc, rc = d.get("model_choice"), d.get("rules_choice")
            if not mc or mc == rc or mc not in u or rc not in u: continue
            kind = "acted" if d.get("acted") == "model" else d.get("ration") or "gate"
            out[kind].append(u[mc] - u[rc])
    return {k: (len(v),) + mean_se(v) for k, v in out.items()}


def observed(arm, other="vs_rules+"):
    rows = []
    for run, st in FINALS:
        s = json.load(open(os.path.join(RUNS, run, "state.json")))["stages"][st]; s = s.get("result", s)
        if other == "vs_rules+":
            a = (s["vs_rules+"].get(arm) or {}).get("all"); cpg = (s["vs_rules+"].get(arm) or {}).get("changes_per_game")
        else:
            a = (s.get("head_to_head") or {}).get(f"{arm} vs {other}"); cpg = None
            a = a.get("all", a) if a else None
        if a: rows.append((run, a["pairs"], a["mean_diff"], (a["ci80"][1] - a["ci80"][0]) / 2 / 1.2816, cpg))
    w = [1 / r[3] ** 2 for r in rows]
    return rows, sum(wi * r[2] for wi, r in zip(w, rows)) / sum(w), 1 / math.sqrt(sum(w))


def main():
    print("calibration (game score per unit of label gain, independent seeds):")
    cal = {h: calibrate(h) for h in (500, 1500, 5000)}
    for h, (n, b, e) in cal.items(): print(f"  {h:5d} actions: {b:.2f} +- {e:.2f} (n {n})")
    _, b, be = cal[5000]
    g = gains()
    print("label gain of trainH's overrides on its own states (labelL + labelM):")
    for k, (n, m, e) in sorted(g.items()): print(f"  {k:9s} n {n:5d}  mean {m:+.4f} +- {e:.4f}")

    def predict(cpg, m, me):
        p = cpg * m * b
        return p, p * math.sqrt((me / m) ** 2 + (be / b) ** 2)
    for arm, other in (("H-c10", "vs_rules+"), ("H-c10-nocool", "vs_rules+"), ("H-c10-nocool", "H-c10")):
        rows, om, oe = observed(arm, other)
        print(f"{arm} {other}:")
        for run, n, md, se, cpg in rows: print(f"  {run}: pairs {n}, mean {md:+.3f} +- {se:.3f}, sd {se * math.sqrt(n):.2f}, changes/game {cpg}")
        print(f"  observed, pooled: {om:+.3f} +- {oe:.3f}")
    rows, _, _ = observed("H-c10"); cpg_h = sum(r[4] * r[1] for r in rows) / sum(r[1] for r in rows)
    rows, _, _ = observed("H-c10-nocool"); cpg_n = sum(r[4] * r[1] for r in rows) / sum(r[1] for r in rows)
    pa = predict(cpg_h, *g["acted"][1:])
    pc = predict(cpg_n - cpg_h, *g["cooldown"][1:])
    print(f"predicted H-c10 vs rules+: {cpg_h:.1f} changes x {g['acted'][1]:+.4f} x {b:.2f} = {pa[0]:+.3f} +- {pa[1]:.3f}")
    print(f"predicted nocool vs H-c10 (the extra changes are cooldown-blocked ones): {cpg_n - cpg_h:.1f} x {g['cooldown'][1]:+.4f} x {b:.2f} = {pc[0]:+.3f} +- {pc[1]:.3f}")
    sd = 3.2
    for n in (1143, 1611, 4387): print(f"  detectable at p < 0.025 with 80% power, {n} pairs, sd {sd}: {2.80 * sd / math.sqrt(n):.3f}")


if __name__ == "__main__":
    main()
