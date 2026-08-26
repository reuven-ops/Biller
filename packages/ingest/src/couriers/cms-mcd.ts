// Courier for cms_mcd: the Medicare Coverage Database through the keyless Coverage
// API (api.coverage.cms.gov). The bulk zip downloads require an interactive license
// modal, so the API is the automatable path the site provides: its licensed endpoints
// hand out a one-hour bearer token from the license-agreement endpoint, and using the
// token is the documented acceptance mechanism (docs/DECISIONS.md D7 and D11,
// docs/SOURCES.md). LCDs and Articles are filtered to the configured MAC states;
// NCDs are national. CPT descriptors are never requested (the hcpc-code child
// endpoints are not called).
import { createHash } from 'node:crypto';
import { optionalEnv } from '@advisor/db';
import { loadJurisdictions } from '@advisor/core/config';
import type { Courier, CourierContext, CourierResult } from '../courier.js';
import { chunkSections } from '../chunker.js';
import type { Section } from '../chunker.js';
import { replaceChunks, withDocument } from '../doc-store.js';
import { htmlToText } from '../html.js';

const USPS_STATE_NAMES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  PR: 'Puerto Rico',
  VI: 'Virgin Islands',
};

interface ApiEnvelope<T> {
  meta: { status: { id: number; message?: string }; next_token?: string };
  data: T[];
}

/** MM/DD/YYYY, 'N/A', '' or prose to ISO date or null. */
export function mcdDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

/** Narrative fields are double entity-encoded HTML. */
export function decodeMcdNarrative(value: string): string {
  let s = value;
  for (let i = 0; i < 2; i++) {
    s = s
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&sol;', '/')
      .replaceAll('&nbsp;', ' ');
  }
  return htmlToText(s);
}

const LCD_NARRATIVE_FIELDS: [string, string][] = [
  ['indication', 'Coverage Indications, Limitations, and Medical Necessity'],
  ['diagnoses_support', 'Diagnoses That Support Medical Necessity'],
  ['diagnoses_dont_support', 'Diagnoses That Do Not Support Medical Necessity'],
  ['coding_guidelines', 'Coding Guidelines'],
  ['doc_reqs', 'Documentation Requirements'],
  ['util_guide', 'Utilization Guidelines'],
  ['associated_info', 'Associated Information'],
  ['add_icd10_info', 'Additional ICD-10 Information'],
  ['keywords', 'Keywords'],
];

const ARTICLE_NARRATIVE_FIELDS: [string, string][] = [
  ['description', 'Article Text'],
  ['article_text', 'Article Text'],
  ['coding_information', 'Coding Information'],
  ['coding_guidelines', 'Coding Guidelines'],
  ['documentation_requirements', 'Documentation Requirements'],
  ['associated_info', 'Associated Information'],
  ['revenue_para', 'Revenue Codes'],
  ['keywords', 'Keywords'],
];

const NCD_NARRATIVE_FIELDS: [string, string][] = [
  ['item_serv_desc', 'Item or Service Description'],
  ['indication', 'Indications and Limitations of Coverage'],
  ['indications_limitations', 'Indications and Limitations of Coverage'],
  ['other', 'Other'],
  ['transmittal_info', 'Transmittal Information'],
];

export function narrativeSections(
  row: Record<string, unknown>,
  fields: [string, string][],
): Section[] {
  const sections: Section[] = [];
  for (const [field, label] of fields) {
    const raw = row[field];
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    const text = decodeMcdNarrative(raw);
    if (text.length < 20) continue;
    sections.push({ path: label, text });
  }
  return sections;
}

class McdApi {
  private token: string | null = null;
  private tokenAt = 0;

  constructor(
    private readonly ctx: CourierContext,
    private readonly base: string,
  ) {}

