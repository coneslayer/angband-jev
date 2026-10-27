#!/usr/bin/env python3
"""Session 16 (~24 h): a third round of rule changes (breeders first), a second continuation of trainH scored without
labelO's selection bias, and unbiased labels on the final default rules.

See docs/finetune-laya-plan.md, "Session 16". Honest view (PLAYER_VIEW=1), C engine (main-http.c now reports a
monster's "breeds explosively" once its lore shows it), rules+ = danger,restock,escape,upnavfood,fire,lowheal.

  ruleP     (CPU, 8 h)  each variant alone on top of rules+, paired with session 14's combo game on the same start
                        (rules+ re-run on 20 starts first to check the source still replays them):
                          breed     known breeders: hunt them first while few; 4 in view or 150 actions in view on a
                                    level, walk to the nearest stairs and take them
                          earlyrun  CL <= 4, lost a third of max HP since the last check with a monster adjacent: stairs
                                    or Phase Door
                          neutshop  one Neutralize Poison at the end of the town list; drink as neutpois
                          cutcure   cut below 50% HP joins lowheal's triggers
                          whirl     Blackguards cast Whirlwind Attack with 2+ monsters adjacent
                        breed, earlyrun, neutshop, cutcure on a sample of 700 of finalM's starts; whirl on finalM's
                        Blackguard starts.
  trainO2   (GPU, alongside ruleP)  trainH continued on session 15's labelO train games for 2 epochs. trainH, trainO
                        and trainO2 scored on held-out labelO with each record weighted by the inverse of its stratum's
                        labelling rate (labelO chose trainH's disagreements far more often than agreements). Chooses
                        session 17's model.
  confirmP  (CPU, 3 h)  rules+ and rules+ with the adopted variants, start by start, on new starts (finalP seeds); their
                        snapshots stay for labelP. Skipped if nothing is adopted. Decides the final default rules.
  labelP    (CPU, rest) rollout labels (K = 8) on a uniform random sample of the final default's fight/tactic
                        decisions (confirmP's games, or session 14's combo games outside labelO if nothing was adopted).

Disk: as session 15, but confirmP's snapshots stay (about 8 MB a game). A guard stops new games below 30 GB free
and the run below 15 GB; the run refuses to start below 40 GB.
Resumable via RUN/state.json; `touch RUN/STOP` stops between stages. Never restart it mid-stage.

Usage: driver16.py --run runs/session16/<date> --prior5 runs/session5/2026-10-16 --prior10 runs/session10/2026-10-21
       --prior13 runs/session13/2026-10-24 --prior14 runs/session14/2026-10-25 --prior15 runs/session15/2026-10-26
       [--hours 24] [--slots 13] [--smoke]
"""
import argparse, collections, concurrent.futures as cf, hashlib, json, os, random, re, shutil, signal, sys, threading, time, types  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import driver3 as D3  # noqa: E402
import driver6 as D6  # noqa: E402
import driver8 as D8  # noqa: E402
import driver9 as D9  # noqa: E402
import driver13 as D13  # noqa: E402
import driver14 as D14  # noqa: E402
import evaluate  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
import driver15 as D15  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
BASE = D15.BASE
SAMPLE_VARIANTS = ["breed", "earlyrun", "neutshop", "cutcure"]
BG_VARIANTS = ["whirl"]
VARIANTS = SAMPLE_VARIANTS + BG_VARIANTS
SAMPLE_N, CHECK_N, MIN_CONFIRM_PAIRS = 700, 20, 300
RULE_H, CONFIRM_H, EPOCHS = 8.0, 3.0, 2
D.SCHEDULE = [("ruleP", RULE_H), ("trainO2", RULE_H), ("confirmP", CONFIRM_H), ("labelP", 24 - RULE_H - CONFIRM_H)]
SMOKE_MINUTES = {"ruleP": 15, "trainO2": 30, "confirmP": 6, "labelP": 8}
FINALP = {"rng": "finalP", "fresh": 3400000, "bank": 3450000}
ok, compare, passes = D14.ok, D14.compare, D14.passes
free_gb, disk_low = D15.free_gb, D15.disk_low


