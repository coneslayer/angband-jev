#!/usr/bin/env npx tsx
/**
 * @file busho-player.ts
 * @brief 武将AIプレイヤー — ai-server経由でAngbandを自律プレイする
 *
 * 学習した戦術をログに記録し、スキルとして保存可能にする。
 */

import {
  DECISION_FORMAT_VERSION, DECISION_FORMAT_VERSION_PLAYER, fightDecision, tacticDecision, recallDecision, descendDecision, exploreDecision, equipDecision,
} from "./decision/index.js";
import type { DecisionType, DecisionRequest } from "./decision/index.js";
import { SavepointBank } from "./savepoint/bank.js";
import { adaptPlayerView } from "./honest-view.js";
import { DangerLogger, DANGER_RECORD_VERSION } from "./danger/record.js";
import { DangerModel } from "./danger/model.js";

const API = process.env.API ?? "http://localhost:3000";
// PLAYER_VIEW=1: play from what the UI shows (/state?view=player), as a human player would
const PLAYER_VIEW = process.env.PLAYER_VIEW === "1";
const VIEW_QS = PLAYER_VIEW ? "?view=player" : "";

// ── 方向定数 (numpad) ──
const DIR = { SW: 1, S: 2, SE: 3, W: 4, STAY: 5, E: 6, NW: 7, N: 8, NE: 9 };
const ALL_DIRS = [1, 2, 3, 4, 6, 7, 8, 9]; // 5(stay)除外

// ── コマンドタイプ ──
const CMD = {
  WALK: 0, RUN: 1, OPEN: 2, CLOSE: 3, TUNNEL: 4, DISARM: 5, ALTER: 6,
  ATTACK: 7, CAST: 8, FIRE: 9, THROW: 10, USE: 11, EAT: 12, QUAFF: 13,
  READ: 14, AIM: 15, ZAP: 16, PICKUP: 17, DROP: 18, EQUIP: 19, UNEQUIP: 20,
  BROWSE: 21, REST: 22, SEARCH: 23, GO_UP: 24, GO_DOWN: 25,
  STUDY: 28,
};

// ── 地形定数 ──
const FEAT = {
  FLOOR: 1, CLOSED_DOOR: 2, OPEN_DOOR: 3, BROKEN_DOOR: 4,
  UP_STAIR: 5, DOWN_STAIR: 6,
  SECRET: 15, RUBBLE: 16, MAGMA: 17, QUARTZ: 18,
  MAGMA_K: 19, QUARTZ_K: 20, GRANITE: 21, PERM: 22,
  LAVA: 23, PASS_RUBBLE: 24,
};
// Lava is left out: it burns, and vanilla asks before a step that costs over a third of HP (headless: no step, no time)
const PASSABLE_FEATS = new Set([FEAT.FLOOR, FEAT.OPEN_DOOR, FEAT.BROKEN_DOOR, FEAT.UP_STAIR, FEAT.DOWN_STAIR, FEAT.PASS_RUBBLE]);
// 掘削具 (Shovel/Pick) を持っているか。VANILLA では初期所持なし → 持たない時は花崗岩/マグマ/石英を掘らない
let canDigHard = true;
const SOFT_DIG_FEATS = new Set([FEAT.CLOSED_DOOR, FEAT.SECRET, FEAT.RUBBLE]);
function playerHasDigger(p: any): boolean {
  for (const it of [...(p.inventory ?? []), ...(p.equipment ?? [])]) {
    if (it && it.tval === 6 && (it.qty ?? 1) > 0) return true;
  }
  return false;
}
// Digging skill (the /state player.digging). As in vanilla, magma needs skill > 10, quartz > 20 and granite > 40;
// below that, tunnelling only ever "chips away futilely", even with a shovel.
let diggingSkill = 0;
const DIG_SKILL_NEEDED: Record<number, number> = { 17: 10, 19: 10, 18: 20, 20: 20, 21: 40 }; // MAGMA(_K), QUARTZ(_K), GRANITE
function canDigFeat(feat: number): boolean {
  return canDigHard && diggingSkill > (DIG_SKILL_NEEDED[feat] ?? 0);
}
/** この地形を掘る価値があるか (掘削具なしだと扉/瓦礫のみ) */
function digWorthwhile(feat: number): boolean {
  return SOFT_DIG_FEATS.has(feat) || (DIGGABLE_FEATS.has(feat) && canDigFeat(feat));
}
const DIGGABLE_FEATS = new Set([FEAT.CLOSED_DOOR, FEAT.SECRET, FEAT.RUBBLE, FEAT.MAGMA, FEAT.QUARTZ, FEAT.MAGMA_K, FEAT.QUARTZ_K, FEAT.GRANITE]);

// ── TVal定数 (list-tvals.h準拠) ──
const TVAL = {
  SCROLL: 25, POTION: 26, FLASK: 27, FOOD: 28,
  // 装備品 (正確な値)
  DIGGING: 6, HAFTED: 7, POLEARM: 8, SWORD: 9,
  BOOTS: 10, GLOVES: 11, HELM: 12, CROWN: 13, SHIELD: 14, CLOAK: 15,
  SOFT_ARMOR: 16, HARD_ARMOR: 17, DRAG_ARMOR: 18,
  LIGHT: 19, AMULET: 20, RING: 21,
  STAFF: 22, WAND: 23, ROD: 24,
  BOW: 5, SHOT: 2, ARROW: 3, BOLT: 4,
  // 魔法書 (装備対象外)
  MAGIC_BOOK: 30, PRAYER_BOOK: 31, NATURE_BOOK: 32, SHADOW_BOOK: 33, OTHER_BOOK: 34,
};

// 装備可能なtval
const WEAPON_TVALS = new Set([TVAL.SWORD, TVAL.POLEARM, TVAL.HAFTED, TVAL.DIGGING]);
const ARMOR_TVALS = new Set([TVAL.SOFT_ARMOR, TVAL.HARD_ARMOR, TVAL.DRAG_ARMOR]);
const HEAD_TVALS = new Set([TVAL.HELM, TVAL.CROWN]);
const EQUIPPABLE_TVALS = new Set([
  TVAL.SWORD, TVAL.POLEARM, TVAL.HAFTED, TVAL.DIGGING,
  TVAL.SOFT_ARMOR, TVAL.HARD_ARMOR, TVAL.DRAG_ARMOR,
  TVAL.BOW, TVAL.SHIELD, TVAL.HELM, TVAL.CROWN, TVAL.GLOVES, TVAL.BOOTS,
  TVAL.CLOAK, TVAL.RING, TVAL.AMULET, TVAL.LIGHT,
]);

// ── ObjectFlag定数 (重要なもののみ) ──
const OF = {
  SUST_STR: 1, SUST_INT: 2, SUST_WIS: 3, SUST_DEX: 4, SUST_CON: 5,
  PROT_FEAR: 6, PROT_BLIND: 7, PROT_CONF: 8, PROT_STUN: 9,
  SLOW_DIGEST: 10, FEATHER: 11, REGEN: 12, TELEPATHY: 13, SEE_INVIS: 14,
  FREE_ACT: 15, HOLD_LIFE: 16,
};
// ── ObjectModifier定数 ──
const OMOD = {
  STR: 0, INT: 1, WIS: 2, DEX: 3, CON: 4,
  STEALTH: 5, SPEED: 9, BLOWS: 10, LIGHT: 13,
};
// ── Element定数 ──
const ELEM = { ACID: 0, ELEC: 1, FIRE: 2, COLD: 3, POIS: 4 };
// Element name → ELEM index mapping (for resistance lookup)
const ELEM_NAME_TO_IDX: Record<string, number> = {
  ACID: 0, ELEC: 1, FIRE: 2, COLD: 3, POIS: 4,
  LIGHT: 5, DARK: 6, SOUND: 7, SHARD: 8, NEXUS: 9,
  NETHER: 10, CHAOS: 11, DISEN: 12,
};

// ── スレイ/ブランドマッピング ──
// Slay index → { raceKey, multiplier }
// raceKey matches monster field names from ai-server
const SLAY_TABLE: { raceKey: string; mult: number }[] = [
  { raceKey: "isEvil", mult: 2 },    // 0: EVIL_2
  { raceKey: "isAnimal", mult: 2 },   // 1: ANIMAL_2
  { raceKey: "isOrc", mult: 3 },      // 2: ORC_3
  { raceKey: "isTroll", mult: 3 },    // 3: TROLL_3
  { raceKey: "isGiant", mult: 3 },    // 4: GIANT_3
  { raceKey: "isDemon", mult: 3 },    // 5: DEMON_3
  { raceKey: "isDragon", mult: 3 },   // 6: DRAGON_3
  { raceKey: "isUndead", mult: 3 },   // 7: UNDEAD_3
  { raceKey: "isDemon", mult: 5 },    // 8: DEMON_5
  { raceKey: "isDragon", mult: 5 },   // 9: DRAGON_5
  { raceKey: "isUndead", mult: 5 },   // 10: UNDEAD_5
];

// Brand index → { element, immunity key, multiplier }
const BRAND_TABLE: { elem: string; imKey: string; mult: number }[] = [
  { elem: "ACID", imKey: "imAcid", mult: 3 },  // 0: ACID_3
  { elem: "ELEC", imKey: "imElec", mult: 3 },  // 1: ELEC_3
  { elem: "FIRE", imKey: "imFire", mult: 3 },  // 2: FIRE_3
  { elem: "COLD", imKey: "imCold", mult: 3 },  // 3: COLD_3
  { elem: "POIS", imKey: "imPois", mult: 3 },  // 4: POIS_3
  { elem: "ACID", imKey: "imAcid", mult: 2 },  // 5: ACID_2
  { elem: "ELEC", imKey: "imElec", mult: 2 },  // 6: ELEC_2
  { elem: "FIRE", imKey: "imFire", mult: 2 },  // 7: FIRE_2
  { elem: "COLD", imKey: "imCold", mult: 2 },  // 8: COLD_2
  { elem: "POIS", imKey: "imPois", mult: 2 },  // 9: POIS_2
];

/**
 * 特定モンスターに対する武器の実効DPS計算
 * スレイ/ブランドのマルチプライヤーを考慮
 */
function weaponDpsVsMonster(
  weapon: { dd?: number; ds?: number; toH: number; toD: number; brands?: number[]; slays?: number[] },
  playerToD: number,
  monster: Record<string, any>,
): number {
  const baseDmg = (weapon.dd ?? 1) * ((weapon.ds ?? 4) + 1) / 2 + weapon.toD + playerToD;

  // 最大スレイマルチプライヤーを検索
  let bestMult = 1;
  if (weapon.slays) {
    for (const slayIdx of weapon.slays) {
      const slay = SLAY_TABLE[slayIdx];
      if (slay && monster[slay.raceKey]) {
        bestMult = Math.max(bestMult, slay.mult);
      }
    }
  }

  // ブランドマルチプライヤー（モンスター耐性で無効化）
  if (weapon.brands) {
    for (const brandIdx of weapon.brands) {
      const brand = BRAND_TABLE[brandIdx];
      if (brand && !monster[brand.imKey]) {
        bestMult = Math.max(bestMult, brand.mult);
      }
    }
  }

  return baseDmg * bestMult;
}

/**
 * インベントリから特定モンスターに最適な武器を選ぶ
 * 現装備より実効DPSが高い武器があればそのスロットを返す
 */
function findBestWeaponForMonster(
  inventory: any[], equipment: any[], playerToD: number, monster: Record<string, any>,
): { slot: number; name: string; dps: number; currentDps: number } | null {
  // RULEFIX=gearid: 武器は itemPower (攻撃回数込みの 1 ターンの与ダメージ) だけで選ぶ。ここの見積もりは攻撃回数も
  // 分かっている修正も見ないので、敵が近づく度に gearid の選んだ武器と入れ替え合っていた
  if (GEARID) return null;
  const currentWeapon = equipment.find((e: any) => WEAPON_TVALS.has(e.tval));
  if (!currentWeapon) return null;

  const currentDps = weaponDpsVsMonster(currentWeapon, playerToD, monster);

  let bestSlot = -1;
  let bestDps = currentDps;
  let bestName = "";

  for (const item of inventory) {
    if (!WEAPON_TVALS.has(item.tval)) continue;
    const dps = weaponDpsVsMonster(item, playerToD, monster);
    if (dps > bestDps * 1.3) { // 30%以上のDPS増加がある場合のみスワップ（頻繁な交換防止）
      bestDps = dps;
      bestSlot = item.slot;
      bestName = item.name;
    }
  }

  if (bestSlot === -1) return null;
  return { slot: bestSlot, name: bestName, dps: bestDps, currentDps };
}

// 装備品のパワースコア計算 (フラグ・耐性・修正値を考慮)
// 現在のプレイヤー耐性セット（グローバル、毎ターン更新）
let currentPlayerResists = new Set<number>();
let currentDepth = 0;

function itemPower(item: {
  tval: number; toH: number; toD: number; toA: number;
  ac?: number; dd?: number; ds?: number;
  flags?: number[]; modifiers?: number[];
  resists?: { elem: number; level: number }[];
  brands?: number[]; slays?: number[];
}): number {
  let score = 0;
  if (GEARID) {
    if (gearCursed(item)) return -100; // 呪いの分かっている品は着けない
    item = gearView(item);
  }

  if (WEAPON_TVALS.has(item.tval)) {
    // 武器: ダメージダイス + 命中/ダメージボーナス
    const avgDmg = (item.dd ?? 1) * ((item.ds ?? 4) + 1) / 2;
    // RULEFIX=gearid: 1 ターンの与ダメージ (この武器での攻撃回数 × (ダイス + ダメージ修正)) で比べる。重すぎる武器は回数が減る
    const kblows = (item as any).kblows;
    score = GEARID && typeof kblows === "number" && kblows > 0
      ? (kblows / 100) * (avgDmg + (item.toD ?? 0)) * 2 + (item.toH ?? 0) * 2
      : avgDmg + item.toH * 2 + item.toD * 3;
    // ブランド/スレイは大きなボーナス
    if (item.brands && item.brands.length > 0) score += item.brands.length * 10;
    if (item.slays && item.slays.length > 0) score += item.slays.length * 8;
  } else {
    // 防具: AC + ボーナス
    score = (item.ac ?? 0) + item.toA * 2 + item.toH + item.toD;
  }

  // フラグボーナス
  const flags = new Set(item.flags ?? []);
  if (flags.has(OF.FREE_ACT)) score += 15;
  if (flags.has(OF.SEE_INVIS)) score += 12;
  if (flags.has(OF.HOLD_LIFE)) score += 10;
  if (flags.has(OF.REGEN)) score += 8;
  if (flags.has(OF.PROT_CONF)) score += 8;
  if (flags.has(OF.PROT_BLIND)) score += 8;
  if (flags.has(OF.PROT_FEAR)) score += 5;
  if (flags.has(OF.FEATHER)) score += 3;
  if (flags.has(OF.SLOW_DIGEST)) score += 3;
  if (flags.has(OF.TELEPATHY)) score += 20;
  for (let i = OF.SUST_STR; i <= OF.SUST_CON; i++) {
    if (flags.has(i)) score += 3;
  }

  // 耐性ボーナス — 足りない耐性は超高評価
  for (const r of item.resists ?? []) {
    if (r.level > 0) {
      const isMissing = !currentPlayerResists.has(r.elem);
      const depthMultiplier = currentDepth >= 30 ? 3 : currentDepth >= 20 ? 2 : 1;
      if (r.elem <= ELEM.COLD) {
        score += isMissing ? 40 * depthMultiplier : 15; // 足りない基本耐性は超重要
      } else if (r.elem === ELEM.POIS) {
        score += isMissing ? 30 * depthMultiplier : 12;
      } else {
        score += isMissing ? 20 * depthMultiplier : 8;
      }
    }
  }

  // 修正値ボーナス
  const mods = item.modifiers ?? [];
  if (mods[OMOD.SPEED] && mods[OMOD.SPEED] > 0) score += mods[OMOD.SPEED] * 20;
  if (mods[OMOD.STR] && mods[OMOD.STR] > 0) score += mods[OMOD.STR] * 5;
  if (mods[OMOD.DEX] && mods[OMOD.DEX] > 0) score += mods[OMOD.DEX] * 4;
  if (mods[OMOD.CON] && mods[OMOD.CON] > 0) score += mods[OMOD.CON] * 5;
  if (mods[OMOD.STEALTH] && mods[OMOD.STEALTH] > 0) score += mods[OMOD.STEALTH] * 3;
  if (mods[OMOD.BLOWS] && mods[OMOD.BLOWS] > 0) score += mods[OMOD.BLOWS] * 15;

  return score;
}

const STATIONARY_RE = /jelly|mold|mushroom|patch|floating eye|lichen|shrieker|spore|ooze/i;
// 接触で痛い動かない敵 (ゼリー/カビ/浮遊眼)。キノコ (HP1-2) は殴って倒す方が安全
function hurtsOnContact(m: any): boolean {
  const name = m.name ?? "";
  if (!STATIONARY_RE.test(name)) return false;
  return /floating eye/i.test(name) || (m.maxhp ?? m.hp ?? 99) > 5;
}
// ── 序盤ルール改善 (RULEFIX=danger,restock,escape,upnavfood,fire,lowheal,leave,clgate1。"none" で旧ルール、A/B 用。wor, upnav は明示した時だけ。fire, lowheal はセッション14、leave, clgate1 はセッション17で採用) ──
const RULEFIX = new Set((process.env.RULEFIX ?? "danger,restock,escape,upnavfood,fire,lowheal,leave,clgate1").split(",").map((t) => t.trim()));
// 既定 (session 14 で採用): fire (射撃武器で撃つ + 矢弾を買う), lowheal (HP 危険域・毒は停滞脱出より回復)。
// 明示した時だけ (session 15 の検証): food8 (食料を 8 個まで), neutpois (Neutralize Poison を買い、毒で HP 半分未満なら飲む),
// poisonhold (毒で HP 半分未満・回復薬なし・敵が見えない → 休む), fireadj (隣接する敵も撃つ), ammo60 (矢弾を 60 本まで)
// 明示した時だけ (session 14 で不採用): restock100 (補給帰還は 100G 以上), restockboth (回復薬と Phase/油の両方が切れたら帰還), clgate1 (DL1-3 は CL >= DL+1 で降下)
// 明示した時だけ (セッション18で検証): clgate0 (DL1-3 は CL >= DL で降下)、leave2 (この階で 2 回逃げたら去る)、
// leavemore (leave の名前に、セッション17の新しい既定で多かった死因を加える)
const EARLY_CL_MARGIN = RULEFIX.has("clgate0") ? 0 : RULEFIX.has("clgate1") ? 1 : 2;
const FOOD_KEEP = RULEFIX.has("food8") ? 8 : 6; // 町で買う食料の目標 (深い階の帰り道で餓死していた)
// RULEFIX=breed: 繁殖する敵 (思い出に「爆発的に繁殖する」と出たもの = C サーバーの breeds。繁殖を見た後だけ) を
// 少ないうちに最優先で倒し、増え始めたら (4 体以上見える、またはこの階で 150 行動見え続けた) 最寄りの階段から階を去る
const BREED = RULEFIX.has("breed");
const BREED_LEAVE_SEEN = 4, BREED_LEAVE_TICKS = 150, BREED_WALK_MAX = 300;
let breedDepth = -1, breedTicks = 0, breedLeaving = false, breedWalk = 0;
const breedHunted = new Set<string>();
function knownBreeder(m: any): boolean { return BREED && m.breeds === true; }
// RULEFIX=whirl: ブラックガードは隣接 2 体以上で Whirlwind Attack (CL5、隣接全体を攻撃)
const WHIRL = RULEFIX.has("whirl");
// RULEFIX=earlyrun: CL4 以下で 1 手に最大 HP の 1/3 以上減り、敵が隣接 → 階段/Phase で離れる (序盤の soldier/apprentice 死)
const EARLYRUN = RULEFIX.has("earlyrun");
let earlyLastHp: number | null = null;
// RULEFIX=neutshop: Neutralize Poison は町の買い物の最後に 1 個だけ (neutpois は買い物で補給帰還が増えた)。飲み方は neutpois と同じ
// RULEFIX=cutcure: 出血中 HP 50% 未満も lowheal の回復対象に ("a fatal wound" 死)
// RULEFIX=stairsfirst: 階段の上で、見えている敵が 2 手以内に HP を削り切れる (近接の見積もり) → 他の逃走より先に階段を使う。
// CL10 未満で既存の逃走条件が成立したら、近い既知の階段 (6 歩以内、どの敵にも今より近づかない経路) へ Phase Door より先に歩く
const STAIRSFIRST = RULEFIX.has("stairsfirst");
const STAIRS_WALK_MAX = 6, STAIRS_WALK_FAR = 20;
let stairsFirstWalks = 0;
// 「近い」階段の歩数: 6 歩。脅威が全て 2 マス以上離れていて自分より速くなければ、歩く間に追いつかれないので 20 歩まで
// (TS の煙テストでは逃走条件の成立時に最寄りの階段が 13-191 歩、6 歩以内は 0 回だった)
function stairsWalkMax(threats: any[], pspeed: number | undefined): number {
  return threats.every((m: any) => m.distance >= 2 && (m.speed ?? 110) <= (pspeed ?? 110)) ? STAIRS_WALK_FAR : STAIRS_WALK_MAX;
}
// RULEFIX=leave: 序盤の危険な敵 (4.2 の名前) が見えた、この階で 3 回逃げた (Phase Door/Teleport/逃走)、毒か出血で HP 半分未満
// → 最寄りの既知の階段 (上下どちらでも) から階を去る。逃げ続けた後の強制戦闘 (forceFight) への切り替えも、階を去るに置き換える
const LEAVE = RULEFIX.has("leave");
const LEAVE_LIST: [RegExp, number][] = [ // [名前, この CL 以下で去る]
  [/^(fang|grip), farmer maggot's dog$/, 5],
  [/^(soldier|apprentice|acolyte)$/, 8],
  [/^bullroarer the hobbit$/, 15],
  [/^cave spider$/, 20],
  ...(RULEFIX.has("leavemore") ? [ // セッション17の confirmQ (新しい既定) で 4 回以上殺した敵
    [/^snaga$/, 10], [/^lagduf, the snaga$/, 14], [/^mughash the kobold lord$/, 15], [/^gallant$/, 10],
    [/^scout$/, 8], [/^battle-scarred veteran$/, 10], [/^large kobold$/, 8],
  ] as [RegExp, number][] : []),
];
const LEAVE_ESCAPES = RULEFIX.has("leave2") ? 2 : 3, LEAVE_WALK_MAX = 300;
let leaving = "", leaveWalk = 0, levelEscapes = 0;
let leaveHurtDone = false; // 毒/出血での離脱はその毒/出血の間に 1 回だけ (着いた階段ですぐまた去るのを繰り返さない)
function leaveListed(m: any, plevel: number): boolean {
  const n = String(m.name ?? "").toLowerCase().replace(/^(the|an?) /, "");
  return LEAVE_LIST.some(([rx, maxCl]) => plevel <= maxCl && rx.test(n));
}
// RULEFIX=arrive: 階段で着いた直後、危険の気配 (state.levelFeeling 1-9、9 が最悪。TS には無い = 情報なし) が閾値以上
// (5、CL が DL を 4 超えるごとに +1)、または leave の敵が見えたら、その階段ですぐ引き返す。連続 3 回まで
const ARRIVE = RULEFIX.has("arrive");
const ARRIVE_MAX_BOUNCES = 3;
let arrivePending = false, arriveBounces = 0;
function arriveThreshold(plevel: number, depth: number): number {
  return Math.min(10, 5 + Math.floor(Math.max(0, plevel - depth) / 4));
}
// RULEFIX=seal: 既知の繁殖敵 (breeds、思い出に出てから) から退く途中で扉を抜けたら、扉の上が空なら閉める。扉を開けて既知の繁殖敵
// 3 体以上、または敵 8 体以上が新たに見えたら、扉の上が空ならすぐ閉める。閉めた扉はこの階では壁扱い (行き詰まった時だけ開け直す)
const SEAL = RULEFIX.has("seal");
const SEAL_BREEDERS = 3, SEAL_CROWD = 8;
const sealedDoors = new Set<string>(); // この階で閉めた扉 "x,y" (経路探索では壁)
const sealFailed = new Set<string>();  // 閉められなかった扉 (再試行しない)
let sealPrev: { x: number; y: number; depth: number } | null = null;
// RULEFIX=sling: 射撃武器のない職業は、最初の買い物でスリング (武器屋) と鉄の弾 20 発 (雑貨屋) を買い、装備して fire で撃つ。
// 所持金が少なければ (スリング購入後 200G 未満) 油の目標を半分に
const SLING = RULEFIX.has("sling");
const SLING_SHOTS = 20, SLING_OIL_GOLD = 200;
// モンスターの打撃 (gamedata/monster.json) → 1ターンあたり平均ダメージ
const MON_BLOW_AVG: Map<string, number> = (() => {
  const m = new Map<string, number>();
  try {
    const fs = require("node:fs");
    const raw = JSON.parse(fs.readFileSync(`${process.cwd()}/packages/@angband/core/gamedata/monster.json`, "utf-8"));
    const list: any[] = Array.isArray(raw) ? raw : (Object.values(raw)[0] as any[]);
    for (const mon of list) {
      const blows: string[] = Array.isArray(mon.blow) ? mon.blow : mon.blow ? [mon.blow] : [];
      let avg = 0;
      for (const b of blows) {
        const d = /(\d+)d(\d+)/.exec(b);
        if (d) avg += Number(d[1]) * (Number(d[2]) + 1) / 2;
      }
      if (mon.name) m.set(String(mon.name).toLowerCase(), avg);
    }
  } catch { /* gamedata なし: danger 判定は無効 */ }
  return m;
})();
// RULES_CAUTION=-1..1 (既定0=無効): ルールの fight/tactic 判断の慎重さを1つのつまみで動かす (Session 3 対照群)
// +1 で慎重 (高い回復閾値、格下でも油/逃走、殴り合いの許容ダメージ半減)、-1 で大胆
const RULES_CAUTION = Math.max(-1, Math.min(1, Number(process.env.RULES_CAUTION ?? "0") || 0));
// 殴り合いの見積もり: 倒すまでに受けるダメージが現HPの半分以上なら殴らない (CL<15)
// RULEFIX=dangerml: 敵の 1 ターンの与ダメージを、ゲームデータの打撃平均 (MON_BLOW_AVG) ではなく学習した危険度モデルの
// dmg_5 (この先 5 プレイヤーターンで失う HP / 最大 HP、DANGER_MODEL で読み込み、DANGER_LOG=1 の記録から毎手予測) から見積もる
const DANGERML = RULEFIX.has("dangerml");
let predDmg5: number | undefined; // 今の状態での dmg_5 の予測 (DANGERML の時だけ使う)
// RULEFIX=dangermlflee: 危険度モデルの death_20 (この先 20 プレイヤーターン以内に死ぬ確率、DANGER_MODEL で読み込み) が
// MLFLEE_STAIRS 以上で 5 マス以内に敵 → 階段の上なら階段、MLFLEE_ESCAPE 以上で 3 マス以内に敵 → 逃走スペル/巻物。
// 閾値は session 17+18 の検証用ゲームの信頼度表から実行前に固定 (docs/finetune-laya-plan.md)
const DANGERMLFLEE = RULEFIX.has("dangermlflee");
const MLFLEE_STAIRS = 0.002, MLFLEE_ESCAPE = 0.01, MLFLEE_TELE = 0.1; // 検証用で実際の死亡率 6% / 17% / 36% の行
let predDeath20: number | undefined;
let mlFleeStairs = 0, mlFleeEscapes = 0, lastMlFleeAction = -99;
function meleeTooCostly(m: any, p: any): boolean {
  if (!RULEFIX.has("danger") || p.level >= 15) return false;
  if (!DANGERML && !MON_BLOW_AVG.size) return false;
  // dangerml: 予測は実際に受けたダメージ (命中も速度も込み) なので、そのまま 1 プレイヤーターンあたりの HP にする
  const predicted = DANGERML && predDmg5 !== undefined ? predDmg5 / 5 * (p.maxHp ?? p.hp) : undefined;
  const blowAvg = DANGERML ? predicted : MON_BLOW_AVG.get(String(m.name ?? "").toLowerCase());
  if (!blowAvg) return false;
  const weapon = (p.equipment ?? []).find((e: any) => e && (e.dd ?? 0) > 0);
  const perBlow = weapon ? weapon.dd * (weapon.ds + 1) / 2 + (weapon.toD ?? 0) : 1.5;
  const myDmg = Math.max(1, (p.numBlows ?? 1) * (perBlow + (p.toD ?? 0)) * 0.75);
  const speedRatio = Math.max(0.5, ((m.speed ?? 110) - 100) / Math.max(5, (p.speed ?? 110) - 100));
  const theirDmg = predicted ?? blowAvg * 0.7 * speedRatio;
  const turnsToKill = Math.ceil((m.hp ?? m.maxhp ?? 1) / myDmg);
  return theirDmg * turnsToKill >= 0.5 * (1 - 0.5 * RULES_CAUTION) * p.hp;
}
let restockTrip = false; // 浅層で消耗品切れ → 上り階段で町へ (着いたら補充して解除)
let upRerolls = 0, upRerollDepth = -1; // RULEFIX=upnav: 補給帰還中、この深さで階を振り直した回数

// CL<12 の BFS 回避マス (毎ターン更新): 上記の敵のマス (hard: 歩くと攻撃になる) とその隣 (soft: 接触攻撃を受ける)
let avoidHard = new Set<string>();
let avoidSoft = new Set<string>();
function setStationaryAvoid(monsters: any[], level: number): void {
  avoidHard = new Set(); avoidSoft = new Set();
  if (level >= 12) return;
  for (const m of monsters) {
    if (!hurtsOnContact(m)) continue;
    avoidHard.add(`${m.x},${m.y}`);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) avoidSoft.add(`${m.x + dx},${m.y + dy}`);
  }
}
// ── 序盤の高速/強敵 (Fang, Grip, 洞窟蜘蛛群れ等): CL<10 では格上の速い敵は逃げ/投擲対象 ──
function lowCLDanger(mon: { level: number; speed: number; isUnique?: boolean; name?: string }, playerLevel: number): boolean {
  if (playerLevel >= 10) return false;
  // 動かない敵 (ゼリー/カビ/キノコ等は speed120 だが追って来ない。サーバに NEVER_MOVE が出ないので名前で除外)
  if (mon.name && STATIONARY_RE.test(mon.name)) return false;
  return mon.speed >= 120 && (!!mon.isUnique || mon.level >= playerLevel + Math.round(2 - 2 * RULES_CAUTION));
}

// ── モンスター脅威度評価 ──
function monsterThreat(mon: {
  level: number; speed: number; hp: number; maxhp: number;
  isUnique?: boolean; breathElements?: string[]; hasSummon?: boolean;
  freqSpell?: number; freqInnate?: number;
}, playerLevel: number, playerResists?: Set<string>): number {
  // 高い値 = 危険
  let threat = mon.level;
  if (mon.speed > 110) threat += (mon.speed - 110) * 3; // 速い敵は非常に危険
  if (mon.level > playerLevel * 2) threat += 20; // レベル差が大きい
  if (mon.level > playerLevel * 3) threat += 30; // 極端なレベル差
  // ユニーク補正
  if (mon.isUnique) threat += 15;
  // ブレス攻撃 — 耐性なしの属性ブレスは非常に危険
  if (mon.breathElements && mon.breathElements.length > 0) {
    let unresisted = 0;
    for (const elem of mon.breathElements) {
      if (playerResists && playerResists.has(elem)) continue;
      unresisted++;
    }
    threat += unresisted * 10; // 耐性なしブレス1種につき+10
    if (unresisted === 0 && mon.breathElements.length > 0) {
      threat -= 5; // 全ブレスに耐性あり → 脅威低下
    }
  }
  // 召喚持ちは長期戦で危険
  if (mon.hasSummon) threat += 10;
  // 高頻度スペル使い
  if ((mon.freqSpell ?? 0) >= 33) threat += 5;
  if ((mon.freqInnate ?? 0) >= 33) threat += 5;
  return threat;
}

function isDangerousMonster(mon: {
  level: number; speed: number; hp: number; maxhp: number; name: string;
  isUnique?: boolean; breathElements?: string[]; hasSummon?: boolean;
  isBreeder?: boolean; freqSpell?: number; freqInnate?: number;
}, playerLevel: number, depth: number, playerResists?: Set<string>): boolean {
  if (lowCLDanger(mon, playerLevel)) return true;
  // 速度130+は「速い+強い」の組み合わせが危険 (低レベル高速モンスターは戦える)
  if (mon.speed >= 130 && (mon.level >= playerLevel * 0.7 || mon.level >= 15)) return true;

  // 低レベルでは脅威判定を緩和 (CL5未満は基本的に戦う)
  if (playerLevel < 5) {
    // CL5未満は本当に強い敵だけ避ける
    if (mon.level > playerLevel * 4 && mon.level >= 10) return true;
    return false;
  }

  // ユニーク判定: サーバーフラグ優先、フォールバックで名前ヒューリスティック
  const isUnique = mon.isUnique ?? (
    mon.name.includes(",") ||
    (mon.name[0] === mon.name[0]?.toUpperCase() && !mon.name.startsWith("the ") && !mon.name.startsWith("a ") && !mon.name.startsWith("an "))
  );

  // 耐性なしブレス持ちは非常に危険 (ブレスダメージはHPの1/3)
  const hasUnresistedBreath = (mon.breathElements?.length ?? 0) > 0 &&
    mon.breathElements!.some(elem => !playerResists || !playerResists.has(elem));

  // 召喚持ちは数的不利を作られるため危険
  const isSummoner = mon.hasSummon ?? false;

  // 高頻度スペル使い (1/3以上) は遠距離から攻撃してくる
  const isFreqCaster = ((mon.freqSpell ?? 0) >= 33) || ((mon.freqInnate ?? 0) >= 33);

  // DL20+ではさらに慎重に (ユニークは基本的に危険)
  if (depth >= 20) {
    if (isUnique) return true; // DL20+ではユニーク全部危険
    if (mon.speed > 120) return true;
    if (mon.level > playerLevel * 1.5 && mon.level >= 10) return true;
    if (mon.maxhp > 200 && mon.level > playerLevel + 3) return true;
    // 高HP敵 (hydra, golem, knight等) は消耗戦で不利
    if (mon.maxhp >= 300) return true;
    if (mon.maxhp >= 200 && depth >= 30) return true;
    // 耐性なしブレス持ちで格上 → 危険
    if (hasUnresistedBreath && mon.level >= playerLevel) return true;
    // 召喚持ちは同レベル以上で危険
    if (isSummoner && mon.level >= playerLevel) return true;
    return false;
  }
  // DL15+ではより慎重に
  if (depth >= 15) {
    if (isUnique && mon.level > playerLevel) return true;
    if (isUnique && mon.maxhp > 200) return true;
    if (mon.speed > 120 && mon.level > playerLevel) return true;
    if (mon.level > playerLevel * 2.0 && mon.level >= 10) return true;
    // 耐性なしブレス持ちで格上 → 危険
    if (hasUnresistedBreath && mon.level > playerLevel + 2) return true;
    // 召喚持ちで格上
    if (isSummoner && mon.level > playerLevel + 3) return true;
    return false;
  }

  if (isUnique && mon.level > playerLevel + 5) return true;
  // ユニークでHP200超え → 1 blowでは倒せない消耗戦になる
  if (isUnique && mon.maxhp > 150 && mon.level > playerLevel) return true;
  if (mon.speed > 120 && mon.level > playerLevel + 3) return true;
  if (mon.level > playerLevel * 2.5 && mon.level >= 10) return true;
  // 耐性なしブレスは浅層でも大ダメージ
  if (hasUnresistedBreath && mon.level > playerLevel + 5) return true;
  // 高HPモンスター (非ユニーク含む) は消耗戦で危険
  if (mon.maxhp > 300 && mon.level > playerLevel + 3) return true;
  return false;
}

