#!/usr/bin/env python3
"""Session 5 (~8 h): honest play on C Angband 4.2.6 (main-http front end), the first C-engine session.

See docs/finetune-laya-plan.md, "Session 5". Everything sees only what the UI shows (PLAYER_VIEW=1). The C game
(binary + lib) is frozen into RUN/src/c-game at start. Stages:
  collectE  the honest rules player on C, decisions logged in format v3 (fresh starts; the run's own C bank fills
            as it goes, since TS savepoints can't load in C);
  labelE    rollouts on C (a C process per run from the snapshot), honest rules continuation, utility v2;
  trainE    laya from the base model on session 4's clean labelD (TS) plus labelE (C), 4 epochs;
  finalE    tournament: rules, rules+ (caution +1, confirming session 4's finding) and E-gate (trainE, oil/potion
            guards, acting only at confidence >= 0.3, now the default per session 4's gating rule).
Resumable via RUN/state.json; `touch RUN/STOP` stops between games. Never restart it mid-stage.

Usage: driver5.py --run runs/session5/<name> --prior runs/session4/2026-10-15 [--hours 8] [--smoke] [--slots 13]
"""
import argparse, collections, concurrent.futures as cf, json, os, random, re, signal, sys, threading, time  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import driver3 as D3  # noqa: E402
import evaluate  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
STAGES = [("collectE", "collect", 0.75), ("labelE", "label", 3.0), ("trainE", "train", 0.75), ("finalE", "tournament", 3.0)]
SMOKE_MINUTES = {"tournament": 10, "collect": 5, "label": 8, "train": 20}
D.SCHEDULE = [(n, h) for n, _, h in STAGES]
GATE = "0.3"
HONEST = {"PLAYER_VIEW": "1"}


# ── arms ──
def final_arms(run):
    t = run.state["stages"].get("trainE", {})
    ck = t.get("result", {}).get("ckpt") if t.get("status") == "done" else None
    arms = [{"name": "rules", "ckpt": None, "guard": ""},
            {"name": "rules+", "ckpt": None, "guard": "", "caution": 1.0}]
    if ck: arms.append({"name": "E-gate", "ckpt": ck, "guard": "oil,potion", "min_conf": GATE})
    return arms


def arm_env(arm, names, bank=False):
    e = {**D3.arm_env(arm, names, bank), **HONEST}
    if arm.get("min_conf"): e["DECISION_MIN_CONFIDENCE"] = arm["min_conf"]
    return e


# ── stages ──
def stage_collect(run, name, deadline):
    games_dir = run.d(name, "games", "x")[:-2]
    bank = run.d("bank", "x")[:-2]
    pool = D2.bank_files(run)  # C savepoints only: empty at first in this era
    rng = random.Random(name)

    def jobs():
        for i in range(100000):
            if pool and i % 5 in (1, 3): yield (800000 + i, "random", rng.choice(pool))
            else: yield (800000 + i, D.CLASSES[i % len(D.CLASSES)])

    env = {**D2.rules_env(), **HONEST, "SAVEPOINT_DIR": "/bank"}
    cap, maxa = (240, 1500) if run.smoke else (1500, 30000)
    outcomes = D.run_games(run, name, jobs(), run.slots, deadline, lambda s, c: env, cap, maxa, games_dir, 4100, bank)
    gdirs = [os.path.join(games_dir, g) for g in os.listdir(games_dir)]
    sums = [D2.game_summary(g) for g in gdirs]
    recs = [r for s in sums for r in s["decisions"]]
    by_type = collections.Counter(r["decision_type"] for r in recs)
    fmt = collections.Counter(r.get("format_version") for r in recs)
    stalls = sum(open(os.path.join(g, "player.log"), errors="replace").read().count("停滞リセット")
                 for g in gdirs if os.path.exists(os.path.join(g, "player.log")))
    causes = collections.Counter(o.get("death_cause") for o in outcomes if o.get("dead"))
    res = {"policy": "honest rules, C engine", "games": len(outcomes),
           "bank_games": sum(bool(o.get("restore")) for o in outcomes),
           "errors": sum("error" in o for o in outcomes), "decisions": sum(by_type.values()), "by_type": dict(by_type),
           "format_versions": {str(k): v for k, v in fmt.items()}, "stall_resets": stalls,
           "deaths": sum(o.get("dead", False) for o in outcomes), "top_killers": causes.most_common(8),
           "max_depth": max((o.get("max_depth", 0) for o in outcomes), default=0),
           "bank_size": len(D2.bank_files(run))}
    res["canary"] = D2.canary(res, [("errors <= 10%", res["errors"] <= 0.1 * max(1, res["games"])),
                                    ("every decision is format v3", set(fmt) == {3}),
                                    ("trained-type decisions >= 500", run.smoke or sum(by_type[t] for t in ("fight", "tactic")) >= 500)])
    return res


