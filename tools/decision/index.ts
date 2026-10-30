/**
 * @file decision/index.ts
 * @brief System One 判断の共有モジュール: state文字列 + 固定の質問定義
 *
 * 推論時 (busho-player) と学習データ生成が同じ出力を使う。
 * フォーマットを変えたら DECISION_FORMAT_VERSION を上げること。
 * 質問は全て choice (noul は使わない)。可変情報は state 末尾の Situation に入れる。
 */

export const DECISION_FORMAT_VERSION = 2; // v2: fight = {melee, throw, flee}
// v3: the same questions, with the state drawn only from what the UI shows (/state?view=player)
export const DECISION_FORMAT_VERSION_PLAYER = 3;
// v4 (DECISION_ROLES=1): v3 plus the character's resources by role, spells and items alike (tools/spell-roles.ts), and
// choices worded by role rather than by item
export const DECISION_ROLES = process.env.DECISION_ROLES === "1";
export const DECISION_FORMAT_VERSION_ROLES = 4;

import { resourceLines } from "../spell-roles.js";

export type DecisionType = "fight" | "tactic" | "recall" | "descend" | "explore" | "equip";
export const DECISION_TYPES: DecisionType[] = ["fight", "tactic", "recall", "descend", "explore", "equip"];

export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export interface DecisionRequest {
  state: string;
  questions: { decision: ChoiceQuestion };
}

// 固定の質問 (オプション順も固定)
export const QUESTIONS: Record<DecisionType, ChoiceQuestion> = {
  fight: {
    type: "choice",
    instructions: "Decide how to deal with the target monster described in the Situation section, given my character, supplies and the monsters nearby.",
    criteria: {
      melee: "fight the target monster in melee",
      throw: "throw Flasks of oil at the target monster from a distance",
      flee: "avoid the target monster and escape by stairs or Phase Door",
    },
  },
  tactic: {
    type: "choice",
    instructions: "I am in melee with the adjacent enemies listed in the Situation section and my HP is not full. Decide the best action this turn.",
    criteria: {
      heal: "drink a healing potion or cast a healing spell",
      flee: "read a Teleportation scroll to get away from the enemies",
      fight: "keep attacking without healing",
    },
  },
  recall: {
    type: "choice",
    instructions: "Decide whether to read Word of Recall now to return to town for supplies, or to continue exploring the dungeon.",
    criteria: {
      recall: "read Word of Recall and return to town to restock",
      continue: "stay in the dungeon and keep going",
    },
  },
  descend: {
    type: "choice",
    instructions: "I am ready to take the stairs down according to my usual rules. Decide whether to descend to the next dungeon level or stay on this one.",
    criteria: {
      descend: "take the stairs down to the next dungeon level",
      stay: "stay on this level to gain more levels, items or supplies",
    },
  },
  explore: {
    type: "choice",
    instructions: "Decide whether to keep exploring the current level (see the Situation section for kills and time spent here) or to descend now.",
    criteria: {
      explore: "keep exploring this level for more experience and items",
      descend: "head down to the next dungeon level now",
    },
  },
  equip: {
    type: "choice",
    instructions: "I found a candidate item with a higher raw power score than my current item in the same slot. Decide whether to swap to the candidate or keep the current item.",
    criteria: {
      swap: "equip the candidate item in place of the current one",
      keep: "keep wearing the current item",
    },
  },
};

export function optionsOf(type: DecisionType): string[] {
  return Object.keys(QUESTIONS[type].criteria);
}

const ELEM_NAMES = ["ACID", "ELEC", "FIRE", "COLD", "POIS", "LIGHT", "DARK", "SOUND", "SHARD", "NEXUS", "NETHER", "CHAOS", "DISEN"];
// ObjectFlag index (ai-server serializeItemExtra) — 名前が分かるものだけ
const FLAG_NAMES: Record<number, string> = {
  1: "SUST_STR", 2: "SUST_INT", 3: "SUST_WIS", 4: "SUST_DEX", 5: "SUST_CON",
  6: "PROT_FEAR", 7: "PROT_BLIND", 8: "PROT_CONF", 9: "PROT_STUN",
  10: "SLOW_DIGEST", 11: "FEATHER", 12: "REGEN", 13: "TELEPATHY", 14: "SEE_INVIS",
  15: "FREE_ACT", 16: "HOLD_LIFE",
};
const SHOWN_FLAGS = [6, 7, 8, 9, 11, 12, 13, 14, 15, 16];
const MOD_SPEED = 9, MOD_BLOWS = 10, MOD_LIGHT = 13;

// "& Dagger~" → "Dagger"
const cleanName = (n: string | undefined) => (n ?? "?").replace(/^& /, "").replace(/~/g, "").trim();

const qtyOf = (inv: any[], pred: (n: string) => boolean) =>
  inv.filter((i: any) => pred(i.name ?? "")).reduce((s: number, i: any) => s + (i.qty ?? 1), 0);

function resistLabel(r: { elem: any; level: number }): string {
  const name = typeof r.elem === "number" ? (ELEM_NAMES[r.elem] ?? `elem${r.elem}`) : String(r.elem);
  return r.level >= 3 ? `${name}(imm)` : r.level < 0 ? `${name}(vuln)` : name;
}

