#!/usr/bin/env python3
"""Session 11 (~12 h): does trainH, gated at confidence 0.1, beat rules+? And with the cooldown off?

See docs/finetune-laya-plan.md, "Session 11". Honest view (PLAYER_VIEW=1), C engine, rules+ (caution +1) under every
arm. Session 10 found trainG gated at 0.1 the closest a model has come (669-627, p = 0.13) and trainH's overrides
right more often than trainG's on held-out labelH. Its labels also say the overrides the cooldown blocks at
confidence >= 0.1 would win.
One stage:
  finalK  tournament until 20 minutes before the end, starts in a fixed order (4 fresh : 1 bank, session 5's bank):
          rules+; H-c10 (trainH, acts only at confidence >= 0.1, label-horizon cooldown, as session 10's G-c10);
          H-c10-nocool (the same without the cooldown); rules+-replay on the first 24 starts.
          Starts complete in every main arm are analysed.
Resumable via RUN/state.json; `touch RUN/STOP` stops between games. Never restart it mid-stage.

Usage: driver11.py --run runs/session11/<name> --prior5 runs/session5/2026-10-16 --prior10 runs/session10/2026-10-21
       [--hours 12] [--smoke] [--slots 13]
"""
import argparse, os, signal, sys, threading  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import driver6 as D6  # noqa: E402
import driver8 as D8  # noqa: E402
import driver10 as D10  # noqa: E402

D.SCHEDULE = [("finalK", 11.7)]
SMOKE_MINUTES = {"finalK": 15}
D8.STARTS = {"rng": "finalK", "fresh": 3000000, "bank": 3050000}
D8.HEAD_TO_HEAD = (("H-c10", "H-c10-nocool"),)


def arms_for(run):
    h = os.path.join(run.prior10, "trainH", "ckpt-e3-s0.final")
    m = {"ckpt": h, "guard": "oil,potion", "caution": 1.0, "min_conf": "0.1"}
    return [{"name": "rules+", "ckpt": None, "guard": "", "caution": 1.0},
            {"name": "H-c10", **m, "cooldown": D8.LABEL_COOLDOWN},
            {"name": "H-c10-nocool", **m},
            {"name": "rules+-replay", "ckpt": None, "guard": "", "caution": 1.0, "replay": True}]


D8.arms_for = D10.arms_for = arms_for  # D10.stage_tournament: D8's tournament plus the gate-binds canary
D6.KINDS["finalK"] = D10.stage_tournament
D6.SMOKE_MINUTES.update(SMOKE_MINUTES)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--prior5", required=True); ap.add_argument("--prior10", required=True)
    ap.add_argument("--hours", type=float, default=12); ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--slots", type=int, default=13)
    a = ap.parse_args()
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior = run.prior5 = os.path.abspath(a.prior5)  # run.prior: session 5's C bank (D2.bank_files)
    run.prior10 = os.path.abspath(a.prior10)
    signal.signal(signal.SIGTERM, lambda *_: D.STOP.set())
    app = D.app_dir(run)  # first: freezing the source recreates RUN/src
    cbin = D.freeze_c(run)
    run.log(f"driver11 start (smoke={a.smoke}, slots={a.slots}, engine={D.ENGINE}, c_bin={cbin}, "
            f"port_offset={D.PORT_OFFSET}); prior5={run.prior5}; prior10={run.prior10}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    end = run.state["deadline"]
    try:
        D6.run_stage(run, "finalK", end - 20 * 60, a.smoke)
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        D.write_report(run)
        run.log("driver11 finished")


if __name__ == "__main__":
    main()
