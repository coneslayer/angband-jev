/**
 * @file borg/snapshot.ts
 * @brief Faithful JSON snapshot/restore of a live GameState (for AI rollouts)
 *
 * save/save.ts is NOT used here: it drops inventory/equipment, uses placeholder
 * race/class, restores no monsters/objects, shares one heatmap between noise and
 * scent, and does not touch stores or template state.  Instead this is a generic
 * object-graph codec:
 *   - shared references / cycles are preserved (ids emitted only when shared),
 *   - BitFlag / RNG class instances, typed arrays, Map and Set are handled,
 *   - static game data (races, classes, monster races, object kinds, artifacts,
 *     ego items, brands, slays) is stored as index references, never copied,
 *   - mutable fields of those templates (race.curNum, kind.aware, artifact.created ...)
 *     are saved as a diff against a pristine capture taken right after data load.
 * Unknown class instances and functions throw, so a new unsupported field fails loudly.
 */

import { BitFlag } from "../z/bitflag.js";
import { RNG } from "../z/rand.js";
import type { GameState } from "../game/state.js";

export type TemplateLists = Record<string, readonly object[]>;
/** list name -> template index -> key -> encoded JSON string */
export type PristineTemplates = Record<string, Record<number, Record<string, string>>>;

export const SNAPSHOT_FORMAT = "ts-graph-1";

/** GameState keys not stored in the graph (re-attached from the live server). */
const EXTERNAL_KEYS = ["eventBus", "rng", "monsterRaces", "objectKinds", "artifacts", "egoItems", "brands", "slays"] as const;

const CLASSES: Record<string, { new (...a: never[]): object; prototype: object }> = {
  BitFlag: BitFlag as never,
  RNG: RNG as never,
};

/** [list, index] for a template itself, or [list, index, key, key, ...] for an object nested inside one. */
type RefMap = Map<object, (string | number)[]>;

function buildRefs(lists: TemplateLists, rng: RNG): RefMap {
  const refs: RefMap = new Map();
  for (const [name, arr] of Object.entries(lists)) arr.forEach((t, i) => refs.set(t, [name, i]));
  refs.set(rng, ["$rng", 0]);
  return refs;
}

// Objects nested inside templates (kind.effect, ...) are aliased by game objects created from the
// kind; give them path refs so aliasing survives a restore.  Templates are static, so cache.
const deepCache = new WeakMap<TemplateLists, RefMap>();
function buildDeepRefs(lists: TemplateLists, rng: RNG): RefMap {
  let base = deepCache.get(lists);
  if (!base) {
    base = new Map();
    const walk = (v: unknown, path: (string | number)[]): void => {
      if (v === null || typeof v !== "object" || base!.has(v)) return;
      if (v instanceof Map || v instanceof Set) return;
      base!.set(v, path);
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
      else for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], [...path, k]);
    };
    for (const [name, arr] of Object.entries(lists)) arr.forEach((t, i) => base!.set(t, [name, i]));
    for (const [name, arr] of Object.entries(lists)) {
      arr.forEach((t, i) => { for (const k of Object.keys(t)) walk((t as Record<string, unknown>)[k], [name, i, k]); });
    }
    deepCache.set(lists, base);
  }
  const refs: RefMap = new Map(base);
  refs.set(rng, ["$rng", 0]);
  return refs;
}
function invalidateDeepRefs(lists: TemplateLists): void { deepCache.delete(lists); }

const TYPED: Record<string, new (a: number[]) => object> = {
  Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float64Array,
} as never;

class Encoder {
  private counts = new Map<object, number>();
  private ids = new Map<object, number>();
  private nextId = 0;
  constructor(private refs: RefMap) {}

  encode(root: unknown): unknown {
    this.count(root);
    return this.enc(root, "$");
  }

  private count(v: unknown): void {
    if (v === null || typeof v !== "object") return;
    if (this.refs.has(v)) return;
    const n = this.counts.get(v) ?? 0;
    this.counts.set(v, n + 1);
    if (n > 0) return;
    if (ArrayBuffer.isView(v)) return;
    if (v instanceof Map) { for (const [k, x] of v) { this.count(k); this.count(x); } return; }
    if (v instanceof Set) { for (const x of v) this.count(x); return; }
    if (Array.isArray(v)) { for (const x of v) this.count(x); return; }
    for (const k of Object.keys(v)) this.count((v as Record<string, unknown>)[k]);
  }

