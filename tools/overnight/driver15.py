#!/usr/bin/env python3
"""Session 15 (~24 h): a second round of rule changes, then labels and a model on the final default rules.

See docs/finetune-laya-plan.md, "Session 15". Honest view (PLAYER_VIEW=1), C engine, rules+ = session 14's new
default (danger,restock,escape,upnavfood,fire,lowheal; RULES_CAUTION=1).

  ruleO     (CPU, 7 h)  each variant alone on top of rules+, paired with session 14's combo game on the same start
                        (the same rules, so rules+ is re-run on 20 starts first to check the source replays them):
                          food8       keep 8 rations (now 6)
                          neutpois    buy Neutralize Poison; poisoned below 50% HP, drink it (or CCW) first
                          poisonhold  poisoned below 50% HP, no potion, no monster in view: rest instead of walking
                          fireadj     with a launcher, shoot adjacent monsters too (now 2+ squares away)
                          ammo60      buy ammo up to 60 (now 30)
                        food8, neutpois and poisonhold on a sample of 700 of finalM's starts; fireadj and ammo60 on
                        the 184 Ranger starts and the other starts whose combo game fired at least once.
  answerO   (GPU, alongside ruleO)  trainH answers 60,000 fight/tactic decisions of session 14's combo games, so
                        labelO can choose records as labelL did (trainH's disagreements by confidence, and agreements).
  confirmO  (CPU, 2.5 h) rules+ and rules+ with the adopted variants, start by start, on new starts (finalO seeds).
                        Skipped if nothing is adopted. Decides the final default rules.
  labelO    (CPU, until 3 h before the end)  rollout labels (K = 8) on those combo states, the final default rules
                        continuing.
  trainO    (GPU, last 3 h)  trainH continued on labelO's train games, 2 epochs (capped); trainH and trainO answer
                        held-out labelO (a quarter of its games) and trainH's held-out. Chooses session 16's model.

Disk: games drop their replay and snapshots once played (labelO uses session 14's snapshots). A guard stops new games
below 30 GB free and stops the run below 15 GB; the run refuses to start below 40 GB.
Resumable via RUN/state.json; `touch RUN/STOP` stops between stages. Never restart it mid-stage.

Usage: driver15.py --run runs/session15/<date> --prior5 runs/session5/2026-10-16 --prior10 runs/session10/2026-10-21
       --prior13 runs/session13/2026-10-24 --prior14 runs/session14/2026-10-25 [--hours 24] [--slots 13] [--smoke]
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
BASE = "danger,restock,escape,upnavfood,fire,lowheal"  # session 14's new default (busho's default)
SAMPLE_VARIANTS = ["food8", "neutpois", "poisonhold"]
SHOOT_VARIANTS = ["fireadj", "ammo60"]
VARIANTS = SAMPLE_VARIANTS + SHOOT_VARIANTS
SAMPLE_N, CHECK_N, MIN_CONFIRM_PAIRS = 700, 20, 300
ANSWER_N, ANSWER_CHUNK = 60000, 5000
RULE_H, CONFIRM_H, TRAIN_H = 7.0, 2.5, 3.0
HELD_FRAC, EPOCHS = 0.25, 2
DISK_FLOOR_GB, DISK_STOP_GB, DISK_START_GB = 30, 15, 40
D.SCHEDULE = [("ruleO", RULE_H), ("answerO", RULE_H), ("confirmO", CONFIRM_H), ("labelO", 24 - RULE_H - CONFIRM_H - TRAIN_H),
              ("trainO", TRAIN_H)]
SMOKE_MINUTES = {"ruleO": 15, "answerO": 15, "confirmO": 6, "labelO": 8, "trainO": 25}
FINALM = {"rng": "finalM", "fresh": 3200000, "bank": 3250000}
FINALO = {"rng": "finalO", "fresh": 3300000, "bank": 3350000}
ok, compare, passes = D14.ok, D14.compare, D14.passes


# ── disk ──
def free_gb(path): return shutil.disk_usage(path).free / 2**30


def disk_guard(run):
    """Below DISK_FLOOR_GB free no new game starts (RUN/DISKLOW); below DISK_STOP_GB the run stops between stages."""
    while not D.STOP.is_set():
        try:
            gb = free_gb(run.path)
            low = os.path.join(run.path, "DISKLOW")
            if gb < DISK_FLOOR_GB and not os.path.exists(low):
                open(low, "w").write(f"{gb:.1f} GB free"); run.log(f"disk guard: {gb:.1f} GB free, no new games")
            if gb < DISK_STOP_GB and not os.path.exists(os.path.join(run.path, "STOP")):
                open(os.path.join(run.path, "STOP"), "w").write(f"{gb:.1f} GB free"); run.log(f"disk guard: {gb:.1f} GB free, stopping")
        except Exception as e:  # never let the guard kill the run
            run.log(f"disk guard error: {e}")
        D.STOP.wait(60)


def disk_low(run): return os.path.exists(os.path.join(run.path, "DISKLOW"))


# ── games ──
def play(run, stage, jobs, deadline, smoke):
    """jobs: [(start, arm name, rulefix, full length)]; outcomes logged as '<stage>-<arm>: <start id>: {...}'. Each
    game's replay and snapshots are deleted once it's played; player.log, decisions and the report stay."""
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
            for f in ("busho-replay.jsonl", "snapshots"):
                p = os.path.join(out, f)
                if os.path.isdir(p): shutil.rmtree(p, ignore_errors=True)
                elif os.path.exists(p): os.remove(p)

    with cf.ThreadPoolExecutor(run.slots) as ex:
        list(ex.map(worker, range(run.slots)))


def log_counts(run, stage, arm, ids):
    """Per game: launcher shots, poison cures drunk, restock trips and descents, from the player logs."""
    n, c = 0, collections.Counter()
    for s in ids:
        f = run.d(stage, arm, s, "player.log")
        if not os.path.exists(f): continue
        t = open(f, errors="replace").read(); n += 1
        m = re.search(r"射撃(\d+)回", t); c["shots"] += int(m.group(1)) if m else 0
        c["poison_cures"] += t.count("[学習] 解毒"); c["restock_trips"] += t.count("[学習] 補給帰還")
        c["descents"] += t.count("[学習] 降下")
    return {"games": n, **{f"{k}_per_game": round(v / max(1, n), 2) for k, v in c.items()}}


def finalm_starts(run, base):
    """finalM's full list of starts, also in the smoke test (without touching run.smoke: answerO runs alongside)."""
    D8.STARTS = FINALM
    full = types.SimpleNamespace(smoke=False, path=run.path, prior=run.prior)
    return [s for s in D8.starts_for(full) if ok(base.get(s["id"]))]


