#!/usr/bin/env python3
"""Session 14: rule changes where the score is lost, rules+ only, paired with session 13's own rules+ games.

Games are deterministic, so each variant is paired with finalM's rules+ game on the same start (session 13 froze
the source with these rules off; rules+ is re-run on the first 20 starts to check the new source plays the same).

  ruleN    (screen)  each variant on a fixed sample of 700 of finalM's complete starts; fire also on every other
                     fresh Ranger start. Variants (each alone on top of rules+):
                       fire         shoot with an equipped launcher at monsters 2+ squares away; buy ammo in town
                       lowheal      HP < 35% (or poisoned and < 50%): heal before the stall escapes
                       restock100   go back to town for potions/escapes only with 100+ gold (now 40)
                       restockboth  go back only when both potions and Phase/oil are gone (now either)
                       clgate1      DL1-3: descend at CL >= DL+1 (now DL+2)
  confirmN (confirm) the adopted variants together ("combo") on the other 443 starts, then on the 700

Usage: driver14.py --run runs/session14/<date> --prior5 runs/session5/2026-10-16 --prior13 runs/session13/2026-10-24
       [--hours 12] [--slots 13] [--smoke]
"""
import argparse, ast, collections, concurrent.futures as cf, json, os, random, re, signal, sys, threading, time  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import driver3 as D3  # noqa: E402
import driver8 as D8  # noqa: E402

BASE = "danger,restock,escape,upnavfood"
VARIANTS = ["fire", "lowheal", "restock100", "restockboth", "clgate1"]
SAMPLE_N, CHECK_N, PENALTY = 700, 20, 3
SCREEN_FRAC = 0.82  # of the session for ruleN; confirmN gets the rest
D8.STARTS = {"rng": "finalM", "fresh": 3200000, "bank": 3250000}
D.SCHEDULE = [("ruleN", 10.0), ("confirmN", 2.0)]


def load_outcomes(path, prefix):
    """{arm: {start id: outcome}} from a driver log's result lines."""
    out = collections.defaultdict(dict)
    for line in open(path, errors="replace"):
        m = re.match(r"\[.*?\] (\S+?): (\S+): (\{.*\})$", line.strip())
        if m and m.group(1).startswith(prefix):
            out[m.group(1)[len(prefix):]][m.group(2)] = ast.literal_eval(m.group(3))
    return out


def ok(r): return bool(r) and "error" not in r and not r.get("timed_out") and not r.get("cut")
def score(r, k=PENALTY): return r["max_depth"] - k * r["dead"]
def fingerprint(r): return (r["actions"], r["dead"], r["max_depth"])
def cause(r, word): return bool(r["dead"] and word in (r.get("death_cause") or ""))


def compare(base, new, ids):
    """Paired results of new against base on the starts in ids (complete in both)."""
    pairs = [(base[s], new[s]) for s in ids if ok(base.get(s)) and ok(new.get(s))]
    if not pairs: return {"pairs": 0}
    n = len(pairs)
    res = {"pairs": n, "changed": sum(fingerprint(a) != fingerprint(b) for a, b in pairs)}
    for k in (0, 1, 3, 6):
        w = sum(score(b, k) > score(a, k) for a, b in pairs); l = sum(score(b, k) < score(a, k) for a, b in pairs)
        res[f"k{k}"] = {"wins": w, "losses": l, "mean_diff": round(sum(score(b, k) - score(a, k) for a, b in pairs) / n, 3),
                        "sign_p": D3.sign_p(w, l)}
    res.update({"wins": res["k3"]["wins"], "losses": res["k3"]["losses"], "mean_diff": res["k3"]["mean_diff"], "sign_p": res["k3"]["sign_p"],
                "deaths": [sum(a["dead"] for a, _ in pairs), sum(b["dead"] for _, b in pairs)],
                "mean_depth": [round(sum(a["max_depth"] for a, _ in pairs) / n, 2), round(sum(b["max_depth"] for _, b in pairs) / n, 2)],
                "starvation": [sum(cause(a, "starvation") for a, _ in pairs), sum(cause(b, "starvation") for _, b in pairs)],
                "poison": [sum(cause(a, "(poison)") for a, _ in pairs), sum(cause(b, "(poison)") for _, b in pairs)],
                "mean_actions": [round(sum(a["actions"] for a, _ in pairs) / n), round(sum(b["actions"] for _, b in pairs) / n)]})
    return res


