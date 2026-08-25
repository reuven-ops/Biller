// Hybrid retrieval (brief section 9): pgvector cosine top 60 plus tsvector top 60
// with exact code matching, fused with reciprocal rank fusion, filtered by the DOS
// window, jurisdiction, payer, doc type, tier, and client visibility, reranked to
// top 12 with the local cross-encoder, returned as evidence objects.
import type { Pool, Tier } from '@advisor/db';
import { embedQuery, rerankScores, toVectorLiteral } from './inference.js';
import type { EvidenceRecord } from './evidence.js';
import type { EvidenceRegistry } from './evidence.js';

export interface RetrievalFilters {
  dos: string; // YYYY-MM-DD; the DOS window filter is never skipped
  jurisdiction?: string | undefined; // state code; matches chunks with no jurisdiction too
  payer?: string | undefined;
  docTypes?: string[] | undefined;
  tiers?: Tier[] | undefined; // defaults to 1..5 for search_policy
  clientIds: string[]; // clients the asking user is assigned to; [] means none
  topK?: number | undefined; // final rerank cut, default 12
  candidateK?: number | undefined; // per-arm candidate depth, default 60
}

interface CandidateRow {
  id: string;
  document_id: string;
  section_path: string;
  text: string;
  tier: Tier;
  client_id: string | null;
  effective_date: Date | null;
  retired_date: Date | null;
  external_id: string;
  title: string;
  doc_type: string;
  url: string | null;
  version_hash: string;
  retrieved_at: Date;
  publisher: string;
}

const BASE_FILTER = `
  (c.effective_date IS NULL OR c.effective_date <= $1::date)
  AND (c.retired_date IS NULL OR c.retired_date > $1::date)
  AND (d.effective_date IS NULL OR d.effective_date <= $1::date)
  AND (d.retired_date IS NULL OR d.retired_date > $1::date)
  AND d.superseded_by IS NULL
  AND c.tier = ANY($2::int[])
  AND (c.client_id IS NULL OR c.client_id = ANY($3::uuid[]))
  AND ($4::text IS NULL OR d.jurisdiction = '{}' OR $4 = ANY(d.jurisdiction))
  AND ($5::text IS NULL OR d.payer IS NULL OR d.payer = $5)
  AND ($6::text[] IS NULL OR d.doc_type = ANY($6::text[]))
`;

const SELECT_FIELDS = `
  c.id, c.document_id, c.section_path, c.text, c.tier, c.client_id,
  c.effective_date, c.retired_date,
  d.external_id, d.title, d.doc_type, d.url, d.version_hash, d.retrieved_at,
  s.publisher
`;

/** Extracts code-like tokens from the query for the exact-match arm. */
export function queryCodes(query: string): string[] {
  const out = new Set<string>();
  for (const m of query.matchAll(
    /\b[A-Z]?\d{4}[0-9A-Z]?\b|\b[A-TV-Z]\d[0-9A-Z](?:\.[0-9A-Z]{1,4})?\b/g,
  )) {
    const token = m[0];
    if (/^(19|20)\d{2}$/.test(token)) continue;
    if (/^\d{4}$/.test(token)) continue;
    out.add(token);
  }
  return [...out];
}

// Two-character HCPCS billing modifiers. The english FTS config drops "at" as a
// stopword, so without an exact-token arm a query about the AT modifier can never
// lexically reach the passage that defines it (measured: the IOM 240.1.3 chunk
// ranked 14,851 of 15,968 by embedding for eval item A1's question).
const MODIFIER_TOKENS = new Set([
  'at',
  'kx',
  'ga',
  'gx',
  'gy',
  'gz',
  'gp',
  'go',
  'gn',
  'cq',
  'co',
  'cr',
  'cs',
  'xe',
  'xp',
  'xs',
  'xu',
  'lt',
  'rt',
  'tc',
  '24',
  '25',
  '26',
  '50',
  '51',
  '52',
  '53',
  '54',
  '55',
  '57',
  '58',
  '59',
  '62',
  '66',
  '76',
  '77',
  '78',
  '79',
  '80',
  '81',
  '82',
  '90',
  '91',
  '95',
  '96',
  '97',
  '99',
]);

/**
 * Known billing modifiers named next to the word "modifier" in the query. Two
 * passes, one per direction: a single alternation would let "Is modifier" match
 * the token-then-modifier branch and consume the word "modifier" away from the
 * "modifier KX" pair that follows it.
 */
