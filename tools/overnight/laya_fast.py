#!/usr/bin/env python3
"""laya-train with the training knobs laya 0.4.6's CLI doesn't expose, and a training rate measured in the run.

A drop-in for `laya-train`: it takes the same flags (laya.train_cli's own parser), calls laya.train.finetune
unchanged, and swaps in its own copy of laya.train.train_model. With the defaults the loop is laya's own
(fp16 autocast with a GradScaler on CUDA, gradient checkpointing, AdamW, cosine schedule, micro-batches in
shuffled order), so a run without the extra flags trains the same model.

Extra flags:
  --amp fp16|bf16|off     autocast dtype; laya uses fp16 on CUDA and none on the CPU. bf16 needs no GradScaler.
  --grad-ckpt on|off      activation checkpointing; laya turns it on with autocast. Off is faster, uses more memory.
  --optim adamw|fused|adamw8bit   adamw8bit needs bitsandbytes and keeps Adam's state in 8 bits (3.4 GB -> 0.8 GB).
  --lora R                LoRA of rank R on the encoder's Wqkv, Wo and Wi layers; the rest of the encoder is frozen
                          and the decision heads train in full. Saved checkpoints hold the merged weights under the
                          usual names, so laya-serve and evaluate.py load them as before. --lora-lr sets its rate.
  --bucket N              sort micro-batches by length within windows of N micro-batches (micro-batch > 1 only)
  --threads N             torch CPU threads (the game farm competes for the CPU)
  --sync-every N          read the losses back N micro-steps at a time instead of after every one (laya), so the CPU
                          can queue work while the GPU runs; same weights, same reported losses
  --rate-file PATH        JSON with the measured rate, written after the probe and at every epoch end
  --fit-end UNIX_TS       training, laya's calibration and the final save must be done by then. After --probe-items
                          items the run measures its rate and lowers --epochs to what fits; it checks again at every
                          epoch end and only ever lowers. Exit 3 (nothing saved) if fewer than --min-epochs fit.
  --bench-steps K         benchmark: train K micro-steps from the base, write the rate file and exit; no calibration,
                          evaluation or checkpoint
"""
import json, math, os, random, sys, time  # noqa: E401

import torch
import torch.nn.functional as F
from torch import nn

import laya.train as LT
from laya.train_cli import build_parser

BUDGET_EXIT = 3
LAYA_TRAIN_MODEL, LAYA_CALIBRATION_RECORDS = LT.train_model, LT.calibration_records  # the originals, for tests
LORA_TARGETS = ("Wqkv", "Wo", "Wi")  # ModernBERT's attention and MLP projections
OPTS = None  # the parsed extra flags; set by main()


class BudgetTooShort(Exception):
    pass


class BenchDone(Exception):
    pass


# ------------------------------------------------------------------------------------------------- LoRA

class LoRALinear(nn.Module):
    """A frozen nn.Linear plus a trainable low-rank update. state_dict() holds the merged weight under the Linear's
    own keys, so a checkpoint saved with it loads into the stock model."""

    def __init__(self, base: nn.Linear, r: int, alpha: float):
        super().__init__()
        self.in_features, self.out_features, self.scale = base.in_features, base.out_features, alpha / r
        self.weight, self.bias = base.weight, base.bias
        for p in (self.weight, self.bias):
            if p is not None: p.requires_grad_(False)
        w = base.weight
        self.lora_A = nn.Parameter(torch.empty(r, self.in_features, device=w.device, dtype=torch.float32))
        self.lora_B = nn.Parameter(torch.zeros(self.out_features, r, device=w.device, dtype=torch.float32))
        nn.init.kaiming_uniform_(self.lora_A, a=math.sqrt(5))

    def forward(self, x):
        return F.linear(x, self.weight, self.bias) + F.linear(F.linear(x, self.lora_A), self.lora_B) * self.scale

    def merged_weight(self):
        return self.weight + (self.lora_B @ self.lora_A).to(self.weight.dtype) * self.scale

    def _save_to_state_dict(self, destination, prefix, keep_vars):
        w = self.merged_weight()
        destination[prefix + "weight"] = w if keep_vars else w.detach()
        if self.bias is not None:
            destination[prefix + "bias"] = self.bias if keep_vars else self.bias.detach()


