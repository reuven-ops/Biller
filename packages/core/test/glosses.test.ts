// D14 gloss drafting: grounded only, honest when evidence is thin.
import { describe, expect, it } from 'vitest';
import { EvidenceRegistry } from '../src/evidence.js';
import { StubLlmClient, type LlmResponse } from '../src/llm.js';
import { draftGlossFromEvidence } from '../src/glosses.js';

function makeEvidence(text: string) {
  const registry = new EvidenceRegistry();
  return registry.register({
    document_id: 'doc-1',
    external_id: 'iom-100-04-ch22',
    title: 'Medicare Claims Processing Manual, Chapter 22',
    doc_type: 'manual',
    publisher: 'CMS',
    tier: 2,
    section_path: '60.1 Group Codes',
    text,
    effective_date: null,
    retired_date: null,
    retrieved_at: '2026-08-25T00:00:00Z',
    version_hash: 'h1',
    url: 'https://www.cms.gov/x',
    client_id: null,
  });
}

const reply = (obj: unknown) => () =>
  Promise.resolve<LlmResponse>({
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  });

describe('draftGlossFromEvidence', () => {
  it('drafts a grounded gloss carrying the used evidence with quotes', async () => {
    const ev = makeEvidence(
      'CO - Contractual Obligations. This group code shall be used when a contractual agreement resulted in an adjustment.',
    );
    const llm = new StubLlmClient();
    llm.enqueue(
      reply({
        gloss:
          'CO means the provider absorbs the adjustment under its contract; the patient cannot be billed for it.',
        evidence_ids: [ev.evidence_id],
      }),
    );
    const draft = await draftGlossFromEvidence(llm, 'group', 'CO', [ev]);
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.gloss).toContain('contract');
    expect(draft.evidence[0]?.external_id).toBe('iom-100-04-ch22');
    expect(draft.evidence[0]?.quote).toContain('Contractual Obligations');
    expect(draft.evidence[0]?.version_hash).toBe('h1');
  });

  it('returns an honest gap when the model says the evidence does not identify the code', async () => {
    const ev = makeEvidence('Unrelated remittance prose.');
    const llm = new StubLlmClient();
    llm.enqueue(reply({ gloss: null, reason: 'no excerpt defines CARC 252', evidence_ids: [] }));
    const draft = await draftGlossFromEvidence(llm, 'carc', '252', [ev]);
    expect(draft.ok).toBe(false);
    if (!draft.ok) expect(draft.reason).toContain('252');
  });

  it('rejects a draft whose cited evidence ids were not provided', async () => {
    const ev = makeEvidence('CO - Contractual Obligations.');
    const llm = new StubLlmClient();
    llm.enqueue(reply({ gloss: 'A made-up claim.', evidence_ids: ['ev_not-provided'] }));
    const draft = await draftGlossFromEvidence(llm, 'group', 'CO', [ev]);
    expect(draft.ok).toBe(false);
  });

  it('skips without calling the model when no evidence exists', async () => {
    const llm = new StubLlmClient();
    const draft = await draftGlossFromEvidence(llm, 'carc', '999', []);
    expect(draft.ok).toBe(false);
    expect(llm.requests).toHaveLength(0);
  });
});
