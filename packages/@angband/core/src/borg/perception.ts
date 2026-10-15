/**
 * @file borg/perception.ts
 * @brief What the player could know from the UI: the AI server's "view=player" layer.
 *
 * The plain /state is omniscient (whole map, every monster, race data). This module keeps the
 * knowledge a human player would have and renders /state from it instead:
 *   - map memory: squares the player has SEEN (or that mapping effects MARKed), per level;
 *   - monsters: visible now (in view and lit, warm-blooded within infravision, invisible only
 *     with See Invisible, or by telepathy), plus a per-level memory of monsters seen alive
 *     ("you saw a live X recently on this level") until the player sees them die;
 *   - monster health as the look command's words, never exact HP;
 *   - lore that starts empty per character and grows only from what the player observes:
 *     sightings, melee blows and spells in the message log, and kills;
 *   - food as the status-bar word.
 *
 * Learning thresholds follow monster/lore.ts (itself an approximation of mon-lore.c).
 * Not yet covered: detection effects, mimics, item rune/flavour knowledge.
 */

import type { GameState, GameMessage } from "../game/state.js";
import type { Monster, MonsterRace } from "../types/monster.js";
import { MonsterRaceFlag, MonsterTimedEffect } from "../types/monster.js";
import { SquareFlag } from "../types/cave.js";
import { ObjectFlag } from "../types/object.js";
import { TimedEffect } from "../types/player.js";
import { PY_FOOD_STARVE, PY_FOOD_FAINT, PY_FOOD_WEAK, PY_FOOD_HUNGRY, PY_FOOD_FULL } from "../player/timed.js";

// Indexed by BlowMethod / BlowEffect (types/monster.ts)
const METHOD_NAMES = ["NONE", "HIT", "TOUCH", "PUNCH", "KICK", "CLAW", "BITE", "STING", "BUTT", "CRUSH", "ENGULF",
  "CRAWL", "DROOL", "SPIT", "GAZE", "WAIL", "SPORE", "BEG", "INSULT", "MOAN"];
const METHOD_DESC = ["", "hits", "touches", "punches", "kicks", "claws", "bites", "stings", "butts", "crushes", "engulfs",
  "crawls on", "drools on", "spits on", "gazes at", "wails at", "releases spores at", "begs", "insults", "moans"];
const EFFECT_NAMES = ["NONE", "HURT", "POISON", "DISENCHANT", "DRAIN_CHARGES", "EAT_GOLD", "EAT_ITEM", "EAT_FOOD",
  "EAT_LIGHT", "ACID", "ELEC", "FIRE", "COLD", "BLIND", "CONFUSE", "TERRIFY", "PARALYZE", "LOSE_STR", "LOSE_INT",
  "LOSE_WIS", "LOSE_DEX", "LOSE_CON", "LOSE_ALL", "SHATTER", "EXP_10", "EXP_20", "EXP_40", "EXP_80", "HALLU",
  "BLACK_BREATH"];

/** Racial kinds learned after 10 sightings, as in monster/lore.ts. */
const KIND_FLAGS: [MonsterRaceFlag, string][] = [
  [MonsterRaceFlag.EVIL, "evil"], [MonsterRaceFlag.UNDEAD, "undead"], [MonsterRaceFlag.DRAGON, "dragon"],
  [MonsterRaceFlag.DEMON, "demon"], [MonsterRaceFlag.ANIMAL, "animal"], [MonsterRaceFlag.ORC, "orc"],
  [MonsterRaceFlag.TROLL, "troll"], [MonsterRaceFlag.GIANT, "giant"],
];

interface Lore {
  sights: number;
  kills: number;
  /** Times each blow slot was seen to hit. */
  blowSeen: number[];
  /** Spell names seen cast ("breathe fire", "confuse", ...). */
  spells: string[];
}

interface Remembered {
  ridx: number;
  name: string;
  x: number;
  y: number;
  lastSeen: number;
  visible: boolean;
}

export interface PerceptionData {
  v: 1;
  lore: Record<string, Lore>;
  depth: number;
  /** Remembered squares as [key, feat, hasObj] with key = y * width + x. */
  map: [number, number, number][];
  monsters: Record<string, Remembered>;
}

export function healthWords(hp: number, maxhp: number, living: boolean): string {
  const perc = maxhp > 0 ? Math.floor((100 * Math.max(0, hp)) / maxhp) : 0;
  if (hp >= maxhp) return living ? "unhurt" : "undamaged";
  if (perc >= 60) return living ? "somewhat wounded" : "somewhat damaged";
  if (perc >= 25) return living ? "wounded" : "damaged";
  if (perc >= 10) return living ? "badly wounded" : "badly damaged";
  return living ? "almost dead" : "almost destroyed";
}

