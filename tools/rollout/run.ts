#!/usr/bin/env npx tsx
/**
 * @file rollout/run.ts
 * @brief Phase 2 rollout orchestrator: decision records -> Laya training JSONL (gold = rollout win shares)
 *
 * Usage (inside the game image, host network; servers from tools/rollout/pool.sh):
 *   npx tsx tools/rollout/run.ts --decisions /scratch/decisions/decisions.jsonl --out /scratch/out/train.jsonl \
 *       --servers http://127.0.0.1:3801,http://127.0.0.1:3802 [--dir <decisions dir>] [--k 8] [--types fight,tactic]
 *       [--max-records N] [--max-per-type N] [--depth-min 1] [--depth-max 5] [--horizon fight=150,tactic=50]
 *       [--workers N] [--player-cmd "node_modules/.bin/tsx tools/busho-player.ts"] [--max-wait 5] [--gamedata <dir>]
 *   Env equivalents: DECISIONS, DECISIONS_DIR, OUT, ROLLOUT_K, SERVERS, WORKERS, PLAYER_CMD ...
 * Output: --out (labelled JSONL), --unlabelled (default <out>.unlabelled.jsonl), <out>.stats.json. Re-running skips
 * records already present in either file (resume).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawn, type ChildProcess } from "node:child_process";
import { CostTable } from "./cost";
import { winShares, allTie } from "./labels";

const DEFAULT_HORIZON: Record<string, number> = { fight: 150, tactic: 50, recall: 400, descend: 2000, explore: 2000, equip: 1500 };

function argv(): Record<string, string> {
  const a = process.argv.slice(2), o: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) { const nx = a[i + 1]; if (nx === undefined || nx.startsWith("--")) o[a[i].slice(2)] = "1"; else { o[a[i].slice(2)] = nx; i++; } }
  return o;
}
const A = argv();
const opt = (name: string, env: string, def?: string) => A[name] ?? process.env[env] ?? def;

const DECISIONS = opt("decisions", "DECISIONS");
if (!DECISIONS) { console.error("--decisions required"); process.exit(1); }
const DIR = opt("dir", "DECISIONS_DIR", path.dirname(DECISIONS))!;
const OUT = opt("out", "OUT", "rollout-train.jsonl")!;
const OUT_UNL = opt("unlabelled", "OUT_UNLABELLED", OUT.replace(/\.jsonl$/, "") + ".unlabelled.jsonl")!;
const K = Number(opt("k", "ROLLOUT_K", "8"));
// Adaptive K: run K_MIN seeds first; add the rest only when the first seeds don't agree on one winner.
const K_MIN = Math.min(K, Number(opt("k-min", "ROLLOUT_K_MIN", String(K))));
// Order records by estimated danger (most dangerous first) and optionally skip trivial ones.
const ORDER = opt("order", "ROLLOUT_ORDER", "file")!;
const MIN_DANGER = Number(opt("min-danger", "ROLLOUT_MIN_DANGER", "-999"));
const SERVERS = (opt("servers", "SERVERS", "http://127.0.0.1:3801")!).split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
const WORKERS = Math.min(Number(opt("workers", "WORKERS", String(SERVERS.length))), SERVERS.length);
const TYPES = opt("types", "TYPES")?.split(",");
const MAX_RECORDS = Number(opt("max-records", "MAX_RECORDS", "0"));
const MAX_PER_TYPE = Number(opt("max-per-type", "MAX_PER_TYPE", "0"));
const DEPTH_MIN = Number(opt("depth-min", "DEPTH_MIN", "-1"));
const DEPTH_MAX = Number(opt("depth-max", "DEPTH_MAX", "9999"));
const MAX_WAIT = opt("max-wait", "ROLLOUT_MAX_WAIT", "5")!;
const PLAYER_CMD = opt("player-cmd", "PLAYER_CMD", "node_modules/.bin/tsx tools/busho-player.ts")!.split(/\s+/);
const GAMEDATA = opt("gamedata", "GAMEDATA", "packages/@angband/core/gamedata")!;
// C Angband engine: records whose snapshot is a C savefile ("c-savefile-1") are restored by starting a fresh
// C game process per run on the worker's port (--load <savefile> --seed k; ~80 ms), instead of POST /restore.
const C_BIN = opt("c-bin", "ANGBAND_C", "/home/mph/src/angband-c/build-rd/game/angband")!;
const C_TMP = opt("c-tmp", "ROLLOUT_C_TMP", path.join(path.dirname(path.resolve(OUT)), "c-rollout-tmp"))!;
const HORIZON: Record<string, number> = { ...DEFAULT_HORIZON };
for (const kv of (opt("horizon", "HORIZON", "") ?? "").split(",").filter(Boolean)) { const [t, h] = kv.split("="); HORIZON[t] = Number(h); }

const costs = new CostTable(path.join(GAMEDATA, "object.json"));
// --utility v2: also charge the share of each scarce supply used (flasks, Cure potions, Phase/teleport scrolls).
// Counts are stored per run (meta.runs[].sup = start/end), so the weights can be re-tuned offline.
const UTILITY = opt("utility", "ROLLOUT_UTILITY", "v1")!;
const SCARCE_W: Record<string, number> = { flask: 0.15, cure: 0.25, escape: 0.15 };
for (const kv of (opt("scarce-w", "ROLLOUT_SCARCE_W", "") ?? "").split(",").filter(Boolean)) { const [c, w] = kv.split("="); SCARCE_W[c] = Number(w); }
type Supply = { flask: number; cure: number; escape: number };
function supplies(inv: any[]): Supply {
  const s: Supply = { flask: 0, cure: 0, escape: 0 };
  for (const it of inv ?? []) {
    const n = String(it?.name ?? "").toLowerCase(), q = it?.qty ?? 1;
    if (it?.tval === 27) s.flask += q;
    else if (it?.tval === 26 && n.includes("cure")) s.cure += q;
    else if (it?.tval === 25 && (n.includes("phase door") || n.includes("teleport"))) s.escape += q;
  }
  return s;
}
function scarcity(a: Supply, b: Supply): number {
  let t = 0;
  for (const c of Object.keys(SCARCE_W) as (keyof Supply)[]) if (a[c] > 0) t += SCARCE_W[c] * Math.min(1, Math.max(0, a[c] - b[c]) / a[c]);
  return t;
}

interface Rec { idx: number; raw: any; type: string; options: string[]; }
interface Run {
  opt: string; k: number; fired: boolean; dead: boolean; u: number | null;
  hp_term?: number; hp_min?: number; xp_term?: number; cons_term?: number; cons_used?: number; actions?: number;
  sup0?: Supply; sup1?: Supply | null; scarce_term?: number;
  depth_end?: number; error?: string; restore_ms?: number; player_ms?: number; total_ms?: number; death_cause?: string | null;
}

function recKey(r: any): string { return `${r.game_id}|${r.turn}|${r.decision_type}`; }

/** Rough danger of a decision situation from its state text: higher = rollouts more likely to differ. */
export function danger(raw: any): number {
  const st: string = raw.state ?? "";
  const cl = Number(raw.player_level ?? 1);
  const hp = /\nHP:(\d+)\/(\d+)/.exec(st);
  const hpFrac = hp && Number(hp[2]) > 0 ? Number(hp[1]) / Number(hp[2]) : 1;
  let d = (1 - hpFrac) * 5;
  const mons = raw.decision_type === "fight"
    ? [/Target monster: [^\n]*/.exec(st)?.[0] ?? ""]
    : [/Adjacent enemies: [^\n]*/.exec(st)?.[0] ?? ""];
  for (const m of mons) {
    for (const lv of m.matchAll(/Lv(\d+)/g)) d += Math.max(-3, Number(lv[1]) - cl);
    if (m.includes("UNIQUE")) d += 5;
    for (const sp of m.matchAll(/spd(\d+)/g)) if (Number(sp[1]) >= 120) d += 3;
    if (/BREATH:|SPELL:/.test(m)) d += 2;
  }
  return Math.round(d * 10) / 10;
}

