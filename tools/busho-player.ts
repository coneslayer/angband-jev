#!/usr/bin/env npx tsx
/**
 * @file busho-player.ts
 * @brief 武将AIプレイヤー — ai-server経由でAngbandを自律プレイする
 *
 * 学習した戦術をログに記録し、スキルとして保存可能にする。
 */

import {
  DECISION_FORMAT_VERSION, DECISION_FORMAT_VERSION_PLAYER, DECISION_FORMAT_VERSION_ROLES, DECISION_ROLES, fightDecision, tacticDecision, recallDecision, descendDecision, exploreDecision, equipDecision, blindDecision,
} from "./decision/index.js";
import type { DecisionType, DecisionRequest, BlindCtx } from "./decision/index.js";
import { SavepointBank } from "./savepoint/bank.js";
import { adaptPlayerView, estimatedMaxHp } from "./honest-view.js";
import { DangerLogger, DANGER_RECORD_VERSION } from "./danger/record.js";
import { DangerModel } from "./danger/model.js";
import { rolesOf, itemRoles, itemHarmful, spellsFor, resourceLines, reachOf, ROLE_ORDER, CURE_STATUS, type Role, type RoleEntry } from "./spell-roles.js";

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
  STUDY: 28, REFILL: 29,
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
  // RULEFIX=spellfx: 壁を消す呪文。経路に何マスもあり得るので、3 回分の MP がある時だけ壁を通る道を考える
  const ds = SPELLFX && DIG_SPELL_FEATS.has(feat) ? fxDigSpell() : null;
  if (ds && (lastKnownState?.player?.sp ?? 0) >= 3 * ds.mana) return true;
  return !digFutile(feat) && (SOFT_DIG_FEATS.has(feat) || (DIGGABLE_FEATS.has(feat) && canDigFeat(feat)));
}
const futileDig = new Set<number>(); // RULEFIX=digskill (説明は DIGSKILL の宣言に)
let futileDigSkill = -1;
function digFutile(feat: number): boolean { return DIGSKILL && futileDig.has(feat); }
const DIR_DXY: Record<number, [number, number]> = { 1: [-1, 1], 2: [0, 1], 3: [1, 1], 4: [-1, 0], 6: [1, 0], 7: [-1, -1], 8: [0, -1], 9: [1, -1] };
function tunnelTarget(s: any, dir: number): { x: number; y: number; feat: number } | null {
  const [dx, dy] = DIR_DXY[dir] ?? [0, 0];
  const x = (s?.player?.x ?? 0) + dx, y = (s?.player?.y ?? 0) + dy;
  const t = (s?.map?.tiles ?? []).find((t: any) => t.x === x && t.y === y);
  return t && DIGGABLE_FEATS.has(t.feat) ? { x, y, feat: t.feat } : null;
}
function noteTunnel(at: { x: number; y: number; feat: number }, turnBefore: number | undefined, s: any): void {
  if (typeof turnBefore !== "number" || (s?.turn ?? 0) - turnBefore < 400 || futileDig.has(at.feat)) return;
  const t = (s?.map?.tiles ?? []).find((t: any) => t.x === at.x && t.y === at.y);
  if (t?.feat !== at.feat) return;
  futileDig.add(at.feat); futileDigSkill = diggingSkill;
  console.log(`  [DIGSKILL] 地形${at.feat}を${(s?.turn ?? 0) - turnBefore}ゲームターン掘って崩れず。掘削能力${diggingSkill}が上がるまで掘らない`);
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
  BOW: 5, SHOT: 2, ARROW: 3, BOLT: 4, CHEST: 1, GOLD: 35,
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
  // RULEFIX=invfix: 深いほど麻痺 (Free Action) と見えない敵 (See Invisible) が命取り: DL10 で 45 と 32。種族 (Gnome、High-Elf) や
  // 他の装備で既に持っていれば 0 (指輪はもう片方の指輪も他の装備として数える)
  const invDepth = INVFIX ? (lastKnownState?.player?.maxDepth ?? lastKnownState?.depth ?? 0) : 0;
  if (flags.has(OF.FREE_ACT) && !(INVFIX && hasElsewhere(OF.FREE_ACT, item))) score += 15 + 3 * invDepth;
  if (flags.has(OF.SEE_INVIS) && !(INVFIX && hasElsewhere(OF.SEE_INVIS, item))) score += 12 + 2 * invDepth;
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
  if (STATIONMEM && STATIONMEM_EYE_RE.test(name)) return true;
  if (!STATIONARY_RE.test(name)) return false;
  return /floating eye/i.test(name) || (m.maxhp ?? m.hp ?? 99) > 5;
}
// ── 序盤ルール改善 (RULEFIX=danger,restock,escape,upnavfood,fire,lowheal,leave,clgate1,gearid,tryunknown,worwait,deepkit,neutdrink,digskill,stationmem。"none" で旧ルール、A/B 用。wor, upnav は明示した時だけ。fire, lowheal はセッション14、leave, clgate1 はセッション17、gearid, tryunknown はセッション22、worwait, deepkit, neutdrink, digskill はセッション23、stationmem はセッション24で採用) ──
const RULEFIX = new Set((process.env.RULEFIX ?? "danger,restock,escape,upnavfood,fire,lowheal,leave,clgate1,gearid,tryunknown,worwait,deepkit,neutdrink,digskill,stationmem").split(",").map((t) => t.trim()));
// 既定 (session 14 で採用): fire (射撃武器で撃つ + 矢弾を買う), lowheal (HP 危険域・毒は停滞脱出より回復)。
// 明示した時だけ (session 15 の検証): food8 (食料を 8 個まで), neutpois (Neutralize Poison を買い、毒で HP 半分未満なら飲む),
// poisonhold (毒で HP 半分未満・回復薬なし・敵が見えない → 休む), fireadj (隣接する敵も撃つ), ammo60 (矢弾を 60 本まで)
// 明示した時だけ (session 14 で不採用): restock100 (補給帰還は 100G 以上), restockboth (回復薬と Phase/油の両方が切れたら帰還), clgate1 (DL1-3 は CL >= DL+1 で降下)
// 明示した時だけ (セッション18で検証): clgate0 (DL1-3 は CL >= DL で降下)、leave2 (この階で 2 回逃げたら去る)、
// leavemore (leave の名前に、セッション17の新しい既定で多かった死因を加える)
const EARLY_CL_MARGIN = RULEFIX.has("clgate0") ? 0 : RULEFIX.has("clgate1") ? 1 : 2;
// RULEFIX=castergate: Mage と Druid (HP の少ない純術者) は DL1-4 で CL >= 2*DL+1 まで降りない。4.2 の Grip/Fang は HP 25/28、
// 速度 +20、AC 36 (昔は HP 5 前後): CL2 の Mage (HP 13-17、MP 4) は倒せず、Phase Door でも逃げられない。harvest の Mage の新規
// 321 局中 DL2-4 止まりが 172、死因の 1-2 位が Grip と Fang
const CASTERGATE = RULEFIX.has("castergate");
// RULEFIX=deepgate: DL8 以降は CL >= DL+3 まで降りない (長居 veryLongOnLevel の緩和も 4 倍の滞在まで効かない)。深層スタート
// (driver18、2026-10-31) の base は 99% が 2 万手以内に死に、開始時の CL-DL が大きいほど長く生きて深く進んだ
// (CL-DL <= 0: 平均 3,000 手で +1.6 階、1-2: 4,200 手で +2.3、3-5: 3,800 手で +2.7、6+: 9,700 手で +13.5。職業の交絡あり)
const DEEPGATE = RULEFIX.has("deepgate");
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
// RULEFIX=leavelos: 名前で去る敵は視線の通る敵だけ (検知・テレパシーで知っただけの敵は数えない)。ゲームのモンスター一覧の
// 「見える」と「気づいている」の区別 (mon-list.c は projectable)。session 25: 到着時の Seek Battle で 27 マス先の Fang を見て去っていた
const LEAVELOS = RULEFIX.has("leavelos");
// RULEFIX=lightout: ランタンは油で補給。残りの光 (装備中 + 予備の松明すべて + ランタンなら油 1 本 7500) が 2000 ターン
// (WoR が無ければ 2000 + 1000×深さ、上限 6000) を切ったら、明るいうちに Word of Recall、無ければ上り階段で町へ (深さを問わず)。もう暗い時: 帰還待ちなら休む、
// 1 歩おきに上り階段を試す (階段の上でなければ時間は経たない)、まだ触れていないマスを優先して手探りで 1 歩
// (session 25: 燃え残りの松明 (各 300 ターン) を替え続けて最後に暗闇になり、同じマスで数千行動休み続けた試合があった)
const LIGHTOUT = RULEFIX.has("lightout");
// RULEFIX=packfull: 荷物の空きはゲームの数え方で (矢筒は 40 本ごとに 1 枠を使う: inventory の件数では満杯が分からない)。満杯なら床のアイテムへ
// 向かわず、拾えなかったマスはこの階では拾わない (2026-10-30 の試走: 満杯で拾えないアイテムの間を数万行動往復し、食料と松明が尽きて餓死)
// RULEFIX=invfix: 持ち物の管理一式 (packfull を含む)。害のある既知の薬・使えない本は持たない (auditfix の判定)、町では使い道の無い物と燃え残りの
// 松明を売って必需品の枠を空ける、ダンジョンでは荷物が満杯か重すぎる (速度が落ちる) 時に要らない物を落とす、ランタンを使う (油で給油)、
// 松明の交換は失敗した時だけ止める、指輪は弱い方と比べて差し替える (両方埋まっていれば外す方を指定)、Free Action と See Invisible は深いほど高く評価
// (2026-10-30: 満杯の荷物で町の WoR・食料を買えず餓死、拾ったランタンの 9 割を売却、燃え残りの松明で暗闇、2 つ目の指輪が着けられないループ)
const INVFIX = RULEFIX.has("invfix");
// RULEFIX=packlight (invfix と): 重さで速度を落とさない。4.2 では持ち物と装備の重さが力の上限の半分 (burdenSlowAt) を超えると、上限の
// 1/10 ごとに速度 −1。harvest の 313 セーブポイントで 59% が半分を超え、36% は実際に −1 以上 (DL20+ は 64%、平均 −1.4)。重さの内訳
// (1 人平均): 油 11 lb、松明 11 lb (ランタンを持ちながら 4〜16 本)、食料 8 lb (6〜25 個)、シャベル 7 lb、宝箱 6 lb (20% が 25 lb の箱を
// 開けずに持つ)、魔法書 8〜9 lb (同じ本を 3〜4 冊)。invfix は山ごとにしか落とさず、これらは落とす順位が無かった。packlight: 宝箱は
// いつでも落とす。重すぎる時は山の余りを落とす (松明はランタンがあれば 1 本、無ければ 4 本、同じ魔法書 2 冊、食料 8 個、油 15 個、
// 合う発射台の無い矢・ボルト)。油は投げる武器なので 15 個 (初版の 8 個では投擲が 6.7 → 5.3 回に減った)
const PACKLIGHT = RULEFIX.has("packlight");
// RULEFIX=floorpick: 足元の山をまとめて拾わず、見えている床の品 (ブリッジの floorObjects: ゲームの物品一覧と同じ、名前・種類・数・重さ)
// から拾う物を 1 品ずつ選ぶ。拾う物の無いマスへは歩かない。ゲームの pickup_inven (持ち物と同じ品は歩けば拾う、既定で有効) を切る:
// 落とした松明・食料・油を歩くたびに拾い直していた。自分で落とした品 (oid) は拾わない (階段の上では隣のマスに落ちる)
const FLOORPICK = RULEFIX.has("floorpick");
// RULEFIX=gearweight: 装備の比べ方 (gearid) に重さを入れる。着けない方は手放すとして、残る重さが速度の落ち始め (burdenSlowAt) を
// 超える分を速度に直して引く (上限の 1/10 で −1、速度 1 = 20 点: itemPower の速度修正と同じ)
const GEARWEIGHT = RULEFIX.has("gearweight");
const PACKFULL = RULEFIX.has("packfull") || INVFIX;
function packIsFull(p: any, inv: any[]): boolean {
  return PACKFULL && typeof p.packFree === "number" ? p.packFree <= 0 : inv.length >= 23;
}
/** invfix: 種族か、この品と同じ部位以外の装備 (指輪はもう片方の指輪も) で既にその性質 (OF) を持っているか */
const RACE_OF: Record<string, number[]> = { Gnome: [OF.FREE_ACT], "High-Elf": [OF.SEE_INVIS] };
function hasElsewhere(flag: number, item: any): boolean {
  const p = lastKnownState?.player;
  if (!p) return false;
  if ((RACE_OF[p.race] ?? []).includes(flag)) return true;
  return ((p.equipment ?? []) as any[]).some((e: any) => {
    if (e === item || (e.slot === item.slot && e.name === item.name && e.tval === item.tval)) return false; // この品自身
    if (e.tval !== TVAL.RING && sameEquipCategory(e.tval, item.tval)) return false; // 替えられる側
    return new Set(gearView(e).flags ?? []).has(flag);
  });
}
// RULEFIX=home: 価値のありそうな装備 (指輪・アミュレット、性質や修正値のある物、未知のルーンのある物。呪いの分かっている物は除く) は
// 売らず捨てず家に預ける。町に戻るたびに家の装備を今の装備と比べ、良ければ引き出して着ける (例: Speed のブーツで Free Action の
// ブーツを外したら、家の Free Action の指輪の評価が上がって引き出される)
const HOME = RULEFIX.has("home");
const ABILITY_OF = new Set([OF.SUST_STR, OF.SUST_INT, OF.SUST_WIS, OF.SUST_DEX, OF.SUST_CON, OF.PROT_FEAR, OF.PROT_BLIND, OF.PROT_CONF,
  OF.PROT_STUN, OF.SLOW_DIGEST, OF.FEATHER, OF.REGEN, OF.TELEPATHY, OF.SEE_INVIS, OF.FREE_ACT, OF.HOLD_LIFE]);
function homeWorthy(item: any): boolean {
  if (!HOME || !item || !EQUIPPABLE_TVALS.has(item.tval) || item.tval === TVAL.LIGHT || item.tval === TVAL.DIGGING) return false;
  if (gearCursed(item)) return false;
  if (item.tval === TVAL.RING || item.tval === TVAL.AMULET || gearUnknown(item)) return itemPower(item) >= 0; // Open Wounds などの負の物は除く
  const v = gearView(item);
  return (v.flags ?? []).some((f: number) => ABILITY_OF.has(f)) || (v.resists ?? []).some((r: any) => r.level > 0)
    || (v.modifiers ?? []).some((m: number | undefined) => (m ?? 0) > 0) || (v.brands ?? []).length > 0 || (v.slays ?? []).length > 0;
}
function homeStore(st: any): any | undefined { return (st?.stores ?? []).find((s: any) => /home/i.test(s.name ?? "")); }
/** invfix: 新しい指輪と比べる装備中の指輪。両手に嵌めていれば評価の低い方、空きがあれば無し */
function ringRival(equip: any[]): any | undefined {
  const rings = equip.filter((e: any) => e.tval === TVAL.RING);
  return rings.length < 2 ? undefined : rings.sort((a: any, b: any) => itemPower(a) - itemPower(b))[0];
}
/** 新しい装備と比べる現装備 (invfix: 指輪は ringRival) */
function equipRival(equip: any[], tval: number): any | undefined {
  return INVFIX && tval === TVAL.RING ? ringRival(equip) : equip.find((e: any) => sameEquipCategory(e.tval, tval));
}
/** 装備コマンド (invfix: 指輪で両方埋まっていれば外す指輪を指定。ゲームは "Replace which ring?" と聞く) */
function equipCmd(item: any, rival: any | undefined): Record<string, unknown> {
  return INVFIX && item.tval === TVAL.RING && rival ? { type: CMD.EQUIP, itemIndex: item.slot, replaceSlot: rival.slot }
    : { type: CMD.EQUIP, itemIndex: item.slot };
}
function wieldsLantern(): boolean { // 燃料があるか、給油できる油を持っているランタン (空のランタンは光源に数えない)
  const p = lastKnownState?.player;
  const oil = ((p?.inventory ?? []) as any[]).some((i: any) => /Flask~? of oil/i.test(i.name ?? "") && i.qty > 0);
  return ((p?.equipment ?? []) as any[]).some((e: any) => e.tval === TVAL.LIGHT && /Lantern/i.test(e.name ?? "") && ((e.fuel ?? 0) > 0 || oil));
}
/** invfix: ランタンを使っていれば予備の松明は 1 本で足りる */
function torchTarget(n: number): number { return INVFIX && wieldsLantern() ? Math.min(n, 1) : n; }
/** invfix: 手放す順 (小さいほど先)。null は手放さない (食料、回復・脱出・帰還、油、自分の本、掘削具、矢弾、良い装備…) */
function shedRank(item: any, equip: any[]): number | null {
  if (!INVFIX || !item || item.qty <= 0) return null;
  if (auditJunk(item)) return 0; // 使えない本、害のある既知の薬・巻物・食料
  if (EQUIPPABLE_TVALS.has(item.tval) && item.tval !== TVAL.DIGGING && item.tval !== TVAL.LIGHT && !shouldKeepItem(item, equip)) return homeWorthy(item) ? null : 1; // home: 家まで持ち帰る
  if (item.tval === TVAL.LIGHT && /Torch/i.test(item.name ?? "")) {
    const otherLight = wieldsLantern() || ((lastKnownState?.player?.inventory ?? []) as any[])
      .some((i: any) => i !== item && i.tval === TVAL.LIGHT && (i.fuel ?? 0) >= 1000);
    if ((item.fuel ?? 0) < 1000 && otherLight) return 2; // 燃え残り (燃料の違う松明は重ならず 1 枠ずつ使う)
    if (wieldsLantern() && ((lastKnownState?.player?.inventory ?? []) as any[])
      .filter((i: any) => i.tval === TVAL.LIGHT && /Torch/i.test(i.name ?? "") && (i.fuel ?? 0) > (item.fuel ?? 0)).length >= 1) return 2;
  }
  if (item.tval === TVAL.LIGHT && /Lantern/i.test(item.name ?? "") && wieldsLantern()) return 2; // 2 つ目のランタン
  if (item.tval === TVAL.SCROLL && item.aware === false) return 3; // 未知の巻物 (読まない。町で店に渡して識別)
  if (item.tval === TVAL.SCROLL && /^(Treasure Detection|Detect Invisible)$/.test(item.name ?? "")) return 4;
  if ((!DEVICES || (DFXNOKEEP && (item.aware === false || deviceUseless(item)))) && [TVAL.STAFF, TVAL.WAND, TVAL.ROD].includes(item.tval)
    && !(TELESHOP && isTeleStaff(item))) return 4;
  // 5-6: 荷物が詰まった時だけ (町では空きが 3 枠未満の時に売る): 未知の薬 (店に渡せば識別)、小物の食料と薬、2 本目の掘削具
  if (item.tval === TVAL.POTION && item.aware === false) return 5;
  if (item.tval === TVAL.FOOD && !/Ration|Remove Hunger/i.test(item.name ?? "")) return 6;
  if (item.tval === TVAL.POTION && /^(Boldness|Infravision|Slime Mold Juice|Salt Water|Sleep)$/.test(item.name ?? "")) return 6;
  if (item.tval === TVAL.DIGGING && ((lastKnownState?.player?.inventory ?? []) as any[])
    .some((i: any) => i !== item && i.tval === TVAL.DIGGING && ((i.weight ?? 0) > (item.weight ?? 0) || ((i.weight ?? 0) === (item.weight ?? 0) && i.slot < item.slot)))) return 6;
  return null;
}
/** packlight: この山から手放してよい数 (目標を超える分)。宝箱は全部。重すぎる時に使う */
function shedExcess(item: any, inv: any[]): number {
  if (!PACKLIGHT || !item || (item.qty ?? 0) <= 0) return 0;
  const q = item.qty ?? 1, name = item.name ?? "";
  const keepOf = (keep: number, same: (i: any) => boolean, better: (a: any, b: any) => number) => {
    // 同じ種類の山を良い順に並べ、良い方から keep 個まで残す。この山の残りを返す
    let left = keep;
    for (const i of inv.filter(same).sort(better)) {
      const k = Math.min(left, i.qty ?? 1); left -= k;
      if (i === item) return q - k;
    }
    return 0;
  };
  if (item.tval === TVAL.CHEST) return q;
  if (item.tval >= 30 && item.tval <= 34) return Math.max(0, q - 2); // 火で 1 冊焼けても残るように 2 冊
  if (item.tval === TVAL.LIGHT && /Torch/i.test(name))
    return keepOf(wieldsLantern() ? 1 : 4, (i: any) => i.tval === TVAL.LIGHT && /Torch/i.test(i.name ?? ""), (a: any, b: any) => (b.fuel ?? 0) - (a.fuel ?? 0));
  if (item.tval === TVAL.FOOD && /Ration/i.test(name)) return keepOf(Math.max(FOOD_KEEP, 8), (i: any) => i.tval === TVAL.FOOD && /Ration/i.test(i.name ?? ""), () => 0);
  if (item.tval === TVAL.FLASK && /oil/i.test(name)) return keepOf(15, (i: any) => i.tval === TVAL.FLASK && /oil/i.test(i.name ?? ""), () => 0);
  if (item.tval === TVAL.ARROW || item.tval === TVAL.BOLT) {
    const bow = ((lastKnownState?.player?.equipment ?? []) as any[]).find((e: any) => e.tval === TVAL.BOW)?.name ?? "";
    const fits = item.tval === TVAL.BOLT ? /Crossbow/i.test(bow) : /Bow/i.test(bow) && !/Crossbow/i.test(bow);
    if (!fits) return q; // 石と弾は投げられる (THROWING) ので残す
  }
  return 0;
}
const ignoredOids = new Set<number>(); // floorpick: 自分で落とした・拾えなかった床の品 (この階)
/** floorpick: 落とす前の床の品の oid。落とした後の state と比べて、新しく現れた品を拾わない品にする */
function floorOids(st: any): Set<number> { return new Set(((st?.floorObjects ?? []) as any[]).map((o: any) => o.oid)); }
function noteDropped(before: Set<number>, st: any): void {
  if (FLOORPICK) for (const o of (st?.floorObjects ?? []) as any[]) if (!before.has(o.oid)) ignoredOids.add(o.oid);
}
/** floorpick: 床の品を拾うか。見えている名前・種類・数・重さだけで決める。遠くから見ただけの山 (unknown) は見に行く */
function wantFloor(o: any, p: any, inv: any[]): boolean {
  if (ignoredOids.has(o.oid) || o.ignored) return false;
  if (o.unknown) return true;
  if (o.tval === TVAL.GOLD) return true;
  const it = { ...o, slot: -1, aware: true };
  if (o.tval === TVAL.CHEST || auditJunk(it)) return false;
  if ([TVAL.STAFF, TVAL.WAND, TVAL.ROD].includes(o.tval) && deviceUseless(it)) return false;
  if (o.tval >= 30 && o.tval <= 34) return inv.filter((i: any) => i.tval === o.tval && i.name === o.name).reduce((n: number, i: any) => n + (i.qty ?? 1), 0) < 2;
  if (PACKLIGHT && shedExcess(it, [...inv, it]) >= (o.qty ?? 1)) return false; // 持っている分で目標に足りている (松明・食料・油・合わない矢)
  const w = (o.weight ?? 0) * (o.qty ?? 1);
  if (typeof p?.burden === "number" && typeof p?.burdenSlowAt === "number" && p.burden + w > p.burdenSlowAt) {
    // 拾うと速度が落ち始める: 軽くて役に立つ物 (薬・巻物・指輪・首飾り・魔法の道具) と、空いた部位の装備だけ
    if ([TVAL.POTION, TVAL.SCROLL, TVAL.RING, TVAL.AMULET, TVAL.WAND, TVAL.ROD].includes(o.tval)) return true;
    if (EQUIPPABLE_TVALS.has(o.tval) && o.tval !== TVAL.LIGHT && o.tval !== TVAL.DIGGING)
      return !((p.equipment ?? []) as any[]).some((e: any) => sameEquipCategory(e.tval, o.tval));
    return false;
  }
  return true;
}
let pickOid = -1;
/** floorpick: 足元で拾う 1 品の PICKUP。拾う物が無ければ null (このマスには印を付け、二度と拾いに来ない) */
function floorPickCmd(st: any, px: number, py: number): Record<string, unknown> | null {
  if (!FLOORPICK) return { type: CMD.PICKUP };
  const here = ((st.floorObjects ?? []) as any[]).filter((o: any) => o.x === px && o.y === py);
  if (here.length === 0) return { type: CMD.PICKUP }; // 一覧に無い (上限超え): 今まで通り
  const want = here.find((o: any) => !o.unknown && wantFloor(o, st.player, st.player.inventory ?? []));
  if (!want) { droppedTiles.add(`${px},${py}`); return null; }
  pickOid = want.oid;
  return { type: CMD.PICKUP, objectId: want.oid };
}
/** floorpick: 拾いに行く価値のあるマスか */
function tileWanted(st: any, x: number, y: number): boolean {
  if (!FLOORPICK) return true;
  const here = ((st.floorObjects ?? []) as any[]).filter((o: any) => o.x === x && o.y === y);
  return here.length === 0 || here.some((o: any) => wantFloor(o, st.player, st.player.inventory ?? []));
}
/** gearweight: 重さ b の時の速度の費用 (itemPower の点) */
function burdenCost(b: number, p: any): number {
  if (!GEARWEIGHT || typeof p?.burdenSlowAt !== "number" || p.burdenSlowAt <= 0) return 0;
  return 20 * Math.max(0, b - p.burdenSlowAt) / (p.burdenSlowAt / 5);
}
let lightTripNoted = false, darkSteps = 0;
const darkFelt = new Set<string>(); // 暗闇で踏んだマス (この階)
/** lightout: 買い物で数える松明は燃料 2500 以上 (新品は 5000) だけ。燃え残りを在庫に数えて買わずにいた */
function torchCounts(i: any): boolean { return !LIGHTOUT || i.tval !== TVAL.LIGHT || (i.fuel ?? 5000) >= 2500; }
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