export function hungerWord(food: number): string {
  if (food <= PY_FOOD_STARVE) return "Starving";
  if (food <= PY_FOOD_FAINT) return "Faint";
  if (food <= PY_FOOD_WEAK) return "Weak";
  if (food <= PY_FOOD_HUNGRY) return "Hungry";
  if (food <= PY_FOOD_FULL) return "Fed";
  return "Full";
}

export class Perception {
  private lore = new Map<number, Lore>();
  private chunkRef: unknown = null;
  private depth = -1;
  private map = new Map<number, [number, boolean]>();
  private monsters = new Map<number, Remembered>();
  private lastMsg: GameMessage | null = null;
  private races: readonly MonsterRace[] = [];
  private raceByName = new Map<string, MonsterRace>();
  private raceById = new Map<number, MonsterRace>();
  private updates = 0;

  /** Fold the current game state into what the player knows. Safe to call more than once per turn. */
  update(state: GameState): void {
    const chunk = state.chunk;
    let full = this.updates++ % 200 === 0; // mapping effects MARK squares anywhere: sweep the whole level now and then
    if (chunk !== this.chunkRef) {
      // A new level (or the first look at one): map and monster memory start over
      if (this.chunkRef !== null || this.depth !== state.depth) { this.map.clear(); this.monsters.clear(); }
      this.chunkRef = chunk;
      this.depth = state.depth;
      full = true;
    }
    this.indexRaces(state);
    const p = state.player;

    // Map memory. SEEN is only ever set within the view radius (20), so a window around the
    // player suffices on most calls; this runs every game turn (see AIServer), so runs and
    // other multi-step commands are remembered square by square.
    const R = 21;
    const y0 = full ? 0 : Math.max(0, p.grid.y - R), y1 = full ? chunk.height - 1 : Math.min(chunk.height - 1, p.grid.y + R);
    const x0 = full ? 0 : Math.max(0, p.grid.x - R), x1 = full ? chunk.width - 1 : Math.min(chunk.width - 1, p.grid.x + R);
    for (let y = y0; y <= y1; y++) {
      const row = chunk.squares[y];
      if (!row) continue;
      for (let x = x0; x <= x1; x++) {
        const sq = row[x];
        if (!sq || sq.feat === 0) continue;
        if (sq.info.has(SquareFlag.SEEN)) this.map.set(y * chunk.width + x, [sq.feat, sq.obj != null]);
        else if (sq.info.has(SquareFlag.MARK) && !this.map.has(y * chunk.width + x)) this.map.set(y * chunk.width + x, [sq.feat, false]);
      }
    }

    // Messages since the last update: blows, spells and kills by monsters the player can see
    const fresh = this.freshMessages(state);
    const killed = new Set<string>();
    let someKill = false; // "You have slain the monster!", "The monster is destroyed!" (throws, spells)
    for (const m of fresh) {
      const text = m.text ?? String(m);
      const slain = /^You have (?:slain|destroyed) the (.+?)!$/.exec(text);
      if (slain) { if (slain[1] === "monster") someKill = true; else killed.add(slain[1]!); continue; }
      if (/^The monster (?:is destroyed|dies)/.test(text)) { someKill = true; continue; }
      const race = this.raceAtStart(text);
      if (!race || !this.raceVisible(state, race)) continue;
      const rest = text.slice(race.name.length + 1);
      const cast = /^casts (.+)\.$/.exec(rest);
      if (cast) {
        const l = this.loreOf(race);
        if (!l.spells.includes(cast[1]!)) l.spells.push(cast[1]!);
        continue;
      }
      // A landed blow names its method; credit the first slot with that method
      for (let i = 0; i < race.blows.length; i++) {
        const desc = METHOD_DESC[race.blows[i]!.method as number];
        if (desc && rest === `${desc} you.`) { this.loreOf(race).blowSeen[i]!++; break; }
      }
    }

    // Monster sightings and memory
    const seeInvis = p.state?.flags?.has(ObjectFlag.SEE_INVIS) || (p.timed[TimedEffect.SINVIS] ?? 0) > 0;
    const esp = p.state?.flags?.has(ObjectFlag.TELEPATHY) || (p.timed[TimedEffect.TELEPATHY] ?? 0) > 0;
    const blind = (p.timed[TimedEffect.BLIND] ?? 0) > 0;
    const seen = new Set<number>();
    for (const mon of chunk.monsters ?? []) {
      if (!mon || mon.hp <= 0) continue;
      if (!this.monsterVisible(state, mon, seeInvis, esp, blind)) continue;
      seen.add(mon.midx);
      const race = mon.originalRace ?? mon.race;
      const prev = this.monsters.get(mon.midx);
      if (!prev || !prev.visible || prev.ridx !== race.ridx) this.loreOf(race).sights++;
      this.monsters.set(mon.midx, { ridx: race.ridx, name: race.name, x: mon.grid.x, y: mon.grid.y, lastSeen: state.turn, visible: true });
    }
    for (const [midx, r] of this.monsters) {
      const live = chunk.monsters?.[midx];
      const same = live && live.hp > 0 && (live.originalRace ?? live.race).ridx === r.ridx;
      if (!same && (r.visible || killed.has(r.name))) {
        // Seen to die (or vanish while in view): forget it, and credit a kill if the log says so
        if (killed.has(r.name) || (someKill && r.visible)) {
          this.loreOf(this.raceById.get(r.ridx)!).kills++;
          if (killed.has(r.name)) killed.delete(r.name); else someKill = false;
        }
        this.monsters.delete(midx);
        continue;
      }
      if (!seen.has(midx)) r.visible = false;
    }
  }

