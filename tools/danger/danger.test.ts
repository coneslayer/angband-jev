import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DangerLogger, MF, cutGrade, dangerRecord, readDangerLog, stunGrade, type DangerRecord } from "./record.js";
import { CATEGORICAL, FEATURE_NAMES, Featurizer, defaultVocab, handDamage } from "./features.js";
import { LABEL_NAMES, STAGE_HORIZON, labelGame, timedRecords } from "./labels.js";
import { NpyWriter, build } from "./build.js";
import { DangerModel, type DangerModelJson } from "./model.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "danger-"));

/** A minimal record; the label tests only read a, t, d, hp, mhp and dead. */
function rec(a: number, t: number, hp: number, extra: Partial<DangerRecord> = {}): DangerRecord {
  return {
    a, t, d: 1, cl: 1, hp, mhp: 20, sp: 0, msp: 0, spd: 110, ac: 5, bl: 1, wd: 4, th: 0, li: 1,
    tm: [0, 0, 0, 0, 0, 0, 0, 0, 0], hu: 4, inv: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], lm: 0, cs: [0, 0], os: 0,
    sd: [-1, -1], lt: 0, m: [], nv: 0, nr: 0, rd: -1, ...extra,
  };
}
const col = (rows: Float64Array[], name: string) => rows.map(r => r[LABEL_NAMES.indexOf(name)]!);

describe("status grades", () => {
  it("follow player_timed.txt", () => {
    expect([0, 1, 10, 11, 25, 26, 50, 100, 101, 200, 1000, 1001].map(cutGrade)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 7]);
    expect([0, 1, 50, 51, 150, 151].map(stunGrade)).toEqual([0, 1, 1, 2, 2, 3]);
  });
});

describe("dangerRecord", () => {
  const state = {
    turn: 500, depth: 2, levelFeeling: 3, view: "player",
    player: {
      x: 10, y: 10, hp: 12, maxHp: 20, sp: 0, maxSp: 0, level: 3, speed: 110, ac: 10, numBlows: 2, toH: 3, toD: 1, light: 2,
      timed: { poisoned: 4, cut: 30, stun: 0 }, hunger: "Hungry",
      inventory: [{ tval: 26, name: "Cure Light Wounds", qty: 3 }, { tval: 25, name: "Phase Door", qty: 2 }, { tval: 27, name: "Flask of Oil", qty: 5 }],
      equipment: [{ tval: 9, dd: 2, ds: 5, toD: 2, name: "Dagger" }, { tval: 5, name: "Sling" }],
      spells: [],
    },
    map: { tiles: [{ x: 10, y: 10, feat: 6 }, { x: 14, y: 12, feat: 5 }] },
    monsters: [
      { name: "cave spider", distance: 3, health: "wounded", level: 2, levelKnown: true, speed: 120, sights: 3, blowsSeen: [{ dice: "1d4" }] },
      { name: "Grip, Farmer Maggot's Dog", distance: 1, health: "unhurt", level: 5, levelKnown: false, speed: 120, sights: 1, isUnique: true, asleep: true },
    ],
    rememberedMonsters: [{ name: "soldier", distance: 9 }],
  };
  it("keeps what the UI shows, nearest monster first", () => {
    const r = dangerRecord(state, 7, 40);
    expect(r).toMatchObject({ a: 7, t: 500, d: 2, fe: 3, hp: 12, mhp: 20, os: 2, sd: [4, 0], lt: 40, nv: 2, nr: 1, rd: 9, hu: 3, lm: 2 });
    expect(r.tm.slice(0, 3)).toEqual([1, 3, 0]);
    expect(r.inv.slice(0, 6)).toEqual([3, 0, 0, 2, 0, 5]);
    expect(r.wd).toBe(2 * 3 + 2 + 1);
    expect(r.m[0]).toEqual(["Grip, Farmer Maggot's Dog", 1, 0, null, 120, MF.UNIQUE | MF.ASLEEP, 0, 0, 0]);
    expect(r.m[1]).toEqual(["cave spider", 3, 2, 2, 120, 0, 2.5, 1, 0]);
  });
});

