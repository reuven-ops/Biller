// Client contract uploads (brief section 14.2): PDF or DOCX chunked into the
// corpus as tier 5 with client_id isolation; machine-readable fee schedules
// (CSV or XLSX with recognizable columns) also fill client_fee_schedule.
import { createHash } from 'node:crypto';
import type { Pool } from '@advisor/db';
import {
  chunkSections,
  csvRows,
  extractPdfLines,
  replaceChunks,
  upsertDocument,
  xlsxRows,
  zipEntries,
} from '@advisor/ingest';

export interface ContractUpload {
  clientId: string;
  payer: string;
  title: string;
  contractType: 'agreement' | 'fee_schedule' | 'amendment';
  effectiveDate: string | null;
  terminationDate: string | null;
  portalPath: string | null;
  filename: string;
  data: Buffer;
}

/**
 * Stable external id piece from a user-entered name, so a re-upload of a revised
 * document under the same title supersedes the old version and records a
 * revised change event instead of creating an unrelated document.
 */
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

/** DOCX text: the zip's word/document.xml with tags stripped, paragraphs kept. */
export function docxText(data: Buffer): string {
  const entry = zipEntries(data, /^word\/document\.xml$/)[0];
  if (!entry) throw new Error('not a DOCX file (word/document.xml missing)');
  const xml = entry.data.toString('utf8');
  return xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface FeeRow {
  cpt: string;
  modifiers: string[];
  allowed: number;
}

/**
 * Fee schedule tables when the layout is machine readable: a header row naming a
 * code column and an amount column. Anything else falls back to text only.
 */
export function parseFeeSchedule(rows: unknown[][]): FeeRow[] {
  if (rows.length < 2) return [];
  const header = (rows[0] ?? []).map((c) => String(c ?? '').toLowerCase());
  const cptIdx = header.findIndex((h) => /^(cpt|hcpcs|code|procedure)/.test(h));
  const amtIdx = header.findIndex((h) => /(allowed|rate|amount|fee)/.test(h));
  const modIdx = header.findIndex((h) => /modifier/.test(h));
  if (cptIdx < 0 || amtIdx < 0) return [];
  const out: FeeRow[] = [];
  for (const row of rows.slice(1)) {
    const cpt = String(row[cptIdx] ?? '')
      .trim()
      .toUpperCase();
    const allowed = Number(String(row[amtIdx] ?? '').replace(/[$,]/g, ''));
    if (!/^[0-9A-Z]{5}$/.test(cpt) || !Number.isFinite(allowed) || allowed <= 0) continue;
    const modifiers =
      modIdx >= 0
        ? String(row[modIdx] ?? '')
            .split(/[|,\s]+/)
            .map((m) => m.trim().toUpperCase())
            .filter(Boolean)
            .sort()
        : [];
    out.push({ cpt, modifiers, allowed });
  }
  return out;
}

export interface ContractResult {
  ok: boolean;
  message: string;
  chunks?: number | undefined;
  feeRows?: number | undefined;
}

/** Extracted upload content, or the user-facing reason it could not be read. */
async function uploadContent(
  filename: string,
  data: Buffer,
  allowTables: boolean,
): Promise<{ text: string; feeRows: FeeRow[] } | { error: string }> {
  const lower = filename.toLowerCase();
  try {
    if (lower.endsWith('.pdf')) {
      const ex = await extractPdfLines(new Uint8Array(data));
      return { text: ex.lines.join('\n'), feeRows: [] };
    }
    if (lower.endsWith('.docx')) return { text: docxText(data), feeRows: [] };
    if (allowTables && lower.endsWith('.csv')) {
      const raw = data.toString('utf8');
      return { text: raw.slice(0, 200_000), feeRows: parseFeeSchedule(csvRows(raw)) };
    }
    if (allowTables && lower.endsWith('.xlsx')) {
      const rows = xlsxRows(data);
      return {
        text: rows.map((r) => r.map((c) => String(c ?? '')).join(' | ')).join('\n'),
        feeRows: parseFeeSchedule(rows),
      };
    }
    return {
      error: allowTables
        ? 'Upload a PDF, DOCX, CSV, or XLSX file.'
        : 'Upload a PDF or DOCX policy document.',
    };
  } catch (err) {
    return { error: `Could not read ${filename}: ${(err as Error).message}` };
  }
}

export async function importContract(pool: Pool, upload: ContractUpload): Promise<ContractResult> {
  const content = await uploadContent(upload.filename, upload.data, true);
  if ('error' in content) return { ok: false, message: content.error };
  const { text, feeRows } = content;
  if (text.trim().length < 40 && feeRows.length === 0) {
    return { ok: false, message: 'No readable text found in the file.' };
  }

  const versionHash = createHash('sha256').update(upload.data).digest('hex');
  const doc = await upsertDocument(pool, {
    sourceId: 'client_contracts',
    externalId: `contract-${upload.clientId}-${slug(upload.payer)}-${upload.contractType}-${slug(upload.title)}`,
    docType: upload.contractType,
    title: upload.title,
    url: upload.portalPath,
    versionHash,
    effectiveDate: upload.effectiveDate,
    revisionDate: null,
    retiredDate: upload.terminationDate,
    tier: 5,
    jurisdiction: [],
    payer: upload.payer,
    lob: null,
    clientId: upload.clientId,
    storagePath: null,
    metadata: { filename: upload.filename, contract_type: upload.contractType },
  });
  const sections = [{ path: `${upload.contractType} text`, text }];
  const chunks = chunkSections(upload.title, sections).map((c) => ({
    sectionPath: c.sectionPath,
    ordinal: c.ordinal,
    text: c.text,
    tokenCount: c.tokenCount,
    tier: 5 as const,
    clientId: upload.clientId,
    effectiveDate: upload.effectiveDate,
    retiredDate: upload.terminationDate,
    codesMentioned: c.codesMentioned,
    metadata: {},
  }));
  const written = await replaceChunks(pool, doc.documentId, chunks);
  if (feeRows.length > 0) {
    await pool.query(`DELETE FROM client_fee_schedule WHERE source_document_id = $1`, [
      doc.documentId,
    ]);
    for (const r of feeRows) {
      await pool.query(
        `INSERT INTO client_fee_schedule (client_id, payer, cpt, modifiers, allowed_amount,
           effective_date, termination_date, source_document_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          upload.clientId,
          upload.payer,
          r.cpt,
          r.modifiers,
          r.allowed,
          upload.effectiveDate,
          upload.terminationDate,
          doc.documentId,
        ],
      );
    }
  }
  return {
    ok: true,
    message:
      `Contract stored as tier 5 for the client (${written} chunks` +
      `${feeRows.length ? `, ${feeRows.length} fee schedule rows` : ''}). ` +
      'Only users assigned to the client can retrieve it.',
    chunks: written,
    feeRows: feeRows.length,
  };
}

export interface PayerPolicyUpload {
  payer: string;
  title: string;
  effectiveDate: string | null;
  portalPath: string;
  filename: string;
  data: Buffer;
}

/**
 * Lead-uploaded payer policy (brief 14.1): the compliant path for payers whose
 * terms bar automated collection. Stored as tier 4 with the portal path as the
 * URL field so citations point at where the document lives.
 */
export async function importPayerPolicy(
  pool: Pool,
  upload: PayerPolicyUpload,
): Promise<ContractResult> {
  const content = await uploadContent(upload.filename, upload.data, false);
  if ('error' in content) return { ok: false, message: content.error };
  const text = content.text;
  if (text.trim().length < 40) return { ok: false, message: 'No readable text found in the file.' };
  const versionHash = createHash('sha256').update(upload.data).digest('hex');
  const doc = await upsertDocument(pool, {
    sourceId: 'payer_policies',
    externalId: `payer-policy-${slug(upload.payer)}-${slug(upload.title)}`,
    docType: 'payer_policy',
    title: upload.title,
    url: upload.portalPath,
    versionHash,
    effectiveDate: upload.effectiveDate,
    revisionDate: null,
    retiredDate: null,
    tier: 4,
    jurisdiction: [],
    payer: upload.payer,
    lob: null,
    clientId: null,
    storagePath: null,
    metadata: { filename: upload.filename, uploaded: true },
  });
  const chunks = chunkSections(upload.title, [{ path: 'policy text', text }]).map((c) => ({
    sectionPath: c.sectionPath,
    ordinal: c.ordinal,
    text: c.text,
    tokenCount: c.tokenCount,
    tier: 4 as const,
    clientId: null,
    effectiveDate: upload.effectiveDate,
    retiredDate: null,
    codesMentioned: c.codesMentioned,
    metadata: {},
  }));
  const written = await replaceChunks(pool, doc.documentId, chunks);
  return {
    ok: true,
    message: `Policy stored as tier 4 (${written} chunks). Answers for ${upload.payer} can cite it now.`,
    chunks: written,
  };
}
