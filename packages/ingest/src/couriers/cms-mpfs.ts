// Courier for cms_mpfs: PFS Relative Value Files, quarterly (RVU26A..D pattern).
// Each release zip carries PPRRVU (RVUs, status indicator, global days, policy
// indicators, conversion factor per row) and GPCI files. CPT descriptors inside
// PPRRVU are AMA-copyrighted and are dropped at parse time under
// CPT_LICENSE_MODE=none (brief non-negotiable 5). Release-level effectivity: the
// quarter's snapshot governs dates of service in that quarter (docs/SOURCES.md).
import type { Courier, CourierContext, CourierResult } from '../courier.js';
import { upsertDocument } from '../doc-store.js';
import { csvRows, zipEntries } from '../formats.js';

export interface MpfsRowParsed {
  code: string;
  modifier: string;
  statusIndicator: string;
  workRvu: string;
  peRvuNonfac: string;
  peRvuFac: string;
  mpRvu: string;
  totalNonfac: string;
  totalFac: string;
  pctc: string;
  globalDays: string;
  multProc: string;
  bilateral: string;
  assistantSurg: string;
  coSurg: string;
  convFactor: string;
}

/**
 * Parses a PPRRVU csv: preamble lines, stacked caption lines, then the real header
 * row starting HCPCS,MOD,DESCRIPTION. Columns are mapped positionally from that
 * header row; the DESCRIPTION column is never read into output.
 */
export function parsePprrvuCsv(data: Buffer): MpfsRowParsed[] {
  const records = csvRows(data.toString('latin1'));
  const headerIdx = records.findIndex(
    (r) => (r[0] ?? '').trim() === 'HCPCS' && (r[1] ?? '').trim() === 'MOD',
  );
  if (headerIdx < 0) throw new Error('PPRRVU header row (HCPCS,MOD,...) not found');
  const header = records[headerIdx]!.map((c) => c.trim().toUpperCase());
  if (header[2] !== 'DESCRIPTION' || header[3] !== 'CODE') {
    throw new Error(`PPRRVU header layout changed: ${header.slice(0, 6).join(',')}`);
  }
  const out: MpfsRowParsed[] = [];
  for (const r of records.slice(headerIdx + 1)) {
    const code = (r[0] ?? '').trim();
    if (!/^[A-Z0-9]{5}$/.test(code)) continue;
    out.push({
      code,
      modifier: (r[1] ?? '').trim(),
      statusIndicator: (r[3] ?? '').trim(),
      workRvu: (r[5] ?? '').trim(),
      peRvuNonfac: (r[6] ?? '').trim(),
      peRvuFac: (r[8] ?? '').trim(),
      mpRvu: (r[10] ?? '').trim(),
      totalNonfac: (r[11] ?? '').trim(),
      totalFac: (r[12] ?? '').trim(),
      pctc: (r[13] ?? '').trim(),
      globalDays: (r[14] ?? '').trim(),
      multProc: (r[18] ?? '').trim(),
      bilateral: (r[19] ?? '').trim(),
      assistantSurg: (r[20] ?? '').trim(),
      coSurg: (r[21] ?? '').trim(),
      convFactor: (r[25] ?? '').trim(),
    });
  }
  return out;
}

export interface GpciRowParsed {
  mac: string;
  state: string;
  localityNumber: string;
  localityName: string;
  work: string;
  pe: string;
  mp: string;
}

export function parseGpciCsv(data: Buffer): GpciRowParsed[] {
  const records = csvRows(data.toString('latin1'));
  const headerIdx = records.findIndex((r) => /locality number/i.test(r[2] ?? ''));
  if (headerIdx < 0) throw new Error('GPCI header row not found');
  const out: GpciRowParsed[] = [];
  for (const r of records.slice(headerIdx + 1)) {
    const mac = (r[0] ?? '').trim();
    if (!/^\d{5}$/.test(mac)) continue;
    out.push({
      mac,
      state: (r[1] ?? '').trim(),
      localityNumber: (r[2] ?? '').trim(),
      localityName: (r[3] ?? '').trim(),
      work: (r[4] ?? '').trim(),
      pe: (r[5] ?? '').trim(),
      mp: (r[6] ?? '').trim(),
    });
  }
  return out;
}

