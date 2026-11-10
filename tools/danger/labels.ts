/**
 * @file danger/labels.ts
 * @brief Outcome labels for each record of one game, read from the records that follow it.
 *
 * Short horizon (the danger model), in player turns at normal speed (10 game turns each), counting the actions that
 * start within the window [t, t + 10W):
 *   death_W  1 if the game's fatal action starts within the window;
 *   dmg_W    HP lost in those actions (the sum of drops, so healing in between doesn't hide damage), over max HP.
 * Long horizon (a first V(state)), in busho actions as hazard.py counts them, with the stage the deepest level so far:
 *   adv_H    1 if the next stage is reached within H actions before any death;
 *   die_H    1 if the character dies within H actions before reaching the next stage.
 * A window that runs past the end of a game that ended alive (the action cap) is censored: NaN.
 */

import type { DangerRecord } from "./record.js";

export const DEATH_WINDOWS = [5, 20, 50];
export const DMG_WINDOWS = [1, 5, 20];
export const STAGE_HORIZON = 2000;
export const LABEL_NAMES: string[] = [
  ...DEATH_WINDOWS.map(w => `death_${w}`), ...DMG_WINDOWS.map(w => `dmg_${w}`),
  `adv_${STAGE_HORIZON}`, `die_${STAGE_HORIZON}`,
];

/**
 * Drops states that passed no time (shopping, inventory): of consecutive records with the same game turn, only the
 * last, the one the time-taking action started from, is kept. The final record always stays.
 */
export function timedRecords(records: DangerRecord[]): DangerRecord[] {
  const out: DangerRecord[] = [];
  for (let i = 0; i < records.length; i++) {
    const next = records[i + 1];
    if (next && next.t === records[i]!.t && !records[i]!.dead) continue;
    out.push(records[i]!);
  }
  return out;
}

/** Labels for each record (rows in LABEL_NAMES order). records: one game in order, as timedRecords leaves them. */
export function labelGame(records: DangerRecord[]): Float64Array[] {
  const n = records.length;
  const last = records[n - 1];
  const dead = !!last?.dead;
  const endT = last?.t ?? 0, endA = last?.a ?? 0;
  // the fatal action starts at the record before the dead one
  const deathT = dead && n >= 2 ? records[n - 2]!.t : dead ? endT : Infinity;
  const deathA = dead && n >= 2 ? records[n - 2]!.a : dead ? endA : Infinity;
  // drop[i]: HP lost in the action that starts at record i
  const drop = records.map((r, i) => (i + 1 < n ? Math.max(0, r.hp - Math.max(0, records[i + 1]!.hp)) : 0));
  const stage: number[] = [];
  let deepest = 0;
  for (const r of records) { deepest = Math.max(deepest, r.d); stage.push(deepest); }
  // first record of a deeper stage after each record
  const advA = new Array<number>(n).fill(Infinity);
  for (let i = n - 2; i >= 0; i--) advA[i] = stage[i + 1]! > stage[i]! ? records[i + 1]!.a : advA[i + 1]!;

  const out: Float64Array[] = [];
  for (let i = 0; i < n; i++) {
    const r = records[i]!;
    const row = new Float64Array(LABEL_NAMES.length);
    let k = 0;
    for (const w of DEATH_WINDOWS) {
      const end = r.t + 10 * w;
      row[k++] = deathT < end ? 1 : !dead && endT < end ? NaN : 0;
    }
    for (const w of DMG_WINDOWS) {
      const end = r.t + 10 * w;
      if (!dead && endT < end) { row[k++] = NaN; continue; }
      let lost = 0;
      for (let j = i; j < n - 1 && records[j]!.t < end; j++) lost += drop[j]!;
      row[k++] = lost / Math.max(1, r.mhp);
    }
    const endH = r.a + STAGE_HORIZON;
    const adv = advA[i]! < endH && advA[i]! <= deathA;
    const die = deathA < endH && deathA < advA[i]!;
    const censored = !dead && endA < endH && !adv;
    row[k++] = censored ? NaN : adv ? 1 : 0;
    row[k++] = censored ? NaN : die ? 1 : 0;
    out.push(row);
  }
  return out;
}
