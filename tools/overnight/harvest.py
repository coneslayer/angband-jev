"""Savepoint harvest: grow a bank of deep starts (DL8 and deeper) for the deep-start screens.

See docs/finetune-laya-plan.md, "Next phase: deeper play across all classes". Honest view, C engine, one arm (no
pairing). Every game saves a savepoint on each new deepest level from --min-depth down (tools/savepoint/bank.ts,
SAVEPOINT_DIR); the bank is RUN/bank with its index.jsonl.

Jobs, one per free slot. A lineage is the fresh game a savepoint descends from; lineages, not savepoints, are the
sample size (the pilot: branching multiplied savepoints within a few lineages).
  branch  a level-entry savepoint at --branch-depth or deeper, continued with a new seed. The class furthest under its
          --quota15 of DL15+ lineages first, then the lineage branched least, then the deepest savepoint. Each
          savepoint is branched at most --branches times, each lineage at most --lineage-cap times, and at most half the
          slots run branches at once, so fresh games keep measuring yield.
  fresh   a new character of the class furthest under its --quota10 of DL10+ lineages (counting the expected yield of
          its games in flight), then of classes still under --quota15; rotation breaks ties (--rotate: rotation only, as
          the pilot). Casters (--casters) get --caster-extra added to RULEFIX, and --class-extra adds flags by class.
Every game's outcome and lineage go to RUN/harvest.jsonl (seed, class, parent savepoint, root seed). Replays and
snapshots are deleted after each game; no danger log. RUN/REPORT-harvest.json counts savepoints by class and depth.

Disk guard as session 15 (Linux and the Windows host drive); `touch RUN/STOP` stops between games; resumable via
RUN/state.json.

Usage: harvest.py --run runs/harvest/<date> [--hours 2] [--seed 6000000] [--slots 13] [--maxa 60000] [--smoke]
"""
import argparse, collections, json, os, re, shutil, signal, sys, threading, time  # noqa: E401
import concurrent.futures as cf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import driver8 as D8  # noqa: E402
import driver15 as D15  # noqa: E402
import evaluate  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
D24 = "danger,restock,escape,upnavfood,fire,lowheal,leave,clgate1,gearid,tryunknown,worwait,deepkit,neutdrink,digskill,stationmem"
CLASSES = "Warrior,Rogue,Ranger,Paladin,Blackguard,Mage,Priest,Druid"
free_gb, disk_low = D15.free_gb, D15.disk_low
LOCK = threading.Lock()


def seed_of(savepoint):
    """The game seed a savepoint came from: busho names it <seed>-<race>-<class>-<ts>-DL<d>-<turn>.json.gz."""
    m = re.match(r"(\d+)-", os.path.basename(savepoint))
    return int(m.group(1)) if m else None


