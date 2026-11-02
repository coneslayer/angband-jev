#!/usr/bin/env python3
"""Session 10 (~22 h): does a confidence gate make trainG's overrides pay? And trainH on labels from its own games.

See docs/finetune-laya-plan.md, "Session 10". Honest view (PLAYER_VIEW=1), C engine, rules+ (caution +1) under every
arm. Session 9 found (post hoc, on both halves of the games) that trainG's overrides win more often than the rules'
choice when its confidence is at least 0.05, and lose below it.
Phase 1 (CPU + GPU serving):
  finalJ   tournament on new seeds, starts in a fixed order (4 fresh : 1 bank, session 5's bank): rules+; G-c05 (trainG,
           acts only at confidence >= 0.05, label-horizon cooldown, as session 8's G-cool); G-c10 (the same at 0.1);
           rules+-replay on the first 24 starts. Starts complete in every main arm are analysed.
Phase 2, two tracks:
  GPU  trainH  laya from the base model on labelD + labelE + labelF + labelH, 4 epochs (capped to fit), the game-hash
               split; scored on all held-out and each part; trainG answers held-out labelH too, and both models'
               overrides there are scored against the rules with the labels' utilities.
  CPU  labelJ  rollout labels on G-c05's finalJ games (the gated player's own states), rules+ continuing,
               disagree and agree 3 to 1.
       reportJ driver9's override report on labelJ (acted / cooldown / gate, pair, confidence).
Resumable via RUN/state.json; `touch RUN/STOP` stops between stages. Never restart it mid-stage.

Usage: driver10.py --run runs/session10/<name> --prior5 runs/session5/2026-10-16 --prior6 runs/session6/2026-10-16
       --prior7 runs/session7/2026-10-17 --prior9 runs/session9/2026-10-21 [--hours 22] [--smoke] [--slots 13]
"""
import argparse, collections, json, os, signal, sys, threading, time  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import driver6 as D6  # noqa: E402
import driver8 as D8  # noqa: E402
import driver9 as D9  # noqa: E402
import evaluate  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
D.SCHEDULE = [("finalJ", 12.0), ("trainH", 9.4), ("labelJ", 9.4), ("reportJ", 0.1)]
SMOKE_MINUTES = {"finalJ": 15, "trainH": 15, "labelJ": 8, "reportJ": 2}
PHASE2_HOURS = 9.75  # trainH: about 18,900 items x 4 epochs x 0.403 s (trainG's rate) = 8.4 h, plus evaluations
EPOCHS = 4
GATED = "G-c05"  # labelJ's source
D8.STARTS = {"rng": "finalJ", "fresh": 2900000, "bank": 2950000}
D8.HEAD_TO_HEAD = (("G-c05", "G-c10"),)


def arms_for(run):
    g = os.path.join(run.prior7, "trainG", "ckpt-e4-s0.final")
    m = {"ckpt": g, "guard": "oil,potion", "caution": 1.0, "cooldown": D8.LABEL_COOLDOWN}
    return [{"name": "rules+", "ckpt": None, "guard": "", "caution": 1.0},
            {"name": "G-c05", **m, "min_conf": "0.05"},
            {"name": "G-c10", **m, "min_conf": "0.1"},
            {"name": "rules+-replay", "ckpt": None, "guard": "", "caution": 1.0, "replay": True}]


D8.arms_for = arms_for


def stage_tournament(run, name, deadline):
    res = D8.stage_tournament(run, name, deadline)
    # the gate must bind: some overrides blocked by it, in every gated arm
    checks = [(c, False) for c in res["canary"]["failed"]]
    for a in arms_for(run):
        if not a.get("ckpt"): continue
        blocked = 0
        for g in os.listdir(run.d(name, a["name"], "x")[:-2]):
            p = os.path.join(run.path, name, a["name"], g, "decisions.jsonl")
            if os.path.exists(p):
                blocked += sum(1 for r in map(json.loads, open(p)) if D9.disagrees(r) and not r.get("guard") and D9.status(r) == "gate")
        res["vs_rules+"].setdefault(a["name"], {})["blocked_by_gate"] = blocked
        checks.append((f"{a['name']}: gate binds", blocked > 0))
    res["canary"] = D2.canary(res, checks)
    return res


