#!/usr/bin/env npx tsx
/**
 * @file savepoint/launch.ts
 * @brief バンクのセーブポイントからゲームを再開する: POST /restore {save, seed} → 復元後の状態要約を表示
 *
 * 使い方 (サーバは別途起動済み。VANILLA=1 STAT_FLOOR=0 は元ゲームと揃える):
 *   npx tsx tools/savepoint/launch.ts <savepoint.json.gz> <seed> <server-url>
 *   例) npx tsx tools/savepoint/launch.ts /bank/101-human-warrior-1-DL5-900.json.gz 7 http://localhost:3510
 * 続けて busho をそのサーバに向ける (復元後の状態から通常プレイ):
 *   API=http://localhost:3510 LLM_BACKEND=anthropic npx tsx tools/busho-player.ts
 * ロールアウト (復元状態から強制オプションで H 手だけルール実行し ROLLOUT_RESULT を1行出す):
 *   API=... ROLLOUT_FORCE=fight:flee ROLLOUT_HORIZON=150 npx tsx tools/busho-player.ts
 * ファイルは GET /snapshot の本文 ({turn, depth, save}) を gzip したもの。/restore へは .save を渡す。
 */
import * as fs from "node:fs";
import * as zlib from "node:zlib";

export async function restoreSavepoint(file: string, seed: number | undefined, api: string): Promise<any> {
  const raw = fs.readFileSync(file);
  const text = (raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw).toString("utf-8");
  const snap = JSON.parse(text);
  const save = snap.save ?? snap;
  const res = await fetch(`${api}/restore`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(seed === undefined ? { save } : { save, seed }),
  });
  if (res.status === 404) throw new Error(`${api}/restore not found (404): the server has no /restore yet`);
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`restore failed: HTTP ${res.status} ${body.error ?? ""}`);
  return body;
}

export function summarize(st: any): string {
  const p = st.player;
  return `${p.race} ${p.class} CL${p.level} DL${st.depth} HP ${p.hp}/${p.maxHp} turn ${st.turn} gold ${p.gold} ` +
    `inv ${p.inventory.length} items, ${st.monsters.length} monsters in view`;
}

async function main() {
  const [file, seedArg, api] = process.argv.slice(2);
  if (!file || !api) {
    console.error("usage: launch.ts <savepoint.json.gz> <seed|-> <server-url>");
    process.exit(2);
  }
  const seed = seedArg === undefined || seedArg === "-" ? undefined : Number(seedArg);
  try {
    const st = await restoreSavepoint(file, seed, api);
    console.log(`restored (seed ${seed ?? "unchanged"}): ${summarize(st)}`);
  } catch (e) {
    console.error(`launch failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
if (process.argv[1] && /launch\.[tj]s$/.test(process.argv[1])) main();
