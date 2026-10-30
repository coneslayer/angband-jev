#!/usr/bin/env python3
"""Session 3 (23 h): guard tournament, one DAgger round with scarcity-aware labels, final tournament.

See docs/finetune-laya-plan.md, "Session 3". Builds on driver.py (native game runner, labelling servers)
and driver2.py (busho envs, collection, training, canaries, paired test). New here:
  - tournaments: N arms (rules, or a checkpoint + busho MODEL_GUARD) over one list of starts, jobs
    interleaved by start so every arm finishes the same starts; fresh DL1 starts plus bank (DL>=5
    savepoint, fixed seed) starts; one laya server holding every checkpoint the arms need;
  - labelC: utility v2 (scarcity term) on the new collection, then re-rolls of session-2 records
    whose v1 label favoured throw or heal; v2 labels replace v1 per record.
Resumable via RUN/state.json; `touch RUN/STOP` stops between games. Never restart it mid-stage.

Usage: driver3.py --run runs/session3/<name> --prior runs/session2/2026-10-13 [--hours 20.5] [--smoke] [--slots 13]
"""
import argparse, collections, concurrent.futures as cf, glob, gzip, json, os, random, re, shutil, signal
import subprocess, sys, threading, time, urllib.request  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OVN_NATIVE"] = "1"
import driver as D  # noqa: E402
import driver2 as D2  # noqa: E402
import evaluate  # noqa: E402

D.NATIVE = evaluate.NATIVE = True
LAYA_PORT = D.LAYA_PORT
STAGES = [("T1", "tournament", 4.5), ("collectC", "collect", 1.25), ("labelC", "label", 5.0),
          ("trainC", "train", 0.75), ("final", "tournament", 7.5)]  # final 6.0 -> 7.5 h for the rules-adj arm
SMOKE_MINUTES = {"tournament": 9, "collect": 5, "label": 8, "train": 20}
D.SCHEDULE = [(n, h) for n, _, h in STAGES]
GUARDS_ALL = "oil,potion,flee"


# ── arms ──
def t1_arms(run):
    ck = os.path.join(run.prior, "trainB", "ckpt-s0.final")
    return [{"name": "rules", "ckpt": None, "guard": ""},
            {"name": "B", "ckpt": ck, "guard": ""},
            {"name": "B-op", "ckpt": ck, "guard": "oil,potion"},
            {"name": "B-opf", "ckpt": ck, "guard": GUARDS_ALL}]


def final_arms(run):
    w = run.state.get("t1_winner")
    if not w: return None
    arms = [{"name": "rules", "ckpt": None, "guard": ""}, dict(w, name="W")]
    c = run.state["stages"].get("trainC", {})
    if c.get("status") == "done" and c.get("result", {}).get("ckpt"):
        arms.append({"name": "C", "ckpt": c["result"]["ckpt"], "guard": w["guard"]})
    arms.append({"name": "rules-adj", "ckpt": None, "guard": "", "caution": rules_adj_caution(run)})
    return arms


def rules_adj_caution(run):
    """Control arm (added after T1, before the final): the rules with RULES_CAUTION moved toward W's place on
    the risk/reward curve, so the final can tell skill from a different caution setting. Pre-committed rule
    on W's T1 result against rules: more deaths -> bolder (-1); fewer -> more cautious (+1); same deaths ->
    bolder if W went deeper, else more cautious."""
    if "rules_adj_caution" not in run.state:
        t = run.state["stages"]["T1"]["result"]["vs_rules"][run.state["t1_winner"]["name"]]["all"]
        dd = t["deaths_model"] - t["deaths_rules"]
        c = -1.0 if dd > 0 else 1.0 if dd < 0 else (-1.0 if t["mean_depth_model"] > t["mean_depth_rules"] else 1.0)
        run.state["rules_adj_caution"] = c
        run.log(f"rules-adj: RULES_CAUTION={c} (T1 W vs rules: deaths {t['deaths_model']}/{t['deaths_rules']}, "
                f"depth {t['mean_depth_model']}/{t['mean_depth_rules']})")
    return run.state["rules_adj_caution"]