  async get<T>(path: string, licensed = false): Promise<ApiEnvelope<T>> {
    const url = `${this.base}${path}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: Record<string, string> = {};
      if (licensed) {
        headers['authorization'] = `Bearer ${await this.licenseToken(attempt > 0)}`;
      }
      const res = await this.fetchJson(url, headers);
      if (res.status === 401 && licensed && attempt === 0) continue;
      if (res.status >= 400) throw new Error(`MCD API ${res.status} for ${path}`);
      return JSON.parse(res.body) as ApiEnvelope<T>;
    }
    throw new Error(`MCD API auth failed for ${path}`);
  }

  private async fetchJson(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    await this.ctx.fetcher.assertAllowed(url);
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'cm-coding-advisor/0.1 (ClinicMind internal tool)',
        ...headers,
      },
    });
    return { status: res.status, body: await res.text() };
  }

  /** The license-agreement endpoint returns the terms and a one-hour token (D11). */
  private async licenseToken(force: boolean): Promise<string> {
    if (optionalEnv('CMS_LICENSE_ATTESTATION', 'accept') !== 'accept') {
      throw new Error(
        'cms_mcd licensed endpoints need the CMS license attestation; CMS_LICENSE_ATTESTATION is not "accept" (D7)',
      );
    }
    const age = Date.now() - this.tokenAt;
    if (!force && this.token && age < 50 * 60 * 1000) return this.token;
    const res = await this.fetchJson(`${this.base}/v1/metadata/license-agreement/`, {});
    if (res.status >= 400) throw new Error(`MCD license-agreement endpoint ${res.status}`);
    const parsed = JSON.parse(res.body) as ApiEnvelope<{ Token: string }>;
    const token = parsed.data[0]?.Token;
    if (!token) throw new Error('MCD license-agreement returned no token');
    this.token = token;
    this.tokenAt = Date.now();
    return token;
  }
}

interface ReportRow {
  document_id: string;
  document_version: string;
  document_display_id: string;
  document_type: string;
  title: string;
  contractor_name_type?: string;
  effective_date?: string;
  retirement_date?: string;
}

async function run(ctx: CourierContext): Promise<CourierResult> {
  const src = await ctx.pool.query<{ base_url: string }>(
    `SELECT base_url FROM sources WHERE id = 'cms_mcd'`,
  );
  const base = src.rows[0]?.base_url?.replace(/\/$/, '');
  if (!base) throw new Error('cms_mcd base_url missing in config/sources.yaml');
  const api = new McdApi(ctx, base);

  // Configured states from the MAC footprint.
  const jurisdictions = await loadJurisdictions();
  const stateCodes = [...new Set(jurisdictions.macs.flatMap((m) => m.states))];
  const states = await api.get<{ state_id: number; description: string }>('/v1/metadata/states/');
  const idByName = new Map(states.data.map((s) => [s.description.toLowerCase(), s.state_id]));
  const stateIds: { code: string; id: number }[] = [];
  for (const code of stateCodes) {
    const name = USPS_STATE_NAMES[code];
    const id = name ? idByName.get(name.toLowerCase()) : undefined;
    if (id !== undefined) stateIds.push({ code, id });
  }
  const scopeIds = ctx.limit ? stateIds.slice(0, 1) : stateIds;

  // Collect LCD and Article ids in scope, remembering which states matched.
  const docs = new Map<string, { row: ReportRow; states: Set<string> }>();
  for (const { code, id } of scopeIds) {
    for (const report of ['local-coverage-final-lcds', 'local-coverage-articles']) {
      const page = await api.get<ReportRow>(`/v1/reports/${report}/?state_id=${id}`);
      for (const row of page.data) {
        const key = `${row.document_type}:${row.document_id}:${row.document_version}`;
        const entry = docs.get(key) ?? { row, states: new Set<string>() };
        entry.states.add(code);
        docs.set(key, entry);
      }
      await pause(120);
    }
  }

  // NCDs are national (tokenless list and detail).
  const ncds = await api.get<{
    document_id: string;
    document_version: string;
    document_display_id: string;
    title: string;
    last_updated?: string;
  }>('/v1/reports/national-coverage-ncd/');

  let written = 0;
  let processed = 0;
  const failures: string[] = [];

  const targets = ctx.limit ? [...docs.values()].slice(0, ctx.limit) : [...docs.values()];
  for (const { row, states: rowStates } of targets) {
    try {
      const isLcd = row.document_type === 'LCD';
      const detailPath = isLcd
        ? `/v1/data/lcd/?lcdid=${row.document_id}&ver=${row.document_version}`
        : `/v1/data/article/?articleid=${row.document_id}&ver=${row.document_version}`;
      const detail = await api.get<Record<string, unknown>>(detailPath, true);
      const d = detail.data[0] ?? {};
      const effective =
        mcdDate(d[isLcd ? 'rev_eff_date' : 'article_eff_date'] as string) ??
        mcdDate(row.effective_date);
      const retired =
        mcdDate(d['date_retired'] as string) ??
        mcdDate(d[isLcd ? 'rev_end_date' : 'article_rev_end_date'] as string) ??
        mcdDate(row.retirement_date);
      const versionHash = createHash('sha256').update(JSON.stringify(d)).digest('hex');
      const sections = narrativeSections(
        d,
        isLcd ? LCD_NARRATIVE_FIELDS : ARTICLE_NARRATIVE_FIELDS,
      );
      const result = await withDocument(
        ctx.pool,
        {
          sourceId: 'cms_mcd',
          externalId: row.document_display_id,
          docType: isLcd ? 'lcd' : 'lca_article',
          title: `${row.document_display_id}: ${row.title}`,
          url: `https://www.cms.gov/medicare-coverage-database/view/${isLcd ? 'lcd' : 'article'}.aspx?${isLcd ? 'lcdid' : 'articleid'}=${row.document_id}&ver=${row.document_version}`,
          versionHash,
          effectiveDate: effective,
          revisionDate: null,
          retiredDate: retired,
          tier: 3,
          jurisdiction: [...rowStates].sort(),
          payer: null,
          lob: null,
          clientId: null,
          storagePath: null,
          metadata: {
            document_id: row.document_id,
            version: row.document_version,
            contractor: row.contractor_name_type?.replace(/\r\n/g, ' ') ?? null,
            attested: 'coverage api license token (D11)',
          },
        },
        async (client, documentId) => {
          const chunks = chunkSections(`${row.document_display_id} ${row.title}`, sections).map(
            (c) => ({
              sectionPath: c.sectionPath,
              ordinal: c.ordinal,
              text: c.text,
              tokenCount: c.tokenCount,
              tier: 3 as const,
              clientId: null,
              effectiveDate: effective,
              retiredDate: retired,
              codesMentioned: c.codesMentioned,
            }),
          );
          return replaceChunks(client, documentId, chunks);
        },
      );
      processed++;
      written += result.rowsWritten;
      await pause(120);
    } catch (err) {
      failures.push(`${row.document_display_id}: ${(err as Error).message}`);
      if (failures.length > 25) {
        throw new Error(`too many MCD detail failures; first: ${failures[0]}`, { cause: err });
      }
    }
  }

  const ncdTargets = ctx.limit ? ncds.data.slice(0, 2) : ncds.data;
  for (const row of ncdTargets) {
    try {
      const detail = await api.get<Record<string, unknown>>(
        `/v1/data/ncd/?ncdid=${row.document_id}&ncdver=${row.document_version}`,
      );
      const d = detail.data[0] ?? {};
      const effective = mcdDate(d['effective_date'] as string);
      const versionHash = createHash('sha256').update(JSON.stringify(d)).digest('hex');
      const sections = narrativeSections(d, NCD_NARRATIVE_FIELDS);
      const result = await withDocument(
        ctx.pool,
        {
          sourceId: 'cms_mcd',
          externalId: `NCD-${row.document_display_id}`,
          docType: 'ncd',
          title: `NCD ${row.document_display_id}: ${row.title}`,
          url: `https://www.cms.gov/medicare-coverage-database/view/ncd.aspx?ncdid=${row.document_id}&ncdver=${row.document_version}`,
          versionHash,
          effectiveDate: effective,
          revisionDate: mcdDate(row.last_updated),
          retiredDate: null,
          tier: 3,
          jurisdiction: [],
          payer: null,
          lob: null,
          clientId: null,
          storagePath: null,
          metadata: { document_id: row.document_id, version: row.document_version },
        },
        async (client, documentId) => {
          const chunks = chunkSections(`NCD ${row.document_display_id} ${row.title}`, sections).map(
            (c) => ({
              sectionPath: c.sectionPath,
              ordinal: c.ordinal,
              text: c.text,
              tokenCount: c.tokenCount,
              tier: 3 as const,
              clientId: null,
              effectiveDate: effective,
              retiredDate: null,
              codesMentioned: c.codesMentioned,
            }),
          );
          return replaceChunks(client, documentId, chunks);
        },
      );
      processed++;
      written += result.rowsWritten;
      await pause(120);
    } catch (err) {
      failures.push(`NCD ${row.document_display_id}: ${(err as Error).message}`);
      if (failures.length > 25) {
        throw new Error(`too many MCD detail failures; first: ${failures[0]}`, { cause: err });
      }
    }
  }

  return {
    rowsWritten: written,
    notes:
      `${processed} documents (${docs.size} LCD/Article in scope across ${scopeIds.length} states, ` +
      `${ncdTargets.length} NCDs)` +
      (failures.length > 0 ? `; ${failures.length} failures, first: ${failures[0]}` : ''),
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const cmsMcdCourier: Courier = { sourceId: 'cms_mcd', run };
