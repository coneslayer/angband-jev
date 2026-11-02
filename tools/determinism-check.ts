/**
 * Determinism gate for /snapshot + /restore on the AI game server.
 *
 * Usage: npx tsx tools/determinism-check.ts [serverUrl=http://localhost:3000] [commands=1000] [warmup=300]
 *
 * Plays a deterministic mixed walk/fight/descend/rest policy, snapshots, and checks that
 * restore (no seed) + identical commands reproduces /state and the snapshot itself at
 * commands 10/100/1000; that two seed=1 runs are identical; and whether seed=1 vs seed=2 differ.
 * Exits non-zero on any mismatch.
 */

const URL_BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const K = Number(process.argv[3] ?? 1000);
const CHECKPOINTS = [10, 100, 1000].filter((n) => n <= K);

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function http(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const r = await fetch(URL_BASE + path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

// ── deep compare: returns path of first difference, or null ──
function firstDiff(a: Json, b: Json, path = "$"): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    return `${path}: ${JSON.stringify(a)?.slice(0, 80)} != ${JSON.stringify(b)?.slice(0, 80)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object mismatch`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}.length: ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) return `${path}.${k}: missing in first`;
    if (!(k in b)) return `${path}.${k}: missing in second`;
    const d = firstDiff(a[k], b[k], `${path}.${k}`); if (d) return d;
  }
  return null;
}

// ── policy: deterministic given (state, prng) ──
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// keypad directions: 1..9, y grows downward
const DIRS: Record<number, [number, number]> = {
  1: [-1, 1], 2: [0, 1], 3: [1, 1], 4: [-1, 0], 6: [1, 0], 7: [-1, -1], 8: [0, -1], 9: [1, -1],
};
const PASSABLE = new Set([1, 2, 3, 4, 5, 6, 24]); // floor, closed door (walk opens it), open door, broken, stairs, pass rubble
const CMD = { WALK: 0, ATTACK: 7, REST: 22, GO_DOWN: 25 };
const MAX_DEPTH = 3;
const WARMUP = Number(process.argv[4] ?? 300);

function pickCommand(s: Json, rnd: () => number): Json {
  const p = s.player;
  const randomWalk = () => ({ type: CMD.WALK, direction: [1, 2, 3, 4, 6, 7, 8, 9][Math.floor(rnd() * 8)] });
  const adj = s.monsters.filter((m: Json) => Math.max(Math.abs(m.x - p.x), Math.abs(m.y - p.y)) === 1);
  if (adj.length && rnd() < 0.85) {
    const m = adj[Math.floor(rnd() * adj.length)];
    return { type: CMD.ATTACK, target: { x: m.x, y: m.y } };
  }
  if (!s.monsters.length && p.hp < p.maxHp * 0.6 && rnd() < 0.7) return { type: CMD.REST, turns: 5 };
  const here = s.map.tiles.find((t: Json) => t.x === p.x && t.y === p.y);
  if (here?.feat === 6 && s.depth < MAX_DEPTH) return { type: CMD.GO_DOWN };
  if (rnd() < 0.2) return randomWalk();
  // BFS one step toward the stairs (while shallow) or the nearest monster
  const W = s.map.width;
  const feat = new Map<number, number>();
  for (const t of s.map.tiles) feat.set(t.y * W + t.x, t.feat);
  const goals = new Set<number>();
  if (s.depth < MAX_DEPTH) { for (const t of s.map.tiles) if (t.feat === 6) goals.add(t.y * W + t.x); }
  else for (const m of s.monsters) goals.add(m.y * W + m.x);
  if (goals.size) {
    const prev = new Map<number, number>([[p.y * W + p.x, -1]]);
    const q = [p.y * W + p.x];
    let goal = -1;
    for (let qi = 0; qi < q.length && goal < 0; qi++) {
      const c = q[qi]!; const cx = c % W, cy = Math.floor(c / W);
      for (const d of [1, 2, 3, 4, 6, 7, 8, 9]) {
        const nx = cx + DIRS[d]![0], ny = cy + DIRS[d]![1], n = ny * W + nx;
        if (prev.has(n) || !(PASSABLE.has(feat.get(n) ?? 0) || goals.has(n))) continue;
        prev.set(n, c); q.push(n);
        if (goals.has(n)) { goal = n; break; }
      }
    }
    if (goal >= 0) {
      let c = goal;
      while (prev.get(c) !== p.y * W + p.x && prev.get(c) !== -1) c = prev.get(c)!;
      const dx = (c % W) - p.x, dy = Math.floor(c / W) - p.y;
      const dir = Object.entries(DIRS).find(([, v]) => v[0] === dx && v[1] === dy)?.[0];
      if (dir) return { type: CMD.WALK, direction: Number(dir) };
    }
  }
  return randomWalk();
}

interface Run {
  cmds: Json[];
  states: Record<number, Json>; // command count -> /command response
  saves: Record<number, Json>; // command count -> /snapshot save
  n: number; // commands actually executed
  died: boolean;
}