export interface RvuReleaseLink {
  detailUrl: string;
  year: number;
  quarter: number; // A=1 .. D=4
  slug: string; // rvu26c
}

export function findRvuReleaseLinks(html: string, baseUrl: string): RvuReleaseLink[] {
  const out = new Map<string, RvuReleaseLink>();
  const re = /href="([^"]*\/pfs-relative-value-files\/(rvu(\d{2})([a-d]))[^"]*)"/gi;
  for (const m of html.matchAll(re)) {
    const slug = m[2]!.toLowerCase();
    const year = 2000 + Number(m[3]);
    const quarter = m[4]!.toLowerCase().charCodeAt(0) - 96; // a=1
    out.set(slug, { detailUrl: new URL(m[1]!, baseUrl).toString(), year, quarter, slug });
  }
  return [...out.values()].sort((a, b) => b.year - a.year || b.quarter - a.quarter);
}

export function findZipLink(html: string, baseUrl: string): string | null {
  const m = /href="([^"]*\/files\/zip\/[^"]*\.zip)"/i.exec(html);
  return m?.[1] ? new URL(m[1], baseUrl).toString() : null;
}

function quarterStart(year: number, quarter: number): string {
  return `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01`;
}

async function loadRelease(
  ctx: CourierContext,
  link: RvuReleaseLink,
): Promise<{ written: number; unchanged: boolean }> {
  const detail = await ctx.fetcher.fetchArtifact(link.detailUrl, 'cms_mpfs', {
    accept: 'text/html',
  });
  const zipUrl = findZipLink(detail.body.toString('utf8'), detail.finalUrl);
  if (!zipUrl) throw new Error(`no zip link on ${link.detailUrl}`);
  const artifact = await ctx.fetcher.fetchArtifact(zipUrl, 'cms_mpfs');
  const doc = await upsertDocument(ctx.pool, {
    sourceId: 'cms_mpfs',
    externalId: `mpfs-${link.slug}`,
    docType: 'mpfs_rvu',
    title: `PFS Relative Value File ${link.slug.toUpperCase()}`,
    url: zipUrl,
    versionHash: artifact.sha256,
    effectiveDate: quarterStart(link.year, link.quarter),
    revisionDate: null,
    retiredDate: null,
    tier: 2,
    jurisdiction: [],
    payer: null,
    lob: null,
    clientId: null,
    storagePath: artifact.storagePath,
    metadata: { year: link.year, quarter: link.quarter },
  });
  if (doc.outcome === 'unchanged') return { written: 0, unchanged: true };

  // 2026+ splits PPRRVU into nonQPP and QPP (two conversion factors); the non-QPP
  // file is the general case and is what conversion_factor stores (docs/DECISIONS.md D8).
  const entries = zipEntries(artifact.body, /^PPRRVU.*\.csv$/i);
  const pprrvu =
    entries.find((e) => /nonqpp/i.test(e.name)) ??
    entries.find((e) => !/qpp/i.test(e.name)) ??
    entries[0];
  if (!pprrvu) throw new Error(`no PPRRVU csv in ${zipUrl}`);
  let rows = parsePprrvuCsv(pprrvu.data);
  if (ctx.limit) rows = rows.slice(0, ctx.limit);

  let written = 0;
  const BATCH = 400;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values: string[] = [];
    const params: unknown[] = [];
    batch.forEach((r, j) => {
      const o = j * 17;
      const ph = Array.from({ length: 17 }, (_, k) => `$${o + k + 1}`);
      values.push(`(${ph.join(',')})`);
      params.push(
        r.code,
        r.modifier,
        link.year,
        link.quarter,
        r.statusIndicator,
        numOrNull(r.workRvu),
        numOrNull(r.peRvuFac),
        numOrNull(r.peRvuNonfac),
        numOrNull(r.mpRvu),
        numOrNull(r.totalFac),
        numOrNull(r.totalNonfac),
        r.globalDays,
        r.multProc,
        r.bilateral,
        r.assistantSurg,
        r.coSurg,
        r.pctc,
      );
    });
    const res = await ctx.pool.query(
      `INSERT INTO mpfs (code, modifier, year, quarter, status_indicator, work_rvu,
         pe_rvu_fac, pe_rvu_nonfac, mp_rvu, total_fac, total_nonfac, global_days,
         mult_proc, bilateral, assistant_surg, co_surg, pctc, effective_date, file_version)
       SELECT v.c1, v.c2, v.c3::int, v.c4::int, v.c5, v.c6::numeric, v.c7::numeric,
              v.c8::numeric, v.c9::numeric, v.c10::numeric, v.c11::numeric, v.c12,
              v.c13, v.c14, v.c15, v.c16, v.c17, '${quarterStart(link.year, link.quarter)}'::date,
              '${link.slug}'
       FROM (VALUES ${values.join(',')})
         AS v(c1,c2,c3,c4,c5,c6,c7,c8,c9,c10,c11,c12,c13,c14,c15,c16,c17)
       ON CONFLICT (code, modifier, year, quarter) DO UPDATE SET
         status_indicator = EXCLUDED.status_indicator,
         work_rvu = EXCLUDED.work_rvu,
         pe_rvu_fac = EXCLUDED.pe_rvu_fac,
         pe_rvu_nonfac = EXCLUDED.pe_rvu_nonfac,
         mp_rvu = EXCLUDED.mp_rvu,
         total_fac = EXCLUDED.total_fac,
         total_nonfac = EXCLUDED.total_nonfac,
         global_days = EXCLUDED.global_days,
         mult_proc = EXCLUDED.mult_proc,
         bilateral = EXCLUDED.bilateral,
         assistant_surg = EXCLUDED.assistant_surg,
         co_surg = EXCLUDED.co_surg,
         pctc = EXCLUDED.pctc,
         file_version = EXCLUDED.file_version`,
      params,
    );
    written += res.rowCount ?? 0;
  }

  // Conversion factor: per-row CONV FACTOR column; take the first non-empty value.
  const cf = rows.map((r) => r.convFactor).find((v) => /^\d+\.\d+$/.test(v));
  if (cf) {
    await ctx.pool.query(
      `INSERT INTO conversion_factor (year, quarter, value, source_document_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (year, quarter) DO UPDATE SET
         value = EXCLUDED.value, source_document_id = EXCLUDED.source_document_id`,
      [link.year, link.quarter, cf, doc.documentId],
    );
    written += 1;
  }

  // GPCI (annual; present in each quarterly zip).
  const gpciEntry = zipEntries(artifact.body, /^GPCI.*\.csv$/i)[0];
  if (gpciEntry) {
    for (const g of parseGpciCsv(gpciEntry.data)) {
      const res = await ctx.pool.query(
        `INSERT INTO gpci (locality_code, locality_name, state, year, work, pe, mp)
         VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric)
         ON CONFLICT (locality_code, year) DO UPDATE SET
           locality_name = EXCLUDED.locality_name, state = EXCLUDED.state,
           work = EXCLUDED.work, pe = EXCLUDED.pe, mp = EXCLUDED.mp`,
        [`${g.mac}-${g.localityNumber}`, g.localityName, g.state, link.year, g.work, g.pe, g.mp],
      );
      written += res.rowCount ?? 0;
    }
  }
  return { written, unchanged: false };
}

