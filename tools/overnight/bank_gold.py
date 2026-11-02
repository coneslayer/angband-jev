#!/usr/bin/env python3
"""Record each level-entry savepoint's gold in BANK/gold.jsonl ({file, gold}), for driver18 --min-gold.

Loads each savepoint into the C server (build-rd) and reads /state. Resumable: savepoints already in gold.jsonl are
skipped. Ports --port..--port+workers-1.

Usage: bank_gold.py runs/harvest/<run>[,...] [--min-depth 10] [--max-depth 19] [--workers 12] [--port 5600]
"""
import argparse, json, os, shutil, subprocess, sys, tempfile, threading, time, urllib.request  # noqa: E401
import concurrent.futures as cf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402


def gold_of(sp, port, udir):
    shutil.rmtree(udir, ignore_errors=True); os.makedirs(udir)
    sav = D.c_savepoint_files(udir, sp)
    p = subprocess.Popen([D.C_BIN, "-mhttp", f"-duser={udir}", "--", "--port", str(port), "--seed", "1", "--load", sav],
                         cwd=os.path.dirname(D.C_BIN), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    try:
        for _ in range(150):
            try: return json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/state", timeout=2))["player"]["gold"]
            except Exception: time.sleep(0.1)
        return None
    finally:
        p.kill(); p.wait()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("banks"); ap.add_argument("--min-depth", type=int, default=10); ap.add_argument("--max-depth", type=int, default=19)
    ap.add_argument("--workers", type=int, default=12); ap.add_argument("--port", type=int, default=5600)
    a = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix="bank_gold-")
    try:
        for b in a.banks.split(","):
            out = os.path.join(b, "bank", "gold.jsonl")
            done = {json.loads(l)["file"] for l in open(out)} if os.path.exists(out) else set()
            todo = [m["file"] for m in map(json.loads, open(os.path.join(b, "bank", "index.jsonl")))
                    if m.get("kind") == "level-entry" and a.min_depth <= m.get("depth", 0) <= a.max_depth and m["file"] not in done]
            lock, f, n = threading.Lock(), open(out, "a"), [0, 0]

            def one(i):
                w = i % a.workers
                g = gold_of(os.path.join(b, "bank", todo[i]), a.port + w, os.path.join(tmp, f"u{i}"))
                shutil.rmtree(os.path.join(tmp, f"u{i}"), ignore_errors=True)
                with lock:
                    n[g is None] += 1
                    if g is not None: f.write(json.dumps({"file": todo[i], "gold": g}) + "\n"); f.flush()

            with cf.ThreadPoolExecutor(a.workers) as ex:
                # one port per worker: worker w handles i ≡ w (mod workers), in order
                list(ex.map(lambda w: [one(i) for i in range(w, len(todo), a.workers)], range(a.workers)))
            f.close()
            print(f"{b}: {n[0]} recorded, {n[1]} failed, {len(done)} already there")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
