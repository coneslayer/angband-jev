#!/usr/bin/env python3
"""Session 13 (~24 h): a better model from the gated players' own states.

See docs/finetune-laya-plan.md, "Session 13". Honest view (PLAYER_VIEW=1), C engine, rules+ (caution +1, upnavfood).
trainH gated at 0.1 (H-c10) wins about 52% of pairs against rules+ over sessions 11 and 12. labelJ (G-c05's own
states, 8,927 labels) has never been trained on, and H-c10's own states have never been labelled.
Phase 1, two tracks:
  GPU  trainI0  laya from the base model on labelD-H (trainH's data) + labelJ, 3 epochs (capped to fit); held out:
                trainH's games (10%) and a quarter of labelJ's games. trainH answers held-out labelJ too.
  CPU  labelL   rollout labels on H-c10's session 12 games, rules+ continuing; disagreements alternate between trainH
                confidence >= 0.1 and below, agree records 1 in 4.
Phase 2, two tracks:
  GPU  trainIL  trainI0 continued on labelL (train games), 2 epochs; trainHJL: trainH continued on labelJ + labelL
                (train games), 2 epochs. trainH, trainI0 and both continuations answer held-out labelL (a quarter of its
                games); the continuations also held-out labelJ and trainH's held-out. Chooses the candidate for finalM.
  CPU  labelM   rollout labels on H-c10's session 11 games, as labelL (for session 14's training).
       reportL  driver9's override report on labelL (trainH's overrides on its own states).
Phase 3:
  finalM  tournament on new seeds: rules+; H-c10; X-c10 (the chosen candidate, gated and cooled as H-c10);
          rules+-replay on the first 24 starts. Without a candidate: rules+ and H-c10 only.
Resumable via RUN/state.json; `touch RUN/STOP` stops between stages. Never restart it mid-stage.

Usage: driver13.py --run runs/session13/<name> --prior5 runs/session5/2026-10-16 --prior6 runs/session6/2026-10-16
       --prior9 runs/session9/2026-10-21 --prior10 runs/session10/2026-10-21 --prior11 runs/session11/2026-10-22
       --prior12 runs/session12/2026-10-23 [--hours 24] [--smoke] [--slots 13]
"""
import argparse, collections, hashlib, json, os, random, signal, sys, threading, time  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import driver6 as D6  # noqa: E402
import driver8 as D8  # noqa: E402
import driver9 as D9  # noqa: E402
import driver10 as D10  # noqa: E402
import evaluate  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
PHASE1_HOURS, PHASE3_HOURS = 11.0, 5.75  # phase 2 is what's left: 7.25 h of 24
D.SCHEDULE = [("trainI0", PHASE1_HOURS), ("labelL", PHASE1_HOURS), ("trainIL", 7.25), ("labelM", 7.1),
              ("reportL", 0.1), ("finalM", PHASE3_HOURS)]
SMOKE_MINUTES = {"trainI0": 15, "labelL": 8, "trainIL": 25, "labelM": 6, "reportL": 2, "finalM": 15}
RATE = 0.469  # trainH's seconds per item-epoch with labelling on the CPU (session 10)
EPOCHS_BASE, EPOCHS_CONT = 3, 2
NEW_FRAC = 0.25  # held out from the on-policy sets (labelJ, labelL); trainH's sets keep its 10% split
GATE = 0.1
D8.STARTS = {"rng": "finalM", "fresh": 3200000, "bank": 3250000}


def trainH(run): return os.path.join(run.prior10, "trainH", "ckpt-e3-s0.final")


def held_out(r):
    frac = NEW_FRAC if r["meta"].get("source") in ("labelJ", "labelL") else 0.1
    return int(hashlib.sha1(r["meta"]["game_id"].encode()).hexdigest(), 16) % 1000 < frac * 1000


def load(path, src=None):
    recs = []
    for line in open(path).read().split("\n")[:-1]:  # drop a partial last line
        r = json.loads(line)
        if src: r["meta"]["source"] = src
        if not r["meta"].get("all_tie"): recs.append(r)
    return recs


def write(path, rows, cap=None):
    with open(path, "w") as f:
        rows = rows[:cap] if cap else rows
        for r in rows: f.write(json.dumps(r) + "\n")
    return path


def epochs_for(n, deadline, reserve_min, want):
    cap = int((deadline - time.time() - reserve_min * 60) / (RATE * max(1, n)))
    return min(want, cap), cap


