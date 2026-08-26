import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRemitCsv, REQUIRED_COLUMNS } from '../src/remit-importer.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'evals',
  'fixtures',
  'remit',
  'synthetic_remit.csv',
);

const HEADER = REQUIRED_COLUMNS.join(',');
const GOOD_ROW =
  'C1,1,PayerX,111,Plan,Commercial,FL,CL1,DC,2025-01-02,97140,59,M99.01,1,85.00,42.00,42.00,,,0,0,na,2025-02-01';

describe('parseRemitCsv', () => {
  it('aggregates the synthetic fixture into cells with correct counts', () => {
    const result = parseRemitCsv(readFileSync(FIXTURE));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowsIn).toBe(24);
    expect(result.rowsRejected).toBe(0);

    const uhc97140 = result.cells.find(
      (c) => c.payerId === '87726' && c.cpt === '97140' && c.year === 2025,
    );
    expect(uhc97140).toBeDefined();
    expect(uhc97140?.modifiers).toEqual(['59']);
    expect(uhc97140?.claimsN).toBe(10);
    expect(uhc97140?.deniedN).toBe(6);
    expect(uhc97140?.paidN).toBe(4);
    expect(uhc97140?.topCarc[0]).toEqual({ code: '97', n: 5 });
    expect(uhc97140?.appealedN).toBe(4);
    expect(uhc97140?.overturnedN).toBe(2);
    // avg over the four paid lines: 42.10, 41.80, 42.10, 42.10
    expect(uhc97140?.avgAllowed).toBeCloseTo((42.1 + 41.8 + 42.1 + 42.1) / 4, 4);

    // The 2026 Aetna 90837 lines form their own year cell.
    const aetna2026 = result.cells.find(
      (c) => c.payerId === '60054' && c.cpt === '90837' && c.year === 2026,
    );
    expect(aetna2026?.claimsN).toBe(2);
  });

  it('rejects a file with a forbidden identifier column, whole file', () => {
    const csv = `${HEADER},member_id\n${GOOD_ROW},ABC123`;
    const result = parseRemitCsv(csv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('member_id');
  });

  it('rejects a file whose content matches an SSN pattern', () => {
    const csv = `${HEADER}\n${GOOD_ROW.replace('CL1', '123-45-6789')}`;
    const result = parseRemitCsv(csv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('SSN');
  });

  it('rejects a file missing required columns', () => {
    const csv = 'claim_ref,cpt\nC1,97140';
    const result = parseRemitCsv(csv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Missing required columns');
  });

  it('tallies row-level rejects without failing the file', () => {
    const badLob = GOOD_ROW.replace('Commercial', 'HMO');
    const csv = `${HEADER}\n${GOOD_ROW}\n${badLob}`;
    const result = parseRemitCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowsIn).toBe(2);
    expect(result.rowsRejected).toBe(1);
    expect(result.rejects[0]).toContain('lob');
    expect(result.cells).toHaveLength(1);
  });
});

describe('remitGuideSections', () => {
  it('sections the MLN booklet on its capitalized headings', async () => {
    const { remitGuideSections } = await import('../src/couriers/cms-remit-guides.js');
    const lines = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'evals',
        'fixtures',
        'cms_remit_guides',
        'icn905367.lines.txt',
      ),
      'utf8',
    ).split('\n');
    const sections = remitGuideSections(lines);
    const paths = sections.map((s) => s.path);
    expect(paths).toContain('GENERAL INFORMATION');
    const general = sections.find((s) => s.path === 'GENERAL INFORMATION');
    expect(general?.text).toContain('Electronic');
    expect(general?.text).toContain('Remittance Advice');
  });
});