# ── games ──
def play(run, stage, jobs, deadline, smoke, keep_snapshots=False):
    """jobs: [(start, arm name, rulefix, full length)]; outcomes logged as '<stage>-<arm>: <start id>: {...}'. Each
    game's replay is deleted once it's played, and its snapshots too unless keep_snapshots."""
    it, lock = iter(jobs), threading.Lock()

    def worker(slot):
        while not run.stopped() and time.time() < deadline and not disk_low(run):
            if slot >= D.THROTTLED_SLOTS and os.path.exists(os.path.join(run.path, "THROTTLE")):
                time.sleep(30); continue
            with lock: job = next(it, None)
            if job is None: return
            s, arm, rulefix, full = job
            cap, maxa = (600, 15000) if s["restore"] else (900, 20000)
            if smoke and not full: cap, maxa = 240, 1500
            env = {**D8.arm_env({"name": arm, "ckpt": None, "guard": "", "caution": 1.0}, {}), "RULEFIX": rulefix}
            out = run.d(stage, arm, s["id"])
            res = D.play_game(run, f"{stage}-{arm}", slot, s["seed"], s["cls"], env, out,
                              max(60, min(cap, deadline - time.time())), maxa, 4100, None, s["restore"])
            run.log(f"{stage}-{arm}: {s['id']}: {res}")
            for f in ("busho-replay.jsonl",) + (() if keep_snapshots else ("snapshots",)):
                p = os.path.join(out, f)
                if os.path.isdir(p): shutil.rmtree(p, ignore_errors=True)
                elif os.path.exists(p): os.remove(p)

    with cf.ThreadPoolExecutor(run.slots) as ex:
        list(ex.map(worker, range(run.slots)))


def log_counts(run, stage, arm, ids):
    """Per game, from the player logs: breeder hunts and level exits, early exits, poison cures, Whirlwind casts
    (spells cast, from the report), restock trips and descents."""
    n, c = 0, collections.Counter()
    for s in ids:
        f = run.d(stage, arm, s, "player.log")
        if not os.path.exists(f): continue
        t = open(f, errors="replace").read(); n += 1
        for k, tag in (("breed_hunts", "繁殖狩り"), ("breed_exits", "繁殖脱出"), ("early_exits", "序盤離脱"),
                       ("poison_cures", "解毒"), ("restock_trips", "補給帰還"), ("descents", "降下")):
            c[k] += t.count(f"[学習] {tag}")
        rep = run.d(stage, arm, s, "busho-play-report.json")
        if os.path.exists(rep):
            try: c["spells"] += json.load(open(rep))["summary"].get("spellsUsed", 0)
            except Exception: pass
    return {"games": n, **{f"{k}_per_game": round(v / max(1, n), 2) for k, v in c.items()}}


def death_causes(run, stage, arm, ids, base_dir=None):
    """Deaths by cause, this arm against session 14's combo games on the same starts (breeders, poison, ...)."""
    def cause(p):
        if not os.path.exists(p): return None
        s = json.load(open(p))["summary"]
        return re.sub(r"You have died\. \((.*)\)", r"\1", s["deathCause"]) if s.get("dead") else None
    new, old = collections.Counter(), collections.Counter()
    for s in ids:
        a = cause(run.d(stage, arm, s, "busho-play-report.json"))
        b = cause(os.path.join(base_dir, s, "busho-play-report.json")) if base_dir else None
        for c, x in ((new, a), (old, b)):
            if x: c["breeder" if re.search(r"louse|worm mass", x) else x] += 1
    keys = sorted(set(new) | set(old), key=lambda k: -(new[k] + old[k]))[:8]
    return {k: [old[k], new[k]] for k in keys}


