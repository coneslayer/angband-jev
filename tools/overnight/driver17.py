#!/usr/bin/env python3
"""Session 17: a sequential rule screen judged by PH(10), then a confirmation of the winners on new starts.

See docs/finetune-laya-plan.md, "Measurement: a score without the action cap" and "Session 17". Honest view
(PLAYER_VIEW=1), C engine. Replaces the cancelled 16-hour model tournament (finalQ).

  canaryQ  the base rules on the 20 session 14 starts that session 16's ruleP replayed (its rules+ arm; confirmP was
           skipped, as nothing was adopted): at least 18 identical to ruleP's games, or nothing else runs (the merged
           variants, the danger log and the C engine's new levelFeeling must not change default play).
  screenQ  new starts (fresh --seed+, bank --seed+50000, 4 to 1). Each start plays the base and every variant still
           open (sling only on classes without a launcher). Each variant is tested with hazard.screen (looks at 150,
           300 and 700 complete pairs) and closes on adopt or reject, freeing its games for the rest.
  confirmQ the base against base + the adopted variants on new starts (--seed+100000, bank +150000), with the same
           looks. Adopt means a new default.

Every game writes a danger log (DANGER_LOG=1, about 13 bytes an action) for the learned danger model.
Disk guard as session 15; replays and snapshots are deleted after each game. Resumable via RUN/state.json;
`touch RUN/STOP` stops between games. Never restart it mid-stage.

Usage: driver17.py --run runs/session17/<date> --prior5 runs/session5/2026-10-16 --prior16 runs/session16/<date>
       --base RULEFIX --canary-arm ARM --variants a,b,c [--seed 3600000] [--hours 52] [--screen-hours 24]
       [--canary-stage ruleP] [--canary-starts finalM:3200000] [--slots 13] [--smoke]
Session 18 reuses it: --prior16 is then session 17's run, with --canary-stage confirmQ --canary-arm combo
--canary-starts confirmQ:3700000.
"""
import argparse, json, os, shutil, signal, sys, threading, time, types  # noqa: E401
import concurrent.futures as cf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import driver6 as D6  # noqa: E402
import driver8 as D8  # noqa: E402
import driver14 as D14  # noqa: E402
import driver15 as D15  # noqa: E402
import evaluate  # noqa: E402
import hazard as H  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
D.SCHEDULE = [("canaryQ", 1), ("screenQ", 24), ("confirmQ", 27)]
D6.SMOKE_MINUTES.update({"canaryQ": 10, "screenQ": 14, "confirmQ": 10})
CANARY_N, CANARY_MIN = 20, 18
N_STARTS = 1200                  # more than the 700 a variant can use; the stage ends when every variant has closed
NO_LAUNCHER = ("Warrior", "Rogue", "Paladin", "Blackguard")  # sling: Rangers start with a bow
SMOKE_LOOKS = (3, 6, 9)
ok, free_gb, disk_low = D14.ok, D15.free_gb, D15.disk_low


def starts(run, rng, seed):
    D8.STARTS, D8.N_STARTS = {"rng": rng, "fresh": seed, "bank": seed + 50000}, N_STARTS
    return D8.starts_for(run)


def play_one(run, stage, s, arm, rulefix, slot, deadline):
    cap, maxa = (600, 15000) if s["restore"] else (900, 20000)
    if run.smoke: cap, maxa = 240, 1500
    env = {**D8.arm_env({"name": arm, "ckpt": None, "guard": "", "caution": 1.0}, {}), "RULEFIX": rulefix,
           "DANGER_LOG": "1",  # the learned danger model's training data (tools/danger); play is unchanged
           **({"DANGER_MODEL": run.danger_model} if run.danger_model else {})}  # read only by RULEFIX=dangerml
    out = run.d(stage, arm, s["id"])
    res = D.play_game(run, f"{stage}-{arm}", slot, s["seed"], s["cls"], env, out,
                      max(60, min(cap, deadline - time.time())), maxa, 4100, None, s["restore"])
    run.log(f"{stage}-{arm}: {s['id']}: {res}")
    for f in ("busho-replay.jsonl", "snapshots"):
        p = os.path.join(out, f)
        if os.path.isdir(p): shutil.rmtree(p, ignore_errors=True)
        elif os.path.exists(p): os.remove(p)
    return res


