#!/usr/bin/env python3
"""One-off hand-off for session 3: stop the running driver3 between trainC and the final, put the new
busho-player.ts (RULES_CAUTION, default off) into the run's frozen source, and relaunch driver3, whose new
code adds the rules-adj control arm to a 7.5 h final.

The STOP file is touched once trainC has begun. trainC does not read RUN/STOP (train.py watches RUN/trainC/STOP),
so training finishes; the driver then stops at the top of its stage loop, before the final begins.
If the final has already begun when we look, nothing is touched: the final runs as originally planned.

Usage: handoff_final.py --run runs/session3/2026-10-14 --pid <driver3 pid> -- <driver3 relaunch args...>
"""
import argparse, difflib, json, os, re, shutil, subprocess, sys, time  # noqa: E401

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--out", required=True, help="driver stdout file to append to")
    ap.add_argument("relaunch", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    run = os.path.abspath(a.run)
    dlog, stop, hlog = os.path.join(run, "driver.log"), os.path.join(run, "STOP"), open(os.path.join(run, "handoff.log"), "a")

    def log(msg):
        hlog.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n"); hlog.flush()

    def seen(rx): return re.search(rx, open(dlog, errors="replace").read(), re.M) is not None
    alive = lambda: os.path.exists(f"/proc/{a.pid}") and b"driver3.py" in open(f"/proc/{a.pid}/cmdline", "rb").read()  # noqa: E731

    log(f"waiting for trainC to begin (driver pid {a.pid})")
    while not seen(r"stage trainC begins"):
        if seen(r"stage final begins"): log("final already began; leaving it as planned"); return
        if not alive(): log("driver exited before trainC; nothing done"); return
        time.sleep(2)
    if seen(r"stage final begins"): log("final already began; leaving it as planned"); return
    open(stop, "w").write("handoff_final: stop before the final\n")
    log("trainC began; STOP touched")
    time.sleep(3)
    if seen(r"stage final begins"):  # lost the race (trainC skipped instantly): don't cut the final short
        os.remove(stop); log("final began before STOP took effect; STOP removed, final left as planned"); return
    while alive(): time.sleep(5)
    st = json.load(open(os.path.join(run, "state.json")))
    log(f"driver exited; trainC={st['stages'].get('trainC', {}).get('status')} final={st['stages'].get('final')}")
    if st["stages"].get("final"):
        log("final has state; not relaunching (check by hand)"); return

    # new busho-player.ts into the frozen source (both copies the games use), keeping the old one
    src = os.path.join(run, "src")
    new = open(os.path.join(REPO, "tools", "busho-player.ts"), newline="").read()
    old = open(os.path.join(src, "tools", "busho-player.ts"), newline="").read()
    shutil.copy(os.path.join(src, "tools", "busho-player.ts"), os.path.join(src, "busho-player.ts.before-final"))
    open(os.path.join(src, "busho-player.before-final.diff"), "w").write(
        "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), "before-final", "final")))
    for d in (os.path.join(src, "tools"), os.path.join(src, "app", "tools")):
        tmp = os.path.join(d, "busho-player.ts.tmp")
        open(tmp, "w", newline="").write(new); os.replace(tmp, os.path.join(d, "busho-player.ts"))
    log("frozen busho-player.ts updated (RULES_CAUTION); old copy at src/busho-player.ts.before-final")

    os.remove(stop)
    args = [x for x in a.relaunch if x != "--"]
    with open(a.out, "a") as out:
        p = subprocess.Popen([sys.executable, "-I", *args], cwd=REPO, stdout=out, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, start_new_session=True)
    log(f"driver3 relaunched: pid {p.pid}: {' '.join(args)}")


if __name__ == "__main__":
    main()