def apply_lora(encoder: nn.Module, r: int, alpha: float, targets=LORA_TARGETS) -> int:
    """Freeze `encoder` and wrap its target Linear layers in place; returns how many were wrapped."""
    for p in encoder.parameters():
        p.requires_grad_(False)
    hits = [(name, m) for name, m in encoder.named_modules()
            if isinstance(m, nn.Linear) and name.rsplit(".", 1)[-1] in targets]
    for name, m in hits:
        parent_name, _, child = name.rpartition(".")
        setattr(encoder.get_submodule(parent_name) if parent_name else encoder, child, LoRALinear(m, r, alpha))
    return len(hits)


# ------------------------------------------------------------------------------------------- scheduling

class Cosine:
    """CosineAnnealingLR in closed form, so the run can be shortened part-way. Used only after a refit."""

    def __init__(self, optimizer, t_max, eta_min, done):
        self.opt, self.t_max, self.eta_min, self.n = optimizer, max(1, t_max), eta_min, done
        self.base = [g["initial_lr"] for g in optimizer.param_groups]
        self._set()

    def step(self):
        self.n += 1
        self._set()

    def _set(self):
        c = (1 + math.cos(math.pi * min(self.n, self.t_max) / self.t_max)) / 2
        for g, b in zip(self.opt.param_groups, self.base):
            g["lr"] = self.eta_min + (b - self.eta_min) * c


