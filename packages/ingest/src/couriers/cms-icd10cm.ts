// Courier for cms_icd10cm: ICD-10-CM order files (public domain) and the Official
// Guidelines PDF. FY files are effective October 1 of the prior calendar year through
// September 30; a mid-year April 1 package supersedes the base package for the same
// fiscal year. Landing-page slugs are hand-authored, so links are scraped, never
// templated (docs/SOURCES.md).
import type { Courier, CourierContext, CourierResult } from '../courier.js';
import { chunkSections } from '../chunker.js';
import { replaceChunks, upsertDocument } from '../doc-store.js';
import { extractPdfLines, sectionsFromLines } from '../pdf.js';
import { zipEntries } from '../formats.js';

export interface Icd10OrderRow {
  code: string; // dotted form, e.g. M54.50
  billable: boolean;
  shortDesc: string;
  longDesc: string;
}

/** Adds the dot after the third character (ICD-10-CM presentation form). */
export function dotted(code: string): string {
  return code.length > 3 ? `${code.slice(0, 3)}.${code.slice(3)}` : code;
}

/**
 * Parses icd10cm_order_YYYY.txt: fixed-width, columns (1-indexed) 1-5 order number,
 * 7-13 code without dot, 15 billable flag (0 header, 1 billable), 17-76 short
 * description, 78+ long description.
 */
export function parseOrderFile(data: Buffer): Icd10OrderRow[] {
  const out: Icd10OrderRow[] = [];
  for (const line of data.toString('latin1').split(/\r?\n/)) {
    if (line.length < 16) continue;
    const code = line.slice(6, 13).trim();
    if (!/^[A-Z][0-9A-Z]{2,6}$/.test(code)) continue;
    const flag = line.slice(14, 15);
    out.push({
      code: dotted(code),
      billable: flag === '1',
      shortDesc: line.slice(16, 76).trim(),
      longDesc: line.slice(77).trim(),
    });
  }
  return out;
}

export interface Icd10Release {
  url: string;
  fy: number;
  midYear: boolean; // april package supersedes the base package for the same FY
}

export function findOrderZipLinks(html: string, baseUrl: string): Icd10Release[] {
  const releases = new Map<number, Icd10Release>();
  const re =
    /href="([^"]*\/files\/zip\/([a-z0-9-]*code-descriptions-tabular-order[a-z0-9-]*\.zip))"/gi;
  for (const m of html.matchAll(re)) {
    const slug = m[2]!;
    const year = /(\d{4})/.exec(slug)?.[1];
    if (!year) continue;
    const fy = Number(year);
    const midYear = /april/i.test(slug);
    const existing = releases.get(fy);
    if (!existing || (midYear && !existing.midYear)) {
      releases.set(fy, { url: new URL(m[1]!, baseUrl).toString(), fy, midYear });
    }
  }
  return [...releases.values()].sort((a, b) => b.fy - a.fy);
}

export function findGuidelinesPdf(
  html: string,
  baseUrl: string,
): { url: string; fy: number } | null {
  const matches = [
    ...html.matchAll(
      /href="([^"]*\/files\/document\/fy-?(\d{4})-icd-10-cm-coding-guidelines[a-z0-9-]*\.pdf)"/gi,
    ),
  ];
  if (matches.length === 0) return null;
  const newest = matches.sort((a, b) => Number(b[2]) - Number(a[2]))[0]!;
  return { url: new URL(newest[1]!, baseUrl).toString(), fy: Number(newest[2]) };
}

function fyWindow(fy: number): { start: string; end: string } {
  return { start: `${fy - 1}-10-01`, end: `${fy}-09-30` };
}

