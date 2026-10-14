#!/usr/bin/env python3
"""Session 2 (20 h): baseline eval, agent rule pass, two real DAgger rounds, final eval.

See docs/finetune-laya-plan.md, "Session 2". Reuses driver.py's machinery (native processes,
game runner, labelling, Laya server/trainer) and adds: model acting during collection on its
trained question types only, bank-branch games (DL>=5 savepoints, new seeds), disagreement-first
labelling, a promotion test on paired scores, canaries on every stage, a gate that waits for the
agent's rule pass, and a memory watchdog. Resumable via RUN/state.json; `touch RUN/STOP` stops.

Usage: driver2.py --run runs/session2/<name> --prior runs/overnight/2026-10-13 [--hours 20]
                  [--smoke] [--slots 13]   (always native; Docker is left alone)
"""
import argparse, collections, concurrent.futures as cf, glob, json, os, random, re, shutil, signal
import subprocess, sys, threading, time  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
import driver as D  # noqa: E402
import evaluate  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
HERE = os.path.dirname(os.path.abspath(__file__))
LAYA_PORT = D.LAYA_PORT
MODEL_TYPES = "fight,tactic"
STAGES = [("baseline", "eval", 1.25), ("rulepass", "gate", 2.5),
          ("collectA", "collect", 1.25), ("labelA", "label", 3.75), ("trainA", "train", 1.0), ("evalA", "eval", 1.6),
          ("collectB", "collect", 1.25), ("labelB", "label", 3.75), ("trainB", "train", 1.0), ("evalB", "eval", 1.6),
          ("final", "eval", 1.75)]
SMOKE_MINUTES = {"eval": 8, "gate": 1, "collect": 5, "label": 6, "train": 20}
D.SCHEDULE = [(n, h) for n, _, h in STAGES]  # for D.write_report


# ── environment for busho ──
def model_env(seed=None, cls=None, bank=False):
    e = {"LLM_BACKEND": "systemone", "SYSTEMONE_URL": f"http://127.0.0.1:{LAYA_PORT}", "SYSTEMONE_MODEL": evaluate.NAME,
         "DECISION_POLICY": "model", "DECISION_MIN_CONFIDENCE": "0", "DECISION_MODEL_TYPES": MODEL_TYPES,
         "DECISION_LOG": "1", "DECISION_LOG_DIR": "/data", "DECISION_TRIGGERS": "wide"}
    if bank: e["SAVEPOINT_DIR"] = "/bank"
    return e


def rules_env(seed=None, cls=None):
    return {"LLM_BACKEND": "anthropic", "DECISION_LOG": "1", "DECISION_LOG_DIR": "/data", "DECISION_TRIGGERS": "wide"}


# ── reading game folders ──
def game_summary(gdir):
    """Outcome, decision stats and throw count from a finished game folder."""
    text = open(os.path.join(gdir, "player.log"), errors="replace").read() if os.path.exists(os.path.join(gdir, "player.log")) else ""
    m = {k: rx.search(text) for k, rx in D.FINAL.items()}
    depths = [int(x) for x in re.findall(r"最深部更新: DL(\d+)", text)]
    thr = re.search(r"投擲(\d+)回", text)
    decs = []
    f = os.path.join(gdir, "decisions.jsonl")
    if os.path.exists(f):
        for l in open(f):
            try: decs.append(json.loads(l))
            except ValueError: pass
    return {"max_depth": int(m["maxdl"].group(1)) if m["maxdl"] else max(depths, default=0), "dead": bool(m["dead"]),
            "actions": int(m["actions"].group(1)) if m["actions"] else None, "throws": int(thr.group(1)) if thr else 0,
            "decisions": decs, "fingerprint": (m["actions"].group(1) if m["actions"] else None, bool(m["dead"]),
                                               max(depths, default=0))}


def acted_ratio(game_dirs):
    """Share of trained-type decisions the model acted on."""
    n = a = 0
    types = set(MODEL_TYPES.split(","))
    for g in game_dirs:
        for r in game_summary(g)["decisions"]:
            if r.get("decision_type") in types:
                n += 1; a += r.get("acted") == "model"
    return (a / n if n else None), n


