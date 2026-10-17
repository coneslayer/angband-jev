#!/usr/bin/env python3
"""Session 6 (~14 h): deterministic pairs, the confidence gate, longer training and more C labels.

See docs/finetune-laya-plan.md, "Session 6". Honest view (PLAYER_VIEW=1), C engine. The player's own random moves
are now seeded (PLAYER_RNG_SEED/SEED), so a seed replays the same game and the tournament's pairs are true pairs.
Phase 1, one stage:
  finalF    tournament on 240 starts (192 fresh, 48 bank from session 5's C bank): rules, rules+ (caution +1), E05 and E00 (trainE at
            confidence gates 0.05 and 0, oil/potion guards), and rules-replay (rules again on the first 24 starts,
            the determinism canary).
Phase 2, two tracks in parallel:
  CPU  labelF   label more of session 5's collectE decisions (danger-first, skipping labelE's), seeded rollouts.
  GPU  sweepF   on trainE's exact split: 8 epochs (seed 0), 4 epochs (seed 1), 2 epochs (seed 0), plus trainE itself
                (4 epochs, seed 0); held-out accuracy and the selective (per-gate) table for each.
       trainF   laya from the base model on labelD + labelE + labelF so far, at the sweep's epoch count (capped to fit
                the deadline); the same game-hash split, so trainE's held-out games stay held out.
Resumable via RUN/state.json; `touch RUN/STOP` stops between games. Never restart it mid-stage.

Usage: driver6.py --run runs/session6/<name> --prior runs/session5/2026-10-16 [--hours 14] [--smoke] [--slots 13]
"""
import argparse, collections, concurrent.futures as cf, json, os, random, re, signal, subprocess, sys, threading, time  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
os.environ["OVN_ENGINE"] = "c"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import driver3 as D3  # noqa: E402
import driver5 as D5  # noqa: E402
import evaluate  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
HERE = os.path.dirname(os.path.abspath(__file__))
D.SCHEDULE = [("finalF", 2.5), ("labelF", 11.25), ("sweepF", 4.5), ("trainF", 7.0)]
SMOKE_MINUTES = {"finalF": 12, "labelF": 10, "sweepF": 25, "trainF": 15}
REPLAY_N = 24
SWEEP = [(8, 0), (4, 1), (2, 0)]  # (epochs, seed); trainE is the (4, 0) point


def arms_for(run):
    ck = os.path.join(run.prior, "trainE", "ckpt-s0.final")
    return [{"name": "rules", "ckpt": None, "guard": ""},
            {"name": "rules+", "ckpt": None, "guard": "", "caution": 1.0},
            {"name": "E05", "ckpt": ck, "guard": "oil,potion", "min_conf": "0.05"},
            {"name": "E00", "ckpt": ck, "guard": "oil,potion", "min_conf": "0"},
            {"name": "rules-replay", "ckpt": None, "guard": "", "replay": True}]


def override_stats(gdirs):
    """How often the model's answer was used, and how often that changed the rules' choice."""
    acted = changed = games = 0
    for g in gdirs:
        p, hit = os.path.join(g, "decisions.jsonl"), False
        if not os.path.exists(p): continue
        for line in open(p):
            r = json.loads(line)
            if r.get("acted") != "model": continue
            acted += 1
            if r.get("model_choice") != r.get("rules_choice"): changed += 1; hit = True
        games += hit
    return {"model_acted": acted, "changed_rules_choice": changed, "games_changed": games}


