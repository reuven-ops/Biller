// Courier for cms_hcpcs: HCPCS Level II quarterly update. Each quarterly zip carries a
// full snapshot workbook (one row per code or modifier) with add, action effective, and
// termination dates per row in YYYYMMDD form. HCPCS Level II descriptors are public
// (only CPT Level I is license-gated) and are stored. Quarters are loaded as versions
// so historical DOS lookups hit the version in force.
import type { Courier, CourierContext, CourierResult } from '../courier.js';
import { upsertDocument } from '../doc-store.js';
import { cellToIsoDate, xlsxRows, zipEntries } from '../formats.js';

export interface HcpcsRowParsed {
  code: string;
  recId: string;
  longDesc: string;
  shortDesc: string;
  coverage: string;
  addDate: string | null;
  actionEffectiveDate: string | null;
  terminationDate: string | null;
  actionCode: string;
}

/** Parses the HCPC*ANWEB*.xlsx sheet rows (header row first). */
export function parseHcpcsRows(rows: unknown[][]): HcpcsRowParsed[] {
  const header = (rows[0] ?? []).map((c) => String(c).trim().toUpperCase());
  const col = (name: string): number => {
    const idx = header.indexOf(name);
    if (idx < 0) throw new Error(`HCPCS workbook column missing: ${name}`);
    return idx;
  };
  const cCode = col('HCPC');
  const cRec = col('RECID');
  const cLong = col('LONG DESCRIPTION');
  const cShort = col('SHORT DESCRIPTION');
  const cCov = col('COV');
  const cAdd = col('ADD DT');
  const cEff = col('ACT EFF DT');
  const cTerm = col('TERM DT');
  const cAction = col('ACTION CD');
  const out: HcpcsRowParsed[] = [];
  for (const r of rows.slice(1)) {
    const code = String(r[cCode] ?? '').trim();
    if (code.length === 0) continue;
    out.push({
      code,
      recId: String(r[cRec] ?? '').trim(),
      longDesc: String(r[cLong] ?? '').trim(),
      shortDesc: String(r[cShort] ?? '').trim(),
      coverage: String(r[cCov] ?? '').trim(),
      addDate: cellToIsoDate(r[cAdd]),
      actionEffectiveDate: cellToIsoDate(r[cEff]),
      terminationDate: cellToIsoDate(r[cTerm]),
      actionCode: String(r[cAction] ?? '').trim(),
    });
  }
  return out;
}

export interface HcpcsQuarterLink {
  url: string;
  version: string; // e.g. 2026-10
}

const MONTHS: Record<string, string> = {
  january: '01',
  april: '04',
  july: '07',
  october: '10',
};

/** Finds quarterly zip links; the month name and year ride in the URL. */
export function findHcpcsQuarterLinks(html: string, baseUrl: string): HcpcsQuarterLink[] {
  const out = new Map<string, HcpcsQuarterLink>();
  const re =
    /href="([^"]*\/files\/zip\/(january|april|july|october)-(\d{4})-alpha-numeric-hcpcs-files?\.zip)"/gi;
  for (const m of html.matchAll(re)) {
    const url = new URL(m[1]!, baseUrl).toString();
    const version = `${m[3]}-${MONTHS[m[2]!.toLowerCase()]}`;
    out.set(url, { url, version });
  }
  return [...out.values()].sort((a, b) => b.version.localeCompare(a.version));
}

async function loadQuarter(
  ctx: CourierContext,
  link: HcpcsQuarterLink,
): Promise<{ written: number; parsed: number; unchanged: boolean }> {
  const artifact = await ctx.fetcher.fetchArtifact(link.url, 'cms_hcpcs');
  const doc = await upsertDocument(ctx.pool, {
    sourceId: 'cms_hcpcs',
    externalId: `hcpcs-${link.version}`,
    docType: 'hcpcs_quarterly',
    title: `HCPCS Level II quarterly update ${link.version}`,
    url: link.url,
    versionHash: artifact.sha256,
    effectiveDate: `${link.version}-01`,
    revisionDate: null,
    retiredDate: null,
    tier: 2,
    jurisdiction: [],
    payer: null,
    lob: null,
    clientId: null,
    storagePath: artifact.storagePath,
    metadata: {},
  });
  if (doc.outcome === 'unchanged') return { written: 0, parsed: 0, unchanged: true };

  const entry = zipEntries(artifact.body, /HCPC.*ANWEB.*\.xlsx$/i).find(
    (e) => !/transaction|correction/i.test(e.name),
  );
  if (!entry) throw new Error(`no HCPC*ANWEB*.xlsx entry in ${link.url}`);
  let rows = parseHcpcsRows(xlsxRows(entry.data));
  const parsed = rows.length;
  if (ctx.limit) rows = rows.slice(0, ctx.limit);

  let written = 0;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values: string[] = [];
    const params: unknown[] = [];
    batch.forEach((r, j) => {
      const o = j * 8;
      values.push(
        `('HCPCS',$${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`,
      );
      params.push(
        r.code,
        r.shortDesc,
        r.longDesc,
        r.coverage,
        r.addDate,
        r.terminationDate,
        link.version,
        r.actionCode,
      );
    });
    // codes.status carries the HCPCS coverage code (COV); the per-quarter action code
    // is not persisted, it only describes the change relative to the prior quarter.
    const res = await ctx.pool.query(
      `INSERT INTO codes (code_set, code, short_desc, long_desc, status, effective_date, end_date, version)
       SELECT v.code_set, v.code, v.short_desc, v.long_desc, v.status, v.eff::date, v.term::date, v.version
       FROM (VALUES ${values.join(',')}) AS v(code_set, code, short_desc, long_desc, status, eff, term, version, action)
       ON CONFLICT (code_set, code, version) DO UPDATE SET
         short_desc = EXCLUDED.short_desc,
         long_desc = EXCLUDED.long_desc,
         status = EXCLUDED.status,
         effective_date = EXCLUDED.effective_date,
         end_date = EXCLUDED.end_date`,
      params,
    );
    written += res.rowCount ?? 0;
  }
  return { written, parsed, unchanged: false };
}

async function run(ctx: CourierContext): Promise<CourierResult> {
  const src = await ctx.pool.query<{ base_url: string; config: { backfill_quarters?: number } }>(
    `SELECT base_url, config FROM sources WHERE id = 'cms_hcpcs'`,
  );
  const baseUrl = src.rows[0]?.base_url;
  if (!baseUrl) throw new Error('cms_hcpcs base_url missing in config/sources.yaml');
  const backfill = src.rows[0]?.config?.backfill_quarters ?? 8;

  const landing = await ctx.fetcher.fetchArtifact(baseUrl, 'cms_hcpcs', { accept: 'text/html' });
  const links = findHcpcsQuarterLinks(landing.body.toString('utf8'), landing.finalUrl);
  if (links.length === 0) throw new Error('no quarterly HCPCS zip links found');

  const targets = ctx.limit ? links.slice(0, 1) : links.slice(0, backfill);
  let written = 0;
  let parsed = 0;
  const loaded: string[] = [];
  for (const link of targets) {
    const r = await loadQuarter(ctx, link);
    written += r.written;
    parsed += r.parsed;
    if (!r.unchanged) loaded.push(link.version);
  }
  return {
    rowsWritten: written,
    notes: `quarters loaded: ${loaded.join(', ') || 'none (all unchanged)'}; ${parsed} rows parsed`,
  };
}

export const cmsHcpcsCourier: Courier = { sourceId: 'cms_hcpcs', run };