# ── stages ──
def stage_gate(run, name, deadline):
    """Wait for the agent's rule pass (RUN/AGENT_DONE). If it finished, re-freeze the source."""
    flag = os.path.join(run.path, "AGENT_DONE")
    while not os.path.exists(flag) and time.time() < deadline and not run.stopped():
        time.sleep(30)
    if not os.path.exists(flag):
        return {"skipped": "agent rule pass did not finish; keeping the frozen source"}
    src = os.path.join(run.path, "src")
    keep = os.path.join(run.path, f"src-before-{name}")
    if os.path.exists(src) and not os.path.exists(keep): os.replace(src, keep)
    D.app_dir(run)  # freezes the current repo and rebuilds the runnable copy
    return {"refrozen": True, "agent_note": open(flag).read()[-2000:]}


def bank_files(run):
    files = glob.glob(os.path.join(run.path, "bank", "*.json.gz")) + glob.glob(os.path.join(run.prior, "bank", "*.json.gz"))
    return sorted(f for f in files if (m := re.search(r"-DL(\d+)-", os.path.basename(f))) and int(m.group(1)) >= 5)


def stage_collect(run, name, deadline):
    ckpt = run.state.get("incumbent")
    if not ckpt or not os.path.isdir(ckpt):
        return {"failed": f"no incumbent checkpoint ({ckpt})"}
    games_dir = run.d(name, "games", "x")[:-2]
    bank = run.d("bank", "x")[:-2]
    pool = bank_files(run)
    rng = random.Random(name)
    base = {"collectA": 300000, "collectB": 400000}.get(name, 500000)

    def jobs():
        for i in range(100000):
            if pool and i % 5 in (1, 3):  # 40% branch from a DL>=5 savepoint with a fresh seed
                yield (base + i, "random", rng.choice(pool))
            else:
                yield (base + i, D.CLASSES[i % len(D.CLASSES)])

    cap, maxa = (240, 1500) if run.smoke else (1500, 30000)
    with evaluate.LayaServer(ckpt, LAYA_PORT, "ovn-laya-collect"):
        outcomes = D.run_games(run, name, jobs(), run.slots, deadline, lambda s, c: model_env(bank=True), cap, maxa,
                               games_dir, 4100, bank)
    gdirs = [os.path.join(games_dir, g) for g in os.listdir(games_dir)]
    ratio, n_trained = acted_ratio(gdirs)
    sums = [game_summary(g) for g in gdirs]
    by_type = collections.Counter(r["decision_type"] for s in sums for r in s["decisions"])
    res = {"ckpt": ckpt, "games": len(outcomes), "bank_games": sum(bool(o.get("restore")) for o in outcomes),
           "errors": sum("error" in o for o in outcomes), "decisions": sum(by_type.values()), "by_type": dict(by_type),
           "acted_model": ratio, "trained_type_decisions": n_trained,
           "deaths": sum(o.get("dead", False) for o in outcomes),
           "max_depth": max((o.get("max_depth", 0) for o in outcomes), default=0),
           "max_throws": max((s["throws"] for s in sums), default=0)}
    res["canary"] = canary(res, [("acted_model >= 0.9", ratio is not None and ratio >= 0.9),
                                 ("max_throws <= 100", res["max_throws"] <= 100),
                                 ("errors <= 10%", res["errors"] <= 0.1 * max(1, res["games"]))])
    return res


def canary(res, checks):
    failed = [name for name, ok in checks if not ok]
    if failed: res["failed"] = "canary: " + ", ".join(failed)
    return {"passed": not failed, "failed": failed}


