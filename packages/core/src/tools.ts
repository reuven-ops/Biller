// The 13 agent tools from brief section 9, implemented over SQL and retrieval.
// Every tool result carries evidence_ids and tiers; the composer can cite only
// evidence_ids issued during the run (EvidenceRegistry).
import type { Pool, Tier } from '@advisor/db';
import { optionalEnv } from '@advisor/db';
import { EvidenceRegistry } from './evidence.js';
import type { EvidenceRecord } from './evidence.js';
import { hybridRetrieve, isoOrNull } from './retrieval.js';
import type { LlmToolDefinition } from './llm.js';

export interface ToolContext {
  pool: Pool;
  registry: EvidenceRegistry;
  userClientIds: string[];
  dos: string; // resolved DOS for the run
  jurisdiction: string | undefined;
  payer: string | undefined;
  /** Sources consulted during this run, for the freshness block. */
  sourcesUsed: Set<string>;
  /** refresh_source is bounded to once per answer. */
  refreshUsed: boolean;
  refreshSource?: ((sourceId: string) => Promise<string>) | undefined;
}

export function newToolContext(
  pool: Pool,
  opts: {
    userClientIds?: string[];
    dos: string;
    jurisdiction?: string | undefined;
    payer?: string | undefined;
    refreshSource?: ((sourceId: string) => Promise<string>) | undefined;
  },
): ToolContext {
  return {
    pool,
    registry: new EvidenceRegistry(),
    userClientIds: opts.userClientIds ?? [],
    dos: opts.dos,
    jurisdiction: opts.jurisdiction,
    payer: opts.payer,
    sourcesUsed: new Set(),
    refreshUsed: false,
    refreshSource: opts.refreshSource,
  };
}

interface HeadDoc {
  id: string;
  external_id: string;
  title: string;
  doc_type: string;
  url: string | null;
  version_hash: string;
  retrieved_at: Date;
  effective_date: Date | null;
  retired_date: Date | null;
  publisher: string;
  tier: Tier;
}

async function headDocument(
  ctx: ToolContext,
  sourceId: string,
  externalIdPattern?: string,
): Promise<HeadDoc | null> {
  const res = await ctx.pool.query<HeadDoc>(
    `SELECT d.id, d.external_id, d.title, d.doc_type, d.url, d.version_hash, d.retrieved_at,
            d.effective_date, d.retired_date, s.publisher, d.tier
     FROM documents d JOIN sources s ON s.id = d.source_id
     WHERE d.source_id = $1 AND d.superseded_by IS NULL
       AND ($2::text IS NULL OR d.external_id LIKE $2)
     ORDER BY d.retrieved_at DESC LIMIT 1`,
    [sourceId, externalIdPattern ?? null],
  );
  return res.rows[0] ?? null;
}

/** Registers evidence for a structured-table fact, citing the source file's document. */
async function registerStructured(
  ctx: ToolContext,
  sourceId: string,
  sectionPath: string,
  text: string,
  opts: { externalIdPattern?: string; effective?: string | null; retired?: string | null } = {},
): Promise<EvidenceRecord | null> {
  const doc = await headDocument(ctx, sourceId, opts.externalIdPattern);
  if (!doc) return null;
  ctx.sourcesUsed.add(sourceId);
  return ctx.registry.register({
    document_id: doc.id,
    external_id: doc.external_id,
    title: doc.title,
    doc_type: doc.doc_type,
    publisher: doc.publisher,
    tier: doc.tier,
    section_path: sectionPath,
    text,
    effective_date: opts.effective ?? isoOrNull(doc.effective_date),
    retired_date: opts.retired ?? isoOrNull(doc.retired_date),
    retrieved_at: doc.retrieved_at.toISOString(),
    version_hash: doc.version_hash,
    url: doc.url,
    client_id: null,
  });
}

