# Training cost (2026-10-28)

This follows up item 4.1 of the 2026-10-27 review (on `claude/rule-model-improvements-bymira`):
check `laya-train` for LoRA, bf16, gradient checkpointing and dynamic padding, and measure the
training rate when a stage starts instead of using a stored figure. It was written without the
GPU. Everything below about speed or GPU memory on the 3080 is either arithmetic or a
hypothesis for `trainbench.py` to test. The code was tested on the CPU with a tiny random
ModernBERT.

## What laya-train 0.4.6 already does
From `laya/train.py` and `laya/common.py` in the `laya==0.4.6` wheel that both the image and
the native pipenv install.

| Feature | In laya-train 0.4.6 | CLI flag |
|---|---|---|
| Mixed precision | **Already on.** `TrainConfig.amp` defaults to on for CUDA: fp16 autocast with a GradScaler. Weights, gradients and AdamW state stay fp32. | none |
| bf16 | Inference only (the shipped checkpoints' `amp_dtype`). Training autocast is hard-coded to fp16. | none |
| Gradient checkpointing | **Already on.** It defaults to following `amp`: the encoder uses HF's non-reentrant checkpointing and the two head layers use `head_checkpointing`. | none |
| Dynamic padding | **Already there.** `collate_items` pads to the longest sequence in the micro-batch, and at micro-batch 1 nothing is padded. There's no length bucketing. | n/a |
| LoRA / PEFT | **None.** No peft dependency. The only partial option is `--freeze-encoder`, which trains the heads only. | `--freeze-encoder` |
| Optimizer | `torch.optim.AdamW` (foreach). Not fused, not 8-bit. | none |
| GPU sync | `total += loss.item()` after every micro-step, so the CPU waits for the GPU 64 times per optimizer update. | none |
| ModernBERT compile | transformers' `_maybe_set_compile` compiles ModernBERT's MLP and embeddings when `reference_compile` is unset, triton imports and the model runs on CUDA. Whether today's runs do this depends on the checkpoint's `encoder/config.json`. Worth a look in a `train.log`. | none |

So the review's "fp32" is half right. The arithmetic is already fp16 and checkpointing is
already on. The 6.7 GB is fp32 master weights, gradients and Adam moments, and mixed precision
doesn't touch any of those.

## Where the memory goes
421,294,084 parameters: ModernBERT-large 394.8M (51.6M of it embeddings) plus laya's heads 26.5M.

| Item | Full fine-tune today | 8-bit AdamW | LoRA r=16 + full heads |
|---|---|---|---|
| Weights (fp32) | 1.69 GB | 1.69 GB | 1.71 GB (frozen base + adapters) |
| Gradients (fp32) | 1.69 GB | 1.69 GB | 0.13 GB (33.7M trainable) |
| AdamW m, v | 3.37 GB | 0.84 GB | 0.27 GB |
| fp16 weight copies cached by autocast | 0.84 GB | 0.84 GB | 0.84 GB |
| **Subtotal** | **7.6 GB** | **5.1 GB** | **2.9 GB** |

On top of that come the CUDA context, cuBLAS workspace and allocator slack (roughly 0.5–1 GB),
plus activations. With checkpointing, activations at micro-batch 1 and 512 tokens are a few
hundred MB. That matches `train.py`'s note that a micro-batch 2 run peaks about 7.5 GB above
idle, and session 1's 9.57 of 10.24 GB with another 2 GB on the card. LoRA is the only option
that leaves room for micro-batch 8. 8-bit Adam probably allows micro-batch 2–4 with
checkpointing. bf16 autocast saves nothing on its own. Pure-bf16 weights and optimizer state
would halve everything, but at an encoder learning rate of 2.5e-5 most updates are smaller
than bf16's resolution and get rounded away, so it isn't offered.

## Where the time goes
The plan's own rates for the same model and loop: 0.19 s per item-epoch (session 1), 0.219
(trainO, CPU idle), 0.25 (micro-batch 2, session 1 budget), 0.403 (trainG), 0.469 (trainH,
labelling on the CPU), 0.50 (sweepF). The rate more than doubles when the CPU is busy, which a
GPU-bound job wouldn't do. A rough compute check: one training step on the 421M model at 512
tokens with checkpointing is about 1.5 TFLOP (forward 2 × 368M non-embedding parameters ×
512 ≈ 0.38 TFLOP, times 4 for the forward, the recompute and the backward). At 0.22 s an item
that is at most 7 TFLOPS sustained, well under the 3080's fp16 tensor-core rate. The likely
costs:
- **Micro-batch 1.** Every item pays a full step's fixed CPU cost: Python, head tokenisation,
  collation, and a few thousand kernel launches with checkpointing. WSL2 adds per-launch cost.
- **A GPU sync after every micro-step** (`loss.item()`), so the CPU never queues the next
  step while the GPU runs the current one. Step time is CPU time plus GPU time instead of the
  larger of the two.
- **CPU contention.** The game farm runs at `nice 10`, but SMT siblings, caches and memory
  bandwidth are still shared with 13 game slots.

Expected levers, roughly from largest to smallest. These are hypotheses until `trainbench.py`
runs:
1. **A bigger micro-batch,** which needs LoRA or 8-bit Adam to fit. It spreads the per-step
   overhead over 4–8 items.
2. **`--sync-every N`.** It reads the losses back N at a time, so the CPU can run ahead. The
   weights and reported losses are identical (tested).
3. **LoRA.** The encoder gets no weight gradients, which cuts about a third of the compute,
   on top of 1.
4. **Checkpointing off** once memory allows, saving about a quarter of the compute.
5. **bf16 autocast.** On Ampere it should run at the same speed as fp16. It drops the
   GradScaler and its sync at each optimizer update, so the gain is small.
6. **Fused AdamW.** One optimizer step per 64 items, so the gain is small.
7. **Pinning the trainer** to its own physical core and the farm to the rest
   (`trainbench.py --pin-cpus`). Adopting it would need the driver to pin the game processes.

Quality: `--sync-every`, bucketing and fused AdamW don't change the objective. bf16 changes
numerics slightly. LoRA and heads-only change what is trained, so they need the quality A/B
below before adoption.

## What this branch adds
- **`tools/overnight/laya_fast.py`**: a drop-in `laya-train`. It uses the same flags (laya's
  own parser), calls `laya.train.finetune` unchanged, and swaps in a copy of `train_model`. With
  default flags it trains bit-for-bit the same weights as laya's loop (tested on the CPU,
  including laya's CUDA settings of fp16 autocast and checkpointing forced on). Extra flags:
  `--amp fp16|bf16|off`, `--grad-ckpt on|off`, `--optim adamw|fused|adamw8bit`, `--lora R`
  (with `--lora-lr`, default 2e-4), `--bucket N`, `--sync-every N`, `--threads N`,
  `--rate-file`, `--fit-end`, `--min-epochs` and `--bench-steps`. LoRA checkpoints store the
  merged weights under the stock names, so laya-serve, `evaluate.py` and continued training
  load them as before (tested: a strict load reproduces the logits).
- **The rate is measured in the run.** After a 20-item warm-up and a 200-item probe (1–2 minutes
  at today's rates), `laya_fast.py` prints and writes the rate in s per item and s per 1k
  tokens. It estimates the work left after training from things it has timed: the
  before-training evaluation pass, which costs the same as the calibration and after-training
  passes, and the first checkpoint save. It adds a 5% margin and lowers `--epochs` to what ends
  by `--fit-end`. It checks again at every epoch end and only ever lowers. A shortened run
  switches to a shorter cosine schedule from that step on. If fewer than `--min-epochs` fit, it
  exits 3 with nothing saved. `DIR/rate.json` holds the rate, the plan, peak GPU memory and the
  per-epoch rates.
- **`train.py`**: new `--fit-end` and `--min-epochs` flags, the knobs above, and
  `--micro-batch`/`--grad-accum` (default 1 × 64, as before). It runs `laya_fast.py` when any of
  these are given and stock `laya-train` otherwise, so existing drivers are unchanged. On an OOM
  it now halves a micro-batch above 1 (doubling grad-accum). It returns 3 when the budget is too
  short, and that isn't retried.
- **`driver6.train_eval(..., fit_end=, min_epochs=, knobs=)`**: passes these through, puts
  `rate.json` in the result, reports the epochs actually trained, and sets
  `run.state["s_per_item_measured"]` for later stages in the session. A result of
  `{"skipped": ...}` means not even `min_epochs` fit. For a sweep where the epoch count is the
  variable (sweepF), pass `min_epochs=epochs`, which makes it all or nothing.
- **`tools/overnight/trainbench.py`**: one subprocess per configuration from the base. It times
  384 items after warm-up and reports s per item, the speed-up over today's settings, peak GPU
  memory and loss, writing `bench.md` and `bench.json`. Runs that OOM are reported and skipped.
  `--cpu-burn N` adds N busy loops at nice 10 to stand in for the farm.
- **`tools/overnight/test_laya_fast.py`**: 16 CPU tests. Run them with the pipenv's Python:
  `(cd tools/overnight/native && pipenv run python -I ../test_laya_fast.py)`. `laya_fast.py`
  copies laya 0.4.6's loop and calls its internals (`laya.train.encode_item`, `collate_items`,
  `soft_ce_loss` and others), so re-run these tests after any laya upgrade.

**Not verified here:** anything on CUDA, meaning speed, memory, OOM handling, bf16 on the GPU,
bitsandbytes, and LoRA under ModernBERT's compiled MLP. The future drivers that should pass
`fit_end` don't exist yet, so none of the session drivers uses it so far.

How the two failures would have gone. **trainO** (session 15) asked for 2 epochs, but the cap
used session 10's 0.469 s, so it trained 1. With `fit_end` the probe would have measured about
0.22 s, and both epochs (about 81 minutes) fit its 3-hour slot. **sweepF** ran 14 epochs at
0.50 s against a 4.5 h budget that assumed about 0.2 s. With `min_epochs=epochs` and each point's
`fit_end` set to the stage deadline, each point would have run whole or not at all. The driver
should still re-plan the remaining points from `run.state["s_per_item_measured"]` after the
first one.

## On the 3080
All of these run from the repo root with the native pipenv (`OVN_NATIVE=1`; `trainbench.py`
finds the pipenv's Python itself). Stop laya-serve and kev first so the GPU is otherwise idle.
For the 8-bit run, add bitsandbytes to the pipenv by hand. It isn't in `Pipfile.lock`; without
it that row reports an import error.

```bash
(cd tools/overnight/native && pipenv run pip install bitsandbytes)
```

1. Speed and memory, idle CPU, on trainE's data (sweepF's split):

```bash
python3 -I tools/overnight/trainbench.py --data runs/session5/2026-10-16/trainE/data/train.jsonl --out runs/bench/idle
```

2. The same with the farm's CPU load, then with the trainer pinned. Check `lscpu -e` for a
   core's two SMT CPUs and pass them to `--pin-cpus`:

```bash
python3 -I tools/overnight/trainbench.py --data runs/session5/2026-10-16/trainE/data/train.jsonl --out runs/bench/burn13 --cpu-burn 13
```

```bash
python3 -I tools/overnight/trainbench.py --data runs/session5/2026-10-16/trainE/data/train.jsonl --out runs/bench/burn13-pin --cpu-burn 13 --pin-cpus 0,8 --configs base,sync64,lora16-mb8,lora16-mb8-sync8
```

   Each configuration takes about 2–4 minutes (model load, tokenising 2,000 rows, about 400
   timed items), so all 14 take about 40 minutes. The idle `base` row should come out at or a
   little under trainO's 0.22 s per item, which included evaluation and saving. If it is far
   off, the benchmark isn't measuring what the stages see.

3. Quality A/B, only for a winner that changes what is trained (LoRA, heads only, bf16). Its
   baseline already exists: session 16's **trainO2**, a full fine-tune of trainH for 2 epochs on
   session 15's labelO train games. Train the candidate the same way, then score it on the same
   3,599 held-out records:

```bash
OVN_NATIVE=1 python3 -I tools/overnight/train.py --data runs/session15/2026-10-26/trainO/data/train.jsonl --out runs/bench/ab/lora16/ckpt-e2-s0 --epochs 2 --base runs/session10/2026-10-21/trainH/ckpt-e3-s0.final --lora 16 --micro-batch 8 --grad-accum 8 --bucket 16 --sync-every 8 --fit-end $(date -d '+4 hours' +%s)
```

```bash
OVN_NATIVE=1 python3 -I tools/overnight/evaluate.py --heldout runs/session15/2026-10-26/trainO/data/heldout.O.jsonl --train runs/session15/2026-10-26/trainO/data/train.jsonl --ckpt runs/bench/ab/lora16/ckpt-e2-s0.final --base "" --out runs/bench/ab/lora16/heldout.O.json
```

   Compare its accuracy and Brier with trainO2's `heldout.O` in session 16's `state.json`. At
   3,599 records the standard error of accuracy is about 0.8 points, and sweepF showed a
   seed-to-seed spread of about 2 points. One seed can rule out a large loss but can't
   establish a small one.

**Proposed adoption rule,** to be fixed before the numbers come in:
- A knob that doesn't change the objective (`--sync-every`, bucketing, fused AdamW,
  `--threads`, pinning) is adopted if `trainbench.py` shows it at least 1.2 times faster under
  `--cpu-burn 13`.
- A knob that changes what is trained (LoRA, heads only, bf16) is adopted if it is at least
  1.5 times faster under load, and its held-out labelO accuracy, averaged over seeds 0 and 1, is
  no more than 1.5 points below trainO2's with a Brier score no more than 0.005 worse.
- Every training stage from session 18 on passes `fit_end` (the stage deadline minus the
  evaluation reserve) to `train_eval`, instead of capping epochs from a stored rate.
