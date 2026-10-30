#!/usr/bin/env python3
"""Session 9 (~5 h): which of trainG's overrides are right? Labels from the model's own games.

See docs/finetune-laya-plan.md, "Session 9". Honest view (PLAYER_VIEW=1), C engine. CPU only:
  labelH   rollout labels (K = 8, adaptive from 4, utility v2, horizons fight 150 / tactic 50) on fight/tactic
           decisions from session 8's G-cool games: the states trainG's own play reaches. Records where trainG
           disagreed with the rules (acted, or blocked by the cooldown; not those its guards blocked) and records
           where it agreed come 3 to 1, each shuffled with a fixed seed. The rollout continuation is rules+
           (RULES_CAUTION=1), the player the overrides have to beat.
  reportH  per record, the label's mean utility of trainG's choice minus the rules' choice: by pair, type,
           acted/cooldown/gate and confidence. A gate (allowed pairs, confidence threshold) is chosen on one half of the
           games and scored on the other half.
Resumable via RUN/state.json; `touch RUN/STOP` stops between stages. Never restart it mid-stage.

Usage: driver9.py --run runs/session9/<name> --prior8 runs/session8/2026-10-20 [--hours 5] [--smoke] [--slots 13]
"""
import argparse, collections, hashlib, json, os, random, re, signal, sys, threading, time  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import driver3 as D3  # noqa: E402
import driver5 as D5  # noqa: E402
import driver6 as D6  # noqa: E402
import evaluate  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
D.SCHEDULE = [("labelH", 4.75), ("reportH", 0.25)]
SMOKE_MINUTES = {"labelH": 8, "reportH": 2}
ARM = "G-cool"
TYPES = ("fight", "tactic")
CONF_BINS = (0.0, 0.02, 0.05, 0.1, 0.2)  # trainG's confidence on its overrides: median 0.055, 90th percentile 0.2
MIN_PAIR_N = 30


def key(r): return (r["game_id"], r["turn"], r["decision_type"])


def disagrees(r): return bool(r.get("model_choice") and r.get("rules_choice") and r["model_choice"] != r["rules_choice"])


def pool(run):
    """trainG's fight/tactic decisions from session 8, snapshot paths relative to the session 8 run. Written once."""
    dec = run.d("labelH", "decisions.jsonl")
    if not os.path.exists(dec):
        run.state["labelH_pool"] = build_pool(run.prior8, os.path.join("finalH", ARM), dec, "labelH", run.smoke); run.save()
    return dec


def build_pool(base, rel, dec, seed, smoke):
    """The fight/tactic decisions of the games in base/rel (one per game, turn and type), snapshot paths relative to
    base: disagree and agree 3 to 1, each shuffled with a fixed seed."""
    root = os.path.join(base, rel)
    dis, agr, seen = [], [], set()
    for g in sorted(os.listdir(root)):
        f = os.path.join(root, g, "decisions.jsonl")
        if not os.path.exists(f): continue
        for line in open(f):
            r = json.loads(line)
            if r.get("decision_type") not in TYPES or not r.get("snapshot") or key(r) in seen: continue
            if r.get("guard"): continue  # the model's choice was impossible (no oil, no potion), so never played
            seen.add(key(r))
            r["snapshot"] = os.path.join(rel, g, r["snapshot"])
            (dis if disagrees(r) else agr).append(r)
    rng = random.Random(seed)
    rng.shuffle(dis); rng.shuffle(agr)
    order, ai = [], 0
    for i, r in enumerate(dis):
        order.append(r)
        if i % 3 == 2 and ai < len(agr): order.append(agr[ai]); ai += 1
    order += agr[ai:]
    if smoke: order = order[:24]
    with open(dec + ".tmp", "w") as f:
        for r in order: f.write(json.dumps(r) + "\n")
    os.replace(dec + ".tmp", dec)
    return {"records": len(order), "disagree": len(dis), "agree": len(agr)}


# ── CPU ──
def stage_label(run, name, deadline):
    return label(run, name, pool(run), run.prior8, deadline)


