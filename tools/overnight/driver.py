#!/usr/bin/env python3
"""Unattended overnight run: collect -> label -> train -> evaluate, twice (DAgger).

See docs/finetune-laya-plan.md, "Overnight run". Resumable: stage results live in
RUN/state.json and a restart skips finished stages. `touch RUN/STOP` stops cleanly.

Usage: driver.py --run runs/overnight/<name> [--hours 18] [--smoke] [--slots 13] [--native]

--native runs game servers, players and Laya as host processes instead of containers (for when
Docker Desktop is down). It needs Node 22 on PATH or in OVN_NODE_BIN, `npm ci` in the repo, and
the pipenv environment in tools/overnight/native (or OVN_VENV_BIN pointing at its bin/).
"""
import argparse, collections, concurrent.futures as cf, gzip, hashlib, json, os, random, re, shutil
import signal, subprocess, sys, threading, time  # noqa: E401

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evaluate  # noqa: E402

GAME_IMAGE, LAYA_IMAGE = "angband-jev-game", "angband-jev-laya"
CLASSES = ["Warrior", "Rogue", "Ranger", "Paladin", "Blackguard"]
CPU_SHARES = "256"           # low weight: the user's containers win when busy
LAYA_PORT = 8010 + int(os.environ.get("OVN_PORT_OFFSET", "0"))  # see PORT_OFFSET
STOP = threading.Event()
NATIVE = os.environ.get("OVN_NATIVE") == "1"   # set by --native; inherited by train.py/evaluate.py
PROCS, PROCS_LOCK = {}, threading.Lock()       # native long-lived servers by name
# Game engine: "ts" (the TS port's ai-server.ts) or "c" (C Angband 4.2.6 with main-http.c, native only).
# C games start from a fresh user directory (empty monster lore) and load bank savepoints with --load.
ENGINE = os.environ.get("OVN_ENGINE", "ts")
# Added to every game/labeller port (4100+, 4300+), so a test run can't collide with a running session
PORT_OFFSET = int(os.environ.get("OVN_PORT_OFFSET", "0"))
C_BIN = os.environ.get("ANGBAND_C", "/home/mph/src/angband-c/build-rd/game/angband")
THROTTLED_SLOTS = 9                            # parallel games while RUN/THROTTLE exists

# Stage budgets in hours (full run). Smoke mode scales them down.
SCHEDULE = [("collect1", 1.5), ("label1", 5.0), ("train1", 1.0), ("eval1", 0.75),
            ("collect2", 1.5), ("label2", 5.0), ("train2", 1.25), ("eval2", 0.75)]
SMOKE_MINUTES = {"collect": 4, "label": 6, "train": 15, "eval": 6}


# ── utilities ──
def now(): return time.strftime("%Y-%m-%d %H:%M:%S")


class Run:
    def __init__(self, path, hours, smoke, slots):
        self.path, self.smoke, self.slots = os.path.abspath(path), smoke, slots
        os.makedirs(self.path, exist_ok=True)
        self.state_file = os.path.join(self.path, "state.json")
        self.state = json.load(open(self.state_file)) if os.path.exists(self.state_file) else {}
        self.state.setdefault("started", time.time())
        self.state.setdefault("deadline", self.state["started"] + hours * 3600)
        self.state.setdefault("stages", {})
        self.log_fh = open(os.path.join(self.path, "driver.log"), "a")
        self.save()

    def log(self, msg):
        line = f"[{now()}] {msg}"
        print(line, flush=True); self.log_fh.write(line + "\n"); self.log_fh.flush()

    def save(self):
        tmp = self.state_file + ".tmp"
        json.dump(self.state, open(tmp, "w"), indent=1); os.replace(tmp, self.state_file)

    def stopped(self):
        return STOP.is_set() or os.path.exists(os.path.join(self.path, "STOP")) or time.time() > self.state["deadline"]

    def d(self, *parts):
        p = os.path.join(self.path, *parts); os.makedirs(os.path.dirname(p), exist_ok=True); return p


def docker(*args, check=False, timeout=None):
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check, timeout=timeout)


def docker_ok():
    try: return docker("info", "--format", "{{.ServerVersion}}", timeout=15).returncode == 0
    except subprocess.TimeoutExpired: return False


