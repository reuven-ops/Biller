// Denial code glosses (DECISIONS.md D14): original plain-language explanations of
// CARC, RARC, and group codes, drafted only from evidence retrieved from the
// public corpus, stored as drafts until a lead approves them. Codes with no
// public evidence stay honest gaps.
import type { Pool } from '@advisor/db';
import { EvidenceRegistry, type EvidenceRecord } from './evidence.js';
import { hybridRetrieve } from './retrieval.js';
import type { LlmClient } from './llm.js';
import { modelConfig } from './llm.js';
import { promptText } from './phi.js';

export interface GlossEvidence {
  evidence_id: string;
  document_id: string;
  external_id: string;
  title: string;
  tier: number;
  section_path: string;
  quote: string;
  url: string | null;
  version_hash: string;
}

export type GlossDraft =
  { ok: true; gloss: string; evidence: GlossEvidence[] } | { ok: false; reason: string };

/** Drafts one gloss from the given evidence; testable with a stub client. */
export async function draftGlossFromEvidence(
  llm: LlmClient,
  codeType: 'carc' | 'rarc' | 'group',
  code: string,
  evidence: EvidenceRecord[],
): Promise<GlossDraft> {
  if (evidence.length === 0) return { ok: false, reason: 'no public evidence retrieved' };
  const block = evidence
    .map((e) => `[${e.evidence_id}] ${e.title} | ${e.section_path}\n${e.text.slice(0, 1500)}`)
    .join('\n\n---\n\n');
  const label =
    codeType === 'carc'
      ? `Claim Adjustment Reason Code (CARC) ${code}`
      : codeType === 'rarc'
        ? `Remittance Advice Remark Code (RARC) ${code}`
        : `claim adjustment group code ${code}`;
  const res = await llm.complete({
    model: modelConfig().light,
    system: promptText('glosser.md'),
    messages: [{ role: 'user', content: `Code: ${label}\n\nEvidence excerpts:\n${block}` }],
    maxTokens: 1024,
  });
  const text = res.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') return { ok: false, reason: 'no model output' };
  const start = text.text.indexOf('{');
  const end = text.text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, reason: 'unparseable model output' };
  let parsed: { gloss?: string | null; reason?: string; evidence_ids?: string[] };
  try {
    parsed = JSON.parse(text.text.slice(start, end + 1)) as typeof parsed;
  } catch {
    return { ok: false, reason: 'unparseable model output' };
  }
  if (!parsed.gloss)
    return { ok: false, reason: parsed.reason ?? 'evidence does not identify the code' };
  const byId = new Map(evidence.map((e) => [e.evidence_id, e]));
  const used = (parsed.evidence_ids ?? [])
    .map((id) => byId.get(id))
    .filter((e): e is EvidenceRecord => Boolean(e));
  if (used.length === 0) return { ok: false, reason: 'the draft cited no provided evidence' };
  return {
    ok: true,
    gloss: parsed.gloss,
    evidence: used.map((e) => ({
      evidence_id: e.evidence_id,
      document_id: e.document_id,
      external_id: e.external_id,
      title: e.title,
      tier: e.tier,
      section_path: e.section_path,
      quote: e.text.slice(0, 600),
      url: e.url,
      version_hash: e.version_hash,
    })),
  };
}

/** Every code the remit data mentions, plus the three group codes. */
export async function codesNeedingGlosses(
  pool: Pool,
): Promise<{ codeType: 'carc' | 'rarc' | 'group'; code: string }[]> {
  const res = await pool.query<{ code_type: string; code: string }>(
    `WITH mentioned AS (
       SELECT 'carc' AS code_type, jsonb_array_elements(top_carc)->>'code' AS code FROM remit_behavior
       UNION
       SELECT 'rarc', jsonb_array_elements(top_rarc)->>'code' FROM remit_behavior
       UNION SELECT 'group', g FROM unnest(ARRAY['CO','OA','PR']) AS g
     )
     SELECT DISTINCT m.code_type, m.code FROM mentioned m
     WHERE m.code IS NOT NULL AND m.code <> ''
       AND NOT EXISTS (
         SELECT 1 FROM code_glosses cg
         WHERE cg.code_type = m.code_type AND cg.code = m.code AND cg.status <> 'retired'
       )
     ORDER BY m.code_type, m.code`,
  );
  return res.rows.map((r) => ({
    codeType: r.code_type as 'carc' | 'rarc' | 'group',
    code: r.code,
  }));
}

function glossQuery(codeType: 'carc' | 'rarc' | 'group', code: string): string {
  if (codeType === 'carc') return `claim adjustment reason code CARC ${code} meaning denial reason`;
  if (codeType === 'rarc') return `remittance advice remark code RARC ${code} meaning`;
  return `claim adjustment group code ${code} contractual obligation patient responsibility meaning`;
}

export interface GlossRunSummary {
  drafted: number;
  skipped: { code: string; reason: string }[];
}

/** Drafts every missing gloss the public corpus can support; honest gaps skip. */
export async function draftMissingGlosses(
  pool: Pool,
  llm: LlmClient,
  opts: { limit?: number } = {},
): Promise<GlossRunSummary> {
  const pending = await codesNeedingGlosses(pool);
  const targets = opts.limit ? pending.slice(0, opts.limit) : pending;
  const summary: GlossRunSummary = { drafted: 0, skipped: [] };
  const today = new Date().toISOString().slice(0, 10);
  for (const t of targets) {
    const registry = new EvidenceRegistry();
    const evidence = await hybridRetrieve(pool, registry, glossQuery(t.codeType, t.code), {
      dos: today,
      clientIds: [],
      tiers: [1, 2, 3, 4],
      topK: 6,
    });
    // Keep only excerpts that actually mention the code token, so the drafter
    // never sees plausible-but-unrelated text.
    const codeRe = new RegExp(`(^|[^A-Z0-9])${t.code}([^A-Z0-9]|$)`, 'i');
    const mentioning = evidence.filter((e) => codeRe.test(e.text));
    const draft = await draftGlossFromEvidence(llm, t.codeType, t.code, mentioning);
    if (!draft.ok) {
      summary.skipped.push({ code: `${t.codeType} ${t.code}`, reason: draft.reason });
      continue;
    }
    await pool.query(
      `INSERT INTO code_glosses (code_type, code, gloss, evidence)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (code_type, code) DO UPDATE SET
         gloss = EXCLUDED.gloss, evidence = EXCLUDED.evidence, status = 'draft',
         drafted_at = now(), needs_review = false`,
      [t.codeType, t.code, draft.gloss, JSON.stringify(draft.evidence)],
    );
    summary.drafted += 1;
  }
  return summary;
}

/** Flags approved or draft glosses whose cited documents changed (D14.2b). */
export async function flagStaleGlosses(pool: Pool): Promise<number> {
  const res = await pool.query(
    `UPDATE code_glosses cg SET needs_review = true
     WHERE needs_review = false AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(cg.evidence) ev
       JOIN documents d ON d.id::text = ev->>'document_id'
       WHERE d.version_hash <> ev->>'version_hash'
     )`,
  );
  return res.rowCount ?? 0;
}
