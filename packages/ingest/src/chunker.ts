// Chunker for narrative documents (brief section 8.4): split on section headings,
// target 500 to 1,000 tokens with 80-token overlap, preserve section_path, prepend
// title and section path to the embedded text, and extract code-like tokens.

export interface Section {
  path: string; // e.g. "100-02 > Ch.15 > 240.1.2"
  text: string;
}

export interface Chunk {
  sectionPath: string;
  ordinal: number;
  text: string;
  tokenCount: number;
  codesMentioned: string[];
}

const TARGET_MIN = 500;
const TARGET_MAX = 1000;
const OVERLAP = 80;

/** Rough token estimate: whitespace-delimited words times 4/3. Deterministic. */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  return Math.ceil((words * 4) / 3);
}

const CPT_RE = /\b\d{4}[0-9A-Z]\b/g; // 5 digits, or 4 digits + letter (Cat II/III F/T/U codes)
const HCPCS_RE = /\b[A-V]\d{4}\b/g; // letter + 4 digits
const ICD10_RE = /\b[A-TV-Z]\d[0-9A-Z](?:\.[0-9A-Z]{1,4})?\b/g;

/**
 * Extracts code-like tokens (5-digit CPT, HCPCS letter plus four digits, ICD-10-CM
 * patterns). Pattern-based; downstream tools validate against the loaded code sets.
 */
export function extractCodes(text: string): string[] {
  const found = new Set<string>();
  for (const re of [CPT_RE, HCPCS_RE, ICD10_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const token = m[0];
      // Skip obvious years and pure-numeric false positives out of code ranges.
      if (/^\d{5}$/.test(token) || /^\d{4}[A-Z]$/.test(token) || !/^\d/.test(token)) {
        if (/^(19|20)\d{3}$/.test(token)) continue;
        found.add(token);
      }
    }
  }
  return [...found].sort();
}

function splitLongText(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const wordsPerChunk = Math.floor((TARGET_MAX * 3) / 4);
  const overlapWords = Math.floor((OVERLAP * 3) / 4);
  if (words.length <= wordsPerChunk) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + wordsPerChunk, words.length);
    parts.push(words.slice(start, end).join(' '));
    if (end === words.length) break;
    start = end - overlapWords;
  }
  return parts;
}

/**
 * Turns titled sections into chunks. Small adjacent sections under the same parent are
 * merged toward the 500 token floor; oversized sections are split with overlap. The
 * embedded text is prefixed with the document title and section path.
 */
export function chunkSections(documentTitle: string, sections: Section[]): Chunk[] {
  const chunks: Chunk[] = [];
  let ordinal = 0;

  let bufferPath: string | null = null;
  let bufferText = '';

  const flush = (): void => {
    if (bufferPath === null || bufferText.trim().length === 0) {
      bufferPath = null;
      bufferText = '';
      return;
    }
    for (const part of splitLongText(bufferText.trim())) {
      const text = `${documentTitle} > ${bufferPath}\n\n${part}`;
      chunks.push({
        sectionPath: bufferPath,
        ordinal: ordinal++,
        text,
        tokenCount: estimateTokens(text),
        codesMentioned: extractCodes(part),
      });
    }
    bufferPath = null;
    bufferText = '';
  };

  for (const section of sections) {
    const sectionTokens = estimateTokens(section.text);
    if (bufferPath !== null) {
      const bufferedTokens = estimateTokens(bufferText);
      if (bufferedTokens >= TARGET_MIN || bufferedTokens + sectionTokens > TARGET_MAX) {
        flush();
      }
    }
    if (bufferPath === null) {
      bufferPath = section.path;
      bufferText = section.text;
    } else {
      // Keep the first section's path when merging small neighbors.
      bufferText += `\n\n${section.path}\n${section.text}`;
    }
  }
  flush();
  return chunks;
}