def epochs_that_fit(epoch_start, fit_end, tail_s, n_items, s_per_item, save_s, margin):
    """Whole epochs, counted from `epoch_start`, that end with `tail_s` to spare before `fit_end`."""
    per_epoch = n_items * s_per_item * (1 + margin) + save_s
    return max(0, int((fit_end - tail_s - epoch_start) // per_epoch)) if per_epoch > 0 else 0


def micro_batches(items, micro, bucket, rng):
    """Consecutive slices of `items`, or with `bucket`, slices of length-sorted windows in shuffled order."""
    if micro <= 1 or bucket <= 0:
        return [items[s:s + micro] for s in range(0, len(items), micro)]
    w, chunks = micro * bucket, []
    for s in range(0, len(items), w):
        win = sorted(items[s:s + w], key=lambda it: len(it["state_ids"]))
        chunks += [win[i:i + micro] for i in range(0, len(win), micro)]
    rng.shuffle(chunks)
    return chunks


# ------------------------------------------------------------------------------------------- the meter

class Meter:
    """Seconds per trained item, timed after a warm-up, and the costs that follow training."""

    def __init__(self, path, settings):
        self.path, self.settings, self.state, self.epochs = path, settings, {}, []
        self.inf_s, self.inf_items, self.save_s = 0.0, 0, None
        self.reset(time.monotonic())

    def reset(self, t):
        self.t0, self.items, self.tokens = t, 0, 0

    def add(self, items, tokens):
        self.items, self.tokens = self.items + items, self.tokens + tokens

    def rate(self, t):
        return (t - self.t0) / self.items if self.items else None

    def s_per_inference_item(self, fallback):
        return self.inf_s / self.inf_items if self.inf_items else fallback

    def write(self, **kw):
        self.state.update(kw, updated=time.time(), settings=self.settings, epochs_timed=self.epochs)
        if self.inf_items: self.state["s_per_inference_item"] = self.inf_s / self.inf_items
        if self.save_s is not None: self.state["save_s"] = round(self.save_s, 1)
        if torch.cuda.is_available():
            self.state["peak_alloc_mib"] = round(torch.cuda.max_memory_allocated() / 2 ** 20)
            self.state["peak_reserved_mib"] = round(torch.cuda.max_memory_reserved() / 2 ** 20)
        if not self.path: return
        out, tmp = self.state, self.path + ".tmp"
        with open(tmp, "w") as f: json.dump(out, f, indent=1)
        os.replace(tmp, self.path)


METER = None


def _timed_calibration_records(fn):
    def wrapper(model, tok, items, *a, **k):
        t = time.monotonic()
        out = fn(model, tok, items, *a, **k)
        if METER is not None and items:
            METER.inf_s += time.monotonic() - t; METER.inf_items += len(items)
        return out
    return wrapper


# ----------------------------------------------------------------------------------------- train loop

def _forward(model, batch, device, amp_dtype, detach_encoder):
    args = (batch["input_ids"].to(device), batch["attention_mask"].to(device),
            batch["marker_pos"].to(device), batch["marker_mask"].to(device), batch["qtype"].to(device))
    kwargs = {"detach_encoder": detach_encoder}
    if "option_ids" in batch:
        kwargs.update(position_ids=batch["position_ids"].to(device), option_ids=batch["option_ids"].to(device))
    if amp_dtype is not None:
        with torch.autocast(device.type, dtype=amp_dtype):
            logits, _act = model(*args, **kwargs)
    else:
        logits, _act = model(*args, **kwargs)
    return logits.float()


def drain(total, pending):
    """Add the queued loss tensors to `total` in order (waits for the GPU) and empty the queue."""
    for x in pending:
        total += x.item()
    pending.clear()
    return total


def make_optimizer(groups, config, kind):
    if kind == "adamw8bit":
        import bitsandbytes as bnb
        return bnb.optim.AdamW8bit(groups, weight_decay=config.weight_decay)
    return torch.optim.AdamW(groups, weight_decay=config.weight_decay, **({"fused": True} if kind == "fused" else {}))


def train_model(model, tok, items, config, device, max_len, head_max_len, on_epoch_end=None, parallel=False):
    """laya.train.train_model with OPTS's knobs; returns the mean loss of each epoch."""
    o = OPTS
    config.validate()
    if not items:
        raise ValueError("no training items")
    amp_name = o.amp or ("fp16" if device.type == "cuda" else "off")
    amp_dtype = {"fp16": torch.float16, "bf16": torch.bfloat16, "off": None}[amp_name]
    checkpointing = (amp_dtype is not None) if o.grad_ckpt is None else o.grad_ckpt == "on"

    if o.lora:
        if config.freeze_encoder: raise ValueError("--lora and --freeze-encoder don't mix")
        wrapped = apply_lora(model.encoder, o.lora, o.lora_alpha or 2.0 * o.lora)
        print("lora: rank %d on %d encoder layers" % (o.lora, wrapped), flush=True)
    if config.freeze_encoder:
        for p in model.encoder.parameters():
            p.requires_grad_(False)
    elif checkpointing and hasattr(model.encoder, "gradient_checkpointing_enable"):
        model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.head_checkpointing = checkpointing
    model.to(device).train()
    if config.freeze_encoder:
        model.encoder.eval()

    groups = [{"params": [p for n, p in model.named_parameters()
                          if not n.startswith("encoder.") and p.requires_grad], "lr": config.head_lr}]
    if not config.freeze_encoder:
        groups.insert(0, {"params": [p for n, p in model.named_parameters()
                                     if n.startswith("encoder.") and p.requires_grad],
                          "lr": o.lora_lr if o.lora else config.encoder_lr})
    optimizer = make_optimizer(groups, config, o.optim)
    epochs = config.epochs
    steps_per_epoch = math.ceil(len(items) / config.micro_batch)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=LT.optimizer_updates(len(items), config.micro_batch, config.grad_accum, epochs),
        eta_min=config.min_lr)
    scaler = torch.amp.GradScaler("cuda") if amp_dtype == torch.float16 and device.type == "cuda" else None
    trainable = sum(p.numel() for g in groups for p in g["params"])
    print("fast: amp %s, checkpointing %s, optimizer %s, %d trainable parameters, micro-batch %d x %d, bucket %d"
          % (amp_name, "on" if checkpointing else "off", o.optim, trainable, config.micro_batch, config.grad_accum,
             o.bucket), flush=True)
    METER.settings.update(amp=amp_name, grad_ckpt="on" if checkpointing else "off", trainable_params=trainable)

    torch.manual_seed(config.seed)
    order_rng = random.Random(config.seed)
    params = [p for g in groups for p in g["params"]]
    history, updates, epoch, all_steps = [], 0, 0, 0
    fit_end = o.fit_end
    n_calib = min(config.calib_max, math.ceil(len(items) * config.calib_frac / (1 - config.calib_frac)))
    warm = min(o.warmup_items, max(1, len(items) // 10))
    while epoch < epochs:
        epoch_items = list(items)
        random.Random(config.seed + epoch).shuffle(epoch_items)
        chunks = micro_batches(epoch_items, config.micro_batch, o.bucket, random.Random(config.seed + 7919 * (epoch + 1)))
        sigma = LT.sigma_at(epoch, epochs, config.sigma_start, config.sigma_end)
        total, n_steps, seen, pending = 0.0, 0, 0, []
        epoch_start = time.monotonic()
        METER.reset(epoch_start)
        optimizer.zero_grad(set_to_none=True)
        for ci, part in enumerate(chunks):
            chunk = [LT.encode_item(tok, it, max_len, head_max_len,
                                    LT.draw_option_order(it, order_rng, config.shuffle_options), parallel)
                     for it in part]
            batch = LT.collate_items([chunk], tok.pad_token_id)
            logits = _forward(model, batch, device, amp_dtype, config.freeze_encoder)
            mask = batch["marker_mask"].to(device)
            target = batch["target"].to(device)
            if config.loss == "rlcd":
                loss = LT.rlcd_loss(logits, target, mask, batch["qtype"].to(device), sigma,
                                    config.rl_samples, config.w_sph, config.w_rps)
            else:
                loss = LT.soft_ce_loss(logits, target, mask)
            window_start = (n_steps // config.grad_accum) * config.grad_accum
            window_size = min(config.grad_accum, steps_per_epoch - window_start)
            scaled = loss / window_size
            if scaler is not None:
                scaler.scale(scaled).backward()
            else:
                scaled.backward()
            n_steps += 1
            all_steps += 1
            if n_steps % config.grad_accum == 0 or ci == len(chunks) - 1:
                if scaler is not None:
                    scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(params, config.grad_clip)
                if scaler is not None:
                    scaler.step(optimizer)
                    scaler.update()
                else:
                    optimizer.step()
                scheduler.step()
                updates += 1
                optimizer.zero_grad(set_to_none=True)
            # laya reads every loss at once, which makes the CPU wait for the GPU each micro-step; --sync-every N
            # reads them N at a time (the same sum in the same order), so the CPU can queue the next step meanwhile.
            pending.append(loss.detach())
            log_due = config.log_every and n_steps % config.log_every == 0
            if len(pending) >= o.sync_every or log_due:
                total = drain(total, pending)
            if log_due:
                print("epoch %d/%d step %d loss %.4f" % (epoch + 1, epochs, n_steps, loss.item()), flush=True)

            seen += len(part)
            if epoch == 0 and seen <= warm:
                total = drain(total, pending)
                METER.reset(time.monotonic())  # skip allocator growth and kernel autotuning
                continue
            METER.add(len(part), sum(len(c["ids"]) for c in chunk))
            bench_due = o.bench_steps and all_steps >= o.bench_steps
            probe_due = epoch == 0 and METER.items >= o.probe_items and METER.items - len(part) < o.probe_items
            if bench_due or probe_due:
                total = drain(total, pending)  # so the clock times finished work
            now = time.monotonic()
            if bench_due:
                METER.write(s_per_item=METER.rate(now), items_timed=METER.items,
                            tokens_per_item=METER.tokens / METER.items, steps=all_steps, last_loss=loss.item(),
                            mean_loss=total / n_steps)
                raise BenchDone()
            if probe_due:
                rate = METER.rate(now)
                save_s = METER.save_s or 60
                tail = (n_calib + METER.inf_items) * METER.s_per_inference_item(rate / 3) + save_s + 30
                plan = epochs
                if fit_end:
                    plan = min(epochs, epochs_that_fit(time.time() - (now - epoch_start), fit_end, tail,
                                                       len(items), rate, save_s, o.margin))
                epoch_h = len(items) * rate / 3600
                print("rate: %.4f s per item (%.3f s per 1k tokens) over %d items; an epoch of %d items takes %.2f h;"
                      " planned epochs %d of %d" % (rate, 1000 * rate * METER.items / METER.tokens, METER.items,
                                                     len(items), epoch_h, plan, epochs), flush=True)
                METER.write(s_per_item=rate, items_timed=METER.items, tokens_per_item=METER.tokens / METER.items,
                            epochs_requested=config.epochs, epochs_planned=plan, fit_end=fit_end, tail_s=round(tail),
                            projected_end=time.time() + (plan - seen / len(items)) * epoch_h * 3600 + plan * save_s + tail)
                if plan < o.min_epochs:
                    raise BudgetTooShort("only %d epoch(s) fit before the deadline; need %d" % (plan, o.min_epochs))
                if plan < epochs:
                    epochs = plan
                    scheduler = Cosine(optimizer, LT.optimizer_updates(len(items), config.micro_batch,
                                                                       config.grad_accum, epochs),
                                       config.min_lr, updates)
        total = drain(total, pending)
        mean = total / max(1, n_steps)
        history.append(mean)
        print("epoch %d/%d mean loss %.4f" % (epoch + 1, epochs, mean), flush=True)
        now = time.monotonic()
        rate = METER.rate(now)
        METER.epochs.append({"epoch": epoch + 1, "s_per_item": rate, "seconds": round(now - epoch_start)})
        if on_epoch_end is not None:
            t = time.monotonic()
            on_epoch_end(epoch, mean)
            METER.save_s = time.monotonic() - t
        epoch += 1
        if fit_end and epoch < epochs and rate:
            save_s = METER.save_s or 0
            tail = (n_calib + METER.inf_items) * METER.s_per_inference_item(rate / 3) + save_s + 30
            more = epochs_that_fit(time.time(), fit_end, tail, len(items), rate, save_s, o.margin)
            if epoch + more < epochs:
                print("rate: %.4f s per item in epoch %d; only %d more epoch(s) fit, stopping at %d of %d"
                      % (rate, epoch, more, epoch + more, epochs), flush=True)
                epochs = epoch + more
                if epoch < epochs:
                    scheduler = Cosine(optimizer, LT.optimizer_updates(len(items), config.micro_batch,
                                                                       config.grad_accum, epochs),
                                       config.min_lr, updates)
        METER.write(s_per_item=rate, epochs_requested=config.epochs, epochs_planned=epochs, epochs_done=epoch,
                    fit_end=fit_end)
    model.eval()
    return history


# ---------------------------------------------------------------------------------------------- main

def parser():
    p = build_parser()
    p.prog = "laya_fast.py"
    p.add_argument("--amp", choices=("fp16", "bf16", "off"), default=None)
    p.add_argument("--grad-ckpt", choices=("on", "off"), default=None)
    p.add_argument("--optim", choices=("adamw", "fused", "adamw8bit"), default="adamw")
    p.add_argument("--lora", type=int, default=0)
    p.add_argument("--lora-alpha", type=float, default=None)
    p.add_argument("--lora-lr", type=float, default=2e-4)
    p.add_argument("--bucket", type=int, default=0)
    p.add_argument("--threads", type=int, default=None)
    p.add_argument("--sync-every", type=int, default=1)
    p.add_argument("--rate-file", default=None)
    p.add_argument("--fit-end", type=float, default=None)
    p.add_argument("--min-epochs", type=int, default=1)
    p.add_argument("--probe-items", type=int, default=200)
    p.add_argument("--warmup-items", type=int, default=20)
    p.add_argument("--margin", type=float, default=0.05)
    p.add_argument("--bench-steps", type=int, default=0)
    return p


def config_from(a):
    return LT.TrainConfig(
        epochs=a.epochs, micro_batch=a.micro_batch, grad_accum=a.grad_accum, encoder_lr=a.encoder_lr,
        head_lr=a.head_lr, loss=a.loss, label_smoothing=a.label_smoothing,
        shuffle_options=("choice",) if a.shuffle_options else (), freeze_encoder=a.freeze_encoder, seed=a.seed,
        max_len=a.max_len, head_max_len=a.head_max_len, text_column=a.text_column, label_column=a.label_column,
        question_id=a.question_id, instructions=a.instructions, eval_data=a.eval_data, target_error=a.target_error,
        min_abstain_n=a.min_abstain_n)


def bench(a, config):
    """finetune's set-up, then train_model until --bench-steps."""
    dev = LT.resolve_device(a.device)
    model, tok, cfg = LT.load_checkpoint(a.model_dir)
    model.to(dev)
    max_len, head_max_len = config.max_len or cfg.get("max_len", 512), config.head_max_len or cfg.get("head_max_len", 192)
    rows = LT.read_data(a.data, text_column=config.text_column, label_column=config.label_column,
                        question_id=config.question_id, instructions=config.instructions)
    items, _ = LT.items_from_rows(tok, rows, max_len, head_max_len, label_smoothing=config.label_smoothing)
    if torch.cuda.is_available(): torch.cuda.reset_peak_memory_stats()
    try:
        train_model(model, tok, items, config, dev, max_len, head_max_len, parallel=LT.uses_parallel_layout(cfg))
    except BenchDone:
        return 0
    METER.write(s_per_item=METER.rate(time.monotonic()), note="ran out of items before --bench-steps")
    return 0


def configure(a):
    """Install the parsed flags and the replacement train loop; returns the TrainConfig."""
    global OPTS, METER
    if a.bench_steps and a.bench_steps * a.micro_batch <= a.warmup_items:
        raise ValueError("--bench-steps must cover more than --warmup-items items")
    if a.min_epochs < 1 or a.sync_every < 1:
        raise ValueError("--min-epochs and --sync-every must be at least 1")
    if a.threads: torch.set_num_threads(a.threads)
    OPTS = a
    keys = ("amp", "grad_ckpt", "optim", "lora", "bucket", "threads", "sync_every", "micro_batch", "grad_accum", "loss")
    METER = Meter(a.rate_file, {k: getattr(a, k) for k in keys})
    LT.train_model = train_model
    LT.calibration_records = _timed_calibration_records(LAYA_CALIBRATION_RECORDS)
    return config_from(a)


def main(argv=None):
    p = parser()
    a = p.parse_args(argv)
    if not (a.dry_run or a.output_dir or a.bench_steps):
        p.error("--out is required unless --dry-run or --bench-steps is set")
    config = configure(a)
    try:
        config.validate()
        if a.dry_run:
            LT.dry_run(data=a.data, model_dir=a.model_dir, config=config); return 0
        if a.bench_steps:
            return bench(a, config)
        summary = LT.finetune(data=a.data, model_dir=a.model_dir, output_dir=a.output_dir, config=config,
                              device=a.device)
        print("Training complete! Model saved to %s" % summary["output_dir"], flush=True)
        return 0
    except BudgetTooShort as err:
        print("laya_fast: budget: %s" % (err,), file=sys.stderr, flush=True)
        return BUDGET_EXIT
    except (ValueError, FileNotFoundError, TypeError) as err:
        print("laya-train: error: %s" % (err,), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