def stage_label(run, name, deadline):
    dec = run.d(name, "decisions.jsonl")
    n = D.merge_decisions(run, ["collectE"], dec)
    out = run.d(name, "labels.jsonl")
    # C: run.ts starts a C game per rollout on the worker's port; no long-lived servers
    urls = [f"http://127.0.0.1:{4300 + i + D.PORT_OFFSET}" for i in range(run.slots)]
    script = ["tools/rollout/run.ts", "--decisions", dec, "--dir", run.path, "--out", out, "--servers", ",".join(urls),
              "--workers", str(run.slots), "--types", D2.MODEL_TYPES, "--k", "4" if run.smoke else "8", "--k-min", "4",
              "--order", "danger", "--utility", "v2"]
    if run.smoke: script += ["--max-records", "40"]
    env = {"BUSHO_TMP": run.d(name, "tmp", "x")[:-2], "ANGBAND_C": D.C_BIN, **HONEST}
    text, timed_out = D.run_node(run, f"ovn-{name}-orch", script, env, max(60, int(deadline - time.time())), heap_mb=0)
    open(run.d(name, "orchestrator.tail.log"), "w").write(("stopped at deadline\n" if timed_out else "") + text[-3000:])
    labels = [json.loads(l) for l in open(out)] if os.path.exists(out) else []
    noise = D.run_node(run, f"ovn-{name}-noise", ["tools/rollout/noise.ts", out], {}, 600, heap_mb=0)[0][-2000:] if labels else ""
    open(run.d(name, "noise.txt"), "w").write(noise)
    agree = [float(x) for x in re.findall(r"split-half agreement=([\d.]+)%", noise)]
    runs_err = sum(sum(r["meta"].get("runs_error", {}).values()) for r in labels)
    runs_all = sum(sum(r["meta"].get("runs_fired", {}).values()) for r in labels) or 1
    ties = sum(bool(r["meta"].get("all_tie")) for r in labels)
    stats = run.d(name, "labels.stats.json")
    res = {"decisions": n, "labels": len(labels), "by_type": dict(collections.Counter(r["meta"]["decision_type"] for r in labels)),
           "all_tie": ties, "run_error_rate": round(runs_err / runs_all, 4), "split_half": agree,
           "noise": noise.strip().splitlines()[-6:],
           "missing_cost_keys": json.load(open(stats)).get("missing_cost_keys", [])[:20] if os.path.exists(stats) else None}
    res["canary"] = D2.canary(res, [("labels > 0", len(labels) > 0),
                                    ("labels >= 300", run.smoke or len(labels) >= 300),
                                    ("split-half >= 65%", all(a >= 65 for a in agree) if agree else run.smoke),
                                    ("all-tie <= 25%", run.smoke or ties <= 0.25 * max(1, len(labels))),
                                    ("run errors <= 2%", runs_err <= 0.02 * runs_all)])
    if not res.get("failed"): run.state["labelsE"] = out
    return res