# ── phase 2: GPU ──
def stage_train(run, name, deadline):
    d = run.d(name, "data", "x")[:-2]
    counts, recs = collections.Counter(), []
    for path, src in ((os.path.join(run.prior5, "trainE", "labels.combined.jsonl"), None),
                      (os.path.join(run.prior6, "labelF", "labels.jsonl"), "labelF"),
                      (os.path.join(run.prior9, "labelH", "labels.jsonl"), "labelH")):
        for line in open(path).read().split("\n")[:-1]:
            r = json.loads(line)
            if src: r["meta"]["source"] = src
            recs.append(r); counts[r["meta"].get("source")] += 1
    recs = [r for r in recs if not r["meta"].get("all_tie")]
    train, held = D.split_by_game(recs)
    parts = {"heldout.DE": ("labelD", "labelE"), "heldout.F": ("labelF",), "heldout.H": ("labelH",)}
    paths = {}
    for fn, rows in (("train", train), ("heldout", held),
                     *((p, [r for r in held if r["meta"].get("source") in srcs]) for p, srcs in parts.items())):
        paths[fn] = os.path.join(d, f"{fn}.jsonl")
        with open(paths[fn], "w") as f:
            for r in rows: f.write(json.dumps(r) + "\n")
    rate = 0.403  # trainG's seconds per item-epoch (session 7)
    room = deadline - time.time() - 75 * 60  # five evaluations and margin
    cap = int(room / (rate * max(1, len(train))))
    epochs = min(EPOCHS, cap)
    res = {"sources": dict(counts), "train_items": len(train), "heldout": len(held), "epochs_wanted": EPOCHS,
           "epochs_cap": cap, "s_per_item_epoch_assumed": rate}
    if epochs < 2 and not run.smoke:
        res["skipped"] = f"only {cap} epoch(s) fit before the deadline"; return res
    r = D6.train_eval(run, run.d(name, "x")[:-2], paths["train"], paths["heldout"], max(1, epochs), 0, deadline)
    res.update(r)
    g = os.path.join(run.prior7, "trainG", "ckpt-e4-s0.final")
    res["trainG.heldout.H"] = D6.evaluate_ckpt(g, paths["heldout.H"], paths["train"], run.d(name, "trainG.heldout.H.json"))
    res["overrides.H"] = {"trainG": overrides_vs_rules(paths["heldout.H"], run.d(name, "trainG.heldout.H.answers.jsonl"))}
    if "ckpt" in r:
        for part in parts:
            if os.path.getsize(paths[part]):
                res[part] = D6.evaluate_ckpt(r["ckpt"], paths[part], paths["train"], run.d(name, f"offline.{part}.json"))
        res["overrides.H"]["trainH"] = overrides_vs_rules(paths["heldout.H"], run.d(name, "offline.heldout.H.answers.jsonl"))
    if "acc" in r:
        res["canary"] = D2.canary(res, [("acc > majority", r["acc"]["model"] > r["acc"].get("majority", 0))])
    return res


def overrides_vs_rules(labels, answers):
    """Where a model's offline answer differs from the rules' choice: the label's mean utility of its choice minus
    the rules', overall and at each confidence."""
    if not os.path.exists(answers): return {"failed": "no answers"}
    ans = {(a["game_id"], a["turn"], a["type"]): a["answer"] for a in map(json.loads, open(answers)) if a}
    rows = []
    for m in (json.loads(l)["meta"] for l in open(labels)):
        a = ans.get((m["game_id"], m["turn"], m["decision_type"])) or {}
        c, rc, u = a.get("choice"), m.get("rules_choice"), m["u_mean"]
        if c and rc and c != rc and c in u and rc in u: rows.append((a.get("confidence") or 0, u[c] - u[rc]))
    return {"n_records": sum(1 for _ in open(labels)),
            "conf_at_least": {str(b): D9.tally([d for c, d in rows if c >= b]) for b in D9.CONF_BINS}}


# ── phase 2: CPU ──
def stage_label(run, name, deadline):
    dec = run.d(name, "decisions.jsonl")
    if not os.path.exists(dec):
        run.state["labelJ_pool"] = D9.build_pool(run.path, os.path.join("finalJ", GATED), dec, "labelJ", run.smoke); run.save()
    return D9.label(run, name, dec, run.path, deadline)


def stage_report(run, name, deadline):
    lab = run.d("labelJ", "labels.jsonl")
    if not os.path.exists(lab) or not os.path.getsize(lab): return {"skipped": "no labelJ labels"}
    res = D9.report(D9.overrides(lab, run.d("labelJ", "decisions.jsonl")), run.smoke)
    with open(run.d(name, "report.json"), "w") as f: json.dump(res, f, indent=1)
    return res


KINDS = {"finalJ": stage_tournament, "trainH": stage_train, "labelJ": stage_label, "reportJ": stage_report}
D6.KINDS.update(KINDS)
D6.SMOKE_MINUTES.update(SMOKE_MINUTES)


def main():
    ap = argparse.ArgumentParser()
    for p in ("--run", "--prior5", "--prior6", "--prior7", "--prior9"): ap.add_argument(p, required=True)
    ap.add_argument("--hours", type=float, default=22); ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--slots", type=int, default=13)
    a = ap.parse_args()
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior = run.prior5 = os.path.abspath(a.prior5)  # run.prior: session 5's C bank (D2.bank_files)
    run.prior6, run.prior7, run.prior9 = (os.path.abspath(p) for p in (a.prior6, a.prior7, a.prior9))
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
    run.log(f"driver10 start (smoke={a.smoke}, slots={a.slots}, engine={D.ENGINE}, c_bin={cbin}, "
            f"port_offset={D.PORT_OFFSET}); prior5={run.prior5}; prior6={run.prior6}; prior7={run.prior7}; "
            f"prior9={run.prior9}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    end = run.state["deadline"]
    try:
        D6.run_stage(run, "finalJ", end - PHASE2_HOURS * 3600, a.smoke)
        g = threading.Thread(target=D6.run_stage, args=(run, "trainH", end - 20 * 60, a.smoke))
        g.start()
        D6.run_stage(run, "labelJ", end - 30 * 60, a.smoke)
        D6.run_stage(run, "reportJ", end - 20 * 60, a.smoke)
        g.join()
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        D.write_report(run)
        run.log("driver10 finished")


if __name__ == "__main__":
    main()
