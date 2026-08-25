// Courier for cms_ncci_mue: NCCI Medically Unlikely Edits, practitioner services.
// The quarterly file is a full snapshot; a row is written only when a code's value,
// indicator, or rationale changed, and codes missing from the new snapshot get a
// deletion_date. Effective dates ride on the file name (docs/SOURCES.md).
import type { Courier, CourierContext, CourierResult } from '../courier.js';
import { upsertDocument } from '../doc-store.js';
import { csvRows, zipEntries } from '../formats.js';

export interface MueRowParsed {
  code: string;
  mueValue: number;
  adjudicationIndicator: string;
  rationale: string;
}

export interface MueFileParsed {
  effectiveDate: string;
  rows: MueRowParsed[];
}

/** Eff_07-01-2026 or effective-07-01-2026 in a file name to 2026-07-01. */
export function effectiveDateFromName(name: string): string | null {
  const m = /[Ee]ff(?:ective)?[_-](\d{2})-(\d{2})-(\d{4})/.exec(name);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

/**
 * Parses the practitioner MUE CSV: Latin-1 encoded, record 0 is a quoted AMA notice,
 * then the header row (first cell contains an embedded newline), then data rows:
 * code, MUE value, adjudication indicator, rationale.
 */
export function parseMueCsv(data: Buffer, entryName: string): MueFileParsed {
  const text = data.toString('latin1');
  const records = csvRows(text);
  const headerIdx = records.findIndex((r) => /HCPCS/i.test(r[0] ?? '') && /Code/i.test(r[0] ?? ''));
  if (headerIdx < 0) {
    throw new Error(`MUE CSV header row not found in ${entryName}`);
  }
  const effectiveDate = effectiveDateFromName(entryName);
  if (!effectiveDate) {
    throw new Error(`MUE effective date not found in file name ${entryName}`);
  }
  const rows: MueRowParsed[] = [];
  for (const r of records.slice(headerIdx + 1)) {
    const code = (r[0] ?? '').trim();
    if (!/^[A-Z0-9]{5}$/.test(code)) continue;
    const value = Number.parseInt((r[1] ?? '').trim(), 10);
    if (Number.isNaN(value)) continue;
    rows.push({
      code,
      mueValue: value,
      adjudicationIndicator: (r[2] ?? '').trim(),
      rationale: (r[3] ?? '').trim(),
    });
  }
  return { effectiveDate, rows };
}

export function findMueTableUrl(landingHtml: string, baseUrl: string): string | null {
  const m = /href="([^"]*practitioner-services-mue-table[^"]*\.zip)"/i.exec(landingHtml);
  if (!m || !m[1]) return null;
  return new URL(m[1], baseUrl).toString();
}

async function run(ctx: CourierContext): Promise<CourierResult> {
  const src = await ctx.pool.query<{ base_url: string }>(
    `SELECT base_url FROM sources WHERE id = 'cms_ncci_mue'`,
  );
  const baseUrl = src.rows[0]?.base_url;
  if (!baseUrl) throw new Error('cms_ncci_mue base_url missing in config/sources.yaml');

  const landing = await ctx.fetcher.fetchArtifact(baseUrl, 'cms_ncci_mue', {
    accept: 'text/html',
  });
  const fileUrl = findMueTableUrl(landing.body.toString('utf8'), landing.finalUrl);
  if (!fileUrl) throw new Error('practitioner MUE table link not found on landing page');

  const artifact = await ctx.fetcher.fetchArtifact(fileUrl, 'cms_ncci_mue');
  const csvEntry = zipEntries(artifact.body, /\.csv$/i)[0];
  if (!csvEntry) throw new Error(`no CSV entry in ${fileUrl}`);
  const parsed = parseMueCsv(csvEntry.data, csvEntry.name);

  const doc = await upsertDocument(ctx.pool, {
    sourceId: 'cms_ncci_mue',
    externalId: 'mue-practitioner',
    docType: 'mue_table',
    title: `NCCI Practitioner Services MUE Table, effective ${parsed.effectiveDate}`,
    url: fileUrl,
    versionHash: artifact.sha256,
    effectiveDate: parsed.effectiveDate,
    revisionDate: null,
    retiredDate: null,
    tier: 2,
    jurisdiction: [],
    payer: null,
    lob: null,
    clientId: null,
    storagePath: artifact.storagePath,
    metadata: { entry: csvEntry.name, rows: parsed.rows.length },
  });
  if (doc.outcome === 'unchanged') {
    return { rowsWritten: 0, notes: `unchanged (${parsed.effectiveDate})` };
  }

  const rows = ctx.limit ? parsed.rows.slice(0, ctx.limit) : parsed.rows;
  const fileVersion = csvEntry.name;
  let written = 0;
  for (const row of rows) {
    const res = await ctx.pool.query(
      `INSERT INTO mue (code, mue_value, adjudication_indicator, rationale, effective_date, file_version)
       SELECT $1, $2, $3, $4, $5, $6
       WHERE NOT EXISTS (
         SELECT 1 FROM mue m
         WHERE m.code = $1 AND m.deletion_date IS NULL
           AND m.effective_date <= $5
           AND m.mue_value = $2 AND m.adjudication_indicator = $3 AND m.rationale = $4
       )
       ON CONFLICT (code, effective_date) DO UPDATE SET
         mue_value = EXCLUDED.mue_value,
         adjudication_indicator = EXCLUDED.adjudication_indicator,
         rationale = EXCLUDED.rationale,
         file_version = EXCLUDED.file_version`,
      [
        row.code,
        row.mueValue,
        row.adjudicationIndicator,
        row.rationale,
        parsed.effectiveDate,
        fileVersion,
      ],
    );
    written += res.rowCount ?? 0;
  }

  // Snapshot deletion marking: codes that disappeared from the current full snapshot.
  if (!ctx.limit) {
    const del = await ctx.pool.query(
      `UPDATE mue SET deletion_date = $1
       WHERE deletion_date IS NULL AND effective_date < $1
         AND NOT (code = ANY($2::text[]))`,
      [parsed.effectiveDate, rows.map((r) => r.code)],
    );
    written += del.rowCount ?? 0;
  }

  return {
    rowsWritten: written,
    notes: `snapshot ${parsed.effectiveDate}, ${parsed.rows.length} codes in file`,
  };
}

export const cmsNcciMueCourier: Courier = { sourceId: 'cms_ncci_mue', run };
