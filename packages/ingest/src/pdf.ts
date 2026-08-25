// PDF extraction on pdfjs with heading heuristics and a quality flag
// (brief section 8.6). Poor quality (scanned or garbled) flags the document
// and skips it; no OCR in v1.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Section } from './chunker.js';

export interface PdfExtraction {
  pages: number;
  lines: string[];
  quality: 'ok' | 'poor';
  qualityNote: string;
}

interface TextItemLike {
  str?: string;
  transform?: number[];
  height?: number;
}

export async function extractPdfLines(data: Uint8Array): Promise<PdfExtraction> {
  const loadingTask = getDocument({ data, useSystemFonts: true });
  const doc = await loadingTask.promise;
  const lines: string[] = [];
  let charCount = 0;
  let badCharCount = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Group items into lines by their y position, then order by x.
    const byLine = new Map<number, { x: number; str: string }[]>();
    for (const item of content.items as TextItemLike[]) {
      if (!item.str || !item.transform) continue;
      const x = item.transform[4] ?? 0;
      const y = Math.round((item.transform[5] ?? 0) * 2) / 2;
      const bucket = byLine.get(y) ?? [];
      bucket.push({ x, str: item.str });
      byLine.set(y, bucket);
    }
    const ys = [...byLine.keys()].sort((a, b) => b - a);
    for (const y of ys) {
      const parts = (byLine.get(y) ?? []).sort((a, b) => a.x - b.x).map((p2) => p2.str);
      const line = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (line.length === 0) continue;
      charCount += line.length;
      badCharCount += (line.match(/\uFFFD/g) ?? []).length;
      lines.push(line);
    }
  }
  const pages = doc.numPages;
  await loadingTask.destroy();
  const avgCharsPerPage = pages > 0 ? charCount / pages : 0;
  if (avgCharsPerPage < 200) {
    return {
      pages,
      lines,
      quality: 'poor',
      qualityNote: `average ${Math.round(avgCharsPerPage)} characters per page; likely scanned`,
    };
  }
  if (charCount > 0 && badCharCount / charCount > 0.02) {
    return {
      pages,
      lines,
      quality: 'poor',
      qualityNote: 'more than 2 percent unmappable characters; garbled extraction',
    };
  }
  return { pages, lines, quality: 'ok', qualityNote: '' };
}

/**
 * Splits extracted lines into sections on numbered-heading patterns like
 * "240.1.2 - Necessity for Treatment" used across CMS manuals. Text before the first
 * heading lands in a "front matter" section.
 */
export function sectionsFromLines(lines: string[], headingRe?: RegExp): Section[] {
  const re = headingRe ?? /^(\d{1,4}(?:\.\d{1,3}){0,4})\s*[-–—]\s+(.{3,120})$/;
  const sections: Section[] = [];
  let currentPath = 'front matter';
  let buffer: string[] = [];
  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text.length > 0) sections.push({ path: currentPath, text });
    buffer = [];
  };
  for (const line of lines) {
    const m = re.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      flush();
      currentPath = `${m[1]} ${m[2].trim()}`;
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}