// 同じスロットカテゴリか判定
// RULEFIX=gearid: 装備の識別と選択。C の画面が送る「プレイヤーが知っている性質」(kflags/kmods/kres/kbrands/kslays/kcurses、
// 武器はこの武器での攻撃回数 kblows、店の品は kdd..ktoA) で評価し、{cursed} は着けない。安全な時に {??} (未知のルーンあり) の品を
// 試着し (同点なら未知の方、指輪/アミュレットは空き枠に)、着けてみて分かった性質で一番良いものに着け替える
const GEARID = RULEFIX.has("gearid");
function gearView(it: any): any {
  if (!it || it.kflags === undefined) return it;
  const mods: number[] = [];
  for (const [i, v] of it.kmods ?? []) mods[i] = v;
  return { ...it, dd: it.dd ?? it.kdd, ds: it.ds ?? it.kds, ac: it.ac ?? it.kac,
    toH: it.toH ?? it.ktoH ?? 0, toD: it.toD ?? it.ktoD ?? 0, toA: it.toA ?? it.ktoA ?? 0,
    flags: it.kflags, modifiers: mods, resists: (it.kres ?? []).map(([elem, level]: number[]) => ({ elem, level })),
    brands: new Array(it.kbrands ?? 0).fill(1), slays: new Array(it.kslays ?? 0).fill(1) };
}
function gearCursed(it: any): boolean { return (it?.kcurses ?? 0) > 0 || /\{[^}]*cursed/.test(it?.desc ?? ""); }
function gearUnknown(it: any): boolean { return /\?\?/.test(it?.desc ?? ""); }
// 射撃武器の弾の種類 (違う種類には替えない: 買った矢弾が無駄になる)
function launcherFamily(name: string): string { return /Sling/i.test(name) ? "shot" : /Crossbow/i.test(name) ? "bolt" : "arrow"; }
let gearTries = new Map<string, number>(), lastGearAction = -99;
// RULEFIX=tryunknown: 未知の薬を、5 マス以内に敵がいない時に飲んで識別する (HP 75% 未満なら回復薬かもしれない。町なら HP を問わない)。
// 未知の巻物は町で錬金術店に渡す (shouldKeepItem)。持ち物の名前は知っている時だけ本当の名前 (C の aware)
const TRYUNKNOWN = RULEFIX.has("tryunknown");
let lastTryAction = -99, potionsTried = 0;
// RULEFIX=devices: 魔法の道具 (杖・魔法棒・ロッド)。未知のものは使って識別する (魔法棒/ロッドは隣にいない見えている敵へ、
// 杖は敵が見えず HP 75% 以上の時: 4.2 では回復・治療・感知は満タンでも識別される)。分かったものは、攻撃の魔法棒/ロッドを
// 危険な敵へ近接の前に (油より先に)、回復の杖を HP 半分未満で、Teleportation の杖を緊急時に使う。使い道のないものは落とす
const DEVICES = RULEFIX.has("devices");
const ATTACK_DEVICES = /^(Magic Missile|Stinking Cloud|Lightning Bolts|Frost Bolts|Fire Bolts|Acid Bolts|Lightning Balls|Cold Balls|Fire Balls|Acid Balls|Dragon's (Flame|Frost|Breath)|Drain Life|Annihilation)$/;
const HEAL_STAVES = /^(Cure Light Wounds|Curing|Healing)$/;
const USELESS_DEVICES = /^(Haste Monsters?|Heal Monster|Clone Monster|Summoning|Darkness|Wonder|Polymorph)$/;
function deviceCharges(it: any): number | null { const m = /\((\d+) charges?\)/.exec(it?.desc ?? ""); return m ? Number(m[1]) : null; }
function deviceUseless(it: any): boolean { return it.aware !== false && USELESS_DEVICES.test(it.name ?? ""); }
const deviceEmpty = new Set<string>(); // 使えなかった (充填なし・充填中) 道具。階を移ると忘れる
function deviceReady(it: any): boolean {
  return it.qty > 0 && deviceCharges(it) !== 0 && !deviceEmpty.has(`${it.tval}:${it.name}`) && !/charging|\bempty\b/i.test(it.desc ?? "");
}
// 未知の杖を試すのは 1 階につき 1 種類 1 回。{tried} (使っても識別されなかった = 敵に効く杖: Sleep/Slow/Confuse Monsters など) は
// 次は見えている敵 (2-6 マス) がいる時に試す
const staffTriedLevel = new Set<string>();
let devicesUsed = 0, devicesTried = 0, lastDeviceAction = -99;
// 使い道のないと分かった道具は、安全な時にその場に落とす (no_selling では店に渡しても何も得ない。持ち物の枠が空く)。
// 落としたマスは拾わない・向かわない (この階だけ。DEVICES でなければ空のまま)
const droppedTiles = new Set<string>();
function sameEquipCategory(tval1: number, tval2: number): boolean {
  if (WEAPON_TVALS.has(tval1) && WEAPON_TVALS.has(tval2)) return true;
  if (ARMOR_TVALS.has(tval1) && ARMOR_TVALS.has(tval2)) return true;
  if (HEAD_TVALS.has(tval1) && HEAD_TVALS.has(tval2)) return true;
  return tval1 === tval2;
}

// ── 学習記録 ──
interface LessonLog {
  turn: number;
  depth: number;
  event: string;
  lesson: string;
}

const lessons: LessonLog[] = [];
let totalKills = 0;
let maxDepthReached = 0;
let maxLevelReached = 1;
let healingsUsed = 0;
let fleeAttempts = 0;
let deathCause = "";

// ── 録画システム ──
// Per-run scratch files (replay, wisdom, report); BUSHO_TMP keeps parallel native players apart.
const BUSHO_TMP = process.env.BUSHO_TMP ?? "/tmp";
const RECORD_PATH = `${BUSHO_TMP}/busho-replay.jsonl`;
let recordEnabled = process.env.ROLLOUT_FORCE ? false : true; // ロールアウト中は録画しない
// DANGER_LOG=1: what the player sees before every action, to ${BUSHO_TMP}/danger.jsonl.gz (training data for the learned
// danger model, tools/danger/record.ts). It only reads the state, so play is unchanged
const DANGER_LOG_PATH = process.env.DANGER_LOG === "1" && !process.env.ROLLOUT_FORCE ? `${BUSHO_TMP}/danger.jsonl.gz` : "";
let dangerLogger: DangerLogger | null = null;
// DANGER_MODEL=a.json[,b.json]: models from tools/overnight/danger.py. For now their predictions only go into the danger
// log (pd), so live calibration can be checked against the offline scores before any rule reads them
const DANGER_MODELS: DangerModel[] = (process.env.DANGER_MODEL ?? "").split(",").filter(Boolean).map((f) => DangerModel.load(f.trim()));
let frameNumber = 0;
const recordedFrames: string[] = [];

function recordFrame(state: any, event?: string) {
  if (!recordEnabled) return;
  const p = state.player;
  // プレイヤー周辺のみ記録 (壁は省略 — 再生時に推定)
  const viewR = 30;
  const cx = p.x, cy = p.y;
  const tiles = (state.map?.tiles ?? [])
    .filter((t: any) => {
      if (Math.abs(t.x - cx) > viewR || Math.abs(t.y - cy) > viewR / 2) return false;
      // 壁(21)は省略 — 空タイルが壁扱いになるのでビューアで復元可能
      if (t.feat === 21 && !t.hasObj) return false;
      return true;
    })
    .map((t: any) => {
      const dx = t.x - cx, dy = t.y - cy;
      const flags = (t.lit ? 1 : 0) | (t.hasObj ? 2 : 0);
      return [dx, dy, t.feat, flags];
    });
  const mons = (state.monsters ?? [])
    .filter((m: any) => m.distance <= 20)
    .map((m: any) => [m.x - cx, m.y - cy, m.name[0], m.hp, m.maxhp, m.name, m.level]);
  const frame: any = {
    f: frameNumber++,
    t: state.turn,
    d: state.depth,
    px: p.x, py: p.y,
    hp: p.hp, mhp: p.maxHp,
    cl: p.level, ac: p.ac ?? 0,
    food: p.timed?.food ?? 0,
    dead: state.dead || false,
    tiles, mons,
  };
  if (event) frame.ev = event;
  const msgs = (state.messages ?? []).slice(-2);
  if (msgs.length > 0) frame.msg = msgs.join(" | ").substring(0, 100);
  recordedFrames.push(JSON.stringify(frame));
}

async function flushRecording() {
  if (!recordEnabled) return;
  const fs = await import("node:fs");
  fs.writeFileSync(RECORD_PATH, recordedFrames.join("\n"));
  console.log(`  録画保存: ${RECORD_PATH} (${recordedFrames.length}フレーム)`);
}

// ── HTTP ヘルパー ──
let cmdDebug = false;
const CMD_DEBUG_AFTER = Number(process.env.CMD_DEBUG_AFTER ?? "") || Infinity; // debugging: log every command after this many commands
let commandsSent = 0;
let lastKnownState: any = null; // 直前のstate (confused検出用)
// 時間の進まないコマンド (C: 暗闇で読む/唱える、使えない呪文 など) のループ防止
let sendSeq = 0, noTimeStreak = 0;
const noTimeUntil: Record<number, number> = {};
function readBlocked(): boolean { return (noTimeUntil[CMD.READ] ?? 0) > sendSeq; }
function castBlocked(): boolean { return (noTimeUntil[CMD.CAST] ?? 0) > sendSeq; }
// RULEFIX=leave: 逃走の読み/詠唱か (Phase Door、Teleport 系の巻物、逃走スペル)。コマンド前の持ち物/スペルで判定
function isEscapeCommand(cmd: Record<string, unknown>): boolean {
  const pl = lastKnownState?.player;
  if (!pl) return false;
  if (cmd.type === CMD.READ) {
    const it = (pl.inventory ?? []).find((i: any) => i.slot === cmd.itemIndex);
    return /Phase Door|Teleport/.test(it?.name ?? "");
  }
  if (cmd.type === CMD.CAST) {
    const s = (pl.spells ?? []).find((x: any) => x.index === cmd.spellIndex);
    return /Phase Door|Teleport Self|Portal|Dimension Door/.test(s?.name ?? "");
  }
  return false;
}

async function sendCommand(cmd: Record<string, unknown>): Promise<any> {
  sendSeq++;
  if (noTimeStreak >= 30) {
    console.log(`  [CMD-GUARD] ${noTimeStreak} commands passed no time: holding a turn instead of ${JSON.stringify(cmd)}`);
    cmd = { type: CMD.SEARCH };
    noTimeStreak = 0;
  }
  const turnBefore = lastKnownState?.turn;
  // 混乱中のREAD/CASTは必ず失敗する → RESTに差し替えて無限ループ防止
  if (lastKnownState?.player?.timed?.confused > 0 && (cmd.type === CMD.READ || cmd.type === CMD.CAST)) {
    console.log(`  [CMD-GUARD] confused中のREAD/CASTをRESTに差し替え`);
    cmd = { type: CMD.REST };
  }
  const escapeCmd = LEAVE && isEscapeCommand(cmd); // RULEFIX=leave: この階の逃走回数に数える (時間が進んだら)
  if (cmdDebug || ++commandsSent >= CMD_DEBUG_AFTER) console.log(`    >> CMD: ${JSON.stringify(cmd)}`);
  dangerLogger?.noteCommand(cmd.type as number);
  for (let retry = 0; retry < 5; retry++) {
    const res = await fetch(`${API}/command${VIEW_QS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    const data = await res.json();
    if (res.status === 503) {
      // Game loop not ready yet, wait and retry
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    if (res.status !== 200) {
      // Return refreshed state on error
      const s = await getState();
      lastKnownState = s;
      return s;
    }
    lastKnownState = adaptPlayerView(data);
    if (typeof turnBefore === "number" && lastKnownState?.turn === turnBefore) {
      noTimeStreak++;
      if (cmd.type === CMD.READ || cmd.type === CMD.CAST) noTimeUntil[cmd.type as number] = sendSeq + 20;
    } else {
      noTimeStreak = 0;
      if (escapeCmd) levelEscapes++;
    }
    return lastKnownState;
  }
  // All retries failed — return refreshed state, don't loop
  const s = await getState();
  lastKnownState = s;
  return s;
}

async function getState(): Promise<any> {
  const res = await fetch(`${API}/state${VIEW_QS}`);
  return adaptPlayerView(await res.json());
}

// ── LLM戦略判断 ──
// ルールで判断しにくい場面でLLM(Claude haiku)に聞く

const LLM_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
// System One decision model: local Kev (http://localhost:8009) or hosted Jev (https://api.typesafe.ai)
const SYSTEMONE_URL = (process.env.SYSTEMONE_URL ?? "").replace(/\/+$/, "");
const SYSTEMONE_API_KEY = process.env.SYSTEMONE_API_KEY || process.env.TYPESAFE_API_KEY || "";
const SYSTEMONE_MODEL = process.env.SYSTEMONE_MODEL ?? "kev-latest";
const DECISION_MIN_CONFIDENCE = Number(process.env.DECISION_MIN_CONFIDENCE ?? "0.3"); // これ未満の確信度はルールに任せる
const LLM_BACKEND = process.env.LLM_BACKEND ?? (SYSTEMONE_URL ? "systemone" : LLM_API_KEY ? "anthropic" : "ollama"); // "systemone", "anthropic" or "ollama"
const LLM_ENABLED = LLM_BACKEND === "anthropic" ? LLM_API_KEY.length > 0
  : LLM_BACKEND === "systemone" ? SYSTEMONE_URL.length > 0
  : true;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "phi3.5";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
let llmCallCount = 0;
let llmCacheHits = 0;
let llmTotalMs = 0;

// ── クロスラン記憶: 過去の走行から学んだ教訓をLLMに渡す ──
const WISDOM_FILE = `${BUSHO_TMP}/busho-wisdom.jsonl`;
interface WisdomEntry {
  seed: number; maxDL: number; maxCL: number; deathDL: number; deathCause: string;
  hadResists: string; ac: number; dps: number; blows: number;
  lesson: string; // 自然言語の教訓
}
let wisdomEntries: WisdomEntry[] = [];
try {
  const fs = require("node:fs");
  if (fs.existsSync(WISDOM_FILE)) {
    const lines = fs.readFileSync(WISDOM_FILE, "utf-8").trim().split("\n").filter(Boolean);
    wisdomEntries = lines.map((l: string) => JSON.parse(l));
    console.log(`  [WISDOM] 過去の教訓読込: ${wisdomEntries.length}件`);
  }
} catch {}

function saveWisdom(entry: WisdomEntry) {
  try {
    const fs = require("node:fs");
    fs.appendFileSync(WISDOM_FILE, JSON.stringify(entry) + "\n");
    wisdomEntries.push(entry);
  } catch {}
}

function wisdomContext(): string {
  if (wisdomEntries.length === 0) return "";
  // 最新10件 + 最高DL到達の記録を含める
  const sorted = [...wisdomEntries].sort((a, b) => b.maxDL - a.maxDL);
  const best = sorted.slice(0, 3);
  const recent = wisdomEntries.slice(-5);
  const unique = [...new Map([...best, ...recent].map(e => [e.lesson, e])).values()];
  const lines = unique.map(e =>
    `DL${e.deathDL}/CL${e.maxCL} died to ${e.deathCause} (resist:${e.hadResists} AC:${e.ac} DPS:${e.dps} ${e.blows}blows): ${e.lesson}`
  );
  return `\nPast run lessons:\n${lines.join("\n")}`;
}

// 死亡時に教訓を自動生成
function generateDeathWisdom(state: any, deathCause: string): string {
  const p = state.player;
  const resists = (p.resistances ?? []).filter((r: any) => r.level > 0).map((r: any) => r.elem);
  const hasAllBase = ["ACID","ELEC","FIRE","COLD"].every(e => resists.includes(e));
  const hasPois = resists.includes("POIS");
  const lessons: string[] = [];

  if (deathCause.includes("falcon") || deathCause.includes("blood")) {
    lessons.push("Speed 130+ enemies (blood falcon) require instant WoR — Phase Door and Teleport are insufficient");
  }
  if (deathCause.includes("hydra")) {
    lessons.push("Multi-headed hydras have very high HP/AC — avoid combat, use Teleport to flee");
  }
  if (deathCause.includes("dragon")) {
    lessons.push(`Dragon breath is deadly ${!hasAllBase ? "without base resists" : "even with resists"} — prioritize elemental resistance gear before deep diving`);
  }
  if (deathCause.includes("knight") || deathCause.includes("Troll")) {
    lessons.push(`High-damage melee enemies at DL${state.depth}+ — need AC ${(p.ac ?? 0) < 80 ? ">80" : ">100"} and healing reserves >10`);
  }
  if (deathCause.includes("poison") || deathCause.includes("venom") || deathCause.includes("scorpion")) {
    lessons.push("Poison damage is lethal without POIS resist — prioritize poison resistance at DL25+");
  }
  if (!hasAllBase && state.depth >= 25) {
    lessons.push(`Died at DL${state.depth} with only ${resists.length} resists — need all 4 base resists before DL25`);
  }
  if ((p.ac ?? 0) < 60 && state.depth >= 20) {
    lessons.push(`AC ${p.ac} too low for DL${state.depth} — ensure equipment upgrades are being worn`);
  }
  if (lessons.length === 0) {
    lessons.push(`Died at DL${state.depth} to ${deathCause} — consider more cautious descent or better supplies`);
  }
  return lessons.join(". ");
}

async function askLLM(question: string, context: string): Promise<string> {
  if (!LLM_ENABLED) return "";

  llmCallCount++;
  const start = Date.now();
  try {
    let answer = "";

    if (LLM_BACKEND === "ollama") {
      // Ollama (local)
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          prompt: `You are an expert Angband roguelike player. Answer concisely.
${wisdomContext()}
${context}

${question}

Answer (start with YES or NO, then one short reason):`,
          stream: false,
          options: { num_predict: 30 },
        }),
      });
      const data = await res.json() as any;
      answer = data?.response ?? "";
    } else {
      // Anthropic API
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": LLM_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 80,
          messages: [{
            role: "user",
            content: `You are an expert Angband player AI. Answer concisely in one line.
${wisdomContext()}
Game state:
${context}

Question: ${question}

Answer (one line, start with YES/NO or the choice):`,
          }],
        }),
      });
      const data = await res.json() as any;
      answer = data?.content?.[0]?.text ?? "";
    }

    llmTotalMs += Date.now() - start;
    const ms = Date.now() - start;
    console.log(`  [LLM ${LLM_BACKEND}] Q: ${question.slice(0, 55)} → ${answer.slice(0, 70)} (${ms}ms)`);

    return answer;
  } catch (e) {
    llmTotalMs += Date.now() - start;
    return "";
  }
}

// ── System One (Kev / Jev): 型付き質問 → 確率付きの回答 ──
type SystemOneQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

async function askSystemOne(questions: Record<string, SystemOneQuestion>, context: string): Promise<Record<string, any> | null> {
  if (!LLM_ENABLED) return null;

  llmCallCount++;
  const start = Date.now();
  try {
    const res = await fetch(`${SYSTEMONE_URL}/v1/systemone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(SYSTEMONE_API_KEY ? { Authorization: `Bearer ${SYSTEMONE_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: SYSTEMONE_MODEL,
        state: context, // tools/decision の state (wisdomContext なし)
        questions,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const ms = Date.now() - start;
    llmTotalMs += ms;
    if (!res.ok) {
      console.log(`  [LLM systemone] HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
      return null;
    }
    const answers = ((await res.json()) as any)?.answers ?? null;
    for (const [id, a] of Object.entries<any>(answers ?? {})) {
      const summary = a.type === "noul" ? `p(yes)=${a.noul}` : `${a.choice} conf=${a.confidence}`;
      console.log(`  [LLM systemone] Q: ${questions[id]?.instructions.slice(0, 55)} → ${summary} (${ms}ms)`);
    }
    return answers;
  } catch (e) {
    llmTotalMs += Date.now() - start;
    console.log(`  [LLM systemone] error: ${(e as Error).message}`);
    return null;
  }
}

// choice: 確信度が低ければ null (ルールに任せる)
async function decideChoice(req: DecisionRequest): Promise<string | null> {
  const answers = await askSystemOne(req.questions, req.state);
  const a = answers?.decision;
  const criteria = req.questions.decision.criteria;
  if (!a || !(a.choice in criteria) || a.confidence < DECISION_MIN_CONFIDENCE) return null;
  return a.choice as string;
}

function gameContextString(state: any): string {
  const p = state.player;
  const monsters = state.monsters ?? [];
  const inv = p.inventory ?? [];
  const equip = p.equipment ?? [];
  const nearby = monsters.filter((m: any) => m.distance <= 6).slice(0, 5);
  const healPots = inv.filter((i: any) => i.name?.includes("Cure") || i.name?.includes("Healing"));
  const totalHeals = healPots.reduce((s: number, i: any) => s + (i.qty ?? 1), 0);
  const teleScrolls = inv.filter((i: any) => i.name?.includes("Teleport")).reduce((s: number, i: any) => s + (i.qty ?? 1), 0);
  const phaseScrolls = inv.filter((i: any) => i.name?.includes("Phase Door")).reduce((s: number, i: any) => s + (i.qty ?? 1), 0);
  const recallScrolls = inv.filter((i: any) => i.name?.includes("Word of Recall")).reduce((s: number, i: any) => s + (i.qty ?? 1), 0);
  const speedPots = inv.filter((i: any) => i.name?.includes("Speed")).reduce((s: number, i: any) => s + (i.qty ?? 1), 0);
  const resists = (p.resistances ?? []).filter((r: any) => r.level > 0).map((r: any) => r.elem);

  return `CL${p.level} DL${state.depth} HP:${p.hp}/${p.maxHp} AC:${p.ac ?? "?"} Speed:${p.speed} Blows:${p.numBlows ?? "?"}
Heals:${totalHeals} Phase:${phaseScrolls} Teleport:${teleScrolls} WoR:${recallScrolls} Speed:${speedPots}
Resists: ${resists.length > 0 ? resists.join(",") : "none"}
Equipment: ${equip.map((e: any) => e.name).join(", ") || "none"}
Nearby monsters: ${nearby.map((m: any) => `${m.name}(Lv${m.level},HP${m.hp}/${m.maxhp},spd${m.speed},dist${m.distance}${m.isUnique ? ",UNIQUE" : ""}${m.breathElements?.length ? ",BREATH:" + m.breathElements.join("/") : ""})`).join(", ") || "none"}`;
}

// ── 判断の入口 (全6フックがここを通る) ──
// DECISION_LOG=1: モデルは呼ばずに記録だけ行い null を返す (ルールが決める)
const DECISION_LOG = process.env.DECISION_LOG === "1";
const DECISION_LOG_DIR = process.env.DECISION_LOG_DIR ?? `${BUSHO_TMP}/decisions`;
// ROLLOUT_FORCE=<type>:<option>: ルールのみで続行し、最初の decide(<type>) だけ強制オプションを返す (Phase 2 ラベリング用)
const ROLLOUT_FORCE = process.env.ROLLOUT_FORCE ?? "";
const ROLLOUT = ROLLOUT_FORCE !== "";
const [ROLLOUT_TYPE, ROLLOUT_OPTION] = ROLLOUT_FORCE.split(":");
const ROLLOUT_HORIZON = Number(process.env.ROLLOUT_HORIZON ?? "150");
const ROLLOUT_MAX_WAIT = Number(process.env.ROLLOUT_MAX_WAIT ?? "5");
let rolloutFired = false;
// /state の player に exp-to-next は無いので 4.2 の player_exp 表 × 種族 expfact から推定 (クラスの expfact は 4.2 では 0)
const PLAYER_EXP = [10, 25, 45, 70, 100, 140, 200, 280, 380, 500, 650, 850, 1100, 1400, 1800, 2300, 2900, 3600, 4400, 5400,
  6800, 8400, 10200, 12500, 17500, 25000, 35000, 50000, 75000, 100000, 150000, 200000, 275000, 350000, 450000, 550000, 700000, 850000, 1000000, 1250000,
  1500000, 1800000, 2100000, 2400000, 2700000, 3000000, 3500000, 4000000, 4500000, 5000000];
const RACE_EXPFACT: Record<string, number> = { Human: 100, "Half-Elf": 120, Elf: 120, Hobbit: 120, Gnome: 120, Dwarf: 120, "Half-Orc": 120, "Half-Troll": 120, Dunadan: 120, "High-Elf": 145, Kobold: 120 };
function expToNextLevel(p: any): number | null {
  if (typeof p.expToNext === "number") return p.expToNext; // サーバが出すようになったらそれを使う
  const f = RACE_EXPFACT[p.race];
  const need = PLAYER_EXP[p.level - 1];
  if (f === undefined || need === undefined) return null;
  return Math.max(0, Math.floor(need * f / 100) - (p.exp ?? 0));
}
let rolloutActions = 0;
let minHpFrac = 1; // ロールアウト中の最低HP割合 (危険度の指標)
let rolloutDepthMax = 0; // ロールアウト中の最大深度 (長期ロールアウトの価値 = 深度 − 3×死亡)
// ROLLOUT_CHECKPOINTS=50,150,500: その行動数での状態を記録 (1本の長いロールアウトから複数ホライズンを測る, Session 7)
const ROLLOUT_CHECKPOINTS = new Set((process.env.ROLLOUT_CHECKPOINTS ?? "").split(",").filter(Boolean).map(Number));
const rolloutCheckpoints: { a: number; depth: number; dmax: number; hp: number; mhp: number; exp: number }[] = [];
// DECISION_TRIGGERS=wide: ログモードと同じ広いトリガー集合を、ログなしでも使う (評価/DAgger 用)。既定は従来のゲート
const DECISION_TRIGGERS = process.env.DECISION_TRIGGERS ?? "default";
const LOGLIKE = DECISION_LOG || DECISION_TRIGGERS === "wide"; // ログモード相当のトリガー/追加質問
const WIDE = LOGLIKE || ROLLOUT; // 判断トリガーを広げる (ログ/ロールアウトで同じ地点に到達するため)
// DECISION_POLICY=model (DECISION_LOG=1 と併用): ログを書きつつモデルの答えで実際に行動する。
// モデル呼び出し失敗/確信度 < DECISION_MIN_CONFIDENCE ならルールにフォールバック (acted: "rules")
const DECISION_POLICY = process.env.DECISION_POLICY ?? "rules";
const POLICY_MODEL = DECISION_LOG && DECISION_POLICY === "model";
// DECISION_MODEL_TYPES=fight,tactic: モデル方策でもモデルに聞くのはこの型だけ (学習していない型はルール)
const DECISION_MODEL_TYPES = new Set((process.env.DECISION_MODEL_TYPES ?? "").split(",").map((t) => t.trim()).filter(Boolean));
const DECISION_ON = (LLM_ENABLED && !ROLLOUT) || WIDE; // 呼出側のゲート用
const GAME_START_TS = Date.now();
const GAME_SEED = process.env.SEED ?? process.env.GAME_SEED ?? null; // サーバの--seed (stateには出ない)
// プレイヤー自身の乱数 (混乱中・停滞時のランダム移動): PLAYER_RNG_SEED/SEEDで固定し、同じseedで同じゲームを再現する (Session 6)
const PLAYER_RNG_SEED = process.env.PLAYER_RNG_SEED ?? GAME_SEED;
let rngState = PLAYER_RNG_SEED !== null ? (Number(PLAYER_RNG_SEED) >>> 0) || 1 : (Math.random() * 2 ** 32) >>> 0;
function rand(): number { // mulberry32
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

interface DecideCtx {
  state: any;
  rules: string | null;      // ルールが実際に取る選択 (ログ用)
  monster?: any; enemies?: any[]; hpPct?: number;
  kills?: number; turns?: number; current?: any; candidate?: any;
}

function buildRequest(type: DecisionType, c: DecideCtx): DecisionRequest {
  switch (type) {
    case "fight": return fightDecision(c.state, c.monster);
    case "tactic": return tacticDecision(c.state, c.enemies ?? [], c.hpPct ?? 0);
    case "recall": return recallDecision(c.state);
    case "descend": return descendDecision(c.state);
    case "explore": return exploreDecision(c.state, c.kills ?? 0, c.turns ?? 0);
    case "equip": return equipDecision(c.state, c.current, c.candidate);
  }
}

// MODEL_GUARD=oil,potion,flee: モデル方策で消耗品を使い切る/逃走を覆す答えをルールの選択に戻す (Session 3)
const MODEL_GUARD = new Set((process.env.MODEL_GUARD ?? "").split(",").map((t) => t.trim()).filter(Boolean));
// MODEL_COOLDOWN=fight=150,tactic=50 (または数値1つ): モデルがルールを覆したら、その行動数だけルールに任せる。
// ラベルが測ったのは「1回覆して以降ルール」なので、覆しが連続する方策との差を測る (Session 8)
const MODEL_COOLDOWN: Record<string, number> = {};
for (const kv of (process.env.MODEL_COOLDOWN ?? "").split(",").filter(Boolean)) {
  const [t, n] = kv.includes("=") ? kv.split("=") : ["*", kv];
  MODEL_COOLDOWN[t] = Number(n) || 0;
}
const cooldownFor = (type: string) => MODEL_COOLDOWN[type] ?? MODEL_COOLDOWN["*"] ?? 0;
let modelCooldownUntil = -1; // この行動数まではモデルの覆しを使わない
const itemCount = (inv: any[], pred: (it: any) => boolean): number =>
  inv.filter((it: any) => it && pred(it)).reduce((n: number, it: any) => n + (it.qty ?? 1), 0);
/** 発動したガード名 (null なら通す) */
function modelGuard(type: DecisionType, c: DecideCtx, choice: string): string | null {
  if (!MODEL_GUARD.size || choice === c.rules) return null;
  const p = c.state?.player ?? {};
  const inv = p.inventory ?? [];
  if (MODEL_GUARD.has("flee") && c.rules === "flee" && (choice === "throw" || choice === "melee" || choice === "fight")) return "flee";
  if (MODEL_GUARD.has("oil") && type === "fight" && choice === "throw") {
    const flasks = itemCount(inv, (it) => it.tval === TVAL.FLASK);
    if (flasks <= 3 && !(c.monster && meleeTooCostly(c.monster, p))) return "oil";
  }
  if (MODEL_GUARD.has("potion") && type === "tactic" && choice === "heal") {
    const cures = itemCount(inv, (it) => it.tval === TVAL.POTION && String(it.name ?? "").includes("Cure"));
    if (cures <= 2 && (c.hpPct ?? 1) >= 0.5) return "potion";
  }
  return null;
}

// 返り値はオプション名。null ならルールに任せる。
async function decide(type: DecisionType, c: DecideCtx): Promise<string | null> {
  if (ROLLOUT) {
    if (!rolloutFired && type === ROLLOUT_TYPE && rolloutActions <= ROLLOUT_MAX_WAIT) {
      rolloutFired = true;
      console.log(`  [ROLLOUT] ${type} 強制: ${ROLLOUT_OPTION} (rules=${c.rules})`);
      return ROLLOUT_OPTION!;
    }
    return null;
  }
  if (DECISION_LOG) {
    const req = buildRequest(type, c);
    if (!POLICY_MODEL || (DECISION_MODEL_TYPES.size > 0 && !DECISION_MODEL_TYPES.has(type))) {
      await logDecision(type, c, req);
      return null;
    }
    // モデル方策: モデルに聞いて記録し、十分な確信度ならその答えで行動する
    let modelChoice: string | null = null;
    let modelConfidence: number | null = null;
    if (LLM_ENABLED) {
      if (LLM_BACKEND === "systemone") {
        const answers = await askSystemOne(req.questions, req.state);
        const a = answers?.decision;
        if (a && typeof a.choice === "string" && a.choice in req.questions.decision.criteria) {
          modelChoice = a.choice;
          modelConfidence = typeof a.confidence === "number" ? a.confidence : null;
        }
      } else {
        modelChoice = await decideText(type, c); // 自由文バックエンドは確信度なし
      }
    }
    let useModel = modelChoice !== null && (modelConfidence === null || modelConfidence >= DECISION_MIN_CONFIDENCE);
    const guard = useModel ? modelGuard(type, c, modelChoice!) : null;
    if (guard) useModel = false;
    let ration: string | null = null;
    if (useModel && modelChoice !== c.rules && cooldownFor(type) > 0) {
      if (rolloutActions < modelCooldownUntil) { useModel = false; ration = "cooldown"; }
      else modelCooldownUntil = rolloutActions + cooldownFor(type);
    }
    await logDecision(type, c, req, { model_choice: modelChoice, model_confidence: modelConfidence, acted: useModel ? "model" : "rules",
      actions: rolloutActions, ...(guard ? { guard } : {}), ...(ration ? { ration } : {}) });
    return useModel ? modelChoice : null;
  }
  if (!LLM_ENABLED) return null;
  if (LLM_BACKEND === "systemone") return decideChoice(buildRequest(type, c));
  return decideText(type, c);
}

// ollama / anthropic: 自由文の回答をオプションへ
async function decideText(type: DecisionType, c: DecideCtx): Promise<string | null> {
  const ctx = gameContextString(c.state);
  const yn = (answer: string, yes: string, no: string): string | null => {
    const up = answer.toUpperCase();
    if (up.startsWith("YES")) return yes;
    if (up.startsWith("NO")) return no;
    return null;
  };
  switch (type) {
    case "fight": {
      const m = c.monster;
      const answer = await askLLM(
        `Should I fight ${m.name} (Lv${m.level}, HP${m.maxhp}, speed ${m.speed}${m.isUnique ? ", UNIQUE" : ""}) or flee? Consider my HP, healing supplies, and level.`,
        ctx
      );
      if (answer.toUpperCase().startsWith("YES") || answer.toUpperCase().includes("FIGHT")) return "melee";
      if (answer.toUpperCase().startsWith("NO") || answer.toUpperCase().includes("FLEE")) return "flee";
      return null; // ambiguous → rules decide
    }
    case "descend":
      return yn(await askLLM(
        `Should I descend to the next dungeon level? Consider my CL vs DL, healing/teleport supplies, equipment quality, and resistances.`,
        ctx
      ), "descend", "stay");
    case "equip": {
      const cur = c.current, cand = c.candidate;
      const q = `Should I swap ${cur?.name ?? "empty"} (resists: ${itemResistNames(cur)}) for ${cand.name} (resists: ${itemResistNames(cand)})? In Angband, elemental resists are CRITICAL for survival in deep dungeon. Weight affects number of blows.`;
      return yn(await askLLM(q, ctx), "swap", "keep");
    }
    case "tactic": {
      const enemyStr = (c.enemies ?? []).slice(0, 3).map((m: any) =>
        `${m.name}(Lv${m.level},HP${m.hp},spd${m.speed}${m.isUnique ? ",UNQ" : ""})`).join(", ");
      const answer = await askLLM(
        `HP ${Math.round((c.hpPct ?? 0)*100)}% with ${(c.enemies ?? []).length} adjacent enemies: ${enemyStr}. Should I HEAL (use potion), FLEE (teleport away), or FIGHT (keep attacking)?`,
        ctx
      );
      const up = answer.toUpperCase();
      if (up.includes("HEAL")) return "heal";
      if (up.includes("FLEE") || up.includes("TELEPORT") || up.includes("ESCAPE")) return "flee";
      if (up.includes("FIGHT") || up.includes("ATTACK")) return "fight";
      return null;
    }
    case "recall":
      return yn(await askLLM(
        `Should I use Word of Recall to return to town? Consider my HP, healing supplies, and the danger level at current depth. Low supplies or dangerous depth = YES.`,
        ctx
      ), "recall", "continue");
    case "explore":
      return yn(await askLLM(
        `I've killed ${c.kills} monsters and spent ${c.turns} turns on DL${c.state.depth}. Should I keep exploring this level for more XP/items (YES) or descend to the next level (NO)? Consider my CL vs DL ratio and equipment readiness.`,
        ctx
      ), "explore", "descend");
  }
}

function itemResistNames(item: any): string {
  const names = ["ACID","ELEC","FIRE","COLD","POIS","LIGHT","DARK","SOUND","SHARD","NEXUS","NETHER","CHAOS","DISEN"];
  const rs = (item?.resists ?? []).filter((r: any) => r.level > 0).map((r: any) => names[r.elem] ?? `elem${r.elem}`);
  return rs.join(",") || "none";
}

// ── DECISION_LOG: 判断点を JSONL + スナップショットで記録 ──
let snapshotWarned = false;
let snapshotMissing = false; // 404 → 以後呼ばない
let decisionGameId: string | null = null;

async function takeSnapshot(gameId: string, turn: number, type: DecisionType): Promise<string | null> {
  if (snapshotMissing) return null;
  const warn = (msg: string) => {
    if (!snapshotWarned) { snapshotWarned = true; console.log(`  [DECISION_LOG] snapshot unavailable (${msg}); storing null`); }
  };
  try {
    let res: Response | null = null;
    for (let retry = 0; retry < 3; retry++) {
      res = await fetch(`${API}/snapshot`);
      if (res.status !== 409) break; // ループが待機中でない → 少し待って再試行
      await new Promise(r => setTimeout(r, 50));
    }
    if (!res || !res.ok) {
      if (res?.status === 404) snapshotMissing = true;
      warn(`HTTP ${res?.status}`);
      return null;
    }
    const body = await res.text();
    const fs = await import("node:fs");
    const zlib = await import("node:zlib");
    const rel = `snapshots/${gameId}-${turn}-${type}.json.gz`;
    fs.mkdirSync(`${DECISION_LOG_DIR}/snapshots`, { recursive: true });
    fs.writeFileSync(`${DECISION_LOG_DIR}/${rel}`, zlib.gzipSync(body));
    return rel;
  } catch (e) {
    warn((e as Error).message);
    return null;
  }
}

async function logDecision(type: DecisionType, c: DecideCtx, req: DecisionRequest, extra: Record<string, unknown> = {}) {
  try {
    const st = c.state;
    if (!decisionGameId) {
      decisionGameId = `${GAME_SEED ?? "noseed"}-${st.player.race}-${st.player.class}-${GAME_START_TS}`
        .toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
    }
    const snapshot = await takeSnapshot(decisionGameId, st.turn, type);
    const rec = {
      format_version: PLAYER_VIEW ? DECISION_FORMAT_VERSION_PLAYER : DECISION_FORMAT_VERSION,
      game_id: decisionGameId,
      seed: GAME_SEED === null ? null : Number(GAME_SEED),
      race: st.player.race,
      class: st.player.class,
      start_ts: GAME_START_TS,
      decision_type: type,
      turn: st.turn,
      depth: st.depth,
      player_level: st.player.level,
      state: req.state,
      questions: req.questions,
      snapshot,
      rules_choice: c.rules,
      ...extra,
    };
    const fs = await import("node:fs");
    fs.mkdirSync(DECISION_LOG_DIR, { recursive: true });
    fs.appendFileSync(`${DECISION_LOG_DIR}/decisions.jsonl`, JSON.stringify(rec) + "\n");
    decisionLogCounts[type] = (decisionLogCounts[type] ?? 0) + 1;
  } catch (e) {
    console.log(`  [DECISION_LOG] error: ${(e as Error).message}`);
  }
}
const decisionLogCounts: Record<string, number> = {};

// /snapshot 本文 (JSON文字列)。ループ待機中でない (409) 時は少し待って再試行
async function fetchSnapshotBody(): Promise<string | null> {
  if (snapshotMissing) return null;
  try {
    for (let retry = 0; retry < 5; retry++) {
      const res = await fetch(`${API}/snapshot`);
      if (res.status === 409) { await new Promise(r => setTimeout(r, 50)); continue; }
      if (!res.ok) { if (res.status === 404) snapshotMissing = true; return null; }
      return await res.text();
    }
  } catch {}
  return null;
}
const savepointBank = new SavepointBank();
function gameIdOf(st: any): string {
  if (!decisionGameId) {
    decisionGameId = `${GAME_SEED ?? "noseed"}-${st.player.race}-${st.player.class}-${GAME_START_TS}`
      .toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
  }
  return decisionGameId;
}

// 序盤の買い物: 予算内で 油 > Phase > 掘削具(Shovel) > CLW の優先順 (全店を見て最安を買う)。深層用リストは buySupplies
// 4.2.6 の always 品 (油/Phase/CLW/Shovel/Pick) は常に在庫あり。まとめ買い (quantity) 対応。
// Word of Recall は買わない (初期所持1本を温存)。Pick(300G)は高価なので Shovel(10G)を買う。持ち物に入れるだけで装備しない
// 予備の松明 (燃料の多い順)。fuel は C だけが返す
function spareTorchSlot(inv: any[]): number | null {
  const t = inv.filter((i: any) => i.tval === TVAL.LIGHT && /Torch/i.test(i.name ?? "") && i.qty > 0 && (i.fuel ?? 0) > 0)
    .sort((a: any, b: any) => (b.fuel ?? 0) - (a.fuel ?? 0))[0];
  return t ? t.slot : null;
}

// 食料を最優先 (vanilla は初期資金が少なく、食料が後回しだと餓死する)
// RULEFIX=neutpois: CLW/CSW は毒を治さない (4.2)。Neutralize Poison (錬金術店、75G) を CLW 3 個の次に 1 個、最後に 2 個まで
const EARLY_KIT_STEPS: [string, number][] = [["food", 3], ["torch", 2], ["oil", 5], ["phase", 2], ["digger", 1], ["oil", 10], ["phase", 5],
  ["clw", 3], ...(RULEFIX.has("neutpois") ? [["neut", 1] as [string, number]] : []), ["clw", 5], ["csw", 2],
  ...(RULEFIX.has("neutpois") ? [["neut", 2] as [string, number]] : []), ["food", FOOD_KEEP],
  // RULEFIX=kitmore: 残金があれば Phase 10 枚、CLW 8 個まで (session 20: 死亡の 8 割は Phase も回復薬もなし)
  ...(RULEFIX.has("kitmore") ? [["phase", 10], ["clw", 8]] as [string, number][] : [])];
async function buyEarlyKit(steps: [string, number][] = EARLY_KIT_STEPS): Promise<void> {
  // RULEFIX=sling: 生まれた直後の買い物で、射撃武器がなければスリングを買って装備 (弾は下の ammo で 20 発)
  const slingBought = SLING && steps === EARLY_KIT_STEPS && (await getState()).turn < 100 ? await buySling() : false;
  // RULEFIX=fire: 射撃武器があれば、光源の次に矢弾を 30 本まで (雑貨屋に常にある。ammo60 なら 60 本)
  const kitPlayer = (await getState()).player;
  const ammoTval = RULEFIX.has("fire") ? launcherAmmoTval(kitPlayer) : null;
  const slingAmmo = SLING && /Sling/i.test((kitPlayer.equipment ?? []).find((e: any) => e.tval === TVAL.BOW)?.name ?? "");
  if (ammoTval !== null && steps === EARLY_KIT_STEPS) steps = [...steps.slice(0, 2), ["ammo", slingAmmo ? SLING_SHOTS : RULEFIX.has("ammo60") ? 60 : 30], ...steps.slice(2)];
  // RULEFIX=sling: スリングと弾で所持金が減る分、油の目標を半分に
  if (slingBought && kitPlayer.gold < SLING_OIL_GOLD) steps = steps.map(([k, n]) => [k, k === "oil" ? Math.ceil(n / 2) : n] as [string, number]);
  const kinds: Record<string, (i: any) => boolean> = {
    food: i => i.tval === TVAL.FOOD && (i.name ?? "").includes("Ration"),
    torch: i => i.tval === TVAL.LIGHT && (i.name ?? "").includes("Wooden Torch"),
    oil: i => i.tval === TVAL.FLASK && (i.name ?? "").includes("Flask"),
    phase: i => i.tval === TVAL.SCROLL && (i.name ?? "").includes("Phase Door"),
    digger: i => i.tval === TVAL.DIGGING && (i.name ?? "").includes("Shovel"),
    clw: i => i.tval === TVAL.POTION && (i.name ?? "") === "Cure Light Wounds",
    csw: i => i.tval === TVAL.POTION && (i.name ?? "") === "Cure Serious Wounds", // CLW が置いてない店の代用
    ammo: i => ammoTval !== null && i.tval === ammoTval,
    neut: i => i.tval === TVAL.POTION && (i.name ?? "") === "Neutralize Poison",
  };
  const haveOf = (inv: any[], kind: string) =>
    kind === "digger"
      ? inv.filter(i => i.tval === TVAL.DIGGING && i.qty > 0).reduce((a, i) => a + i.qty, 0)
      : inv.filter(i => kinds[kind]!(i) && i.qty > 0).reduce((a, i) => a + i.qty, 0);
  const bought: Record<string, number> = { food: 0, torch: 0, oil: 0, phase: 0, digger: 0, clw: 0, csw: 0, ammo: 0, neut: 0 };
  let spent = 0, n = 0;
  for (const [kind, target] of steps) {
    const test = kinds[kind]!;
    for (let guard = 0; guard < 6 && n < 40; guard++) {
      const st = await getState();
      if (st.depth !== 0 || !st.stores) return;
      const have = haveOf(st.player.inventory as any[], kind);
      if (have >= target) break;
      let best: { storeType: number; item: any } | null = null;
      for (const store of st.stores as any[]) {
        if (![0, 3, 4, 5, 6].includes(store.type)) continue;
        if (kind === "neut" && store.type !== 4) continue; // 錬金術店だけ (闇市は 225G)
        for (const it of store.stock) {
          if (!test(it) || it.price <= 0 || it.price > st.player.gold) continue;
          if (!best || it.price < best.item.price) best = { storeType: store.type, item: it };
        }
      }
      if (!best) break;
      const qty = Math.max(1, Math.min(target - have, Math.floor(st.player.gold / best.item.price), best.item.number ?? 1));
      const res = await fetch(`${API}/buy`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeType: best.storeType, itemIndex: best.item.index, quantity: qty }),
      });
      const r: any = await res.json();
      n++;
      if (!r.success) break;
      bought[kind]! += qty; spent += best.item.price * qty;
    }
  }
  const after = await getState();
  console.log(`  [序盤購入] food+${bought.food} torch+${bought.torch} oil+${bought.oil} phase+${bought.phase} digger+${bought.digger} clw+${bought.clw} csw+${bought.csw} neut+${bought.neut} ammo+${bought.ammo} (${spent}G使用, 残金${after.player.gold}G)`);
  addLesson(0, 0, "序盤購入", `food+${bought.food} oil+${bought.oil} phase+${bought.phase} digger+${bought.digger} clw+${bought.clw}。残金${after.player.gold}G`);
}

const MAX_ACTIONS = Number(process.env.MAX_ACTIONS ?? "100000"); // テスト用の早期終了

// LLM判断: この敵と戦うべきか逃げるべきか (rules: ルールは戦う)
type FightChoice = "melee" | "throw" | "flee";
async function decideFight(state: any, monster: any, rules: FightChoice): Promise<FightChoice | null> {
  const choice = await decide("fight", { state, monster, rules });
  return choice === "melee" || choice === "throw" || choice === "flee" ? choice : null;
}
// 個体ごとに決まった fight 判断 (モデル/強制)。ルール任せの個体は入らない
const fightPlan = new Map<string, FightChoice>();
const fleeSteps = new Map<string, number>();
// サーバに射線なしで拒否された投擲 ("px,py>mx,my")。同じ地点からは投げずに殴る (拒否はターンが進まず無限ループになる)
const noThrowLOS = new Set<string>();
let shotsFired = 0, throwHits = 0, throwKills = 0, throwsMade = 0, earlyFleeActions = 0, earlyFleeStairs = 0, phasesRead = 0, lastEarlyPhaseAction = -99;

// ルール自身の fight 分類: 序盤の高速/強敵は 油 > 逃走 > 殴る
function rulesFightChoice(m: any, plevel: number, inv: any[], tiles: any[], px: number, py: number): FightChoice {
  if (!lowCLDanger(m, plevel) && !(lastKnownState?.player && meleeTooCostly(m, lastKnownState.player))) return "melee";
  if (findOilFlask(inv) !== null && m.distance <= THROW_RANGE && hasLOS(tiles, px, py, m.x, m.y)) return "throw";
  const st = nearestStair(tiles, px, py);
  if (findPhaseScroll(inv) !== null || (st !== null && st.len <= 8)) return "flee";
  return "melee";
}

// 序盤の逃走: 足元の階段 > Phase Door (敵が近い時) > 最寄り階段へ歩く > Phase Door
function earlyFleeCommand(tiles: any[], px: number, py: number, inv: any[], m: any, actionNo: number,
  ctx?: { plevel: number; pspeed: number; monsters: any[]; turn: number; depth: number }): { cmd: Record<string, unknown>; kind: string } | null {
  const here = tiles.find((t: any) => t.x === px && t.y === py);
  if (here?.feat === FEAT.DOWN_STAIR) return { cmd: { type: CMD.GO_DOWN }, kind: "stairs" };
  if (here?.feat === FEAT.UP_STAIR) return { cmd: { type: CMD.GO_UP }, kind: "stairs" };
  // RULEFIX=stairsfirst: CL10 未満は、近い既知の階段 (敵に近づかない経路) へ Phase Door より先に歩く
  if (STAIRSFIRST && ctx && ctx.plevel < 10) {
    const sf = safeStairPath(tiles, px, py, [m], ctx.monsters, stairsWalkMax([m], ctx.pspeed));
    if (sf) {
      stairsFirstWalks++;
      if (stairsFirstWalks <= 3 || stairsFirstWalks % 10 === 0) addLesson(ctx.turn, ctx.depth, "階段優先", `${m.name}から逃走: Phase Door より先に階段へ歩く (${sf.len}歩, #${stairsFirstWalks})`);
      return { cmd: { type: CMD.WALK, direction: sf.dir }, kind: "walk" };
    }
  }
  const phase = findPhaseScroll(inv);
  const phaseOk = phase !== null && actionNo - lastEarlyPhaseAction >= 4;
  const st = nearestStair(tiles, px, py);
  if (phaseOk && m.distance <= 2 && !(st && st.len <= 2)) {
    lastEarlyPhaseAction = actionNo;
    return { cmd: { type: CMD.READ, itemIndex: phase }, kind: "phase" };
  }
  if (st) return { cmd: { type: CMD.WALK, direction: st.dir }, kind: "walk" };
  if (phaseOk && m.distance <= 6) {
    lastEarlyPhaseAction = actionNo;
    return { cmd: { type: CMD.READ, itemIndex: phase }, kind: "phase" };
  }
  return null;
}

// LLM判断: 降下してよいか (rules: 降下)
async function llmShouldDescend(state: any, rules: "descend" | "stay" = "descend"): Promise<boolean | null> {
  const choice = await decide("descend", { state, rules });
  return choice === null ? null : choice === "descend";
}

// LLM判断: どの装備に変えるべきか (rules: 交換)
async function llmChooseEquipment(state: any, current: any, candidate: any, rules: "swap" | "keep" = "swap"): Promise<boolean | null> {
  const choice = await decide("equip", { state, current, candidate, rules });
  return choice === null ? null : choice === "swap";
}

// LLM判断: 戦闘中にヒールすべきか逃走すべきか
async function llmHealOrFlee(state: any, enemies: any[], hpPct: number, rules: "heal" | "flee" | "fight" | null): Promise<"heal" | "flee" | "fight" | null> {
  return (await decide("tactic", { state, enemies, hpPct, rules })) as "heal" | "flee" | "fight" | null;
}

// LLM判断: WoR帰還すべきか (深層で危険な状況) (rules: 継続)
async function llmShouldRecall(state: any, rules: "recall" | "continue" = "continue"): Promise<boolean | null> {
  const choice = await decide("recall", { state, rules });
  return choice === null ? null : choice === "recall";
}

// LLM判断: この階の探索を続けるべきか (レベリング vs 降下) (rules: 降下)
async function llmShouldExploreMore(state: any, killsThisLevel: number, turnsOnLevel: number, rules: "explore" | "descend" = "descend"): Promise<boolean | null> {
  const choice = await decide("explore", { state, kills: killsThisLevel, turns: turnsOnLevel, rules });
  return choice === null ? null : choice === "explore";
}

// ── 戦術判断 ──

function findTile(tiles: any[], feat: number): { x: number; y: number } | null {
  const match = tiles.find((t: any) => t.feat === feat);
  return match ? { x: match.x, y: match.y } : null;
}

function directionTo(px: number, py: number, tx: number, ty: number): number {
  const dx = Math.sign(tx - px);
  const dy = Math.sign(ty - py);
  // numpad: (dx,dy) → direction
  const map: Record<string, number> = {
    "-1,-1": 7, "0,-1": 8, "1,-1": 9,
    "-1,0": 4,  "0,0": 5,  "1,0": 6,
    "-1,1": 1,  "0,1": 2,  "1,1": 3,
  };
  return map[`${dx},${dy}`] ?? 5;
}

function distanceTo(px: number, py: number, tx: number, ty: number): number {
  return Math.max(Math.abs(tx - px), Math.abs(ty - py));
}

function isPassable(tiles: any[], x: number, y: number): boolean {
  const t = tiles.find((t: any) => t.x === x && t.y === y);
  if (!t) return false;
  return PASSABLE_FEATS.has(t.feat);
}

function findHealingPotion(inventory: any[]): number | null {
  // CLW, CSW, CCW の順で探す (sval小さい方が弱い回復)
  const potions = inventory
    .filter((item: any) => item.tval === TVAL.POTION && item.name.includes("Cure") && item.qty > 0)
    .sort((a: any, b: any) => a.sval - b.sval);
  return potions.length > 0 ? potions[0].slot : null;
}

function findStrongHealingPotion(inventory: any[]): number | null {
  const potions = inventory
    .filter((item: any) => item.tval === TVAL.POTION && item.name.includes("Cure") && item.qty > 0)
    .sort((a: any, b: any) => b.sval - a.sval); // 強い順
  return potions.length > 0 ? potions[0].slot : null;
}

/**
 * 段階的回復ポーション選択 — HP残量に応じて適切な強さのポーションを選ぶ
 * - HP 60%+ (軽傷): CLW優先
 * - HP 40-60% (中傷): CSW → CCW
 * - HP 20-40% (重傷): CCW → Healing
 * - HP <20% (致命): *Healing* → Healing → CCW
 */
function findTieredHealingPotion(inventory: any[], hpPct: number): number | null {
  const allPotions = inventory
    .filter((item: any) => item.tval === TVAL.POTION && item.qty > 0);

  const clw = allPotions.filter((p: any) => p.name === "Cure Light Wounds");
  const csw = allPotions.filter((p: any) => p.name === "Cure Serious Wounds");
  const ccw = allPotions.filter((p: any) => p.name === "Cure Critical Wounds");
  const healing = allPotions.filter((p: any) => p.name === "Healing");
  const starHealing = allPotions.filter((p: any) => p.name === "*Healing*");
  const life = allPotions.filter((p: any) => p.name === "Life");

  if (hpPct < 0.2) {
    // 致命: 最強を使う
    return (starHealing[0]?.slot ?? life[0]?.slot ?? healing[0]?.slot ?? ccw[0]?.slot ?? csw[0]?.slot) ?? null;
  } else if (hpPct < 0.4) {
    // 重傷: Healing → CCW
    return (healing[0]?.slot ?? ccw[0]?.slot ?? csw[0]?.slot ?? clw[0]?.slot) ?? null;
  } else if (hpPct < 0.6) {
    // 中傷: CCW → CSW
    return (ccw[0]?.slot ?? csw[0]?.slot ?? clw[0]?.slot) ?? null;
  } else {
    // 軽傷: CLW → CSW
    return (clw[0]?.slot ?? csw[0]?.slot ?? ccw[0]?.slot) ?? null;
  }
}

/**
 * Teleport Level scroll — 緊急フロア脱出 (召喚群れなど)
 */
function findTeleportLevelScroll(inventory: any[]): number | null {
  if (readBlocked()) return null; // 読めない (暗闇/盲目): 読もうとし続けない
  const scroll = inventory.find((item: any) =>
    item.tval === TVAL.SCROLL && item.name.includes("Teleport Level") && item.qty > 0
  );
  return scroll ? scroll.slot : null;
}

function findPhaseScroll(inventory: any[]): number | null {
  if (readBlocked()) return null; // 読めない (暗闇/盲目): 読もうとし続けない
  const scroll = inventory.find((item: any) =>
    item.tval === TVAL.SCROLL && item.name.includes("Phase Door") && item.qty > 0
  );
  return scroll ? scroll.slot : null;
}

function findOilFlask(inventory: any[]): number | null {
  const f = inventory.find((item: any) => item.tval === TVAL.FLASK && item.qty > 0);
  return f ? f.slot : null;
}

// RULEFIX=fire: 装備中の射撃武器に合う矢弾の tval (スリング=弾、クロスボウ=ボルト、弓=矢)。射撃武器なしは null
function launcherAmmoTval(player: any): number | null {
  const bow = (player.equipment ?? []).find((e: any) => e.tval === TVAL.BOW);
  if (!bow) return null;
  const n = bow.name ?? "";
  return /Sling/i.test(n) ? TVAL.SHOT : /Crossbow/i.test(n) ? TVAL.BOLT : TVAL.ARROW;
}
function findAmmo(player: any): number | null {
  const t = launcherAmmoTval(player);
  if (t === null) return null;
  const a = (player.inventory ?? []).find((item: any) => item.tval === t && item.qty > 0);
  return a ? a.slot : null;
}

// RULEFIX=sling: 射撃武器 (装備・持ち物) がなければ、武器屋で一番安いスリングを買って装備する。装備できたら true
async function buySling(): Promise<boolean> {
  const st = await getState();
  if (st.depth !== 0 || !st.stores) return false;
  const pl = st.player;
  if (launcherAmmoTval(pl) !== null || (pl.inventory ?? []).some((i: any) => i.tval === TVAL.BOW)) return false;
  let best: { storeType: number; item: any } | null = null;
  for (const store of st.stores as any[]) {
    if (store.type !== 2) continue; // 武器屋
    for (const it of store.stock) {
      if (it.tval !== TVAL.BOW || !/Sling/i.test(it.name ?? "") || it.price <= 0 || it.price > pl.gold) continue;
      if (!best || it.price < best.item.price) best = { storeType: store.type, item: it };
    }
  }
  if (!best) {
    console.log(`  [スリング] 武器屋にスリングなし (所持金${pl.gold}G)`);
    return false;
  }
  const res = await fetch(`${API}/buy`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storeType: best.storeType, itemIndex: best.item.index, quantity: 1 }),
  });
  const r: any = await res.json();
  if (!r.success) return false;
  const sl = ((await getState()).player.inventory ?? []).find((i: any) => i.tval === TVAL.BOW && /Sling/i.test(i.name ?? ""));
  if (sl) await sendCommand({ type: CMD.EQUIP, itemIndex: sl.slot });
  const ok = launcherAmmoTval((await getState()).player) === TVAL.SHOT;
  addLesson(0, 0, "スリング", ok ? `スリングを${best.item.price}Gで購入して装備。鉄の弾を${SLING_SHOTS}発まで買う` : `スリングを買ったが装備できず`);
  return ok;
}

