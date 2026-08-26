// Worker entry: syncs the source registry, runs the courier scheduler with
// database job locks (brief section 12.1), and keeps chunk embeddings filled.
import { getPool, closePool, intEnv } from '@advisor/db';
import { embedBackfill } from '@advisor/core';
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

// Embedding backfill: after each pass, newly chunked documents get vectors so the
// dense retrieval arm stays complete; the text arm covers the gap in between.
const embedIntervalMs = intEnv('EMBED_INTERVAL_MINUTES', 10) * 60 * 1000;
let embedding = false;
const embedTick = async (): Promise<void> => {
  if (embedding) return;
  embedding = true;
  try {
    const embedded = await embedBackfill(pool);
    if (embedded > 0) console.log(`worker: embedded ${embedded} chunks`);
  } catch (err) {
    console.error(`worker: embed backfill failed: ${(err as Error).message}`);
  } finally {
    embedding = false;
  }
};
void embedTick();
const embedTimer = setInterval(() => void embedTick(), embedIntervalMs);

let stopping = false;
function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`worker: ${signal} received, shutting down.`);
  scheduler.stop();
  clearInterval(embedTimer);
  void closePool().then(() => process.exit(0));
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