def answer(run, ckpt, held, train, tag, stage):
    """Offline accuracy on `held`, and the model's overrides of the rules there scored with the labels' utilities."""
    out = run.d(stage, f"{tag}.json")
    res = D6.evaluate_ckpt(ckpt, held, train, out)
    res["overrides"] = D10.overrides_vs_rules(held, out.replace(".json", "") + ".answers.jsonl")
    return res


def gate_score(ev):
    """Net utility of acting at the gate, per 1,000 held-out records: the sum over the model's overrides at
    confidence >= GATE of its choice's mean utility minus the rules'."""
    ov = ev.get("overrides") or {}
    t = (ov.get("conf_at_least") or {}).get(str(GATE))
    if not t or not t["n"] or t["mean_diff"] is None: return None
    return round(1000 * t["mean_diff"] * t["n"] / max(1, ov["n_records"]), 2)


# ── phase 1: GPU ──
def stage_train_base(run, name, deadline):
    d = run.d(name, "data", "x")[:-2]
    recs = (load(os.path.join(run.prior5, "trainE", "labels.combined.jsonl"))
            + load(os.path.join(run.prior6, "labelF", "labels.jsonl"), "labelF")
            + load(os.path.join(run.prior9, "labelH", "labels.jsonl"), "labelH")
            + load(os.path.join(run.prior10, "labelJ", "labels.jsonl"), "labelJ"))
    train = [r for r in recs if not held_out(r)]
    held = [r for r in recs if held_out(r)]
    small = 150 if run.smoke else None
    paths = {"train": write(os.path.join(d, "train.jsonl"), train),
             "train.J": write(os.path.join(d, "train.J.jsonl"), [r for r in train if r["meta"]["source"] == "labelJ"]),
             "heldout.DH": write(os.path.join(d, "heldout.DH.jsonl"), [r for r in held if r["meta"]["source"] != "labelJ"], small),
             "heldout.J": write(os.path.join(d, "heldout.J.jsonl"), [r for r in held if r["meta"]["source"] == "labelJ"], small)}
    run.state["paths"] = paths; run.save()
    res = {"sources": dict(collections.Counter(r["meta"].get("source") for r in recs)), "train_items": len(train),
           "heldout": len(held), "epochs_wanted": EPOCHS_BASE}
    res["trainH.heldout.J"] = answer(run, trainH(run), paths["heldout.J"], paths["train"], "trainH.heldout.J", name)
    epochs, cap = epochs_for(len(train), deadline, 30, EPOCHS_BASE)
    res["epochs_cap"] = cap
    if epochs < 2 and not run.smoke:
        res["skipped"] = f"only {cap} epoch(s) fit before the deadline"; return res
    r = D6.train_eval(run, run.d(name, "x")[:-2], paths["train"], paths["heldout.DH"], max(1, epochs), 0, deadline)
    res.update(r)
    if "ckpt" in r:
        run.state["ckpt"] = {**run.state.get("ckpt", {}), "trainI0": r["ckpt"]}; run.save()
        res["heldout.J"] = answer(run, r["ckpt"], paths["heldout.J"], paths["train"], "trainI0.heldout.J", name)
        res["canary"] = D2.canary(res, [("acc > majority", r["acc"]["model"] > r["acc"].get("majority", 0))])
    return res


# ── phase 2: GPU ──
def stage_train_cont(run, name, deadline):
    d = run.d(name, "data", "x")[:-2]
    lab = run.d("labelL", "labels.jsonl")
    L = load(lab, "labelL") if os.path.exists(lab) else []
    if not L: return {"failed": "no labelL labels"}
    paths = run.state["paths"]
    trainL = [r for r in L if not held_out(r)]
    trainJ = load(paths["train.J"])
    p = {"train.L": write(os.path.join(d, "train.L.jsonl"), trainL),
         "train.JL": write(os.path.join(d, "train.JL.jsonl"), trainJ + trainL),
         "heldout.L": write(os.path.join(d, "heldout.L.jsonl"), [r for r in L if held_out(r)], 150 if run.smoke else None)}
    res = {"labelL": len(L), "train.L": len(trainL), "train.JL": len(trainJ) + len(trainL),
           "heldout.L": sum(1 for _ in open(p["heldout.L"]))}
    base = {"trainH": trainH(run), "trainI0": run.state.get("ckpt", {}).get("trainI0")}
    runs = (("trainIL", "trainI0", p["train.L"]), ("trainHJL", "trainH", p["train.JL"]))
    for i, (tag, frm, data) in enumerate(runs):
        if not base[frm]: res[tag] = {"failed": f"no {frm} checkpoint"}; continue
        n = sum(1 for _ in open(data))
        later = sum(sum(1 for _ in open(x)) * EPOCHS_CONT * RATE / 60 for _, _, x in runs[i + 1:])
        epochs, cap = epochs_for(n, deadline, 40 + later, EPOCHS_CONT)
        if epochs < 1 and not run.smoke: res[tag] = {"skipped": f"only {cap} epochs fit"}; continue
        r = D6.train_eval(run, run.d(name, tag, "x")[:-2], data, p["heldout.L"], max(1, epochs), 0, deadline,
                          base=base[frm])
        r["from"] = frm
        if "ckpt" in r:
            base[tag] = r["ckpt"]
            r["heldout.L"] = answer(run, r["ckpt"], p["heldout.L"], data, f"{tag}.heldout.L", name)
            r["heldout.J"] = answer(run, r["ckpt"], paths["heldout.J"], data, f"{tag}.heldout.J", name)
            r["heldout.DH"] = D6.evaluate_ckpt(r["ckpt"], paths["heldout.DH"], data, run.d(name, f"{tag}.heldout.DH.json"))
        res[tag] = r
    for tag in ("trainH", "trainI0"):
        if base[tag]:
            res[tag] = {"heldout.L": answer(run, base[tag], p["heldout.L"], paths["train"], f"{tag}.heldout.L", name)}
    if base["trainH"]:
        res["trainH"]["heldout.DH"] = D6.evaluate_ckpt(base["trainH"], paths["heldout.DH"], paths["train"],
                                                       run.d(name, "trainH.heldout.DH.json"))
    res["choice"] = choose(run, res, base)
    run.state["candidate"] = res["choice"].get("ckpt"); run.save()
    return res


