#!/usr/bin/env python3
"""Phase 2 pilot (docs/plan-2026-11-09.md): APW Borg lives on the C engine, headless (angband -mborg -n).

Each life runs in its own directories with BORG_RACE/BORG_CLASS (a fixed birth; angband-c borg-reincarnate.c) and
the default borg.txt settings (borg_plays_risky, borg_cheat_death and borg_munchkin_start FALSE). A life ends at the
death line in borg-log.txt, or at --cap-s wall seconds (censored). Per life, from the Borg's JSON log: deepest
level, highest CL, game turns, the death cause, wall time, and the first arrival at each depth (turn, CL, HP).
RUN/lives.jsonl, one line per life; resumable.

Usage: borg_pilot.py --run runs/borg/<name> [--classes Warrior,Mage,Priest,Druid] [--lives 10] [--slots 6]
                     [--cap-s 1800] [--c-bin PATH]
"""
import argparse, concurrent.futures as cf, glob, json, os, re, shutil, signal, subprocess, threading, time  # noqa: E401

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DEFAULT_BIN = "/home/mph/src/angband-c/build-rd/game/angband"
KILLED = re.compile(r"Killed on level: (\d+) \(max\. (\d+)\) by (.*)")
GAME_TURN = re.compile(r"Turn: (\d+)")  # game turns, as busho's clock (the JSON log's "turn" is the Borg's own count)


def life(run, cbin, cls, i, cap_s):
    d = os.path.join(run, "lives", f"{cls}-{i:03d}")
    shutil.rmtree(d, ignore_errors=True)
    dirs = {k: os.path.join(d, k) for k in ("user", "save", "archive", "scores", "panic")}
    for p in dirs.values(): os.makedirs(p)
    shutil.copy(os.path.join(os.path.dirname(cbin), "..", "..", "src", "borg", "borg.txt"), dirs["user"])
    env = {**os.environ, "BORG_RACE": "Human", "BORG_CLASS": cls}
    args = ["nice", "-n", "10", cbin, "-mborg", "-n"] + [f"-d{k}={v}" for k, v in dirs.items()]
    t0 = time.time()
    p = subprocess.Popen(args, cwd=os.path.dirname(cbin), env=env, stdout=open(os.path.join(d, "out.txt"), "w"),
                         stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    dead, cause = False, None
    txt = os.path.join(dirs["archive"], "borg-log.txt")
    while p.poll() is None and time.time() - t0 < cap_s:
        time.sleep(2)
        if os.path.exists(txt):
            m = KILLED.search(open(txt, errors="replace").read())
            if m: dead, cause = True, m.group(3); break
    try: os.killpg(p.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: p.wait(timeout=20)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL); p.wait()
    wall = time.time() - t0
    rows = []
    for f in sorted(glob.glob(os.path.join(dirs["archive"], "borg-log-*.json"))):
        try: rows += json.load(open(f))
        except ValueError: pass
    arrive, maxd, maxcl, last = {}, 0, 0, rows[-1] if rows else {}
    for r in rows:
        dp = r.get("depth", 0)
        maxd = max(maxd, dp); maxcl = max(maxcl, r.get("playerLevel", 0))
        if dp > 0 and dp not in arrive: arrive[dp] = {"turn": r.get("turn"), "cl": r.get("playerLevel"), "mhp": r.get("mhp")}
    game_turn = None
    if os.path.exists(txt):
        t = open(txt, errors="replace").read()
        m = KILLED.search(t)
        if m: dead, cause = True, m.group(3); maxd = max(maxd, int(m.group(2)))
        g = GAME_TURN.search(t)
        if g: game_turn = int(g.group(1))
    rec = {"class": cls, "life": i, "dead": dead, "cause": cause, "max_depth": maxd, "max_cl": maxcl,
           "game_turns": game_turn, "borg_turns": last.get("turn"), "entries": len(rows), "wall_s": round(wall), "censored": not dead, "arrive": arrive}
    for f in glob.glob(os.path.join(dirs["archive"], "borg-log-*.json")) + [os.path.join(dirs["user"], "borg_action_local.csv")]:
        if os.path.exists(f): subprocess.run(["gzip", "-f", f])  # keep, compressed
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--classes", default="Warrior,Mage,Priest,Druid")
    ap.add_argument("--lives", type=int, default=10); ap.add_argument("--slots", type=int, default=6)
    ap.add_argument("--cap-s", type=int, default=1800); ap.add_argument("--c-bin", default=DEFAULT_BIN)
    a = ap.parse_args()
    os.makedirs(a.run, exist_ok=True)
    out = os.path.join(a.run, "lives.jsonl")
    done = {(r["class"], r["life"]) for r in map(json.loads, open(out))} if os.path.exists(out) else set()
    jobs = [(c, i) for i in range(a.lives) for c in a.classes.split(",") if (c, i) not in done]
    lock = threading.Lock()

    def one(job):
        r = life(a.run, a.c_bin, *job, a.cap_s)
        with lock:
            with open(out, "a") as f: f.write(json.dumps(r) + "\n")
        print(json.dumps({k: r[k] for k in ("class", "life", "dead", "max_depth", "max_cl", "game_turns", "wall_s", "cause")}), flush=True)

    with cf.ThreadPoolExecutor(a.slots) as ex: list(ex.map(one, jobs))


if __name__ == "__main__":
    main()
