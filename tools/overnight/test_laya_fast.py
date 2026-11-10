#!/usr/bin/env python3
"""Tests for laya_fast.py on a tiny random ModernBERT on the CPU; no downloads.

Run with the Python that has laya installed: <venv>/bin/python -I tools/overnight/test_laya_fast.py [-v]
They check that the default loop trains exactly what laya's own does, that LoRA checkpoints load into stock laya,
the epoch fitting, bucketing and the bf16 path. They don't measure speed: trainbench.py does that on the GPU.
"""
import argparse, json, math, os, random, shutil, sys, tempfile, time, unittest  # noqa: E401
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # run with -I

import torch  # noqa: E402

import laya.train as LT  # noqa: E402
import laya_fast as LF  # noqa: E402

WORDS = ("hp low high full half monster orc dog spider kobold near far adjacent fast slow poisoned bleeding "
         "potion oil scroll phase door stairs here none depth level what should the player do attack it run away "
         "throw flask of drink a cure read").split()
QUESTION = {"type": "choice", "instructions": "What should the player do?",
            "criteria": {"melee": "attack it", "flee": "run away", "throw": "throw a flask of oil",
                         "heal": "drink a cure potion"}}


def make_checkpoint(path, seed=0):
    """A laya checkpoint directory with a 2-layer, 64-wide ModernBERT encoder and a word-level tokenizer."""
    from tokenizers import Tokenizer, models, pre_tokenizers
    from transformers import ModernBertConfig, ModernBertModel, PreTrainedTokenizerFast
    from safetensors.torch import save_file
    from laya.common import DecisionModel

    specials = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"]
    vocab = {w: i for i, w in enumerate(specials + sorted(set(WORDS)) + list("0123456789{}[]:,.\"'_-?"))}
    t = Tokenizer(models.WordLevel(vocab, unk_token="[UNK]"))
    t.pre_tokenizer = pre_tokenizers.Sequence([pre_tokenizers.Whitespace(), pre_tokenizers.Digits(individual_digits=True)])
    tok = PreTrainedTokenizerFast(tokenizer_object=t, pad_token="[PAD]", unk_token="[UNK]", cls_token="[CLS]",
                                  sep_token="[SEP]", mask_token="[MASK]")
    ecfg = ModernBertConfig(vocab_size=len(vocab), hidden_size=64, intermediate_size=96, num_hidden_layers=2,
                            num_attention_heads=2, max_position_embeddings=512, pad_token_id=0, cls_token_id=2,
                            sep_token_id=3, bos_token_id=2, eos_token_id=3, global_attn_every_n_layers=1,
                            reference_compile=False)
    torch.manual_seed(seed)
    model = DecisionModel(ModernBertModel(ecfg), head_layers=1, n_act=2)
    os.makedirs(path, exist_ok=True)
    save_file({k: v.contiguous() for k, v in model.state_dict().items()}, os.path.join(path, "model.safetensors"))
    ecfg.save_pretrained(os.path.join(path, "encoder"))
    tok.save_pretrained(os.path.join(path, "tokenizer"))
    cfg = {"encoder": os.path.join(path, "encoder"), "head_layers": 1, "act_costs": {"act": 1.0}, "max_len": 128,
           "head_max_len": 48, "temperature": {"choice": 1.0, "noul": 1.0, "score": 1.0}}
    with open(os.path.join(path, "rl_agent_config.json"), "w") as f: json.dump(cfg, f)
    return path


def make_rows(n, seed=0):
    rng = random.Random(seed)
    rows = []
    for i in range(n):
        state = {"hp": f"hp {rng.choice(['low', 'high', 'half', 'full'])} {rng.randint(1, 99)}",
                 "monsters": " ".join(rng.choice(WORDS[5:16]) for _ in range(rng.randint(1, 40))),
                 "depth": f"depth {rng.randint(1, 12)}"}
        p = [rng.random() for _ in QUESTION["criteria"]]
        gold = {k: v / sum(p) for k, v in zip(QUESTION["criteria"], p)}
        rows.append({"state": state, "questions": {"decision": QUESTION}, "gold": {"decision": {"probabilities": gold}},
                     "meta": {"game_id": f"g{i % 7}"}})
    return rows


