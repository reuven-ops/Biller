// Fetch layer: every outbound request is checked against config/egress.yaml
// (brief non-negotiable 8), retried with backoff, and stored as a raw artifact
// with its SHA-256 (brief section 8.1).
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { optionalEnv } from '@advisor/db';
import { hostAllowed, loadEgress, type EgressConfig } from '@advisor/core/config';

const USER_AGENT = 'cm-coding-advisor/0.1 (ClinicMind internal tool; contact rcm operations)';

export interface FetchedArtifact {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  sha256: string;
  storagePath: string;
  body: Buffer;
}

export interface FetcherOptions {
  artifactsDir?: string;
  egress?: EgressConfig;
  maxRetries?: number;
  timeoutMs?: number;
}

export class EgressDeniedError extends Error {
  constructor(host: string) {
    super(`Egress denied: ${host} is not in config/egress.yaml`);
  }
}

export class Fetcher {
  private egress: EgressConfig | undefined;
  private readonly artifactsDir: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(opts: FetcherOptions = {}) {
    this.artifactsDir = opts.artifactsDir ?? optionalEnv('ARTIFACTS_DIR', './artifacts');
    if (opts.egress) this.egress = opts.egress;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  private async egressConfig(): Promise<EgressConfig> {
    if (!this.egress) this.egress = await loadEgress();
    return this.egress;
  }

  async assertAllowed(url: string): Promise<void> {
    const host = new URL(url).hostname;
    if (!hostAllowed(host, await this.egressConfig())) {
      throw new EgressDeniedError(host);
    }
  }

  /**
   * GET with retries. Every redirect hop is egress-checked. The raw body is written
   * to <artifactsDir>/<source_id>/<sha256 prefix>/<sha256><ext>.
   */
  async fetchArtifact(
    url: string,
    sourceId: string,
    opts: { accept?: string } = {},
  ): Promise<FetchedArtifact> {
    await this.assertAllowed(url);
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
      try {
        const res = await this.fetchFollowingRedirects(url, opts.accept);
        if (res.status >= 500) {
          lastError = new Error(`HTTP ${res.status} from ${url}`);
          continue;
        }
        if (res.status >= 400) {
          throw new Error(`HTTP ${res.status} from ${url}`);
        }
        const body = Buffer.from(await res.response.arrayBuffer());
        const sha256 = createHash('sha256').update(body).digest('hex');
        const ext = extensionFor(res.response.headers.get('content-type') ?? '', res.finalUrl);
        const dir = join(this.artifactsDir, sourceId, sha256.slice(0, 2));
        await mkdir(dir, { recursive: true });
        const storagePath = join(dir, `${sha256}${ext}`);
        await writeFile(storagePath, body);
        return {
          url,
          finalUrl: res.finalUrl,
          status: res.status,
          contentType: res.response.headers.get('content-type') ?? '',
          bytes: body.byteLength,
          sha256,
          storagePath,
          body,
        };
      } catch (err) {
        if (err instanceof EgressDeniedError) throw err;
        lastError = err as Error;
      }
    }
    throw new Error(`Fetch failed after ${this.maxRetries + 1} attempts: ${url}`, {
      cause: lastError,
    });
  }

  private async fetchFollowingRedirects(
    url: string,
    accept?: string,
  ): Promise<{ response: Response; status: number; finalUrl: string }> {
    let current = url;
    for (let hop = 0; hop < 8; hop++) {
      await this.assertAllowed(current);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': USER_AGENT,
            ...(accept ? { accept } : {}),
          },
        });
      } finally {
        clearTimeout(timer);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return { response, status: response.status, finalUrl: current };
        current = new URL(location, current).toString();
        continue;
      }
      return { response, status: response.status, finalUrl: current };
    }
    throw new Error(`Too many redirects: ${url}`);
  }
}

function extensionFor(contentType: string, url: string): string {
  const fromUrl = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(new URL(url).pathname);
  if (fromUrl?.[1]) return `.${fromUrl[1].toLowerCase()}`;
  const ct = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const map: Record<string, string> = {
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'application/json': '.json',
    'text/html': '.html',
    'text/csv': '.csv',
    'text/plain': '.txt',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  };
  return map[ct] ?? '.bin';
}
