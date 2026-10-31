#!/usr/bin/env python3
"""Deep-start screen: rule variants against the base on savepoints from a harvest bank, judged by PH(k) from DL s0.

See docs/finetune-laya-plan.md, "Next phase: deeper play across all classes". Honest view, C engine. One stage:

  deepS  starts are level-entry savepoints at --min-depth..--max-depth from one or more harvest runs (harvest.py),
         drawn class by class in rotation and, within a class, lineage by lineage (a lineage is the fresh game a
         savepoint descends from), each continued with its own seed. Every start plays the base and every variant
         still open; the base is per class (the casters add --caster-extra, as the harvest did). Each variant closes by
         hazard.screen at its looks, with PH(--k) from stage --start and the sd resampling lineages (clusters).

Every game writes a danger log. Disk guard as session 15; replays and snapshots are deleted after each game.
Resumable via RUN/state.json; `touch RUN/STOP` stops between games. Never restart it mid-stage.

Usage: driver18.py --run runs/deep/<date> --bank runs/harvest/<run>[,...] --base RULEFIX --variants a,b@Cls1/Cls2,c,d+e
       [--seed 7000000] [--hours 24] [--slots 13] [--k 20] [--start 10] [--min-depth 10] [--max-depth 19] [--smoke]
"""
import argparse, json, os, random, shutil, signal, sys, threading, time  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import driver6 as D6  # noqa: E402
import driver8 as D8  # noqa: E402
import driver14 as D14  # noqa: E402
import driver15 as D15  # noqa: E402
import driver17 as D17  # noqa: E402
import evaluate  # noqa: E402
import hazard as H  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
D.SCHEDULE = [("deepS", 24)]
D6.SMOKE_MINUTES.update({"deepS": 20})
SMOKE_LOOKS = (3, 6, 9)
free_gb, disk_low, ok = D15.free_gb, D15.disk_low, D14.ok


def bank_starts(banks, lo, hi, seed, n):
    """Up to n starts: level-entry savepoints at DL lo..hi, classes in rotation, lineages in rotation within a class,
    savepoints of a lineage in random order. Each: {id, seed, cls, restore, cluster, depth}."""
    rng = random.Random(seed)
    by_cls = {}
    for b in banks:
        roots = {}
        hj = os.path.join(b, "harvest.jsonl")
        if os.path.exists(hj):
            for line in open(hj):
                try: g = json.loads(line)
                except ValueError: continue
                roots[g["seed"]] = g.get("root", g["seed"])
        for line in open(os.path.join(b, "bank", "index.jsonl")):
            try: m = json.loads(line)
            except ValueError: continue
            if m.get("kind") != "level-entry" or not lo <= m.get("depth", 0) <= hi: continue
            s = int(os.path.basename(m["file"]).split("-")[0])
            lin = f"{os.path.basename(b.rstrip('/'))}:{roots.get(s, s)}"
            by_cls.setdefault(m.get("class", "?"), {}).setdefault(lin, []).append(
                {"file": os.path.join(b, "bank", m["file"]), "depth": m["depth"], "cls": m.get("class", "?")})
    for lins in by_cls.values():
        for sps in lins.values(): rng.shuffle(sps)
    order = {c: rng.sample(list(lins), len(lins)) for c, lins in by_cls.items()}
    classes, out, k = sorted(by_cls), [], {c: 0 for c in by_cls}
    while len(out) < n and any(by_cls[c][l] for c in classes for l in order[c]):
        for c in classes:
            lins = [l for l in order[c] if by_cls[c][l]]
            if not lins: continue
            lin = lins[k[c] % len(lins)]; k[c] += 1
            sp = by_cls[c][lin].pop()
            i = len(out)
            out.append({"id": f"bank-{i:05d}-{c}-DL{sp['depth']}", "seed": seed + i, "cls": c, "restore": sp["file"],
                        "cluster": lin, "depth": sp["depth"]})
            if len(out) >= n: break
    return out


class DeepScreen(D17.Screen):
    """driver17's Screen with a per-class base, PH(k) from stage s0, and lineage clusters."""

    def __init__(self, run, stage, starts, base_of, variants, looks):
        super().__init__(run, stage, starts, "", variants, looks)
        self.base_of = base_of
        self.clusters = {s["id"]: s["cluster"] for s in starts}

    def next_job(self):
        with self.lock:
            while not self.queue:
                if not self.open() or self.pos >= len(self.starts): return None
                s = self.starts[self.pos]; self.pos += 1
                want = [a for a in self.open() if self.variants[a][1](s)]
                if not want: continue
                b = self.base_of(s)
                if s["id"] not in self.outcomes["base"]: self.queue.append((s, "base", b, self.stage))
                self.queue += [(s, a, f"{b},{self.variants[a][0]}", self.stage) for a in want
                               if s["id"] not in self.outcomes[a]]
            return self.queue.pop(0)

    def check(self, final=False):
        with self.lock:
            got = D14.load_outcomes(self.run.d("driver.log"), f"{self.stage}-")
            done = {a: {i for i, r in got.get(a, {}).items() if ok(r)} for a in ["base", *self.variants]}
            for a in self.open():
                ids = done["base"] & done[a]
                look = sum(len(ids) >= x for x in self.looks)
                if look <= self.checked.get(a, 0) and not final: continue
                if look == 0:
                    if final: self.closed[a] = {"decision": "unresolved", "pairs": len(ids)}
                    continue
                r = H.screen(self.games("base", ids), self.games(a, ids), look=look, looks=self.looks,
                             k=self.run.k, start=self.run.s0, clusters=self.clusters)
                pol = H.policy(self.games("base", ids), self.games(a, ids), ks=(), n_boot=200)
                r["death_rr"], r["pace_rr"] = pol["death_rr"]["ratio"], pol["pace_rr"]["ratio"]
                self.checked[a] = look
                self.run.log(f"{self.stage}: {a} look {look} ({len(ids)} pairs): {json.dumps(r)}")
                if r["decision"] != "continue" or final:
                    if r["decision"] == "continue": r["decision"] = "unresolved"
                    self.closed[a] = {**r, "capped": D14.compare(got["base"], got[a], ids)}
                self.run.save()


