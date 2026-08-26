// The answer rendering contract from brief section 13.1: sections in tier order,
// citations expandable to the passage text with effective date, retrieval date, and
// link, Copy for appeal from tiers 1 to 4 only, and the feedback buttons.
import type { Answer, Citation, EvidenceRecord } from '@advisor/core';
import { html, raw, type Safe } from './html.js';

const TIER_LABELS: Record<number, string> = {
  1: 'Tier 1, statute and regulation',
  2: 'Tier 2, CMS national policy',
  3: 'Tier 3, MAC local policy',
  4: 'Tier 4, payer published policy',
  5: 'Tier 5, client contract',
  6: 'Tier 6, our call notes',
  7: 'Tier 7, our remittance experience',
};

function fmtDate(value: string | null | undefined): string {
  if (!value) return 'n/a';
  return value.slice(0, 10);
}

function citationBlock(cite: Citation, evidence: Map<string, EvidenceRecord>): Safe {
  const ev = evidence.get(cite.evidence_id);
  const title = ev?.title ?? cite.external_id;
  return html`<details class="cite">
    <summary>
      <span class="tier">T${cite.tier}</span>${title}${
        cite.section_path ? ` | ${cite.section_path}` : ''
      }
      | effective ${fmtDate(cite.effective_date)}
    </summary>
    ${ev ? html`<blockquote>${ev.text}</blockquote>` : html`<p class="muted">Passage text not stored.</p>`}
    <p class="muted">
      ${TIER_LABELS[cite.tier] ?? `Tier ${cite.tier}`} | retrieved ${fmtDate(cite.retrieved_at)}
      ${cite.retired_date ? ` | retired ${fmtDate(cite.retired_date)}` : ''}
      ${cite.url ? html` | <a href="${cite.url}" rel="noopener noreferrer" target="_blank">source</a>` : ''}
    </p>
  </details>`;
}

function cites(list: Citation[], evidence: Map<string, EvidenceRecord>): Safe {
  return html`${list.map((c) => citationBlock(c, evidence))}`;
}

function modifierPills(modifiers: string[]): Safe {
  return html`${modifiers.map((m) => html`<span class="pill">modifier ${m}</span>`)}`;
}

function ratioNote(numerator: number | null, denominator: number | null): Safe {
  if (numerator === null || denominator === null) return html``;
  return html`<span class="muted">(${numerator} of ${denominator})</span>`;
}

/** Appeal text quotes only tiers 1 to 4 (brief hard rule: Copy for appeal). */
export function appealText(answer: Answer, evidence: Map<string, EvidenceRecord>): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const collect = (statement: string, citations: Citation[]) => {
    const kept = citations.filter((c) => c.tier <= 4);
    if (kept.length === 0) return;
    lines.push(statement);
    for (const c of kept) {
      if (seen.has(c.evidence_id)) continue;
      seen.add(c.evidence_id);
      const ev = evidence.get(c.evidence_id);
      const title = ev?.title ?? c.external_id;
      lines.push(
        `  Source: ${title}${c.section_path ? `, ${c.section_path}` : ''} (effective ${fmtDate(c.effective_date)}${c.url ? `, ${c.url}` : ''})`,
      );
      if (ev?.text) lines.push(`  Quote: "${ev.text.slice(0, 600).trim()}"`);
    }
    lines.push('');
  };
  for (const rule of answer.published_rules) collect(rule.statement, rule.citations);
  for (const code of answer.codes)
    collect(
      `${code.code}${code.modifiers.length ? ` with modifier ${code.modifiers.join(', ')}` : ''}`,
      code.citations,
    );
  for (const d of answer.documentation_required) collect(d.element, d.citations);
  return lines.join('\n').trim();
}

