#!/usr/bin/env python3
"""Session 7 (~14 h): do the short rollout labels agree with the whole game? And trainG on all labels.

See docs/finetune-laya-plan.md, "Session 7". Honest view (PLAYER_VIEW=1), C engine. Two tracks from the start:
  CPU  valG    re-label held-out labelF decisions with long rollouts: 5,000 actions, scored like the tournament
               (deepest level gained - 3 if dead), same seeds and same rules continuation as labelF, with
               checkpoints at 50/150/500/1500 actions. Records where the short label disagrees with the rules
               alternate with records where it agrees.
       reportG horizon.py on valG: short-vs-long agreement and label/model-vs-rules at each horizon.
  GPU  evalE   trainE on valG's pool (its choices for reportG, and its accuracy on new held-out games).
       trainG  laya from the base model on labelD + labelE + labelF (4 epochs, capped to fit), the same game-hash
               split; scored on all held-out, the labelD/E part and the labelF part, and asked on valG's pool.
Resumable via RUN/state.json; `touch RUN/STOP` stops between stages. Never restart it mid-stage.

Usage: driver7.py --run runs/session7/<name> --prior runs/session6/2026-10-16 --prior5 runs/session5/2026-10-16
       [--hours 14] [--smoke] [--slots 13]
"""
import argparse, collections, json, os, random, signal, subprocess, sys, threading, time  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import driver5 as D5  # noqa: E402
import driver6 as D6  # noqa: E402
import evaluate  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
HERE = os.path.dirname(os.path.abspath(__file__))
D.SCHEDULE = [("valG", 13.5), ("reportG", 0.25), ("evalE", 0.25), ("trainG", 8.5)]
SMOKE_MINUTES = {"valG": 12, "reportG": 3, "evalE": 10, "trainG": 15}
HORIZON = 5000
CHECKPOINTS = "50,150,500,1500"
EPOCHS = 4  # session 6's sweep


def strict(p):
    best = max(p.values())
    top = [o for o, v in p.items() if v >= best - 1e-9]
    return top[0] if len(top) == 1 else None


def key(m): return (m["game_id"], m["turn"], m["decision_type"])


def pool(run):
    """Held-out labelF records with a single short-label winner, not all-tie: disagree-with-rules and agree
    alternate, each shuffled with a fixed seed. Written once (labelled records, and their raw decisions in order)."""
    pl, dec = run.d("valG", "pool.jsonl"), run.d("valG", "decisions.jsonl")
    if os.path.exists(dec): return pl, dec
    recs = [json.loads(l) for l in open(os.path.join(run.prior, "labelF", "labels.jsonl"))]
    _, held = D.split_by_game([r for r in recs if not r["meta"].get("all_tie")])
    held = [r for r in held if strict(r["gold"]["decision"]["probabilities"])]
    rng = random.Random("valG")
    dis = [r for r in held if strict(r["gold"]["decision"]["probabilities"]) != r["meta"]["rules_choice"]]
    agr = [r for r in held if strict(r["gold"]["decision"]["probabilities"]) == r["meta"]["rules_choice"]]
    rng.shuffle(dis); rng.shuffle(agr)
    order = [r for pair in zip(dis, agr) for r in pair] + dis[len(agr):] + agr[len(dis):]
    if run.smoke: order = order[:3]
    want = {key(r["meta"]) for r in order}
    raw = {}
    for line in open(os.path.join(run.prior5, "labelE", "decisions.jsonl")):
        r = json.loads(line)
        if (r["game_id"], r["turn"], r["decision_type"]) in want: raw[(r["game_id"], r["turn"], r["decision_type"])] = line
    order = [r for r in order if key(r["meta"]) in raw]
    with open(pl, "w") as f:
        for r in order: f.write(json.dumps(r) + "\n")
    with open(dec + ".tmp", "w") as f:
        for r in order: f.write(raw[key(r["meta"])])
    os.replace(dec + ".tmp", dec)
    run.state["valG_pool"] = {"records": len(order), "disagree": len(dis), "agree": len(agr)}; run.save()
    return pl, dec


