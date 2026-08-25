// Verifier hardening from the first live eval run: fenced verdict JSON must
// parse, citation metadata always comes from the registry (closing the
// model-mislabeled-tier hole), and a failed verdict pass withholds the answer
// in live mode instead of silently skipping enforcement.
import { describe, expect, it } from 'vitest';
import type { Answer, Citation } from '../src/answer-schema.js';
import { EvidenceRegistry } from '../src/evidence.js';
import type { LlmClient, LlmRequest, LlmResponse } from '../src/llm.js';
import { StubLlmClient } from '../src/llm.js';
import { verifyAnswer } from '../src/verifier.js';

const FRESHNESS = { as_of: '2026-08-25', stale_sources: [] };
const APPLICABILITY = {
  dos: '2026-08-25',
  payer: 'Medicare Part B',
  jurisdiction: 'FL',
  provider_type: 'DC',
  setting: 'office, POS 11',
  client: null,
  defaults_applied: [],
};

function makeRegistry(): { registry: EvidenceRegistry; id: string } {
  const registry = new EvidenceRegistry();
  const rec = registry.register({
    document_id: 'doc-real',
    external_id: 'ncci-manual',
    title: 'NCCI Policy Manual',
    doc_type: 'manual',
    publisher: 'CMS',
    tier: 2,
    section_path: 'Ch.XI > S. Chiropractic Manipulative Treatment',
    text: 'The rule text.',
    effective_date: '2026-01-01',
    retired_date: null,
    retrieved_at: '2026-08-25T00:00:00Z',
    version_hash: 'h1',
    url: 'https://www.cms.gov/x',
    client_id: null,
  });
  return { registry, id: rec.evidence_id };
}

function modelWrittenCitation(evidenceId: string): Citation {
  // The composer copied metadata sloppily: title in external_id, wrong tier.
  return {
    evidence_id: evidenceId,
    document_id: 'wrong-doc',
    external_id: 'NCCI Policy Manual',
    tier: 6,
    section_path: 'wrong section',
    effective_date: null,
    retired_date: null,
    retrieved_at: 'whenever',
    url: null,
  };
}

function answerWith(citation: Citation): Answer {
  return {
    bottom_line: 'Yes with modifier 59.',
    applicability: APPLICABILITY,
    codes: [
      { code: '97140', code_set: 'CPT', role: 'primary', modifiers: ['59'], citations: [citation] },
    ],
    published_rules: [{ statement: 'The published rule.', citations: [citation] }],
    contract_terms: [],
    our_experience: [],
    divergence: [],
    documentation_required: [],
    what_would_change_this: [],
    next_action: { type: 'none', script: null },
    confidence: { level: 'high', rationale: 'direct' },
    freshness: FRESHNESS,
    abstained: false,
    abstain_reason: null,
    missing_sources: [],
  };
}

const supportedVerdicts = (fence: boolean) => (req: LlmRequest) => {
  void req;
  const json = JSON.stringify({
    items: [
      { kind: 'bottom_line', index: 0, verdict: 'supported', note: '' },
      { kind: 'code', index: 0, verdict: 'supported', note: '' },
      { kind: 'published_rule', index: 0, verdict: 'supported', note: '' },
    ],
  });
  const text = fence ? '```json\n' + json + '\n```\nDone.' : json;
  return Promise.resolve<LlmResponse>({
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  });
};

describe('verifier hardening', () => {
  it('parses fenced verdict JSON with trailing prose', async () => {
    const { registry, id } = makeRegistry();
    const llm = new StubLlmClient();
    llm.enqueue(supportedVerdicts(true));
    const out = await verifyAnswer(llm, 'q', answerWith(modelWrittenCitation(id)), registry, {
      dos: '2026-08-25',
      userClientIds: [],
    });
    expect(out.items.length).toBe(3);
    expect(out.supportedRate).toBe(1);
    expect(out.finalAnswer.abstained).toBe(false);
  });

  it('canonicalizes citation metadata from the registry, closing the tier hole', async () => {
    const { registry, id } = makeRegistry();
    const llm = new StubLlmClient();
    llm.enqueue(supportedVerdicts(false));
    const answer = answerWith(modelWrittenCitation(id));
    const out = await verifyAnswer(llm, 'q', answer, registry, {
      dos: '2026-08-25',
      userClientIds: [],
    });
    const cite = out.finalAnswer.published_rules[0]?.citations[0];
    expect(cite?.external_id).toBe('ncci-manual');
    expect(cite?.tier).toBe(2);
    expect(cite?.section_path).toContain('Chiropractic');
    expect(cite?.url).toBe('https://www.cms.gov/x');
    // The model claimed tier 6 on a published rule; canonicalization corrected it
    // before the tier check, so no violation and no abstention.
    expect(out.codeChecks.tierViolations).toEqual([]);
    expect(out.finalAnswer.abstained).toBe(false);
  });

  it('flags a real tier violation using the registry tier, not the claimed one', async () => {
    const registry = new EvidenceRegistry();
    const rec = registry.register({
      document_id: 'doc-note',
      external_id: 'note-1',
      title: 'Call note',
      doc_type: 'call_note',
      publisher: 'us',
      tier: 6,
      section_path: '',
      text: 'A payer rep said so.',
      effective_date: null,
      retired_date: null,
      retrieved_at: '2026-08-25T00:00:00Z',
      version_hash: 'h2',
      url: null,
      client_id: null,
    });
    // The model claims tier 2 on tier 6 evidence to sneak it into a published rule.
    const cite = { ...modelWrittenCitation(rec.evidence_id), tier: 2 as const };
    const llm = new StubLlmClient();
    llm.enqueue(supportedVerdicts(false));
    const out = await verifyAnswer(llm, 'q', answerWith(cite), registry, {
      dos: '2026-08-25',
      userClientIds: [],
    });
    expect(out.codeChecks.tierViolations.length).toBeGreaterThan(0);
    expect(out.finalAnswer.abstained).toBe(true);
  });

  it('withholds the answer when the live verdict pass fails twice', async () => {
    const { registry, id } = makeRegistry();
    let calls = 0;
    const badLive: LlmClient = {
      mode: 'live',
      complete: () => {
        calls += 1;
        return Promise.resolve<LlmResponse>({
          content: [{ type: 'text', text: 'I cannot produce the verdicts right now.' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        });
      },
    };
    const out = await verifyAnswer(badLive, 'q', answerWith(modelWrittenCitation(id)), registry, {
      dos: '2026-08-25',
      userClientIds: [],
    });
    expect(calls).toBe(2);
    expect(out.verdictsUnavailable).toBe(true);
    expect(out.abstainedByVerifier).toBe(true);
    expect(out.finalAnswer.abstained).toBe(true);
    expect(out.finalAnswer.abstain_reason).toContain('verification pass');
  });

  it('keeps running without verdicts in stub mode', async () => {
    const { registry, id } = makeRegistry();
    const llm = new StubLlmClient(); // empty queue returns non-JSON stub text
    const out = await verifyAnswer(llm, 'q', answerWith(modelWrittenCitation(id)), registry, {
      dos: '2026-08-25',
      userClientIds: [],
    });
    expect(out.verdictsUnavailable).toBe(false);
    expect(out.finalAnswer.abstained).toBe(false);
  });
});
