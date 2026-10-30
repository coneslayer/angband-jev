/**
 * Tests for command/combat.ts — Player combat commands.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loc } from "../z/index.js";
import { RNG } from "../z/index.js";
import { BitFlag } from "../z/index.js";
import { createChunk, chunkGetSquare, setFeatureInfo, setViewFeatureTable } from "../cave/index.js";
import { Feat, TerrainFlag, TVal, EquipSlot, ObjectFlag } from "../types/index.js";
import type { FeatureType, FeatureId, MonsterId, Player, Monster, MonsterRace, ObjectType } from "../types/index.js";
import { equipItem, addToInventory } from "../object/gear.js";
import {
  chanceOfMeleeHitBase,
  chanceOfMeleeHit,
  playerMeleeHit,
  chanceOfMissileHitBase,
  cmdAttack,
  cmdFire,
  cmdThrow,
  throwDamage,
  throwRange,
  throwBreakageChance,
  chanceOfThrowHit,
  playerAttackMonster,
} from "./combat.js";

// ── Test helpers ──

function buildTestFeatureInfo(): FeatureType[] {
  const features: FeatureType[] = [];

  function makeFeat(
    fidx: number,
    name: string,
    flags: TerrainFlag[],
  ): FeatureType {
    const bf = new BitFlag(TerrainFlag.MAX);
    for (const f of flags) bf.on(f);
    return {
      name, desc: "", fidx: fidx as FeatureId, mimic: null,
      priority: 0, shopnum: 0, dig: 0, flags: bf,
      dAttr: 0, dChar: ".", walkMsg: "", runMsg: "",
      hurtMsg: "", dieMsg: "", confusedMsg: "",
      lookPrefix: "", lookInPreposition: "", resistFlag: -1,
    };
  }

  features[Feat.NONE] = makeFeat(Feat.NONE, "nothing", []);
  features[Feat.FLOOR] = makeFeat(Feat.FLOOR, "open floor", [
    TerrainFlag.LOS, TerrainFlag.PROJECT, TerrainFlag.PASSABLE,
    TerrainFlag.EASY, TerrainFlag.TRAP, TerrainFlag.OBJECT,
    TerrainFlag.TORCH, TerrainFlag.FLOOR,
  ]);

  return features;
}

function makeTestPlayer(x: number, y: number): Player {
  const bf = new BitFlag(32);
  const elInfo = Array.from({ length: 5 }, () => ({ resLevel: 0, flags: new BitFlag(4) }));
  // skills: [DISARM_PHYS=30, DISARM_MAGIC=20, DEVICE=20, SAVE=40, SEARCH=30,
  //          STEALTH=5, TO_HIT_MELEE=50, TO_HIT_BOW=40, TO_HIT_THROW=30, DIGGING=20]
  const skills = [30, 20, 20, 40, 30, 5, 50, 40, 30, 20];
  const state = {
    statAdd: [0, 0, 0, 0, 0], statInd: [0, 0, 0, 0, 0],
    statUse: [16, 14, 14, 16, 16], statTop: [18, 18, 18, 18, 18],
    skills, speed: 110, numBlows: 200, numShots: 10, numMoves: 0,
    ammoMult: 2, ammoTval: 0, ac: 10, damRed: 0, percDamRed: 0,
    toA: 5, toH: 10, toD: 5, seeInfra: 2, curLight: 1,
    heavyWield: false, heavyShoot: false, blessWield: false, cumberArmor: false,
    flags: bf, pflags: new BitFlag(20), elInfo,
  };
  const upkeep = {
    playing: true, autosave: false, generateLevel: false, onlyPartial: false,
    dropping: false, energyUse: 0, newSpells: 0, notice: 0, update: 0,
    redraw: 0, commandWrk: 0, createUpStair: false, createDownStair: false,
    lightLevel: false, arenaLevel: false, resting: 0, running: 0,
    runningFirstStep: false, totalWeight: 100, invenCnt: 0, equipCnt: 0,
    quiverCnt: 0, rechargePow: 0, stepCount: 0, pathDest: loc(0, 0),
  };
  return {
    race: {} as Player["race"],
    class: { magic: { totalSpells: 0 } } as Player["class"],
    grid: loc(x, y), oldGrid: loc(x, y),
    hitdie: 10, expfact: 100, age: 20, ht: 70, wt: 180,
    au: 100, maxDepth: 0, recallDepth: 0, depth: 1,
    maxLev: 1, lev: 10, maxExp: 0, exp: 0, expFrac: 0,
    mhp: 50, chp: 50, chpFrac: 0, msp: 20, csp: 20, cspFrac: 0,
    statMax: [16, 14, 14, 16, 16], statCur: [16, 14, 14, 16, 16],
    statMap: [0, 1, 2, 3, 4],
    timed: new Array(53).fill(0),
    wordRecall: 0, deepDescent: 0,
    energy: 100, totalEnergy: 0, restingTurn: 0, food: 5000,
    unignoring: 0, spellFlags: [], spellOrder: [],
    fullName: "Test", diedFrom: "", history: "",
    quests: [], totalWinner: false, noscore: 0,
    isDead: false, wizard: false, playerHp: new Array(50).fill(10),
    auBirth: 100, statBirth: [16, 14, 14, 16, 16],
    htBirth: 70, wtBirth: 180,
    body: { name: "humanoid", count: 2, slots: [] },
    shape: null, state, knownState: state, upkeep,
  } as unknown as Player;
}

function makeTestObject(tval: number, sval: number, opts: Partial<ObjectType> = {}): ObjectType {
  return {
    oidx: 1, tval, sval, kind: null, ego: null, artifact: null,
    dd: opts.dd ?? 1, ds: opts.ds ?? 4,
    ac: 0, toH: opts.toH ?? 0, toD: opts.toD ?? 0, toA: 0,
    weight: 10, number: opts.number ?? 1, pval: opts.pval ?? 0,
    timeout: 0, notice: 0,
    flags: new BitFlag(32), modifiers: [], elInfo: [],
    brands: null, slays: null, curses: null,
    origin: 0, originDepth: 0, originRace: null,
    note: 0, held: 0, mimickingMidx: 0,
  } as unknown as ObjectType;
}

function makeRng(seed = 42): RNG {
  const rng = new RNG();
  rng.stateInit(seed);
  return rng;
}

function makeTestMonster(ac: number, hp: number): Monster {
  const race = {
    ridx: 1, name: "test monster", text: "", plural: null,
    base: { name: "test", pain: null },
    avgHp: hp, ac,
    sleep: 10, hearing: 20, smell: 20, speed: 110, light: 0,
  } as unknown as MonsterRace;

  return {
    race, originalRace: null, midx: 1 as MonsterId,
    grid: loc(3, 2), hp, maxhp: hp,
    mTimed: new Int16Array(10), mspeed: 110, energy: 0,
    cdis: 1, mflag: new BitFlag(32),
    mimickedObjIdx: 0, heldObjIdx: 0, attr: 0,
  } as unknown as Monster;
}

// ── Setup ──

beforeAll(() => {
  setFeatureInfo(buildTestFeatureInfo());
  setViewFeatureTable(buildTestFeatureInfo());
});

// ── Tests ──

describe("chanceOfMeleeHitBase", () => {
  it("calculates base melee to-hit from skills and toH", () => {
    const player = makeTestPlayer(5, 5);
    // skills[TO_HIT_MELEE=6] = 50, toH = 10, BTH_PLUS_ADJ = 3, blessWield = false
    // Expected: 50 + (10 + 0) * 3 = 80
    const base = chanceOfMeleeHitBase(player);
    expect(base).toBe(80);
  });

  it("includes bless bonus when blessWield is true", () => {
    const player = makeTestPlayer(5, 5);
    player.state.blessWield = true;
    // Expected: 50 + (10 + 2) * 3 = 86
    const base = chanceOfMeleeHitBase(player);
    expect(base).toBe(86);
  });
});

describe("chanceOfMeleeHit", () => {
  it("returns full chance for visible monsters", () => {
    const player = makeTestPlayer(5, 5);
    const base = chanceOfMeleeHitBase(player);
    expect(chanceOfMeleeHit(player, true)).toBe(base);
  });

  it("returns half chance for invisible monsters", () => {
    const player = makeTestPlayer(5, 5);
    const base = chanceOfMeleeHitBase(player);
    expect(chanceOfMeleeHit(player, false)).toBe(Math.floor(base / 2));
  });
});

describe("playerMeleeHit", () => {
  it("has guaranteed hit rate (never always miss for high to-hit)", () => {
    // With a very high to-hit and low AC, should hit most of the time
    const rng = makeRng();
    let hits = 0;
    const trials = 1000;
    for (let i = 0; i < trials; i++) {
      if (playerMeleeHit(rng, 100, 0)) hits++;
    }
    // Should hit at least 80% of the time (guaranteed 12% + calculated rate)
    expect(hits / trials).toBeGreaterThan(0.8);
  });

  it("has guaranteed miss rate (never 100% for low to-hit)", () => {
    const rng = makeRng();
    let misses = 0;
    const trials = 1000;
    for (let i = 0; i < trials; i++) {
      if (!playerMeleeHit(rng, 0, 100)) misses++;
    }
    // Should miss frequently with toHit=0, AC=100
    // But still has 12% guaranteed hit
    expect(misses / trials).toBeGreaterThan(0.8);
  });

  it("floors to-hit at 9", () => {
    // Even with toHit=1, the effective value should be 9
    const rng = makeRng();
    let hits = 0;
    const trials = 1000;
    for (let i = 0; i < trials; i++) {
      if (playerMeleeHit(rng, 1, 0)) hits++;
    }
    // With effective to-hit 9 and AC 0, should still hit reasonably
    // 12% guaranteed + calculated
    expect(hits / trials).toBeGreaterThan(0.1);
  });
});

describe("chanceOfMissileHitBase", () => {
  it("calculates base missile to-hit from skills and toH", () => {
    const player = makeTestPlayer(5, 5);
    // skills[TO_HIT_BOW=7] = 40, toH = 10, BTH_PLUS_ADJ = 3
    // Expected: 40 + 10 * 3 = 70
    const base = chanceOfMissileHitBase(player);
    expect(base).toBe(70);
  });
});

describe("cmdAttack", () => {
  it("attacks a monster at the target location", () => {
    const chunk = createChunk(10, 10, 1);
    chunkGetSquare(chunk, loc(3, 2)).feat = Feat.FLOOR as FeatureId;
    chunkGetSquare(chunk, loc(3, 2)).mon = 1 as MonsterId;
    const player = makeTestPlayer(2, 2);
    const rng = makeRng();

    const result = cmdAttack(player, chunk, loc(3, 2), rng);
    expect(result.success).toBe(true);
    expect(result.energyCost).toBe(100);
    expect(result.messages.length).toBeGreaterThan(0);
    // Player should produce at least numBlows messages
    // numBlows = 200 / 100 = 2 blows
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
  });

  it("fails when no monster at target", () => {
    const chunk = createChunk(10, 10, 1);
    chunkGetSquare(chunk, loc(3, 2)).feat = Feat.FLOOR as FeatureId;
    const player = makeTestPlayer(2, 2);
    const rng = makeRng();

    const result = cmdAttack(player, chunk, loc(3, 2), rng);
    expect(result.success).toBe(false);
    expect(result.messages[0]).toContain("nothing there to attack");
  });

  it("fails when player is afraid", () => {
    const chunk = createChunk(10, 10, 1);
    chunkGetSquare(chunk, loc(3, 2)).mon = 1 as MonsterId;
    const player = makeTestPlayer(2, 2);
    player.timed[5] = 10; // TimedEffect.AFRAID = 5
    const rng = makeRng();

    const result = cmdAttack(player, chunk, loc(3, 2), rng);
    expect(result.success).toBe(false);
    expect(result.messages[0]).toContain("afraid");
  });

  it("fails when target is out of bounds", () => {
    const chunk = createChunk(5, 5, 1);
    const player = makeTestPlayer(2, 2);
    const rng = makeRng();

    const result = cmdAttack(player, chunk, loc(10, 10), rng);
    expect(result.success).toBe(false);
  });

  it("generates hit or miss messages for each blow", () => {
    const chunk = createChunk(10, 10, 1);
    chunkGetSquare(chunk, loc(3, 2)).mon = 1 as MonsterId;
    const player = makeTestPlayer(2, 2);
    const rng = makeRng();

    const result = cmdAttack(player, chunk, loc(3, 2), rng);
    // Each blow produces at least one message (hit/miss/damage)
    for (const msg of result.messages) {
      const isHitOrMiss =
        msg.includes("hit the monster") ||
        msg.includes("miss the monster") ||
        msg.includes("fail to harm") ||
        msg.includes("It was a"); // critical hit messages
      expect(isHitOrMiss).toBe(true);
    }
  });
});

describe("playerAttackMonster", () => {
  it("resolves attack against a monster object", () => {
    const player = makeTestPlayer(2, 2);
    const mon = makeTestMonster(10, 50);
    const rng = makeRng();

    const result = playerAttackMonster(player, mon, rng);
    expect(result.messages.length).toBeGreaterThan(0);
    // Should either hit or miss
    if (result.hit) {
      expect(result.damage).toBeGreaterThanOrEqual(0);
    } else {
      expect(result.damage).toBe(0);
    }
  });

  it("can kill a low-HP monster", () => {
    const player = makeTestPlayer(2, 2);
    // Monster with only 1 HP — should die on any hit
    const mon = makeTestMonster(0, 1); // AC=0, HP=1
    let killed = false;

    // Try multiple seeds until we get a killing hit
    for (let seed = 0; seed < 50; seed++) {
      const testMon = makeTestMonster(0, 1);
      const rng = makeRng(seed);
      const result = playerAttackMonster(player, testMon, rng);
      if (result.killed) {
        killed = true;
        expect(result.hit).toBe(true);
        expect(testMon.hp).toBeLessThanOrEqual(0);
        expect(result.messages.some(m => m.includes("slain"))).toBe(true);
        break;
      }
    }
    expect(killed).toBe(true);
  });

  it("refuses to attack when player is afraid", () => {
    const player = makeTestPlayer(2, 2);
    player.timed[5] = 10; // TimedEffect.AFRAID = 5
    const mon = makeTestMonster(10, 50);
    const rng = makeRng();

    const result = playerAttackMonster(player, mon, rng);
    expect(result.hit).toBe(false);
    expect(result.damage).toBe(0);
    expect(result.killed).toBe(false);
    expect(result.messages[0]).toContain("afraid");
  });

  it("reduces monster HP on hit", () => {
    const player = makeTestPlayer(2, 2);
    const mon = makeTestMonster(0, 1000); // Low AC, high HP
    const initialHp = mon.hp;

    // Try multiple seeds to ensure we get a hit
    for (let seed = 0; seed < 50; seed++) {
      const testMon = makeTestMonster(0, 1000);
      const rng = makeRng(seed);
      const result = playerAttackMonster(player, testMon, rng);
      if (result.hit && result.damage > 0) {
        expect(testMon.hp).toBe(1000 - result.damage);
        break;
      }
    }
  });
});

describe("cmdFire", () => {
  function setupPlayerWithBow(player: Player): void {
    // Equip a short bow (sval 11 → fires arrows, pval=2 for 2x multiplier)
    const bow = makeTestObject(TVal.BOW, 11, { pval: 2 });
    equipItem(player, bow, EquipSlot.BOW);
    // Add arrows to inventory
    const arrows = makeTestObject(TVal.ARROW, 1, { dd: 1, ds: 6, number: 20 });
    addToInventory(player, arrows);
  }

  it("fires at a monster", () => {
    const chunk = createChunk(10, 10, 1);
    chunkGetSquare(chunk, loc(5, 2)).feat = Feat.FLOOR as FeatureId;
    chunkGetSquare(chunk, loc(5, 2)).mon = 1 as MonsterId;
    chunk.monsters[1] = makeTestMonster(10, 100);
    (chunk.monsters[1] as Monster).grid = loc(5, 2);
    const player = makeTestPlayer(2, 2);
    setupPlayerWithBow(player);
    const rng = makeRng();

    const result = cmdFire(player, chunk, loc(5, 2), rng);
    expect(result.success).toBe(true);
    expect(result.energyCost).toBe(100);
    const hasFireMsg = result.messages.some(
      m => m.includes("missile hits") || m.includes("missile misses") || m.includes("missile kills"),
    );
    expect(hasFireMsg).toBe(true);
  });

  it("fails when no launcher equipped", () => {
    const chunk = createChunk(10, 10, 1);
    chunkGetSquare(chunk, loc(5, 2)).feat = Feat.FLOOR as FeatureId;
    chunkGetSquare(chunk, loc(5, 2)).mon = 1 as MonsterId;
    const player = makeTestPlayer(2, 2);
    const rng = makeRng();

    const result = cmdFire(player, chunk, loc(5, 2), rng);
    expect(result.success).toBe(false);
    expect(result.messages[0]).toContain("no missile launcher");
  });

  it("fails when no monster at target", () => {
    const chunk = createChunk(10, 10, 1);
    chunkGetSquare(chunk, loc(5, 2)).feat = Feat.FLOOR as FeatureId;
    const player = makeTestPlayer(2, 2);
    setupPlayerWithBow(player);
    const rng = makeRng();

    const result = cmdFire(player, chunk, loc(5, 2), rng);
    expect(result.success).toBe(false);
    expect(result.messages[0]).toContain("nothing there to fire at");
  });

  it("fails when target is out of bounds", () => {
    const chunk = createChunk(5, 5, 1);
    const player = makeTestPlayer(2, 2);
    setupPlayerWithBow(player);
    const rng = makeRng();

    const result = cmdFire(player, chunk, loc(10, 10), rng);
    expect(result.success).toBe(false);
  });
});

function floorRow(chunk: ReturnType<typeof createChunk>, y: number, x0: number, x1: number): void {
  for (let x = x0; x <= x1; x++) chunkGetSquare(chunk, loc(x, y)).feat = Feat.FLOOR as FeatureId;
}

/** A thrown object with a kind, as the store/object code would build it. */
function makeThrown(
  name: string, weight: number, dd: number, ds: number,
  flagList: ObjectFlag[], breakPerc: number, tval: number = TVal.FLASK,
): ObjectType {
  const kflags = new BitFlag(ObjectFlag.MAX);
  for (const f of flagList) kflags.on(f);
  const kind = {
    name, weight, tval, flags: kflags,
    base: { breakPerc, maxStack: 40, flags: new BitFlag(ObjectFlag.MAX) },
  };
  const o = makeTestObject(tval, 1, { dd, ds, number: 3 }) as unknown as Record<string, unknown>;
  o.kind = kind;
  o.weight = weight;
  o.flags = new BitFlag(ObjectFlag.MAX);
  return o as unknown as ObjectType;
}