def choose(run, res, base):
    """Pre-committed: the candidate with the best gate score on held-out labelL plays finalM if that score beats
    trainH's, its held-out labelL accuracy beats the majority, and its accuracy on trainH's held-out is no more than
    2 points below trainH's."""
    def acc(ev, k="model"): return ((ev or {}).get("acc") or {}).get(k)
    sI0 = run.state["stages"].get("trainI0", {}).get("result", {})
    hdh = acc((res.get("trainH") or {}).get("heldout.DH"))
    rows = {}
    for tag in ("trainH", "trainI0", "trainIL", "trainHJL"):
        ev = (res.get(tag) or {}).get("heldout.L")
        if not ev or tag not in base or not base[tag]: continue
        dh = sI0 if tag == "trainI0" else res[tag].get("heldout.DH")  # trainI0 was scored on it when trained
        rows[tag] = {"gate_score": gate_score(ev), "acc_L": acc(ev), "majority_L": acc(ev, "majority"), "acc_DH": acc(dh),
                     "overrides_at_gate": ((ev.get("overrides") or {}).get("conf_at_least") or {}).get(str(GATE))}
    out = {"table": rows, "trainH_acc_DH": hdh}
    h = (rows.get("trainH") or {}).get("gate_score")
    ok = []
    for tag, r in rows.items():
        if tag == "trainH" or r["gate_score"] is None: continue
        if h is not None and r["gate_score"] <= h: continue
        if r["acc_L"] is None or r["majority_L"] is None or r["acc_L"] <= r["majority_L"]: continue
        if hdh is not None and (r["acc_DH"] is None or r["acc_DH"] < hdh - 0.02): continue
        ok.append((r["gate_score"], tag))
    if ok:
        tag = max(ok)[1]
        out.update(chosen=tag, ckpt=base[tag])
    else:
        out["chosen"] = None
    return out


# ── CPU ──
def build_pool(base, rel, dec, seed, smoke):
    """As driver9's, but the disagreements alternate between trainH's confidence >= GATE and below, so the overrides
    a gated player can act on are a half of them instead of about a third."""
    root = os.path.join(base, rel)
    hi, lo, agr, seen = [], [], [], set()
    for g in sorted(os.listdir(root)):
        f = os.path.join(root, g, "decisions.jsonl")
        if not os.path.exists(f): continue
        for line in open(f):
            r = json.loads(line)
            if r.get("decision_type") not in D9.TYPES or not r.get("snapshot") or D9.key(r) in seen: continue
            if r.get("guard"): continue
            seen.add(D9.key(r))
            r["snapshot"] = os.path.join(rel, g, r["snapshot"])
            if not D9.disagrees(r): agr.append(r)
            else: (hi if (r.get("model_confidence") or 0) >= GATE else lo).append(r)
    rng = random.Random(seed)
    for x in (hi, lo, agr): rng.shuffle(x)
    dis = [r for pair in zip(hi, lo) for r in pair] + hi[len(lo):] + lo[len(hi):]
    order, ai = [], 0
    for i, r in enumerate(dis):
        order.append(r)
        if i % 3 == 2 and ai < len(agr): order.append(agr[ai]); ai += 1
    order += agr[ai:]
    if smoke: order = order[:24]
    with open(dec + ".tmp", "w") as f:
        for r in order: f.write(json.dumps(r) + "\n")
    os.replace(dec + ".tmp", dec)
    return {"records": len(order), "disagree_hi": len(hi), "disagree_lo": len(lo), "agree": len(agr)}


