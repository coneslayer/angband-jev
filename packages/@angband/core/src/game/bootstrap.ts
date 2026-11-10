/**
 * @file game/bootstrap.ts
 * @brief New-character setup: starting kit, auto-equip, derived stats
 *
 * Port of player_outfit() / wield_all() in player-birth.c.
 *
 * Copyright (c) 1997 Ben Harrison, James E. Wilson, Robert A. Koeneke
 *
 * This work is free software; you can redistribute it and/or modify it
 * under the terms of either GPL-2.0 or the Angband licence.
 */

import { RNG, Aspect } from "../z/index.js";
import type { ObjectType, ObjectKind, Player, StartItem } from "../types/index.js";
import { EquipSlot, ObjectOrigin } from "../types/index.js";
import { createObjectFromKind } from "../object/make.js";
import { findEquipSlotForItem, equipItem } from "../object/gear.js";
import { calcBonuses, calcMana } from "../player/calcs.js";
import { objectBaseValue } from "../store/store.js";

type PlayerWithGear = Player & {
  inventory?: ObjectType[];
  equipment?: (ObjectType | null)[];
};

/** "& Ration~ of Food" -> "ration of food" */
function cleanKindName(name: string): string {
  return name.replace(/^& /, "").replace(/~/g, "").trim().toLowerCase();
}

/** class.json uses British spellings ("soft armour"); object bases use "soft armor". */
function normalizeTvalName(name: string): string {
  return name.toLowerCase().replace(/_/g, " ").replace(/armour/g, "armor").trim();
}

/**
 * Find the object kind for a class start item.
 *
 * Start items parsed from class.json carry names only (tval/sval are 0), so
 * match on the kind name, preferring a kind whose base matches the tval name.
 */
export function findStartItemKind(
  item: StartItem,
  kinds: readonly ObjectKind[],
): ObjectKind | null {
  if (item.tval > 0) {
    return kinds.find((k) => k.tval === item.tval && k.sval === item.sval) ?? null;
  }
  if (!item.svalName) return null;

  const wanted = item.svalName.toLowerCase();
  const matches = kinds.filter((k) => cleanKindName(k.name) === wanted);
  if (matches.length <= 1 || !item.tvalName) return matches[0] ?? null;

  const tvalName = normalizeTvalName(item.tvalName);
  return matches.find((k) => k.base && normalizeTvalName(k.base.name) === tvalName) ?? matches[0]!;
}

/**
 * Create a birth-quality object (object_prep with MINIMISE, as player_outfit does).
 * MINIMISE takes the low end of every random value, so no RNG draws are consumed.
 */
export function createStartObject(kind: ObjectKind, qty: number): ObjectType {
  const obj = createObjectFromKind(kind, new RNG(), 0, Aspect.MINIMISE);
  return { ...obj, number: Math.max(1, qty), origin: ObjectOrigin.BIRTH } as ObjectType;
}

/**
 * Give the player their class's starting kit (port of player_outfit).
 * As in 4.2, each item's value is deducted from the starting gold.
 */
export function giveStartingItems(
  player: Player,
  kinds: readonly ObjectKind[],
  rng: RNG,
): void {
  const p = player as PlayerWithGear;
  if (!p.inventory) p.inventory = [];

  for (const item of player.class.startItems) {
    const kind = findStartItemKind(item, kinds);
    if (!kind) continue;
    const qty = item.max > item.min ? rng.range(item.min, item.max) : item.min;
    if (qty <= 0) continue;
    const obj = createStartObject(kind, qty);
    player.au -= objectBaseValue(obj) * obj.number;
    p.inventory.push(obj);
  }
  if (player.au < 0) player.au = 0;
}

/** Rough worth of an item in its slot, used to pick between candidates. */
function equipScore(obj: ObjectType): number {
  if (findEquipSlotForItem(obj) === EquipSlot.WEAPON) {
    return (obj.dd * (obj.ds + 1)) / 2 + obj.toD + obj.toH / 2;
  }
  return obj.ac + obj.toA;
}

/**
 * Wield the best wearable item from the inventory into each empty slot
 * (port of wield_all). Stacks are split so one unit is worn and the rest stay.
 */
export function autoEquipStartingItems(player: Player): void {
  const p = player as PlayerWithGear;
  if (!p.inventory) return;

  const best = new Map<EquipSlot, ObjectType>();
  for (const obj of p.inventory) {
    const slot = findEquipSlotForItem(obj);
    if (slot === null || p.equipment?.[slot]) continue;
    const current = best.get(slot);
    if (!current || equipScore(obj) > equipScore(current)) best.set(slot, obj);
  }

  for (const [slot, obj] of best) {
    const idx = p.inventory.indexOf(obj);
    if (obj.number > 1) {
      p.inventory[idx] = { ...obj, number: obj.number - 1 } as ObjectType;
      equipItem(player, { ...obj, number: 1 } as ObjectType, slot);
    } else {
      p.inventory.splice(idx, 1);
      equipItem(player, obj, slot);
    }
  }
}

/** Starting kit, auto-equip, then derived stats and mana. */
export function initializeNewPlayer(
  player: Player,
  kinds: readonly ObjectKind[],
  rng: RNG,
): void {
  giveStartingItems(player, kinds, rng);
  autoEquipStartingItems(player);
  player.state = calcBonuses(player);
  const msp = calcMana(player);
  if (msp > 0) {
    player.msp = msp;
    player.csp = msp;
  }
}