def model_names(arms):
    """laya model name per checkpoint (one server holds them all)."""
    names = {}
    for a in arms:
        if a["ckpt"] and a["ckpt"] not in names: names[a["ckpt"]] = f"ovn-ck{len(names)}"
    return names


def arm_env(arm, names, bank=False):
    if not arm["ckpt"]:
        e = D2.rules_env()
        if arm.get("caution"): e["RULES_CAUTION"] = str(arm["caution"])
        return e
    e = D2.model_env(bank=bank)
    e["SYSTEMONE_MODEL"] = names[arm["ckpt"]]
    if arm["guard"]: e["MODEL_GUARD"] = arm["guard"]
    return e


class MultiLaya:
    """Native laya-serve with several checkpoints registered (and preloaded) under their own names.
    Retries start-up, since another container's brief VRAM spike can make loading fail."""

    def __init__(self, names, log_path):
        self.names, self.log_path, self.proc = names, log_path, None

    def __enter__(self):
        if not self.names: return self
        env = {**os.environ, "LAYA_HOST": "127.0.0.1", "LAYA_PORT": str(LAYA_PORT), "LAYA_DEVICE": "cuda",
               "LAYA_DEFAULT_MODEL": "english", "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True",
               "LAYA_MAX_LOADED": str(len(self.names) + 1), "LAYA_MODELS": ",".join(self.names.values()),
               "LAYA_EXTRA_MODELS": json.dumps({n: p for p, n in self.names.items()})}
        for attempt in range(5):
            with open(self.log_path, "a") as log:
                self.proc = subprocess.Popen([evaluate.venv_bin("laya-serve")], env=env, stdout=log, stderr=subprocess.STDOUT,
                                             stdin=subprocess.DEVNULL, start_new_session=True)
            for _ in range(240):
                if self.proc.poll() is not None: break
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{LAYA_PORT}/health", timeout=5); return self
                except Exception:
                    time.sleep(2)
            self.__exit__()
            time.sleep(60 * (attempt + 1))
        raise RuntimeError(f"laya-serve did not come up: {open(self.log_path).read()[-2000:]}")

    def __exit__(self, *exc):
        if not self.proc: return
        try: os.killpg(self.proc.pid, signal.SIGTERM); self.proc.wait(timeout=30)
        except Exception:
            try: os.killpg(self.proc.pid, signal.SIGKILL)
            except Exception: pass
        self.proc = None


# ── game-folder readers ──
def last_supplies(gdir):
    """(flasks, cure potions) at the last decision snapshot, or None."""
    snaps = glob.glob(os.path.join(gdir, "snapshots", "*.json.gz"))
    if not snaps: return None
    snaps.sort(key=lambda p: int(m.group(1)) if (m := re.search(r"-(\d+)-\w+\.json\.gz$", p)) else 0)
    try: inv = json.load(gzip.open(snaps[-1]))["save"]["state"]["player"]["inventory"]
    except Exception: return None
    inv = [i for i in inv if i]
    return (sum(i.get("number", 1) for i in inv if i.get("tval") == 27), sum(i.get("number", 1) for i in inv if i.get("tval") == 26))


def consult_stats(gdirs):
    """Model consultation on trained types: (consulted ratio, n, guard counts)."""
    n = c = 0; guards = collections.Counter()
    types = set(D2.MODEL_TYPES.split(","))
    for g in gdirs:
        for r in D2.game_summary(g)["decisions"]:
            if r.get("decision_type") not in types: continue
            n += 1; c += r.get("model_choice") is not None
            if r.get("guard"): guards[r["guard"]] += 1
    return (c / n if n else None), n, dict(guards)


