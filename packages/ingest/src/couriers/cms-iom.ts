// Courier for cms_iom: the Internet-Only Manual chapters from brief section 6.8.
// Chapter PDFs live at stable download URLs recorded in config/sources.yaml
// (discovered 2026-08-25; docs/SOURCES.md). Each chapter carries its revision on the
// title page as "(Rev. NNNNN; Issued: MM-DD-YY)"; sections carry their own revision
// lines which stay inside the chunk text for the composer and verifier to quote.
import type { Courier, CourierContext, CourierResult } from '../courier.js';
import { chunkSections } from '../chunker.js';
import { replaceChunks, withDocument } from '../doc-store.js';
import { extractPdfLines, sectionsFromLines } from '../pdf.js';

interface IomChapterConfig {
  manual: string;
  chapter: string;
  title: string;
  url: string;
}

/** "(Rev. 13774; Issued: 05-08-26)" or 4-digit years; returns the issued date. */
export function parseChapterRevision(
  lines: string[],
): { rev: string; issued: string | null } | null {
  for (const line of lines.slice(0, 40)) {
    const m = /\(Rev\.\s*(\d+)[;:]\s*Issued[;:]\s*(\d{2})-(\d{2})-(\d{2,4})\)?/i.exec(line);
    if (m) {
      const year = m[4]!.length === 2 ? `20${m[4]}` : m[4]!;
      return { rev: m[1]!, issued: `${year}-${m[2]}-${m[3]}` };
    }
  }
  return null;
}

async function run(ctx: CourierContext): Promise<CourierResult> {
  const src = await ctx.pool.query<{ config: { chapters?: IomChapterConfig[] } }>(
    `SELECT config FROM sources WHERE id = 'cms_iom'`,
  );
  const chapters = src.rows[0]?.config?.chapters ?? [];
  if (chapters.length === 0) throw new Error('cms_iom chapters missing in config/sources.yaml');

  const targets = ctx.limit ? chapters.slice(0, 1) : chapters;
  let written = 0;
  const notes: string[] = [];
  for (const chapter of targets) {
    if (!chapter.url)
      throw new Error(`cms_iom chapter ${chapter.manual} ch ${chapter.chapter} has no url`);
    const artifact = await ctx.fetcher.fetchArtifact(chapter.url, 'cms_iom');
    const externalId = `iom-${chapter.manual}-ch${chapter.chapter}`;
    const extraction = await extractPdfLines(new Uint8Array(artifact.body));
    const revision = parseChapterRevision(extraction.lines);
    const result = await withDocument(
      ctx.pool,
      {
        sourceId: 'cms_iom',
        externalId,
        docType: 'iom_chapter',
        title: chapter.title,
        url: chapter.url,
        versionHash: artifact.sha256,
        effectiveDate: null,
        revisionDate: revision?.issued ?? null,
        retiredDate: null,
        tier: 2,
        jurisdiction: [],
        payer: null,
        lob: null,
        clientId: null,
        storagePath: artifact.storagePath,
        metadata: {
          manual: chapter.manual,
          chapter: chapter.chapter,
          rev: revision?.rev ?? null,
          pages: extraction.pages,
          quality: extraction.quality,
          ...(extraction.quality === 'poor' ? { quality_note: extraction.qualityNote } : {}),
        },
      },
      async (client, documentId) => {
        if (extraction.quality === 'poor') return 0;
        const sections = sectionsFromLines(extraction.lines);
        const prefix = `${chapter.manual} > Ch.${chapter.chapter}`;
        const chunks = chunkSections(chapter.title, sections).map((c) => ({
          sectionPath: `${prefix} > ${c.sectionPath}`,
          ordinal: c.ordinal,
          text: c.text,
          tokenCount: c.tokenCount,
          tier: 2 as const,
          clientId: null,
          effectiveDate: null,
          retiredDate: null,
          codesMentioned: c.codesMentioned,
        }));
        return replaceChunks(client, documentId, chunks);
      },
    );
    if (result.outcome === 'unchanged') {
      notes.push(`${externalId} unchanged`);
      continue;
    }
    if (extraction.quality === 'poor') {
      notes.push(`${externalId} flagged poor quality, not chunked`);
      continue;
    }
    written += result.rowsWritten;
    notes.push(`${externalId} rev ${revision?.rev ?? '?'}: ${result.rowsWritten} chunks`);
  }
  return { rowsWritten: written, notes: notes.join('; ') };
}

export const cmsIomCourier: Courier = { sourceId: 'cms_iom', run };