// RULEFIX=stationmem: 回避マスに、今は見えないがこの階で見た動かない接触の敵 (C の rememberedMonsters) も入れる。見えている敵だけだと、
// 離れて視界から消えた途端に BFS がまた隣を通る (session 22 の tryunknown: 隣 → 見えない → 6 手以内に同じ敵の隣、705 局中 402 局で
// 26,618 回。浮遊眼 9,420、blue jelly 6,924。rot jelly は触れるたびに食料を食べる)。4.2 で動かない目 (bloodshot eye の凝視で盲目など) も接触の敵に
const STATIONMEM = RULEFIX.has("stationmem");
const STATIONMEM_EYE_RE = /(radiation|disenchanter|bloodshot|evil) eye/i;
let blindSteps = 0;
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
function gearCursed(it: any): boolean {
  return (it?.kcurses ?? 0) > 0 || /\{[^}]*cursed/.test(it?.desc ?? "") || (FEARFIX && fearShunned.has(it?.name ?? ""));
}
function gearUnknown(it: any): boolean { return /\?\?/.test(it?.desc ?? ""); }
// 射撃武器の弾の種類 (違う種類には替えない: 買った矢弾が無駄になる)
function launcherFamily(name: string): string { return /Sling/i.test(name) ? "shot" : /Crossbow/i.test(name) ? "bolt" : "arrow"; }
let gearTries = new Map<string, number>(), lastGearAction = -99, lastShedAction = -99;
// RULEFIX=tryunknown: 未知の薬を、5 マス以内に敵がいない時に飲んで識別する (HP 75% 未満なら回復薬かもしれない。町なら HP を問わない)。
// 未知の巻物は町で錬金術店に渡す (shouldKeepItem)。持ち物の名前は知っている時だけ本当の名前 (C の aware)
const TRYUNKNOWN = RULEFIX.has("tryunknown");
// RULEFIX=blindsafe: 盲目で見えない敵に攻撃されている → 盲目を治す薬 (4.2 では CLW/CSW/CCW すべて) を飲む、なければ階段の上なら階を変える
// (休むと殴られ続ける。session 22 の確認の新既定: 死亡 183 件中 14 件が盲目で休み続けて死に、うち 8 件は飲んだ直後で治す薬なし。
// tryunknown の Blindness は 75+4d25 ターン)。tryunknown は治す薬を持っている時だけ未知の薬を飲む
const BLINDSAFE = RULEFIX.has("blindsafe");
const BLINDSAFE2 = RULEFIX.has("blindsafe2");
const BLINDFIGHT = RULEFIX.has("blindfight");
let blindAttacks = 0;
const BLINDASK = RULEFIX.has("blindask");
const CHEAT = process.env.ROLLOUT_FORCE ? "" : (process.env.CHEAT ?? "").trim(); // rollouts never cheat
let blindEp: { start: number; hp0: number; lastHp: number; hits: number; asks: number; askedAtHits: number } | null = null;
let blindAsks = 0;
const blindActs: Record<string, number> = {};
const BLIND_CURE_ORDER = ["Cure Light Wounds", "Cure Serious Wounds", "Cure Critical Wounds", "Healing", "*Healing*", "Life"];
/** Potions known to cure blindness, weakest first (4.2: all the Cure potions and the Healing ones) */
function blindCures(inv: any[]): any[] {
  return inv.filter((i: any) => i.tval === TVAL.POTION && i.aware !== false && (i.qty ?? 1) > 0 && BLIND_CURE_ORDER.includes(i.name ?? ""))
    .sort((a: any, b: any) => BLIND_CURE_ORDER.indexOf(a.name) - BLIND_CURE_ORDER.indexOf(b.name));
}
/** M1 "walk": the passable neighbour farthest from the remembered monsters within 7 (any one if none), or null */
function blindWalkDir(tiles: any[], px: number, py: number, mem: any[]): number | null {
  const off: Record<number, [number, number]> = { 1: [-1, 1], 2: [0, 1], 3: [1, 1], 4: [-1, 0], 6: [1, 0], 7: [-1, -1], 8: [0, -1], 9: [1, -1] };
  let best: number | null = null, bestD = -1;
  for (const d of ALL_DIRS) {
    const [dx, dy] = off[d]!;
    const nx = px + dx, ny = py + dy;
    if (!isPassable(tiles, nx, ny) || mem.some((m: any) => m.x === nx && m.y === ny)) continue;
    const md = mem.length ? Math.min(...mem.map((m: any) => Math.max(Math.abs(m.x - nx), Math.abs(m.y - ny)))) : 0;
    if (md > bestD) { bestD = md; best = d; }
  }
  return best;
}
// RULEFIX=teleshop: 4.2 の店は Teleportation の巻物を売らない (魔法店と闇市の Teleportation の杖だけ)。最深 DL5 以上で使える杖がなければ
// 買い、売らず落とさず、Teleportation の巻物を探す所すべてで巻物がない (または読めない: 盲目・混乱) 時は杖を使う。杖は盲目でも混乱中でも使える
const TELESHOP = RULEFIX.has("teleshop");
// RULEFIX=curefx: 混乱中に飲む薬は混乱を治すもの (CSW、CCW。4.2 の CLW は 20 ターン減らすだけ) を先に、HP 35% 未満なら強い順。
// 2 マス以内に敵がいなくても、起きて動く敵が 7 マス以内に見えれば休まず飲む (遠くから混乱させ続ける術者: ironfist priest など)
const CUREFX = RULEFIX.has("curefx");
const CONF_CURES = /^(Cure Serious Wounds|Cure Critical Wounds|Healing|\*Healing\*|Life)$/;
// RULEFIX=confesc: 混乱中は耐えずに逃げる。起きて動く敵が 7 マス以内 (または見えない攻撃者) の時、階段の上なら階段、Teleportation の杖
// (混乱中でも使える) があれば杖、混乱を治す薬 (CSW・CCW、無ければ CLW: 4.2 の混乱の多くは 20 ターン未満) を飲み、治った直後にまだ敵が
// 見えて危ないなら Teleportation (無ければ Phase Door) を読む。何も無ければ隣の敵を殴り、いなければ離れる (4.2 の混乱は 75% で向きが
// ランダム、狙った向きの方がランダム歩行よりまし)。2026-10-31: 深層 base の死 1,122 件中 302 件で最後の 30 行動に混乱、混乱中の行動は
// ランダム歩行 1,472・休む 747 (7 マス先の術者の前で休んでいた)・薬 626
const CONFESC = RULEFIX.has("confesc");
// RULEFIX=fearfix: 怯えていると殴れない (4.2)。auditfix の恐怖の手当て (恐怖を治す薬、呪文、射撃、投擲、離れる、Phase Door) を単独で使い、
// 時限の恐怖だけでなく「too afraid to attack」(移動が時間を使わずに失敗) でも怯えていると見る。その時に時限の恐怖が無ければ恐怖は
// 装備から (Ring of Escaping、cowardice の呪い): 恐怖の性質を知っている (kflags) 指輪・アミュレット、無ければ呪いのある指輪・アミュレットを
// 外し、二度と着けない。2026-10-31: 深層 base 1,159 局で、時間の進まない移動 30 回の後の「待機」が 5,097 回 (隣の敵に只で殴られる)
const FEARFIX = RULEFIX.has("fearfix");
const OF_AFRAID = 24; // list-object-flags.h
let fearMsgSeq = -99, fearPerm = false, fearOffs = 0;
const fearShunned = new Set<string>();
/** fearfix: 今殴れないか (時限の恐怖、または直近 5 コマンド以内に「too afraid to attack」) */
function fearBlocked(p: any): boolean { return (p?.timed?.afraid ?? 0) > 0 || (FEARFIX && sendSeq - fearMsgSeq <= 5); }
/** confesc: 混乱中に逃げる理由になる敵 (起きて動く、7 マス以内) */
function confThreat(m: any): boolean {
  return m.distance <= 7 && !m.asleep && m.neverMove !== true && !STATIONARY_RE.test(m.name ?? "");
}
let confCuredAt = -99;
const confEsc = { stairs: 0, staff: 0, cure: 0, attack: 0, away: 0, read: 0 };
/** curefx: 混乱を治す薬 (なければ CLW)。HP 35% 未満なら強い順 */
function findConfusionCure(inv: any[], hpPct: number): number | null {
  const cures = inv.filter((i: any) => i.tval === TVAL.POTION && i.qty > 0 && i.aware !== false && CONF_CURES.test(i.name ?? ""))
    .sort((a: any, b: any) => hpPct < 0.35 ? b.sval - a.sval : a.sval - b.sval);
  return cures.length ? cures[0].slot : findHealingPotion(inv);
}
function isTeleStaff(i: any): boolean { return i?.tval === TVAL.STAFF && i.aware !== false && /^Teleportation$/.test(i.name ?? ""); }
let lastTryAction = -99, potionsTried = 0;
// RULEFIX=corridor: 起きている動く敵が 2 体以上 7 マス以内に見え、まだ隣にいない時、開けた場所 (通れる隣接 3 以上) なら
// 6 歩以内の通路 (通れる隣接 2 以下、敵の隣でない) へ下がり、通路では最大 CORRIDOR_HOLD 回その場で待つ (近づいて部屋で囲まれない)。
// 待っても来なければ CORRIDOR_OFF 行動は使わない (4.2 の GROUP_AI の群れは通路の外へ誘い出そうとして来ない)。
// session 23 の base の死 190 件中 83 件で、最後の 15 行動に 2 体以上が隣接していた (オーク・コボルドの死では 48 件中 26 件)
const CORRIDOR = RULEFIX.has("corridor");
const CORRIDOR_HOLD = 6, CORRIDOR_STEPS = 8, CORRIDOR_OFF = 40;
let corridorHold = 0, corridorSteps = 0, corridorOffUntil = -1, corridorMoves = 0, corridorWaits = 0;
// RULEFIX=worwait: 町で Word of Recall が発動待ちの間は階段を降りずに待つ (4.2 ではダンジョンにいる時に発動すると町へ引き戻される。
// session 22 の既定では町で読んだ 329 回のうち 269 回が DL1 へ降りて町へ戻され、巻物 (125G) が無駄になり DL1 から歩いていた)
const WORWAIT = RULEFIX.has("worwait");
const ESCRECALL = RULEFIX.has("escrecall");
const ESCWALK = RULEFIX.has("escwalk");
const ESCDIRE = RULEFIX.has("escdire");
let escRecalls = 0, escWalks = 0;
// RULEFIX=deepkit: DL5 以深から戻った町でも、装備と Cure Critical Wounds (200G) より先に Phase/CLW/油/CSW を買う
// (buySupplies は CLW を買わず、CCW 30 個が先なので Phase が残りの金で決まっていた。CLW は 20G で 20 HP、CCW は 200G で 60 HP)
const DEEPKIT = RULEFIX.has("deepkit");
const DEEP_KIT_STEPS: [string, number][] = [["phase", 5], ["clw", 5], ["oil", 10], ["phase", 10], ["clw", 10], ["csw", 3]];
// RULEFIX=packroom: 町で持ち物が 18 枠以上なら、未知の薬と巻物を錬金術店へ、魔法の道具を魔法店へ (devices では持つ)、燃料の少ない松明の山を
// 雑貨屋へ (2 山を残す) 渡して枠を空ける。店に渡すと種類も分かる (session 22: 23 枠が埋まって Phase Door が買えず、補給帰還を繰り返した)
const PACKROOM = RULEFIX.has("packroom");
const PACK_ROOM_AT = 18;
// RULEFIX=neutdrink: 毒で HP 半分未満なら、持っている Neutralize Poison か CCW を飲む (neutpois の飲み方だけ、買い物はしない。HP 35% 未満なら CCW を先に)。
// tryunknown で拾った薬が分かるようになり、session 22 の tryunknown の毒死 63 件のうち 19 件は Neutralize Poison か CCW を持っていた
const NEUTDRINK = RULEFIX.has("neutdrink");
function poisonCureSlot(inv: any[], hpPct: number): number | null {
  const find = (name: string) => inv.find((i: any) => i.tval === TVAL.POTION && i.qty > 0 && i.name === name)?.slot ?? null;
  const neut = find("Neutralize Poison"), ccw = find("Cure Critical Wounds");
  return hpPct < 0.35 ? ccw ?? neut : neut ?? ccw;
}
// RULEFIX=digskill: 99 回の自動繰り返しで掘れなかった岩 (同じ地形のまま 400 ゲームターン以上) は、掘削能力が上がるまで同じ種類を掘らない。
// 停滞脱出と孤立脱出は掘れる向きだけを掘る (session 22 の tryunknown: 99 ターン掘って終わる掘削が 705 局中 212 局で 5,197 回、全ゲームターンの 6%。
// 餓死 21 件のうち 19 件で 12-223 回)。C の digging は手に持った武器での値で、4.2 が自動で使う予備の掘削具を含まないので、表ではなく失敗から学ぶ
// 停滞の強制脱出 (最優先) も、隣に敵がいる間はしない (tryunknown: 隣に敵がいる掘削 11,434 回、160 局。死亡 28 件で最後の 6 手に含まれた)
const DIGSKILL = RULEFIX.has("digskill");
// RULEFIX=devices: 魔法の道具 (杖・魔法棒・ロッド)。未知のものは使って識別する (魔法棒/ロッドは隣にいない見えている敵へ、
// 杖は敵が見えず HP 75% 以上の時: 4.2 では回復・治療・感知は満タンでも識別される)。分かったものは、攻撃の魔法棒/ロッドを
// 危険な敵へ近接の前に (油より先に)、回復の杖を HP 半分未満で、Teleportation の杖を緊急時に使う。使い道のないものは落とす
// RULEFIX=devices2: devices に加えて、Wand of Light (4.2.6: 6d8 の光のビーム、光に弱い敵にだけ効く) を起きているオークへ
// (snaga, cave orc, orc tracker/shaman/archer は光に弱い。Lagduf や Grishnákh などのユニークは弱くない)。列に並んだオークを
// まとめて狙う。session 23 の devices は識別した Wand of Light を一度も使わなかった。未知の魔法棒/ロッドはユニークに試さない
// (Haste Monster を Sméagol に撃って殺されていた)
const DEVICES2 = RULEFIX.has("devices2");
// RULEFIX=devicefx (devices を含む): 魔法の道具を名前の表ではなく効果 (ブリッジの keffects → spell-roles の役割) で選ぶ。攻撃は
// 届く道具のうち期待ダメージ × (1 − 失敗率) の最大、逃げる相手 (fight の flee、危険な敵) には先に Teleport Other (AWAY)、
// 無ければ減速・混乱・睡眠・恐怖 (control)、到着時に地図・階段・敵の感知。失敗率 (ブリッジの failPermil) 50% 以上は攻撃・制御に使わない。
// 4.2 では深くなるほど道具が増えるが (Teleport Other、Stone to Mud、Slow/Confuse/Sleep Monster、Mapping、Detect Evil、Curing…)、
// devices は攻撃の魔法棒・回復の杖・Teleportation の杖しか使わなかった
const DEVICEFX = RULEFIX.has("devicefx");
const DEVICES = RULEFIX.has("devices") || DEVICES2 || DEVICEFX;
// RULEFIX=devheal (devices と): 弱い回復の杖 (Cure Light Wounds、Curing: 20 HP 前後) は起きた敵が 5 マス以内にいない時だけ (休む代わり)。
// 戦闘中の HP 半分未満で使うと、緊急回復と逃走 (優先度 2) より先に 1 手を無駄にしていた (深層スタート 2026-10-31: devicefx の
// PH 2.18、杖の回復 132 回)。Healing の杖 (300 HP) は今まで通り
const DEVHEAL = RULEFIX.has("devheal");
// devicefx の部分を外す切り分け用 (2026-10-31: devicefx の深層 PH 2.18 の原因探し)。dfxnotry: 未知の道具を使って識別しない。
// dfxnoarrive: 到着時の感知をしない。dfxnokeep: 未知・使い道のない道具は devices なしと同じく手放す (既知の役に立つ道具だけ持つ)
const DFXNOTRY = RULEFIX.has("dfxnotry"), DFXNOARRIVE = RULEFIX.has("dfxnoarrive"), DFXNOKEEP = RULEFIX.has("dfxnokeep");
const LIGHT_ORC_RE = /^(snaga|cave orc|orc (tracker|shaman|archer))$/;
// RULEFIX=spellfx: 呪文を名前ではなく効果で選ぶ (tools/spell-roles.ts: ブリッジが送る効果の列から役割を決める)。名前の表は angband-ts 用で
// 4.2.6 の多くの呪文に当たらなかった (session 23 の確認: Ranger は Remove Hunger と Herbal Curing を覚えて一度も唱えず、Blackguard は
// 何も唱えなかった)。加えて: 空腹なら食料より先に食事の呪文 (知っていれば食料切れで町へ戻らない)、毒・朦朧・切り傷は薬より先に治す呪文、
// 恐怖で隣に敵がいれば恐怖を治す呪文、強化は状態表示に無い時だけ戦いの前に、敵の感知は到着時と敵が見えない 300 行動ごと、降りたいのに
// 下り階段を知らなければ階段の感知、掘る代わりに壁を消す呪文。逃走の呪文 1 回分の MP は他の詠唱に使わない
// RULEFIX=auditfix: 監査 (docs/finetune-laya-plan.md "Capabilities lost to mismatches") で見つかった取りこぼしをまとめて直す:
// 怯えていて隣に敵 → 殴れない (4.2.6 は "too afraid" で時間を使わず、CMD-GUARD が 30 回ごとに 1 手棒立ちしていた。session 23 の確認で
// 221/707 局、怯えたままの死亡 10) ので、恐怖を治す薬 (効果で探す: Boldness、Heroism、Berserk Strength)・呪文、射撃、投擲、離れる、
// Phase Door の順。見た呪文 (S_KIN など) から召喚持ちを知る (honest-view は形式違いで立てていなかった)。加速の薬を深さを問わず
// 危険な時に (DL10 未満では一度も飲まず、拾った 100 局のうち 45 局が飲まずに死んだ)。名前に Cure の無い強い回復薬 (Healing、
// *Healing*、Life) も効果で探す。使えない領域の本と、害のある既知の薬・巻物・食料 (Poison、Blindness、Sleep、Salt Water、
// Aggravate Monster、Deep Descent など) を持たない (拾ったら落とし、町で店に渡す。本は本屋へ)
const AUDITFIX = RULEFIX.has("auditfix");
let fearActions = 0;
const BOOK_TVAL_OF_REALM: Record<string, number> = { arcane: 30, divine: 31, nature: 32, shadow: 33 };
/** auditfix: この職業が使える本か (呪文の領域から。戦士はどの本も使えない) */
function bookUsable(tval: number): boolean {
  const realms = new Set(((lastKnownState?.player?.spells ?? []) as any[]).map(s => BOOK_TVAL_OF_REALM[s.realm]).filter(t => t !== undefined));
  return realms.has(tval);
}
/** auditfix: 持っていても仕方がない物 (使えない領域の本、害のある既知の薬・巻物・食料) */
function auditJunk(item: any): boolean {
  if (!(AUDITFIX || INVFIX) || !item) return false;
  if (item.tval >= 30 && item.tval <= 33) return !bookUsable(item.tval);
  return [TVAL.POTION, TVAL.SCROLL, TVAL.FOOD].includes(item.tval) && itemHarmful(item);
}
/** auditfix: 名前に Cure の無い強い回復薬 (効果の回復量 100 以上: Healing、*Healing*、Life) */
function strongHealByEffect(item: any): boolean {
  return AUDITFIX && item.tval === TVAL.POTION && !(item.name ?? "").includes("Cure")
    && itemRoles(item).some(e => e.role === "heal" && e.amount >= 100);
}
const SPELLFIGHT = RULEFIX.has("spellfight");
const SPELLFX = RULEFIX.has("spellfx") || SPELLFIGHT;
const fxCasts: Record<string, number> = {}; // 役割ごとの詠唱数 (終了時に表示)
function fxNote(role: string): void { fxCasts[role] = (fxCasts[role] ?? 0) + 1; }
/** spellfx: 役割の呪文で今唱えられる一番良いもの。reserve の MP は残す */
function fxSpell(p: any, role: Role, pick?: (e: RoleEntry) => boolean, reserve = 0): SpellInfo | null {
  if (!p || castBlocked()) return null;
  return (spellsFor(p.spells ?? [], p.level ?? 1, (p.sp ?? 0) - reserve, role, pick)[0]?.spell as SpellInfo | undefined) ?? null;
}
/** spellfx: 覚えていて最大 MP で唱えられる役割の呪文 (今の MP は問わない) */
function fxKnows(p: any, role: Role): SpellInfo | null {
  return (spellsFor(p?.spells ?? [], p?.level ?? 1, p?.maxSp ?? 0, role)[0]?.spell as SpellInfo | undefined) ?? null;
}
/** spellfx: 短距離の逃走呪文 1 回分の MP (他の詠唱はこれを残す)。無ければ 0 */
function fxReserve(p: any): number {
  return fxKnows(p, "escape-short")?.mana ?? 0;
}
/** spellfx: 逃走の呪文。長距離 (Teleport Self など) を望むなら先に、無ければ短距離 */
function fxEscape(p: any, preferLong: boolean): SpellInfo | null {
  return preferLong ? fxSpell(p, "escape-long") ?? fxSpell(p, "escape-short") : fxSpell(p, "escape-short") ?? fxSpell(p, "escape-long");
}
/** 逃走呪文が長距離か (旧ルール: 名前に Teleport) */
function escapeIsLong(s: SpellInfo): boolean {
  return SPELLFX ? rolesOf(s as any).some(e => e.role === "escape-long") : s.name.includes("Teleport");
}
/** 呪文の最初の役割 (危険度ログの ar) */
function spellRoleLabel(s: any): string | undefined {
  const e = s ? rolesOf(s)[0] : undefined;
  return e ? e.role + (e.sub && (e.role === "cure" || e.role === "buff") ? `:${e.sub}` : "") : undefined;
}
const DIG_SPELL_FEATS = new Set([FEAT.RUBBLE, FEAT.MAGMA, FEAT.QUARTZ, FEAT.MAGMA_K, FEAT.QUARTZ_K, FEAT.GRANITE]);
let fxDigCache: { state: any; spell: SpellInfo | null } = { state: null, spell: null };
/** spellfx: 壁を消す呪文が今唱えられるか (経路探索から何度も呼ばれるので状態ごとに覚える) */
function fxDigSpell(): SpellInfo | null {
  if (!SPELLFX || !lastKnownState?.player) return null;
  if (fxDigCache.state !== lastKnownState) {
    const pl = lastKnownState.player;
    fxDigCache = { state: lastKnownState, spell: fxSpell(pl, "dig", undefined, fxReserve(pl)) };
  }
  return fxDigCache.spell;
}
const ATTACK_DEVICES = /^(Magic Missile|Stinking Cloud|Lightning Bolts|Frost Bolts|Fire Bolts|Acid Bolts|Lightning Balls|Cold Balls|Fire Balls|Acid Balls|Dragon's (Flame|Frost|Breath)|Drain Life|Annihilation)$/;
const HEAL_STAVES = /^(Cure Light Wounds|Curing|Healing)$/;
const USELESS_DEVICES = /^(Haste Monsters?|Heal Monster|Clone Monster|Summoning|Darkness|Wonder|Polymorph)$/;
function deviceCharges(it: any): number | null { const m = /\((\d+) charges?\)/.exec(it?.desc ?? ""); return m ? Number(m[1]) : null; }
function deviceUseless(it: any): boolean { return it.aware !== false && USELESS_DEVICES.test(it.name ?? ""); }
const deviceEmpty = new Set<string>(); // 使えなかった (充填なし・充填中) 道具。階を移ると忘れる
function deviceReady(it: any): boolean {
  if (typeof it.charges === "number" && it.charges <= 0) return false;
  if (typeof it.charging === "number" && it.charging >= (it.qty ?? 1)) return false;
  return it.qty > 0 && deviceCharges(it) !== 0 && !deviceEmpty.has(`${it.tval}:${it.name}`) && !/charging|\bempty\b/i.test(it.desc ?? "");
}
/** devicefx: 役割を持つ使える道具 (既知、充填あり、失敗率が maxFail‰ 未満) のうち最良。score は期待値 (既定: 量 × 成功率) */
function devFx(inv: any[], role: Role, pick: (e: RoleEntry) => boolean = () => true, maxFail = 500): { it: any; entry: RoleEntry; ok: number } | null {
  if (!DEVICEFX) return null;
  let best: { it: any; entry: RoleEntry; ok: number } | null = null;
  for (const it of inv) {
    if (![TVAL.WAND, TVAL.STAFF, TVAL.ROD].includes(it.tval) || it.aware === false || !deviceReady(it)) continue;
    const fail = typeof it.failPermil === "number" ? it.failPermil : 300;
    if (fail >= maxFail) continue;
    const e = itemRoles(it).find(r => r.role === role && pick(r));
    if (!e) continue;
    const ok = 1 - fail / 1000;
    if (!best || e.amount * ok > best.entry.amount * best.ok) best = { it, entry: e, ok };
  }
  return best;
}
const devFxUses: Record<string, number> = {};
function devFxNote(k: string): void { devFxUses[k] = (devFxUses[k] ?? 0) + 1; }
/** devicefx: 道具を使うコマンド (魔法棒は aim、ロッドは zap、杖は use)。target があれば狙う */
function devCmd(it: any, target?: { x: number; y: number }): Record<string, unknown> {
  const type = it.tval === TVAL.WAND ? CMD.AIM : it.tval === TVAL.ROD ? CMD.ZAP : CMD.USE;
  return target && it.tval !== TVAL.STAFF ? { type, itemIndex: it.slot, target } : { type, itemIndex: it.slot };
}
let devDetectLevel = -1, devMapLevel = -1;
const dimLights = new Set<string>(); // invfix: 着けて暗かった光源 (二度と着けない)
/** Necromancer (4.2 の UNLIGHT): 光なしで近くが見え、明るい所では呪文の失敗が +25%。負の光 (Lantern of Shadows) はむしろ良い */
function UNLIGHT_CLASS(p: any): boolean { return /Necromancer/.test(p?.class ?? ""); }
function lightKey(it: any): string { return `${it.sval}:${(it.desc ?? it.name ?? "").replace(/\(\d+ turns?\)/, "")}`; } // 燃料の残りは説明から外す
// 未知の杖を試すのは 1 階につき 1 種類 1 回。{tried} (使っても識別されなかった = 敵に効く杖: Sleep/Slow/Confuse Monsters など) は
// 次は見えている敵 (2-6 マス) がいる時に試す
const staffTriedLevel = new Set<string>();
let devicesUsed = 0, devicesTried = 0, lastDeviceAction = -99;
let lightWandUses = 0, lightWandOrcs = 0; // RULEFIX=devices2
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
  if (cmd.type === CMD.READ || (TELESHOP && cmd.type === CMD.USE)) {
    const it = (pl.inventory ?? []).find((i: any) => i.slot === cmd.itemIndex);
    return /Phase Door|Teleport/.test(it?.name ?? "");
  }
  if (cmd.type === CMD.CAST) {
    const s = (pl.spells ?? []).find((x: any) => x.index === cmd.spellIndex);
    if (SPELLFX) return !!s && rolesOf(s).some(e => e.role === "escape-short" || e.role === "escape-long");
    return /Phase Door|Teleport Self|Portal|Dimension Door/.test(s?.name ?? "");
  }
  return false;
}