# ── phase 1 ──
def stage_tournament(run, name, deadline):
    arms = arms_for(run)
    n_fresh, n_bank = (3, 1) if run.smoke else (192, 48)
    replay_n = 2 if run.smoke else REPLAY_N
    pool = D2.bank_files(run)
    rng = random.Random(name)
    starts = []
    for i in range(max(n_fresh, n_bank)):
        if i < n_fresh: starts.append({"id": f"{2600000 + i}-{D.CLASSES[i % len(D.CLASSES)]}", "seed": 2600000 + i,
                                       "cls": D.CLASSES[i % len(D.CLASSES)], "restore": None})
        if i < n_bank and pool: starts.append({"id": f"{2650000 + i}-bank", "seed": 2650000 + i, "cls": "random",
                                               "restore": rng.choice(pool)})
    jobs = iter([(s, a) for i, s in enumerate(starts) for a in arms if not a.get("replay") or i < replay_n])
    names = D3.model_names(arms)
    lock, outcomes = threading.Lock(), collections.defaultdict(dict)
    caps = {"fresh": (240, 1500) if run.smoke else (900, 20000), "bank": (240, 1500) if run.smoke else (600, 15000)}

    def worker(slot):
        while not run.stopped() and time.time() < deadline:
            if slot >= D.THROTTLED_SLOTS and os.path.exists(os.path.join(run.path, "THROTTLE")):
                time.sleep(30); continue
            with lock: job = next(jobs, None)
            if job is None: return
            s, a = job
            cap, maxa = caps["bank" if s["restore"] else "fresh"]
            cap_now = max(60, min(cap, deadline - time.time()))
            res = D.play_game(run, f"{name}-{a['name']}", slot, s["seed"], s["cls"], D5.arm_env(a, names),
                              os.path.join(run.path, name, a["name"], s["id"]), cap_now, maxa, 4100, None, s["restore"])
            res["cut"] = bool(res.get("timed_out") and res.get("seconds", 0) < cap - 30)
            with lock: outcomes[a["name"]][s["id"]] = res
            run.log(f"{name}-{a['name']}: {s['id']}: {res}")

    with D3.MultiLaya(names, run.d(name, "laya.log")):
        with cf.ThreadPoolExecutor(run.slots) as ex:
            list(ex.map(worker, range(run.slots)))
    for a in arms: D.rm_containers(f"ovn-{name}-{a['name']}-")

    main_arms = [a for a in arms if not a.get("replay")]
    ok = lambda o: o and "error" not in o and not o["cut"]  # noqa: E731
    complete = [s for s in starts if all(ok(outcomes[a["name"]].get(s["id"])) for a in main_arms)]
    gd = lambda a, s: os.path.join(run.path, name, a, s["id"])  # noqa: E731
    fp = lambda a, s: D2.game_summary(gd(a, s))["fingerprint"]  # noqa: E731
    replayed = [s for s in starts[:replay_n] if ok(outcomes["rules"].get(s["id"])) and ok(outcomes["rules-replay"].get(s["id"]))]
    same = sum(fp("rules", s) == fp("rules-replay", s) for s in replayed)
    res = {"arms": arms, "starts_planned": len(starts), "starts_complete": len(complete),
           "replay": {"n": len(replayed), "identical": same},
           "deadline_cut": {a["name"]: sum(1 for o in outcomes[a["name"]].values() if o.get("cut")) for a in arms},
           "errors": {a["name"]: sum(1 for o in outcomes[a["name"]].values() if "error" in o) for a in arms}, "vs_rules": {}}
    checks = [("starts complete >= 75% of planned", len(complete) >= 0.75 * len(starts)),
              ("replay identical >= 90%", bool(replayed) and same >= 0.9 * len(replayed))]

    def compare(base, other):
        out = {}
        for subset, sel in (("all", complete), ("fresh", [s for s in complete if not s["restore"]]),
                            ("bank", [s for s in complete if s["restore"]])):
            b = {s["id"]: outcomes[base][s["id"]] for s in sel}
            o = {s["id"]: outcomes[other][s["id"]] for s in sel}
            out[subset] = D2.paired_test(b, o)
            out[subset]["robust"] = D3.robustness(b, o)
        out["sign_p"] = D3.sign_p(out["all"]["wins"], out["all"]["losses"])
        out["identical"] = sum(fp(base, s) == fp(other, s) for s in complete)
        return out

    for a in main_arms:
        if a["name"] == "rules":
            res["vs_rules"]["rules"] = {
                "deaths": sum(outcomes["rules"][s["id"]]["dead"] for s in complete),
                "mean_depth": round(sum(outcomes["rules"][s["id"]]["max_depth"] for s in complete) / max(1, len(complete)), 2),
                "top_killers": collections.Counter(outcomes["rules"][s["id"]].get("death_cause") for s in complete
                                                   if outcomes["rules"][s["id"]]["dead"]).most_common(8)}
            continue
        info = compare("rules", a["name"])
        if a["ckpt"]:
            gdirs = [gd(a["name"], s) for s in complete]
            ratio, n, guards = D3.consult_stats(gdirs)
            thr = max((D2.game_summary(g)["throws"] for g in gdirs), default=0)
            info.update(consulted=ratio, trained_type_decisions=n, guards=guards, max_throws=thr, **override_stats(gdirs))
            checks += [(f"{a['name']}: consulted >= 0.9", ratio is not None and ratio >= 0.9),
                       (f"{a['name']}: max throws <= 100", thr <= 100)]
            info["vs_rules+"] = compare("rules+", a["name"])
        res["vs_rules"][a["name"]] = info
    res["canary"] = D2.canary(res, checks)
    return res