// Bresenham でプレイヤー→目標の射線が通るか (中間タイルが全て通行可・扉閉でない)
function hasLOS(tiles: any[], px: number, py: number, tx: number, ty: number): boolean {
  const feats = new Map<number, number>();
  for (const t of tiles) feats.set(t.y * 4096 + t.x, t.feat);
  const dx = Math.abs(tx - px), dy = Math.abs(ty - py);
  const sx = px < tx ? 1 : -1, sy = py < ty ? 1 : -1;
  let err = dx - dy, x = px, y = py;
  while (!(x === tx && y === ty)) {
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    if (x === tx && y === ty) break;
    const f = feats.get(y * 4096 + x);
    if (f === undefined || !PASSABLE_FEATS.has(f) || f === FEAT.PASS_RUBBLE) return false;
  }
  return true;
}

const THROW_RANGE = 8;

// 既知の階段 (上り/下り) のうち最寄りへの BFS: 最初の一歩と歩数
function nearestStair(tiles: any[], px: number, py: number): { dir: number; len: number } | null {
  const passable = new Set<string>();
  const stairs = new Set<string>();
  for (const t of tiles) {
    if (PASSABLE_FEATS.has(t.feat)) passable.add(`${t.x},${t.y}`);
    if (t.feat === FEAT.UP_STAIR || t.feat === FEAT.DOWN_STAIR) stairs.add(`${t.x},${t.y}`);
  }
  for (const k of sealedDoors) passable.delete(k); // RULEFIX=seal: 閉めた扉は壁
  if (stairs.size === 0) return null;
  const offs: [number, number, number][] = [[-1, 1, 1], [0, 1, 2], [1, 1, 3], [-1, 0, 4], [1, 0, 6], [-1, -1, 7], [0, -1, 8], [1, -1, 9]];
  const seen = new Set<string>([`${px},${py}`]);
  let frontier: { x: number; y: number; dir: number }[] = [{ x: px, y: py, dir: 5 }];
  for (let len = 1; frontier.length > 0 && len < 200; len++) {
    const next: { x: number; y: number; dir: number }[] = [];
    for (const c of frontier) {
      for (const [dx, dy, d] of offs) {
        const nx = c.x + dx, ny = c.y + dy, k = `${nx},${ny}`;
        if (!passable.has(k) || seen.has(k)) continue;
        if (!canMoveDiag(passable, c.x, c.y, dx, dy)) continue;
        seen.add(k);
        const dir = c.dir === 5 ? d : c.dir;
        if (stairs.has(k)) return { dir, len };
        next.push({ x: nx, y: ny, dir });
      }
    }
    frontier = next;
  }
  return null;
}

// RULEFIX=stairsfirst: 見えている情報だけの近接ダメージ (1 手): 思い出に出た打撃のダイス (10 回見た後)、まだなら Lv からの
// 全モンスター共通の事前値 (打撃平均の Lv 別中央値 ≈ 1.0 × Lv)。meleeTooCostly と同じく命中 0.7、速度比を掛ける
function seenMeleePerTurn(m: any): number {
  let avg = 0;
  for (const b of m.blowsSeen ?? []) {
    const d = /(\d+)d(\d+)/.exec(String(b?.dice ?? ""));
    if (d) avg += Number(d[1]) * (Number(d[2]) + 1) / 2;
  }
  return avg > 0 ? avg : Math.max(1, m.level ?? 1);
}
// 見えている敵が 2 手以内に現 HP を削り切れるか (遠い敵は近づく手数を引く。動かない敵は隣接時だけ)
function lethalWithinTwo(monsters: any[], p: any): boolean {
  let dmg = 0;
  for (const m of monsters) {
    if (m.distance > 8 || (m.distance > 1 && STATIONARY_RE.test(m.name ?? ""))) continue;
    const speedRatio = Math.max(0.5, ((m.speed ?? 110) - 100) / Math.max(5, (p.speed ?? 110) - 100));
    const attacks = Math.max(0, 2 * speedRatio - Math.max(0, m.distance - 1));
    dmg += seenMeleePerTurn(m) * 0.7 * attacks;
  }
  return dmg >= p.hp;
}
// 既知の最寄り階段への BFS (maxLen 歩以内): 敵のいるマスは通らず、どの脅威にも今より近づかない (隣接していない脅威の隣も通らない)
function safeStairPath(tiles: any[], px: number, py: number, threats: any[], monsters: any[], maxLen: number): { dir: number; len: number } | null {
  const passable = new Set<string>();
  const stairs = new Set<string>();
  for (const t of tiles) {
    if (PASSABLE_FEATS.has(t.feat)) passable.add(`${t.x},${t.y}`);
    if (t.feat === FEAT.UP_STAIR || t.feat === FEAT.DOWN_STAIR) stairs.add(`${t.x},${t.y}`);
  }
  for (const k of sealedDoors) passable.delete(k);
  for (const m of monsters) passable.delete(`${m.x},${m.y}`);
  if (stairs.size === 0) return null;
  const keep = threats.map((m: any) => ({ x: m.x, y: m.y, d: Math.min(2, distanceTo(px, py, m.x, m.y)) }));
  const ok = (x: number, y: number) => keep.every(k => distanceTo(x, y, k.x, k.y) >= k.d);
  const offs: [number, number, number][] = [[-1, 1, 1], [0, 1, 2], [1, 1, 3], [-1, 0, 4], [1, 0, 6], [-1, -1, 7], [0, -1, 8], [1, -1, 9]];
  const seen = new Set<string>([`${px},${py}`]);
  let frontier: { x: number; y: number; dir: number }[] = [{ x: px, y: py, dir: 5 }];
  for (let len = 1; frontier.length > 0 && len <= maxLen; len++) {
    const next: { x: number; y: number; dir: number }[] = [];
    for (const c of frontier) {
      for (const [dx, dy, d] of offs) {
        const nx = c.x + dx, ny = c.y + dy, k = `${nx},${ny}`;
        if (!passable.has(k) || seen.has(k) || !ok(nx, ny)) continue;
        if (!canMoveDiag(passable, c.x, c.y, dx, dy)) continue;
        seen.add(k);
        const dir = c.dir === 5 ? d : c.dir;
        if (stairs.has(k)) return { dir, len };
        next.push({ x: nx, y: ny, dir });
      }
    }
    frontier = next;
  }
  return null;
}

function findTeleportScroll(inventory: any[]): number | null {
  if (readBlocked()) return null; // 読めない (暗闇/盲目): 読もうとし続けない
  const scroll = inventory.find((item: any) =>
    item.tval === TVAL.SCROLL && item.name.includes("Teleportation") && item.qty > 0
  );
  return scroll ? scroll.slot : null;
}

function findSpeedPotion(inventory: any[]): number | null {
  const potion = inventory.find((item: any) =>
    item.tval === TVAL.POTION && item.name.includes("Speed") && item.qty > 0
  );
  return potion ? potion.slot : null;
}

function findRecallScroll(inventory: any[]): number | null {
  if (readBlocked()) return null; // 読めない (暗闇/盲目): 読もうとし続けない
  const scroll = inventory.find((item: any) =>
    item.tval === TVAL.SCROLL && item.name.includes("Word of Recall") && item.qty > 0
  );
  return scroll ? scroll.slot : null;
}

function findFood(inventory: any[]): number | null {
  const food = inventory.find((item: any) =>
    item.tval === TVAL.FOOD && item.qty > 0
  );
  return food ? food.slot : null;
}

// ── スペル関連 ──
interface SpellInfo {
  name: string;
  index: number;
  level: number;
  mana: number;
  failRate: number;
  learned: boolean;
  realm: string;
}

// スペル名でカテゴリ分類 (名前ベースで判断、effect解析不要)
const HEAL_SPELLS = ["Cure Light Wounds", "Cure Serious Wounds", "Cure Critical Wounds",
  "Cure Mortal Wounds", "Healing", "Minor Healing", "Major Healing"];
const BUFF_SPELLS = ["Bless", "Heroism", "Berserker", "Haste Self", "Protection from Evil",
  "Shield", "Resist Heat and Cold", "Resist Fire", "Resist Cold", "Resist Poison",
  "Resistance", "Globe of Invulnerability"];
const ESCAPE_SPELLS = ["Phase Door", "Teleport Self", "Teleport Other", "Portal",
  "Dimension Door", "Word of Recall"];
const DETECT_SPELLS = ["Detect Evil", "Detect Monsters", "Detect Traps", "Detect Doors",
  "Detect Stairs", "Detection", "Clairvoyance", "Sense Surroundings",
  "Detect Life", "Treasure Detection"];
const ATTACK_SPELLS = ["Magic Missile", "Stinking Cloud", "Lightning Bolt", "Frost Bolt",
  "Fire Bolt", "Fire Ball", "Frost Ball", "Acid Bolt", "Cloud Kill",
  "Ice Storm", "Meteor Swarm", "Rift", "Mana Storm",
  "Orb of Draining", "Holy Word", "Annihilation"];
// 方向が必要なスペル (ボルト/ビーム系)
const DIRECTIONAL_SPELLS = ["Magic Missile", "Lightning Bolt", "Frost Bolt", "Fire Bolt",
  "Acid Bolt", "Orb of Draining", "Stinking Cloud"];

function findCastableSpell(spells: SpellInfo[], names: string[], playerLevel: number, sp: number): SpellInfo | null {
  // 学習済み・レベル足りる・マナ足りる・失敗率80%未満のスペルを探す
  return spells.find(s =>
    s.learned && s.level <= playerLevel && s.mana <= sp && s.failRate < 80 &&
    names.some(n => s.name.includes(n))
  ) ?? null;
}

function findBestHealSpell(spells: SpellInfo[], playerLevel: number, sp: number, emergency: boolean): SpellInfo | null {
  const castable = spells.filter(s =>
    s.learned && s.level <= playerLevel && s.mana <= sp && s.failRate < 80 &&
    HEAL_SPELLS.some(n => s.name.includes(n))
  );
  if (castable.length === 0) return null;
  // 緊急時は最強(mana最大)を選択、通常時は最弱(mana最小)で節約
  castable.sort((a, b) => emergency ? b.mana - a.mana : a.mana - b.mana);
  return castable[0]!;
}

function findStudyableSpell(spells: SpellInfo[], playerLevel: number): SpellInfo | null {
  // 未学習で、レベルが足りているスペルを優先度順に探す
  // 優先: 回復 > 逃走 > 検知 > バフ > 攻撃
  const priorityLists = [HEAL_SPELLS, ESCAPE_SPELLS, DETECT_SPELLS, BUFF_SPELLS, ATTACK_SPELLS];
  for (const nameList of priorityLists) {
    const candidate = spells.find(s =>
      !s.learned && s.level <= playerLevel &&
      nameList.some(n => s.name.includes(n))
    );
    if (candidate) return candidate;
  }
  // どのカテゴリにも属さない → レベルが低い順で任意のスペルを学習
  return spells.find(s => !s.learned && s.level <= playerLevel) ?? null;
}

let spellsUsed = 0;
let spellsLearned = 0;

let lastRecordedState: any = null; // addLessonからの録画用
function addLesson(turn: number, depth: number, event: string, lesson: string) {
  lessons.push({ turn, depth, event, lesson });
  console.log(`  [学習] ${event}: ${lesson}`);
  if (lastRecordedState) recordFrame(lastRecordedState, `${event}: ${lesson.substring(0, 60)}`);
}

// ── 斜め移動制限チェック ──
// Angband: 斜め移動は、両隣の基本方向が壁なら不可
function canMoveDiag(passableSet: Set<string>, fx: number, fy: number, dx: number, dy: number): boolean {
  if (dx === 0 || dy === 0) return true; // 基本方向は常にOK
  // 斜め移動: 両隣のカーディナル方向をチェック
  const cardH = passableSet.has(`${fx + dx},${fy}`);
  const cardV = passableSet.has(`${fx},${fy + dy}`);
  return cardH || cardV; // 少なくとも1つが通行可能ならOK
}

// PLAYER_VIEW: squares the player hasn't seen may well be open. Paths to a target (stairs) go through them
// optimistically, and are replanned as they are seen; exploration targets stay the known frontier.
const knownKeyCache = new WeakMap<any[], Set<string>>();
function unknownOpen(tiles: any[], x: number, y: number): boolean {
  if (!PLAYER_VIEW) return false;
  const w = lastKnownState?.map?.width ?? 198, h = lastKnownState?.map?.height ?? 66;
  if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) return false;
  let known = knownKeyCache.get(tiles);
  if (!known) { known = new Set(tiles.map((t: any) => `${t.x},${t.y}`)); knownKeyCache.set(tiles, known); }
  return !known.has(`${x},${y}`);
}

// ── BFS パスファインディング ──
function bfsNextStep(tiles: any[], px: number, py: number, tx: number, ty: number): number | null {
  // 動かない敵の隣を避ける経路が無ければ、隣を通る経路 (敵のマス自体は通らない)
  return bfsNextStepCore(tiles, px, py, tx, ty, true) ?? (avoidSoft.size ? bfsNextStepCore(tiles, px, py, tx, ty, false) : null);
}

