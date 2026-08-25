import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPtpFileLinks, parsePtpTxt } from '../src/couriers/cms-ncci-ptp.js';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'evals', 'fixtures', 'cms_ncci_ptp');

describe('cms_ncci_ptp parser', () => {
  const txt = readFileSync(join(FIXTURES, 'ccipra-v322r0-f1.excerpt.txt'));

  it('parses real data rows and skips the notice and wrapped header', () => {
    const rows = parsePtpTxt(txt);
    expect(rows.length).toBeGreaterThan(100);
    const first = rows[0]!;
    expect(first.column1).toBe('0001A');
    expect(first.column2).toBe('0591T');
    expect(first.effectiveDate).toBe('2022-01-01');
    expect(first.deletionDate).toBe('2023-12-31');
    expect(first.modifierIndicator).toBe('1');
    expect(first.rationale).toContain('coding instruction');
  });

  it('treats * as no deletion date', () => {
    const rows = parsePtpTxt(txt);
    const active = rows.find((r) => r.column2 === '81161');
    expect(active).toBeDefined();
    expect(active!.deletionDate).toBeNull();
    expect(active!.effectiveDate).toBe('2018-01-01');
  });

  it('every row has valid codes, dates, and indicator', () => {
    for (const r of parsePtpTxt(txt)) {
      expect(r.column1).toMatch(/^[A-Z0-9]{5}$/);
      expect(r.column2).toMatch(/^[A-Z0-9]{5}$/);
      expect(r.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['0', '1', '9']).toContain(r.modifierIndicator);
    }
  });

  it('finds the four current-version file links on the real page excerpt', () => {
    const html = readFileSync(join(FIXTURES, 'ptp_page.links.excerpt.html'), 'utf8');
    const links = findPtpFileLinks(html, 'https://www.cms.gov/medicare/x');
    expect(links).toHaveLength(4);
    expect(links.map((l) => l.part)).toEqual([1, 2, 3, 4]);
    expect(links[0]!.version).toBe('v322r0');
    expect(links[0]!.url).toBe(
      'https://www.cms.gov/files/zip/medicare-ncci-2026q3-practitioner-ptp-edits-ccipra-v322r0-f1.zip',
    );
  });
});
