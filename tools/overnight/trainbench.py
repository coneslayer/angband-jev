#!/usr/bin/env python3
"""Training-rate and GPU-memory benchmark for laya fine-tuning, one subprocess per configuration.

Each configuration runs laya_fast.py --bench-steps from the base model on the first --rows rows of --data, times
--items items after a warm-up, and reports seconds per item, seconds per 1k tokens, peak GPU memory and the loss.
No checkpoint is written. A run that runs out of GPU memory is reported as OOM and the next one starts.

--cpu-burn N runs N busy loops at nice 10 alongside, as the game farm does; with --pin-cpus the trainer is pinned to
those CPUs and the busy loops to the others (adopting that needs the farm pinned the same way).

Usage: trainbench.py --data train.jsonl --out DIR [--base english] [--configs base,bf16,...] [--items 384]
                     [--rows 2000] [--cpu-burn 13] [--pin-cpus 0,8] [--python PATH]
Writes DIR/bench.json and DIR/bench.md.
"""
import argparse, json, math, os, re, subprocess, sys, time  # noqa: E401

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # run with -I
OOM = re.compile(r"CUDA out of memory|CUBLAS_STATUS_ALLOC_FAILED|cudaErrorMemoryAllocation|OutOfMemoryError")

MB = lambda m, b=16: ["--micro-batch", str(m), "--grad-accum", str(64 // m), "--bucket", str(b)]  # noqa: E731
CONFIGS = {  # name: laya_fast.py flags; every one keeps the effective batch of 64 (1 x 64 unless it says)
    "base": [],                                     # today's runs: fp16 autocast, checkpointing, AdamW, 1 x 64
    "bf16": ["--amp", "bf16"],
    "nockpt": ["--grad-ckpt", "off"],
    "fused": ["--optim", "fused"],
    "threads2": ["--threads", "2"],
    "sync64": ["--sync-every", "64"],
    "mb2": MB(2),
    "mb4": MB(4),
    "8bit-mb4": ["--optim", "adamw8bit", *MB(4)],
    "lora16-mb8": ["--lora", "16", *MB(8)],
    "lora16-mb8-nockpt": ["--lora", "16", "--grad-ckpt", "off", *MB(8)],
    "lora16-bf16-mb8-nockpt": ["--lora", "16", "--amp", "bf16", "--grad-ckpt", "off", *MB(8)],
    "lora16-mb8-sync8": ["--lora", "16", "--sync-every", "8", *MB(8)],
    "heads-mb8": ["--freeze-encoder", *MB(8)],
}


def micro_of(flags):
    return int(flags[flags.index("--micro-batch") + 1]) if "--micro-batch" in flags else 1


def with_batch(flags):
    """train.py's 1 x 64 unless the flags set the micro-batch (laya-train's own default is 8 x 8)."""
    return flags if "--micro-batch" in flags else [*flags, "--micro-batch", "1", "--grad-accum", "64"]


def burners(n, cpus):
    if n <= 0: return []
    pre = (lambda: os.sched_setaffinity(0, cpus)) if cpus else None
    return [subprocess.Popen(["nice", "-n", "10", sys.executable, "-c", "while True: pass"], preexec_fn=pre)
            for _ in range(n)]


def run_config(a, name, flags, data, out_dir, pin):
    rate_file = os.path.join(out_dir, f"{name}.rate.json")
    if os.path.exists(rate_file): os.remove(rate_file)
    micro, warm = micro_of(flags), 20
    steps = math.ceil((a.items + warm) / micro)
    cmd = [a.python, "-I", os.path.join(HERE, "laya_fast.py"), "--data", data, "--base", a.base, "--max-len", "512",
           "--loss", "soft-ce", "--epochs", "1000", "--bench-steps", str(steps), "--warmup-items", str(warm),
           "--rate-file", rate_file, *with_batch(flags)]
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True, errors="replace",
                       env={**os.environ, "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"},
                       preexec_fn=(lambda: os.sched_setaffinity(0, pin)) if pin else None)
    with open(os.path.join(out_dir, f"{name}.log"), "w") as f: f.write(p.stdout + p.stderr)
    res = {"name": name, "flags": flags, "wall_s": round(time.time() - t0)}
    if p.returncode != 0 or not os.path.exists(rate_file):
        lines = (p.stdout + p.stderr).strip().splitlines()
        res["status"] = "OOM" if OOM.search(p.stdout + p.stderr) else \
            f"error (exit {p.returncode}): {lines[-1][:100] if lines else ''}".replace("|", "/")
        return res
    r = json.load(open(rate_file))
    res.update(status="ok", s_per_item=r.get("s_per_item"), tokens_per_item=r.get("tokens_per_item"),
               peak_alloc_mib=r.get("peak_alloc_mib"), peak_reserved_mib=r.get("peak_reserved_mib"),
               mean_loss=r.get("mean_loss"), trainable=r.get("settings", {}).get("trainable_params"))
    if res["s_per_item"] and res["tokens_per_item"]:
        res["s_per_1k_tokens"] = 1000 * res["s_per_item"] / res["tokens_per_item"]
    return res


def table(rows, base):
    ref = next((r["s_per_item"] for r in rows if r["name"] == base and r.get("s_per_item")), None)
    out = ["| Config | s / item | vs base | s / 1k tokens | Peak alloc MiB | Peak reserved MiB | Mean loss | Trainable |",
           "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        if r["status"] != "ok":
            out.append(f"| {r['name']} | {r['status']} | | | | | | |"); continue
        f = lambda k, fmt: format(r[k], fmt) if r.get(k) is not None else ""  # noqa: E731
        vs = f"{ref / r['s_per_item']:.2f}x" if ref else ""
        out.append(f"| {r['name']} | {f('s_per_item', '.4f')} | {vs} | {f('s_per_1k_tokens', '.3f')} | "
                   f"{f('peak_alloc_mib', ',')} | {f('peak_reserved_mib', ',')} | {f('mean_loss', '.4f')} | "
                   f"{f('trainable', ',')} |")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--base", default="english")
    ap.add_argument("--configs", default=",".join(CONFIGS))
    ap.add_argument("--items", type=int, default=384, help="items timed per configuration, after a warm-up of 20")
    ap.add_argument("--rows", type=int, default=2000)
    ap.add_argument("--cpu-burn", type=int, default=0)
    ap.add_argument("--pin-cpus", default="")
    ap.add_argument("--python", default=None, help="the Python with laya installed (default: the native pipenv's)")
    a = ap.parse_args()
    if a.python is None:
        from evaluate import venv_bin
        a.python = venv_bin("python")
    os.makedirs(a.out, exist_ok=True)
    data = os.path.join(a.out, "bench.jsonl")
    with open(a.data) as src, open(data, "w") as f:
        for i, line in enumerate(src):
            if i >= a.rows: break
            f.write(line)
    pin = {int(c) for c in a.pin_cpus.split(",") if c} or None
    others = (set(range(os.cpu_count())) - pin) if pin else None
    names = [n for n in a.configs.split(",") if n]
    unknown = [n for n in names if n not in CONFIGS]
    if unknown: ap.error(f"unknown configs {unknown}; known: {', '.join(CONFIGS)}")
    rows, burn = [], burners(a.cpu_burn, others)
    try:
        for n in names:
            print(f"[{time.strftime('%H:%M:%S')}] {n}: {' '.join(CONFIGS[n]) or '(defaults)'}", flush=True)
            rows.append(run_config(a, n, CONFIGS[n], data, a.out, pin))
            r = rows[-1]
            print(f"  {r['status']}" + (f": {r['s_per_item']:.4f} s/item, peak {r['peak_alloc_mib']} MiB"
                                         if r["status"] == "ok" and r.get("s_per_item") else ""), flush=True)
            json.dump({"cpu_burn": a.cpu_burn, "pin_cpus": a.pin_cpus, "items": a.items, "rows": rows},
                      open(os.path.join(a.out, "bench.json"), "w"), indent=1)
    finally:
        for b in burn: b.kill()
    md = table(rows, "base")
    with open(os.path.join(a.out, "bench.md"), "w") as f:
        f.write(f"cpu-burn {a.cpu_burn}, pin {a.pin_cpus or 'none'}, {a.items} items timed per config\n\n{md}\n")
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
