#!/usr/bin/env python3
"""The learned danger estimate (review 2026-10-27, model track items 1 and 5): gradient-boosted trees on the per-action
danger logs, scored by calibration on held-out games.

See docs/finetune-laya-plan.md, "Model track: a learned danger estimate". busho writes danger.jsonl.gz with
DANGER_LOG=1; tools/danger/build.ts turns a set of games into a dataset (X.npy, y.npy, w.npy, g.npy, meta.json).

  train     one LightGBM model for one label. Games are split by start seed (a stable hash, so a rebuilt dataset keeps
            its split): test games are never seen in training, and early stopping uses a validation slice of the
            training games. Weights from build.ts's quiet subsampling are used throughout.
  scoring   on the test games, against baselines fitted on the training games: the base rate, and `hand`, the rules'
            kind of estimate (melee damage the visible monsters could do in two turns, over current HP, as busho's
            lethalWithinTwo computes it) calibrated by binning. Binary labels: log loss, Brier, AUC and the expected
            calibration error with a reliability table; damage labels: MSE, MAE and R^2. The model-minus-hand loss
            difference gets a 90% interval from a bootstrap over test games (rows in a game aren't independent).
  ablation  --drop takes feature-name prefixes out; --drop identity removes every monster slot's race and glyph class,
            so the difference shows what monster identity, the part a player learns by experience, adds.
  export    model.json: the trees (LightGBM's dump_model), feature names, categorical features, the vocabulary, the
            metrics, and parity rows (features and predictions) that tools/danger/model.test.ts checks the TypeScript
            evaluator against.

Usage: danger.py train DATASET --label death_20 --out DIR [--test-frac 0.2] [--drop identity|PREFIX,...] [--threads 4]
       danger.py describe DATASET          label rates, censoring and rows per game
"""
import argparse, hashlib, json, math, os, sys, time  # noqa: E401

import numpy as np

BINARY_PREFIXES = ("death_", "adv_", "die_")
PARAMS = {
    "learning_rate": 0.05, "num_leaves": 63, "min_data_in_leaf": 200, "feature_fraction": 0.8,
    "bagging_fraction": 0.8, "bagging_freq": 1, "lambda_l2": 1.0, "cat_smooth": 10, "min_data_per_group": 50,
    "max_cat_threshold": 64, "verbose": -1,
}
MAX_ROUNDS, EARLY_STOP = 3000, 100
BOOT = 1000


def load(path):
    with open(os.path.join(path, "meta.json")) as f: meta = json.load(f)
    arr = {k: np.load(os.path.join(path, f"{k}.npy"), mmap_mode="r") for k in ("X", "y", "w", "g")}
    return meta, arr


def is_binary(label):
    return label.startswith(BINARY_PREFIXES)


def game_bucket(game, salt="danger-split-1"):
    """A stable number in [0, 1) per start (seed and bank flag), so splits survive rebuilding the dataset."""
    key = f"{salt}:{game.get('seed')}:{game.get('bank')}:{game.get('class')}"
    return int(hashlib.sha256(key.encode()).hexdigest()[:12], 16) / 16 ** 12


def split(meta, test_frac=0.2, val_frac=0.1):
    """Game indices: (train, val, test). val is carved out of the non-test games."""
    b = np.array([game_bucket(g) for g in meta["games"]])
    test = b < test_frac
    val = (~test) & (b < test_frac + val_frac * (1 - test_frac))
    return np.where(~test & ~val)[0], np.where(val)[0], np.where(test)[0]


def rows_for(g, games):
    return np.isin(g, games)


# ── metrics (weighted) ──
def log_loss(y, p, w):
    p = np.clip(p, 1e-7, 1 - 1e-7)
    return float(np.sum(-w * (y * np.log(p) + (1 - y) * np.log(1 - p))) / np.sum(w))


def brier(y, p, w):
    return float(np.sum(w * (p - y) ** 2) / np.sum(w))


