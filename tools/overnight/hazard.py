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

  screen    group-sequential adoption test on PH(10), with looks at 150, 300 and 700 complete paired starts.
            z = -log PH(10) / sd (positive: the variant is better), sd from a paired bootstrap over starts.
            Efficacy: O'Brien-Fleming bounds, overall one-sided alpha 0.05, from exact recursive integration.
            Futility (non-binding, so it doesn't enter the alpha): stop when the conditional power under the
            current trend falls below 2%, which is about "the variant isn't ahead" at looks 1 and 2.
            Never "adopt" while the death-rate ratio over stages 7+ (death_rr_deep) is above 1 with p < 0.05.
  simulate  synthetic games (the dict shape parse_game returns) from a per-stage hazard table, with death and pace
            ratios for the variant, paired starts sharing randomness: test_hazard.py uses it for the estimator,
            type I error, power and expected sample size.

Usage: hazard.py table DIR...                     rates and C for the games in the DIRs (one arm)
       hazard.py compare BASE_DIR VAR_DIR [--ref DIR...]  paired comparison of two arms on their common starts
       hazard.py screen BASE_DIR VAR_DIR [--look K]   the sequential decision on their common complete starts
                                                       (default: the last look the pair count has reached)
"""
import functools, json, math, os, random, re, statistics, sys  # noqa: E401

STATUS = re.compile(r"\[状態\] A(\d+) .*?\| DL(\d+) ")
CHANGE = re.compile(r"\[深度変更\] DL(\d+) → DL(\d+)")
MAX_STAGE = 40
DEEP_STAGE = 7


def parse_game(path):
    """{id, bank, start, end, actions, dead, segs: [(stage, exposure, 'adv'|'death'|'cens', next stage)]} or None."""
    try:
        with open(os.path.join(path, "busho-play-report.json")) as f: s = json.load(f)["summary"]
        with open(os.path.join(path, "player.log"), encoding="utf-8", errors="replace") as f: lines = f.read().splitlines()
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


# ── Sequential screening ──

LOOKS = (150, 300, 700)   # complete paired starts at each look
ALPHA = 0.05              # overall one-sided type I error
FUTILITY_CP = 0.02        # stop for futility below this conditional power (current trend); non-binding
SCREEN_K = 10             # the verdict score is PH(SCREEN_K)
_ND = statistics.NormalDist()


def _Phi(x):
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def _phi(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _simpson(lo, hi, h):
    n = max(2, int(math.ceil((hi - lo) / h)))
    n += n % 2
    step = (hi - lo) / n
    return ([lo + i * step for i in range(n + 1)],
            [step / 3 * (1 if i in (0, n) else 4 if i % 2 else 2) for i in range(n + 1)])


def exit_probs(up, lo, t, theta=0.0, per_sd=16):
    """Stopping probabilities of a group-sequential z-test: ([P(stop above at look k)], [P(stop below at look k)]).
    Canonical joint distribution: Z_k = S_k / sqrt(t_k) with independent increments S_k - S_k-1 ~ N(theta dt, dt),
    t_k the information fractions (t_K = 1, so theta is the expected final z). up/lo are z-scale bounds, lo[k] None
    for none. Recursive numerical integration of the continuation density (Simpson's rule, per_sd points per sd)."""
    pu, pl, xs, ws, f = [], [], None, None, None
    for k, tk in enumerate(t):
        sd = math.sqrt(tk)
        b = up[k] * sd
        a = lo[k] * sd if lo[k] is not None else -math.inf
        if k == 0:
            m = theta * tk
            pu.append(1 - _Phi((b - m) / sd)); pl.append(_Phi((a - m) / sd) if a > -math.inf else 0.0)
        else:
            dt = tk - t[k - 1]; sdd, mu = math.sqrt(dt), theta * dt
            wf = [w * fx for w, fx in zip(ws, f)]
            pu.append(sum(c * (1 - _Phi((b - x - mu) / sdd)) for x, c in zip(xs, wf)))
            pl.append(sum(c * _Phi((a - x - mu) / sdd) for x, c in zip(xs, wf)) if a > -math.inf else 0.0)
        if k == len(t) - 1: break
        nx, nw = _simpson(max(a, theta * tk - 8 * sd), b, sd / per_sd)
        if k == 0:
            f = [_phi((u - m) / sd) / sd for u in nx]
        else:
            f = [sum(c * _phi((u - x - mu) / sdd) for x, c in zip(xs, wf)) / sdd for u in nx]
        xs, ws = nx, nw
    return pu, pl


@functools.lru_cache(maxsize=None)
def obf_bounds(looks=LOOKS, alpha=ALPHA):
    """O'Brien-Fleming efficacy bounds z_k = c / sqrt(t_k), c set so that the chance of crossing any of them under
    H0 (with no futility stopping) is alpha."""
    t = tuple(n / looks[-1] for n in looks)
    lo, hi = 1.0, 6.0
    for _ in range(50):
        c = (lo + hi) / 2
        if sum(exit_probs([c / math.sqrt(x) for x in t], [None] * len(t), t)[0]) > alpha: lo = c
        else: hi = c
    return tuple(hi / math.sqrt(x) for x in t)


@functools.lru_cache(maxsize=None)
def futility_bounds(looks=LOOKS, alpha=ALPHA, cp=FUTILITY_CP):
    """Stop for futility at look k < K when z_k is below this: the conditional power under the current trend,
    1 - Phi((b_K - z_k / sqrt(t_k)) / sqrt(1 - t_k)), is below cp. The last look's bound is the efficacy bound."""
    t = [n / looks[-1] for n in looks]
    bK, zc = obf_bounds(looks, alpha)[-1], _ND.inv_cdf(1 - cp)
    return tuple([math.sqrt(x) * (bK - zc * math.sqrt(1 - x)) for x in t[:-1]] + [bK])


def _start_vectors(base, var, ids):
    """Per start: its stage totals [E, D, A per stage] for the base game, then for the variant game."""
    rows = []
    for i in ids:
        tb, tv = rates([base[i]]), rates([var[i]])
        rows.append((tb, tv))
    S = 1 + max([d for tb, tv in rows for d in list(tb) + list(tv)] or [0])
    vecs = []
    for tb, tv in rows:
        v = [0.0] * (6 * S)
        for off, t in ((0, tb), (3 * S, tv)):
            for d, r in t.items(): v[off + 3 * d:off + 3 * d + 3] = r
        vecs.append(v)
    return vecs, S


def _screen_stats(tot, S, k=SCREEN_K):
    """(log PH(k), log death_rr_deep) from summed start vectors."""
    tb = {d: tot[3 * d:3 * d + 3] for d in range(S)}
    tv = {d: tot[3 * S + 3 * d:3 * S + 3 * d + 3] for d in range(S)}
    dr, pr = mh_ratio(tb, tv, 1), mh_ratio(tb, tv, 2)
    deep = mh_ratio(tb, tv, 1, DEEP_STAGE)
    lph = float("nan")
    if dr > 0 and pr > 0:
        lph = math.log(ctable(scaled(tb, dr, pr))[k] / ctable(tb)[k])
    return lph, (math.log(deep) if deep > 0 and math.isfinite(deep) else float("nan"))


def _boot_sd(vecs, S, n_boot, seed):
    rng, n, ph, dp = random.Random(seed), len(vecs), [], []
    for _ in range(n_boot):
        tot = [sum(c) for c in zip(*[vecs[rng.randrange(n)] for _ in range(n)])]
        a, b = _screen_stats(tot, S)
        if math.isfinite(a): ph.append(a)
        if math.isfinite(b): dp.append(b)
    sd = lambda xs: statistics.stdev(xs) if len(xs) > 2 else float("nan")  # noqa: E731
    return sd(ph), sd(dp)


def _delta_sd(vecs, S, tot):
    """Linearised (infinitesimal jackknife) sd: the start-level influence of each total, by central differences.
    It estimates the same quantity as the paired bootstrap, in milliseconds; the simulation studies use it."""
    n = len(vecs)
    mean = [x / n for x in tot]
    # only totals that vary across starts carry any variance
    live = [j for j in range(len(tot)) if any(v[j] != mean[j] for v in vecs)]
    grads = {}
    for j in live:
        h = 1e-4 * max(abs(tot[j]), 1.0)
        up, dn = list(tot), list(tot)
        up[j] += h; dn[j] -= h
        a1, b1 = _screen_stats(up, S); a0, b0 = _screen_stats(dn, S)
        ga, gb = (a1 - a0) / (2 * h), (b1 - b0) / (2 * h)
        grads[j] = (ga if math.isfinite(ga) else 0.0, gb if math.isfinite(gb) else 0.0)
    va = vb = 0.0
    for v in vecs:
        ia = sum(g[0] * (v[j] - mean[j]) for j, g in grads.items())
        ib = sum(g[1] * (v[j] - mean[j]) for j, g in grads.items())
        va += ia * ia; vb += ib * ib
    return math.sqrt(va), math.sqrt(vb)


def screen(base, var, look=None, sd="bootstrap", n_boot=1000, seed=0, looks=LOOKS, ids=None):
    """The sequential adoption decision for a variant against the baseline on their common complete starts.

    look: 1-based look number; None picks the last look the pair count has reached. A look uses every common start
    available (at least looks[look-1]); the bounds are those of the planned information fractions.
    sd: "bootstrap" (paired over starts, n_boot resamples) or "delta" (linearised; the simulation studies).
    Returns {"decision": "adopt"|"reject"|"continue", "look", "pairs", "z", "bound", "futility", "PH", "sd",
    "death_rr_deep", "deep_p", "reason"}."""
    ids = sorted(set(base) & set(var)) if ids is None else list(ids)
    n = len(ids)
    if look is None:
        look = sum(n >= x for x in looks)
    res = {"look": look, "pairs": n, "planned": looks[look - 1] if look else looks[0]}
    if look == 0 or n < looks[look - 1]:
        return {**res, "decision": "continue", "reason": f"need {looks[max(look, 1) - 1]} complete pairs"}
    vecs, S = _start_vectors(base, var, ids)
    tot = [sum(c) for c in zip(*vecs)]
    lph, ldeep = _screen_stats(tot, S)
    sd_ph, sd_deep = _boot_sd(vecs, S, n_boot, seed) if sd == "bootstrap" else _delta_sd(vecs, S, tot)
    z = -lph / sd_ph if sd_ph > 0 and math.isfinite(lph) else 0.0
    up, fut = obf_bounds(looks), futility_bounds(looks)
    deep_p = 1 - _Phi(ldeep / sd_deep) if math.isfinite(ldeep) and sd_deep > 0 else None
    res.update({"z": z, "bound": up[look - 1], "futility": fut[look - 1], "PH": math.exp(lph), "sd": sd_ph,
                "death_rr_deep": math.exp(ldeep) if math.isfinite(ldeep) else None, "deep_p": deep_p})
    last = look == len(looks)
    deep_bad = deep_p is not None and ldeep > 0 and deep_p < 0.05
    if z >= up[look - 1] and not deep_bad:
        return {**res, "decision": "adopt", "reason": "efficacy bound crossed"}
    if z >= up[look - 1]:
        return {**res, "decision": "reject" if last else "continue", "reason": "efficacy bound crossed, but deep deaths up"}
    if last:
        return {**res, "decision": "reject", "reason": "final look below the efficacy bound"}
    if z < fut[look - 1]:
        return {**res, "decision": "reject", "reason": "futility"}
    return {**res, "decision": "continue", "reason": "between the bounds"}


# ── Simulation ──

# Session 14's default rules (combo14), 1,145 games: stage: (exposure in actions, deaths, advances).
BASELINE_14 = {0: (83980, 0, 915), 1: (885941, 34, 880), 2: (1454957, 84, 790), 3: (1783518, 82, 680),
               4: (2241846, 80, 518), 5: (1876779, 97, 433), 6: (1896435, 82, 333), 7: (1224519, 99, 209),
               8: (793071, 86, 94), 9: (279043, 40, 42), 10: (143182, 21, 11)}


def hazard_rates(table=BASELINE_14):
    """[(death rate, advance rate) per action] for stages 0..MAX_STAGE; stages past the table keep its last rates."""
    last = max(table)
    return [(table[min(d, last)][1] / table[min(d, last)][0], table[min(d, last)][2] / table[min(d, last)][0])
            for d in range(MAX_STAGE + 1)]


def true_ph(death_rr, pace_rr, k=SCREEN_K, table=BASELINE_14):
    """PH(k) of the generating model: the table with both ratios applied, against the table itself."""
    t = {d: list(r) for d, r in table.items()}
    return ctable(scaled(t, death_rr, pace_rr))[k] / ctable(t)[k]


def _sim_game(gid, bank, start, cap, hz, frail, pfrail, drr, prr, shared, priv, tau):
    """One game: competing exponential death and advance times per stage. Stage d's draw comes from shared[d]
    until time tau, after which (memoryless) the rest is drawn from priv."""
    t, st, segs = 0.0, start, []
    while True:
        lam, mu = hz[min(st, MAX_STAGE)][0] * frail * drr, hz[min(st, MAX_STAGE)][1] * pfrail * prr
        tot = lam + mu
        u1, u2 = shared[min(st, MAX_STAGE)] if t < tau else (1 - priv.random(), priv.random())
        end = t - math.log(u1) / tot
        if t < tau < end:
            end, u2 = tau - math.log(1 - priv.random()) / tot, priv.random()
        if end >= cap:
            segs.append((st, cap - t, "cens", None)); return _game(gid, bank, start, st, cap, False, segs)
        if u2 < lam / tot:
            segs.append((st, end - t, "death", None)); return _game(gid, bank, start, st, end, True, segs)
        segs.append((st, end - t, "adv", st + 1)); st, t = st + 1, end


def _game(gid, bank, start, end, actions, dead, segs):
    return {"id": gid, "bank": bank, "start": start, "end": end, "actions": int(round(actions)), "dead": dead,
            "segs": segs}


def simulate(n, death_rr=1.0, pace_rr=1.0, seed=0, table=BASELINE_14, bank_share=0.2, bank_stages=(5, 12),
             caps=(20000, 15000), frailty=0.0, pace_frailty=0.0, diverge_mean=10000.0):
    """n paired starts: ({id: base game}, {id: variant game}). The variant's death and advance rates are the
    baseline's times death_rr and pace_rr at every stage (proportional hazards). bank_share of the starts begin at a
    stage drawn uniformly from bank_stages, with the bank cap; the rest at stage 0 with the fresh cap.

    Pairs share randomness, as real paired games do: the same per-stage random draws until a divergence time
    (exponential, mean diverge_mean actions), after which the variant's game draws its own. With both ratios 1 the
    arms are identical up to that time and independent after it, as games are once a rule first changes an action.
    frailty and pace_frailty (sd on the log scale, mean 1) add a per-character factor on the death and advance rates,
    shared by the pair. They default to 0: with frailty the stage-stratified ratio that PH measures is pulled toward
    1 (survivors of the safer arm are frailer), so death_rr and pace_rr would no longer be the measured ratios."""
    hz, base, var = hazard_rates(table), {}, {}
    for i in range(n):
        rng = random.Random((seed * 1_000_003 + i) * 7919 + 17)
        bank = rng.random() < bank_share
        start = rng.randint(*bank_stages) if bank else 0
        cap = caps[1] if bank else caps[0]
        frail = math.exp(frailty * rng.gauss(0, 1) - frailty ** 2 / 2)
        pfrail = math.exp(pace_frailty * rng.gauss(0, 1) - pace_frailty ** 2 / 2)
        tau = rng.expovariate(1 / diverge_mean) if diverge_mean else 0.0
        shared = [(1 - rng.random(), rng.random()) for _ in range(MAX_STAGE + 1)]
        priv = random.Random(rng.getrandbits(64))
        gid = f"{'bank-' if bank else ''}sim{seed}-{i:05d}"
        base[gid] = _sim_game(gid, bank, start, cap, hz, frail, pfrail, 1.0, 1.0, shared, None, math.inf)
        var[gid] = _sim_game(gid, bank, start, cap, hz, frail, pfrail, death_rr, pace_rr, shared, priv, tau)
    return base, var


def run_screen(base, var, looks=LOOKS, sd="delta", **kw):
    """Play the sequential design on starts in id order (the order they were simulated): the result of the first
    look that stops, with the pairs it used."""
    ids = sorted(set(base) & set(var), key=lambda g: g.split("-")[-1])
    r = None
    for k, n in enumerate(looks, 1):
        r = screen(base, var, k, sd=sd, looks=looks, ids=ids[:n], **kw)
        if r["decision"] != "continue": return r
    return r


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
    if not a or a[0] not in ("table", "compare", "screen"): sys.exit(__doc__)
    if a[0] == "screen":
        if len(a) < 3: sys.exit(__doc__)
        look = int(a[a.index("--look") + 1]) if "--look" in a else None
        r = screen(load([a[1]]), load([a[2]]), look)
        r["bounds"], r["futility_bounds"], r["looks"] = obf_bounds(), futility_bounds(), LOOKS
        print(json.dumps(r, indent=1))
        return
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