/** Send commands (from `fixed`, or chosen by the policy) up to K; capture state + snapshot at checkpoints. */
async function play(start: Json, fixed: Json[] | null, polSeed: number): Promise<Run> {
  const run: Run = { cmds: [], states: {}, saves: {}, n: 0, died: false };
  const rnd = mulberry32(polSeed);
  let s = start;
  for (let i = 1; i <= K; i++) {
    const cmd = fixed ? fixed[i - 1] : pickCommand(s, rnd);
    if (!cmd) break;
    const r = await http("POST", "/command", cmd);
    if (r.status !== 200) {
      if (s.dead || r.json?.error === "Game over") { run.died = true; break; }
      throw new Error(`command ${i} failed: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    }
    s = r.json; run.cmds.push(cmd); run.n = i;
    const final = s.dead || i === K;
    if (CHECKPOINTS.includes(i) || final) {
      run.states[i] = s;
      if (!s.dead) {
        const sn = await http("GET", "/snapshot");
        if (sn.status !== 200) throw new Error(`/snapshot at ${i}: ${sn.status} ${JSON.stringify(sn.json).slice(0, 200)}`);
        run.saves[i] = sn.json.save;
      }
    }
    if (s.dead) { run.died = true; break; }
  }
  return run;
}

let failures = 0;
function check(name: string, diff: string | null): void {
  if (diff) { failures++; console.log(`FAIL  ${name}: first diff at ${diff}`); }
  else console.log(`PASS  ${name}`);
}

function compareRuns(label: string, a: Run, b: Run): void {
  check(`${label}: commands executed (${a.n} vs ${b.n})`, a.n === b.n ? null : `n: ${a.n} != ${b.n}`);
  const pts = [...new Set([...Object.keys(a.states), ...Object.keys(b.states)])].map(Number).sort((x, y) => x - y);
  for (const n of pts) {
    check(`${label}: /state at command ${n}`, firstDiff(a.states[n], b.states[n]));
    if (a.saves[n] || b.saves[n]) check(`${label}: snapshot at command ${n}`, firstDiff(a.saves[n], b.saves[n]));
  }
}

async function restore(save: Json, seed?: number): Promise<Json> {
  const r = await http("POST", "/restore", seed === undefined ? { save } : { save, seed });
  if (r.status !== 200) throw new Error(`/restore failed: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
}

async function main(): Promise<void> {
  const h = await http("GET", "/health");
  console.log(`server ${URL_BASE}: ${JSON.stringify(h.json)}`);

  // 409 when not waiting is exercised implicitly by the server; here: warm up so the snapshot is mid-game
  let s = (await http("GET", "/state")).json;
  const warm = mulberry32(777);
  for (let i = 0; i < WARMUP && !s.dead; i++) s = (await http("POST", "/command", pickCommand(s, warm))).json;
  if (s.dead) { console.log("player died during warm-up; restart the server with another --seed"); process.exit(2); }

  const snapRes = await http("GET", "/snapshot");
  if (snapRes.status !== 200) throw new Error(`/snapshot: ${snapRes.status}`);
  const snap = snapRes.json;
  const bytes = JSON.stringify(snap).length;
  console.log(`snapshot at turn ${snap.turn}, depth ${snap.depth}, ${(bytes / 1e6).toFixed(2)} MB`);
  const stateAtSnap = (await http("GET", "/state")).json;

  // Run A: play K commands from the snapshot
  const t0 = Date.now();
  const runA = await play(stateAtSnap, null, 12345);
  const attacks = runA.cmds.filter((c) => c.type === CMD.ATTACK).length;
  const fin = runA.states[runA.n];
  console.log(`run A stats: ${attacks} attack commands, exp ${stateAtSnap.player.exp} -> ${fin?.player.exp}, template diffs in final snapshot: ${Object.entries(runA.saves[runA.n]?.templates ?? {}).map(([k, v]) => `${k}:${Object.keys(v as object).length}`).join(" ") || "none"}`);
  console.log(`run A: ${runA.n} commands in ${((Date.now() - t0) / 1000).toFixed(1)}s, died=${runA.died}, final depth ${runA.states[runA.n]?.depth}, hp ${runA.states[runA.n]?.player.hp}/${runA.states[runA.n]?.player.maxHp}, lvl ${runA.states[runA.n]?.player.level}`);
  if (runA.n < K) console.log(`NOTE  player died/ended after ${runA.n} < ${K} commands; checking through command ${runA.n}`);

  // Restore (no seed): state immediately equals state at snapshot time
  const restored = await restore(snap.save);
  check("restore returns the snapshot-time /state", firstDiff(stateAtSnap, restored));
  check("snapshot -> restore -> snapshot round trip", firstDiff(snap.save, (await http("GET", "/snapshot")).json.save));

  // Replay identical commands
  const runB = await play(restored, runA.cmds, 0);
  compareRuns("restore(no seed) replay vs original", runA, runB);

  // Second restore of the same snapshot (restore is repeatable)
  await restore(snap.save);
  const runC = await play(restored, runA.cmds, 0);
  compareRuns("second restore(no seed) replay vs original", runA, runC);

  // Seeded rollouts (adaptive policy with a fixed policy seed)
  await restore(snap.save, 1);
  const s1a = await play(stateAtSnap, null, 999);
  await restore(snap.save, 1);
  const s1b = await play(stateAtSnap, null, 999);
  compareRuns("seed=1 twice", s1a, s1b);
  await restore(snap.save, 2);
  const s2 = await play(stateAtSnap, null, 999);
  const lastN = Math.min(s1a.n, s2.n);
  const dseed = firstDiff(s1a.states[lastN] ?? s1a.states[s1a.n], s2.states[lastN] ?? s2.states[s2.n]);
  console.log(`INFO  seed=1 vs seed=2 ${dseed ? "differ (expected): " + dseed : "are IDENTICAL (unexpected unless nothing random happened)"}`);
  const dseedRng = firstDiff(s1a.saves[s1a.n]?.rng, s2.saves[s2.n]?.rng);
  console.log(`INFO  seed=1 vs seed=2 RNG state ${dseedRng ? "differs" : "identical"}`);
  const dnoseed = firstDiff(runA.states[runA.n], s1a.states[s1a.n]);
  console.log(`INFO  no-seed vs seed=1 final state ${dnoseed ? "differ (expected)" : "identical"}`);

  console.log(failures ? `\nDETERMINISM CHECK FAILED (${failures} mismatches)` : "\nDETERMINISM CHECK PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
