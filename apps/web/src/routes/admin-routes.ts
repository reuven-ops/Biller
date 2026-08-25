// Admin page (brief section 13.5): users and roles, invites, client assignments,
// cost against the cap, model and prompt versions. Remit import and eval run
// management land in Phase 4.
import { intEnv } from '@advisor/db';
import type { Pool } from '@advisor/db';
import { modelConfig, promptVersion } from '@advisor/core';
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

export function registerAdminRoutes(router: Router, pool: Pool, authed: Authed): void {
  router.get(
    '/admin',
    authed('admin', async (ctx) => {
      const invited = ctx.query.get('invited');
      const inviteToken = ctx.query.get('token');
      const [users, cost, clients] = await Promise.all([
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

            <p class="muted">
              Remittance imports and eval run management arrive with Phase 4. Feedback review for
              leads arrives with the call notes pages.
            </p>
          `,
        }),
      );
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
