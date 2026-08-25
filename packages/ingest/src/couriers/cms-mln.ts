// Courier for cms_mln: Transmittals and their MLN Matters articles. cms.gov robots
// disallows general query strings but explicitly allows /sitemap.xml?page=N, so the
// backfill enumerates transmittal detail pages (clean URLs) from the sitemap; the
// weekly incremental pass reads the clean year-listing pages, whose first 25 rows
// carry the newest transmittals (docs/SOURCES.md).
import type { Courier, CourierContext, CourierResult } from '../courier.js';
import { chunkSections, estimateTokens, extractCodes } from '../chunker.js';
import { replaceChunks, upsertDocument } from '../doc-store.js';
import { extractPdfLines, sectionsFromLines } from '../pdf.js';
import { htmlToText } from '../html.js';

export interface TransmittalRef {
  url: string; // detail page, clean URL
  year: number;
}

/** Detail-page URLs look like /medicare/regulations-guidance/transmittals/2026-transmittals/r13924cp */
const DETAIL_RE = /href="([^"?#]*\/(\d{4})-transmittals\/([a-z0-9-]+))"/gi;

export function findTransmittalDetailLinks(html: string, baseUrl: string): TransmittalRef[] {
  const out = new Map<string, TransmittalRef>();
  for (const m of html.matchAll(DETAIL_RE)) {
    const url = new URL(m[1]!, baseUrl).toString();
    out.set(url, { url, year: Number(m[2]) });
  }
  return [...out.values()];
}

export function sitemapTransmittalUrls(xml: string): TransmittalRef[] {
  const out: TransmittalRef[] = [];
  for (const m of xml.matchAll(/<loc>([^<]*\/(\d{4})-transmittals\/[a-z0-9-]+)<\/loc>/gi)) {
    out.push({ url: m[1]!, year: Number(m[2]) });
  }
  return out;
}

export interface TransmittalDetail {
  transmittalNumber: string;
  subject: string;
  issueDate: string | null;
  implementationDate: string | null;
  crNumber: string;
  transmittalPdfUrl: string | null;
  articlePdfUrl: string | null;
}

function fieldAfterLabel(text: string, label: string): string {
  const re = new RegExp(`${label}\\s*\\n?\\s*([^\\n]+)`, 'i');
  return re.exec(text)?.[1]?.trim() ?? '';
}

