#!/usr/bin/env python3
"""Cap-free scores from game logs: per-depth death and descent rates, and the replacement-cost score.

See docs/finetune-laya-plan.md, "Measurement: exposure-based score". A game's progress stage is the deepest level it has
reached so far. From player.log's status lines (depth and action count every 200 actions) and its depth changes, each
game becomes a list of stage segments, each ending in an advance, a death or the action cap (censored).

  rates     per stage d: exposure E_d (actions), deaths D_d, advances A_d. Under constant hazards the advance chance is
            p_d = A_d / (A_d + D_d) and the mean stay tau_d = E_d / (A_d + D_d); censored games add exposure only.
  C(k)      expected actions for a fresh character to first reach DL k, counting deaths and restarts:
            C(d+1) = (C(d) + tau_d) / p_d. The policy-level objective (lower is better).
  PH(k)     the verdict score: the stage-stratified death-rate and advance-rate ratios of a variant (Mantel-Haenszel),
            applied to the baseline's own table, as C_var(k) / C_base(k). Raw C(k) ratios are much noisier, since
            most of their weight falls on deep stages with few events.
  rc        per-game replacement-cost score against a fixed reference table C: C(end stage) - C(start stage) - actions
            if alive, -C(start stage) - actions if dead. Zero on average for the reference policy; paired by start.
            Reported only: a few deep games dominate it.

Usage: hazard.py table DIR...                     rates and C for the games in the DIRs (one arm)
       hazard.py compare BASE_DIR VAR_DIR [--ref DIR...]  paired comparison of two arms on their common starts
"""
import json, math, os, random, re, sys  # noqa: E401

STATUS = re.compile(r"\[状態\] A(\d+) .*?\| DL(\d+) ")
CHANGE = re.compile(r"\[深度変更\] DL(\d+) → DL(\d+)")
MAX_STAGE = 40
DEEP_STAGE = 7


def parse_game(path):
    """{id, bank, start, end, actions, dead, segs: [(stage, exposure, 'adv'|'death'|'cens', next stage)]} or None."""
    try:
        s = json.load(open(os.path.join(path, "busho-play-report.json")))["summary"]
        lines = open(os.path.join(path, "player.log"), encoding="utf-8", errors="replace").read().splitlines()
    except (OSError, ValueError, KeyError):
        return None
    total = int(s.get("actions") or 0)
    ev = []  # ("s", action, depth) | ("c", from, to)
    for ln in lines:
        m = STATUS.search(ln)
        if m: ev.append(("s", int(m[1]), int(m[2]))); continue
        m = CHANGE.search(ln)
        if m: ev.append(("c", int(m[1]), int(m[2])))
    # place each depth change between the status lines around it, spread evenly
    timed, i, prev_a = [], 0, 0
    while i < len(ev):
        if ev[i][0] == "s": prev_a = ev[i][1]; timed.append(ev[i]); i += 1; continue
        j = i
        while j < len(ev) and ev[j][0] == "c": j += 1
        next_a = ev[j][1] if j < len(ev) else max(total, prev_a)
        n = j - i
        for k in range(n):
            timed.append(("c", prev_a + (next_a - prev_a) * (k + 1) / (n + 1), ev[i + k][1], ev[i + k][2]))
        i = j
    name = os.path.basename(path.rstrip("/"))
    # a fresh start begins in town; a bank start at the first dungeon level it's seen on (restored characters often
    # begin in town and recall straight to their deepest level)
    seen = [d for e in ev for d in ((e[1], e[2]) if e[0] == "c" else (e[2],)) if d > 0]
    start = (seen[0] if seen else int(s.get("maxDepth") or 0)) if "bank" in name else 0
    stage, t0, segs = start, 0.0, []
    for e in timed:
        depth, a = (e[2], e[1]) if e[0] == "s" else (e[3], e[1])
        if depth > stage:
            segs.append((stage, max(0.0, a - t0), "adv", depth)); stage, t0 = depth, a
    dead = bool(s.get("dead"))
    segs.append((stage, max(0.0, total - t0), "death" if dead else "cens", None))
    return {"id": name, "bank": "bank" in name, "start": start, "end": stage, "actions": total, "dead": dead,
            "segs": segs}


def load(dirs):
    games = {}
    for d in dirs:
        for g in sorted(os.listdir(d)):
            r = parse_game(os.path.join(d, g))
            if r: games[r["id"]] = r
    return games


def rates(games):
    """{stage: [E, D, A]}; a jump from d to d+j also passes d+1..d+j-1 with no exposure."""
    t = {}
    for g in games:
        for st, e, kind, nxt in g["segs"]:
            r = t.setdefault(st, [0.0, 0, 0]); r[0] += e
            if kind == "death": r[1] += 1
            elif kind == "adv":
                r[2] += 1
                for mid in range(st + 1, nxt):
                    t.setdefault(mid, [0.0, 0, 0])[2] += 1
    return t


def ctable(t, prior=(1.0, 1.0)):
    """C[d] for d = 0..: expected actions to first reach stage d from a fresh start. A weak prior (one death and one
    advance at the pooled time per event) keeps thin stages finite; stages with no exposure extend the last ratio."""
    events = sum(r[1] + r[2] for r in t.values()) or 1
    pooled_tau = sum(r[0] for r in t.values()) / events
    C, last = [0.0], None
    for d in range(MAX_STAGE):
        r = t.get(d)
        if r is None or r[0] == 0 and r[1] + r[2] == 0:
            if last is None: C.append(C[-1] + pooled_tau); continue
            C.append(C[-1] * last); continue
        D, A = r[1] + prior[0] * 0.5, r[2] + prior[1] * 0.5
        tau = (r[0] + prior[0] * pooled_tau) / (D + A)
        p = A / (A + D)
        C.append((C[-1] + tau) / p)
        last = C[-1] / C[-2] if C[-2] > 0 else None
    return C


