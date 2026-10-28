/**
 * @file danger/record.ts
 * @brief Per-action records of what the player can see, for the learned danger model (DANGER_LOG=1).
 *
 * See docs/finetune-laya-plan.md, "Model track: a learned danger estimate". One record per busho action, taken from the
 * honest view (PLAYER_VIEW=1, as adapted by honest-view.ts) before the action is chosen, plus the final state. Labels
 * (death and HP lost over the next few player turns) are read later from the records that follow, so every turn of
 * every logged game is a training example with no rollouts.
 *
 * Only what the UI shows goes in: the sidebar numbers, status-bar grades (Poisoned, cut and stun grades, the hunger
 * word), the inventory as named, known stairs, the level feeling, and for each visible monster its name, distance,
 * health word and what recall shows (level and speed when known, blows and spells seen, "breeds explosively").
 *
 * The file is gzip, written in chunks of complete lines (concatenated gzip members), so a player killed at its wall
 * cap still leaves every chunk flushed before that.
 */

import * as fs from "node:fs";
import * as zlib from "node:zlib";

export const DANGER_RECORD_VERSION = 1;

/** Status-bar grades, as player_timed.txt (4.2.6) names them: 0 = none. */
export function cutGrade(cut: number): number {
  if (cut <= 0) return 0;
  const max = [10, 25, 50, 100, 200, 1000]; // Graze, Light Cut, Bad Cut, Nasty Cut, Severe Cut, Deep Gash, else Mortal Wound
  const i = max.findIndex(m => cut <= m);
  return i < 0 ? 7 : i + 1;
}
export function stunGrade(stun: number): number {
  return stun <= 0 ? 0 : stun <= 50 ? 1 : stun <= 150 ? 2 : 3; // Stun, Heavy Stun, Knocked Out
}
const HUNGER_GRADE: Record<string, number> = { Starving: 0, Faint: 1, Weak: 2, Hungry: 3, Fed: 4, Full: 5 };
const HEALTH_CODE: Record<string, number> = {
  unhurt: 0, undamaged: 0, "somewhat wounded": 1, "somewhat damaged": 1, wounded: 2, damaged: 2,
  "badly wounded": 3, "badly damaged": 3, "almost dead": 4, "almost destroyed": 4,
};

/** Monster flag bits in a record's monster rows. */
export const MF = { UNIQUE: 1, ASLEEP: 2, AFRAID: 4, BREEDS: 8, BREATH: 16, SUMMON: 32, NEVER_MOVES: 64 } as const;

/**
 * One visible monster: [name, distance, health code 0-4 (-1 unknown), level (null unknown), speed (null unknown),
 * flag bits (MF), average damage of the blows whose dice are known (0 none), blows seen, spells seen].
 */
export type MonsterRow = [string, number, number, number | null, number | null, number, number, number, number];

export interface DangerRecord {
  /** busho action count (1-based; the final state repeats the last count) */
  a: number;
  /** game turn (10 game turns = one player turn at normal speed) */
  t: number;
  d: number;
  dead?: 1;
  cl: number; hp: number; mhp: number; sp: number; msp: number;
  spd: number; ac: number; bl: number;
  /** expected damage of one melee blow (weapon dice as known, plus to-dam) */
  wd: number;
  th: number; li: number;
  /** [poisoned, cut grade, stun grade, confused, blind, afraid, paralyzed, slow, fast] */
  tm: number[];
  /** hunger grade, 0 Starving .. 5 Full */
  hu: number;
  /** [CLW, CSW, CCW, Phase Door, Teleportation, Flasks of oil, Word of Recall, Neutralize Poison, food, ammo] */
  inv: number[];
  /** equipped launcher's multiplier (0 none) */
  lm: number;
  /** castable now: [a healing spell, an escape spell] */
  cs: [number, number];
  /** standing on stairs: 0 no, 1 up, 2 down */
  os: number;
  /** Chebyshev distance to the nearest known [up, down] staircase (-1 none known) */
  sd: [number, number];
  /** level feeling 1 (quiet) .. 9 (omens of death); absent when the server gives none */
  fe?: number;
  /** game turns since arriving on this level */
  lt: number;
  /** visible monsters, nearest first (at most MAX_MONSTERS) */
  m: MonsterRow[];
  /** visible monsters in all, remembered ones, distance to the nearest remembered one (-1 none) */
  nv: number; nr: number; rd: number;
  /** command type of the first command sent after this state */
  act?: number;
  /** danger model predictions at this state, when DANGER_MODEL is loaded */
  pd?: Record<string, number>;
}

