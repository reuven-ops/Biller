// Worker entry. Phase 0: connects, syncs the source registry, and idles.
// The courier scheduler with job locks lands in Phase 1 (PLAN.md M1.1).
import { getPool, closePool } from '@advisor/db';
import { syncSources } from './sync-sources.js';

const pool = getPool();
const n = await syncSources(pool);
console.log(`worker: source registry synced (${n} sources). Scheduler lands in Phase 1.`);

let stopping = false;
function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`worker: ${signal} received, shutting down.`);
  void closePool().then(() => process.exit(0));
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

setInterval(() => {
  // heartbeat placeholder until the Phase 1 scheduler replaces this loop
}, 60_000);