def fired(run, sid):
    f = os.path.join(run.prior14, "confirmN", "combo", sid, "player.log")
    m = re.search(r"射撃(\d+)回", open(f, errors="replace").read()) if os.path.exists(f) else None
    return bool(m and int(m.group(1)) > 0)


def stage_rules(run, name, deadline):
    base = run.combo14
    starts = finalm_starts(run, base)
    sample = random.Random("ruleO").sample(starts, min(SAMPLE_N, len(starts)))
    rangers = [s for s in starts if s["cls"] == "Ranger"]
    others = [s for s in starts if s["cls"] != "Ranger" and fired(run, s["id"])]
    check = starts[:CHECK_N]
    if run.smoke:  # 4 sample starts, 2 Rangers, 1 other shooter; full-length replays of 2 bank starts and 1 fresh one
        sample, rangers, others = [s for s in sample if s["cls"] != "Ranger"][:4], rangers[:2], others[:1]
        check = [s for s in starts if s["restore"]][:2] + starts[:1]
    run.state["starts"] = {"complete": len(starts), "sample": len(sample), "rangers": len(rangers), "other_shooters": len(others),
                           "check": [s["id"] for s in check]}; run.save()
    jobs = [(s, "rules+", BASE, True) for s in check]
    shoot = rangers + others
    for i in range(max(len(sample), len(shoot))):  # interleaved, so every variant has its share if the stage is cut
        if i < len(sample): jobs += [(sample[i], f"rules+{v}", f"{BASE},{v}", False) for v in SAMPLE_VARIANTS]
        if i < len(shoot): jobs += [(shoot[i], f"rules+{v}", f"{BASE},{v}", False) for v in SHOOT_VARIANTS]
    run.log(f"{name}: {len(jobs)} games")
    play(run, name, jobs, deadline - 5 * 60, run.smoke)
    got = D14.load_outcomes(run.d("driver.log"), f"{name}-")
    det = [s["id"] for s in check if ok(got["rules+"].get(s["id"]))]
    same = sum(D14.fingerprint(got["rules+"][i]) == D14.fingerprint(base[i]) for i in det)
    res = {"replay": {"n": len(det), "identical": same}, "variants": {}}
    sids, rids, oids = {s["id"] for s in sample}, {s["id"] for s in rangers}, {s["id"] for s in others}
    for v in SAMPLE_VARIANTS:
        arm = f"rules+{v}"
        c = {"sample": compare(base, got[arm], sids), "logs": log_counts(run, name, arm, sids)}
        c["adopt"] = passes(c["sample"])
        res["variants"][v] = c
    for v in SHOOT_VARIANTS:
        arm = f"rules+{v}"
        c = {"rangers": compare(base, got[arm], rids), "other_shooters": compare(base, got[arm], oids),
             "ranger_logs": log_counts(run, name, arm, rids)}
        o = c["other_shooters"]
        c["adopt"] = passes(c["rangers"]) and not (o.get("losses", 0) > o.get("wins", 0) and D3.sign_p(o["losses"], o["wins"]) < 0.05)
        res["variants"][v] = c
    np_, ph = res["variants"]["neutpois"], res["variants"]["poisonhold"]
    if np_["adopt"] and ph["adopt"]:  # both aim at poison deaths: keep the better one
        (ph if np_["sample"]["mean_diff"] >= ph["sample"]["mean_diff"] else np_)["adopt"] = False
    res["canary"] = {"passed": same >= 0.9 * max(1, len(det)) and len(det) >= (2 if run.smoke else 10)}
    res["adopted"] = [v for v in VARIANTS if res["variants"][v]["adopt"]]
    if run.smoke and not res["adopted"]: res["adopted"] = ["food8", "neutpois", "fireadj"]  # exercise confirmO
    return res


