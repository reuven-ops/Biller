import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dotted,
  findGuidelinesPdf,
  findOrderZipLinks,
  parseOrderFile,
} from '../src/couriers/cms-icd10cm.js';
import {
  findTelehealthZip,
  parseTelehealthRows,
  yearFromUrl,
} from '../src/couriers/cms-telehealth.js';
import { parseChapterRevision } from '../src/couriers/cms-iom.js';

const FIX = join(import.meta.dirname, '..', '..', '..', 'evals', 'fixtures');

describe('cms_icd10cm parser', () => {
  const data = readFileSync(join(FIX, 'cms_icd10cm', 'icd10cm_order_2026.excerpt.txt'));

  it('parses the fixed-width order file with billable flags', () => {
    const rows = parseOrderFile(data);
    expect(rows.length).toBeGreaterThan(80);
    const cholera = rows[0]!;
    expect(cholera.code).toBe('A00');
    expect(cholera.billable).toBe(false); // category header
    const specific = rows[1]!;
    expect(specific.code).toBe('A00.0');
    expect(specific.billable).toBe(true);
    expect(specific.longDesc).toContain('Vibrio cholerae 01, biovar cholerae');
  });

  it('parses the M54 low back pain block with dotted codes', () => {
    const rows = parseOrderFile(data);
    const m545 = rows.find((r) => r.code === 'M54.5');
    expect(m545).toBeDefined();
    expect(m545!.billable).toBe(false); // M54.5 is a header; M54.50/51/59 are billable
    const m5450 = rows.find((r) => r.code === 'M54.50');
    expect(m5450).toBeDefined();
    expect(m5450!.billable).toBe(true);
  });

  it('dotted() formats codes per presentation form', () => {
    expect(dotted('M5450')).toBe('M54.50');
    expect(dotted('A00')).toBe('A00');
  });

  it('picks the April package over the base package for the same FY', () => {
    const html =
      '<a href="/files/zip/2026-code-descriptions-tabular-order.zip">base</a>' +
      '<a href="/files/zip/april-1-2026-code-descriptions-tabular-order.zip">april</a>' +
      '<a href="/files/zip/2027-code-descriptions-tabular-order.zip">next</a>';
    const releases = findOrderZipLinks(html, 'https://www.cms.gov/x');
    expect(releases).toHaveLength(2);
    expect(releases[0]!.fy).toBe(2027);
    expect(releases[1]!.fy).toBe(2026);
    expect(releases[1]!.midYear).toBe(true);
  });

  it('finds the newest guidelines PDF', () => {
    const html = '<a href="/files/document/fy-2026-icd-10-cm-coding-guidelines.pdf">g</a>';
    expect(findGuidelinesPdf(html, 'https://www.cms.gov/x')).toEqual({
      url: 'https://www.cms.gov/files/document/fy-2026-icd-10-cm-coding-guidelines.pdf',
      fy: 2026,
    });
  });
});

describe('cms_telehealth_list parser', () => {
  it('parses codes and actions from the real (descriptor-redacted) excerpt', () => {
    const text = readFileSync(
      join(FIX, 'cms_telehealth_list', 'cy2026_list_508.excerpt.redacted.txt'),
      'utf8',
    );
    const rows = text.split('\n').map((l) => l.split('\t'));
    const parsed = parseTelehealthRows(rows);
    expect(parsed.length).toBeGreaterThan(40);
    expect(parsed[0]!.code).toBe('0362T');
    expect(parsed[0]!.action).toBe('Maintain');
    for (const r of parsed) {
      expect(r.code).toMatch(/^[A-Z0-9]{5}$/);
      expect(['Maintain', 'Addition']).toContain(r.action);
    }
  });

  it('reads the year from the final URL after redirects', () => {
    expect(
      yearFromUrl('https://www.cms.gov/files/zip/list-telehealth-services-calendar-year-2026.zip'),
    ).toBe(2026);
    expect(yearFromUrl('https://www.cms.gov/files/zip/other.zip')).toBeNull();
  });

  it('finds the zip link', () => {
    const html = '<a href="/files/zip/list-telehealth-services-calendar-year-2026.zip">list</a>';
    expect(findTelehealthZip(html, 'https://www.cms.gov/x')).toBe(
      'https://www.cms.gov/files/zip/list-telehealth-services-calendar-year-2026.zip',
    );
  });
});

describe('cms_iom revision parser', () => {
  it('parses the chapter revision from real title lines', () => {
    const lines = readFileSync(join(FIX, 'cms_iom', 'title_lines.bp102c15.txt'), 'utf8').split(
      '\n',
    );
    const rev = parseChapterRevision(lines);
    expect(rev).toEqual({ rev: '13774', issued: '2026-05-08' });
  });

  it('tolerates colon separators and 4-digit years', () => {
    expect(parseChapterRevision(['(Rev. 11901: Issued: 03-16-2023)'])).toEqual({
      rev: '11901',
      issued: '2023-03-16',
    });
  });
});