async function sendCommand(cmd: Record<string, unknown>): Promise<any> {
  sendSeq++;
  // CMD_TRACE=1: each command with its caller (bundle line), to see which branch acts (e.g. in a restored rollout)
  if (process.env.CMD_TRACE) console.log(`  [CMD] ${JSON.stringify(cmd)} @ ${(new Error().stack ?? "").split("\n")[2]?.trim()}`);
  if (noTimeStreak >= 30) {
    console.log(`  [CMD-GUARD] ${noTimeStreak} commands passed no time: holding a turn instead of ${JSON.stringify(cmd)} | msgs: ${((lastKnownState?.messages ?? []) as any[]).slice(-3).map(String).join(" | ")}`);
    cmd = { type: CMD.SEARCH };
    noTimeStreak = 0;
  }
  const turnBefore = lastKnownState?.turn;
  if (TELESHOP && cmd.type === CMD.READ
    && isTeleStaff((lastKnownState?.player?.inventory ?? []).find((i: any) => i.slot === cmd.itemIndex))) {
    cmd = { type: CMD.USE, itemIndex: cmd.itemIndex }; // teleshop: findTeleportScroll が返した杖
  }
  // 混乱中のREAD/CASTは必ず失敗する → RESTに差し替えて無限ループ防止
  if (lastKnownState?.player?.timed?.confused > 0 && (cmd.type === CMD.READ || cmd.type === CMD.CAST)) {
    console.log(`  [CMD-GUARD] confused中のREAD/CASTをRESTに差し替え`);
    cmd = { type: CMD.REST };
  }
  // RULEFIX=spellfx: 掘る代わりに壁を消す呪文 (Shatter Stone、Stone to Mud) を同じ向きへ
  if (SPELLFX && cmd.type === CMD.TUNNEL) {
    const t = tunnelTarget(lastKnownState, cmd.direction as number);
    const dig = t && DIG_SPELL_FEATS.has(t.feat) ? fxDigSpell() : null;
    if (dig) { spellsUsed++; fxNote("dig"); cmd = { type: CMD.CAST, spellIndex: dig.index, direction: cmd.direction }; }
  }
  const escapeCmd = LEAVE && isEscapeCommand(cmd); // RULEFIX=leave: この階の逃走回数に数える (時間が進んだら)
  const digAt = DIGSKILL && cmd.type === CMD.TUNNEL ? tunnelTarget(lastKnownState, cmd.direction as number) : null;
  if (cmdDebug || ++commandsSent >= CMD_DEBUG_AFTER) console.log(`    >> CMD: ${JSON.stringify(cmd)}`);
  dangerLogger?.noteCommand(cmd.type as number, actionRole(cmd));
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
    if (digAt) noteTunnel(digAt, turnBefore, lastKnownState);
    if (typeof turnBefore === "number" && lastKnownState?.turn === turnBefore) {
      noTimeStreak++;
      // NOTIME_DEBUG=1: 時間の進まない移動の原因を表示 (目標マスと直近のメッセージ)
      if (process.env.NOTIME_DEBUG === "1" && noTimeStreak === 3 && cmd.type === CMD.WALK) {
        const pl = lastKnownState.player ?? {}, [dx, dy] = DIR_DXY[cmd.direction as number] ?? [0, 0];
        const t = (lastKnownState.map?.tiles ?? []).find((q: any) => q.x === pl.x + dx && q.y === pl.y + dy);
        const mon = (lastKnownState.monsters ?? []).concat(lastKnownState.rememberedMonsters ?? []).find((m: any) => m.x === pl.x + dx && m.y === pl.y + dy);
        console.log(`  [NOTIME] walk ${cmd.direction} from (${pl.x},${pl.y}): tile ${JSON.stringify(t)} monster ${mon ? `${mon.name} vis=${mon.visible} dist=${mon.distance} inView=${(lastKnownState.monsters ?? []).includes(mon)}` : "-"} afraid=${pl.timed?.afraid} msgs ${JSON.stringify((lastKnownState.messages ?? []).slice(-4))}`);
      }
      if (cmd.type === CMD.READ || cmd.type === CMD.CAST) noTimeUntil[cmd.type as number] = sendSeq + 20;
      if (FEARFIX && cmd.type === CMD.WALK && /too afraid to attack/.test(String((lastKnownState.messages ?? []).slice(-1)[0] ?? ""))) {
        fearMsgSeq = sendSeq;
        fearPerm = (lastKnownState.player?.timed?.afraid ?? 0) === 0;
      }
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

/** spellfight: 近接 1 ターンの期待ダメージ (表示されている攻撃回数、武器のダイス、ダメージ修正。命中は 75% と置く) */
function meleeExpected(p: any): number {
  const w = (p.equipment ?? []).find((e: any) => WEAPON_TVALS.has(e.tval));
  const per = (w ? (w.dd ?? 1) * ((w.ds ?? 4) + 1) / 2 + (w.toD ?? 0) : 1.5) + (p.toD ?? 0);
  return Math.max(1, p.numBlows ?? 1) * Math.max(1, per) * 0.75;
}
/** spellfight: 呪文 1 回の期待値 (量 × 成功率) */
function fxExpected(s: SpellInfo, role: Role): number {
  const e = rolesOf(s as any).find(r => r.role === role);
  return e ? e.amount * (1 - s.failRate / 100) : 0;
}

/** 危険度ログの ar: 詠唱なら呪文の役割、使う道具なら道具の役割 */
function actionRole(cmd: Record<string, unknown>): string | undefined {
  const pl = lastKnownState?.player;
  if (!pl) return undefined;
  if (cmd.type === CMD.CAST) return spellRoleLabel((pl.spells ?? []).find((x: any) => x.index === cmd.spellIndex));
  if (cmd.type === CMD.QUAFF || cmd.type === CMD.READ || cmd.type === CMD.EAT) {
    const e = itemRoles((pl.inventory ?? []).find((i: any) => i.slot === cmd.itemIndex))[0];
    return e ? e.role + (e.sub ? `:${e.sub}` : "") : undefined;
  }
  return undefined;
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
let llmCallCount = 0, llmFallbacks = 0;
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
      llmFallbacks++;
      console.log(`  [LLM systemone] HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
      return null;
    }
    const data = (await res.json()) as any;
    const answers = data?.answers ?? null;
    // JEV_LEDGER=<path> (hosted Jev): every call's tokens and estimated cost, for the phase's spend cap
    if (process.env.JEV_LEDGER) {
      const tok = Number(data?.usage?.input_tokens ?? 0) || Math.ceil(context.length / 3);
      try {
        (await import("node:fs")).appendFileSync(process.env.JEV_LEDGER, JSON.stringify({ ts: Date.now() / 1000, model: SYSTEMONE_MODEL,
          served: data?.model ?? null, input_tokens: tok, usd: tok * 0.042e-6, src: "busho", seed: GAME_SEED }) + "\n");
      } catch { /* the ledger is best effort; the driver also caps by count */ }
    }
    if (!answers) llmFallbacks++;
    for (const [id, a] of Object.entries<any>(answers ?? {})) {
      const summary = a.type === "noul" ? `p(yes)=${a.noul}` : `${a.choice} conf=${a.confidence}`;
      console.log(`  [LLM systemone] Q: ${questions[id]?.instructions.slice(0, 55)} → ${summary} (${ms}ms)`);
    }
    return answers;
  } catch (e) {
    llmTotalMs += Date.now() - start;
    llmFallbacks++;
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
const ROLLOUT_STICKY = process.env.ROLLOUT_STICKY === "1";
const DECISION_LOG_TYPES = new Set((process.env.DECISION_LOG_TYPES ?? "").split(",").map((t) => t.trim()).filter(Boolean));
// ROLLOUT_FULL_RULES=1: 長いロールアウト (戦略の判断) では、普段のプレイの規則 (worwait、restock、tryunknown、gearid、invfix、
// 食料切れの帰還など) をロールアウト中も使う。既定ではロールアウト中は止める (短いロールアウトの副作用を避けるため)。
// 記録・セーブポイント・開始直後の買い物は常に止める
const RO_GATE = ROLLOUT && process.env.ROLLOUT_FULL_RULES !== "1";
// ROLLOUT_FORCE=descend:stay を戦略として測る: 強制した「留まる」は、この行動数のあいだ降下しない (無ければ次の行動で
// また聞かれて 1 手遅れるだけ。降下の見送りは 1 深度 2 回まで)。通常のプレイには関係しない
const ROLLOUT_STAY_ACTIONS = Number(process.env.ROLLOUT_STAY_ACTIONS ?? "500");
let descentHoldUntil = -1;
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
  blind?: BlindCtx;
}

function buildRequest(type: DecisionType, c: DecideCtx): DecisionRequest {
  switch (type) {
    case "fight": return fightDecision(c.state, c.monster);
    case "tactic": return tacticDecision(c.state, c.enemies ?? [], c.hpPct ?? 0);
    case "recall": return recallDecision(c.state);
    case "descend": return descendDecision(c.state);
    case "explore": return exploreDecision(c.state, c.kills ?? 0, c.turns ?? 0);
    case "equip": return equipDecision(c.state, c.current, c.candidate);
    case "blind": return blindDecision(c.state, c.blind!);
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

// RULEFIX=lookahead (DECISION_LOG=1 と): 危険な判断 (LOOKAHEAD_TYPES、DL1+、run.ts の danger ≥ LOOKAHEAD_MIN_DANGER) では、
// その場のスナップショットから各選択肢を K 回ずつルールで先読みし (tools/rollout/run.ts: C の新しいプロセスで再開、選択肢間で同じ
// 乱数)、平均効用 (v2) が最大の選択肢を取る (同点ならルール)。判断を完全な先読みに替えたら死亡が減るかの上限の確認 (2026-10-31)。
// 結果は ${DECISION_LOG_DIR}/lookahead.jsonl (学習用のラベル)。先読みに失敗したらルール
const LOOKAHEAD = RULEFIX.has("lookahead");
const LOOKAHEAD_TYPES = new Set((process.env.LOOKAHEAD_TYPES ?? "fight,tactic").split(",").filter(Boolean));
const LOOKAHEAD_MIN_DANGER = Number(process.env.LOOKAHEAD_MIN_DANGER ?? "2");
const LOOKAHEAD_PORTS = (process.env.LOOKAHEAD_PORTS ?? "").split(",").filter(Boolean); // この局の先読みサーバのポート
const LOOKAHEAD_K = process.env.LOOKAHEAD_K ?? "8", LOOKAHEAD_K_MIN = process.env.LOOKAHEAD_K_MIN ?? "4";
// ルールの選択を覆すのは、最良の平均効用がルールの選択より LOOKAHEAD_MARGIN 以上高い時だけ (8 本では 0.005 の差は雑音。
// 死亡 1 本は平均を約 0.2 動かす)
const LOOKAHEAD_MARGIN = Number(process.env.LOOKAHEAD_MARGIN ?? "0.05");
const lookStats = { asked: 0, changed: 0, failed: 0, ms: 0, by: {} as Record<string, number> };
let lookPlayerCmd: string | null = null;
/** run.ts の danger() とほぼ同じ (状態の文から: HP の減り、対象/隣の敵の格上度、ユニーク、速さ、ブレス/呪文)。ただし今の状態の文は
 *  呪文を "seen casting:" と書く (run.ts の BREATH:|SPELL: は古い形式で当たらず、ironfist priest が 1 未満だった) */
function lookDanger(type: string, st: string, cl: number): number {
  const hp = /\nHP:(\d+)\/(\d+)/.exec(st);
  const hpFrac = hp && Number(hp[2]) > 0 ? Number(hp[1]) / Number(hp[2]) : 1;
  let d = (1 - hpFrac) * 5;
  const m = (type === "fight" ? /Target monster: [^\n]*/.exec(st) : /Adjacent enemies: [^\n]*/.exec(st))?.[0] ?? "";
  for (const lv of m.matchAll(/Lv(\d+)/g)) d += Math.max(-3, Number(lv[1]) - cl);
  if (m.includes("UNIQUE")) d += 5;
  for (const sp of m.matchAll(/spd(\d+)/g)) if (Number(sp[1]) >= 120) d += 3;
  if (/BREATH:|SPELL:|seen casting:/.test(m)) d += 2;
  return d;
}
/** 先読みのプレイヤー: 1 局に 1 回 esbuild で束ねる (起動 0.3 s → 0.09 s)。失敗したら tsx */
async function lookPlayer(): Promise<string> {
  if (lookPlayerCmd) return lookPlayerCmd;
  const { spawnSync } = await import("node:child_process");
  const out = `${DECISION_LOG_DIR}/la-player.mjs`;
  const r = spawnSync("node_modules/.bin/esbuild", ["tools/busho-player.ts", "--bundle", "--platform=node", "--format=esm",
    `--outfile=${out}`, "--log-level=error", "--banner:js=import { createRequire } from 'module'; const require = createRequire(import.meta.url);"]);
  lookPlayerCmd = r.status === 0 ? `node ${out}` : "node_modules/.bin/tsx tools/busho-player.ts";
  if (r.status !== 0) console.log(`  [LOOKAHEAD] esbuild failed, using tsx: ${String(r.stderr).slice(0, 200)}`);
  return lookPlayerCmd;
}
async function lookahead(rec: any): Promise<string | null> {
  if (!LOOKAHEAD_PORTS.length) return null;
  const fs = await import("node:fs");
  const { spawn } = await import("node:child_process");
  const t0 = Date.now();
  lookStats.asked++;
  const dir = DECISION_LOG_DIR, tin = `${dir}/la-in.jsonl`, tout = `${dir}/la-out.jsonl`, tunl = `${dir}/la-out.unl.jsonl`;
  for (const f of [tout, tunl, tout.replace(/\.jsonl$/, ".stats.json")]) fs.rmSync(f, { force: true });
  fs.writeFileSync(tin, JSON.stringify(rec) + "\n");
  const cmd = await lookPlayer();
  const args = ["tools/rollout/run.ts", "--decisions", tin, "--dir", dir, "--out", tout, "--unlabelled", tunl,
    "--servers", LOOKAHEAD_PORTS.map(pt => `http://127.0.0.1:${pt}`).join(","), "--k", LOOKAHEAD_K, "--k-min", LOOKAHEAD_K_MIN,
    "--utility", "v2", "--player-cmd", cmd, "--c-tmp", `${dir}/la-c`, "--gamedata", "packages/@angband/core/gamedata"];
  const code = await new Promise<number | null>((resolve) => {
    const ch = spawn("node_modules/.bin/tsx", args, { env: { ...process.env, BUSHO_TMP: `${dir}/la-c` }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ch.stderr!.on("data", (d) => { err = (err + d).slice(-2000); });
    ch.on("close", (c) => { if (c !== 0) console.log(`  [LOOKAHEAD] run.ts exit ${c}: ${err.slice(-300)}`); resolve(c); });
  });
  lookStats.ms += Date.now() - t0;
  const line = code === 0 && fs.existsSync(tout) ? fs.readFileSync(tout, "utf-8").split("\n").find(l => l.trim()) : undefined;
  if (!line) { lookStats.failed++; return null; }
  const lab = JSON.parse(line);
  const u: Record<string, number> = lab.meta?.u_mean ?? {};
  const top = Math.max(...Object.values(u));
  const best = Object.keys(u).filter(o => u[o]! >= top - 1e-9);
  const ruleU = u[rec.rules_choice] ?? -Infinity;
  const choice = best.includes(rec.rules_choice) || top - ruleU < LOOKAHEAD_MARGIN ? rec.rules_choice : best[0] ?? null;
  lab.meta.la_choice = choice;
  fs.appendFileSync(`${dir}/lookahead.jsonl`, JSON.stringify(lab) + "\n");
  if (choice && choice !== rec.rules_choice) {
    lookStats.changed++;
    const k = `${rec.decision_type}:${rec.rules_choice}>${choice}`;
    lookStats.by[k] = (lookStats.by[k] ?? 0) + 1;
    console.log(`  [LOOKAHEAD] ${rec.decision_type} DL${rec.depth}: ${rec.rules_choice} → ${choice} u=${JSON.stringify(u)} (${Date.now() - t0}ms)`);
    return choice;
  }
  return null; // ルールと同じ: null を返す (fight の答えは個体の計画 fightPlan になり、その後の扱いが変わるため)
}

// 返り値はオプション名。null ならルールに任せる。
async function decide(type: DecisionType, c: DecideCtx): Promise<string | null> {
  if (ROLLOUT) {
    if (!rolloutFired && type === ROLLOUT_TYPE && rolloutActions <= ROLLOUT_MAX_WAIT) {
      rolloutFired = true;
      console.log(`  [ROLLOUT] ${type} 強制: ${ROLLOUT_OPTION} (rules=${c.rules})`);
      return ROLLOUT_OPTION!;
    }
    // ROLLOUT_STICKY=1: 強制した選択肢を、その後の同じ型の判断でも毎回選ぶ (方策としての価値。1 回だけ覆す値は
    // ルールが次にまた元の選択をするので小さく出る: session 13 の罠、docs/plan-2026-11-09.md の M1)
    if (ROLLOUT_STICKY && rolloutFired && type === ROLLOUT_TYPE) return ROLLOUT_OPTION!;
    return null;
  }
  // DECISION_LOG_TYPES=blind: この型だけ記録する (スナップショットの量を抑える。他の型はルールのまま、記録なし)
  if (DECISION_LOG && DECISION_LOG_TYPES.size > 0 && !DECISION_LOG_TYPES.has(type)) return null;
  if (DECISION_LOG) {
    const req = buildRequest(type, c);
    if (LOOKAHEAD && LOOKAHEAD_TYPES.has(type) && (c.state?.depth ?? 0) >= 1
        && lookDanger(type, req.state, c.state?.player?.level ?? 1) >= LOOKAHEAD_MIN_DANGER) {
      const rec = await logDecision(type, c, req, { acted: "lookahead" });
      return rec?.snapshot ? lookahead(rec) : null;
    }
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
  if (snapshotMissing || process.env.DECISION_SNAPSHOT === "0") return null; // DECISION_SNAPSHOT=0: log without snapshots (determinism tests)
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

const levelCtx = { kills: 0, turns: 0 }; // the main loop's per-level counters, for logDecision's level_ctx
async function logDecision(type: DecisionType, c: DecideCtx, req: DecisionRequest, extra: Record<string, unknown> = {}): Promise<any | null> {
  try {
    const st = c.state;
    if (!decisionGameId) {
      decisionGameId = `${GAME_SEED ?? "noseed"}-${st.player.race}-${st.player.class}-${GAME_START_TS}`
        .toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
    }
    const snapshot = await takeSnapshot(decisionGameId, st.turn, type);
    const rec = {
      format_version: DECISION_ROLES ? DECISION_FORMAT_VERSION_ROLES : PLAYER_VIEW ? DECISION_FORMAT_VERSION_PLAYER : DECISION_FORMAT_VERSION,
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
      // the per-level counters a rollout needs to restart from this point (busho keeps them in-process)
      ...(type === "descend" || type === "explore" ? { level_ctx: { kills: levelCtx.kills, turns: levelCtx.turns } } : {}),
      ...extra,
    };
    const fs = await import("node:fs");
    fs.mkdirSync(DECISION_LOG_DIR, { recursive: true });
    fs.appendFileSync(`${DECISION_LOG_DIR}/decisions.jsonl`, JSON.stringify(rec) + "\n");
    decisionLogCounts[type] = (decisionLogCounts[type] ?? 0) + 1;
    return rec;
  } catch (e) {
    console.log(`  [DECISION_LOG] error: ${(e as Error).message}`);
    return null;
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
      : inv.filter(i => kinds[kind]!(i) && i.qty > 0 && torchCounts(i)).reduce((a, i) => a + i.qty, 0);
  const bought: Record<string, number> = { food: 0, torch: 0, oil: 0, phase: 0, digger: 0, clw: 0, csw: 0, ammo: 0, neut: 0 };
  let spent = 0, n = 0;
  for (const [kind, target0] of steps) {
    const target = kind === "torch" ? torchTarget(target0) : target0; // invfix: ランタンなら松明は 1 本
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
const devCtl = new Map<string, number>(); // devicefx: 個体ごとの Teleport Other・制御の道具の使用回数
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
    .filter((item: any) => item.tval === TVAL.POTION && (item.name.includes("Cure") || strongHealByEffect(item)) && item.qty > 0)
    .sort((a: any, b: any) => a.sval - b.sval);
  return potions.length > 0 ? potions[0].slot : null;
}

function findStrongHealingPotion(inventory: any[]): number | null {
  const potions = inventory
    .filter((item: any) => item.tval === TVAL.POTION && (item.name.includes("Cure") || strongHealByEffect(item)) && item.qty > 0)
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

// RULEFIX=devices2: 自分から (tx,ty) を通って壁に当たるまでの直線 (ビームが通るマス。hasLOS と同じ線で近似)
function beamCells(tiles: any[], px: number, py: number, tx: number, ty: number, range: number): Set<string> {
  const feats = new Map<number, number>();
  for (const t of tiles) feats.set(t.y * 4096 + t.x, t.feat);
  const out = new Set<string>();
  const dx = Math.abs(tx - px), dy = Math.abs(ty - py);
  const sx = px < tx ? 1 : -1, sy = py < ty ? 1 : -1;
  let err = dx - dy, x = px, y = py;
  for (let i = 0; i < range; i++) {
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    out.add(`${x},${y}`); // 止まるマスも含める (扉や未知のマスに立つ敵)
    const f = feats.get(y * 4096 + x);
    if (f === undefined || !PASSABLE_FEATS.has(f) || f === FEAT.PASS_RUBBLE) break;
  }
  return out;
}

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
  // teleshop: 巻物がない・読めない時は Teleportation の杖 (sendCommand が READ を USE に替える)
  const staff = TELESHOP ? inventory.find((i: any) => isTeleStaff(i) && deviceReady(i))?.slot ?? null : null;
  const tm = lastKnownState?.player?.timed ?? {};
  if (staff !== null && ((tm.confused ?? 0) > 0 || (tm.blind ?? 0) > 0)) return staff;
  if (readBlocked()) return staff; // 読めない (暗闇/盲目): 読もうとし続けない
  const scroll = inventory.find((item: any) =>
    item.tval === TVAL.SCROLL && item.name.includes("Teleportation") && item.qty > 0
  );
  return scroll ? scroll.slot : staff;
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
  // RULEFIX=spellfx: 名前の表の代わりに役割で (表ごとに対応する役割)
  if (SPELLFX && (names === ESCAPE_SPELLS || names === DETECT_SPELLS || names === ATTACK_SPELLS)) {
    const pl = { spells, level: playerLevel, sp };
    return names === ESCAPE_SPELLS ? fxEscape(pl, false) : fxSpell(pl, names === DETECT_SPELLS ? "detect-monsters" : "attack-target");
  }
  // 学習済み・レベル足りる・マナ足りる・失敗率80%未満のスペルを探す
  return spells.find(s =>
    s.learned && s.level <= playerLevel && s.mana <= sp && s.failRate < 80 &&
    names.some(n => s.name.includes(n))
  ) ?? null;
}

function findBestHealSpell(spells: SpellInfo[], playerLevel: number, sp: number, emergency: boolean): SpellInfo | null {
  if (SPELLFX) { // 緊急時は回復量最大、通常時は MP 最小
    const l = spellsFor(spells as any, playerLevel, sp, "heal");
    if (!emergency) l.sort((a, b) => a.spell.mana - b.spell.mana);
    return (l[0]?.spell as SpellInfo | undefined) ?? null;
  }
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
  if (SPELLFX) { // 役割の順: 逃走、攻撃、治療、食事、回復、敵の感知、強化、...
    const can = spells.filter(s => !s.learned && s.level <= playerLevel);
    for (const role of FX_STUDY_ORDER) {
      const c = can.find(s => rolesOf(s as any).some(e => e.role === role));
      if (c) return c;
    }
    return can[0] ?? null;
  }
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

const FX_STUDY_ORDER: Role[] = ["escape-short", "attack-target", "cure", "nourish", "heal", "detect-monsters", "buff",
  "escape-long", "attack-melee", "dig", "detect-stairs", "control", "attack-area", "detect-objects", "light"];
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
    if (feat === FEAT.CLOSED_DOOR || feat === FEAT.SECRET) return digFutile(feat) ? 9999 : 2;
    if (feat === FEAT.RUBBLE) return digFutile(feat) ? 9999 : 3;
    if (!canDigFeat(feat) || digFutile(feat)) return 9999; // 掘削具なし or 技能不足: 岩盤は掘れない (digskill: 掘れなかった種類も)
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
let lastDetectAt = 0; // RULEFIX=spellfx: 最後に敵の感知を唱えた行動
let stairDetectLevel = -1, stairDetectTries = 0; // RULEFIX=spellfx: 階段の感知 (階ごと 3 回まで)
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
  if (auditJunk(item)) return false; // RULEFIX=auditfix: 使えない本、害のある既知の消耗品
  // 消耗品は常に保持
  // RULEFIX=tryunknown: 未知の巻物は町で店に渡して識別する (読むと Deep Descent・召喚・呪いの危険。持っていても使わない)
  if (TRYUNKNOWN && item.tval === TVAL.SCROLL && item.aware === false) return false;
  if ([TVAL.SCROLL, TVAL.POTION, TVAL.FOOD, TVAL.FLASK].includes(item.tval)) return true; // 油は投擲武器
  // RULEFIX=devices: 魔法の道具は持つ (使い道のないと分かったものはダンジョンで落とす)
  if (DEVICES && [TVAL.STAFF, TVAL.WAND, TVAL.ROD].includes(item.tval)) return !(DFXNOKEEP && (item.aware === false || deviceUseless(item)));
  if (TELESHOP && isTeleStaff(item)) return true;
  // 魔法書は保持
  if ([30, 31, 32, 33, 34].includes(item.tval)) return true;
  // 掘削具は保持 (stuck 脱出用)
  if (item.tval === TVAL.DIGGING) return true;
  // 予備の松明は保持 (vanilla の松明は燃え尽きる。燃え尽きたものは売る)
  if (item.tval === TVAL.LIGHT && /Torch/i.test(item.name ?? "") && (item.fuel === undefined || item.fuel > 0)) return true;
  if (INVFIX && item.tval === TVAL.LIGHT && /Lantern/i.test(item.name ?? "")) return true; // invfix: 油で給油できる光源
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

    // RULEFIX=packroom: 持ち物が多い時だけ、燃料の多い 2 山以外の松明と未知の薬/巻物/魔法の道具も渡す
    const crowded = PACKROOM && inv.length >= PACK_ROOM_AT;
    const torchKeep = new Set(inv.filter((i: any) => i.tval === TVAL.LIGHT && /Torch/i.test(i.name ?? ""))
      .sort((a: any, b: any) => (b.fuel ?? 0) - (a.fuel ?? 0)).slice(0, 2).map((i: any) => i.slot));
    const invRank = (item: any) => INVFIX ? shedRank(item, equip2) : null;
    const tight = INVFIX && typeof freshState.player.packFree === "number" && freshState.player.packFree < 3;
    const roomJunk = (item: any) => (invRank(item) !== null && (invRank(item)! <= 4 || tight)) || crowded && (
      ([TVAL.POTION, TVAL.SCROLL].includes(item.tval) && item.aware === false)
      || (!DEVICES && [TVAL.STAFF, TVAL.WAND, TVAL.ROD].includes(item.tval))
      || (item.tval === TVAL.LIGHT && /Torch/i.test(item.name ?? "") && !torchKeep.has(item.slot)));

    // 売却候補を探す (逆順: 後ろから売ることでインデックスがずれない)
    let soldThisRound = false;
    for (let i = inv.length - 1; i >= 0; i--) {
      const item = inv[i];
      if (!item || item.qty <= 0) continue;
      if (shouldKeepItem(item, equip2) && !roomJunk(item)) continue;

      const home = HOME && homeWorthy(item) ? homeStore(freshState) : undefined;
      const stores = home ? [home.type, ...(SELL_STORE_FOR_TVAL[item.tval] ?? [0])] // home: 家に預ける (家が一杯なら売る)
        : roomJunk(item) && [TVAL.STAFF, TVAL.WAND, TVAL.ROD].includes(item.tval) ? [5]
        : (AUDITFIX || INVFIX) && item.tval >= 30 && item.tval <= 33 ? [3] // RULEFIX=auditfix: 本は本屋 (雑貨屋は本を買わない)
        : SELL_STORE_FOR_TVAL[item.tval] ?? [0]; // default: General
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
            console.log(home && storeType === home.type ? `  [家に預ける] ${item.desc ?? item.name}` : `  [売却] ${item.name} → store${storeType} (${result.price}G)`);
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

/** home: 家の装備で今の装備 (指輪は弱い方) より評価の高い物を引き出して着ける。外した物は次の sellJunk で預ける */
async function retrieveHomeGear(): Promise<number> {
  let n = 0;
  for (let k = 0; k < 4; k++) {
    const st = await getState();
    const home = homeStore(st);
    if (!home || (typeof st.player.packFree === "number" && st.player.packFree <= 0)) break;
    const equip = st.player.equipment ?? [];
    let best: { it: any; rival: any; gain: number } | null = null;
    for (const it of home.stock ?? []) {
      if (!EQUIPPABLE_TVALS.has(it.tval) || it.tval === TVAL.LIGHT || it.tval === TVAL.DIGGING || gearCursed(it)) continue;
      const rival = equipRival(equip, it.tval);
      if (it.tval === TVAL.BOW && rival && launcherFamily(it.name ?? "") !== launcherFamily(rival.name ?? "")) continue;
      const pw = itemPower(it), gain = pw - (rival ? itemPower(rival) : 0);
      if (gain > 0 && (rival || pw > 0) && (!best || gain > best.gain)) best = { it, rival, gain };
    }
    if (!best) break;
    const res = await fetch(`${API}/buy`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeType: home.type, itemIndex: best.it.index }) }).then(r => r.json()).catch(() => null);
    if (!res?.success) break;
    const got = ((await getState()).player.inventory as any[]).find((i: any) => i.tval === best!.it.tval && i.sval === best!.it.sval);
    if (!got) break;
    console.log(`  [家から引き出す] ${best.it.desc ?? best.it.name} (評価 +${Math.round(best.gain)}${best.rival ? `、${best.rival.name}の代わり` : ""})`);
    await sendCommand(equipCmd(got, best.rival));
    n++;
  }
  return n;
}

// ── RULEFIX=gearset: 装備一式で選ぶ ──
// 1 品ずつ部位ごとに比べる代わりに、着る物の組み合わせ全体を評価する。各組み合わせの能力値はゲーム自身の計算で求める (ブリッジの /whatif:
// calc_bonuses を既知のルーンだけで。攻撃回数は武器の重さと STR/DEX で変わり、STR の指輪で武器の回数が変わる)。性質と耐性は何品で
// 持っても 1 回だけ数え、深いほど高い。候補は着ている物、荷物の装備 (未知のルーンのある物は gearid の試着に任せる)、町では家の装備。
// 1 部位の交換と、2 部位の同時交換 (Speed のブーツ + Free Action の指輪のように、片方だけでは損な組み合わせ) を試して最良を着る。
// 光源・射撃武器・掘削具は対象外 (それぞれの規則がある)
const GEARSET = RULEFIX.has("gearset");
const GEAR_SLOTS: [number[], number[]][] = [ // [tval, 装備欄] (4.2 の人型: 0 武器 2-3 指輪 4 首 6 胴 7 外套 8 盾 9 頭 10 手 11 足)
  [[TVAL.SWORD, TVAL.POLEARM, TVAL.HAFTED], [0]], [[TVAL.RING], [2, 3]], [[TVAL.AMULET], [4]],
  [[TVAL.SOFT_ARMOR, TVAL.HARD_ARMOR, TVAL.DRAG_ARMOR], [6]], [[TVAL.CLOAK], [7]], [[TVAL.SHIELD], [8]],
  [[TVAL.HELM, TVAL.CROWN], [9]], [[TVAL.GLOVES], [10]], [[TVAL.BOOTS], [11]],
];
function gearSlotsOf(tval: number): number[] { return GEAR_SLOTS.find(([t]) => t.includes(tval))?.[1] ?? []; }
/** 性質の価値 (OF 番号 → 深さ d での点)。何品で持っても 1 回 */
function abilityValue(flag: number, d: number): number {
  switch (flag) {
    case OF.FREE_ACT: return 15 + 3 * d;
    case OF.SEE_INVIS: return 12 + 2 * d;
    case OF.TELEPATHY: return 20 + 2 * d;
    case OF.HOLD_LIFE: return 5 + d;
    case OF.PROT_CONF: case OF.PROT_BLIND: return 6 + 0.5 * d;
    case OF.PROT_FEAR: return MELEE_CLASS() ? 8 : 3;
    case OF.PROT_STUN: return 4 + 0.5 * d;
    case OF.REGEN: return 8;
    case OF.SLOW_DIGEST: case OF.FEATHER: return 3;
    default: return flag >= OF.SUST_STR && flag <= OF.SUST_CON ? 2 + 0.2 * d : 0;
  }
}
function MELEE_CLASS(): boolean { return /Warrior|Blackguard|Paladin/.test(lastKnownState?.player?.class ?? ""); }
/** 耐性の価値 (要素 → 深さ d での点。免疫は 2 倍、弱点は負) */
function resistValue(elem: number, level: number, d: number): number {
  const v = elem <= 3 ? 4 + 0.6 * d : elem === 4 ? 2 + 0.8 * d : elem <= 6 ? 2 + 0.3 * d : elem <= 12 ? 1 + 0.4 * d : 0;
  return level >= 3 ? 2 * v : level > 0 ? v : level < 0 ? -v : 0;
}
/** 一式の評価: 近接の 1 ターンの与ダメージ、命中、AC、速度、光、隠密、性質、耐性 */
function gearsetValue(w: any, weapon: any | undefined, d: number): number {
  const wv = weapon ? gearView(weapon) : undefined;
  const dice = wv ? (wv.dd ?? 1) * ((wv.ds ?? 1) + 1) / 2 : 1;
  const dmg = (w.blows / 100) * Math.max(0, dice + (wv?.toD ?? 0) + w.toD);
  const casterish = /Mage|Necromancer/.test(lastKnownState?.player?.class ?? "");
  let v = dmg * (casterish ? 1 : 2) + (w.toH + (wv?.toH ?? 0)) * 0.5 + w.ac + (w.speed - 110) * 15 + w.light * 4 + w.stealth;
  if (w.heavyWield) v -= 30;
  if (w.cumberArmor && (lastKnownState?.player?.maxSp ?? 0) > 0) v -= 25; // 鎧の重さで MP が減る (4.2 に手袋の罰は無い)
  for (const f of w.flags ?? []) v += abilityValue(f, d);
  for (const [e, lv] of w.res ?? []) v += resistValue(e, lv, d);
  return v;
}
async function whatIf(set: string): Promise<any | null> {
  try {
    const r = await fetch(`${API}/whatif`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ set }) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
type GearMove = { slot: number; src: "p" | "h"; item: any };
/** 今の一式より良い交換 (1 部位、または 2 部位の同時交換) を探す。無ければ null */
async function gearsetPlan(st: any, withHome: boolean): Promise<{ moves: GearMove[]; gain: number; base: number } | null> {
  const p = st.player, d = p.maxDepth ?? st.depth ?? 0;
  const equip: any[] = p.equipment ?? [];
  const worn = (slot: number) => equip.find((e: any) => e.slot === slot);
  const fits = (it: any) => gearSlotsOf(it.tval).length > 0 && !gearCursed(it) && !gearUnknown(it) && itemPower(it) > -50;
  const cands: { src: "p" | "h"; item: any }[] = [
    ...((p.inventory ?? []) as any[]).filter(fits).map(item => ({ src: "p" as const, item })),
    ...(withHome ? ((homeStore(st)?.stock ?? []) as any[]).filter(fits).map(item => ({ src: "h" as const, item: { ...item, slot: item.index } })) : []),
  ];
  if (cands.length === 0) return null;
  const val = async (moves: GearMove[]) => {
    const w = await whatIf(moves.map(m => `${m.slot}:${m.src}${m.item.slot}`).join(","));
    if (!w) return null;
    const wm = moves.find(m => m.slot === 0);
    return gearsetValue(w, wm ? wm.item : worn(0), d);
  };
  const base = await val([]);
  if (base === null) return null;
  const singles: { m: GearMove; v: number }[] = [];
  for (const c of cands) for (const slot of gearSlotsOf(c.item.tval)) {
    if (c.item.tval === TVAL.RING && slot === 3 && !worn(2)) continue; // 空いた指輪欄は 1 つ試せば足りる
    const m = { slot, src: c.src, item: c.item };
    const v = await val([m]);
    if (v !== null) singles.push({ m, v });
  }
  let best: { moves: GearMove[]; v: number } = { moves: [], v: base };
  for (const s1 of singles) if (s1.v > best.v) best = { moves: [s1.m], v: s1.v };
  const top = [...singles].sort((a, b) => b.v - a.v).slice(0, 8);
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
    const a = top[i]!.m, b = top[j]!.m;
    if (a.slot === b.slot || (a.src === b.src && a.item.slot === b.item.slot)) continue;
    const v = await val([a, b]);
    if (v !== null && v > best.v) best = { moves: [a, b], v };
  }
  const gain = best.v - base;
  return best.moves.length && gain >= Math.max(3, 0.02 * Math.abs(base)) ? { moves: best.moves, gain, base } : null; // 小さな差では替えない
}
let gearsetSig = "", gearsetAt = -99;
/** gearset: 計画を実行する (家の品は先に引き出す)。替えたら true */
async function gearsetApply(withHome: boolean): Promise<boolean> {
  const st = await getState();
  const plan = await gearsetPlan(st, withHome);
  if (!plan) return false;
  const home = homeStore(st);
  addLesson(st.turn, st.depth, "装備一式", plan.moves.map(m => `${m.item.desc ?? m.item.name}${m.src === "h" ? " (家から)" : ""} → 欄${m.slot}`).join("、")
    + ` (評価 ${Math.round(plan.base)} → ${Math.round(plan.base + plan.gain)})`);
  for (const m of plan.moves) {
    let item = m.item;
    if (m.src === "h") {
      if (!home) return false;
      const res = await fetch(`${API}/buy`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeType: home.type, itemIndex: m.item.index }) }).then(r => r.json()).catch(() => null);
      if (!res?.success) return false;
      item = ((await getState()).player.inventory as any[]).find((i: any) => i.tval === m.item.tval && i.sval === m.item.sval && (i.desc ?? i.name) === (m.item.desc ?? m.item.name))
        ?? ((await getState()).player.inventory as any[]).find((i: any) => i.tval === m.item.tval && i.sval === m.item.sval);
      if (!item) return false;
    } else {
      item = ((await getState()).player.inventory as any[]).find((i: any) => i.tval === m.item.tval && i.sval === m.item.sval && (i.desc ?? i.name) === (m.item.desc ?? m.item.name)) ?? item;
    }
    const occupied = ((await getState()).player.equipment as any[]).find((e: any) => e.slot === m.slot);
    await sendCommand(item.tval === TVAL.RING && occupied ? { type: CMD.EQUIP, itemIndex: item.slot, replaceSlot: m.slot } : { type: CMD.EQUIP, itemIndex: item.slot });
  }
  return true;
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
    { name: "Wooden Torch", tvals: [TVAL.LIGHT], target: torchTarget(3), stores: [0] }, // vanilla torches burn out
    // RULEFIX=wor: 帰還の巻物 1 枚を回復薬より先に。無いと食料切れのとき上り階段を歩いて餓死していた
    // RULEFIX=wor2: 2 枚 (町から戻る 1 枚 + 次に補給に帰る 1 枚)。深層スタートの 45% は WoR を持っていなかった (2026-10-31 夜)
    ...(RULEFIX.has("wor") || RULEFIX.has("wor2") ? [{ name: "Word of Recall" as string | null, tvals: [25], target: RULEFIX.has("wor2") ? 2 : 1, stores: [4, 5] }] : []),
    ...(RULEFIX.has("neutpois") ? [{ name: "Neutralize Poison" as string | null, tvals: [26], target: 2, stores: [4] }] : []), // 錬金術店 (闇市は 3 倍)
    ...(TELESHOP && (p.maxDepth ?? state.depth ?? 0) >= 5 ? [{ name: "Teleportation" as string | null, tvals: [TVAL.STAFF], target: 1, stores: [5, 6] }] : []),
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
      current = inv.filter((i: any) => i.name?.includes(item.name) && i.qty > 0 && torchCounts(i)
        && (!TELESHOP || (item.tvals.includes(i.tval) && (i.tval !== TVAL.STAFF || deviceReady(i)))))
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
          // packlight: 最低限 (食料 4、松明 1、CCW・Phase 5、Teleportation 2、他 1) を超えた分は、買うと速度が落ち始めるなら買わない
          const pl = stRes.player, least = /Ration/.test(item.name ?? "Ration") ? 4 : /Cure Critical|Phase/.test(item.name ?? "") ? 5 : /^Teleportation$/.test(item.name ?? "") ? 2 : 1;
          if (PACKLIGHT && current + bought >= least && typeof pl?.burden === "number" && typeof pl?.burdenSlowAt === "number"
            && pl.burden + (stockItem.weight ?? 0) > pl.burdenSlowAt) break;

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
          } else {
            const pack = (await getState()).player.inventory ?? [];
            console.log(`  [購入失敗] ${stockItem.name} (${stockItem.price}G) store${storeType} 残金${currentGold}G、持ち物${pack.length}枠: ${pack.map((i: any) => `${i.name}x${i.qty}`).join(", ")}`);
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
      const currentSlotEquip = INVFIX ? equipRival(currentEquip, stockItem.tval) : currentEquip.find((e: any) => sameEquipCategory(e.tval, stockItem.tval));
      const currentPower = currentSlotEquip ? itemPower(currentSlotEquip) : 0;

      // 耐性装備チェック: 足りない耐性を持つアイテムは強く優先
      const hasNeededResist = ((GEARID ? gearView(stockItem) : stockItem).resists ?? []).some((r: any) =>
        r.level > 0 && !currentPlayerResists.has(r.elem)
      );

      // 20%以上パワーアップ or 空スロット or 足りない耐性を持つ
      // invfix: 空きスロットは 10 を超える物だけ (評価 0 の 1.2 倍は何でも通り、Feather Falling を買っていた)
      if ((INVFIX ? currentSlotEquip && stockPower > currentPower * 1.2 : stockPower > currentPower * 1.2)
        || (!currentSlotEquip && stockPower > 10) || hasNeededResist) {
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
              await sendCommand(equipCmd(boughtItem, currentSlotEquip));
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

  // CHEAT=a,b (phase 1 headroom map, test only): the grant once, before the first action (the server needs --cheats).
  // A restore starts a new server process, so the grant is sent again by this new player. Cheat games never feed
  // training or pooled tables (their danger-log header records the grant)
  if (CHEAT) {
    const r = await fetch(`${API}/cheat`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant: CHEAT }) }).catch((e) => ({ ok: false, status: String(e) } as any));
    console.log(`  [CHEAT] ${CHEAT}: ${r.ok ? "granted" : `refused (${r.status})`}`);
    if (!r.ok) process.exit(3);
  }
  let state = await getState();
  if (FLOORPICK) await fetch(`${API}/option`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "pickup_inven", value: 0 }) }).catch(() => null);
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
  // ロールアウト: 復元したゲームには busho のプロセス内カウンタがない (この階の撃破数・滞在ターン)。記録の値で始める
  // (run.ts が ROLLOUT_LEVEL_KILLS/TURNS で渡す)。ないと滞在ターンが state.turn 全体になり、降下ゲートが緩む
  if (ROLLOUT && process.env.ROLLOUT_LEVEL_TURNS) {
    killsThisLevel = Number(process.env.ROLLOUT_LEVEL_KILLS ?? 0);
    levelEntryTurn = state.turn - Number(process.env.ROLLOUT_LEVEL_TURNS);
  }
  // descend/explore are asked at the descent gate, which the item branch comes before: the original game reached
  // the gate with the items in view already passed on (dropped, unreachable or unwanted), and those in-process sets
  // are empty after a restore. Mark the visible items as passed on so the restored game reaches the gate too
  if (ROLLOUT && (ROLLOUT_TYPE === "descend" || ROLLOUT_TYPE === "explore"))
    for (const t of state.map?.tiles ?? []) if (t.hasObj) unreachableItems.add(`${t.x},${t.y}`);
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
      rulefix: [...RULEFIX].join(","), roles: ROLE_ORDER, ...(CHEAT ? { cheat: CHEAT } : {}),
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
    // RULEFIX=auditfix: 見た呪文 (S_KIN、S_MONSTER など) から召喚持ちを知る
    if (AUDITFIX) for (const m of monsters) if (!m.hasSummon && (m.spellsSeen ?? []).some((x: string) => /^S_/.test(x))) m.hasSummon = true;
    const inv = p.inventory;
    canDigHard = playerHasDigger(p);
    diggingSkill = p.digging ?? 0;
    if (DIGSKILL && futileDig.size > 0 && diggingSkill > futileDigSkill) futileDig.clear();
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
    // RULEFIX=floorpick: 持っている品と同じ種類 (pickup_inven が歩くたびに拾っていた物: 撃った矢弾、薬、巻物、油…) は、目標を超えない
    // 限り戦闘中でも拾う (1 品 0.1 ターン、自動で拾うのと同じ)。初版は安全な時しか拾わず、矢弾と油が減って深層 PH 1.43 だった
    if (FLOORPICK && !RO_GATE && state.depth >= 1 && !packIsFull(p, inv)) {
      const held = [...inv, ...((p.quiver ?? []) as any[])];
      const o = ((state.floorObjects ?? []) as any[]).find((o: any) => o.x === px && o.y === py && !o.unknown && !o.ignored
        && held.some((i: any) => i.tval === o.tval && i.sval === o.sval) && wantFloor(o, p, inv));
      if (o) {
        const b0 = p.burden;
        pickOid = o.oid;
        state = await sendCommand({ type: CMD.PICKUP, objectId: o.oid });
        if (state.player.burden === b0) ignoredOids.add(o.oid);
        continue;
      }
    }
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
    // RULEFIX=digskill: 孤立脱出の掘削は掘れる向きだけ。なければ歩ける向きへ 1 歩 (別の壁を試す)、それもなければ 1 ターン休む
    const digSkillStep = async (): Promise<any> => {
      const at = (d: number) => { const [ddx, ddy] = dirOffsets[d] ?? [0, 0]; return tiles.find((t: any) => t.x === px + ddx && t.y === py + ddy); };
      const dig = ALL_DIRS.filter((d) => { const t = at(d); return !!t && digWorthwhile(t.feat); });
      if (dig.length) return sendCommand({ type: CMD.TUNNEL, direction: dig[Math.floor(rand() * dig.length)] });
      const walk = ALL_DIRS.filter((d) => { const t = at(d); return !!t && PASSABLE_FEATS.has(t.feat); });
      if (walk.length) return sendCommand({ type: CMD.WALK, direction: walk[Math.floor(rand() * walk.length)] });
      return sendCommand({ type: CMD.REST, turns: 1 } as any);
    };
    setStationaryAvoid(STATIONMEM ? monsters.concat((state.rememberedMonsters ?? []).map((m: any) =>
      ({ ...m, maxhp: estimatedMaxHp(m.level ?? state.depth, !!m.isUnique) }))) : monsters, p.level);
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
        if (GEARSET) break; // gearset: 一式で選ぶ
        if (!EQUIPPABLE_TVALS.has(invItem.tval)) continue;
        if (INVFIX && invItem.tval === TVAL.LIGHT) continue; // invfix: 光源は光源の規則で (空のランタンに替えて暗闇になっていた)
        if (invItem.tval === TVAL.DIGGING) continue; // 掘削具は持ち物のまま (装備しない)
        // 既に装備したことのあるアイテムは無視 (ループ防止)
        if (equippedNames.has(invItem.name)) continue;
        const curEquip = INVFIX ? equipRival(equip, invItem.tval) : equip.find((e: any) => sameEquipCategory(e.tval, invItem.tval));
        const invPow = itemPower(invItem);
        const curPow = curEquip ? itemPower(curEquip) : -1;
        if (invPow > curPow * 1.2 || (!curEquip && invPow > 0)) {
          equippedNames.add(invItem.name);
          console.log(`  [自動装備] ${invItem.name}(pow=${invPow}) ${curEquip ? `> ${curEquip.name}(pow=${curPow})` : "(空スロット)"}`);
          state = await sendCommand(equipCmd(invItem, curEquip));
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
      levelEscapes = 0; leaving = ""; leaveWalk = 0; sealedDoors.clear(); sealFailed.clear(); sealPrev = null; deviceEmpty.clear(); droppedTiles.clear(); ignoredOids.clear(); staffTriedLevel.clear();
      const arrivedOn = tiles.find((t: any) => t.x === px && t.y === py)?.feat;
      arrivePending = ARRIVE && state.depth >= 1 && (arrivedOn === FEAT.UP_STAIR || arrivedOn === FEAT.DOWN_STAIR);
      if (savepointBank.enabled && !ROLLOUT) await savepointBank.onLevelEntry(state, gameIdOf(state), GAME_SEED === null ? null : Number(GAME_SEED), fetchSnapshotBody);

      // 序盤の町帰還 (逃走で DL1→町 など): 残金で油/Phase/CLW を補充
      if (state.depth === 0 && maxDepthReached < 5 && !RO_GATE) {
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
        if (GEARSET ? await gearsetApply(HOME) : HOME && await retrieveHomeGear() > 0) { await sellJunk(state); state = await getState(); } // home/gearset: 家の装備も含めて見直し、外した物を預ける
        await buyEarlyKit([["food", RULEFIX.has("food8") ? FOOD_KEEP : 5], ["torch", 3]]); // 装備で資金を使い切る前に食料と光源
        // RULEFIX=restock8: CL15 未満は装備より先に序盤の一式 (油/Phase/CLW)。buySupplies は CLW を買わない
        if (RULEFIX.has("restock8") && state.player.level < 15) { await buyEarlyKit(); state = await getState(); }
        if (DEEPKIT) { await buyEarlyKit(DEEP_KIT_STEPS); state = await getState(); }
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
      // RULEFIX=spellfx: 食事の呪文 (Remove Hunger など) を食料より先に。MP が足りなければ敵のいない所で MP を待つ
      const feed = SPELLFX ? fxSpell(p, "nourish") : null;
      if (feed) {
        spellsUsed++; fxNote("nourish");
        addLesson(state.turn, state.depth, "食事", `空腹。${feed.name}`);
        state = await sendCommand({ type: CMD.CAST, spellIndex: feed.index, direction: 5 });
        continue;
      }
      if (SPELLFX && findFood(inv) === null && fxKnows(p, "nourish") && monsters.length === 0 && p.timed.food > 300) {
        state = await sendCommand({ type: CMD.REST, turns: 10 });
        continue;
      }
      const f = findFood(inv);
      if (f !== null) {
        addLesson(state.turn, state.depth, "食事", `空腹。食事`);
        state = await sendCommand({ type: CMD.EAT, itemIndex: f });
        continue;
      }
      if (!RO_GATE && state.depth >= 1) {
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

    // === RULEFIX=spellfx: 毒・朦朧 (と HP 70% 未満の切り傷) は治す呪文で、薬より先に。隣に敵がいれば HP 半分以上の時だけ、
    // 逃走の MP は残す。恐怖で隣に敵 (近接できない) → 恐怖を治す呪文 (Berserk Strength、Heroism) ===
    if (SPELLFX && !castBlocked()) {
      const adj = monsters.some((m: any) => m.distance <= 1);
      const want: string[] = [];
      if ((p.timed.poisoned ?? 0) > 0) want.push("POISONED");
      if ((p.timed.stun ?? 0) > 0) want.push("STUN");
      if ((p.timed.cut ?? 0) > 0 && hpPct < 0.7) want.push("CUT");
      if ((p.timed.afraid ?? 0) > 0 && adj) want.push("AFRAID");
      if (want.length > 0 && (!adj || hpPct >= 0.5 || want.includes("AFRAID"))) {
        const cure = fxSpell(p, "cure", e => want.includes(e.sub ?? ""), adj ? fxReserve(p) : 0);
        if (cure) {
          spellsUsed++; fxNote("cure");
          addLesson(state.turn, state.depth, "治療", `${want.join("/")}${adj ? "、隣に敵" : ""}。${cure.name}`);
          state = await sendCommand({ type: CMD.CAST, spellIndex: cure.index, direction: 5 });
          continue;
        }
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
        : NEUTDRINK && p.timed.poisoned > 0 ? poisonCureSlot(inv, hpPct) : null;
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
        const named = monsters.find((m: any) => leaveListed(m, p.level) && (!LEAVELOS || m.los !== false));
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
    // RULEFIX=digskill: 隣に敵がいる間は強制脱出しない (戦闘・動かない敵から離れる処理に任せる。青ゼリーに触られながら花崗岩を掘り続けて死んでいた)
    if (noProgressCount >= 500 && !lowHpHold && !(DIGSKILL && monsters.some((m: any) => m.distance <= 1))) {
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
      // RULEFIX=digskill: 隣に掘れる岩がなければ、掘削具なしと同じ脱出 (スクロール、WoR、歩ける向き、扉/瓦礫)
      const hardDigOk = (d: number): boolean => {
        const [ddx, ddy] = dirOffsets[d] ?? [0, 0];
        const tt = tiles.find((t: any) => t.x === px + ddx && t.y === py + ddy);
        return !!tt && DIGGABLE_FEATS.has(tt.feat) && !SOFT_DIG_FEATS.has(tt.feat) && digWorthwhile(tt.feat);
      };
      if (!canDigHard || (DIGSKILL && !ALL_DIRS.some(hardDigOk))) {
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
          } else if (SOFT_DIG_FEATS.has(tt.feat) && !digFutile(tt.feat)) {
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
      if (DIGSKILL) { // 掘れない向きなら、回転順で最初の掘れる岩へ
        const [odx, ody] = dirOffsets[tunnelDir] ?? [0, 0];
        const ot = tiles.find((t: any) => t.x === px + odx && t.y === py + ody);
        if (!(ot && (PASSABLE_FEATS.has(ot.feat) || digWorthwhile(ot.feat)))) {
          const alt = ALL_DIRS.map((_, i) => ALL_DIRS[(((tryDirIndex + i) % ALL_DIRS.length) + ALL_DIRS.length) % ALL_DIRS.length]!).find(hardDigOk);
          if (alt !== undefined) tunnelDir = alt;
        }
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
      if (STATIONMEM) { const rm = (state.rememberedMonsters ?? []).filter((m: any) => hurtsOnContact(m)); if (rm.length) threatInfo += ` MEM:${rm.map((m: any) => `${m.name}@${m.x},${m.y}`).join(",")}`; }
      console.log(`  [状態] A${actionCount} T${state.turn} | DL${state.depth} CL${p.level} | HP:${p.hp}/${p.maxHp}${spInfo} | pos:(${px},${py}) | K:${totalKills}(L${killsThisLevel}) | P${passableTiles}/U${unvisited}(${explorationPct}%) | mon:${monsters.length} food:${p.timed.food}${digInfo}${worInfo}${resInfo}${threatInfo}`);
    }

    // === 優先度0: 状態異常対処 (混乱/盲目/麻痺) ===
    const isConfused = p.timed.confused > 0;
    const isBlind = p.timed.blind > 0;
    const isParalyzed = p.timed.paralyzed > 0;
    // M1: the current blind spell (start, HP then, hits since: HP drops between actions while blind)
    if (!isBlind) blindEp = null;
    else if (!blindEp) blindEp = { start: actionCount, hp0: p.hp, lastHp: p.hp, hits: 0, asks: 0, askedAtHits: 0 };
    else { if (p.hp < blindEp.lastHp) blindEp.hits++; blindEp.lastHp = p.hp; }
    if (isConfused || isBlind || isParalyzed) {
      const status = isConfused ? "混乱" : isBlind ? "盲目" : "麻痺";
      const nearbyEnemies = monsters.filter((m: any) => m.distance <= 2);
      const confThreats = CONFESC && isConfused && !isParalyzed ? monsters.filter(confThreat) : [];
      if (confThreats.length > 0 || (CONFESC && isConfused && !isParalyzed && unseenThreat)) {
        const shroom = monsters.find((m: any) => m.distance <= 1 && STATIONARY_RE.test(m.name ?? "") && !hurtsOnContact(m));
        const here = tiles.find((t: any) => t.x === px && t.y === py);
        const tstaff = inv.find((i: any) => isTeleStaff(i) && deviceReady(i));
        const cure = findConfusionCure(inv, hpPct);
        const adj = confThreats.filter((m: any) => m.distance <= 1);
        const what = confThreats.length ? `${confThreats[0].name}ら${confThreats.length}体` : "見えない敵";
        if (shroom) {
          state = await sendCommand({ type: CMD.WALK, direction: directionTo(px, py, shroom.x, shroom.y) });
        } else if (here?.feat === FEAT.DOWN_STAIR || here?.feat === FEAT.UP_STAIR) {
          confEsc.stairs++; fleeAttempts++;
          addLesson(state.turn, state.depth, "混乱脱出", `混乱中、${what}。階段の上なので階段で離脱`);
          state = await sendCommand({ type: here.feat === FEAT.DOWN_STAIR ? CMD.GO_DOWN : CMD.GO_UP });
        } else if (tstaff) {
          confEsc.staff++; fleeAttempts++;
          addLesson(state.turn, state.depth, "混乱脱出", `混乱中、${what}。Teleportationの杖で離脱`);
          state = await sendCommand({ type: CMD.USE, itemIndex: tstaff.slot });
        } else if (cure !== null) {
          confEsc.cure++; healingsUsed++; confCuredAt = actionCount;
          addLesson(state.turn, state.depth, "混乱脱出", `混乱中、${what}。薬で治してから逃げる`);
          state = await sendCommand({ type: CMD.QUAFF, itemIndex: cure });
        } else if (adj.length > 0) {
          confEsc.attack++;
          state = await sendCommand({ type: CMD.WALK, direction: directionTo(px, py, adj[0].x, adj[0].y) });
        } else {
          // 脅威から一番遠くなる隣のマス (見えない敵だけならランダム)
          let best: number | null = null, bestD = -1;
          for (const d of ALL_DIRS) {
            const [dx, dy] = dirOffsets[d]!;
            const nx = px + dx, ny = py + dy;
            if (!isPassable(tiles, nx, ny) || monsters.some((m: any) => m.x === nx && m.y === ny)) continue;
            const md = confThreats.length ? Math.min(...confThreats.map((m: any) => Math.max(Math.abs(m.x - nx), Math.abs(m.y - ny)))) : rand();
            if (md > bestD) { bestD = md; best = d; }
          }
          confEsc.away++;
          state = await sendCommand(best !== null ? { type: CMD.WALK, direction: best } : { type: CMD.SEARCH });
        }
        continue;
      }
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
        // teleshop: 混乱中でも杖は使える。HP 半分未満なら Teleportation の杖で離れる
        const tstaff = TELESHOP && hpPct < 0.5 ? inv.find((i: any) => isTeleStaff(i) && deviceReady(i)) : null;
        if (tstaff) {
          addLesson(state.turn, state.depth, "状態異常", `${status}中+敵${nearbyEnemies.length}体接近、HP${Math.round(hpPct * 100)}%。Teleportationの杖で離脱`);
          fleeAttempts++;
          state = await sendCommand({ type: CMD.USE, itemIndex: tstaff.slot });
          continue;
        }
        // 混乱+敵が近い → ポーション飲む (混乱中でもquaffは可能)
        const healSlot = CUREFX ? findConfusionCure(inv, hpPct) : findHealingPotion(inv);
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
      // RULEFIX=blindsafe2 (blindsafe を含む): 見えない敵に打たれるのを待たず、盲目になった時に動く敵を近くで見たばかりなら
      // (覚えている敵: 6 マス以内、100 ゲームターン以内) すぐ治す。盲目は深層の死亡の 43% に出ていて、その間の行動の 72% が休息だった
      // (2026-11-01、blindsafe 採用前の基準)
      // RULEFIX=blindask (M1, docs/plan-2026-11-09.md): blind with a threat → ask the "blind" question. Asked at the first
      // such action of a blind spell, then after each new hit, at most 6 times a spell. "rest" carries on as the rules
      // would (null); the other answers are carried out here. With the rules policy and no model the play is unchanged.
      if (BLINDASK && isBlind && !isParalyzed && !isConfused && DECISION_ON && blindEp) {
        const mem = ((state.rememberedMonsters ?? []) as any[]).filter((m: any) => m.distance <= 7);
        const threatMem = mem.some((m: any) => m.distance <= 1 || ((m.turnsAgo ?? 9999) <= 100 && m.neverMove !== true
          && !STATIONARY_RE.test(m.name ?? "")));
        // a rollout's first ask: the record was in the class when saved, but a restored game has lost the bridge's
        // monster memory (in-process, not in the savefile) and the hits counted so far, so it asks whenever blind
        const inClass = (ROLLOUT && !rolloutFired) || blindEp.hits > 0 || unseenThreat || threatMem || monsters.some((m: any) => m.distance <= 1);
        if (inClass && blindEp.asks < 6 && (blindEp.asks === 0 || blindEp.hits > blindEp.askedAtHits)) {
          blindEp.asks++; blindEp.askedAtHits = blindEp.hits; blindAsks++;
          const here = tiles.find((t: any) => t.x === px && t.y === py);
          const onStairs = here?.feat === FEAT.UP_STAIR || here?.feat === FEAT.DOWN_STAIR;
          const cures: Record<string, number> = {};
          for (const it of blindCures(inv)) cures[it.name] = (cures[it.name] ?? 0) + (it.qty ?? 1);
          const walkDir = blindWalkDir(tiles, px, py, mem);
          const ctx: BlindCtx = { hits: blindEp.hits, hpLost: Math.max(0, blindEp.hp0 - p.hp), turnsBlind: actionCount - blindEp.start,
            cures, onStairs, canWalk: walkDir !== null,
            messages: ((state.messages ?? []) as any[]).slice(-3).map((m: any) => String(m)),
            near: mem.slice(0, 5).map((m: any) => `${m.name}(dist${m.distance}, ${Math.round((m.turnsAgo ?? 0) / 10)} turns ago)`) };
          const ans = await decide("blind", { state, rules: "rest", blind: ctx });
          if (ans && ans !== "rest") {
            const cure = blindCures(inv)[0];
            const cmd = ans === "cure" && cure ? { type: CMD.QUAFF, itemIndex: cure.slot }
              : ans === "stairs" && onStairs ? { type: here?.feat === FEAT.DOWN_STAIR ? CMD.GO_DOWN : CMD.GO_UP }
              : ans === "walk" && walkDir !== null ? { type: CMD.WALK, direction: walkDir } : null;
            if (cmd) {
              blindActs[ans] = (blindActs[ans] ?? 0) + 1;
              addLesson(state.turn, state.depth, "盲目の判断", `盲目 (被弾${ctx.hits}回)。${ans}`);
              if (ans === "cure") healingsUsed++;
              if (ans === "stairs") { fleeAttempts++; unseenHits = []; }
              state = await sendCommand(cmd);
              continue;
            }
          }
        }
      }
      const blindNearMem = BLINDSAFE2 && ((state.rememberedMonsters ?? []) as any[]).some((m: any) => m.distance <= 6
        && (m.turnsAgo ?? 9999) <= 100 && m.neverMove !== true && !STATIONARY_RE.test(m.name ?? ""));
      if ((BLINDSAFE || BLINDSAFE2) && isBlind && !isParalyzed && !isConfused && (unseenThreat || blindNearMem)) {
        const cure = findHealingPotion(inv);
        const here = tiles.find((t: any) => t.x === px && t.y === py);
        const onStair = here?.feat === FEAT.UP_STAIR || here?.feat === FEAT.DOWN_STAIR;
        if (cure !== null || onStair) {
          addLesson(state.turn, state.depth, "状態異常", `盲目で${unseenThreat ? `見えない敵に${unseenHits.length}回攻撃された` : "近くに敵"}。${cure !== null ? "薬で盲目を治す" : "階段で離脱"}`);
          if (cure !== null) { healingsUsed++; state = await sendCommand({ type: CMD.QUAFF, itemIndex: cure }); }
          else { fleeAttempts++; state = await sendCommand({ type: here?.feat === FEAT.DOWN_STAIR ? CMD.GO_DOWN : CMD.GO_UP }); unseenHits = []; }
          continue;
        }
      }
      // RULEFIX=blindfight: 盲目で見えない敵に打たれていて、治す薬も足元の階段もない → 休まず、盲目になる前に隣で見た敵のマスを殴る
      // (4.2 では見えなくても隣のマスは攻撃できる)。blindsafe の基準で盲目で休んで死んだ 92 局のうち 58 局は Cure を持たず、77 局は
      // 休む間に HP が減っていた (2026-11-01)
      if (BLINDFIGHT && isBlind && !isParalyzed && !isConfused && unseenThreat && findHealingPotion(inv) === null) {
        const adj = ((state.rememberedMonsters ?? []) as any[]).filter((m: any) => m.distance <= 1 && (m.turnsAgo ?? 9999) <= 300)
          .sort((a: any, b: any) => (a.turnsAgo ?? 0) - (b.turnsAgo ?? 0))[0];
        if (adj) {
          blindAttacks++;
          if (blindAttacks <= 3 || blindAttacks % 20 === 0) addLesson(state.turn, state.depth, "状態異常", `盲目で打たれ、薬なし。隣で見た${adj.name}のマスを殴る (#${blindAttacks})`);
          state = await sendCommand({ type: CMD.ATTACK, target: { x: adj.x, y: adj.y } });
          continue;
        }
      }
      // RULEFIX=stationmem: 盲目で、覚えている動かない接触の敵が隣 → 休まず 1 歩離れる (bloodshot eye の凝視は盲目 + 2d6 で、
      // 見えないまま隣で休み続けて死んでいた。CLW は盲目を治すが次の凝視でまた盲目)
      if (STATIONMEM && isBlind && !isParalyzed && !isConfused
          && monsters.concat(state.rememberedMonsters ?? []).some((m: any) => m.distance <= 1 && hurtsOnContact(m))) {
        const away = stepAwayFromStationary();
        if (away !== null) {
          blindSteps++;
          if (blindSteps <= 3 || blindSteps % 20 === 0) addLesson(state.turn, state.depth, "状態異常", `盲目で動かない敵の隣。休まず離れる (#${blindSteps})`);
          state = await sendCommand({ type: CMD.WALK, direction: away });
          continue;
        }
      }
      // RULEFIX=curefx: 混乱中、起きて動く敵が 7 マス以内に見える → 休まず混乱を治す薬を飲む
      if (CUREFX && isConfused && !isParalyzed
          && monsters.some((m: any) => m.distance <= 7 && !STATIONARY_RE.test(m.name ?? "") && m.neverMove !== true && !m.asleep)) {
        const cure = findConfusionCure(inv, hpPct);
        if (cure !== null) {
          addLesson(state.turn, state.depth, "状態異常", `混乱中、7マス以内に敵。休まず薬で治す`);
          healingsUsed++;
          state = await sendCommand({ type: CMD.QUAFF, itemIndex: cure });
          continue;
        }
      }
      // 敵がいない or 盲目/麻痺 → RESTで回復待ち
      if (actionCount % 50 === 0) {
        addLesson(state.turn, state.depth, "状態異常", `${status}中。RESTで回復待ち`);
      }
      state = await sendCommand({ type: CMD.REST });
      continue;
    }

    // RULEFIX=confesc: 薬で混乱を治した直後 (3 行動以内)、まだ起きて動く敵が 7 マス以内に見え、HP 60% 未満かユニーク・階層以上の敵なら
    // Teleportation (無ければ Phase Door) を読む。術者や凝視の敵の前に残るとまた混乱させられる
    if (CONFESC && actionCount - confCuredAt <= 3 && !isConfused && !isBlind && !isParalyzed) {
      const threats = monsters.filter(confThreat);
      if (threats.length > 0 && (hpPct < 0.6 || threats.some((m: any) => m.isUnique || (m.level ?? 0) >= state.depth))) {
        const scroll = findTeleportScroll(inv) ?? findPhaseScroll(inv);
        if (scroll !== null) {
          confCuredAt = -99; confEsc.read++; fleeAttempts++;
          addLesson(state.turn, state.depth, "混乱脱出", `混乱が治った。${threats[0].name}がまだ${threats[0].distance}マス、HP${Math.round(hpPct * 100)}%。巻物で離脱`);
          state = await sendCommand({ type: CMD.READ, itemIndex: scroll });
          continue;
        }
      }
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
      // RULEFIX=invfix: ランタン (松明より明るく燃え尽きず、持っている油で給油できる) を持っていれば松明から替える
      const lanternInv = INVFIX && !/Lantern/i.test(cur?.name ?? "") && actionCount >= lightBlockedUntil
        ? inv.find((i: any) => i.tval === TVAL.LIGHT && /Lantern/i.test(i.name ?? "") && !gearCursed(i) && itemPower(i) >= 0
          && (UNLIGHT_CLASS(p) || (((gearView(i).modifiers ?? [])[OMOD.LIGHT] ?? 0) >= 0 && !dimLights.has(lightKey(i)))) // Lantern of Shadows (LIGHT -4) は暗くなる
          && ((i.fuel ?? 0) > 0 || inv.some((o: any) => /Flask~? of oil/i.test(o.name ?? "") && o.qty > 0))) : undefined;
      if (lanternInv && monsters.every((m: any) => m.distance > 2)) {
        addLesson(state.turn, state.depth, "光源", `${cur?.name ?? "光源なし"}からランタンに替える`);
        state = await sendCommand({ type: CMD.EQUIP, itemIndex: lanternInv.slot });
        if (!/Lantern/i.test((state.player?.equipment ?? []).find((e: any) => e.tval === TVAL.LIGHT)?.name ?? "")) lightBlockedUntil = actionCount + 200;
        continue;
      }
      // invfix: 空のランタンは油があればその場で給油、無ければ松明に替える (給油は lightout の規則より先: 替えては戻すループになっていた)
      const oilInv = inv.find((i: any) => /Flask~? of oil/i.test(i.name ?? "") && i.qty > 0);
      if (INVFIX && cur && /Lantern/i.test(cur.name ?? "") && (cur.fuel ?? 0) <= 0 && oilInv && actionCount >= lightBlockedUntil) {
        state = await sendCommand({ type: CMD.REFILL, itemIndex: oilInv.slot });
        const after = (state.player?.equipment ?? []).find((e: any) => e.tval === TVAL.LIGHT);
        if ((after?.fuel ?? 0) <= 0) lightBlockedUntil = actionCount + 200;
        continue;
      }
      const low = cur ? (typeof cur.fuel === "number" && (/Torch/i.test(cur.name ?? "") ? cur.fuel < 300 : INVFIX && cur.fuel <= 0 && !oilInv)) : true;
      // invfix: 着けている光源で明るくならない (Lantern of Shadows など、光の修正が負) → 燃料のある松明に替える
      const dim = INVFIX && !UNLIGHT_CLASS(p) && !!cur && !/Torch/i.test(cur.name ?? "") && (p.light ?? 1) <= 0 && (cur.fuel ?? 1) > 0;
      if (dim) dimLights.add(lightKey(cur));
      const spare = (low || dim) && actionCount >= lightBlockedUntil ? spareTorchSlot(inv) : null;
      if (spare !== null && (dim || !(INVFIX && cur && (inv.find((i: any) => i.slot === spare)?.fuel ?? 0) <= (cur.fuel ?? 0)))) {
        addLesson(state.turn, state.depth, "光源", `松明の残り${cur?.fuel ?? 0}ターン。予備の松明に替える`);
        state = await sendCommand({ type: CMD.EQUIP, itemIndex: spare });
        const after = (state.player?.equipment ?? []).find((e: any) => e.tval === TVAL.LIGHT);
        // 替えられなかった: ループ防止 (invfix: 燃料が増えなかった時だけ。燃え残りに替えるのは正しい交換で、止めると予備を残したまま暗闇になる)
        if (INVFIX ? (after?.fuel ?? 0) <= (cur?.fuel ?? 0) : (after?.fuel ?? 0) < 300) lightBlockedUntil = actionCount + 200;
        continue;
      }
    }

    // === RULEFIX=lightout: ランタンの給油、光源切れの前の帰還、暗闇での手探り ===
    if (LIGHTOUT && state.depth >= 1) {
      const cur = (p.equipment ?? []).find((e: any) => e.tval === TVAL.LIGHT);
      const fuel = cur ? (typeof cur.fuel === "number" ? cur.fuel : Infinity) : 0; // fuel の無い光源 (燃え尽きない) は無限
      const lantern = !!cur && /Lantern/i.test(cur.name ?? "");
      const oil = inv.find((i: any) => /Flask~? of oil/i.test(i.name ?? "") && i.qty > 0);
      // 動かないと分かっている敵 (思い出の「追って来ない」: neverMove) は数えない: 隣なら離れればよい (2026-10-30: 2 マス先の bloodshot eye の
      // そばで給油も手探りもせず、暗闇で数千行動止まっていた)
      const nearFoe = monsters.some((m: any) => m.distance <= 2 && m.asleep !== true && m.neverMove !== true);
      if (lantern && fuel < 7500 && oil && !nearFoe && actionCount >= lightBlockedUntil) {
        state = await sendCommand({ type: CMD.REFILL, itemIndex: oil.slot });
        const after = (state.player?.equipment ?? []).find((e: any) => e.tval === TVAL.LIGHT);
        if ((after?.fuel ?? 0) <= fuel) lightBlockedUntil = actionCount + 200; // 給油できなかった: ループ防止
        continue;
      }
      const spareFuel = inv.filter((i: any) => i.tval === TVAL.LIGHT && /Torch/i.test(i.name ?? "") && i.qty > 0)
        .reduce((t: number, i: any) => t + (i.fuel ?? 0) * i.qty, 0)
        + (lantern ? inv.filter((i: any) => /Flask~? of oil/i.test(i.name ?? "")).reduce((t: number, i: any) => t + 7500 * i.qty, 0) : 0);
      // WoR があれば 2000 で足りる (発動まで 15-35 ターン)。無ければ上り階段を階ごとに探すので深さに応じて (上限 6000)
      const lightNeed = findRecallScroll(inv) !== null || p.wordRecall > 0 ? 2000 : Math.min(2000 + 1000 * state.depth, 6000);
      if (fuel + spareFuel < lightNeed) {
        const canRead = fuel > 0 && !(p.timed.blind > 0) && !(p.timed.confused > 0);
        if (!(p.wordRecall > 0) && canRead && !nearFoe) {
          const wor = findRecallScroll(inv);
          if (wor !== null) {
            addLesson(state.turn, state.depth, "光源", `光源の残り${fuel}ターン、予備なし。明るいうちにWoRで町へ`);
            state = await sendCommand({ type: CMD.READ, itemIndex: wor });
            continue;
          }
        }
        if (!(p.wordRecall > 0) && !restockTrip) {
          restockTrip = true;
          if (!lightTripNoted) { lightTripNoted = true; addLesson(state.turn, state.depth, "光源", `光源の残り${fuel}ターン、予備なし。上り階段で町へ`); }
        }
        if (fuel <= 0 && !nearFoe) { // もう暗い
          const here = tiles.find((t: any) => t.x === px && t.y === py);
          if (p.wordRecall > 0) { state = await sendCommand({ type: CMD.REST, turns: 5 }); continue; }
          if (here?.feat === FEAT.UP_STAIR) { state = await sendCommand({ type: CMD.GO_UP }); continue; }
          const up = findTile(tiles, FEAT.UP_STAIR);
          if (!(up && bfsNextStep(tiles, px, py, up.x, up.y) !== null)) { // 道が分からない: 手探り
            darkFelt.add(`${state.depth}:${px},${py}`);
            if (darkSteps % 2 === 0) { // 足元が見えないので上り階段を試す (無ければ時間は経たない)
              darkSteps++;
              state = await sendCommand({ type: CMD.GO_UP });
              continue;
            }
            const at = (d: number) => tiles.find((t: any) => t.x === px + DIR_DXY[d]![0] && t.y === py + DIR_DXY[d]![1]);
            const open0 = ALL_DIRS.filter((d) => { const t = at(d); return !t || t.unknown || PASSABLE_FEATS.has(t.feat); });
            const fresh = open0.filter((d) => !darkFelt.has(`${state.depth}:${px + DIR_DXY[d]![0]},${py + DIR_DXY[d]![1]}`));
            const open = fresh.length ? fresh : open0;
            if (open.length) {
              darkSteps++;
              if (darkSteps <= 3 || darkSteps % 100 === 0) addLesson(state.turn, state.depth, "光源", `暗闇で道が分からない。手探りで歩く (#${darkSteps})`);
              state = await sendCommand({ type: CMD.WALK, direction: open[Math.floor(rand() * open.length)]! });
              continue;
            }
          }
        }
      }
    }

    // === RULEFIX=devicefx: 到着した階で 1 回ずつ、地図・階段の感知と敵の感知の道具 (杖・ロッド) ===
    if (DEVICEFX && !DFXNOARRIVE && !RO_GATE && state.depth >= 1 && monsters.every((m: any) => m.distance > 3)) {
      const map = devMapLevel !== levelEntryTurn ? devFx(inv, "detect-stairs", undefined, 700) : null;
      const det = !map && devDetectLevel !== levelEntryTurn ? devFx(inv, "detect-monsters", e => e.sub !== "DETECT_INVISIBLE_MONSTERS", 700) : null; // 透明な敵だけの感知は到着時には使わない (209 回の無駄、2026-10-31)
      const d = map ?? det;
      if (map) devMapLevel = levelEntryTurn; else if (det) devDetectLevel = levelEntryTurn;
      if (d) {
        devFxNote(d.entry.role);
        addLesson(state.turn, state.depth, "魔法の道具", `到着: ${d.it.desc ?? d.it.name} (${d.entry.role})`);
        state = await sendCommand(devCmd(d.it));
        continue;
      }
    }

    // === 優先度1.5: 検知スペル (新フロアで1回使用) ===
    // RULEFIX=spellfx: 到着時に加えて、敵が見えないまま 300 行動たったらもう一度。逃走の MP は残す
    if ((!levelEntryDetected || (SPELLFX && monsters.length === 0 && actionCount - lastDetectAt >= 300)) && canCastSpells && actionCount > 1) {
      const detectSpell = SPELLFX ? fxSpell(p, "detect-monsters", undefined, fxReserve(p)) : findCastableSpell(spells, DETECT_SPELLS, p.level, sp);
      if (detectSpell) {
        spellsUsed++;
        if (SPELLFX) { fxNote("detect-monsters"); lastDetectAt = actionCount; }
        levelEntryDetected = true;
        addLesson(state.turn, state.depth, "検知",
          `新フロアで${detectSpell.name}を使用。周囲の状況把握`);
        state = await sendCommand({ type: CMD.CAST, spellIndex: detectSpell.index, direction: 5 });
        continue;
      }
    }

    // === 優先度1.8: 補給帰還 (回復薬が危険域ならWoRで町へ) ===
    // supplyWoRUsed: 同じ階で1回のみ (ループ防止)
    if ((state.depth >= 10 || ((WIDE || ESCRECALL) && state.depth >= 5)) && !(p.wordRecall > 0) && !supplyWoRUsedThisLevel
        && monsters.filter((m: any) => m.distance <= 3).length === 0) {
      const cureQty2 = inv.filter((i: any) => i.name?.includes("Cure") && i.qty > 0)
        .reduce((s: number, i: any) => s + i.qty, 0);
      const minCureForDepth = state.depth >= 35 ? 15 : state.depth >= 25 ? 10 : state.depth >= 20 ? 8 : state.depth >= 15 ? 5 : 3;
      // ルール基準 OR LLM判断で帰還
      let shouldRecall = state.depth >= 10 && cureQty2 < minCureForDepth;
      let recallWhy = `回復薬${cureQty2}個 < 最低${minCureForDepth}`, escLow = false;
      // RULEFIX=escrecall: 逃走手段が降下の基準 (Phase 3、DL15+ は 5。Teleportation は 2 枚分) を下回り、逃走の呪文も知らなければ
      // WoR で補給 (2026-10-31 夜: DL5+ の recall/continue を 2,000 行動まで先読みすると、Phase 0-6 では今帰る方が +0.7〜0.8
      // (死亡 -17pp、n 16)、Phase 7+ では -0.23。降下は止まるのに補給に帰らず、長居の期限まで Phase なしで戦っていた)
      if (!shouldRecall && ESCRECALL && p.gold >= 150 && !(p.timed?.blind > 0) && !(p.timed?.confused > 0)) {
        const ph = itemCount(inv, (i) => i.tval === TVAL.SCROLL && /Phase Door/.test(i.name ?? ""));
        const te = itemCount(inv, (i) => i.tval === TVAL.SCROLL && /^Teleportation$/.test(i.name ?? ""))
          + (TELESHOP ? inv.filter((i: any) => isTeleStaff(i) && deviceReady(i)).reduce((n: number, i: any) => n + Math.max(1, i.charges ?? 1), 0) : 0);
        const minPh = state.depth >= 15 ? 5 : 3;
        const escSpell = ((p.spells ?? []) as any[]).some((sp: any) => /Phase Door|Teleport|Blink|Portal/i.test(sp.name ?? "") && (sp.level ?? 99) <= p.level);
        // RULEFIX=escdire: 回復薬も 2 個以下の時だけ (escwalk は死亡を 27% 減らしたが、帰る回数が多くて進みも 22% 遅れた)
        if (ph + 2 * te < minPh && !escSpell && (!ESCDIRE || cureQty2 <= 2)) { shouldRecall = true; escLow = true; recallWhy = `逃走手段 Phase${ph} Teleport${te} < ${minPh}`; }
      }
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
          if (escLow) escRecalls++;
          addLesson(state.turn, state.depth, "補給帰還", `${recallWhy}。WoRで補給帰還`);
          state = await sendCommand({ type: CMD.READ, itemIndex: recallSlot2 });
          continue;
        }
        // RULEFIX=escwalk: WoR が無ければ上り階段で町へ (restock の補給帰還と同じ道)
        if (escLow && ESCWALK && !restockTrip) {
          restockTrip = true; supplyWoRUsedThisLevel = true; escWalks++;
          addLesson(state.turn, state.depth, "補給帰還", `${recallWhy}、WoR なし。上り階段で町へ`);
        }
      }
    }

    // === 優先度1.9: 浅層の補給帰還 (回復薬切れ or Phase/油切れ → 上り階段で町へ) ===
    // RULEFIX=restock8: 補給帰還を DL8 まで (session 20: Phase なしの死亡 165 件のうち 113 件は DL5 以深か CL15 以上)
    if (RULEFIX.has("restock") && !RO_GATE && state.depth >= 1 && ((state.depth <= (RULEFIX.has("restock8") ? 8 : 4) && p.level < 15) || restockTrip)) {
      const cureN = inv.filter((i: any) => i.name?.includes("Cure") && i.qty > 0).reduce((s: number, i: any) => s + i.qty, 0);
      const escN = inv.filter((i: any) => (i.name?.includes("Phase Door") || /Flask~? of oil/i.test(i.name ?? "")) && i.qty > 0)
        .reduce((s: number, i: any) => s + i.qty, 0);
      const foodN = inv.filter((i: any) => i.tval === TVAL.FOOD && i.qty > 0).reduce((s: number, i: any) => s + i.qty, 0)
        + (SPELLFX && fxKnows(p, "nourish") ? 99 : 0); // RULEFIX=spellfx: 食事の呪文を知っていれば食料のための帰還はしない
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
    if (state.depth === 0) { restockTrip = false; upRerolls = 0; upRerollDepth = -1; lightTripNoted = false; darkSteps = 0; darkFelt.clear(); }

    // === RULEFIX=devices: 回復の杖 (HP 半分未満)、Teleportation の杖 (HP 35% 未満で 3 マス以内に敵)、未知の杖 (安全な時) ===
    if (DEVICES && !RO_GATE && actionCount - lastDeviceAction >= 2) {
      const dev = (re: RegExp, tv: number) => inv.find((i: any) => i.tval === tv && i.aware !== false && re.test(i.name ?? "") && deviceReady(i));
      const near3 = monsters.some((m: any) => m.distance <= 3);
      let use: { it: any; why: string } | null = null;
      const tele = dev(/^Teleportation$/, TVAL.STAFF);
      const heal = dev(HEAL_STAVES, TVAL.STAFF);
      if (tele && hpPct < 0.35 && near3) use = { it: tele, why: "緊急逃走" };
      else if (heal && hpPct < 0.5 && !(DEVHEAL && heal.name !== "Healing"
        && monsters.some((m: any) => m.distance <= 5 && m.asleep !== true && m.neverMove !== true))) use = { it: heal, why: "回復" };
      else {
        const unk = DFXNOTRY ? undefined : inv.find((i: any) => i.tval === TVAL.STAFF && i.aware === false && deviceReady(i) && !staffTriedLevel.has(i.name));
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
          const escSpell = SPELLFX ? fxEscape(p, preferTeleport) : findCastableSpell(spells, ESCAPE_SPELLS, p.level, sp);
          if (escSpell) {
            fleeAttempts++; retreatMode = true; retreatStartTurn = state.turn;
            spellsUsed++;
            addLesson(state.turn, state.depth, "魔法逃走",
              `HP${Math.round(hpPct*100)}%、${escSpell.name}で逃走`);
            state = await sendCommand({ type: CMD.CAST, spellIndex: escSpell.index, direction: 5 });
            if (escapeIsLong(escSpell)) {
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
    // RULEFIX=spellfx: 状態表示に出ていない強化だけ (攻撃、防御、加速。属性耐性と補助は除く)。起きた敵が 2-5 マスに来る時、
    // または隣の敵 2 体以上か HP 50-80% で隣に敵。逃走の MP は残す
    if (SPELLFX) {
      const active = new Set<string>(p.timedActive ?? []);
      const adjN = monsters.filter((m: any) => m.distance <= 1).length;
      // HP 半分未満では強化しない (回復・逃走が先。smoke45: HP 33% で Berserk Strength を唱えて次の手で死んだ)
      const fight = hpPct >= 0.5 && (monsters.some((m: any) => m.asleep !== true && m.distance >= 2 && m.distance <= 5) || adjN >= 2 || (adjN >= 1 && hpPct < 0.8));
      const buff = canCastSpells && fight ? fxSpell(p, "buff", e => e.amount > 0 && !active.has(e.sub ?? "")
        && (e.kind === "offence" || e.kind === "speed" || (e.kind === "defence" && !(e.sub ?? "").startsWith("OPP_"))), fxReserve(p)) : null;
      if (buff) {
        spellsUsed++; fxNote("buff");
        if ((fxCasts.buff ?? 0) <= 3 || (fxCasts.buff ?? 0) % 20 === 0) addLesson(state.turn, state.depth, "バフ", `${buff.name} (MP${buff.mana}, #${fxCasts.buff})`);
        state = await sendCommand({ type: CMD.CAST, spellIndex: buff.index, direction: 5 });
        continue;
      }
    } else if (canCastSpells && monsters.filter((m: any) => m.distance <= 3).length > 0) {
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
      // RULEFIX=auditfix: 深さを問わず (起きた敵が 3 マス以内にいる時だけ)
      const awakeNear = monsters.some((m: any) => m.distance <= 3 && m.asleep !== true);
      if ((hasDangerNear || hasFastMonsterNear || nearEnemyCount >= 3 || hasSummonerNear) && (isDeep || (AUDITFIX && awakeNear && state.depth >= 1))
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

    // === RULEFIX=devices2: 起きているオーク (7 マス以内) がいれば Wand of Light。一番多くのオークを貫く向きへ ===
    if (DEVICES2 && state.depth >= 1 && !RO_GATE) {
      const wand = inv.find((i: any) => i.tval === TVAL.WAND && i.aware !== false && i.name === "Light" && deviceReady(i));
      const orcs = wand ? monsters.filter((m: any) => LIGHT_ORC_RE.test(m.name ?? "") && m.distance <= 10
        && hasLOS(tiles, px, py, m.x, m.y)) : [];
      if (wand && orcs.some((m: any) => m.asleep !== true && m.distance <= 7)) {
        let best: any = null, bestN = 0;
        for (const m of orcs) {
          const cells = beamCells(tiles, px, py, m.x, m.y, 20);
          const n = orcs.filter((o: any) => cells.has(`${o.x},${o.y}`)).length;
          if (best === null || n > bestN || (n === bestN && m.distance < best.distance)) { best = m; bestN = n; }
        }
        lightWandUses++; lightWandOrcs += bestN; devicesUsed++; lastDeviceAction = actionCount;
        if (lightWandUses <= 3 || lightWandUses % 10 === 0) addLesson(state.turn, state.depth, "魔法の道具",
          `${wand.desc ?? wand.name}を${best.name}(dist${best.distance})へ、列のオーク${bestN}体 (#${lightWandUses})`);
        const turnBefore = state.turn;
        state = await sendCommand({ type: CMD.AIM, itemIndex: wand.slot, target: { x: best.x, y: best.y } });
        if (state.turn === turnBefore) deviceEmpty.add(`${wand.tval}:${wand.name}`);
        continue;
      }
    }

    // === 優先度3.8: 遠距離攻撃スペル (距離2-6の敵にボルト/ビーム) ===
    if (canCastSpells) {
      const adjacentCount = monsters.filter((m: any) => m.distance <= 1).length;
      const rangedTargets = monsters.filter((m: any) =>
        m.distance >= 2 && m.distance <= 6 && !isDangerousMonster(m, p.level, state.depth, playerResists)
        && (!SPELLFIGHT || hasLOS(tiles, px, py, m.x, m.y))
      );
      if (rangedTargets.length > 0 && adjacentCount === 0) {
        // 召喚持ちは優先排除 (増殖前に倒す)、次に近い敵を狙う
        const target = rangedTargets.sort((a: any, b: any) => {
          const aSummon = a.hasSummon ? -10 : 0;
          const bSummon = b.hasSummon ? -10 : 0;
          return (a.distance + aSummon) - (b.distance + bSummon);
        })[0];
        // RULEFIX=spellfx: 目標に届く呪文だけ (Electric Arc などの短いビームは レベル÷n マスまで。smoke51: CL2 の Mage が
        // 2 マスしか届かない Electric Arc を 3-6 マス先へ唱えていた)
        const atkSpell = SPELLFX ? fxSpell(p, "attack-target", e => reachOf(e, p.level) >= target.distance)
          : findCastableSpell(spells, ATTACK_SPELLS, p.level, sp);
        if (atkSpell && sp >= atkSpell.mana) {
          const dir = directionTo(px, py, target.x, target.y);
          spellsUsed++;
          if (SPELLFIGHT) fxNote("attack-target");
          // RULEFIX=spellfight: 目標のマスへ (方向だと 8 方向の線上にいない敵に当たらない)
          state = await sendCommand(SPELLFIGHT ? { type: CMD.CAST, spellIndex: atkSpell.index, target: { x: target.x, y: target.y } }
            : { type: CMD.CAST, spellIndex: atkSpell.index, direction: dir });
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

    // === RULEFIX=spellfight: 起きた敵 (危険でない) が 2-4 マスに 1 体だけ → 走り寄って打つ呪文 (Leap into Battle: 説明では最大 4 マス)。
    // 歩いて近づく手番を打撃に変える。6 マス以内の起きた敵が 2 体以上なら群れに飛び込まない ===
    if (SPELLFIGHT && canCastSpells && !monsters.some((m: any) => m.distance <= 1)) {
      const awake6 = monsters.filter((m: any) => m.asleep !== true && m.distance <= 6);
      const m = awake6.length === 1 ? awake6[0] : null;
      if (m && m.distance >= 2 && m.distance <= 4 && hasLOS(tiles, px, py, m.x, m.y) && !hurtsOnContact(m)
          && !isDangerousMonster(m, p.level, state.depth, playerResists)) {
        const leap = fxSpell(p, "attack-melee", e => e.sub === "MOVE_ATTACK", fxReserve(p));
        if (leap) {
          spellsUsed++; fxNote("attack-melee");
          if ((fxCasts["attack-melee"] ?? 0) <= 3) addLesson(state.turn, state.depth, "呪文で戦う", `${m.name}(dist${m.distance})へ${leap.name}`);
          state = await sendCommand({ type: CMD.CAST, spellIndex: leap.index, target: { x: m.x, y: m.y } });
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
        if (DEVICES && !DFXNOTRY && state.depth >= 1 && m.distance >= 2 && choice !== "flee" && !(DEVICES2 && m.isUnique)
          // devicefx: 未知の道具は危険でない敵 (ユニークを除く) にだけ試す (Haste Monster や Clone を危険な敵に撃たない)
          && !(DEVICEFX && (m.isUnique || choice !== null || lowCLDanger(m, p.level) || meleeTooCostly(m, p)))
          && hasLOS(tiles, px, py, m.x, m.y)) {
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
          const wand = DEVICEFX // devicefx: 届く攻撃の道具で期待ダメージ最大 (名前の表ではなく効果で)
            ? devFx(inv.filter((i: any) => i.tval !== TVAL.STAFF), "attack-target", e => reachOf(e, p.level) >= m.distance)?.it
            : inv.find((i: any) => (i.tval === TVAL.WAND || i.tval === TVAL.ROD) && i.aware !== false
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
        // RULEFIX=devicefx: 逃げる相手には先に Teleport Other、無ければ減速・混乱・睡眠・恐怖の道具 (同じ個体に 3 回まで)
        if (DEVICEFX && choice === "flee" && hasLOS(tiles, px, py, m.x, m.y) && (devCtl.get(key) ?? 0) < 3) {
          const away = devFx(inv, "control", e => /^AWAY/.test(e.sub ?? ""));
          const ctl = away ?? (m.isUnique ? null : devFx(inv, "control", e => !/^AWAY/.test(e.sub ?? "")));
          if (ctl && ctl.it.tval !== TVAL.STAFF) {
            devCtl.set(key, (devCtl.get(key) ?? 0) + 1);
            const turnBefore = state.turn;
            devFxNote(away ? "away" : `control:${ctl.entry.sub}`);
            addLesson(state.turn, state.depth, "魔法の道具", `${m.name}(Lv${m.level},dist${m.distance})から逃げる前に${ctl.it.desc ?? ctl.it.name} (${ctl.entry.sub})`);
            state = await sendCommand(devCmd(ctl.it, { x: m.x, y: m.y }));
            if (state.turn !== turnBefore) { acted = true; break; }
            deviceEmpty.add(`${ctl.it.tval}:${ctl.it.name}`);
          }
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
      // RULEFIX=devicefx: 危険な敵から逃げる前に Teleport Other (同じ個体に 3 回まで)
      if (DEVICEFX && hasLOS(tiles, px, py, dangerMon.x, dangerMon.y) && (devCtl.get(fkey(dangerMon)) ?? 0) < 3) {
        const away = devFx(inv, "control", e => /^AWAY/.test(e.sub ?? ""));
        if (away && away.it.tval !== TVAL.STAFF) {
          devCtl.set(fkey(dangerMon), (devCtl.get(fkey(dangerMon)) ?? 0) + 1);
          const turnBefore = state.turn;
          devFxNote("away");
          addLesson(state.turn, state.depth, "魔法の道具", `危険な${dangerMon.name}(Lv${dangerMon.level},dist${dangerMon.distance})に${away.it.desc ?? away.it.name}`);
          state = await sendCommand(devCmd(away.it, { x: dangerMon.x, y: dangerMon.y }));
          if (state.turn !== turnBefore) continue;
          deviceEmpty.add(`${away.it.tval}:${away.it.name}`);
        }
      }
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

      // RULEFIX=spellfight: 逃げる前に、その敵を遠くへ飛ばす・遅くする・眠らせる・混乱させる呪文 (成功率 60% 以上、見えている時)
      if (SPELLFIGHT && canCastSpells && hasLOS(tiles, px, py, dangerMon.x, dangerMon.y)) {
        const ctl = fxSpell(p, "control", e => !e.area && /^(AWAY_|MON_SLOW|MON_CONF|MON_SLEEP|MON_HOLD)/.test(e.sub ?? ""));
        if (ctl && ctl.failRate <= 40) {
          spellsUsed++; fxNote("control");
          addLesson(state.turn, state.depth, "呪文で制御", `${dangerMon.name}(dist${dangerMon.distance})に${ctl.name}`);
          state = await sendCommand({ type: CMD.CAST, spellIndex: ctl.index, target: { x: dangerMon.x, y: dangerMon.y } });
          continue;
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
          if (escapeIsLong(escSpell)) { stuckCount = 0; noProgressCount = 0; }
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

    // === RULEFIX=auditfix: 怯えていて隣に起きた敵 → 殴れない。恐怖を治す薬、呪文、射撃、投擲、離れる、Phase Door の順 ===
    if ((AUDITFIX && (p.timed.afraid ?? 0) > 0) || (FEARFIX && fearBlocked(p))) {
      const adjAwake = monsters.filter((m: any) => m.distance <= 1 && m.asleep !== true);
      // fearfix: 時限の恐怖なしで殴れない → 恐怖の元の装備を外す (性質が分かっている物、無ければ呪いのある指輪・アミュレット)
      const fearItem = FEARFIX && fearPerm && (p.timed.afraid ?? 0) === 0
        ? ((p.equipment ?? []) as any[]).find((e: any) => (e.kflags ?? []).includes(OF_AFRAID))
          ?? ((p.equipment ?? []) as any[]).find((e: any) => (e.tval === TVAL.RING || e.tval === TVAL.AMULET) && (e.kcurses ?? 0) > 0)
        : undefined;
      if (fearItem && !fearShunned.has(fearItem.name)) {
        fearShunned.add(fearItem.name); fearPerm = false; fearOffs++;
        addLesson(state.turn, state.depth, "恐怖", `怯えていないのに殴れない: ${fearItem.desc ?? fearItem.name} が恐怖の元。外して二度と着けない`);
        state = await sendCommand({ type: CMD.UNEQUIP, itemIndex: fearItem.slot });
        continue;
      }
      if (adjAwake.length > 0) {
        const tgt = [...adjAwake].sort((a: any, b: any) => (a.hp ?? 99) - (b.hp ?? 99))[0];
        const potion = inv.find((i: any) => i.qty > 0 && (i.tval === TVAL.POTION || i.tval === TVAL.FOOD)
          && itemRoles(i).some(e => e.role === "cure" && e.sub === "AFRAID"));
        const spell = canCastSpells ? fxSpell(p, "cure", e => e.sub === "AFRAID") : null;
        const ammo = findAmmo(p), flask = findOilFlask(inv), phase = findPhaseScroll(inv);
        let away: number | null = null, awayDist = 1;
        for (const d of ALL_DIRS) {
          const [dx, dy] = dirOffsets[d]!;
          const nx = px + dx, ny = py + dy;
          if (!isPassable(tiles, nx, ny) || monsters.some((m: any) => m.x === nx && m.y === ny)) continue;
          const near = Math.min(...adjAwake.map((m: any) => distanceTo(nx, ny, m.x, m.y)));
          if (near > awayDist) { awayDist = near; away = d; }
        }
        let cmd: Record<string, unknown> | null = null, what = "";
        // 隣が動かない敵だけ (キノコ、カビ、ゼリー) なら薬を使わず離れる (smoke46: yellow mushroom patch の隣で Boldness を飲んだ)
        const allStill = adjAwake.every((m: any) => STATIONARY_RE.test(m.name ?? ""));
        if (allStill && away !== null) { cmd = { type: CMD.WALK, direction: away }; what = "離れる"; }
        else if (potion) { cmd = { type: CMD.QUAFF, itemIndex: potion.slot }; what = potion.name; }
        else if (spell) { cmd = { type: CMD.CAST, spellIndex: spell.index, direction: 5 }; what = spell.name; spellsUsed++; }
        else if (ammo !== null) { cmd = { type: CMD.FIRE, target: { x: tgt.x, y: tgt.y }, itemIndex: ammo }; what = "射撃"; }
        else if (flask !== null) { cmd = { type: CMD.THROW, target: { x: tgt.x, y: tgt.y }, itemIndex: flask }; what = "油"; }
        else if (away !== null) { cmd = { type: CMD.WALK, direction: away }; what = "離れる"; }
        else if (phase !== null) { cmd = { type: CMD.READ, itemIndex: phase }; what = "Phase Door"; }
        if (cmd) {
          fearActions++;
          if (fearActions <= 3 || fearActions % 20 === 0) addLesson(state.turn, state.depth, "恐怖", `怯えて${tgt.name}が隣 (殴れない)。${what} (#${fearActions})`);
          state = await sendCommand(cmd);
          continue;
        }
      }
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
      // RULEFIX=spellfight: 隣の起きた敵が攻撃回数より多い → 隣の全員に打つ呪文 (Whirlwind Attack: 1 体 1 回と見る)。
      // 起きた敵 3 体以上が 3 マス以内で HP 60% 未満 → 見えている全員を怯えさせる呪文 (Howl of the Damned)
      if (SPELLFIGHT && canCastSpells) {
        const awakeAdj = adjacentMonsters.filter((m: any) => m.asleep !== true).length;
        const sweep = awakeAdj >= 2 && awakeAdj > (p.numBlows ?? 1)
          ? fxSpell(p, "attack-melee", e => e.sub === "SWEEP", fxReserve(p)) : null;
        const scare = !sweep && hpPct < 0.6 && monsters.filter((m: any) => m.asleep !== true && m.distance <= 3).length >= 3
          ? fxSpell(p, "control", e => !!e.area && /^TURN_/.test(e.sub ?? "")) : null;
        const fx = sweep ?? scare;
        if (fx) {
          spellsUsed++; fxNote(sweep ? "attack-melee" : "control");
          if ((fxCasts[sweep ? "attack-melee" : "control"] ?? 0) <= 3) addLesson(state.turn, state.depth, "呪文で戦う", `隣の敵${awakeAdj}体、HP${Math.round(hpPct * 100)}%。${fx.name}`);
          state = await sendCommand({ type: CMD.CAST, spellIndex: fx.index, direction: 5 });
          continue;
        }
      }
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

      // 攻撃スペルがあれば使う (隣接敵に方向指定)。RULEFIX=spellfight: 期待ダメージが近接より大きい時だけ、目標のマスへ
      if (canCastSpells) {
        let atkSpell = SPELLFIGHT ? fxSpell(p, "attack-target", e => reachOf(e, p.level) >= 1, fxReserve(p)) : findCastableSpell(spells, ATTACK_SPELLS, p.level, sp);
        if (SPELLFIGHT && atkSpell && fxExpected(atkSpell, "attack-target") <= meleeExpected(p)) atkSpell = null;
        if (atkSpell && sp >= atkSpell.mana) {
          spellsUsed++;
          if (SPELLFIGHT) fxNote("attack-target");
          state = await sendCommand(SPELLFIGHT ? { type: CMD.CAST, spellIndex: atkSpell.index, target: { x: target.x, y: target.y } }
            : { type: CMD.CAST, spellIndex: atkSpell.index, direction: dir });
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

    // === RULEFIX=worwait: 町で帰還の発動を待つ (戦闘・逃走の判断はこの前) ===
    if (WORWAIT && !RO_GATE && state.depth === 0 && (p.wordRecall ?? 0) > 0) {
      state = await sendCommand(monsters.length > 0 ? { type: CMD.SEARCH } : { type: CMD.REST, turns: 5 });
      continue;
    }

    // === RULEFIX=tryunknown: 未知の薬を安全な時に飲む ===
    if (TRYUNKNOWN && !RO_GATE && actionCount - lastTryAction >= 5 && (hpPct < 0.75 || state.depth === 0)
        && monsters.every((m: any) => m.distance > 5) && (!(BLINDSAFE || BLINDSAFE2) || findHealingPotion(inv) !== null)) {
      const pot = inv.find((i: any) => i.tval === TVAL.POTION && i.aware === false && i.qty > 0);
      if (pot) {
        lastTryAction = actionCount; potionsTried++;
        addLesson(state.turn, state.depth, "未知の薬", `${pot.name}を試飲 (HP${Math.round(hpPct * 100)}%、#${potionsTried})`);
        state = await sendCommand({ type: CMD.QUAFF, itemIndex: pot.slot });
        continue;
      }
    }

    // === RULEFIX=gearset: 装備や荷物の装備品が変わった時 (安全な時、20 行動に 1 回まで) に一式を見直す ===
    if (GEARSET && !RO_GATE && state.depth >= 1 && actionCount - gearsetAt >= 20 && hpPct >= 0.5 && monsters.every((m: any) => m.distance > 5)) {
      const sig = [p.maxDepth, ...((p.equipment ?? []) as any[]).map((e: any) => `${e.slot}:${e.desc ?? e.name}`),
        ...(inv as any[]).filter((i: any) => gearSlotsOf(i.tval).length > 0).map((i: any) => i.desc ?? i.name)].join("|");
      if (sig !== gearsetSig) {
        gearsetSig = sig; gearsetAt = actionCount;
        if (await gearsetApply(false)) { state = await getState(); continue; }
      }
    }

    // === RULEFIX=invfix: 荷物が満杯、または重すぎて速度が落ちている時に、要らない物を落とす (shedRank の順。重すぎる時は重い物から) ===
    if (INVFIX && !RO_GATE && state.depth >= 1 && actionCount - lastShedAction >= 10 && hpPct >= 0.5 && monsters.every((m: any) => m.distance > 5)) {
      const over = typeof p.burden === "number" && typeof p.burdenSlowAt === "number" ? p.burden - p.burdenSlowAt : 0;
      const full = typeof p.packFree === "number" && p.packFree <= 0;
      const chest = PACKLIGHT && inv.some((i: any) => i.tval === TVAL.CHEST);
      // packlight: 階段の上では落とさない (落とした物は隣のマスに落ち、落としたマスの印が外れて拾い直していた)
      const onStair = PACKLIGHT && [FEAT.UP_STAIR, FEAT.DOWN_STAIR].includes(tiles.find((t: any) => t.x === px && t.y === py)?.feat);
      if ((over > 0 || full || chest) && !onStair) {
        lastShedAction = actionCount;
        // packlight: 山ごとの候補に、山の余り (shedExcess) を加える。重すぎる時は落とす重さの大きい順
        const cand = inv.map((i: any) => ({ i, r: shedRank(i, p.equipment ?? []), q: i.qty ?? 1 })).filter((x: any) => x.r !== null) as { i: any; r: number; q: number }[];
        if (PACKLIGHT) for (const i of inv) {
          const q = shedExcess(i, inv);
          if (q > 0 && (over > 0 || i.tval === TVAL.CHEST) && !cand.some(x => x.i === i)) cand.push({ i, r: i.tval === TVAL.CHEST ? 0 : 3, q });
        }
        const wt = (x: { i: any; q: number }) => (x.i.weight ?? 0) * x.q;
        const c = cand.filter(x => over > 0 || full || x.i.tval === TVAL.CHEST)
          .sort((a, b) => over > 0 ? wt(b) - wt(a) || a.r - b.r : a.r - b.r || wt(b) - wt(a))[0];
        if (c) {
          droppedTiles.add(`${px},${py}`); // 落とした物を拾い直さない
          addLesson(state.turn, state.depth, "持ち物", `${full ? "荷物が満杯" : over > 0 ? `重量超過 ${(over / 10).toFixed(1)}lb` : "宝箱"}。${c.i.name}x${c.q}を落とす (順位${c.r})`);
          const before = floorOids(state);
          state = await sendCommand({ type: CMD.DROP, itemIndex: c.i.slot, quantity: c.q });
          noteDropped(before, state);
          continue;
        }
      }
    }

    // === RULEFIX=gearid: 安全な時 (5 マス以内に敵なし、HP 半分以上、10 行動に 1 回) に装備を見直す ===
    if (GEARID && !RO_GATE && actionCount - lastGearAction >= 10 && hpPct >= 0.5 && monsters.every((m: any) => m.distance > 5)) {
      const equip = p.equipment ?? [];
      let pick: { item: any; why: string; rival?: any } | null = null;
      for (const it of inv) {
        if (!EQUIPPABLE_TVALS.has(it.tval) || it.tval === TVAL.DIGGING || it.tval === TVAL.LIGHT || gearCursed(it)) continue;
        const cur = INVFIX ? equipRival(equip, it.tval) : it.tval === TVAL.RING
          ? (equip.filter((e: any) => e.tval === TVAL.RING).length >= 2 ? equip.find((e: any) => e.tval === TVAL.RING) : undefined)
          : equip.find((e: any) => sameEquipCategory(e.tval, it.tval));
        if (cur && it.tval === TVAL.BOW && launcherFamily(it.name ?? "") !== launcherFamily(cur.name ?? "")) continue;
        const pw = itemPower(it), cpw = cur ? itemPower(cur) : -1;
        // gearweight: 着けない方は手放すとして、残る重さの速度の費用を引く
        const wb = p.burden ?? 0, wIt = burdenCost(wb - (cur?.weight ?? 0), p), wCur = burdenCost(wb - (it.weight ?? 0), p);
        if (!GEARSET && (cur ? pw - wIt > cpw - wCur : pw - wIt > -wCur)) { pick = { item: it, why: `${pw} > ${cur ? cpw : "空き"}${GEARWEIGHT && (wIt || wCur) ? ` (重さ ${wIt.toFixed(1)} / ${wCur.toFixed(1)})` : ""}`, rival: cur }; break; } // 分かっている性質で良い方
        const key = `${it.tval}:${it.sval}`;
        if (gearUnknown(it) && (gearTries.get(key) ?? 0) < 3 && (cur ? pw >= cpw : pw >= 0)) { // 試着: 着ければ明らかな性質が分かる
          gearTries.set(key, (gearTries.get(key) ?? 0) + 1);
          pick = { item: it, why: `試着 {??} ${pw} >= ${cur ? cpw : "空き"}`, rival: cur };
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
        state = await sendCommand(equipCmd(pick.item, pick.rival));
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
        if (packIsFull(p, inv)) {
          // Don't try to pick up — move on to avoid stuck loop
          // (future: drop lowest-value item to make room)
        } else if (FLOORPICK && !floorPickCmd(state, px, py)) {
          // floorpick: 拾う物が無い (印を付けた)
        } else {
        const prevInvCount = inv.length, prevWeight = p.burden;
        state = await sendCommand(floorPickCmd(state, px, py) ?? { type: CMD.PICKUP });
        const newInv = state.player.inventory;
        if (FLOORPICK && state.player.burden === prevWeight) ignoredOids.add(pickOid); // 拾えなかった品は二度と試さない
        if (PACKFULL && newInv.length === prevInvCount) droppedTiles.add(`${px},${py}`); // 拾えなかった: この階では二度と試さない
        if (newInv.length > prevInvCount) {
          for (const item of newInv.slice(prevInvCount)) {
            console.log(`  [拾得] ${item.name} (tval=${item.tval}, ac=${item.ac ?? 0})`);
          }
          // RULEFIX=auditfix: 使えない本や害のある既知の消耗品は拾ったらすぐ落とす (このマスは二度と拾わない)
          const junk = newInv.slice(prevInvCount).find((i: any) => auditJunk(i));
          if (junk) {
            droppedTiles.add(`${px},${py}`);
            console.log(`  [不要品] ${junk.name}を落とす`);
            const before = floorOids(state);
            state = await sendCommand({ type: CMD.DROP, itemIndex: junk.slot, quantity: junk.qty });
            noteDropped(before, state);
            continue;
          }
        }
        // 装備比較: 拾ったものが現装備より良ければ即装備
        const equip2 = state.player.equipment ?? [];
        for (const invItem of state.player.inventory) {
          if (GEARSET) break; // gearset: 一式で選ぶ
          if (!EQUIPPABLE_TVALS.has(invItem.tval)) continue;
          if (INVFIX && invItem.tval === TVAL.LIGHT) continue; // invfix: 光源は光源の規則で
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

    // === RULEFIX=corridor: 動く敵の群れが近い → 開けた場所なら通路へ下がり、通路で待つ ===
    if (CORRIDOR && state.depth >= 1 && !retreatMode && stuckCount < 5 && noProgressCount < 50) {
      const group = monsters.filter((m: any) => m.distance <= 7 && m.asleep !== true && !STATIONARY_RE.test(m.name ?? ""));
      if (group.length < 2) { corridorHold = 0; corridorSteps = 0; }
      else if (actionCount >= corridorOffUntil) {
        const known = new Set<string>();
        for (const t of tiles) if (!t.unknown && PASSABLE_FEATS.has(t.feat)) known.add(`${t.x},${t.y}`);
        const openAt = (x: number, y: number) => {
          let n = 0;
          for (const d of ALL_DIRS) { const [dx, dy] = dirOffsets[d]!; if (known.has(`${x + dx},${y + dy}`)) n++; }
          return n;
        };
        const nearGroup = (x: number, y: number) => group.some((m: any) => Math.max(Math.abs(m.x - x), Math.abs(m.y - y)) <= 1);
        if (openAt(px, py) <= 2) {
          if (corridorHold < CORRIDOR_HOLD) {
            corridorHold++; corridorWaits++;
            state = await sendCommand({ type: CMD.SEARCH }); // C: CMD_HOLD
            continue;
          }
          corridorOffUntil = actionCount + CORRIDOR_OFF; corridorHold = 0; corridorSteps = 0;
        } else if (corridorSteps < CORRIDOR_STEPS) {
          // BFS (既知の床のみ、敵の隣と動かない敵の近くを通らない) で最寄りの通路マスへ
          let dir: number | null = null;
          const seen = new Set<string>([`${px},${py}`]);
          let frontier: { x: number; y: number; first: number }[] = [{ x: px, y: py, first: -1 }];
          for (let step = 1; step <= 6 && dir === null && frontier.length; step++) {
            const next: typeof frontier = [];
            for (const c of frontier) {
              for (const d of ALL_DIRS) {
                const [dx, dy] = dirOffsets[d]!;
                const nx = c.x + dx, ny = c.y + dy, key = `${nx},${ny}`;
                if (seen.has(key) || !known.has(key) || avoidHard.has(key) || avoidSoft.has(key) || nearGroup(nx, ny)) continue;
                if (!canMoveDiag(known, c.x, c.y, dx, dy)) continue;
                seen.add(key);
                const first = c.first === -1 ? d : c.first;
                if (openAt(nx, ny) <= 2) { dir = first; break; }
                next.push({ x: nx, y: ny, first });
              }
              if (dir !== null) break;
            }
            frontier = next;
          }
          if (dir !== null) {
            corridorSteps++; corridorMoves++;
            if (corridorMoves <= 3 || corridorMoves % 20 === 0) addLesson(state.turn, state.depth, "回廊待機",
              `${group.length}体 (${group.slice(0, 3).map((m: any) => m.name).join(", ")}) が接近。開けた場所 (${openAt(px, py)}隣接) から通路へ (#${corridorMoves})`);
            const beforeX = px, beforeY = py;
            state = await sendCommand({ type: CMD.WALK, direction: dir });
            if (state.player.x === beforeX && state.player.y === beforeY) corridorSteps = CORRIDOR_STEPS;
            continue;
          }
        }
      }
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
    if (monsters.filter((m: any) => m.distance <= 3).length === 0 && noProgressCount < 50 && !(PACKFULL && packIsFull(p, inv))) {
      const itemTiles = tiles.filter((t: any) =>
        t.hasObj && (t.x !== px || t.y !== py) &&
        !unreachableItems.has(`${t.x},${t.y}`) && !droppedTiles.has(`${t.x},${t.y}`) && tileWanted(state, t.x, t.y)
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
    const pick6 = currentTile?.hasObj && !packIsFull(p, inv) && !droppedTiles.has(`${px},${py}`) ? floorPickCmd(state, px, py) : null;
    if (pick6) {
      // フロアにアイテムあり → 拾う (pack full時はスキップ)
      const prevInvCount = inv.length, prevWeight = p.burden;
      state = await sendCommand(pick6);
      if (FLOORPICK && state.player.burden === prevWeight) ignoredOids.add(pickOid);
      const newInv = state.player.inventory;
      if (PACKFULL && newInv.length === prevInvCount) droppedTiles.add(`${px},${py}`);
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
        if (GEARSET) break; // gearset: 一式で選ぶ
        if (!EQUIPPABLE_TVALS.has(invItem.tval)) continue;
        if (INVFIX && invItem.tval === TVAL.LIGHT) continue; // invfix: 光源は光源の規則で
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
    levelCtx.kills = killsThisLevel; levelCtx.turns = turnsOnLevel;
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
      .reduce((s: number, i: any) => s + i.qty, 0)
      + (TELESHOP ? inv.filter((i: any) => isTeleStaff(i) && deviceReady(i)).reduce((s: number, i: any) => s + Math.max(1, i.charges ?? 1), 0) : 0); // teleshop: 杖の残り回数
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
    const casterGate = CASTERGATE && /^(Mage|Druid)$/.test(p.class ?? "") && state.depth >= 1 && state.depth <= 4
      && p.level < 2 * state.depth + 1 && turnsOnLevel <= 8000;
    const deepGate = DEEPGATE && state.depth >= 8 && p.level < state.depth + 3;
    const clOk = !casterGate && !deepGate && ((p.level >= Math.floor(state.depth * minClRatio) && p.level >= absoluteMinCl && (state.depth > 3 || state.depth === 0 || p.level >= state.depth + EARLY_CL_MARGIN))
      || (state.depth >= 1 && state.depth <= 3 && p.level >= state.depth + EARLY_CL_MARGIN));

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
    const clCheck = clOk || (veryLongOnLevel && !(deepGate && turnsOnLevel <= tooLongThreshold * 4));
    const equipCheck = equipmentReady || veryLongOnLevel;
    // 耐性ソフトゲート: 不足分×3000ターン追加滞在で降下許可
    const resistCheck = resistOk || turnsOnLevel > resistPenaltyTurns;
    const readyToDescend = !restockTrip && actionCount >= descentHoldUntil && hpPct >= 0.7 && healingOk && escapeOk && resistCheck && equipCheck &&
      ((clCheck && (enoughKills || explorationStalled || tooLongOnLevel || overleveled)) || (lowExplorationEarlyDescent && !casterGate && !deepGate));
    if (process.env.DESCENT_DEBUG && actionCount % 200 === 0) console.log(`  [DESCENT?] ready=${readyToDescend} restock=${restockTrip} hp=${hpPct.toFixed(2)} heal=${healingOk} escape=${escapeOk} resist=${resistCheck} equip=${equipCheck} cl=${clCheck} kills=${enoughKills} stalled=${explorationStalled} tooLong=${tooLongOnLevel} over=${overleveled} lowEarly=${lowExplorationEarlyDescent} stair=${!!findTile(tiles, FEAT.DOWN_STAIR)}`);

    // LLM降下判断: DL15+でLLMに確認（深度ごとに最大2回まで）
    let llmDescentVeto = false;
    // ロールアウト: 記録は降下条件が揃った地点で取られている。復元後はカウンタ等が違うので、最初の 1 回はその地点として扱う
    const rolloutAtPoint = ROLLOUT && !rolloutFired && (ROLLOUT_TYPE === "descend" || ROLLOUT_TYPE === "explore");
    const descendNow = readyToDescend || rolloutAtPoint;
    if (descendNow && ROLLOUT && ROLLOUT_TYPE === "explore" && state.depth >= 1) {
      // explore の質問は収集時、降下地点ごとに (ログモードで) 聞かれた。ルールの答えは「降下」。ロールアウトでは
      // ここで聞いて従う: explore なら ROLLOUT_STAY_ACTIONS だけ留まる (sticky なら降下地点のたびに)
      const ex = await llmShouldExploreMore(state, killsThisLevel, turnsOnLevel);
      if (ex === true) { llmDescentVeto = true; descentHoldUntil = actionCount + ROLLOUT_STAY_ACTIONS; }
    } else if (descendNow && DECISION_ON && (state.depth >= 15 || (WIDE && state.depth >= 1))) {
      const vetoCountKey = `descent_veto_count_${state.depth}`;
      const approvedKey = `descent_approved_${state.depth}`; // 承認済みなら階段まで毎ターン聞き直さない
      const vetoCount = (globalThis as any)[vetoCountKey] ?? 0;
      if (vetoCount < 2 && !(globalThis as any)[approvedKey]) { // 同じ深度で最大2回までLLMに聞く
        const llmOk = await llmShouldDescend(state);
        if (LOGLIKE) await llmShouldExploreMore(state, killsThisLevel, turnsOnLevel); // ログのみ (ルールは降下)
        if (llmOk !== false) (globalThis as any)[approvedKey] = true;
        if (llmOk === false && ROLLOUT) descentHoldUntil = actionCount + ROLLOUT_STAY_ACTIONS;
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

    if (descendNow && !llmDescentVeto) {
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
      } else if (SPELLFX && (stairDetectLevel !== levelEntryTurn || stairDetectTries < 3) && fxSpell(p, "detect-stairs", undefined, fxReserve(p))) {
        // RULEFIX=spellfx: 降りたいのに下り階段を知らない → 階段の感知 (Detect Stairs、Sense Surroundings など)
        if (stairDetectLevel !== levelEntryTurn) { stairDetectLevel = levelEntryTurn; stairDetectTries = 0; }
        stairDetectTries++;
        const sd = fxSpell(p, "detect-stairs", undefined, fxReserve(p))!;
        spellsUsed++; fxNote("detect-stairs");
        addLesson(state.turn, state.depth, "階段感知", `降りたいが下り階段を知らない。${sd.name}`);
        state = await sendCommand({ type: CMD.CAST, spellIndex: sd.index, direction: 5 });
        continue;
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
          if (DIGSKILL) { state = await digSkillStep(); continue; }
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
        if (DIGSKILL) { state = await digSkillStep(); continue; }
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
  if (SPELLFX) console.log(`  呪文 (役割): ${Object.entries(fxCasts).map(([k, v]) => `${k} ${v}`).join(", ") || "なし"}`);
  if (AUDITFIX) console.log(`  恐怖の対処: ${fearActions}回`);
  console.log(`  種族/職業: ${fp.race}/${fp.class}`);
  console.log(`  死亡: ${finalState.dead ? `はい (${deathCause})` : "いいえ"}`);
  console.log(`  行動回数: ${actionCount}`);
  if (LLM_ENABLED) {
    if (RULES_CAUTION) console.log(`  RULES_CAUTION: ${RULES_CAUTION}`);
    console.log(`  LLM: ${LLM_BACKEND} 呼出${llmCallCount}回 (平均${llmCallCount > 0 ? Math.round(llmTotalMs / llmCallCount) : 0}ms, fallbacks ${llmFallbacks})`);
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
  if (CORRIDOR) console.log(`  回廊: 通路へ${corridorMoves}歩, 通路で待機${corridorWaits}回`);
  if (DEVICES2) console.log(`  光の魔法棒: ${lightWandUses}回, 列のオーク計${lightWandOrcs}体`);
  if (DEVICEFX) console.log(`  devicefx: ${JSON.stringify(devFxUses)}`);
  if (BLINDFIGHT) console.log(`  blindfight: ${blindAttacks}`);
  if (BLINDASK) console.log(`  blindask: ${blindAsks} asked, acted ${JSON.stringify(blindActs)}`);
  if (ESCRECALL) console.log(`  escrecall: ${escRecalls} WoR, ${escWalks} walk`);
  if (LOOKAHEAD) console.log(`  lookahead: ${JSON.stringify({ ...lookStats, avg_ms: lookStats.asked ? Math.round(lookStats.ms / lookStats.asked) : 0 })}`);

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
      ...(SPELLFX ? { spellRoles: fxCasts } : {}),
      ...(CONFESC ? { confEsc } : {}),
      ...(FEARFIX ? { fearActions, fearOffs, fearShunned: [...fearShunned] } : {}),
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