def write_rows(path, rows):
    with open(path, "w") as f:
        for r in rows: f.write(json.dumps(r) + "\n")
    return path


class Fixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="laya_fast_test.")
        cls.ckpt = make_checkpoint(os.path.join(cls.tmp, "base"))
        cls.data = write_rows(os.path.join(cls.tmp, "train.jsonl"), make_rows(60))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def opts(self, *argv):
        a = LF.parser().parse_args(["--data", self.data, "--base", self.ckpt, "--out", os.path.join(self.tmp, "o"),
                                    *argv])
        return a, LF.configure(a)

    def items(self, cfg_over=None):
        model, tok, cfg = LT.load_checkpoint(self.ckpt)
        items, _ = LT.items_from_rows(tok, LT.read_jsonl(self.data), cfg["max_len"], cfg["head_max_len"])
        return model, tok, cfg, items


class DefaultLoop(Fixture):
    def check_same(self, *argv, laya=None):
        _a, config = self.opts(*argv)
        ref, tok, cfg, items = self.items()
        mine = LT.load_checkpoint(self.ckpt)[0]
        dev = torch.device("cpu")
        ref_config = LT.TrainConfig(**{**config.__dict__, **(laya or {})})
        h_ref = LF.LAYA_TRAIN_MODEL(ref, tok, items, ref_config, dev, cfg["max_len"], cfg["head_max_len"])
        h_mine = LF.train_model(mine, tok, items, config, dev, cfg["max_len"], cfg["head_max_len"])
        self.assertEqual(h_ref, h_mine)
        sd_ref, sd_mine = ref.state_dict(), mine.state_dict()
        self.assertEqual(sd_ref.keys(), sd_mine.keys())
        for k in sd_ref:
            self.assertTrue(torch.equal(sd_ref[k], sd_mine[k]), k)

    def test_same_as_laya_micro1(self):
        self.check_same("--epochs", "2", "--micro-batch", "1", "--grad-accum", "8", "--loss", "soft-ce")

    def test_same_as_laya_with_fp16_autocast_and_checkpointing(self):
        # laya's CUDA defaults, forced on the CPU: fp16 autocast (no GradScaler off CUDA) and checkpointing
        self.check_same("--epochs", "1", "--micro-batch", "2", "--grad-accum", "4", "--loss", "soft-ce",
                        "--amp", "fp16", "--grad-ckpt", "on", laya={"amp": True, "gradient_checkpointing": True})

    def test_same_as_laya_reading_losses_in_batches(self):
        self.check_same("--epochs", "2", "--micro-batch", "1", "--grad-accum", "8", "--loss", "soft-ce",
                        "--sync-every", "7")

    def test_same_as_laya_micro4_rlcd_shuffled(self):
        self.check_same("--epochs", "2", "--micro-batch", "4", "--grad-accum", "3", "--loss", "rlcd",
                        "--shuffle-options")


