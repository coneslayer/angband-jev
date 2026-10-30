/**
 * @file rollout/cost.ts
 * @brief Consumable value of an inventory, from object.json base costs
 *
 * Counted item classes: potion (tval 26), scroll (25), flask (27, Flasks of oil), food (28), mushroom (29).
 * Not counted: wands/staffs/rods (charges), ammo, books, equipment.
 * An unaware flavour (C names it by flavour, e.g. "Blue Potion") is valued at a generic prior: the median cost
 * of that type's shallow kinds (level <= 15), since the player doesn't know what it is. Its key is still
 * reported in `missing`.
 */
import * as fs from "node:fs";

const TVAL_TYPE: Record<number, string> = { 25: "scroll", 26: "potion", 27: "flask", 28: "food", 29: "mushroom" };

// same cleaning as ai-server.ts: "& Flask~ of oil" -> "flask of oil"
export const cleanName = (n: string): string => n.replace(/^& /, "").replace(/~/, "").trim().toLowerCase();

export class CostTable {
  private cost = new Map<string, number>();
  private prior = new Map<string, number>();
  constructor(objectJsonPath: string) {
    const kinds: any[] = JSON.parse(fs.readFileSync(objectJsonPath, "utf-8"));
    const shallow = new Map<string, number[]>();
    for (const k of kinds) {
      if (!k.name || !k.type || k.cost === undefined) continue;
      this.cost.set(`${k.type}|${cleanName(k.name)}`, Number(k.cost));
      if (Number(k.level) <= 15 && Number(k.cost) > 0) shallow.set(k.type, [...(shallow.get(k.type) ?? []), Number(k.cost)]);
    }
    for (const [t, c] of shallow) {
      c.sort((a, b) => a - b);
      this.prior.set(t, c.length % 2 ? c[(c.length - 1) / 2]! : (c[c.length / 2 - 1]! + c[c.length / 2]!) / 2);
    }
  }
  /** Map of "type|name" -> {qty, unit} for consumables in a /state player.inventory. */
  consumables(inventory: any[]): Map<string, { qty: number; unit: number }> {
    const m = new Map<string, { qty: number; unit: number }>();
    for (const it of inventory ?? []) {
      const type = TVAL_TYPE[it.tval];
      if (!type) continue;
      const key = `${type}|${cleanName(it.name)}`;
      let unit = this.cost.get(key);
      if (unit === undefined) {
        this.missing.add(key);
        unit = this.prior.get(type);
        if (unit === undefined) continue;
      }
      const e = m.get(key) ?? { qty: 0, unit };
      e.qty += it.qty ?? 1;
      m.set(key, e);
    }
    return m;
  }
  missing = new Set<string>();
  static total(m: Map<string, { qty: number; unit: number }>): number {
    let t = 0;
    for (const e of m.values()) t += e.qty * e.unit;
    return t;
  }
  /** Value consumed between start and end: sum over kinds of max(0, qty_start - qty_end) * unit. */
  static used(start: Map<string, { qty: number; unit: number }>, end: Map<string, { qty: number; unit: number }>): number {
    let t = 0;
    for (const [k, s] of start) t += Math.max(0, s.qty - (end.get(k)?.qty ?? 0)) * s.unit;
    return t;
  }
}
