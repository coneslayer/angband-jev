#!/usr/bin/env python3
"""Session 8 (~18 h): is the model's loss in play compounding? A tournament with rationed overrides.

See docs/finetune-laya-plan.md, "Session 8". Honest view (PLAYER_VIEW=1), C engine, rules+ (caution +1) under every
arm. The rollout labels value one override followed by the rules; in play the model overrides at every decision.
MODEL_COOLDOWN makes the player hand control back to the rules for a number of actions after each override.
One stage:
  finalH  tournament until 20 minutes before the end, starts in a fixed order (4 fresh : 1 bank, session 5's bank):
          rules+; E-all (trainE, no gate, as finalF's E00); E-cool (trainE, cooldown = the label horizons, fight 150 /
          tactic 50 actions); E-cool1000 (trainE, 1,000 actions); G-cool (trainG, label-horizon cooldown); and
          rules+-replay on the first 24 starts (determinism canary). Starts complete in every main arm are analysed.
Resumable via RUN/state.json; `touch RUN/STOP` stops between games. Never restart it mid-stage.

Usage: driver8.py --run runs/session8/<name> --prior5 runs/session5/2026-10-16 --prior7 runs/session7/2026-10-17
       [--hours 18] [--smoke] [--slots 13]
"""
import argparse, collections, concurrent.futures as cf, json, os, random, signal, sys, threading, time  # noqa: E401

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
D.SCHEDULE = [("finalH", 17.5)]
SMOKE_MINUTES = {"finalH": 15}
REPLAY_N = 24
N_STARTS = 2000  # more than fit: the stage runs to its deadline and analyses the starts complete in every main arm
LABEL_COOLDOWN = "fight=150,tactic=50"  # the rollout labels' horizons


def arms_for(run):
    e = os.path.join(run.prior5, "trainE", "ckpt-s0.final")
    g = os.path.join(run.prior7, "trainG", "ckpt-e4-s0.final")
    m = {"guard": "oil,potion", "min_conf": "0", "caution": 1.0}
    return [{"name": "rules+", "ckpt": None, "guard": "", "caution": 1.0},
            {"name": "E-all", "ckpt": e, **m},
            {"name": "E-cool", "ckpt": e, **m, "cooldown": LABEL_COOLDOWN},
            {"name": "E-cool1000", "ckpt": e, **m, "cooldown": "1000"},
            {"name": "G-cool", "ckpt": g, **m, "cooldown": LABEL_COOLDOWN},
            {"name": "rules+-replay", "ckpt": None, "guard": "", "caution": 1.0, "replay": True}]


def arm_env(arm, names):
    e = D5.arm_env(arm, names)
    if arm.get("caution"): e["RULES_CAUTION"] = str(arm["caution"])  # D3.arm_env sets it for rules arms only
    if arm.get("cooldown"): e["MODEL_COOLDOWN"] = arm["cooldown"]
    return e


def override_stats(gdirs):
    """How often the model's answer changed the rules' choice, by (model, rules) pair; how often a cooldown blocked one."""
    acted = changed = games = blocked = 0
    pairs, per_game = collections.Counter(), []
    for g in gdirs:
        p, n = os.path.join(g, "decisions.jsonl"), 0
        if not os.path.exists(p): continue
        for line in open(p):
            r = json.loads(line)
            if r.get("ration"): blocked += 1
            if r.get("acted") != "model": continue
            acted += 1
            if r.get("model_choice") != r.get("rules_choice"):
                changed += 1; n += 1; pairs[f"{r.get('model_choice')}>{r.get('rules_choice')}"] += 1
        games += n > 0; per_game.append(n)
    return {"model_acted": acted, "changed_rules_choice": changed, "games_changed": games, "blocked_by_cooldown": blocked,
            "changes_per_game": round(sum(per_game) / max(1, len(per_game)), 1), "pairs": dict(pairs.most_common(8))}


def starts_for(run):
    pool = D2.bank_files(run)
    rng = random.Random("finalH")
    out, nf, nb = [], 0, 0
    for i in range(18 if run.smoke else N_STARTS):
        if i % 5 == 4 and pool:
            out.append({"id": f"{2850000 + nb}-bank", "seed": 2850000 + nb, "cls": "random", "restore": rng.choice(pool)}); nb += 1
        else:
            c = D.CLASSES[nf % len(D.CLASSES)]
            out.append({"id": f"{2800000 + nf}-{c}", "seed": 2800000 + nf, "cls": c, "restore": None}); nf += 1
    return out


