#!/usr/bin/env python3
"""M1 step 1, offline (docs/plan-2026-11-09.md): headroom and deciders on a rule knockout's label sets.

  headroom  LABELS.jsonl (tools/rollout/run.ts output, utility "game": levels gained − 3 if dead) → the held-out gain
            of the rollout pick over the rules' choice (picked on seeds 1..K/2, scored on K/2+1..K), the share of
            outcome variance the option explains within a decision, and death and depth by option.
  agree     SHORT.jsonl LONG.jsonl → how often the short labels' pick matches the long ones' (all seeds), and the
            long-label regret of following the short pick.
  score     LONG.jsonl ANSWERS.jsonl [...] → for each decider's answers ({game_id, turn, choice}), agreement with the
            long pick, mean regret against it (u_mean best − u_mean chosen) and the gain over the rules' choice.
  trees     TRAIN.jsonl LONG.jsonl COLLECT_RUN SELDIR OUT.jsonl → LightGBM per option on the danger-log features
            at each decision, trained on TRAIN's u_mean, answering LONG's decisions (the "trees" arm). SELDIR holds
            m1_select.py's check.jsonl and train.jsonl (they map a record's game_id to its collection game). Run in
            the pipenv that has lightgbm (tools/overnight/native).

  ceiling   LABELS.jsonl [BASE] → per option against BASE (default the best constant): mean difference, true-effect sd,
            label reliability and the noise-corrected gain of a perfect state reader (Fable's review, 2026-11-11).
  score     also takes --vs BASE_ANSWERS (paired difference with bootstrap intervals) and --clusters JSON
            ({game_id: lineage}, for a bootstrap over lineages). TREES_TARGET=share trains trees on the win shares.

Usage: m1_offline.py headroom LABELS.jsonl | agree SHORT LONG | score LONG ANSWERS... [--vs BASE] [--clusters JSON]
       | trees TRAIN LONG RUN SELDIR OUT [LONG_RUN LONG_SELDIR] | ceiling LABELS [BASE] | aligned STAGE_DIR [ARMS] | splits LABELS
  splits    LABELS → headroom averaged over every half/half seed split, with death-rate and pace ratios (pooled on
            the held-out seeds) of the pick against the best constant and the rules (Fable's review of 6598a6c).
  aligned   STAGE_DIR (a paired screen's deepS/) → per arm, label u and deepest-level u, arm − base, from the first
            divergence to 500/1,000/2,000/4,000 actions and to the game's end (Fable's aligned-play canary).
"""
import bisect, gzip, json, os, statistics as st, sys  # noqa: E401


def load(path):
    return [json.loads(l) for l in open(path) if l.strip()]


def key(rec):
    m = rec["meta"]
    return (m["game_id"], m["turn"])


def per_seed(m):
    """{option: {k: (u, dead, levels gained)}} from a labelled record's runs (utility "game")."""
    R = {}
    for o, rs in m["runs"].items():
        for r in rs:
            if "dead" not in r: continue
            g = max(0, (r.get("dmax") or 0) - m.get("progress_from", m["depth"]))  # m1_rescore.py: from the deepest level
            R.setdefault(o, {})[r["k"]] = (g - (3 if r["dead"] else 0), r["dead"], g, r.get("act") or 0)
    return R


