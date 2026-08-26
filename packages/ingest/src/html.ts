// Minimal HTML handling for narrative pages: split on h1/h2/h3 headings into
// sections and strip tags to text. Server-rendered CMS and OIG pages only; no
// script execution, no DOM library.
import type { Section } from './chunker.js';

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&#8211;': '-',
  '&#8212;': '-',
  '&#8217;': "'",
  '&#8220;': '"',
  '&#8221;': '"',
};

export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  for (const [entity, ch] of Object.entries(ENTITIES)) {
    s = s.replaceAll(entity, ch);
  }
  s = s.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\s*\n\s*/g, '\n');
  return s.trim();
}

/**
 * Splits an HTML document into sections at h1/h2/h3 headings. Content before the
 * first heading becomes "front matter". Optionally scope to the first element whose
 * class matches contentClass (e.g. the Drupal body field) to skip nav chrome.
 */
export function htmlSections(html: string, contentClass?: string): Section[] {
  let scope = html;
  if (contentClass) {
    const idx = html.search(new RegExp(`class="[^"]*${contentClass}[^"]*"`));
    if (idx >= 0) scope = html.slice(idx);
  }
  const parts = scope.split(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi);
  const sections: Section[] = [];
  // parts: [before, level, heading, body, level, heading, body, ...]
  const front = htmlToText(parts[0] ?? '');
  if (front.length > 0) sections.push({ path: 'front matter', text: front });
  for (let i = 1; i + 2 < parts.length + 1; i += 3) {
    const heading = htmlToText(parts[i + 1] ?? '').slice(0, 120);
    const body = htmlToText(parts[i + 2] ?? '');
    if (heading.length === 0 && body.length === 0) continue;
    sections.push({ path: heading || 'untitled', text: body });
  }
  return sections;
}