def stage_tournament(run, name, deadline):
    arms = arms_for(run)
    starts = starts_for(run)
    replay_n = 2 if run.smoke else REPLAY_N
    jobs = iter([(s, a) for i, s in enumerate(starts) for a in arms if not a.get("replay") or i < replay_n])
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

    main_arms = [a for a in arms if not a.get("replay")]
    ok = lambda o: o and "error" not in o and not o["cut"]  # noqa: E731
    complete = [s for s in starts if all(ok(outcomes[a["name"]].get(s["id"])) for a in main_arms)]
    started = [s for s in starts if any(s["id"] in outcomes[a["name"]] for a in main_arms)]
    gd = lambda a, s: os.path.join(run.path, name, a, s["id"])  # noqa: E731
    fp = lambda a, s: D2.game_summary(gd(a, s))["fingerprint"]  # noqa: E731
    replayed = [s for s in starts[:replay_n] if ok(outcomes["rules+"].get(s["id"])) and ok(outcomes["rules+-replay"].get(s["id"]))]
    same = sum(fp("rules+", s) == fp("rules+-replay", s) for s in replayed)
    res = {"arms": arms, "starts_started": len(started), "starts_complete": len(complete),
           "complete_fresh": sum(1 for s in complete if not s["restore"]), "complete_bank": sum(1 for s in complete if s["restore"]),
           "replay": {"n": len(replayed), "identical": same},
           "deadline_cut": {a["name"]: sum(1 for o in outcomes[a["name"]].values() if o.get("cut")) for a in arms},
           "errors": {a["name"]: sum(1 for o in outcomes[a["name"]].values() if "error" in o) for a in arms},
           "baseline": {}, "vs_rules+": {}, "head_to_head": {}}
    checks = [("complete starts >= 600", run.smoke or len(complete) >= 600),
              ("complete starts >= 75% of started", len(complete) >= 0.75 * max(1, len(started))),
              ("replay identical >= 90%", bool(replayed) and same >= 0.9 * len(replayed))]

    def compare(base, other):
        out = {}
        for subset, sel in (("all", complete), ("fresh", [s for s in complete if not s["restore"]]),
                            ("bank", [s for s in complete if s["restore"]])):
            b = {s["id"]: outcomes[base][s["id"]] for s in sel}
            o = {s["id"]: outcomes[other][s["id"]] for s in sel}
            out[subset] = D2.paired_test(b, o)
            out[subset]["robust"] = D3.robustness(b, o)
        out["sign_p"] = D3.sign_p(out["all"]["wins"], out["all"]["losses"])
        out["deaths"] = sum(outcomes[other][s["id"]]["dead"] for s in complete)
        out["mean_depth"] = round(sum(outcomes[other][s["id"]]["max_depth"] for s in complete) / max(1, len(complete)), 2)
        return out

    rp = [outcomes["rules+"][s["id"]] for s in complete]
    res["baseline"] = {"deaths": sum(o["dead"] for o in rp), "mean_depth": round(sum(o["max_depth"] for o in rp) / max(1, len(rp)), 2),
                       "top_killers": collections.Counter(o.get("death_cause") for o in rp if o["dead"]).most_common(8)}
    stats = {}
    for a in main_arms:
        if not a["ckpt"]: continue
        info = compare("rules+", a["name"])
        gdirs = [gd(a["name"], s) for s in complete]
        ratio, n, guards = D3.consult_stats(gdirs)
        thr = max((D2.game_summary(g)["throws"] for g in gdirs), default=0)
        stats[a["name"]] = override_stats(gdirs)
        info.update(consulted=ratio, trained_type_decisions=n, guards=guards, max_throws=thr, **stats[a["name"]])
        checks += [(f"{a['name']}: consulted >= 0.9", ratio is not None and ratio >= 0.9),
                   (f"{a['name']}: max throws <= 100", thr <= 100)]
        res["vs_rules+"][a["name"]] = info
    for a in main_arms:  # the cooldown must bind: fewer changes per game than E-all, and some blocked
        if a.get("cooldown") and a["name"] in stats and "E-all" in stats:
            checks.append((f"{a['name']}: cooldown binds", stats[a["name"]]["blocked_by_cooldown"] > 0 and
                           stats[a["name"]]["changes_per_game"] < stats["E-all"]["changes_per_game"]))
    for base, other in (("E-all", "E-cool"), ("E-all", "E-cool1000"), ("E-cool", "E-cool1000"), ("E-cool", "G-cool")):
        res["head_to_head"][f"{other} vs {base}"] = compare(base, other)
    res["canary"] = D2.canary(res, checks)
    return res


KINDS = {"finalH": stage_tournament}
D6.KINDS.update(KINDS)
D6.SMOKE_MINUTES.update(SMOKE_MINUTES)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--prior5", required=True); ap.add_argument("--prior7", required=True)
    ap.add_argument("--hours", type=float, default=18); ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--slots", type=int, default=13)
    a = ap.parse_args()
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior = run.prior5 = os.path.abspath(a.prior5)  # run.prior: session 5's C bank (D2.bank_files)
    run.prior7 = os.path.abspath(a.prior7)
    signal.signal(signal.SIGTERM, lambda *_: D.STOP.set())
    app = D.app_dir(run)  # first: freezing the source recreates RUN/src
    cbin = D.freeze_c(run)
    run.log(f"driver8 start (smoke={a.smoke}, slots={a.slots}, engine={D.ENGINE}, c_bin={cbin}, "
            f"port_offset={D.PORT_OFFSET}); prior5={run.prior5}; prior7={run.prior7}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    end = run.state["deadline"]
    try:
        D6.run_stage(run, "finalH", end - 20 * 60, a.smoke)
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        D.write_report(run)
        run.log("driver8 finished")


if __name__ == "__main__":
    main()
