import { closePool, getPool } from '@advisor/db';
import { ALL_COURIERS, runCourier, syncSources } from '@advisor/ingest';

export async function runIngestCommand(args: string[]): Promise<void> {
  const sourceId = args.find((a) => !a.startsWith('--'));
  const limitIdx = args.indexOf('--limit');
  const limitRaw = limitIdx >= 0 ? args[limitIdx + 1] : undefined;
  const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
  if (!sourceId || (limit !== undefined && Number.isNaN(limit))) {
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
    const courier = ALL_COURIERS.find((c) => c.sourceId === sourceId);
    if (!courier) {
      console.error(
        `No courier registered for ${sourceId} yet. Registered: ` +
          `${ALL_COURIERS.map((c) => c.sourceId).join(', ') || 'none'}.`,
      );
      process.exitCode = 2;
      return;
    }
    const outcome = await runCourier(pool, courier, { limit });
    if (!outcome.ran) {
      console.error('Another worker holds the lock for this courier; not run.');
      process.exitCode = 3;
      return;
    }
    console.log(
      `${sourceId}: ${outcome.status}, ${outcome.rowsWritten} rows written.` +
        (outcome.notes ? ` ${outcome.notes}` : ''),
    );
    if (outcome.status === 'failed') {
      console.error(`error: ${outcome.error ?? 'unknown'}`);
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
