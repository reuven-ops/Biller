import { extractPdfLines } from '@advisor/ingest';
import { readFileSync, writeFileSync } from 'node:fs';
const [pdf, out, from, to] = process.argv.slice(2);
const ex = await extractPdfLines(new Uint8Array(readFileSync(pdf!)));
writeFileSync(out!, ex.lines.slice(Number(from ?? 0), Number(to ?? 120)).join('\n'));
console.log('pages', ex.pages, 'lines', ex.lines.length, '->', out);
