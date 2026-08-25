// Embedding backfill: fills chunks.embedding where NULL using the local model
// (docs/DECISIONS.md D12). Batched for CPU; safe to re-run and to interrupt.
import type { Pool } from '@advisor/db';
import { embedPassages, toVectorLiteral } from './inference.js';

export interface BackfillProgress {
  embedded: number;
  remaining: number;
}

export async function embedBackfill(
  pool: Pool,
  opts: { batchSize?: number; onProgress?: (p: BackfillProgress) => void } = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? 16;
  let total = 0;
  for (;;) {
    const batch = await pool.query<{ id: string; text: string }>(
      `SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT $1`,
      [batchSize],
    );
    if (batch.rowCount === 0) break;
    const vectors = await embedPassages(batch.rows.map((r) => r.text.slice(0, 4000)));
    for (let i = 0; i < batch.rows.length; i++) {
      await pool.query(`UPDATE chunks SET embedding = $2::vector WHERE id = $1`, [
        batch.rows[i]!.id,
        toVectorLiteral(vectors[i]!),
      ]);
    }
    total += batch.rows.length;
    if (opts.onProgress) {
      const remaining = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM chunks WHERE embedding IS NULL`,
      );
      opts.onProgress({ embedded: total, remaining: Number(remaining.rows[0]?.n ?? 0) });
    }
  }
  return total;
}
