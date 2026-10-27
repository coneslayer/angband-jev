#!/usr/bin/env python3
"""Session 17, part 1 (16 h): the model on the final default rules, in one large tournament.

See docs/finetune-laya-plan.md, "Session 17". Honest view (PLAYER_VIEW=1), C engine. rules+ is busho's default
RULEFIX (session 16's final default); the model arm is session 16's choice (trainH, trainO or trainO2 by weighted
gate score), gated as H-c10 (confidence >= 0.1, oil/potion guard, cooldown fight=150,tactic=50).

  finalQ    (CPU + GPU serving, 16 h)  new seeds (fresh 3500000+, bank 3550000+), 4 fresh to 1 bank: rules+, the
                        model arm and rules+-replay on the first 24 starts. Every game's replay and snapshots are
                        deleted once played (a 16-hour tournament would otherwise fill about 50 GB).

Promotion as in session 11 (one model arm): W > L and one-sided sign p < 0.05 on the complete starts.
Disk guard as session 15. Resumable via RUN/state.json; `touch RUN/STOP` stops. Never restart it mid-stage.

Usage: driver17.py --run runs/session17/<date> --prior5 runs/session5/2026-10-16 --prior10 runs/session10/2026-10-21
       --prior16 runs/session16/<date> [--hours 16] [--slots 13] [--smoke]
"""
import argparse, json, os, shutil, signal, sys, threading  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import driver3 as D3  # noqa: E402
import driver6 as D6  # noqa: E402
import driver8 as D8  # noqa: E402
import driver10 as D10  # noqa: E402
import driver13 as D13  # noqa: E402
import driver15 as D15  # noqa: E402
import evaluate  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
D8.STARTS = {"rng": "finalQ", "fresh": 3500000, "bank": 3550000}
D8.N_STARTS = 5000  # more than fit: the stage runs to its deadline
D8.HEAD_TO_HEAD = ()
D.SCHEDULE = [("finalQ", 16)]
D6.SMOKE_MINUTES.update({"finalQ": 15})
PROMOTE_P = 0.05


def model(run):
    """Session 16's choice: (arm name, checkpoint)."""
    c = json.load(open(os.path.join(run.prior16, "state.json")))["stages"]["trainO2"]["result"]["choice"]
    return {"trainH": "H", "trainO": "O", "trainO2": "O2"}[c["chosen"]] + "-c10", c.get("ckpt") or D13.trainH(run)


def arms_for(run):
    name, ckpt = model(run)
    m = {"guard": "oil,potion", "caution": 1.0, "min_conf": str(D13.GATE), "cooldown": D8.LABEL_COOLDOWN}
    return [{"name": "rules+", "ckpt": None, "guard": "", "caution": 1.0}, {"name": name, "ckpt": ckpt, **m},
            {"name": "rules+-replay", "ckpt": None, "guard": "", "caution": 1.0, "replay": True}]


D8.arms_for = D10.arms_for = arms_for
_play_game = D.play_game


def play_game(run, tag, slot, seed, cls, env, out_dir, *a, **k):
    """D.play_game, then drop the replay and snapshots (player.log, decisions and the report stay)."""
    res = _play_game(run, tag, slot, seed, cls, env, out_dir, *a, **k)
    for f in ("busho-replay.jsonl", "snapshots"):
        p = os.path.join(out_dir, f)
        if os.path.isdir(p): shutil.rmtree(p, ignore_errors=True)
        elif os.path.exists(p): os.remove(p)
    return res


D.play_game = play_game


def stage_tournament(run, name, deadline):
    res = D10.stage_tournament(run, name, deadline)
    arm = model(run)[0]
    v = res["vs_rules+"].get(arm) or {}
    a = v.get("all") or {}
    res["model"] = {"arm": arm, "ckpt": model(run)[1]}
    res["promote"] = bool(a) and a.get("wins", 0) > a.get("losses", 0) and (v.get("sign_p") or 1) < PROMOTE_P
    return res


D6.KINDS.update({"finalQ": stage_tournament})


def main():
    ap = argparse.ArgumentParser()
    for p in ("--run", "--prior5", "--prior10", "--prior16"): ap.add_argument(p, required=True)
    ap.add_argument("--hours", type=float, default=16); ap.add_argument("--slots", type=int, default=13)
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    if D15.free_gb(".") < D15.DISK_START_GB:
        sys.exit(f"only {D15.free_gb('.'):.1f} GB free; need {D15.DISK_START_GB}")
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior = run.prior5 = os.path.abspath(a.prior5)  # run.prior: session 5's C bank (D2.bank_files)
    run.prior10, run.prior16 = os.path.abspath(a.prior10), os.path.abspath(a.prior16)
    signal.signal(signal.SIGTERM, lambda *_: D.STOP.set())
    app = D.app_dir(run)  # first: freezing the source recreates RUN/src
    cbin = D.freeze_c(run)
    run.log(f"driver17 start (smoke={a.smoke}, slots={run.slots}, c_bin={cbin}, port_offset={D.PORT_OFFSET}, "
            f"free {D15.free_gb(run.path):.0f} GB); model {model(run)}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    threading.Thread(target=D15.disk_guard, args=(run,), daemon=True).start()
    try:
        D6.run_stage(run, "finalQ", run.state["deadline"] - 15 * 60, a.smoke)
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        D.write_report(run)
        run.log(f"driver17 finished ({D15.free_gb(run.path):.0f} GB free)")


if __name__ == "__main__":
    main()