def auc(y, p, w):
    """Weighted ROC AUC by ranks (ties count half)."""
    order = np.argsort(p, kind="mergesort")
    y, p, w = y[order], p[order], w[order]
    pos, neg = w * (y > 0.5), w * (y <= 0.5)
    if pos.sum() == 0 or neg.sum() == 0: return float("nan")
    # group ties
    _, start = np.unique(p, return_index=True)
    bounds = list(start) + [len(p)]
    cum_neg, total = 0.0, 0.0
    for a, b in zip(bounds[:-1], bounds[1:]):
        pg, ng = pos[a:b].sum(), neg[a:b].sum()
        total += pg * (cum_neg + 0.5 * ng)
        cum_neg += ng
    return float(total / (pos.sum() * neg.sum()))


def reliability(y, p, w, bins=10):
    """Equal-weight bins of the prediction: [(mean predicted, observed rate, weight share)], and the ECE."""
    order = np.argsort(p, kind="mergesort")
    cw = np.cumsum(w[order]) / np.sum(w)
    table, ece = [], 0.0
    for k in range(bins):
        sel = order[(cw > k / bins) & (cw <= (k + 1) / bins + 1e-12)]
        if not len(sel): continue
        ws = w[sel].sum()
        pm, om = float(np.sum(w[sel] * p[sel]) / ws), float(np.sum(w[sel] * y[sel]) / ws)
        share = float(ws / np.sum(w))
        table.append((round(pm, 5), round(om, 5), round(share, 4)))
        ece += share * abs(pm - om)
    return table, float(ece)


def row_loss(y, p, binary):
    if binary:
        p = np.clip(p, 1e-7, 1 - 1e-7)
        return -(y * np.log(p) + (1 - y) * np.log(1 - p))
    return (p - y) ** 2


def scores(y, p, w, binary):
    if binary:
        table, ece = reliability(y, p, w)
        return {"log_loss": log_loss(y, p, w), "brier": brier(y, p, w), "auc": auc(y, p, w), "ece": ece,
                "mean_pred": float(np.sum(w * p) / np.sum(w)), "rate": float(np.sum(w * y) / np.sum(w)), "reliability": table}
    mse = float(np.sum(w * (p - y) ** 2) / np.sum(w))
    var = float(np.sum(w * (y - np.sum(w * y) / np.sum(w)) ** 2) / np.sum(w))
    table, _ = reliability(y, p, w)
    return {"mse": mse, "mae": float(np.sum(w * np.abs(p - y)) / np.sum(w)), "r2": 1 - mse / var if var > 0 else float("nan"),
            "mean_pred": float(np.sum(w * p) / np.sum(w)), "mean": float(np.sum(w * y) / np.sum(w)), "reliability": table}


def paired_boot(loss_a, loss_b, w, games, n=BOOT, seed=1):
    """Mean weighted loss difference a - b, with a 90% interval from resampling games."""
    uniq, inv = np.unique(games, return_inverse=True)
    da = np.bincount(inv, weights=w * (loss_a - loss_b), minlength=len(uniq))
    ws = np.bincount(inv, weights=w, minlength=len(uniq))
    rng = np.random.default_rng(seed)
    est = float(da.sum() / ws.sum())
    reps = []
    for _ in range(n):
        idx = rng.integers(0, len(uniq), len(uniq))
        reps.append(da[idx].sum() / ws[idx].sum())
    lo, hi = np.percentile(reps, [5, 95])
    return {"diff": est, "lo90": float(lo), "hi90": float(hi), "games": int(len(uniq))}


# ── baselines, fitted on the training rows ──
def binned(x_tr, y_tr, w_tr, x_te, bins=20, prior_w=50.0):
    """A step function of one feature: weighted label mean per quantile bin, shrunk to the overall mean."""
    ok = ~np.isnan(x_tr)
    edges = np.unique(np.quantile(x_tr[ok], np.linspace(0, 1, bins + 1)[1:-1])) if ok.any() else np.array([])
    mean = float(np.sum(w_tr * y_tr) / np.sum(w_tr))
    b_tr = np.where(ok, np.searchsorted(edges, x_tr, side="right"), len(edges) + 1)
    sums = np.bincount(b_tr, weights=w_tr * y_tr, minlength=len(edges) + 2)
    wts = np.bincount(b_tr, weights=w_tr, minlength=len(edges) + 2)
    table = (sums + prior_w * mean) / (wts + prior_w)
    b_te = np.where(np.isnan(x_te), len(edges) + 1, np.searchsorted(edges, np.nan_to_num(x_te), side="right"))
    return table[b_te]