function evidenceSummary(e: EvidenceRecord): Record<string, unknown> {
  return {
    evidence_id: e.evidence_id,
    tier: e.tier,
    title: e.title,
    section_path: e.section_path,
    effective_date: e.effective_date,
    retired_date: e.retired_date,
    text: e.text,
  };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export async function lookupCode(
  ctx: ToolContext,
  input: { code: string; dos?: string },
): Promise<unknown> {
  const dos = input.dos ?? ctx.dos;
  const code = input.code.trim().toUpperCase();
  const results: Record<string, unknown> = { code, dos };
  const evidence: Record<string, unknown>[] = [];

  // HCPCS Level II (descriptors public). CPT descriptors are never stored under
  // CPT_LICENSE_MODE=none; a CPT code's existence shows through MPFS and NCCI data.
  const hcpcs = await ctx.pool.query<{
    short_desc: string | null;
    long_desc: string | null;
    status: string | null;
    effective_date: Date | null;
    end_date: Date | null;
    version: string;
  }>(
    `SELECT short_desc, long_desc, status, effective_date, end_date, version
     FROM codes WHERE code_set = 'HCPCS' AND code = $1
       AND (effective_date IS NULL OR effective_date <= $2::date)
       AND (end_date IS NULL OR end_date >= $2::date)
     ORDER BY version DESC LIMIT 1`,
    [code, dos],
  );
  if (hcpcs.rows[0]) {
    const r = hcpcs.rows[0];
    const text =
      `HCPCS code ${code}: ${r.long_desc ?? r.short_desc ?? 'no description'}. ` +
      `Coverage code ${r.status ?? 'none'}. Added ${isoOrNull(r.effective_date) ?? 'unknown'}, ` +
      `termination ${isoOrNull(r.end_date) ?? 'none'} (in force on ${dos}). Quarterly file ${r.version}.`;
    const ev = await registerStructured(ctx, 'cms_hcpcs', `HCPCS ${code}`, text, {
      externalIdPattern: `hcpcs-%`,
    });
    if (ev) evidence.push(evidenceSummary(ev));
    results.hcpcs = { found: true, status: r.status };
  }

  // ICD-10-CM.
  const icd = await ctx.pool.query<{
    description: string;
    billable: boolean;
    effective_date: Date | null;
    end_date: Date | null;
    version: string;
  }>(
    `SELECT description, billable, effective_date, end_date, version FROM icd10cm
     WHERE code = $1
       AND (effective_date IS NULL OR effective_date <= $2::date)
       AND (end_date IS NULL OR end_date >= $2::date)
     ORDER BY version DESC LIMIT 1`,
    [code, dos],
  );
  if (icd.rows[0]) {
    const r = icd.rows[0];
    const text =
      `ICD-10-CM ${code}: ${r.description}. Billable: ${r.billable ? 'yes' : 'no (category or header code)'}. ` +
      `Fiscal-year file ${r.version}, in force on ${dos}.`;
    const ev = await registerStructured(ctx, 'cms_icd10cm', `ICD-10-CM ${code}`, text, {
      externalIdPattern: `icd10cm-order-%`,
    });
    if (ev) evidence.push(evidenceSummary(ev));
    results.icd10cm = { found: true, billable: r.billable };
  }

  // MPFS status for the quarter of DOS.
  const mpfs = await mpfsRow(ctx, code, dos);
  if (mpfs) {
    const text =
      `Medicare PFS entry for ${code} (${mpfs.year} Q${mpfs.quarter} RVU file): status indicator ${mpfs.status_indicator}, ` +
      `global days ${mpfs.global_days ?? 'none'}, work RVU ${mpfs.work_rvu ?? 'none'}, ` +
      `non-facility PE RVU ${mpfs.pe_rvu_nonfac ?? 'none'}, MP RVU ${mpfs.mp_rvu ?? 'none'}, ` +
      `multiple procedure indicator ${mpfs.mult_proc ?? 'none'}. No CPT descriptor is stored (CPT_LICENSE_MODE=none).`;
    const ev = await registerStructured(ctx, 'cms_mpfs', `PFS ${code}`, text, {
      externalIdPattern: `mpfs-%`,
    });
    if (ev) evidence.push(evidenceSummary(ev));
    results.mpfs = {
      found: true,
      status_indicator: mpfs.status_indicator,
      global_days: mpfs.global_days,
    };
  }

  // MUE in force on DOS.
  const mue = await ctx.pool.query<{
    mue_value: number;
    adjudication_indicator: string | null;
    rationale: string | null;
    effective_date: Date;
  }>(
    `SELECT mue_value, adjudication_indicator, rationale, effective_date FROM mue
     WHERE code = $1 AND effective_date <= $2::date
       AND (deletion_date IS NULL OR deletion_date >= $2::date)
     ORDER BY effective_date DESC LIMIT 1`,
    [code, dos],
  );
  if (mue.rows[0]) {
    const r = mue.rows[0];
    const text =
      `Practitioner MUE for ${code}: ${r.mue_value} unit(s) per day. ` +
      `Adjudication indicator: ${r.adjudication_indicator ?? 'none'}. Rationale: ${r.rationale ?? 'none'}. ` +
      `Effective ${isoOrNull(r.effective_date)}, in force on ${dos}.`;
    const ev = await registerStructured(ctx, 'cms_ncci_mue', `MUE ${code}`, text);
    if (ev) evidence.push(evidenceSummary(ev));
    results.mue = { found: true, value: r.mue_value };
  }

  // Telehealth list membership for the calendar year of DOS.
  const year = Number(dos.slice(0, 4));
  const th = await ctx.pool.query<{ action: string }>(
    `SELECT action FROM telehealth_services WHERE code = $1 AND year = $2`,
    [code, year],
  );
  if (th.rows[0]) {
    const text = `${code} appears on the List of Medicare Telehealth Services for CY ${year} (action: ${th.rows[0].action}).`;
    const ev = await registerStructured(ctx, 'cms_telehealth_list', `Telehealth CY ${year}`, text, {
      externalIdPattern: `telehealth-cy${year}`,
    });
    if (ev) evidence.push(evidenceSummary(ev));
    results.telehealth = { on_list: true, action: th.rows[0].action };
  } else {
    const listDoc = await headDocument(ctx, 'cms_telehealth_list', `telehealth-cy${year}`);
    results.telehealth = {
      on_list: false,
      note: listDoc
        ? `not on the CY ${year} list`
        : `no telehealth list loaded for CY ${year}; cannot confirm membership`,
    };
  }

  if (evidence.length === 0) {
    return {
      code,
      dos,
      found: false,
      note: 'No structured record for this code on this DOS in HCPCS, ICD-10-CM, MPFS, MUE, or the telehealth list.',
    };
  }
  return { ...results, evidence };
}

interface MpfsRowResult {
  year: number;
  quarter: number;
  status_indicator: string | null;
  work_rvu: string | null;
  pe_rvu_fac: string | null;
  pe_rvu_nonfac: string | null;
  mp_rvu: string | null;
  global_days: string | null;
  mult_proc: string | null;
  bilateral: string | null;
}

async function mpfsRow(ctx: ToolContext, code: string, dos: string): Promise<MpfsRowResult | null> {
  const year = Number(dos.slice(0, 4));
  const quarter = Math.floor((Number(dos.slice(5, 7)) - 1) / 3) + 1;
  const res = await ctx.pool.query<MpfsRowResult>(
    `SELECT year, quarter, status_indicator, work_rvu, pe_rvu_fac, pe_rvu_nonfac, mp_rvu,
            global_days, mult_proc, bilateral
     FROM mpfs WHERE code = $1 AND modifier = '' AND (year, quarter) <= ($2, $3)
     ORDER BY year DESC, quarter DESC LIMIT 1`,
    [code, year, quarter],
  );
  return res.rows[0] ?? null;
}

export async function ncciCheck(
  ctx: ToolContext,
  input: { codes: string[]; dos?: string },
): Promise<unknown> {
  const dos = input.dos ?? ctx.dos;
  const codes = input.codes.map((c) => c.trim().toUpperCase());
  const pairs: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown>[] = [];
  const res = await ctx.pool.query<{
    column1: string;
    column2: string;
    modifier_indicator: string;
    effective_date: Date;
    deletion_date: Date | null;
    rationale: string | null;
    file_version: string;
  }>(
    `SELECT column1, column2, modifier_indicator, effective_date, deletion_date, rationale, file_version
     FROM ncci_ptp
     WHERE column1 = ANY($1::text[]) AND column2 = ANY($1::text[])
       AND effective_date <= $2::date
       AND (deletion_date IS NULL OR deletion_date >= $2::date)
     ORDER BY column1, column2`,
    [codes, dos],
  );
  for (const r of res.rows) {
    const meaning =
      r.modifier_indicator === '0'
        ? 'modifier not allowed; the column 2 code is never paid separately with the column 1 code'
        : r.modifier_indicator === '1'
          ? 'modifier allowed; an appropriate NCCI-associated modifier permits separate payment when clinically justified'
          : 'not applicable';
    const text =
      `NCCI PTP edit in force on ${dos}: column 1 ${r.column1}, column 2 ${r.column2}, ` +
      `modifier indicator ${r.modifier_indicator} (${meaning}). ` +
      `Effective ${isoOrNull(r.effective_date)}, deletion date ${isoOrNull(r.deletion_date) ?? 'none'}. ` +
      `Rationale: ${r.rationale ?? 'none'}. File version ${r.file_version}.`;
    const ev = await registerStructured(
      ctx,
      'cms_ncci_ptp',
      `PTP ${r.column1}/${r.column2}`,
      text,
      { effective: isoOrNull(r.effective_date), retired: null },
    );
    if (ev) evidence.push(evidenceSummary(ev));
    pairs.push({
      column1: r.column1,
      column2: r.column2,
      modifier_indicator: r.modifier_indicator,
      effective_date: isoOrNull(r.effective_date),
      deletion_date: isoOrNull(r.deletion_date),
    });
  }
  ctx.sourcesUsed.add('cms_ncci_ptp');
  if (pairs.length === 0) {
    return {
      dos,
      codes,
      pairs: [],
      note: 'No NCCI PTP edit in force among these codes on this DOS.',
    };
  }
  return { dos, codes, pairs, evidence };
}

export async function mpfsLookup(
  ctx: ToolContext,
  input: { code: string; dos?: string; locality?: string },
): Promise<unknown> {
  const dos = input.dos ?? ctx.dos;
  const code = input.code.trim().toUpperCase();
  const row = await mpfsRow(ctx, code, dos);
  ctx.sourcesUsed.add('cms_mpfs');
  if (!row) {
    return {
      code,
      dos,
      found: false,
      note: 'No PFS RVU row for this code in the release covering this DOS.',
    };
  }
  const cf = await ctx.pool.query<{ value: string }>(
    `SELECT value FROM conversion_factor WHERE (year, quarter) <= ($1, $2)
     ORDER BY year DESC, quarter DESC LIMIT 1`,
    [row.year, row.quarter],
  );
  const cfValue = cf.rows[0]?.value ?? null;
  let payment: { nonFacility: number; facility: number } | null = null;
  if (cfValue && row.work_rvu !== null && row.pe_rvu_nonfac !== null && row.mp_rvu !== null) {
    const factor = Number(cfValue);
    payment = {
      nonFacility:
        Math.round(
          (Number(row.work_rvu) + Number(row.pe_rvu_nonfac) + Number(row.mp_rvu)) * factor * 100,
        ) / 100,
      facility:
        Math.round(
          (Number(row.work_rvu) + Number(row.pe_rvu_fac ?? 0) + Number(row.mp_rvu)) * factor * 100,
        ) / 100,
    };
  }
  const text =
    `Medicare PFS ${row.year} Q${row.quarter} for ${code}: status indicator ${row.status_indicator}, ` +
    `work RVU ${row.work_rvu}, non-facility PE RVU ${row.pe_rvu_nonfac}, facility PE RVU ${row.pe_rvu_fac}, ` +
    `MP RVU ${row.mp_rvu}, global days ${row.global_days ?? 'none'}, multiple procedure indicator ${row.mult_proc ?? 'none'}, ` +
    `bilateral indicator ${row.bilateral ?? 'none'}. ` +
    (cfValue
      ? `Conversion factor ${cfValue} (non-QPP). Estimated national payment: non-facility $${payment?.nonFacility}, facility $${payment?.facility} ` +
        `(RVU sum times conversion factor, before GPCI adjustment and sequestration).`
      : `No conversion factor is loaded for this period (per-row conversion factors exist from the 2026 RVU layout on), so no payment estimate is given.`);
  const ev = await registerStructured(ctx, 'cms_mpfs', `PFS ${code} payment`, text, {
    externalIdPattern: `mpfs-%`,
  });
  return {
    code,
    dos,
    found: true,
    status_indicator: row.status_indicator,
    work_rvu: row.work_rvu,
    pe_rvu_nonfac: row.pe_rvu_nonfac,
    pe_rvu_fac: row.pe_rvu_fac,
    mp_rvu: row.mp_rvu,
    global_days: row.global_days,
    conversion_factor: cfValue,
    estimated_national_payment: payment,
    evidence: ev ? [evidenceSummary(ev)] : [],
  };
}

export async function icd10Lookup(
  ctx: ToolContext,
  input: { query: string; dos?: string },
): Promise<unknown> {
  const dos = input.dos ?? ctx.dos;
  const q = input.query.trim();
  ctx.sourcesUsed.add('cms_icd10cm');
  const res = await ctx.pool.query<{
    code: string;
    description: string;
    billable: boolean;
    version: string;
  }>(
    `SELECT code, description, billable, version FROM icd10cm
     WHERE (code = upper($1) OR code LIKE upper($1) || '%' OR description ILIKE '%' || $1 || '%')
       AND (effective_date IS NULL OR effective_date <= $2::date)
       AND (end_date IS NULL OR end_date >= $2::date)
     ORDER BY (code = upper($1)) DESC, billable DESC, code
     LIMIT 15`,
    [q, dos],
  );
  const rows = res.rows;
  if (rows.length === 0)
    return { query: q, dos, matches: [], note: 'No ICD-10-CM match on this DOS.' };
  const text =
    `ICD-10-CM matches for "${q}" in force on ${dos}: ` +
    rows
      .map((r) => `${r.code} ${r.description} (billable: ${r.billable ? 'yes' : 'no'})`)
      .join('; ') +
    '.';
  const ev = await registerStructured(ctx, 'cms_icd10cm', `ICD-10-CM search ${q}`, text, {
    externalIdPattern: `icd10cm-order-%`,
  });
  return {
    query: q,
    dos,
    matches: rows.map((r) => ({ code: r.code, billable: r.billable })),
    evidence: ev ? [evidenceSummary(ev)] : [],
  };
}

export async function mcdLookup(
  ctx: ToolContext,
  input: { query: string; jurisdiction?: string; dos?: string },
): Promise<unknown> {
  const dos = input.dos ?? ctx.dos;
  ctx.sourcesUsed.add('cms_mcd');
  const records = await hybridRetrieve(ctx.pool, ctx.registry, input.query, {
    dos,
    jurisdiction: input.jurisdiction ?? ctx.jurisdiction,
    clientIds: ctx.userClientIds,
    docTypes: ['lcd', 'lca_article', 'ncd'],
    tiers: [3],
    topK: 8,
  });
  return {
    query: input.query,
    dos,
    results: records.map(evidenceSummary),
    note:
      records.length === 0
        ? 'No NCD, LCD, or Article matched for this jurisdiction and DOS.'
        : undefined,
  };
}

export async function searchPolicy(
  ctx: ToolContext,
  input: {
    query: string;
    dos?: string;
    jurisdiction?: string;
    payer?: string;
    doc_types?: string[];
    tiers?: number[];
  },
): Promise<unknown> {
  const dos = input.dos ?? ctx.dos;
  const records = await hybridRetrieve(ctx.pool, ctx.registry, input.query, {
    dos,
    jurisdiction: input.jurisdiction ?? ctx.jurisdiction,
    payer: input.payer ?? ctx.payer,
    clientIds: ctx.userClientIds,
    docTypes: input.doc_types,
    tiers: (input.tiers as Tier[] | undefined) ?? [1, 2, 3, 4, 5],
    topK: 12,
  });
  for (const r of records) {
    // Track by document source for freshness.
    void r;
  }
  return {
    query: input.query,
    dos,
    results: records.map(evidenceSummary),
    note:
      records.length === 0
        ? 'Nothing retrieved; consider abstaining and naming the missing source.'
        : undefined,
  };
}

export async function getSection(
  ctx: ToolContext,
  input: { document_id: string; section_path: string },
): Promise<unknown> {
  const res = await ctx.pool.query<{
    section_path: string;
    text: string;
    tier: Tier;
    client_id: string | null;
    effective_date: Date | null;
    retired_date: Date | null;
    external_id: string;
    title: string;
    doc_type: string;
    url: string | null;
    version_hash: string;
    retrieved_at: Date;
    publisher: string;
    document_id: string;
  }>(
    `SELECT c.section_path, c.text, c.tier, c.client_id, c.effective_date, c.retired_date,
            d.external_id, d.title, d.doc_type, d.url, d.version_hash, d.retrieved_at,
            s.publisher, d.id AS document_id
     FROM chunks c JOIN documents d ON d.id = c.document_id JOIN sources s ON s.id = d.source_id
     WHERE d.id = $1::uuid AND c.section_path ILIKE '%' || $2 || '%'
       AND (c.client_id IS NULL OR c.client_id = ANY($3::uuid[]))
     ORDER BY c.ordinal LIMIT 6`,
    [input.document_id, input.section_path, ctx.userClientIds],
  );
  if (res.rowCount === 0)
    return { note: 'No matching section in that document (or not visible to this user).' };
  const out = res.rows.map((r) =>
    evidenceSummary(
      ctx.registry.register({
        document_id: r.document_id,
        external_id: r.external_id,
        title: r.title,
        doc_type: r.doc_type,
        publisher: r.publisher,
        tier: r.tier,
        section_path: r.section_path,
        text: r.text,
        effective_date: isoOrNull(r.effective_date),
        retired_date: isoOrNull(r.retired_date),
        retrieved_at: r.retrieved_at.toISOString(),
        version_hash: r.version_hash,
        url: r.url,
        client_id: r.client_id,
      }),
    ),
  );
  return { sections: out };
}

export async function callNotesLookup(
  ctx: ToolContext,
  input: { payer: string; state?: string; codes?: string[]; dos?: string },
): Promise<unknown> {
  ctx.sourcesUsed.add('payer_call_notes');
  const res = await ctx.pool.query<{
    id: string;
    payer: string;
    state: string | null;
    codes: string[];
    modifiers: string[];
    topic: string;
    rule_as_stated: string;
    rep_name: string | null;
    call_reference: string | null;
    call_date: Date;
    status: string;
    expires_on: Date;
    client_id: string | null;
  }>(
    `SELECT id, payer, state, codes, modifiers, topic, rule_as_stated, rep_name,
            call_reference, call_date, status, expires_on, client_id
     FROM payer_call_notes
     WHERE payer ILIKE $1 AND status <> 'retired'
       AND expires_on >= now()::date
       AND ($2::text IS NULL OR state IS NULL OR state = $2)
       AND ($3::text[] IS NULL OR codes && $3::text[])
       AND (client_id IS NULL OR client_id = ANY($4::uuid[]))
     ORDER BY (status = 'lead_approved') DESC, call_date DESC
     LIMIT 8`,
    [`%${input.payer}%`, input.state ?? null, input.codes ?? null, ctx.userClientIds],
  );
  if (res.rowCount === 0) {
    return {
      payer: input.payer,
      notes: [],
      note: 'No unexpired call notes for this payer (tier 6 evidence arrives in Phase 4).',
    };
  }
  const notes = res.rows.map((r) => {
    const text =
      `Payer call note (${r.status === 'lead_approved' ? 'lead approved' : 'unverified'}): ${r.payer}` +
      `${r.state ? `, ${r.state}` : ''}. Codes ${r.codes.join(', ')}${r.modifiers.length ? ` with modifiers ${r.modifiers.join(', ')}` : ''}. ` +
      `Topic: ${r.topic}. The representative stated: ${r.rule_as_stated} ` +
      `(rep ${r.rep_name ?? 'not recorded'}, reference ${r.call_reference ?? 'none'}, call date ${isoOrNull(r.call_date)}, expires ${isoOrNull(r.expires_on)}).`;
    const ev = ctx.registry.register({
      document_id: r.id,
      external_id: `call-note-${r.id.slice(0, 8)}`,
      title: `Payer call note: ${r.payer} ${r.topic}`,
      doc_type: 'payer_call_note',
      publisher: 'ClinicMind',
      tier: 6,
      section_path: r.status,
      text,
      effective_date: isoOrNull(r.call_date),
      retired_date: isoOrNull(r.expires_on),
      retrieved_at: new Date().toISOString(),
      version_hash: r.id,
      url: null,
      client_id: r.client_id,
    });
    return evidenceSummary(ev);
  });
  return { payer: input.payer, notes };
}

export async function remitLookup(
  ctx: ToolContext,
  input: { payer: string; state?: string; cpt: string; modifiers?: string[]; year?: number },
): Promise<unknown> {
  ctx.sourcesUsed.add('remit_behavior');
  const minN = Number(optionalEnv('REMIT_MIN_N', '30'));
  const res = await ctx.pool.query<{
    payer: string;
    lob: string;
    state: string;
    cpt: string;
    modifiers: string[];
    year: number;
    claims_n: number;
    denied_n: number;
    paid_n: number;
    top_carc: unknown;
    appealed_n: number;
    overturned_n: number;
    import_id: string | null;
    computed_at: Date;
  }>(
    `SELECT payer, lob, state, cpt, modifiers, year, claims_n, denied_n, paid_n, top_carc,
            appealed_n, overturned_n, import_id, computed_at
     FROM remit_behavior
     WHERE payer ILIKE $1 AND cpt = $2
       AND ($3::text IS NULL OR state = $3)
       AND ($4::int IS NULL OR year = $4)
       AND claims_n >= $5
     ORDER BY year DESC LIMIT 6`,
    [`%${input.payer}%`, input.cpt.toUpperCase(), input.state ?? null, input.year ?? null, minN],
  );
  if (res.rowCount === 0) {
    return {
      payer: input.payer,
      cpt: input.cpt,
      cells: [],
      note: `No remittance cell with at least REMIT_MIN_N=${minN} claims (tier 7 evidence arrives in Phase 4).`,
    };
  }
  const cells = res.rows.map((r) => {
    const deniedPct = ((r.denied_n / r.claims_n) * 100).toFixed(1);
    const overturnedPct =
      r.appealed_n > 0 ? ((r.overturned_n / r.appealed_n) * 100).toFixed(1) : null;
    const text =
      `Observed remittance behavior: ${r.payer}, ${r.state}, ${r.cpt}${r.modifiers.length ? ` with modifiers ${r.modifiers.join(', ')}` : ''}, ${r.year}: ` +
      `${r.claims_n} claims, ${r.denied_n} denied (${deniedPct} percent), top CARC ${JSON.stringify(r.top_carc)}; ` +
      `${r.appealed_n} appealed, ${r.overturned_n} overturned${overturnedPct ? ` (${overturnedPct} percent)` : ''}.`;
    const ev = ctx.registry.register({
      document_id: r.import_id ?? '00000000-0000-0000-0000-000000000000',
      external_id: `remit-${r.payer}-${r.cpt}-${r.year}`,
      title: `Remittance behavior: ${r.payer} ${r.cpt} ${r.year}`,
      doc_type: 'remit_behavior',
      publisher: 'ClinicMind',
      tier: 7,
      section_path: `${r.state} ${r.lob}`,
      text,
      effective_date: `${r.year}-01-01`,
      retired_date: `${r.year}-12-31`,
      retrieved_at: r.computed_at.toISOString(),
      version_hash: `${r.claims_n}`,
      url: null,
      client_id: null,
    });
    return {
      ...evidenceSummary(ev),
      claims_n: r.claims_n,
      denied_n: r.denied_n,
      appealed_n: r.appealed_n,
      overturned_n: r.overturned_n,
    };
  });
  return { payer: input.payer, cpt: input.cpt, cells };
}

export async function freshnessReport(
  ctx: ToolContext,
  input: { source_ids?: string[] },
): Promise<unknown> {
  const res = await ctx.pool.query<{
    id: string;
    cadence_days: number;
    last_success_at: Date | null;
    last_error: string | null;
    stale: boolean;
  }>(
    `SELECT id, cadence_days, last_success_at, last_error,
            (last_error IS NOT NULL OR last_success_at IS NULL
             OR now() - last_success_at > (cadence_days * interval '1 day') * 1.5) AS stale
     FROM sources WHERE enabled AND ($1::text[] IS NULL OR id = ANY($1::text[]))
     ORDER BY id`,
    [input.source_ids ?? null],
  );
  return {
    sources: res.rows.map((r) => ({
      source_id: r.id,
      cadence_days: r.cadence_days,
      last_success_at: r.last_success_at?.toISOString() ?? null,
      stale: r.stale,
      last_error: r.last_error,
    })),
  };
}

export async function listChanges(
  ctx: ToolContext,
  input: { since: string; source_id?: string },
): Promise<unknown> {
  const res = await ctx.pool.query<{
    change_type: string;
    diff_summary: string | null;
    detected_at: Date;
    title: string;
    external_id: string;
    source_id: string;
  }>(
    `SELECT ce.change_type, ce.diff_summary, ce.detected_at, d.title, d.external_id, d.source_id
     FROM change_events ce JOIN documents d ON d.id = ce.document_id
     WHERE ce.detected_at >= $1::timestamptz
       AND ($2::text IS NULL OR d.source_id = $2)
       AND (d.client_id IS NULL OR d.client_id = ANY($3::uuid[]))
     ORDER BY ce.detected_at DESC LIMIT 40`,
    [input.since, input.source_id ?? null, ctx.userClientIds],
  );
  return { since: input.since, changes: res.rows };
}

export async function refreshSourceTool(
  ctx: ToolContext,
  input: { source_id: string },
): Promise<unknown> {
  if (ctx.refreshUsed) return { note: 'refresh_source already used once this answer (the bound).' };
  if (!ctx.refreshSource) return { note: 'refresh is not available in this context.' };
  ctx.refreshUsed = true;
  const outcome = await ctx.refreshSource(input.source_id);
  return { source_id: input.source_id, outcome };
}

// ---------------------------------------------------------------------------
// Tool definitions (Claude tool schemas) and the dispatcher
// ---------------------------------------------------------------------------

const str = { type: 'string' } as const;
const strArr = { type: 'array', items: { type: 'string' } } as const;

export const TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    name: 'lookup_code',
    description:
      'Code status on the DOS: HCPCS or ICD-10-CM record, MPFS status indicator and global days, practitioner MUE, and Medicare telehealth list membership. CPT descriptors are never returned.',
    input_schema: {
      type: 'object',
      properties: {
        code: str,
        dos: { ...str, description: 'YYYY-MM-DD; defaults to the run DOS' },
      },
      required: ['code'],
    },
  },
  {
    name: 'ncci_check',
    description:
      'All NCCI PTP edit pairs among the given procedure codes in force on the DOS, with modifier indicator and effective and deletion dates. Required whenever two or more procedure codes are in play.',
    input_schema: {
      type: 'object',
      properties: { codes: strArr, dos: str },
      required: ['codes'],
    },
  },
  {
    name: 'mpfs_lookup',
    description:
      'Medicare PFS status, RVUs, conversion factor, and estimated national payment for a code on the DOS. Required whenever payment or payability status is in play.',
    input_schema: {
      type: 'object',
      properties: { code: str, dos: str, locality: str },
      required: ['code'],
    },
  },
  {
    name: 'icd10_lookup',
    description: 'ICD-10-CM code or term search with billable flags, DOS-filtered.',
    input_schema: {
      type: 'object',
      properties: { query: str, dos: str },
      required: ['query'],
    },
  },
  {
    name: 'mcd_lookup',
    description:
      'NCDs, LCDs, and Local Coverage Articles relevant to a code or keyword for the MAC jurisdiction or state, DOS-filtered. Required for Medicare coverage questions.',
    input_schema: {
      type: 'object',
      properties: {
        query: str,
        jurisdiction: { ...str, description: 'two-letter state code' },
        dos: str,
      },
      required: ['query'],
    },
  },
  {
    name: 'search_policy',
    description:
      'Hybrid retrieval over the governed corpus, tiers 1 to 5: Federal Register rules, CMS manuals and articles, MAC documents, payer policies, client contracts (only for assigned clients).',
    input_schema: {
      type: 'object',
      properties: {
        query: str,
        dos: str,
        jurisdiction: str,
        payer: str,
        doc_types: strArr,
        tiers: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 5 } },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_section',
    description:
      'Full text of sections of one document by document_id and section path, for citation precision.',
    input_schema: {
      type: 'object',
      properties: { document_id: str, section_path: str },
      required: ['document_id', 'section_path'],
    },
  },
  {
    name: 'call_notes_lookup',
    description:
      'Tier 6 payer call notes, unexpired as of today, lead-approved first. Required when the payer is not traditional Medicare.',
    input_schema: {
      type: 'object',
      properties: { payer: str, state: str, codes: strArr, dos: str },
      required: ['payer'],
    },
  },
  {
    name: 'remit_lookup',
    description:
      'Tier 7 observed remittance behavior cells with at least REMIT_MIN_N claims, with CARC labels. Required when the payer is not traditional Medicare.',
    input_schema: {
      type: 'object',
      properties: {
        payer: str,
        state: str,
        cpt: str,
        modifiers: strArr,
        year: { type: 'integer' },
      },
      required: ['payer', 'cpt'],
    },
  },
  {
    name: 'freshness_report',
    description: 'Last success, cadence, and stale flag for sources.',
    input_schema: { type: 'object', properties: { source_ids: strArr }, required: [] },
  },
  {
    name: 'list_changes',
    description: 'Recent change events (new, revised, retired documents) since a timestamp.',
    input_schema: {
      type: 'object',
      properties: { since: str, source_id: str },
      required: ['since'],
    },
  },
  {
    name: 'refresh_source',
    description: 'Bounded refresh of one stale source; usable at most once per answer.',
    input_schema: { type: 'object', properties: { source_id: str }, required: ['source_id'] },
  },
  {
    name: 'submit_answer',
    description:
      'The only way to finish. Submit the final Answer object conforming to the answer contract. Cite only evidence_ids returned by tools during this run.',
    input_schema: {
      type: 'object',
      properties: { answer: { type: 'object', description: 'The Answer object' } },
      required: ['answer'],
    },
  },
];

export async function dispatchTool(
  ctx: ToolContext,
  name: string,
  input: unknown,
): Promise<unknown> {
  const i = input as never;
  switch (name) {
    case 'lookup_code':
      return lookupCode(ctx, i);
    case 'ncci_check':
      return ncciCheck(ctx, i);
    case 'mpfs_lookup':
      return mpfsLookup(ctx, i);
    case 'icd10_lookup':
      return icd10Lookup(ctx, i);
    case 'mcd_lookup':
      return mcdLookup(ctx, i);
    case 'search_policy':
      return searchPolicy(ctx, i);
    case 'get_section':
      return getSection(ctx, i);
    case 'call_notes_lookup':
      return callNotesLookup(ctx, i);
    case 'remit_lookup':
      return remitLookup(ctx, i);
    case 'freshness_report':
      return freshnessReport(ctx, i);
    case 'list_changes':
      return listChanges(ctx, i);
    case 'refresh_source':
      return refreshSourceTool(ctx, i);
    default:
      return { error: `unknown tool ${name}` };
  }
}
