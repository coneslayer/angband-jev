/**
 * @file spell-roles.ts
 * @brief What a spell does, from its effects, and what the character can do now (spells and items), by role.
 *
 * The C bridge sends each spell as the book browser shows it: the Info column, the description and the effect chain
 * those are built from (effect code, subtype, dice at the current level, radius). Rules ask for a role ("cure
 * POISONED", "escape-short") instead of naming spells, so every class and book works the same way, including dungeon
 * books found later. See docs/finetune-laya-plan.md, "Spellcasting by effect".
 *
 * resources() lists, per role, every way to do it now: castable spells and carried items, with cost, fail and
 * expected amount. The rules, the danger logger and the decision prompts read it.
 */

export type Role =
  | "heal" | "cure" | "nourish"
  | "escape-short" | "escape-long" | "escape-level" | "recall"
  | "detect-monsters" | "detect-stairs" | "detect-objects" | "detect-traps" | "light"
  | "buff"
  | "attack-target" | "attack-area" | "attack-melee" | "control" | "dig";

/** Role order for the danger logger's `rs` and the prompts (append only: the logger's header records the version) */
export const ROLE_ORDER: Role[] = [
  "heal", "cure", "nourish", "escape-short", "escape-long", "escape-level", "recall",
  "detect-monsters", "detect-stairs", "detect-objects", "detect-traps", "light", "buff",
  "attack-target", "attack-area", "attack-melee", "control", "dig",
];
export const ROLES_VERSION = 1;

export interface SpellEffect {
  e: string; sub: string; base: number; dice: number; sides: number; bonus: number;
  radius: number; other: number; y: number; x: number; avg?: number;
}

export interface RoleEntry {
  role: Role;
  /** the status cured, the timed effect a buff gives, the projection an attack carries */
  sub?: string;
  /** HP healed, squares teleported, turns of a buff, average damage, food: bigger is more */
  amount: number;
  /** buffs: offence, defence, speed or utility */
  kind?: "offence" | "defence" | "speed" | "utility";
  /** attacks: a ball/arc/sphere/area that hits more than one monster */
  area?: boolean;
}

/** Statuses a cure can lift, as busho's `timed` names them */
export const CURE_STATUS: Record<string, string> = {
  POISONED: "poisoned", CUT: "cut", STUN: "stun", AFRAID: "afraid", CONFUSED: "confused", BLIND: "blind",
};

const BUFF_KIND: Record<string, RoleEntry["kind"]> = {
  BLESSED: "offence", HERO: "offence", SHERO: "offence", ATT_EVIL: "offence", ATT_DEMON: "offence",
  ATT_POIS: "offence",
  PROTEVIL: "defence", STONESKIN: "defence", SHIELD: "defence",
  OPP_ACID: "defence", OPP_ELEC: "defence", OPP_FIRE: "defence", OPP_COLD: "defence", OPP_POIS: "defence",
  FAST: "speed",
  SINVIS: "utility", FREE_ACT: "utility", OPP_CONF: "utility",
};

/** Projections that hurt (almost) every monster; LIGHT_WEAK and DARK_WEAK hurt only some, the KILL_/MAKE_ ones none */
function hurtsMonsters(proj: string): boolean {
  return !/^(LIGHT_WEAK|DARK_WEAK|KILL_|MAKE_|AWAY_|TURN_|SLEEP_|MON_(SLOW|CONF|HOLD|SLEEP|STUN|SPEED|HEAL|CLONE))/.test(proj);
}
/** Monster-status projections: slow, confuse, hold, sleep, scare, teleport away */
function controls(proj: string): boolean {
  return /^(MON_SLOW|MON_CONF|MON_HOLD|MON_SLEEP|MON_STUN|SLEEP_|TURN_|AWAY_)/.test(proj);
}

function avgOf(e: SpellEffect): number {
  if (typeof e.avg === "number") return e.avg;
  return Math.max(0, e.base + (e.dice > 0 && e.sides > 0 ? e.dice * (e.sides + 1) / 2 : 0));
}