def stage_label(run, name, deadline):
    collects = ["s1-collect1", "s1-collect2"] + [n for n, k, _ in STAGES if k == "collect" and STAGES.index((n, k, _)) < idx(name)]
    dec = run.d(name, "decisions.jsonl")
    n = D.merge_decisions(run, [c for c in collects if os.path.isdir(os.path.join(run.path, c))], dec)
    out = run.d(name, "labels.jsonl")
    prev = run.state.get("labels") or os.path.join(run.prior, "label2", "labels.jsonl")  # carry earlier labels forward
    if os.path.exists(prev) and not os.path.exists(out): shutil.copy(prev, out)
    carried = sum(1 for _ in open(out)) if os.path.exists(out) else 0
    tag = f"ovn-{name}-r"
    D.rm_containers(tag)
    urls = []
    for i in range(run.slots):
        D.start_server(run, f"{tag}{i}", 4300 + i, {"VANILLA": "1"}, 1)
        urls.append(f"http://127.0.0.1:{4300 + i}")
    script = ["tools/rollout/run.ts", "--decisions", dec, "--dir", run.path, "--out", out, "--servers", ",".join(urls),
              "--workers", str(run.slots), "--types", MODEL_TYPES, "--k", "4" if run.smoke else "8", "--k-min", "4",
              "--order", "disagree"]
    if run.smoke: script += ["--max-records", "12"]
    env = {"BUSHO_TMP": run.d(name, "tmp", "x")[:-2]}
    text, timed_out = D.run_node(run, f"ovn-{name}-orch", script, env, max(60, int(deadline - time.time())), heap_mb=0)
    D.rm_containers(tag)
    open(run.d(name, "orchestrator.tail.log"), "w").write(("stopped at stage deadline\n" if timed_out else "") + text[-3000:])
    labels = [json.loads(l) for l in open(out)] if os.path.exists(out) else []
    noise = D.run_node(run, f"ovn-{name}-noise", ["tools/rollout/noise.ts", out], {}, 600, heap_mb=0)[0][-2000:] if labels else ""
    open(run.d(name, "noise.txt"), "w").write(noise)
    new = labels[carried:]
    agree = [float(x) for x in re.findall(r"split-half agreement=([\d.]+)%", noise)]
    runs_err = sum(sum(r["meta"].get("runs_error", {}).values()) for r in new)
    runs_all = sum(sum(r["meta"].get("runs_fired", {}).values()) for r in new) or 1
    ties = sum(bool(r["meta"].get("all_tie")) for r in new)
    disagree_new = sum(1 for r in new if r["meta"].get("model_choice") and r["meta"].get("model_choice") != r["meta"].get("rules_choice"))
    res = {"decisions_available": n, "carried": carried, "new_labels": len(new), "total": len(labels),
           "by_type_new": dict(collections.Counter(r["meta"]["decision_type"] for r in new)),
           "all_tie_new": ties, "run_error_rate": round(runs_err / runs_all, 4), "split_half": agree,
           "disagreement_labels": disagree_new, "noise": noise.strip().splitlines()[-6:]}
    res["canary"] = canary(res, [("new labels > 0", len(new) > 0 or run.smoke),
                                 ("split-half >= 65%", all(a >= 65 for a in agree) if agree else run.smoke),
                                 ("all-tie <= 25%", ties <= 0.25 * max(1, len(new))),  # disagreement-first records tie more; ties are not trained on
                                 ("run errors <= 2%", runs_err <= 0.02 * runs_all)])
    if not res.get("failed"): run.state["labels"] = out
    return res


def stage_train(run, name, deadline):
    src = run.state.get("labels")
    if not src: return {"skipped": "no labels"}
    records = [r for r in (json.loads(l) for l in open(src)) if not r["meta"].get("all_tie")]
    train, held = D.split_by_game(records)
    if run.smoke: train = train[:300]  # smoke: just exercise the path
    d = run.d(name, "data", "x")[:-2]
    for fn, rows in (("train.jsonl", train), ("heldout.jsonl", held)):
        with open(os.path.join(d, fn), "w") as f:
            for r in rows: f.write(json.dumps(r) + "\n")
    epochs = 1 if run.smoke else 4
    out = run.d(name, "ckpt-s0")
    rc = subprocess.run([sys.executable, "-I", os.path.join(HERE, "train.py"), "--data", os.path.join(d, "train.jsonl"),
                         "--out", out, "--epochs", str(epochs), "--loss", "soft-ce", "--seed", "0",
                         "--deadline", str(deadline)]).returncode
    if rc != 0 or not os.path.isdir(out + ".final"):
        return {"failed": f"training failed (rc={rc})", "train_items": len(train)}
    m = run.d(name, "offline.json")
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "evaluate.py"), "--heldout", os.path.join(d, "heldout.jsonl"),
                    "--train", os.path.join(d, "train.jsonl"), "--ckpt", out + ".final", "--out", m])
    if not os.path.exists(m): return {"failed": "offline evaluation failed", "train_items": len(train)}
    off = json.load(open(m))
    res = {"train_items": len(train), "heldout": len(held), "epochs": epochs, "ckpt": out + ".final",
           "acc": {k: off[k]["all"]["acc"] for k in ("model", "majority", "rules", "base") if k in off},
           "brier": {k: off[k]["all"]["brier"] for k in ("model", "majority", "rules", "base") if k in off},
           "by_type": {t: v for t, v in off["model"].items() if t in ("fight", "tactic")}}
    res["canary"] = canary(res, [("acc > majority", off["model"]["all"]["acc"] > off["majority"]["all"]["acc"])])
    if not res.get("failed"): run.state["incumbent"] = res["ckpt"]  # the policy the next collection uses
    return res


