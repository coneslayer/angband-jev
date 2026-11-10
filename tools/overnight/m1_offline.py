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

Usage: m1_offline.py headroom LABELS.jsonl | agree SHORT LONG | score LONG ANSWERS... | trees TRAIN LONG RUN SELDIR OUT
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
            g = max(0, (r.get("dmax") or 0) - m["depth"])
            R.setdefault(o, {})[r["k"]] = (g - (3 if r["dead"] else 0), r["dead"], g)
    return R


def pick(u, rules):
    """The best option by mean u; the rules' choice wins ties."""
    top = max(u.values())
    return rules if u.get(rules, -1e9) >= top - 1e-9 else max(u, key=u.get)


def headroom(recs):
    gains, var_opt, var_tot, by = [], [], [], {}
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
        allu = [R[o][k][0] for o in opts for k in ks]
        var_tot.append(st.pvariance(allu)); var_opt.append(st.pvariance([mean(o, ks) for o in opts]))
        for o in opts:
            b = by.setdefault(o, [0, 0, 0.0])
            b[0] += len(ks); b[1] += sum(R[o][k][1] for k in ks); b[2] += sum(R[o][k][2] for k in ks)
    n = len(gains)
    if not n: return {"decisions": 0}
    sd = st.pstdev(gains) / n ** 0.5
    return {"decisions": n, "heldout_gain": round(st.mean(gains), 4), "se": round(sd, 4),
            "better": sum(g > 0 for g in gains), "worse": sum(g < 0 for g in gains), "same": sum(g == 0 for g in gains),
            "option_variance_share": round(st.mean(var_opt) / max(1e-9, st.mean(var_tot)), 3),
            "by_option": {o: {"n": b[0], "dead": round(b[1] / b[0], 3), "levels": round(b[2] / b[0], 3)} for o, b in by.items()}}


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


def score(long_, answers):
    L = {key(r): r for r in long_}
    out = {}
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
    return out


def features(run, game, turn, cache={}):
    """Danger-log features at the decision (the record nearest the turn) for a collection game."""
    if game not in cache:
        p = os.path.join(run, "games", game, "danger.jsonl.gz")
        recs = [r for r in (json.loads(l) for l in gzip.open(p, "rt")) if "t" in r and "tm" in r] if os.path.exists(p) else []
        cache[game] = ([r["t"] for r in recs], recs)
    ts, recs = cache[game]
    if not recs: return None
    x = recs[min(bisect.bisect_left(ts, turn), len(recs) - 1)]
    ms = x.get("m", [])
    near = [m for m in ms if m[1] <= 7]
    return [x["hp"] / max(1, x["mhp"]), x["mhp"], x["d"] - x["cl"], x["d"], x["spd"], x.get("rd", -1), len(ms), len(near),
            x.get("os", 0), *x["tm"], *x["inv"]]


def trees(train, long_, run, seldir, out):
    import lightgbm as lgb, numpy as np  # noqa: E401
    src = {}
    for f in ("check.jsonl", "train.jsonl"):
        for r in load(os.path.join(seldir, f)): src[r["game_id"]] = r["src_game"]
    opts = sorted({o for r in train for o in r["meta"].get("u_mean", {})})
    X, Y = {o: [] for o in opts}, {o: [] for o in opts}
    for r in train:
        u = r["meta"].get("u_mean")
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
            m = r["meta"]; g = src.get(m["game_id"]); f = g and features(run, g, m["turn"])
            avail = [o for o in m["options"] if o in models]
            if not f or not avail: continue
            pred = {o: float(models[o].predict(np.array([f], float))[0]) for o in avail}
            fh.write(json.dumps({"game_id": m["game_id"], "turn": m["turn"], "choice": max(pred, key=pred.get), "pred": pred}) + "\n")
    return {"trained_on": {o: len(Y[o]) for o in opts}, "models": list(models)}


def main():
    a = sys.argv[1:]
    if not a: sys.exit(__doc__)
    if a[0] == "headroom": print(json.dumps(headroom(load(a[1])), indent=1))
    elif a[0] == "agree": print(json.dumps(agree(load(a[1]), load(a[2])), indent=1))
    elif a[0] == "score": print(json.dumps(score(load(a[1]), a[2:]), indent=1))
    elif a[0] == "trees": print(json.dumps(trees(load(a[1]), load(a[2]), a[3], a[4], a[5]), indent=1))
    else: sys.exit(__doc__)


if __name__ == "__main__":
    main()