def wait_for_docker(run):
    """Block until the Docker engine answers again (or the run stops). True if it came back."""
    if docker_ok(): return True
    run.log("Docker engine not responding; waiting for it to come back")
    while not run.stopped():
        time.sleep(60)
        if docker_ok():
            run.log("Docker engine is back"); time.sleep(30); return True
    return False


def rm_containers(prefix):
    if NATIVE:
        with PROCS_LOCK: names = [n for n in PROCS if n.startswith(prefix)]
        for n in names: stop_server(n)
        return
    names = docker("ps", "-a", "--format", "{{.Names}}").stdout.split()
    mine = [n for n in names if n.startswith(prefix)]
    if mine: docker("rm", "-f", *mine)


# ── native processes (--native) ──
def node_env(extra, heap_mb=1024):
    e = dict(os.environ)
    if os.environ.get("OVN_NODE_BIN"): e["PATH"] = os.environ["OVN_NODE_BIN"] + os.pathsep + e["PATH"]
    if heap_mb: e["NODE_OPTIONS"] = f"--max-old-space-size={heap_mb}"  # stands in for the containers' --memory 1g
    e.update(extra)
    return e


def kill_group(p):
    try: os.killpg(p.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError): pass
    try: p.wait(timeout=30)
    except subprocess.TimeoutExpired: pass


def stop_server(name):
    if NATIVE:
        with PROCS_LOCK: p = PROCS.pop(name, None)
        if p: kill_group(p)
    else:
        docker("rm", "-f", name)


def c_savepoint_files(udir, path):
    """Unpack a C bank savepoint (gzip JSON {turn, depth, save: {format c-savefile-1, data, lore}}) into a user dir."""
    import base64
    snap = json.load(gzip.open(path)) if path.endswith(".gz") else json.load(open(path))
    save = snap.get("save", snap)
    if save.get("format") != "c-savefile-1": raise ValueError(f"not a C savepoint: {path}")
    sav = os.path.join(udir, "restore.sav")
    with open(sav, "wb") as f: f.write(base64.b64decode(save["data"]))
    with open(os.path.join(udir, "lore.txt"), "wb") as f: f.write(base64.b64decode(save.get("lore") or ""))
    return sav