describe("DangerLogger", () => {
  it("writes gzip chunks that read back whole, with the command after each state", () => {
    const file = path.join(tmp(), "danger.jsonl.gz");
    const log = new DangerLogger(file, { h: 1, v: 1, engine: "ts", view: "player", class: "Rogue", race: "Hobbit", seed: "5", rulefix: "" }, 3);
    const st = (turn: number, hp: number) => ({ turn, depth: 1, player: { hp, maxHp: 20, level: 1 }, monsters: [], map: { tiles: [] } });
    for (let i = 1; i <= 7; i++) { log.record(st(i * 10, 20 - i), i); log.noteCommand(i); log.noteCommand(99); }
    log.finish({ ...st(80, 0), dead: true });
    const { header, records } = readDangerLog(file);
    expect(header?.class).toBe("Rogue");
    expect(records.map(r => r.a)).toEqual([1, 2, 3, 4, 5, 6, 7, 7]);
    expect(records.slice(0, 7).map(r => r.act)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(records[7]!.dead).toBe(1);
    // turns on this level count from the first record on it
    expect(records.map(r => r.lt)).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
  });
  it("reads what it can from a truncated file", () => {
    const file = path.join(tmp(), "danger.jsonl.gz");
    const log = new DangerLogger(file, { h: 1, v: 1, engine: "ts", view: "player", class: "Rogue", race: "Hobbit", seed: "5", rulefix: "" }, 2);
    for (let i = 1; i <= 6; i++) log.record({ turn: i, depth: 1, player: { hp: 5, maxHp: 5 } }, i);
    log.close();
    const buf = fs.readFileSync(file);
    fs.writeFileSync(file, buf.subarray(0, buf.length - 10));
    const { records } = readDangerLog(file); // the gzip trailer is gone, so a plain gunzip would throw
    expect(records.length).toBeGreaterThanOrEqual(4);
    expect(records.map(r => r.a)).toEqual([1, 2, 3, 4, 5, 6].slice(0, records.length));
  });
});

describe("labels", () => {
  it("drops states that passed no time, keeping the last of each turn", () => {
    const rs = [rec(1, 0, 20), rec(2, 0, 20), rec(3, 10, 20), rec(4, 20, 20), rec(5, 30, 0, { dead: 1 })];
    expect(timedRecords(rs).map(r => r.a)).toEqual([2, 3, 4, 5]);
  });
  it("death windows count the fatal action's start; damage sums drops", () => {
    // a game of 60 player turns, HP 20, hit for 5 at turns 40 and 50, healed in between, killed by an action at turn 59
    const rs: DangerRecord[] = [];
    for (let i = 0; i < 60; i++) rs.push(rec(i + 1, i * 10, i === 41 || i === 42 ? 15 : i >= 51 ? 15 : 20));
    rs.push(rec(61, 600, -3, { dead: 1 }));
    const y = labelGame(rs);
    const d5 = col(y, "death_5"), d20 = col(y, "death_20"), d50 = col(y, "death_50");
    // fatal action starts at t = 590: within [t, t + 50) from t >= 550, i.e. records 55..59
    expect(d5.map((v, i) => (v ? i : -1)).filter(i => i >= 0)).toEqual([55, 56, 57, 58, 59, 60]);
    expect(d20[39]).toBe(0); expect(d20[40]).toBe(1);
    expect(d50[9]).toBe(0); expect(d50[10]).toBe(1);
    const dmg5 = col(y, "dmg_5");
    expect(dmg5[36]).toBeCloseTo(5 / 20); // the drop in the action starting at turn 40
    expect(dmg5[35]).toBe(0);
    expect(col(y, "dmg_20")[31]).toBeCloseTo(10 / 20); // turn 40 and turn 50, though healed in between
    expect(col(y, "dmg_1")[59]).toBeCloseTo(15 / 20); // the fatal blow, to 0 HP
  });
  it("censors windows past the end of a game that ended alive", () => {
    const rs: DangerRecord[] = [];
    for (let i = 0; i < 30; i++) rs.push(rec(i + 1, i * 10, 20));
    const y = labelGame(rs);
    expect(col(y, "death_5").slice(0, 25).every(v => v === 0)).toBe(true);
    expect(col(y, "death_5").slice(25).every(v => Number.isNaN(v))).toBe(true);
    expect(col(y, "death_50").every(v => Number.isNaN(v))).toBe(true);
    expect(col(y, `die_${STAGE_HORIZON}`).every(v => Number.isNaN(v))).toBe(true);
  });
  it("stage labels: the first of advance and death within H actions", () => {
    const rs = [rec(1, 0, 20), rec(500, 10, 20, { d: 2 }), rec(2400, 20, 20, { d: 2 }), rec(2600, 30, 20, { d: 2 }), rec(2601, 40, 0, { d: 2, dead: 1 })];
    const y = labelGame(rs);
    expect(col(y, `adv_${STAGE_HORIZON}`).slice(0, 4)).toEqual([1, 0, 0, 0]);
    expect(col(y, `die_${STAGE_HORIZON}`).slice(0, 4)).toEqual([0, 0, 1, 1]);
  });
});

describe("Featurizer", () => {
  const fz = new Featurizer(defaultVocab());
  it("builds one value per feature name, with race identity as a category", () => {
    expect(FEATURE_NAMES.length).toBe(new Set(FEATURE_NAMES).size);
    for (const c of CATEGORICAL) expect(FEATURE_NAMES).toContain(c);
    const r = rec(1, 0, 10, {
      m: [["Grip, Farmer Maggot's Dog", 1, 0, null, 120, MF.UNIQUE, 0, 0, 0], ["no such monster", 4, -1, 3, null, 0, 0, 0, 0]],
      nv: 2, fe: 2,
    });
    const x = fz.featurize(r, { class: "Rogue", race: "Hobbit" });
    const v = (n: string) => x[FEATURE_NAMES.indexOf(n)]!;
    expect(x.length).toBe(FEATURE_NAMES.length);
    expect(v("class")).toBe(6); expect(v("prace")).toBe(3);
    expect(fz.vocab.monster[v("m0_race")]).toBe("grip, farmer maggot's dog");
    expect(v("m0_level")).toBeNaN(); expect(v("m0_dspeed")).toBe(10); expect(v("m0_unique")).toBe(1);
    expect(v("m1_race")).toBeNaN(); expect(v("m1_health")).toBeNaN(); expect(v("m1_level")).toBe(3);
    expect(v("m2_dist")).toBeNaN();
    expect(v("n_adj")).toBe(1); expect(v("n_d5")).toBe(2); expect(v("n_fast_d5")).toBe(1);
    expect(v("hp_frac")).toBe(0.5); expect(v("feeling")).toBe(2); expect(v("up_dist")).toBeNaN();
    expect(v("hand_two")).toBeCloseTo(handDamage(r, 2, 8) / 10);
  });
  it("hand estimate: unknown blows use the level, speed scales attacks, distance costs turns", () => {
    const r = rec(1, 0, 10, { d: 4, m: [["x", 1, 0, null, null, 0, 0, 0, 0], ["y", 2, 0, 2, 120, 0, 3, 1, 0], ["z", 3, 0, 9, 110, MF.NEVER_MOVES, 0, 0, 0]] });
    // x: level unknown → depth 4, 2 turns at speed 110: 4*0.7*2; y: 3*0.7*(2*2-1); z: never moves, not adjacent
    expect(handDamage(r, 2, 8)).toBeCloseTo(4 * 0.7 * 2 + 3 * 0.7 * 3);
  });
});

describe("NpyWriter", () => {
  it("patches the shape into a 128-byte header", () => {
    const file = path.join(tmp(), "a.npy");
    const w = new NpyWriter(file, "<f4", 3);
    w.write(new Float32Array([1, 2, 3, 4, 5, 6]), 2);
    w.write(new Float32Array([7, 8, 9]), 1);
    w.close();
    const buf = fs.readFileSync(file);
    expect(buf.subarray(0, 6).toString("latin1")).toBe("\x93NUMPY");
    const hlen = buf.readUInt16LE(8);
    expect(10 + hlen).toBe(128);
    expect(buf.subarray(10, 128).toString("latin1")).toMatch(/'shape': \(3, 3\)/);
    expect(Array.from(new Float32Array(buf.buffer.slice(buf.byteOffset + 128, buf.byteOffset + buf.length)))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("build", () => {
  it("subsamples records where nothing happened, weights them back, and skips omniscient games", () => {
    const dir = tmp();
    const game = (name: string, view: string, hit: boolean) => {
      fs.mkdirSync(path.join(dir, name));
      const log = new DangerLogger(path.join(dir, name, "danger.jsonl.gz"), { h: 1, v: 1, engine: "ts", view, class: "Mage", race: "Elf", seed: name, rulefix: "" });
      const mon = { name: "kobold", distance: 2, health: "unhurt", level: 2, speed: 110, sights: 1 };
      for (let i = 0; i < 400; i++) {
        log.record({ turn: i * 10, depth: 1, player: { hp: hit && i === 300 ? 5 : 20, maxHp: 20, level: 1 }, monsters: i >= 200 ? [mon] : [] }, i + 1);
      }
      log.close();
    };
    game("a", "player", true); game("b", "player", false); game("c", "omniscient", false);
    const out = path.join(dir, "ds");
    const res = build([dir], out, 0.25, 0.5);
    const meta = JSON.parse(fs.readFileSync(path.join(out, "meta.json"), "utf-8"));
    expect(meta.games.map((g: any) => g.seed)).toEqual(["a", "b"]);
    expect(Object.values(meta.skipped)).toEqual(["view omniscient"]);
    expect(meta.features).toEqual(FEATURE_NAMES);
    const wb = fs.readFileSync(path.join(out, "w.npy"));
    const w = new Float32Array(wb.buffer.slice(wb.byteOffset + 128, wb.byteOffset + wb.length));
    expect(w.length).toBe(res.rows);
    expect(new Set(w)).toEqual(new Set([1, 2, 4]));
    // weighted, the kept rows stand for every record (each game's final record is censored but still a row)
    const total = w.reduce((s, x) => s + x, 0);
    expect(total / 800).toBeGreaterThan(0.85); expect(total / 800).toBeLessThan(1.15);
    expect(res.rows).toBeLessThan(400);
  });
});

describe("DangerModel", () => {
  const json: DangerModelJson = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/parity-model.json"), "utf-8"));
  it("matches LightGBM on the exported parity rows (categorical splits and NaN included)", () => {
    // the fixture is tools/overnight/test_danger.py's synthetic model (DANGER_FIXTURE=... to regenerate)
    const model = new DangerModel(json);
    expect(json.parity!.length).toBeGreaterThan(10);
    for (const r of json.parity!) {
      expect(model.predictRow(r.x.map(v => (v === null ? NaN : v)))).toBeCloseTo(r.p, 12);
    }
  });
  it("refuses a model whose features this featurizer doesn't build", () => {
    expect(() => new DangerModel({ ...json, features: [...json.features, "no_such_feature"] })).toThrow(/no_such_feature/);
  });
});