def stage_label(run, name, deadline):
    base = run.prior12 if name == "labelL" else run.prior11
    rel = os.path.join("finalL" if name == "labelL" else "finalK", "H-c10")
    dec = run.d(name, "decisions.jsonl")
    if not os.path.exists(dec):
        run.state[f"{name}_pool"] = build_pool(base, rel, dec, name, run.smoke); run.save()
    return D9.label(run, name, dec, base, deadline)


def stage_report(run, name, deadline):
    lab = run.d("labelL", "labels.jsonl")
    if not os.path.exists(lab) or not os.path.getsize(lab): return {"skipped": "no labelL labels"}
    res = D9.report(D9.overrides(lab, run.d("labelL", "decisions.jsonl")), run.smoke)
    with open(run.d(name, "report.json"), "w") as f: json.dump(res, f, indent=1)
    return res


# ── phase 3 ──
def arms_for(run):
    m = {"guard": "oil,potion", "caution": 1.0, "min_conf": str(GATE), "cooldown": D8.LABEL_COOLDOWN}
    arms = [{"name": "rules+", "ckpt": None, "guard": "", "caution": 1.0}, {"name": "H-c10", "ckpt": trainH(run), **m}]
    if run.state.get("candidate"): arms.append({"name": "X-c10", "ckpt": run.state["candidate"], **m})
    return arms + [{"name": "rules+-replay", "ckpt": None, "guard": "", "caution": 1.0, "replay": True}]


D8.arms_for = D10.arms_for = arms_for


def stage_tournament(run, name, deadline):
    D8.HEAD_TO_HEAD = (("H-c10", "X-c10"),) if run.state.get("candidate") else ()
    res = D10.stage_tournament(run, name, deadline)
    res["candidate"] = run.state.get("candidate")
    return res


KINDS = {"trainI0": stage_train_base, "labelL": stage_label, "trainIL": stage_train_cont, "labelM": stage_label,
         "reportL": stage_report, "finalM": stage_tournament}
D6.KINDS.update(KINDS)
D6.SMOKE_MINUTES.update(SMOKE_MINUTES)


def main():
    ap = argparse.ArgumentParser()
    for p in ("--run", "--prior5", "--prior6", "--prior9", "--prior10", "--prior11", "--prior12"):
        ap.add_argument(p, required=True)
    ap.add_argument("--hours", type=float, default=24); ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--slots", type=int, default=13)
    a = ap.parse_args()
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior = run.prior5 = os.path.abspath(a.prior5)  # run.prior: session 5's C bank (D2.bank_files)
    run.prior6, run.prior9, run.prior10, run.prior11, run.prior12 = (
        os.path.abspath(p) for p in (a.prior6, a.prior9, a.prior10, a.prior11, a.prior12))
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
    run.log(f"driver13 start (smoke={a.smoke}, slots={a.slots}, engine={D.ENGINE}, c_bin={cbin}, "
            f"port_offset={D.PORT_OFFSET}); priors 5/6/9/10/11/12 = {run.prior5}, {run.prior6}, {run.prior9}, "
            f"{run.prior10}, {run.prior11}, {run.prior12}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    end = run.state["deadline"]
    p1, p3 = run.state["started"] + PHASE1_HOURS * 3600, end - PHASE3_HOURS * 3600
    if a.smoke: p1, p3 = time.time() + 16 * 60, None
    try:
        g = threading.Thread(target=D6.run_stage, args=(run, "trainI0", p1, a.smoke))
        g.start()
        D6.run_stage(run, "labelL", p1, a.smoke)
        g.join()  # trainI0 runs to the end of its last epoch even past p1; phase 2 then starts late
        p3 = p3 or time.time() + 32 * 60
        g = threading.Thread(target=D6.run_stage, args=(run, "trainIL", p3, a.smoke))
        g.start()
        D6.run_stage(run, "labelM", p3 - 10 * 60, a.smoke)
        D6.run_stage(run, "reportL", p3, a.smoke)
        g.join()
        D6.run_stage(run, "finalM", end - 20 * 60 if not a.smoke else time.time() + 15 * 60, a.smoke)
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        D.write_report(run)
        run.log("driver13 finished")


if __name__ == "__main__":
    main()