async function loadRelease(
  ctx: CourierContext,
  release: Icd10Release,
): Promise<{ written: number; unchanged: boolean }> {
  const artifact = await ctx.fetcher.fetchArtifact(release.url, 'cms_icd10cm');
  const window = fyWindow(release.fy);
  const doc = await upsertDocument(ctx.pool, {
    sourceId: 'cms_icd10cm',
    externalId: `icd10cm-order-fy${release.fy}`,
    docType: 'icd10cm_order',
    title: `ICD-10-CM Code Descriptions in Tabular Order, FY ${release.fy}${release.midYear ? ' (April update)' : ''}`,
    url: release.url,
    versionHash: artifact.sha256,
    effectiveDate: window.start,
    revisionDate: release.midYear ? `${release.fy}-04-01` : null,
    retiredDate: null,
    tier: 2,
    jurisdiction: [],
    payer: null,
    lob: null,
    clientId: null,
    storagePath: artifact.storagePath,
    metadata: { fy: release.fy, midYear: release.midYear },
  });
  if (doc.outcome === 'unchanged') return { written: 0, unchanged: true };

  const entry = zipEntries(artifact.body, /icd10cm_order_\d{4}\.txt$/i)[0];
  if (!entry) throw new Error(`no icd10cm_order file in ${release.url}`);
  let rows = parseOrderFile(entry.data);
  if (ctx.limit) rows = rows.slice(0, ctx.limit);

  let written = 0;
  const BATCH = 1000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values: string[] = [];
    const params: unknown[] = [];
    batch.forEach((r, j) => {
      const o = j * 4;
      values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4})`);
      params.push(r.code, r.longDesc || r.shortDesc, r.billable, `fy${release.fy}`);
    });
    const res = await ctx.pool.query(
      `INSERT INTO icd10cm (code, description, billable, effective_date, end_date, version)
       SELECT v.code, v.description, v.billable::boolean, '${window.start}'::date,
              '${window.end}'::date, v.version
       FROM (VALUES ${values.join(',')}) AS v(code, description, billable, version)
       ON CONFLICT (code, version) DO UPDATE SET
         description = EXCLUDED.description, billable = EXCLUDED.billable`,
      params,
    );
    written += res.rowCount ?? 0;
  }
  return { written, unchanged: false };
}

async function run(ctx: CourierContext): Promise<CourierResult> {
  const src = await ctx.pool.query<{ base_url: string; config: { backfill_fys?: number } }>(
    `SELECT base_url, config FROM sources WHERE id = 'cms_icd10cm'`,
  );
  const baseUrl = src.rows[0]?.base_url;
  if (!baseUrl) throw new Error('cms_icd10cm base_url missing in config/sources.yaml');
  const backfill = src.rows[0]?.config?.backfill_fys ?? 3;

  const landing = await ctx.fetcher.fetchArtifact(baseUrl, 'cms_icd10cm', {
    accept: 'text/html',
  });
  const html = landing.body.toString('utf8');
  const releases = findOrderZipLinks(html, landing.finalUrl);
  if (releases.length === 0) throw new Error('no code-descriptions-tabular-order links found');

  const targets = ctx.limit ? releases.slice(0, 1) : releases.slice(0, backfill);
  let written = 0;
  const notes: string[] = [];
  for (const release of targets) {
    const r = await loadRelease(ctx, release);
    written += r.written;
    notes.push(`fy${release.fy}${r.unchanged ? ' unchanged' : ''}`);
  }

  // Official Guidelines PDF: narrative document, chunked for retrieval.
  const guide = findGuidelinesPdf(html, landing.finalUrl);
  if (guide && !ctx.limit) {
    const artifact = await ctx.fetcher.fetchArtifact(guide.url, 'cms_icd10cm');
    const window = fyWindow(guide.fy);
    const doc = await upsertDocument(ctx.pool, {
      sourceId: 'cms_icd10cm',
      externalId: `icd10cm-guidelines-fy${guide.fy}`,
      docType: 'icd10cm_guidelines',
      title: `ICD-10-CM Official Guidelines for Coding and Reporting, FY ${guide.fy}`,
      url: guide.url,
      versionHash: artifact.sha256,
      effectiveDate: window.start,
      revisionDate: null,
      retiredDate: null,
      tier: 2,
      jurisdiction: [],
      payer: null,
      lob: null,
      clientId: null,
      storagePath: artifact.storagePath,
      metadata: { fy: guide.fy },
    });
    if (doc.outcome !== 'unchanged') {
      const extraction = await extractPdfLines(new Uint8Array(artifact.body));
      if (extraction.quality === 'ok') {
        const sections = sectionsFromLines(
          extraction.lines,
          /^([A-Z]?\d{0,2}[a-z]?\.?\s?\d{0,2}\.?\)?)\s*[-–—.]?\s+([A-Z].{3,100})$/,
        );
        const chunks = chunkSections(`ICD-10-CM Official Guidelines FY ${guide.fy}`, sections).map(
          (c) => ({
            sectionPath: c.sectionPath,
            ordinal: c.ordinal,
            text: c.text,
            tokenCount: c.tokenCount,
            tier: 2 as const,
            clientId: null,
            effectiveDate: window.start,
            retiredDate: window.end,
            codesMentioned: c.codesMentioned,
          }),
        );
        written += await replaceChunks(ctx.pool, doc.documentId, chunks);
        notes.push(`guidelines fy${guide.fy}: ${chunks.length} chunks`);
      } else {
        notes.push(`guidelines fy${guide.fy} flagged poor quality`);
      }
    }
  }
  return { rowsWritten: written, notes: notes.join('; ') };
}

export const cmsIcd10cmCourier: Courier = { sourceId: 'cms_icd10cm', run };
