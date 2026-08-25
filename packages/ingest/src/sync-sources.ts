import type { Pool } from '@advisor/db';
import { loadSources } from '@advisor/core/config';

/**
 * Upserts config/sources.yaml into the sources table. Config is the source of truth
 * for registry fields; run-state columns (last_run_at, last_success_at, last_error)
 * are preserved.
 */
export async function syncSources(pool: Pool): Promise<number> {
  const sources = await loadSources();
  for (const s of sources) {
    await pool.query(
      `INSERT INTO sources (id, name, publisher, kind, base_url, cadence_days, tier,
                            license_required, enabled, config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         publisher = EXCLUDED.publisher,
         kind = EXCLUDED.kind,
         base_url = EXCLUDED.base_url,
         cadence_days = EXCLUDED.cadence_days,
         tier = EXCLUDED.tier,
         license_required = EXCLUDED.license_required,
         enabled = EXCLUDED.enabled,
         config = EXCLUDED.config`,
      [
        s.id,
        s.name,
        s.publisher,
        s.kind,
        s.base_url,
        s.cadence_days,
        s.tier,
        s.license_required,
        s.enabled,
        JSON.stringify(s.config ?? {}),
      ],
    );
  }
  return sources.length;
}