def play_one(run, stage, s, arm, rulefix, slot, deadline):
    maxa, cap = (1500, 240) if run.smoke else (run.maxa, run.cap_s)
    env = {**D8.arm_env({"name": arm, "ckpt": None, "guard": "", "caution": 1.0}, {}), "RULEFIX": rulefix,
           "DANGER_LOG": "1"}
    out = run.d(stage, arm, s["id"])
    res = D.play_game(run, f"{stage}-{arm}", slot, s["seed"], s["cls"], env, out,
                      max(60, min(cap, deadline - time.time())), maxa, 4100, None, s["restore"])
    run.log(f"{stage}-{arm}: {s['id']}: {res}")
    for f in ("busho-replay.jsonl", "snapshots"):
        p = os.path.join(out, f)
        if os.path.isdir(p): shutil.rmtree(p, ignore_errors=True)
        elif os.path.exists(p): os.remove(p)
    return res


D17.play_one = play_one  # D17.pool calls play_one by module global


def stage_deep(run, name, deadline):
    ss = bank_starts(run.banks, run.min_depth, run.max_depth, run.seed, 40 if run.smoke else 3000)
    if not ss: return {"failed": "no savepoints in range"}
    by = {}
    for s in ss: by[s["cls"]] = by.get(s["cls"], 0) + 1
    run.log(f"{name}: {len(ss)} starts from {len({s['cluster'] for s in ss})} lineages; by class {by}")
    casters = set(run.casters)
    base_of = lambda s: run.base + (f",{run.caster_extra}" if s["cls"] in casters and run.caster_extra else "")  # noqa: E731
    variants = {}
    for v in run.variants:  # "name" or "name@Class1/Class2": the variant only on those classes' starts
        arm, _, cls = v.partition("@")
        only = set(cls.split("/")) if cls else None
        variants[arm] = (arm.replace("+", ","), (lambda s, only=only: only is None or s["cls"] in only))  # a+b: both flags
    res = DeepScreen(run, name, ss, base_of, variants, SMOKE_LOOKS if run.smoke else run.looks).run_until(deadline)
    res["adopted"] = [v for v in variants if (res["closed"].get(v) or {}).get("decision") == "adopt"]
    return res


D6.KINDS.update({"deepS": stage_deep})


def main():
    ap = argparse.ArgumentParser()
    for p in ("--run", "--bank", "--base", "--variants"): ap.add_argument(p, required=True)
    ap.add_argument("--casters", default="Mage,Priest,Druid"); ap.add_argument("--caster-extra", default="spellfx,spellfight")
    ap.add_argument("--seed", type=int, default=7000000); ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--slots", type=int, default=13); ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--k", type=int, default=20); ap.add_argument("--start", type=int, default=10)
    ap.add_argument("--min-depth", type=int, default=10); ap.add_argument("--max-depth", type=int, default=19)
    ap.add_argument("--maxa", type=int, default=20000); ap.add_argument("--cap-s", type=int, default=900)
    ap.add_argument("--looks", default=",".join(map(str, H.LOOKS)))
    a = ap.parse_args()
    if free_gb(".") < D15.DISK_START_GB:
        sys.exit(f"only {free_gb('.'):.1f} GB free (Linux and host drive); need {D15.DISK_START_GB}")
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.banks = [os.path.abspath(b) for b in a.bank.split(",")]
    run.base, run.variants, run.seed = a.base, a.variants.split(","), a.seed
    run.casters, run.caster_extra = a.casters.split(",") if a.casters else [], a.caster_extra
    run.k, run.s0, run.min_depth, run.max_depth = a.k, a.start, a.min_depth, a.max_depth
    run.maxa, run.cap_s, run.looks = a.maxa, a.cap_s, tuple(int(x) for x in a.looks.split(","))
    signal.signal(signal.SIGTERM, lambda *_: D.STOP.set())
    app = D.app_dir(run)
    cbin = D.freeze_c(run)
    run.log(f"driver18 start (smoke={a.smoke}, slots={run.slots}, c_bin={cbin}, port_offset={D.PORT_OFFSET}, "
            f"free {free_gb(run.path):.0f} GB); banks {run.banks}; DL{run.min_depth}-{run.max_depth}; base {run.base}; "
            f"casters {run.casters} +{run.caster_extra}; variants {run.variants}; PH({run.k}) from {run.s0}; looks "
            f"{run.looks}; maxa {run.maxa}; seed {run.seed}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    threading.Thread(target=D15.disk_guard, args=(run,), daemon=True).start()
    try:
        D6.run_stage(run, "deepS", run.state["deadline"] - 5 * 60, a.smoke)
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        D.write_report(run)
        run.log(f"driver18 finished ({free_gb(run.path):.0f} GB free)")


if __name__ == "__main__":
    main()
