// Courier for cms_ncci_manual: the NCCI Policy Manual for Medicare Services. The
// current edition is published as one combined all-chapters PDF; the version is the
// calendar year and the edition is effective January 1 of that year.
import type { Courier, CourierContext, CourierResult } from '../courier.js';
import type { Section } from '../chunker.js';
import { chunkSections } from '../chunker.js';
import { replaceChunks, upsertDocument } from '../doc-store.js';
import { extractPdfLines } from '../pdf.js';

export interface ManualLink {
  url: string;
  year: number;
}

export function findManualPdfLink(html: string, baseUrl: string): ManualLink | null {
  const matches = [
    ...html.matchAll(
      /href="([^"]*\/files\/document\/(\d{4})-ncci-medicare-policy-manual-all-chapters\.pdf)"/gi,
    ),
  ];
  if (matches.length === 0) return null;
  const newest = matches.sort((a, b) => Number(b[2]) - Number(a[2]))[0]!;
  return { url: new URL(newest[1]!, baseUrl).toString(), year: Number(newest[2]) };
}

/**
 * Splits NCCI manual lines into sections. The manual uses CHAPTER I..XIII roman
 * headings and lettered section headings ("A. Introduction"). Table-of-contents
 * lines (dot leaders) are not headings.
 */
export function ncciManualSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let chapter = '';
  let path = 'front matter';
  let buffer: string[] = [];
  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text.length > 0) sections.push({ path, text });
    buffer = [];
  };
  for (const line of lines) {
    const ch = /^CHAPTER\s+([IVX]+)\b/i.exec(line);
    const letter = /^([A-Z])\.\s+([A-Za-z].{2,79})$/.exec(line);
    if (ch && ch[1]) {
      flush();
      chapter = ch[1].toUpperCase();
      path = `Ch.${chapter}`;
      continue;
    }
    if (letter && letter[1] && letter[2] && !letter[2].includes('....')) {
      flush();
      path = chapter
        ? `Ch.${chapter} > ${letter[1]}. ${letter[2].trim()}`
        : `${letter[1]}. ${letter[2].trim()}`;
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

async function run(ctx: CourierContext): Promise<CourierResult> {
  const src = await ctx.pool.query<{ base_url: string }>(
    `SELECT base_url FROM sources WHERE id = 'cms_ncci_manual'`,
  );
  const baseUrl = src.rows[0]?.base_url;
  if (!baseUrl) throw new Error('cms_ncci_manual base_url missing in config/sources.yaml');

  const landing = await ctx.fetcher.fetchArtifact(baseUrl, 'cms_ncci_manual', {
    accept: 'text/html',
  });
  const link = findManualPdfLink(landing.body.toString('utf8'), landing.finalUrl);
  if (!link) throw new Error('all-chapters NCCI manual PDF link not found');

  const artifact = await ctx.fetcher.fetchArtifact(link.url, 'cms_ncci_manual');
  const extraction = await extractPdfLines(new Uint8Array(artifact.body));
  const doc = await upsertDocument(ctx.pool, {
    sourceId: 'cms_ncci_manual',
    externalId: 'ncci-manual',
    docType: 'ncci_manual',
    title: `NCCI Policy Manual for Medicare Services, ${link.year} edition`,
    url: link.url,
    versionHash: artifact.sha256,
    effectiveDate: `${link.year}-01-01`,
    revisionDate: null,
    retiredDate: null,
    tier: 2,
    jurisdiction: [],
    payer: null,
    lob: null,
    clientId: null,
    storagePath: artifact.storagePath,
    metadata: { year: link.year, pages: extraction.pages, quality: extraction.quality },
  });
  if (doc.outcome === 'unchanged') return { rowsWritten: 0, notes: `unchanged (${link.year})` };
  if (extraction.quality === 'poor') {
    return {
      rowsWritten: 0,
      notes: `document flagged, not chunked: ${extraction.qualityNote}`,
    };
  }
  let sections = ncciManualSections(extraction.lines);
  if (ctx.limit) sections = sections.slice(0, ctx.limit);
  const chunks = chunkSections(`NCCI Policy Manual ${link.year}`, sections).map((c) => ({
    sectionPath: c.sectionPath,
    ordinal: c.ordinal,
    text: c.text,
    tokenCount: c.tokenCount,
    tier: 2 as const,
    clientId: null,
    effectiveDate: `${link.year}-01-01`,
    retiredDate: null,
    codesMentioned: c.codesMentioned,
  }));
  const written = await replaceChunks(ctx.pool, doc.documentId, chunks);
  return {
    rowsWritten: written,
    notes: `${link.year} edition, ${extraction.pages} pages, ${sections.length} sections`,
  };
}

export const cmsNcciManualCourier: Courier = { sourceId: 'cms_ncci_manual', run };