def start_c_server(run, name, port, env, seed, restore=None):
    """C Angband on 127.0.0.1:port: a new character (seeded; RACE/CLASS from env unless "random"), or a bank
    savepoint continued with a fresh seed."""
    udir = run.d("procs", name + "-user")
    shutil.rmtree(udir, ignore_errors=True); os.makedirs(udir)
    # A new character's savefile defaults to the shared lib/save/<user>, which every concurrent new game read at
    # birth and wrote (Session 6: the same seed gave different races in different arms), so new games get their own
    # save/scores/panic dirs. Not for --load: with -dsave the load silently fails and a new character is born; a
    # loaded game saves to its own --load file anyway.
    own = [] if restore else [f"-dsave={udir}", f"-dscores={udir}", f"-dpanic={udir}", "-n"]
    args = [C_BIN, "-mhttp", f"-duser={udir}"] + own + ["--", "--port", str(port), "--seed", str(seed)]
    if restore: args += ["--load", c_savepoint_files(udir, restore)]
    else:
        for k, flag in (("RACE", "--race"), ("CLASS", "--class")):
            if env.get(k) and env[k] != "random": args += [flag, env[k]]
    log = open(run.d("procs", name + ".log"), "w")
    p = subprocess.Popen(["nice", "-n", "10", *args], cwd=os.path.dirname(C_BIN), stdout=log, stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    log.close()
    with PROCS_LOCK: PROCS[name] = p
    return wait_http(f"http://127.0.0.1:{port}/health")


def start_server(run, name, port, env, seed, restore=None):
    """A game server answering on 127.0.0.1:port. True once it is healthy."""
    stop_server(name)
    if ENGINE == "c": return start_c_server(run, name, port, env, seed, restore)
    script = ["node_modules/.bin/tsx", "packages/@angband/core/src/borg/ai-server.ts"]
    if NATIVE:
        log = open(run.d("procs", name + ".log"), "w")
        p = subprocess.Popen(["nice", "-n", "10", *script, "--port", str(port), "--seed", str(seed)],
                             cwd=app_dir(run), env=node_env(env), stdout=log, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        log.close()
        with PROCS_LOCK: PROCS[name] = p
    else:
        args = ["run", "-d", "--name", name, "--cpu-shares", CPU_SHARES, "--memory", "1g", "-p", f"127.0.0.1:{port}:3000"]
        for k, v in env.items(): args += ["-e", f"{k}={v}"]
        if docker(*args, *mounts(run), GAME_IMAGE, *script, "--port", "3000", "--seed", str(seed)).returncode != 0:
            return False
    return wait_http(f"http://127.0.0.1:{port}/health")


def run_node(run, name, script, env, timeout, docker_opts=(), heap_mb=1024):
    """Run a tsx script to completion (or timeout). Returns (output, timed_out).
    docker_opts are extra `docker run` options (mounts) and are ignored natively."""
    if NATIVE:
        p = subprocess.Popen(["nice", "-n", "10", "node_modules/.bin/tsx", *script], cwd=app_dir(run),
                             env=node_env(env, heap_mb), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, text=True, errors="replace", start_new_session=True)
        try:
            return p.communicate(timeout=timeout)[0], False
        except subprocess.TimeoutExpired:
            kill_group(p)  # the whole group: tsx runs node as a child, and rollouts spawn players
            return (p.communicate()[0] or ""), True
    args = ["run", "--rm", "--name", name, "--network", "host", "--cpu-shares", CPU_SHARES, *docker_opts, *mounts(run)]
    for k, v in env.items(): args += ["-e", f"{k}={v}"]
    try:
        p = subprocess.run(["docker", *args, GAME_IMAGE, "node_modules/.bin/tsx", *script],
                           capture_output=True, text=True, errors="replace", timeout=timeout)
        return p.stdout + p.stderr, False
    except subprocess.TimeoutExpired as e:
        docker("rm", "-f", name)
        out = e.stdout or ""
        return (out.decode(errors="replace") if isinstance(out, bytes) else out), True


def wait_http(url, timeout=120):
    import urllib.request
    t0 = time.time()
    while time.time() - t0 < timeout:
        try: urllib.request.urlopen(url, timeout=5); return True
        except Exception: time.sleep(1)
    return False


def freeze_source(run):
    """Copy the code the run uses, so edits during the night can't change the experiment."""
    src = run.d("src")
    if os.path.exists(os.path.join(src, "DONE")): return src
    shutil.rmtree(src, ignore_errors=True); os.makedirs(src)
    shutil.copytree(os.path.join(REPO, "packages/@angband/core/src"), os.path.join(src, "core-src"))
    shutil.copytree(os.path.join(REPO, "tools"), os.path.join(src, "tools"),
                    ignore=shutil.ignore_patterns("__pycache__"))
    rev = subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    diff = subprocess.run(["git", "-C", REPO, "diff"], capture_output=True, text=True).stdout
    open(os.path.join(src, "GIT_HEAD"), "w").write(rev + "\n")
    open(os.path.join(src, "working-tree.diff"), "w").write(diff)
    open(os.path.join(src, "DONE"), "w").write(now())
    return src


def app_dir(run):
    """Native mode: a runnable copy of the repo layout built from the frozen source."""
    src = freeze_source(run)
    app = os.path.join(src, "app")
    if os.path.exists(os.path.join(app, "DONE")): return app
    shutil.rmtree(app, ignore_errors=True)
    core = os.path.join(app, "packages/@angband/core")
    os.makedirs(core)
    for f in ("package.json", "tsconfig.json"):
        shutil.copy(os.path.join(REPO, f), app)
        shutil.copy(os.path.join(REPO, "packages/@angband/core", f), core)
    shutil.copytree(os.path.join(REPO, "packages/@angband/core/gamedata"), os.path.join(core, "gamedata"))
    shutil.copytree(os.path.join(src, "core-src"), os.path.join(core, "src"))  # copies, not links:
    shutil.copytree(os.path.join(src, "tools"), os.path.join(app, "tools"))   # ai-server finds gamedata via __dirname
    os.symlink(os.path.join(REPO, "node_modules"), os.path.join(app, "node_modules"))
    open(os.path.join(app, "DONE"), "w").write(now())
    return app


def freeze_c(run):
    """C engine: copy the game (binary + lib) into the run and point C_BIN at the copy, so a rebuild during the
    night can't change the experiment. Records the angband-c commit and working-tree diff. Idempotent on resume."""
    global C_BIN
    dst = os.path.join(run.d("src"), "c-game")
    if not os.path.exists(os.path.join(dst, "DONE")):
        shutil.rmtree(dst, ignore_errors=True)
        tests = shutil.ignore_patterns("tests", "run-tests")
        # no leftover savefiles: every game now gets its own save dir (-dsave), and a stale lib/save/<user> once
        # leaked into births when all games shared it
        skip = lambda d, names: tests(d, names) | (set(names) if os.path.basename(d) == "save" else set())  # noqa: E731
        shutil.copytree(os.path.dirname(C_BIN), dst, ignore=skip)
        repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(C_BIN))))  # <repo>/<build>/game/angband
        rev = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        diff = subprocess.run(["git", "-C", repo, "diff"], capture_output=True, text=True).stdout
        open(os.path.join(dst, "GIT_HEAD"), "w").write(f"{rev}\n{os.path.abspath(C_BIN)}\n")
        open(os.path.join(dst, "working-tree.diff"), "w").write(diff)
        open(os.path.join(dst, "DONE"), "w").write(now())
    C_BIN = os.path.join(dst, os.path.basename(C_BIN))
    return C_BIN


