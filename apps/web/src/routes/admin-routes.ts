// Admin page (brief section 13.5): users and roles, invites, client assignments,
// cost against the cap, model and prompt versions. Remit import and eval run
// management land in Phase 4.
import { intEnv } from '@advisor/db';
import type { Pool } from '@advisor/db';
import {
  createLlmClient,
  draftMissingGlosses,
  flagStaleGlosses,
  modelConfig,
  promptVersion,
} from '@advisor/core';
import { importRemitCsv } from '@advisor/ingest';
import { auditAdminAction, createInvite } from '../auth.js';
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

const ROLES = ['biller', 'lead', 'admin'] as const;

// One drafting run at a time; retrieval and drafting take minutes on CPU.
let glossRun: { startedAt: number; done: boolean; message: string } | null = null;

export function registerAdminRoutes(router: Router, pool: Pool, authed: Authed): void {
  router.get(
    '/admin',
    authed('admin', async (ctx) => {
      const invited = ctx.query.get('invited');
      const inviteToken = ctx.query.get('token');
      const remitMessage = ctx.query.get('remit');
      const remitOk = ctx.query.get('remit_ok') === '1';
      const [users, cost, clients, imports, glosses] = await Promise.all([
        pool.query<{
          id: string;
          email: string;
          name: string;
          role: string;
          status: string;
          last_login_at: Date | null;
          clients: string[] | null;
        }>(
          `SELECT u.id, u.email, u.name, u.role, u.status, u.last_login_at,
                  array_remove(array_agg(c.name), NULL) AS clients
           FROM users u
           LEFT JOIN user_clients uc ON uc.user_id = u.id
           LEFT JOIN clients c ON c.id = uc.client_id
           GROUP BY u.id ORDER BY u.email`,
        ),
        pool.query<{ today: string; month: string }>(
          `SELECT coalesce(sum(cost_usd) FILTER (WHERE ts::date = now()::date), 0)::numeric(10,2) AS today,
                  coalesce(sum(cost_usd) FILTER (WHERE date_trunc('month', ts) = date_trunc('month', now())), 0)::numeric(10,2) AS month
           FROM qa_log`,
        ),
        pool.query<{ id: string; name: string }>(
          'SELECT id, name FROM clients WHERE active ORDER BY name',
        ),
        pool.query<{
          filename: string;
          rows_in: number;
          rows_rejected: number;
          cells_written: number;
          imported_at: Date;
          email: string | null;
        }>(
          `SELECT r.filename, r.rows_in, r.rows_rejected, r.cells_written, r.imported_at, u.email
           FROM remit_imports r LEFT JOIN users u ON u.id = r.imported_by
           ORDER BY r.imported_at DESC LIMIT 10`,
        ),
        pool.query<{
          id: string;
          code_type: string;
          code: string;
          gloss: string;
          status: string;
          needs_review: boolean;
          evidence_titles: string;
        }>(
          `SELECT id, code_type, code, gloss, status, needs_review,
                  (SELECT string_agg(DISTINCT ev->>'title', '; ')
                   FROM jsonb_array_elements(evidence) ev) AS evidence_titles
           FROM code_glosses ORDER BY needs_review DESC, code_type, code LIMIT 100`,
        ),
      ]);
      const cap = intEnv('DAILY_COST_CAP_USD', 25);
      const models = modelConfig();
      sendHtml(
        ctx,
        200,
        layout({
          title: 'Admin',
          user: ctx.user,
          active: '/admin',
          csrf: ctx.csrf,
          body: html`
            <h1>Admin</h1>
            ${
              invited && inviteToken
                ? html`<div class="notice">
                    Invite created for ${invited}. Send this link, valid 7 days:<br />
                    <code>/invite/${inviteToken}</code>
                  </div>`
                : ''
            }

            <h2>Cost</h2>
            <div class="card">
              <p>
                Today: <strong>$${Number(cost.rows[0]?.today ?? 0).toFixed(2)}</strong> of the
                $${cap} daily cap. This month:
                <strong>$${Number(cost.rows[0]?.month ?? 0).toFixed(2)}</strong>.
              </p>
              <p class="muted">
                Models: composer ${models.composer}, verifier ${models.verifier}, light
                ${models.light}. Prompts: composer v${promptVersion('composer.md')}, verifier
                v${promptVersion('verifier.md')}, phi v${promptVersion('phi_screen.md')}.
              </p>
            </div>

            <h2>Users</h2>
            <div class="card">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Clients</th>
                    <th>Last login</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${users.rows.map(
                    (u) => html`
                      <tr>
                        <td>${u.email}</td>
                        <td>${u.name}</td>
                        <td>
                          <form method="post" action="/admin/users/${u.id}/role" class="inline">
                            <input type="hidden" name="csrf" value="${ctx.csrf}" />
                            <select
                              name="role"
                              onchange="this.form.submit()"
                              ${u.id === ctx.user.id ? 'disabled' : ''}
                            >
                              ${ROLES.map(
                                (r) =>
                                  html`<option value="${r}" ${r === u.role ? 'selected' : ''}>
                                    ${r}
                                  </option>`,
                              )}
                            </select>
                          </form>
                        </td>
                        <td>${u.status}</td>
                        <td>${(u.clients ?? []).join(', ')}</td>
                        <td class="muted">
                          ${u.last_login_at?.toISOString().slice(0, 10) ?? 'never'}
                        </td>
                        <td>
                          ${
                            u.id !== ctx.user.id
                              ? html`<form
                                  method="post"
                                  action="/admin/users/${u.id}/status"
                                  class="inline"
                                >
                                  <input type="hidden" name="csrf" value="${ctx.csrf}" />
                                  <button type="submit" class="quiet">
                                    ${u.status === 'disabled' ? 'Enable' : 'Disable'}
                                  </button>
                                </form>`
                              : ''
                          }
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>

            <h2>Invite a user</h2>
            <div class="card" style="max-width: 30rem">
              <form method="post" action="/admin/invites">
                <input type="hidden" name="csrf" value="${ctx.csrf}" />
                <label for="inv-email">Email</label>
                <input id="inv-email" name="email" type="email" required />
                <label for="inv-role">Role</label>
                <select id="inv-role" name="role">
                  ${ROLES.map((r) => html`<option value="${r}">${r}</option>`)}
                </select>
                <p><button type="submit">Create invite link</button></p>
              </form>
            </div>

            <h2>Client assignments</h2>
            <div class="card">
              ${
                clients.rows.length === 0
                  ? html`<p class="muted">
                      No clients yet. Clients and contract uploads arrive with Phase 4.
                    </p>`
                  : html`<form method="post" action="/admin/assign">
                      <input type="hidden" name="csrf" value="${ctx.csrf}" />
                      <div class="row">
                        <div>
                          <label for="as-user">User</label>
                          <select id="as-user" name="user_id">
                            ${users.rows.map((u) => html`<option value="${u.id}">${u.email}</option>`)}
                          </select>
                        </div>
                        <div>
                          <label for="as-client">Client</label>
                          <select id="as-client" name="client_id">
                            ${clients.rows.map(
                              (c) => html`<option value="${c.id}">${c.name}</option>`,
                            )}
                          </select>
                        </div>
                        <div>
                          <label for="as-op">Action</label>
                          <select id="as-op" name="op">
                            <option value="add">Assign</option>
                            <option value="remove">Unassign</option>
                          </select>
                        </div>
                      </div>
                      <p><button type="submit" class="quiet">Apply</button></p>
                    </form>`
              }
            </div>

            <h2>Remittance import</h2>
            <div class="card">
              ${
                remitMessage
                  ? html`<div class="${remitOk ? 'notice' : 'error'}">${remitMessage}</div>`
                  : ''
              }
              <form method="post" action="/admin/remit" enctype="multipart/form-data">
                <input type="hidden" name="csrf" value="${ctx.csrf}" />
                <label for="remit-file">De-identified claim line CSV (Appendix B contract)</label>
                <input id="remit-file" name="remit" type="file" accept=".csv,text/csv" required />
                <p><button type="submit">Import</button></p>
                <p class="muted">
                  A file carrying any patient identifier column or value is rejected whole. Rows
                  aggregate into remittance cells; the raw file is discarded after aggregation.
                  Cells under REMIT_MIN_N claims are stored but never cited.
                </p>
              </form>
              ${
                imports.rows.length
                  ? html`<table>
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>File</th>
                          <th>Rows in</th>
                          <th>Rejected</th>
                          <th>Cells</th>
                          <th>By</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${imports.rows.map(
                        (r) => html`
                          <tr>
                            <td>${r.imported_at.toISOString().slice(0, 16).replace('T', ' ')}</td>
                            <td>${r.filename}</td>
                            <td>${r.rows_in}</td>
                            <td>${r.rows_rejected}</td>
                            <td>${r.cells_written}</td>
                            <td>${r.email ?? ''}</td>
                          </tr>
                        `,
                      )}
                      </tbody>
                    </table>`
                  : ''
              }
            </div>

            <h2>Denial code glosses</h2>
            <div class="card">
              <p class="muted">
                Plain-language explanations of CARC, RARC, and group codes, drafted only from
                evidence in the public corpus (DECISIONS.md D14). Drafts need lead approval before
                remit views show them; codes without public evidence stay honest gaps.
              </p>
              ${
                glossRun && !glossRun.done
                  ? html`<div class="notice">
                      Drafting run in progress; refresh in a few minutes.
                    </div>`
                  : glossRun
                    ? html`<div class="notice">${glossRun.message}</div>`
                    : ''
              }
              <form method="post" action="/admin/glosses/draft" class="inline">
                <input type="hidden" name="csrf" value="${ctx.csrf}" />
                <button type="submit" class="quiet">Draft missing glosses</button>
              </form>
              ${
                glosses.rows.length
                  ? html`<table>
                      <thead>
                        <tr>
                          <th>Code</th>
                          <th>Gloss</th>
                          <th>Status</th>
                          <th>Evidence</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        ${glosses.rows.map(
                        (g) => html`
                          <tr>
                            <td>${g.code_type.toUpperCase()} ${g.code}</td>
                            <td>${g.gloss}</td>
                            <td>
                              <span class="pill">${g.status}</span>
                              ${g.needs_review ? html`<span class="pill" style="background:#fff3cd">source changed</span>` : ''}
                            </td>
                            <td class="muted">${g.evidence_titles}</td>
                            <td>
                              ${
                                g.status === 'draft' || g.needs_review
                                  ? html`<form
                                      class="inline"
                                      method="post"
                                      action="/admin/glosses/${g.id}/approve"
                                    >
                                      <input type="hidden" name="csrf" value="${ctx.csrf}" />
                                      <button class="quiet" type="submit">Approve</button>
                                    </form>`
                                  : ''
                              }
                              ${
                                g.status !== 'retired'
                                  ? html`<form
                                      class="inline"
                                      method="post"
                                      action="/admin/glosses/${g.id}/retire"
                                    >
                                      <input type="hidden" name="csrf" value="${ctx.csrf}" />
                                      <button class="quiet" type="submit">Retire</button>
                                    </form>`
                                  : ''
                              }
                            </td>
                          </tr>
                        `,
                      )}
                      </tbody>
                    </table>`
                  : html`<p class="muted">No glosses yet. Import remit data, then draft.</p>`
              }
            </div>

            <p class="muted">Eval run management arrives with Phase 6 hardening.</p>
          `,
        }),
      );
    }),
  );

  router.post(
    '/admin/remit',
    authed('admin', async (ctx) => {
      const file = ctx.files.find((f) => f.field === 'remit');
      if (!file) {
        redirect(ctx, `/admin?remit=${encodeURIComponent('Choose a CSV file to import.')}`);
        return;
      }
      const outcome = await importRemitCsv(pool, file.data, file.filename, ctx.user.id);
      await auditAdminAction(pool, ctx.user.id, 'remit_import', {
        filename: file.filename,
        ok: outcome.ok,
        rowsIn: outcome.rowsIn ?? 0,
        rowsRejected: outcome.rowsRejected ?? 0,
      });
      const detail = outcome.rejects?.length
        ? ` First rejects: ${outcome.rejects.slice(0, 3).join('; ')}`
        : '';
      redirect(
        ctx,
        `/admin?remit_ok=${outcome.ok ? '1' : '0'}&remit=${encodeURIComponent(outcome.message + detail)}`,
      );
    }),
  );

  router.post(
    '/admin/glosses/draft',
    authed('admin', async (ctx) => {
      if (!glossRun || glossRun.done) {
        glossRun = { startedAt: Date.now(), done: false, message: '' };
        const run = glossRun;
        void (async () => {
          try {
            await flagStaleGlosses(pool);
            const summary = await draftMissingGlosses(pool, createLlmClient());
            run.message = `Drafted ${summary.drafted} glosses; ${summary.skipped.length} codes lack public evidence${
              summary.skipped.length
                ? ` (${summary.skipped
                    .slice(0, 5)
                    .map((s) => s.code)
                    .join(', ')})`
                : ''
            }.`;
          } catch (err) {
            run.message = `Drafting failed: ${(err as Error).message}`;
          } finally {
            run.done = true;
          }
        })();
        await auditAdminAction(pool, ctx.user.id, 'gloss_draft_run', {});
      }
      redirect(ctx, '/admin');
    }),
  );

  router.post(
    '/admin/glosses/:id/approve',
    authed('lead', async (ctx) => {
      await pool.query(
        `UPDATE code_glosses SET status = 'approved', approved_by = $2, approved_at = now(),
           needs_review = false WHERE id::text = $1`,
        [ctx.params['id'], ctx.user.id],
      );
      await auditAdminAction(pool, ctx.user.id, 'gloss_approved', { gloss: ctx.params['id'] });
      redirect(ctx, '/admin');
    }),
  );

  router.post(
    '/admin/glosses/:id/retire',
    authed('lead', async (ctx) => {
      await pool.query(`UPDATE code_glosses SET status = 'retired' WHERE id::text = $1`, [
        ctx.params['id'],
      ]);
      await auditAdminAction(pool, ctx.user.id, 'gloss_retired', { gloss: ctx.params['id'] });
      redirect(ctx, '/admin');
    }),
  );

  router.post(
    '/admin/invites',
    authed('admin', async (ctx) => {
      const email = (ctx.form['email'] ?? '').trim();
      const role = ctx.form['role'] ?? 'biller';
      if (!email || !ROLES.includes(role as (typeof ROLES)[number])) {
        redirect(ctx, '/admin');
        return;
      }
      const token = await createInvite(pool, email, role as (typeof ROLES)[number], ctx.user.id);
      await auditAdminAction(pool, ctx.user.id, 'invite_created', { email, role });
      redirect(ctx, `/admin?invited=${encodeURIComponent(email)}&token=${token}`);
    }),
  );

  router.post(
    '/admin/users/:id/role',
    authed('admin', async (ctx) => {
      const role = ctx.form['role'] ?? '';
      const id = ctx.params['id'] ?? '';
      if (ROLES.includes(role as (typeof ROLES)[number]) && id !== ctx.user.id) {
        await pool.query('UPDATE users SET role = $2 WHERE id = $1', [id, role]);
        await auditAdminAction(pool, ctx.user.id, 'role_changed', { target: id, role });
      }
      redirect(ctx, '/admin');
    }),
  );

  router.post(
    '/admin/users/:id/status',
    authed('admin', async (ctx) => {
      const id = ctx.params['id'] ?? '';
      if (id !== ctx.user.id) {
        await pool.query(
          `UPDATE users SET status = CASE WHEN status = 'disabled' THEN 'active' ELSE 'disabled' END
           WHERE id = $1`,
          [id],
        );
        await auditAdminAction(pool, ctx.user.id, 'status_toggled', { target: id });
      }
      redirect(ctx, '/admin');
    }),
  );

  router.post(
    '/admin/assign',
    authed('admin', async (ctx) => {
      const userId = ctx.form['user_id'] ?? '';
      const clientId = ctx.form['client_id'] ?? '';
      if (userId && clientId) {
        if (ctx.form['op'] === 'remove') {
          await pool.query('DELETE FROM user_clients WHERE user_id = $1 AND client_id = $2', [
            userId,
            clientId,
          ]);
        } else {
          await pool.query(
            'INSERT INTO user_clients (user_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [userId, clientId],
          );
        }
        await auditAdminAction(pool, ctx.user.id, 'client_assignment', {
          target: userId,
          client: clientId,
          op: ctx.form['op'] ?? 'add',
        });
      }
      redirect(ctx, '/admin');
    }),
  );
}
