#!/usr/bin/env npx tsx
/**
 * @file danger/build.ts
 * @brief Danger logs → a training set for tools/overnight/danger.py.
 *
 * Finds every danger.jsonl.gz under the given directories (one per game, as busho writes it with DANGER_LOG=1),
 * drops states that passed no time, featurizes each record (features.ts) and labels it from the records that follow
 * (labels.ts). Records where nothing happened (no HP lost and no death within the label windows) are subsampled:
 * quiet ones (no monster in view, no harmful status) are kept with probability --quiet-keep, the rest with
 * --calm-keep. Each kept record is weighted by the inverse of its probability, so weighted sums over the set stay
 * unbiased while it shrinks several times over; records with damage or a death are always kept. Games played from
 * the omniscient view are skipped.
 *
 * Output DIR: X.npy (float32, rows × features, NaN missing), y.npy (float32, rows × labels, NaN censored),
 * w.npy (float32 weights), g.npy (int32 game index) and meta.json (feature, categorical and label names, the
 * vocabulary, and one entry per game).
 *
 * Usage: npx tsx tools/danger/build.ts --out DIR [--quiet-keep 0.1] [--calm-keep 1] [--root REPO] GAMES_DIR...
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readDangerLog } from "./record.js";
import { Featurizer, defaultVocab, FEATURE_NAMES, CATEGORICAL } from "./features.js";
import { labelGame, timedRecords, LABEL_NAMES } from "./labels.js";

/** A .npy file written row by row; the shape is patched into the fixed-size header on close. */
export class NpyWriter {
  private fd: number;
  private rows = 0;
  private static HEADER = 128;
  constructor(readonly file: string, readonly descr: "<f4" | "<i4", readonly cols: number | null) {
    this.fd = fs.openSync(file, "w");
    fs.writeSync(this.fd, Buffer.alloc(NpyWriter.HEADER));
  }
  write(data: Float32Array | Int32Array, rows: number): void {
    fs.writeSync(this.fd, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    this.rows += rows;
  }
  close(): void {
    const shape = this.cols === null ? `(${this.rows},)` : `(${this.rows}, ${this.cols})`;
    let dict = `{'descr': '${this.descr}', 'fortran_order': False, 'shape': ${shape}, }`;
    dict = dict.padEnd(NpyWriter.HEADER - 10 - 1, " ") + "\n";
    const head = Buffer.alloc(NpyWriter.HEADER);
    head.write("\x93NUMPY", 0, "latin1");
    head[6] = 1; head[7] = 0;
    head.writeUInt16LE(dict.length, 8);
    head.write(dict, 10, "latin1");
    fs.writeSync(this.fd, head, 0, NpyWriter.HEADER, 0);
    fs.closeSync(this.fd);
  }
}

function findLogs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findLogs(p, out);
    else if (e.name === "danger.jsonl.gz") out.push(p);
  }
  return out;
}

/** A uniform number in [0, 1) from a string (FNV-1a), so subsampling is reproducible. */
function unit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h / 2 ** 32;
}

export function build(dirs: string[], out: string, quietKeep = 0.1, calmKeep = 1, root = process.cwd()): Record<string, unknown> {
  fs.mkdirSync(out, { recursive: true });
  const vocab = defaultVocab(root);
  const fz = new Featurizer(vocab);
  const F = FEATURE_NAMES.length, L = LABEL_NAMES.length;
  const X = new NpyWriter(path.join(out, "X.npy"), "<f4", F);
  const Y = new NpyWriter(path.join(out, "y.npy"), "<f4", L);
  const W = new NpyWriter(path.join(out, "w.npy"), "<f4", null);
  const G = new NpyWriter(path.join(out, "g.npy"), "<i4", null);
  const iDeath50 = LABEL_NAMES.indexOf("death_50"), iDmg20 = LABEL_NAMES.indexOf("dmg_20");
  const games: Record<string, unknown>[] = [];
  const skipped: Record<string, string> = {};
  let rows = 0, records = 0;
  const logs = dirs.flatMap(d => findLogs(d)).sort();
  for (const file of logs) {
    const id = path.relative(process.cwd(), path.dirname(file));
    let log;
    try { log = readDangerLog(file); } catch (e) { skipped[id] = `unreadable: ${e}`; continue; }
    const { header } = log;
    if (!header) { skipped[id] = "no header"; continue; }
    if (header.view !== "player") { skipped[id] = `view ${header.view}`; continue; }
    const recs = timedRecords(log.records);
    if (recs.length < 2) { skipped[id] = "fewer than 2 timed records"; continue; }
    const labels = labelGame(recs);
    const xs = new Float32Array(recs.length * F), ys = new Float32Array(recs.length * L);
    const ws = new Float32Array(recs.length), gs = new Int32Array(recs.length);
    const row = new Float64Array(F);
    let k = 0;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i]!, y = labels[i]!;
      if (r.dead) continue; // the end state itself: nothing left to predict
      const nothing = !(y[iDeath50]! > 0) && !(y[iDmg20]! > 0);
      const keep = !nothing ? 1 : r.nv === 0 && r.tm.slice(0, 8).every(v => v === 0) ? quietKeep : calmKeep;
      if (keep < 1 && unit(`${id}:${r.a}:${r.t}`) >= keep) continue;
      const w = 1 / keep;
      fz.featurize(r, header, row);
      xs.set(row, k * F); ys.set(y, k * L); ws[k] = w; gs[k] = games.length;
      k++;
    }
    X.write(xs.subarray(0, k * F), k); Y.write(ys.subarray(0, k * L), k);
    W.write(ws.subarray(0, k), k); G.write(gs.subarray(0, k), k);
    const last = recs[recs.length - 1]!;
    games.push({
      id, seed: header.seed, class: header.class, race: header.race, engine: header.engine, rulefix: header.rulefix,
      bank: /-bank$/.test(id), records: recs.length, rows: k, dead: !!last.dead, actions: last.a, max_depth: Math.max(...recs.map(r => r.d)),
    });
    rows += k; records += recs.length;
  }
  X.close(); Y.close(); W.close(); G.close();
  const meta = {
    version: 1, built: new Date().toISOString(), quiet_keep: quietKeep, calm_keep: calmKeep, records, rows,
    features: FEATURE_NAMES, categorical: CATEGORICAL, labels: LABEL_NAMES, vocab, games, skipped,
  };
  fs.writeFileSync(path.join(out, "meta.json"), JSON.stringify(meta));
  return { games: games.length, skipped: Object.keys(skipped).length, records, rows };
}

if (process.argv[1] && /build\.ts$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  let out = "", quietKeep = 0.1, calmKeep = 1, root = process.cwd();
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i]!;
    else if (args[i] === "--quiet-keep") quietKeep = Number(args[++i]);
    else if (args[i] === "--calm-keep") calmKeep = Number(args[++i]);
    else if (args[i] === "--root") root = args[++i]!;
    else dirs.push(args[i]!);
  }
  if (!out || !dirs.length || !(quietKeep > 0 && quietKeep <= 1) || !(calmKeep > 0 && calmKeep <= 1)) {
    console.error("usage: build.ts --out DIR [--quiet-keep 0.1] [--calm-keep 1] [--root REPO] GAMES_DIR...");
    process.exit(2);
  }
  console.log(JSON.stringify(build(dirs, out, quietKeep, calmKeep, root)));
}