def headroom_splits(recs):
    """Fable's review of 6598a6c: average over every half/half seed split (one split can be lucky). For each split,
    the best constant is chosen on the A seeds pooled over decisions and the per-decision pick on A; both are scored
    on B. Reports the split-averaged pick over the constant (se from per-decision averages) and, pooled on B, the
    death-rate and pace (levels per action) ratios of the pick against the constant and against the rules."""
    import itertools
    rows = []
    for x in recs:
        m = x["meta"]; R = per_seed(m)
        opts = [o for o in m["options"] if o in R]
        K = max((k for o in opts for k in R[o]), default=0)
        ks = [k for k in range(1, K + 1) if all(k in R[o] for o in opts)]
        if len(ks) >= 2 and m["rules_choice"] in opts: rows.append((R, opts, ks, m["rules_choice"]))
    if not rows: return {"decisions": 0}
    nk = __import__("collections").Counter(len(ks) for _, _, ks, _ in rows).most_common(1)[0][0]
    rows = [(R, o, ks[:nk], rc) for R, o, ks, rc in rows if len(ks) >= nk]  # the usual seed count; fewer: dropped
    combos = [set(c) for c in itertools.combinations(range(nk), nk // 2)]
    per = [[] for _ in rows]; pool = {"pick": [0, 0, 0.0, 0], "const": [0, 0, 0.0, 0], "rules": [0, 0, 0.0, 0]}
    consts = []
    for A_idx in combos:
        AB = [([ks[i] for i in range(nk) if i in A_idx], [ks[i] for i in range(nk) if i not in A_idx]) for _, _, ks, _ in rows]
        mean = lambda R, o, kk: st.mean(R[o][k][0] for k in kk)  # noqa: E731
        tot = {}
        for (R, opts, ks, rc), (A, B) in zip(rows, AB):
            for o in opts: tot[o] = tot.get(o, 0.0) + mean(R, o, A)
        const = max(tot, key=lambda o: (round(tot[o], 9), o == rows[0][3])); consts.append(const)
        for j, ((R, opts, ks, rc), (A, B)) in enumerate(zip(rows, AB)):
            best = pick({o: mean(R, o, A) for o in opts}, rc); c = const if const in opts else rc
            per[j].append(mean(R, best, B) - mean(R, c, B))
            for name, o in (("pick", best), ("const", c), ("rules", rc)):
                for k in B:
                    u, dead, lev, act = R[o][k]; P = pool[name]; P[0] += 1; P[1] += dead; P[2] += lev; P[3] += act
    avg = [st.mean(v) for v in per]
    ratio = lambda a, b, i: (pool[a][i] / max(1e-9, pool[a][0])) / max(1e-9, pool[b][i] / max(1e-9, pool[b][0]))  # noqa: E731
    pace = lambda a: pool[a][2] / max(1, pool[a][3])  # noqa: E731
    return {"decisions": len(rows), "splits": len(combos), "constants": dict(__import__("collections").Counter(consts)),
            "pick_over_constant": round(st.mean(avg), 4), "se": round(st.pstdev(avg) / len(avg) ** 0.5, 4),
            "by_split": [round(st.mean(v[i] for v in per), 4) for i in range(len(combos))],
            "pick_vs_constant": {"death_ratio": round(ratio("pick", "const", 1), 3), "pace_ratio": round(pace("pick") / max(1e-9, pace("const")), 3)},
            "pick_vs_rules": {"death_ratio": round(ratio("pick", "rules", 1), 3), "pace_ratio": round(pace("pick") / max(1e-9, pace("rules")), 3)},
            "constant_vs_rules": {"death_ratio": round(ratio("const", "rules", 1), 3), "pace_ratio": round(pace("const") / max(1e-9, pace("rules")), 3)}}


def pick(u, rules):
    """The best option by mean u; the rules' choice wins ties."""
    top = max(u.values())
    return rules if u.get(rules, -1e9) >= top - 1e-9 else max(u, key=u.get)


def headroom(recs):
    gains, var_opt, var_tot, by, rows = [], [], [], {}, []
    for x in recs:
        m = x["meta"]; R = per_seed(m)
        opts = [o for o in m["options"] if o in R]
        K = max((k for o in opts for k in R[o]), default=0)
        ks = [k for k in range(1, K + 1) if all(k in R[o] for o in opts)]
        if len(ks) < 4 or m["rules_choice"] not in opts: continue
        A, B = ks[:len(ks) // 2], ks[len(ks) // 2:]
        mean = lambda o, kk, i=0: st.mean(R[o][k][i] for k in kk)  # noqa: E731
        best = pick({o: mean(o, A) for o in opts}, m["rules_choice"])
        gains.append(mean(best, B) - mean(m["rules_choice"], B))
        rows.append(({o: mean(o, A) for o in opts}, {o: mean(o, B) for o in opts}, m["rules_choice"], best))
        allu = [R[o][k][0] for o in opts for k in ks]
        var_tot.append(st.pvariance(allu)); var_opt.append(st.pvariance([mean(o, ks) for o in opts]))
        for o in opts:
            b = by.setdefault(o, [0, 0, 0.0])
            b[0] += len(ks); b[1] += sum(R[o][k][1] for k in ks); b[2] += sum(R[o][k][2] for k in ks)
    n = len(gains)
    if not n: return {"decisions": 0}
    sd = st.pstdev(gains) / n ** 0.5
    # the best constant answer (one option for every decision, chosen on seeds A pooled over decisions, scored on B;
    # the rules' choice where it isn't offered): headroom a rule could take without reading the state. The pick's
    # gain over it is the state-dependent part, which is what a decision model can add over a rule.
    allo = {o for a, _, _, _ in rows for o in a}
    tot = {o: sum(a.get(o, a[rc]) for a, _, rc, _ in rows) for o in allo}  # not offered: falls back to the rules' choice
    const = max(tot, key=lambda o: (round(tot[o], 9), o == rows[0][2]))
    cg = [b.get(const, b[rc]) - b[rc] for _, b, rc, _ in rows]
    sg = [b[bst] - b.get(const, b[rc]) for _, b, rc, bst in rows]
    se = lambda v: round(st.pstdev(v) / len(v) ** 0.5, 4)  # noqa: E731
    return {"best_constant": const, "constant_gain": round(st.mean(cg), 4), "constant_se": se(cg),
            "pick_over_constant": round(st.mean(sg), 4), "pick_over_constant_se": se(sg),
            "decisions": n, "heldout_gain": round(st.mean(gains), 4), "se": round(sd, 4),
            "better": sum(g > 0 for g in gains), "worse": sum(g < 0 for g in gains), "same": sum(g == 0 for g in gains),
            "option_variance_share": round(st.mean(var_opt) / max(1e-9, st.mean(var_tot)), 3),
            "by_option": {o: {"n": b[0], "dead": round(b[1] / b[0], 3), "levels": round(b[2] / b[0], 3)} for o, b in by.items()}}


def ceiling(recs, base=None):
    """Noise-corrected headroom (Fable's review, 2026-11-11): for each option o against the base option b (default the
    best constant by mean u), the per-decision K-seed mean difference d_i = mean_k(u_o - u_b) and its sampling
    variance s_i^2 / K. The true-effect variance is var(d) - mean(s^2/K); reliability = that / var(d). A perfect state
    reader choosing between o and b gains E[max(delta, 0)] - max(mu, 0) over the better constant, with
    delta ~ N(mu, tau^2): an upper estimate (a share of effects are exactly zero)."""
    import math
    rows = []
    for x in recs:
        R = per_seed(x["meta"]); opts = [o for o in x["meta"]["options"] if o in R]
        K = max((k for o in opts for k in R[o]), default=0)
        ks = [k for k in range(1, K + 1) if all(k in R[o] for o in opts)]
        if len(ks) >= 2: rows.append({o: [R[o][k][0] for k in ks] for o in opts})
    opts = sorted({o for r in rows for o in r})
    mean_u = {o: st.mean(st.mean(r[o]) for r in rows if o in r) for o in opts}
    b = base or max(mean_u, key=mean_u.get)
    out = {"decisions": len(rows), "base": b, "mean_u": {o: round(v, 3) for o, v in mean_u.items()}, "vs_base": {}}
    for o in opts:
        if o == b: continue
        d, s2 = [], []
        for r in rows:
            if o not in r or b not in r: continue
            diff = [x - y for x, y in zip(r[o], r[b])]
            d.append(st.mean(diff)); s2.append(st.variance(diff) / len(diff))
        vd = st.pvariance(d); tau2 = max(0.0, vd - st.mean(s2)); mu = st.mean(d); tau = tau2 ** 0.5
        if tau > 0:
            z = mu / tau
            emax = mu * 0.5 * (1 + math.erf(z / 2 ** 0.5)) + tau * math.exp(-z * z / 2) / (2 * math.pi) ** 0.5
        else: emax = max(mu, 0.0)
        out["vs_base"][o] = {"n": len(d), "mean": round(mu, 3), "true_sd": round(tau, 3),
                             "reliability": round(tau2 / vd, 3) if vd else None,
                             "perfect_reader_gain": round(emax - max(mu, 0.0), 3),
                             "flat_share": round(sum(abs(x) < 1e-9 for x in d) / len(d), 3)}
    return out


def _play_game(path):
    try:
        summ = json.load(open(os.path.join(path, "busho-play-report.json")))["summary"]
        rows = []
        with gzip.open(os.path.join(path, "danger.jsonl.gz"), "rt") as f:
            for ln in f:
                r = json.loads(ln)
                if "a" in r: rows.append((r["a"], r["t"], r["d"], r["hp"], r.get("cl")))
    except Exception:
        return None
    return {"dead": bool(summ.get("dead")), "rows": rows}


def aligned(stage_dir, arms=None, horizons=(500, 1000, 2000, 4000)):
    """Fable's aligned-play canary (2026-11-11): score a paired screen's games with label utilities from the first
    action where an arm's game leaves its base game (one action earlier), to each horizon and to the game's end.
    Utilities per window: "label" max(0, dmax - depth at start) - 3 if dead (the rollout labels' u); "deepest"
    max(0, dmax - deepest level so far) - 3 if dead (progress on PH's clock). A label utility at horizon H is
    calibrated on a screen when its sign agrees with "deepest" to the game's end."""
    arms = arms or sorted(a for a in os.listdir(stage_dir) if a != "base" and os.path.isdir(os.path.join(stage_dir, a)))
    base, out = {}, {}
    for arm in arms:
        adir = os.path.join(stage_dir, arm); pairs = []; n = same = 0
        for gid in sorted(os.listdir(adir)):
            if gid not in base: base[gid] = _play_game(os.path.join(stage_dir, "base", gid))
            b, v = base[gid], _play_game(os.path.join(adir, gid))
            if not b or not v or not b["rows"] or not v["rows"]: continue
            n += 1
            m = min(len(b["rows"]), len(v["rows"]))
            i = next((k for k in range(m) if b["rows"][k] != v["rows"][k]), None)
            if i is None and len(b["rows"]) == len(v["rows"]): same += 1; continue
            pairs.append((b, v, max(0, (i if i is not None else m) - 1)))

        def win(g, i0, H):
            rows = g["rows"]; d0 = rows[i0][2]; deep0 = max(r[2] for r in rows[: i0 + 1])
            end = len(rows) if H is None else min(len(rows), i0 + H)
            dmax = max(r[2] for r in rows[i0:end]); dead = g["dead"] and end >= len(rows)
            return max(0, dmax - d0) - 3 * dead, max(0, dmax - deep0) - 3 * dead, dead
        res = {}
        for H in list(horizons) + [None]:
            lab, dee, dd = [], [], []
            for b, v, i0 in pairs:
                wb, wv = win(b, i0, H), win(v, i0, H)
                lab.append(wv[0] - wb[0]); dee.append(wv[1] - wb[1]); dd.append(wv[2] - wb[2])
            se = lambda x: round(st.pstdev(x) / len(x) ** 0.5, 3) if len(x) > 1 else None  # noqa: E731
            res["end" if H is None else str(H)] = {"label": round(st.mean(lab), 3) if lab else None, "label_se": se(lab),
                                                   "deepest": round(st.mean(dee), 3) if dee else None, "deepest_se": se(dee),
                                                   "dead_diff": round(st.mean(dd), 3) if dd else None}
        out[arm] = {"pairs": n, "identical": same, "diverge": len(pairs), "by_horizon": res}
    return out


def agree(short, long_):
    L = {key(r): r for r in long_}
    hit = n = 0; reg = []
    for s in short:
        l = L.get(key(s))
        if not l or not s["meta"].get("u_mean") or not l["meta"].get("u_mean"): continue
        rc = l["meta"]["rules_choice"]
        ps, pl = pick(s["meta"]["u_mean"], rc), pick(l["meta"]["u_mean"], rc)
        n += 1; hit += ps == pl
        ul = l["meta"]["u_mean"]; reg.append(max(ul.values()) - ul.get(ps, min(ul.values())))
    return {"pairs": n, "same_pick": round(hit / max(1, n), 3), "long_regret_of_short_pick": round(st.mean(reg), 4) if reg else None}


def score(long_, answers, vs=None, clusters=None, boots=2000):
    """vs: an answers file to compare each decider with (paired, per decision); clusters: {game_id: lineage} for a
    bootstrap over lineages (default: over decisions). Reports diff_vs mean and 80%/95% intervals."""
    import random
    L = {key(r): r for r in long_}
    out = {}
    def u_of(path):
        ans = {(a["game_id"], a["turn"]): a.get("choice") for a in load(path)}
        res = {}
        for k, r in L.items():
            u = r["meta"].get("u_mean")
            if not u: continue
            c = ans.get(k)
            if c not in u: c = r["meta"]["rules_choice"]
            res[k] = u[c]
        return res
    base_u = u_of(vs) if vs else None
    base_reg = []
    for r in long_:
        u = r["meta"].get("u_mean")
        if u: base_reg.append(max(u.values()) - u.get(r["meta"]["rules_choice"], min(u.values())))
    out["rules"] = {"n": len(base_reg), "regret": round(st.mean(base_reg), 4)}
    for path in answers:
        ans = {(a["game_id"], a["turn"]): a.get("choice") for a in load(path)}
        reg, hit, gain, n, miss = [], 0, [], 0, 0
        for k, r in L.items():
            u = r["meta"].get("u_mean")
            if not u: continue
            c = ans.get(k)
            if c not in u: miss += 1; c = r["meta"]["rules_choice"]  # unanswered: falls back to the rules
            n += 1; hit += c == pick(u, r["meta"]["rules_choice"])
            reg.append(max(u.values()) - u[c]); gain.append(u[c] - u.get(r["meta"]["rules_choice"], u[c]))
        out[os.path.basename(path)] = {"n": n, "fallbacks": miss, "agree_with_pick": round(hit / max(1, n), 3),
                                       "regret": round(st.mean(reg), 4) if reg else None,
                                       "gain_over_rules": round(st.mean(gain), 4) if gain else None}
        if base_u is not None:
            mine = u_of(path)
            groups = {}
            for k in mine:
                if k in base_u: groups.setdefault((clusters or {}).get(k[0], k), []).append(mine[k] - base_u[k])
            g = list(groups.values()); rng = random.Random(0); tot = sum(len(v) for v in g)
            if not g: continue
            bs = []
            for _ in range(boots):
                smp = [g[rng.randrange(len(g))] for _ in g]
                bs.append(sum(map(sum, smp)) / max(1, sum(map(len, smp))))
            bs.sort(); q = lambda p: round(bs[int(p * (len(bs) - 1))], 4)  # noqa: E731
            out[os.path.basename(path)]["vs_" + os.path.basename(vs)] = {
                "diff": round(sum(map(sum, g)) / tot, 4), "ci80": [q(0.1), q(0.9)], "ci95": [q(0.025), q(0.975)],
                "clusters": len(g)}
    return out


FEATURES = ["hp_frac", "mhp", "dl_minus_cl", "dl", "speed", "nearest_remembered", "n_visible", "n_within_7",
            "on_stairs", "poisoned", "cut", "stun", "confused", "blind", "afraid", "paralyzed", "slow", "fast",
            "CLW", "CSW", "CCW", "PhaseDoor", "Teleportation", "Oil", "WoR", "NeutralizePoison", "food", "ammo"]


_CACHE = __import__("collections").OrderedDict()  # (run, game) -> (turns, records); a few games only (a full
_CACHE_MAX = 4                                      # collection's danger logs are ~6 GB in memory): callers sort by game


def features(run, game, turn):
    """Danger-log features at the decision (the record nearest the turn) for a collection game."""
    k = (run, game)
    if k in _CACHE: _CACHE.move_to_end(k)
    else:
        p = os.path.join(run, "games", game, "danger.jsonl.gz")
        recs = [r for r in (json.loads(l) for l in gzip.open(p, "rt")) if "t" in r and "tm" in r] if os.path.exists(p) else []
        _CACHE[k] = ([r["t"] for r in recs], recs)
        while len(_CACHE) > _CACHE_MAX: _CACHE.popitem(last=False)
    ts, recs = _CACHE[k]
    if not recs: return None
    return feature_vector(recs[min(bisect.bisect_left(ts, turn), len(recs) - 1)])


def feature_vector(x):
    """FEATURES from one danger record (tools/danger/record.ts; also what busho sends a feature policy in play)."""
    ms = x.get("m", [])
    near = [m for m in ms if m[1] <= 7]
    return [x["hp"] / max(1, x["mhp"]), x["mhp"], x["d"] - x["cl"], x["d"], x["spd"], x.get("rd", -1), len(ms), len(near),
            x.get("os", 0), *x["tm"], *x["inv"]]


def trees(train, long_, run, seldir, out, long_run=None, long_seldir=None):
    import lightgbm as lgb, numpy as np  # noqa: E401
    long_run, long_seldir = long_run or run, long_seldir or seldir  # LONG from another collection (M2: train ≠ check)
    src, lsrc = {}, {}
    for f in ("check.jsonl", "train.jsonl"):
        for r in load(os.path.join(seldir, f)): src[r["game_id"]] = r["src_game"]
        for r in load(os.path.join(long_seldir, f)): lsrc[r["game_id"]] = r["src_game"]
    opts = sorted({o for r in train for o in r["meta"].get("u_mean", {})})
    X, Y = {o: [] for o in opts}, {o: [] for o in opts}
    target = os.environ.get("TREES_TARGET", "u")  # "share": Laya's targets (the gold win shares) in place of u_mean
    train = sorted(train, key=lambda r: (src.get(r["meta"]["game_id"]) or "", r["meta"]["turn"]))  # cache by game
    long_ = sorted(long_, key=lambda r: (lsrc.get(r["meta"]["game_id"]) or "", r["meta"]["turn"]))
    for r in train:
        u = r["meta"].get("u_mean")
        if target == "share" and u: u = {o: r["gold"]["decision"]["probabilities"].get(o, 0.0) for o in u}
        g = src.get(r["meta"]["game_id"])
        f = u and g and features(run, g, r["meta"]["turn"])
        if not f: continue
        for o, v in u.items(): X[o].append(f); Y[o].append(v)
    models = {}
    P = dict(objective="regression", learning_rate=0.05, num_leaves=15, min_data_in_leaf=40, verbose=-1, seed=0)
    for o in opts:
        if len(Y[o]) >= 50: models[o] = lgb.train(P, lgb.Dataset(np.array(X[o], float), np.array(Y[o], float)), 200)
    with open(out, "w") as fh:
        for r in long_:
            m = r["meta"]; g = lsrc.get(m["game_id"]); f = g and features(long_run, g, m["turn"])
            avail = [o for o in m["options"] if o in models]
            if not f or not avail: continue
            pred = {o: float(models[o].predict(np.array([f], float))[0]) for o in avail}
            fh.write(json.dumps({"game_id": m["game_id"], "turn": m["turn"], "choice": max(pred, key=pred.get), "pred": pred}) + "\n")
    imp = {}
    for o, mdl in models.items():
        for name, v in zip(FEATURES, mdl.feature_importance("gain")): imp[name] = imp.get(name, 0.0) + float(v)
    tot = sum(imp.values()) or 1.0
    top = sorted(imp.items(), key=lambda kv: -kv[1])[:10]
    return {"trained_on": {o: len(Y[o]) for o in opts}, "models": list(models), "target": target,
            "importance_top10": {k: round(v / tot, 3) for k, v in top}}


def main():
    a = sys.argv[1:]
    if not a: sys.exit(__doc__)
    if a[0] == "headroom": print(json.dumps(headroom(load(a[1])), indent=1))
    elif a[0] == "agree": print(json.dumps(agree(load(a[1]), load(a[2])), indent=1))
    elif a[0] == "score":
        vs = cl = None; files = []
        it = iter(a[2:])
        for x in it:
            if x == "--vs": vs = next(it)
            elif x == "--clusters": cl = json.load(open(next(it)))
            else: files.append(x)
        print(json.dumps(score(load(a[1]), files, vs, cl), indent=1))
    elif a[0] == "aligned": print(json.dumps(aligned(a[1], a[2].split(",") if len(a) > 2 else None), indent=1))
    elif a[0] == "splits": print(json.dumps(headroom_splits(load(a[1])), indent=1))
    elif a[0] == "ceiling": print(json.dumps(ceiling(load(a[1]), a[2] if len(a) > 2 else None), indent=1))
    elif a[0] == "trees": print(json.dumps(trees(load(a[1]), load(a[2]), a[3], a[4], a[5], *a[6:8]), indent=1))
    else: sys.exit(__doc__)


if __name__ == "__main__":
    main()