def stage_rules(run, name, deadline):
    base = run.combo14
    starts = D15.finalm_starts(run, base)
    sample = random.Random("ruleP").sample(starts, min(SAMPLE_N, len(starts)))
    bgs = [s for s in starts if s["cls"] == "Blackguard"]
    check = starts[:CHECK_N]
    if run.smoke:  # 4 sample starts with a breeder death in session 14, 2 Blackguards, full-length replays of 2 bank
        # starts and 1 fresh one
        sample = [s for s in starts if s["id"] in run.smoke_ids][:4] or sample[:4]
        bgs, check = bgs[:2], [s for s in starts if s["restore"]][:2] + starts[:1]
    run.state["starts"] = {"complete": len(starts), "sample": len(sample), "blackguards": len(bgs),
                           "check": [s["id"] for s in check]}; run.save()
    jobs = [(s, "rules+", BASE, True) for s in check]
    for i in range(max(len(sample), len(bgs))):  # interleaved, so every variant has its share if the stage is cut
        if i < len(sample): jobs += [(sample[i], f"rules+{v}", f"{BASE},{v}", False) for v in SAMPLE_VARIANTS]
        if i < len(bgs): jobs += [(bgs[i], f"rules+{v}", f"{BASE},{v}", False) for v in BG_VARIANTS]
    run.log(f"{name}: {len(jobs)} games")
    play(run, name, jobs, deadline - 5 * 60, run.smoke)
    got = D14.load_outcomes(run.d("driver.log"), f"{name}-")
    det = [s["id"] for s in check if ok(got["rules+"].get(s["id"]))]
    same = sum(D14.fingerprint(got["rules+"][i]) == D14.fingerprint(base[i]) for i in det)
    res = {"replay": {"n": len(det), "identical": same}, "variants": {}}
    combo_dir = os.path.join(run.prior14, "confirmN", "combo")
    for v, ss in [(v, sample) for v in SAMPLE_VARIANTS] + [(v, bgs) for v in BG_VARIANTS]:
        arm, ids = f"rules+{v}", {s["id"] for s in ss}
        c = {"starts": compare(base, got[arm], ids), "logs": log_counts(run, name, arm, ids),
             "deaths": death_causes(run, name, arm, ids, combo_dir)}
        c["adopt"] = passes(c["starts"])
        res["variants"][v] = c
    res["canary"] = {"passed": same >= 0.9 * max(1, len(det)) and len(det) >= (2 if run.smoke else 10)}
    res["adopted"] = [v for v in VARIANTS if res["variants"][v]["adopt"]]
    if run.smoke and not res["adopted"]: res["adopted"] = ["breed", "whirl"]  # exercise confirmP
    return res


def stage_confirm(run, name, deadline):
    r = run.state["stages"]["ruleP"].get("result") or {}
    if not (r.get("canary") or {}).get("passed"):
        return {"skipped": "the replay canary failed: session 14's games don't replay"}
    if not r.get("adopted"): return {"skipped": "no variant adopted"}
    combo = f"{BASE},{','.join(r['adopted'])}"
    D8.STARTS = FINALP
    starts = D8.starts_for(run)
    jobs = [(s, arm, rf, False) for s in starts for arm, rf in (("rules+", BASE), ("combo", combo))]
    run.log(f"{name}: combo = {combo}, up to {len(starts)} new starts")
    play(run, name, jobs, deadline - 5 * 60, run.smoke, keep_snapshots=True)
    got = D14.load_outcomes(run.d("driver.log"), f"{name}-")
    ids = {s["id"] for s in starts}
    c = {"rulefix": combo, "all": compare(got["rules+"], got["combo"], ids),
         "logs": log_counts(run, name, "combo", ids), "base_logs": log_counts(run, name, "rules+", ids)}
    a = c["all"]
    c["new_default"] = a.get("pairs", 0) >= (1 if run.smoke else MIN_CONFIRM_PAIRS) and a["wins"] > a["losses"] and a["mean_diff"] > 0
    # labelP uses the final default's games: the other arm's snapshots go
    drop = run.d(name, "rules+" if c["new_default"] else "combo", "x")[:-2]
    for g in os.listdir(drop):
        shutil.rmtree(os.path.join(drop, g, "snapshots"), ignore_errors=True)
    return c


