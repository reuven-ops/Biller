// Sources page (brief section 13.4): freshness by source, run now (admin),
// change digest, and the source requests queue. Uploads land in Phase 4.
import type { Pool } from '@advisor/db';
import { auditAdminAction } from '../auth.js';
import { html, layout } from '../html.js';
import { redirect, sendHtml, type Handler, type Router } from '../http.js';

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

export function registerSourcesRoutes(router: Router, pool: Pool, authed: Authed): void {
  router.get(
    '/sources',
    authed('biller', async (ctx) => {
      const [sources, changes, requests] = await Promise.all([
        pool.query<{
          id: string;
          name: string;
          tier: number;
          cadence_days: number;
          last_success_at: Date | null;
          last_error: string | null;
          run_requested_at: Date | null;
          stale: boolean;
        }>(
          `SELECT id, name, tier, cadence_days, last_success_at, last_error, run_requested_at,
                  (last_error IS NOT NULL OR last_success_at IS NULL
                   OR now() - last_success_at > (cadence_days * interval '1 day') * 1.5) AS stale
           FROM sources WHERE enabled ORDER BY tier, id`,
        ),
        pool.query<{
          detected_at: Date;
          change_type: string;
          title: string;
          diff_summary: string | null;
        }>(
          `SELECT c.detected_at, c.change_type, d.title, c.diff_summary
           FROM change_events c JOIN documents d ON d.id = c.document_id
           WHERE d.client_id IS NULL
           ORDER BY c.detected_at DESC LIMIT 25`,
        ),
        pool.query<{
          id: string;
          ts: Date;
          payer_or_source: string;
          note: string | null;
          status: string;
          email: string | null;
        }>(
          `SELECT r.id, r.ts, r.payer_or_source, r.note, r.status, u.email
           FROM source_requests r LEFT JOIN users u ON u.id = r.requested_by
           ORDER BY r.ts DESC LIMIT 25`,
        ),
      ]);
      sendHtml(
        ctx,
        200,
        layout({
          title: 'Sources',
          user: ctx.user,
          active: '/sources',
          csrf: ctx.csrf,
          body: html`
            <h1>Sources and freshness</h1>
            <div class="card">
              <table>
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Tier</th>
                    <th>Cadence</th>
                    <th>Last success</th>
                    <th>Status</th>
                    ${ctx.user.role === 'admin' ? html`<th></th>` : ''}
                  </tr>
                </thead>
                <tbody>
                  ${sources.rows.map(
                    (s) => html`
                      <tr>
                        <td>${s.name}<br /><span class="muted">${s.id}</span></td>
                        <td>${s.tier}</td>
                        <td>${s.cadence_days}d</td>
                        <td>
                          ${s.last_success_at?.toISOString().slice(0, 16).replace('T', ' ') ?? 'never'}
                        </td>
                        <td>
                          ${
                            s.last_error
                              ? html`<span class="pill" style="background:#fbe9e7">error</span>`
                              : s.stale
                                ? html`<span class="pill" style="background:#fff3cd">stale</span>`
                                : html`<span class="pill" style="background:#e6f4ea">fresh</span>`
                          }
                          ${s.run_requested_at ? html`<span class="pill">run queued</span>` : ''}
                        </td>
                        ${
                          ctx.user.role === 'admin'
                            ? html`<td>
                                <form method="post" action="/sources/${s.id}/run" class="inline">
                                  <input type="hidden" name="csrf" value="${ctx.csrf}" />
                                  <button type="submit" class="quiet">Run now</button>
                                </form>
                              </td>`
                            : ''
                        }
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
              <p class="muted">
                Run now queues the source for the worker's next scheduler pass (within 15 minutes).
              </p>
            </div>

            <h2>Change digest, latest 25</h2>
            <div class="card">
              ${
                changes.rows.length === 0
                  ? html`<p class="muted">No changes recorded yet.</p>`
                  : html`<table>
                      <tbody>
                        ${changes.rows.map(
                          (c) => html`
                            <tr>
                              <td>${c.detected_at.toISOString().slice(0, 10)}</td>
                              <td><span class="pill">${c.change_type}</span></td>
                              <td>${c.title.slice(0, 90)}</td>
                              <td class="muted">${(c.diff_summary ?? '').slice(0, 80)}</td>
                            </tr>
                          `,
                        )}
                      </tbody>
                    </table>`
              }
            </div>

            <h2>Source requests</h2>
            <div class="card">
              ${
                requests.rows.length === 0
                  ? html`<p class="muted">
                      No requests. The Request source button appears on abstained answers.
                    </p>`
                  : html`<table>
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>Requested</th>
                          <th>Note</th>
                          <th>By</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${requests.rows.map(
                          (r) => html`
                            <tr>
                              <td>${r.ts.toISOString().slice(0, 10)}</td>
                              <td>${r.payer_or_source.slice(0, 60)}</td>
                              <td class="muted">${(r.note ?? '').slice(0, 70)}</td>
                              <td>${r.email ?? ''}</td>
                              <td><span class="pill">${r.status}</span></td>
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

  router.post(
    '/sources/:id/run',
    authed('admin', async (ctx) => {
      const id = ctx.params['id'] ?? '';
      const res = await pool.query('UPDATE sources SET run_requested_at = now() WHERE id = $1', [
        id,
      ]);
      if (res.rowCount) await auditAdminAction(pool, ctx.user.id, 'source_run_now', { source: id });
      redirect(ctx, '/sources');
    }),
  );
}
