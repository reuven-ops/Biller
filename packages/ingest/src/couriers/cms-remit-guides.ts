// Courier for cms_remit_guides (D14): the CMS remittance advice guidance PDFs
// (the MLN Remittance Advice Resources and FAQs booklet and the CCIIO CAA/NSA
// RARC guidance) that ground the denial code glosses and remit view prose.
import { createHash } from 'node:crypto';
import type { Courier, CourierContext, CourierResult } from '../courier.js';
import { chunkSections } from '../chunker.js';
import { extractPdfLines } from '../pdf.js';
import { replaceChunks, withDocument } from '../doc-store.js';

interface GuideConfig {
  title: string;
  url: string;
  note?: string;
}

/** Sections on ALL-CAPS headings (the booklet's style); one section as fallback. */
export function remitGuideSections(lines: string[]): { path: string; text: string }[] {
  const sections: { path: string; text: string }[] = [];
  let path = 'front matter';
  let buffer: string[] = [];
  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text.length > 0) sections.push({ path, text });
    buffer = [];
  };
  for (const line of lines) {
    const heading = /^[A-Z][A-Z &/()',-]{2,59}$/.test(line.trim()) && !line.includes('....');
    if (heading) {
      flush();
      path = line.trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections.length > 0 ? sections : [{ path: 'document', text: lines.join('\n') }];
}

async function run(ctx: CourierContext): Promise<CourierResult> {
  const pool = ctx.pool;
  {
    const src = await pool.query<{ config: { documents?: GuideConfig[] } }>(
      `SELECT config FROM sources WHERE id = 'cms_remit_guides'`,
    );
    const documents = src.rows[0]?.config?.documents ?? [];
    if (documents.length === 0)
      throw new Error('cms_remit_guides documents missing in config/sources.yaml');
    const targets = ctx.limit ? documents.slice(0, 1) : documents;
    const notes: string[] = [];
    let rows = 0;
    for (const doc of targets) {
      const artifact = await ctx.fetcher.fetchArtifact(doc.url, 'cms_remit_guides', {
        accept: 'application/pdf',
      });
      const extraction = await extractPdfLines(new Uint8Array(artifact.body));
      const sections = remitGuideSections(extraction.lines);
      const externalId = `remit-guide-${createHash('sha256').update(doc.url).digest('hex').slice(0, 12)}`;
      const outcome = await withDocument(
        pool,
        {
          sourceId: 'cms_remit_guides',
          externalId,
          docType: 'guidance',
          title: doc.title,
          url: doc.url,
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
          metadata: { pages: extraction.pages, note: doc.note ?? null },
        },
        async (client, documentId) => {
          const chunks = chunkSections(doc.title, sections).map((c) => ({
            sectionPath: c.sectionPath,
            ordinal: c.ordinal,
            text: c.text,
            tokenCount: c.tokenCount,
            tier: 2 as const,
            clientId: null,
            effectiveDate: null,
            retiredDate: null,
            codesMentioned: c.codesMentioned,
            metadata: {},
          }));
          return replaceChunks(client, documentId, chunks);
        },
      );
      rows += outcome.rowsWritten;
      notes.push(`${doc.title}: ${outcome.outcome}, ${outcome.rowsWritten} chunks`);
    }
    return { rowsWritten: rows, notes: notes.join('; ') };
  }
}

export const cmsRemitGuidesCourier: Courier = { sourceId: 'cms_remit_guides', run };
