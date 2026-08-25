// Document store: one row per (source_id, external_id, version_hash); unchanged hash
// means no new version; a new version supersedes the prior one and writes a
// change_event (brief section 8.1, 8.3, 8.7).
import type { Pool, PoolClient, Tier } from '@advisor/db';

export interface UpsertDocumentInput {
  sourceId: string;
  externalId: string;
  docType: string;
  title: string;
  url: string | null;
  versionHash: string;
  effectiveDate: string | null;
  revisionDate: string | null;
  retiredDate: string | null;
  tier: Tier;
  jurisdiction: string[];
  payer: string | null;
  lob: string | null;
  clientId: string | null;
  storagePath: string | null;
  metadata: Record<string, unknown>;
}

export interface UpsertDocumentResult {
  documentId: string;
  outcome: 'unchanged' | 'new' | 'revised';
  supersededDocumentId: string | null;
}

export async function upsertDocument(
  db: Pool | PoolClient,
  input: UpsertDocumentInput,
): Promise<UpsertDocumentResult> {
  const existing = await db.query<{ id: string; version_hash: string }>(
    `SELECT id, version_hash FROM documents
     WHERE source_id = $1 AND external_id = $2 AND superseded_by IS NULL
     ORDER BY retrieved_at DESC LIMIT 1`,
    [input.sourceId, input.externalId],
  );
  const current = existing.rows[0];
  if (current && current.version_hash === input.versionHash) {
    return { documentId: current.id, outcome: 'unchanged', supersededDocumentId: null };
  }

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO documents (source_id, external_id, doc_type, title, url, version_hash,
       effective_date, revision_date, retired_date, tier, jurisdiction, payer, lob,
       client_id, storage_path, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (source_id, external_id, version_hash) DO UPDATE SET retrieved_at = documents.retrieved_at
     RETURNING id`,
    [
      input.sourceId,
      input.externalId,
      input.docType,
      input.title,
      input.url,
      input.versionHash,
      input.effectiveDate,
      input.revisionDate,
      input.retiredDate,
      input.tier,
      input.jurisdiction,
      input.payer,
      input.lob,
      input.clientId,
      input.storagePath,
      JSON.stringify(input.metadata),
    ],
  );
  const documentId = inserted.rows[0]?.id;
  if (!documentId) throw new Error('document insert returned no id');

  if (current && current.id !== documentId) {
    await db.query(`UPDATE documents SET superseded_by = $1 WHERE id = $2`, [
      documentId,
      current.id,
    ]);
    await db.query(
      `INSERT INTO change_events (document_id, change_type, diff_summary)
       VALUES ($1, 'revised', $2)`,
      [documentId, `New version of ${input.externalId} supersedes ${current.id}`],
    );
    return { documentId, outcome: 'revised', supersededDocumentId: current.id };
  }

  await db.query(
    `INSERT INTO change_events (document_id, change_type, diff_summary)
     VALUES ($1, 'new', $2)`,
    [documentId, `First version of ${input.externalId}`],
  );
  return { documentId, outcome: 'new', supersededDocumentId: null };
}

export interface ChunkInput {
  sectionPath: string;
  ordinal: number;
  text: string;
  tokenCount: number;
  tier: Tier;
  clientId: string | null;
  effectiveDate: string | null;
  retiredDate: string | null;
  codesMentioned: string[];
  metadata?: Record<string, unknown>;
}

/** Replaces the chunk set of a document. Embeddings are filled by the Phase 2 backfill job. */
export async function replaceChunks(
  db: Pool | PoolClient,
  documentId: string,
  chunks: ChunkInput[],
): Promise<number> {
  await db.query(`DELETE FROM chunks WHERE document_id = $1`, [documentId]);
  for (const c of chunks) {
    await db.query(
      `INSERT INTO chunks (document_id, section_path, ordinal, text, token_count, tier,
         client_id, effective_date, retired_date, codes_mentioned, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        documentId,
        c.sectionPath,
        c.ordinal,
        c.text,
        c.tokenCount,
        c.tier,
        c.clientId,
        c.effectiveDate,
        c.retiredDate,
        c.codesMentioned,
        JSON.stringify(c.metadata ?? {}),
      ],
    );
  }
  return chunks.length;
}