def stage_confirm(run, name, deadline):
    r = run.state["stages"]["ruleO"].get("result") or {}
    if not (r.get("canary") or {}).get("passed"):
        return {"skipped": "the replay canary failed: session 14's games don't replay"}
    if not r.get("adopted"): return {"skipped": "no variant adopted"}
    combo = f"{BASE},{','.join(r['adopted'])}"
    D8.STARTS = FINALO
    starts = D8.starts_for(run)
    jobs = [(s, arm, rf, False) for s in starts for arm, rf in (("rules+", BASE), ("combo", combo))]
    run.log(f"{name}: combo = {combo}, up to {len(starts)} new starts")
    play(run, name, jobs, deadline - 5 * 60, run.smoke)
    got = D14.load_outcomes(run.d("driver.log"), f"{name}-")
    ids = {s["id"] for s in starts}
    c = {"rulefix": combo, "all": compare(got["rules+"], got["combo"], ids),
         "logs": log_counts(run, name, "combo", ids), "base_logs": log_counts(run, name, "rules+", ids)}
    a = c["all"]
    c["new_default"] = a.get("pairs", 0) >= (1 if run.smoke else MIN_CONFIRM_PAIRS) and a["wins"] > a["losses"] and a["mean_diff"] > 0
    return c


def final_rulefix(run):
    c = run.state["stages"].get("confirmO", {}).get("result") or {}
    return c["rulefix"] if c.get("new_default") else BASE


# ── GPU: trainH answers the label pool ──
def combo_pool(run):
    """session 14's combo fight/tactic decisions with a snapshot (paths relative to session 14's run), 60,000 of them
    in a fixed random order."""
    root = os.path.join(run.prior14, "confirmN", "combo")
    recs, seen = [], set()
    for g in sorted(os.listdir(root)):
        f = os.path.join(root, g, "decisions.jsonl")
        if not os.path.exists(f): continue
        for line in open(f):
            r = json.loads(line)
            if r.get("decision_type") not in D9.TYPES or not r.get("snapshot") or D9.key(r) in seen: continue
            seen.add(D9.key(r))
            r["snapshot"] = os.path.join("confirmN", "combo", g, r["snapshot"])
            recs.append(r)
    random.Random("answerO").shuffle(recs)
    return recs[:200 if run.smoke else ANSWER_N]