function loadRecords(): Rec[] {
  const done = new Set<string>();
  for (const f of [OUT, OUT_UNL]) if (fs.existsSync(f)) for (const l of fs.readFileSync(f, "utf-8").split("\n")) {
    if (!l.trim()) continue;
    try { const m = JSON.parse(l).meta; if (m) done.add(`${m.game_id}|${m.turn}|${m.decision_type}`); } catch { /* ignore */ }
  }
  const recs: Rec[] = [], cands: Rec[] = [];
  const perType: Record<string, number> = {};
  let skippedDone = 0;
  for (const l of fs.readFileSync(DECISIONS!, "utf-8").split("\n")) {
    if (!l.trim()) continue;
    const raw = JSON.parse(l);
    if (TYPES && !TYPES.includes(raw.decision_type)) continue;
    if (raw.depth < DEPTH_MIN || raw.depth > DEPTH_MAX) continue;
    if (!raw.snapshot) continue;
    if (done.has(recKey(raw))) { skippedDone++; continue; }
    const options = Object.keys(raw.questions?.decision?.criteria ?? {}); // never hard-code options
    if (options.length < 2) continue;
    if (danger(raw) < MIN_DANGER) continue;
    cands.push({ idx: 0, raw, type: raw.decision_type, options });
  }
  // disagree: records where the acting model chose differently from the rules come first (they are the
  // labels that change the policy), then by danger
  const disagree = (r: any) => (r.model_choice && r.rules_choice && r.model_choice !== r.rules_choice ? 1 : 0);
  if (ORDER === "danger") cands.sort((a, b) => danger(b.raw) - danger(a.raw)); // stable: file order within ties
  if (ORDER === "disagree") cands.sort((a, b) => disagree(b.raw) - disagree(a.raw) || danger(b.raw) - danger(a.raw));
  for (const c of cands) {
    if (MAX_PER_TYPE && (perType[c.type] ?? 0) >= MAX_PER_TYPE) continue;
    perType[c.type] = (perType[c.type] ?? 0) + 1;
    c.idx = recs.length; recs.push(c);
    if (MAX_RECORDS && recs.length >= MAX_RECORDS) break;
  }
  if (skippedDone) console.error(`resume: skipping ${skippedDone} already-processed records`);
  return recs;
}