class Lora(Fixture):
    def test_checkpoint_loads_in_stock_laya(self):
        _a, config = self.opts("--epochs", "2", "--micro-batch", "4", "--grad-accum", "2", "--loss", "soft-ce",
                               "--lora", "4", "--lora-lr", "1e-2")
        model, tok, cfg, items = self.items()
        keys = set(model.state_dict())
        before = {k: v.clone() for k, v in model.state_dict().items()}
        LF.train_model(model, tok, items, config, torch.device("cpu"), cfg["max_len"], cfg["head_max_len"])
        wrapped = [m for m in model.encoder.modules() if isinstance(m, LF.LoRALinear)]
        self.assertEqual(len(wrapped), 2 * 4)  # per layer: attn.Wqkv, attn.Wo, mlp.Wi, mlp.Wo
        self.assertTrue(any(m.lora_B.abs().sum() > 0 for m in wrapped))
        sd = model.state_dict()
        self.assertEqual(set(sd), keys)  # merged weights under the stock names, no lora_A/lora_B
        # Only the wrapped weights and the heads moved; the rest of the encoder is frozen.
        moved = {k for k in keys if not torch.equal(before[k], sd[k])}
        self.assertTrue(all(k.startswith("encoder.layers.") and k.endswith(".weight") or not k.startswith("encoder.")
                            for k in moved), sorted(moved))
        self.assertFalse(any("embeddings" in k or "norm" in k for k in moved if k.startswith("encoder.")))
        self.assertTrue(any(k.startswith("encoder.") for k in moved))

        batch = LT.collate_items([[LT.encode_item(tok, it, cfg["max_len"], cfg["head_max_len"]) for it in items[:8]]],
                                 tok.pad_token_id)
        model.eval()
        with torch.no_grad():
            want = LF._forward(model, batch, torch.device("cpu"), None, False)
        out = os.path.join(self.tmp, "lora-ckpt")
        LT.save_checkpoint(model, tok, cfg, out)
        stock, _, _ = LT.load_checkpoint(out)  # strict load
        stock.eval()
        with torch.no_grad():
            got = LF._forward(stock, batch, torch.device("cpu"), None, False)
        self.assertTrue(torch.allclose(want, got, atol=2e-2), (want - got).abs().max())

    def test_merge_matches_forward(self):
        lin = torch.nn.Linear(16, 24)
        m = LF.LoRALinear(lin, 4, 8.0)
        torch.nn.init.normal_(m.lora_B)
        x = torch.randn(5, 16)
        self.assertTrue(torch.allclose(m(x), torch.nn.functional.linear(x, m.merged_weight(), m.bias), atol=1e-5))


class Fitting(Fixture):
    def run_main(self, *argv):
        out = os.path.join(self.tmp, f"run{time.monotonic_ns()}")
        rate = out + ".rate.json"
        rc = LF.main(["--data", self.data, "--base", self.ckpt, "--out", out, "--loss", "soft-ce", "--micro-batch", "1",
                      "--grad-accum", "4", "--rate-file", rate, "--probe-items", "10", "--warmup-items", "4", *argv])
        if not os.path.exists(rate): return rc, out, None
        with open(rate) as f: return rc, out, json.load(f)

    def test_no_reduction_with_room(self):
        rc, out, rate = self.run_main("--epochs", "2", "--fit-end", str(time.time() + 1e6))
        self.assertEqual(rc, 0)
        self.assertEqual(rate["epochs_planned"], 2)
        self.assertEqual(rate["epochs_done"], 2)
        self.assertGreater(rate["s_per_item"], 0)
        self.assertTrue(os.path.exists(os.path.join(out, "model.safetensors")))

    def test_budget_too_short_exits_3_without_a_checkpoint(self):
        rc, out, rate = self.run_main("--epochs", "2", "--fit-end", str(time.time() + 1))
        self.assertEqual(rc, LF.BUDGET_EXIT)
        self.assertEqual(rate["epochs_planned"], 0)
        self.assertFalse(os.path.exists(os.path.join(out, "model.safetensors")))

    def test_probe_lowers_epochs(self):
        real = LF.epochs_that_fit
        LF.epochs_that_fit = lambda *a, **k: 1
        try:
            rc, out, rate = self.run_main("--epochs", "3", "--fit-end", str(time.time() + 1e6))
        finally:
            LF.epochs_that_fit = real
        self.assertEqual(rc, 0)
        self.assertEqual((rate["epochs_planned"], rate["epochs_done"]), (1, 1))

    def test_epoch_end_stops_early(self):
        real, calls = LF.epochs_that_fit, []

        def fake(*a, **k):
            calls.append(a)
            return 3 if len(calls) == 1 else 0  # the probe sees room for 3; after epoch 1, no more fit
        LF.epochs_that_fit = fake
        try:
            rc, out, rate = self.run_main("--epochs", "3", "--fit-end", str(time.time() + 1e6))
        finally:
            LF.epochs_that_fit = real
        self.assertEqual(rc, 0)
        self.assertEqual(rate["epochs_done"], 1)
        self.assertTrue(os.path.exists(os.path.join(out, "model.safetensors")))

    def test_epochs_that_fit(self):
        # 1,000 items at 0.2 s plus a 50 s save is 250 s an epoch (no margin); 900 s left after a 100 s tail.
        self.assertEqual(LF.epochs_that_fit(0, 1000, 100, 1000, 0.2, 50, 0.0), 3)
        self.assertEqual(LF.epochs_that_fit(0, 1000, 100, 1000, 0.2, 50, 0.5), 2)
        self.assertEqual(LF.epochs_that_fit(0, 100, 200, 1000, 0.2, 50, 0.0), 0)

    def test_cosine_matches_torch_and_ends_at_eta_min(self):
        p = torch.nn.Parameter(torch.zeros(1))
        opt = torch.optim.SGD([p], lr=1.0)
        ref = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=20, eta_min=0.01)
        for _ in range(7): opt.step(); ref.step()
        lr7 = opt.param_groups[0]["lr"]
        c = LF.Cosine(opt, 20, 0.01, 7)
        self.assertAlmostEqual(opt.param_groups[0]["lr"], lr7, places=9)
        for _ in range(13): c.step()
        self.assertAlmostEqual(opt.param_groups[0]["lr"], 0.01, places=12)


