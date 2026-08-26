// Shared file-format helpers for couriers: zip entries, xlsx sheets, csv rows.
import AdmZip from 'adm-zip';
import { parse as parseCsvSync } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export function zipEntries(zipData: Buffer, filter?: RegExp): ZipEntry[] {
  const zip = new AdmZip(zipData);
  const out: ZipEntry[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (filter && !filter.test(entry.entryName)) continue;
    out.push({ name: entry.entryName, data: entry.getData() });
  }
  return out;
}

/** Rows of the named (or first) sheet as arrays of cell values, empty cells as ''. */
export function xlsxRows(data: Buffer, sheetName?: string): unknown[][] {
  const wb = XLSX.read(data, { type: 'buffer', cellDates: true });
  const name = sheetName ?? wb.SheetNames[0];
  if (!name) return [];
  const sheet = wb.Sheets[name];
  if (!sheet) throw new Error(`Sheet not found: ${name}. Sheets: ${wb.SheetNames.join(', ')}`);
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: true });
}

export function xlsxSheetNames(data: Buffer): string[] {
  return XLSX.read(data, { type: 'buffer', bookSheets: true }).SheetNames;
}

export function csvRows(
  data: Buffer | string,
  opts: { delimiter?: string; fromLine?: number } = {},
): string[][] {
  return parseCsvSync(data, {
    delimiter: opts.delimiter ?? ',',
    from_line: opts.fromLine ?? 1,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  }) as string[][];
}

/** Excel serial date or date-like cell to YYYY-MM-DD, or null. */
export function cellToIsoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    // Excel serial date (days since 1899-12-30).
    const ms = Math.round((value - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
