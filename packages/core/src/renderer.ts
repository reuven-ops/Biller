// Terminal renderer for answers: sections in tier order with citations
// (brief section 13.1 rendering rules, CLI form).
import type { Answer, Citation } from './answer-schema.js';

function cite(c: Citation): string {
  return (
    `[${c.evidence_id} | tier ${c.tier} | ${c.external_id} | ${c.section_path}` +
    `${c.effective_date ? ` | effective ${c.effective_date}` : ''}]`
  );
}

function section(title: string, lines: string[]): string {
  if (lines.length === 0) return '';
  return `\n${title}\n${'-'.repeat(title.length)}\n${lines.join('\n')}\n`;
}

export function renderAnswer(answer: Answer): string {
  const parts: string[] = [];
  parts.push(`Bottom line: ${answer.bottom_line}\n`);
  const a = answer.applicability;
  parts.push(
    `Applies to: DOS ${a.dos}; ${a.payer}; ${a.jurisdiction}; ${a.provider_type}; ${a.setting}` +
      `${a.client ? `; client ${a.client}` : ''}`,
  );
  if (a.defaults_applied.length > 0) {
    parts.push(`Defaults applied: ${a.defaults_applied.join('; ')}`);
  }
  if (answer.abstained) {
    parts.push(`\nAbstained: ${answer.abstain_reason ?? 'no reason recorded'}`);
    if (answer.missing_sources.length > 0) {
      parts.push(`Missing sources: ${answer.missing_sources.join(', ')}`);
    }
  }
  parts.push(
    section(
      'Codes',
      answer.codes.map(
        (c) =>
          `${c.code} (${c.code_set}, ${c.role})${c.modifiers.length ? ` with modifiers ${c.modifiers.join(', ')}` : ''} ` +
          c.citations.map(cite).join(' '),
      ),
    ),
  );
  parts.push(
    section(
      'Published rule',
      answer.published_rules.map((s) => `${s.statement} ${s.citations.map(cite).join(' ')}`),
    ),
  );
  parts.push(
    section(
      'Contract terms',
      answer.contract_terms.map((s) => `${s.statement} ${s.citations.map(cite).join(' ')}`),
    ),
  );
  parts.push(
    section(
      'Our experience',
      answer.our_experience.map(
        (s) =>
          `${s.statement}${s.numerator !== null && s.denominator !== null ? ` (${s.numerator} of ${s.denominator})` : ''} ` +
          s.citations.map(cite).join(' '),
      ),
    ),
  );
  parts.push(
    section(
      'Divergence',
      answer.divergence.map(
        (d) => `${d.payer_or_jurisdiction}: ${d.differs_how} ${d.citations.map(cite).join(' ')}`,
      ),
    ),
  );
  parts.push(
    section(
      'Documentation required',
      answer.documentation_required.map((d) => `${d.element} ${d.citations.map(cite).join(' ')}`),
    ),
  );
  parts.push(
    section(
      'What would change this',
      answer.what_would_change_this.map((w) => `- ${w}`),
    ),
  );
  if (answer.next_action.type !== 'none') {
    parts.push(`\nNext action: ${answer.next_action.type}`);
    if (answer.next_action.script) parts.push(answer.next_action.script);
  }
  parts.push(`\nConfidence: ${answer.confidence.level}. ${answer.confidence.rationale}`);
  if (answer.freshness.stale_sources.length > 0) {
    parts.push(
      `\nWARNING, stale sources: ` +
        answer.freshness.stale_sources
          .map(
            (s) =>
              `${s.source_id} (last success ${s.last_success_at}, cadence ${s.cadence_days} days)`,
          )
          .join('; '),
    );
  }
  parts.push(`As of ${answer.freshness.as_of}.`);
  return parts.filter((p) => p.length > 0).join('\n');
}