def stage_answer(run, name, deadline):
    pool = run.d(name, "pool.jsonl")
    if not os.path.exists(pool): D13.write(pool, combo_pool(run))
    recs = [json.loads(l) for l in open(pool)]
    chunk = 100 if run.smoke else ANSWER_CHUNK
    done = 0
    for i in range(0, len(recs), chunk):
        out = run.d(name, f"chunk{i // chunk:02d}.json")
        if os.path.exists(out.replace(".json", ".answers.jsonl")): done += 1; continue
        if run.stopped() or time.time() > deadline: break
        part = run.d(name, f"chunk{i // chunk:02d}.records.jsonl")
        with open(part, "w") as f:  # evaluate.py scores against a gold distribution: a uniform one, unused
            for r in recs[i:i + chunk]:
                opts = list(r["questions"]["decision"]["criteria"])
                f.write(json.dumps({"state": r["state"], "questions": r["questions"],
                                    "meta": {k: r.get(k) for k in ("game_id", "turn", "decision_type", "rules_choice")},
                                    "gold": {"decision": {"probabilities": {o: 1 / len(opts) for o in opts}}}}) + "\n")
        D6.evaluate_ckpt(D13.trainH(run), part, part, out)
        os.remove(part)
        if os.path.exists(out.replace(".json", ".answers.jsonl")): done += 1
    ans = answers(run)
    dis = [a for k, a in ans.items() if a["choice"] != a["rules"]]
    res = {"pool": len(recs), "chunks_done": done, "answered": len(ans), "disagree": len(dis),
           "disagree_conf_ge_gate": sum((a.get("confidence") or 0) >= D13.GATE for a in dis)}
    res["canary"] = D2.canary(res, [("answered >= 5000", run.smoke or len(ans) >= 5000)])
    return res


def answers(run):
    out = {}
    d = run.d("answerO", "x")[:-2]
    for f in sorted(os.listdir(d)):
        if not f.endswith(".answers.jsonl"): continue
        for line in open(os.path.join(d, f)):
            a = json.loads(line)
            out[(a["game_id"], a["turn"], a["type"])] = {**a["answer"], "rules": a["rules"]}
    return out


# ── CPU: labels ──
def stage_label(run, name, deadline):
    dec = run.d(name, "decisions.jsonl")
    if not os.path.exists(dec):
        ans = answers(run)
        hi, lo, agr = [], [], []
        for r in map(json.loads, open(run.d("answerO", "pool.jsonl"))):
            a = ans.get(D9.key(r))
            if not a: continue
            r["model_choice"], r["model_confidence"] = a["choice"], a.get("confidence") or 0
            if not D9.disagrees(r): agr.append(r)
            else: (hi if r["model_confidence"] >= D13.GATE else lo).append(r)
        dis = [r for pair in zip(hi, lo) for r in pair] + hi[len(lo):] + lo[len(hi):]  # the pool is already shuffled
        order, ai = [], 0
        for i, r in enumerate(dis):
            order.append(r)
            if i % 3 == 2 and ai < len(agr): order.append(agr[ai]); ai += 1
        order += agr[ai:]
        D13.write(dec, order[:24] if run.smoke else order)
        run.state["labelO_pool"] = {"records": len(order), "disagree_hi": len(hi), "disagree_lo": len(lo), "agree": len(agr)}; run.save()
    run.state["final_rulefix"] = os.environ["RULEFIX"] = final_rulefix(run); run.save()  # the rollouts' players
    res = D9.label(run, name, dec, run.prior14, deadline)
    res["rulefix"] = os.environ["RULEFIX"]
    return res


# ── GPU: model ──
def held(r): return int(hashlib.sha1(r["meta"]["game_id"].encode()).hexdigest(), 16) % 1000 < HELD_FRAC * 1000


def stage_train(run, name, deadline):
    lab = run.d("labelO", "labels.jsonl")
    L = D13.load(lab, "labelO") if os.path.exists(lab) and os.path.getsize(lab) else []
    if not L: return {"failed": "no labelO labels"}
    d = run.d(name, "data", "x")[:-2]
    train = D13.write(os.path.join(d, "train.jsonl"), [r for r in L if not held(r)])
    heldout = D13.write(os.path.join(d, "heldout.O.jsonl"), [r for r in L if held(r)], 150 if run.smoke else None)
    dh = os.path.join(run.prior13, "trainI0", "data", "heldout.DH.jsonl")
    dh_train = os.path.join(run.prior13, "trainI0", "data", "train.jsonl")
    if run.smoke: dh = D13.write(os.path.join(d, "heldout.DH.smoke.jsonl"), D13.load(dh), 150)
    n = sum(1 for _ in open(train))
    res = {"labels": len(L), "train_items": n, "heldout.O": sum(1 for _ in open(heldout))}
    res["trainH"] = {"heldout.O": D13.answer(run, D13.trainH(run), heldout, train, "trainH.heldout.O", name),
                     "heldout.DH": D6.evaluate_ckpt(D13.trainH(run), dh, dh_train, run.d(name, "trainH.heldout.DH.json"))}
    epochs, cap = D13.epochs_for(n, deadline, 25, EPOCHS)
    res["epochs_cap"] = cap
    if epochs < 1 and not run.smoke:
        res["trainO"] = {"skipped": f"only {cap} epochs fit"}
    else:
        r = D6.train_eval(run, run.d(name, "trainO", "x")[:-2], train, heldout, max(1, epochs), 0, deadline, base=D13.trainH(run))
        if "ckpt" in r:
            r["heldout.O"] = D13.answer(run, r["ckpt"], heldout, train, "trainO.heldout.O", name)
            r["heldout.DH"] = D6.evaluate_ckpt(r["ckpt"], dh, dh_train, run.d(name, "trainO.heldout.DH.json"))
        res["trainO"] = r
    res["choice"] = choose(res)
    return res


