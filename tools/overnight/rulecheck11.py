#!/usr/bin/env python3
"""Check rule changes (RULEFIX variants) on session 11's starts, rules+ only: wor (buy a Word of Recall before the
potions) and upnav (on the way back to town, re-make the level by stairs when no up staircase is in view).

Games are deterministic, so each variant is paired with session 11's own rules+ games: every start where
rules+ starved, plus a fixed random sample of the others. rules+ itself is re-run on the first 20 starts to check
that the new source, with the rules off, still plays the same games.

Usage: rulecheck11.py --run runs/session11/rulecheck --prior5 runs/session5/2026-10-16 --prior11 runs/session11/2026-10-22
       [--others 437] [--hours 2] [--slots 13]
"""
import argparse, json, os, random, re, signal, sys, threading  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import driver8 as D8  # noqa: E402
import driver11  # noqa: E402,F401  session 11's start seeds (D8.STARTS)

D.SCHEDULE = [("ruleK", 2.5)]
VARIANTS = {"rules+upnav": "danger,restock,escape,upnav", "rules+upnav+wor": "danger,restock,escape,upnav,wor"}
if os.environ.get("RULECHECK_VARIANTS"):  # e.g. rules+upnavfood=danger,restock,escape,upnavfood
    VARIANTS = dict(v.split("=", 1) for v in os.environ["RULECHECK_VARIANTS"].split(";"))
CHECK_N = 20


def main():
    ap = argparse.ArgumentParser()
    for p in ("--run", "--prior5", "--prior11"): ap.add_argument(p, required=True)
    ap.add_argument("--others", type=int, default=437); ap.add_argument("--hours", type=float, default=2.5)
    ap.add_argument("--slots", type=int, default=13)
    a = ap.parse_args()
    run = D.Run(a.run, a.hours, False, a.slots)
    run.prior = run.prior5 = os.path.abspath(a.prior5)
    prior = os.path.join(os.path.abspath(a.prior11), "finalK", "rules+")
    starts = D8.starts_for(run)
    starved = lambda s: re.search(r"died\. \(starvation\)", open(os.path.join(prior, s["id"], "player.log"), errors="replace").read())  # noqa: E731
    done = [s for s in starts if os.path.exists(os.path.join(prior, s["id"], "player.log"))]
    hit = [s for s in done if starved(s)]
    rest = [s for s in done if not starved(s)]
    pick = hit + random.Random("foodK").sample(rest, min(a.others, len(rest)))  # the same sample as the food check
    check = {s["id"] for s in done[:CHECK_N]}
    D8.starts_for = lambda run: pick + [s for s in done[:CHECK_N] if s not in pick]
    D8.arms_for = lambda run: [*({"name": n, "ckpt": None, "guard": "", "caution": 1.0, "rulefix": r} for n, r in VARIANTS.items()),
                               {"name": "rules+", "ckpt": None, "guard": "", "caution": 1.0, "only": check}]
    arm_env = D8.arm_env
    D8.arm_env = lambda arm, names: {**arm_env(arm, names), **({"RULEFIX": arm["rulefix"]} if arm.get("rulefix") else {})}
    run.state["ruleK"] = {"starved_starts": [s["id"] for s in hit], "check_starts": sorted(check)}; run.save()
    signal.signal(signal.SIGTERM, lambda *_: D.STOP.set())
    app = D.app_dir(run)
    cbin = D.freeze_c(run)
    run.log(f"rulecheck11 start: {len(hit)} starved starts, {len(pick) - len(hit)} others, {len(check)} rules+ re-runs; "
            f"c_bin={cbin}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    try:
        run_games(run, "ruleK", pick, check, run.state["deadline"] - 5 * 60)
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        run.log("rulecheck11 finished")


def run_games(run, name, pick, check, deadline):
    """Each variant on every picked start, rules+ on the check starts; outcomes go to RUN/name/<arm>/<start>."""
    import concurrent.futures as cf, time  # noqa: E401
    arms = D8.arms_for(run)
    jobs = iter([(s, arm) for arm in reversed(arms) for s in pick + [x for x in D8.starts_for(run) if x not in pick]
                 if "only" not in arm or s["id"] in arm["only"]])
    lock, out = threading.Lock(), {}

    def worker(slot):
        while not run.stopped() and time.time() < deadline:
            if slot >= D.THROTTLED_SLOTS and os.path.exists(os.path.join(run.path, "THROTTLE")):
                time.sleep(30); continue
            with lock: job = next(jobs, None)
            if job is None: return
            s, arm = job
            cap, maxa = (600, 15000) if s["restore"] else (900, 20000)
            res = D.play_game(run, f"{name}-{arm['name']}", slot, s["seed"], s["cls"], D8.arm_env(arm, {}),
                              os.path.join(run.path, name, arm["name"], s["id"]), max(60, min(cap, deadline - time.time())),
                              maxa, 4100, None, s["restore"])
            with lock: out[f"{arm['name']}/{s['id']}"] = res
            run.log(f"{name}-{arm['name']}: {s['id']}: {res}")

    with cf.ThreadPoolExecutor(run.slots) as ex:
        list(ex.map(worker, range(run.slots)))
    with open(run.d(name, "outcomes.json"), "w") as f: json.dump(out, f)


if __name__ == "__main__":
    main()