# ── phase 2: CPU ──
def stage_label(run, name, deadline):
    """Continue labelling session 5's collectE decisions: run.ts appends to a copy of labelE's output and skips the
    records already in it. New labels are the lines after labelE's."""
    prior_lab = os.path.join(run.prior, "labelE")
    dec = os.path.join(prior_lab, "decisions.jsonl")
    out = run.d(name, "labels.all.jsonl")
    if not os.path.exists(out):
        for src, dst in (("labels.jsonl", out), ("labels.unlabelled.jsonl", run.d(name, "labels.all.unlabelled.jsonl"))):
            p = os.path.join(prior_lab, src)
            with open(dst, "w") as f:
                if os.path.exists(p): f.write(open(p).read())
    n0 = sum(1 for _ in open(os.path.join(prior_lab, "labels.jsonl")))
    run.state["labelF_n0"] = n0; run.save()
    urls = [f"http://127.0.0.1:{4300 + i + D.PORT_OFFSET}" for i in range(run.slots)]
    script = ["tools/rollout/run.ts", "--decisions", dec, "--dir", run.prior, "--out", out, "--servers", ",".join(urls),
              "--workers", str(run.slots), "--types", D2.MODEL_TYPES, "--k", "4" if run.smoke else "8", "--k-min", "4",
              "--order", "danger", "--utility", "v2"]
    if run.smoke: script += ["--max-records", "30"]  # counts new records only
    env = {"BUSHO_TMP": run.d(name, "tmp", "x")[:-2], "ANGBAND_C": D.C_BIN, **D5.HONEST}
    text, timed_out = D.run_node(run, f"ovn-{name}-orch", script, env, max(60, int(deadline - time.time())), heap_mb=0)
    open(run.d(name, "orchestrator.tail.log"), "w").write(("stopped at deadline\n" if timed_out else "") + text[-3000:])
    new = new_labels(run)
    newf = run.d(name, "labels.jsonl")
    with open(newf, "w") as f:
        for r in new: f.write(json.dumps(r) + "\n")
    noise = D.run_node(run, f"ovn-{name}-noise", ["tools/rollout/noise.ts", newf], {}, 600, heap_mb=0)[0][-2000:] if new else ""
    open(run.d(name, "noise.txt"), "w").write(noise)
    agree = [float(x) for x in re.findall(r"split-half agreement=([\d.]+)%", noise)]
    runs_err = sum(sum(r["meta"].get("runs_error", {}).values()) for r in new)
    runs_all = sum(sum(r["meta"].get("runs_fired", {}).values()) for r in new) or 1
    ties = sum(bool(r["meta"].get("all_tie")) for r in new)
    res = {"labels": len(new), "by_type": dict(collections.Counter(r["meta"]["decision_type"] for r in new)),
           "all_tie": ties, "run_error_rate": round(runs_err / runs_all, 4), "split_half": agree,
           "noise": noise.strip().splitlines()[-6:]}
    res["canary"] = D2.canary(res, [("labels > 0", len(new) > 0),
                                    ("labels >= 300", run.smoke or len(new) >= 300),
                                    ("split-half >= 65%", all(a >= 65 for a in agree) if agree else run.smoke),
                                    ("all-tie <= 25%", run.smoke or ties <= 0.25 * max(1, len(new))),
                                    ("run errors <= 2%", runs_err <= 0.02 * runs_all)])
    return res


def new_labels(run):
    """labelF's labels so far: complete lines after labelE's, tagged with their source."""
    p = os.path.join(run.path, "labelF", "labels.all.jsonl")
    if not os.path.exists(p): return []
    n0 = run.state.get("labelF_n0", 0)
    lines = open(p).read().split("\n")[:-1]  # drop a partial last line
    out = []
    for line in lines[n0:]:
        r = json.loads(line); r["meta"]["source"] = "labelF"; out.append(r)
    return out