def pool(run, deadline, next_job):
    """Run next_job() -> (start, arm, rulefix) | None on every slot until it returns None or time runs out."""
    def worker(slot):
        while not run.stopped() and time.time() < deadline - 5 * 60 and not disk_low(run):
            job = next_job()
            if job is None: return
            s, arm, rulefix, stage = job
            play_one(run, stage, s, arm, rulefix, slot, deadline)
    with cf.ThreadPoolExecutor(run.slots) as ex:
        list(ex.map(worker, range(run.slots)))


def stage_canary(run, name, deadline):
    prior = D14.load_outcomes(os.path.join(run.prior16, "driver.log"), f"{run.canary_stage}-").get(run.canary_arm) or {}
    ids = [i for i in sorted(prior) if ok(prior[i])][:2 if run.smoke else CANARY_N]
    if not ids: return {"failed": f"no {run.canary_stage} games for arm {run.canary_arm} in {run.prior16}"}
    D8.STARTS, D8.N_STARTS = run.canary_starts, N_STARTS  # the prior stage's starts
    by_id = {s["id"]: s for s in D8.starts_for(types.SimpleNamespace(smoke=False, path=run.path, prior=run.prior))}
    jobs = iter([(by_id[i], "base", run.base, name) for i in ids if i in by_id])
    lock = threading.Lock()

    def nxt():
        with lock: return next(jobs, None)
    pool(run, deadline, nxt)
    got = D14.load_outcomes(run.d("driver.log"), f"{name}-")["base"]
    done = [i for i in ids if ok(got.get(i))]
    same = sum(D14.fingerprint(got[i]) == D14.fingerprint(prior[i]) for i in done)
    need = 2 if run.smoke else CANARY_MIN
    res = {"arm": run.canary_arm, "n": len(done), "identical": same, "passed": same >= need}
    return res if res["passed"] else {**res, "failed": f"only {same} of {len(done)} replays identical"}


class Screen:
    """Paired arms on a list of starts, each variant closed by hazard.screen at its looks."""

    def __init__(self, run, stage, starts, base, variants, looks):
        self.run, self.stage, self.starts, self.base, self.looks = run, stage, starts, base, looks
        self.variants = variants  # {arm: (rulefix, eligible(start) -> bool)}
        st = run.state["stages"][stage]
        self.closed = st.setdefault("closed", {})   # arm -> verdict (kept across a restart)
        self.checked = st.setdefault("checked", {})  # arm -> last look checked
        self.lock, self.pos, self.queue, self.parsed = threading.RLock(), 0, [], {}
        self.outcomes = D14.load_outcomes(run.d("driver.log"), f"{stage}-")  # a restart skips played games

    def open(self):
        return [a for a in self.variants if a not in self.closed]

    def next_job(self):
        with self.lock:
            while not self.queue:
                if not self.open() or self.pos >= len(self.starts): return None
                s = self.starts[self.pos]; self.pos += 1
                want = [a for a in self.open() if self.variants[a][1](s)]
                if not want: continue
                if s["id"] not in self.outcomes["base"]: self.queue.append((s, "base", self.base, self.stage))
                self.queue += [(s, a, self.variants[a][0], self.stage) for a in want if s["id"] not in self.outcomes[a]]
            return self.queue.pop(0)

    def games(self, arm, ids):
        """Parsed games (hazard.parse_game) of an arm on the given starts, cached."""
        cache = self.parsed.setdefault(arm, {})
        for i in ids:
            if i not in cache: cache[i] = H.parse_game(self.run.d(self.stage, arm, i))
        return {i: cache[i] for i in ids if cache[i]}

    def check(self, final=False):
        """Test every open variant that has reached its next look (or every one, at the end)."""
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
                r = H.screen(self.games("base", ids), self.games(a, ids), look=look, looks=self.looks)
                self.checked[a] = look
                self.run.log(f"{self.stage}: {a} look {look} ({len(ids)} pairs): {json.dumps(r)}")
                if r["decision"] != "continue" or final:
                    if r["decision"] == "continue": r["decision"] = "unresolved"
                    self.closed[a] = {**r, "capped": D14.compare(got["base"], got[a], ids)}
                self.run.save()

    def run_until(self, deadline):
        stop = threading.Event()

        def monitor():
            while not stop.wait(60):
                try: self.check()
                except Exception as e: self.run.log(f"{self.stage}: check failed: {e!r}")
        t = threading.Thread(target=monitor, daemon=True); t.start()
        pool(self.run, deadline, self.next_job)
        stop.set(); t.join()
        self.check(final=True)
        return {"closed": self.closed}


