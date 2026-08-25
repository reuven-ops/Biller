// Probe: is chunk 177's stored embedding consistent with a fresh embedding of
// its own text? Low self-similarity means the stored vector is stale or corrupt.
import pg from 'pg';
import { embedPassages, embedQuery, toVectorLiteral } from '@advisor/core';

const QUESTION =
  'Medicare patient, DC performs 98941 for a new episode of low back pain with subluxation. ' +
  'Which modifier signals active treatment, and which documentation elements must the initial visit contain?';

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://app:app_local_dev_pw@127.0.0.1:5432/advisor',
  max: 2,
});
pool.on('error', () => {});

const row = await pool.query<{ id: string; text: string }>(
  `SELECT c.id, c.text FROM chunks c JOIN documents d ON d.id = c.document_id
   WHERE d.external_id = 'iom-100-02-ch15' AND c.ordinal = 177`,
);
const chunk = row.rows[0]!;

const [freshPassage] = await embedPassages([chunk.text]);
const queryVec = await embedQuery(QUESTION);

const sims = await pool.query<{
  stored_vs_fresh: number;
  stored_vs_query: number;
  fresh_vs_query: number;
}>(
  `SELECT 1 - (c.embedding <=> $1::vector) AS stored_vs_fresh,
          1 - (c.embedding <=> $2::vector) AS stored_vs_query,
          1 - ($1::vector <=> $2::vector) AS fresh_vs_query
   FROM chunks c WHERE c.id = $3`,
  [toVectorLiteral(freshPassage!), toVectorLiteral(queryVec), chunk.id],
);
console.log(JSON.stringify(sims.rows[0]));

// Where would the chunk rank if its embedding were fresh?
const rank = await pool.query<{ n: string }>(
  `SELECT count(*) AS n FROM chunks
   WHERE embedding IS NOT NULL AND (embedding <=> $1::vector) < (SELECT $2::vector <=> $1::vector)`,
  [toVectorLiteral(queryVec), toVectorLiteral(freshPassage!)],
);
console.log(`chunks closer to the query than fresh-embedded 240.1.3: ${rank.rows[0]?.n}`);
await pool.end();
