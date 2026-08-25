import { closePool, getPool } from '@advisor/db';
import { syncSources } from '@advisor/ingest';

export async function runIngestCommand(args: string[]): Promise<void> {
  const sourceId = args.find((a) => !a.startsWith('--'));
  if (!sourceId) {
    console.error('Usage: pnpm ingest <source_id> [--limit N]');
    process.exitCode = 1;
    return;
  }
  const pool = getPool();
  try {
    await syncSources(pool);
    const res = await pool.query<{ id: string; enabled: boolean }>(
      'SELECT id, enabled FROM sources WHERE id = $1',
      [sourceId],
    );
    const row = res.rows[0];
    if (!row) {
      console.error(`Unknown source: ${sourceId}. See config/sources.yaml.`);
      process.exitCode = 1;
      return;
    }
    if (!row.enabled) {
      console.error(`Source ${sourceId} is disabled in config/sources.yaml.`);
      process.exitCode = 1;
      return;
    }
    // Couriers land in Phase 1 (PLAN.md M1.1 to M1.3); the registry sync above is real.
    console.error(`The courier for ${sourceId} lands in Phase 1. Registry is synced.`);
    process.exitCode = 2;
  } finally {
    await closePool();
  }
}