# ── stages ──
def stage_tournament(run, name, deadline):
    arms = t1_arms(run) if name == "T1" else final_arms(run)
    if not arms: return {"skipped": "no T1 winner"}
    n_fresh, n_bank = (2, 1) if run.smoke else ((48, 24) if name == "T1" else (90, 30))
    fresh_base, bank_base = {"T1": (1000000, 1050000), "final": (1100000, 1150000)}[name]
    pool = D2.bank_files(run)
    rng = random.Random(name)
    starts = []
    for i in range(max(n_fresh, n_bank)):  # bank starts interleaved with fresh ones
        if i < n_fresh: starts.append({"id": f"{fresh_base + i}-{D.CLASSES[i % len(D.CLASSES)]}", "seed": fresh_base + i,
                                       "cls": D.CLASSES[i % len(D.CLASSES)], "restore": None})
        if i < n_bank and pool: starts.append({"id": f"{bank_base + i}-bank", "seed": bank_base + i, "cls": "random",
                                               "restore": rng.choice(pool)})
    jobs = iter([(s, a) for s in starts for a in arms])
    names = model_names(arms)
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
            res = D.play_game(run, f"{name}-{a['name']}", slot, s["seed"], s["cls"], arm_env(a, names),
                              os.path.join(run.path, name, a["name"], s["id"]), cap_now, maxa, 4100, None, s["restore"])
            res["cut"] = bool(res.get("timed_out") and res.get("seconds", 0) < cap - 30)
            with lock: outcomes[a["name"]][s["id"]] = res
            run.log(f"{name}-{a['name']}: {s['id']}: {res}")

    with MultiLaya(names, run.d(name, "laya.log")):
        with cf.ThreadPoolExecutor(run.slots) as ex:
            list(ex.map(worker, range(run.slots)))
    for a in arms: D.rm_containers(f"ovn-{name}-{a['name']}-")

    ok = lambda o: o and "error" not in o and not o["cut"]  # noqa: E731
    complete = [s for s in starts if all(ok(outcomes[a["name"]].get(s["id"])) for a in arms)]
    res = {"arms": arms, "starts_planned": len(starts), "starts_complete": len(complete),
           "deadline_cut": {a["name"]: sum(1 for o in outcomes[a["name"]].values() if o.get("cut")) for a in arms},
           "errors": {a["name"]: sum(1 for o in outcomes[a["name"]].values() if "error" in o) for a in arms}, "vs_rules": {}}
    gd = lambda a, s: os.path.join(run.path, name, a, s["id"])  # noqa: E731
    checks = [("starts complete >= 75% of planned", len(complete) >= 0.75 * len(starts))]
    for a in arms:
        dead_sup = [last_supplies(gd(a["name"], s)) for s in complete if outcomes[a["name"]][s["id"]]["dead"]]
        dead_sup = [x for x in dead_sup if x]
        info = {"deaths_no_oil": sum(f == 0 for f, _ in dead_sup), "deaths_no_potion": sum(p == 0 for _, p in dead_sup),
                "deaths_with_snapshot": len(dead_sup)}
        if a["name"] != "rules":
            same = sum(D2.game_summary(gd(a["name"], s))["fingerprint"] == D2.game_summary(gd("rules", s))["fingerprint"] for s in complete)
            info["identical_to_rules"] = same
            checks.append((f"{a['name']}: identical to rules <= 50%", same <= 0.5 * max(1, len(complete))))
        if a["ckpt"]:
            ratio, n, guards = consult_stats([gd(a["name"], s) for s in complete])
            thr = max((D2.game_summary(gd(a["name"], s))["throws"] for s in complete), default=0)
            info.update(consulted=ratio, trained_type_decisions=n, guards=guards, max_throws=thr)
            checks += [(f"{a['name']}: consulted >= 0.9", ratio is not None and ratio >= 0.9),
                       (f"{a['name']}: max throws <= 100", thr <= 100)]
        if a["name"] != "rules":
            for subset, sel in (("all", complete), ("fresh", [s for s in complete if not s["restore"]]),
                                ("bank", [s for s in complete if s["restore"]])):
                r = {s["id"]: outcomes["rules"][s["id"]] for s in sel}
                m = {s["id"]: outcomes[a["name"]][s["id"]] for s in sel}
                info[subset] = D2.paired_test(r, m)
                info[subset]["robust"] = robustness(r, m)
            info["sign_p"] = sign_p(info["all"]["wins"], info["all"]["losses"])
        else:
            info["deaths"] = sum(outcomes["rules"][s["id"]]["dead"] for s in complete)
        res["vs_rules"][a["name"]] = info

    def head_to_head(base, other):  # other against base on the complete starts
        b = {s["id"]: outcomes[base][s["id"]] for s in complete}
        o = {s["id"]: outcomes[other][s["id"]] for s in complete}
        t = D2.paired_test(b, o)
        t["sign_p"] = sign_p(t["wins"], t["losses"])
        t["robust"] = robustness(b, o)
        return t
    present = {a["name"] for a in arms}
    if name == "final" and "C" in present: res["C_vs_W"] = head_to_head("W", "C")  # C against the T1 winner directly
    if name == "final" and "rules-adj" in present:
        res["W_vs_rules_adj"] = head_to_head("rules-adj", "W")
        if "C" in present: res["C_vs_rules_adj"] = head_to_head("rules-adj", "C")
        res["frontier"] = frontier(res["vs_rules"], [a["name"] for a in arms if a["ckpt"]])
    res["canary"] = D2.canary(res, checks)
    if name == "T1" and not res.get("failed"):
        res["winner"] = pick_winner(res, arms)
        run.state["t1_winner"] = next(a for a in arms if a["name"] == res["winner"])
    return res