function isoDateIn(s: string): string | null {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[0];
  const us = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1]}-${us[2]}`;
  return null;
}

export function parseTransmittalDetail(html: string, pageUrl: string): TransmittalDetail {
  const text = htmlToText(html);
  const pdfs = [...html.matchAll(/href="([^"]*\/files\/document\/[a-z0-9-]+\.pdf)"/gi)].map((m) =>
    new URL(m[1]!, pageUrl).toString(),
  );
  const articlePdfUrl = pdfs.find((u) => /\/(mm|se)\d+/i.test(u)) ?? null;
  const transmittalPdfUrl = pdfs.find((u) => u !== articlePdfUrl) ?? null;
  // <time datetime="..."> attributes are the machine-readable dates.
  const times = [...html.matchAll(/datetime="(\d{4}-\d{2}-\d{2})T/g)].map((m) => m[1]!);
  return {
    transmittalNumber:
      fieldAfterLabel(text, 'Transmittal Number:?') || pageUrl.split('/').pop()!.toUpperCase(),
    subject: fieldAfterLabel(text, 'Subject:?'),
    issueDate: times[0] ?? isoDateIn(fieldAfterLabel(text, 'Issue Date:?')),
    implementationDate: times[1] ?? isoDateIn(fieldAfterLabel(text, 'Implementation Date:?')),
    crNumber: fieldAfterLabel(text, 'CR #:?') || fieldAfterLabel(text, 'CR Number:?'),
    transmittalPdfUrl,
    articlePdfUrl,
  };
}

async function ingestTransmittal(ctx: CourierContext, ref: TransmittalRef): Promise<number> {
  const page = await ctx.fetcher.fetchArtifact(ref.url, 'cms_mln', { accept: 'text/html' });
  const detail = parseTransmittalDetail(page.body.toString('utf8'), page.finalUrl);
  const externalId = `transmittal-${detail.transmittalNumber.toLowerCase()}`;
  const doc = await upsertDocument(ctx.pool, {
    sourceId: 'cms_mln',
    externalId,
    docType: 'transmittal',
    title: `Transmittal ${detail.transmittalNumber}: ${detail.subject || '(no subject parsed)'}`,
    url: ref.url,
    versionHash: page.sha256,
    effectiveDate: detail.implementationDate ?? detail.issueDate,
    revisionDate: detail.issueDate,
    retiredDate: null,
    tier: 2,
    jurisdiction: [],
    payer: null,
    lob: null,
    clientId: null,
    storagePath: page.storagePath,
    metadata: {
      cr_number: detail.crNumber,
      year: ref.year,
      transmittal_pdf: detail.transmittalPdfUrl,
      article_pdf: detail.articlePdfUrl,
    },
  });
  if (doc.outcome === 'unchanged') return 0;

  let written = 0;
  // The MLN Matters article PDF, when present, is the biller-facing narrative worth
  // chunking; the transmittal page itself gets one metadata chunk.
  if (detail.articlePdfUrl) {
    const pdf = await ctx.fetcher.fetchArtifact(detail.articlePdfUrl, 'cms_mln');
    const extraction = await extractPdfLines(new Uint8Array(pdf.body));
    if (extraction.quality === 'ok') {
      const sections = sectionsFromLines(extraction.lines);
      const chunks = chunkSections(
        `MLN Matters ${detail.crNumber ? `CR ${detail.crNumber}` : detail.transmittalNumber}`,
        sections,
      ).map((c) => ({
        sectionPath: c.sectionPath,
        ordinal: c.ordinal + 1,
        text: c.text,
        tokenCount: c.tokenCount,
        tier: 2 as const,
        clientId: null,
        effectiveDate: detail.implementationDate ?? detail.issueDate,
        retiredDate: null,
        codesMentioned: c.codesMentioned,
      }));
      const summary = summaryChunk(detail);
      written += await replaceChunks(ctx.pool, doc.documentId, [summary, ...chunks]);
      return written;
    }
  }
  written += await replaceChunks(ctx.pool, doc.documentId, [summaryChunk(detail)]);
  return written;
}

function summaryChunk(detail: TransmittalDetail): {
  sectionPath: string;
  ordinal: number;
  text: string;
  tokenCount: number;
  tier: 2;
  clientId: null;
  effectiveDate: string | null;
  retiredDate: null;
  codesMentioned: string[];
} {
  const text =
    `Transmittal ${detail.transmittalNumber}. Subject: ${detail.subject}. ` +
    `Issue date: ${detail.issueDate ?? 'unknown'}. Implementation date: ${detail.implementationDate ?? 'unknown'}. ` +
    `Change request: ${detail.crNumber || 'none listed'}.`;
  return {
    sectionPath: 'summary',
    ordinal: 0,
    text,
    tokenCount: estimateTokens(text),
    tier: 2,
    clientId: null,
    effectiveDate: detail.implementationDate ?? detail.issueDate,
    retiredDate: null,
    codesMentioned: extractCodes(detail.subject),
  };
}

async function run(ctx: CourierContext): Promise<CourierResult> {
  const src = await ctx.pool.query<{
    base_url: string;
    config: { backfill_years?: number; sitemap_url?: string; max_sitemap_pages?: number };
  }>(`SELECT base_url, config FROM sources WHERE id = 'cms_mln'`);
  const baseUrl = src.rows[0]?.base_url;
  if (!baseUrl) throw new Error('cms_mln base_url missing in config/sources.yaml');
  const cfg = src.rows[0]?.config ?? {};
  const backfillYears = cfg.backfill_years ?? 3;
  const sitemapUrl = cfg.sitemap_url ?? 'https://www.cms.gov/sitemap.xml';
  const maxSitemapPages = cfg.max_sitemap_pages ?? 80;

  const thisYear = new Date().getUTCFullYear();
  const years = Array.from({ length: backfillYears }, (_, i) => thisYear - i);
  const refs = new Map<string, TransmittalRef>();

  // Incremental: clean-URL year listing pages carry the newest 25 transmittals.
  for (const year of years) {
    const listing = await ctx.fetcher.fetchArtifact(
      `${baseUrl.replace(/\/$/, '')}/${year}-transmittals`,
      'cms_mln',
      { accept: 'text/html' },
    );
    for (const ref of findTransmittalDetailLinks(listing.body.toString('utf8'), listing.finalUrl)) {
      if (years.includes(ref.year)) refs.set(ref.url, ref);
    }
  }

  // Backfill: the already-ingested set tells us whether the deep sitemap walk is
  // needed; once backfilled, the year listings cover the weekly cadence.
  const known = await ctx.pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM documents WHERE source_id = 'cms_mln'`,
  );
  const needBackfill = Number(known.rows[0]?.n ?? 0) < 100 && !ctx.limit;
  if (needBackfill) {
    for (let pageNo = 1; pageNo <= maxSitemapPages; pageNo++) {
      const page = await ctx.fetcher.fetchArtifact(`${sitemapUrl}?page=${pageNo}`, 'cms_mln', {
        accept: 'application/xml',
      });
      const xml = page.body.toString('utf8');
      for (const ref of sitemapTransmittalUrls(xml)) {
        if (years.includes(ref.year)) refs.set(ref.url, ref);
      }
      if (!/<loc>/i.test(xml)) break; // past the last sitemap page
    }
  }

  const targets = ctx.limit ? [...refs.values()].slice(0, ctx.limit) : [...refs.values()];
  let written = 0;
  let processed = 0;
  for (const ref of targets) {
    written += await ingestTransmittal(ctx, ref);
    processed++;
  }
  return {
    rowsWritten: written,
    notes: `${processed} transmittals processed (${refs.size} discovered, backfill ${needBackfill ? 'on' : 'off'})`,
  };
}

export const cmsMlnCourier: Courier = { sourceId: 'cms_mln', run };
