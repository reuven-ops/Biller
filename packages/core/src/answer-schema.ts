// The answer contract from brief section 10, enforced at submit_answer.
import { z } from 'zod';

export const CitationSchema = z.object({
  evidence_id: z.string(),
  document_id: z.string(),
  external_id: z.string(),
  tier: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
    z.literal(7),
  ]),
  section_path: z.string(),
  effective_date: z.string().nullable(),
  retired_date: z.string().nullable(),
  retrieved_at: z.string(),
  url: z.string().nullable(),
});

export const AnswerSchema = z.object({
  bottom_line: z.string(),
  applicability: z.object({
    dos: z.string(),
    payer: z.string(),
    jurisdiction: z.string(),
    provider_type: z.string(),
    setting: z.string(),
    client: z.string().nullable(),
    defaults_applied: z.array(z.string()),
  }),
  codes: z.array(
    z.object({
      code: z.string(),
      code_set: z.enum(['CPT', 'HCPCS', 'ICD10CM']),
      role: z.enum(['primary', 'add_on', 'diagnosis']),
      modifiers: z.array(z.string()),
      citations: z.array(CitationSchema), // tiers 1 to 4 only (verifier enforces)
    }),
  ),
  published_rules: z.array(z.object({ statement: z.string(), citations: z.array(CitationSchema) })),
  contract_terms: z.array(z.object({ statement: z.string(), citations: z.array(CitationSchema) })),
  our_experience: z.array(
    z.object({
      statement: z.string(),
      numerator: z.number().nullable(),
      denominator: z.number().nullable(),
      citations: z.array(CitationSchema),
    }),
  ),
  divergence: z.array(
    z.object({
      payer_or_jurisdiction: z.string(),
      differs_how: z.string(),
      citations: z.array(CitationSchema),
    }),
  ),
  documentation_required: z.array(
    z.object({ element: z.string(), citations: z.array(CitationSchema) }),
  ),
  what_would_change_this: z.array(z.string()),
  next_action: z.object({
    type: z.enum(['none', 'call_payer', 'request_source', 'upload_policy']),
    script: z.string().nullable(),
  }),
  confidence: z.object({
    level: z.enum(['high', 'medium', 'low']),
    rationale: z.string(),
  }),
  freshness: z.object({
    as_of: z.string(),
    stale_sources: z.array(
      z.object({
        source_id: z.string(),
        last_success_at: z.string(),
        cadence_days: z.number(),
      }),
    ),
  }),
  abstained: z.boolean(),
  abstain_reason: z.string().nullable(),
  missing_sources: z.array(z.string()),
});

export type Citation = z.infer<typeof CitationSchema>;
export type Answer = z.infer<typeof AnswerSchema>;

export function validateAnswer(
  input: unknown,
): { ok: true; answer: Answer } | { ok: false; errors: string } {
  const parsed = AnswerSchema.safeParse(input);
  if (parsed.success) return { ok: true, answer: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues
      .slice(0, 12)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; '),
  };
}

/** Every citation anywhere in the answer, for the code-level checks. */
export function allCitations(answer: Answer): Citation[] {
  const out: Citation[] = [];
  for (const c of answer.codes) out.push(...c.citations);
  for (const s of answer.published_rules) out.push(...s.citations);
  for (const s of answer.contract_terms) out.push(...s.citations);
  for (const s of answer.our_experience) out.push(...s.citations);
  for (const s of answer.divergence) out.push(...s.citations);
  for (const s of answer.documentation_required) out.push(...s.citations);
  return out;
}

/** An abstention answer with the standard shape. */
export function abstention(
  applicability: Answer['applicability'],
  reason: string,
  missingSources: string[],
  freshness: Answer['freshness'],
): Answer {
  return {
    bottom_line: `No answer: ${reason}`,
    applicability,
    codes: [],
    published_rules: [],
    contract_terms: [],
    our_experience: [],
    divergence: [],
    documentation_required: [],
    what_would_change_this: missingSources.map((s) => `Evidence from ${s} becomes available.`),
    next_action: { type: missingSources.length > 0 ? 'request_source' : 'none', script: null },
    confidence: { level: 'low', rationale: 'Abstained for lack of supporting evidence.' },
    freshness,
    abstained: true,
    abstain_reason: reason,
    missing_sources: missingSources,
  };
}