describe("cmdThrow", () => {
  it("throws at a monster", () => {
    const chunk = createChunk(10, 20, 1);
    floorRow(chunk, 2, 0, 12);
    chunkGetSquare(chunk, loc(4, 2)).mon = 1 as MonsterId;
    chunk.monsters[1] = makeTestMonster(10, 100);
    (chunk.monsters[1] as Monster).grid = loc(4, 2);
    const player = makeTestPlayer(2, 2);
    addToInventory(player, makeTestObject(TVal.SWORD, 1, { dd: 2, ds: 5, number: 1 }));
    const result = cmdThrow(player, chunk, loc(4, 2), makeRng(), 0);
    expect(result.success).toBe(true);
    expect(result.energyCost).toBe(100);
    expect(result.messages.some(m => /hits|misses|kills/.test(m))).toBe(true);
  });

  it("throws at empty square (lands on ground)", () => {
    const chunk = createChunk(10, 20, 1);
    floorRow(chunk, 2, 0, 12);
    const player = makeTestPlayer(2, 2);
    addToInventory(player, makeTestObject(TVal.SHOT, 1, { number: 5 }));
    const result = cmdThrow(player, chunk, loc(4, 2), makeRng(), 0);
    expect(result.success).toBe(true);
    expect(result.energyCost).toBe(100);
    expect(result.messages[0]).toContain("lands on the ground");
  });

  it("fails when nothing to throw", () => {
    const chunk = createChunk(5, 5, 1);
    const player = makeTestPlayer(2, 2);
    const result = cmdThrow(player, chunk, loc(3, 3), makeRng(), 0);
    expect(result.success).toBe(false);
    expect(result.messages[0]).toContain("nothing to throw");
  });

  it("fails when target is out of bounds", () => {
    const chunk = createChunk(5, 5, 1);
    const player = makeTestPlayer(2, 2);
    addToInventory(player, makeTestObject(TVal.SHOT, 1));
    expect(cmdThrow(player, chunk, loc(10, 10), makeRng(), 0).success).toBe(false);
  });

  it("rejects targets beyond the throwing range without using the item", () => {
    const chunk = createChunk(10, 40, 1);
    floorRow(chunk, 2, 0, 39);
    const player = makeTestPlayer(2, 2);
    const flask = makeThrown("& Flask~ of oil", 20, 1, 4, [ObjectFlag.THROWING, ObjectFlag.EXPLODE], 100);
    addToInventory(player, flask);
    expect(throwRange(player, flask)).toBe(10); // (3+20)*10/20 = 11 -> capped at 10
    const r = cmdThrow(player, chunk, loc(14, 2), makeRng(), 0);
    expect(r.success).toBe(false);
    expect(r.messages[0]).toContain("out of range");
    expect(flask.number).toBe(3);
  });

  it("rejects targets without line of sight", () => {
    const chunk = createChunk(10, 20, 1);
    floorRow(chunk, 2, 0, 12);
    // wall (no LOS) at x=4 between the player and the target at x=6
    chunkGetSquare(chunk, loc(4, 2)).feat = Feat.NONE as FeatureId;
    const player = makeTestPlayer(2, 2);
    addToInventory(player, makeThrown("& Flask~ of oil", 20, 1, 4, [ObjectFlag.THROWING, ObjectFlag.EXPLODE], 100));
    const r = cmdThrow(player, chunk, loc(6, 2), makeRng(), 0);
    expect(r.success).toBe(false);
    expect(r.messages[0]).toContain("line of sight");
  });

  it("hits the first monster on the path and consumes one flask", () => {
    const chunk = createChunk(10, 20, 1);
    floorRow(chunk, 2, 0, 12);
    chunkGetSquare(chunk, loc(4, 2)).mon = 1 as MonsterId;
    chunk.monsters[1] = makeTestMonster(0, 1000);
    (chunk.monsters[1] as Monster).grid = loc(4, 2);
    const player = makeTestPlayer(2, 2);
    const flask = makeThrown("& Flask~ of oil", 20, 1, 4, [ObjectFlag.THROWING, ObjectFlag.EXPLODE], 100);
    addToInventory(player, flask);
    const rng = makeRng(100);
    const hp0 = chunk.monsters[1]!.hp;
    cmdThrow(player, chunk, loc(8, 2), rng, 0);
    cmdThrow(player, chunk, loc(8, 2), rng, 0);
    cmdThrow(player, chunk, loc(8, 2), rng, 0);
    expect((player as any).inventory.filter((o: unknown) => o).length).toBe(0);
    // the monster at x=4 is on the path to x=8 and is the one struck
    expect(chunk.monsters[1]!.hp).toBeLessThan(hp0);
  });
});

