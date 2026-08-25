// Courier for oig_workplan: HHS OIG Work Plan items via the site's own CSV export
// endpoint (the browse page's download button). Active items become documents with
// one chunk each; items that leave the active set get retired_date stamped.
import { createHash } from 'node:crypto';
import type { Courier, CourierContext, CourierResult } from '../courier.js';
import { estimateTokens, extractCodes } from '../chunker.js';
import { replaceChunks, upsertDocument } from '../doc-store.js';
import { csvRows } from '../formats.js';
import { htmlToText } from '../html.js';

export interface WorkplanItem {
  number: string;
  title: string;
  type: string;
  narrative: string;
  component: string;
  agencies: string;
  status: string;
  announced: string | null;
  estFy: string;
}

export function parseWorkplanCsv(data: Buffer): WorkplanItem[] {
  // The export starts with a (sometimes doubled) UTF-8 BOM.
  let text = data.toString('utf8');
  while (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = csvRows(text);
  const header = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const col = (name: string): number => {
    const idx = header.indexOf(name.toLowerCase());
    if (idx < 0) throw new Error(`workplan CSV column missing: ${name}`);
    return idx;
  };
  const cNumber = col('Number');
  const cTitle = col('Title');
  const cType = col('Type');
  const cNarrative = col('Narrative');
  const cComponent = col('Component');
  const cAgencies = col('Agencies');
  const cStatus = col('Status');
  const cAnnounced = col('Announced Date');
  const cFy = col('Est FY');
  const out: WorkplanItem[] = [];
  for (const r of rows.slice(1)) {
    const number = (r[cNumber] ?? '').trim();
    if (!number) continue;
    const announcedRaw = (r[cAnnounced] ?? '').trim();
    out.push({
      number,
      title: (r[cTitle] ?? '').trim(),
      type: (r[cType] ?? '').trim(),
      narrative: htmlToText(r[cNarrative] ?? ''),
      component: (r[cComponent] ?? '').trim(),
      agencies: (r[cAgencies] ?? '').trim(),
      status: (r[cStatus] ?? '').trim().toUpperCase(),
      announced: /^\d{4}-\d{2}-\d{2}$/.test(announcedRaw) ? announcedRaw : null,
      estFy: (r[cFy] ?? '').trim(),
    });
  }
  return out;
}

async function run(ctx: CourierContext): Promise<CourierResult> {
  const src = await ctx.pool.query<{ config: { export_url?: string } }>(
    `SELECT config FROM sources WHERE id = 'oig_workplan'`,
  );
  const exportUrl = src.rows[0]?.config?.export_url;
  if (!exportUrl) throw new Error('oig_workplan config.export_url missing in config/sources.yaml');

  const artifact = await ctx.fetcher.fetchArtifact(exportUrl, 'oig_workplan', {
    accept: 'text/csv',
  });
  const items = parseWorkplanCsv(artifact.body);
  const active = items.filter((i) => i.status === 'ACTIVE');
  const targets = ctx.limit ? active.slice(0, ctx.limit) : active;

  let written = 0;
  for (const item of targets) {
    const body = `${item.title}\n\n${item.narrative}\n\nStatus: active. Component: ${item.component}. Expected issue FY ${item.estFy}.`;
    const doc = await upsertDocument(ctx.pool, {
      sourceId: 'oig_workplan',
      externalId: item.number,
      docType: 'oig_workplan_item',
      title: `OIG Work Plan: ${item.title}`,
      url: 'https://oig.hhs.gov/reports/work-plan/browse-work-plan-projects/',
      versionHash: sha1ish(body),
      effectiveDate: item.announced,
      revisionDate: null,
      retiredDate: null,
      tier: 2,
      jurisdiction: [],
      payer: null,
      lob: null,
      clientId: null,
      storagePath: artifact.storagePath,
      metadata: { component: item.component, agencies: item.agencies, est_fy: item.estFy },
    });
    if (doc.outcome === 'unchanged') continue;
    written += await replaceChunks(ctx.pool, doc.documentId, [
      {
        sectionPath: item.number,
        ordinal: 0,
        text: `OIG Work Plan ${item.number}\n\n${body}`,
        tokenCount: estimateTokens(body),
        tier: 2,
        clientId: null,
        effectiveDate: item.announced,
        retiredDate: null,
        codesMentioned: extractCodes(body),
      },
    ]);
  }

  // Items no longer active: stamp retired_date so DOS-filtered retrieval drops them.
  if (!ctx.limit) {
    const res = await ctx.pool.query(
      `UPDATE documents SET retired_date = now()::date
       WHERE source_id = 'oig_workplan' AND retired_date IS NULL AND superseded_by IS NULL
         AND NOT (external_id = ANY($1::text[]))`,
      [active.map((i) => i.number)],
    );
    await ctx.pool.query(
      `UPDATE chunks SET retired_date = now()::date
       FROM documents d
       WHERE chunks.document_id = d.id AND d.source_id = 'oig_workplan'
         AND d.retired_date IS NOT NULL AND chunks.retired_date IS NULL`,
    );
    written += res.rowCount ?? 0;
  }
  return {
    rowsWritten: written,
    notes: `${active.length} active items in export (${items.length} total)`,
  };
}

// A content hash for version detection; not security-sensitive.
function sha1ish(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export const oigWorkplanCourier: Courier = { sourceId: 'oig_workplan', run };