def final_rulefix(run):
    c = run.state["stages"].get("confirmP", {}).get("result") or {}
    return c["rulefix"] if c.get("new_default") else BASE


# ── CPU: labels on a uniform sample of the final default's decisions ──
def label_pool(run):
    c = run.state["stages"].get("confirmP", {}).get("result") or {}
    if "all" in c:
        root, rel = run.path, os.path.join("confirmP", "combo" if c.get("new_default") else "rules+")
    else:  # nothing adopted: session 14's combo games (the same rules), minus labelO's records
        root, rel = run.prior14, os.path.join("confirmN", "combo")
    done = set()
    if root == run.prior14:
        done = {D9.key(json.loads(l)) for l in open(os.path.join(run.prior15, "labelO", "decisions.jsonl"))}
    recs, seen = [], set()
    for g in sorted(os.listdir(os.path.join(root, rel))):
        f = os.path.join(root, rel, g, "decisions.jsonl")
        if not os.path.exists(f) or not os.path.isdir(os.path.join(root, rel, g, "snapshots")): continue
        for line in open(f):
            r = json.loads(line)
            if r.get("decision_type") not in D9.TYPES or not r.get("snapshot") or D9.key(r) in seen or D9.key(r) in done: continue
            seen.add(D9.key(r))
            r["snapshot"] = os.path.join(rel, g, r["snapshot"])
            recs.append(r)
    random.Random("labelP").shuffle(recs)
    return root, rel, recs


def stage_label(run, name, deadline):
    dec = run.d(name, "decisions.jsonl")
    if not os.path.exists(dec):
        root, rel, recs = label_pool(run)
        D13.write(dec, recs[:24] if run.smoke else recs)
        run.state["labelP_pool"] = {"root": root, "games": rel, "records": len(recs)}; run.save()
    run.state["final_rulefix"] = os.environ["RULEFIX"] = final_rulefix(run); run.save()  # the rollouts' players
    res = D9.label(run, name, dec, run.state["labelP_pool"]["root"], deadline)
    res["rulefix"] = os.environ["RULEFIX"]
    res["pool"] = run.state["labelP_pool"]
    return res


# ── GPU: trainO2 and the reweighted gate score ──
def strata_weights(run):
    """labelO's records by stratum (trainH agrees, disagrees at confidence >= GATE, below), weighted by pool size over
    labels made, so a weighted held-out set stands for all 60,000 decisions of the pool."""
    s15 = os.path.join(run.prior15, "labelO")
    pool = json.load(open(os.path.join(run.prior15, "state.json")))["labelO_pool"]
    stratum = {}
    for r in map(json.loads, open(os.path.join(s15, "decisions.jsonl"))):
        stratum[D9.key(r)] = "agree" if not D9.disagrees(r) else "disagree_hi" if r["model_confidence"] >= D13.GATE else "disagree_lo"
    made = collections.Counter(stratum.get((m["game_id"], m["turn"], m["decision_type"]))
                               for m in (json.loads(l)["meta"] for l in open(os.path.join(s15, "labels.jsonl"))))
    w = {k: pool[k] / made[k] for k in ("agree", "disagree_hi", "disagree_lo") if made.get(k)}
    return stratum, w, dict(made)


