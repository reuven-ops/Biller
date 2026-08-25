// Verifier (brief section 11): code-level checks (citation existence, client scoping,
// tier integrity, DOS windows) plus an independent MODEL_VERIFIER pass that grades
// every statement against the cited evidence texts. Unsupported statements are
// stripped; an unsupported core element forces an abstention.
import type { Answer, Citation } from './answer-schema.js';
import { abstention, allCitations } from './answer-schema.js';
import type { EvidenceRegistry } from './evidence.js';
import type { LlmClient } from './llm.js';
import { modelConfig } from './llm.js';
import { promptText, promptVersion } from './phi.js';

export interface VerifierItem {
  kind:
    | 'code'
    | 'published_rule'
    | 'contract_term'
    | 'our_experience'
    | 'divergence'
    | 'documentation_required'
    | 'bottom_line';
  index: number;
  statement: string;
  verdict: 'supported' | 'partial' | 'unsupported';
  evidence_id: string | null;
  quote: string | null;
}

export interface VerifierOutput {
  codeChecks: {
    citationsValid: boolean;
    invalidCitations: string[];
    clientViolations: string[];
    tierViolations: string[];
    dosViolations: string[];
  };
  items: VerifierItem[];
  supportedRate: number | null;
  /** Live mode only: the model verdict pass failed twice, so the answer was withheld. */
  verdictsUnavailable: boolean;
  removed: { kind: string; statement: string }[];
  finalAnswer: Answer;
  abstainedByVerifier: boolean;
  promptVersion: string;
  modelMode: 'live' | 'stub';
}

function tierViolationsOf(answer: Answer): string[] {
  const out: string[] = [];
  const check = (cites: Citation[], allowed: number[], label: string): void => {
    for (const c of cites) {
      if (!allowed.includes(c.tier)) {
        out.push(
          `${label} cites tier ${c.tier} (${c.evidence_id}); allowed tiers: ${allowed.join(',')}`,
        );
      }
    }
  };
  for (const [i, code] of answer.codes.entries())
    check(code.citations, [1, 2, 3, 4], `codes[${i}]`);
  for (const [i, s] of answer.published_rules.entries())
    check(s.citations, [1, 2, 3, 4], `published_rules[${i}]`);
  for (const [i, s] of answer.contract_terms.entries())
    check(s.citations, [5], `contract_terms[${i}]`);
  for (const [i, s] of answer.our_experience.entries())
    check(s.citations, [6, 7], `our_experience[${i}]`);
  return out;
}

function dosViolationsOf(answer: Answer, dos: string): string[] {
  const out: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const c of allCitations(answer)) {
    if (c.effective_date && c.effective_date > dos) {
      out.push(`${c.evidence_id} effective ${c.effective_date} is after DOS ${dos}`);
    }
    if (c.tier === 6) {
      // Call notes must be unexpired as of today (retired_date carries expiry).
      if (c.retired_date && c.retired_date < today) {
        out.push(`${c.evidence_id} call note expired ${c.retired_date}`);
      }
    } else if (c.retired_date && c.retired_date < dos) {
      out.push(`${c.evidence_id} retired ${c.retired_date} before DOS ${dos}`);
    }
  }
  return out;
}

async function llmVerdicts(
  llm: LlmClient,
  question: string,
  answer: Answer,
  registry: EvidenceRegistry,
  prompt: string,
): Promise<VerifierItem[] | null> {
  const cited = new Map<string, string>();
  for (const c of allCitations(answer)) {
    const rec = registry.get(c.evidence_id);
    if (rec) cited.set(rec.evidence_id, rec.text);
  }
  const evidenceBlock = [...cited.entries()]
    .map(([id, text]) => `[${id}]\n${text}`)
    .join('\n\n---\n\n');
  const res = await llm.complete({
    model: modelConfig().verifier,
    system: prompt,
    messages: [
      {
        role: 'user',
        content:
          `Question:\n${question}\n\nAnswer object:\n${JSON.stringify(answer, null, 1)}\n\n` +
          `Cited evidence records:\n${evidenceBlock || '(none cited)'}`,
      },
    ],
    maxTokens: 8192,
  });
  const textOut = res.content.find((b) => b.type === 'text');
  if (!textOut || textOut.type !== 'text') return null;
  // Models sometimes fence the JSON or add prose around it; take the outermost braces.
  const jsonStart = textOut.text.indexOf('{');
  const jsonEnd = textOut.text.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
  try {
    const parsed = JSON.parse(textOut.text.slice(jsonStart, jsonEnd + 1)) as {
      items?: VerifierItem[];
    };
    return parsed.items ?? null;
  } catch {
    return null;
  }
}

/**
 * Rewrites every citation's metadata from the run's evidence registry. The model
 * chooses only the evidence_id; document, tier, section, dates, and URL always come
 * from the retrieved record (brief hard rule 2), so a mislabeled tier or a mangled
 * external_id can neither slip past the tier checks nor reach the screen.
 */
function canonicalizeCitations(answer: Answer, registry: EvidenceRegistry): void {
  for (const c of allCitations(answer)) {
    const rec = registry.get(c.evidence_id);
    if (!rec) continue;
    c.document_id = rec.document_id;
    c.external_id = rec.external_id;
    c.tier = rec.tier as Citation['tier'];
    c.section_path = rec.section_path;
    c.effective_date = rec.effective_date;
    c.retired_date = rec.retired_date;
    c.retrieved_at = rec.retrieved_at;
    c.url = rec.url;
  }
}

/**
 * Runs the verifier. In stub mode the model pass is skipped (items empty, supported
 * rate null); the code checks always run and still strip and abstain on violations.
 */