def passes(c): return c.get("pairs", 0) > 0 and c["wins"] > c["losses"] and c["sign_p"] < 0.05 and c["mean_diff"] > 0


def log_counts(run, stage, arm, ids):
    """Per game: launcher shots, restock trips and descents, from the player logs."""
    shots, trips, desc, n = 0, 0, 0, 0
    for s in ids:
        f = run.d(stage, arm, s, "player.log")
        if not os.path.exists(f): continue
        t = open(f, errors="replace").read(); n += 1
        m = re.search(r"射撃(\d+)回", t); shots += int(m.group(1)) if m else 0
        trips += t.count("[学習] 補給帰還"); desc += t.count("[学習] 降下")
    return {"games": n, "shots_per_game": round(shots / max(1, n), 1), "restock_trips_per_game": round(trips / max(1, n), 1),
            "descents_per_game": round(desc / max(1, n), 1)}


def play(run, stage, jobs, deadline, smoke):
    """jobs: [(start, arm name, rulefix)]; outcomes logged as '<stage>-<arm>: <start id>: {...}'."""
    it, lock = iter(jobs), threading.Lock()

    def worker(slot):
        while not run.stopped() and time.time() < deadline:
            if slot >= D.THROTTLED_SLOTS and os.path.exists(os.path.join(run.path, "THROTTLE")):
                time.sleep(30); continue
            with lock: job = next(it, None)
            if job is None: return
            s, arm, rulefix, full = job
            cap, maxa = (600, 15000) if s["restore"] else (900, 20000)
            if smoke and not full: cap, maxa = 240, 1500
            env = {**D8.arm_env({"name": arm, "ckpt": None, "guard": "", "caution": 1.0}, {}), "RULEFIX": rulefix}
            res = D.play_game(run, f"{stage}-{arm}", slot, s["seed"], s["cls"], env, run.d(stage, arm, s["id"]),
                              max(60, min(cap, deadline - time.time())), maxa, 4100, None, s["restore"])
            run.log(f"{stage}-{arm}: {s['id']}: {res}")

    with cf.ThreadPoolExecutor(run.slots) as ex:
        list(ex.map(worker, range(run.slots)))