def weighted_gate(labels, answers, stratum, w):
    """gate_score with each held-out record weighted: 1000 x sum of w x (choice's utility - rules') over overrides at
    confidence >= GATE, over the sum of w over all records. Also the weighted share of records overridden."""
    if not os.path.exists(answers): return None
    ans = {(a["game_id"], a["turn"], a["type"]): a["answer"] for a in map(json.loads, open(answers)) if a}
    num = den = acted = 0.0
    for m in (json.loads(l)["meta"] for l in open(labels)):
        k = (m["game_id"], m["turn"], m["decision_type"])
        wi = w.get(stratum.get(k), 0.0)
        den += wi
        a = ans.get(k) or {}
        c, rc, u = a.get("choice"), m.get("rules_choice"), m["u_mean"]
        if c and rc and c != rc and c in u and rc in u and (a.get("confidence") or 0) >= D13.GATE:
            num += wi * (u[c] - u[rc]); acted += wi
    return {"gate_score_w": round(1000 * num / den, 2) if den else None, "override_rate_w": round(acted / den, 4) if den else None}


def stage_train(run, name, deadline):
    t15 = os.path.join(run.prior15, "trainO")
    train, heldout = os.path.join(t15, "data", "train.jsonl"), os.path.join(t15, "data", "heldout.O.jsonl")
    dh = os.path.join(run.prior13, "trainI0", "data", "heldout.DH.jsonl")
    dh_train = os.path.join(run.prior13, "trainI0", "data", "train.jsonl")
    if run.smoke:
        d = run.d(name, "data", "x")[:-2]
        heldout = D13.write(os.path.join(d, "heldout.O.smoke.jsonl"), D13.load(heldout), 150)
        dh = D13.write(os.path.join(d, "heldout.DH.smoke.jsonl"), D13.load(dh), 150)
    n = sum(1 for _ in open(train))
    epochs, cap = D13.epochs_for(n, deadline, 30, EPOCHS)
    res = {"train_items": n, "heldout.O": sum(1 for _ in open(heldout)), "epochs_cap": cap}
    r = D6.train_eval(run, run.d(name, "trainO2", "x")[:-2], train, heldout, max(1, epochs), 0, deadline, base=D13.trainH(run))
    if "ckpt" in r:
        r["heldout.O"] = D13.answer(run, r["ckpt"], heldout, train, "trainO2.heldout.O", name)
        r["heldout.DH"] = D6.evaluate_ckpt(r["ckpt"], dh, dh_train, run.d(name, "trainO2.heldout.DH.json"))
    res["trainO2"] = r
    s15 = json.load(open(os.path.join(run.prior15, "state.json")))["stages"]["trainO"]["result"]
    models = {"trainH": {"heldout.O": s15["trainH"]["heldout.O"], "heldout.DH": s15["trainH"]["heldout.DH"],
                         "answers": os.path.join(t15, "trainH.heldout.O.answers.jsonl")},
              "trainO": {"heldout.O": s15["trainO"]["heldout.O"], "heldout.DH": s15["trainO"]["heldout.DH"],
                         "answers": os.path.join(t15, "trainO.heldout.O.answers.jsonl"), "ckpt": s15["trainO"]["ckpt"]}}
    if "ckpt" in r:
        models["trainO2"] = {"heldout.O": r["heldout.O"], "heldout.DH": r["heldout.DH"],
                             "answers": run.d(name, "trainO2.heldout.O.answers.jsonl"), "ckpt": r["ckpt"]}
    stratum, w, made = strata_weights(run)
    res["weights"], res["labels_by_stratum"] = {k: round(v, 3) for k, v in w.items()}, made
    held_full = os.path.join(t15, "data", "heldout.O.jsonl")
    res["choice"] = choose(models, held_full, stratum, w, run.smoke)
    return res


