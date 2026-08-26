import { describe, expect, it } from 'vitest';
import { chunkSections, estimateTokens, extractCodes } from '../src/chunker.js';

describe('extractCodes', () => {
  it('finds CPT, HCPCS, and ICD-10-CM patterns', () => {
    const text =
      'Bill 97110 with 98940 when appropriate. G0283 is the always-therapy code. ' +
      'Diagnosis M54.5 or M99.01 supports subluxation. Category III code 0552T exists.';
    const codes = extractCodes(text);
    expect(codes).toContain('97110');
    expect(codes).toContain('98940');
    expect(codes).toContain('G0283');
    expect(codes).toContain('M54.5');
    expect(codes).toContain('M99.01');
    expect(codes).toContain('0552T');
  });

  it('does not treat years as codes', () => {
    const codes = extractCodes('Effective January 1, 20250 is not a year but 2025 is common.');
    expect(codes).not.toContain('2025');
  });
});

describe('chunkSections', () => {
  it('preserves section paths and prefixes title', () => {
    const chunks = chunkSections('Medicare Benefit Policy Manual, Chapter 15', [
      { path: '240 Chiropractic Services', text: 'word '.repeat(700) },
      { path: '240.1 Coverage', text: 'coverage '.repeat(700) },
    ]);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.sectionPath).toBe('240 Chiropractic Services');
    expect(chunks[0]?.text).toContain('Medicare Benefit Policy Manual, Chapter 15 > 240');
    const ordinals = chunks.map((c) => c.ordinal);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
  });

  it('merges small adjacent sections toward the floor', () => {
    const sections = Array.from({ length: 10 }, (_, i) => ({
      path: `s${i}`,
      text: 'small section text here. '.repeat(10),
    }));
    const chunks = chunkSections('Doc', sections);
    expect(chunks.length).toBeLessThan(10);
  });

  it('labels a merged chunk with the section span, trimming the shared prefix', () => {
    const small = (path: string) => ({ path, text: 'short body. '.repeat(8) });
    const chunks = chunkSections('Doc', [
      small('Ch.XI > Q. Medical Nutrition Therapy'),
      small('Ch.XI > R. Osteopathic Manipulative Treatment'),
      small('Ch.XI > S. Chiropractic Manipulative Treatment'),
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.sectionPath).toBe(
      'Ch.XI > Q. Medical Nutrition Therapy to S. Chiropractic Manipulative Treatment',
    );
    expect(chunks[0]!.text).toContain('S. Chiropractic Manipulative Treatment');
  });

  it('splits oversized sections with overlap', () => {
    const big = 'alpha beta gamma delta epsilon '.repeat(400); // ~2000 words
    const chunks = chunkSections('Doc', [{ path: 'big', text: big }]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(1100);
    }
    // Overlap: the tail words of chunk 0 reappear at the head of chunk 1.
    const tail = chunks[0]!.text.split(/\s+/).slice(-20).join(' ');
    expect(chunks[1]!.text).toContain(tail.split(' ').slice(0, 5).join(' '));
  });

  it('estimateTokens is deterministic and monotone', () => {
    expect(estimateTokens('one two three')).toBe(estimateTokens('one two three'));
    expect(estimateTokens('word '.repeat(100))).toBeGreaterThan(estimateTokens('word '.repeat(10)));
  });
});