  /** The player's view of /state: same schema as serializeState, filtered to what the UI shows. */
  render(full: any, state: GameState): any {
    const p = state.player;
    const width = state.chunk.width;
    const tiles = full.map.tiles.filter((t: any) => this.map.has(t.y * width + t.x)).map((t: any) => {
      const [feat, obj] = this.map.get(t.y * width + t.x)!;
      return { ...t, feat, hasObj: obj, mon: 0 };
    });
    const monsters: any[] = [];
    for (const [midx, r] of this.monsters) {
      const race = this.raceById.get(r.ridx);
      if (!race) continue;
      const live = r.visible ? state.chunk.monsters?.[midx] : null;
      const at = live ? live.grid : { x: r.x, y: r.y };
      const distance = Math.max(Math.abs(at.x - p.grid.x), Math.abs(at.y - p.grid.y));
      if (live) {
        const t = tiles.find((q: any) => q.x === at.x && q.y === at.y);
        if (t) t.mon = midx;
      }
      monsters.push({
        midx, name: race.name, x: at.x, y: at.y, distance,
        visible: r.visible,
        turnsAgo: r.visible ? 0 : state.turn - r.lastSeen,
        health: live ? healthWords(live.hp, live.maxhp, !race.flags.has(MonsterRaceFlag.UNDEAD) && !race.flags.has(MonsterRaceFlag.NONLIVING)) : null,
        asleep: live ? (live.mTimed[MonsterTimedEffect.SLEEP] ?? 0) > 0 : null,
        afraid: live ? (live.mTimed[MonsterTimedEffect.FEAR] ?? 0) > 0 : null,
        ...this.recall(race),
      });
    }
    monsters.sort((a, b) => Number(b.visible) - Number(a.visible) || a.distance - b.distance);
    const { food, ...timed } = full.player.timed;
    return {
      ...full,
      view: "player",
      player: { ...full.player, timed, hunger: hungerWord(food) },
      map: { ...full.map, tiles },
      monsters,
      messages: this.scrubMessages(full.messages, state),
    };
  }

  /** What monster recall shows for a race, given this character's lore. Unknown fields are null. */
  recall(race: MonsterRace): Record<string, unknown> {
    const l = this.lore.get(race.ridx);
    const sights = l?.sights ?? 0, kills = l?.kills ?? 0;
    const spells = l?.spells ?? [];
    const blows = race.blows.map((b, i) => ({ b, n: l?.blowSeen[i] ?? 0 })).filter(({ n }) => n > 0)
      .map(({ b, n }) => ({
        method: METHOD_NAMES[b.method as number] ?? "?",
        effect: EFFECT_NAMES[b.effect as number] ?? "?",
        dice: n >= 10 ? `${b.dice.dice}d${b.dice.sides}` : null,
      }));
    return {
      sights, kills,
      isUnique: race.flags.has(MonsterRaceFlag.UNIQUE),
      speed: sights > 0 ? race.speed : null,
      level: kills > 0 ? race.level : null,
      kinds: sights >= 10 ? KIND_FLAGS.filter(([f]) => race.flags.has(f)).map(([, n]) => n) : null,
      neverMoves: sights >= 5 ? race.flags.has(MonsterRaceFlag.NEVER_MOVE) : null,
      hurtByLight: kills > 0 ? race.flags.has(MonsterRaceFlag.HURT_LIGHT) : null,
      blowsSeen: blows,
      spellsSeen: spells,
      breathElements: spells.filter(s => s.startsWith("breathe ")).map(s => s.slice(8).toUpperCase()),
      hasSummon: spells.some(s => s.includes("summon")),
    };
  }