// ── snapshot cache (parsed once per record, shared by the servers working on it) ──
const saveCache = new Map<number, string>();
function saveJson(rec: Rec): string {
  let s = saveCache.get(rec.idx);
  if (!s) {
    const p = path.join(DIR, rec.raw.snapshot);
    const buf = fs.readFileSync(p);
    const text = (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString("utf-8");
    const snap = JSON.parse(text);
    s = JSON.stringify(snap.save ?? snap);
    saveCache.set(rec.idx, s);
  }
  return s;
}

/** The record's snapshot as a C savefile (+ monster lore), or null for a TS snapshot. */
const cSaveCache = new Map<number, { data: Buffer; lore: Buffer } | null>();
function cSave(rec: Rec): { data: Buffer; lore: Buffer } | null {
  if (cSaveCache.has(rec.idx)) return cSaveCache.get(rec.idx)!;
  const save = JSON.parse(saveJson(rec));
  const v = save?.format === "c-savefile-1" ? { data: Buffer.from(save.data, "base64"), lore: Buffer.from(save.lore ?? "", "base64") } : null;
  cSaveCache.set(rec.idx, v);
  return v;
}

/** Start a C game on `server`'s port from the record's savefile, reseeded with k. Resolves once /health answers. */
async function startC(server: string, rec: Rec, k: number): Promise<ChildProcess> {
  const port = new URL(server).port;
  const udir = path.join(C_TMP, `w${port}`);
  fs.mkdirSync(udir, { recursive: true });
  const c = cSave(rec)!;
  const sav = path.join(udir, "rollout.sav");
  fs.writeFileSync(sav, c.data);
  fs.writeFileSync(path.join(udir, "lore.txt"), c.lore); // read at start-up: the character's monster memory
  const child = spawn(C_BIN, ["-mhttp", `-duser=${udir}`, "--", "--port", port, "--load", sav, "--seed", String(k)],
    { cwd: path.dirname(C_BIN), stdio: "ignore" });
  for (let i = 0; i < 250; i++) {
    if (child.exitCode !== null) break; // e.g. the port is taken: never fall back to whatever answers there
    try {
      const r = await fetch(`${server}/health`);
      if (r.ok && (await r.json()).engine === "c" && child.exitCode === null) return child;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  child.kill("SIGKILL");
  throw new Error(`C game did not start on ${server}`);
}

async function stopC(server: string, child: ChildProcess) {
  try { await fetch(`${server}/quit`, { method: "POST", body: "{}" }); } catch { /* already gone */ }
  if (child.exitCode === null) {
    await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function http(url: string, method: string, body?: string): Promise<any> {
  const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

function runPlayer(api: string, type: string, option: string, horizon: number, k: number): Promise<{ result: any | null; ms: number; err?: string }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(PLAYER_CMD[0], PLAYER_CMD.slice(1), {
      env: { ...process.env, API: api, ROLLOUT_FORCE: `${type}:${option}`, ROLLOUT_HORIZON: String(horizon), ROLLOUT_MAX_WAIT: MAX_WAIT, LLM_BACKEND: "anthropic",
        PLAYER_RNG_SEED: String(k) }, // the player's own random moves share seed k across options too
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), (180 + horizon / 5) * 1000);
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.split("\n").find((l) => l.startsWith("ROLLOUT_RESULT "));
      if (!line) return resolve({ result: null, ms: Date.now() - t0, err: `no ROLLOUT_RESULT; stderr: ${err.slice(-300)}` });
      try { resolve({ result: JSON.parse(line.slice("ROLLOUT_RESULT ".length)), ms: Date.now() - t0 }); }
      catch (e) { resolve({ result: null, ms: Date.now() - t0, err: String(e) }); }
    });
  });
}

function utility(res: any, s0: any, s1: any): { u: number; hp: number; hpMin: number; xp: number; cons: number; used: number; sup0: Supply; sup1: Supply | null; scarce: number } {
  const sup0 = supplies(s0.player.inventory), sup1 = s1?.player?.inventory ? supplies(s1.player.inventory) : null;
  const scarce = sup1 ? scarcity(sup0, sup1) : 0; // end inventory unknown: no scarcity charge
  const startCons = costs.consumables(s0.player.inventory);
  const endCons = costs.consumables(s1?.player?.inventory ?? []);
  const used = CostTable.used(startCons, endCons);
  const denom = (s0.player.gold ?? 0) + CostTable.total(startCons);
  const cons = denom > 0 ? Math.min(1, used / denom) : 0;
  const gain = (res.exp_end ?? 0) - (res.exp_start ?? 0);
  const toNext = res.exp_to_next_level_at_start;
  const xp = toNext > 0 ? Math.min(1, Math.max(0, gain / toNext)) : (gain > 0 ? 1 : 0);
  const hp = res.max_hp > 0 ? Math.max(0, res.hp / res.max_hp) : 0;
  const hpMin = typeof res.min_hp_frac === "number" ? Math.max(0, Math.min(hp, res.min_hp_frac)) : hp;
  if (res.dead) return { u: -1, hp, hpMin, xp, cons, used, sup0, sup1, scarce };
  // Lowest HP during the horizon measures how close a call it was; end HP alone is nearly always full.
  const u = 0.35 * hpMin + 0.25 * hp + 0.4 * xp - 0.3 * cons - (UTILITY === "v2" ? scarce : 0);
  return { u, hp, hpMin, xp, cons, used, sup0, sup1, scarce };
}

async function oneRun(server: string, rec: Rec, option: string, k: number): Promise<Run> {
  const t0 = Date.now();
  const base: Run = { opt: option, k, fired: false, dead: false, u: null };
  let cGame: ChildProcess | null = null;
  try {
    let s0: any;
    if (cSave(rec)) {
      cGame = await startC(server, rec, k);
      s0 = await http(`${server}/state`, "GET");
    } else {
      const body = `{"save":${saveJson(rec)},"seed":${k}}`;
      try { s0 = await http(`${server}/restore`, "POST", body); }
      catch { await new Promise((r) => setTimeout(r, 500)); s0 = await http(`${server}/restore`, "POST", body); }
    }
    const restoreMs = Date.now() - t0;
    const { result, ms, err } = await runPlayer(server, rec.type, option, HORIZON[rec.type] ?? 150, k);
    if (!result) return { ...base, error: err, restore_ms: restoreMs, player_ms: ms, total_ms: Date.now() - t0 };
    let s1: any = null;
    try { s1 = await http(`${server}/state`, "GET"); } catch { /* dead/closed game: end inventory unknown */ }
    const run: Run = { ...base, fired: !!result.decision_fired, dead: !!result.dead, actions: result.actions, depth_end: result.depth_end,
      death_cause: result.death_cause ?? null, restore_ms: restoreMs, player_ms: ms };
    if (run.fired) {
      const x = utility(result, s0, s1);
      Object.assign(run, { u: x.u, hp_term: x.hp, hp_min: x.hpMin, xp_term: x.xp, cons_term: x.cons, cons_used: x.used,
        sup0: x.sup0, sup1: x.sup1, scarce_term: x.scarce });
    }
    run.total_ms = Date.now() - t0;
    return run;
  } catch (e) {
    return { ...base, error: String(e), total_ms: Date.now() - t0 };
  } finally {
    if (cGame) await stopC(server, cGame);
  }
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function finish(rec: Rec, runs: Run[]): { labelled: boolean; line: any } {
  const K = Math.max(...runs.map((r) => r.k)); // seeds actually run for this record (adaptive K)
  const meta0 = {
    game_id: rec.raw.game_id, seed: rec.raw.seed, turn: rec.raw.turn, decision_type: rec.type, depth: rec.raw.depth,
    player_level: rec.raw.player_level, race: rec.raw.race, class: rec.raw.class, rules_choice: rec.raw.rules_choice, model_choice: rec.raw.model_choice ?? null, acted: rec.raw.acted ?? null,
    format_version: rec.raw.format_version, K, danger: danger(rec.raw), horizon: HORIZON[rec.type] ?? 150, options: rec.options, utility: UTILITY,
  };
  const firedBy: Record<string, number> = {}, errBy: Record<string, number> = {};
  for (const o of rec.options) {
    firedBy[o] = runs.filter((r) => r.opt === o && r.fired && r.u !== null).length;
    errBy[o] = runs.filter((r) => r.opt === o && r.error).length;
  }
  const dropped = runs.filter((r) => !r.fired).length;
  // paired seeds: fired for every option (common random numbers)
  const seeds: number[] = [];
  for (let k = 1; k <= K; k++) if (rec.options.every((o) => runs.some((r) => r.opt === o && r.k === k && r.fired && r.u !== null))) seeds.push(k);
  let reason: string | null = null;
  const weak = rec.options.filter((o) => firedBy[o] < K / 2);
  if (weak.length) reason = `decision fired in fewer than K/2 runs for option(s) ${weak.map((o) => `${o} (${firedBy[o]}/${K})`).join(", ")}`;
  else if (seeds.length < K / 2) reason = `only ${seeds.length} seeds fired for all options (need ${K / 2})`;
  const uOf = (o: string, k: number) => runs.find((r) => r.opt === o && r.k === k)!.u as number;
  const matrix: Record<string, (number | null)[]> = {};
  for (const o of rec.options) matrix[o] = Array.from({ length: K }, (_, i) => { const r = runs.find((x) => x.opt === o && x.k === i + 1); return r && r.fired && r.u !== null ? r3(r.u) : null; });
  const meta: any = { ...meta0, runs_fired: firedBy, runs_dropped: dropped, runs_error: errBy, paired_seeds: seeds };
  if (reason) {
    return { labelled: false, line: { state: rec.raw.state, questions: rec.raw.questions, meta: { ...meta, unlabelled_reason: reason, u_matrix: matrix } } };
  }
  const rows = (ks: number[]) => ks.map((k) => rec.options.map((o) => uOf(o, k)));
  const probs = (ks: number[]) => (ks.length ? winShares(rows(ks), rec.options.length) : null);
  const toObj = (p: number[] | null) => (p ? Object.fromEntries(rec.options.map((o, i) => [o, r3(p[i])])) : null);
  const p = winShares(rows(seeds), rec.options.length);
  const h1 = seeds.filter((k) => k <= K / 2), h2 = seeds.filter((k) => k > K / 2);
  meta.u_mean = Object.fromEntries(rec.options.map((o) => [o, r3(seeds.reduce((a, k) => a + uOf(o, k), 0) / seeds.length)]));
  meta.u_matrix = matrix;
  meta.all_tie = allTie(rows(seeds));
  meta.split_half = { first: toObj(probs(h1)), second: toObj(probs(h2)) };
  meta.runs = Object.fromEntries(rec.options.map((o) => [o, runs.filter((r) => r.opt === o).sort((a, b) => a.k - b.k).map((r) =>
    r.fired ? { k: r.k, dead: r.dead, hp: r3(r.hp_term ?? 0), hpmin: r3(r.hp_min ?? 0), xp: r3(r.xp_term ?? 0), cons: r3(r.cons_term ?? 0), act: r.actions, dl: r.depth_end,
      ...(r.sup0 ? { sup: [r.sup0.flask, r.sup0.cure, r.sup0.escape, ...(r.sup1 ? [r.sup1.flask, r.sup1.cure, r.sup1.escape] : [])], scarce: r3(r.scarce_term ?? 0) } : {}), ...(r.dead ? { cause: r.death_cause } : {}) }
      : { k: r.k, fired: false, ...(r.error ? { error: r.error.slice(0, 120) } : {}) })]));
  return { labelled: true, line: { state: rec.raw.state, questions: rec.raw.questions,
    gold: { decision: { probabilities: toObj(p) } }, meta } };
}

async function main() {
  const recs = loadRecords();
  const units: { rec: Rec; option: string; k: number }[] = [];
  for (const rec of recs) for (let k = 1; k <= K_MIN; k++) for (const o of rec.options) units.push({ rec, option: o, k });
  const extra: { rec: Rec; option: string; k: number }[] = []; // second-phase seeds, served first
  console.error(`${recs.length} records, ${units.length} first-phase rollouts, ${WORKERS} workers, K=${K_MIN}..${K}, order=${ORDER}`);
  const results = new Map<number, Run[]>();
  const need = new Map<number, number>(recs.map((r) => [r.idx, K_MIN * r.options.length]));
  const extended = new Set<number>();
  /** After the first K_MIN seeds: do they already agree on one winner (or all tie in every seed)? */
  const settled = (rec: Rec, runs: Run[]) => {
    const winnersBySeed: string[] = [];
    for (let k = 1; k <= K_MIN; k++) {
      const us = rec.options.map((o) => runs.find((r) => r.opt === o && r.k === k));
      if (us.some((r) => !r || !r.fired || r.u === null)) return false;
      const top = Math.max(...us.map((r) => r!.u as number));
      winnersBySeed.push(rec.options.filter((_, i) => (us[i]!.u as number) >= top - 1e-9).join("+"));
    }
    return winnersBySeed.every((w) => w === winnersBySeed[0]);
  };
  let next = 0, nLab = 0, nUnl = 0, nRuns = 0, nErr = 0;
  const t0 = Date.now();
  const all: Run[] = [];
  fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.mkdirSync(path.dirname(OUT_UNL), { recursive: true });
  const outFd = fs.openSync(OUT, "a"), unlFd = fs.openSync(OUT_UNL, "a");

  async function worker(server: string) {
    for (;;) {
      let u = extra.shift();
      if (!u) { const i = next++; if (i >= units.length) { if (K > K_MIN && [...need.values()].some((n) => n > 0)) { await new Promise((r) => setTimeout(r, 200)); next--; continue; } return; } u = units[i]; }
      const run = await oneRun(server, u.rec, u.option, u.k);
      nRuns++; if (run.error) { nErr++; if (nErr <= 5) console.error(`run error: ${run.error.slice(0, 300)}`); }
      all.push(run);
      const arr = results.get(u.rec.idx) ?? []; arr.push(run); results.set(u.rec.idx, arr);
      let left = need.get(u.rec.idx)! - 1; need.set(u.rec.idx, left);
      if (left === 0 && K > K_MIN && !extended.has(u.rec.idx) && !settled(u.rec, arr)) {
        extended.add(u.rec.idx);
        for (let k = K_MIN + 1; k <= K; k++) for (const o of u.rec.options) extra.push({ rec: u.rec, option: o, k });
        left = (K - K_MIN) * u.rec.options.length; need.set(u.rec.idx, left);
      }
      if (left === 0) {
        const { labelled, line } = finish(u.rec, arr);
        fs.writeSync(labelled ? outFd : unlFd, JSON.stringify(line) + "\n");
        if (labelled) nLab++; else nUnl++;
        saveCache.delete(u.rec.idx); cSaveCache.delete(u.rec.idx); results.delete(u.rec.idx);
        const el = (Date.now() - t0) / 1000;
        console.error(`[${((el / 60)).toFixed(1)}m] record ${u.rec.idx + 1}/${recs.length} ${u.rec.type} DL${u.rec.raw.depth} ${labelled ? "labelled " + JSON.stringify(line.gold.decision.probabilities) : "UNLABELLED " + line.meta.unlabelled_reason}  (${nRuns} runs, ${(el / nRuns).toFixed(1)} s/run wall)`);
      }
    }
  }
  await Promise.all(SERVERS.slice(0, WORKERS).map(worker));
  const el = (Date.now() - t0) / 1000;
  const ok = all.filter((r) => r.total_ms);
  const avg = (f: (r: Run) => number | undefined) => { const v = ok.map(f).filter((x): x is number => typeof x === "number"); return v.length ? r3(v.reduce((a, b) => a + b, 0) / v.length / 1000) : 0; };
  const stats = { records: recs.length, labelled: nLab, unlabelled: nUnl, rollouts: nRuns, errors: nErr, wall_s: r3(el), workers: WORKERS, K,
    avg_restore_s: avg((r) => r.restore_ms), avg_player_s: avg((r) => r.player_ms), avg_total_s: avg((r) => r.total_ms),
    wall_s_per_rollout: r3(el / Math.max(1, nRuns)), wall_s_per_labelled_record: r3(el / Math.max(1, nLab)),
    missing_cost_keys: [...costs.missing] };
  fs.writeFileSync(OUT.replace(/\.jsonl$/, "") + ".stats.json", JSON.stringify(stats, null, 1));
  console.error(JSON.stringify(stats));
}
main().catch((e) => { console.error(e); process.exit(1); });
