/**
 * @file danger/features.ts
 * @brief DangerRecord → numeric feature vector, shared by the dataset builder (training) and busho (inference).
 *
 * Missing values are NaN (LightGBM routes them per split). Categorical features (monster race and its glyph class,
 * the character's class and race) are small integers from a Vocab, which the dataset's meta.json and the exported
 * model carry, so a model always featurizes with the vocabulary it was trained on. Only names go in: the race's
 * stats stay out, as the honest-view principle requires; what a name means is learned into the model's weights.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MF, type DangerRecord } from "./record.js";

export interface Vocab {
  /** monster race names (lower case) and each one's glyph class (monster_base) */
  monster: string[];
  monsterBase: string[];
  class: string[];
  race: string[];
}

const CLASSES = ["Warrior", "Mage", "Druid", "Priest", "Necromancer", "Paladin", "Rogue", "Ranger", "Blackguard"];
const RACES = ["Human", "Half-Elf", "Elf", "Hobbit", "Gnome", "Dwarf", "Half-Orc", "Half-Troll", "Dunadan", "High-Elf", "Kobold"];

/** The vocabulary from the game data (4.2.6 monster.txt order). root: the repository root. */
export function defaultVocab(root = process.cwd()): Vocab {
  const raw = JSON.parse(fs.readFileSync(path.join(root, "packages/@angband/core/gamedata/monster.json"), "utf-8"));
  const list: any[] = Array.isArray(raw) ? raw : (Object.values(raw)[0] as any[]);
  const mons = list.filter(m => m.name && m.base !== "player");
  return {
    monster: mons.map(m => String(m.name).toLowerCase()),
    monsterBase: mons.map(m => String(m.base ?? "")),
    class: CLASSES, race: RACES,
  };
}

/** Nearest visible monsters that get their own feature slots. */
export const SLOTS = 4;
const SLOT_FIELDS = ["race", "base", "dist", "health", "level", "dspeed", "unique", "asleep", "afraid", "breeds",
  "breath", "summon", "blowavg", "blows", "spells"] as const;
const INV = ["clw", "csw", "ccw", "phase", "tele", "oil", "wor", "neut", "food", "ammo"];
const TIMED = ["pois", "cut", "stun", "conf", "blind", "afraid", "para", "slow", "fast"];

/** Feature names, in vector order. */
export const FEATURE_NAMES: string[] = [
  "class", "prace", "depth", "cl", "depth_minus_cl", "hp", "mhp", "hp_frac", "sp_frac", "dspeed_p", "ac", "blows",
  "blow_dmg", "melee_turn", "to_hit", "light",
  ...TIMED, "hunger",
  ...INV, "launcher", "heal_spell", "escape_spell",
  "on_stairs", "up_dist", "down_dist", "stair_dist", "feeling", "level_turns",
  "nv", "n_adj", "n_d2", "n_d5", "n_awake_d5", "n_fast_d5", "n_unique", "n_breeds", "n_breath", "n_summon",
  "max_level_minus_cl", "sum_level_d5", "near_dist", "near_health", "hand_two", "hand_adj", "nr", "rd",
  ...Array.from({ length: SLOTS }, (_, k) => SLOT_FIELDS.map(f => `m${k}_${f}`)).flat(),
];
export const CATEGORICAL: string[] = ["class", "prace", ...Array.from({ length: SLOTS }, (_, k) => [`m${k}_race`, `m${k}_base`]).flat()];

/**
 * The rules' kind of estimate, from the view only (busho's lethalWithinTwo): melee damage the visible monsters could
 * do over the next `turns` player turns, from seen blow dice or a prior of the monster's level (unknown: the dungeon
 * level), hit chance 0.7, scaled by relative speed, less the turns needed to close in. Never-moving monsters count
 * only when adjacent.
 */
export function handDamage(rec: DangerRecord, turns: number, maxDist: number): number {
  let dmg = 0;
  const pspd = rec.spd;
  for (const [, dist, , level, speed, flags, blowAvg] of rec.m) {
    if (dist > maxDist || (dist > 1 && flags & MF.NEVER_MOVES)) continue;
    const ratio = Math.max(0.5, ((speed ?? 110) - 100) / Math.max(5, pspd - 100));
    const attacks = Math.max(0, turns * ratio - Math.max(0, dist - 1));
    dmg += (blowAvg > 0 ? blowAvg : Math.max(1, level ?? rec.d)) * 0.7 * attacks;
  }
  return dmg;
}

export class Featurizer {
  readonly names = FEATURE_NAMES;
  readonly categorical = CATEGORICAL;
  private monIdx = new Map<string, number>();
  private baseIdx = new Map<string, number>();
  private monBase: number[] = [];
  private classIdx: Map<string, number>;
  private raceIdx: Map<string, number>;

