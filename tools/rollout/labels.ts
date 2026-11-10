/**
 * @file rollout/labels.ts
 * @brief Shared label computation: per-seed utility matrix -> win-share probabilities (ties split)
 */

export const EPS = 1e-9;

/** u[seedIndex][optionIndex] (null seeds are skipped by the caller). Returns per-option win share over seeds. */
export function winShares(u: number[][], nOpt: number): number[] {
  const wins = new Array<number>(nOpt).fill(0);
  if (u.length === 0) return wins;
  for (const row of u) {
    const best = Math.max(...row);
    const winners: number[] = [];
    row.forEach((v, i) => { if (v >= best - EPS) winners.push(i); });
    for (const i of winners) wins[i] += 1 / winners.length;
  }
  return wins.map((w) => w / u.length);
}

/** Option indices whose probability is maximal (the label argmax set). */
export function argmaxSet(p: number[]): number[] {
  const m = Math.max(...p);
  const s: number[] = [];
  p.forEach((v, i) => { if (v >= m - EPS) s.push(i); });
  return s;
}

/** True when every option has the same U in every seed (label carries no information). */
export function allTie(u: number[][]): boolean {
  return u.length > 0 && u.every((row) => Math.max(...row) - Math.min(...row) < EPS);
}