def train(dataset, label, out, test_frac=0.2, drop=(), threads=4, params=None, max_rounds=MAX_ROUNDS, log=print):
    import lightgbm as lgb
    meta, a = load(dataset)
    li = meta["labels"].index(label)
    binary = is_binary(label)
    feats = [f for f in meta["features"] if not any(f.startswith(d) for d in drop if d)]
    fi = [meta["features"].index(f) for f in feats]
    cats = [f for f in meta["categorical"] if f in feats]
    tr_g, va_g, te_g = split(meta, test_frac)
    y_all = np.asarray(a["y"][:, li], dtype=np.float64)
    keep = ~np.isnan(y_all)
    g = np.asarray(a["g"])
    w = np.asarray(a["w"], dtype=np.float64)
    sel = {k: np.where(keep & rows_for(g, gs))[0] for k, gs in (("train", tr_g), ("val", va_g), ("test", te_g))}
    X = {k: np.asarray(a["X"][v][:, fi], dtype=np.float32) for k, v in sel.items()}
    Y = {k: y_all[v] for k, v in sel.items()}
    W = {k: w[v] for k, v in sel.items()}
    log(f"danger: {label} ({'binary' if binary else 'regression'}); rows train {len(Y['train'])}, val {len(Y['val'])}, "
        f"test {len(Y['test'])}; games {len(tr_g)}/{len(va_g)}/{len(te_g)}; {len(feats)} features")
    p = {**PARAMS, **(params or {}), "objective": "binary" if binary else "regression", "num_threads": threads,
         "seed": 1, "deterministic": True}
    t0 = time.time()
    dtr = lgb.Dataset(X["train"], Y["train"], weight=W["train"], feature_name=feats, categorical_feature=cats, free_raw_data=False)
    dva = lgb.Dataset(X["val"], Y["val"], weight=W["val"], reference=dtr)
    booster = lgb.train(p, dtr, num_boost_round=max_rounds, valid_sets=[dva],
                        callbacks=[lgb.early_stopping(EARLY_STOP, verbose=False)])
    secs = time.time() - t0
    pred = booster.predict(X["test"], num_iteration=booster.best_iteration)
    hand_col = meta["features"].index("hand_two")
    hand_tr = np.asarray(a["X"][sel["train"], hand_col], dtype=np.float64)
    hand_te = np.asarray(a["X"][sel["test"], hand_col], dtype=np.float64)
    base = np.full(len(Y["test"]), float(np.sum(W["train"] * Y["train"]) / np.sum(W["train"])))
    hand = binned(hand_tr, Y["train"], W["train"], hand_te)
    res = {"label": label, "binary": binary, "features": len(feats), "dropped": list(drop), "rounds": booster.best_iteration,
           "train_seconds": round(secs, 1), "rows": {k: len(v) for k, v in Y.items()},
           "games": {"train": len(tr_g), "val": len(va_g), "test": len(te_g)},
           "model": scores(Y["test"], pred, W["test"], binary),
           "base": scores(Y["test"], base, W["test"], binary),
           "hand": scores(Y["test"], hand, W["test"], binary)}
    gt = g[sel["test"]]
    lm = row_loss(Y["test"], pred, binary)
    res["model_minus_hand"] = paired_boot(lm, row_loss(Y["test"], hand, binary), W["test"], gt)
    res["model_minus_base"] = paired_boot(lm, row_loss(Y["test"], base, binary), W["test"], gt)
    imp = booster.feature_importance("gain")
    res["top_features"] = [(feats[i], round(float(imp[i] / imp.sum()), 4)) for i in np.argsort(-imp)[:20]]
    os.makedirs(out, exist_ok=True)
    export(booster, meta, label, binary, feats, cats, X["test"], pred, res, os.path.join(out, "model.json"))
    with open(os.path.join(out, "metrics.json"), "w") as f: json.dump(res, f, indent=1)
    log(summary(res))
    return res


SPLIT_KEYS = ("split_feature", "threshold", "decision_type", "default_left", "missing_type")


