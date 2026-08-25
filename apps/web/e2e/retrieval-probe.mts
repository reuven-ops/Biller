// Probe: where does IOM 100-02 ch15 section 240.1.3 (the AT modifier chunk) rank
// for eval item A1's question, per retrieval arm? Diagnostic for the gate 3 miss.
import pg from 'pg';
import { embedQuery, toVectorLiteral } from '@advisor/core';

const QUESTION =
  'Medicare patient, DC performs 98941 for a new episode of low back pain with subluxation. ' +
  'Which modifier signals active treatment, and which documentation elements must the initial visit contain?';
const SHORT = 'AT modifier chiropractic active treatment documentation subluxation';

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://app:app_local_dev_pw@127.0.0.1:5432/advisor',
  max: 2,
});
pool.on('error', () => {});

async function vectorRank(query: string): Promise<void> {
  const vec = toVectorLiteral(await embedQuery(query));
  const res = await pool.query<{ rank: string; ordinal: number }>(
    `SELECT rank, ordinal FROM (
       SELECT c.ordinal, d.external_id,
              row_number() OVER (ORDER BY c.embedding <=> $1::vector) AS rank
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.embedding IS NOT NULL
     ) t WHERE external_id = 'iom-100-02-ch15' AND ordinal IN (175, 177)`,
    [vec],
  );
  console.log(
    `vector ranks for "${query.slice(0, 60)}...": ` +
      res.rows.map((r) => `ord ${r.ordinal} -> rank ${r.rank}`).join(', '),
  );
}

async function textMatch(query: string): Promise<void> {
  const res = await pool.query<{ ordinal: number; rank: string }>(
    `SELECT c.ordinal, row_number() OVER (
        ORDER BY ts_rank(c.tsv, plainto_tsquery('english', $1)) DESC) AS rank
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE d.external_id = 'iom-100-02-ch15' AND c.ordinal IN (175, 177)
       AND c.tsv @@ plainto_tsquery('english', $1)`,
    [query],
  );
  console.log(
    `text-arm strict AND match for "${query.slice(0, 60)}...": ` +
      (res.rows.length ? res.rows.map((r) => `ord ${r.ordinal}`).join(', ') : 'NO MATCH'),
  );
}

await vectorRank(QUESTION);
await vectorRank(SHORT);
await textMatch(QUESTION);
await textMatch(SHORT);
await pool.end();
