// Worker entry: syncs the source registry, then runs the courier scheduler with
// database job locks (brief section 12.1).
import { getPool, closePool } from '@advisor/db';
import { syncSources } from './sync-sources.js';
import { couriersById, startScheduler } from './scheduler.js';
import { ALL_COURIERS } from './couriers/index.js';

const pool = getPool();
const n = await syncSources(pool);
console.log(`worker: source registry synced (${n} sources).`);

const scheduler = startScheduler(pool, couriersById(ALL_COURIERS), {
  onRun: (sourceId, outcome) => {
    console.log(`worker: ${sourceId} ${outcome.status}, ${outcome.rowsWritten} rows`);
  },
});
console.log(`worker: scheduler running (${ALL_COURIERS.length} couriers registered).`);

let stopping = false;
function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`worker: ${signal} received, shutting down.`);
  scheduler.stop();
  void closePool().then(() => process.exit(0));
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