def slim(node):
    """A dumped tree node with only what evaluation needs (the dump also has gains, counts and internal values)."""
    if "leaf_value" in node: return {"leaf_value": node["leaf_value"]}
    return {**{k: node[k] for k in SPLIT_KEYS}, "left_child": slim(node["left_child"]), "right_child": slim(node["right_child"])}


def export(booster, meta, label, binary, feats, cats, x_test, pred, res, path, n_parity=64):
    """model.json for tools/danger/model.ts. Parity rows include NaNs and categorical values from the test set."""
    dump = booster.dump_model(num_iteration=booster.best_iteration)
    rng = np.random.default_rng(7)
    idx = rng.choice(len(x_test), size=min(n_parity, len(x_test)), replace=False) if len(x_test) else []
    parity = [{"x": [None if math.isnan(v) else float(v) for v in x_test[i]], "p": float(pred[i])} for i in idx]
    model = {"format": "danger-gbt-1", "label": label, "kind": "binary" if binary else "regression",
             "features": feats, "categorical": cats, "vocab": meta["vocab"],
             "trees": [slim(t["tree_structure"]) for t in dump["tree_info"]],
             "metrics": {k: res[k] for k in ("model", "base", "hand", "model_minus_hand", "rows", "games", "rounds")},
             "parity": parity}
    with open(path, "w") as f: json.dump(model, f)


def summary(res):
    m, h, b = res["model"], res["hand"], res["base"]
    if res["binary"]:
        d = res["model_minus_hand"]
        return (f"{res['label']}: test log loss model {m['log_loss']:.5f}, hand {h['log_loss']:.5f}, base {b['log_loss']:.5f}; "
                f"model-hand {d['diff']:+.5f} (90% {d['lo90']:+.5f}..{d['hi90']:+.5f}, {d['games']} games); "
                f"AUC {m['auc']:.3f} vs hand {h['auc']:.3f}; ECE {m['ece']:.5f}; rate {m['rate']:.5f}; {res['rounds']} rounds")
    d = res["model_minus_hand"]
    return (f"{res['label']}: test MSE model {m['mse']:.5f}, hand {h['mse']:.5f}, base {b['mse']:.5f}; R2 {m['r2']:.3f} "
            f"(hand {h['r2']:.3f}); model-hand {d['diff']:+.5f} (90% {d['lo90']:+.5f}..{d['hi90']:+.5f}); {res['rounds']} rounds")


def describe(dataset):
    meta, a = load(dataset)
    y, w = np.asarray(a["y"], dtype=np.float64), np.asarray(a["w"], dtype=np.float64)
    out = {"games": len(meta["games"]), "rows": int(len(w)), "records": meta["records"], "quiet_keep": meta["quiet_keep"],
           "deaths": sum(g["dead"] for g in meta["games"]), "labels": {}}
    for j, name in enumerate(meta["labels"]):
        ok = ~np.isnan(y[:, j])
        out["labels"][name] = {"censored": round(float(1 - ok.mean()), 4),
                               "mean": round(float(np.sum(w[ok] * y[ok, j]) / np.sum(w[ok])), 6) if ok.any() else None}
    return out


def expand_drop(spec):
    """Comma-separated feature-name prefixes; "identity" stands for every monster slot's race and glyph class."""
    out = []
    for d in filter(None, spec.split(",")):
        out += [f"m{k}_{f}" for k in range(4) for f in ("race", "base")] if d == "identity" else [d]
    return tuple(out)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train"); t.add_argument("dataset"); t.add_argument("--label", default="death_20")
    t.add_argument("--out", required=True); t.add_argument("--test-frac", type=float, default=0.2)
    t.add_argument("--drop", default=""); t.add_argument("--threads", type=int, default=4)
    t.add_argument("--max-rounds", type=int, default=MAX_ROUNDS)
    d = sub.add_parser("describe"); d.add_argument("dataset")
    a = ap.parse_args()
    if a.cmd == "train":
        train(a.dataset, a.label, a.out, a.test_frac, expand_drop(a.drop), a.threads, max_rounds=a.max_rounds)
    else:
        print(json.dumps(describe(a.dataset), indent=1))


if __name__ == "__main__":
    sys.exit(main())