function numOrNull(s: string): string | null {
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

async function run(ctx: CourierContext): Promise<CourierResult> {
  const src = await ctx.pool.query<{ base_url: string; config: { backfill_quarters?: number } }>(
    `SELECT base_url, config FROM sources WHERE id = 'cms_mpfs'`,
  );
  const baseUrl = src.rows[0]?.base_url;
  if (!baseUrl) throw new Error('cms_mpfs base_url missing in config/sources.yaml');
  const backfill = src.rows[0]?.config?.backfill_quarters ?? 8;

  const landing = await ctx.fetcher.fetchArtifact(baseUrl, 'cms_mpfs', { accept: 'text/html' });
  const links = findRvuReleaseLinks(landing.body.toString('utf8'), landing.finalUrl);
  if (links.length === 0) throw new Error('no RVU release links found');

  const targets = ctx.limit ? links.slice(0, 1) : links.slice(0, backfill);
  let written = 0;
  const loaded: string[] = [];
  for (const link of targets) {
    const r = await loadRelease(ctx, link);
    written += r.written;
    if (!r.unchanged) loaded.push(link.slug);
  }
  return {
    rowsWritten: written,
    notes: `releases loaded: ${loaded.join(', ') || 'none (unchanged)'}`,
  };
}

export const cmsMpfsCourier: Courier = { sourceId: 'cms_mpfs', run };
