import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlSections, htmlToText } from '../src/html.js';
import { parseTherapyThresholds } from '../src/couriers/cms-therapy.js';
import { parseWorkplanCsv } from '../src/couriers/oig-workplan.js';
import { listUrl, stripRawTextWrapper, topicTags, wantsFullText } from '../src/couriers/fedreg.js';
import {
  findTransmittalDetailLinks,
  parseTransmittalDetail,
  sitemapTransmittalUrls,
} from '../src/couriers/cms-mln.js';

const FIX = join(import.meta.dirname, '..', '..', '..', 'evals', 'fixtures');

describe('cms_therapy parser', () => {
  const html = readFileSync(join(FIX, 'cms_therapy', 'therapy-services.body.excerpt.html'), 'utf8');

  it('extracts the CY 2026 KX and medical review thresholds from the real page prose', () => {
    const thresholds = parseTherapyThresholds(htmlToText(html));
    expect(thresholds).not.toBeNull();
    expect(thresholds!.year).toBe(2026);
    expect(thresholds!.kxPtSlp).toBe(2480);
    expect(thresholds!.kxOt).toBe(2480);
    expect(thresholds!.mrAmount).toBe(3000);
  });

  it('returns null on a page without threshold prose instead of guessing', () => {
    expect(parseTherapyThresholds('Totally unrelated page text.')).toBeNull();
  });

  it('htmlSections splits the body on headings', () => {
    const sections = htmlSections(html, 'rxbodyfield');
    expect(sections.length).toBeGreaterThan(1);
  });
});

describe('oig_workplan parser', () => {
  it('parses the real CSV export excerpt', () => {
    const items = parseWorkplanCsv(
      readFileSync(join(FIX, 'oig_workplan', 'export-workplan.excerpt.csv')),
    );
    expect(items.length).toBe(15);
    for (const i of items) {
      expect(i.number.length).toBeGreaterThan(3);
      expect(['ACTIVE', 'COMPLETED', 'CANCELED']).toContain(i.status);
      if (i.announced) expect(i.announced).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(i.narrative).not.toMatch(/<p|data-block-key/); // HTML stripped
    }
  });
});

describe('fedreg helpers', () => {
  it('builds the list URL with agency, types, window, and fields', () => {
    const url = listUrl(
      'https://www.federalregister.gov/api/v1/documents.json',
      '2019-01-01',
      'first',
    );
    expect(url).toContain('centers-for-medicare-medicaid-services');
    expect(url).toContain('RULE');
    expect(url).toContain('PRORULE');
    expect(url).toContain('2019-01-01');
    expect(url).toContain('per_page=1000');
  });

  it('parses the real list page sample', () => {
    const page = JSON.parse(readFileSync(join(FIX, 'fedreg', 'sample_page1.json'), 'utf8')) as {
      count: number;
      results: { document_number: string; publication_date: string; title: string }[];
    };
    expect(page.count).toBeGreaterThan(100);
    expect(page.results.length).toBeGreaterThan(0);
    const doc = page.results[0]!;
    expect(doc.document_number).toMatch(/^\d{4}-\d+$/);
    expect(doc.publication_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('strips the pre wrapper from real raw text', () => {
    const raw = readFileSync(join(FIX, 'fedreg', 'raw_text_2026-14327.head.txt'), 'utf8');
    const text = stripRawTextWrapper(raw);
    expect(text).not.toContain('<pre');
    expect(text.length).toBeGreaterThan(1000);
  });

  it('tags topics and scopes full text to PFS rules in the window', () => {
    expect(topicTags('Medicare Program; CY 2027 Physician Fee Schedule proposed rule')).toContain(
      'pfs',
    );
    expect(
      wantsFullText(
        { title: 'CY 2027 Physician Fee Schedule', publication_date: '2026-07-16' },
        '2023-01-01',
      ),
    ).toBe(true);
    expect(
      wantsFullText(
        { title: 'CY 2020 Physician Fee Schedule', publication_date: '2019-11-01' },
        '2023-01-01',
      ),
    ).toBe(false);
    expect(
      wantsFullText({ title: 'Hospice Wage Index', publication_date: '2026-07-16' }, '2023-01-01'),
    ).toBe(false);
  });
});

describe('cms_mln parser', () => {
  const detailHtml = readFileSync(join(FIX, 'cms_mln', 'transmittal_r13924cp.html'), 'utf8');

  it('parses the real transmittal detail page', () => {
    const d = parseTransmittalDetail(
      detailHtml,
      'https://www.cms.gov/medicare/regulations-guidance/transmittals/2026-transmittals/r13924cp',
    );
    expect(d.transmittalNumber.toUpperCase()).toContain('R13924CP');
    expect(d.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.transmittalPdfUrl ?? d.articlePdfUrl).toMatch(/files\/document\/.*\.pdf$/);
  });

  it('finds detail links on listing markup and sitemap entries', () => {
    const links = findTransmittalDetailLinks(
      '<a href="/medicare/regulations-guidance/transmittals/2026-transmittals/r13924cp">R13924CP</a>',
      'https://www.cms.gov/x',
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.year).toBe(2026);

    const refs = sitemapTransmittalUrls(
      '<url><loc>https://www.cms.gov/medicare/regulations-guidance/transmittals/2025-transmittals/r13000cp</loc></url>',
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]!.year).toBe(2025);
  });
});
