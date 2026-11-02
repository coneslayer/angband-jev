#!/usr/bin/env python3
"""Tests for danger.py on a synthetic dataset in build.ts's format (no games needed).

Run: python3 -I tools/overnight/test_danger.py [-v]
DANGER_FIXTURE=tools/danger/fixtures/parity-model.json also writes the small model that tools/danger/model.test.ts
checks the TypeScript evaluator against (categorical splits, NaN routing and the sigmoid included).
"""
import json, os, shutil, sys, tempfile, unittest  # noqa: E401
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # run with -I
import numpy as np  # noqa: E402
import danger as DG  # noqa: E402

FEATURES = ["class", "prace", "hp_frac", "hand_two", "n_adj", "depth", "m0_race", "m0_base", "m0_level"]
CATEGORICAL = ["class", "prace", "m0_race", "m0_base"]
LABELS = ["death_20", "dmg_5"]
DEADLY = (3, 7, 11)


def synth(path, games=300, rows=200, seed=0):
    """Death within 20 turns rises with the hand estimate and low HP, and much more next to a few monster races,
    which the hand estimate can't see. Some levels and monsters are missing (NaN)."""
    rng = np.random.default_rng(seed)
    n = games * rows
    X = np.full((n, len(FEATURES)), np.nan, dtype=np.float32)
    X[:, 0] = rng.integers(0, 9, n); X[:, 1] = rng.integers(0, 11, n)
    X[:, 2] = rng.uniform(0.05, 1, n)
    present = rng.random(n) < 0.6
    X[:, 4] = np.where(present, rng.integers(0, 4, n), 0)
    X[:, 3] = np.where(present, rng.gamma(1.0, 0.4, n), 0)
    X[:, 5] = rng.integers(1, 12, n)
    race = rng.integers(0, 40, n)
    X[present, 6] = race[present]; X[present, 7] = race[present] % 9
    known = present & (rng.random(n) < 0.5)
    X[known, 8] = rng.integers(1, 15, known.sum())
    deadly = np.isin(X[:, 6], DEADLY)
    z = -5.5 + 2.0 * X[:, 3] - 2.0 * X[:, 2] + 2.5 * deadly
    p = 1 / (1 + np.exp(-z))
    y = np.zeros((n, len(LABELS)), dtype=np.float32)
    y[:, 0] = rng.random(n) < p
    y[:, 1] = np.clip(0.1 * X[:, 3] + 0.15 * deadly + rng.normal(0, 0.05, n), 0, None)
    y[rng.random(n) < 0.02, :] = np.nan  # censored
    w = np.ones(n, dtype=np.float32)
    g = np.repeat(np.arange(games, dtype=np.int32), rows)
    os.makedirs(path, exist_ok=True)
    for k, v in (("X", X), ("y", y), ("w", w), ("g", g)): np.save(os.path.join(path, f"{k}.npy"), v)
    meta = {"version": 1, "quiet_keep": 1, "records": n, "rows": n, "features": FEATURES, "categorical": CATEGORICAL,
            "labels": LABELS, "vocab": {"monster": [f"m{i}" for i in range(40)], "monsterBase": [f"b{i % 9}" for i in range(40)],
                                        "class": [], "race": []},
            "games": [{"id": f"g{i}", "seed": str(1000 + i), "class": "Warrior", "bank": False, "dead": False} for i in range(games)]}
    with open(os.path.join(path, "meta.json"), "w") as f: json.dump(meta, f)
    return meta


class Metrics(unittest.TestCase):
    def test_log_loss_brier_auc(self):
        y = np.array([0, 0, 1, 1.0]); p = np.array([0.1, 0.4, 0.35, 0.8]); w = np.ones(4)
        self.assertAlmostEqual(DG.brier(y, p, w), (0.01 + 0.16 + 0.4225 + 0.04) / 4)
        self.assertAlmostEqual(DG.auc(y, p, w), 0.75)
        self.assertAlmostEqual(DG.auc(y, np.array([0.5, 0.5, 0.5, 0.5]), w), 0.5)
        self.assertAlmostEqual(DG.log_loss(y, np.full(4, 0.5), w), np.log(2))

    def test_weights_equal_repeats(self):
        y = np.array([0, 1.0, 0]); p = np.array([0.2, 0.7, 0.4])
        rep_y, rep_p = np.array([0, 1, 1, 0, 0, 0.0]), np.array([0.2, 0.7, 0.7, 0.4, 0.4, 0.4])
        w = np.array([1, 2, 3.0])
        self.assertAlmostEqual(DG.log_loss(y, p, w), DG.log_loss(rep_y, rep_p, np.ones(6)))
        self.assertAlmostEqual(DG.auc(y, p, w), DG.auc(rep_y, rep_p, np.ones(6)))

    def test_reliability_perfect(self):
        rng = np.random.default_rng(3)
        p = rng.uniform(0, 1, 200000); y = (rng.random(200000) < p).astype(float)
        table, ece = DG.reliability(y, p, np.ones_like(p))
        self.assertEqual(len(table), 10)
        self.assertLess(ece, 0.01)

    def test_binned_baseline(self):
        x = np.array([0, 0, 1, 1, np.nan, np.nan]); y = np.array([0, 0, 1, 1, 1, 0.0])
        out = DG.binned(x, y, np.ones(6), np.array([0, 1, np.nan]), bins=2, prior_w=0)
        np.testing.assert_allclose(out, [0, 1, 0.5])