PENALTIES = [0, 1, 2, 3, 6, 20]  # depth levels a death costs; 20 ~ survival first


def robustness(base, other):
    """Is `other` better than `base` whatever the price of a death? Paired W-L and mean score difference under
    each death penalty, deaths per dungeon level reached, and a verdict: "better" if it wins (W > L and mean
    diff > 0) at every penalty, "worse" if it loses (W < L and mean diff < 0) at every one, else "trade-off"
    (the result depends on how much a death is worth, i.e. on risk tuning)."""
    keys = sorted(set(base) & set(other))
    sweep = {}
    for k in PENALTIES:
        d = [(other[x]["max_depth"] - k * other[x]["dead"]) - (base[x]["max_depth"] - k * base[x]["dead"]) for x in keys]
        w, l = sum(v > 0 for v in d), sum(v < 0 for v in d)
        sweep[str(k)] = {"wins": w, "losses": l, "mean_diff": round(sum(d) / max(1, len(d)), 3), "sign_p": sign_p(w, l)}
    hazard = lambda g: round(sum(o["dead"] for o in g) / max(1, sum(o["max_depth"] for o in g)), 4)  # noqa: E731
    up = [v["wins"] > v["losses"] and v["mean_diff"] > 0 for v in sweep.values()]
    down = [v["wins"] < v["losses"] and v["mean_diff"] < 0 for v in sweep.values()]
    return {"sweep": sweep, "deaths_per_level": {"base": hazard([base[x] for x in keys]), "other": hazard([other[x] for x in keys])},
            "verdict": "better" if all(up) else "worse" if all(down) else "trade-off"}


