// Courier for cms_therapy: the Therapy Services page. KX modifier threshold amounts
// and the targeted medical review threshold live in prose on the page for the current
// calendar year only; each year's page version is archived and its amounts stored in
// therapy_thresholds. Prior years arrive through cms_mln and fedreg (docs/SOURCES.md).
import type { Courier, CourierContext, CourierResult } from '../courier.js';
import { chunkSections } from '../chunker.js';
import { replaceChunks, upsertDocument } from '../doc-store.js';
import { htmlSections, htmlToText } from '../html.js';

export interface TherapyThresholds {
  year: number;
  kxPtSlp: number | null;
  kxOt: number | null;
  mrAmount: number | null;
}

function dollars(s: string): number {
  return Number(s.replaceAll(',', ''));
}

/**
 * Pulls the CY, the KX threshold amounts, and the medical review threshold out of the
 * page text. Anchored on the phrases CMS uses; a page rewrite makes this return nulls,
 * which the courier reports loudly rather than guessing.
 */
export function parseTherapyThresholds(pageText: string): TherapyThresholds | null {
  const kxBlock =
    /For CY (\d{4}) this KX modifier threshold amount is:?\s*\$?([\d,]+) for PT and SLP services combined[,;\s]*(?:and)?\s*\$?([\d,]+) for OT services/i.exec(
      pageText,
    );
  let year: number | null = kxBlock ? Number(kxBlock[1]) : null;
  let kxPtSlp: number | null = kxBlock ? dollars(kxBlock[2]!) : null;
  let kxOt: number | null = kxBlock ? dollars(kxBlock[3]!) : null;

  if (!kxBlock) {
    // Fallback: the updates callout ("KX modifier threshold amounts of $2,480 for CY 2026").
    const callout = /KX modifier threshold amounts? of \$([\d,]+) for CY (\d{4})/i.exec(pageText);
    if (callout) {
      year = Number(callout[2]);
      kxPtSlp = dollars(callout[1]!);
      kxOt = dollars(callout[1]!);
    }
  }
  if (year === null) return null;

  const mr = /MR threshold is \$([\d,]+) for PT and SLP services/i.exec(pageText);
  return { year, kxPtSlp, kxOt, mrAmount: mr ? dollars(mr[1]!) : null };
}

async function run(ctx: CourierContext): Promise<CourierResult> {
  const src = await ctx.pool.query<{ base_url: string }>(
    `SELECT base_url FROM sources WHERE id = 'cms_therapy'`,
  );
  const baseUrl = src.rows[0]?.base_url;
  if (!baseUrl) throw new Error('cms_therapy base_url missing in config/sources.yaml');

  const artifact = await ctx.fetcher.fetchArtifact(baseUrl, 'cms_therapy', {
    accept: 'text/html',
  });
  const html = artifact.body.toString('utf8');
  const pageText = htmlToText(html);
  const thresholds = parseTherapyThresholds(pageText);

  const doc = await upsertDocument(ctx.pool, {
    sourceId: 'cms_therapy',
    externalId: thresholds ? `therapy-services-cy${thresholds.year}` : 'therapy-services',
    docType: 'therapy_page',
    title: `CMS Therapy Services page${thresholds ? `, CY ${thresholds.year}` : ''}`,
    url: artifact.finalUrl,
    versionHash: artifact.sha256,
    effectiveDate: thresholds ? `${thresholds.year}-01-01` : null,
    revisionDate: null,
    retiredDate: null,
    tier: 2,
    jurisdiction: [],
    payer: null,
    lob: null,
    clientId: null,
    storagePath: artifact.storagePath,
    metadata: thresholds ? { thresholds: { ...thresholds } } : { thresholds: null },
  });
  if (doc.outcome === 'unchanged') {
    return { rowsWritten: 0, notes: 'unchanged' };
  }

  let written = 0;
  if (thresholds) {
    const res = await ctx.pool.query(
      `INSERT INTO therapy_thresholds (year, kx_pt_slp, kx_ot, mr_pt_slp, mr_ot, source_document_id)
       VALUES ($1, $2, $3, $4, $4, $5)
       ON CONFLICT (year) DO UPDATE SET
         kx_pt_slp = EXCLUDED.kx_pt_slp, kx_ot = EXCLUDED.kx_ot,
         mr_pt_slp = EXCLUDED.mr_pt_slp, mr_ot = EXCLUDED.mr_ot,
         source_document_id = EXCLUDED.source_document_id`,
      [thresholds.year, thresholds.kxPtSlp, thresholds.kxOt, thresholds.mrAmount, doc.documentId],
    );
    written += res.rowCount ?? 0;
  }

  let sections = htmlSections(html, 'rxbodyfield');
  if (ctx.limit) sections = sections.slice(0, ctx.limit);
  const chunks = chunkSections('CMS Therapy Services page', sections).map((c) => ({
    sectionPath: c.sectionPath,
    ordinal: c.ordinal,
    text: c.text,
    tokenCount: c.tokenCount,
    tier: 2 as const,
    clientId: null,
    effectiveDate: thresholds ? `${thresholds.year}-01-01` : null,
    retiredDate: null,
    codesMentioned: c.codesMentioned,
  }));
  written += await replaceChunks(ctx.pool, doc.documentId, chunks);
  return {
    rowsWritten: written,
    notes: thresholds
      ? `CY ${thresholds.year}: KX PT/SLP $${thresholds.kxPtSlp}, OT $${thresholds.kxOt}, MR $${thresholds.mrAmount}`
      : 'threshold prose not found; page archived and chunked, amounts NOT stored',
  };
}

export const cmsTherapyCourier: Courier = { sourceId: 'cms_therapy', run };
