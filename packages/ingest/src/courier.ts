// Courier contract and the run wrapper: ingest_runs bookkeeping, job lock, and
// source last_run/last_success/last_error updates. Couriers are idempotent; a re-run
// against unchanged upstream data writes zero new rows (brief section 8.8).
import type { Pool } from '@advisor/db';
import { Fetcher } from './fetcher.js';
import { withJobLock } from './job-locks.js';

export interface CourierContext {
  pool: Pool;
  fetcher: Fetcher;
  /** Sample mode: process at most this many records or documents (brief section 8.9). */
  limit?: number | undefined;
}

export interface CourierResult {
  rowsWritten: number;
  notes: string;
}

export interface Courier {
  sourceId: string;
  run: (ctx: CourierContext) => Promise<CourierResult>;
}

export interface RunOutcome {
  ran: boolean;
  status: 'succeeded' | 'failed' | 'skipped';
  rowsWritten: number;
  notes: string;
  error?: string;
}

export async function runCourier(
  pool: Pool,
  courier: Courier,
  opts: { limit?: number | undefined; fetcher?: Fetcher } = {},
): Promise<RunOutcome> {
  const outcome = await withJobLock(pool, `courier:${courier.sourceId}`, async () => {
    const started = await pool.query<{ id: string }>(
      `INSERT INTO ingest_runs (source_id, status) VALUES ($1, 'running') RETURNING id`,
      [courier.sourceId],
    );
    const runId = started.rows[0]?.id;
    await pool.query(`UPDATE sources SET last_run_at = now() WHERE id = $1`, [courier.sourceId]);
    try {
      const result = await courier.run({
        pool,
        fetcher: opts.fetcher ?? new Fetcher(),
        limit: opts.limit,
      });
      await pool.query(
        `UPDATE ingest_runs SET finished_at = now(), status = 'succeeded',
           rows_written = $2, notes = $3 WHERE id = $1`,
        [runId, result.rowsWritten, result.notes],
      );
      await pool.query(
        `UPDATE sources SET last_success_at = now(), last_error = NULL WHERE id = $1`,
        [courier.sourceId],
      );
      return { status: 'succeeded' as const, ...result };
    } catch (err) {
      const message = (err as Error).message;
      await pool.query(
        `UPDATE ingest_runs SET finished_at = now(), status = 'failed', error = $2 WHERE id = $1`,
        [runId, message],
      );
      await pool.query(`UPDATE sources SET last_error = $2 WHERE id = $1`, [
        courier.sourceId,
        message,
      ]);
      return { status: 'failed' as const, rowsWritten: 0, notes: '', error: message };
    }
  });

  if (!outcome.ran || !outcome.result) {
    return {
      ran: false,
      status: 'skipped',
      rowsWritten: 0,
      notes: 'another worker holds the lock',
    };
  }
  const r = outcome.result;
  return {
    ran: true,
    status: r.status,
    rowsWritten: r.rowsWritten,
    notes: r.notes,
    ...(r.status === 'failed' ? { error: r.error } : {}),
  };
}
