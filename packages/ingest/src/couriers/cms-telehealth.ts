// Courier for cms_telehealth_list: the List of Medicare Telehealth Services, one file
// per calendar year. CMS keeps only the current year online (prior-year URLs redirect
// to the current file), so each edition is archived at ingest time and the year is
// read from the final URL after redirects. The file's Short Descriptor column is AMA
// CPT text and is stored only when CPT_LICENSE_MODE=licensed.
import { optionalEnv } from '@advisor/db';
import type { Courier, CourierContext, CourierResult } from '../courier.js';
import { withDocument } from '../doc-store.js';
import { xlsxRows, zipEntries } from '../formats.js';

export interface TelehealthRowParsed {
  code: string;
  shortDesc: string;
  action: string;
}

/** Parses the workbook rows: title row, then HCPCS | Short Descriptor | action. */
export function parseTelehealthRows(rows: unknown[][]): TelehealthRowParsed[] {
  const headerIdx = rows.findIndex(
    (r) =>
      String(r[0] ?? '')
        .trim()
        .toUpperCase() === 'HCPCS',
  );
  if (headerIdx < 0) throw new Error('telehealth workbook header row (HCPCS) not found');
  const out: TelehealthRowParsed[] = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const code = String(r[0] ?? '').trim();
    if (!/^[A-Z0-9]{5}$/.test(code)) continue;
    out.push({
      code,
      shortDesc: String(r[1] ?? '').trim(),
      action: String(r[2] ?? '').trim(),
    });
  }
  return out;
}

export function findTelehealthZip(html: string, baseUrl: string): string | null {
  const m = /href="([^"]*\/files\/zip\/list-telehealth-services-calendar-year-\d{4}\.zip)"/i.exec(
    html,
  );
  return m?.[1] ? new URL(m[1], baseUrl).toString() : null;
}

export function yearFromUrl(url: string): number | null {
  const m = /calendar-year-(\d{4})\.zip/.exec(url);
  return m ? Number(m[1]) : null;
}

async function run(ctx: CourierContext): Promise<CourierResult> {
  const src = await ctx.pool.query<{ base_url: string }>(
    `SELECT base_url FROM sources WHERE id = 'cms_telehealth_list'`,
  );
  const baseUrl = src.rows[0]?.base_url;
  if (!baseUrl) throw new Error('cms_telehealth_list base_url missing in config/sources.yaml');

  const landing = await ctx.fetcher.fetchArtifact(baseUrl, 'cms_telehealth_list', {
    accept: 'text/html',
  });
  const zipUrl = findTelehealthZip(landing.body.toString('utf8'), landing.finalUrl);
  if (!zipUrl) throw new Error('telehealth list zip link not found');

  const artifact = await ctx.fetcher.fetchArtifact(zipUrl, 'cms_telehealth_list');
  // The year comes from the final URL: an out-of-date slug redirects to the current year.
  const year = yearFromUrl(artifact.finalUrl) ?? yearFromUrl(zipUrl);
  if (!year) throw new Error(`cannot read calendar year from ${artifact.finalUrl}`);

  const entry = zipEntries(artifact.body, /\.xlsx$/i)[0];
  if (!entry) throw new Error(`no xlsx entry in ${zipUrl}`);
  let rows = parseTelehealthRows(xlsxRows(entry.data));
  if (ctx.limit) rows = rows.slice(0, ctx.limit);
  const licensed = optionalEnv('CPT_LICENSE_MODE', 'none') === 'licensed';

  const result = await withDocument(
    ctx.pool,
    {
      sourceId: 'cms_telehealth_list',
      externalId: `telehealth-cy${year}`,
      docType: 'telehealth_list',
      title: `List of Medicare Telehealth Services, CY ${year}`,
      url: artifact.finalUrl,
      versionHash: artifact.sha256,
      effectiveDate: `${year}-01-01`,
      revisionDate: null,
      retiredDate: `${year}-12-31`,
      tier: 2,
      jurisdiction: [],
      payer: null,
      lob: null,
      clientId: null,
      storagePath: artifact.storagePath,
      metadata: { year },
    },
    async (client) => {
      let written = 0;
      for (const r of rows) {
        const res = await client.query(
          `INSERT INTO telehealth_services (code, year, action, short_desc, file_version)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (code, year) DO UPDATE SET
             action = EXCLUDED.action, short_desc = EXCLUDED.short_desc,
             file_version = EXCLUDED.file_version`,
          [r.code, year, r.action, licensed ? r.shortDesc : null, `cy${year}`],
        );
        written += res.rowCount ?? 0;
      }
      return written;
    },
  );
  if (result.outcome === 'unchanged') return { rowsWritten: 0, notes: `unchanged (CY ${year})` };
  return { rowsWritten: result.rowsWritten, notes: `CY ${year}, ${rows.length} services` };
}

export const cmsTelehealthCourier: Courier = { sourceId: 'cms_telehealth_list', run };