/** The roles of one spell, from its effects. A spell with none (identify, recharge, shapechange...) returns []. */
export function rolesOf(spell: { effects?: SpellEffect[] }): RoleEntry[] {
  const out: RoleEntry[] = [];
  for (const e of spell.effects ?? []) {
    const a = avgOf(e);
    switch (e.e) {
      case "HEAL_HP":
        out.push({ role: "heal", amount: a }); break;
      case "CURE": case "TIMED_DEC":
        if (CURE_STATUS[e.sub]) out.push({ role: "cure", sub: e.sub, amount: 1 }); break;
      case "NOURISH":
        if (e.sub !== "DEC_BY") out.push({ role: "nourish", amount: a }); break;
      case "TELEPORT":
        if (e.sub === "1") break; // TELEPORT:AWAY
        // m_bonus: "a weird random thing", a long random teleport (Teleport Self)
        if (e.bonus > 0 || a > 15) out.push({ role: "escape-long", amount: e.bonus > 0 ? 100 : a });
        else if (a > 0) out.push({ role: "escape-short", amount: a });
        break;
      case "TELEPORT_LEVEL": out.push({ role: "escape-level", amount: 1 }); break;
      case "RECALL": out.push({ role: "recall", amount: 1 }); break;
      case "DETECT_VISIBLE_MONSTERS": case "DETECT_INVISIBLE_MONSTERS": case "DETECT_LIVING_MONSTERS":
      case "DETECT_EVIL": case "DETECT_FEARFUL_MONSTERS": case "DETECT_SOUL":
        out.push({ role: "detect-monsters", sub: e.e, amount: 1 }); break;
      case "DETECT_STAIRS": case "MAP_AREA": case "LIGHT_LEVEL":
        out.push({ role: "detect-stairs", sub: e.e, amount: 1 }); break;
      case "DETECT_OBJECTS": case "SENSE_OBJECTS": case "DETECT_GOLD": case "SENSE_GOLD":
        out.push({ role: "detect-objects", sub: e.e, amount: 1 }); break;
      case "DETECT_TRAPS": out.push({ role: "detect-traps", amount: 1 }); break;
      case "LIGHT_AREA": out.push({ role: "light", amount: 1 }); break;
      case "TIMED_INC":
        if (BUFF_KIND[e.sub]) out.push({ role: "buff", sub: e.sub, amount: a, kind: BUFF_KIND[e.sub] }); break;
      case "BOLT": case "BEAM": case "BOLT_OR_BEAM": case "BOLT_AWARE": case "BOLT_STATUS": case "BOLT_STATUS_DAM":
      case "SHORT_BEAM": case "LINE": case "SPOT": case "STRIKE": case "SWARM": case "BALL": case "ARC":
        if (e.sub === "KILL_WALL") { out.push({ role: "dig", amount: 1 }); break; }
        if (controls(e.sub)) { out.push({ role: "control", sub: e.sub, amount: 1 }); break; }
        if (hurtsMonsters(e.sub) && a > 0)
          out.push({ role: "attack-target", sub: e.sub, amount: e.e === "SWARM" ? a * Math.max(1, e.bonus) : a,
            area: e.e === "BALL" || e.e === "ARC" || e.e === "STRIKE" || e.e === "SWARM" });
        break;
      case "SPHERE":
        if (hurtsMonsters(e.sub) && a > 0) out.push({ role: "attack-area", sub: e.sub, amount: a, area: true }); break;
      case "PROJECT_LOS": case "PROJECT_LOS_AWARE":
        if (controls(e.sub)) out.push({ role: "control", sub: e.sub, amount: 1, area: true });
        else if (hurtsMonsters(e.sub)) out.push({ role: "attack-area", sub: e.sub, amount: a, area: true });
        break;
      case "TOUCH_AWARE":
        if (controls(e.sub)) out.push({ role: "control", sub: e.sub, amount: 1 }); break;
      case "SWEEP": out.push({ role: "attack-melee", sub: "SWEEP", amount: 1, area: true }); break;
      case "MOVE_ATTACK": out.push({ role: "attack-melee", sub: "MOVE_ATTACK", amount: 1 }); break;
      case "MELEE_BLOWS": out.push({ role: "attack-melee", sub: "MELEE_BLOWS", amount: Math.max(1, e.base) }); break;
    }
  }
  return out;
}

