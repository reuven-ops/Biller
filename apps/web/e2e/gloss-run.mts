import { readFileSync } from 'node:fs';
import { getPool, closePool } from '@advisor/db';
import { importRemitCsv } from '@advisor/ingest';
import { createLlmClient, draftMissingGlosses } from '@advisor/core';

const pool = getPool();
const csv = readFileSync('evals/fixtures/remit/synthetic_remit.csv');
const imported = await importRemitCsv(pool, csv, 'synthetic_remit.csv', null);
console.log('import:', JSON.stringify(imported));
const summary = await draftMissingGlosses(pool, createLlmClient());
console.log('drafted:', summary.drafted);
for (const s of summary.skipped) console.log('skipped:', s.code, '-', s.reason);
const rows = await pool.query(
  `SELECT code_type, code, left(gloss, 130) AS gloss FROM code_glosses ORDER BY code_type, code`,
);
for (const r of rows.rows) console.log(`${r.code_type} ${r.code}: ${r.gloss}`);
await closePool();