def choose(models, held, stratum, w, smoke):
    """Pre-committed: session 17's model is the one with the highest weighted gate score on held-out labelO among
    trainH, trainO and trainO2, if its held-out labelO accuracy beats the majority and its accuracy on trainH's
    held-out set is no more than 2 points below trainH's; otherwise trainH."""
    def acc(ev, k="model"): return ((ev or {}).get("acc") or {}).get(k)
    rows = {}
    for m, x in models.items():
        rows[m] = {**(weighted_gate(held, x["answers"], stratum, w) or {}), "gate_score": D13.gate_score(x["heldout.O"] or {}),
                   "acc_O": acc(x["heldout.O"]), "majority_O": acc(x["heldout.O"], "majority"), "acc_DH": acc(x["heldout.DH"])}
    h = rows["trainH"]
    out = {"rows": rows, "chosen": "trainH"}
    best = h.get("gate_score_w")
    for m in ("trainO", "trainO2"):
        r = rows.get(m)
        if not r or r.get("gate_score_w") is None or (best is not None and r["gate_score_w"] <= best): continue
        if r["acc_O"] is None or r["majority_O"] is None or r["acc_O"] <= r["majority_O"]: continue
        if h["acc_DH"] is not None and (r["acc_DH"] is None or r["acc_DH"] < h["acc_DH"] - 0.02): continue
        out.update(chosen=m, ckpt=models[m]["ckpt"]); best = r["gate_score_w"]
    if smoke: out["note"] = "smoke: answers on the full held-out set come from session 15; trainO2's on a 150-record subset"
    return out


KINDS = {"ruleP": stage_rules, "trainO2": stage_train, "confirmP": stage_confirm, "labelP": stage_label}
D6.KINDS.update(KINDS)
D6.SMOKE_MINUTES.update(SMOKE_MINUTES)


def main():
    ap = argparse.ArgumentParser()
    for p in ("--run", "--prior5", "--prior10", "--prior13", "--prior14", "--prior15"): ap.add_argument(p, required=True)
    ap.add_argument("--hours", type=float, default=24); ap.add_argument("--slots", type=int, default=13)
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    if free_gb(".") < D15.DISK_START_GB:
        sys.exit(f"only {free_gb('.'):.1f} GB free; need {D15.DISK_START_GB}")
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior = run.prior5 = os.path.abspath(a.prior5)  # run.prior: session 5's C bank (D2.bank_files)
    run.prior10, run.prior13, run.prior14, run.prior15 = (os.path.abspath(p) for p in (a.prior10, a.prior13, a.prior14, a.prior15))
    run.combo14 = D14.load_outcomes(os.path.join(run.prior14, "driver.log"), "confirmN-")["combo"]
    run.smoke_ids = ["3200118-Paladin", "3200109-Blackguard", "3200563-Paladin", "3200547-Ranger"]
    lock = threading.RLock()

    def shared(fn):
        """As in driver13: serialise state writers across the two tracks, retry a dump that raced, always unlock."""
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
    run.log(f"driver16 start (smoke={a.smoke}, slots={run.slots}, c_bin={cbin}, port_offset={D.PORT_OFFSET}, "
            f"free {free_gb(run.path):.0f} GB); priors 5/10/13/14/15 = {run.prior5}, {run.prior10}, {run.prior13}, "
            f"{run.prior14}, {run.prior15}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    threading.Thread(target=D15.disk_guard, args=(run,), daemon=True).start()
    t0, end = run.state["started"], run.state["deadline"]
    rule_end, confirm_end = t0 + RULE_H * 3600, t0 + (RULE_H + CONFIRM_H) * 3600
    if a.smoke: rule_end, confirm_end = time.time() + 16 * 60, time.time() + 24 * 60
    try:
        g = threading.Thread(target=D6.run_stage, args=(run, "trainO2", rule_end, a.smoke))
        g.start()
        D6.run_stage(run, "ruleP", rule_end, a.smoke)
        g.join()
        D6.run_stage(run, "confirmP", confirm_end, a.smoke)
        D6.run_stage(run, "labelP", end - 10 * 60, a.smoke)
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        D.write_report(run)
        run.log(f"driver16 finished ({free_gb(run.path):.0f} GB free)")


if __name__ == "__main__":
    main()
