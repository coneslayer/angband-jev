#!/usr/bin/env python3
"""Keep one laya-serve up on the GPU for decision-model play arms (driver18 "model:laya"), until killed.

Serves --model (a bundled base, default english) and, with --ckpt, a fine-tuned checkpoint registered as --name.
Writes its PID to --pidfile; ready once /health answers. One Laya server on the GPU at a time.

Usage: laya_serve.py [--port 8010] [--model english] [--ckpt DIR --name m1-ft] [--pidfile PATH] [--log PATH]
"""
import argparse, json, os, signal, subprocess, sys, time, urllib.request  # noqa: E401

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("OVN_NATIVE", "1")
from evaluate import venv_bin  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8010); ap.add_argument("--model", default="english")
    ap.add_argument("--ckpt"); ap.add_argument("--name", default="m1-ft")
    ap.add_argument("--pidfile"); ap.add_argument("--log", default="laya-serve.log")
    a = ap.parse_args()
    models = [a.model] + ([a.name] if a.ckpt else [])
    env = {**os.environ, "LAYA_HOST": "127.0.0.1", "LAYA_PORT": str(a.port), "LAYA_DEVICE": "cuda",
           "LAYA_DEFAULT_MODEL": a.model, "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
           "LAYA_MAX_LOADED": str(len(models)), "LAYA_MODELS": ",".join(models),
           **({"LAYA_EXTRA_MODELS": json.dumps({a.name: os.path.abspath(a.ckpt)})} if a.ckpt else {})}
    p = subprocess.Popen([venv_bin("laya-serve")], env=env, stdout=open(a.log, "w"), stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    if a.pidfile: open(a.pidfile, "w").write(str(p.pid))
    for _ in range(240):
        try: urllib.request.urlopen(f"http://127.0.0.1:{a.port}/health", timeout=5); print("ready", flush=True); break
        except Exception: time.sleep(2)
        if p.poll() is not None: sys.exit(f"laya-serve exited (see {a.log})")
    else:
        os.killpg(p.pid, signal.SIGTERM); sys.exit("laya-serve did not come up")
    signal.signal(signal.SIGTERM, lambda *_: (os.killpg(p.pid, signal.SIGTERM), sys.exit(0)))
    p.wait()


if __name__ == "__main__":
    main()
