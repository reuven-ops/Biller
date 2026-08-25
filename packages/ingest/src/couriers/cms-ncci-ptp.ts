// Courier for cms_ncci_ptp: NCCI Procedure-to-Procedure edits, practitioner services.
// The four quarterly zips are attestation-gated (docs/DECISIONS.md D7); each inner TXT
// carries per-row effective date, deletion date, modifier indicator, and rationale.
import { optionalEnv } from '@advisor/db';
import type { Courier, CourierContext, CourierResult } from '../courier.js';
import { withDocument } from '../doc-store.js';
import { zipEntries } from '../formats.js';

export interface PtpRowParsed {
  column1: string;
  column2: string;
  priorTo1996: boolean;
  effectiveDate: string;
  deletionDate: string | null;
  modifierIndicator: string;
  rationale: string;
}

const CODE_RE = /^[A-Z0-9]{5}$/;

function yyyymmddToIso(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Parses a ccipra TXT file: AMA notice line, title line, a wrapped multi-line
 * tab-delimited header, then data rows Column1 \t Column2 \t [*] \t YYYYMMDD \t
 * (YYYYMMDD | *) \t (0|1|9) \t rationale, CRLF line endings.
 */
export function parsePtpTxt(data: Buffer): PtpRowParsed[] {
  const rows: PtpRowParsed[] = [];
  for (const line of data.toString('latin1').split(/\r?\n/)) {
    const f = line.split('\t');
    if (f.length < 6) continue;
    const column1 = (f[0] ?? '').trim();
    const column2 = (f[1] ?? '').trim();
    const effective = yyyymmddToIso((f[3] ?? '').trim());
    if (!CODE_RE.test(column1) || !CODE_RE.test(column2) || !effective) continue;
    const deletionRaw = (f[4] ?? '').trim();
    const modifier = (f[5] ?? '').trim();
    if (!/^[019]$/.test(modifier)) continue;
    rows.push({
      column1,
      column2,
      priorTo1996: (f[2] ?? '').trim() === '*',
      effectiveDate: effective,
      deletionDate: yyyymmddToIso(deletionRaw),
      modifierIndicator: modifier,
      rationale: (f[6] ?? '').trim(),
    });
  }
  return rows;
}

/**
 * The published files occasionally repeat a (column1, column2, effective_date) key,
 * observed when a pair was deleted and re-added the same day with a different
 * indicator. The row still in force wins: null deletion_date first, then the later
 * deletion_date.
 */
export function dedupePtpRows(rows: PtpRowParsed[]): PtpRowParsed[] {
  const byKey = new Map<string, PtpRowParsed>();
  for (const row of rows) {
    const key = `${row.column1}|${row.column2}|${row.effectiveDate}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    const keepNew =
      row.deletionDate === null ||
      (existing.deletionDate !== null && row.deletionDate > existing.deletionDate);
    if (keepNew) byKey.set(key, row);
  }
  return [...byKey.values()];
}

export interface PtpFileLink {
  url: string;
  version: string; // e.g. v322r0
  part: number; // f1..f4
}

/**
 * Finds the current quarter's practitioner PTP file links on the downloads page.
 * Links may be wrapped in the license attestation URL (/license/ama?file=...).
 */
export function findPtpFileLinks(html: string, baseUrl: string): PtpFileLink[] {
  const found = new Map<string, PtpFileLink>();
  const re =
    /(?:\/license\/ama\?file=)?(\/files\/zip\/medicare-ncci-\d{4}q\d-practitioner-ptp-edits-ccipra-(v\d+r\d+)-f(\d)\.zip)/g;
  for (const m of html.matchAll(re)) {
    const path = m[1]!;
    const url = new URL(path, baseUrl).toString();
    found.set(url, { url, version: m[2]!, part: Number(m[3]) });
  }
  const all = [...found.values()];
  if (all.length === 0) return [];
  // Keep only the newest version present on the page.
  const newest = all
    .map((l) => l.version)
    .sort((a, b) => Number(b.slice(1).split('r')[0]) - Number(a.slice(1).split('r')[0]))[0]!;
  return all.filter((l) => l.version === newest).sort((a, b) => a.part - b.part);
}

async function loadRows(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
  rows: PtpRowParsed[],
  fileVersion: string,
): Promise<number> {
  let written = 0;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values: string[] = [];
    const params: unknown[] = [];
    batch.forEach((r, j) => {
      const o = j * 7;
      values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`);
      params.push(
        r.column1,
        r.column2,
        r.modifierIndicator,
        r.effectiveDate,
        r.deletionDate,
        r.rationale,
        fileVersion,
      );
    });
    const res = await db.query(
      `INSERT INTO ncci_ptp (column1, column2, modifier_indicator, effective_date,
         deletion_date, rationale, file_version)
       VALUES ${values.join(',')}
       ON CONFLICT (column1, column2, effective_date) DO UPDATE SET
         modifier_indicator = EXCLUDED.modifier_indicator,
         deletion_date = EXCLUDED.deletion_date,
         rationale = EXCLUDED.rationale,
         file_version = EXCLUDED.file_version
       WHERE (ncci_ptp.modifier_indicator, ncci_ptp.deletion_date, ncci_ptp.rationale,
              ncci_ptp.file_version)
             IS DISTINCT FROM
             (EXCLUDED.modifier_indicator, EXCLUDED.deletion_date, EXCLUDED.rationale,
              EXCLUDED.file_version)`,
      params,
    );
    written += res.rowCount ?? 0;
  }
  return written;
}