export function queryModifierTokens(query: string): string[] {
  const out = new Set<string>();
  const passes = [/\bmodifiers?\s+-?([A-Za-z0-9]{2})\b/gi, /\b-?([A-Za-z0-9]{2})\s+modifiers?\b/gi];
  for (const re of passes) {
    for (const m of query.matchAll(re)) {
      const token = (m[1] ?? '').toLowerCase();
      if (MODIFIER_TOKENS.has(token)) out.add(token);
    }
  }
  return [...out];
}

/**
 * The simple-config tsquery for the exact-token arm: the modifier token must sit
 * directly next to the word modifier(s), as in "AT modifier" or "modifier AT".
 * Plain co-occurrence is far too broad ("at" appears in nearly every chunk that
 * also says "modifier" somewhere). Empty when no modifier is named in the query.
 */
export function modifierTsquery(tokens: string[]): string {
  return tokens
    .map(
      (t) =>
        `(${t} <-> modifier) | (${t} <-> modifiers) | (modifier <-> ${t}) | (modifiers <-> ${t})`,
    )
    .join(' | ');
}

export async function hybridRetrieve(
  pool: Pool,
  registry: EvidenceRegistry,
  query: string,
  filters: RetrievalFilters,
): Promise<EvidenceRecord[]> {
  const tiers = filters.tiers ?? [1, 2, 3, 4, 5];
  const candidateK = filters.candidateK ?? 60;
  const topK = filters.topK ?? 12;
  const params = [
    filters.dos,
    tiers,
    filters.clientIds,
    filters.jurisdiction ?? null,
    filters.payer ?? null,
    filters.docTypes ?? null,
  ];

  // Arm 1: vector cosine.
  const vector = toVectorLiteral(await embedQuery(query));
  const vectorRows = await pool.query<CandidateRow>(
    `SELECT ${SELECT_FIELDS}
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     JOIN sources s ON s.id = d.source_id
     WHERE ${BASE_FILTER} AND c.embedding IS NOT NULL
     ORDER BY c.embedding <=> $7::vector
     LIMIT ${candidateK}`,
    [...params, vector],
  );

  // Arm 2: full text, exact code matching, and exact modifier tokens (the
  // simple-config tsvector keeps stopword-shaped modifiers like AT).
  const codes = queryCodes(query);
  const modifierQuery = modifierTsquery(queryModifierTokens(query));
  const textRows = await pool.query<CandidateRow>(
    `SELECT ${SELECT_FIELDS}
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     JOIN sources s ON s.id = d.source_id
     WHERE ${BASE_FILTER}
       AND (c.tsv @@ plainto_tsquery('english', $7)
            OR ($8::text[] <> '{}' AND c.codes_mentioned && $8::text[])
            OR ($9::text <> '' AND c.tsv_simple @@ to_tsquery('simple', $9)))
     ORDER BY (c.codes_mentioned && $8::text[])::int DESC,
              ($9::text <> '' AND c.tsv_simple @@ to_tsquery('simple', $9))::int DESC,
              ts_rank(c.tsv, plainto_tsquery('english', $7)) DESC
     LIMIT ${candidateK}`,
    [...params, query, codes, modifierQuery],
  );

  // Reciprocal rank fusion.
  const K = 60;
  const scores = new Map<string, { row: CandidateRow; score: number }>();
  for (const [arm, rows] of [
    ['vector', vectorRows.rows],
    ['text', textRows.rows],
  ] as const) {
    void arm;
    rows.forEach((row, rank) => {
      const entry = scores.get(row.id) ?? { row, score: 0 };
      entry.score += 1 / (K + rank + 1);
      scores.set(row.id, entry);
    });
  }
  const fused = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, candidateK);
  if (fused.length === 0) return [];

  // Cross-encoder rerank to topK.
  const rr = await rerankScores(
    query,
    fused.map((f) => f.row.text.slice(0, 2000)),
  );
  const reranked = fused
    .map((f, i) => ({ row: f.row, score: rr[i] ?? -Infinity }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return reranked.map(({ row }) =>
    registry.register({
      document_id: row.document_id,
      external_id: row.external_id,
      title: row.title,
      doc_type: row.doc_type,
      publisher: row.publisher,
      tier: row.tier,
      section_path: row.section_path,
      text: row.text,
      effective_date: isoOrNull(row.effective_date),
      retired_date: isoOrNull(row.retired_date),
      retrieved_at: row.retrieved_at.toISOString(),
      version_hash: row.version_hash,
      url: row.url,
      client_id: row.client_id,
    }),
  );
}

export function isoOrNull(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}
