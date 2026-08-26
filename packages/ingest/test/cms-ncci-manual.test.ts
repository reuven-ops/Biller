import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkSections } from '../src/chunker.js';
import { extractPdfLines } from '../src/pdf.js';
import { findManualPdfLink, ncciManualSections } from '../src/couriers/cms-ncci-manual.js';

const FIX = join(import.meta.dirname, '..', '..', '..', 'evals', 'fixtures', 'cms_ncci_manual');

describe('cms_ncci_manual', () => {
  it('finds the newest all-chapters PDF link', () => {
    const html =
      '<a href="/files/document/2025-ncci-medicare-policy-manual-all-chapters.pdf">2025</a>' +
      '<a href="/files/document/2026-ncci-medicare-policy-manual-all-chapters.pdf">2026</a>';
    const link = findManualPdfLink(html, 'https://www.cms.gov/x');
    expect(link).toEqual({
      url: 'https://www.cms.gov/files/document/2026-ncci-medicare-policy-manual-all-chapters.pdf',
      year: 2026,
    });
  });

  it('extracts, sections, and chunks a real manual chapter PDF', async () => {
    const pdf = readFileSync(
      join(FIX, '12-chapter12-ncci-medicare-policy-manual-2025_final_clean.pdf'),
    );
    const extraction = await extractPdfLines(new Uint8Array(pdf));
    expect(extraction.quality).toBe('ok');
    expect(extraction.lines.length).toBeGreaterThan(200);

    const sections = ncciManualSections(extraction.lines);
    expect(sections.length).toBeGreaterThan(3);
    const paths = sections.map((s) => s.path);
    expect(paths.some((p) => p.startsWith('Ch.XII'))).toBe(true);
    expect(paths.some((p) => /A\. Introduction/.test(p))).toBe(true);
    // Table-of-contents dot-leader lines must not become headings.
    expect(paths.every((p) => !p.includes('....'))).toBe(true);

    const chunks = chunkSections('NCCI Policy Manual 2025', sections);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(1100);
      expect(c.text.startsWith('NCCI Policy Manual 2025 > ')).toBe(true);
    }
  }, 60_000);
});