def label(run, name, dec, base, deadline):
    """Rollout labels for the records in dec (snapshots relative to base), rules+ continuing."""
    out = run.d(name, "labels.jsonl")
    urls = [f"http://127.0.0.1:{4300 + i + D.PORT_OFFSET}" for i in range(run.slots)]
    script = ["tools/rollout/run.ts", "--decisions", dec, "--dir", base, "--out", out, "--servers", ",".join(urls),
              "--workers", str(run.slots), "--types", ",".join(TYPES), "--k", "8", "--k-min", "4", "--order", "file",
              "--utility", "v2"]
    env = {"BUSHO_TMP": run.d(name, "tmp", "x")[:-2], "ANGBAND_C": D.C_BIN, "RULES_CAUTION": "1", **D5.HONEST}
    text, timed_out = D.run_node(run, f"ovn-{name}-orch", script, env, max(60, int(deadline - time.time())), heap_mb=0)
    open(run.d(name, "orchestrator.tail.log"), "w").write(("stopped at deadline\n" if timed_out else "") + text[-3000:])
    lines = open(out).read().split("\n")[:-1] if os.path.exists(out) else []  # drop a partial last line
    labels = [json.loads(l) for l in lines]
    noise = D.run_node(run, f"ovn-{name}-noise", ["tools/rollout/noise.ts", out], {}, 600, heap_mb=0)[0][-2000:] if labels else ""
    open(run.d(name, "noise.txt"), "w").write(noise)
    agree = [float(x) for x in re.findall(r"split-half agreement=([\d.]+)%", noise)]
    runs_err = sum(sum(r["meta"].get("runs_error", {}).values()) for r in labels)
    runs_all = sum(sum(r["meta"].get("runs_fired", {}).values()) for r in labels) or 1
    ties = sum(bool(r["meta"].get("all_tie")) for r in labels)
    res = {"labels": len(labels), "by_type": dict(collections.Counter(r["meta"]["decision_type"] for r in labels)),
           "disagree": sum(disagrees(r["meta"]) for r in labels), "all_tie": ties,
           "run_error_rate": round(runs_err / runs_all, 4), "split_half": agree, "noise": noise.strip().splitlines()[-6:]}
    res["canary"] = D2.canary(res, [("labels > 0", len(labels) > 0),
                                    ("labels >= 300", run.smoke or len(labels) >= 300),
                                    ("split-half >= 65%", all(a >= 65 for a in agree) if agree else run.smoke),
                                    ("all-tie <= 25%", run.smoke or ties <= 0.25 * max(1, len(labels))),
                                    ("run errors <= 2%", runs_err <= 0.02 * runs_all)])
    return res


def strict(p):
    best = max(p.values())
    top = [o for o, v in p.items() if v >= best - 1e-9]
    return top[0] if len(top) == 1 else None


def tally(rows):
    """rows: per-record utility difference, trainG's choice minus the rules' choice."""
    w = sum(d > 1e-9 for d in rows); l = sum(d < -1e-9 for d in rows)
    return {"n": len(rows), "wins": w, "losses": l, "ties": len(rows) - w - l,
            "mean_diff": round(sum(rows) / len(rows), 4) if rows else None,
            "sign_p": D3.sign_p(w, l), "sign_p_rules": D3.sign_p(l, w)}


def half(game_id): return int(hashlib.sha1(game_id.encode()).hexdigest(), 16) % 2


def status(r):
    """Why the rules acted, or that the model did."""
    return "acted" if r.get("acted") == "model" else "cooldown" if r.get("ration") == "cooldown" else "gate"


def stage_report(run, name, deadline):
    lab = run.d("labelH", "labels.jsonl")
    if not os.path.exists(lab) or not os.path.getsize(lab): return {"skipped": "no labelH labels"}
    res = report(overrides(lab, run.d("labelH", "decisions.jsonl")), run.smoke)
    with open(run.d(name, "report.json"), "w") as f: json.dump(res, f, indent=1)
    return res