def stage_train(run, name, deadline):
    """laya from the base model on labelD (session 4, clean lines only) + labelE. Each record is tagged with its
    source; held-out accuracy is also reported on the C (labelE) part alone."""
    src_e = run.state.get("labelsE")
    if not src_e: return {"skipped": "no labelE labels"}
    src_d = os.path.join(run.prior, "labelD", "labels.jsonl")
    combined = run.d(name, "labels.combined.jsonl")
    counts = collections.Counter()
    with open(combined, "w") as f:
        for tag, path in (("labelD", src_d), ("labelE", src_e)):
            if not os.path.exists(path): continue
            for line in open(path):
                r = json.loads(line)
                r["meta"]["source"] = tag
                f.write(json.dumps(r) + "\n"); counts[tag] += 1
    run.state["labels"] = combined
    res = D2.stage_train(run, name, deadline)
    run.state.pop("incumbent", None)
    res["sources"] = dict(counts)
    held = run.d(name, "data", "heldout.jsonl")
    if "ckpt" in res and os.path.exists(held):
        held_e = run.d(name, "data", "heldout.labelE.jsonl")
        n = 0
        with open(held_e, "w") as f:
            for line in open(held):
                if json.loads(line)["meta"].get("source") == "labelE": f.write(line); n += 1
        m = run.d(name, "offline.labelE.json")
        if n:
            import subprocess
            subprocess.run([sys.executable, "-I", os.path.join(D2.HERE, "evaluate.py"), "--heldout", held_e,
                            "--train", run.d(name, "data", "train.jsonl"), "--ckpt", res["ckpt"], "--out", m])
            if os.path.exists(m):
                off = json.load(open(m))
                res["heldout_labelE"] = {"n": n, "acc": {k: off[k]["all"]["acc"] for k in ("model", "majority", "rules", "base") if k in off}}
    return res


def stage_tournament(run, name, deadline):
    arms = final_arms(run)
    n_fresh, n_bank = (2, 1) if run.smoke else (144, 48)
    fresh_base, bank_base = 2500000, 2550000
    pool = D2.bank_files(run)
    rng = random.Random(name)
    starts = []
    for i in range(max(n_fresh, n_bank)):
        if i < n_fresh: starts.append({"id": f"{fresh_base + i}-{D.CLASSES[i % len(D.CLASSES)]}", "seed": fresh_base + i,
                                       "cls": D.CLASSES[i % len(D.CLASSES)], "restore": None})
        if i < n_bank and pool: starts.append({"id": f"{bank_base + i}-bank", "seed": bank_base + i, "cls": "random",
                                               "restore": rng.choice(pool)})
    jobs = iter([(s, a) for s in starts for a in arms])
    names = D3.model_names(arms)
    lock, outcomes = threading.Lock(), collections.defaultdict(dict)
    caps = {"fresh": (240, 1500) if run.smoke else (900, 20000), "bank": (240, 1500) if run.smoke else (600, 15000)}

    def worker(slot):
        while not run.stopped() and time.time() < deadline:
            if slot >= D.THROTTLED_SLOTS and os.path.exists(os.path.join(run.path, "THROTTLE")):
                time.sleep(30); continue
            with lock: job = next(jobs, None)
            if job is None: return
            s, a = job
            cap, maxa = caps["bank" if s["restore"] else "fresh"]
            cap_now = max(60, min(cap, deadline - time.time()))
            res = D.play_game(run, f"{name}-{a['name']}", slot, s["seed"], s["cls"], arm_env(a, names),
                              os.path.join(run.path, name, a["name"], s["id"]), cap_now, maxa, 4100, None, s["restore"])
            res["cut"] = bool(res.get("timed_out") and res.get("seconds", 0) < cap - 30)
            with lock: outcomes[a["name"]][s["id"]] = res
            run.log(f"{name}-{a['name']}: {s['id']}: {res}")

    with D3.MultiLaya(names, run.d(name, "laya.log")):
        with cf.ThreadPoolExecutor(run.slots) as ex:
            list(ex.map(worker, range(run.slots)))
    for a in arms: D.rm_containers(f"ovn-{name}-{a['name']}-")

    ok = lambda o: o and "error" not in o and not o["cut"]  # noqa: E731
    complete = [s for s in starts if all(ok(outcomes[a["name"]].get(s["id"])) for a in arms)]
    res = {"arms": arms, "starts_planned": len(starts), "starts_complete": len(complete),
           "deadline_cut": {a["name"]: sum(1 for o in outcomes[a["name"]].values() if o.get("cut")) for a in arms},
           "errors": {a["name"]: sum(1 for o in outcomes[a["name"]].values() if "error" in o) for a in arms}, "vs_rules": {}}
    gd = lambda a, s: os.path.join(run.path, name, a, s["id"])  # noqa: E731
    checks = [("starts complete >= 75% of planned", len(complete) >= 0.75 * len(starts))]
    for a in arms:
        info = {}
        if a["name"] != "rules":
            info["identical_to_rules"] = sum(D2.game_summary(gd(a["name"], s))["fingerprint"] == D2.game_summary(gd("rules", s))["fingerprint"]
                                             for s in complete)
        if a["ckpt"]:
            ratio, n, guards = D3.consult_stats([gd(a["name"], s) for s in complete])
            thr = max((D2.game_summary(gd(a["name"], s))["throws"] for s in complete), default=0)
            info.update(consulted=ratio, trained_type_decisions=n, guards=guards, max_throws=thr)
            checks += [(f"{a['name']}: consulted >= 0.9", ratio is not None and ratio >= 0.9),
                       (f"{a['name']}: max throws <= 100", thr <= 100)]
        if a["name"] != "rules":
            for subset, sel in (("all", complete), ("fresh", [s for s in complete if not s["restore"]]),
                                ("bank", [s for s in complete if s["restore"]])):
                r = {s["id"]: outcomes["rules"][s["id"]] for s in sel}
                m = {s["id"]: outcomes[a["name"]][s["id"]] for s in sel}
                info[subset] = D2.paired_test(r, m)
                info[subset]["robust"] = D3.robustness(r, m)
            info["sign_p"] = D3.sign_p(info["all"]["wins"], info["all"]["losses"])
        else:
            info["deaths"] = sum(outcomes["rules"][s["id"]]["dead"] for s in complete)
            info["top_killers"] = collections.Counter(outcomes["rules"][s["id"]].get("death_cause") for s in complete
                                                      if outcomes["rules"][s["id"]]["dead"]).most_common(8)
        res["vs_rules"][a["name"]] = info

    present = {a["name"] for a in arms}
    if {"rules+", "E-gate"} <= present:  # the model must also beat the best rules setting
        b = {s["id"]: outcomes["rules+"][s["id"]] for s in complete}
        o = {s["id"]: outcomes["E-gate"][s["id"]] for s in complete}
        t = D2.paired_test(b, o)
        t["sign_p"] = D3.sign_p(t["wins"], t["losses"])
        t["robust"] = D3.robustness(b, o)
        res["Egate_vs_rulesplus"] = t
    res["canary"] = D2.canary(res, checks)
    return res