class Split(unittest.TestCase):
    def test_stable_and_disjoint(self):
        meta = {"games": [{"seed": str(s), "bank": s % 5 == 0, "class": "Rogue"} for s in range(2000)]}
        tr, va, te = DG.split(meta)
        self.assertEqual(len(set(tr) | set(va) | set(te)), 2000)
        self.assertFalse(set(tr) & set(te) or set(va) & set(te) or set(tr) & set(va))
        self.assertAlmostEqual(len(te) / 2000, 0.2, delta=0.03)
        self.assertAlmostEqual(len(va) / 2000, 0.08, delta=0.03)
        meta2 = {"games": list(reversed(meta["games"]))}
        te2 = {meta2["games"][i]["seed"] for i in DG.split(meta2)[2]}
        self.assertEqual(te2, {meta["games"][i]["seed"] for i in te})


class Train(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.ds = os.path.join(cls.tmp, "ds")
        synth(cls.ds)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_death_beats_hand_and_is_calibrated(self):
        out = os.path.join(self.tmp, "m1")
        res = DG.train(self.ds, "death_20", out, threads=2, log=lambda *_: None)
        self.assertLess(res["model"]["log_loss"], res["hand"]["log_loss"])
        self.assertLess(res["model_minus_hand"]["hi90"], 0)
        self.assertGreater(res["model"]["auc"], res["hand"]["auc"])
        self.assertLess(res["model"]["ece"], 0.01)
        model = read_json(os.path.join(out, "model.json"))
        self.assertEqual(model["kind"], "binary")
        self.assertEqual(model["features"], FEATURES)
        self.assertTrue(any("||" in str(n.get("threshold", "")) or n.get("decision_type") == "=="
                            for t in model["trees"] for n in walk(t)), "a categorical split")

    def test_identity_ablation(self):
        full = DG.train(self.ds, "death_20", os.path.join(self.tmp, "m2"), threads=2, log=lambda *_: None)
        blind = DG.train(self.ds, "death_20", os.path.join(self.tmp, "m3"), drop=("m0_race", "m0_base"), threads=2,
                         log=lambda *_: None)
        self.assertLess(full["model"]["log_loss"], blind["model"]["log_loss"])

    def test_regression(self):
        res = DG.train(self.ds, "dmg_5", os.path.join(self.tmp, "m4"), threads=2, log=lambda *_: None)
        self.assertGreater(res["model"]["r2"], res["hand"]["r2"])
        self.assertGreater(res["model"]["r2"], 0.5)

    def test_parity_rows_match_booster(self):
        import lightgbm as lgb
        out = os.path.join(self.tmp, "m5")
        DG.train(self.ds, "death_20", out, threads=2, params={"num_leaves": 15}, max_rounds=12, log=lambda *_: None)
        model = read_json(os.path.join(out, "model.json"))
        self.assertGreater(len(model["parity"]), 10)
        self.assertTrue(any(v is None for r in model["parity"] for v in r["x"]), "parity rows include NaN")
        self.assertEqual(len(model["trees"]), model["metrics"]["rounds"])
        # an independent tree walk in Python agrees with LightGBM, so model.ts can be checked against the same rows
        for r in model["parity"]:
            x = [float("nan") if v is None else v for v in r["x"]]
            raw = sum(eval_tree(t, x) for t in model["trees"])
            self.assertAlmostEqual(1 / (1 + np.exp(-raw)), r["p"], places=12)
        fixture = os.environ.get("DANGER_FIXTURE")
        if fixture:
            os.makedirs(os.path.dirname(fixture), exist_ok=True)
            shutil.copy(os.path.join(out, "model.json"), fixture)
        del lgb


def read_json(path):
    with open(path) as f: return json.load(f)


def walk(node):
    yield node
    for k in ("left_child", "right_child"):
        if k in node: yield from walk(node[k])


def eval_tree(node, x):
    """LightGBM's Tree::Decision, written out independently of model.ts."""
    while "leaf_value" not in node:
        v = float(np.float32(x[node["split_feature"]]))
        if node["decision_type"] == "==":
            cats = {int(c) for c in str(node["threshold"]).split("||")}
            node = node["left_child"] if (not np.isnan(v) and v >= 0 and int(v) in cats) else node["right_child"]
            continue
        if np.isnan(v) and node["missing_type"] != "NaN": v = 0.0
        if (node["missing_type"] == "Zero" and abs(v) <= 1e-35) or (node["missing_type"] == "NaN" and np.isnan(v)):
            node = node["left_child"] if node["default_left"] else node["right_child"]
        else:
            node = node["left_child"] if v <= node["threshold"] else node["right_child"]
    return node["leaf_value"]


if __name__ == "__main__":
    unittest.main()
