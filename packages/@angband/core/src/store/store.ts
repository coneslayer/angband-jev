/**
 * @file store/store.ts
 * @brief Store/shop system
 *
 * Port of store.c / store.h -- haggle-free store mechanics for buying,
 * selling, pricing, stock management, and the player's home.
 *
 * Copyright (c) 1997 Robert A. Koeneke, James E. Wilson, Ben Harrison
 * Copyright (c) 2007 Andi Sidwell
 *
 * This work is free software; you can redistribute it and/or modify it
 * under the terms of either GPL-2.0 or the Angband licence.
 */

import type { ObjectType, ObjectKind } from "../types/index.js";
import { TVal, ObjectFlag } from "../types/index.js";
import type { Player } from "../types/index.js";
import { BitFlag, type RNG } from "../z/index.js";
import { canStack } from "../object/pile.js";
import { STORE_DEFS, cleanKindName, type StoreDef } from "./store-data.js";

// ---------------------------------------------------------------------------
// Store types (matching Angband's 9 store types)
// ---------------------------------------------------------------------------

/** Store type identifiers. Matches store.txt ordering. */
export const enum StoreType {
  GENERAL = 0,
  ARMORY = 1,
  WEAPON = 2,
  TEMPLE = 3,
  ALCHEMY = 4,
  MAGIC = 5,
  BLACKMARKET = 6,
  HOME = 7,
  BOOKSHOP = 8,
}

/** Total number of store types. */
export const STORE_TYPE_MAX = 9;

// ---------------------------------------------------------------------------
// Store owner
// ---------------------------------------------------------------------------