def main():
    ap = argparse.ArgumentParser()
    for p in ("--run", "--prior5", "--prior13"): ap.add_argument(p, required=True)
    ap.add_argument("--hours", type=float, default=12.0); ap.add_argument("--slots", type=int, default=13)
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior = run.prior5 = os.path.abspath(a.prior5)
    base = load_outcomes(os.path.join(os.path.abspath(a.prior13), "driver.log"), "finalM-")["rules+"]
    smoke, run.smoke = run.smoke, False  # finalM's full list of starts, also in the smoke test
    starts = [s for s in D8.starts_for(run) if ok(base.get(s["id"]))]
    run.smoke = smoke
    sample = random.Random("ruleN").sample(starts, min(SAMPLE_N, len(starts)))
    if a.smoke:  # 2 Rangers and 4 others; full-length replays of 2 bank starts and 1 fresh one
        sample = [s for s in sample if s["cls"] == "Ranger"][:2] + [s for s in sample if s["cls"] != "Ranger"][:4]
    sample_ids = {s["id"] for s in sample}
    held = [s for s in starts if s["id"] not in sample_ids][:4 if a.smoke else None]
    rangers = [s for s in starts if s["cls"] == "Ranger" and (not a.smoke or s["id"] in sample_ids)]
    if a.smoke: rangers += [s for s in starts if s["cls"] == "Ranger" and s["id"] not in sample_ids][:1]
    check = [s for s in starts if s["restore"]][:2] + starts[:1] if a.smoke else starts[:CHECK_N]
    run.state.setdefault("starts", {"complete_in_finalM": len(starts), "sample": len(sample), "held": len(held),
                                    "rangers": len(rangers), "check": [s["id"] for s in check]}); run.save()
    signal.signal(signal.SIGTERM, lambda *_: D.STOP.set())
    app = D.app_dir(run); cbin = D.freeze_c(run)
    run.log(f"driver14 start (smoke={a.smoke}, slots={run.slots}): {len(starts)} complete finalM starts, sample {len(sample)}, "
            f"held out {len(held)}, rangers {len(rangers)}; c_bin={cbin}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    end = run.state["deadline"]
    screen_end = run.state["started"] + SCREEN_FRAC * (end - run.state["started"])
    try:
        if "ruleN" not in run.state:
            # the determinism check first (full games, also in the smoke test), then start by start, every variant
            jobs = [(s, "rules+", BASE, True) for s in check]
            extra = [s for s in rangers if s["id"] not in sample_ids]
            for s in sample + extra:
                for v in VARIANTS:
                    if s in extra and v != "fire": continue
                    jobs.append((s, f"rules+{v}", f"{BASE},{v}", False))
            run.log(f"stage ruleN begins ({len(jobs)} games, until {time.strftime('%H:%M', time.localtime(screen_end))})")
            play(run, "ruleN", jobs, screen_end - 5 * 60, a.smoke)
            got = load_outcomes(run.d("driver.log"), "ruleN-")
            det = [s["id"] for s in check if ok(got["rules+"].get(s["id"]))]
            same = sum(fingerprint(got["rules+"][i]) == fingerprint(base[i]) for i in det)
            res = {"replay": {"n": len(det), "identical": same}, "variants": {}}
            for v in VARIANTS:
                arm = f"rules+{v}"
                c = {"sample": compare(base, got[arm], sample_ids), "logs": log_counts(run, "ruleN", arm, sample_ids)}
                if v == "fire":
                    rid = {s["id"] for s in rangers}
                    c["rangers"] = compare(base, got[arm], rid)
                    c["non_rangers"] = compare(base, got[arm], sample_ids - rid)
                    c["ranger_logs"] = log_counts(run, "ruleN", arm, rid)
                    c["adopt"] = passes(c["rangers"]) and not (c["non_rangers"].get("losses", 0) > c["non_rangers"].get("wins", 0)
                                                               and D3.sign_p(c["non_rangers"]["losses"], c["non_rangers"]["wins"]) < 0.05)
                else:
                    c["adopt"] = passes(c["sample"])
                res["variants"][v] = c
            r100, rboth = res["variants"]["restock100"], res["variants"]["restockboth"]
            if r100["adopt"] and rboth["adopt"]:  # the same trigger: keep the better one
                (rboth if r100["sample"]["mean_diff"] >= rboth["sample"]["mean_diff"] else r100)["adopt"] = False
            res["canary"] = {"passed": same >= 0.9 * max(1, len(det)) and len(det) >= (2 if a.smoke else 10)}
            res["adopted"] = [v for v in VARIANTS if res["variants"][v]["adopt"]]
            if a.smoke and not res["adopted"]: res["adopted"] = ["fire", "lowheal", "restockboth"]  # exercise confirmN
            run.state["ruleN"] = res; run.save()
            run.log(f"stage ruleN done: {json.dumps(res)}")
        res = run.state["ruleN"]
        if not res["canary"]["passed"]:
            run.log("replay canary failed: the new source doesn't replay session 13's games; confirmN skipped")
        elif not res["adopted"]:
            run.log("no variant adopted; confirmN skipped")
        elif "confirmN" not in run.state:
            combo = f"{BASE},{','.join(res['adopted'])}"
            jobs = [(s, "combo", combo, False) for s in held + sample]
            run.log(f"stage confirmN begins: combo = {combo} ({len(jobs)} games, held-out first)")
            play(run, "confirmN", jobs, end - 5 * 60, a.smoke)
            got = load_outcomes(run.d("driver.log"), "confirmN-")["combo"]
            held_ids = {s["id"] for s in held}
            c = {"rulefix": combo, "held": compare(base, got, held_ids), "sample": compare(base, got, sample_ids),
                 "all": compare(base, got, held_ids | sample_ids), "logs": log_counts(run, "confirmN", "combo", held_ids | sample_ids)}
            c["new_default"] = c["held"].get("pairs", 0) > 0 and c["held"]["wins"] > c["held"]["losses"] and c["held"]["mean_diff"] > 0
            run.state["confirmN"] = c; run.save()
            run.log(f"stage confirmN done: {json.dumps(c)}")
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        run.log("driver14 finished")


if __name__ == "__main__":
    main()
