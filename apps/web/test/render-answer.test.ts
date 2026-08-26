import { describe, expect, it } from 'vitest';
import type { Answer, Citation, EvidenceRecord } from '@advisor/core';
import { appealText, renderAnswerHtml } from '../src/render-answer.js';

function cite(id: string, tier: Citation['tier']): Citation {
  return {
    evidence_id: id,
    document_id: 'doc-1',
    external_id: 'ext-1',
    tier,
    section_path: 'Ch.1 > S.2',
    effective_date: '2026-01-01',
    retired_date: null,
    retrieved_at: '2026-08-25T00:00:00Z',
    url: 'https://www.cms.gov/example',
  };
}

function evidence(id: string, text: string): EvidenceRecord {
  return {
    evidence_id: id,
    document_id: 'doc-1',
    external_id: 'ext-1',
    title: 'NCCI Policy Manual',
    doc_type: 'manual',
    publisher: 'CMS',
    tier: 2,
    section_path: 'Ch.1 > S.2',
    text,
    effective_date: '2026-01-01',
    retired_date: null,
    retrieved_at: '2026-08-25T00:00:00Z',
    version_hash: 'abc',
    url: 'https://www.cms.gov/example',
    client_id: null,
  };
}

function baseAnswer(): Answer {
  return {
    bottom_line: 'Yes, with modifier 59 in a different region.',
    applicability: {
      dos: '2026-08-01',
      payer: 'Medicare Part B',
      jurisdiction: 'JN',
      provider_type: 'DC',
      setting: 'office, POS 11',
      client: null,
      defaults_applied: [],
    },
    codes: [],
    published_rules: [
      { statement: 'A tier 2 rule statement.', citations: [cite('ev_t2', 2)] },
      { statement: 'A call note statement.', citations: [cite('ev_t6', 6)] },
    ],
    contract_terms: [],
    our_experience: [],
    divergence: [],
    documentation_required: [],
    what_would_change_this: [],
    next_action: { type: 'none', script: null },
    confidence: { level: 'high', rationale: 'Direct citation.' },
    freshness: { as_of: '2026-08-25', stale_sources: [] },
    abstained: false,
    abstain_reason: null,
    missing_sources: [],
  };
}

describe('appealText', () => {
  it('includes tiers 1 to 4 only', () => {
    const text = appealText(
      baseAnswer(),
      new Map([['ev_t2', evidence('ev_t2', 'The rule text.')]]),
    );
    expect(text).toContain('A tier 2 rule statement.');
    expect(text).toContain('The rule text.');
    expect(text).not.toContain('call note');
  });

  it('is empty when only tier 5 to 7 evidence exists', () => {
    const answer = baseAnswer();
    answer.published_rules = [{ statement: 'Note-only claim.', citations: [cite('ev_t6', 6)] }];
    expect(appealText(answer, new Map())).toBe('');
  });
});

describe('renderAnswerHtml', () => {
  it('renders sections, escapes content, and expands citations', () => {
    const answer = baseAnswer();
    answer.bottom_line = 'Bold <script>alert(1)</script> claim';
    const out = renderAnswerHtml({
      answer,
      evidence: [evidence('ev_t2', 'Quoted <passage> text')],
      qaId: 'qa-1',
      csrf: 'token',
    }).value;
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>alert');
    expect(out).toContain('Quoted &lt;passage&gt; text');
    expect(out).toContain('T2');
    expect(out).toContain('/q/qa-1/feedback');
    expect(out).toContain('Copy for appeal');
  });

  it('marks abstentions and shows the reason', () => {
    const answer = baseAnswer();
    answer.abstained = true;
    answer.abstain_reason = 'No supporting evidence for the payer.';
    answer.published_rules = [];
    const out = renderAnswerHtml({ answer, evidence: [], qaId: null, csrf: 't' }).value;
    expect(out).toContain('Why no answer');
    expect(out).toContain('No supporting evidence for the payer.');
    expect(out).not.toContain('Copy for appeal');
  });
});