function bfsNextStepCore(
  tiles: any[], px: number, py: number, tx: number, ty: number, avoidNear: boolean
): number | null {
  if (px === tx && py === ty) return null;

  // タイルをマップ化
  const passableSet = new Set<string>();
  for (const t of tiles) {
    if (PASSABLE_FEATS.has(t.feat)) {
      passableSet.add(`${t.x},${t.y}`);
    }
  }
  for (const k of avoidHard) passableSet.delete(k);
  if (avoidNear) for (const k of avoidSoft) if (k !== `${tx},${ty}`) passableSet.delete(k);
  for (const k of sealedDoors) passableSet.delete(k); // RULEFIX=seal: 閉めた扉は壁

  const queue: { x: number; y: number; firstDir: number }[] = [];
  const visitedBFS = new Set<string>();
  visitedBFS.add(`${px},${py}`);

  // 最初の1歩の8方向を展開
  const offsets: [number, number, number][] = [
    [-1, 1, 1], [0, 1, 2], [1, 1, 3],
    [-1, 0, 4], [1, 0, 6],
    [-1, -1, 7], [0, -1, 8], [1, -1, 9],
  ];

  for (const [dx, dy, dir] of offsets) {
    const nx = px + dx;
    const ny = py + dy;
    const key = `${nx},${ny}`;
    if (!passableSet.has(key) && !unknownOpen(tiles, nx, ny)) continue;
    if (visitedBFS.has(key)) continue;
    if (!canMoveDiag(passableSet, px, py, dx, dy)) continue;
    if (nx === tx && ny === ty) return dir;
    visitedBFS.add(key);
    queue.push({ x: nx, y: ny, firstDir: dir });
  }

  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const [dx, dy] of offsets) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const key = `${nx},${ny}`;
      if (!passableSet.has(key) && !unknownOpen(tiles, nx, ny)) continue;
      if (visitedBFS.has(key)) continue;
      if (!canMoveDiag(passableSet, cur.x, cur.y, dx, dy)) continue;
      if (nx === tx && ny === ty) return cur.firstDir;
      visitedBFS.add(key);
      queue.push({ x: nx, y: ny, firstDir: cur.firstDir });
    }
  }

  return null; // 到達不能
}

// ── Dijkstra: 掘削を考慮したパスファインディング ──
// 壁を掘って通れるルートを探す (BFS到達不能な階段用)
function dijkstraNextStepWithDigging(
  tiles: any[], px: number, py: number, tx: number, ty: number
): { dir: number; needsDig: boolean } | null {
  if (px === tx && py === ty) return null;

  // タイルをマップ化 (feat値付き)
  const tileMap = new Map<string, number>();
  for (const t of tiles) {
    tileMap.set(`${t.x},${t.y}`, t.feat);
  }

  // コスト: 通行可能=1, ドア=2, 瓦礫=3, マグマ/石英=5, 花崗岩=10, 秘密ドア=2, 永久壁=不可
  function moveCost(feat: number): number {
    if (PASSABLE_FEATS.has(feat)) return 1;
    if (feat === FEAT.CLOSED_DOOR || feat === FEAT.SECRET) return 2;
    if (feat === FEAT.RUBBLE) return 3;
    if (!canDigFeat(feat)) return 9999; // 掘削具なし or 技能不足: 岩盤は掘れない
    if (feat === FEAT.MAGMA || feat === FEAT.MAGMA_K) return 5;
    if (feat === FEAT.QUARTZ || feat === FEAT.QUARTZ_K) return 5;
    if (feat === FEAT.GRANITE) return 10;
    return 9999; // PERM or unknown
  }

  const offsets: [number, number, number][] = [
    [-1, 1, 1], [0, 1, 2], [1, 1, 3],
    [-1, 0, 4], [1, 0, 6],
    [-1, -1, 7], [0, -1, 8], [1, -1, 9],
  ];

  // Dijkstra with priority queue (simple sorted array for small maps)
  const dist = new Map<string, number>();
  const firstStep = new Map<string, { dir: number; needsDig: boolean }>();
  const startKey = `${px},${py}`;
  dist.set(startKey, 0);

  // Priority queue entries: [cost, x, y]
  const pq: [number, number, number][] = [[0, px, py]];

  while (pq.length > 0) {
    // Extract min cost
    let minIdx = 0;
    for (let i = 1; i < pq.length; i++) {
      if (pq[i]![0] < pq[minIdx]![0]) minIdx = i;
    }
    const [cost, cx, cy] = pq.splice(minIdx, 1)[0]!;
    const curKey = `${cx},${cy}`;

    if (cost > (dist.get(curKey) ?? Infinity)) continue;

    for (const [dx, dy, dir] of offsets) {
      const nx = cx + dx, ny = cy + dy;
      const nkey = `${nx},${ny}`;
      const feat = tileMap.get(nkey);
      if (feat === undefined) continue; // off-map
      if (sealedDoors.has(nkey)) continue; // RULEFIX=seal: 閉めた扉は壁
      const mc = moveCost(feat);
      if (mc >= 9999) continue; // impassable

      const newCost = cost + mc;
      if (newCost >= (dist.get(nkey) ?? Infinity)) continue;
      dist.set(nkey, newCost);

      // Track first step from start
      if (cx === px && cy === py) {
        const needsDig = !PASSABLE_FEATS.has(feat);
        firstStep.set(nkey, { dir, needsDig });
      } else {
        firstStep.set(nkey, firstStep.get(curKey)!);
      }

      if (nx === tx && ny === ty) {
        return firstStep.get(nkey)!;
      }

      pq.push([newCost, nx, ny]);
    }
  }
  return null; // truly unreachable (permanent walls)
}

// ── BFS: 最寄り未踏タイルへの最初の1歩 ──
function bfsNextUnvisited(tiles: any[], px: number, py: number, visited: Set<string>): number | null {
  return bfsNextUnvisitedCore(tiles, px, py, visited, true) ?? (avoidSoft.size ? bfsNextUnvisitedCore(tiles, px, py, visited, false) : null);
}

function bfsNextUnvisitedCore(
  tiles: any[], px: number, py: number, visited: Set<string>, avoidNear: boolean
): number | null {
  const passableSet = new Set<string>();
  for (const t of tiles) {
    if (PASSABLE_FEATS.has(t.feat)) {
      passableSet.add(`${t.x},${t.y}`);
    }
  }
  for (const k of avoidHard) passableSet.delete(k);
  if (avoidNear) for (const k of avoidSoft) passableSet.delete(k);
  for (const k of sealedDoors) passableSet.delete(k); // RULEFIX=seal: 閉めた扉は壁

  const queue: { x: number; y: number; firstDir: number }[] = [];
  const seen = new Set<string>();
  seen.add(`${px},${py}`);

  const offsets: [number, number, number][] = [
    [-1, 1, 1], [0, 1, 2], [1, 1, 3],
    [-1, 0, 4], [1, 0, 6],
    [-1, -1, 7], [0, -1, 8], [1, -1, 9],
  ];

  for (const [dx, dy, dir] of offsets) {
    const nx = px + dx;
    const ny = py + dy;
    const key = `${nx},${ny}`;
    if (!passableSet.has(key) && (sealedDoors.has(key) || !tiles.find((t: any) => t.x === nx && t.y === ny && t.feat === FEAT.CLOSED_DOOR))) continue;
    if (seen.has(key)) continue;
    if (!canMoveDiag(passableSet, px, py, dx, dy)) continue;
    if (!visited.has(key)) return dir; // 隣接未踏 → 直行
    seen.add(key);
    queue.push({ x: nx, y: ny, firstDir: dir });
  }

  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const [dx, dy] of offsets) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const key = `${nx},${ny}`;
      if (!passableSet.has(key)) continue;
      if (seen.has(key)) continue;
      if (!canMoveDiag(passableSet, cur.x, cur.y, dx, dy)) continue;
      if (!visited.has(key)) return cur.firstDir; // 最寄り未踏発見
      seen.add(key);
      queue.push({ x: nx, y: ny, firstDir: cur.firstDir });
    }
  }

  return null; // 全タイル訪問済 or 到達不能
}

// ── 探索済み管理 ──
const visited = new Set<string>();
let lastX = -1, lastY = -1;
let stuckCount = 0;
let noProgressCount = 0;  // 新タイル訪問なしの連続行動数
let lastVisitedSize = 0;

// ── 孤立ループ検知 ──
let lastTeleportArea = ""; // 直前テレポート後のBFS到達範囲ハッシュ
let teleportLoopCount = 0; // 同じエリアへの連続テレポート回数
let descentTeleportCount = 0; // 降下テレポート回数 (同じ階でのリトライ制限)
let supplyWoRUsedThisLevel = false; // 補給WoR使用済みフラグ (同一階ループ防止)
let levelEntryDetected = false; // 各階で検知スペルを使ったか
const unreachableItems = new Set<string>(); // BFS到達不能なアイテムタイル
const fleeCountByMonster = new Map<string, number>(); // 敵名ごとの逃走回数
const forceFightMonsters = new Set<string>(); // 逃走不可能 → 戦うしかないモンスター

function getAreaHash(tiles: any[], px: number, py: number): string {
  // BFS到達範囲の最小座標をハッシュとして使う（同じ孤立部屋なら同じ値）
  const passableSet = new Set<string>();
  for (const t of tiles) {
    if (PASSABLE_FEATS.has(t.feat)) passableSet.add(`${t.x},${t.y}`);
  }
  const reachable: string[] = [];
  const queue = [`${px},${py}`];
  const seen = new Set<string>(queue);
  while (queue.length > 0) {
    const key = queue.shift()!;
    reachable.push(key);
    const [cx, cy] = key.split(",").map(Number);
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]) {
      const nk = `${cx+dx},${cy+dy}`;
      if (passableSet.has(nk) && !seen.has(nk)) {
        seen.add(nk);
        queue.push(nk);
      }
    }
  }
  reachable.sort();
  // 最初の3タイル+サイズでハッシュ（高速かつ十分ユニーク）
  return `${reachable.length}:${reachable.slice(0, 3).join(";")}`;
}

// ── 退避モード (逃走後のHP回復優先) ──
let retreatMode = false;        // 退避中フラグ
// 見えない攻撃者: HP が減り、隣に見える敵がいず、直近メッセージが "It ... you" のときの actionCount
let unseenHits: number[] = [];
let prevHpUnseen = -1;
let lastUnseenPhase = -100;
let studyBlockedUntil = 0;
let lightBlockedUntil = 0;
let lastFoodRecallAt = -1000;
// "It bites you." / "You are hit by something!" / bumping into it: "You hit the monster" (TS), "You hit it." (C)
const UNSEEN_ATTACK_RX = /^(It|Something) [a-z' ]*\byou\b|hit by something|^You (hit|miss) (the monster|it)\b/;
let retreatStartTurn = 0;       // 退避開始ターン
const RETREAT_HP_THRESHOLD = 0.8; // HP80%以上で退避解除
const RETREAT_MAX_TURNS = 30;    // 最大30ターンで強制解除

// ── 探索効率追跡 ──
let explorationRateWindow: number[] = []; // 直近の探索率（200アクション毎）

// ── 町での不要品売却 ──
// StoreType: 1=Armory, 2=Weapon, 0=General
const SELL_STORE_FOR_TVAL: Record<number, number[]> = {
  [TVAL.SWORD]: [2], [TVAL.POLEARM]: [2], [TVAL.HAFTED]: [2], [TVAL.DIGGING]: [2],
  [TVAL.BOW]: [2],
  [TVAL.SOFT_ARMOR]: [1], [TVAL.HARD_ARMOR]: [1], [TVAL.DRAG_ARMOR]: [1],
  [TVAL.SHIELD]: [1], [TVAL.BOOTS]: [1], [TVAL.GLOVES]: [1],
  [TVAL.HELM]: [1], [TVAL.CROWN]: [1], [TVAL.CLOAK]: [1],
  [TVAL.LIGHT]: [0], [TVAL.RING]: [5], [TVAL.AMULET]: [5],
  [TVAL.ARROW]: [2], [TVAL.BOLT]: [2],
  [TVAL.SCROLL]: [4], [TVAL.POTION]: [4], // 錬金術店 (RULEFIX=tryunknown で未知の巻物を渡す時だけ)
};

// 保持すべきアイテムかチェック (消耗品 or 現装備より良い装備)
function shouldKeepItem(item: any, equipment: any[]): boolean {
  // 消耗品は常に保持
  // RULEFIX=tryunknown: 未知の巻物は町で店に渡して識別する (読むと Deep Descent・召喚・呪いの危険。持っていても使わない)
  if (TRYUNKNOWN && item.tval === TVAL.SCROLL && item.aware === false) return false;
  if ([TVAL.SCROLL, TVAL.POTION, TVAL.FOOD, TVAL.FLASK].includes(item.tval)) return true; // 油は投擲武器
  // RULEFIX=devices: 魔法の道具は持つ (使い道のないと分かったものはダンジョンで落とす)
  if (DEVICES && [TVAL.STAFF, TVAL.WAND, TVAL.ROD].includes(item.tval)) return true;
  // 魔法書は保持
  if ([30, 31, 32, 33, 34].includes(item.tval)) return true;
  // 掘削具は保持 (stuck 脱出用)
  if (item.tval === TVAL.DIGGING) return true;
  // 予備の松明は保持 (vanilla の松明は燃え尽きる。燃え尽きたものは売る)
  if (item.tval === TVAL.LIGHT && /Torch/i.test(item.name ?? "") && (item.fuel === undefined || item.fuel > 0)) return true;
  // 装備品: 現装備より良いなら保持
  if (EQUIPPABLE_TVALS.has(item.tval)) {
    const currentEquip = equipment.find((e: any) => sameEquipCategory(e.tval, item.tval));
    if (!currentEquip) return true; // 空スロット → 装備候補として保持
    return itemPower(item) > itemPower(currentEquip);
  }
  return false; // それ以外は売却可
}

async function sellJunk(state: any) {
  const equip = state.player.equipment ?? [];
  let totalSold = 0;
  let totalGold = 0;

  for (let attempt = 0; attempt < 20; attempt++) {
    const freshState = await getState();
    const inv = freshState.player.inventory;
    const equip2 = freshState.player.equipment ?? [];

    // 売却候補を探す (逆順: 後ろから売ることでインデックスがずれない)
    let soldThisRound = false;
    for (let i = inv.length - 1; i >= 0; i--) {
      const item = inv[i];
      if (!item || item.qty <= 0) continue;
      if (shouldKeepItem(item, equip2)) continue;

      const stores = SELL_STORE_FOR_TVAL[item.tval] ?? [0]; // default: General
      for (const storeType of stores) {
        try {
          const res = await fetch(`${API}/sell`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ storeType, itemSlot: i }),
          });
          const result = await res.json();
          if (result.success) {
            totalSold++;
            totalGold += result.price;
            console.log(`  [売却] ${item.name} → store${storeType} (${result.price}G)`);
            soldThisRound = true;
            break; // sold successfully, re-fetch inventory
          }
        } catch (e) {
          console.log(`  [sellJunk] ERROR: ${e}`);
        }
      }
      if (soldThisRound) break; // re-fetch inventory after each sale
    }
    if (!soldThisRound) break; // nothing left to sell
  }
  if (totalSold > 0) {
    console.log(`  [売却合計] ${totalSold}個売却、${totalGold}G獲得`);
  }
}

// ── 町での補給 ──
// StoreType: 0=General, 3=Temple, 4=Alchemy, 5=Magic, 6=BlackMarket
async function buySupplies(state: any) {
  const p = state.player;
  const gold = p.gold;
  if (gold < 5) return;

  let totalBought = 0;
  let currentGold = gold;
  const MAX_PURCHASES = 40;

  // Shopping list: name match, valid tvals (to avoid buying staves/wands), store IDs
  // tval 25=scroll, 26=potion, 28=food
  const shoppingList = [
    { name: "Ration" as string | null, tvals: [28], target: FOOD_KEEP, stores: [0] }, // food first: starvation
    { name: "Wooden Torch", tvals: [TVAL.LIGHT], target: 3, stores: [0] }, // vanilla torches burn out
    // RULEFIX=wor: 帰還の巻物 1 枚を回復薬より先に。無いと食料切れのとき上り階段を歩いて餓死していた
    ...(RULEFIX.has("wor") ? [{ name: "Word of Recall" as string | null, tvals: [25], target: 1, stores: [4, 5] }] : []),
    ...(RULEFIX.has("neutpois") ? [{ name: "Neutralize Poison" as string | null, tvals: [26], target: 2, stores: [4] }] : []), // 錬金術店 (闇市は 3 倍)
    { name: "Cure Critical Wounds", tvals: [26], target: 30, stores: [4, 5] },
    { name: "Phase Door", tvals: [25], target: 20, stores: [4, 5] },
    { name: "Teleportation", tvals: [25], target: 12, stores: [4, 5, 6] },
    { name: "Word of Recall", tvals: [25], target: 5, stores: [4, 5] },
    ...(RULEFIX.has("neutshop") ? [{ name: "Neutralize Poison" as string | null, tvals: [26], target: 1, stores: [4] }] : []),
    { name: null as string | null, tvals: [28], target: 10, stores: [0] }, // food top-up
  ];

  for (const item of shoppingList) {
    // Re-count current inventory each round
    const freshState = await getState();
    const inv = freshState.player.inventory;
    let current: number;
    if (item.name) {
      current = inv.filter((i: any) => i.name?.includes(item.name) && i.qty > 0)
        .reduce((s: number, i: any) => s + i.qty, 0);
    } else {
      current = inv.filter((i: any) => item.tvals.includes(i.tval) && i.qty > 0)
        .reduce((s: number, i: any) => s + i.qty, 0);
    }
    const needed = item.target - current;
    if (needed <= 0) continue;
    console.log(`  [補給] ${item.name ?? "Food"}: ${current}/${item.target} (need ${needed})`);


    let bought = 0;
    // Retry loop: re-fetch store after each purchase (indices shift)
    for (let attempt = 0; attempt < needed && totalBought < MAX_PURCHASES; attempt++) {
      let purchasedThisAttempt = false;
      for (const storeType of item.stores) {
        if (purchasedThisAttempt) break;
        try {
          const stRes = await getState();
          currentGold = stRes.player.gold;
          const stores = stRes.stores;
          if (!stores || !stores[storeType]) continue;

          const matching = stores[storeType].stock
            .filter((s: any) => {
              if (!item.tvals.includes(s.tval)) return false;
              if (s.price > currentGold || s.price <= 0) return false;
              if (item.name) return s.name?.includes(item.name);
              return true; // food: any tval match
            })
            .sort((a: any, b: any) => a.price - b.price);

          if (matching.length === 0) continue;
          const stockItem = matching[0];

          const res = await fetch(`${API}/buy`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ storeType, itemIndex: stockItem.index }),
          });
          const result = await res.json();
          if (result.success) {
            bought++;
            totalBought++;
            currentGold = result.state?.player?.gold ?? (currentGold - stockItem.price);
            console.log(`  [購入] ${stockItem.name} (${stockItem.price}G) store${storeType} 残金${currentGold}G [${bought}/${needed}]`);
            purchasedThisAttempt = true;
          }
        } catch (e) {
          console.log(`  [buySupplies] ERROR: ${e}`);
        }
      }
      if (!purchasedThisAttempt) break; // no more available in any store
    }
    if (bought > 0) {
      console.log(`  [補給] ${item.name ?? "Food"}: ${bought}個購入`);
    }
  }
  if (totalBought > 0) {
    addLesson(0, 0, "町補給", `${totalBought}個購入。残金${currentGold}G`);
  }
}

// ── 町での装備品購入 ──
// StoreType: 1=Armory, 2=Weapon
async function buyEquipment(state: any) {
  const p = state.player;
  let currentGold = p.gold;
  if (currentGold < 100) return;

  const equip = p.equipment ?? [];
  let totalUpgrades = 0;

  // 全店舗をチェック: 武器(2), 防具(1), 魔法(5), 黒市(6)
  // リング/アミュレットの耐性装備も探す
  for (const storeType of [2, 1, 5, 6]) {
    const freshState = await getState();
    currentGold = freshState.player.gold;
    if (currentGold < 100) break;
    const stores = freshState.stores;
    if (!stores || !stores[storeType]) continue;

    const stock = stores[storeType].stock;
    const currentEquip = freshState.player.equipment ?? [];

    for (const stockItem of stock) {
      if (stockItem.price > currentGold || stockItem.price <= 0) continue;
      if (!EQUIPPABLE_TVALS.has(stockItem.tval)) continue;
      if (stockItem.tval === TVAL.DIGGING) continue; // 掘削具は buyEarlyKit で購入

      // 現装備と比較
      const stockPower = itemPower(stockItem);
      const currentSlotEquip = currentEquip.find((e: any) => sameEquipCategory(e.tval, stockItem.tval));
      const currentPower = currentSlotEquip ? itemPower(currentSlotEquip) : 0;

      // 耐性装備チェック: 足りない耐性を持つアイテムは強く優先
      const hasNeededResist = ((GEARID ? gearView(stockItem) : stockItem).resists ?? []).some((r: any) =>
        r.level > 0 && !currentPlayerResists.has(r.elem)
      );

      // 20%以上パワーアップ or 空スロット or 足りない耐性を持つ
      if (stockPower > currentPower * 1.2 || (!currentSlotEquip && stockPower > 10) || hasNeededResist) {
        // 耐性装備はゴールドの80%まで出す、通常は60%
        const maxSpend = hasNeededResist ? 0.8 : 0.6;
        if (stockItem.price > currentGold * maxSpend) continue;

        try {
          const res = await fetch(`${API}/buy`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ storeType, itemIndex: stockItem.index }),
          });
          const result = await res.json();
          if (result.success) {
            totalUpgrades++;
            currentGold = result.state?.player?.gold ?? (currentGold - stockItem.price);
            console.log(`  [装備購入] ${stockItem.name} (power=${stockPower} > ${currentPower}, ${stockItem.price}G) 残金${currentGold}G`);

            // 購入後に即装備
            const newState = await getState();
            const newInv = newState.player.inventory;
            const boughtItem = newInv.find((i: any) =>
              i.tval === stockItem.tval && i.name === stockItem.name
            );
            if (boughtItem) {
              await sendCommand({ type: CMD.EQUIP, itemIndex: boughtItem.slot });
              console.log(`  [装備] ${boughtItem.name}を装備`);
            }
            break; // 再取得が必要なのでストアループを抜ける
          }
        } catch (e) {
          console.log(`  [buyEquipment] ERROR: ${e}`);
        }
      }
    }
  }
  if (totalUpgrades > 0) {
    addLesson(0, 0, "装備購入", `${totalUpgrades}個装備品購入。残金${currentGold}G`);
  }
}