# ── phase 2: GPU ──
def train_eval(run, d, data, held, epochs, seed, deadline, smoke_items=300):
    """Train laya from the base model and evaluate on `held`. Returns metrics plus seconds per item-epoch."""
    n = sum(1 for _ in open(data))
    if run.smoke:
        small = os.path.join(d, "train.smoke.jsonl")
        with open(small, "w") as f: f.writelines(open(data).readlines()[:smoke_items])
        data, n, epochs = small, min(n, smoke_items), 1
    out = os.path.join(d, f"ckpt-e{epochs}-s{seed}")
    t0 = time.time()
    rc = subprocess.run([sys.executable, "-I", os.path.join(HERE, "train.py"), "--data", data, "--out", out,
                         "--epochs", str(epochs), "--loss", "soft-ce", "--seed", str(seed), "--deadline", str(deadline)]).returncode
    secs = time.time() - t0
    if rc != 0 or not os.path.isdir(out + ".final"):
        return {"failed": f"training failed (rc={rc})", "epochs": epochs, "seed": seed}
    return {"epochs": epochs, "seed": seed, "ckpt": out + ".final", "train_items": n, "train_minutes": round(secs / 60, 1),
            "s_per_item_epoch": round(secs / (n * epochs), 4), **evaluate_ckpt(out + ".final", held, data, out + ".offline.json")}


def evaluate_ckpt(ckpt, held, train, out):
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "evaluate.py"), "--heldout", held, "--train", train,
                    "--ckpt", ckpt, "--base", "", "--out", out])
    if not os.path.exists(out): return {"failed": "offline evaluation failed"}
    off = json.load(open(out))
    return {"acc": {k: off[k]["all"]["acc"] for k in ("model", "majority", "rules") if k in off},
            "brier": off["model"]["all"]["brier"],
            "by_type": {t: v for t, v in off["model"].items() if t in ("fight", "tactic")},
            "selective": off.get("selective")}


