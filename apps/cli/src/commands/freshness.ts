import { closePool, getPool } from '@advisor/db';

interface FreshnessRow {
  id: string;
  enabled: boolean;
  cadence_days: number;
  last_success_at: Date | null;
  last_error: string | null;
  stale: boolean;
}

export async function runFreshnessCommand(): Promise<void> {
  const pool = getPool();
  try {
    const res = await pool.query<FreshnessRow>(
      `SELECT id, enabled, cadence_days, last_success_at, last_error,
              (last_error IS NOT NULL
               OR last_success_at IS NULL
               OR now() - last_success_at > (cadence_days * interval '1 day') * 1.5) AS stale
       FROM sources
       WHERE enabled
       ORDER BY id`,
    );
    if (res.rowCount === 0) {
      console.log('No enabled sources in the database. Run pnpm db:migrate, then pnpm ingest.');
      return;
    }
    const width = Math.max(...res.rows.map((r) => r.id.length));
    console.log(`${'source'.padEnd(width)}  cadence  last success          status`);
    for (const r of res.rows) {
      const last = r.last_success_at ? r.last_success_at.toISOString() : 'never';
      const status = r.stale ? 'STALE' : 'fresh';
      console.log(
        `${r.id.padEnd(width)}  ${String(r.cadence_days).padStart(7)}  ${last.padEnd(20)}  ${status}`,
      );
    }
  } finally {
    await closePool();
  }
}
