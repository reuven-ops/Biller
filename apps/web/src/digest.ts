// Weekly digest (brief section 12.6): document changes by source and payer, call
// notes expiring within 30 days, and remit cells that crossed the citation floor.
import type { Pool } from '@advisor/db';
import { intEnv } from '@advisor/db';
import { html, type Safe } from './html.js';

export interface WeeklyDigest {
  changes: { source_id: string; payer: string | null; change_type: string; n: number }[];
  expiringNotes: number;
  crossedCells: { payer: string; cpt: string; year: number; claims_n: number }[];
}

export async function weeklyDigest(pool: Pool): Promise<WeeklyDigest> {
  const minN = intEnv('REMIT_MIN_N', 30);
  const [changes, notes, cells] = await Promise.all([
    pool.query<WeeklyDigest['changes'][number]>(
      `SELECT d.source_id, d.payer, c.change_type, count(*)::int AS n
       FROM change_events c JOIN documents d ON d.id = c.document_id
       WHERE c.detected_at > now() - interval '7 days' AND d.client_id IS NULL
       GROUP BY d.source_id, d.payer, c.change_type
       ORDER BY n DESC LIMIT 15`,
    ),
    pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payer_call_notes
       WHERE status <> 'retired' AND expires_on <= now()::date + 30`,
    ),
    pool.query<WeeklyDigest['crossedCells'][number]>(
      `SELECT payer, cpt, year, claims_n FROM remit_behavior
       WHERE claims_n >= $1 AND computed_at > now() - interval '7 days'
       ORDER BY claims_n DESC LIMIT 10`,
      [minN],
    ),
  ]);
  return {
    changes: changes.rows,
    expiringNotes: notes.rows[0]?.n ?? 0,
    crossedCells: cells.rows,
  };
}

export function renderDigest(digest: WeeklyDigest): Safe {
  const empty =
    digest.changes.length === 0 && digest.expiringNotes === 0 && digest.crossedCells.length === 0;
  if (empty) return html`<p class="muted">No changes recorded this week.</p>`;
  return html`
    ${
      digest.changes.length
        ? html`<p>
            ${digest.changes
              .map(
                (c) => `${c.n} ${c.change_type} in ${c.source_id}${c.payer ? ` (${c.payer})` : ''}`,
              )
              .join('; ')}.
          </p>`
        : ''
    }
    ${
      digest.expiringNotes
        ? html`<p>
            <a href="/notes">${digest.expiringNotes} call notes expire within 30 days.</a>
          </p>`
        : ''
    }
    ${
      digest.crossedCells.length
        ? html`<p>
            Remit cells now citable:
            ${digest.crossedCells
              .map((c) => `${c.payer} ${c.cpt} ${c.year} (${c.claims_n} claims)`)
              .join('; ')}.
          </p>`
        : ''
    }
  `;
}