def stage_sweep(run, name, deadline):
    te = os.path.join(run.prior, "trainE")
    data, held = os.path.join(te, "data", "train.jsonl"), os.path.join(te, "data", "heldout.jsonl")
    d = run.d(name, "x")[:-2]
    pts = run.state.setdefault("sweep_points", {})
    if "4-0" not in pts:  # trainE itself, re-evaluated for the selective table
        pts["4-0"] = {"epochs": 4, "seed": 0, "ckpt": os.path.join(te, "ckpt-s0.final"), "trainE": True,
                      **evaluate_ckpt(os.path.join(te, "ckpt-s0.final"), held, data, os.path.join(d, "trainE.offline.json"))}
        run.save()
    for epochs, seed in SWEEP:
        k = f"{epochs}-{seed}"
        if k in pts or run.stopped() or time.time() > deadline: continue
        run.log(f"{name}: training {epochs} epochs, seed {seed}")
        pts[k] = train_eval(run, d, data, held, epochs, seed, deadline)
        run.log(f"{name}: {k}: {json.dumps({x: pts[k].get(x) for x in ('acc', 'brier', 'train_minutes', 'failed')})}")
        run.save()
    res = {"points": pts}
    acc = {k: v["acc"]["model"] for k, v in pts.items() if "acc" in v}
    if "4-0" in acc:
        noise = max(0.01, abs(acc["4-0"] - acc["4-1"])) if "4-1" in acc else 0.01
        best, choice = acc["4-0"], 4
        for e in (2, 8):  # another count is chosen only if it beats trainE by more than the seed-to-seed gap
            k = f"{e}-0"
            if k in acc and acc[k] - acc["4-0"] > noise and acc[k] > best: best, choice = acc[k], e
        res.update(seed_gap=round(noise, 4), chosen_epochs=choice)
        run.state["chosen_epochs"] = choice
    rates = [v["s_per_item_epoch"] for v in pts.values() if "s_per_item_epoch" in v]
    if rates: run.state["s_per_item_epoch"] = sorted(rates)[len(rates) // 2]
    res["canary"] = D2.canary(res, [("trainE re-evaluated", "4-0" in acc), ("at least one sweep run", len(acc) >= 2)])
    return res


def stage_train(run, name, deadline):
    te = os.path.join(run.prior, "trainE")
    d = run.d(name, "data", "x")[:-2]
    new = new_labels(run)
    counts = collections.Counter()
    recs = []
    for line in open(os.path.join(te, "labels.combined.jsonl")):
        r = json.loads(line); recs.append(r); counts[r["meta"].get("source")] += 1
    recs += new; counts["labelF"] = len(new)
    recs = [r for r in recs if not r["meta"].get("all_tie")]
    train, held = D.split_by_game(recs)
    paths = {}
    for fn, rows in (("train", train), ("heldout", held),
                     ("heldout.DE", [r for r in held if r["meta"].get("source") in ("labelD", "labelE")]),
                     ("heldout.F", [r for r in held if r["meta"].get("source") == "labelF"])):
        paths[fn] = os.path.join(d, f"{fn}.jsonl")
        with open(paths[fn], "w") as f:
            for r in rows: f.write(json.dumps(r) + "\n")
    want = run.state.get("chosen_epochs", 4)
    rate = run.state.get("s_per_item_epoch", 0.2)
    room = deadline - time.time() - 45 * 60  # evaluation and margin
    cap = int(room / (rate * max(1, len(train))))
    epochs = min(want, cap)
    res = {"sources": dict(counts), "train_items": len(train), "heldout": len(held), "epochs_wanted": want, "epochs_cap": cap}
    if epochs < 2 and not run.smoke:
        res["skipped"] = f"only {cap} epoch(s) fit before the deadline"; return res
    r = train_eval(run, run.d(name, "x")[:-2], paths["train"], paths["heldout"], max(1, epochs), 0, deadline)
    res.update(r)
    if "ckpt" in r:
        for part in ("heldout.DE", "heldout.F"):
            if os.path.getsize(paths[part]):
                res[part] = evaluate_ckpt(r["ckpt"], paths[part], paths["train"], run.d(name, f"offline.{part}.json"))
    if "acc" in r:
        res["canary"] = D2.canary(res, [("acc > majority", r["acc"]["model"] > r["acc"].get("majority", 0))])
    return res


KINDS = {"finalF": stage_tournament, "labelF": stage_label, "sweepF": stage_sweep, "trainF": stage_train}


def run_stage(run, name, deadline, smoke):
    prev = run.state["stages"].get(name) or {}
    if prev.get("status") in ("done", "skipped", "failed"): return
    if run.stopped(): run.log(f"not starting {name}: STOP file, signal or global deadline"); return
    if smoke: deadline = min(deadline, time.time() + SMOKE_MINUTES[name] * 60)
    run.state["stages"][name] = {"status": "running", "began": time.time()}
    run.save(); D.write_report(run)
    run.log(f"stage {name} begins (until {time.strftime('%H:%M', time.localtime(deadline))})")
    try:
        res = KINDS[name](run, name, deadline)
        status = "skipped" if "skipped" in res else ("failed" if "failed" in res else "done")
        run.state["stages"][name].update(status=status, result=res, ended=time.time())
        run.log(f"stage {name} {status}: {json.dumps(res)[:1500]}")
    except Exception as e:
        import traceback
        run.state["stages"][name].update(status="error", error=f"{type(e).__name__}: {e}", ended=time.time(),
                                         trace=traceback.format_exc()[-2000:])
        run.log(f"stage {name} error: {e}")
    run.save(); D.write_report(run)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--prior", required=True)
    ap.add_argument("--hours", type=float, default=14); ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--slots", type=int, default=13)
    a = ap.parse_args()
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior = os.path.abspath(a.prior)
    lock = threading.RLock()

    def shared(fn):
        """Two tracks share run.state: serialise writers, and retry when the other track changes the state
        mid-dump (json raises 'dictionary changed size during iteration'). The lock is always released."""
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
    run.log(f"driver6 start (smoke={a.smoke}, slots={a.slots}, engine={D.ENGINE}, c_bin={cbin}, "
            f"port_offset={D.PORT_OFFSET}); prior={run.prior}; app={app}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
    end = run.state["deadline"]
    try:
        run_stage(run, "finalF", min(time.time() + 2.5 * 3600, end), a.smoke)

        def gpu():
            run_stage(run, "sweepF", end, a.smoke)
            run_stage(run, "trainF", end, a.smoke)
        g = threading.Thread(target=gpu)
        g.start()
        run_stage(run, "labelF", end - 10 * 60, a.smoke)
        g.join()
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        D.write_report(run)
        run.log("driver6 finished")


if __name__ == "__main__":
    main()