def frontier(vs_rules, model_arms):
    """rules and rules-adj are two points (deaths, mean depth) on the rules' risk/reward curve. For each model
    arm: the depth the rules would reach at the model's death count (straight line through the two points);
    a model above that line beats what re-tuning the rules' caution buys."""
    ra = vs_rules.get("rules-adj", {}).get("all")
    if not ra: return None
    d0, x0, d1, x1 = ra["deaths_rules"], ra["mean_depth_rules"], ra["deaths_model"], ra["mean_depth_model"]
    out = {"rules": [d0, x0], "rules-adj": [d1, x1]}
    for a in model_arms:
        m = vs_rules[a]["all"]
        if m["pairs"] != ra["pairs"]: continue
        if d1 == d0: out[a] = {"deaths": m["deaths_model"], "depth": m["mean_depth_model"], "rules_line": None}; continue
        line = x0 + (x1 - x0) * (m["deaths_model"] - d0) / (d1 - d0)
        out[a] = {"deaths": m["deaths_model"], "depth": m["mean_depth_model"], "rules_line": round(line, 2),
                  "above": m["mean_depth_model"] > line}
    return out


def sign_p(w, l):
    """One-sided sign test P(X >= w), X ~ Bin(w + l, 1/2)."""
    from math import comb
    n = w + l
    return round(sum(comb(n, i) for i in range(w, n + 1)) / 2 ** n, 4) if n else 1.0


def pick_winner(res, arms):
    """Pre-committed rule: best mean diff among arms that pass promotion (else among all model arms);
    within 0.05 of the best, the arm with fewer guards wins."""
    cand = [a for a in arms if a["ckpt"]]
    passing = [a for a in cand if res["vs_rules"][a["name"]]["all"]["promote"]] or cand
    md = lambda a: res["vs_rules"][a["name"]]["all"]["mean_diff"]  # noqa: E731
    best = max(md(a) for a in passing)
    close = [a for a in passing if md(a) >= best - 0.05]
    return min(close, key=lambda a: (len([g for g in a["guard"].split(",") if g]), -md(a)))["name"]


def stage_collect(run, name, deadline):
    w = run.state.get("t1_winner")
    if not w: return {"failed": "no T1 winner"}
    names = model_names([w])
    games_dir = run.d(name, "games", "x")[:-2]
    bank = run.d("bank", "x")[:-2]
    pool = D2.bank_files(run)
    rng = random.Random(name)

    def jobs():
        for i in range(100000):
            if pool and i % 5 in (1, 3): yield (600000 + i, "random", rng.choice(pool))
            else: yield (600000 + i, D.CLASSES[i % len(D.CLASSES)])

    cap, maxa = (240, 1500) if run.smoke else (1500, 30000)
    with MultiLaya(names, run.d(name, "laya.log")):
        outcomes = D.run_games(run, name, jobs(), run.slots, deadline, lambda s, c: arm_env(w, names, bank=True),
                               cap, maxa, games_dir, 4100, bank)
    gdirs = [os.path.join(games_dir, g) for g in os.listdir(games_dir)]
    ratio, n, guards = consult_stats(gdirs)
    sums = [D2.game_summary(g) for g in gdirs]
    by_type = collections.Counter(r["decision_type"] for s in sums for r in s["decisions"])
    res = {"policy": w, "games": len(outcomes), "bank_games": sum(bool(o.get("restore")) for o in outcomes),
           "errors": sum("error" in o for o in outcomes), "decisions": sum(by_type.values()), "by_type": dict(by_type),
           "consulted": ratio, "trained_type_decisions": n, "guards": guards,
           "deaths": sum(o.get("dead", False) for o in outcomes),
           "max_depth": max((o.get("max_depth", 0) for o in outcomes), default=0),
           "max_throws": max((s["throws"] for s in sums), default=0)}
    res["canary"] = D2.canary(res, [("consulted >= 0.9", ratio is not None and ratio >= 0.9),
                                    ("max_throws <= 100", res["max_throws"] <= 100),
                                    ("errors <= 10%", res["errors"] <= 0.1 * max(1, res["games"]))])
    return res