def rc(g, C):
    """Replacement-cost score with the time charge, in actions."""
    v = -C[g["start"]] - g["actions"]
    return v + (0 if g["dead"] else C[g["end"]])


def capped(g):
    return g["end"] - (3 if g["dead"] else 0)


def paired(base, var, score, n_boot=4000, seed=0):
    ids = sorted(set(base) & set(var))
    d = [score(var[i]) - score(base[i]) for i in ids]
    n = len(d)
    if n == 0: return {"pairs": 0}
    m = sum(d) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in d) / max(1, n - 1))
    rng = random.Random(seed)
    boots = sorted(sum(rng.choice(d) for _ in range(n)) / n for _ in range(n_boot))
    # one-sided sign-flip permutation test on the mean (pairs are exchangeable under H0)
    flips = sum(1 for _ in range(n_boot) if sum(x if rng.random() < 0.5 else -x for x in d) / n >= m)
    w, l = sum(x > 0 for x in d), sum(x < 0 for x in d)
    return {"pairs": n, "mean": m, "sd": sd, "t": m / (sd / math.sqrt(n)) if sd else 0.0, "wins": w, "losses": l,
            "ci80": (boots[int(0.1 * n_boot)], boots[int(0.9 * n_boot)]), "perm_p": (flips + 1) / (n_boot + 1)}


def mh_ratio(tb, tv, col, min_stage=0):
    """Mantel-Haenszel rate ratio var/base of deaths (col 1) or advances (col 2) per action, stratified by stage."""
    num = den = 0.0
    for d in set(tb) & set(tv):
        if d < min_stage: continue
        eb, ev = tb[d][0], tv[d][0]
        if eb <= 0 or ev <= 0: continue
        num += tv[d][col] * eb / (eb + ev); den += tb[d][col] * ev / (eb + ev)
    return num / den if den else float("nan")


def scaled(t, death_rr, pace_rr):
    """The rate table with every stage's death rate times death_rr and advance rate times pace_rr (exposure kept)."""
    return {d: [r[0], r[1] * death_rr, r[2] * pace_rr] for d, r in t.items()}


def policy(base, var, ks=(5, 8, 10), n_boot=1000, seed=0):
    """Policy-level comparison on the starts both arms played (fresh and bank pooled by stage): C(k) ratios var/base
    (below 1 is better), the stage-stratified death-rate ratio (below 1 is better) and advance-rate ratio (above 1 is
    faster), and PH(k), the C(k) ratio under proportional hazards (the base table with both ratios applied), each with a paired bootstrap over starts: 80% interval and the one-sided chance the variant isn't better."""
    ids = sorted(set(base) & set(var))

    def stats(sel):
        tb, tv = rates([base[i] for i in sel]), rates([var[i] for i in sel])
        cb, cv = ctable(tb), ctable(tv)
        out = {f"C{k}": cv[k] / cb[k] for k in ks}
        out["death_rr"], out["pace_rr"] = mh_ratio(tb, tv, 1), mh_ratio(tb, tv, 2)
        out["death_rr_deep"] = mh_ratio(tb, tv, 1, DEEP_STAGE)  # the check on proportional hazards
        cp = ctable(scaled(tb, out["death_rr"], out["pace_rr"]))
        out.update({f"PH{k}": cp[k] / cb[k] for k in ks})
        return out
    point, rng, boots = stats(ids), random.Random(seed), []
    for _ in range(n_boot):
        boots.append(stats([rng.choice(ids) for _ in ids]))
    res = {"starts": len(ids)}
    for key, v in point.items():
        b = sorted(x[key] for x in boots)
        worse = sum((x <= 1) if key == "pace_rr" else (x >= 1) for x in b) / n_boot
        res[key] = {"ratio": v, "ci80": (b[int(0.1 * n_boot)], b[int(0.9 * n_boot)]), "p": worse}
    return res


def show_table(t, C, upto=15):
    print("stage  exposure  deaths  advances  deaths/1k  p_adv   tau     C(stage+1)")
    for d in range(upto):
        r = t.get(d, [0, 0, 0])
        rate = 1000 * r[1] / r[0] if r[0] else float("nan")
        p = r[2] / (r[1] + r[2]) if r[1] + r[2] else float("nan")
        tau = r[0] / (r[1] + r[2]) if r[1] + r[2] else float("nan")
        print(f"{d:5d} {r[0]:9.0f} {r[1]:7d} {r[2]:9d} {rate:10.3f} {p:6.3f} {tau:7.0f} {C[d + 1]:12.0f}")


def main():
    a = sys.argv[1:]
    if not a or a[0] not in ("table", "compare"): sys.exit(__doc__)
    if a[0] == "table":
        games = list(load(a[1:]).values())
        for label, gs in (("all", games), ("fresh", [g for g in games if not g["bank"]])):
            t = rates(gs)
            print(f"== {label}: {len(gs)} games, {sum(g['dead'] for g in gs)} deaths"); show_table(t, ctable(t))
        return
    ref = a[a.index("--ref") + 1:] if "--ref" in a else [a[1]]
    base, var = load([a[1]]), load([a[2]])
    C = ctable(rates(load(ref).values()))
    print(json.dumps({"capped": paired(base, var, capped), "rc": paired(base, var, lambda g: rc(g, C)),
                      "policy": policy(base, var)}, indent=1))


if __name__ == "__main__":
    main()