  toJSON(state: GameState): PerceptionData {
    const lore: Record<string, Lore> = {};
    for (const [k, v] of this.lore) lore[k] = v;
    const monsters: Record<string, Remembered> = {};
    for (const [k, v] of this.monsters) monsters[k] = v;
    return { v: 1, lore, depth: state.depth, map: [...this.map].map(([k, [f, o]]) => [k, f, o ? 1 : 0]), monsters };
  }

  /** Restore after /restore. Without saved data (e.g. older bank snapshots) everything starts empty. */
  load(data: PerceptionData | undefined, state: GameState): void {
    this.lore.clear(); this.map.clear(); this.monsters.clear();
    this.chunkRef = state.chunk; this.depth = state.depth;
    this.lastMsg = state.messages.length ? state.messages[state.messages.length - 1]! : null;
    if (!data || data.v !== 1) return;
    for (const [k, v] of Object.entries(data.lore)) this.lore.set(Number(k), v);
    if (data.depth === state.depth) {
      for (const [k, f, o] of data.map) this.map.set(k, [f, o === 1]);
      for (const [k, v] of Object.entries(data.monsters)) this.monsters.set(Number(k), v);
    }
  }

  // ── internals ──

  private indexRaces(state: GameState): void {
    const races = (state as unknown as { monsterRaces?: readonly MonsterRace[] }).monsterRaces ?? [];
    if (races === this.races) return;
    this.races = races;
    this.raceByName.clear(); this.raceById.clear();
    for (const r of races) if (r?.name) { this.raceByName.set(r.name, r); this.raceById.set(r.ridx as number, r); }
  }

  private loreOf(race: MonsterRace): Lore {
    let l = this.lore.get(race.ridx);
    if (!l) { l = { sights: 0, kills: 0, blowSeen: race.blows.map(() => 0), spells: [] }; this.lore.set(race.ridx, l); }
    return l;
  }

  private freshMessages(state: GameState): GameMessage[] {
    const msgs = state.messages;
    let i = msgs.length;
    if (this.lastMsg) {
      while (i > 0 && msgs[i - 1] !== this.lastMsg) i--;
      if (i === 0) i = Math.max(0, msgs.length - 50); // ring buffer moved past our marker
    } else {
      i = msgs.length; // first update: nothing before it was observed by this layer
    }
    this.lastMsg = msgs.length ? msgs[msgs.length - 1]! : null;
    return msgs.slice(i);
  }

  /** The longest race name that starts the message, if any. */
  private raceAtStart(text: string): MonsterRace | undefined {
    let best: MonsterRace | undefined;
    for (const [name, r] of this.raceByName) {
      if (text.startsWith(name + " ") && (!best || name.length > best.name.length)) best = r;
    }
    return best;
  }

  private raceVisible(state: GameState, race: MonsterRace): boolean {
    for (const r of this.monsters.values()) if (r.visible && r.ridx === race.ridx) return true;
    // The attacker may have just come into view this turn
    return (state.chunk.monsters ?? []).some(m => m && m.hp > 0 && m.race.ridx === race.ridx
      && Math.max(Math.abs(m.grid.x - state.player.grid.x), Math.abs(m.grid.y - state.player.grid.y)) <= 1
      && state.chunk.squares[m.grid.y]?.[m.grid.x]?.info.has(SquareFlag.SEEN));
  }

  private monsterVisible(state: GameState, mon: Monster, seeInvis: boolean, esp: boolean, blind: boolean): boolean {
    const race = mon.race;
    if (esp && !race.flags.has(MonsterRaceFlag.EMPTY_MIND) && !race.flags.has(MonsterRaceFlag.WEIRD_MIND)) return true;
    if (blind) return false;
    const sq = state.chunk.squares[mon.grid.y]?.[mon.grid.x];
    if (!sq || !sq.info.has(SquareFlag.VIEW)) return false;
    const p = state.player;
    const d = Math.max(Math.abs(mon.grid.x - p.grid.x), Math.abs(mon.grid.y - p.grid.y));
    const byLight = d <= (p.state?.curLight ?? 1) || sq.light > 0;
    const byInfra = d <= (p.state?.seeInfra ?? 0) && !race.flags.has(MonsterRaceFlag.COLD_BLOOD);
    if (!byLight && !byInfra) return false;
    return !race.flags.has(MonsterRaceFlag.INVISIBLE) || seeInvis;
  }

  /** Messages naming a monster the player can't see read "It ..." as in the UI. */
  private scrubMessages(messages: string[], state: GameState): string[] {
    return messages.map((text) => {
      const race = this.raceAtStart(text);
      if (!race || this.raceVisible(state, race)) return text;
      return "It" + text.slice(race.name.length);
    });
  }
}