def v1_argmax_keys(label_file):
    """Keys of v1 records whose label argmax includes throw or heal (and isn't an all-tie)."""
    keys = set()
    for l in open(label_file):
        d = json.loads(l); m = d["meta"]
        p = d["gold"]["decision"]["probabilities"]
        top = max(p.values())
        arg = {k for k, v in p.items() if v >= top - 1e-9}
        if len(arg) < len(p) and arg & {"throw", "heal"}:
            keys.add((m["game_id"], m["turn"], m["decision_type"]))
    return keys


def u_from_run(r, v2):
    if r.get("dead"): return -1.0
    return 0.35 * r["hpmin"] + 0.25 * r["hp"] + 0.4 * r["xp"] - 0.3 * r["cons"] - (r.get("scarce", 0) if v2 else 0)


def v2_change_rate(labels):
    """Share of v2 labels whose argmax set differs from the same runs scored with the v1 utility."""
    def arg(m, v2):
        wins = collections.Counter()
        runs = m["runs"]
        by = {o: {x["k"]: x for x in runs.get(o, []) if x.get("fired", True)} for o in m["options"]}
        for k in m["paired_seeds"]:
            if not all(k in by[o] for o in m["options"]): continue
            us = {o: u_from_run(by[o][k], v2) for o in m["options"]}
            b = max(us.values())
            ws = [o for o in m["options"] if us[o] >= b - 1e-9]
            for o in ws: wins[o] += 1 / len(ws)
        if not wins: return None
        top = max(wins.values())
        return frozenset(o for o in m["options"] if wins[o] >= top - 1e-9)
    n = changed = 0
    for d in labels:
        a1, a2 = arg(d["meta"], False), arg(d["meta"], True)
        if a1 is None or a2 is None: continue
        n += 1; changed += a1 != a2
    return (round(changed / n, 4) if n else None), n


def run_labeller(run, name, tag, dec, ddir, out, deadline, smoke_max):
    servers = f"ovn-{name}-{tag}-r"
    D.rm_containers(servers)
    urls = []
    for i in range(run.slots):
        D.start_server(run, f"{servers}{i}", 4300 + i, {"VANILLA": "1"}, 1)
        urls.append(f"http://127.0.0.1:{4300 + i}")
    script = ["tools/rollout/run.ts", "--decisions", dec, "--dir", ddir, "--out", out, "--servers", ",".join(urls),
              "--workers", str(run.slots), "--types", D2.MODEL_TYPES, "--k", "4" if run.smoke else "8", "--k-min", "4",
              "--order", "disagree", "--utility", "v2"]
    if run.smoke: script += ["--max-records", str(smoke_max)]
    env = {"BUSHO_TMP": run.d(name, f"tmp-{tag}", "x")[:-2]}
    text, timed_out = D.run_node(run, f"ovn-{name}-{tag}-orch", script, env, max(60, int(deadline - time.time())), heap_mb=0)
    D.rm_containers(servers)
    open(run.d(name, f"orchestrator-{tag}.tail.log"), "w").write(("stopped at deadline\n" if timed_out else "") + text[-3000:])
    return [json.loads(l) for l in open(out)] if os.path.exists(out) else []