  constructor(readonly vocab: Vocab) {
    const bases = [...new Set(vocab.monsterBase)].sort();
    bases.forEach((b, i) => this.baseIdx.set(b, i));
    vocab.monster.forEach((n, i) => { this.monIdx.set(n, i); this.monBase.push(this.baseIdx.get(vocab.monsterBase[i]!) ?? NaN); });
    this.classIdx = new Map(vocab.class.map((c, i) => [c, i]));
    this.raceIdx = new Map(vocab.race.map((r, i) => [r, i]));
  }

  /** One record's features. character: the log header's class and race. */
  featurize(rec: DangerRecord, character: { class: string; race: string }, out = new Float64Array(FEATURE_NAMES.length)): Float64Array {
    let i = 0;
    const put = (v: number) => { out[i++] = v; };
    const nan = (v: number | null | undefined, none = -1) => (v == null || v === none ? NaN : v);
    put(this.classIdx.get(character.class) ?? NaN);
    put(this.raceIdx.get(character.race) ?? NaN);
    put(rec.d); put(rec.cl); put(rec.d - rec.cl); put(rec.hp); put(rec.mhp); put(rec.mhp > 0 ? rec.hp / rec.mhp : NaN);
    put(rec.msp > 0 ? rec.sp / rec.msp : NaN); put(rec.spd - 110); put(rec.ac); put(rec.bl); put(rec.wd);
    put(rec.bl * rec.wd); put(rec.th); put(rec.li);
    for (let k = 0; k < TIMED.length; k++) put(rec.tm[k] ?? 0);
    put(rec.hu);
    for (let k = 0; k < INV.length; k++) put(rec.inv[k] ?? 0);
    put(rec.lm); put(rec.cs[0]); put(rec.cs[1]);
    put(rec.os); put(nan(rec.sd[0])); put(nan(rec.sd[1]));
    const sds = rec.sd.filter(x => x >= 0);
    put(sds.length ? Math.min(...sds) : NaN);
    put(nan(rec.fe, 0)); put(rec.lt / 10);

    // visible monsters together
    let adj = 0, d2 = 0, d5 = 0, awake5 = 0, fast5 = 0, uniq = 0, breeds = 0, breath = 0, summon = 0, sumLevel5 = 0;
    let maxLevel = NaN;
    for (const [, dist, , level, speed, flags] of rec.m) {
      if (dist <= 1) adj++;
      if (dist <= 2) d2++;
      if (dist <= 5) {
        d5++;
        if (!(flags & MF.ASLEEP)) awake5++;
        if ((speed ?? 110) > rec.spd) fast5++;
        sumLevel5 += level ?? rec.d;
      }
      if (flags & MF.UNIQUE) uniq++;
      if (flags & MF.BREEDS) breeds++;
      if (flags & MF.BREATH) breath++;
      if (flags & MF.SUMMON) summon++;
      if (level != null && !(level <= maxLevel)) maxLevel = level;
    }
    const near = rec.m[0];
    put(rec.nv); put(adj); put(d2); put(d5); put(awake5); put(fast5); put(uniq); put(breeds); put(breath); put(summon);
    put(maxLevel - rec.cl); put(sumLevel5); put(near ? near[1] : NaN); put(near ? nan(near[2]) : NaN);
    const hp = Math.max(1, rec.hp);
    put(handDamage(rec, 2, 8) / hp); put(handDamage(rec, 1, 1) / hp);
    put(rec.nr); put(nan(rec.rd));

    // the nearest SLOTS monsters, one by one
    for (let k = 0; k < SLOTS; k++) {
      const m = rec.m[k];
      if (!m) { for (let f = 0; f < SLOT_FIELDS.length; f++) put(NaN); continue; }
      const [name, dist, health, level, speed, flags, blowAvg, blows, spells] = m;
      const r = this.monIdx.get(name.toLowerCase());
      put(r ?? NaN); put(r === undefined ? NaN : this.monBase[r]!);
      put(dist); put(nan(health)); put(level ?? NaN); put(speed == null ? NaN : speed - rec.spd);
      put(flags & MF.UNIQUE ? 1 : 0); put(flags & MF.ASLEEP ? 1 : 0); put(flags & MF.AFRAID ? 1 : 0);
      put(flags & MF.BREEDS ? 1 : 0); put(flags & MF.BREATH ? 1 : 0); put(flags & MF.SUMMON ? 1 : 0);
      put(blowAvg); put(blows); put(spells);
    }
    if (i !== FEATURE_NAMES.length) throw new Error(`featurize wrote ${i} of ${FEATURE_NAMES.length} features`);
    return out;
  }
}