def choose(res):
    """Pre-committed: trainO is session 16's model if its gate score on held-out labelO beats trainH's, its held-out
    labelO accuracy beats the majority, and its accuracy on trainH's held-out is no more than 2 points below trainH's."""
    def acc(ev, k="model"): return ((ev or {}).get("acc") or {}).get(k)
    h, o = res["trainH"], res.get("trainO") or {}
    row = lambda x: {"gate_score": D13.gate_score(x.get("heldout.O") or {}), "acc_O": acc(x.get("heldout.O")),  # noqa: E731
                     "majority_O": acc(x.get("heldout.O"), "majority"), "acc_DH": acc(x.get("heldout.DH"))}
    rh, ro = row(h), row(o) if "ckpt" in o else None
    out = {"trainH": rh, "trainO": ro, "chosen": "trainH"}
    if ro and ro["gate_score"] is not None and (rh["gate_score"] is None or ro["gate_score"] > rh["gate_score"]) \
            and ro["acc_O"] is not None and ro["majority_O"] is not None and ro["acc_O"] > ro["majority_O"] \
            and (rh["acc_DH"] is None or (ro["acc_DH"] is not None and ro["acc_DH"] >= rh["acc_DH"] - 0.02)):
        out.update(chosen="trainO", ckpt=o["ckpt"])
    return out


KINDS = {"ruleO": stage_rules, "answerO": stage_answer, "confirmO": stage_confirm, "labelO": stage_label, "trainO": stage_train}
D6.KINDS.update(KINDS)
D6.SMOKE_MINUTES.update(SMOKE_MINUTES)


def main():
    ap = argparse.ArgumentParser()
    for p in ("--run", "--prior5", "--prior10", "--prior13", "--prior14"): ap.add_argument(p, required=True)
    ap.add_argument("--hours", type=float, default=24); ap.add_argument("--slots", type=int, default=13)
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    if free_gb(".") < DISK_START_GB:
        sys.exit(f"only {free_gb('.'):.1f} GB free; need {DISK_START_GB}")
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior = run.prior5 = os.path.abspath(a.prior5)  # run.prior: session 5's C bank (D2.bank_files)
    run.prior10, run.prior13, run.prior14 = (os.path.abspath(p) for p in (a.prior10, a.prior13, a.prior14))
    run.combo14 = D14.load_outcomes(os.path.join(run.prior14, "driver.log"), "confirmN-")["combo"]
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
    run.log(f"driver15 start (smoke={a.smoke}, slots={run.slots}, c_bin={cbin}, port_offset={D.PORT_OFFSET}, "
            f"free {free_gb(run.path):.0f} GB); priors 5/10/13/14 = {run.prior5}, {run.prior10}, {run.prior13}, {run.prior14}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    threading.Thread(target=disk_guard, args=(run,), daemon=True).start()
    t0, end = run.state["started"], run.state["deadline"]
    rule_end, confirm_end, label_end = t0 + RULE_H * 3600, t0 + (RULE_H + CONFIRM_H) * 3600, end - TRAIN_H * 3600
    if a.smoke: rule_end, confirm_end, label_end = time.time() + 16 * 60, time.time() + 24 * 60, time.time() + 34 * 60
    try:
        g = threading.Thread(target=D6.run_stage, args=(run, "answerO", rule_end, a.smoke))
        g.start()
        D6.run_stage(run, "ruleO", rule_end, a.smoke)
        g.join()
        D6.run_stage(run, "confirmO", confirm_end, a.smoke)
        D6.run_stage(run, "labelO", label_end, a.smoke)
        D6.run_stage(run, "trainO", end - 10 * 60, a.smoke)
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        D.write_report(run)
        run.log(f"driver15 finished ({free_gb(run.path):.0f} GB free)")


if __name__ == "__main__":
    main()
