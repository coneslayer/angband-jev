#!/usr/bin/env python3
"""M1: Laya's answers on a label set's decisions (docs/plan-2026-11-09.md): zero-shot (a bundled base model) or a
fine-tuned checkpoint. Starts laya-serve natively (the tools/overnight/native pipenv) with only that model loaded,
on the GPU (at most one Laya server at a time), and writes {game_id, turn, choice, probabilities, confidence} to OUT
for m1_offline.py score.

Usage: m1_laya.py LABELS.jsonl OUT.jsonl [--model english | --ckpt DIR] [--port 8010]
"""
import argparse, json, os, signal, subprocess, sys, time, urllib.request  # noqa: E401

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from evaluate import venv_bin  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("labels"); ap.add_argument("out")
    ap.add_argument("--model", default="english"); ap.add_argument("--ckpt")
    ap.add_argument("--port", type=int, default=8010 + int(os.environ.get("OVN_PORT_OFFSET", "0")))
    a = ap.parse_args()
    recs = [json.loads(l) for l in open(a.labels) if l.strip()]
    name = "m1-ckpt" if a.ckpt else a.model
    env = {**os.environ, "LAYA_HOST": "127.0.0.1", "LAYA_PORT": str(a.port), "LAYA_DEVICE": "cuda",
           "LAYA_DEFAULT_MODEL": name, "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True", "LAYA_MAX_LOADED": "1",
           "LAYA_MODELS": name, **({"LAYA_EXTRA_MODELS": json.dumps({name: os.path.abspath(a.ckpt)})} if a.ckpt else {})}
    log = open(a.out + ".serve.log", "w")
    proc = subprocess.Popen([venv_bin("laya-serve")], env=env, stdout=log, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, start_new_session=True)
    url = f"http://127.0.0.1:{a.port}"
    try:
        for _ in range(240):
            try: urllib.request.urlopen(f"{url}/health", timeout=5); break
            except Exception: time.sleep(2)
        else: sys.exit("laya-serve did not come up (see .serve.log)")
        t0, ok = time.time(), 0
        with open(a.out, "w") as f:
            for r in recs:
                body = json.dumps({"model": name, "state": r["state"], "questions": r["questions"]}).encode()
                d = None
                for attempt in range(4):
                    try:
                        req = urllib.request.Request(f"{url}/v1/systemone", body, {"Content-Type": "application/json"})
                        d = json.load(urllib.request.urlopen(req, timeout=120))["answers"]["decision"]; break
                    except Exception:
                        time.sleep(5 * (attempt + 1))
                ok += d is not None
                f.write(json.dumps({"game_id": (r.get("meta") or r)["game_id"], "turn": (r.get("meta") or r)["turn"], "choice": d and d.get("choice"),
                                    "probabilities": d and d.get("probabilities"), "confidence": d and d.get("confidence"),
                                    "ok": d is not None}) + "\n")
        print(json.dumps({"records": len(recs), "answered": ok, "model": name, "seconds": round(time.time() - t0, 1)}))
    finally:
        os.killpg(proc.pid, signal.SIGTERM)
        try: proc.wait(timeout=30)
        except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL)


if __name__ == "__main__":
    main()