/** A store owner with a name and spending limit. */
export interface StoreOwner {
  /** Display name of the store owner. */
  readonly name: string;
  /** Maximum amount the owner will pay for a single item. */
  readonly maxCost: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Default maximum stock for most stores. */
export const DEFAULT_MAX_STOCK = 24;

/** Maximum slots in the player's home. */
export const HOME_MAX_STOCK = 24;

/** A store instance. */
export interface Store {
  /** What kind of store this is. */
  readonly type: StoreType;
  /** Display name. */
  readonly name: string;
  /** Current stock of items. */
  stock: ObjectType[];
  /** Maximum number of items this store can hold. */
  readonly maxStock: number;
  /** Current owner. */
  owner: StoreOwner;
  /** Owner's purse limit (shortcut for owner.maxCost). */
  readonly purse: number;
  /** Number of items to turn over during maintenance. */
  readonly turnover: number;
}

// ---------------------------------------------------------------------------
// Transaction results
// ---------------------------------------------------------------------------

/** Result of a buy transaction. */
export interface BuyResult {
  /** Whether the purchase succeeded. */
  readonly success: boolean;
  /** The price paid (0 if failed). */
  readonly price: number;
  /** A human-readable message describing the outcome. */
  readonly message: string;
}

/** Result of a sell transaction. */
export interface SellResult {
  /** Whether the sale succeeded. */
  readonly success: boolean;
  /** The price received (0 if failed). */
  readonly price: number;
  /** A human-readable message describing the outcome. */
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Store name table
// ---------------------------------------------------------------------------

/** Default store names indexed by StoreType. */
const STORE_NAMES: Record<number, string> = {
  [StoreType.GENERAL]: "General Store",
  [StoreType.ARMORY]: "Armory",
  [StoreType.WEAPON]: "Weapon Smiths",
  [StoreType.TEMPLE]: "Temple",
  [StoreType.ALCHEMY]: "Alchemy Shop",
  [StoreType.MAGIC]: "Magic Shop",
  [StoreType.BLACKMARKET]: "Black Market",
  [StoreType.HOME]: "Your Home",
  [StoreType.BOOKSHOP]: "Bookstore",
};

/** Default store owners indexed by StoreType. */
const DEFAULT_OWNERS: Record<number, StoreOwner> = {
  [StoreType.GENERAL]: { name: "Bilbo the Friendly", maxCost: 5000 },
  [StoreType.ARMORY]: { name: "Kon-Dar the Ugly", maxCost: 10000 },
  [StoreType.WEAPON]: { name: "Odo the Miser", maxCost: 25000 },
  [StoreType.TEMPLE]: { name: "Ludwig the Humble", maxCost: 15000 },
  [StoreType.ALCHEMY]: { name: "Gagrin Fireblade", maxCost: 10000 },
  [StoreType.MAGIC]: { name: "Ariel the Sorceress", maxCost: 20000 },
  [StoreType.BLACKMARKET]: { name: "Gary Gygax", maxCost: 30000 },
  [StoreType.HOME]: { name: "You", maxCost: 0 },
  [StoreType.BOOKSHOP]: { name: "Randolph Carter", maxCost: 15000 },
};

// ---------------------------------------------------------------------------
// Markup / markdown tables
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Store carries table  (which TVal categories a store accepts)
// ---------------------------------------------------------------------------

/**
 * TVal sets that each store type will buy or stock.
 * This approximates the C store buy-lists from store.txt.
 */
const STORE_TVALS: Record<number, ReadonlySet<TVal>> = {
  [StoreType.GENERAL]: new Set<TVal>([
    TVal.FOOD,
    TVal.MUSHROOM,
    TVal.LIGHT,
    TVal.FLASK,
    TVal.DIGGING,
    TVal.CLOAK,
    TVal.SHOT,
    TVal.ARROW,
    TVal.BOLT,
  ]),
  [StoreType.ARMORY]: new Set<TVal>([
    TVal.BOOTS,
    TVal.GLOVES,
    TVal.HELM,
    TVal.CROWN,
    TVal.SHIELD,
    TVal.CLOAK,
    TVal.SOFT_ARMOR,
    TVal.HARD_ARMOR,
    TVal.DRAG_ARMOR,
  ]),
  [StoreType.WEAPON]: new Set<TVal>([
    TVal.SWORD,
    TVal.HAFTED,
    TVal.POLEARM,
    TVal.BOW,
    TVal.SHOT,
    TVal.ARROW,
    TVal.BOLT,
    TVal.DIGGING,
  ]),
  [StoreType.TEMPLE]: new Set<TVal>([
    TVal.SCROLL,
    TVal.POTION,
    TVal.PRAYER_BOOK,
    TVal.HAFTED,
  ]),
  [StoreType.ALCHEMY]: new Set<TVal>([TVal.SCROLL, TVal.POTION]),
  [StoreType.MAGIC]: new Set<TVal>([
    TVal.RING,
    TVal.AMULET,
    TVal.WAND,
    TVal.STAFF,
    TVal.ROD,
    TVal.MAGIC_BOOK,
    TVal.SCROLL,
    TVal.POTION,
  ]),
  // Black market buys almost everything
  [StoreType.BLACKMARKET]: new Set<TVal>([
    TVal.SWORD,
    TVal.HAFTED,
    TVal.POLEARM,
    TVal.BOW,
    TVal.SHOT,
    TVal.ARROW,
    TVal.BOLT,
    TVal.DIGGING,
    TVal.BOOTS,
    TVal.GLOVES,
    TVal.HELM,
    TVal.CROWN,
    TVal.SHIELD,
    TVal.CLOAK,
    TVal.SOFT_ARMOR,
    TVal.HARD_ARMOR,
    TVal.DRAG_ARMOR,
    TVal.LIGHT,
    TVal.AMULET,
    TVal.RING,
    TVal.STAFF,
    TVal.WAND,
    TVal.ROD,
    TVal.SCROLL,
    TVal.POTION,
    TVal.FLASK,
    TVal.FOOD,
    TVal.MUSHROOM,
    TVal.MAGIC_BOOK,
    TVal.PRAYER_BOOK,
    TVal.NATURE_BOOK,
    TVal.SHADOW_BOOK,
    TVal.OTHER_BOOK,
  ]),
  // Home accepts everything
  [StoreType.HOME]: new Set<TVal>(),
  [StoreType.BOOKSHOP]: new Set<TVal>([
    TVal.MAGIC_BOOK,
    TVal.PRAYER_BOOK,
    TVal.NATURE_BOOK,
    TVal.SHADOW_BOOK,
    TVal.OTHER_BOOK,
  ]),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an empty store of the given type.
 */
export function createStore(type: StoreType): Store {
  const owner = DEFAULT_OWNERS[type] ?? { name: "Unknown", maxCost: 5000 };
  return {
    type,
    name: STORE_NAMES[type] ?? "Store",
    stock: [],
    maxStock: type === StoreType.HOME ? HOME_MAX_STOCK : DEFAULT_MAX_STOCK,
    owner,
    purse: owner.maxCost,
    turnover: type === StoreType.HOME ? 0 : (STORE_DEFS[type]?.turnover ?? 4),
  };
}

/**
 * Get the base value of an object for store pricing purposes.
 *
 * Uses the object's kind cost plus bonuses.  This is a simplified version
 * of `object_value` in the C source.  For objects whose kind is null the
 * value is 0.
 */
export function objectBaseValue(obj: ObjectType): number {
  if (!obj.kind) return 0;
  let value = obj.kind.cost;

  // Bonus for combat enchantments
  if (obj.toH > 0) value += obj.toH * 10;
  if (obj.toD > 0) value += obj.toD * 10;
  if (obj.toA > 0) value += obj.toA * 10;

  // Artifacts and ego items are worth more
  if (obj.artifact) value = Math.max(value, obj.artifact.cost);
  if (obj.ego) value += obj.ego.cost;

  return Math.max(0, value);
}

/**
 * Calculate the price of a single item in a store context.
 *
 * @param store  - The store instance.
 * @param obj    - The item being priced.
 * @param selling - `true` when the player is selling TO the store
 *                  (store is buying); `false` when the player is buying
 *                  FROM the store (store is selling).
 * @returns The calculated price (always >= 1 for valued items, 0 for
 *          worthless items when selling).
 */
export function storeGetPrice(
  store: Store,
  obj: ObjectType,
  selling: boolean,
): number {
  // Home has no pricing
  if (store.type === StoreType.HOME) return 0;

  let price = objectBaseValue(obj);
  const black = store.type === StoreType.BLACKMARKET;

  // Worthless items
  if (price <= 0) {
    return selling ? 0 : 1;
  }

  // Port of price_item() (store.c, 4.2.6): no haggling, no general markup.
  let adjust = 100;
  if (black) adjust = 150;

  if (selling) {
    // Shops pay 2/3 of true value (half that at the black market)
    adjust = Math.min(100, 100 + (100 - adjust));
    price = Math.floor((price * 2) / 3);
    if (black) price = Math.floor(price / 2);
  } else if (black) {
    price = price * 2;
  }

  price = Math.floor((price * adjust + 50) / 100);

  // Cap at the owner's purse limit when the store is buying
  if (selling && price > store.owner.maxCost) {
    price = store.owner.maxCost;
  }

  // Never free for non-worthless items
  if (price <= 0) price = 1;

  return price;
}

/**
 * Check whether a store type carries (or would buy) a given item.
 *
 * The home accepts everything.
 */
export function storeCarries(store: Store, obj: ObjectType): boolean {
  // Home accepts everything
  if (store.type === StoreType.HOME) return true;

  const tvals = STORE_TVALS[store.type];
  if (!tvals) return false;

  return tvals.has(obj.tval);
}

/** Extra context so a bought-out store can restock itself (store.c store_maint). */
export interface StoreRestockContext {
  readonly kinds: readonly ObjectKind[];
  readonly rng: RNG;
}

/**
 * Player buys an item from the store.
 *
 * Staple ("always") items are never depleted, as in 4.2.6 do_cmd_buy.
 *
 * @param store     - The store selling the item.
 * @param player    - The player buying.
 * @param itemIndex - Index into store.stock.
 * @param quantity  - How many of the stack to buy (default 1).
 * @param ctx       - Optional kinds + rng, to restock a sold-out store.
 * @returns BuyResult with success/failure and the price paid.
 */
export function storeBuy(
  store: Store,
  player: Player,
  itemIndex: number,
  quantity: number = 1,
  ctx?: StoreRestockContext,
): BuyResult {
  // Home has no buying -- use homeRetrieve instead
  if (store.type === StoreType.HOME) {
    return { success: false, price: 0, message: "Use home retrieval instead." };
  }

  // Validate index
  if (itemIndex < 0 || itemIndex >= store.stock.length) {
    return { success: false, price: 0, message: "Invalid item index." };
  }

  const obj = store.stock[itemIndex]!;
  const stackSize = Math.max(1, obj.number ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { success: false, price: 0, message: "Invalid quantity." };
  }
  if (quantity > stackSize) {
    return {
      success: false,
      price: 0,
      message: `The store only has ${stackSize}.`,
    };
  }
  const price = storeGetPrice(store, obj, false) * quantity;

  // Check if the player can afford it
  if (player.au < price) {
    return {
      success: false,
      price: 0,
      message: `You cannot afford that (${price} gold required, you have ${player.au}).`,
    };
  }

  // Work out where the goods go: merge into a stack, else a new slot
  const pGear = player as PlayerWithGear;
  ensureInventory(pGear);
  const inv = pGear.inventory as (ObjectType | null)[];
  const maxStack = obj.kind?.base?.maxStack ?? 40;
  let remaining = quantity;
  const merges: [ObjectType, number][] = [];
  for (const have of inv) {
    if (remaining <= 0) break;
    if (!have || !canStack(have, obj)) continue;
    const room = maxStack - have.number;
    if (room <= 0) continue;
    const take = Math.min(room, remaining);
    merges.push([have, take]);
    remaining -= take;
  }
  const freeSlot = inv.findIndex((x) => x == null);
  if (remaining > 0 && freeSlot < 0 && inv.length >= MAX_PLAYER_INVENTORY) {
    return {
      success: false,
      price: 0,
      message: "Your inventory is full.",
    };
  }

  // Execute the transaction
  player.au -= price;
  for (const [have, take] of merges) have.number += take;
  const reduce = storeSaleShouldReduceStock(store, obj);
  if (remaining > 0) {
    const bought: ObjectType =
      reduce && remaining === stackSize
        ? obj
        : ({
            ...obj,
            number: remaining,
            flags: obj.flags.clone(),
            modifiers: obj.modifiers.slice(),
          } as ObjectType);
    if (freeSlot >= 0) inv[freeSlot] = bought;
    else inv.push(bought);
  }

  // Remove the goods from the store unless it is a readily replaced staple
  if (reduce) {
    if (obj.number > quantity) {
      obj.number -= quantity;
    } else {
      store.stock.splice(itemIndex, 1);
    }
    // Sold out: the shopkeeper brings out new stock
    if (store.stock.length === 0 && ctx) {
      for (let i = 0; i < 10; i++) storeMaint(store, ctx.kinds, ctx.rng);
    }
  }

  const label = obj.kind?.name ?? "an item";
  return {
    success: true,
    price,
    message: `You bought ${quantity > 1 ? `${quantity} x ` : ""}${label} for ${price} gold.`,
  };
}

/**
 * Player sells an item to the store.
 *
 * @param store  - The store buying the item.
 * @param player - The player selling.
 * @param obj    - The object being sold (must be in the player's inventory).
 * @returns SellResult with success/failure and the price received.
 */
export function storeSell(
  store: Store,
  player: Player,
  obj: ObjectType,
): SellResult {
  // Home has no selling -- use homeStore instead
  if (store.type === StoreType.HOME) {
    return {
      success: false,
      price: 0,
      message: "Use home storage instead.",
    };
  }

  // Check if this store carries this kind of item
  if (!storeCarries(store, obj)) {
    return {
      success: false,
      price: 0,
      message: "The store does not buy that kind of item.",
    };
  }

  // Check if the store has room
  if (store.stock.length >= store.maxStock) {
    return {
      success: false,
      price: 0,
      message: "The store is full.",
    };
  }

  const price = storeGetPrice(store, obj, true);

  // Remove from player's inventory
  const pGear = player as PlayerWithGear;
  ensureInventory(pGear);
  const idx = pGear.inventory.indexOf(obj);
  if (idx === -1) {
    return {
      success: false,
      price: 0,
      message: "Item not found in your inventory.",
    };
  }

  pGear.inventory.splice(idx, 1);
  player.au += price;
  store.stock.push(obj);

  return {
    success: true,
    price,
    message: `You sold ${obj.kind?.name ?? "an item"} for ${price} gold.`,
  };
}

interface StoreTables {
  readonly def: StoreDef;
  readonly always: ObjectKind[];
  readonly normal: ObjectKind[];
}

/**
 * Resolve a store's always/normal tables against the kind list.  Returns
 * null when the store should use the legacy tval-pool stocking (black
 * market, or a kind list that contains none of the 4.2.6 names).
 */
function resolveTables(
  store: Store,
  kinds: readonly ObjectKind[],
): StoreTables | null {
  if (store.type === StoreType.BLACKMARKET) return null;
  const def = STORE_DEFS[store.type];
  if (!def) return null;
  const find = (e: readonly [TVal, string]): ObjectKind | undefined => {
    const want = cleanKindName(e[1]);
    return kinds.find((k) => k.tval === e[0] && cleanKindName(k.name) === want);
  };
  const always = def.always.map(find).filter((k): k is ObjectKind => !!k);
  const normal = def.normal.map(find).filter((k): k is ObjectKind => !!k);
  const declared = def.always.length + def.normal.length;
  if (declared > 0 && always.length + normal.length === 0) return null;
  return { def, always, normal };
}

/** Is this item one of the store's permanent staples (store_is_staple)? */
function isStaple(store: Store, obj: ObjectType): boolean {
  const def = STORE_DEFS[store.type];
  if (!def || !obj.kind) return false;
  const name = cleanKindName(obj.kind.name);
  return def.always.some((e) => e[0] === obj.kind!.tval && cleanKindName(e[1]) === name);
}

/** Port of store_sale_should_reduce_stock(): false for plain staples. */
function storeSaleShouldReduceStock(store: Store, obj: ObjectType): boolean {
  if (obj.artifact || obj.ego) return true;
  if ((obj.toH || obj.toD) && obj.tval >= TVal.SHOT && obj.tval <= TVal.SWORD) return true;
  if (obj.toA) return true;
  return !isStaple(store, obj);
}

function massRoll(rng: RNG, times: number, max: number): number {
  let t = 0;
  for (let i = 0; i < times; i++) t += rng.randint0(max);
  return t;
}

/** Port of mass_produce(): cheap goods come in piles. */
function massProduce(obj: ObjectType, rng: RNG): void {
  let size = 1;
  const cost = obj.kind?.cost ?? 0;
  switch (obj.tval) {
    case TVal.FOOD:
    case TVal.MUSHROOM:
    case TVal.FLASK:
    case TVal.LIGHT:
      if (cost <= 5) size += massRoll(rng, 3, 5);
      if (cost <= 20) size += massRoll(rng, 3, 5);
      break;
    case TVal.POTION:
    case TVal.SCROLL:
      if (cost <= 60) size += massRoll(rng, 3, 5);
      if (cost <= 240) size += massRoll(rng, 1, 5);
      break;
    case TVal.SOFT_ARMOR:
    case TVal.HARD_ARMOR:
    case TVal.SHIELD:
    case TVal.GLOVES:
    case TVal.BOOTS:
    case TVal.CLOAK:
    case TVal.HELM:
    case TVal.CROWN:
    case TVal.SWORD:
    case TVal.POLEARM:
    case TVal.HAFTED:
    case TVal.DIGGING:
    case TVal.BOW:
      if (obj.ego) break;
      if (cost <= 10) size += massRoll(rng, 3, 5);
      if (cost <= 100) size += massRoll(rng, 3, 5);
      break;
    case TVal.SHOT:
    case TVal.ARROW:
    case TVal.BOLT:
      if (cost <= 5) size = rng.randint1(2) * 20;
      else if (cost <= 50) size = rng.randint1(4) * 10;
      else if (cost <= 500) size = rng.randint1(4) * 5;
      else size = 1;
      break;
    default:
      break;
  }
  obj.number = Math.min(size, obj.kind?.base?.maxStack ?? 40);
}

/** Port of store_carry(): merge into an existing stack, else take a slot. */
function storeCarryObj(store: Store, obj: ObjectType): boolean {
  for (const have of store.stock) {
    if (have.kind === obj.kind && canStack(have, obj)) {
      const max = have.kind?.base?.maxStack ?? 40;
      have.number += Math.max(0, Math.min(obj.number, max - have.number));
      return true;
    }
  }
  if (store.stock.length >= store.maxStock) return false;
  store.stock.push(obj);
  return true;
}

/** Port of store_delete_random(): sell off (part of) a random stack. */
function storeDeleteRandom(store: Store, rng: RNG): void {
  if (store.stock.length === 0) return;
  const what = rng.randint0(store.stock.length);
  const obj = store.stock[what]!;
  let num = obj.number;
  if (num > 1) {
    const ammo = obj.tval === TVal.SHOT || obj.tval === TVal.ARROW || obj.tval === TVal.BOLT;
    if (ammo) {
      if (rng.randint0(100) < 50 || num < 10) num = obj.number;
      else num = rng.randint1(Math.floor(num / 5)) * 5 + (num % 5);
    } else if (rng.randint0(100) < 50) {
      num = 1;
    } else if (rng.randint0(100) < 50) {
      num = Math.floor((num + 1) / 2);
    } else {
      num = obj.number;
    }
  }
  if (obj.number > num) obj.number -= num;
  else store.stock.splice(what, 1);
}

/** Port of store_create_random() for the normal-item pool. */
function storeCreateRandom(store: Store, tables: StoreTables, rng: RNG): boolean {
  if (tables.normal.length === 0) return false;
  for (let tries = 0; tries < 6; tries++) {
    const kind = tables.normal[rng.randint0(tables.normal.length)]!;
    if (kind.cost < 1) continue;
    const obj = createStoreObject(kind);
    massProduce(obj, rng);
    if (storeCarryObj(store, obj)) return true;
  }
  return false;
}

/** Port of store_maint() for stores with 4.2.6 stocking tables. */
function storeMaintTables(store: Store, tables: StoreTables, rng: RNG): void {
  const { def } = tables;
  if (def.turnover) {
    let stock = store.stock.length - rng.randint1(def.turnover);
    stock = Math.min(Math.max(stock, 0), def.slotsMax);
    while (store.stock.length > stock) storeDeleteRandom(store, rng);
  } else if (tables.always.length && store.stock.length) {
    let sales = rng.randint1(store.stock.length);
    while (sales-- > 0 && store.stock.length) storeDeleteRandom(store, rng);
  }

  // Ensure staples exist, in full stacks
  for (const kind of tables.always) {
    let obj = store.stock.find(
      (o) => o.kind === kind && !storeSaleShouldReduceStock(store, o),
    );
    if (!obj) {
      const fresh = createStoreObject(kind);
      if (!storeCarryObj(store, fresh)) continue;
      obj = store.stock.find((o) => o === fresh) ?? store.stock.find((o) => o.kind === kind);
      if (!obj) continue;
    }
    obj.number = kind.base?.maxStack ?? 40;
  }

  if (def.turnover) {
    let stock = store.stock.length + rng.randint1(def.turnover);
    const min = def.slotsMin + tables.always.length;
    const max = def.slotsMax + tables.always.length;
    stock = Math.min(Math.max(stock, min), max);
    let attempts = 1000;
    while (store.stock.length < stock && attempts-- > 0) {
      storeCreateRandom(store, tables, rng);
    }
  }
}

/** Legacy tval-pool stocking, used for the black market and unknown kind lists. */
function legacyKinds(store: Store, depth: number, kinds: readonly ObjectKind[]): ObjectKind[] {
  const tvals = STORE_TVALS[store.type];
  if (!tvals) return [];
  return kinds.filter(
    (k) => tvals.has(k.tval) && k.allocProb > 0 && k.level <= depth + 10,
  );
}

function storeMaint(
  store: Store,
  kinds: readonly ObjectKind[],
  rng: RNG,
  depth = 0,
): void {
  const tables = resolveTables(store, kinds);
  if (tables) {
    storeMaintTables(store, tables, rng);
    return;
  }
  legacyMaintenance(store, depth, kinds, rng);
}

/**
 * Populate a store's initial inventory.
 *
 * Like store_reset() in 4.2.6 this runs ten rounds of maintenance, which
 * creates the always-stocked staples and a random selection of normal items.
 * The black market, and kind lists that do not contain the 4.2.6 item
 * names, fall back to a random draw from the store's tval list.
 */
export function initStoreStock(
  store: Store,
  depth: number,
  kinds: readonly ObjectKind[],
  rng: RNG,
): void {
  // Home starts empty
  if (store.type === StoreType.HOME) return;

  const tables = resolveTables(store, kinds);
  if (tables) {
    for (let i = 0; i < 10; i++) storeMaintTables(store, tables, rng);
    return;
  }

  const validKinds = legacyKinds(store, depth, kinds);
  if (validKinds.length === 0) return;

  // Stock between half and full capacity
  const targetStock = Math.max(
    1,
    Math.floor(store.maxStock / 2) + rng.randint0(Math.floor(store.maxStock / 2) + 1),
  );

  for (let i = 0; i < targetStock && store.stock.length < store.maxStock; i++) {
    const kind = validKinds[rng.randint0(validKinds.length)]!;
    const obj = createStoreObject(kind);
    store.stock.push(obj);
  }
}

/**
 * Perform store maintenance: sell off some old items, make sure the staples
 * are in stock, and add new items (store_maint in 4.2.6).
 */
export function storeMaintenance(
  store: Store,
  depth: number,
  kinds: readonly ObjectKind[],
  rng: RNG,
): void {
  // Home never has maintenance
  if (store.type === StoreType.HOME) return;
  storeMaint(store, kinds, rng, depth);
}

function legacyMaintenance(
  store: Store,
  depth: number,
  kinds: readonly ObjectKind[],
  rng: RNG,
): void {
  const turnover = store.turnover;

  // Remove some items
  const removeCount = Math.min(turnover, store.stock.length);
  for (let i = 0; i < removeCount; i++) {
    const idx = rng.randint0(store.stock.length);
    store.stock.splice(idx, 1);
  }

  const validKinds = legacyKinds(store, depth, kinds);
  if (validKinds.length === 0) return;

  const addCount = Math.min(
    turnover,
    store.maxStock - store.stock.length,
  );

  for (let i = 0; i < addCount; i++) {
    const kind = validKinds[rng.randint0(validKinds.length)]!;
    const obj = createStoreObject(kind);
    store.stock.push(obj);
  }
}

/**
 * Store an item in the player's home.
 *
 * @param store  - The home store.
 * @param player - The player.
 * @param obj    - The item to stash.
 */
export function homeStore(
  store: Store,
  player: Player,
  obj: ObjectType,
): boolean {
  if (store.type !== StoreType.HOME) return false;

  if (store.stock.length >= store.maxStock) return false;

  // Remove from player inventory
  const pGear = player as PlayerWithGear;
  ensureInventory(pGear);
  const idx = pGear.inventory.indexOf(obj);
  if (idx === -1) return false;

  pGear.inventory.splice(idx, 1);
  store.stock.push(obj);
  return true;
}

/**
 * Retrieve an item from the player's home.
 *
 * @param store  - The home store.
 * @param player - The player.
 * @param index  - Index of the item in home stock.
 * @returns The retrieved object, or null if the operation failed.
 */
export function homeRetrieve(
  store: Store,
  player: Player,
  index: number,
): ObjectType | null {
  if (store.type !== StoreType.HOME) return null;

  if (index < 0 || index >= store.stock.length) return null;

  // Check if player inventory is full
  const pGear = player as PlayerWithGear;
  ensureInventory(pGear);
  if (pGear.inventory.length >= MAX_PLAYER_INVENTORY) return null;

  const obj = store.stock[index]!;
  store.stock.splice(index, 1);
  pGear.inventory.push(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Matches MAX_INVENTORY_SIZE from gear.ts. */
const MAX_PLAYER_INVENTORY = 23;

/**
 * Extended Player with mutable inventory array.
 * Mirrors the PlayerWithGear pattern from gear.ts.
 */
interface PlayerWithGear extends Player {
  inventory: ObjectType[];
}

function ensureInventory(p: PlayerWithGear): void {
  if (!p.inventory) {
    p.inventory = [];
  }
}

/**
 * Create a minimal store-quality object from a kind template.
 *
 * In the full game this would call makeObject / applyMagic; here we
 * produce a lightweight item sufficient for store mechanics.
 */
function createStoreObject(kind: ObjectKind): ObjectType {
  const flags = new BitFlag(ObjectFlag.MAX);
  if (kind.base?.flags) flags.union(kind.base.flags);
  if (kind.flags) flags.union(kind.flags);
  return {
    kind,
    ego: null,
    artifact: null,
    prev: null,
    next: null,
    known: null,
    oidx: 0 as any,
    grid: { x: 0, y: 0 },
    tval: kind.tval,
    sval: kind.sval,
    pval: 0,
    weight: kind.weight,
    dd: kind.dd,
    ds: kind.ds,
    ac: kind.ac,
    toA: 0,
    toH: 0,
    toD: 0,
    flags,
    modifiers: new Array(16).fill(0),
    elInfo: [],
    brands: null,
    slays: null,
    curses: null,
    effect: kind.effect,
    effectMsg: kind.effectMsg,
    activation: kind.activation,
    time: kind.time,
    timeout: 0,
    number: 1,
    notice: 0,
    heldMIdx: 0,
    mimickingMIdx: 0,
    origin: 16 as any, // ObjectOrigin.STORE
    originDepth: 0,
    originRace: null,
    note: 0,
  } as ObjectType;
}