describe("throw damage (4.2.6 make_ranged_throw)", () => {
  it("flask of oil: 1d4 x (2 + 20/12) x EXPLODE 3 = 9..36 in steps of 9 without a critical", () => {
    const player = makeTestPlayer(2, 2);
    const mon = makeTestMonster(0, 1000);
    const flask = makeThrown("& Flask~ of oil", 20, 1, 4, [ObjectFlag.THROWING, ObjectFlag.EXPLODE], 100);
    const seen = new Set<number>();
    const rng = makeRng(7);
    for (let i = 0; i < 400; i++) {
      const r = throwDamage(player, mon, flask, rng);
      if (r.critMsg) continue;
      expect(r.damage % 9).toBe(0);
      expect(r.damage).toBeGreaterThanOrEqual(9);
      expect(r.damage).toBeLessThanOrEqual(36);
      seen.add(r.damage);
    }
    expect(seen.size).toBe(4);
  });

  it("throwing spear gets 2 + 50/12 = 6x; to-dam is added before the multiplier", () => {
    const player = makeTestPlayer(2, 2);
    const mon = makeTestMonster(0, 1000);
    const spear = makeThrown("& Spear~", 50, 1, 6, [ObjectFlag.THROWING], 1, TVal.POLEARM);
    (spear as { toD: number }).toD = 2;
    const rng = makeRng(7);
    for (let i = 0; i < 200; i++) {
      const r = throwDamage(player, mon, spear, rng);
      if (r.critMsg) continue;
      expect(r.damage % 6).toBe(0);
      expect(r.damage).toBeGreaterThanOrEqual(18); // (1+2)*6
      expect(r.damage).toBeLessThanOrEqual(48); // (6+2)*6
    }
  });

  it("non-throwing objects get no weight multiplier and no player to-dam", () => {
    const player = makeTestPlayer(2, 2);
    const mon = makeTestMonster(0, 1000);
    const sword = makeThrown("& Dagger~", 12, 1, 4, [], 25, TVal.SWORD);
    const rng = makeRng(7);
    for (let i = 0; i < 100; i++) {
      const r = throwDamage(player, mon, sword, rng);
      if (r.critMsg) continue;
      expect(r.damage).toBeGreaterThanOrEqual(1);
      expect(r.damage).toBeLessThanOrEqual(4);
    }
  });

  it("to-hit: throwing weapons use full skill + player to-hit, others 3/2 skill; distance subtracts", () => {
    const player = makeTestPlayer(2, 2); // skill 30, toH 10
    const spear = makeThrown("& Spear~", 50, 1, 6, [ObjectFlag.THROWING], 1, TVal.POLEARM);
    const dagger = makeThrown("& Dagger~", 12, 1, 4, [], 25, TVal.SWORD);
    expect(chanceOfThrowHit(player, spear, 4)).toBe(30 + 10 * 3 - 4);
    expect(chanceOfThrowHit(player, dagger, 4)).toBe(45 - 4);
  });

  it("breakage: throwing weapons 1%, flasks base 100%, misses square the chance", () => {
    const spear = makeThrown("& Spear~", 50, 1, 6, [ObjectFlag.THROWING], 25, TVal.POLEARM);
    const flask = makeThrown("& Flask~ of oil", 20, 1, 4, [ObjectFlag.THROWING, ObjectFlag.EXPLODE], 100);
    const dagger = makeThrown("& Dagger~", 12, 1, 4, [], 50, TVal.SWORD);
    expect(throwBreakageChance(spear, true)).toBe(1);
    expect(throwBreakageChance(flask, true)).toBe(100);
    expect(throwBreakageChance(flask, false)).toBe(100);
    expect(throwBreakageChance(dagger, true)).toBe(50);
    expect(throwBreakageChance(dagger, false)).toBe(25);
  });
});