  private enc(v: unknown, path: string): unknown {
    switch (typeof v) {
      case "string": case "boolean": return v;
      case "undefined": return { $: "u" };
      case "number":
        if (Number.isFinite(v) && !Object.is(v, -0)) return v;
        return { $: "n", v: Object.is(v, -0) ? "-0" : String(v) };
      case "object": break;
      default: throw new Error(`snapshot: cannot encode ${typeof v} at ${path}`);
    }
    if (v === null) return null;
    const ref = this.refs.get(v);
    if (ref) return ref.length > 2 ? { $: "t", k: ref[0], i: ref[1], p: ref.slice(2) } : { $: "t", k: ref[0], i: ref[1] };
    const shared = (this.counts.get(v) ?? 0) > 1;
    if (shared) {
      const id = this.ids.get(v);
      if (id !== undefined) return { $: "r", id };
    }
    const id = shared ? this.nextId++ : undefined;
    if (shared) this.ids.set(v, id!);
    const wrap = (tag: string, extra: Record<string, unknown>): unknown =>
      id === undefined && tag === "o" ? extra.v : { $: tag, ...(id !== undefined ? { id } : {}), ...extra };

    if (ArrayBuffer.isView(v)) {
      return { $: "ta", t: (v as object).constructor.name, ...(id !== undefined ? { id } : {}), v: Array.from(v as unknown as ArrayLike<number>) };
    }
    if (v instanceof Map) {
      return { $: "m", ...(id !== undefined ? { id } : {}), v: [...v].map(([k, x], i) => [this.enc(k, `${path}.key${i}`), this.enc(x, `${path}[${i}]`)]) };
    }
    if (v instanceof Set) {
      return { $: "s", ...(id !== undefined ? { id } : {}), v: [...v].map((x, i) => this.enc(x, `${path}{${i}}`)) };
    }
    if (Array.isArray(v)) {
      const arr = v.map((x, i) => this.enc(x, `${path}[${i}]`));
      return id === undefined ? arr : { $: "a", id, v: arr };
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      const name = (v as object).constructor?.name ?? "?";
      if (!CLASSES[name] || CLASSES[name]!.prototype !== proto) throw new Error(`snapshot: unsupported class ${name} at ${path}`);
      const f: Record<string, unknown> = {};
      for (const k of Object.keys(v)) f[k] = this.enc((v as Record<string, unknown>)[k], `${path}.${k}`);
      return { $: "c", n: name, ...(id !== undefined ? { id } : {}), f };
    }
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      if (k === "$") throw new Error(`snapshot: reserved key "$" at ${path}`);
      o[k] = this.enc((v as Record<string, unknown>)[k], `${path}.${k}`);
    }
    return wrap("o", { v: o });
  }
}

class Decoder {
  private ids = new Map<number, object>();
  constructor(private lists: TemplateLists, private rng: RNG) {}

  dec(e: unknown): unknown {
    if (e === null || typeof e !== "object") return e;
    if (Array.isArray(e)) return e.map((x) => this.dec(x));
    const t = e as Record<string, unknown> & { $?: string };
    if (t.$ === undefined) {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(t)) o[k] = this.dec(t[k]);
      return o;
    }
    const id = t.id as number | undefined;
    const reg = <T extends object>(o: T): T => { if (id !== undefined) this.ids.set(id, o); return o; };
    switch (t.$) {
      case "u": return undefined;
      case "n": return t.v === "-0" ? -0 : Number(t.v);
      case "r": {
        const o = this.ids.get(t.id as number);
        if (!o) throw new Error(`snapshot: dangling ref ${String(t.id)}`);
        return o;
      }
      case "t": {
        if (t.k === "$rng") return this.rng;
        let o: unknown = this.lists[t.k as string]?.[t.i as number];
        if (!o) throw new Error(`snapshot: unknown template ${String(t.k)}[${String(t.i)}] (server data differs?)`);
        for (const key of (t.p as (string | number)[] | undefined) ?? []) {
          o = (o as Record<string | number, unknown>)?.[key];
          if (o === undefined) throw new Error(`snapshot: bad template path in ${String(t.k)}[${String(t.i)}]`);
        }
        return o;
      }
      case "a": { const a: unknown[] = reg([]); for (const x of t.v as unknown[]) a.push(this.dec(x)); return a; }
      case "o": { const o: Record<string, unknown> = reg({}); const src = t.v as Record<string, unknown>; for (const k of Object.keys(src)) o[k] = this.dec(src[k]); return o; }
      case "ta": { const C = TYPED[t.t as string]; if (!C) throw new Error(`snapshot: typed array ${String(t.t)}`); return reg(new C(t.v as number[])); }
      case "m": { const m = reg(new Map()); for (const [k, x] of t.v as [unknown, unknown][]) m.set(this.dec(k), this.dec(x)); return m; }
      case "s": { const s = reg(new Set()); for (const x of t.v as unknown[]) s.add(this.dec(x)); return s; }
      case "c": {
        const C = CLASSES[t.n as string];
        if (!C) throw new Error(`snapshot: unknown class ${String(t.n)}`);
        const o: Record<string, unknown> = reg(Object.create(C.prototype));
        const f = t.f as Record<string, unknown>;
        for (const k of Object.keys(f)) o[k] = this.dec(f[k]);
        return o;
      }
      default: throw new Error(`snapshot: bad tag ${String(t.$)}`);
    }
  }
}