export interface DangerHeader {
  h: 1; v: number;
  engine: string; view: string;
  class: string; race: string;
  seed: string; rulefix: string;
  model?: string;
}

export const MAX_MONSTERS = 12;
const HEAL_SPELLS = /^(Cure Light Wounds|Cure Serious Wounds|Cure Critical Wounds|Heal|Healing|Minor Healing|Herbal Curing|Remove Hunger)$/;
const ESCAPE_SPELLS = /^(Phase Door|Teleport Self|Portal|Dimension Door|Blink)$/;
const LAUNCHER_MULT: [RegExp, number][] = [[/Sling/i, 2], [/Short Bow/i, 2], [/Long Bow/i, 3], [/Light Crossbow/i, 3], [/Heavy Crossbow/i, 4]];

function count(items: any[], pred: (i: any) => boolean): number {
  let n = 0;
  for (const i of items) if (i && pred(i)) n += i.qty ?? 1;
  return n;
}

function blowAverage(m: any): number {
  let avg = 0;
  for (const b of m.blowsSeen ?? []) {
    const d = /(\d+)d(\d+)/.exec(String(b?.dice ?? ""));
    if (d) avg += Number(d[1]) * (Number(d[2]) + 1) / 2;
  }
  return avg;
}

function monsterRow(m: any): MonsterRow {
  const spells: string[] = m.spellsSeen ?? [];
  let flags = 0;
  if (m.isUnique) flags |= MF.UNIQUE;
  if (m.asleep) flags |= MF.ASLEEP;
  if (m.afraid) flags |= MF.AFRAID;
  if (m.breeds) flags |= MF.BREEDS;
  if ((m.breathElements ?? []).length) flags |= MF.BREATH;
  if (m.hasSummon || spells.some(s => /^S_|summon/i.test(s))) flags |= MF.SUMMON;
  if (m.neverMoves) flags |= MF.NEVER_MOVES;
  // honest-view.ts fills level and speed with priors; keep them only when the view knew them
  const level = m.levelKnown === false ? null : (m.level ?? null);
  const speed = (m.sights ?? 1) > 0 ? (m.speed ?? null) : null;
  return [String(m.name ?? "?"), m.distance ?? 99, HEALTH_CODE[m.health ?? ""] ?? -1, level, speed, flags,
    blowAverage(m), (m.blowsSeen ?? []).length, spells.length];
}

/** The record for one (honest, adapted) state. lt: game turns on this level so far. */
export function dangerRecord(state: any, action: number, lt: number): DangerRecord {
  const p = state.player ?? {};
  const inv: any[] = p.inventory ?? [];
  const eq: any[] = p.equipment ?? [];
  const tm = p.timed ?? {};
  const weapon = eq.find((e: any) => e && (e.dd ?? 0) > 0 && e.tval >= 6 && e.tval <= 9);
  const wd = (weapon ? weapon.dd * (weapon.ds + 1) / 2 + (weapon.toD ?? 0) : 1.5) + (p.toD ?? 0);
  const bow = eq.find((e: any) => e && e.tval === 5);
  const lm = bow ? (LAUNCHER_MULT.find(([rx]) => rx.test(bow.name ?? ""))?.[1] ?? 2) : 0;
  const ammoTval = bow ? (/Sling/i.test(bow.name ?? "") ? 2 : /Crossbow/i.test(bow.name ?? "") ? 4 : 3) : -1;
  const named = (tval: number, name: string) => (i: any) => i.tval === tval && i.name === name;
  const sp = p.sp ?? 0;
  const castable = (rx: RegExp) => (p.spells ?? []).some((s: any) => s.learned && rx.test(s.name ?? "") && (s.mana ?? 99) <= sp) ? 1 : 0;

  let up = -1, down = -1, os = 0;
  for (const t of state.map?.tiles ?? []) {
    if (t.feat !== 5 && t.feat !== 6) continue;
    const dist = Math.max(Math.abs(t.x - p.x), Math.abs(t.y - p.y));
    if (t.feat === 5 && (up < 0 || dist < up)) up = dist;
    if (t.feat === 6 && (down < 0 || dist < down)) down = dist;
    if (dist === 0) os = t.feat === 5 ? 1 : 2;
  }
  const visible = [...(state.monsters ?? [])].sort((a: any, b: any) => (a.distance ?? 99) - (b.distance ?? 99));
  const remembered: any[] = state.rememberedMonsters ?? [];
  const rec: DangerRecord = {
    a: action, t: state.turn ?? 0, d: state.depth ?? 0,
    cl: p.level ?? 1, hp: p.hp ?? 0, mhp: p.maxHp ?? 1, sp, msp: p.maxSp ?? 0,
    spd: p.speed ?? 110, ac: p.ac ?? 0, bl: p.numBlows ?? 1, wd: Math.round(wd * 10) / 10,
    th: p.toH ?? 0, li: p.light ?? 0,
    tm: [(tm.poisoned ?? 0) > 0 ? 1 : 0, cutGrade(tm.cut ?? 0), stunGrade(tm.stun ?? 0), (tm.confused ?? 0) > 0 ? 1 : 0,
      (tm.blind ?? 0) > 0 ? 1 : 0, (tm.afraid ?? 0) > 0 ? 1 : 0, (tm.paralyzed ?? 0) > 0 ? 1 : 0,
      (tm.slow ?? 0) > 0 ? 1 : 0, (tm.fast ?? 0) > 0 ? 1 : 0],
    hu: HUNGER_GRADE[p.hunger ?? "Fed"] ?? 4,
    inv: [
      count(inv, named(26, "Cure Light Wounds")), count(inv, named(26, "Cure Serious Wounds")),
      count(inv, named(26, "Cure Critical Wounds")), count(inv, named(25, "Phase Door")),
      count(inv, (i: any) => i.tval === 25 && /^Teleportation$|^Teleport$/.test(i.name ?? "")),
      count(inv, (i: any) => i.tval === 27), count(inv, named(25, "Word of Recall")),
      count(inv, named(26, "Neutralize Poison")), count(inv, (i: any) => i.tval === 28),
      count(inv, (i: any) => i.tval === ammoTval),
    ],
    lm, cs: [castable(HEAL_SPELLS), castable(ESCAPE_SPELLS)], os, sd: [up, down], lt,
    m: visible.slice(0, MAX_MONSTERS).map(monsterRow),
    nv: visible.length, nr: remembered.length,
    rd: remembered.reduce((best: number, m: any) => best < 0 || (m.distance ?? 99) < best ? (m.distance ?? 99) : best, -1),
  };
  if (state.dead) rec.dead = 1;
  if (typeof state.levelFeeling === "number") rec.fe = state.levelFeeling;
  return rec;
}

