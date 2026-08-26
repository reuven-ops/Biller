// History (brief section 13.2): my questions, team questions searchable by payer,
// code, and text. Client-scoped answers stay hidden from users outside the client.
import type { Pool } from '@advisor/db';
import { html, layout } from '../html.js';
import { sendHtml, type Handler, type Router } from '../http.js';

interface AuthedLike {
  user: {
    id: string;
    email: string;
    name: string;
    role: 'biller' | 'lead' | 'admin';
    clientIds: string[];
  };
  csrf: string;
}
type Authed = (
  minRole: 'biller' | 'lead' | 'admin',
  handler: (ctx: AuthedLike & Parameters<Handler>[0]) => Promise<void> | void,
) => Handler;

interface HistoryRow {
  id: string;
  ts: Date;
  question_text: string | null;
  payer: string | null;
  dos: string | null;
  email: string | null;
  abstained: boolean;
  phi_flag: boolean;
  verdicts: string[] | null;
}

export function registerHistoryRoutes(router: Router, pool: Pool, authed: Authed): void {
  router.get(
    '/history',
    authed('biller', async (ctx) => {
      const mine = ctx.query.get('scope') === 'mine';
      const q = (ctx.query.get('q') ?? '').trim();
      const payer = (ctx.query.get('payer') ?? '').trim();

      const where: string[] = [];
      const params: unknown[] = [];
      if (mine) {
        params.push(ctx.user.id);
        where.push(`q.user_id = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        where.push(`q.question_text ILIKE $${params.length}`);
      }
      if (payer) {
        params.push(`%${payer}%`);
        where.push(`q.payer ILIKE $${params.length}`);
      }
      // Client-scoped rows are visible only to assigned users (admins see all).
      if (ctx.user.role !== 'admin') {
        params.push(ctx.user.clientIds);
        where.push(`(q.client_id IS NULL OR q.client_id = ANY($${params.length}))`);
      }
      const sql = `
        SELECT q.id, q.ts, q.question_text, q.payer, q.dos::text AS dos, u.email,
               q.abstained, q.phi_flag,
               array_remove(array_agg(f.verdict), NULL) AS verdicts
        FROM qa_log q
        LEFT JOIN users u ON u.id = q.user_id
        LEFT JOIN qa_feedback f ON f.qa_id = q.id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY q.id, u.email
        ORDER BY q.ts DESC
        LIMIT 100`;
      const res = await pool.query<HistoryRow>(sql, params);

      sendHtml(
        ctx,
        200,
        layout({
          title: 'History',
          user: ctx.user,
          active: '/history',
          csrf: ctx.csrf,
          body: html`
            <h1>Question history</h1>
            <div class="card">
              <form method="get" action="/history">
                <div class="row">
                  <div>
                    <label for="q">Search text or code</label>
                    <input id="q" name="q" type="text" value="${q}" />
                  </div>
                  <div>
                    <label for="payer">Payer</label>
                    <input id="payer" name="payer" type="text" value="${payer}" />
                  </div>
                  <div>
                    <label for="scope">Scope</label>
                    <select id="scope" name="scope">
                      <option value="team" ${mine ? '' : 'selected'}>Team</option>
                      <option value="mine" ${mine ? 'selected' : ''}>Mine</option>
                    </select>
                  </div>
                </div>
                <p><button type="submit" class="quiet">Search</button></p>
              </form>
            </div>
            <div class="card">
              ${
                res.rows.length === 0
                  ? html`<p class="muted">No questions match.</p>`
                  : html`<table>
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>Question</th>
                          <th>Payer</th>
                          <th>DOS</th>
                          <th>Asked by</th>
                          <th>Feedback</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${res.rows.map(
                          (r) => html`
                            <tr>
                              <td>${r.ts.toISOString().slice(0, 16).replace('T', ' ')}</td>
                              <td>
                                ${
                                  r.phi_flag
                                    ? html`<span class="muted">refused, PHI</span>`
                                    : html`<a href="/q/${r.id}"
                                        >${(r.question_text ?? '').slice(0, 110)}</a
                                      >`
                                }
                                ${r.abstained ? html` <span class="pill">abstained</span>` : ''}
                              </td>
                              <td>${r.payer ?? ''}</td>
                              <td>${r.dos ?? ''}</td>
                              <td>${r.email ?? 'system'}</td>
                              <td>${(r.verdicts ?? []).join(', ')}</td>
                            </tr>
                          `,
                        )}
                      </tbody>
                    </table>`
              }
            </div>
          `,
        }),
      );
    }),
  );
}
