#!/usr/bin/env python3
"""Decision collection on bank starts: one arm, decision records with snapshots kept (M1, docs/plan-2026-11-09.md).

Plays N bank starts (driver18's bank_starts: level-entry savepoints at DL lo..hi, classes and lineages in rotation)
with one RULEFIX (casters and Paladin/Ranger/Rogue get their class extras as in driver18), DANGER_LOG=1 and
DECISION_LOG=1 limited to --types (DECISION_LOG_TYPES), and keeps each game's decisions.jsonl and snapshots/ for the
rollout labeller (tools/rollout/run.ts). Replays are deleted. RUN/collect.jsonl has one line per game.

Usage: collect.py --run runs/m1/<name> --bank runs/harvest/<run>[,...] --rulefix FLAGS --types blind [--n 1200]
                  [--seed 9100000] [--slots 13] [--maxa 20000] [--cap-s 900] [--hours 3] [--exclude-clusters JSON]
"""
import argparse, json, os, shutil, sys, threading, time  # noqa: E401
import concurrent.futures as cf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver8 as D8  # noqa: E402
import driver18 as D18  # noqa: E402
import evaluate  # noqa: E402

D.NATIVE = evaluate.NATIVE = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--bank", required=True)
    ap.add_argument("--rulefix", required=True); ap.add_argument("--types", required=True)
    ap.add_argument("--n", type=int, default=1200); ap.add_argument("--seed", type=int, default=9100000)
    ap.add_argument("--slots", type=int, default=13); ap.add_argument("--maxa", type=int, default=20000)
    ap.add_argument("--cap-s", type=int, default=900); ap.add_argument("--hours", type=float, default=3)
    ap.add_argument("--min-depth", type=int, default=10); ap.add_argument("--max-depth", type=int, default=19)
    ap.add_argument("--casters", default="Mage,Priest,Druid"); ap.add_argument("--caster-extra", default="spellfx,spellfight")
    ap.add_argument("--class-extra", default="Paladin/Ranger/Rogue:spellfx")
    ap.add_argument("--extra-env", default="", help="NAME=value;... added to every game's environment")
    ap.add_argument("--exclude-clusters", help="JSON list of bank lineages (bank_starts' cluster) to leave out, e.g. "
                    "the check sets' characters, so training games share no character with them")
    a = ap.parse_args()
    run = D.Run(a.run, a.hours, False, a.slots)
    D.app_dir(run); D.freeze_c(run)
    if a.exclude_clusters:
        ex = set(json.load(open(a.exclude_clusters)))
        starts = [s for s in D18.bank_starts(a.bank.split(","), a.min_depth, a.max_depth, a.seed, 10 ** 6)
                  if s["cluster"] not in ex][:a.n]
    else:
        starts = D18.bank_starts(a.bank.split(","), a.min_depth, a.max_depth, a.seed, a.n)
    extra = D18.class_extras(a.class_extra)
    casters = set(a.casters.split(","))
    env_extra = dict(kv.split("=", 1) for kv in a.extra_env.split(";") if kv)
    deadline = time.time() + a.hours * 3600
    run.log(f"collect start: {len(starts)} starts, rulefix {a.rulefix}, types {a.types}, slots {a.slots}, maxa {a.maxa}")
    lock, it = threading.Lock(), iter(starts)
    out = open(os.path.join(run.path, "collect.jsonl"), "a")

    def worker(slot):
        while time.time() < deadline - 120 and not run.stopped():
            with lock: s = next(it, None)
            if s is None: return
            rf = ",".join(filter(None, [a.rulefix, a.caster_extra if s["cls"] in casters else "", extra.get(s["cls"], "")]))
            env = {**D8.arm_env({"name": "collect", "ckpt": None, "guard": "", "caution": 1.0}, {}), "RULEFIX": rf,
                   "DANGER_LOG": "1", "DECISION_LOG_TYPES": a.types, **env_extra}
            gdir = run.d("games", s["id"])
            res = D.play_game(run, "collect", slot, s["seed"], s["cls"], env, gdir,
                              max(60, min(a.cap_s, deadline - time.time())), a.maxa, 4100, None, s["restore"])
            p = os.path.join(gdir, "busho-replay.jsonl")
            if os.path.exists(p): os.remove(p)
            n = 0
            dp = os.path.join(gdir, "decisions.jsonl")
            if os.path.exists(dp): n = sum(1 for _ in open(dp))
            with lock:
                out.write(json.dumps({**res, "id": s["id"], "rulefix": rf, "records": n}) + "\n"); out.flush()
            run.log(f"collect: {s['id']}: {n} records, {res}")

    with cf.ThreadPoolExecutor(a.slots) as ex:
        list(ex.map(worker, range(a.slots)))
    run.log("collect done")


if __name__ == "__main__":
    main()