export interface SpellLike {
  name: string; index: number; level: number; mana: number; failRate: number; learned: boolean;
  effects?: SpellEffect[];
}

export interface Means {
  kind: "spell" | "item";
  /** spell index, or the item's inventory slot */
  ref: number;
  name: string;
  /** SP for a spell; 0 for an item */
  cost: number;
  /** percent */
  fail: number;
  amount: number;
  /** items carried, or casts the current SP pays for */
  uses: number;
  entry: RoleEntry;
}

/** A spell the character can cast now: learned, level, mana, fail under the cap */
export function castable(s: SpellLike, level: number, sp: number, maxFail = 80): boolean {
  return s.learned && s.level <= level && s.mana <= sp && s.failRate < maxFail;
}

/** The castable spells with a role, best first (amount times success per mana; cures and escapes: cheapest first) */
export function spellsFor(spells: SpellLike[], level: number, sp: number, role: Role,
  pick: (e: RoleEntry) => boolean = () => true, maxFail = 80): { spell: SpellLike; entry: RoleEntry }[] {
  const out: { spell: SpellLike; entry: RoleEntry }[] = [];
  for (const s of spells) {
    if (!castable(s, level, sp, maxFail)) continue;
    const e = rolesOf(s).find(r => r.role === role && pick(r));
    if (e) out.push({ spell: s, entry: e });
  }
  const ok = (x: { spell: SpellLike }) => 1 - x.spell.failRate / 100;
  const cheapFirst = role === "cure" || role === "escape-short" || role === "nourish" || role.startsWith("detect");
  out.sort((a, b) => cheapFirst
    ? (a.spell.mana / ok(a)) - (b.spell.mana / ok(b))
    : (b.entry.amount * ok(b)) - (a.entry.amount * ok(a)));
  return out;
}

/** Item kinds by role, from the names the player knows them by (items aren't sent by effect yet) */
const ITEM_ROLES: [number, RegExp, RoleEntry][] = [
  [26, /^Cure Light Wounds$/, { role: "heal", amount: 20 }],
  [26, /^Cure Serious Wounds$/, { role: "heal", amount: 40 }],
  [26, /^Cure Critical Wounds$/, { role: "heal", amount: 60 }],
  [26, /^Cure Critical Wounds$/, { role: "cure", sub: "POISONED", amount: 1 }],
  [26, /^Neutralize Poison$/, { role: "cure", sub: "POISONED", amount: 1 }],
  [25, /^Phase Door$/, { role: "escape-short", amount: 10 }],
  [25, /^(Teleportation|Teleport)$/, { role: "escape-long", amount: 100 }],
  [25, /^Deep Descent$/, { role: "escape-level", amount: 1 }],
  [25, /^Word of Recall$/, { role: "recall", amount: 1 }],
  [28, /./, { role: "nourish", amount: 1 }],
];

/** The roles of a carried item: from its effects once its kind is known (the bridge's `keffects`, what the item's
 * description says), else from the name the player knows it by (flasks of oil have no effect; the TS engine sends none) */
export function itemRoles(it: any): RoleEntry[] {
  if (!it || it.aware === false) return [];
  if (Array.isArray(it.keffects) && it.keffects.length) return rolesOf({ effects: it.keffects });
  return ITEM_ROLES.filter(([tval, rx]) => it.tval === tval && rx.test(it.name ?? "")).map(([, , e]) => e);
}

