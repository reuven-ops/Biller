// Web entry (brief section 13): server-rendered pages over node:http. Session
// cookie auth, CSRF on every authenticated POST, security headers on every
// response, and the health endpoint used by docker compose.
import { createServer } from 'node:http';
import { getPool, intEnv, loadEnv, requireEnv } from '@advisor/db';
import { csrfTokenFor, csrfValid, loadSessionUser, SESSION_COOKIE, type WebUser } from './auth.js';
import { html, layout } from './html.js';
import {
  parseCookies,
  readForm,
  Router,
  sendHtml,
  redirect,
  type Ctx,
  type Handler,
} from './http.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerAskRoutes } from './routes/ask-routes.js';
import { registerHistoryRoutes } from './routes/history-routes.js';
import { registerHelpRoutes } from './routes/help-routes.js';
import { registerSourcesRoutes } from './routes/sources-routes.js';
import { registerAdminRoutes } from './routes/admin-routes.js';

loadEnv();
requireEnv('SESSION_SECRET'); // fail fast: sessions and CSRF depend on it
const port = intEnv('APP_PORT', 3000);
const pool = getPool();

export interface AuthedCtx extends Ctx {
  user: WebUser;
  csrf: string;
}

type AuthedHandler = (ctx: AuthedCtx) => Promise<void> | void;

/** Wraps a page handler: requires a session, optionally a role, and CSRF on POST. */
export function authed(minRole: 'biller' | 'lead' | 'admin', handler: AuthedHandler): Handler {
  const rank = { biller: 0, lead: 1, admin: 2 };
  return async (ctx) => {
    const sessionId = ctx.cookies[SESSION_COOKIE] ?? '';
    const user = sessionId ? await loadSessionUser(pool, sessionId) : null;
    if (!user) {
      redirect(ctx, '/login');
      return;
    }
    if (rank[user.role] < rank[minRole]) {
      sendHtml(
        ctx,
        403,
        layout({
          title: 'Not allowed',
          user,
          csrf: csrfTokenFor(sessionId),
          body: html`<div class="error">This page needs the ${minRole} role.</div>`,
        }),
      );
      return;
    }
    const csrf = csrfTokenFor(sessionId);
    if (ctx.method === 'POST' && !csrfValid(sessionId, ctx.form['csrf'] ?? '')) {
      sendHtml(
        ctx,
        403,
        layout({
          title: 'Blocked',
          user,
          csrf,
          body: html`<div class="error">The form expired. Go back, reload, and try again.</div>`,
        }),
      );
      return;
    }
    await handler(Object.assign(ctx, { user, csrf }));
  };
}

const router = new Router();
registerAuthRoutes(router, pool);
registerAskRoutes(router, pool, authed);
registerHistoryRoutes(router, pool, authed);
registerHelpRoutes(router, authed);
registerSourcesRoutes(router, pool, authed);
registerAdminRoutes(router, pool, authed);

// Call notes arrive with Phase 4; the nav link gets an honest placeholder until then.
router.get(
  '/notes',
  authed('biller', (ctx) => {
    sendHtml(
      ctx,
      200,
      layout({
        title: 'Call notes',
        user: ctx.user,
        active: '/notes',
        csrf: ctx.csrf,
        body: html`<h1>Call notes</h1>
          <div class="notice">
            Call notes arrive with Phase 4: the entry form, lead approval, expiry tracking, and
            citation of notes as tier 6 evidence.
          </div>`,
      }),
    );
  }),
);

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: Ctx = {
      req,
      res,
      method: (req.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      params: {},
      cookies: parseCookies(req.headers.cookie),
      form: {},
    };
    try {
      if (ctx.path === '/healthz') {
        const dbRes = await pool
          .query('SELECT 1')
          .then(() => true)
          .catch(() => false);
        res.writeHead(dbRes ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: dbRes }));
        return;
      }
      if (ctx.method === 'POST') ctx.form = await readForm(req);
      const match = router.match(ctx.method, ctx.path);
      if (!match) {
        sendHtml(ctx, 404, layout({ title: 'Not found', body: html`<p>Page not found.</p>` }));
        return;
      }
      ctx.params = match.params;
      await match.handler(ctx);
    } catch (err) {
      console.error(`[web] ${ctx.method} ${ctx.path} failed:`, err);
      if (!res.headersSent)
        sendHtml(
          ctx,
          500,
          layout({
            title: 'Error',
            body: html`<div class="error">Something went wrong. The error is logged.</div>`,
          }),
        );
    }
  })();
});

server.listen(port, () => {
  console.log(`[web] CM Coding Advisor listening on :${port}`);
});
