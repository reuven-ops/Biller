// Courier for fedreg: Federal Register CMS rules and proposed rules via the keyless
// public API. Metadata for every CMS rule since backfill_from; full text, chunked,
// for Physician Fee Schedule rules from full_text_from forward (docs/DECISIONS.md D9).
// A redirect to unblock.federalregister.gov means bot mitigation reached the API;
// the courier stops with a clear error instead of working around it.
import { createHash } from 'node:crypto';
import type { Courier, CourierContext, CourierResult } from '../courier.js';
import { chunkSections } from '../chunker.js';
import { replaceChunks, withDocument } from '../doc-store.js';
import { sectionsFromLines } from '../pdf.js';

interface FedregListDoc {
  document_number: string;
  title: string;
  type: string;
  publication_date: string;
  effective_on: string | null;
  citation: string | null;
  docket_ids: string[];
  raw_text_url: string | null;
  html_url: string | null;
  abstract: string | null;
}

interface FedregListResponse {
  count: number;
  next_page_url?: string | null;
  results: FedregListDoc[];
}

const TOPIC_TAGS: [RegExp, string][] = [
  [/physician fee schedule/i, 'pfs'],
  [/therapy|rehabilitation/i, 'therapy'],
  [/telehealth|telemedicine/i, 'telehealth'],
  [/behavioral health|mental health|psychiatr|psycholog/i, 'behavioral_health'],
  [/chiroprac/i, 'chiropractic'],
  [/quality payment program|mips/i, 'qpp'],
];

export function topicTags(title: string): string[] {
  return TOPIC_TAGS.filter(([re]) => re.test(title)).map(([, tag]) => tag);
}

export function wantsFullText(
  doc: { title: string; publication_date: string },
  from: string,
): boolean {
  return doc.publication_date >= from && /physician fee schedule/i.test(doc.title);
}

/** raw_text_url bodies are minimal HTML wrapping GPO text in a pre block. */
export function stripRawTextWrapper(body: string): string {
  const open = /<pre[^>]*>/i.exec(body);
  let text = open ? body.slice(open.index + open[0].length) : body;
  const close = text.lastIndexOf('</pre>');
  if (close >= 0) text = text.slice(0, close);
  text = text.replace(/<a [^>]*>|<\/a>/gi, '');
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return text;
}

export function listUrl(base: string, backfillFrom: string, page: 'first' | string): string {
  if (page !== 'first') return page;
  const u = new URL(base);
  u.searchParams.append('conditions[agencies][]', 'centers-for-medicare-medicaid-services');
  u.searchParams.append('conditions[type][]', 'RULE');
  u.searchParams.append('conditions[type][]', 'PRORULE');
  u.searchParams.set('conditions[publication_date][gte]', backfillFrom);
  for (const f of [
    'document_number',
    'title',
    'type',
    'publication_date',
    'effective_on',
    'citation',
    'docket_ids',
    'raw_text_url',
    'html_url',
    'abstract',
  ]) {
    u.searchParams.append('fields[]', f);
  }
  u.searchParams.set('per_page', '1000');
  u.searchParams.set('order', 'oldest');
  return u.toString();
}

function assertNotBlocked(finalUrl: string): void {
  if (finalUrl.includes('unblock.federalregister.gov')) {
    throw new Error(
      'federalregister.gov bot mitigation triggered (redirect to unblock page); stopping per brief rule 2.9',
    );
  }
}