function itemResists(item: any): string {
  const rs = (item?.resists ?? []).filter((r: any) => r.level !== 0).map(resistLabel);
  return rs.length ? rs.join(",") : "none";
}

function itemFlags(item: any): string[] {
  const fl: number[] = item?.flags ?? [];
  return SHOWN_FLAGS.filter(f => fl.includes(f)).map(f => FLAG_NAMES[f]!);
}

function describeItem(item: any): string {
  if (!item) return "empty slot";
  const bits: string[] = [];
  if (item.dd) bits.push(`${item.dd}d${item.ds}`);
  if (item.toH || item.toD) bits.push(`(${item.toH >= 0 ? "+" : ""}${item.toH ?? 0},${item.toD >= 0 ? "+" : ""}${item.toD ?? 0})`);
  if (item.ac || item.toA) bits.push(`[${item.ac ?? 0}${item.toA ? (item.toA > 0 ? "+" : "") + item.toA : ""}]`);
  const mods: number[] = item.modifiers ?? [];
  if (mods[MOD_SPEED]) bits.push(`speed${mods[MOD_SPEED]! > 0 ? "+" : ""}${mods[MOD_SPEED]}`);
  if (mods[MOD_BLOWS]) bits.push(`blows${mods[MOD_BLOWS]! > 0 ? "+" : ""}${mods[MOD_BLOWS]}`);
  if (mods[MOD_LIGHT]) bits.push(`light${mods[MOD_LIGHT]! > 0 ? "+" : ""}${mods[MOD_LIGHT]}`);
  const fl = itemFlags(item);
  return `${cleanName(item.name)}${bits.length ? " " + bits.join(" ") : ""} resists: ${itemResists(item)}${fl.length ? " flags: " + fl.join(",") : ""}`;
}

/** A monster as the player knows it: health words, speed, and only what lore has learned. */
function playerMonsterLine(m: any): string {
  const t: string[] = [m.health ?? "?", m.levelKnown ? `Lv${m.level}` : "Lv?", `spd${m.speed ?? "?"}`, `dist${m.distance}`];
  if (m.isUnique) t.push("UNIQUE");
  if (m.asleep) t.push("asleep");
  if (m.afraid) t.push("afraid");
  const blows = (m.blowsSeen ?? []).map((b: any) => `${b.method}:${b.effect}${b.dice ? ":" + b.dice : ""}`);
  if (blows.length) t.push("blows:" + blows.join("/"));
  if ((m.spellsSeen ?? []).length) t.push("seen casting:" + m.spellsSeen.join("/"));
  if ((m.kinds ?? []).length) t.push(m.kinds.join("/"));
  if (m.kills) t.push(`killed${m.kills}`);
  return `${m.name}(${t.join(",")})`;
}

function monsterLine(m: any): string {
  if (m.health !== undefined) return playerMonsterLine(m);
  const t: string[] = [`Lv${m.level}`, `HP${m.hp}/${m.maxhp}`, `spd${m.speed}`, `dist${m.distance}`];
  if (m.isUnique) t.push("UNIQUE");
  if (m.breathElements?.length) t.push("BREATH:" + m.breathElements.join("/"));
  if (m.spellElements?.length) t.push("SPELL:" + m.spellElements.join("/"));
  if (m.hasSummon) t.push("SUMMONS");
  if (m.freqSpell) t.push(`cast1in${m.freqSpell}`);
  if (m.freqInnate) t.push(`innate1in${m.freqInnate}`);
  if (m.isBreeder) t.push("BREEDER");
  if (m.hasPassWall) t.push("PASSWALL");
  const kinds = ([["isEvil", "evil"], ["isUndead", "undead"], ["isDragon", "dragon"], ["isDemon", "demon"],
    ["isAnimal", "animal"], ["isOrc", "orc"], ["isTroll", "troll"], ["isGiant", "giant"]] as const)
    .filter(([k]) => m[k]).map(([, n]) => n);
  if (kinds.length) t.push(kinds.join("/"));
  const imm = ([["imAcid", "ACID"], ["imElec", "ELEC"], ["imFire", "FIRE"], ["imCold", "COLD"], ["imPois", "POIS"]] as const)
    .filter(([k]) => m[k]).map(([, n]) => n);
  if (imm.length) t.push("IM:" + imm.join("/"));
  return `${m.name}(${t.join(",")})`;
}

/** DECISION_ROLES: 役割で言い直した選択肢 (呪文の逃走・回復も含む) */
const ROLE_CRITERIA: Partial<Record<DecisionType, Record<string, string>>> = {
  fight: {
    melee: "fight the target monster in melee",
    throw: "attack the target monster from a distance (thrown oil, missiles or an attack spell)",
    flee: "avoid the target monster and escape (stairs, or a short escape by scroll or spell)",
  },
  tactic: {
    heal: "heal now, by potion or healing spell",
    flee: "escape from the enemies, by scroll or spell",
    fight: "keep attacking without healing",
  },
};