# ── CPU ──
def stage_val(run, name, deadline):
    pl, dec = pool(run)
    out = run.d(name, "labels.jsonl")
    urls = [f"http://127.0.0.1:{4300 + i + D.PORT_OFFSET}" for i in range(run.slots)]
    script = ["tools/rollout/run.ts", "--decisions", dec, "--dir", run.prior5, "--out", out, "--servers", ",".join(urls),
              "--workers", str(run.slots), "--types", D2.MODEL_TYPES, "--k", "8", "--k-min", "8", "--order", "file",
              "--utility", "game", "--horizon", f"fight={HORIZON},tactic={HORIZON}", "--checkpoints", CHECKPOINTS]
    env = {"BUSHO_TMP": run.d(name, "tmp", "x")[:-2], "ANGBAND_C": D.C_BIN, **D5.HONEST}  # rules continuation, as labelF
    text, timed_out = D.run_node(run, f"ovn-{name}-orch", script, env, max(60, int(deadline - time.time())), heap_mb=0)
    open(run.d(name, "orchestrator.tail.log"), "w").write(("stopped at deadline\n" if timed_out else "") + text[-3000:])
    lines = open(out).read().split("\n")[:-1] if os.path.exists(out) else []
    recs = [json.loads(l) for l in lines]
    unl = run.d(name, "labels.unlabelled.jsonl")
    n_unl = sum(1 for _ in open(unl)) if os.path.exists(unl) else 0
    runs_err = sum(sum(r["meta"].get("runs_error", {}).values()) for r in recs)
    runs_all = sum(sum(r["meta"].get("runs_fired", {}).values()) for r in recs) or 1
    acts = [x["act"] for r in recs for o in r["meta"]["options"] for x in r["meta"]["runs"][o] if x.get("act")]
    res = {"labelled": len(recs), "unlabelled": n_unl, "by_type": dict(collections.Counter(r["meta"]["decision_type"] for r in recs)),
           "run_error_rate": round(runs_err / runs_all, 4), "mean_actions": round(sum(acts) / max(1, len(acts))),
           "reached_horizon": round(sum(a >= HORIZON for a in acts) / max(1, len(acts)), 3)}
    res["canary"] = D2.canary(res, [("labelled > 0", len(recs) > 0), ("labelled >= 150", run.smoke or len(recs) >= 150),
                                    ("run errors <= 2%", runs_err <= 0.02 * runs_all)])
    return res


def stage_report(run, name, deadline):
    lab = run.d("valG", "labels.jsonl")
    if not os.path.exists(lab) or not os.path.getsize(lab): return {"skipped": "no valG labels"}
    answers = [f"{m}={p}" for m, p in (("trainE", run.d("evalE", "pool.answers.jsonl")),
                                       ("trainG", run.d("trainG", "pool.answers.jsonl"))) if os.path.exists(p)]
    out = run.d(name, "horizon.json")
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "horizon.py"), "--long", lab,
                    "--short", os.path.join(run.prior, "labelF", "labels.jsonl"), "--out", out, "--answers", *answers],
                   stdout=subprocess.DEVNULL, timeout=max(60, deadline - time.time()))
    if not os.path.exists(out): return {"failed": "horizon.py failed"}
    res = json.load(open(out))
    res["canary"] = D2.canary(res, [("prefix identical >= 95%", res["prefix"]["rate"] >= 0.95 or res["prefix"]["compared"] == 0)])
    return res


# ── GPU ──
def stage_eval(run, name, deadline):
    pl, _ = pool(run)
    te = os.path.join(run.prior5, "trainE")
    out = run.d(name, "pool.json")
    return D6.evaluate_ckpt(os.path.join(te, "ckpt-s0.final"), pl, os.path.join(te, "data", "train.jsonl"), out)


