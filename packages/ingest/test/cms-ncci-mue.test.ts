import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  effectiveDateFromName,
  findMueTableUrl,
  parseMueCsv,
} from '../src/couriers/cms-ncci-mue.js';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', 'evals', 'fixtures', 'cms_ncci_mue');

describe('cms_ncci_mue parser', () => {
  const name = 'MCR_MUE_PractitionerServices_Eff_07-01-2026.excerpt.csv';
  const data = readFileSync(join(FIXTURES, name));

  it('extracts the effective date from the file name', () => {
    expect(effectiveDateFromName(name)).toBe('2026-07-01');
    expect(effectiveDateFromName('practitionerservicesmuetable-effective-07-01-2026.zip')).toBe(
      '2026-07-01',
    );
    expect(effectiveDateFromName('no-date-here.csv')).toBeNull();
  });

  it('parses the real excerpt: skips the AMA notice and header, reads data rows', () => {
    const parsed = parseMueCsv(data, name);
    expect(parsed.effectiveDate).toBe('2026-07-01');
    expect(parsed.rows.length).toBe(44);
    const first = parsed.rows[0]!;
    expect(first.code).toBe('0001U');
    expect(first.mueValue).toBe(1);
    expect(first.adjudicationIndicator).toBe('2 Date of Service Edit: Policy');
    expect(first.rationale).toBe('Code Descriptor / CPT Instruction');
  });

  it('every parsed code is a 5-character HCPCS or CPT code and no descriptors leak', () => {
    const parsed = parseMueCsv(data, name);
    for (const row of parsed.rows) {
      expect(row.code).toMatch(/^[A-Z0-9]{5}$/);
      expect(row.mueValue).toBeGreaterThanOrEqual(0);
    }
  });

  it('finds the current table link on the landing page markup', () => {
    const html =
      '<a href="/files/zip/medicare-ncci-2026-q3-practitioner-services-mue-table.zip">MUE table</a>';
    expect(findMueTableUrl(html, 'https://www.cms.gov/medicare/x')).toBe(
      'https://www.cms.gov/files/zip/medicare-ncci-2026-q3-practitioner-services-mue-table.zip',
    );
  });
});