export function renderAnswerHtml(opts: {
  answer: Answer;
  evidence: EvidenceRecord[];
  qaId: string | null;
  csrf: string;
  feedbackDone?: string | undefined;
}): Safe {
  const { answer } = opts;
  const evidence = new Map(opts.evidence.map((e) => [e.evidence_id, e]));
  const appeal = appealText(answer, evidence);
  const a = answer.applicability;

  return html`
    <div class="card ${answer.abstained ? 'abstain' : ''}">
      <p class="bottom-line">${answer.bottom_line}</p>
      <p class="muted">
        Applies to: DOS ${a.dos}; ${a.payer}; ${a.jurisdiction}; ${a.provider_type}; ${a.setting};
        client ${a.client ?? 'none'}.
        ${a.defaults_applied.length ? ` Defaults applied: ${a.defaults_applied.join('; ')}.` : ''}
      </p>
      ${
        answer.abstained && answer.abstain_reason
          ? html`<p><strong>Why no answer:</strong> ${answer.abstain_reason}</p>
              ${
                answer.missing_sources.length
                  ? html`<p class="muted">Missing sources: ${answer.missing_sources.join(', ')}</p>`
                  : ''
              }`
          : ''
      }
    </div>

    ${
      answer.codes.length
        ? html`<h2>Codes</h2>
            <div class="card">
              ${answer.codes.map(
                (code) => html`
                  <p>
                    <strong>${code.code}</strong> (${code.code_set}, ${code.role})
                    ${modifierPills(code.modifiers)}
                  </p>
                  ${cites(code.citations, evidence)}
                `,
              )}
            </div>`
        : ''
    }
    ${
      answer.published_rules.length
        ? html`<h2>Published rule</h2>
            <div class="card">
              ${answer.published_rules.map(
                (rule) =>
                  html`<p>${rule.statement}</p>
                    ${cites(rule.citations, evidence)}`,
              )}
            </div>`
        : ''
    }
    ${
      answer.contract_terms.length
        ? html`<h2>Contract terms</h2>
            <div class="card">
              ${answer.contract_terms.map(
                (t) =>
                  html`<p>${t.statement}</p>
                    ${cites(t.citations, evidence)}`,
              )}
            </div>`
        : ''
    }
    ${
      answer.our_experience.length
        ? html`<h2>Our experience</h2>
            <div class="card">
              ${answer.our_experience.map(
                (x) =>
                  html`<p>${x.statement} ${ratioNote(x.numerator, x.denominator)}</p>
                    ${cites(x.citations, evidence)}`,
              )}
            </div>`
        : ''
    }
    ${
      answer.divergence.length
        ? html`<h2>Divergence</h2>
            <div class="card">
              ${answer.divergence.map(
                (d) =>
                  html`<p><strong>${d.payer_or_jurisdiction}:</strong> ${d.differs_how}</p>
                    ${cites(d.citations, evidence)}`,
              )}
            </div>`
        : ''
    }
    ${
      answer.documentation_required.length
        ? html`<h2>Documentation required</h2>
            <div class="card">
              ${answer.documentation_required.map(
                (d) =>
                  html`<p>${d.element}</p>
                    ${cites(d.citations, evidence)}`,
              )}
            </div>`
        : ''
    }
    ${
      answer.what_would_change_this.length
        ? html`<h2>What would change this</h2>
            <div class="card">
              <ul>
                ${answer.what_would_change_this.map((w) => html`<li>${w}</li>`)}
              </ul>
            </div>`
        : ''
    }
    ${
      answer.next_action.type !== 'none'
        ? html`<h2>Next action</h2>
            <div class="card">
              <p>${answer.next_action.type.replace('_', ' ')}</p>
              ${
                answer.next_action.script
                  ? html`<blockquote class="muted">${answer.next_action.script}</blockquote>`
                  : ''
              }
              ${
                answer.next_action.type === 'call_payer'
                  ? html`<p><a href="/notes">Add call note</a></p>`
                  : ''
              }
              ${
                answer.next_action.type === 'request_source' && opts.qaId
                  ? html`<form method="post" action="/q/${opts.qaId}/request-source">
                      <input type="hidden" name="csrf" value="${opts.csrf}" />
                      <button type="submit" class="quiet">Request source</button>
                    </form>`
                  : ''
              }
            </div>`
        : ''
    }

    <h2>Confidence and freshness</h2>
    <div class="card">
      <p><strong>Confidence: ${answer.confidence.level}.</strong> ${answer.confidence.rationale}</p>
      <p class="muted">As of ${fmtDate(answer.freshness.as_of)}.</p>
      ${
        answer.freshness.stale_sources.length
          ? html`<p class="muted">
              Stale sources:
              ${answer.freshness.stale_sources
                .map((s) => `${s.source_id} (last success ${fmtDate(s.last_success_at)})`)
                .join('; ')}
            </p>`
          : ''
      }
    </div>

    ${
      appeal
        ? html`<h2>Copy for appeal</h2>
            <div class="card">
              <p class="muted">
                Published rules only, tiers 1 to 4. Paste into your appeal letter.
              </p>
              <textarea readonly id="appeal-text" rows="8">${appeal}</textarea>
              <p>
                <button
                  type="button"
                  class="quiet"
                  onclick="navigator.clipboard.writeText(document.getElementById('appeal-text').value)"
                >
                  Copy to clipboard
                </button>
              </p>
            </div>`
        : ''
    }
    ${
      opts.qaId
        ? html`<h2>Was this answer right?</h2>
            <div class="card">
              ${
                opts.feedbackDone
                  ? html`<p class="notice">Thanks, feedback recorded: ${opts.feedbackDone}.</p>`
                  : html`<form method="post" action="/q/${opts.qaId}/feedback">
                      <input type="hidden" name="csrf" value="${opts.csrf}" />
                      <label for="fb-note">Optional note</label>
                      <textarea id="fb-note" name="note" rows="2"></textarea>
                      <p>
                        <button name="verdict" value="correct" type="submit">Correct</button>
                        <button name="verdict" value="incorrect" type="submit">Incorrect</button>
                        <button name="verdict" value="partial" type="submit" class="quiet">
                          Partial
                        </button>
                      </p>
                    </form>`
              }
            </div>`
        : ''
    }
    ${raw('')}
  `;
}