export async function verifyAnswer(
  llm: LlmClient,
  question: string,
  answer: Answer,
  registry: EvidenceRegistry,
  runContext: { dos: string; userClientIds: string[] },
): Promise<VerifierOutput> {
  const prompt = promptText('verifier.md');

  // 0. Citation metadata always comes from the registry, never from the model.
  canonicalizeCitations(answer, registry);

  // 1. Citation check, in code: every evidence_id must exist in this run's registry.
  const invalidCitations: string[] = [];
  const clientViolations: string[] = [];
  for (const c of allCitations(answer)) {
    const rec = registry.get(c.evidence_id);
    if (!rec) {
      invalidCitations.push(c.evidence_id);
      continue;
    }
    if (rec.client_id && !runContext.userClientIds.includes(rec.client_id)) {
      clientViolations.push(c.evidence_id);
    }
  }
  const tierViolations = tierViolationsOf(answer);
  const dosViolations = dosViolationsOf(answer, runContext.dos);

  // 2. Model pass. One retry on an unparseable response; in live mode a verdict
  // pass that still fails closes the answer (hard rule 1: unverified answers do
  // not ship), while stub mode keeps running for plumbing tests.
  let items = await llmVerdicts(llm, question, answer, registry, prompt);
  if (items === null && llm.mode === 'live') {
    items = await llmVerdicts(llm, question, answer, registry, prompt);
  }
  const verdictsUnavailable = items === null && llm.mode === 'live' && !answer.abstained;
  const graded = items && items.length > 0 ? items : null;
  const supportedRate = graded
    ? graded.filter((i) => i.verdict === 'supported').length / graded.length
    : null;

  // 3. Enforcement: strip unsupported non-core statements; abstain on core failures.
  const removed: { kind: string; statement: string }[] = [];
  let final: Answer = structuredClone(answer);

  const unsupportedAt = (kind: VerifierItem['kind']): Set<number> =>
    new Set(
      (graded ?? [])
        .filter((i) => i.kind === kind && i.verdict === 'unsupported')
        .map((i) => i.index),
    );

  const stripArray = <T>(arr: T[], kind: VerifierItem['kind'], label: (t: T) => string): T[] => {
    const bad = unsupportedAt(kind);
    return arr.filter((entry, i) => {
      if (bad.has(i)) {
        removed.push({ kind, statement: label(entry) });
        return false;
      }
      return true;
    });
  };

  final.published_rules = stripArray(final.published_rules, 'published_rule', (s) => s.statement);
  final.contract_terms = stripArray(final.contract_terms, 'contract_term', (s) => s.statement);
  final.our_experience = stripArray(final.our_experience, 'our_experience', (s) => s.statement);
  final.divergence = stripArray(final.divergence, 'divergence', (s) => s.differs_how);
  final.documentation_required = stripArray(
    final.documentation_required,
    'documentation_required',
    (s) => s.element,
  );

  // Structural violations also strip: a statement whose only citations are invalid,
  // wrong-tier, or client-violating loses its support.
  const badIds = new Set([...invalidCitations, ...clientViolations]);
  const hasValidCite = (cites: Citation[]): boolean =>
    cites.length > 0 && cites.some((c) => !badIds.has(c.evidence_id));
  final.published_rules = final.published_rules.filter((s) => {
    if (!hasValidCite(s.citations)) {
      removed.push({ kind: 'published_rule', statement: s.statement });
      return false;
    }
    return true;
  });
  final.contract_terms = final.contract_terms.filter((s) => {
    if (!hasValidCite(s.citations)) {
      removed.push({ kind: 'contract_term', statement: s.statement });
      return false;
    }
    return true;
  });

  // Core elements: codes, modifiers, bottom line.
  const codeUnsupported = unsupportedAt('code');
  const bottomLineItem = (graded ?? []).find((i) => i.kind === 'bottom_line');
  const coreFailure =
    (!answer.abstained &&
      (verdictsUnavailable ||
        codeUnsupported.size > 0 ||
        (bottomLineItem && bottomLineItem.verdict !== 'supported') ||
        answer.codes.some((c) => !hasValidCite(c.citations)) ||
        (invalidCitations.length > 0 &&
          allCitations(answer).length > 0 &&
          invalidCitations.length === allCitations(answer).length) ||
        tierViolations.some((v) => v.startsWith('codes[')))) ||
    clientViolations.length > 0;

  let abstainedByVerifier = false;
  if (coreFailure) {
    abstainedByVerifier = true;
    const reasons: string[] = [];
    if (verdictsUnavailable)
      reasons.push('the verification pass could not be completed, so the answer is withheld');
    if (codeUnsupported.size > 0)
      reasons.push('a code or modifier is not supported by the cited evidence');
    if (bottomLineItem && bottomLineItem.verdict !== 'supported')
      reasons.push('the bottom line is not fully supported by the cited evidence');
    if (invalidCitations.length > 0)
      reasons.push('citations reference evidence not retrieved in this run');
    if (clientViolations.length > 0)
      reasons.push('client-scoped evidence outside your assignments was cited');
    if (tierViolations.length > 0) reasons.push('tier integrity was violated');
    final = abstention(
      answer.applicability,
      reasons.join('; '),
      answer.missing_sources,
      answer.freshness,
    );
  }

  return {
    codeChecks: {
      citationsValid: invalidCitations.length === 0,
      invalidCitations,
      clientViolations,
      tierViolations,
      dosViolations,
    },
    items: graded ?? [],
    supportedRate,
    verdictsUnavailable,
    removed,
    finalAnswer: final,
    abstainedByVerifier,
    promptVersion: promptVersion(prompt),
    modelMode: llm.mode,
  };
}
