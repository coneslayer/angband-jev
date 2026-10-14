#!/usr/bin/env python3
"""Fine-tune Laya on rollout labels, surviving GPU memory spikes from other containers.

Runs laya-train in the angband-jev-laya image. On a CUDA out-of-memory error it waits and
retries, drops to micro-batch 1 after a second failure, and resumes from the last finished
epoch (laya-train saves checkpoint_latest/ after every epoch).

Usage: train.py --data train.jsonl --out DIR [--epochs 4] [--loss soft-ce] [--seed 0]
                [--base english] [--eval-data heldout.jsonl] [--deadline UNIX_TS]
Exit 0 on success; 1 on failure (details in DIR/train.log).
"""
import argparse, os, re, shlex, shutil, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # run with -I
from evaluate import NATIVE, venv_bin  # noqa: E402

IMAGE = "angband-jev-laya"
MODELS_VOLUME = "laya-eval-models"     # Hugging Face cache with the base checkpoints
MIN_FREE_MIB = 7800                    # a micro-batch 2 run peaks about 7.5 GB above idle
OOM = re.compile(r"CUDA out of memory|CUBLAS_STATUS_ALLOC_FAILED|cudaErrorMemoryAllocation")
# Under WSL2 a GPU memory spike can spill into shared system memory and get the process
# SIGKILLed (exit 137) instead of raising a CUDA error, so treat that as retryable too.
RETRYABLE_EXIT = {137, -9}  # -9: a native run killed by the kernel OOM killer
EPOCH_DONE = re.compile(r"^epoch (\d+)/(\d+) mean loss", re.M)


def log(msg, fh=None):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    if fh: fh.write(line + "\n"); fh.flush()


def free_vram_mib():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=30).stdout
        return int(out.split()[0])
    except Exception:
        return -1


def wait_for_vram(fh, deadline, need=MIN_FREE_MIB):
    """Block until enough GPU memory is free; False if the deadline passes first."""
    while True:
        free = free_vram_mib()
        if free >= need: return True
        if time.time() > deadline: return False
        log(f"waiting for GPU memory: {free} MiB free, need {need}", fh)
        time.sleep(30)


def run_once(a, base, out, epochs, micro, accum, fh):
    if NATIVE:
        cmd = [venv_bin("laya-train"), "--data", os.path.abspath(a.data), "--base", base, "--out", out,
               "--max-len", "512", "--epochs", str(epochs), "--micro-batch", str(micro), "--grad-accum", str(accum),
               "--loss", a.loss, "--seed", str(a.seed)]
        if a.eval_data: cmd += ["--eval-data", os.path.abspath(a.eval_data)]
        log(f"run (native): epochs={epochs} micro={micro} accum={accum} base={base}", fh)
        p = subprocess.run(cmd, capture_output=True, text=True, errors="replace",
                           env={**os.environ, "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"})
        text = p.stdout + p.stderr
        fh.write(text); fh.flush()
        return p.returncode, text
    data_dir = os.path.dirname(os.path.abspath(a.data))
    out_parent = os.path.dirname(os.path.abspath(out))
    cmd = ["docker", "run", "--rm", "--gpus", "all", "--name", f"ovn-train-{os.getpid()}",
           "-v", f"{MODELS_VOLUME}:/models/hf", "-e", "HF_HOME=/models/hf",
           "-v", f"{data_dir}:/data:ro", "-v", f"{out_parent}:/out"]
    if base not in ("english", "multilingual", "typed-decisions"):
        cmd += ["-v", f"{os.path.abspath(base)}:/base:ro"]; base = "/base"
    train = ["laya-train", "--data", f"/data/{os.path.basename(a.data)}", "--base", base,
             "--out", f"/out/{os.path.basename(out)}", "--max-len", "512", "--epochs", str(epochs),
             "--micro-batch", str(micro), "--grad-accum", str(accum), "--loss", a.loss, "--seed", str(a.seed)]
    if a.eval_data:
        train += ["--eval-data", f"/data/{os.path.basename(a.eval_data)}"]
    # The container runs as root; hand the output back to the invoking user either way.
    chown = f"chown -R {os.getuid()}:{os.getgid()} /out/{shlex.quote(os.path.basename(out))} 2>/dev/null"
    cmd += [IMAGE, "sh", "-c", f"{shlex.join(train)}; rc=$?; {chown}; exit $rc"]
    log(f"run: epochs={epochs} micro={micro} accum={accum} base={base}", fh)
    p = subprocess.run(cmd, capture_output=True, text=True)
    text = p.stdout + p.stderr
    fh.write(text); fh.flush()
    return p.returncode, text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--eval-data"); ap.add_argument("--base", default="english")
    ap.add_argument("--epochs", type=int, default=4); ap.add_argument("--loss", default="soft-ce")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--deadline", type=float, default=time.time() + 6 * 3600)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    fh = open(os.path.join(a.out, "train.log"), "a")

    # Effective batch 64. Micro-batch 2 peaks at 9.6 of 10.2 GB, too close to the limit when other
    # containers spike (under WSL2 a spill can take down Docker), so start at micro-batch 1.
    micro, accum = 1, 64
    done, base, ooms = 0, a.base, 0
    work = a.out + ".work"
    while done < a.epochs:
        if os.path.exists(os.path.join(os.path.dirname(os.path.abspath(a.out)), "STOP")) or time.time() > a.deadline:
            log("stopped: STOP file or deadline", fh); return 1
        if not wait_for_vram(fh, a.deadline, MIN_FREE_MIB - 1500):
            log("gave up waiting for GPU memory before the deadline", fh); return 1
        shutil.rmtree(work, ignore_errors=True)
        rc, text = run_once(a, base, work, a.epochs - done, micro, accum, fh)
        finished = len(EPOCH_DONE.findall(text))
        if rc == 0 and "Training complete" in text:
            shutil.rmtree(a.out + ".final", ignore_errors=True)
            os.replace(work, a.out + ".final")
            log(f"training complete ({done + finished}/{a.epochs} epochs, {ooms} OOM retries)", fh)
            return 0
        if not OOM.search(text) and rc not in RETRYABLE_EXIT:
            log(f"laya-train failed (exit {rc}) without an OOM; see train.log", fh); return 1
        ooms += 1
        if finished:  # resume from the last finished epoch
            keep = os.path.join(a.out, f"resume-{done + finished}")
            shutil.rmtree(keep, ignore_errors=True)
            shutil.copytree(os.path.join(work, "checkpoint_latest"), keep)
            base, done = keep, done + finished
        log(f"CUDA OOM or kill (exit {rc}) #{ooms} after {done}/{a.epochs} epochs; retrying in {60 * ooms} s", fh)
        if ooms > 8:
            log("too many OOMs; giving up", fh); return 1
        time.sleep(60 * ooms)
    return 1


if __name__ == "__main__":
    sys.exit(main())