async function run(ctx: CourierContext): Promise<CourierResult> {
  if (optionalEnv('CMS_LICENSE_ATTESTATION', 'accept') !== 'accept') {
    throw new Error(
      'cms_ncci_ptp needs the CMS end-user license attestation; CMS_LICENSE_ATTESTATION is not "accept" (docs/DECISIONS.md D7)',
    );
  }
  const src = await ctx.pool.query<{ base_url: string }>(
    `SELECT base_url FROM sources WHERE id = 'cms_ncci_ptp'`,
  );
  const baseUrl = src.rows[0]?.base_url;
  if (!baseUrl) throw new Error('cms_ncci_ptp base_url missing in config/sources.yaml');

  const landing = await ctx.fetcher.fetchArtifact(baseUrl, 'cms_ncci_ptp', {
    accept: 'text/html',
  });
  const links = findPtpFileLinks(landing.body.toString('utf8'), landing.finalUrl);
  if (links.length === 0) throw new Error('no practitioner PTP file links found on the page');

  const parts = ctx.limit ? links.slice(0, 1) : links;
  let written = 0;
  let totalParsed = 0;
  for (const link of parts) {
    const artifact = await ctx.fetcher.fetchArtifact(`${link.url}?agree=yes`, 'cms_ncci_ptp');
    const txtEntry = zipEntries(artifact.body, /\.txt$/i)[0];
    if (!txtEntry) throw new Error(`no TXT entry in ${link.url}`);
    const result = await withDocument(
      ctx.pool,
      {
        sourceId: 'cms_ncci_ptp',
        externalId: `ncci-ptp-practitioner-f${link.part}`,
        docType: 'ncci_ptp_file',
        title: `NCCI Practitioner PTP Edits ${link.version} part ${link.part}`,
        url: link.url,
        versionHash: artifact.sha256,
        effectiveDate: null,
        revisionDate: null,
        retiredDate: null,
        tier: 2,
        jurisdiction: [],
        payer: null,
        lob: null,
        clientId: null,
        storagePath: artifact.storagePath,
        metadata: { version: link.version, part: link.part, attested: 'agree=yes (D7)' },
      },
      async (client) => {
        let rows = dedupePtpRows(parsePtpTxt(txtEntry.data));
        totalParsed += rows.length;
        if (ctx.limit) rows = rows.slice(0, ctx.limit);
        return loadRows(client, rows, link.version);
      },
    );
    written += result.rowsWritten;
  }
  return {
    rowsWritten: written,
    notes: `${parts.length} file(s), ${totalParsed} rows parsed, version ${parts[0]?.version ?? ''}; CMS EULA attested (D7)`,
  };
}

export const cmsNcciPtpCourier: Courier = { sourceId: 'cms_ncci_ptp', run };
