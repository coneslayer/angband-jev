/**
 * @file store/store-data.ts
 * @brief Store stocking tables (port of lib/gamedata/store.txt, 4.2.6)
 *
 * Indices follow StoreType: 0 General, 1 Armory, 2 Weaponsmith, 3 Bookseller,
 * 4 Alchemist, 5 Magic shop, 6 Black market.  "always" items are permanent,
 * infinite-supply staples; "normal" items are the random-stock pool.
 * Books (the Bookseller's "always" entries) are not object kinds in this
 * port, so the Bookseller carries nothing.
 */

import { TVal } from "../types/index.js";

export interface StoreDef {
  readonly slotsMin: number;
  readonly slotsMax: number;
  readonly turnover: number;
  readonly always: readonly (readonly [TVal, string])[];
  readonly normal: readonly (readonly [TVal, string])[];
}

export const STORE_DEFS: Readonly<Record<number, StoreDef>> = {
  0: {
    slotsMin: 0,
    slotsMax: 4,
    turnover: 2,
    always: [
      [TVal.CLOAK, "Cloak"],
      [TVal.FOOD, "Ration of Food"],
      [TVal.LIGHT, "Wooden Torch"],
      [TVal.FLASK, "Flask of Oil"],
      [TVal.DIGGING, "Shovel"],
      [TVal.DIGGING, "Pick"],
      [TVal.SHOT, "Iron Shot"],
      [TVal.ARROW, "Arrow"],
      [TVal.BOLT, "Bolt"],
    ],
    normal: [
      [TVal.FOOD, "Pint of Fine Wine"],
      [TVal.FOOD, "Slime Mold"],
      [TVal.FOOD, "Flask of Whisky"],
      [TVal.FOOD, "Hard Biscuit"],
      [TVal.MUSHROOM, "Stoneskin"],
      [TVal.MUSHROOM, "Purging"],
    ],
  },
  1: {
    slotsMin: 6,
    slotsMax: 18,
    turnover: 9,
    always: [
    ],
    normal: [
      [TVal.BOOTS, "Pair of Leather Sandals"],
      [TVal.BOOTS, "Pair of Leather Boots"],
      [TVal.BOOTS, "Pair of Iron Shod Boots"],
      [TVal.HELM, "Hard Leather Cap"],
      [TVal.HELM, "Metal Cap"],
      [TVal.HELM, "Iron Helm"],
      [TVal.SOFT_ARMOR, "Robe"],
      [TVal.SOFT_ARMOR, "Soft Leather Armour"],
      [TVal.SOFT_ARMOR, "Studded Leather Armour"],
      [TVal.SOFT_ARMOR, "Hard Leather Armour"],
      [TVal.SOFT_ARMOR, "Leather Scale Mail"],
      [TVal.HARD_ARMOR, "Metal Scale Mail"],
      [TVal.HARD_ARMOR, "Chain Mail"],
      [TVal.GLOVES, "Set of Leather Gloves"],
      [TVal.GLOVES, "Set of Gauntlets"],
      [TVal.SHIELD, "Wicker Shield"],
      [TVal.SHIELD, "Small Metal Shield"],
      [TVal.SHIELD, "Leather Shield"],
    ],
  },
  2: {
    slotsMin: 3,
    slotsMax: 14,
    turnover: 9,
    always: [
    ],
    normal: [
      [TVal.SHOT, "Iron Shot"],
      [TVal.ARROW, "Arrow"],
      [TVal.BOLT, "Bolt"],
      [TVal.SWORD, "Dagger"],
      [TVal.SWORD, "Main Gauche"],
      [TVal.SWORD, "Rapier"],
      [TVal.SWORD, "Short Sword"],
      [TVal.SWORD, "Cutlass"],
      [TVal.SWORD, "Tulwar"],
      [TVal.SWORD, "Broad Sword"],
      [TVal.SWORD, "Long Sword"],
      [TVal.SWORD, "Scimitar"],
      [TVal.SWORD, "Katana"],
      [TVal.SWORD, "Bastard Sword"],
      [TVal.POLEARM, "Spear"],
      [TVal.POLEARM, "Awl-Pike"],
      [TVal.POLEARM, "Trident"],
      [TVal.POLEARM, "Pike"],
      [TVal.POLEARM, "Beaked Axe"],
      [TVal.POLEARM, "Broad Axe"],
      [TVal.POLEARM, "Battle Axe"],
      [TVal.POLEARM, "Lance"],
      [TVal.POLEARM, "Lucerne Hammer"],
      [TVal.HAFTED, "Whip"],
      [TVal.BOW, "Sling"],
      [TVal.BOW, "Short Bow"],
      [TVal.BOW, "Long Bow"],
      [TVal.BOW, "Light Crossbow"],
    ],
  },
  3: {
    slotsMin: 0,
    slotsMax: 2,
    turnover: 0,
    always: [
    ],
    normal: [
    ],
  },
  4: {
    slotsMin: 6,
    slotsMax: 10,
    turnover: 9,
    always: [
      [TVal.SCROLL, "Word of Recall"],
      [TVal.SCROLL, "Phase Door"],
      [TVal.SCROLL, "Remove Curse"],
      [TVal.POTION, "Cure Light Wounds"],
    ],
    normal: [
      [TVal.SCROLL, "Monster Confusion"],
      [TVal.SCROLL, "Magic Mapping"],
      [TVal.SCROLL, "Detect Invisible"],
      [TVal.SCROLL, "Recharging"],
      [TVal.SCROLL, "Remove Hunger"],
      [TVal.SCROLL, "Blessing"],
      [TVal.SCROLL, "Holy Chant"],
      [TVal.POTION, "Boldness"],
      [TVal.POTION, "Berserk Strength"],
      [TVal.POTION, "Resist Heat"],
      [TVal.POTION, "Resist Cold"],
      [TVal.POTION, "Restore Life Levels"],
      [TVal.POTION, "Neutralize Poison"],
      [TVal.POTION, "Cure Serious Wounds"],
      [TVal.POTION, "Cure Critical Wounds"],
    ],
  },
  5: {
    slotsMin: 4,
    slotsMax: 14,
    turnover: 9,
    always: [
    ],
    normal: [
      [TVal.RING, "Searching"],
      [TVal.RING, "Feather Falling"],
      [TVal.RING, "Protection"],
      [TVal.RING, "Open Wounds"],
      [TVal.AMULET, "Slow Digestion"],
      [TVal.AMULET, "Resist Acid"],
      [TVal.WAND, "Light"],
      [TVal.WAND, "Slow Monster"],
      [TVal.WAND, "Confuse Monster"],
      [TVal.WAND, "Magic Missile"],
      [TVal.WAND, "Stinking Cloud"],
      [TVal.WAND, "Stone to Mud"],
      [TVal.STAFF, "Teleportation"],
      [TVal.STAFF, "Light"],
      [TVal.STAFF, "Mapping"],
      [TVal.STAFF, "Detect Invisible"],
      [TVal.STAFF, "Detect Evil"],
    ],
  },
  6: {
    slotsMin: 6,
    slotsMax: 18,
    turnover: 9,
    always: [
    ],
    normal: [
    ],
  },
};

/** Normalise a kind name the way object.txt names are written ("& Flask~ of oil"). */
export function cleanKindName(name: string): string {
  return name.replace(/^& /, "").replace(/~/g, "").trim().toLowerCase();
}
