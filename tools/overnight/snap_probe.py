#!/usr/bin/env python3
"""Read the character's deepest level (player.maxDepth) at each labelled decision from its C snapshot, for labels
made before records logged it (Fable's 11-11 note: measure progress from the deepest level so far, PH's clock).

Each record's snapshot (DIR/snap/...json.gz, {"save": "<c-savefile-1 JSON>"}) is loaded in a fresh C game
(angband -mhttp --load), /state is read, and the game quits. Writes OUT with meta.max_depth added.

DIR holds m1_select.py's check.jsonl/train.jsonl (they give each (game_id, turn) its snapshot) and snap/.

Usage: snap_probe.py LABELS.jsonl DIR OUT.jsonl [--c-bin PATH] [--port0 7900] [--workers 8]
"""
import argparse, base64, concurrent.futures as cf, gzip, json, os, subprocess, tempfile, time, urllib.request  # noqa: E401

DEFAULT_BIN = "/home/mph/src/angband-c/build-rd/game/angband"


def probe(cbin, port, snap_path):
    snap = json.load(gzip.open(snap_path))
    save = json.loads(snap["save"]) if isinstance(snap["save"], str) else snap["save"]
    with tempfile.TemporaryDirectory() as udir:
        sav = os.path.join(udir, "probe.sav")
        open(sav, "wb").write(base64.b64decode(save["data"]))
        open(os.path.join(udir, "lore.txt"), "wb").write(base64.b64decode(save.get("lore") or ""))
        p = subprocess.Popen([cbin, "-mhttp", f"-duser={udir}", "--", "--port", str(port), "--load", sav, "--seed", "1"],
                             cwd=os.path.dirname(cbin), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(250):
                if p.poll() is not None: return None
                try:
                    st = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/state", timeout=2))
                    return {"max_depth": st["player"].get("maxDepth"), "depth": st.get("depth")}
                except Exception: time.sleep(0.02)
            return None
        finally:
            try: urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/quit", data=b"{}", method="POST"), timeout=2)
            except Exception: pass
            try: p.wait(timeout=3)
            except subprocess.TimeoutExpired: p.kill(); p.wait()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("labels"); ap.add_argument("dir"); ap.add_argument("out")
    ap.add_argument("--c-bin", default=DEFAULT_BIN); ap.add_argument("--port0", type=int, default=7900)
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    recs = [json.loads(l) for l in open(a.labels) if l.strip()]
    snaps = {}
    for f in ("check.jsonl", "train.jsonl"):
        p = os.path.join(a.dir, f)
        if os.path.exists(p):
            for l in open(p):
                x = json.loads(l); snaps[(x["game_id"], x["turn"])] = x["snapshot"]
    ports = list(range(a.port0, a.port0 + a.workers)); free = list(ports)
    import threading
    lock = threading.Lock()

    def one(r):
        with lock: port = free.pop()
        try:
            m = r.get("meta") or r
            snap = snaps.get((m["game_id"], m["turn"]))
            return probe(os.path.abspath(a.c_bin), port, os.path.join(a.dir, snap)) if snap else None
        finally:
            with lock: free.append(port)

    with cf.ThreadPoolExecutor(a.workers) as ex: res = list(ex.map(one, recs))
    ok = 0
    with open(a.out, "w") as fh:
        for r, x in zip(recs, res):
            if x and x["max_depth"] is not None:
                (r.setdefault("meta", {}))["max_depth"] = x["max_depth"]; ok += 1
            fh.write(json.dumps(r) + "\n")
    print(json.dumps({"records": len(recs), "probed": ok}))


if __name__ == "__main__":
    main()
