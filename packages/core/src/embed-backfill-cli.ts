import { closePool, getPool } from '@advisor/db';
import { embedBackfill } from './embed-backfill.js';

const pool = getPool();
let lastLog = 0;
const total = await embedBackfill(pool, {
  batchSize: 32,
  onProgress: (p) => {
    if (Date.now() - lastLog > 30_000) {
      console.log(`embedded ${p.embedded}, remaining ${p.remaining}`);
      lastLog = Date.now();
    }
  },
});
console.log(`backfill complete: ${total} chunks embedded`);
await closePool();