def stage_screen(run, name, deadline):
    ss = starts(run, "screenQ", run.seed)
    variants = {}
    for v in run.variants:
        elig = (lambda s: s["restore"] is None and s["cls"] in NO_LAUNCHER) if v == "sling" else (lambda s: True)
        variants[v] = (f"{run.base},{v}", elig)
    res = Screen(run, name, ss, run.base, variants, SMOKE_LOOKS if run.smoke else H.LOOKS).run_until(deadline)
    res["adopted"] = [v for v in run.variants if (res["closed"].get(v) or {}).get("decision") == "adopt"]
    if run.smoke and not res["adopted"]: res["adopted"] = run.variants[:2]  # exercise confirmQ
    return res


def stage_confirm(run, name, deadline):
    r = run.state["stages"]["screenQ"].get("result") or {}
    if not r.get("adopted"): return {"skipped": "no variant adopted"}
    combo = f"{run.base},{','.join(r['adopted'])}"
    ss = starts(run, "confirmQ", run.seed + 100000)
    res = Screen(run, name, ss, run.base, {"combo": (combo, lambda s: True)},
                 SMOKE_LOOKS if run.smoke else H.LOOKS).run_until(deadline)
    c = res["closed"].get("combo") or {}
    return {"rulefix": combo, **c, "new_default": c.get("decision") == "adopt"}


D6.KINDS.update({"canaryQ": stage_canary, "screenQ": stage_screen, "confirmQ": stage_confirm})


def main():
    ap = argparse.ArgumentParser()
    for p in ("--run", "--prior5", "--prior16", "--base", "--canary-arm", "--variants"): ap.add_argument(p, required=True)
    ap.add_argument("--seed", type=int, default=3600000)
    ap.add_argument("--danger-model", default="", help="model.json(s) from danger.py, copied into RUN; every game "
                    "loads them (predictions go to the danger log; only RULEFIX=dangerml acts on them)")
    ap.add_argument("--canary-stage", default="ruleP", help="the stage of --prior16 whose games canaryQ replays")
    ap.add_argument("--canary-starts", default="finalM:3200000", help="that stage's starts, RNG:FRESH (bank +50000)")
    ap.add_argument("--hours", type=float, default=52); ap.add_argument("--screen-hours", type=float, default=24)
    ap.add_argument("--slots", type=int, default=13); ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    if free_gb(".") < D15.DISK_START_GB:
        sys.exit(f"only {free_gb('.'):.1f} GB free; need {D15.DISK_START_GB}")
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior = run.prior5 = os.path.abspath(a.prior5)  # run.prior: session 5's C bank (D2.bank_files)
    run.prior16 = os.path.abspath(a.prior16)
    run.danger_model = ""
    if a.danger_model:
        dst = [os.path.join(run.path, f"danger-model-{i}.json") for i, _ in enumerate(a.danger_model.split(","))]
        for src, d in zip(a.danger_model.split(","), dst):
            if not os.path.exists(d): shutil.copy(src, d)
        run.danger_model = ",".join(dst)
    rng, fresh = a.canary_starts.split(":")
    run.canary_stage, run.canary_starts = a.canary_stage, {"rng": rng, "fresh": int(fresh), "bank": int(fresh) + 50000}
    run.base, run.canary_arm, run.variants, run.seed = a.base, a.canary_arm, a.variants.split(","), a.seed
    signal.signal(signal.SIGTERM, lambda *_: D.STOP.set())
    app = D.app_dir(run)  # first: freezing the source recreates RUN/src
    cbin = D.freeze_c(run)
    run.log(f"driver17 start (smoke={a.smoke}, slots={run.slots}, c_bin={cbin}, port_offset={D.PORT_OFFSET}, "
            f"free {free_gb(run.path):.0f} GB); base {run.base}; variants {run.variants}; seed {run.seed}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    threading.Thread(target=D15.disk_guard, args=(run,), daemon=True).start()
    t0, end = run.state["started"], run.state["deadline"]
    canary_end, screen_end = t0 + 3600, t0 + 3600 + a.screen_hours * 3600
    if a.smoke: canary_end, screen_end = time.time() + 10 * 60, time.time() + 24 * 60
    try:
        D6.run_stage(run, "canaryQ", canary_end, a.smoke)
        if (run.state["stages"]["canaryQ"].get("status")) != "done":
            run.log("canary failed: not screening"); return
        D6.run_stage(run, "screenQ", screen_end, a.smoke)
        D6.run_stage(run, "confirmQ", end - 10 * 60, a.smoke)
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        D.write_report(run)
        run.log(f"driver17 finished ({free_gb(run.path):.0f} GB free)")


if __name__ == "__main__":
    main()
