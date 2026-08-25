// Minimal HTTP plumbing over node:http: routing with path params, cookie and
// urlencoded form parsing, and response helpers. No framework dependency; the
// whole surface is a handful of pages (brief section 13).
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  cookies: Record<string, string>;
  form: Record<string, string>;
  files: UploadedFile[];
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

const MAX_FORM_BYTES = 64 * 1024;
const MAX_MULTIPART_BYTES = 25 * 1024 * 1024;

export interface UploadedFile {
  field: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.startsWith('application/x-www-form-urlencoded')) return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_FORM_BYTES) throw new Error('form body too large');
    chunks.push(buf);
  }
  const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

/**
 * Minimal multipart/form-data parser for the upload forms (contracts, remit CSVs,
 * note attachments). Whole-body in memory with a 25 MB cap; fields land in
 * ctx.form and files in ctx.files.
 */
export async function readMultipart(
  req: IncomingMessage,
): Promise<{ form: Record<string, string>; files: UploadedFile[] }> {
  const type = String(req.headers['content-type'] ?? '');
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return { form: {}, files: [] };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_MULTIPART_BYTES) throw new Error('upload too large (25 MB cap)');
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks);
  const delim = Buffer.from(`--${boundary}`);
  const form: Record<string, string> = {};
  const files: UploadedFile[] = [];
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    const next = body.indexOf(delim, pos + delim.length);
    if (next < 0) break;
    // Part = headers + CRLFCRLF + content + CRLF before the next delimiter.
    const part = body.subarray(pos + delim.length + 2, next - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const content = part.subarray(headerEnd + 4);
      const nameMatch = /name="([^"]*)"/.exec(headers);
      const fileMatch = /filename="([^"]*)"/.exec(headers);
      const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
      const field = nameMatch?.[1] ?? '';
      if (fileMatch !== null) {
        if (fileMatch[1]) {
          files.push({
            field,
            filename: fileMatch[1],
            contentType: (typeMatch?.[1] ?? 'application/octet-stream').trim(),
            data: Buffer.from(content),
          });
        }
      } else if (field) {
        form[field] = content.toString('utf8');
      }
    }
    pos = next;
  }
  return { form, files };
}

export class Router {
  private readonly routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  }

  get(pattern: string, handler: Handler): void {
    this.on('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.on('POST', pattern, handler);
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i += 1) {
        const want = route.parts[i] ?? '';
        const got = parts[i] ?? '';
        if (want.startsWith(':')) params[want.slice(1)] = decodeURIComponent(got);
        else if (want !== got) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

export function sendHtml(ctx: Ctx, status: number, body: string): void {
  ctx.res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; script-src 'unsafe-inline'",
  });
  ctx.res.end(body);
}

export function redirect(ctx: Ctx, location: string, extraHeaders?: Record<string, string>): void {
  ctx.res.writeHead(303, { location, ...(extraHeaders ?? {}) });
  ctx.res.end();
}

export function setCookie(
  name: string,
  value: string,
  opts: { maxAgeSeconds?: number; expire?: boolean } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (process.env.APP_BASE_URL?.startsWith('https://')) parts.push('Secure');
  if (opts.expire) parts.push('Max-Age=0');
  else if (opts.maxAgeSeconds) parts.push(`Max-Age=${Math.floor(opts.maxAgeSeconds)}`);
  return parts.join('; ');
}
