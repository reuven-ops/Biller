// Tiny markdown renderer for our own docs (HELP.md): headings, numbered and
// bulleted lists, paragraphs, links, bold, and code spans. Content is our own
// repository text, but everything is still escaped before markup is applied.
import { escapeHtml, raw, type Safe } from './html.js';

function inline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>',
  );
  return out;
}

export function renderMarkdown(markdown: string): Safe {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let list: 'ol' | 'ul' | null = null;
  let paragraph: string[] = [];

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1]?.length ?? 1;
      out.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
    } else if (ordered) {
      flushParagraph();
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(ordered[1] ?? '')}</li>`);
    } else if (bullet) {
      flushParagraph();
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(bullet[1] ?? '')}</li>`);
    } else if (line.trim() === '') {
      flushParagraph();
      closeList();
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  closeList();
  return raw(out.join('\n'));
}
