import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { csvRows } from '../src/formats.js';
import { findHcpcsQuarterLinks, parseHcpcsRows } from '../src/couriers/cms-hcpcs.js';
import {
  findRvuReleaseLinks,
  findZipLink,
  parseGpciCsv,
  parsePprrvuCsv,
} from '../src/couriers/cms-mpfs.js';

const FIX = join(import.meta.dirname, '..', '..', '..', 'evals', 'fixtures');

describe('cms_hcpcs parser', () => {
  const rows = csvRows(readFileSync(join(FIX, 'cms_hcpcs', 'HCPC2026_OCT_ANWEB.excerpt.csv')));

  it('parses codes with dates and descriptions from the real excerpt', () => {
    const parsed = parseHcpcsRows(rows);
    expect(parsed.length).toBe(35);
    const a1 = parsed.find((r) => r.code === 'A1');
    expect(a1).toBeDefined();
    expect(a1!.longDesc).toBe('Dressing for one wound');
    expect(a1!.addDate).toBe('2002-07-01');
    expect(a1!.terminationDate).toBeNull();
  });

  it('parses termination dates on retired codes', () => {
    const parsed = parseHcpcsRows(rows);
    const termed = parsed.filter((r) => r.terminationDate !== null);
    expect(termed.length).toBe(5);
    for (const t of termed) {
      expect(t.terminationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('finds quarterly zip links including the plural files.zip variant', () => {
    const html =
      '<a href="/files/zip/october-2026-alpha-numeric-hcpcs-file.zip">Oct</a>' +
      '<a href="/files/zip/april-2024-alpha-numeric-hcpcs-files.zip">Apr 24</a>';
    const links = findHcpcsQuarterLinks(html, 'https://www.cms.gov/x');
    expect(links.map((l) => l.version)).toEqual(['2026-10', '2024-04']);
  });
});

describe('cms_mpfs parser', () => {
  const pprrvu = readFileSync(join(FIX, 'cms_mpfs', 'PPRRVU2026_Jul_nonQPP.excerpt.redacted.csv'));

  it('parses RVU rows without ever emitting the descriptor column', () => {
    const rows = parsePprrvuCsv(pprrvu);
    expect(rows.length).toBeGreaterThan(50);
    const first = rows[0]!;
    expect(first.code).toBe('0001F');
    expect(first.statusIndicator).toBe('I');
    expect(first.convFactor).toBe('33.4009');
    const json = JSON.stringify(rows);
    expect(json).not.toContain('REDACTED'); // descriptor column is dropped entirely
  });

  it('parses GPCI rows from the complete real file', () => {
    const rows = parseGpciCsv(readFileSync(join(FIX, 'cms_mpfs', 'GPCI2026.csv')));
    expect(rows.length).toBeGreaterThan(100);
    const alabama = rows.find((r) => r.state === 'AL');
    expect(alabama).toBeDefined();
    expect(alabama!.mac).toBe('10112');
    expect(alabama!.work).toBe('1.000');
    expect(alabama!.pe).toBe('0.875');
    expect(alabama!.mp).toBe('0.566');
  });

  it('finds and orders RVU release links', () => {
    const html =
      '<a href="/medicare/payment/fee-schedules/physician/pfs-relative-value-files/rvu26c">C</a>' +
      '<a href="/medicare/payment/fee-schedules/physician/pfs-relative-value-files/rvu26a">A</a>' +
      '<a href="/medicare/payment/fee-schedules/physician/pfs-relative-value-files/rvu25d">D</a>';
    const links = findRvuReleaseLinks(html, 'https://www.cms.gov/x');
    expect(links.map((l) => l.slug)).toEqual(['rvu26c', 'rvu26a', 'rvu25d']);
    expect(links[0]!.year).toBe(2026);
    expect(links[0]!.quarter).toBe(3);
  });

  it('finds the zip link on a detail page', () => {
    const html = '<a href="/files/zip/rvu26c-updated-06-30-2026.zip">download</a>';
    expect(findZipLink(html, 'https://www.cms.gov/x')).toBe(
      'https://www.cms.gov/files/zip/rvu26c-updated-06-30-2026.zip',
    );
  });
});