def mounts(run):
    src = freeze_source(run)
    return ["-v", f"{src}/core-src:/app/packages/@angband/core/src:ro", "-v", f"{src}/tools:/app/tools:ro"]


# ── games ──
FINAL = {"maxdl": re.compile(r"最深部: DL(\d+)"), "dead": re.compile(r"死亡: はい \((.*)\)"),
         "actions": re.compile(r"行動回数: (\d+)")}


def restore_savepoint(port, path, seed):
    """Replace the server's game with a bank savepoint (gzip JSON {turn, depth, save}), reseeded."""
    import urllib.request
    snap = json.load(gzip.open(path)) if path.endswith(".gz") else json.load(open(path))
    req = urllib.request.Request(f"http://127.0.0.1:{port}/restore", json.dumps({"save": snap.get("save", snap), "seed": seed}).encode(),
                                 {"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=60).read()


def play_game(run, tag, slot, seed, cls, env, out_dir, wall_cap, max_actions, port_base=4100, bank=None, restore=None):
    """One game on its own server. Returns an outcome dict.
    env values "/data" and "/bank" name the game's output folder and the savepoint bank.
    restore: a savepoint file to continue from (reseeded with `seed`) instead of a new character."""
    port = port_base + slot + PORT_OFFSET
    srv, ply = f"ovn-{tag}-s{slot}", f"ovn-{tag}-p{slot}"
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    senv = {"VANILLA": "1", "STAT_FLOOR": "0", "RACE": "random", "CLASS": cls}
    if not start_server(run, srv, port, senv, seed, restore if ENGINE == "c" else None):
        stop_server(srv); return {"seed": seed, "class": cls, "error": "server failed to start", "restore": restore}
    if restore and ENGINE != "c":
        try: restore_savepoint(port, restore, seed)
        except Exception as e:
            stop_server(srv); return {"seed": seed, "class": cls, "error": f"restore failed: {e}", "restore": restore}
    penv = {"API": f"http://127.0.0.1:{port}", "SEED": str(seed), "MAX_ACTIONS": str(max_actions), **env}
    opts = ["--memory", "1g", "-v", f"{out_dir}:/data"] + (["-v", f"{bank}:/bank"] if bank else [])
    if NATIVE:
        paths = {"/data": out_dir, "/bank": bank}
        penv = {k: paths.get(v) or v for k, v in penv.items()}
        penv["BUSHO_TMP"] = out_dir  # replay/wisdom/report files, which a container kept in its own /tmp
    t0 = time.time()
    text, timed_out = run_node(run, ply, ["tools/busho-player.ts"], penv, wall_cap, opts)
    stop_server(srv)
    with open(os.path.join(out_dir, "player.log"), "w") as f: f.write(text)
    m = {k: rx.search(text) for k, rx in FINAL.items()}
    depths = [int(x) for x in re.findall(r"最深部更新: DL(\d+)", text)]
    return {"seed": seed, "class": cls, "seconds": round(time.time() - t0), "timed_out": timed_out, "restore": restore,
            "max_depth": int(m["maxdl"].group(1)) if m["maxdl"] else max(depths, default=0),
            "dead": bool(m["dead"]), "death_cause": m["dead"].group(1) if m["dead"] else None,
            "actions": int(m["actions"].group(1)) if m["actions"] else None}


def run_games(run, tag, jobs, slots, deadline, env_for, wall_cap, max_actions, games_dir, port_base=4100, bank=None):
    """jobs: iterable of (seed, cls). Runs until jobs are exhausted or the deadline; returns outcomes."""
    jobs, out, lock = iter(jobs), [], threading.Lock()

    def worker(slot):
        while not run.stopped() and time.time() < deadline:
            if slot >= THROTTLED_SLOTS and os.path.exists(os.path.join(run.path, "THROTTLE")):
                time.sleep(30); continue  # memory watchdog asked for fewer parallel games
            with lock:
                job = next(jobs, None)
            if job is None: return
            seed, cls, restore = (*job, None)[:3]
            cap = max(60, min(wall_cap, deadline - time.time()))
            name = f"{seed}-{cls}" + ("-bank" if restore else "")
            res = play_game(run, tag, slot, seed, cls, env_for(seed, cls),
                            os.path.join(games_dir, name), cap, max_actions, port_base, bank, restore)
            with lock: out.append(res)
            run.log(f"{tag}: game seed={seed} {cls}: {res}")

    with cf.ThreadPoolExecutor(slots) as ex:
        list(ex.map(worker, range(slots)))
    rm_containers(f"ovn-{tag}-")
    return out


# ── stages ──
def stage_collect(run, name, deadline, model_ckpt):
    rnd = 1 if name == "collect1" else 2
    games_dir = run.d(name, "games", "x")[:-2]
    bank = run.d("bank", "x")[:-2]
    base_seed = 100000 * rnd
    jobs = ((base_seed + i, CLASSES[i % len(CLASSES)]) for i in range(100000))

    def env(seed, cls):
        e = {"DECISION_LOG": "1", "DECISION_LOG_DIR": "/data", "SAVEPOINT_DIR": "/bank",
             "LLM_BACKEND": "anthropic"}  # anthropic with no key = rules only
        if model_ckpt:
            e.update({"LLM_BACKEND": "systemone", "SYSTEMONE_URL": f"http://127.0.0.1:{LAYA_PORT}",
                      "SYSTEMONE_MODEL": evaluate.NAME, "DECISION_POLICY": "model", "DECISION_TRIGGERS": "wide"})
        return e

    cap, maxa = (240, 1500) if run.smoke else (1500, 30000)
    if model_ckpt:
        with evaluate.LayaServer(model_ckpt, LAYA_PORT, "ovn-laya-collect"):
            outcomes = run_games(run, name, jobs, run.slots, deadline, env, cap, maxa, games_dir, 4100, bank)
    else:
        outcomes = run_games(run, name, jobs, run.slots, deadline, env, cap, maxa, games_dir, 4100, bank)
    n_dec = sum(sum(1 for _ in open(os.path.join(games_dir, g, "decisions.jsonl")))
                for g in os.listdir(games_dir) if os.path.exists(os.path.join(games_dir, g, "decisions.jsonl")))
    by_type = collections.Counter()
    for g in os.listdir(games_dir):
        f = os.path.join(games_dir, g, "decisions.jsonl")
        if os.path.exists(f):
            for l in open(f): by_type[json.loads(l)["decision_type"]] += 1
    return {"games": len(outcomes), "decisions": n_dec, "by_type": dict(by_type), "policy": "model" if model_ckpt else "rules",
            "deaths": sum(o.get("dead", False) for o in outcomes),
            "mean_max_depth": round(sum(o.get("max_depth", 0) for o in outcomes) / max(1, len(outcomes)), 2),
            "max_depth": max((o.get("max_depth", 0) for o in outcomes), default=0)}


def merge_decisions(run, collect_names, out_file):
    """All collected decision records in one file, snapshot paths relative to the run dir."""
    n = 0
    with open(out_file, "w") as out:
        for cname in collect_names:
            gdir = os.path.join(run.path, cname, "games")
            if not os.path.isdir(gdir): continue
            for g in sorted(os.listdir(gdir)):
                f = os.path.join(gdir, g, "decisions.jsonl")
                if not os.path.exists(f): continue
                for l in open(f):
                    r = json.loads(l)
                    if r.get("snapshot"): r["snapshot"] = os.path.join(cname, "games", g, r["snapshot"])
                    out.write(json.dumps(r) + "\n"); n += 1
    return n


def stage_label(run, name, deadline):
    rnd = name[-1]
    collects = ["collect1"] if rnd == "1" else ["collect1", "collect2"]
    dec = run.d(name, "decisions.jsonl")
    n = merge_decisions(run, collects, dec)
    out = run.d(name, "labels.jsonl")
    if rnd == "2":  # carry round-1 labels forward so re-labelling is skipped
        prev = os.path.join(run.path, "label1", "labels.jsonl")
        if os.path.exists(prev) and not os.path.exists(out): shutil.copy(prev, out)
    servers = run.slots
    tag = f"ovn-{name}-r"
    rm_containers(tag)
    urls = []
    for i in range(servers):
        port = 4300 + i
        start_server(run, f"{tag}{i}", port, {"VANILLA": "1"}, 1)
        urls.append(f"http://127.0.0.1:{port}")
    budget = max(60, int(deadline - time.time()))
    rdir = run.path if NATIVE else "/run"
    script = ["tools/rollout/run.ts", "--decisions", f"{rdir}/{name}/decisions.jsonl", "--dir", rdir,
              "--out", f"{rdir}/{name}/labels.jsonl", "--servers", ",".join(urls), "--workers", str(servers),
              "--types", "fight,tactic", "--k", "4" if run.smoke else "8", "--k-min", "4", "--order", "danger"]
    if run.smoke: script += ["--max-records", "12"]
    script += os.environ.get("OVN_LABEL_ARGS", "").split()
    env = {}
    if NATIVE:  # rollout players share the orchestrator's environment; keep their scratch files in the run
        env["BUSHO_TMP"] = run.d(name, "tmp", "x")[:-2]
    text, timed_out = run_node(run, f"ovn-{name}-orch", script, env, budget, ["-v", f"{run.path}:/run"], heap_mb=0)
    tail = "stopped at stage deadline\n" + text[-3000:] if timed_out else text[-3000:]
    rm_containers(tag)
    open(run.d(name, "orchestrator.tail.log"), "w").write(tail)
    labels = [json.loads(l) for l in open(out)] if os.path.exists(out) else []
    noise = run_node(run, f"ovn-{name}-noise", ["tools/rollout/noise.ts", f"{rdir}/{name}/labels.jsonl"], {}, 600,
                     ["-v", f"{run.path}:/run"], heap_mb=0)[0][-2000:] if labels else ""
    open(run.d(name, "noise.txt"), "w").write(noise)
    by_type = collections.Counter(r["meta"]["decision_type"] for r in labels)
    ties = collections.Counter(r["meta"]["decision_type"] for r in labels if r["meta"].get("all_tie"))
    return {"decisions_available": n, "labelled": len(labels), "by_type": dict(by_type), "all_tie": dict(ties),
            "noise": noise.strip().splitlines()[-6:]}


def split_by_game(records, frac=0.1):
    train, held = [], []
    for r in records:
        h = int(hashlib.sha1(r["meta"]["game_id"].encode()).hexdigest(), 16) % 1000
        (held if h < frac * 1000 else train).append(r)
    return train, held


def stage_train(run, name, deadline):
    rnd = name[-1]
    src = os.path.join(run.path, f"label{rnd}", "labels.jsonl")
    records = [json.loads(l) for l in open(src)] if os.path.exists(src) else []
    records = [r for r in records if not r["meta"].get("all_tie")]
    train, held = split_by_game(records)
    if len(train) < 50 or len(held) < 10:
        return {"skipped": f"too little data: {len(train)} train, {len(held)} held out"}
    d = run.d(name, "data", "x")[:-2]
    with open(os.path.join(d, "train.jsonl"), "w") as f:
        for r in train: f.write(json.dumps(r) + "\n")
    with open(os.path.join(d, "heldout.jsonl"), "w") as f:
        for r in held: f.write(json.dumps(r) + "\n")
    epochs = 1 if run.smoke else (8 if len(train) < 2000 else 5)
    cands = []
    for seed in ([0] if run.smoke else [0, 1]):
        if run.stopped() or time.time() > deadline - 600: break
        out = run.d(name, f"ckpt-s{seed}")
        rc = subprocess.run([sys.executable, "-I", os.path.join(os.path.dirname(__file__), "train.py"),
                             "--data", os.path.join(d, "train.jsonl"), "--out", out, "--epochs", str(epochs),
                             "--loss", "soft-ce", "--seed", str(seed), "--deadline", str(deadline)]).returncode
        if rc != 0 or not os.path.isdir(out + ".final"):
            run.log(f"{name}: training seed {seed} failed (rc={rc})"); continue
        m = run.d(name, f"offline-s{seed}.json")
        subprocess.run([sys.executable, "-I", os.path.join(os.path.dirname(__file__), "evaluate.py"),
                        "--heldout", os.path.join(d, "heldout.jsonl"), "--train", os.path.join(d, "train.jsonl"),
                        "--ckpt", out + ".final", "--out", m])
        if os.path.exists(m):
            cands.append((seed, out + ".final", json.load(open(m))))
    if not cands:
        return {"failed": "no checkpoint trained", "train_items": len(train), "heldout": len(held)}
    best = max(cands, key=lambda c: (c[2]["model"]["all"]["acc"], -c[2]["model"]["all"]["brier"]))
    return {"train_items": len(train), "heldout": len(held), "epochs": epochs, "best_seed": best[0],
            "ckpt": best[1], "offline": {str(c[0]): c[2] for c in cands}}


def stage_eval(run, name, deadline):
    rnd = name[-1]
    tr = run.state["stages"].get(f"train{rnd}", {}).get("result", {})
    ckpt = tr.get("ckpt")
    if not ckpt:
        return {"skipped": "no checkpoint from training"}
    n_seeds = 2 if run.smoke else int(os.environ.get("OVN_EVAL_SEEDS", "12"))
    pairs = [(900000 + 1000 * int(rnd) + i, CLASSES[i % len(CLASSES)]) for i in range(n_seeds)]
    cap, maxa = (240, 1500) if run.smoke else (1200, 25000)
    half = max(1, run.slots // 2)
    # Both arms log decisions at the same (wide) trigger points. The model arm acts on the model's
    # answers (DECISION_POLICY=model needs DECISION_LOG=1); without both, busho only consults the
    # model through the old confidence-gated hooks and mostly plays the rules.
    logged = {"DECISION_LOG": "1", "DECISION_LOG_DIR": "/data", "DECISION_TRIGGERS": "wide"}
    rules_env = lambda s, c: {"LLM_BACKEND": "anthropic", **logged}  # noqa: E731
    model_env = lambda s, c: {"LLM_BACKEND": "systemone", "SYSTEMONE_URL": f"http://127.0.0.1:{LAYA_PORT}",  # noqa: E731
                              "SYSTEMONE_MODEL": evaluate.NAME, "DECISION_POLICY": "model",
                              "DECISION_MIN_CONFIDENCE": "0", **logged}  # act on the argmax: soft-ce confidences are ~0.01-0.2
    res = {}
    with evaluate.LayaServer(ckpt, LAYA_PORT, "ovn-laya-eval"):
        with cf.ThreadPoolExecutor(2) as ex:
            fr = ex.submit(run_games, run, f"{name}-rules", list(pairs), half, deadline, rules_env, cap, maxa, run.d(name, "rules", "x")[:-2], 4100)
            fm = ex.submit(run_games, run, f"{name}-model", list(pairs), half, deadline, model_env, cap, maxa, run.d(name, "model", "x")[:-2], 4200)
            res["rules"], res["model"] = fr.result(), fm.result()
    by = {k: {(o["seed"], o["class"]): o for o in v if "error" not in o} for k, v in res.items()}
    common = sorted(set(by["rules"]) & set(by["model"]))
    better = sum(by["model"][k]["max_depth"] > by["rules"][k]["max_depth"] for k in common)
    worse = sum(by["model"][k]["max_depth"] < by["rules"][k]["max_depth"] for k in common)
    summ = lambda v: {"games": len(v), "deaths": sum(o["dead"] for o in v),  # noqa: E731
                      "mean_max_depth": round(sum(o["max_depth"] for o in v) / max(1, len(v)), 2),
                      "reached_dl5": sum(o["max_depth"] >= 5 for o in v),
                      "fang_grip_deaths": sum(bool(o["death_cause"]) and ("Fang" in o["death_cause"] or "Grip" in o["death_cause"]) for o in v)}
    out = {"paired": len(common), "model_deeper": better, "model_shallower": worse,
           "rules": summ([by["rules"][k] for k in common]), "model": summ([by["model"][k] for k in common])}
    out["promote"] = bool(common) and better >= worse and out["model"]["deaths"] <= out["rules"]["deaths"]
    if out["promote"]:
        run.state["promoted"] = ckpt
    return out


def write_report(run):
    st = run.state
    lines = [f"# Overnight run: {os.path.basename(run.path)}", "",
             f"Started {time.strftime('%Y-%m-%d %H:%M', time.localtime(st['started']))}, "
             f"deadline {time.strftime('%Y-%m-%d %H:%M', time.localtime(st['deadline']))}. "
             f"Updated {now()}.", "",
             f"Promoted checkpoint: `{st.get('promoted') or 'none yet'}`", "", "| Stage | Status | Minutes | Result |",
             "|---|---|---|---|"]
    for name, _ in SCHEDULE:
        s = st["stages"].get(name)
        if not s: lines.append(f"| {name} | pending | | |"); continue
        mins = round((s.get("ended", time.time()) - s["began"]) / 60)
        res = json.dumps(s.get("result", s.get("error", "")))[:400].replace("|", "/")
        lines.append(f"| {name} | {s['status']} | {mins} | `{res}` |")
    lines += ["", "Full results: `state.json`. Log: `driver.log`. Per-stage outputs in each stage folder."]
    open(os.path.join(run.path, "REPORT.md"), "w").write("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True); ap.add_argument("--hours", type=float, default=18)
    ap.add_argument("--smoke", action="store_true"); ap.add_argument("--slots", type=int, default=13)
    ap.add_argument("--native", action="store_true", help="host processes instead of Docker containers")
    a = ap.parse_args()
    global NATIVE
    if a.native:
        NATIVE = evaluate.NATIVE = True
        os.environ["OVN_NATIVE"] = "1"  # for train.py and evaluate.py subprocesses
    run = Run(a.run, a.hours, a.smoke, a.slots)
    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    run.log(f"driver start (smoke={a.smoke}, slots={a.slots}, native={NATIVE}); source frozen at {freeze_source(run)}")
    if NATIVE: app_dir(run)
    try:
        i = 0
        while i < len(SCHEDULE):
            name, hours = SCHEDULE[i]
            prev = run.state["stages"].get(name) or {}
            if prev.get("status") in ("done", "skipped"): i += 1; continue
            if run.stopped(): run.log("stopping: STOP file, signal or global deadline"); break
            if not NATIVE and not wait_for_docker(run): break
            budget = SMOKE_MINUTES[name[:-1]] * 60 if a.smoke else hours * 3600
            deadline = min(time.time() + budget, run.state["deadline"])
            run.state["stages"][name] = {"status": "running", "began": time.time(), "retried": prev.get("retried", False)}
            run.save(); write_report(run)
            run.log(f"stage {name} begins (budget {budget / 3600:.2f} h)")
            try:
                if name.startswith("collect"):
                    res = stage_collect(run, name, deadline, run.state.get("promoted") if name == "collect2" else None)
                elif name.startswith("label"):
                    res = stage_label(run, name, deadline)
                elif name.startswith("train"):
                    res = stage_train(run, name, deadline)
                else:
                    res = stage_eval(run, name, deadline)
                status = "skipped" if "skipped" in res else ("failed" if "failed" in res else "done")
                run.state["stages"][name].update(status=status, result=res, ended=time.time())
                run.log(f"stage {name} {status}: {json.dumps(res)[:600]}")
            except Exception as e:  # keep going: later stages may still be useful
                import traceback
                run.state["stages"][name].update(status="error", error=f"{type(e).__name__}: {e}", ended=time.time(),
                                                 trace=traceback.format_exc()[-2000:])
                run.log(f"stage {name} error: {e}")
            st = run.state["stages"][name]
            if st["status"] in ("error", "failed") and not st.get("retried") and not NATIVE and not docker_ok():
                # Docker went away mid-stage: wait for it, then rerun this stage once.
                if wait_for_docker(run):
                    run.log(f"rerunning {name} after Docker recovered")
                    st["retried"] = True; st["status"] = "pending"
                    run.save(); write_report(run)
                    continue
            run.save(); write_report(run)
            i += 1
    finally:
        rm_containers("ovn-")
        write_report(run)
        run.log("driver finished")


if __name__ == "__main__":
    main()