def stage_label(run, name, deadline):
    t0 = time.time()
    # pass 1 (60%): the new collection, disagreement first
    dec_new = run.d(name, "decisions-new.jsonl")
    n_new = D.merge_decisions(run, ["collectC"], dec_new)
    new = run_labeller(run, name, "new", dec_new, run.path, run.d(name, "labels-new.jsonl"),
                       t0 + 0.6 * (deadline - t0), 6)
    # pass 2 (rest): re-roll session-2 records whose v1 label favoured throw or heal
    v1_file = os.path.join(run.prior, "labelB", "labels.jsonl")
    keys = v1_argmax_keys(v1_file)
    dec_old = run.d(name, "decisions-reroll.jsonl")
    n_old = 0
    with open(dec_old, "w") as f:
        for l in open(os.path.join(run.prior, "labelB", "decisions.jsonl")):
            r = json.loads(l)
            if (r["game_id"], r["turn"], r["decision_type"]) in keys: f.write(l); n_old += 1
    old = run_labeller(run, name, "reroll", dec_old, run.prior, run.d(name, "labels-reroll.jsonl"), deadline, 6)
    v2 = new + old
    # training set: v2 labels, plus v1 labels for records that were not re-rolled
    rerolled = {(d["meta"]["game_id"], d["meta"]["turn"], d["meta"]["decision_type"]) for d in old}
    out = run.d(name, "labels.jsonl")
    kept_v1 = 0
    with open(out, "w") as f:
        for l in open(v1_file):
            m = json.loads(l)["meta"]
            if (m["game_id"], m["turn"], m["decision_type"]) not in rerolled: f.write(l); kept_v1 += 1
        for d in v2: f.write(json.dumps(d) + "\n")
    v2_file = run.d(name, "labels-v2.jsonl")
    with open(v2_file, "w") as f:
        for d in v2: f.write(json.dumps(d) + "\n")
    noise = D.run_node(run, f"ovn-{name}-noise", ["tools/rollout/noise.ts", v2_file], {}, 600, heap_mb=0)[0][-2000:] if v2 else ""
    open(run.d(name, "noise.txt"), "w").write(noise)
    agree = [float(x) for x in re.findall(r"split-half agreement=([\d.]+)%", noise)]
    runs_err = sum(sum(r["meta"].get("runs_error", {}).values()) for r in v2)
    runs_all = sum(sum(r["meta"].get("runs_fired", {}).values()) for r in v2) or 1
    ties = sum(bool(r["meta"].get("all_tie")) for r in v2)
    rate, n_cmp = v2_change_rate(v2)
    res = {"decisions_new": n_new, "decisions_reroll": n_old, "labels_new": len(new), "labels_reroll": len(old),
           "v1_kept": kept_v1, "total": kept_v1 + len(v2),
           "by_type_v2": dict(collections.Counter(r["meta"]["decision_type"] for r in v2)),
           "all_tie_v2": ties, "run_error_rate": round(runs_err / runs_all, 4), "split_half": agree,
           "v2_argmax_change_rate": rate, "v2_compared": n_cmp, "noise": noise.strip().splitlines()[-6:]}
    res["canary"] = D2.canary(res, [("v2 labels > 0", len(v2) > 0),
                                    ("split-half >= 65%", all(a >= 65 for a in agree) if agree else run.smoke),
                                    ("all-tie <= 25%", ties <= 0.25 * max(1, len(v2))),
                                    ("run errors <= 2%", runs_err <= 0.02 * runs_all),
                                    ("v2 changes argmax on >= 5%", run.smoke or (rate is not None and rate >= 0.05))])
    if not res.get("failed"): run.state["labels"] = out
    return res


def stage_train(run, name, deadline):
    res = D2.stage_train(run, name, deadline)
    run.state.pop("incumbent", None)  # driver3 picks policies by arm, not by incumbent
    return res


KINDS = {"tournament": stage_tournament, "collect": stage_collect, "label": stage_label, "train": stage_train}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--prior", required=True)
    ap.add_argument("--hours", type=float, default=20.5); ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--slots", type=int, default=13)
    a = ap.parse_args()
    run = D.Run(a.run, a.hours, a.smoke, a.slots)
    run.prior = os.path.abspath(a.prior)
    signal.signal(signal.SIGTERM, lambda *_: D.STOP.set())
    run.log(f"driver3 start (smoke={a.smoke}, slots={a.slots}); prior={run.prior}; app={D.app_dir(run)}")
    threading.Thread(target=D2.watchdog, args=(run,), daemon=True).start()
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
                run.log(f"stage {name} {status}: {json.dumps(res)[:1500]}")
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
        run.log("driver3 finished")


if __name__ == "__main__":
    main()