async function run(ctx: CourierContext): Promise<CourierResult> {
  const src = await ctx.pool.query<{
    base_url: string;
    config: { backfill_from?: string; full_text_from?: string };
  }>(`SELECT base_url, config FROM sources WHERE id = 'fedreg'`);
  const baseUrl = src.rows[0]?.base_url;
  if (!baseUrl) throw new Error('fedreg base_url missing in config/sources.yaml');
  const backfillFrom = src.rows[0]?.config?.backfill_from ?? '2019-01-01';
  const fullTextFrom = src.rows[0]?.config?.full_text_from ?? '2023-01-01';

  let written = 0;
  let docsSeen = 0;
  let fullTexts = 0;
  let next: string = listUrl(baseUrl, backfillFrom, 'first');
  while (next) {
    const page = await ctx.fetcher.fetchArtifact(next, 'fedreg', { accept: 'application/json' });
    assertNotBlocked(page.finalUrl);
    const parsed = JSON.parse(page.body.toString('utf8')) as FedregListResponse;
    for (const d of parsed.results) {
      docsSeen++;
      if (ctx.limit && docsSeen > ctx.limit) break;
      const tags = topicTags(d.title);
      const versionHash = contentHash(d);
      // Skip the full-text fetch when this version is already stored.
      const head = await ctx.pool.query<{ version_hash: string }>(
        `SELECT version_hash FROM documents
         WHERE source_id = 'fedreg' AND external_id = $1 AND superseded_by IS NULL
         ORDER BY retrieved_at DESC LIMIT 1`,
        [d.document_number],
      );
      if (head.rows[0]?.version_hash === versionHash) continue;

      const wantFull = wantsFullText(d, fullTextFrom) && d.raw_text_url && !ctx.limit;
      let fullTextChunks: ReturnType<typeof chunkSections> | null = null;
      if (wantFull) {
        const raw = await ctx.fetcher.fetchArtifact(d.raw_text_url!, 'fedreg');
        assertNotBlocked(raw.finalUrl);
        const text = stripRawTextWrapper(raw.body.toString('utf8'));
        const sections = sectionsFromLines(
          text.split(/\r?\n/).map((l) => l.trim()),
          /^([IVXLC]+\.|[A-Z]\.\s|\d{1,2}\.\s)\s*(.{3,120})$/,
        );
        fullTextChunks = chunkSections(d.title, sections);
      }

      const result = await withDocument(
        ctx.pool,
        {
          sourceId: 'fedreg',
          externalId: d.document_number,
          docType: d.type === 'Proposed Rule' ? 'fedreg_proposed_rule' : 'fedreg_rule',
          title: d.title,
          url: d.html_url,
          versionHash,
          effectiveDate: d.effective_on ?? d.publication_date,
          revisionDate: null,
          retiredDate: null,
          tier: 1,
          jurisdiction: [],
          payer: null,
          lob: null,
          clientId: null,
          storagePath: page.storagePath,
          metadata: {
            citation: d.citation,
            docket_ids: d.docket_ids,
            publication_date: d.publication_date,
            tags,
          },
        },
        async (client, documentId) => {
          if (fullTextChunks) {
            return replaceChunks(
              client,
              documentId,
              fullTextChunks.map((c) => ({
                sectionPath: c.sectionPath,
                ordinal: c.ordinal,
                text: c.text,
                tokenCount: c.tokenCount,
                tier: 1 as const,
                clientId: null,
                effectiveDate: d.effective_on ?? d.publication_date,
                retiredDate: null,
                codesMentioned: c.codesMentioned,
              })),
            );
          }
          if (d.abstract) {
            return replaceChunks(client, documentId, [
              {
                sectionPath: 'abstract',
                ordinal: 0,
                text: `${d.title}\n\n${d.abstract}`,
                tokenCount: Math.ceil(d.abstract.length / 3),
                tier: 1,
                clientId: null,
                effectiveDate: d.effective_on ?? d.publication_date,
                retiredDate: null,
                codesMentioned: [],
              },
            ]);
          }
          return 0;
        },
      );
      written += result.rowsWritten;
      if (result.outcome !== 'unchanged' && fullTextChunks) fullTexts++;
    }
    if (ctx.limit && docsSeen >= ctx.limit) break;
    next = parsed.next_page_url ?? '';
  }
  return {
    rowsWritten: written,
    notes: `${docsSeen} documents listed, ${fullTexts} with full text (PFS rules since ${fullTextFrom})`,
  };
}

function contentHash(d: FedregListDoc): string {
  return createHash('sha256').update(JSON.stringify(d)).digest('hex');
}

export const fedregCourier: Courier = { sourceId: 'fedreg', run };
