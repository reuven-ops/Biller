import { describe, expect, it } from 'vitest';
import { validateAnswer, abstention, allCitations } from '../src/answer-schema.js';
import type { Answer, Citation } from '../src/answer-schema.js';
import { phiRegexScreen } from '../src/phi.js';
import { normalizeQuestion } from '../src/agent-loop.js';
import { EvidenceRegistry } from '../src/evidence.js';
import { costUsd } from '../src/llm.js';
import { modifierTsquery, queryModifierTokens } from '../src/retrieval.js';

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

function citation(evidenceId: string, tier: Citation['tier']): Citation {
  return {
    evidence_id: evidenceId,
    document_id: 'doc-1',
    external_id: 'ext-1',
    tier,
    section_path: 'sec',
    effective_date: '2026-01-01',
    retired_date: null,
    retrieved_at: '2026-08-25T00:00:00Z',
    url: null,
  };
}

function minimalAnswer(overrides: Partial<Answer> = {}): Answer {
  return {
    bottom_line: 'Test bottom line.',
    applicability: APPLICABILITY,
    codes: [],
    published_rules: [],
    contract_terms: [],
    our_experience: [],
    divergence: [],
    documentation_required: [],
    what_would_change_this: [],
    next_action: { type: 'none', script: null },
    confidence: { level: 'high', rationale: 'test' },
    freshness: FRESHNESS,
    abstained: false,
    abstain_reason: null,
    missing_sources: [],
    ...overrides,
  };
}

describe('answer schema', () => {
  it('accepts a valid answer and rejects a malformed one', () => {
    expect(validateAnswer(minimalAnswer()).ok).toBe(true);
    const bad = validateAnswer({ bottom_line: 42 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toContain('bottom_line');
  });

  it('rejects out-of-range tiers and unknown next_action types', () => {
    const withBadTier = minimalAnswer({
      published_rules: [
        { statement: 's', citations: [{ ...citation('ev_1', 1), tier: 9 as never }] },
      ],
    });
    expect(validateAnswer(withBadTier).ok).toBe(false);
    const withBadAction = minimalAnswer({
      next_action: { type: 'phone_a_friend' as never, script: null },
    });
    expect(validateAnswer(withBadAction).ok).toBe(false);
  });

  it('collects all citations across sections', () => {
    const a = minimalAnswer({
      codes: [
        {
          code: '98940',
          code_set: 'CPT',
          role: 'primary',
          modifiers: ['AT'],
          citations: [citation('ev_1', 2)],
        },
      ],
      published_rules: [{ statement: 's', citations: [citation('ev_2', 2)] }],
      our_experience: [
        { statement: 'o', numerator: 1, denominator: 2, citations: [citation('ev_3', 7)] },
      ],
    });
    expect(allCitations(a).map((c) => c.evidence_id)).toEqual(['ev_1', 'ev_2', 'ev_3']);
  });

  it('abstention helper produces a valid answer', () => {
    const a = abstention(APPLICABILITY, 'nothing retrieved', ['payer_policies'], FRESHNESS);
    expect(validateAnswer(a).ok).toBe(true);
    expect(a.abstained).toBe(true);
    expect(a.missing_sources).toEqual(['payer_policies']);
  });
});

describe('phi regex screen', () => {
  it('flags SSN, DOB, member id, MRN, and patient name patterns', () => {
    expect(phiRegexScreen('SSN 123-45-6789')).toContain('ssn');
    expect(phiRegexScreen('patient DOB: 01/02/1980 needs 97110')).toContain('dob');
    expect(phiRegexScreen('member ID: ABC123456 denied')).toContain('member_id');
    expect(phiRegexScreen('MRN: 99881122')).toContain('mrn');
    expect(phiRegexScreen('Patient John Smith was seen for 98940')).toContain('name');
  });

  it('does not flag ordinary coding questions', () => {
    expect(phiRegexScreen('Is 97140 payable with 98940 for a Medicare patient?')).toEqual([]);
    expect(phiRegexScreen('What is the KX threshold for CY 2026?')).toEqual([]);
  });
});

describe('question normalization', () => {
  it('applies brief section 3 defaults and records them', () => {
    const n = normalizeQuestion({ question: 'Is 97140 payable with 98940?' });
    expect(n.dos).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(n.payer).toBe('Medicare Part B');
    expect(n.jurisdiction).toBe('FL');
    expect(n.setting).toBe('office, POS 11');
    expect(n.defaultsApplied.length).toBeGreaterThanOrEqual(3);
    expect(n.codesMentioned).toEqual(expect.arrayContaining(['97140', '98940']));
  });

  it('honors explicit values without recording defaults for them', () => {
    const n = normalizeQuestion({
      question: 'q',
      dos: '2025-06-15',
      payer: 'Aetna',
      jurisdiction: 'TX',
    });
    expect(n.dos).toBe('2025-06-15');
    expect(n.payer).toBe('Aetna');
    expect(n.defaultsApplied.join(' ')).not.toContain('DOS defaulted');
  });
});

describe('evidence registry', () => {
  it('issues unique ids and tracks totals', () => {
    const r = new EvidenceRegistry();
    const a = r.register({
      document_id: 'd',
      external_id: 'e',
      title: 't',
      doc_type: 'x',
      publisher: 'p',
      tier: 2,
      section_path: 's',
      text: 'hello world',
      effective_date: null,
      retired_date: null,
      retrieved_at: '2026-08-25T00:00:00Z',
      version_hash: 'h',
      url: null,
      client_id: null,
    });
    expect(r.has(a.evidence_id)).toBe(true);
    expect(r.get('ev_nope')).toBeUndefined();
    expect(r.totalTextLength()).toBe(11);
  });
});

describe('cost accounting', () => {
  it('prices by model family', () => {
    expect(costUsd('claude-sonnet-5', 1_000_000, 0)).toBe(2);
    expect(costUsd('claude-haiku-4-5-20251001', 0, 1_000_000)).toBe(5);
    expect(costUsd('claude-opus-5', 1_000_000, 1_000_000)).toBe(30);
  });
});

describe('modifier token extraction for the exact-search arm', () => {
  it('finds known modifiers named next to the word modifier, either side', () => {
    expect(queryModifierTokens('Which visits need the AT modifier for Medicare?')).toEqual(['at']);
    expect(queryModifierTokens('Is modifier KX required above the threshold?')).toEqual(['kx']);
    expect(queryModifierTokens('modifier 59 vs XS modifier for 97140')).toEqual(
      expect.arrayContaining(['59', 'xs']),
    );
  });

  it('ignores two-letter words that are not billing modifiers', () => {
    expect(queryModifierTokens('is a modifier needed on this claim')).toEqual([]);
    expect(queryModifierTokens('no modifier applies here')).toEqual([]);
    expect(queryModifierTokens('what does the manual say about modifiers')).toEqual([]);
  });

  it('builds a phrase-adjacency tsquery, empty for no tokens', () => {
    expect(modifierTsquery([])).toBe('');
    const q = modifierTsquery(['at']);
    expect(q).toContain('(at <-> modifier)');
    expect(q).toContain('(modifier <-> at)');
    expect(q).not.toContain('&');
  });
});