KINDS = {"tournament": stage_tournament, "collect": stage_collect, "label": stage_label, "train": stage_train}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--prior", required=True)
    ap.add_argument("--hours", type=float, default=8); ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--slots", type=int, default=13)
    a = ap.parse_args()
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior = os.path.abspath(a.prior)
    signal.signal(signal.SIGTERM, lambda *_: D.STOP.set())
    app = D.app_dir(run)  # first: freezing the source recreates RUN/src
    cbin = D.freeze_c(run)
    run.log(f"driver5 start (smoke={a.smoke}, slots={a.slots}, engine={D.ENGINE}, c_bin={cbin}, "
            f"port_offset={D.PORT_OFFSET}); prior={run.prior}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    try:
        for name, kind, hours in STAGES:
            prev = run.state["stages"].get(name) or {}
            if prev.get("status") in ("done", "skipped", "failed"): continue
            if run.stopped(): run.log("stopping: STOP file, signal or global deadline"); break
            budget = SMOKE_MINUTES[kind] * 60 if a.smoke else hours * 3600
            deadline = min(time.time() + budget, run.state["deadline"])
            run.state["stages"][name] = {"status": "running", "began": time.time()}
            run.save(); D.write_report(run)
            run.log(f"stage {name} begins (budget {budget / 3600:.2f} h)")
            try:
                res = KINDS[kind](run, name, deadline)
                status = "skipped" if "skipped" in res else ("failed" if "failed" in res else "done")
                run.state["stages"][name].update(status=status, result=res, ended=time.time())
                run.log(f"stage {name} {status}: {json.dumps(res)[:1500]}")
            except Exception as e:
                import traceback
                run.state["stages"][name].update(status="error", error=f"{type(e).__name__}: {e}", ended=time.time(),
                                                 trace=traceback.format_exc()[-2000:])
                run.log(f"stage {name} error: {e}")
            run.save(); D.write_report(run)
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        D.write_report(run)
        run.log("driver5 finished")


if __name__ == "__main__":
    main()