// ── メインAIループ ──
async function playGame() {
  console.log("=== 武将AI プレイ開始 ===\n");

  // サーバー起動待ち
  for (let retry = 0; retry < 10; retry++) {
    try {
      await getState();
      break;
    } catch {
      console.log("サーバー起動待ち...");
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  let state = await getState();
  const rolloutStart = {
    depth: state.depth, cl: state.player.level, exp: state.player.exp ?? 0,
    hp: state.player.hp, maxHp: state.player.maxHp,
    toNext: expToNextLevel(state.player),
  };
  if (state.depth > maxDepthReached) maxDepthReached = state.depth;
  if (!ROLLOUT && state.depth === 0 && state.turn < 100) {
    await buyEarlyKit();
    state = await getState();
  }
  let turnLimit = 500000;
  let actionCount = 0;
  let killsThisLevel = 0;
  let turnsOnLevel = 0;
  let levelEntryTurn = 0;
  const MAX_TURNS_PER_LEVEL = 3000; // 最大ターン数超えたら降下OK (5000→3000で速度UP)

  // 深度別の最低撃破数（浅層でしっかりレベリング、深層は探索・降下重視）
  function minKillsForDepth(depth: number): number {
    if (depth <= 1) return 0;  // DL0-1: 即降下OK
    if (depth <= 3) return 2;  // DL2-3: 2体
    if (depth <= 6) return 4;  // DL4-6: 4体 (安全にレベリング)
    if (depth <= 10) return 6; // DL7-10: 6体
    if (depth <= 15) return 8; // DL11-15: 8体 (ここでCL15+を目指す)
    if (depth <= 20) return 5; // DL16-20: 5体
    return 3;                  // DL21+: 3体 (深層は速めに降下)
  }

  let lastKnownDepth = state.depth;

  // 初期フレーム録画
  recordFrame(state, "start");
  if (DANGER_LOG_PATH) {
    dangerLogger = new DangerLogger(DANGER_LOG_PATH, {
      h: 1, v: DANGER_RECORD_VERSION, engine: state.engine ?? "ts", view: state.view ?? "omniscient",
      class: state.player?.class ?? "?", race: state.player?.race ?? "?", seed: String(GAME_SEED ?? ""),
      rulefix: [...RULEFIX].join(","),
      ...(DANGER_MODELS.length ? { model: process.env.DANGER_MODEL } : {}),
    });
  }
  const dangerCharacter = { class: state.player?.class ?? "?", race: state.player?.race ?? "?" };
  const dangerPredict = DANGER_MODELS.length
    ? (rec: any) => Object.fromEntries(DANGER_MODELS.map((m) => [m.label, Math.round(m.predict(rec, dangerCharacter) * 1e5) / 1e5]))
    : undefined;

  while (!state.dead && !state.won && state.turn < turnLimit && actionCount < MAX_ACTIONS
         && !(ROLLOUT && (actionCount >= ROLLOUT_HORIZON || (!rolloutFired && actionCount >= ROLLOUT_MAX_WAIT)))) {
    actionCount++;
    rolloutActions = actionCount;
    (globalThis as any).__lastState = state; // LLMキャッシュキー用
    // 録画 (10アクション毎 + イベント時)
    lastRecordedState = state;
    if (actionCount % 10 === 0) recordFrame(state);
    const dangerRec = dangerLogger?.record(state, actionCount, dangerPredict);
    if (DANGERML) predDmg5 = dangerRec?.pd?.dmg_5;
    if (DANGERMLFLEE) predDeath20 = dangerRec?.pd?.death_20;
    const p = state.player;
    if (p.maxHp > 0) minHpFrac = Math.min(minHpFrac, p.hp / p.maxHp);
    rolloutDepthMax = Math.max(rolloutDepthMax, state.depth);
    if (ROLLOUT_CHECKPOINTS.has(actionCount - 1)) {
      rolloutCheckpoints.push({ a: actionCount - 1, depth: state.depth, dmax: rolloutDepthMax, hp: p.hp, mhp: p.maxHp, exp: p.exp ?? 0 });
    }
    const { x: px, y: py } = p;
    const tiles = state.map.tiles;
    const monsters = state.monsters;
    const inv = p.inventory;
    canDigHard = playerHasDigger(p);
    diggingSkill = p.digging ?? 0;
    const hpPct = p.hp / p.maxHp;
    {
      // 見えない攻撃者の検知 (メッセージ窓は直近20件で重複はまとめられるので、HP 減少と組み合わせる)
      const recent = ((state.messages ?? []) as any[]).slice(-4).map((x: any) => String(x));
      if (prevHpUnseen >= 0 && p.hp < prevHpUnseen && recent.some(x => UNSEEN_ATTACK_RX.test(x))
          && !monsters.some((m: any) => m.distance <= 1)) unseenHits.push(actionCount);
      prevHpUnseen = p.hp;
      unseenHits = unseenHits.filter(a => actionCount - a <= 20);
    }
    const unseenThreat = unseenHits.length > 0;
    // Player resistances from calcBonuses (race + equipment)
    const playerResists = new Set<string>();
    currentPlayerResists = new Set<number>(); // itemPower用の数値版
    currentDepth = state.depth;
    for (const r of (p as any).resistances ?? []) {
      if (r.level > 0) {
        playerResists.add(r.elem);
        // 文字列→数値変換
        const idx = ELEM_NAME_TO_IDX[r.elem];
        if (idx !== undefined) currentPlayerResists.add(idx);
      }
    }
    const dirOffsets: Record<number, [number, number]> = {
      1: [-1, 1], 2: [0, 1], 3: [1, 1], 4: [-1, 0], 6: [1, 0],
      7: [-1, -1], 8: [0, -1], 9: [1, -1],
    };
    setStationaryAvoid(monsters, p.level);
    // 動かない敵から離れる1歩 (敵のいない、回避マスでない方向)
    const stepAwayFromStationary = (): number | null => {
      for (const d of ALL_DIRS) {
        const [dx, dy] = dirOffsets[d]!;
        const nx = px + dx, ny = py + dy;
        if (!isPassable(tiles, nx, ny) || avoidSoft.has(`${nx},${ny}`)) continue;
        if (monsters.some((m: any) => m.x === nx && m.y === ny)) continue;
        return d;
      }
      return null;
    };
    // RULEFIX=stairsfirst: CL10 未満で逃走条件が成立 → 階段の上なら階段、近い既知の階段 (6 歩以内、敵に近づかない経路) へ
    // Phase Door より先に歩く。何もしなければ false (呼び出し元の Phase Door へ)
    const stairsFirstFlee = async (threats: any[], why: string): Promise<boolean> => {
      if (!STAIRSFIRST || p.level >= 10 || state.depth < 1) return false;
      const here = tiles.find((t: any) => t.x === px && t.y === py);
      if (here?.feat === FEAT.DOWN_STAIR || here?.feat === FEAT.UP_STAIR) {
        fleeAttempts++;
        addLesson(state.turn, state.depth, "階段優先", `${why}: 階段の上なので Phase Door より先に${here.feat === FEAT.DOWN_STAIR ? "下り" : "上り"}階段`);
        state = await sendCommand({ type: here.feat === FEAT.DOWN_STAIR ? CMD.GO_DOWN : CMD.GO_UP });
        return true;
      }
      const sf = safeStairPath(tiles, px, py, threats, monsters, stairsWalkMax(threats, p.speed));
      if (!sf) return false;
      stairsFirstWalks++;
      if (stairsFirstWalks <= 3 || stairsFirstWalks % 10 === 0) addLesson(state.turn, state.depth, "階段優先", `${why}: Phase Door より先に階段へ歩く (${sf.len}歩, #${stairsFirstWalks})`);
      state = await sendCommand({ type: CMD.WALK, direction: sf.dir });
      return true;
    };

    // === 装備最適化 (500ターンに1回 + 深度変更時) ===
    // equippedNames: 現在装備中のアイテム名セット。同名アイテムの再装備ループを防止
    const equippedNames = (globalThis as any).__equippedNames ?? new Set<string>();
    (globalThis as any).__equippedNames = equippedNames;
    const lastEquipCheck = (globalThis as any).__lastEquipCheck ?? 0;
    const shouldCheckEquip = state.turn - lastEquipCheck >= 500;
    if (shouldCheckEquip && monsters.filter((m: any) => m.distance <= 2).length === 0) {
      (globalThis as any).__lastEquipCheck = state.turn;
      const equip = p.equipment ?? [];
      // 現在の装備名を記録
      for (const e of equip) { if (e?.name) equippedNames.add(e.name); }
      for (const invItem of inv) {
        if (!EQUIPPABLE_TVALS.has(invItem.tval)) continue;
        if (invItem.tval === TVAL.DIGGING) continue; // 掘削具は持ち物のまま (装備しない)
        // 既に装備したことのあるアイテムは無視 (ループ防止)
        if (equippedNames.has(invItem.name)) continue;
        const curEquip = equip.find((e: any) => sameEquipCategory(e.tval, invItem.tval));
        const invPow = itemPower(invItem);
        const curPow = curEquip ? itemPower(curEquip) : -1;
        if (invPow > curPow * 1.2 || (!curEquip && invPow > 0)) {
          equippedNames.add(invItem.name);
          console.log(`  [自動装備] ${invItem.name}(pow=${invPow}) ${curEquip ? `> ${curEquip.name}(pow=${curPow})` : "(空スロット)"}`);
          state = await sendCommand({ type: CMD.EQUIP, itemIndex: invItem.slot });
          break;
        }
      }
    }

    // Detect level change (WoR, stairs, etc.) and reset exploration state
    if (state.depth !== lastKnownDepth) {
      unseenHits = [];
      console.log(`  [深度変更] DL${lastKnownDepth} → DL${state.depth} (WoR/階段)`);
      visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
      killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = [];
      levelEntryDetected = false; unreachableItems.clear();
      teleportLoopCount = 0; lastTeleportArea = ""; descentTeleportCount = 0; supplyWoRUsedThisLevel = false; fleeCountByMonster.clear(); forceFightMonsters.clear(); retreatMode = false;
      // 深度変更時にチェックタイマー・群れカウンターリセット (装備名履歴は保持)
      (globalThis as any).__lastEquipCheck = 0;
      (globalThis as any).__herdFleeCount = 0;
      if (state.depth > maxDepthReached) maxDepthReached = state.depth;
      lastKnownDepth = state.depth;
      // RULEFIX=leave/seal/arrive: 階ごとの状態 (フラグが無効なら使われない)
      levelEscapes = 0; leaving = ""; leaveWalk = 0; sealedDoors.clear(); sealFailed.clear(); sealPrev = null; deviceEmpty.clear(); droppedTiles.clear(); staffTriedLevel.clear();
      const arrivedOn = tiles.find((t: any) => t.x === px && t.y === py)?.feat;
      arrivePending = ARRIVE && state.depth >= 1 && (arrivedOn === FEAT.UP_STAIR || arrivedOn === FEAT.DOWN_STAIR);
      if (savepointBank.enabled && !ROLLOUT) await savepointBank.onLevelEntry(state, gameIdOf(state), GAME_SEED === null ? null : Number(GAME_SEED), fetchSnapshotBody);

      // 序盤の町帰還 (逃走で DL1→町 など): 残金で油/Phase/CLW を補充
      if (state.depth === 0 && maxDepthReached < 5 && !ROLLOUT) {
        if (RULEFIX.has("restock") && actionCount > 0) { await sellJunk(state); state = await getState(); }
        await buyEarlyKit();
        state = await getState();
      }

      // Town: buy supplies before returning to dungeon
      if (state.depth === 0 && maxDepthReached >= 5) {
        const inv2 = state.player.inventory;
        const cureQty = inv2.filter((i: any) => i.name?.includes("Cure")).reduce((s: number, i: any) => s + i.qty, 0);
        const phaseQty = inv2.filter((i: any) => i.name?.includes("Phase Door")).reduce((s: number, i: any) => s + i.qty, 0);
        console.log(`  [町到着] Gold:${state.player.gold} Cure:${cureQty} Phase:${phaseQty}`);
        await sellJunk(state); // 先に不要品を売却してゴールド確保
        state = await getState();
        await buyEarlyKit([["food", RULEFIX.has("food8") ? FOOD_KEEP : 5], ["torch", 3]]); // 装備で資金を使い切る前に食料と光源
        // RULEFIX=restock8: CL15 未満は装備より先に序盤の一式 (油/Phase/CLW)。buySupplies は CLW を買わない
        if (RULEFIX.has("restock8") && state.player.level < 15) { await buyEarlyKit(); state = await getState(); }
        state = await getState();
        await buyEquipment(state); // 装備品を先に購入（ゴールド消費前）
        state = await getState();
        await buySupplies(state);
        state = await getState(); // refresh state after purchases
        // 町帰還で逃走カウンターリセット (ダンジョンに戻ると新しいモンスター配置)
        fleeCountByMonster.clear();
      }

      // Fast return: if recalled to town (DL0) and maxDepth is deep, use WoR to jump back
      if (state.depth === 0 && maxDepthReached >= 5 && !(state.player.wordRecall > 0)) {
        const recallSlot = findRecallScroll(state.player.inventory);
        if (recallSlot !== null) {
          addLesson(state.turn, state.depth, "WoR帰還",
            `町で補給完了。WoRでDL${maxDepthReached}方面へ帰還`);
          state = await sendCommand({ type: CMD.READ, itemIndex: recallSlot });
          continue;
        }
      }
    }

    // === RULEFIX=arrive: 階段で着いた直後、危険の気配が閾値以上か leave の敵が見えたら、その階段ですぐ引き返す (連続 3 回まで) ===
    if (arrivePending) {
      arrivePending = false;
      const here = tiles.find((t: any) => t.x === px && t.y === py);
      const feel = typeof state.levelFeeling === "number" ? state.levelFeeling : null;
      const thr = arriveThreshold(p.level, state.depth);
      const named = monsters.find((m: any) => leaveListed(m, p.level));
      const badFeel = feel !== null && feel >= thr;
      if ((badFeel || named) && arriveBounces < ARRIVE_MAX_BOUNCES && (here?.feat === FEAT.UP_STAIR || here?.feat === FEAT.DOWN_STAIR)) {
        arriveBounces++;
        addLesson(state.turn, state.depth, "到着引き返し",
          `DL${state.depth}着、${badFeel ? `危険の気配${feel} (閾値${thr})` : `${named.name}(dist${named.distance})が見える`}。${here.feat === FEAT.DOWN_STAIR ? "下り" : "上り"}階段ですぐ引き返す (連続${arriveBounces}回目)`);
        state = await sendCommand({ type: here.feat === FEAT.DOWN_STAIR ? CMD.GO_DOWN : CMD.GO_UP });
        continue;
      }
      arriveBounces = 0; // この階に留まる: 連続回数を数え直す
    }

    visited.add(`${px},${py}`);
    if (visited.size > lastVisitedSize) {
      noProgressCount = 0;
      lastVisitedSize = visited.size;
    } else {
      noProgressCount++;
    }
    const levelDebug = turnsOnLevel < 300; // 各フロア最初の300ターンはデバッグ

    // === RULEFIX=seal (a): 既知の繁殖敵から退く途中で扉を抜けた → 扉の上が空なら閉める (この階では壁扱い) ===
    if (SEAL && state.depth >= 1) {
      const prev = sealPrev;
      sealPrev = { x: px, y: py, depth: state.depth };
      if (prev && prev.depth === state.depth && distanceTo(prev.x, prev.y, px, py) === 1) {
        const key = `${prev.x},${prev.y}`;
        const door = tiles.find((t: any) => t.x === prev.x && t.y === prev.y);
        const breeders = monsters.filter((m: any) => m.breeds === true);
        if (door?.feat === FEAT.OPEN_DOOR && breeders.length > 0 && !sealFailed.has(key) && !sealedDoors.has(key) && !door.hasObj
            && !monsters.some((m: any) => m.x === prev.x && m.y === prev.y)) {
          const nb = breeders.reduce((a: any, b: any) => (a.distance <= b.distance ? a : b));
          if (distanceTo(nb.x, nb.y, prev.x, prev.y) < nb.distance) { // 繁殖敵は扉の向こう側: 退いている
            const turnBefore = state.turn;
            state = await sendCommand({ type: CMD.CLOSE, direction: directionTo(px, py, prev.x, prev.y) });
            const now = state.map.tiles.find((t: any) => t.x === prev.x && t.y === prev.y);
            if (state.turn !== turnBefore && now?.feat === FEAT.CLOSED_DOOR) {
              sealedDoors.add(key);
              addLesson(state.turn, state.depth, "扉封鎖", `既知の繁殖敵 ${nb.name}(dist${nb.distance}) から退く途中、通った扉 (${key}) を閉めた。この階では壁扱い`);
            } else sealFailed.add(key);
            if (state.turn !== turnBefore) continue;
          }
        }
      }
    }

    // === 最最最優先: ブリーダー群れ検知 → 即フロア脱出 ===
    // サーバーからのisBreederフラグで正確に検知 (フォールバック: 20体以上)
    const hasBreeder = monsters.some((m: any) => (m.isBreeder || knownBreeder(m)) && m.distance <= 10);
    if (monsters.length >= 20 || (hasBreeder && monsters.length >= 10)) {
      // 20体以上 = ブリーダー群れ。戦っても増殖するだけ → 即脱出
      const onDown = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.DOWN_STAIR);
      const onUp = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.UP_STAIR);
      if (onDown) {
        addLesson(state.turn, state.depth, "群れ脱出",
          `モンスター${monsters.length}体検知！ブリーダー群れ。階段で即脱出`);
        state = await sendCommand({ type: CMD.GO_DOWN });
        visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
        killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = [];
        levelEntryDetected = false; unreachableItems.clear();
        teleportLoopCount = 0; lastTeleportArea = ""; fleeCountByMonster.clear();
        if (state.depth > maxDepthReached) maxDepthReached = state.depth;
        continue;
      } else if (onUp && state.depth > 1) {
        addLesson(state.turn, state.depth, "群れ脱出",
          `モンスター${monsters.length}体！上階段で脱出`);
        state = await sendCommand({ type: CMD.GO_UP });
        visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
        killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = [];
        levelEntryDetected = false; unreachableItems.clear();
        continue;
      }
      // 階段上にいない → 群れ脱出カウンター: 3回Teleport後はWoRで完全離脱
      const herdFleeCount = (globalThis as any).__herdFleeCount ?? 0;
      (globalThis as any).__herdFleeCount = herdFleeCount + 1;
      // 3回以上群れ脱出 or DL30+ → WoR優先 (同じ階でTeleportしても群れに戻る)
      if ((herdFleeCount >= 3 || state.depth >= 30) && state.depth > 0 && !(p.wordRecall > 0)) {
        const recallSlot = findRecallScroll(inv);
        if (recallSlot !== null) {
          addLesson(state.turn, state.depth, "群れ脱出",
            `モンスター${monsters.length}体！${herdFleeCount+1}回目。WoRで帰還`);
          (globalThis as any).__herdFleeCount = 0;
          state = await sendCommand({ type: CMD.READ, itemIndex: recallSlot });
          continue;
        }
      }
      // Teleport (最初の3回)
      const teleSlot = findTeleportScroll(inv);
      if (teleSlot !== null) {
        addLesson(state.turn, state.depth, "群れ脱出",
          `モンスター${monsters.length}体！Teleportで脱出(${herdFleeCount+1}回目)`);
        state = await sendCommand({ type: CMD.READ, itemIndex: teleSlot });
        stuckCount = 0; noProgressCount = 0; visited.clear(); lastVisitedSize = 0;
        continue;
      }
      // Teleportもない → WoR
      if (state.depth > 0 && !(p.wordRecall > 0)) {
        const recallSlot = findRecallScroll(inv);
        if (recallSlot !== null) {
          addLesson(state.turn, state.depth, "群れ脱出",
            `モンスター${monsters.length}体！WoRで帰還`);
          (globalThis as any).__herdFleeCount = 0;
          state = await sendCommand({ type: CMD.READ, itemIndex: recallSlot });
          continue;
        }
      }
    }

    // === 飢餓: 停滞脱出より先 (停滞中に餓死していた)。食べる、無ければ町へ (WoR、無ければ上り階段の補給帰還) ===
    if (p.timed.food <= 1500) {
      const f = findFood(inv);
      if (f !== null) {
        addLesson(state.turn, state.depth, "食事", `空腹。食事`);
        state = await sendCommand({ type: CMD.EAT, itemIndex: f });
        continue;
      }
      if (!ROLLOUT && state.depth >= 1) {
        const r = findRecallScroll(inv);
        if (r !== null && actionCount - lastFoodRecallAt > 300) { // 300 行動空ける: 再読で取り消さない
          lastFoodRecallAt = actionCount;
          addLesson(state.turn, state.depth, "食料切れ", `食料なし (空腹)。WoRで町へ`);
          state = await sendCommand({ type: CMD.READ, itemIndex: r });
          continue;
        }
        if (r === null && !restockTrip) {
          restockTrip = true;
          addLesson(state.turn, state.depth, "食料切れ", `食料なし (空腹)、WoRなし。上り階段で町へ`);
        }
      }
    }

    // === RULEFIX=stairsfirst: 階段の上で、見えている敵が 2 手以内に HP を削り切れる → 回復や他の逃走より先に階段を使う ===
    if (STAIRSFIRST && state.depth >= 1 && monsters.length > 0) {
      const here = tiles.find((t: any) => t.x === px && t.y === py);
      if ((here?.feat === FEAT.DOWN_STAIR || here?.feat === FEAT.UP_STAIR) && lethalWithinTwo(monsters, p)) {
        fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
        addLesson(state.turn, state.depth, "階段優先",
          `HP${p.hp}/${p.maxHp}、見えている敵${monsters.length}体 (最寄り ${[...monsters].sort((a: any, b: any) => a.distance - b.distance)[0].name}) が2手以内に致命的。${here.feat === FEAT.DOWN_STAIR ? "下り" : "上り"}階段で離脱`);
        state = await sendCommand({ type: here.feat === FEAT.DOWN_STAIR ? CMD.GO_DOWN : CMD.GO_UP });
        continue;
      }
    }

    // === RULEFIX=lowheal: HP 危険域 (35% 未満、毒なら 50% 未満) では停滞脱出より先に回復。隣接敵がいれば下の緊急回復/逃走に任せる ===
    // (毒で HP が減り続けるのに停滞脱出で壁を掘り続け、回復薬 6 個を持ったまま死んでいた)
    const lowHpHold = RULEFIX.has("lowheal") && state.depth >= 1 && (hpPct < 0.35 || (p.timed.poisoned > 0 && hpPct < 0.5)
      || (RULEFIX.has("cutcure") && (p.timed.cut ?? 0) > 0 && hpPct < 0.5));
    if (lowHpHold && !monsters.some((m: any) => m.distance <= 1)) {
      // RULEFIX=neutpois: 毒なら毒を治す薬 (Neutralize Poison、CCW) を先に。毒の間は HP が自然回復しない
      const poisonCure = (RULEFIX.has("neutpois") || RULEFIX.has("neutshop")) && p.timed.poisoned > 0
        ? inv.find((i: any) => i.tval === TVAL.POTION && i.qty > 0 && (i.name === "Neutralize Poison" || i.name === "Cure Critical Wounds"))?.slot ?? null
        : null;
      if (poisonCure !== null) {
        addLesson(state.turn, state.depth, "解毒", `HP${Math.round(hpPct * 100)}%、毒。解毒薬を使用`);
        state = await sendCommand({ type: CMD.QUAFF, itemIndex: poisonCure });
        continue;
      }
      const healSlot = hpPct < 0.35 ? findStrongHealingPotion(inv) : findHealingPotion(inv);
      // RULEFIX=poisonhold: 毒で HP 半分未満、回復薬なし、敵が見えない → 探索や帰還の歩きで新しい敵に会う前に、毒が抜けるまで休む
      if (healSlot === null && RULEFIX.has("poisonhold") && p.timed.poisoned > 0 && hpPct < 0.5 && monsters.length === 0) {
        state = await sendCommand({ type: CMD.REST, turns: 10 });
        continue;
      }
      if (healSlot !== null) {
        healingsUsed++;
        addLesson(state.turn, state.depth, "緊急回復", `HP${Math.round(hpPct * 100)}%${p.timed.poisoned > 0 ? "、毒" : ""}。停滞脱出より先に回復薬`);
        state = await sendCommand({ type: CMD.QUAFF, itemIndex: healSlot });
        continue;
      }
    }

    // === RULEFIX=breed: 既知の繁殖敵が増え始めたら階段へ。階段の上なら上り下りどちらでも使う ===
    if (BREED) {
      if (state.depth !== breedDepth) { breedDepth = state.depth; breedTicks = 0; breedLeaving = false; breedWalk = 0; }
      const kb = monsters.filter(knownBreeder);
      if (kb.length > 0) breedTicks++;
      if (!breedLeaving && state.depth >= 1 && (kb.length >= BREED_LEAVE_SEEN || breedTicks >= BREED_LEAVE_TICKS)) {
        breedLeaving = true;
        addLesson(state.turn, state.depth, "繁殖脱出", `既知の繁殖敵${kb.length}体 (${kb[0]?.name ?? "-"})、この階で${breedTicks}行動。階段へ`);
      }
      if (breedLeaving && !lowHpHold) {
        const here = tiles.find((t: any) => t.x === px && t.y === py);
        if (here?.feat === FEAT.DOWN_STAIR || here?.feat === FEAT.UP_STAIR) {
          state = await sendCommand({ type: here.feat === FEAT.DOWN_STAIR ? CMD.GO_DOWN : CMD.GO_UP });
          visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
          killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = [];
          levelEntryDetected = false; unreachableItems.clear();
          if (state.depth > maxDepthReached) maxDepthReached = state.depth;
          continue;
        }
        // 歩いて階段へ (繁殖敵に塞がれたら歩きが攻撃になる)。他の敵が隣接していれば下の戦闘に任せる
        const st = nearestStair(tiles, px, py);
        if (st && breedWalk < BREED_WALK_MAX && !monsters.some((m: any) => m.distance <= 1 && !knownBreeder(m))) {
          breedWalk++;
          state = await sendCommand({ type: CMD.WALK, direction: st.dir });
          continue;
        }
      }
    }

    // === RULEFIX=leave: 序盤の危険な敵が見えた / この階で 3 回逃げた / 毒か出血で HP 半分未満 → 最寄りの既知の階段から階を去る ===
    if (LEAVE && state.depth >= 1) {
      const afflicted = p.timed.poisoned > 0 || (p.timed.cut ?? 0) > 0;
      if (!afflicted) leaveHurtDone = false;
      if (!leaving) {
        const named = monsters.find((m: any) => leaveListed(m, p.level));
        const hurt = afflicted && hpPct < 0.5 && !leaveHurtDone;
        leaving = named ? `${named.name}(Lv${named.level},dist${named.distance})が見えた`
          : levelEscapes >= LEAVE_ESCAPES ? `この階で${levelEscapes}回逃走`
          : hurt ? `${p.timed.poisoned > 0 ? "毒" : "出血"}でHP${Math.round(hpPct * 100)}%` : "";
        if (leaving && !named && levelEscapes < LEAVE_ESCAPES) leaveHurtDone = true;
        if (leaving) { leaveWalk = 0; addLesson(state.turn, state.depth, "階離脱", `${leaving}。最寄りの階段から階を去る`); }
      }
      if (leaving) {
        const here = tiles.find((t: any) => t.x === px && t.y === py);
        if (here?.feat === FEAT.DOWN_STAIR || here?.feat === FEAT.UP_STAIR) {
          state = await sendCommand({ type: here.feat === FEAT.DOWN_STAIR ? CMD.GO_DOWN : CMD.GO_UP });
          continue;
        }
        // 歩いて階段へ (できれば敵に近づかない経路)。隣接する敵がいれば下の戦闘/逃走に任せる。階段が未発見なら通常の探索で探す
        const threats = monsters.filter((m: any) => leaveListed(m, p.level));
        const st = safeStairPath(tiles, px, py, threats, monsters, 200) ?? nearestStair(tiles, px, py);
        if (st && leaveWalk < LEAVE_WALK_MAX && !monsters.some((m: any) => m.distance <= 1)) {
          leaveWalk++;
          state = await sendCommand({ type: CMD.WALK, direction: st.dir });
          continue;
        }
      }
    }

    // === 最最優先: 極端な停滞 → 強制脱出 ===
    if (noProgressCount >= 500 && !lowHpHold) {
      // 500回停滞 → visited クリアで探索リセット (同じパターンを打破)
      addLesson(state.turn, state.depth, "停滞リセット",
        `${noProgressCount}回停滞。visitedクリアして探索再開`);
      visited.clear();
      lastVisitedSize = 0;
      noProgressCount = 0;
      continue;
    }
    if (noProgressCount >= 100 && !lowHpHold) {
      // 100回連続で新タイル訪問なし → 孤立部屋。階段があれば降下、なければ壁を掘る
      const forceDown = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.DOWN_STAIR);
      const forceUp = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.UP_STAIR);
      if (forceDown) {
        addLesson(state.turn, state.depth, "強制降下",
          `${noProgressCount}回連続停滞。条件無視で強制降下`);
        state = await sendCommand({ type: CMD.GO_DOWN });
        visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
        killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = []; levelEntryDetected = false; unreachableItems.clear();
        teleportLoopCount = 0; lastTeleportArea = "";
        if (state.depth > maxDepthReached) maxDepthReached = state.depth;
        continue;
      } else if (forceUp) {
        state = await sendCommand({ type: CMD.GO_UP });
        visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
        killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = []; levelEntryDetected = false; unreachableItems.clear();
        continue;
      }
      // 既知の階段へ歩ける → 最短経路で向かう (着いたら上の強制降下/上昇)。直線に掘るより確実
      const stairPath = nearestStair(tiles, px, py);
      if (stairPath && stairPath.len <= 150) {
        state = await sendCommand({ type: CMD.WALK, direction: stairPath.dir });
        continue;
      }
      // RULEFIX=seal: 行き詰まった (階段へも歩けない) → 最後の手段として閉めた扉を壁扱いから外し、探索に戻る
      if (SEAL && sealedDoors.size > 0) {
        addLesson(state.turn, state.depth, "扉再開放", `${noProgressCount}回停滞、階段にも行けない。閉めた扉${sealedDoors.size}枚を開け直す`);
        sealedDoors.clear();
        noProgressCount = 0;
        continue;
      }
      // 階段上にいない → 壁を掘って脱出 (方向を少しずつ変える)
      // noProgressCountをインデックスとして使い、8方向を順番に試す
      const tryDirIndex = (noProgressCount - 100) % ALL_DIRS.length;
      const visStair = findTile(tiles, FEAT.DOWN_STAIR) ?? findTile(tiles, FEAT.UP_STAIR);
      if (!canDigHard) {
        // 掘削具なし: 花崗岩を掘っても無駄。スクロール > 歩ける方向 > 扉/瓦礫 の順で脱出を試みる
        const teleSlot0 = findTeleportScroll(inv);
        const phaseSlot0 = findPhaseScroll(inv);
        if (noProgressCount % 20 === 0 && (teleSlot0 !== null || phaseSlot0 !== null)) {
          addLesson(state.turn, state.depth, "停滞脱出(掘削具なし)", `${noProgressCount}回停滞。${teleSlot0 !== null ? "Teleport" : "Phase"}`);
          state = await sendCommand({ type: CMD.READ, itemIndex: (teleSlot0 ?? phaseSlot0)! });
          stuckCount = 0; noProgressCount = 60; visited.clear(); lastVisitedSize = 0;
          continue;
        }
        if (noProgressCount >= 140 && state.depth > 0 && !(p.wordRecall > 0)) {
          const recallSlot0 = findRecallScroll(inv);
          if (recallSlot0 !== null) {
            addLesson(state.turn, state.depth, "WoR脱出", `${noProgressCount}回停滞、掘削具なし。Word of Recall`);
            state = await sendCommand({ type: CMD.READ, itemIndex: recallSlot0 });
            noProgressCount = 100;
            continue;
          }
        }
        // 歩ける隣接マスを順に歩く (未訪問優先、なければ回転)、扉/瓦礫だけ掘る
        const order = [...ALL_DIRS];
        let moved = false;
        for (let k = 0; k < order.length && !moved; k++) {
          const d = order[(tryDirIndex + k) % order.length]!;
          const [ddx, ddy] = dirOffsets[d] ?? [0, 0];
          const tt = tiles.find((t: any) => t.x === px + ddx && t.y === py + ddy);
          if (!tt) continue;
          if (PASSABLE_FEATS.has(tt.feat) && !visited.has(`${tt.x},${tt.y}`)) {
            state = await sendCommand({ type: CMD.WALK, direction: d }); moved = true;
          } else if (SOFT_DIG_FEATS.has(tt.feat)) {
            state = await sendCommand({ type: CMD.TUNNEL, direction: d }); moved = true;
          }
        }
        if (!moved) {
          const d = order[tryDirIndex]!;
          const [ddx, ddy] = dirOffsets[d] ?? [0, 0];
          const tt = tiles.find((t: any) => t.x === px + ddx && t.y === py + ddy);
          if (tt && PASSABLE_FEATS.has(tt.feat)) state = await sendCommand({ type: CMD.WALK, direction: d });
          else state = await sendCommand({ type: CMD.REST, turns: 1 } as any);
        }
        continue;
      }
      let tunnelDir: number;
      if (visStair && noProgressCount < 150) {
        // 最初の50回は階段方向へ
        tunnelDir = directionTo(px, py, visStair.x, visStair.y);
      } else {
        // その後は8方向をローテーション
        tunnelDir = ALL_DIRS[tryDirIndex]!;
      }
      const [tdx, tdy] = dirOffsets[tunnelDir] ?? [0, 0];
      const targetTile = tiles.find((t: any) => t.x === px + tdx && t.y === py + tdy);
      if (targetTile && PASSABLE_FEATS.has(targetTile.feat)) {
        state = await sendCommand({ type: CMD.WALK, direction: tunnelDir });
      } else {
        state = await sendCommand({ type: CMD.TUNNEL, direction: tunnelDir });
      }
      continue;
    }

    // === 最優先: 進捗なし脱出 (全priorityより上) ===
    if (noProgressCount >= 50) {
      const totalPassable = tiles.filter((t: any) => PASSABLE_FEATS.has(t.feat)).length;
      const unvisitedCount = totalPassable - visited.size;
      if (unvisitedCount > 10) {
        // テレポートは50回停滞時のみ (30→50で節約)
        const teleSlot = findTeleportScroll(inv);
        if (teleSlot !== null) {
          addLesson(state.turn, state.depth, "進行停止脱出",
            `${noProgressCount}回進捗なし@(${px},${py})。visited=${visited.size}/${totalPassable}。Teleport`);
          state = await sendCommand({ type: CMD.READ, itemIndex: teleSlot });
          stuckCount = 0; noProgressCount = 0;
          continue;
        }
        // Phase Doorは70回停滞時のみ (節約)
        if (noProgressCount >= 70) {
          const phaseSlot = findPhaseScroll(inv);
          if (phaseSlot !== null) {
            state = await sendCommand({ type: CMD.READ, itemIndex: phaseSlot });
            stuckCount = 0; noProgressCount = 0;
            continue;
          }
        }
        // スクロールなし → 降下 or 階段方向へ直進
        const onDown = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.DOWN_STAIR);
        if (onDown) {
          state = await sendCommand({ type: CMD.GO_DOWN });
          visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
          killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = []; levelEntryDetected = false; unreachableItems.clear();
          teleportLoopCount = 0; lastTeleportArea = "";
          if (state.depth > maxDepthReached) maxDepthReached = state.depth;
          continue;
        }
        // Word of Recall — スクロール/階段なしの最終手段 (noProgress >= 80)
        if (noProgressCount >= 80 && state.depth > 0 && !(p.wordRecall > 0)) {
          const recallSlot = findRecallScroll(inv);
          if (recallSlot !== null) {
            addLesson(state.turn, state.depth, "WoR脱出",
              `${noProgressCount}回停滞、スクロール枯渇。Word of Recallで帰還`);
            state = await sendCommand({ type: CMD.READ, itemIndex: recallSlot });
            // WoRはカウントダウン後に発動 — しばらく待つ
            continue;
          }
        }
        // 階段が見えるなら直進 (BFS到達不能でもdirectionToで歩く)
        const visibleStair = findTile(tiles, FEAT.DOWN_STAIR) ?? findTile(tiles, FEAT.UP_STAIR);
        if (visibleStair) {
          const stairDir = directionTo(px, py, visibleStair.x, visibleStair.y);
          const [sdx, sdy] = dirOffsets[stairDir] ?? [0, 0];
          const pathTile = tiles.find((t: any) => t.x === px + sdx && t.y === py + sdy);
          if (pathTile && PASSABLE_FEATS.has(pathTile.feat)) {
            state = await sendCommand({ type: CMD.WALK, direction: stairDir });
            continue;
          } else if (pathTile && digWorthwhile(pathTile.feat)) {
            state = await sendCommand({ type: CMD.TUNNEL, direction: stairDir });
            continue;
          }
          // 掘れない壁: 他の脱出手段 (後段) に任せる
        }
      }
    }

    // === スペル情報取得 ===
    const spells: SpellInfo[] = p.spells ?? [];
    const sp = p.sp ?? 0;
    const maxSp = p.maxSp ?? 0;
    const canCastSpells = spells.length > 0 && sp > 0 && !castBlocked();
    const newSpellSlots = p.newSpells ?? 0;

    // === 見えない攻撃者: 回復/離脱。脅威が続く間は休まない (下の REST は unseenThreat で止める) ===
    if (unseenThreat && !monsters.some((m: any) => m.distance <= 1) && !p.timed.blind && !p.timed.confused) {
      const n = unseenHits.length;
      const tele = findTeleportScroll(inv), phase = findPhaseScroll(inv);
      if (hpPct < 0.5) {
        const healSpell = canCastSpells ? findBestHealSpell(spells, p.level, sp, true) : null;
        if (healSpell) {
          spellsUsed++; healingsUsed++;
          state = await sendCommand({ type: CMD.CAST, spellIndex: healSpell.index, direction: 5 });
          continue;
        }
        const healSlot = findStrongHealingPotion(inv);
        if (healSlot !== null && hpPct >= 0.25) {
          healingsUsed++;
          state = await sendCommand({ type: CMD.QUAFF, itemIndex: healSlot });
          continue;
        }
      }
      // 階段の上なら階を変える (速い透明の敵は Phase Door で振り切れない)
      const here = tiles.find((t: any) => t.x === px && t.y === py);
      if (n >= 3 && (here?.feat === FEAT.UP_STAIR || here?.feat === FEAT.DOWN_STAIR)) {
        fleeAttempts++;
        addLesson(state.turn, state.depth, "見えない攻撃者", `見えない敵に${n}回攻撃された。階段で離脱`);
        state = await sendCommand({ type: here.feat === FEAT.DOWN_STAIR ? CMD.GO_DOWN : CMD.GO_UP });
        unseenHits = [];
        continue;
      }
      // Phase Door は 8 行動に 1 回まで (HP 35% 未満を除く)
      const phaseOk = hpPct < 0.35 || actionCount - lastUnseenPhase > 8;
      const escape = (hpPct < 0.25 || n >= 5) && tele !== null ? tele
        : (hpPct < 0.5 || n >= 3) && phaseOk ? (phase ?? tele) : null;
      if (escape !== null) {
        if (escape === phase) lastUnseenPhase = actionCount;
        fleeAttempts++;
        addLesson(state.turn, state.depth, "見えない攻撃者",
          `HP${Math.round(hpPct*100)}%、見えない敵に${n}回攻撃された。${escape === tele ? "Teleport" : "Phase Door"}で離脱`);
        state = await sendCommand({ type: CMD.READ, itemIndex: escape });
        if (escape === tele) { unseenHits = []; stuckCount = 0; noProgressCount = 0; visited.clear(); lastVisitedSize = 0; }
        continue;
      }
      // 逃げる手段なし (or Phase Door 待ち): 既知の階段へ歩く。着いたら上の階段ルールで階を変える
      const st = n >= 2 ? nearestStair(tiles, px, py) : null;
      if (st && st.len <= 80) {
        state = await sendCommand({ type: CMD.WALK, direction: st.dir });
        continue;
      }
    }

    // === 退避モード管理 ===
    if (retreatMode) {
      const retreatTurns = state.turn - retreatStartTurn;
      if (hpPct >= RETREAT_HP_THRESHOLD || retreatTurns > RETREAT_MAX_TURNS) {
        retreatMode = false;
      }
    }

    // === 退避モード: HP回復優先（逃走直後） ===
    // 逃走後はHPを回復しきるまで戦闘を避け、回復に専念する
    if (retreatMode && monsters.filter((m: any) => m.distance <= 1).length === 0) {
      if (hpPct < RETREAT_HP_THRESHOLD) {
        // 着地先が危険（敵が近い+HP低い）→ もう一回Teleport
        const nearThreat = monsters.filter((m: any) => m.distance <= 3).length;
        if (hpPct < 0.4 && nearThreat > 0 && state.depth >= 15) {
          const retreatTele = findTeleportScroll(inv);
          if (retreatTele !== null) {
            addLesson(state.turn, state.depth, "退避再テレポート",
              `退避中HP${Math.round(hpPct*100)}%に敵${nearThreat}体接近。再Teleport`);
            state = await sendCommand({ type: CMD.READ, itemIndex: retreatTele });
            stuckCount = 0; noProgressCount = 0; visited.clear(); lastVisitedSize = 0;
            continue;
          }
        }
        // 回復スペル
        if (canCastSpells) {
          const healSpell = findBestHealSpell(spells, p.level, sp, false);
          if (healSpell) {
            spellsUsed++; healingsUsed++;
            state = await sendCommand({ type: CMD.CAST, spellIndex: healSpell.index, direction: 5 });
            continue;
          }
        }
        // 回復ポーション（段階的）
        const healSlot = findTieredHealingPotion(inv, hpPct);
        if (healSlot !== null) {
          healingsUsed++;
          state = await sendCommand({ type: CMD.QUAFF, itemIndex: healSlot });
          continue;
        }
        // 回復手段なし → REST（敵が近くにいなければ）
        if (monsters.filter((m: any) => m.distance <= 4).length === 0 && !unseenThreat) {
          state = await sendCommand({ type: CMD.REST, turns: 5 });
          continue;
        }
        // 敵が中距離にいる → 退避解除して通常行動
        retreatMode = false;
      }
    }

    // === 定期ログ + 探索効率追跡 ===
    if (actionCount % 200 === 0) {
      const passableTiles = tiles.filter((t: any) => PASSABLE_FEATS.has(t.feat)).length;
      const unvisited = tiles.filter((t: any) => PASSABLE_FEATS.has(t.feat) && !visited.has(`${t.x},${t.y}`)).length;
      const explorationPct = passableTiles > 0 ? Math.round((1 - unvisited / passableTiles) * 100) : 100;
      explorationRateWindow.push(explorationPct);
      if (explorationRateWindow.length > 5) explorationRateWindow.shift();
      const spInfo = maxSp > 0 ? ` SP:${sp}/${maxSp}` : "";
      const digInfo = p.digging ? ` dig:${p.digging}` : "";
      const worInfo = p.wordRecall > 0 ? ` WoR:${p.wordRecall}` : "";
      const resInfo = playerResists.size > 0 ? ` res:${[...playerResists].join(",")}` : "";
      // Nearby threats summary
      const uniqueNear = monsters.filter((m: any) => m.isUnique && m.distance <= 10);
      const breathNear = monsters.filter((m: any) => (m.breathElements?.length ?? 0) > 0 && m.distance <= 10);
      const summonNear = monsters.filter((m: any) => m.hasSummon && m.distance <= 10);
      let threatInfo = "";
      if (uniqueNear.length > 0) threatInfo += ` UNIQ:${uniqueNear.map((m: any) => m.name).join(",")}`;
      if (breathNear.length > 0) threatInfo += ` BR:${breathNear.length}`;
      if (summonNear.length > 0) threatInfo += ` SUM:${summonNear.length}`;
      console.log(`  [状態] A${actionCount} T${state.turn} | DL${state.depth} CL${p.level} | HP:${p.hp}/${p.maxHp}${spInfo} | pos:(${px},${py}) | K:${totalKills}(L${killsThisLevel}) | P${passableTiles}/U${unvisited}(${explorationPct}%) | mon:${monsters.length} food:${p.timed.food}${digInfo}${worInfo}${resInfo}${threatInfo}`);
    }

    // === 優先度0: 状態異常対処 (混乱/盲目/麻痺) ===
    const isConfused = p.timed.confused > 0;
    const isBlind = p.timed.blind > 0;
    const isParalyzed = p.timed.paralyzed > 0;
    if (isConfused || isBlind || isParalyzed) {
      const status = isConfused ? "混乱" : isBlind ? "盲目" : "麻痺";
      const nearbyEnemies = monsters.filter((m: any) => m.distance <= 2);
      if (nearbyEnemies.length > 0 && p.timed.confused > 0) {
        // 隣のキノコ (HP1-2、胞子で混乱させ続ける) は殴って倒す
        const shroom = nearbyEnemies.find((m: any) => m.distance <= 1 && STATIONARY_RE.test(m.name ?? "") && !hurtsOnContact(m));
        if (shroom) {
          state = await sendCommand({ type: CMD.WALK, direction: directionTo(px, py, shroom.x, shroom.y) });
          continue;
        }
        // 近くの敵が動かない敵だけなら、薬を使わず離れる
        if (hpPct >= 0.4 && nearbyEnemies.every((m: any) => STATIONARY_RE.test(m.name ?? ""))) {
          const away = stepAwayFromStationary();
          if (away !== null) {
            state = await sendCommand({ type: CMD.WALK, direction: away });
            continue;
          }
        }
        // 混乱+敵が近い → ポーション飲む (混乱中でもquaffは可能)
        const healSlot = findHealingPotion(inv);
        if (healSlot !== null) {
          addLesson(state.turn, state.depth, "状態異常", `${status}中+敵${nearbyEnemies.length}体接近。回復薬で耐える`);
          healingsUsed++;
          state = await sendCommand({ type: CMD.QUAFF, itemIndex: healSlot });
          continue;
        }
        // 回復薬なし → ランダム歩行で逃走試行 (混乱中の移動はランダム方向)
        const rdir = ALL_DIRS[Math.floor(rand() * ALL_DIRS.length)];
        state = await sendCommand({ type: CMD.WALK, direction: rdir });
        continue;
      }
      // 敵がいない or 盲目/麻痺 → RESTで回復待ち
      if (actionCount % 50 === 0) {
        addLesson(state.turn, state.depth, "状態異常", `${status}中。RESTで回復待ち`);
      }
      state = await sendCommand({ type: CMD.REST });
      continue;
    }

    // === 優先度0.5: スペル学習 (新スペル枠があれば即学習) ===
    if (newSpellSlots > 0 && spells.length > 0 && actionCount >= studyBlockedUntil) {
      const toStudy = findStudyableSpell(spells, p.level);
      if (toStudy) {
        spellsLearned++;
        addLesson(state.turn, state.depth, "スペル学習",
          `${toStudy.name} (Lv${toStudy.level}, MP${toStudy.mana})を学習。残り枠${newSpellSlots - 1}`);
        state = await sendCommand({ type: CMD.STUDY, spellIndex: toStudy.index });
        // 学習が効かなかった (枠が減らない): しばらく諦める (無限ループ防止)
        if ((state.player?.newSpells ?? 0) >= newSpellSlots) studyBlockedUntil = actionCount + 200;
        continue;
      }
    }

    // === 優先度1: 食事 (飢餓防止) ===
    if (p.timed.food < 2000) {
      const foodSlot = findFood(inv);
      if (foodSlot !== null) {
        addLesson(state.turn, state.depth, "食事", `食料値${p.timed.food}で食事。飢餓は最優先対処`);
        state = await sendCommand({ type: CMD.EAT, itemIndex: foodSlot });
        continue;
      }
    }

    // === 優先度1.2: 光源 (vanilla の松明は燃え尽きる: 暗闇では読めず唱えられない) ===
    {
      const cur = (p.equipment ?? []).find((e: any) => e.tval === TVAL.LIGHT);
      const low = cur ? (typeof cur.fuel === "number" && /Torch/i.test(cur.name ?? "") && cur.fuel < 300) : true;
      const spare = low && actionCount >= lightBlockedUntil ? spareTorchSlot(inv) : null;
      if (spare !== null) {
        addLesson(state.turn, state.depth, "光源", `松明の残り${cur?.fuel ?? 0}ターン。予備の松明に替える`);
        state = await sendCommand({ type: CMD.EQUIP, itemIndex: spare });
        const after = (state.player?.equipment ?? []).find((e: any) => e.tval === TVAL.LIGHT);
        if ((after?.fuel ?? 0) < 300) lightBlockedUntil = actionCount + 200; // 替えられなかった: ループ防止
        continue;
      }
    }

    // === 優先度1.5: 検知スペル (新フロアで1回使用) ===
    if (!levelEntryDetected && canCastSpells && actionCount > 1) {
      const detectSpell = findCastableSpell(spells, DETECT_SPELLS, p.level, sp);
      if (detectSpell) {
        spellsUsed++;
        levelEntryDetected = true;
        addLesson(state.turn, state.depth, "検知",
          `新フロアで${detectSpell.name}を使用。周囲の状況把握`);
        state = await sendCommand({ type: CMD.CAST, spellIndex: detectSpell.index, direction: 5 });
        continue;
      }
    }

    // === 優先度1.8: 補給帰還 (回復薬が危険域ならWoRで町へ) ===
    // supplyWoRUsed: 同じ階で1回のみ (ループ防止)
    if ((state.depth >= 10 || (WIDE && state.depth >= 5)) && !(p.wordRecall > 0) && !supplyWoRUsedThisLevel
        && monsters.filter((m: any) => m.distance <= 3).length === 0) {
      const cureQty2 = inv.filter((i: any) => i.name?.includes("Cure") && i.qty > 0)
        .reduce((s: number, i: any) => s + i.qty, 0);
      const minCureForDepth = state.depth >= 35 ? 15 : state.depth >= 25 ? 10 : state.depth >= 20 ? 8 : state.depth >= 15 ? 5 : 3;
      // ルール基準 OR LLM判断で帰還
      let shouldRecall = state.depth >= 10 && cureQty2 < minCureForDepth;
      const llmRecallCd = (globalThis as any).__llmRecallCd ?? 0;
      // ログモード: DL5+ でWoR所持時のみ、補給量に関係なく、1000ターンに1回
      const recallAsk = WIDE
        ? state.depth >= 5 && findRecallScroll(inv) !== null && state.turn - llmRecallCd >= 1000
        : LLM_ENABLED && state.depth >= 15 && cureQty2 < minCureForDepth * 2 && state.turn - llmRecallCd >= 200;
      if (!shouldRecall && recallAsk) {
        (globalThis as any).__llmRecallCd = state.turn;
        const llmRecall = await llmShouldRecall(state);
        if (llmRecall === true) shouldRecall = true;
      }
      if (shouldRecall) {
        const recallSlot2 = findRecallScroll(inv);
        if (recallSlot2 !== null) {
          supplyWoRUsedThisLevel = true;
          addLesson(state.turn, state.depth, "補給帰還",
            `回復薬${cureQty2}個 < 最低${minCureForDepth}。WoRで補給帰還`);
          state = await sendCommand({ type: CMD.READ, itemIndex: recallSlot2 });
          continue;
        }
      }
    }

    // === 優先度1.9: 浅層の補給帰還 (回復薬切れ or Phase/油切れ → 上り階段で町へ) ===
    // RULEFIX=restock8: 補給帰還を DL8 まで (session 20: Phase なしの死亡 165 件のうち 113 件は DL5 以深か CL15 以上)
    if (RULEFIX.has("restock") && !ROLLOUT && state.depth >= 1 && ((state.depth <= (RULEFIX.has("restock8") ? 8 : 4) && p.level < 15) || restockTrip)) {
      const cureN = inv.filter((i: any) => i.name?.includes("Cure") && i.qty > 0).reduce((s: number, i: any) => s + i.qty, 0);
      const escN = inv.filter((i: any) => (i.name?.includes("Phase Door") || /Flask~? of oil/i.test(i.name ?? "")) && i.qty > 0)
        .reduce((s: number, i: any) => s + i.qty, 0);
      const foodN = inv.filter((i: any) => i.tval === TVAL.FOOD && i.qty > 0).reduce((s: number, i: any) => s + i.qty, 0);
      const lightNow = (p.equipment ?? []).find((e: any) => e.tval === TVAL.LIGHT);
      const lightLow = typeof lightNow?.fuel === "number" && /Torch/i.test(lightNow.name ?? "") && lightNow.fuel < 1500
        && spareTorchSlot(inv) === null;
      const restockGold = RULEFIX.has("restock100") ? 100 : 40;
      const kitOut = RULEFIX.has("restockboth") ? cureN === 0 && escN === 0 : cureN === 0 || escN === 0;
      if (!restockTrip && ((kitOut && restockGold <= p.gold) || ((foodN === 0 || lightLow) && p.gold >= 5))) {
        restockTrip = true;
        addLesson(state.turn, state.depth, "補給帰還", `回復薬${cureN} Phase/油${escN} 食料${foodN}、${p.gold}G。上り階段で町へ`);
      }
      if (restockTrip && monsters.every((m: any) => m.distance > 4)) {
        const onUp = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.UP_STAIR);
        if (onUp) {
          state = await sendCommand({ type: CMD.GO_UP });
          continue;
        }
        const up = findTile(tiles, FEAT.UP_STAIR);
        const dir = up ? bfsNextStep(tiles, px, py, up.x, up.y) : null;
        if (dir !== null) {
          state = await sendCommand({ type: CMD.WALK, direction: dir });
          continue;
        }
        // RULEFIX=upnav: 約 300 行動探しても上り階段が見えない → 下り階段へ戻り、降りてすぐ上る (この深さの階を作り直す)。
        // 接続階段なので降りた先は上り階段の上。探索で上り階段を探すと 1 階に数千行動かかり、その間に餓死していた
        if (state.depth < upRerollDepth) upRerolls = 0;
        if ((RULEFIX.has("upnav") || (RULEFIX.has("upnavfood") && foodN <= 3)) && upRerolls < 10
          && state.turn - levelEntryTurn > 3000) { // upnavfood: 食料が残り 3 個以下の時だけ (他の帰還では新しい階の危険の方が大きい)
          const onDown = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.DOWN_STAIR);
          if (onDown) {
            upRerolls++; upRerollDepth = state.depth;
            addLesson(state.turn, state.depth, "階振り直し", `補給帰還中、上り階段が見つからない。降りてすぐ上る (${upRerolls}回目)`);
            state = await sendCommand({ type: CMD.GO_DOWN });
            continue;
          }
          const stair = nearestStair(tiles, px, py); // 歩ける上り階段なら上り、多くは下り階段
          if (stair && stair.len <= 150) {
            state = await sendCommand({ type: CMD.WALK, direction: stair.dir });
            continue;
          }
        }
        // 上り階段が未発見 → 通常の探索に任せる (降下は restockTrip 中は止める)
      }
    }
    if (state.depth === 0) { restockTrip = false; upRerolls = 0; upRerollDepth = -1; }

    // === RULEFIX=devices: 回復の杖 (HP 半分未満)、Teleportation の杖 (HP 35% 未満で 3 マス以内に敵)、未知の杖 (安全な時) ===
    if (DEVICES && !ROLLOUT && actionCount - lastDeviceAction >= 2) {
      const dev = (re: RegExp, tv: number) => inv.find((i: any) => i.tval === tv && i.aware !== false && re.test(i.name ?? "") && deviceReady(i));
      const near3 = monsters.some((m: any) => m.distance <= 3);
      let use: { it: any; why: string } | null = null;
      const tele = dev(/^Teleportation$/, TVAL.STAFF);
      const heal = dev(HEAL_STAVES, TVAL.STAFF);
      if (tele && hpPct < 0.35 && near3) use = { it: tele, why: "緊急逃走" };
      else if (heal && hpPct < 0.5) use = { it: heal, why: "回復" };
      else {
        const unk = inv.find((i: any) => i.tval === TVAL.STAFF && i.aware === false && deviceReady(i) && !staffTriedLevel.has(i.name));
        const tried = /tried/.test(unk?.desc ?? "");
        const ok = tried
          ? hpPct >= 0.5 && monsters.some((m: any) => m.distance >= 2 && m.distance <= 6) && !monsters.some((m: any) => m.distance <= 1)
          : hpPct >= 0.75 && monsters.length === 0;
        if (unk && ok) { staffTriedLevel.add(unk.name); use = { it: unk, why: tried ? "識別、敵あり" : "識別" }; devicesTried++; }
      }
      const junk = monsters.length === 0 ? inv.find((i: any) => [TVAL.STAFF, TVAL.WAND, TVAL.ROD].includes(i.tval) && deviceUseless(i)) : undefined;
      if (!use && junk) {
        lastDeviceAction = actionCount;
        droppedTiles.add(`${px},${py}`);
        addLesson(state.turn, state.depth, "魔法の道具", `${junk.desc ?? junk.name}は使い道がないので落とす`);
        state = await sendCommand({ type: CMD.DROP, itemIndex: junk.slot, quantity: junk.qty });
        continue;
      }
      if (use) {
        lastDeviceAction = actionCount; devicesUsed++;
        const turnBefore = state.turn;
        addLesson(state.turn, state.depth, "魔法の道具", `${use.it.desc ?? use.it.name}を使う (${use.why}、HP${Math.round(hpPct * 100)}%)`);
        state = await sendCommand({ type: CMD.USE, itemIndex: use.it.slot });
        if (state.turn === turnBefore) deviceEmpty.add(`${use.it.tval}:${use.it.name}`);
        continue;
      }
    }

    // === RULEFIX=dangermlflee: 予測した死亡確率が高い → 階段の上なら階段、敵が近ければ逃走 (Borg 式) ===
    if (DANGERMLFLEE && predDeath20 !== undefined && predDeath20 >= MLFLEE_STAIRS && state.depth >= 1) {
      const pct = `death_20 ${Math.round(predDeath20 * 1000) / 10}%`;
      const here = tiles.find((t: any) => t.x === px && t.y === py);
      if ((here?.feat === FEAT.DOWN_STAIR || here?.feat === FEAT.UP_STAIR) && monsters.some((m: any) => m.distance <= 5)) {
        mlFleeStairs++; fleeAttempts++;
        if (mlFleeStairs <= 3 || mlFleeStairs % 10 === 0) addLesson(state.turn, state.depth, "危険度逃走", `${pct}: 階段の上なので${here.feat === FEAT.DOWN_STAIR ? "下り" : "上り"}階段 (#${mlFleeStairs})`);
        state = await sendCommand({ type: here.feat === FEAT.DOWN_STAIR ? CMD.GO_DOWN : CMD.GO_UP });
        continue;
      }
      const near = monsters.filter((m: any) => m.distance <= 3);
      if (predDeath20 >= MLFLEE_ESCAPE && near.length > 0 && actionCount - lastMlFleeAction >= 3) {
        // 速い敵・壁抜け・DL18+・極めて危険 → Teleport、それ以外は Phase Door (逃走スペルがあれば先に)
        const wantTele = predDeath20 >= MLFLEE_TELE || state.depth >= 18 || near.some((m: any) => m.hasPassWall || m.speed >= 120);
        const escSpell = canCastSpells ? findCastableSpell(spells, ESCAPE_SPELLS, p.level, sp) : null;
        const tele = findTeleportScroll(inv), phase = findPhaseScroll(inv);
        let cmd: Record<string, unknown> | null = null, what = "";
        if (escSpell && !(wantTele && tele !== null && !escSpell.name.includes("Teleport"))) { cmd = { type: CMD.CAST, spellIndex: escSpell.index, direction: 5 }; what = escSpell.name; spellsUsed++; }
        else if (wantTele && tele !== null) { cmd = { type: CMD.READ, itemIndex: tele }; what = "Teleportation"; }
        else if (phase !== null) { cmd = { type: CMD.READ, itemIndex: phase }; what = "Phase Door"; }
        else if (tele !== null) { cmd = { type: CMD.READ, itemIndex: tele }; what = "Teleportation"; }
        if (cmd) {
          mlFleeEscapes++; fleeAttempts++; lastMlFleeAction = actionCount;
          retreatMode = true; retreatStartTurn = state.turn;
          if (mlFleeEscapes <= 3 || mlFleeEscapes % 10 === 0) addLesson(state.turn, state.depth, "危険度逃走", `${pct}、敵${near.length}体(dist<=3): ${what} (#${mlFleeEscapes})`);
          state = await sendCommand(cmd);
          if (what.includes("Teleport")) { stuckCount = 0; noProgressCount = 0; visited.clear(); lastVisitedSize = 0; }
          continue;
        }
      }
    }

    // === 優先度2: 緊急回復+逃走 (深層は閾値引き上げ) ===
    const isExtremeDeep = state.depth >= 20;
    const isVeryDeep = state.depth >= 15;
    const isDeep = state.depth >= 10;
    // 序盤 (CL<10, DL<=5) は 1-2 発で HP の 3 割が飛ぶ: 半分で逃げる/回復する
    const lowCLEscape = RULEFIX.has("escape") && p.level < 10 && state.depth <= 5;
    const emergencyHpThreshold = isExtremeDeep ? 0.5 : isVeryDeep ? 0.4 : isDeep ? 0.35 : lowCLEscape ? 0.5 : 0.3;
    const fleeHpThreshold = isExtremeDeep ? 0.65 : isVeryDeep ? 0.55 : isDeep ? 0.5 : lowCLEscape ? 0.5 : 0.3;

    // HP危険域 → 敵がいれば逃走優先、敵がいなければ回復
    if (hpPct < emergencyHpThreshold) {
      const nearbyEnemies = monsters.filter((m: any) => m.distance <= 3);

      // 敵がいる場合: 逃走 > 回復 (forceFight対象は逃走しない)
      const anyNearbyForceFight = nearbyEnemies.some((m: any) => forceFightMonsters.has(m.name));
      if (nearbyEnemies.length > 0 && hpPct < fleeHpThreshold && !anyNearbyForceFight) {
        // 持続追跡者チェック — 同じ敵から繰り返し逃走ならTeleport優先
        const closestEnemy = nearbyEnemies.sort((a: any, b: any) => a.distance - b.distance)[0];
        const emFleeCount = closestEnemy ? (fleeCountByMonster.get(closestEnemy.name) || 0) : 0;
        if (closestEnemy) fleeCountByMonster.set(closestEnemy.name, emFleeCount + 1);
        const emergencyPersistent = emFleeCount >= 3;

        // 持続追跡者 → Phase Door無駄、Teleport/階段優先
        // 安全弁: 10回以上逃走 → forceFight登録して戦闘に移行
        // 除外: 速度130+、ユニーク+HP200超、ユニーク+格上 (消耗戦で確実に死ぬ)
        const isTooStrongToFight = closestEnemy && (
          (closestEnemy.speed >= 130 && (closestEnemy.level >= p.level * 0.7 || closestEnemy.level >= 15)) ||
          (closestEnemy.isUnique && closestEnemy.maxhp > 200) ||
          (closestEnemy.isUnique && closestEnemy.level > p.level + 3)
        );
        if (emFleeCount >= 10 && closestEnemy && !isTooStrongToFight) {
          if (LEAVE && state.depth >= 1) {
            // RULEFIX=leave: 強制戦闘の代わりに階を去る (上の leave ブロックが次の手から階段へ向かう)
            if (!leaving) { leaving = `${closestEnemy.name}から${emFleeCount + 1}回逃走`; leaveWalk = 0; addLesson(state.turn, state.depth, "階離脱", `${leaving}。強制戦闘の代わりに階を去る`); }
          } else {
            forceFightMonsters.add(closestEnemy.name);
            fleeCountByMonster.delete(closestEnemy.name);
          }
          // 回復してから戦闘 (逃走せずに下のヒーリングコードへ)
        }

        if (emergencyPersistent) {
          // 5回以上逃走 → Teleport/階段で距離を取る (WoRは使わない — 同深度に戻るとループ)
          if (emFleeCount >= 5) {
            const onDown = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.DOWN_STAIR);
            const onUp = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.UP_STAIR);
            if (onDown) {
              fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
              state = await sendCommand({ type: CMD.GO_DOWN });
              visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
              killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = [];
              levelEntryDetected = false; unreachableItems.clear();
              teleportLoopCount = 0; lastTeleportArea = ""; fleeCountByMonster.clear();
              if (state.depth > maxDepthReached) maxDepthReached = state.depth;
              continue;
            }
            if (onUp && state.depth > 1) {
              fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
              state = await sendCommand({ type: CMD.GO_UP });
              visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
              killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = [];
              levelEntryDetected = false; unreachableItems.clear();
              fleeCountByMonster.clear();
              continue;
            }
          }
          // Teleportで距離を取る
          const teleSlotP = findTeleportScroll(inv);
          if (teleSlotP !== null) {
            fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
            state = await sendCommand({ type: CMD.READ, itemIndex: teleSlotP });
            stuckCount = 0; noProgressCount = 0; visited.clear(); lastVisitedSize = 0;
            continue;
          }
        }

        // パスウォール持ち or DL18+ or 速度120+敵ではPhase Doorでは追いつかれる → Teleport優先
        const hasPassWallChaser = nearbyEnemies.some((m: any) => m.hasPassWall);
        const hasFastChaser = nearbyEnemies.some((m: any) => m.speed >= 120);
        const preferTeleport = hasPassWallChaser || hasFastChaser || state.depth >= 18;

        // 逃走スペル (Phase Door/Teleport Self)
        if (canCastSpells) {
          const escSpell = findCastableSpell(spells, ESCAPE_SPELLS, p.level, sp);
          if (escSpell) {
            fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
            spellsUsed++;
            addLesson(state.turn, state.depth, "魔法逃走",
              `HP${Math.round(hpPct*100)}%、${escSpell.name}で逃走`);
            state = await sendCommand({ type: CMD.CAST, spellIndex: escSpell.index, direction: 5 });
            if (escSpell.name.includes("Teleport")) {
              stuckCount = 0; noProgressCount = 0;
            }
            continue;
          }
        }
        // DL18+ or パスウォール持ち → Teleport優先 (Phase Doorは短距離で再遭遇しやすい)
        if (preferTeleport) {
          const teleSlotDeep = findTeleportScroll(inv);
          if (teleSlotDeep !== null) {
            fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
            addLesson(state.turn, state.depth, "深層逃走",
              `HP${Math.round(hpPct*100)}%、DL${state.depth}。Teleportで確実に距離を取る`);
            state = await sendCommand({ type: CMD.READ, itemIndex: teleSlotDeep });
            stuckCount = 0; noProgressCount = 0;
            visited.clear(); lastVisitedSize = 0;
            continue;
          }
        }
        // 速度130+の敵 → 階段/WoR優先 (Teleportでも追いつかれる)
        const hasVeryFastEnemy = nearbyEnemies.some((m: any) => m.speed >= 130);
        if (hasVeryFastEnemy) {
          const onStairDown = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.DOWN_STAIR);
          const onStairUp = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.UP_STAIR);
          if (onStairDown) {
            fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
            state = await sendCommand({ type: CMD.GO_DOWN });
            visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
            killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = [];
            levelEntryDetected = false; unreachableItems.clear();
            teleportLoopCount = 0; lastTeleportArea = ""; descentTeleportCount = 0; fleeCountByMonster.clear();
            if (state.depth > maxDepthReached) maxDepthReached = state.depth;
            continue;
          }
          if (onStairUp) {
            fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
            state = await sendCommand({ type: CMD.GO_UP });
            visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
            fleeCountByMonster.clear();
            continue;
          }
        }
        // 速度120+の敵が近くにいるならTeleport優先 (Phase Doorでは追いつかれる)
        const hasNearbyFastEnemy = nearbyEnemies.some((m: any) => m.speed >= 120);
        if (hasNearbyFastEnemy || state.depth >= 18) {
          const teleSlotFast = findTeleportScroll(inv);
          if (teleSlotFast !== null) {
            fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
            addLesson(state.turn, state.depth, "早期逃走",
              `HP${Math.round(hpPct*100)}%、高速敵あり。Teleportで確実離脱`);
            state = await sendCommand({ type: CMD.READ, itemIndex: teleSlotFast });
            stuckCount = 0; noProgressCount = 0; visited.clear(); lastVisitedSize = 0;
            continue;
          }
        }
        if (await stairsFirstFlee(nearbyEnemies, `HP${Math.round(hpPct * 100)}%、敵${nearbyEnemies.length}体(dist<=3)`)) continue;
        const phaseSlot = findPhaseScroll(inv);
        if (phaseSlot !== null) {
          fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
          addLesson(state.turn, state.depth, "早期逃走",
            `HP${Math.round(hpPct*100)}%、敵${nearbyEnemies.length}体(dist<=3)。Phase Doorで退避`);
          state = await sendCommand({ type: CMD.READ, itemIndex: phaseSlot });
          continue;
        }
        const teleSlot = findTeleportScroll(inv);
        if (teleSlot !== null) {
          fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
          addLesson(state.turn, state.depth, "緊急逃走",
            `HP危険域、Teleportationで脱出。生存最優先`);
          state = await sendCommand({ type: CMD.READ, itemIndex: teleSlot });
          stuckCount = 0; noProgressCount = 0;
          visited.clear(); lastVisitedSize = 0;
          continue;
        }
      }

      // 回復スペル → 回復薬 (スペルがあれば薬を温存)
      if (canCastSpells) {
        const healSpell = findBestHealSpell(spells, p.level, sp, true);
        if (healSpell) {
          spellsUsed++;
          healingsUsed++;
          addLesson(state.turn, state.depth, "緊急回復スペル",
            `HP${Math.round(hpPct*100)}%。${healSpell.name}(MP${healSpell.mana})で回復`);
          state = await sendCommand({ type: CMD.CAST, spellIndex: healSpell.index, direction: 5 });
          continue;
        }
      }
      const healSlot = findStrongHealingPotion(inv);
      if (healSlot !== null) {
        healingsUsed++;
        addLesson(state.turn, state.depth, "緊急回復",
          `HP${p.hp}/${p.maxHp}(${Math.round(hpPct*100)}%)で回復薬使用`);
        state = await sendCommand({ type: CMD.QUAFF, itemIndex: healSlot });
        continue;
      }

      // 回復薬なし → 逃走 (速度120+敵にはTeleport優先)
      const hasFastNearby = monsters.some((m: any) => m.distance <= 5 && m.speed >= 120);
      if ((hasFastNearby || state.depth >= 18) && monsters.length > 0) {
        const teleSlotFlee = findTeleportScroll(inv);
        if (teleSlotFlee !== null) {
          fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
          addLesson(state.turn, state.depth, "逃走",
            `HP${Math.round(hpPct*100)}%、回復薬なし、高速敵あり。Teleportで脱出`);
          state = await sendCommand({ type: CMD.READ, itemIndex: teleSlotFlee });
          stuckCount = 0; noProgressCount = 0; visited.clear(); lastVisitedSize = 0;
          continue;
        }
      }
      if (monsters.length > 0 && await stairsFirstFlee(monsters.filter((m: any) => m.distance <= 5), `HP${Math.round(hpPct * 100)}%、回復薬なし`)) continue;
      const phaseSlot = findPhaseScroll(inv);
      if (phaseSlot !== null && monsters.length > 0) {
        fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
        addLesson(state.turn, state.depth, "逃走",
          `HP${Math.round(hpPct*100)}%、回復薬なし、敵${monsters.length}体。Phase Doorで退避`);
        state = await sendCommand({ type: CMD.READ, itemIndex: phaseSlot });
        continue;
      }
      const teleSlot2 = findTeleportScroll(inv);
      if (teleSlot2 !== null && monsters.length > 0) {
        fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
        state = await sendCommand({ type: CMD.READ, itemIndex: teleSlot2 });
        stuckCount = 0; noProgressCount = 0;
        visited.clear(); lastVisitedSize = 0;
        continue;
      }
    }

    // === 優先度3: 戦術的回復 (HP低下 かつ敵なし) ===
    const tacticalHealThreshold = isExtremeDeep ? 0.75 : isVeryDeep ? 0.65 : 0.6;
    if (hpPct < tacticalHealThreshold && monsters.filter((m: any) => m.distance <= 2).length === 0) {
      // 回復スペル優先 (薬を節約)
      if (canCastSpells) {
        const healSpell = findBestHealSpell(spells, p.level, sp, false);
        if (healSpell) {
          spellsUsed++;
          healingsUsed++;
          state = await sendCommand({ type: CMD.CAST, spellIndex: healSpell.index, direction: 5 });
          continue;
        }
      }
      // 段階的ポーション: HP残量に応じた適切な強さを選択
      const healSlot = findTieredHealingPotion(inv, hpPct);
      if (healSlot !== null) {
        healingsUsed++;
        state = await sendCommand({ type: CMD.QUAFF, itemIndex: healSlot });
        continue;
      }
      // 回復薬なし → RESTで自然回復 (MPも回復)
      if (hpPct < 0.5 && !unseenThreat) {
        state = await sendCommand({ type: CMD.REST, turns: 10 });
        continue;
      }
    }

    // === 優先度3.5: バフスペル (敵が近くにいて戦闘前) ===
    if (canCastSpells && monsters.filter((m: any) => m.distance <= 3).length > 0) {
      const buffSpell = findCastableSpell(spells, BUFF_SPELLS, p.level, sp);
      if (buffSpell && sp >= buffSpell.mana * 2) { // MPに余裕がある場合のみ
        spellsUsed++;
        addLesson(state.turn, state.depth, "バフ",
          `敵接近中。${buffSpell.name}(MP${buffSpell.mana})でバフ`);
        state = await sendCommand({ type: CMD.CAST, spellIndex: buffSpell.index, direction: 5 });
        continue;
      }
    }

    // === 優先度3.6: 速度ポーション (危険敵接近時 or 多数敵 or 召喚/ブレス持ち) ===
    if (!(p.timed?.fast > 0)) {  // まだ加速されていない
      const nearEnemyCount = monsters.filter((m: any) => m.distance <= 3).length;
      const hasDangerNear = monsters.some((m: any) =>
        m.distance <= 5 && isDangerousMonster(m, p.level, state.depth, playerResists)
      );
      // 速度120+の敵が距離8以内 → 早めに加速 (blood falcon等の高速群れ対策)
      const hasFastMonsterNear = monsters.some((m: any) =>
        m.distance <= 8 && m.speed >= 120
      );
      // 召喚持ちは素早く倒さないと数が増える
      const hasSummonerNear = monsters.some((m: any) => m.hasSummon && m.distance <= 5);
      // DL30+では敵が近くにいるだけで加速（生存最優先）
      const isUltraDeep = state.depth >= 30;
      if ((hasDangerNear || hasFastMonsterNear || nearEnemyCount >= 3 || hasSummonerNear) && isDeep
          || (isUltraDeep && nearEnemyCount >= 1)) {
        const speedSlot = findSpeedPotion(inv);
        if (speedSlot !== null) {
          addLesson(state.turn, state.depth, "加速",
            `危険な状況（敵${nearEnemyCount}体近接）。Speed potionで加速`);
          state = await sendCommand({ type: CMD.QUAFF, itemIndex: speedSlot });
          continue;
        }
      }
    }

    // === 優先度3.8: 遠距離攻撃スペル (距離2-6の敵にボルト/ビーム) ===
    if (canCastSpells) {
      const adjacentCount = monsters.filter((m: any) => m.distance <= 1).length;
      const rangedTargets = monsters.filter((m: any) =>
        m.distance >= 2 && m.distance <= 6 && !isDangerousMonster(m, p.level, state.depth, playerResists)
      );
      if (rangedTargets.length > 0 && adjacentCount === 0) {
        const atkSpell = findCastableSpell(spells, ATTACK_SPELLS, p.level, sp);
        if (atkSpell && sp >= atkSpell.mana) {
          // 召喚持ちは優先排除 (増殖前に倒す)、次に近い敵を狙う
          const target = rangedTargets.sort((a: any, b: any) => {
            const aSummon = a.hasSummon ? -10 : 0;
            const bSummon = b.hasSummon ? -10 : 0;
            return (a.distance + aSummon) - (b.distance + bSummon);
          })[0];
          const dir = directionTo(px, py, target.x, target.y);
          spellsUsed++;
          state = await sendCommand({ type: CMD.CAST, spellIndex: atkSpell.index, direction: dir });
          const newMonsters = state.monsters;
          if (newMonsters.length < monsters.length) {
            totalKills++;
            killsThisLevel++;
            console.log(`  [遠距離撃破] Turn ${state.turn} DL${state.depth} CL${state.player.level} - ${atkSpell.name}→${target.name}(dist${target.distance}) (累計${totalKills})`);
          }
          continue;
        }
      }
    }

    // === 優先度3.7: 危険モンスター回避 (隣接前に逃走判定) ===
    const dangerDetectRange = isVeryDeep ? 6 : 5;
    const dangerFleeRange = isVeryDeep ? 4 : 3;
    let nearDangerous = monsters.filter((m: any) =>
      m.distance <= dangerDetectRange && isDangerousMonster(m, p.level, state.depth, playerResists) && !forceFightMonsters.has(m.name)
    );
    // ログ/ロールアウトモード: 6マス以内に入った各モンスター個体を1回ずつ判断 (rules = ルール自身の分類)
    const fkey = (m: any) => `${state.depth}:${m.midx}:${m.name}`;
    if (WIDE) {
      const seenMon = (globalThis as any).__logSeenMon ?? new Set<string>();
      (globalThis as any).__logSeenMon = seenMon;
      for (const m of monsters) {
        if (m.distance > 6) continue;
        const key = fkey(m);
        if (seenMon.has(key)) continue;
        seenMon.add(key);
        let rulesChoice = rulesFightChoice(m, p.level, inv, tiles, px, py);
        if (rulesChoice === "melee" && isDangerousMonster(m, p.level, state.depth, playerResists) && !forceFightMonsters.has(m.name)) rulesChoice = "flee";
        const ch = await decideFight(state, m, rulesChoice);
        if (ch) fightPlan.set(key, ch);
      }
    }
    // LLM判断: ルールでは安全だが怪しい敵にLLMに聞く（同名敵は1回だけ）
    if (nearDangerous.length === 0 && DECISION_ON && !WIDE) {
      const llmAskedMonsters = (globalThis as any).__llmAskedMonsters ?? new Set<string>();
      (globalThis as any).__llmAskedMonsters = llmAskedMonsters;
      const suspicious = monsters.filter((m: any) =>
        m.distance <= dangerFleeRange && !forceFightMonsters.has(m.name) &&
        !llmAskedMonsters.has(m.name) &&
        (m.maxhp > 150 || m.level > p.level + 5 || m.isUnique) &&
        m.distance >= 2
      );
      if (suspicious.length > 0) {
        const sus = suspicious[0];
        llmAskedMonsters.add(sus.name);
        const ch = await decideFight(state, sus, "melee");
        if (ch) fightPlan.set(fkey(sus), ch);
        if (ch === "flee") nearDangerous = [sus];
      }
    }
    // === RULEFIX=earlyrun: 前回ここを通ってから最大 HP の 1/3 以上減った (CL4 以下) → 隣接敵から階段/Phase で離れる ===
    if (EARLYRUN) {
      const drop = earlyLastHp === null ? 0 : earlyLastHp - p.hp;
      earlyLastHp = p.hp;
      const adj = monsters.filter((m: any) => m.distance <= 1 && !knownBreeder(m)).sort((a: any, b: any) => b.level - a.level)[0];
      if (adj && p.level <= 4 && state.depth >= 1 && drop >= p.maxHp / 3) {
        const fl = earlyFleeCommand(tiles, px, py, inv, adj, actionCount, { plevel: p.level, pspeed: p.speed, monsters, turn: state.turn, depth: state.depth });
        if (fl) {
          earlyFleeActions++; fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
          if (LEAVE && fl.kind === "walk") levelEscapes++; // RULEFIX=leave: 歩いて逃げ始めた (Phase/Teleport は sendCommand で数える)
          addLesson(state.turn, state.depth, "序盤離脱", `${adj.name}(Lv${adj.level})に1手でHP${drop}/${p.maxHp}。${fl.kind}`);
          state = await sendCommand(fl.cmd);
          earlyLastHp = state.player.hp;
          continue;
        }
      }
    }

    // === 序盤トルクキット: fight = {melee, throw, flee} の実行 ===
    // 判断済み個体 (fightPlan) はそれに従う。未判断の序盤高速/強敵はルール分類 (油 > 逃走 > 殴る)
    {
      let acted = false;
      const cands = monsters.filter((m: any) => m.distance <= 8)
        .sort((a: any, b: any) => (knownBreeder(b) ? 1 : 0) - (knownBreeder(a) ? 1 : 0) || a.distance - b.distance);
      for (const m of cands) {
        const key = fkey(m);
        let choice: FightChoice | null = fightPlan.get(key) ?? null;
        const planned = choice !== null;
        // RULEFIX=fire: 射撃武器と矢弾があれば、離れた敵 (2 マス以上、射線あり) は殴りに行く前に撃つ。逃げる相手と油を投げる相手は除く
        // RULEFIX=fireadj: 隣接する敵も撃つ (4.2 は隣接射撃に不利がない。レンジャーの近接は弱い)
        if (RULEFIX.has("fire") && state.depth >= 1 && m.distance >= (RULEFIX.has("fireadj") ? 1 : 2) && choice !== "flee"
          && !(choice === "throw" && findOilFlask(inv) !== null)) {
          const ammo = findAmmo(p);
          const losKey = `${px},${py}>${m.x},${m.y}`;
          if (ammo !== null && hasLOS(tiles, px, py, m.x, m.y) && !noThrowLOS.has(losKey)) {
            const turnBefore = state.turn;
            state = await sendCommand({ type: CMD.FIRE, target: { x: m.x, y: m.y }, itemIndex: ammo });
            if (state.turn !== turnBefore) {
              shotsFired++;
              acted = true;
              break;
            }
            noThrowLOS.add(losKey); // サーバが拒否: この射線は投擲と同じく覚えておく
          }
        }
        // RULEFIX=devices: 隣にいない見えている敵へ、未知の魔法棒/ロッドを試す (識別)
        if (DEVICES && state.depth >= 1 && m.distance >= 2 && choice !== "flee" && hasLOS(tiles, px, py, m.x, m.y)) {
          const unk = inv.find((i: any) => (i.tval === TVAL.WAND || i.tval === TVAL.ROD) && i.aware === false && deviceReady(i));
          if (unk) {
            const turnBefore = state.turn;
            devicesTried++; devicesUsed++;
            addLesson(state.turn, state.depth, "魔法の道具", `${unk.desc ?? unk.name}を${m.name}(dist${m.distance})へ (識別)`);
            state = await sendCommand({ type: unk.tval === TVAL.WAND ? CMD.AIM : CMD.ZAP, itemIndex: unk.slot, target: { x: m.x, y: m.y } });
            if (state.turn === turnBefore) deviceEmpty.add(`${unk.tval}:${unk.name}`);
            else { acted = true; break; }
          }
        }
        if (!choice) {
          if (!lowCLDanger(m, p.level) && !meleeTooCostly(m, p)) continue;
          choice = rulesFightChoice(m, p.level, inv, tiles, px, py);
        }
        // RULEFIX=devices: 危険な敵 (油/逃走/近接見送りの対象) が離れているうちに、攻撃の魔法棒/ロッドを使う (油より先)
        if (DEVICES && m.distance >= 2 && choice !== "flee" && hasLOS(tiles, px, py, m.x, m.y)) {
          const wand = inv.find((i: any) => (i.tval === TVAL.WAND || i.tval === TVAL.ROD) && i.aware !== false
            && ATTACK_DEVICES.test(i.name ?? "") && deviceReady(i));
          if (wand) {
            const turnBefore = state.turn;
            devicesUsed++;
            if (devicesUsed <= 3 || devicesUsed % 10 === 0) addLesson(state.turn, state.depth, "魔法の道具", `${wand.desc ?? wand.name}を${m.name}(dist${m.distance})へ (#${devicesUsed})`);
            state = await sendCommand({ type: wand.tval === TVAL.WAND ? CMD.AIM : CMD.ZAP, itemIndex: wand.slot, target: { x: m.x, y: m.y } });
            if (state.turn !== turnBefore) { acted = true; break; }
            deviceEmpty.add(`${wand.tval}:${wand.name}`);
          }
        }
        if (choice === "throw") {
          const flask = findOilFlask(inv);
          const losKey = `${px},${py}>${m.x},${m.y}`;
          if (flask !== null && m.distance <= THROW_RANGE && hasLOS(tiles, px, py, m.x, m.y) && !noThrowLOS.has(losKey)) {
            const turnBefore = state.turn;
            throwsMade++;
            if (throwsMade <= 3 || throwsMade % 10 === 0) addLesson(state.turn, state.depth, "投擲", `${m.name}(Lv${m.level},spd${m.speed},dist${m.distance})へ油を投擲 (#${throwsMade})`);
            state = await sendCommand({ type: CMD.THROW, target: { x: m.x, y: m.y }, itemIndex: flask });
            {
              // サーバーの投擲メッセージ ("Your flask of oil hits/kills/misses ...") から命中/撃破を数える
              // (C Angband follows the hit with "The X dies.", "You have N Flasks of oil", "The Flask of oil breaks.")
              const tm = ((state.messages ?? []) as any[]).slice(-6).map((x: any) => String(x));
              const hit = tm.some(x => /^Your .* (hits|kills) /.test(x));
              if (hit) throwHits++;
              if (tm.some(x => /^Your .* and kills it/.test(x)) || (hit && tm.some(x => /^The .* (dies|is destroyed)\.$/.test(x)))) throwKills++;
            }
            if (state.turn !== turnBefore) {
              acted = true;
              break;
            }
            // サーバが拒否 (ターン経過なし): hasLOS とサーバの射線判定がずれる地点は覚えて殴る
            throwsMade--;
            noThrowLOS.add(losKey);
          }
          choice = "melee"; // 油なし/射線なし → 殴る
        }
        if (choice === "flee") {
          const fleeN = (fleeSteps.get(key) ?? 0) + 1;
          fleeSteps.set(key, fleeN);
          const fl = fleeN > 60 ? null : earlyFleeCommand(tiles, px, py, inv, m, actionCount, { plevel: p.level, pspeed: p.speed, monsters, turn: state.turn, depth: state.depth }); // 同一個体から60手逃げても振り切れない → 諦めて殴る
          if (fl) {
            earlyFleeActions++; fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
            if (LEAVE && fleeN === 1 && fl.kind === "walk") levelEscapes++; // RULEFIX=leave: この個体から歩いて逃げ始めた
            if (fl.kind === "stairs") earlyFleeStairs++;
            if (fl.kind === "phase") phasesRead++;
            if (earlyFleeActions <= 3 || fl.kind !== "walk") addLesson(state.turn, state.depth, "序盤逃走", `${m.name}(Lv${m.level},spd${m.speed},dist${m.distance})から${fl.kind}`);
            state = await sendCommand(fl.cmd);
            acted = true;
            break;
          }
          // 逃走手段なし → 計画済みなら既存の逃走処理へ、ルール分類なら殴る
          if (planned && !nearDangerous.includes(m)) nearDangerous.push(m);
          else if (!planned) choice = "melee";
        }
        if (choice === "melee") nearDangerous = nearDangerous.filter((x: any) => x !== m);
      }
      if (acted) continue;
    }
    if (nearDangerous.length > 0 && nearDangerous[0].distance <= dangerFleeRange) {
      const dangerMon = nearDangerous[0];
      const monFleeCount = fleeCountByMonster.get(dangerMon.name) || 0;
      fleeCountByMonster.set(dangerMon.name, monFleeCount + 1);

      // forceFight禁止: 速度130+、ユニーク+高HP、ユニーク+格上
      const isTooFastToFight = dangerMon.speed >= 130 && (dangerMon.level >= p.level * 0.7 || dangerMon.level >= 15);
      const isTooToughToFight = (dangerMon.isUnique && dangerMon.maxhp > 200) ||
        (dangerMon.isUnique && dangerMon.level > p.level + 3);

      // DL30+ユニーク: 2回逃走したらWoR帰還 (Lokkak等の追跡型ユニーク対策)
      if (dangerMon.isUnique && state.depth >= 30 && monFleeCount >= 2 && !(p.wordRecall > 0)) {
        const recallSlotUniq = findRecallScroll(inv);
        if (recallSlotUniq !== null) {
          fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
          addLesson(state.turn, state.depth, "ユニーク帰還",
            `${dangerMon.name}(Lv${dangerMon.level})から${monFleeCount+1}回逃走。DL30+ユニーク→WoR帰還`);
          state = await sendCommand({ type: CMD.READ, itemIndex: recallSlotUniq });
          continue;
        }
      }

      // 6回以上逃走 → もう逃げるのは無駄。forceFight登録して戦闘に移行 (強敵は除外)
      if (monFleeCount >= 6 && !isTooFastToFight && !isTooToughToFight) {
        if (LEAVE && state.depth >= 1) {
          // RULEFIX=leave: 強制戦闘の代わりに階を去る
          if (!leaving) { leaving = `${dangerMon.name}から${monFleeCount + 1}回逃走`; leaveWalk = 0; addLesson(state.turn, state.depth, "階離脱", `${leaving}。強制戦闘の代わりに階を去る`); }
        } else {
          forceFightMonsters.add(dangerMon.name);
          fleeCountByMonster.delete(dangerMon.name);
        }
        // 下のisDangerousチェックを再評価 → 戦闘に移行 (逃走しない)
      }

      // 同じ敵から2回以上逃走 → Phase Doorは無駄、Teleportation or 階段脱出
      // 速度130+は常にpersistent扱い (forceFightに入れないため)
      const isPersistentChaser = (monFleeCount >= 2 || isTooFastToFight) && !forceFightMonsters.has(dangerMon.name);

      if (isPersistentChaser) {
        // 速度130+は階段/WoR優先 (Teleportでも追いつかれる)
        if (isTooFastToFight) {
          // 1st: 足元に階段があれば即降下
          const onDownFast = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.DOWN_STAIR);
          const onUpFast = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.UP_STAIR);
          if (onDownFast) {
            fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
            addLesson(state.turn, state.depth, "高速敵脱出",
              `${dangerMon.name}(spd${dangerMon.speed})。階段降下で階層脱出`);
            state = await sendCommand({ type: CMD.GO_DOWN });
            visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
            killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = [];
            levelEntryDetected = false; unreachableItems.clear();
            teleportLoopCount = 0; lastTeleportArea = ""; descentTeleportCount = 0; fleeCountByMonster.clear();
            if (state.depth > maxDepthReached) maxDepthReached = state.depth;
            continue;
          }
          if (onUpFast) {
            fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
            addLesson(state.turn, state.depth, "高速敵脱出",
              `${dangerMon.name}(spd${dangerMon.speed})。階段上昇で階層脱出`);
            state = await sendCommand({ type: CMD.GO_UP });
            visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
            killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = [];
            fleeCountByMonster.clear();
            continue;
          }
          // 2nd: WoRで帰還 (Teleportより確実) — 速度130+は初回から即WoR
          if (state.depth > 0 && !(p.wordRecall > 0)) {
            const recallSlotFast = findRecallScroll(inv);
            if (recallSlotFast !== null) {
              fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
              addLesson(state.turn, state.depth, "高速敵脱出",
                `${dangerMon.name}(spd${dangerMon.speed})から${monFleeCount+1}回逃走。WoR帰還`);
              state = await sendCommand({ type: CMD.READ, itemIndex: recallSlotFast });
              continue;
            }
          }
          // 3rd: Teleport (最終手段 — 1回だけ。追いつかれたら次はWoR)
          if (monFleeCount < 2) {
            const teleSlotFast = findTeleportScroll(inv);
            if (teleSlotFast !== null) {
              fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
              addLesson(state.turn, state.depth, "高速敵回避",
                `${dangerMon.name}(spd${dangerMon.speed})。Teleport(1回限り)で距離確保`);
              state = await sendCommand({ type: CMD.READ, itemIndex: teleSlotFast });
              stuckCount = 0; noProgressCount = 0; visited.clear(); lastVisitedSize = 0;
              continue;
            }
          }
        }
        // 通常の persistent chaser: Teleportで距離を取る
        const teleSlotChaser = findTeleportScroll(inv);
        if (teleSlotChaser !== null) {
          fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
          addLesson(state.turn, state.depth, "追跡者脱出",
            `${dangerMon.name}(Lv${dangerMon.level})から${monFleeCount+1}回目。Teleportで脱出`);
          state = await sendCommand({ type: CMD.READ, itemIndex: teleSlotChaser });
          stuckCount = 0; noProgressCount = 0; visited.clear(); lastVisitedSize = 0;
          continue;
        }
        // Teleportなし → 階段で脱出
        const onDownStair = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.DOWN_STAIR);
        if (onDownStair) {
          fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
          addLesson(state.turn, state.depth, "追跡者脱出",
            `${dangerMon.name}から${monFleeCount+1}回目。階段で脱出`);
          state = await sendCommand({ type: CMD.GO_DOWN });
          visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
          killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = [];
          levelEntryDetected = false; unreachableItems.clear();
          teleportLoopCount = 0; lastTeleportArea = ""; descentTeleportCount = 0; fleeCountByMonster.clear();
          if (state.depth > maxDepthReached) maxDepthReached = state.depth;
          continue;
        }
        // 5回以上逃走+Teleportなし → WoRで完全離脱
        if (monFleeCount >= 5 && state.depth > 0 && !(p.wordRecall > 0)) {
          const recallSlot = findRecallScroll(inv);
          if (recallSlot !== null) {
            fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
            addLesson(state.turn, state.depth, "追跡者脱出",
              `${dangerMon.name}から${monFleeCount+1}回目。WoRで帰還`);
            state = await sendCommand({ type: CMD.READ, itemIndex: recallSlot });
            continue;
          }
        }
      }

      // 通常の危険敵逃走
      if (canCastSpells) {
        const escSpell = findCastableSpell(spells, ESCAPE_SPELLS, p.level, sp);
        if (escSpell) {
          fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
          spellsUsed++;
          const breathInfo = dangerMon.breathElements?.length ? ` BR:${dangerMon.breathElements.join("/")}` : "";
          const summonInfo = dangerMon.hasSummon ? " +SUM" : "";
          addLesson(state.turn, state.depth, "危険敵回避",
            `${dangerMon.name}(Lv${dangerMon.level},spd${dangerMon.speed}${breathInfo}${summonInfo})接近。${escSpell.name}で退避`);
          state = await sendCommand({ type: CMD.CAST, spellIndex: escSpell.index, direction: 5 });
          if (escSpell.name.includes("Teleport")) { stuckCount = 0; noProgressCount = 0; }
          continue;
        }
      }
      // 速度120+、高HP300+、DL20+ユニーク、DL18+の敵はPhase Door(2マス)では逃げきれない → Teleport優先
      const dangerIsFast = dangerMon.speed >= 120;
      const dangerIsHighHp = dangerMon.maxhp >= 300;
      const dangerIsDeepUnique = dangerMon.isUnique && state.depth >= 20;
      if (dangerIsFast || dangerIsHighHp || dangerIsDeepUnique || state.depth >= 18) {
        const teleSlotFast = findTeleportScroll(inv);
        if (teleSlotFast !== null) {
          fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
          addLesson(state.turn, state.depth, "危険敵回避",
            `${dangerMon.name}(Lv${dangerMon.level},spd${dangerMon.speed})接近。Teleportで確実離脱`);
          state = await sendCommand({ type: CMD.READ, itemIndex: teleSlotFast });
          stuckCount = 0; noProgressCount = 0; visited.clear(); lastVisitedSize = 0;
          continue;
        }
      }
      if (await stairsFirstFlee([dangerMon], `${dangerMon.name}(Lv${dangerMon.level})接近`)) continue;
      const phaseSlot = findPhaseScroll(inv);
      if (phaseSlot !== null) {
        fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
        addLesson(state.turn, state.depth, "危険敵回避",
          `${dangerMon.name}(Lv${dangerMon.level},spd${dangerMon.speed})接近。Phase Doorで退避`);
        state = await sendCommand({ type: CMD.READ, itemIndex: phaseSlot });
        continue;
      }
      const teleSlot = findTeleportScroll(inv);
      if (teleSlot !== null) {
        fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
        addLesson(state.turn, state.depth, "危険敵回避",
          `${dangerMon.name}(Lv${dangerMon.level})接近。Teleportで脱出`);
        state = await sendCommand({ type: CMD.READ, itemIndex: teleSlot });
        stuckCount = 0; noProgressCount = 0; visited.clear(); lastVisitedSize = 0;
        continue;
      }
      // 逃走手段なし → 戦うしかない
    }

    // === 優先度4: 隣接敵との戦闘 ===
    // 低CLでは動かない敵 (キノコ/ゼリー/カビ/浮遊眼) を殴らない: 胞子/接触/麻痺で CL1 が死ぬ (経験値より危険)
    const adjacentMonsters = monsters.filter((m: any) => m.distance <= 1 && !(p.level < 12 && hurtsOnContact(m)));
    // 殴らない動かない敵の隣にいる → 1歩離れる (直後の BFS は隣接マスを避ける)
    if (adjacentMonsters.length === 0 && p.level < 12 && monsters.some((m: any) => m.distance <= 1 && hurtsOnContact(m))) {
      const away = stepAwayFromStationary();
      if (away !== null) {
        state = await sendCommand({ type: CMD.WALK, direction: away });
        continue;
      }
    }
    if (adjacentMonsters.length > 0) {
      if (WHIRL && p.level >= 5 && adjacentMonsters.length >= 2 && canCastSpells) {
        const whirl = findCastableSpell(spells, ["Whirlwind Attack"], p.level, sp);
        if (whirl) {
          const turnBefore = state.turn;
          spellsUsed++;
          state = await sendCommand({ type: CMD.CAST, spellIndex: whirl.index, direction: 5 });
          if (state.turn !== turnBefore) continue;
          spellsUsed--;
        }
      }
      // ターゲット選択: 既知の繁殖敵 (RULEFIX=breed) と召喚持ちを優先排除、次にブレス持ち、次に最弱
      const target = adjacentMonsters.sort((a: any, b: any) => {
        // 召喚持ちは最優先で排除（放置すると増殖）
        const aSummon = a.hasSummon ? -1000 : 0;
        const bSummon = b.hasSummon ? -1000 : 0;
        // ブレス持ちは次に優先
        const aBreath = (a.breathElements?.length ?? 0) > 0 ? -500 : 0;
        const bBreath = (b.breathElements?.length ?? 0) > 0 ? -500 : 0;
        const aBreed = knownBreeder(a) ? -2000 : 0;
        const bBreed = knownBreeder(b) ? -2000 : 0;
        // 1体なら最弱狙い、複数なら脅威度優先
        if (adjacentMonsters.length === 1) return a.hp - b.hp;
        return (a.hp + aSummon + aBreath + aBreed) - (b.hp + bSummon + bBreath + bBreed);
      })[0];
      const dir = directionTo(px, py, target.x, target.y);

      // === 回廊戦闘: 複数敵に囲まれそうなら狭い場所に退避 ===
      // 2体以上隣接 + 開けた場所にいる → 隣の回廊に1歩移動
      // DL15+でのみ有効（浅層では不要、移動コストがもったいない）
      if (adjacentMonsters.length >= 3 && hpPct >= 0.5 && state.depth >= 15) {
        // 現在地の通行可能な隣接タイル数を数える
        let openNeighbors = 0;
        for (const d of ALL_DIRS) {
          const [dx, dy] = dirOffsets[d]!;
          if (isPassable(tiles, px + dx, py + dy)) openNeighbors++;
        }
        // 4つ以上開けている(部屋の中)→ 2-3の狭い場所を探す
        if (openNeighbors >= 4) {
          let bestCorridorDir = -1;
          let bestCorridorOpenness = 99;
          for (const d of ALL_DIRS) {
            const [dx, dy] = dirOffsets[d]!;
            const nx = px + dx, ny = py + dy;
            if (!isPassable(tiles, nx, ny)) continue;
            // 敵のいる方向には移動しない
            if (adjacentMonsters.some((m: any) => m.x === nx && m.y === ny)) continue;
            // その先の開き具合を計算
            let neighborOpen = 0;
            for (const d2 of ALL_DIRS) {
              const [dx2, dy2] = dirOffsets[d2]!;
              if (isPassable(tiles, nx + dx2, ny + dy2)) neighborOpen++;
            }
            if (neighborOpen <= 3 && neighborOpen < bestCorridorOpenness) {
              bestCorridorOpenness = neighborOpen;
              bestCorridorDir = d;
            }
          }
          if (bestCorridorDir !== -1) {
            addLesson(state.turn, state.depth, "回廊退避",
              `隣接敵${adjacentMonsters.length}体@開けた場所(${openNeighbors}隣接)。狭い場所(${bestCorridorOpenness}隣接)へ移動`);
            state = await sendCommand({ type: CMD.WALK, direction: bestCorridorDir });
            continue;
          }
        }
      }

      // === スレイ/ブランド対応の武器スワップ ===
      // ターゲットに対して現武器よりDPSが30%以上高い武器がインベントリにあればスワップ
      const weaponSwap = findBestWeaponForMonster(inv, p.equipment ?? [], p.toD ?? 0, target);
      if (weaponSwap) {
        addLesson(state.turn, state.depth, "武器スワップ",
          `${target.name}に対し${weaponSwap.name}へ交換 (DPS ${Math.round(weaponSwap.currentDps)}→${Math.round(weaponSwap.dps)})`);
        state = await sendCommand({ type: CMD.EQUIP, itemIndex: weaponSwap.slot });
        continue; // 装備変更でターン消費、次ターンで攻撃
      }

      // 戦闘予測: 自分のDPS vs 被ダメ推定 (2体以上の時のみ)
      let combatUnwinnable = false;
      if (adjacentMonsters.length >= 2) {
        const weapon = (p.equipment ?? []).find((e: any) => WEAPON_TVALS.has(e.tval));
        // スレイ/ブランド考慮のDPS計算（ターゲットに対する実効ダメージ）
        const avgWeaponDmg = weapon ? weaponDpsVsMonster(weapon, p.toD ?? 0, target) : (p.level / 2 + 3);
        const totalEnemyHp = adjacentMonsters.reduce((s: number, m: any) => s + m.hp, 0);
        const turnsToKill = Math.ceil(totalEnemyHp / Math.max(avgWeaponDmg, 1));
        // ブレス持ちの追加ダメージを考慮 (HPの1/6が基本ダメージ、耐性ありなら1/3に軽減)
        let breathBonus = 0;
        for (const m of adjacentMonsters) {
          if (m.breathElements && m.breathElements.length > 0) {
            const hasResist = m.breathElements.every((e: string) => playerResists.has(e));
            breathBonus += hasResist ? m.maxhp / 18 : m.maxhp / 6;
          }
        }
        const estimatedDmgTaken = (adjacentMonsters.length * (target.level * 1.5 + 3) + breathBonus) * turnsToKill * 0.3;
        combatUnwinnable = estimatedDmgTaken > p.hp * 0.9;
      }

      // 敵が多い場合は逃走検討（ただしforceFight対象は除外）
      const hasDangerousAdjacent = adjacentMonsters.some((m: any) => isDangerousMonster(m, p.level, state.depth, playerResists));
      const anyForceFight = adjacentMonsters.some((m: any) => forceFightMonsters.has(m.name));
      const shouldFlee = !anyForceFight && (
        (adjacentMonsters.length >= 2 && hpPct < 0.6) || adjacentMonsters.length >= 3 || (hasDangerousAdjacent && hpPct < 0.7)
        || (isVeryDeep && adjacentMonsters.length >= 1 && hpPct < 0.4)
        || (isExtremeDeep && adjacentMonsters.length >= 2 && hpPct < 0.65) // DL20+: 2体で65%以下は逃走
        || (combatUnwinnable && hpPct < 0.6)
      );
      if (shouldFlee) {
        // 持続追跡者チェック — 隣接戦闘でも繰り返し逃走ならTeleport優先
        const adjFleeCount = fleeCountByMonster.get(target.name) || 0;
        fleeCountByMonster.set(target.name, adjFleeCount + 1);

        if (adjFleeCount >= 3) {
          // 5回以上 → 階段かWoRで完全離脱
          if (adjFleeCount >= 5) {
            const onDown = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.DOWN_STAIR);
            const onUp = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.UP_STAIR);
            if (onDown) {
              fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
              state = await sendCommand({ type: CMD.GO_DOWN });
              visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
              killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = [];
              fleeCountByMonster.clear();
              if (state.depth > maxDepthReached) maxDepthReached = state.depth;
              continue;
            }
            if (onUp && state.depth > 1) {
              fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
              state = await sendCommand({ type: CMD.GO_UP });
              visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
              killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = [];
              fleeCountByMonster.clear();
              continue;
            }
          }
          // 10回以上 → もう逃げても無駄。forceFight登録して戦闘に移行 (強敵は除外)
          const adjTooStrong = (target.speed >= 130 && (target.level >= p.level * 0.7 || target.level >= 15)) ||
            (target.isUnique && target.maxhp > 200) || (target.isUnique && target.level > p.level + 3);
          if (adjFleeCount >= 10 && !adjTooStrong) {
            if (LEAVE && state.depth >= 1) {
              // RULEFIX=leave: 強制戦闘の代わりに階を去る
              if (!leaving) { leaving = `${target.name}から${adjFleeCount + 1}回逃走`; leaveWalk = 0; addLesson(state.turn, state.depth, "階離脱", `${leaving}。強制戦闘の代わりに階を去る`); }
            } else {
              forceFightMonsters.add(target.name);
              fleeCountByMonster.delete(target.name);
            }
            // shouldFleeが次回からfalseになるので、以降は戦闘に落ちる
          }
          // 3-9回 → Teleport
          if (adjFleeCount < 10) {
            const teleSlot = findTeleportScroll(inv);
            if (teleSlot !== null) {
              fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
              addLesson(state.turn, state.depth, "追跡者包囲脱出",
                `${target.name}から${adjFleeCount+1}回目。Teleportで完全脱出`);
              state = await sendCommand({ type: CMD.READ, itemIndex: teleSlot });
              stuckCount = 0; noProgressCount = 0; visited.clear(); lastVisitedSize = 0;
              continue;
            }
          }
        }

        // 高HP+高AC敵 (hydra等) はPhase Doorでは逃げきれない → Teleport優先
        const hasHighHpAcAdjacent = adjacentMonsters.some((m: any) => m.maxhp >= 200 && m.hp > 100);
        // 速度120+敵 or DL18+ or 高HP+高AC敵では包囲時もTeleport優先
        const hasFastAdjacent = adjacentMonsters.some((m: any) => m.speed >= 120);
        if (hasFastAdjacent || state.depth >= 18 || hasHighHpAcAdjacent) {
          const teleSlotSurr = findTeleportScroll(inv);
          if (teleSlotSurr !== null) {
            fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
            addLesson(state.turn, state.depth, "包囲逃走",
              `隣接敵${adjacentMonsters.length}体(高速敵あり)、HP${Math.round(hpPct*100)}%。Teleportで脱出`);
            state = await sendCommand({ type: CMD.READ, itemIndex: teleSlotSurr });
            stuckCount = 0; noProgressCount = 0; visited.clear(); lastVisitedSize = 0;
            continue;
          }
        }
        if (await stairsFirstFlee(adjacentMonsters, `隣接敵${adjacentMonsters.length}体、HP${Math.round(hpPct * 100)}%`)) continue;
        const phaseSlot = findPhaseScroll(inv);
        if (phaseSlot !== null) {
          fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
          addLesson(state.turn, state.depth, "包囲逃走",
            `隣接敵${adjacentMonsters.length}体、HP${Math.round(hpPct*100)}%。Phase Doorで退避`);
          state = await sendCommand({ type: CMD.READ, itemIndex: phaseSlot });
          continue;
        }
        // Phase Doorなし → Teleportation (深層はより早く脱出)
        const teleFleePct = isVeryDeep ? 0.6 : 0.4;
        if (hpPct < teleFleePct) {
          const teleSlot = findTeleportScroll(inv);
          if (teleSlot !== null) {
            fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
            addLesson(state.turn, state.depth, "緊急包囲脱出",
              `隣接敵${adjacentMonsters.length}体、HP${Math.round(hpPct*100)}%。Teleportで緊急脱出`);
            state = await sendCommand({ type: CMD.READ, itemIndex: teleSlot });
            stuckCount = 0; noProgressCount = 0;
            visited.clear(); lastVisitedSize = 0;
            continue;
          }
        }
      }

      // 戦闘中回復: HP低下時にLLMに戦術判断を仰ぐ (DL15+)
      const combatHealThreshold = (isExtremeDeep ? 0.65 : isVeryDeep ? 0.55 : isDeep ? 0.5 : 0.4) + 0.15 * RULES_CAUTION;
      // LLM戦闘判断: HP40-70%の微妙な範囲でLLMに聞く (50ターンに1回、コスト制限)
      const llmCombatCooldown = (globalThis as any).__llmCombatCd ?? 0;
      // ログモード: 隣接敵あり & HP<90%、20プレイヤーターン(=200ゲームターン)に1回
      const tacticAsk = WIDE
        ? state.depth >= 1 && hpPct < 0.9 && adjacentMonsters.length >= 1 && state.turn - llmCombatCooldown >= 200
        : LLM_ENABLED && state.depth >= 15 && hpPct >= 0.3 && hpPct < 0.7 && adjacentMonsters.length >= 1
          && state.turn - llmCombatCooldown >= 50;
      let skipHealThisTurn = false;
      if (tacticAsk) {
        (globalThis as any).__llmCombatCd = state.turn;
        // ルールの次手: 回復手段があれば回復、なければ殴る (逃走は上で処理済み)
        const rulesHeal = hpPct < combatHealThreshold && adjacentMonsters.length <= 2 &&
          ((canCastSpells && findBestHealSpell(spells, p.level, sp, true) !== null) || findTieredHealingPotion(inv, hpPct) !== null);
        const llmAction = await llmHealOrFlee(state, adjacentMonsters, hpPct, rulesHeal ? "heal" : "fight");
        if (llmAction === "flee") {
          // Teleport if held, else Phase Door (early vanilla characters rarely have Teleportation)
          const teleSlotLlm = findTeleportScroll(inv) ?? findPhaseScroll(inv);
          if (teleSlotLlm !== null) {
            fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
            addLesson(state.turn, state.depth, "LLM逃走判断",
              `HP${Math.round(hpPct*100)}%、隣接${adjacentMonsters.length}体。LLMがFLEE推奨`);
            state = await sendCommand({ type: CMD.READ, itemIndex: teleSlotLlm });
            stuckCount = 0; noProgressCount = 0; visited.clear(); lastVisitedSize = 0;
            continue;
          }
        }
        // llmAction === "fight" → 回復せずに殴る (DPS高いなら有効)
        if (llmAction === "fight") {
          skipHealThisTurn = true;
        } else if (llmAction === "heal") {
          // heal → HPしきい値に関係なく今回復する (スペル優先、なければポーション)
          const healSpellLlm = canCastSpells ? findBestHealSpell(spells, p.level, sp, true) : null;
          if (healSpellLlm) {
            spellsUsed++; healingsUsed++;
            state = await sendCommand({ type: CMD.CAST, spellIndex: healSpellLlm.index, direction: 5 });
            continue;
          }
          const healSlotLlm = findTieredHealingPotion(inv, hpPct) ?? findHealingPotion(inv);
          if (healSlotLlm !== null) {
            healingsUsed++;
            state = await sendCommand({ type: CMD.QUAFF, itemIndex: healSlotLlm });
            continue;
          }
        }
      }
      if (!skipHealThisTurn && hpPct < combatHealThreshold && adjacentMonsters.length <= 2) {
        // 回復スペルがあればスペル優先
        if (canCastSpells) {
          const healSpell = findBestHealSpell(spells, p.level, sp, true);
          if (healSpell) {
            spellsUsed++;
            healingsUsed++;
            state = await sendCommand({ type: CMD.CAST, spellIndex: healSpell.index, direction: 5 });
            continue;
          }
        }
        // 戦闘中は段階的ポーション（HP残量に応じた適切な強さ）
        const healSlot = findTieredHealingPotion(inv, hpPct);
        if (healSlot !== null) {
          healingsUsed++;
          state = await sendCommand({ type: CMD.QUAFF, itemIndex: healSlot });
          continue;
        }
      }

      // 攻撃スペルがあれば使う (隣接敵に方向指定)
      if (canCastSpells) {
        const atkSpell = findCastableSpell(spells, ATTACK_SPELLS, p.level, sp);
        if (atkSpell && sp >= atkSpell.mana) {
          spellsUsed++;
          state = await sendCommand({ type: CMD.CAST, spellIndex: atkSpell.index, direction: dir });
          const newMonsters = state.monsters;
          if (newMonsters.length < monsters.length) {
            totalKills++;
            killsThisLevel++;
            console.log(`  [魔法撃破] Turn ${state.turn} DL${state.depth} CL${state.player.level} - ${atkSpell.name}で撃破 (累計${totalKills}) HP:${state.player.hp}/${state.player.maxHp}`);
          }
          continue;
        }
      }

      state = await sendCommand({ type: CMD.WALK, direction: dir });

      // 戦闘結果チェック
      const newMonsters = state.monsters;
      if (newMonsters.length < monsters.length) {
        totalKills++;
        killsThisLevel++;
        console.log(`  [戦闘] Turn ${state.turn} DL${state.depth} CL${state.player.level} - 撃破 (累計${totalKills}, 階${killsThisLevel}) HP:${state.player.hp}/${state.player.maxHp}`);
      }
      continue;
    }

    // === RULEFIX=breed: 既知の繁殖敵は少ないうちに倒す。10 マス以内で届くなら、拾い物や他の敵より先に向かう ===
    if (BREED && !breedLeaving && stuckCount < 5 && noProgressCount < 50 && !retreatMode) {
      const prey = monsters.filter((m: any) => knownBreeder(m) && m.distance <= 10 && !hurtsOnContact(m)
        && !isDangerousMonster(m, p.level, state.depth, playerResists))
        .sort((a: any, b: any) => a.distance - b.distance)[0];
      const huntDir = prey ? bfsNextStep(tiles, px, py, prey.x, prey.y) : null;
      if (prey && huntDir !== null) {
        const hk = `${state.depth}:${prey.midx}:${prey.name}`;
        if (!breedHunted.has(hk)) { breedHunted.add(hk); addLesson(state.turn, state.depth, "繁殖狩り", `${prey.name}(dist${prey.distance})を先に倒す`); }
        state = await sendCommand({ type: CMD.WALK, direction: huntDir });
        continue;
      }
    }

    // === RULEFIX=tryunknown: 未知の薬を安全な時に飲む ===
    if (TRYUNKNOWN && !ROLLOUT && actionCount - lastTryAction >= 5 && (hpPct < 0.75 || state.depth === 0)
        && monsters.every((m: any) => m.distance > 5)) {
      const pot = inv.find((i: any) => i.tval === TVAL.POTION && i.aware === false && i.qty > 0);
      if (pot) {
        lastTryAction = actionCount; potionsTried++;
        addLesson(state.turn, state.depth, "未知の薬", `${pot.name}を試飲 (HP${Math.round(hpPct * 100)}%、#${potionsTried})`);
        state = await sendCommand({ type: CMD.QUAFF, itemIndex: pot.slot });
        continue;
      }
    }

    // === RULEFIX=gearid: 安全な時 (5 マス以内に敵なし、HP 半分以上、10 行動に 1 回) に装備を見直す ===
    if (GEARID && !ROLLOUT && actionCount - lastGearAction >= 10 && hpPct >= 0.5 && monsters.every((m: any) => m.distance > 5)) {
      const equip = p.equipment ?? [];
      let pick: { item: any; why: string } | null = null;
      for (const it of inv) {
        if (!EQUIPPABLE_TVALS.has(it.tval) || it.tval === TVAL.DIGGING || it.tval === TVAL.LIGHT || gearCursed(it)) continue;
        const cur = it.tval === TVAL.RING
          ? (equip.filter((e: any) => e.tval === TVAL.RING).length >= 2 ? equip.find((e: any) => e.tval === TVAL.RING) : undefined)
          : equip.find((e: any) => sameEquipCategory(e.tval, it.tval));
        if (cur && it.tval === TVAL.BOW && launcherFamily(it.name ?? "") !== launcherFamily(cur.name ?? "")) continue;
        const pw = itemPower(it), cpw = cur ? itemPower(cur) : -1;
        if (cur ? pw > cpw : pw > 0) { pick = { item: it, why: `${pw} > ${cur ? cpw : "空き"}` }; break; } // 分かっている性質で良い方
        const key = `${it.tval}:${it.sval}`;
        if (gearUnknown(it) && (gearTries.get(key) ?? 0) < 3 && (cur ? pw >= cpw : pw >= 0)) { // 試着: 着ければ明らかな性質が分かる
          gearTries.set(key, (gearTries.get(key) ?? 0) + 1);
          pick = { item: it, why: `試着 {??} ${pw} >= ${cur ? cpw : "空き"}` };
          break;
        }
      }
      // 指輪/アミュレットで評価が負 (呪い、マイナス修正) → 外す (外せない呪いもあるので 2 回まで)
      const bad = equip.find((e: any) => (e.tval === TVAL.RING || e.tval === TVAL.AMULET) && itemPower(e) < 0
        && (gearTries.get(`off:${e.slot}:${e.name}`) ?? 0) < 2);
      if (!pick && bad) {
        const key = `off:${bad.slot}:${bad.name}`;
        gearTries.set(key, (gearTries.get(key) ?? 0) + 1);
        lastGearAction = actionCount;
        addLesson(state.turn, state.depth, "装備識別", `${bad.desc ?? bad.name}: 評価 ${itemPower(bad)} なので外す`);
        state = await sendCommand({ type: CMD.UNEQUIP, itemIndex: bad.slot });
        continue;
      }
      if (pick) {
        lastGearAction = actionCount;
        addLesson(state.turn, state.depth, "装備識別", `${pick.item.desc ?? pick.item.name}: ${pick.why}`);
        state = await sendCommand({ type: CMD.EQUIP, itemIndex: pick.item.slot });
        continue;
      }
    }

    // === 優先度4.5: 足元アイテム拾い + 装備最適化 (安全時のみ) ===
    // 条件: 隣接敵なし + 近接敵(dist<=3)も少ない + 降下急いでない
    const nearMonCount = monsters.filter((m: any) => m.distance <= 3).length;
    if (adjacentMonsters.length === 0 && nearMonCount <= 1) {
      const currentTile2 = tiles.find((t: any) => t.x === px && t.y === py);
      if (currentTile2?.hasObj && !droppedTiles.has(`${px},${py}`)) {
        // Pack full check: skip pickup if inventory is full (23 slots max)
        const MAX_PACK = 23;
        if (inv.length >= MAX_PACK) {
          // Don't try to pick up — move on to avoid stuck loop
          // (future: drop lowest-value item to make room)
        } else {
        const prevInvCount = inv.length;
        state = await sendCommand({ type: CMD.PICKUP });
        const newInv = state.player.inventory;
        if (newInv.length > prevInvCount) {
          for (const item of newInv.slice(prevInvCount)) {
            console.log(`  [拾得] ${item.name} (tval=${item.tval}, ac=${item.ac ?? 0})`);
          }
        }
        // 装備比較: 拾ったものが現装備より良ければ即装備
        const equip2 = state.player.equipment ?? [];
        for (const invItem of state.player.inventory) {
          if (!EQUIPPABLE_TVALS.has(invItem.tval)) continue;
          const invPower2 = itemPower(invItem);
          const currentEquip2 = equip2.find((e: any) => sameEquipCategory(e.tval, invItem.tval));
          if (!currentEquip2 && invPower2 > 0) {
            addLesson(state.turn, state.depth, "装備",
              `${invItem.name}を装備 (power=${invPower2}, 空スロット)`);
            state = await sendCommand({ type: CMD.EQUIP, itemIndex: invItem.slot });
            break;
          }
          const eqLogSeen: Set<string> = (globalThis as any).__logEquipSeen ?? ((globalThis as any).__logEquipSeen = new Set<string>());
          const eqLogKey = `${invItem.name}|${currentEquip2?.slot}`;
          const eqLogFirst = LOGLIKE && !!currentEquip2 && !eqLogSeen.has(eqLogKey);
          if (eqLogFirst && invPower2 <= itemPower(currentEquip2)) {
            eqLogSeen.add(eqLogKey);
            await llmChooseEquipment(state, currentEquip2, invItem, "keep"); // ログのみ: ルールは交換しない
          }
          if (currentEquip2 && invPower2 > itemPower(currentEquip2)) {
            // LLM装備判断: 武器(blowsリスク)と耐性付き防具(トレードオフ)
            let doSwap = true;
            const hasResists = (invItem.resists ?? []).some((r: any) => r.level > 0);
            const currentHasResists = (currentEquip2.resists ?? []).some((r: any) => r.level > 0);
            if (LOGLIKE ? eqLogFirst : DECISION_ON && (WEAPON_TVALS.has(invItem.tval) || hasResists || currentHasResists)) {
              if (eqLogFirst) eqLogSeen.add(eqLogKey);
              const llmOk = await llmChooseEquipment(state, currentEquip2, invItem);
              if (llmOk === false) {
                doSwap = false;
                console.log(`  [LLM VETO] 装備変更見送り: ${invItem.name}`);
              }
            }
            if (doSwap) {
              addLesson(state.turn, state.depth, "装備変更",
                `${invItem.name}(power=${invPower2}) > ${currentEquip2.name}(power=${itemPower(currentEquip2)})。交換`);
              state = await sendCommand({ type: CMD.EQUIP, itemIndex: invItem.slot });
              break;
            }
          }
        }
        continue;
      }
      } // end pack full else
    }

    // === 優先度5: 接近中の敵への対応 (BFS到達可能 + 安全な敵のみ) ===
    // noProgressCount高い時はスキップ (脱出を優先)
    // 退避モード中はスキップ (HP回復を優先、敵に近づかない)
    const nearbyMonsters = monsters.filter((m: any) =>
      m.distance <= 6 && !isDangerousMonster(m, p.level, state.depth, playerResists)
    );
    if (nearbyMonsters.length > 0 && stuckCount < 5 && noProgressCount < 50 && !retreatMode) {
      const closest = nearbyMonsters.sort((a: any, b: any) => a.distance - b.distance)[0];

      // 接近中に武器スワップ（距離2-3で余裕がある時）
      if (closest.distance >= 2) {
        const preSwap = findBestWeaponForMonster(inv, p.equipment ?? [], p.toD ?? 0, closest);
        if (preSwap) {
          addLesson(state.turn, state.depth, "先行武器スワップ",
            `${closest.name}(dist${closest.distance})接近中。${preSwap.name}へ交換 (DPS ${Math.round(preSwap.currentDps)}→${Math.round(preSwap.dps)})`);
          state = await sendCommand({ type: CMD.EQUIP, itemIndex: preSwap.slot });
          continue;
        }
      }

      // BFSで到達可能か確認（壁越しの敵は無視）
      const approachDir = bfsNextStep(tiles, px, py, closest.x, closest.y);
      if (approachDir !== null) {
        const beforeX = px, beforeY = py;
        state = await sendCommand({ type: CMD.WALK, direction: approachDir });
        if (state.player.x === beforeX && state.player.y === beforeY) {
          stuckCount++; // 歩けなかった → stuckCount上昇
        }
        continue;
      }
      // 到達不能 → 無視して探索に移行
    }

    // === 優先度6: アイテム拾い + 装備最適化 ===
    // 6a: 近くのフロアアイテムに向かう (敵がいない場合のみ、停滞中はスキップ)
    if (monsters.filter((m: any) => m.distance <= 3).length === 0 && noProgressCount < 50) {
      const itemTiles = tiles.filter((t: any) =>
        t.hasObj && (t.x !== px || t.y !== py) &&
        !unreachableItems.has(`${t.x},${t.y}`) && !droppedTiles.has(`${t.x},${t.y}`)
      );
      if (itemTiles.length > 0) {
        // 最寄りのアイテムタイルへBFS
        const sorted = itemTiles
          .map((t: any) => ({ ...t, dist: distanceTo(px, py, t.x, t.y) }))
          .sort((a: any, b: any) => a.dist - b.dist);
        for (const target of sorted) {
          if (target.dist > 50) break; // 遠すぎるものは無視
          const itemDir = bfsNextStep(tiles, px, py, target.x, target.y);
          if (itemDir !== null) {
            state = await sendCommand({ type: CMD.WALK, direction: itemDir });
            break;
          }
          // BFS到達不能 → このアイテムを無視リストに追加
          unreachableItems.add(`${target.x},${target.y}`);
        }
        if (state.player.x !== px || state.player.y !== py) continue;
      }
    }

    // 6b: 足元アイテム拾い + 装備比較
    const currentTile = tiles.find((t: any) => t.x === px && t.y === py);
    if (currentTile?.hasObj && inv.length < 23 && !droppedTiles.has(`${px},${py}`)) {
      // フロアにアイテムあり → 拾う (pack full時はスキップ)
      const prevInvCount = inv.length;
      state = await sendCommand({ type: CMD.PICKUP });
      const newInv = state.player.inventory;
      if (newInv.length > prevInvCount) {
        const newItems = newInv.slice(prevInvCount);
        for (const item of newItems) {
          console.log(`  [拾得] ${item.name} (tval=${item.tval}, toH=${item.toH}, toD=${item.toD}, ac=${item.ac ?? 0})`);
        }
      }
      // 拾った後に装備比較
      const equip = state.player.equipment ?? [];
      const updatedInv = state.player.inventory;
      for (const invItem of updatedInv) {
        if (!EQUIPPABLE_TVALS.has(invItem.tval)) continue;
        const invPower = itemPower(invItem);
        // 同カテゴリの現装備を探す
        const currentEquip = equip.find((e: any) => sameEquipCategory(e.tval, invItem.tval));
        if (!currentEquip && invPower > 0) {
          // 空スロット → power正なら装備
          addLesson(state.turn, state.depth, "装備",
            `${invItem.name}を装備 (power=${invPower}, 空スロット)`);
          state = await sendCommand({ type: CMD.EQUIP, itemIndex: invItem.slot });
          continue;
        }
        if (!currentEquip) continue; // power <= 0 → 装備しない
        const equipPower = itemPower(currentEquip);
        if (invPower > equipPower) {
          addLesson(state.turn, state.depth, "装備変更",
            `${invItem.name}(power=${invPower}) > ${currentEquip.name}(power=${equipPower})。交換`);
          state = await sendCommand({ type: CMD.EQUIP, itemIndex: invItem.slot });
        }
      }
      continue;
    }

    // === 優先度7: 階段降下 ===
    turnsOnLevel = state.turn - levelEntryTurn;
    const healingPotions = inv.filter((item: any) => item.tval === TVAL.POTION && item.name.includes("Cure") && item.qty > 0);
    const totalHealingQty = healingPotions.reduce((sum: number, item: any) => sum + item.qty, 0);
    const hasHealing = totalHealingQty > 0;
    const enoughKills = killsThisLevel >= minKillsForDepth(state.depth) || state.depth === 0 || turnsOnLevel > MAX_TURNS_PER_LEVEL;

    // 探索効率停滞チェック: 直近3回の探索率変化が2%以下
    const descentPassable = tiles.filter((t: any) => PASSABLE_FEATS.has(t.feat)).length;
    const descentUnvisited = tiles.filter((t: any) => PASSABLE_FEATS.has(t.feat) && !visited.has(`${t.x},${t.y}`)).length;
    const currentExplorationPct = descentPassable > 0 ? Math.round((1 - descentUnvisited / descentPassable) * 100) : 100;
    const explorationStalled = explorationRateWindow.length >= 3 && (() => {
      if (turnsOnLevel < 1000) return false; // 最低1000ターンは探索する
      const last3 = explorationRateWindow.slice(-3);
      const change = Math.abs(last3[last3.length - 1]! - last3[0]!);
      return change <= 2 && last3[0]! >= 50; // 50%以上探索で停滞
    })();
    // 低探索率フロア早期降下: 探索率<15%で1500ターン以上 → 小部屋/孤立フロアなので降りる
    // 探索率が極端に低い場合はkillsもCLも待たない (そのフロアで稼げない)
    const lowExplorationEarlyDescent = currentExplorationPct < 15 && turnsOnLevel > 1500 && state.depth > 0
      && (state.depth > 3 || p.level >= state.depth + EARLY_CL_MARGIN || turnsOnLevel > 8000); // 序盤は CL ゲートを回避させない

    // If overleveled, skip kill requirement — rush deeper
    // DL20でCL22+, DL10でCL15+でオーバーレベル判定
    const overlevelThreshold = state.depth >= 20 ? 1.1 : state.depth >= 10 ? 1.3 : 2;
    const overleveled = p.level >= state.depth * overlevelThreshold && state.depth > 0;

    // 長時間同じ階にいたら強制降下 — 深度でスケール (v8: 閾値引き上げ)
    const tooLongThreshold = overleveled ? 1500 :
      state.depth >= 20 ? 4000 :
      state.depth >= 10 ? 5000 :
      state.depth >= 5 ? 6000 : 8000;
    const tooLongOnLevel = turnsOnLevel > tooLongThreshold;

    // 深層では回復薬を十分持っていないと降下しない
    const minHealingForDescent = state.depth >= 40 ? 15 : state.depth >= 30 ? 10 : state.depth >= 15 ? 6 : state.depth >= 12 ? 4 : state.depth >= 8 ? 2 : 1;
    // No potions and too poor to restock (restock needs 40 gold): on shallow levels, don't wait forever
    const healingOk = totalHealingQty >= minHealingForDescent
      || (state.depth < 8 && p.gold < 40 && turnsOnLevel > 2 * tooLongThreshold)
      // Too poor to buy one (vanilla starts with ~150 gold and pays nothing for sales): shallow levels go on without
      || (state.depth < 3 && p.gold < 20);

    // 逃走手段チェック (深層では必須)
    const phaseCount = inv.filter((item: any) => item.tval === TVAL.SCROLL && item.name.includes("Phase Door") && item.qty > 0)
      .reduce((s: number, i: any) => s + i.qty, 0);
    const teleCount = inv.filter((item: any) => item.tval === TVAL.SCROLL && item.name.includes("Teleportation") && item.qty > 0)
      .reduce((s: number, i: any) => s + i.qty, 0);
    const minPhaseForEscape = state.depth >= 15 ? 5 : 3;
    const minTeleForEscape = state.depth >= 15 ? 3 : state.depth >= 10 ? 1 : 0;
    const hasEscapeMeans = (phaseCount >= minPhaseForEscape || teleCount >= 2 ||
      (canCastSpells && findCastableSpell(spells, ESCAPE_SPELLS, p.level, sp) !== null))
      && teleCount >= minTeleForEscape;
    const escapeOk = state.depth < 8 || hasEscapeMeans || tooLongOnLevel;

    // 耐性カバレッジ: ソフトゲート — 耐性不足時は最低撃破数/滞在ターンを引き上げ
    // 完全ブロックだと耐性装備が出ないSeedで詰む
    const BASE_ELEMS = ["ACID", "ELEC", "FIRE", "COLD"];
    const baseResistCount = BASE_ELEMS.filter(e => playerResists.has(e)).length;
    const hasPoisRes = playerResists.has("POIS");
    const resistTarget = state.depth < 20 ? 0 :
      state.depth < 30 ? 2 :
      state.depth < 40 ? 4 : 4;  // 目標耐性数
    const resistDeficit = Math.max(0, resistTarget - baseResistCount - (hasPoisRes ? 0 : (state.depth >= 30 ? 1 : 0)));
    // 耐性不足1つにつき追加3000ターン滞在 (探索/レベリングで補填)
    const resistPenaltyTurns = resistDeficit * 3000;
    const resistOk = resistDeficit === 0;

    // CLが低すぎる場合は降下を控える (v12d設定に戻す — 緩めゲート + LLM判断)
    const minClRatio = state.depth >= 30 ? 0.8 : state.depth >= 20 ? 0.75 : state.depth >= 10 ? 0.7 : 0.5;
    // 絶対最低CL: DL10→CL8, DL15→CL12, DL20→CL16, DL25→CL20, DL30→CL25
    const absoluteMinCl = state.depth >= 30 ? 25 : state.depth >= 25 ? 20 : state.depth >= 20 ? 16 : state.depth >= 15 ? 12 : state.depth >= 10 ? 8 : 0;
    // 序盤 (DL1-3) は CL >= DL+2 まで降りない (CL1 の 12HP で DL2-4 に潜って Fang/Grip/ゼリーに殺される対策)。長期滞在 (veryLongOnLevel) では緩和
    const clOk = (p.level >= Math.floor(state.depth * minClRatio) && p.level >= absoluteMinCl && (state.depth > 3 || state.depth === 0 || p.level >= state.depth + EARLY_CL_MARGIN))
      || (state.depth >= 1 && state.depth <= 3 && p.level >= state.depth + EARLY_CL_MARGIN);

    // === 装備品質ゲート (v9: CLだけでなく装備の準備状況もチェック) ===
    // DL15+: blows >= 2 (最低限の火力)
    // DL20+: blows >= 3 OR 武器ダメージが十分 (高品質武器なら2 blowsでもOK)
    // DL25+: 基本耐性2つ以上 (Fire+Cold推奨)
    const currentBlows = p.numBlows ?? 2;
    const currentWeapon = (p.equipment ?? []).find((e: any) => WEAPON_TVALS.has(e.tval));
    const weaponBaseDmg = currentWeapon ? ((currentWeapon.dd ?? 1) * ((currentWeapon.ds ?? 4) + 1) / 2 + (currentWeapon.toD ?? 0) + (p.toD ?? 0)) : 10;
    const estimatedDps = weaponBaseDmg * currentBlows;
    // DPS基準: DL15で30+, DL20で45+, DL25で60+, DL30で70+
    const minDpsForDepth = state.depth >= 30 ? 70 : state.depth >= 25 ? 60 : state.depth >= 20 ? 45 : state.depth >= 15 ? 30 : 0;
    const dpsOk = estimatedDps >= minDpsForDepth || state.depth < 15;
    // 耐性基準: DL25+で基本耐性2+, DL30+で基本耐性3+
    const minResistForDepth = state.depth >= 30 ? 3 : state.depth >= 25 ? 2 : 0;
    const equipResistOk = baseResistCount >= minResistForDepth || state.depth < 25;
    // AC基準: DL20+でAC60+, DL30+でAC80+
    const minAcForDepth = state.depth >= 30 ? 80 : state.depth >= 20 ? 60 : 0;
    const acOk = (p.ac ?? 0) >= minAcForDepth || state.depth < 20;
    // 総合装備チェック: 3つ全部OK or 超長期滞在で緩和
    const equipmentReady = dpsOk && equipResistOk && acOk;

    // tooLongOnLevelでもclOkは必須 (レベル不足での降下は死因上位)
    // ただし超長期滞在(2x閾値)ではCLチェック・装備チェックも緩和
    const veryLongOnLevel = turnsOnLevel > tooLongThreshold * 2;
    const clCheck = clOk || veryLongOnLevel;
    const equipCheck = equipmentReady || veryLongOnLevel;
    // 耐性ソフトゲート: 不足分×3000ターン追加滞在で降下許可
    const resistCheck = resistOk || turnsOnLevel > resistPenaltyTurns;
    const readyToDescend = !restockTrip && hpPct >= 0.7 && healingOk && escapeOk && resistCheck && equipCheck &&
      ((clCheck && (enoughKills || explorationStalled || tooLongOnLevel || overleveled)) || lowExplorationEarlyDescent);
    if (process.env.DESCENT_DEBUG && actionCount % 200 === 0) console.log(`  [DESCENT?] ready=${readyToDescend} restock=${restockTrip} hp=${hpPct.toFixed(2)} heal=${healingOk} escape=${escapeOk} resist=${resistCheck} equip=${equipCheck} cl=${clCheck} kills=${enoughKills} stalled=${explorationStalled} tooLong=${tooLongOnLevel} over=${overleveled} lowEarly=${lowExplorationEarlyDescent} stair=${!!findTile(tiles, FEAT.DOWN_STAIR)}`);

    // LLM降下判断: DL15+でLLMに確認（深度ごとに最大2回まで）
    let llmDescentVeto = false;
    if (readyToDescend && DECISION_ON && (state.depth >= 15 || (WIDE && state.depth >= 1))) {
      const vetoCountKey = `descent_veto_count_${state.depth}`;
      const approvedKey = `descent_approved_${state.depth}`; // 承認済みなら階段まで毎ターン聞き直さない
      const vetoCount = (globalThis as any)[vetoCountKey] ?? 0;
      if (vetoCount < 2 && !(globalThis as any)[approvedKey]) { // 同じ深度で最大2回までLLMに聞く
        const llmOk = await llmShouldDescend(state);
        if (LOGLIKE) await llmShouldExploreMore(state, killsThisLevel, turnsOnLevel); // ログのみ (ルールは降下)
        if (llmOk !== false) (globalThis as any)[approvedKey] = true;
        if (llmOk === false) {
          const llmExplore = await llmShouldExploreMore(state, killsThisLevel, turnsOnLevel);
          if (llmExplore === true || llmExplore === null) {
            llmDescentVeto = true;
            (globalThis as any)[vetoCountKey] = vetoCount + 1;
            console.log(`  [LLM VETO] 降下を見送り (DL${state.depth}, ${vetoCount+1}/3) — LLMが探索続行を推奨`);
          }
        }
      }
    }

    if (readyToDescend && !llmDescentVeto) {
      const downStair = findTile(tiles, FEAT.DOWN_STAIR);
      if (downStair) {
        const onStair = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.DOWN_STAIR);
        if (onStair) {
          addLesson(state.turn, state.depth, "降下",
            `DL${state.depth}→DL${state.depth+1}。HP${Math.round(hpPct*100)}%、撃破${killsThisLevel}体、耐性${baseResistCount}/4+毒${hasPoisRes ? "○" : "×"}、DPS${Math.round(estimatedDps)}、AC${p.ac ?? 0}、${currentBlows}blows。降下`);
          state = await sendCommand({ type: CMD.GO_DOWN });
          if (state.depth > maxDepthReached) {
            maxDepthReached = state.depth;
            console.log(`  [到達] 最深部更新: DL${maxDepthReached}`);
          }
          visited.clear(); lastVisitedSize = 0; noProgressCount = 0;
          stuckCount = 0; explorationRateWindow = [];
          killsThisLevel = 0;
          levelEntryTurn = state.turn;
          teleportLoopCount = 0; lastTeleportArea = "";
          continue;
        } else {
          // BFSで階段への最短経路を計算
          const nextDir = bfsNextStep(tiles, px, py, downStair.x, downStair.y);
          if (nextDir !== null) {
            state = await sendCommand({ type: CMD.WALK, direction: nextDir });
            continue;
          }
          // 階段がBFS到達不能 → 掘削パスファインディングで壁を掘る
          const digPath = dijkstraNextStepWithDigging(tiles, px, py, downStair.x, downStair.y);
          const stairDist = distanceTo(px, py, downStair.x, downStair.y);
          // 掘削で向かう (テレポ失敗を避けるため閾値緩和)
          if (digPath && stairDist <= 60) {
            if (digPath.needsDig) {
              state = await sendCommand({ type: CMD.TUNNEL, direction: digPath.dir });
            } else {
              state = await sendCommand({ type: CMD.WALK, direction: digPath.dir });
            }
            continue;
          }
          // 遠い or Dijkstraでも到達不能 → テレポート (最大3回/階、超えたら掘削 or 探索続行)
          if (descentTeleportCount < 3) {
            const teleSlot = findTeleportScroll(inv);
            if (teleSlot !== null) {
              descentTeleportCount++;
              addLesson(state.turn, state.depth, "降下テレポート",
                `階段が遠い/到達不能(dist=${stairDist})。テレポートで再配置 (${descentTeleportCount}/3)`);
              state = await sendCommand({ type: CMD.READ, itemIndex: teleSlot });
              stuckCount = 0; noProgressCount = 0;
              continue;
            }
          }
          // テレポ回数切れ or テレポスクロールなし → 掘削 or 方向歩行
          if (digPath) {
            if (digPath.needsDig) {
              state = await sendCommand({ type: CMD.TUNNEL, direction: digPath.dir });
            } else {
              state = await sendCommand({ type: CMD.WALK, direction: digPath.dir });
            }
            continue;
          }
          // Dijkstraも失敗 → 階段方向へ直進 (壁を掘りながら)
          {
            const stairDir = directionTo(px, py, downStair.x, downStair.y);
            const [sdx, sdy] = dirOffsets[stairDir] ?? [0, 0];
            const targetT = tiles.find((t: any) => t.x === px + sdx && t.y === py + sdy);
            if (targetT && PASSABLE_FEATS.has(targetT.feat)) {
              state = await sendCommand({ type: CMD.WALK, direction: stairDir });
              continue;
            } else if (targetT && digWorthwhile(targetT.feat)) {
              state = await sendCommand({ type: CMD.TUNNEL, direction: stairDir });
              continue;
            }
            // 掘れない (掘削具なし): 探索を続ける
          }
        }
      } else if (tooLongOnLevel || overleveled) {
        // 階段が見えない → テレポートで探す
        const teleSlot = findTeleportScroll(inv);
        if (teleSlot !== null) {
          addLesson(state.turn, state.depth, "階段探索テレポート",
            `階段未発見+長期滞在${turnsOnLevel}T。テレポートで移動`);
          state = await sendCommand({ type: CMD.READ, itemIndex: teleSlot });
          stuckCount = 0; noProgressCount = 0;
          continue;
        }
      }
    }
    // 降下条件未達 → 探索・戦闘を優先（階段に向かわない）

    // === 優先度8: 探索 ===
    if (px === lastX && py === lastY) {
      stuckCount++;
    } else {
      stuckCount = 0;
    }
    lastX = px;
    lastY = py;

    // === stuckCount >= 20 → 強制テレポート脱出 ===
    if (stuckCount >= 20) {
      const teleSlot = findTeleportScroll(inv);
      if (teleSlot !== null) {
        addLesson(state.turn, state.depth, "強制脱出",
          `${stuckCount}回スタック@(${px},${py})。Teleportで強制脱出`);
        state = await sendCommand({ type: CMD.READ, itemIndex: teleSlot });
        stuckCount = 0;
        visited.clear(); lastVisitedSize = 0; noProgressCount = 0;
        continue;
      }
      const phaseSlot = findPhaseScroll(inv);
      if (phaseSlot !== null) {
        state = await sendCommand({ type: CMD.READ, itemIndex: phaseSlot });
        stuckCount = 0;
        visited.clear(); lastVisitedSize = 0; noProgressCount = 0;
        continue;
      }
      // スクロール切れ → 降下 or 上昇
      const onDown = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.DOWN_STAIR);
      if (onDown) {
        state = await sendCommand({ type: CMD.GO_DOWN });
        visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
        killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = []; levelEntryDetected = false; unreachableItems.clear();
        teleportLoopCount = 0; lastTeleportArea = "";
        if (state.depth > maxDepthReached) maxDepthReached = state.depth;
        continue;
      }
    }

    // === 隣接の閉ドアを開ける/壊す (最優先) ===
    let doorHandled = false;
    for (const dir of ALL_DIRS) {
      const [dx, dy] = dirOffsets[dir]!;
      const t = tiles.find((tt: any) => tt.x === px + dx && tt.y === py + dy);
      if (t?.feat === FEAT.CLOSED_DOOR && !sealedDoors.has(`${px + dx},${py + dy}`)) { // RULEFIX=seal: 閉めた扉は開けない
        if (levelDebug) console.log(`  [DOOR] dir${dir}@(${px+dx},${py+dy}) stuck=${stuckCount}`);
        const seenBefore = new Set(monsters.map((m: any) => m.midx ?? `${m.name}@${m.x},${m.y}`));
        if (stuckCount > 3) {
          state = await sendCommand({ type: CMD.TUNNEL, direction: dir });
        } else {
          state = await sendCommand({ type: CMD.OPEN, direction: dir });
        }
        // ドア開いた後の確認
        const newT = state.map.tiles.find((tt: any) => tt.x === px + dx && tt.y === py + dy);
        if (levelDebug && newT) console.log(`    → feat now: ${newT.feat}`);
        // RULEFIX=seal (b): 開けた扉の向こうに既知の繁殖敵 3 体以上、または敵 8 体以上が新たに見えた → 扉の上が空ならすぐ閉める
        if (SEAL && state.depth >= 1 && newT?.feat === FEAT.OPEN_DOOR && !newT.hasObj) {
          const fresh = ((state.monsters ?? []) as any[]).filter((m: any) => !seenBefore.has(m.midx ?? `${m.name}@${m.x},${m.y}`));
          const freshBreeders = fresh.filter((m: any) => m.breeds === true).length;
          const key = `${px + dx},${py + dy}`;
          if ((freshBreeders >= SEAL_BREEDERS || fresh.length >= SEAL_CROWD) && !sealFailed.has(key)
              && !((state.monsters ?? []) as any[]).some((m: any) => m.x === px + dx && m.y === py + dy)) {
            const turnBefore = state.turn;
            state = await sendCommand({ type: CMD.CLOSE, direction: dir });
            const shut = state.map.tiles.find((tt: any) => tt.x === px + dx && tt.y === py + dy);
            if (state.turn !== turnBefore && shut?.feat === FEAT.CLOSED_DOOR) {
              sealedDoors.add(key);
              addLesson(state.turn, state.depth, "扉封鎖", `扉 (${key}) を開けたら新たに敵${fresh.length}体 (既知の繁殖敵${freshBreeders}体)。すぐ閉めた。この階では壁扱い`);
            } else sealFailed.add(key);
          }
        }
        doorHandled = true;
        break;
      }
    }
    if (doorHandled) continue;

    // === BFSで最寄りの未踏タイルへ移動 ===
    const bfsExploreDir = bfsNextUnvisited(tiles, px, py, visited);
    if (levelDebug) {
      // 隣接タイルの情報
      const adjInfo = ALL_DIRS.map(d => {
        const [dx, dy] = dirOffsets[d]!;
        const t = tiles.find((tt: any) => tt.x === px + dx && tt.y === py + dy);
        return t ? `d${d}:f${t.feat}` : `d${d}:?`;
      }).join(" ");
      console.log(`  [EXPLORE] pos=(${px},${py}) bfs=${bfsExploreDir} stuck=${stuckCount} adj=[${adjInfo}]`);
    }
    if (bfsExploreDir !== null) {
      const oldPos = `${px},${py}`;
      state = await sendCommand({ type: CMD.WALK, direction: bfsExploreDir });
      const newPos = `${state.player.x},${state.player.y}`;
      if (levelDebug && oldPos !== newPos) {
        console.log(`  [MOVE] ${oldPos} → ${newPos}`);
      }
      if (oldPos === newPos && stuckCount <= 2) {
        console.log(`  [STUCK!] WALK dir=${bfsExploreDir} @${oldPos} stuck=${stuckCount} msgs: ${state.messages.slice(-3).join(" | ")}`);
      }
    } else {
      // BFSで到達可能な未踏タイルなし → 孤立部屋チェック
      const totalPassable = tiles.filter((t: any) => PASSABLE_FEATS.has(t.feat)).length;
      const unvisitedCount = tiles.filter((t: any) => PASSABLE_FEATS.has(t.feat) && !visited.has(`${t.x},${t.y}`)).length;

      if (unvisitedCount > 10) {
        // 孤立ループ検知: テレポート後に同じエリアに着地していないか
        const currentArea = getAreaHash(tiles, px, py);
        if (currentArea === lastTeleportArea) {
          teleportLoopCount++;
        } else {
          teleportLoopCount = 0;
        }

        // 3回同じエリアにテレポートした → 階段で脱出
        if (teleportLoopCount >= 2) {
          addLesson(state.turn, state.depth, "孤立ループ脱出",
            `同エリアに${teleportLoopCount+1}回テレポート。階段で脱出に切替`);
          teleportLoopCount = 0;
          lastTeleportArea = "";
          // 階段を探して降下/上昇
          const downOnMe = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.DOWN_STAIR);
          const upOnMe = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.UP_STAIR);
          if (downOnMe) {
            state = await sendCommand({ type: CMD.GO_DOWN });
            visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
            killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = []; levelEntryDetected = false; unreachableItems.clear();
            if (state.depth > maxDepthReached) maxDepthReached = state.depth;
            continue;
          } else if (upOnMe) {
            state = await sendCommand({ type: CMD.GO_UP });
            visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
            killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = []; levelEntryDetected = false; unreachableItems.clear();
            continue;
          }
          // 階段の上にいない → BFSで最寄りの階段へ
          const anyStair = tiles.find((t: any) => t.feat === FEAT.DOWN_STAIR || t.feat === FEAT.UP_STAIR);
          if (anyStair) {
            const stairDir = bfsNextStep(tiles, px, py, anyStair.x, anyStair.y);
            if (stairDir !== null) {
              state = await sendCommand({ type: CMD.WALK, direction: stairDir });
              continue;
            }
          }
          // 階段到達不能 → 壁を掘る
          const randomDir = ALL_DIRS[Math.floor(rand() * ALL_DIRS.length)];
          state = await sendCommand({ type: CMD.TUNNEL, direction: randomDir });
          continue;
        }

        // 通常の孤立脱出: テレポート
        const teleSlot = findTeleportScroll(inv);
        if (teleSlot !== null) {
          addLesson(state.turn, state.depth, "孤立脱出",
            `到達${totalPassable - unvisitedCount}、未到達${unvisitedCount}。Teleportで脱出`);
          lastTeleportArea = currentArea;
          state = await sendCommand({ type: CMD.READ, itemIndex: teleSlot });
          stuckCount = 0;
          visited.clear(); lastVisitedSize = 0; noProgressCount = 0;
          continue;
        }
        // Phase Door fallback
        const phaseSlot = findPhaseScroll(inv);
        if (phaseSlot !== null) {
          lastTeleportArea = currentArea;
          state = await sendCommand({ type: CMD.READ, itemIndex: phaseSlot });
          stuckCount = 0;
          visited.clear(); lastVisitedSize = 0; noProgressCount = 0;
          continue;
        }
        // スクロール切れ → 壁を掘って脱出
        const randomDir = ALL_DIRS[Math.floor(rand() * ALL_DIRS.length)];
        state = await sendCommand({ type: CMD.TUNNEL, direction: randomDir });
      } else {
        // 全タイル訪問済 → 降下
        const downStair = findTile(tiles, FEAT.DOWN_STAIR);
        if (downStair) {
          const onStair = tiles.find((t: any) => t.x === px && t.y === py && t.feat === FEAT.DOWN_STAIR);
          if (onStair) {
            addLesson(state.turn, state.depth, "探索完了降下", `全タイル訪問。降下`);
            state = await sendCommand({ type: CMD.GO_DOWN });
            visited.clear(); lastVisitedSize = 0; noProgressCount = 0; stuckCount = 0;
            killsThisLevel = 0; levelEntryTurn = state.turn; explorationRateWindow = []; levelEntryDetected = false; unreachableItems.clear();
            teleportLoopCount = 0; lastTeleportArea = "";
            if (state.depth > maxDepthReached) maxDepthReached = state.depth;
            continue;
          }
          const nextDir = bfsNextStep(tiles, px, py, downStair.x, downStair.y);
          if (nextDir !== null) {
            state = await sendCommand({ type: CMD.WALK, direction: nextDir });
            continue;
          }
        }
        // フォールバック: ランダムWALK
        state = await sendCommand({ type: CMD.WALK, direction: ALL_DIRS[Math.floor(rand() * ALL_DIRS.length)] });
      }
    }

    // === レベルアップ検知 ===
    if (p.level > maxLevelReached) {
      maxLevelReached = p.level;
      addLesson(state.turn, state.depth, "レベルアップ",
        `CL${maxLevelReached}到達。HP${p.maxHp}、AC${p.ac}、EXP${p.exp}`);
    }

    // (ログは先頭で出力済み)
  }

  // === ゲーム終了 ===
  const finalState = await getState();
  const fp = finalState.player;
  dangerLogger?.finish(finalState);

  if (finalState.dead) {
    // 死因分析
    const lastMsgs = finalState.messages;
    deathCause = fp.diedFrom ? `You have died. (${fp.diedFrom})` // C Angband: player->died_from
      : lastMsgs.find((m: string) => m.includes("killed") || m.includes("die")) || "不明";
    addLesson(finalState.turn, finalState.depth, "死亡",
      `DL${finalState.depth}でCL${fp.level}が死亡。HP${fp.hp}/${fp.maxHp}。死因: ${deathCause}`);
  }

  console.log("\n=== 武将AI プレイ結果 ===");
  console.log(`  最終Turn: ${finalState.turn}`);
  console.log(`  最深部: DL${maxDepthReached}`);
  console.log(`  最高レベル: CL${maxLevelReached}`);
  console.log(`  総撃破数: ${totalKills}`);
  console.log(`  回復薬使用: ${healingsUsed}`);
  console.log(`  逃走回数: ${fleeAttempts}`);
  console.log(`  スペル使用: ${spellsUsed}`);
  console.log(`  スペル学習: ${spellsLearned}`);
  console.log(`  種族/職業: ${fp.race}/${fp.class}`);
  console.log(`  死亡: ${finalState.dead ? `はい (${deathCause})` : "いいえ"}`);
  console.log(`  行動回数: ${actionCount}`);
  if (LLM_ENABLED) {
    if (RULES_CAUTION) console.log(`  RULES_CAUTION: ${RULES_CAUTION}`);
    console.log(`  LLM: ${LLM_BACKEND} 呼出${llmCallCount}回 (平均${llmCallCount > 0 ? Math.round(llmTotalMs / llmCallCount) : 0}ms)`);
  }

  if (finalState.dead && !ROLLOUT) savepointBank.onDeath(deathCause);

  if (ROLLOUT) {
    // ロールアウト結果: 1行だけ stdout に出す (録画/wisdom/レポートは書かない)
    const result = {
      decision_fired: rolloutFired,
      forced: ROLLOUT_FORCE,
      dead: !!finalState.dead,
      death_cause: finalState.dead ? deathCause : null,
      actions: actionCount,
      hp: fp.hp, max_hp: fp.maxHp,
      min_hp_frac: finalState.dead ? 0 : Math.min(minHpFrac, fp.maxHp > 0 ? fp.hp / fp.maxHp : 1),
      depth_start: rolloutStart.depth, depth_end: finalState.depth, depth_max: Math.max(rolloutDepthMax, finalState.depth),
      ...(ROLLOUT_CHECKPOINTS.size ? { checkpoints: rolloutCheckpoints } : {}),
      cl_start: rolloutStart.cl, cl_end: fp.level,
      exp_start: rolloutStart.exp, exp_end: fp.exp ?? 0,
      exp_to_next_level_at_start: rolloutStart.toNext, // 推定値 (player JSON に無い場合) — 種族 expfact × player_exp 表
      exp_to_next_source: "estimated",
      won: !!finalState.won,
      throws: throwsMade, throw_hits: throwHits, throw_kills: throwKills, flees: earlyFleeActions,
    };
    console.log(`ROLLOUT_RESULT ${JSON.stringify(result)}`);
    return result;
  }
  console.log(`  序盤キット: 射撃${shotsFired}回 投擲${throwsMade}回(命中${throwHits}/撃破${throwKills}) 逃走行動${earlyFleeActions}回(階段${earlyFleeStairs}, Phase${phasesRead})`);

  // 最終フレーム + 録画保存
  recordFrame(finalState, finalState.dead ? `死亡: ${deathCause}` : "生存");
  await flushRecording();

  // === 学習記録をJSON出力 ===
  const report = {
    summary: {
      finalTurn: finalState.turn,
      maxDepth: maxDepthReached,
      maxLevel: maxLevelReached,
      totalKills,
      healingsUsed,
      fleeAttempts,
      spellsUsed,
      spellsLearned,
      race: fp.race,
      class: fp.class,
      dead: finalState.dead,
      deathCause,
      actions: actionCount,
    },
    lessons,
    tactics: extractTactics(),
  };

  // クロスラン記憶: 教訓を保存
  if (finalState.dead) {
    const resists = (fp.resistances ?? []).filter((r: any) => r.level > 0).map((r: any) => r.elem);
    const resistStr = resists.length > 0 ? resists.join(",") : "none";
    const lastDescent = lessons.filter(l => l.event === "降下").pop();
    const blowsMatch = lastDescent?.lesson.match(/(\d+)blows/);
    const dpsMatch = lastDescent?.lesson.match(/DPS(\d+)/);
    const acMatch = lastDescent?.lesson.match(/AC(\d+)/);
    const wisdom: WisdomEntry = {
      seed: 0, maxDL: maxDepthReached, maxCL: maxLevelReached,
      deathDL: finalState.depth ?? maxDepthReached,
      deathCause,
      hadResists: resistStr,
      ac: acMatch ? Number(acMatch[1]) : fp.ac ?? 0,
      dps: dpsMatch ? Number(dpsMatch[1]) : 0,
      blows: blowsMatch ? Number(blowsMatch[1]) : 0,
      lesson: generateDeathWisdom(finalState, deathCause),
    };
    saveWisdom(wisdom);
    console.log(`  [WISDOM] 教訓保存: ${wisdom.lesson.slice(0, 80)}`);
  }

  const reportPath = `${BUSHO_TMP}/busho-play-report.json`;
  const fs = await import("node:fs");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  レポート保存: ${reportPath}`);

  return report;
}

function extractTactics(): Record<string, string> {
  return {
    "survival_priority": "HP30%以下で即座に回復。回復薬がなければ逃走。生存が最優先",
    "healing_strategy": "緊急時は最強の回復薬、戦術的回復時は最弱の回復薬を使用。資源節約",
    "combat_approach": "隣接敵は最弱から倒す。3体以上に囲まれたら逃走。危険敵(Lv2x以上,速度120超)は接近前に回避",
    "descent_conditions": "HP70%+回復薬+逃走手段+CL/DL比率チェック。無謀な降下は死因の上位",
    "exploration_pattern": "未踏地を優先して移動。スタック検知でランダム方向転換",
    "food_management": "food < 2000で即食事。飢餓はHP回復を阻害し間接的な死因になる",
    "flee_decision": "HP危険域+回復不能=Phase Door。さらに危険ならTeleportation。危険敵はdist3で先制逃走",
    "rest_vs_potion": "敵なし+HP50%以下→REST。敵あり+HP低→回復薬。状況で使い分け",
    "spell_priority": "回復スペル→薬温存。逃走スペル→スクロール温存。攻撃スペル→隣接敵に使用。検知→新フロア到着時",
    "spell_learning": "優先順: 回復 > 逃走 > 検知 > バフ > 攻撃。新枠があれば即学習",
    "equipment_scoring": "耐性(base4=+15,高級=+8),フラグ(FREE_ACT+15,SEE_INVIS+12,TELEPATHY+20),SPEED修正(+20/pt)",
    "threat_assessment": "Lv>2xPL or spd>120+LvOverPL → 危険判定。接近前にPhase/Teleportで回避",
  };
}

// ── 実行 ──
playGame().catch(console.error);