function encodeTemplateKeys(lists: TemplateLists, refs: RefMap): PristineTemplates {
  const out: PristineTemplates = {};
  for (const [name, arr] of Object.entries(lists)) {
    const m: Record<number, Record<string, string>> = {};
    arr.forEach((t, i) => {
      const keys: Record<string, string> = {};
      for (const k of Object.keys(t)) keys[k] = JSON.stringify(new Encoder(refs).encode((t as Record<string, unknown>)[k]));
      m[i] = keys;
    });
    out[name] = m;
  }
  return out;
}

/** Capture template contents; call once right after data load, before birth. */
export function capturePristine(lists: TemplateLists, rng: RNG): PristineTemplates {
  return encodeTemplateKeys(lists, buildRefs(lists, rng));
}

export interface SnapshotData {
  format: string;
  state: unknown;
  rng: unknown;
  /** list -> index -> key -> encoded value, only where it differs from pristine */
  templates: Record<string, Record<number, Record<string, unknown>>>;
}

export function snapshotState(state: GameState, lists: TemplateLists, pristine: PristineTemplates): SnapshotData {
  const refs = buildDeepRefs(lists, state.rng);
  const gs: Record<string, unknown> = { ...(state as unknown as Record<string, unknown>) };
  for (const k of EXTERNAL_KEYS) delete gs[k];
  const stateEnc = new Encoder(refs).encode(gs);
  // RNG is encoded alone (graph references to it are $rng refs)
  const noRng: RefMap = new Map(refs); noRng.delete(state.rng);
  const rngEnc = new Encoder(noRng).encode(state.rng);
  const templates: SnapshotData["templates"] = {};
  const cur = encodeTemplateKeys(lists, buildRefs(lists, state.rng));
  for (const [name, byIdx] of Object.entries(cur)) {
    for (const [i, keys] of Object.entries(byIdx)) {
      const pk = pristine[name]?.[Number(i)] ?? {};
      const diff: Record<string, unknown> = {};
      for (const k of new Set([...Object.keys(keys), ...Object.keys(pk)])) {
        if (keys[k] !== pk[k]) diff[k] = keys[k] === undefined ? { $: "x" } : JSON.parse(keys[k]!);
      }
      if (Object.keys(diff).length) (templates[name] ??= {})[Number(i)] = diff;
    }
  }
  return { format: SNAPSHOT_FORMAT, state: stateEnc, rng: rngEnc, templates };
}

export interface DecodedSnapshot {
  state: GameState;
  /** Call after the old game loop has stopped: applies template + RNG state to the live objects. */
  commit(): void;
}

/**
 * Decode a snapshot into a new GameState without touching live objects.
 * `live` supplies the external parts (eventBus, rng, static data lists).
 */
export function decodeSnapshot(data: SnapshotData, live: GameState, lists: TemplateLists, pristine: PristineTemplates): DecodedSnapshot {
  if (!data || data.format !== SNAPSHOT_FORMAT) throw new Error(`snapshot: unsupported format ${String(data?.format)}`);
  const dec = new Decoder(lists, live.rng);
  const decoded = dec.dec(data.state) as Record<string, unknown>;
  const state = {
    ...decoded,
    eventBus: live.eventBus,
    rng: live.rng,
    monsterRaces: live.monsterRaces,
    objectKinds: live.objectKinds,
    artifacts: live.artifacts,
    egoItems: live.egoItems,
    brands: live.brands,
    slays: live.slays,
  } as unknown as GameState;
  const rngFields = new Decoder(lists, live.rng).dec(data.rng) as Record<string, unknown>;
  // pre-decode template changes (validates before anything is mutated)
  const refs = buildRefs(lists, live.rng);
  const plan: { t: Record<string, unknown>; key: string; value?: unknown; del: boolean }[] = [];
  for (const [name, arr] of Object.entries(lists)) {
    arr.forEach((t, i) => {
      const want = data.templates[name]?.[i] ?? {};
      const pk = pristine[name]?.[i] ?? {};
      const tr = t as Record<string, unknown>;
      for (const k of new Set([...Object.keys(tr), ...Object.keys(pk), ...Object.keys(want)])) {
        const w = k in want ? want[k] : undefined;
        const target: string | undefined = w !== undefined ? JSON.stringify(w) : pk[k];
        const curStr = k in tr ? JSON.stringify(new Encoder(refs).encode(tr[k])) : undefined;
        if (curStr === target) continue;
        if (w !== undefined && (w as { $?: string }).$ === "x" || target === undefined) plan.push({ t: tr, key: k, del: true });
        else plan.push({ t: tr, key: k, value: new Decoder(lists, live.rng).dec(JSON.parse(target)), del: false });
      }
    });
  }
  return {
    state,
    commit() {
      for (const p of plan) { if (p.del) delete p.t[p.key]; else p.t[p.key] = p.value; }
      if (plan.length) invalidateDeepRefs(lists);
      Object.assign(live.rng as unknown as Record<string, unknown>, rngFields);
    },
  };
}
