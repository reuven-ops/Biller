// In-process scheduler (brief section 12.1): checks every enabled source against its
// cadence and runs due couriers under database job locks. A plain interval check is
// the "node-cron or equivalent"; cadences are in days, so minute precision is enough.
import type { Pool } from '@advisor/db';
import type { Courier } from './courier.js';
import { runCourier } from './courier.js';

export interface SchedulerOptions {
  checkIntervalMs?: number;
  onRun?: (sourceId: string, outcome: { status: string; rowsWritten: number }) => void;
}

export function couriersById(couriers: Courier[]): Map<string, Courier> {
  return new Map(couriers.map((c) => [c.sourceId, c]));
}

/** One pass: run every enabled, registered courier whose cadence has elapsed. */
export async function runDueCouriers(
  pool: Pool,
  registry: Map<string, Courier>,
  onRun?: SchedulerOptions['onRun'],
): Promise<string[]> {
  const due = await pool.query<{ id: string }>(
    `SELECT id FROM sources
     WHERE enabled
       AND cadence_days > 0
       AND (last_success_at IS NULL
            OR last_success_at < now() - cadence_days * interval '1 day')
     ORDER BY id`,
  );
  const ran: string[] = [];
  for (const row of due.rows) {
    const courier = registry.get(row.id);
    if (!courier) continue; // registered in a later phase
    const outcome = await runCourier(pool, courier);
    if (outcome.ran) {
      ran.push(row.id);
      onRun?.(row.id, { status: outcome.status, rowsWritten: outcome.rowsWritten });
    }
  }
  return ran;
}

export function startScheduler(
  pool: Pool,
  registry: Map<string, Courier>,
  opts: SchedulerOptions = {},
): { stop: () => void } {
  const interval = opts.checkIntervalMs ?? 15 * 60 * 1000;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runDueCouriers(pool, registry, opts.onRun);
    } catch (err) {
      console.error(`scheduler: pass failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), interval);
  return {
    stop: () => clearInterval(timer),
  };
}