/** Statuses an item or spell inflicts on the user, and effects that hurt the user (from known effects) */
const HARMFUL_TIMED = new Set(["POISONED", "BLIND", "CONFUSED", "PARALYZED", "IMAGE", "AMNESIA", "SLOW", "SCRAMBLE"]);
const HARMFUL_EFFECTS = new Set(["DRAIN_STAT", "LOSE_RANDOM_STAT", "LOSE_EXP", "SUMMON", "WAKE", "DARKEN_AREA",
  "DEEP_DESCENT", "CURSE_ARMOR", "CURSE_WEAPON", "DAMAGE"]);
/** A known potion, scroll or mushroom that harms the user (Poison, Blindness, Sleep, Salt Water, Aggravate Monsters,
 * Summon Undead, Deep Descent...) */
export function itemHarmful(it: any): boolean {
  if (!it || it.aware === false || !Array.isArray(it.keffects)) return false;
  return it.keffects.some((e: SpellEffect) => HARMFUL_EFFECTS.has(e.e)
    || ((e.e === "TIMED_INC" || e.e === "TIMED_INC_NO_RES" || e.e === "TIMED_SET") && HARMFUL_TIMED.has(e.sub))
    || (e.e === "NOURISH" && (e.sub === "DEC_BY" || e.sub === "SET_TO")));
}

/** Every way to do each role now: castable spells (uses = casts the current SP pays for) and carried items */
export function resources(p: any): Map<Role, Means[]> {
  const out = new Map<Role, Means[]>();
  const add = (m: Means) => { const l = out.get(m.entry.role) ?? []; l.push(m); out.set(m.entry.role, l); };
  const sp = p.sp ?? 0;
  for (const s of (p.spells ?? []) as SpellLike[]) {
    if (!castable(s, p.level ?? 1, sp)) continue;
    for (const e of rolesOf(s)) {
      add({ kind: "spell", ref: s.index, name: s.name, cost: s.mana, fail: s.failRate, amount: e.amount,
        uses: s.mana > 0 ? Math.floor(sp / s.mana) : 99, entry: e });
    }
  }
  for (const it of p.inventory ?? []) {
    if (!(it.qty > 0) || it.aware === false) continue;
    for (const e of itemRoles(it))
      add({ kind: "item", ref: it.slot, name: it.name, cost: 0, fail: 0, amount: e.amount, uses: it.qty, entry: e });
  }
  return out;
}

/** Per role in ROLE_ORDER: [available now, uses left, best amount, best fail %] (the danger logger's `rs`) */
export function resourceVector(p: any): number[][] {
  const r = resources(p);
  return ROLE_ORDER.map(role => {
    const l = r.get(role) ?? [];
    if (l.length === 0) return [0, 0, 0, 0];
    const uses = l.reduce((s, m) => s + m.uses, 0);
    return [1, Math.min(uses, 99), Math.max(...l.map(m => m.amount)), Math.min(...l.map(m => m.fail))];
  });
}

/** One line per role the character has, for the decision prompts: "Escapes: Phase Door scroll x3, ..." */
export function resourceLines(p: any): string[] {
  const r = resources(p);
  const label: Partial<Record<Role, string>> = {
    "heal": "Healing", "cure": "Cures", "nourish": "Food", "escape-short": "Short escapes",
    "escape-long": "Teleports", "escape-level": "Level escapes", "recall": "Recall", "buff": "Buffs",
    "attack-target": "Attack spells", "attack-area": "Area attacks", "attack-melee": "Melee spells",
    "control": "Monster control", "detect-monsters": "Monster detection", "detect-stairs": "Stair detection",
  };
  const lines: string[] = [];
  for (const role of ROLE_ORDER) {
    const l = r.get(role);
    if (!l || !label[role]) continue;
    const parts = l.map(m => m.kind === "item"
      ? `${m.name} x${m.uses}`
      : `${m.name} spell (${m.cost} mana, ${m.fail}% fail${m.entry.sub ? `, ${m.entry.sub}` : ""}, ${m.uses} casts)`);
    lines.push(`${label[role]}: ${[...new Set(parts)].join(", ")}`);
  }
  return lines;
}
