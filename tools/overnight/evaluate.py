#!/usr/bin/env python3
"""Score a Laya checkpoint on held-out rollout labels, against simple baselines.

Serves the checkpoint with laya-serve (angband-jev-laya image) and asks every held-out
record's question. Metrics per decision type and overall:
  acc       argmax matches the rollout winner (any of the tied winners counts)
  p_gold    probability the model puts on the rollout winner(s)
  brier     multi-class Brier score against the rollout distribution
Baselines from the same records: the rules player's choice (meta.rules_choice), the
majority winner in the training data, and optionally the untuned base checkpoint.

Usage: evaluate.py --heldout heldout.jsonl --ckpt DIR [--train train.jsonl] [--base english]
                   [--out metrics.json]
"""
import argparse, collections, json, os, signal, subprocess, sys, time, urllib.request

IMAGE = "angband-jev-laya"
MODELS_VOLUME = "laya-eval-models"
NAME = "angband-vanilla"
PRELOAD = f"{NAME},english"  # all three bundled checkpoints would take ~9.8 GB of the 10 GB GPU
NATIVE = os.environ.get("OVN_NATIVE") == "1"  # host laya-serve from the pipenv environment, no Docker


def venv_bin(tool):
    """A console script from the tools/overnight/native pipenv environment."""
    d = os.environ.get("OVN_VENV_BIN")
    if not d:
        here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "native")
        venv = subprocess.run(["pipenv", "--venv"], cwd=here, capture_output=True, text=True,
                              env={**os.environ, "PIPENV_VERBOSITY": "-1"}).stdout.strip()
        d = os.path.join(venv, "bin")
    return os.path.join(d, tool)


class LayaServer:
    """laya-serve in a container with one extra checkpoint registered as NAME."""

    def __init__(self, ckpt, port=8010, container="ovn-laya-eval"):
        self.ckpt, self.port, self.container = os.path.abspath(ckpt), port, container
        self.url = f"http://localhost:{port}"

    def __enter__(self):
        if NATIVE: return self._start_native()
        subprocess.run(["docker", "rm", "-f", self.container], capture_output=True)
        subprocess.run(["docker", "run", "-d", "--name", self.container, "--gpus", "all",
                        "-p", f"127.0.0.1:{self.port}:8000", "-v", f"{MODELS_VOLUME}:/models/hf",
                        "-v", f"{self.ckpt}:/ckpt:ro", "-e", "HF_HOME=/models/hf",
                        "-e", json_env("LAYA_EXTRA_MODELS", {NAME: "/ckpt"}),
                        "-e", "LAYA_MAX_LOADED=3", "-e", f"LAYA_MODELS={PRELOAD}", IMAGE], check=True, capture_output=True)
        for _ in range(240):
            try:
                urllib.request.urlopen(f"{self.url}/health", timeout=5); return self
            except Exception:
                time.sleep(2)
        raise RuntimeError(f"laya-serve did not come up: {logs(self.container)}")

    def _start_native(self):
        log_path = os.path.join(os.path.dirname(self.ckpt), f"{self.container}.log")
        env = {**os.environ, "LAYA_HOST": "127.0.0.1", "LAYA_PORT": str(self.port), "LAYA_DEVICE": "cuda",
               "LAYA_DEFAULT_MODEL": "english", "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
               "LAYA_MAX_LOADED": "3", "LAYA_MODELS": PRELOAD, "LAYA_EXTRA_MODELS": json.dumps({NAME: self.ckpt})}
        with open(log_path, "w") as log:
            self.proc = subprocess.Popen([venv_bin("laya-serve")], env=env, stdout=log, stderr=subprocess.STDOUT,
                                         stdin=subprocess.DEVNULL, start_new_session=True)
        for _ in range(240):
            if self.proc.poll() is not None: break
            try:
                urllib.request.urlopen(f"{self.url}/health", timeout=5); return self
            except Exception:
                time.sleep(2)
        self.__exit__()
        raise RuntimeError(f"laya-serve did not come up: {open(log_path).read()[-2000:]}")

    def __exit__(self, *exc):
        if NATIVE:
            try: os.killpg(self.proc.pid, signal.SIGTERM); self.proc.wait(timeout=30)
            except Exception:
                try: os.killpg(self.proc.pid, signal.SIGKILL)
                except Exception: pass
            return
        subprocess.run(["docker", "rm", "-f", self.container], capture_output=True)

    def ask(self, model, state, questions, retries=5):
        body = json.dumps({"model": model, "state": state, "questions": questions}).encode()
        for attempt in range(retries):
            try:
                req = urllib.request.Request(f"{self.url}/v1/systemone", body, {"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    return json.load(r)["answers"]
            except Exception as e:  # a GPU memory spike can fail a request; laya also falls back to CPU
                if attempt == retries - 1: raise
                time.sleep(10 * (attempt + 1))


def json_env(k, v):
    return f"{k}={json.dumps(v)}"


def logs(container):
    return subprocess.run(["docker", "logs", "--tail", "20", container], capture_output=True, text=True).stderr


def winners(gold):
    top = max(gold.values())
    return {k for k, p in gold.items() if p >= top - 1e-9}


def score(records, predict):
    """predict(record) -> probabilities dict, or a single option name for a baseline."""
    by = collections.defaultdict(lambda: {"n": 0, "acc": 0.0, "p_gold": 0.0, "brier": 0.0})
    for r in records:
        gold = r["gold"]["decision"]["probabilities"]
        win = winners(gold)
        pred = predict(r)
        probs = pred if isinstance(pred, dict) else {k: float(k == pred) for k in gold}
        choice = max(probs, key=probs.get)
        for key in (r["meta"]["decision_type"], "all"):
            m = by[key]; m["n"] += 1
            m["acc"] += choice in win
            m["p_gold"] += sum(probs.get(k, 0.0) for k in win)
            m["brier"] += sum((probs.get(k, 0.0) - gold[k]) ** 2 for k in gold)
    return {k: {"n": m["n"], **{x: round(m[x] / m["n"], 4) for x in ("acc", "p_gold", "brier")}}
            for k, m in by.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--heldout", required=True); ap.add_argument("--ckpt", required=True)
    ap.add_argument("--train"); ap.add_argument("--base", default="english")
    ap.add_argument("--out"); ap.add_argument("--port", type=int, default=8010)
    a = ap.parse_args()
    records = [json.loads(l) for l in open(a.heldout) if l.strip()]
    result = {"heldout": len(records)}

    result["rules"] = score(records, lambda r: r["meta"].get("rules_choice"))
    if a.train:  # majority rollout winner per decision type in the training data
        counts = collections.defaultdict(collections.Counter)
        for l in open(a.train):
            r = json.loads(l); g = r["gold"]["decision"]["probabilities"]
            counts[r["meta"]["decision_type"]][max(g, key=g.get)] += 1
        result["majority"] = score(records, lambda r: counts[r["meta"]["decision_type"]].most_common(1)[0][0])

    with LayaServer(a.ckpt, a.port) as srv:
        for label, model in (("model", NAME), ("base", a.base)):
            if not model: continue
            t0 = time.time()
            result[label] = score(records, lambda r: srv.ask(model, r["state"], r["questions"])["decision"]["probabilities"])
            result[label]["seconds"] = round(time.time() - t0, 1)
        result["cpu_fallbacks"] = json.load(urllib.request.urlopen(f"{srv.url}/health")).get("cpu_fallbacks")

    text = json.dumps(result, indent=1)
    print(text)
    if a.out:
        with open(a.out, "w") as f: f.write(text)


if __name__ == "__main__":
    sys.exit(main())