def paired_test(rules, model):
    """Promotion test on paired games: score = max depth - 3 if dead."""
    sc = lambda o: o["max_depth"] - 3 * o["dead"]  # noqa: E731
    keys = sorted(set(rules) & set(model))
    diffs = [sc(model[k]) - sc(rules[k]) for k in keys]
    wins, losses = sum(x > 0 for x in diffs), sum(x < 0 for x in diffs)
    rng = random.Random(0)
    boots = sorted(sum(rng.choice(diffs) for _ in diffs) / len(diffs) for _ in range(2000)) if diffs else [0]
    dr, dm = sum(rules[k]["dead"] for k in keys), sum(model[k]["dead"] for k in keys)
    return {"pairs": len(keys), "wins": wins, "losses": losses, "mean_diff": round(sum(diffs) / max(1, len(diffs)), 3),
            "ci80": [round(boots[len(boots) // 10], 3), round(boots[9 * len(boots) // 10], 3)],
            "deaths_rules": dr, "deaths_model": dm,
            "mean_depth_rules": round(sum(rules[k]["max_depth"] for k in keys) / max(1, len(keys)), 2),
            "mean_depth_model": round(sum(model[k]["max_depth"] for k in keys) / max(1, len(keys)), 2),
            "promote": bool(keys) and wins > losses and dm <= dr + 2}


def stage_eval(run, name, deadline):
    if name == "baseline":
        ckpt = run.state.get("incumbent")
    elif name == "final":
        cands = [s["result"] for n, s in run.state["stages"].items() if n.startswith("eval") and s.get("status") == "done"
                 and s.get("result", {}).get("test", {}).get("promote")]
        if not cands:
            cands = [s["result"] for n, s in run.state["stages"].items()
                     if n in ("baseline", "evalA", "evalB") and s.get("status") == "done" and "test" in s.get("result", {})]
        if not cands: return {"skipped": "nothing evaluated"}
        ckpt = max(cands, key=lambda r: r["test"]["mean_diff"])["ckpt"]
    else:
        tr = run.state["stages"].get("train" + name[-1], {})
        if tr.get("status") != "done": return {"skipped": f"train{name[-1]} did not pass ({tr.get('status')})"}
        ckpt = tr.get("result", {}).get("ckpt")
    if not ckpt or not os.path.isdir(ckpt): return {"skipped": f"no checkpoint ({ckpt})"}
    n = 2 if run.smoke else (60 if name == "final" else 48)
    base = {"baseline": 910000, "evalA": 920000, "evalB": 930000, "final": 990000}[name]
    pairs = [(base + i, D.CLASSES[i % len(D.CLASSES)]) for i in range(n)]
    cap, maxa = (240, 1500) if run.smoke else (900, 20000)
    half = max(1, run.slots // 2)
    res = {}
    with evaluate.LayaServer(ckpt, LAYA_PORT, "ovn-laya-eval"):
        with cf.ThreadPoolExecutor(2) as ex:
            fr = ex.submit(D.run_games, run, f"{name}-rules", list(pairs), half, deadline, rules_env, cap, maxa, run.d(name, "rules", "x")[:-2], 4100)
            fm = ex.submit(D.run_games, run, f"{name}-model", list(pairs), run.slots - half, deadline, model_env, cap, maxa, run.d(name, "model", "x")[:-2], 4200)
            res["rules"], res["model"] = fr.result(), fm.result()
    # A game killed by the stage deadline (not by its own wall cap) is unfinished; pairing it would bias the test.
    cut = lambda o: o.get("timed_out") and o.get("seconds", 0) < cap - 30  # noqa: E731
    by = {k: {(o["seed"], o["class"]): o for o in v if "error" not in o and not cut(o)} for k, v in res.items()}
    test = paired_test(by["rules"], by["model"])
    test["deadline_cut"] = {k: sum(1 for o in v if "error" not in o and cut(o)) for k, v in res.items()}
    gd = lambda arm, k: os.path.join(run.path, name, arm, f"{k[0]}-{k[1]}")  # noqa: E731
    keys = sorted(set(by["rules"]) & set(by["model"]))
    same = sum(game_summary(gd("rules", k))["fingerprint"] == game_summary(gd("model", k))["fingerprint"] for k in keys)
    ratio, n_trained = acted_ratio([gd("model", k) for k in keys])
    max_thr = max((game_summary(gd("model", k))["throws"] for k in keys), default=0)
    out = {"ckpt": ckpt, "test": test, "identical_pairs": same, "acted_model": ratio, "trained_type_decisions": n_trained,
           "max_throws_model": max_thr}
    out["canary"] = canary(out, [("acted_model >= 0.9", ratio is not None and ratio >= 0.9),
                                 ("identical pairs <= 50%", same <= 0.5 * max(1, len(keys))),
                                 ("max throws <= 100", max_thr <= 100), ("pairs >= 75% of planned", len(keys) >= 0.75 * n)])
    if test["promote"] and not out.get("failed"): run.state.setdefault("promoted", []).append(ckpt)
    return out


KINDS = {"eval": stage_eval, "gate": stage_gate, "collect": stage_collect, "label": stage_label, "train": stage_train}


def idx(name): return [n for n, _, _ in STAGES].index(name)


# ── watchdog ──
def watchdog(run):
    """Throttle to fewer games if WSL memory gets high or Windows logs a low-memory event (ID 2004)."""
    flag = os.path.join(run.path, "THROTTLE")
    started = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(run.state["started"]))
    last_win = 0
    while not D.STOP.is_set():
        try:
            mi = dict(l.split(":", 1) for l in open("/proc/meminfo"))
            used_gb = (int(mi["MemTotal"].split()[0]) - int(mi["MemAvailable"].split()[0])) / 2**20
            reason = f"WSL memory {used_gb:.1f} GB" if used_gb > 16 else None
            if time.time() - last_win > 600:
                last_win = time.time()
                ps = (f"(Get-WinEvent -FilterHashtable @{{LogName='System'; Id=2004; StartTime=[datetime]'{started}'}} "
                      "-ErrorAction SilentlyContinue | Measure-Object).Count")
                p = subprocess.run(["/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "-NoProfile", "-Command", ps],
                                   capture_output=True, text=True, timeout=60, cwd="/mnt/c")
                cnt = int((p.stdout.strip() or "0").splitlines()[-1]) if p.returncode == 0 else 0
                if cnt > 0: reason = f"Windows low-memory events since start: {cnt}"
            if reason and not os.path.exists(flag):
                open(flag, "w").write(reason); run.log(f"watchdog: throttling to {D.THROTTLED_SLOTS} games ({reason})")
        except Exception as e:  # never let the watchdog kill the run
            run.log(f"watchdog error: {e}")
        D.STOP.wait(120)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--prior", required=True)
    ap.add_argument("--hours", type=float, default=20); ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--slots", type=int, default=13)
    a = ap.parse_args()
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior = os.path.abspath(a.prior)
    signal.signal(signal.SIGTERM, lambda *_: D.STOP.set())
    for c in ("collect1", "collect2"):  # session-1 games, for re-labelling with disagreement order
        link = os.path.join(run.path, f"s1-{c}")
        if not os.path.exists(link): os.symlink(os.path.join(run.prior, c), link)
    run.state.setdefault("incumbent", os.path.join(run.prior, "train2", "ckpt-s1.final"))
    run.log(f"driver2 start (smoke={a.smoke}, slots={a.slots}); prior={run.prior}; app={D.app_dir(run)}")
    threading.Thread(target=watchdog, args=(run,), daemon=True).start()
    try:
        for name, kind, hours in STAGES:
            prev = run.state["stages"].get(name) or {}
            if prev.get("status") in ("done", "skipped", "failed"): continue
            if run.stopped(): run.log("stopping: STOP file, signal or global deadline"); break
            budget = SMOKE_MINUTES[kind] * 60 if a.smoke else hours * 3600
            deadline = min(time.time() + budget, run.state["deadline"])
            run.state["stages"][name] = {"status": "running", "began": time.time()}
            run.save(); D.write_report(run)
            run.log(f"stage {name} begins (budget {budget / 3600:.2f} h)")
            try:
                res = KINDS[kind](run, name, deadline)
                status = "skipped" if "skipped" in res else ("failed" if "failed" in res else "done")
                run.state["stages"][name].update(status=status, result=res, ended=time.time())
                run.log(f"stage {name} {status}: {json.dumps(res)[:900]}")
            except Exception as e:  # keep going: later stages may still be useful
                import traceback
                run.state["stages"][name].update(status="error", error=f"{type(e).__name__}: {e}", ended=time.time(),
                                                 trace=traceback.format_exc()[-2000:])
                run.log(f"stage {name} error: {e}")
            run.save(); D.write_report(run)
    finally:
        D.STOP.set()
        D.rm_containers("ovn-")
        D.write_report(run)
        run.log("driver2 finished")


if __name__ == "__main__":
    main()