class Harvest:
    def __init__(self, run, a):
        self.run, self.a = run, a
        self.bank = run.d("bank")
        h = run.state.setdefault("harvest", {})
        h.setdefault("fresh_next", a.seed); h.setdefault("branch_next", a.seed + 500000); h.setdefault("rot", 0)
        h.setdefault("branched", {}); h.setdefault("lineage_branches", {}); h.setdefault("root", {})
        self.h = h
        self.classes, self.casters = a.classes.split(","), set(a.casters.split(",")) if a.casters else set()
        self.running_branches = 0
        self.running_fresh = collections.Counter()

    def lineages(self):
        """{class: (DL10+ lineages, DL15+ lineages)} from the bank, and fresh games finished per class."""
        idx = os.path.join(self.bank, "index.jsonl")
        l10, l15 = collections.defaultdict(set), collections.defaultdict(set)
        if os.path.exists(idx):
            for line in open(idx):
                try: m = json.loads(line)
                except ValueError: continue
                if m.get("kind") != "level-entry" or m.get("depth", 0) < 10: continue
                s = seed_of(m["file"]); root = self.h["root"].get(str(s), s)
                l10[m.get("class")].add(root)
                if m["depth"] >= 15: l15[m.get("class")].add(root)
        return {c: (len(l10[c]), len(l15[c])) for c in self.classes}

    def fresh_class(self, lin):
        """Rotation (--rotate), else the class furthest under its DL10+ quota, then its DL15+ quota."""
        if self.a.rotate: return self.classes[self.h["rot"] % len(self.classes)]
        done = self.h.setdefault("fresh_done", {})
        def need(c, k, q):
            n = done.get(c, 0); rate = (lin[c][k] + 0.5) / (n + 3)  # yield per fresh game, shrunk toward 1/6
            return (lin[c][k] + rate * self.running_fresh[c]) / q
        order = {c: i for i, c in enumerate(self.classes[self.h["rot"] % len(self.classes):] + self.classes[:self.h["rot"] % len(self.classes)])}
        # At most a third of the slots per class at once: the class with the lowest yield (Druids) would take them all
        room = [c for c in self.classes if self.running_fresh[c] < max(1, -(-self.run.slots // 3))] or self.classes
        under10 = [c for c in room if need(c, 0, self.a.quota10) < 1]
        if under10: return min(under10, key=lambda c: (need(c, 0, self.a.quota10), order[c]))
        return min(room, key=lambda c: (need(c, 1, self.a.quota15), order[c]))

    def candidates(self):
        """Level-entry savepoints deep enough to branch, deepest first."""
        idx = os.path.join(self.bank, "index.jsonl")
        if not os.path.exists(idx): return []
        out = []
        for line in open(idx):
            try: m = json.loads(line)
            except ValueError: continue
            if m.get("kind") == "level-entry" and m.get("depth", 0) >= self.a.branch_depth:
                out.append(m)
        return sorted(out, key=lambda m: -m["depth"])

    def next_job(self):
        """(seed, class, restore file | None, root seed) or None when stopping."""
        with LOCK:
            lin = self.lineages()
            if self.running_branches < max(1, self.run.slots // 2):
                cands = self.candidates()
                if not self.a.rotate:  # class under its DL15+ quota, then the lineage branched least, then deepest
                    def key(m):
                        s = seed_of(m["file"]); root = self.h["root"].get(str(s), s)
                        return (lin.get(m.get("class"), (0, 0))[1] / self.a.quota15,
                                self.h["lineage_branches"].get(str(root), 0), -m["depth"])
                    cands = sorted((m for m in cands if lin.get(m.get("class"), (0, 0))[1] < self.a.quota15), key=key)
                for m in cands:
                    f = os.path.join(self.bank, m["file"])
                    parent = seed_of(f)
                    root = self.h["root"].get(str(parent), parent)
                    if self.h["branched"].get(m["file"], 0) >= self.a.branches: continue
                    if self.h["lineage_branches"].get(str(root), 0) >= self.a.lineage_cap: continue
                    self.h["branched"][m["file"]] = self.h["branched"].get(m["file"], 0) + 1
                    self.h["lineage_branches"][str(root)] = self.h["lineage_branches"].get(str(root), 0) + 1
                    seed = self.h["branch_next"]; self.h["branch_next"] += 1
                    self.h["root"][str(seed)] = root
                    self.running_branches += 1
                    self.run.save()
                    return seed, m.get("class") or "Warrior", f, root
            cls = self.fresh_class(lin)
            self.h["rot"] += 1
            self.running_fresh[cls] += 1
            seed = self.h["fresh_next"]; self.h["fresh_next"] += 1
            self.h["root"][str(seed)] = seed
            self.run.save()
            return seed, cls, None, seed

    def rulefix(self, cls):
        return ",".join(filter(None, [self.a.base, self.a.caster_extra if cls in self.casters else "",
                                      class_extras(self.a.class_extra).get(cls, "")]))

    def play(self, slot, deadline):
        seed, cls, restore, root = self.next_job()
        env = {**D8.arm_env({"name": "harvest", "ckpt": None, "guard": "", "caution": 1.0}, {}),
               "RULEFIX": self.rulefix(cls), "SAVEPOINT_DIR": "/bank", "SAVEPOINT_MIN_DEPTH": str(self.a.min_depth)}
        out = self.run.d("games", f"{seed}-{cls}" + ("-branch" if restore else ""))
        try:
            res = D.play_game(self.run, "harvest", slot, seed, cls, env, out,
                              max(60, min(self.a.cap_s, deadline - time.time())), self.a.maxa, 4100, self.bank, restore)
        finally:
            with LOCK:
                if restore: self.running_branches -= 1
                else:
                    self.running_fresh[cls] -= 1
                    self.h.setdefault("fresh_done", {})[cls] = self.h["fresh_done"].get(cls, 0) + 1
        for f in ("busho-replay.jsonl", "snapshots", "decisions.jsonl"):
            p = os.path.join(out, f)
            if os.path.isdir(p): shutil.rmtree(p, ignore_errors=True)
            elif os.path.exists(p): os.remove(p)
        rec = {**res, "class": cls, "parent": os.path.basename(restore) if restore else None, "root": root,
               "rulefix": self.rulefix(cls)}
        with LOCK:
            with open(os.path.join(self.run.path, "harvest.jsonl"), "a") as fh: fh.write(json.dumps(rec) + "\n")
        self.run.log(f"harvest: {seed}-{cls}{' branch of ' + os.path.basename(restore) if restore else ''}: {res}")

    def report(self):
        idx = os.path.join(self.bank, "index.jsonl")
        sp = [json.loads(l) for l in open(idx)] if os.path.exists(idx) else []
        games = [json.loads(l) for l in open(os.path.join(self.run.path, "harvest.jsonl"))] \
            if os.path.exists(os.path.join(self.run.path, "harvest.jsonl")) else []
        band = lambda d: f"DL1-{self.a.min_depth - 1}" if d < self.a.min_depth else f"DL{self.a.min_depth}-9" if d < 10 else "DL10-14" if d < 15 else "DL15-19" if d < 20 else "DL20+"  # noqa: E731
        fresh_seeds = {g["seed"] for g in games if not g["parent"]}
        by = collections.defaultdict(lambda: collections.Counter())
        for m in sp:
            if m.get("kind") != "level-entry": continue
            src = "fresh" if seed_of(m["file"]) in fresh_seeds else "branch"
            by[m.get("class", "?")][f"{band(m['depth'])} {src}"] += 1
        g = collections.defaultdict(lambda: collections.Counter())
        for x in games:
            k = "branch" if x["parent"] else "fresh"
            g[x["class"]][f"{k} games"] += 1
            g[x["class"]][f"{k} deaths"] += int(bool(x.get("dead")))
            g[x["class"]][f"{k} actions"] += x.get("actions") or 0
        rep = {"hours": round((time.time() - self.run.state["started"]) / 3600, 2), "games": len(games),
               "savepoints": {c: dict(v) for c, v in sorted(by.items())},
               "games_by_class": {c: dict(v) for c, v in sorted(g.items())},
               "lineages_branched": len(self.h["lineage_branches"]),
               "lineages_dl10_dl15": {c: list(v) for c, v in self.lineages().items()}}
        json.dump(rep, open(os.path.join(self.run.path, "REPORT-harvest.json"), "w"), indent=1)
        return rep


def class_extras(spec):
    """'Cls1/Cls2:a,b;Cls3:c' -> {class: 'a,b'}: flags adopted for some classes only."""
    out = {}
    for part in filter(None, spec.split(";")):
        cls, _, flags = part.partition(":")
        for c in cls.split("/"): out[c] = ",".join(filter(None, [out.get(c), flags]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--hours", type=float, default=2); ap.add_argument("--seed", type=int, default=6000000)
    ap.add_argument("--slots", type=int, default=13); ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--classes", default=CLASSES); ap.add_argument("--casters", default="Mage,Priest,Druid")
    ap.add_argument("--base", default=D24 + ",leavelos,lightout")
    ap.add_argument("--caster-extra", default="spellfx,spellfight")
    ap.add_argument("--class-extra", default="Paladin/Ranger/Rogue:spellfx", help="per-class flags added to RULEFIX: Cls1/Cls2:flag,flag;Cls3:flag (spellfx adopted 2026-10-31)")
    ap.add_argument("--maxa", type=int, default=60000); ap.add_argument("--cap-s", type=int, default=2400)
    ap.add_argument("--min-depth", type=int, default=8); ap.add_argument("--branch-depth", type=int, default=12)
    ap.add_argument("--branches", type=int, default=3); ap.add_argument("--lineage-cap", type=int, default=12)
    ap.add_argument("--quota10", type=int, default=40); ap.add_argument("--quota15", type=int, default=15)
    ap.add_argument("--rotate", action="store_true", help="fresh classes in rotation and branches deepest first (the pilot)")
    a = ap.parse_args()
    if a.smoke: a.maxa, a.cap_s, a.min_depth, a.branch_depth = 3000, 240, 1, 2
    if free_gb(".") < D15.DISK_START_GB:
        sys.exit(f"only {free_gb('.'):.1f} GB free (Linux and host drive); need {D15.DISK_START_GB}")
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    signal.signal(signal.SIGTERM, lambda *_: D.STOP.set())
    app = D.app_dir(run)
    cbin = D.freeze_c(run)
    hv = Harvest(run, a)
    run.log(f"harvest start (smoke={a.smoke}, slots={run.slots}, c_bin={cbin}, port_offset={D.PORT_OFFSET}, free "
            f"{free_gb(run.path):.0f} GB); base {a.base}; casters {a.casters} +{a.caster_extra}; class extra {a.class_extra}; classes {a.classes}; "
            f"maxa {a.maxa}; min depth {a.min_depth}; branch from DL{a.branch_depth} x{a.branches}, lineage cap "
            f"{a.lineage_cap}; quotas DL10+ {a.quota10} DL15+ {a.quota15} lineages per class{' (rotation)' if a.rotate else ''}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    threading.Thread(target=D15.disk_guard, args=(run,), daemon=True).start()
    deadline = run.state["deadline"]

    def worker(slot):
        while not run.stopped() and time.time() < deadline - 5 * 60 and not disk_low(run):
            if slot >= D.THROTTLED_SLOTS and os.path.exists(os.path.join(run.path, "THROTTLE")):
                time.sleep(30); continue
            hv.play(slot, deadline)

    try:
        with cf.ThreadPoolExecutor(run.slots) as ex:
            list(ex.map(worker, range(run.slots)))
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        rep = hv.report()
        run.log(f"harvest finished: {json.dumps(rep)} ({free_gb(run.path):.0f} GB free)")


if __name__ == "__main__":
    main()