def stage_train(run, name, deadline):
    te = os.path.join(run.prior5, "trainE")
    d = run.d(name, "data", "x")[:-2]
    counts, recs = collections.Counter(), []
    for line in open(os.path.join(te, "labels.combined.jsonl")):
        r = json.loads(line); recs.append(r); counts[r["meta"].get("source")] += 1
    for line in open(os.path.join(run.prior, "labelF", "labels.jsonl")):
        r = json.loads(line); recs.append(r); counts["labelF"] += 1
    recs = [r for r in recs if not r["meta"].get("all_tie")]
    train, held = D.split_by_game(recs)
    paths = {}
    for fn, rows in (("train", train), ("heldout", held),
                     ("heldout.DE", [r for r in held if r["meta"].get("source") in ("labelD", "labelE")]),
                     ("heldout.F", [r for r in held if r["meta"].get("source") == "labelF"])):
        paths[fn] = os.path.join(d, f"{fn}.jsonl")
        with open(paths[fn], "w") as f:
            for r in rows: f.write(json.dumps(r) + "\n")
    rate = run.prior_state.get("s_per_item_epoch", 0.5)
    room = deadline - time.time() - 60 * 60  # three evaluations and margin
    cap = int(room / (rate * max(1, len(train))))
    epochs = min(EPOCHS, cap)
    res = {"sources": dict(counts), "train_items": len(train), "heldout": len(held), "epochs_wanted": EPOCHS,
           "epochs_cap": cap, "s_per_item_epoch_assumed": rate}
    if epochs < 2 and not run.smoke:
        res["skipped"] = f"only {cap} epoch(s) fit before the deadline"; return res
    r = D6.train_eval(run, run.d(name, "x")[:-2], paths["train"], paths["heldout"], max(1, epochs), 0, deadline)
    res.update(r)
    if "ckpt" in r:
        for part in ("heldout.DE", "heldout.F"):
            if os.path.getsize(paths[part]):
                res[part] = D6.evaluate_ckpt(r["ckpt"], paths[part], paths["train"], run.d(name, f"offline.{part}.json"))
        res["pool"] = D6.evaluate_ckpt(r["ckpt"], pool(run)[0], paths["train"], run.d(name, "pool.json"))
    if "acc" in r:
        res["canary"] = D2.canary(res, [("acc > majority", r["acc"]["model"] > r["acc"].get("majority", 0))])
    return res


KINDS = {"valG": stage_val, "reportG": stage_report, "evalE": stage_eval, "trainG": stage_train}
D6.KINDS.update(KINDS)
D6.SMOKE_MINUTES.update(SMOKE_MINUTES)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--prior", required=True); ap.add_argument("--prior5", required=True)
    ap.add_argument("--hours", type=float, default=14); ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--slots", type=int, default=13)
    a = ap.parse_args()
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior, run.prior5 = os.path.abspath(a.prior), os.path.abspath(a.prior5)
    run.prior_state = json.load(open(os.path.join(run.prior, "state.json")))
    lock = threading.RLock()

    def shared(fn):
        """As in driver6: serialise state writers across the two tracks, retry a dump that raced, always unlock."""
        def wrapped(*args):
            for attempt in range(50):
                with lock:
                    try: return fn(*args)
                    except RuntimeError:
                        if attempt == 49: raise
                time.sleep(0.1)
        return wrapped
    run.save, D.write_report = shared(run.save), shared(D.write_report)
    signal.signal(signal.SIGTERM, lambda *_: D.STOP.set())
    app = D.app_dir(run)  # first: freezing the source recreates RUN/src
    cbin = D.freeze_c(run)
    run.log(f"driver7 start (smoke={a.smoke}, slots={a.slots}, engine={D.ENGINE}, c_bin={cbin}, "
            f"port_offset={D.PORT_OFFSET}); prior={run.prior}; prior5={run.prior5}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    end = run.state["deadline"]
    pool(run)  # before either track reads it
    try:
        def gpu():
            D6.run_stage(run, "evalE", end, a.smoke)
            D6.run_stage(run, "trainG", end - 20 * 60, a.smoke)
        g = threading.Thread(target=gpu)
        g.start()
        D6.run_stage(run, "valG", end - 30 * 60, a.smoke)
        g.join()  # reportG uses trainG's answers when it finished
        D6.run_stage(run, "reportG", end, a.smoke)
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        D.write_report(run)
        run.log("driver7 finished")


if __name__ == "__main__":
    main()