/** Writes DangerRecords as gzip JSONL, flushing every `chunk` records and at close. */
export class DangerLogger {
  private lines: string[] = [];
  private pending: DangerRecord | null = null;
  private levelDepth = -1;
  private levelTurn = 0;
  private lastAction = 0;
  private closed = false;

  constructor(readonly path: string, header: DangerHeader, private chunk = 500) {
    fs.writeFileSync(path, ""); // a fresh file per game
    this.lines.push(JSON.stringify(header));
  }

  /** The state before action `action` (or the final state); returns the record so callers can annotate it. */
  record(state: any, action: number, predict?: (rec: DangerRecord) => Record<string, number>): DangerRecord | null {
    if (this.closed || !state?.player) return null;
    const depth = state.depth ?? 0;
    if (depth !== this.levelDepth) { this.levelDepth = depth; this.levelTurn = state.turn ?? 0; }
    const rec = dangerRecord(state, action, (state.turn ?? 0) - this.levelTurn);
    if (predict) rec.pd = predict(rec);
    this.push();
    this.pending = rec;
    this.lastAction = action;
    return rec;
  }

  /** The command sent after the latest record (only the first one counts). */
  noteCommand(type: number): void {
    if (this.pending && this.pending.act === undefined) this.pending.act = type;
  }

  /** The final state, after the loop. */
  finish(state: any): void {
    this.record(state, this.lastAction);
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.push();
    this.flush();
    this.closed = true;
  }

  private push(): void {
    if (!this.pending) return;
    this.lines.push(JSON.stringify(this.pending));
    this.pending = null;
    if (this.lines.length >= this.chunk) this.flush();
  }

  private flush(): void {
    if (!this.lines.length) return;
    fs.appendFileSync(this.path, zlib.gzipSync(this.lines.join("\n") + "\n"));
    this.lines = [];
  }
}

/** Reads a danger log (any number of gzip members) into its header and records. */
export function readDangerLog(path: string): { header: DangerHeader | null; records: DangerRecord[] } {
  const buf = fs.readFileSync(path);
  let text: string;
  try {
    text = zlib.gunzipSync(buf).toString("utf-8");
  } catch {
    // a player killed in the middle of a write leaves a truncated last member: keep what decompresses
    text = zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("utf-8");
  }
  let header: DangerHeader | null = null;
  const records: DangerRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; } // a torn last line from a killed player
    if (o.h === 1) header = o; else records.push(o);
  }
  return { header, records };
}