def overrides(lab, dec):
    """One row per labelled record (not all-tie): the model's and rules' choices, and for disagreements the label's
    mean utility of the model's choice minus the rules'."""
    raw = {key(r): r for r in map(json.loads, open(dec))}
    rows = []
    for line in open(lab).read().split("\n")[:-1]:
        m = json.loads(line)["meta"]
        r = raw.get((m["game_id"], m["turn"], m["decision_type"]))
        if not r or m.get("all_tie"): continue
        u, mc, rc = m["u_mean"], r.get("model_choice"), r.get("rules_choice")
        win = strict(m["u_mean"])
        rows.append({"game": m["game_id"], "type": m["decision_type"], "model": mc, "rules": rc, "label": win,
                     "conf": r.get("model_confidence") or 0, "status": status(r),
                     "diff": (u[mc] - u[rc]) if disagrees(r) and mc in u and rc in u else None})
    return rows


def report(rows, smoke):
    dis = [x for x in rows if x["diff"] is not None]
    agr = [x for x in rows if x["diff"] is None and x["model"] and x["model"] == x["rules"]]
    by = lambda f, xs: {k: tally([x["diff"] for x in xs if f(x) == k]) for k in sorted({f(x) for x in xs}, key=str)}  # noqa: E731
    bin_of = lambda c: max(b for b in CONF_BINS if c >= b)  # noqa: E731
    res = {"records": len(rows), "disagree": tally([x["diff"] for x in dis]),
           "disagree_label_is": dict(collections.Counter("model" if x["label"] == x["model"] else "rules" if x["label"] == x["rules"]
                                                         else "other" if x["label"] else "tie" for x in dis)),
           "agree_label_is_rules": round(sum(x["label"] == x["rules"] for x in agr) / max(1, len(agr)), 4),
           "agree_n": len(agr),
           "by_pair": by(lambda x: f"{x['model']}>{x['rules']}", dis), "by_type": by(lambda x: x["type"], dis),
           "by_status": by(lambda x: x["status"], dis),
           "by_conf": by(lambda x: bin_of(x["conf"]), dis),
           "conf_at_least": {str(b): tally([x["diff"] for x in dis if x["conf"] >= b]) for b in CONF_BINS}}
    # a gate chosen on half 0 of the games, scored on half 1
    a = [x for x in dis if half(x["game"]) == 0]; b = [x for x in dis if half(x["game"]) == 1]
    pa = by(lambda x: f"{x['model']}>{x['rules']}", a)
    pairs = sorted(p for p, t in pa.items() if t["n"] >= MIN_PAIR_N and t["mean_diff"] > 0)
    inp = [x for x in a if f"{x['model']}>{x['rules']}" in pairs]
    tau = next((t for t in CONF_BINS if (s := [x["diff"] for x in inp if x["conf"] >= t]) and sum(s) / len(s) > 0), None)
    gate = lambda x: f"{x['model']}>{x['rules']}" in pairs and tau is not None and x["conf"] >= tau  # noqa: E731
    res["gate"] = {"pairs": pairs, "min_conf": tau, "chosen_on": tally([x["diff"] for x in a if gate(x)]),
                   "scored_on": tally([x["diff"] for x in b if gate(x)]),
                   "scored_on_share_kept": round(sum(map(gate, b)) / max(1, len(b)), 4)}
    res["canary"] = D2.canary(res, [("disagree records >= 100", smoke or len(dis) >= 100)])
    return res


KINDS = {"labelH": stage_label, "reportH": stage_report}
D6.KINDS.update(KINDS)
D6.SMOKE_MINUTES.update(SMOKE_MINUTES)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--prior8", required=True)
    ap.add_argument("--hours", type=float, default=5); ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--slots", type=int, default=13)
    a = ap.parse_args()
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior8 = os.path.abspath(a.prior8)
    signal.signal(signal.SIGTERM, lambda *_: D.STOP.set())
    app = D.app_dir(run)  # first: freezing the source recreates RUN/src
    cbin = D.freeze_c(run)
    run.log(f"driver9 start (smoke={a.smoke}, slots={a.slots}, engine={D.ENGINE}, c_bin={cbin}, "
            f"port_offset={D.PORT_OFFSET}); prior8={run.prior8}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    end = run.state["deadline"]
    try:
        pool(run)
        D6.run_stage(run, "labelH", end - 15 * 60, a.smoke)
        D6.run_stage(run, "reportH", end, a.smoke)
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        D.write_report(run)
        run.log("driver9 finished")


if __name__ == "__main__":
    main()
