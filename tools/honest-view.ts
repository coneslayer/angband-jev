/**
 * @file honest-view.ts
 * @brief Adapts the server's /state?view=player into the fields the rules player reads.
 *
 * The player view (packages/@angband/core/src/borg/perception.ts) shows only what the UI
 * shows: health as words, lore that starts empty, visible and remembered monsters, the seen
 * map, hunger as a word. The rules player was written against exact numbers, so this adapter
 * fills them with estimates built only from that view plus generic priors:
 *   - unknown monster level: the dungeon level;
 *   - max HP: a power law in level, fitted once over all monsters (and separately over all
 *     uniques), so it encodes nothing about any particular monster;
 *   - current HP: max HP times the midpoint of the health word's band;
 *   - spells, breaths, summons: only those seen cast;
 *   - breeders: six or more of one non-unique race seen on this level;
 *   - the map frontier: every unknown square next to a known floor or door square is offered as
 *     unvisited floor (marked `unknown: true`). The rules explorer only walks to known unvisited
 *     squares, so without this it stalls in any pocket whose exits are doors or unlit edges
 *     (e.g. after a Phase Door into the dark). A wrong guess costs a step, and the square is
 *     then seen for what it is.
 * Fields the player can't know stay false/0 (immunities, PASS_WALL, spell frequency unless
 * spells were seen). The honest originals stay on each monster for the decision prompt.
 */

const HEALTH_FRAC: Record<string, number> = {
  unhurt: 1, undamaged: 1,
  "somewhat wounded": 0.8, "somewhat damaged": 0.8,
  wounded: 0.42, damaged: 0.42,
  "badly wounded": 0.17, "badly damaged": 0.17,
  "almost dead": 0.05, "almost destroyed": 0.05,
};

// Hunger word → a representative nourishment value, so the existing thresholds keep working
const HUNGER_FOOD: Record<string, number> = {
  Starving: 50, Faint: 300, Weak: 800, Hungry: 1500, Fed: 6000, Full: 12000,
};

const ELEMENT_WORDS: [RegExp, string][] = [
  [/acid/, "ACID"], [/lightning|elec/, "ELEC"], [/fire/, "FIRE"], [/frost|cold/, "COLD"],
  [/poison|stinking/, "POIS"], [/nether/, "NETHER"],
];

export function estimatedMaxHp(level: number, unique: boolean): number {
  const l = Math.max(1, level);
  return Math.max(5, Math.round(unique ? 7.5 * Math.pow(l, 1.5) : 1.7 * Math.pow(l, 1.48)));
}

// Floor, doors, stairs, passable rubble: squares a frontier can open out from
const OPEN_FEATS = new Set([1, 2, 3, 4, 5, 6, 24]);

function withFrontier(tiles: any[]): any[] {
  const known = new Set<string>();
  for (const t of tiles) known.add(`${t.x},${t.y}`);
  const extra: any[] = [];
  for (const t of tiles) {
    if (!OPEN_FEATS.has(t.feat)) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = `${t.x + dx},${t.y + dy}`;
      if (known.has(k)) continue;
      known.add(k);
      extra.push({ x: t.x + dx, y: t.y + dy, feat: 1, lit: false, hasObj: false, mon: 0, unknown: true });
    }
  }
  return extra.length ? tiles.concat(extra) : tiles;
}

export function adaptPlayerView(state: any): any {
  if (!state || state.view !== "player") return state;
  const depth = Math.max(1, state.depth ?? 1);
  const all: any[] = state.monsters ?? [];
  const counts = new Map<string, number>();
  for (const m of all) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);

  const visible = all.filter(m => m.visible).map((m) => {
    const level = m.level ?? depth;
    const maxhp = estimatedMaxHp(level, !!m.isUnique);
    const frac = HEALTH_FRAC[m.health ?? "unhurt"] ?? 1;
    const spells: string[] = m.spellsSeen ?? [];
    const spellElements = [...new Set(spells.filter(s => !s.startsWith("breathe "))
      .flatMap(s => ELEMENT_WORDS.filter(([rx]) => rx.test(s)).map(([, e]) => e)))];
    return {
      ...m,
      level,
      levelKnown: m.level != null,
      maxhp,
      hp: Math.max(1, Math.round(maxhp * frac)),
      speed: m.speed ?? 110,
      isBreeder: !m.isUnique && (counts.get(m.name) ?? 0) >= 6,
      spellElements,
      // Seen casting: assume a moderate frequency (percent per turn, as the server reports it)
      freqSpell: spells.some(s => !s.startsWith("breathe ")) ? 15 : 0,
      freqInnate: (m.breathElements ?? []).length ? 15 : 0,
      hasPassWall: false,
      isEvil: (m.kinds ?? []).includes("evil"), isUndead: (m.kinds ?? []).includes("undead"),
      isDragon: (m.kinds ?? []).includes("dragon"), isDemon: (m.kinds ?? []).includes("demon"),
      isAnimal: (m.kinds ?? []).includes("animal"), isOrc: (m.kinds ?? []).includes("orc"),
      isTroll: (m.kinds ?? []).includes("troll"), isGiant: (m.kinds ?? []).includes("giant"),
      imAcid: false, imElec: false, imFire: false, imCold: false, imPois: false,
    };
  });
  const p = state.player ?? {};
  return {
    ...state,
    map: state.map ? { ...state.map, tiles: withFrontier(state.map.tiles ?? []) } : state.map,
    monsters: visible,
    rememberedMonsters: all.filter(m => !m.visible),
    player: { ...p, timed: { ...(p.timed ?? {}), food: HUNGER_FOOD[p.hunger] ?? 6000 } },
  };
}
