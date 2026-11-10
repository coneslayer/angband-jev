#!/usr/bin/env python3
"""Phase 1 headroom map (docs/plan-2026-11-09.md): base and test-only cheat arms on the same starts, one look.

Starts: --kind bank (driver18's bank_starts, DL10-19, 20,000 actions) or --kind fresh (new characters, classes in
rotation). Every start plays the base and each arm (CHEAT=<grant>, the server started with --cheats), all on the same
seed. Base flags per class as driver18 (casters +spellfx,spellfight; Paladin/Ranger/Rogue +spellfx).

Report (RUN/report.json): per arm against base, on the common complete starts: the stage-stratified death-rate and
advance-rate ratios with 80% bootstrap intervals (hazard.policy), PH(10) (fresh) or PH(20) from DL10 (bank,
hazard.screen), and the death ratio by class. The reading rule is in the plan (live <= 0.67, dead >= 0.85).
Cheat games are measurements: their danger logs are never pooled or trained on.

Usage: headroom.py --run runs/headroom/<name> --kind bank|fresh --arms cl10,hp2,... --base FLAGS [--n 150]
                   [--seed 9200000] [--slots 13] [--maxa 20000] [--cap-s 900] [--hours 4] [--report-only]
"""
import argparse, json, os, sys, threading, time  # noqa: E401
import concurrent.futures as cf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver8 as D8  # noqa: E402
import driver18 as D18  # noqa: E402
import evaluate  # noqa: E402
import hazard as H  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
CLASSES = ["Warrior", "Mage", "Priest", "Rogue", "Ranger", "Paladin", "Druid", "Blackguard"]


def starts(a):
    if a.kind == "bank":
        return D18.bank_starts(a.bank.split(","), 10, 19, a.seed, a.n)
    return [{"id": f"fresh-{i:05d}-{CLASSES[i % len(CLASSES)]}", "seed": a.seed + i, "cls": CLASSES[i % len(CLASSES)],
             "restore": None, "cluster": i} for i in range(a.n)]


def report(a, ss):
    arms = ["base"] + a.arms.split(",")
    games = {arm: H.load([os.path.join(a.run, "games", arm)]) if os.path.isdir(os.path.join(a.run, "games", arm)) else {}
             for arm in arms}
    cls_of = {s["id"]: s["cls"] for s in ss}
    clusters = {s["id"]: s.get("cluster") for s in ss} if a.kind == "bank" else None
    k, start = (20, 10) if a.kind == "bank" else (10, 0)
    out = {"kind": a.kind, "k": k, "start": start, "arms": {}}
    for arm in arms[1:]:
        ids = sorted(set(games["base"]) & set(games[arm]))
        if not ids: continue
        b, v = {i: games["base"][i] for i in ids}, {i: games[arm][i] for i in ids}
        pol = H.policy(b, v, ks=(10,), n_boot=400)
        scr = H.screen(b, v, look=1, looks=(len(ids),), k=k, start=start, clusters=clusters)
        by = {}
        for c in sorted({cls_of.get(i, "?") for i in ids}):
            sel = [i for i in ids if cls_of.get(i) == c]
            tb, tv = H.rates([b[i] for i in sel]), H.rates([v[i] for i in sel])
            by[c] = {"pairs": len(sel), "death_rr": H.mh_ratio(tb, tv, 1), "pace_rr": H.mh_ratio(tb, tv, 2),
                     "deaths": [sum(b[i]["dead"] for i in sel), sum(v[i]["dead"] for i in sel)]}
        dr = pol["death_rr"]
        verdict = "live" if dr["ratio"] <= 0.67 else "dead" if dr["ratio"] >= 0.85 else "between"
        out["arms"][arm] = {"pairs": len(ids), "death_rr": dr, "pace_rr": pol["pace_rr"], f"PH{k}": scr.get("PH"),
                            "z": scr.get("z"), "deaths": [sum(b[i]["dead"] for i in ids), sum(v[i]["dead"] for i in ids)],
                            "mean_end": [round(sum(b[i]["end"] for i in ids) / len(ids), 2), round(sum(v[i]["end"] for i in ids) / len(ids), 2)],
                            "verdict": verdict, "by_class": by}
    json.dump(out, open(os.path.join(a.run, "report.json"), "w"), indent=1, default=str)
    for arm, r in out["arms"].items():
        print(f"{arm:10s} pairs {r['pairs']:4d} death_rr {r['death_rr']['ratio']:.2f} {tuple(round(x, 2) for x in r['death_rr']['ci80'])} "
              f"pace {r['pace_rr']['ratio']:.2f} PH{k} {r[f'PH{k}'] if r[f'PH{k}'] is None else round(r[f'PH{k}'], 2)} "
              f"deaths {r['deaths']} end {r['mean_end']} -> {r['verdict']}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--kind", choices=("bank", "fresh"), required=True)
    ap.add_argument("--arms", required=True); ap.add_argument("--base", required=True)
    ap.add_argument("--bank", default="runs/harvest/2026-10-30-full,runs/harvest/2026-10-30-pilot")
    ap.add_argument("--n", type=int, default=150); ap.add_argument("--seed", type=int, default=9200000)
    ap.add_argument("--slots", type=int, default=13); ap.add_argument("--maxa", type=int, default=20000)
    ap.add_argument("--cap-s", type=int, default=900); ap.add_argument("--hours", type=float, default=4)
    ap.add_argument("--report-only", action="store_true")
    a = ap.parse_args()
    run = D.Run(a.run, a.hours, False, a.slots)
    run.state["deadline"] = time.time() + a.hours * 3600  # a rerun into the same directory gets a new deadline
    ss = starts(a)
    if a.report_only: report(a, ss); return
    D.app_dir(run); D.freeze_c(run)
    extra = D18.class_extras("Paladin/Ranger/Rogue:spellfx")
    casters = {"Mage", "Priest", "Druid"}
    arms = ["base"] + a.arms.split(",")
    jobs = [(s, arm) for s in ss for arm in arms
            if not os.path.exists(os.path.join(a.run, "games", arm, s["id"], "busho-play-report.json"))]
    deadline = time.time() + a.hours * 3600
    run.log(f"headroom {a.kind}: {len(ss)} starts x {len(arms)} arms, {len(jobs)} games to play; base {a.base}")
    lock, it = threading.Lock(), iter(jobs)

    def worker(slot):
        while time.time() < deadline - 120 and not run.stopped():
            with lock: job = next(it, None)
            if job is None: return
            s, arm = job
            rf = ",".join(filter(None, [a.base, "spellfx,spellfight" if s["cls"] in casters else "", extra.get(s["cls"], "")]))
            env = {**D8.arm_env({"name": arm, "ckpt": None, "guard": "", "caution": 1.0}, {}), "RULEFIX": rf, "DANGER_LOG": "1",
                   **({"CHEAT": arm.replace("+", ",")} if arm != "base" else {})}
            gdir = run.d("games", arm, s["id"])
            res = D.play_game(run, f"hr-{arm}", slot, s["seed"], s["cls"], env, gdir,
                              max(60, min(a.cap_s, deadline - time.time())), a.maxa, 4100, None, s["restore"])
            for f in ("busho-replay.jsonl", "snapshots", "decisions.jsonl"):
                p = os.path.join(gdir, f)
                if os.path.isdir(p): __import__("shutil").rmtree(p, ignore_errors=True)
                elif os.path.exists(p): os.remove(p)
            run.log(f"{arm}: {s['id']}: {res}")

    with cf.ThreadPoolExecutor(a.slots) as ex: list(ex.map(worker, range(a.slots)))
    report(a, ss)


if __name__ == "__main__":
    main()