/** /state JSON → 決定的なテキスト (wisdomContext なし) */
export function buildStateText(state: any): string {
  const p = state.player;
  const monsters: any[] = state.monsters ?? [];
  const inv: any[] = p.inventory ?? [];
  const equip: any[] = p.equipment ?? [];
  const nearby = monsters.filter(m => m.distance <= 6)
    .sort((a, b) => a.distance - b.distance || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, 5);
  const heals = qtyOf(inv, n => n.includes("Cure") || n.includes("Healing"));
  const tele = qtyOf(inv, n => n.includes("Teleport"));
  const phase = qtyOf(inv, n => n.includes("Phase Door"));
  const oil = qtyOf(inv, n => n.includes("Flask"));
  const wor = qtyOf(inv, n => n.includes("Word of Recall"));
  const speed = qtyOf(inv, n => n.includes("Speed"));
  const resists = (p.resistances ?? []).filter((r: any) => r.level !== 0).map(resistLabel);
  // 装備の flags の和集合 (種族固有の能力は /state に無い)
  const abil = SHOWN_FLAGS.filter(f => equip.some(e => (e.flags ?? []).includes(f))).map(f => FLAG_NAMES[f]!);
  const timed = p.timed ?? {};
  const status = ["blind", "confused", "poisoned", "cut", "stun", "afraid", "paralyzed", "fast", "slow"]
    .filter(k => (timed[k] ?? 0) > 0).map(k => k.toUpperCase());
  const lines = [
    "Angband roguelike game state, as seen by an expert player.",
    `${p.race ?? "?"} ${p.class ?? "?"} CL${p.level} DL${state.depth}`,
    `HP:${p.hp}/${p.maxHp}${p.maxSp ? ` SP:${p.sp}/${p.maxSp}` : ""} AC:${p.ac ?? "?"} Speed:${p.speed} Blows:${p.numBlows ?? "?"} Light:${p.light ?? "?"}`,
    `Heals:${heals} Phase:${phase} Teleport:${tele} WoR:${wor} Speed:${speed} Oil:${oil}${p.wordRecall > 0 ? " (recall active)" : ""}`,
    `Resists: ${resists.length > 0 ? resists.join(",") : "none"}`,
    `Abilities: ${abil.length > 0 ? abil.join(",") : "none"}`,
    `Status: ${status.length > 0 ? status.join(",") : "normal"} ${p.hunger ? p.hunger : `food:${timed.food ?? "?"}`}`,
    ...(DECISION_ROLES ? resourceLines(p) : []),
    `Equipment: ${equip.map(e => cleanName(e.name)).join(", ") || "none"}`,
    `Nearby monsters: ${nearby.map(monsterLine).join(", ") || "none"}`,
  ];
  if (state.view === "player") {
    // Monsters seen alive on this level and out of sight now: what the player remembers
    const mem = (state.rememberedMonsters ?? []).slice().sort((a: any, b: any) => a.turnsAgo - b.turnsAgo).slice(0, 5)
      .map((m: any) => `${m.name}(${Math.round(m.turnsAgo / 10)} turns ago, last seen dist${m.distance}${m.isUnique ? ",UNIQUE" : ""})`);
    lines.push(`Seen recently on this level: ${mem.join(", ") || "none"}`);
  }
  return lines.join("\n");
}

function build(type: DecisionType, state: any, situation: string[]): DecisionRequest {
  return {
    state: `${buildStateText(state)}\nSituation:\n${situation.join("\n")}`,
    questions: { decision: DECISION_ROLES && ROLE_CRITERIA[type] ? { ...QUESTIONS[type], criteria: ROLE_CRITERIA[type]! } : QUESTIONS[type] },
  };
}

const pct = (x: number) => Math.round(x * 100);

export function fightDecision(state: any, monster: any): DecisionRequest {
  return build("fight", state, [`Target monster: ${monsterLine(monster)}`]);
}

export function tacticDecision(state: any, enemies: any[], hpPct: number): DecisionRequest {
  return build("tactic", state, [
    `HP ${pct(hpPct)}% with ${enemies.length} adjacent enemies`,
    `Adjacent enemies: ${enemies.slice(0, 3).map(monsterLine).join(", ")}`,
  ]);
}

export function recallDecision(state: any): DecisionRequest {
  const p = state.player;
  return build("recall", state, [`HP ${pct(p.hp / p.maxHp)}% on DL${state.depth}, no urgent threat adjacent`]);
}

export function descendDecision(state: any): DecisionRequest {
  const p = state.player;
  return build("descend", state, [`Standing on DL${state.depth} at CL${p.level}, HP ${pct(p.hp / p.maxHp)}%; the usual descent conditions are met`]);
}

export function exploreDecision(state: any, killsThisLevel: number, turnsOnLevel: number): DecisionRequest {
  return build("explore", state, [`Killed ${killsThisLevel} monsters and spent ${turnsOnLevel} turns on DL${state.depth}`]);
}

export function equipDecision(state: any, current: any, candidate: any): DecisionRequest {
  return build("equip", state, [
    `Current: ${describeItem(current)}`,
    `Candidate: ${describeItem(candidate)}`,
  ]);
}
