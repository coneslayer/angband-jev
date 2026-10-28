/**
 * @file danger/model.ts
 * @brief Evaluates a danger model exported by tools/overnight/danger.py (LightGBM trees as JSON) inside busho.
 *
 * The model carries its feature names and vocabulary, so the features are built exactly as in training. Inputs are
 * rounded to float32 first, as the training matrix was. Split rules follow LightGBM's Tree::Decision: numerical
 * splits go left when value <= threshold, with NaN (or zero, for missing_type Zero) sent to the default side;
 * categorical splits go left when the integer value is in the split's category list, and NaN or negative values go
 * right.
 */

import * as fs from "node:fs";
import { Featurizer, FEATURE_NAMES, type Vocab } from "./features.js";
import type { DangerRecord } from "./record.js";

interface Leaf { leaf_value: number }
interface Split {
  split_feature: number;
  threshold: number | string;
  decision_type: "<=" | "==";
  default_left: boolean;
  missing_type: "None" | "Zero" | "NaN";
  left_child: Node;
  right_child: Node;
}
type Node = Leaf | Split;

export interface DangerModelJson {
  format: "danger-gbt-1";
  label: string;
  kind: "binary" | "regression";
  features: string[];
  categorical: string[];
  vocab: Vocab;
  trees: Node[];
  metrics?: unknown;
  parity?: { x: (number | null)[]; p: number }[];
}

/** Category lists parsed once per split ("1||3||5"). */
const catCache = new WeakMap<Split, Set<number>>();
function categories(s: Split): Set<number> {
  let c = catCache.get(s);
  if (!c) { c = new Set(String(s.threshold).split("||").map(Number)); catCache.set(s, c); }
  return c;
}

function leafValue(node: Node, x: ArrayLike<number>): number {
  while (!("leaf_value" in node)) {
    const v = x[node.split_feature]!;
    if (node.decision_type === "==") {
      node = !Number.isNaN(v) && v >= 0 && categories(node).has(Math.trunc(v)) ? node.left_child : node.right_child;
      continue;
    }
    let f = v;
    if (Number.isNaN(f) && node.missing_type !== "NaN") f = 0;
    if ((node.missing_type === "Zero" && Math.abs(f) <= 1e-35) || (node.missing_type === "NaN" && Number.isNaN(f))) {
      node = node.default_left ? node.left_child : node.right_child;
    } else {
      node = f <= (node.threshold as number) ? node.left_child : node.right_child;
    }
  }
  return node.leaf_value;
}

export class DangerModel {
  private fz: Featurizer;
  /** model feature j = featurizer feature cols[j] */
  private cols: number[];
  private full = new Float64Array(FEATURE_NAMES.length);

  constructor(readonly json: DangerModelJson) {
    if (json.format !== "danger-gbt-1") throw new Error(`unknown danger model format ${json.format}`);
    this.fz = new Featurizer(json.vocab);
    this.cols = json.features.map((f) => {
      const i = FEATURE_NAMES.indexOf(f);
      if (i < 0) throw new Error(`danger model feature ${f} is not built by this featurizer`);
      return i;
    });
  }

  static load(path: string): DangerModel {
    return new DangerModel(JSON.parse(fs.readFileSync(path, "utf-8")));
  }

  get label(): string { return this.json.label; }

  /** The prediction for a row of the model's own features (as in the parity rows). */
  predictRow(x: ArrayLike<number>): number {
    const xf = Float64Array.from(x as ArrayLike<number>, (v) => Math.fround(v));
    let raw = 0;
    for (const t of this.json.trees) raw += leafValue(t, xf);
    return this.json.kind === "binary" ? 1 / (1 + Math.exp(-raw)) : raw;
  }

  /** The prediction for a state's record (busho builds it with dangerRecord). */
  predict(rec: DangerRecord, character: { class: string; race: string }): number {
    this.fz.featurize(rec, character, this.full);
    return this.predictRow(this.cols.map((i) => this.full[i]!));
  }
}
