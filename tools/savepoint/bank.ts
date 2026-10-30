/**
 * @file savepoint/bank.ts
 * @brief セーブポイントバンク (Phase 1c): 階層進入時に /snapshot を保存する
 *
 * SAVEPOINT_DIR 指定時のみ有効。
 *  - 新しい最深階に入り depth >= SAVEPOINT_MIN_DEPTH (既定5) なら kind:"level-entry" で書き出す。
 *  - 直近3つの階層進入スナップショットを (DL1 から) メモリに保持し、死亡時に kind:"pre-death" で書き出す。
 * ファイル: ${dir}/<game_id>-DL<depth>-<turn>.json.gz, 索引: ${dir}/index.jsonl
 */
import * as fs from "node:fs";
import * as zlib from "node:zlib";

export interface SavepointMeta {
  file: string; game_id: string; seed: number | null; race: string; class: string;
  depth: number; player_level: number; turn: number; hp: number; max_hp: number;
  kind: "level-entry" | "pre-death"; death_cause?: string;
}

interface RingEntry { meta: Omit<SavepointMeta, "kind">; gz: Buffer }

export class SavepointBank {
  readonly dir: string | null;
  readonly minDepth: number;
  private ring: RingEntry[] = [];
  private deepest = 0;
  private warned = false;

  constructor(dir = process.env.SAVEPOINT_DIR ?? "", minDepth = Number(process.env.SAVEPOINT_MIN_DEPTH ?? "5")) {
    this.dir = dir ? dir : null;
    this.minDepth = minDepth;
  }

  get enabled(): boolean { return this.dir !== null; }

  private writeFile(m: Omit<SavepointMeta, "kind">, gz: Buffer, kind: SavepointMeta["kind"], deathCause?: string) {
    const dir = this.dir!;
    fs.mkdirSync(dir, { recursive: true });
    const path = `${dir}/${m.file}`;
    if (!fs.existsSync(path)) fs.writeFileSync(path, gz);
    const line: SavepointMeta = { ...m, kind, ...(deathCause !== undefined ? { death_cause: deathCause } : {}) };
    fs.appendFileSync(`${dir}/index.jsonl`, JSON.stringify(line) + "\n");
  }

  /** 階層に入った直後 (サーバがコマンド待ちの時) に呼ぶ。fetchSnapshot は /snapshot の本文 (JSON文字列) を返す */
  async onLevelEntry(
    state: any, gameId: string, seed: number | null, fetchSnapshot: () => Promise<string | null>,
  ): Promise<void> {
    if (!this.dir || state.depth < 1) return;
    try {
      const body = await fetchSnapshot();
      if (!body) {
        if (!this.warned) { this.warned = true; console.log("  [SAVEPOINT] snapshot unavailable; skipping"); }
        return;
      }
      const p = state.player;
      const gz = zlib.gzipSync(body);
      const meta = {
        file: `${gameId}-DL${state.depth}-${state.turn}.json.gz`, game_id: gameId, seed,
        race: p.race, class: p.class, depth: state.depth, player_level: p.level,
        turn: state.turn, hp: p.hp, max_hp: p.maxHp,
      };
      this.ring.push({ meta, gz });
      if (this.ring.length > 3) this.ring.shift();
      if (state.depth > this.deepest) {
        this.deepest = state.depth;
        if (state.depth >= this.minDepth) {
          this.writeFile(meta, gz, "level-entry");
          console.log(`  [SAVEPOINT] ${meta.file}`);
        }
      }
    } catch (e) {
      console.log(`  [SAVEPOINT] error: ${(e as Error).message}`);
    }
  }

  /** 死亡時: 直近の階層進入スナップショットを pre-death として書き出す */
  onDeath(deathCause: string): number {
    if (!this.dir) return 0;
    try {
      for (const r of this.ring) this.writeFile(r.meta, r.gz, "pre-death", deathCause);
      if (this.ring.length) console.log(`  [SAVEPOINT] pre-death ${this.ring.length}件`);
      return this.ring.length;
    } catch (e) {
      console.log(`  [SAVEPOINT] error: ${(e as Error).message}`);
      return 0;
    }
  }
}