class Batching(Fixture):
    def test_bucketed_micro_batches(self):
        items = [{"state_ids": [0] * random.Random(i).randint(1, 300), "i": i} for i in range(103)]
        chunks = LF.micro_batches(items, 4, 5, random.Random(1))
        self.assertEqual(len(chunks), math.ceil(103 / 4))
        self.assertEqual(sorted(it["i"] for c in chunks for it in c), list(range(103)))
        for c in chunks:
            lens = [len(it["state_ids"]) for it in c]
            self.assertEqual(lens, sorted(lens))
        self.assertEqual(LF.micro_batches(items, 4, 0, None), [items[s:s + 4] for s in range(0, 103, 4)])

    def test_bucketing_reduces_padding(self):
        _a, config = self.opts()
        _m, tok, cfg, items = self.items()
        pad = lambda chunks: sum(max(len(it["state_ids"]) for it in c) * len(c) for c in chunks)  # noqa: E731
        plain = pad(LF.micro_batches(items, 8, 0, None))
        bucketed = pad(LF.micro_batches(items, 8, 4, random.Random(0)))
        self.assertLess(bucketed, plain)

    def test_bf16_autocast_trains(self):
        _a, config = self.opts("--epochs", "1", "--micro-batch", "4", "--grad-accum", "2", "--loss", "soft-ce",
                               "--amp", "bf16", "--grad-ckpt", "on", "--bucket", "2")
        model, tok, cfg, items = self.items()
        h = LF.train_model(model, tok, items, config, torch.device("cpu"), cfg["max_len"], cfg["head_max_len"])
        self.assertTrue(all(math.isfinite(x) for x in h))


class TrainPy(unittest.TestCase):
    def test_fast_args(self):
        import train as T
        a = argparse.Namespace(fit_end=123.5, min_epochs=2, amp="bf16", grad_ckpt=None, optim=None, lora=16, bucket=None,
                               threads=None, sync_every=None)
        self.assertTrue(T.fast(a))
        self.assertEqual(T.fast_args(a, "/x/rate.json"), ["--rate-file", "/x/rate.json", "--min-epochs", "2",
                                                          "--fit-end", "123.5", "--amp", "bf16", "--lora", "16"])
        b = argparse.Namespace(fit_end=None, min_epochs=1, **{k: None for k in T.KNOBS})
        self.assertFalse(T.fast(b))


if __name__ == "__main__":
    unittest.main()
