#!/usr/bin/env npx tsx
/**
 * @file rollout/noise.ts
 * @brief Label-noise check: split-half (seeds 1..K/2 vs K/2+1..K) argmax agreement per decision_type
 *
 * Usage: npx tsx tools/rollout/noise.ts <train.jsonl> [more.jsonl ...]
 * Agreement = the two halves' argmax sets intersect (ties count as agreement). The plan drops a type below ~70%.
 */
import * as fs from "node:fs";
import { winShares, argmaxSet, allTie } from "./labels";

interface Agg { n: number; agree: number; infAgree: number; infUsable: number; allTie: number; usable: number; hist: Record<string, number>; }
const per: Record<string, Agg> = {};
for (const f of process.argv.slice(2)) for (const l of fs.readFileSync(f, "utf-8").split("\n")) {
  if (!l.trim()) continue;
  const m = JSON.parse(l).meta;
  if (!m?.u_mean || !m.u_matrix) continue; // unlabelled
  const opts: string[] = m.options, K: number = m.K;
  const seeds: number[] = m.paired_seeds;
  const rows = (ks: number[]) => ks.map((k) => opts.map((o) => m.u_matrix[o][k - 1] as number));
  const a = per[m.decision_type] ??= { n: 0, agree: 0, infAgree: 0, infUsable: 0, allTie: 0, usable: 0, hist: {} };
  a.n++;
  const full = rows(seeds);
  if (allTie(full)) a.allTie++;
  const h1 = seeds.filter((k) => k <= K / 2), h2 = seeds.filter((k) => k > K / 2);
  if (!h1.length || !h2.length) continue;
  a.usable++;
  const s1 = argmaxSet(winShares(rows(h1), opts.length)), s2 = argmaxSet(winShares(rows(h2), opts.length));
  const ok = s1.some((i) => s2.includes(i));
  if (ok) a.agree++;
  if (!allTie(full)) { a.infUsable++; if (ok) a.infAgree++; }
  const w = argmaxSet(winShares(full, opts.length)).map((i) => opts[i]).join("+");
  a.hist[w] = (a.hist[w] ?? 0) + 1;
}
for (const [t, a] of Object.entries(per)) {
  const pct = (x: number, d: number) => (d ? (100 * x / d).toFixed(1) + "%" : "n/a");
  console.log(`${t.padEnd(8)} records=${a.n} split-half agreement=${pct(a.agree, a.usable)} (${a.agree}/${a.usable})  excluding all-tie records=${pct(a.infAgree, a.infUsable)} (${a.infAgree}/${a.infUsable})  all-options-tie=${pct(a.allTie, a.n)} (${a.allTie})  ${(a.usable ? a.agree / a.usable : 0) < 0.7 ? "BELOW 70%" : "ok"}`);
  console.log(`         argmax distribution: ${JSON.stringify(a.hist)}`);
}
