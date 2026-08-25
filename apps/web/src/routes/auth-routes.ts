// Login, logout, and invite acceptance (brief section 13 auth).
import type { Pool } from '@advisor/db';
import {
  acceptInvite,
  csrfTokenFor,
  csrfValid,
  findInvite,
  login,
  passwordPolicyError,
  revokeSession,
  SESSION_COOKIE,
  SESSION_DAYS,
} from '../auth.js';
import { html } from '../html.js';
import { layout } from '../html.js';
import { redirect, sendHtml, setCookie, type Ctx, type Router } from '../http.js';

function loginPage(error?: string): string {
  return layout({
    title: 'Sign in',
    body: html`
      <h1>Sign in</h1>
      ${error ? html`<div class="error">${error}</div>` : ''}
      <div class="card" style="max-width: 26rem">
        <form method="post" action="/login">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required autocomplete="username" />
          <label for="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autocomplete="current-password"
          />
          <p><button type="submit">Sign in</button></p>
        </form>
        <p class="muted">No account? Ask an admin for an invite link.</p>
      </div>
    `,
  });
}

export function registerAuthRoutes(router: Router, pool: Pool): void {
  router.get('/login', (ctx) => {
    sendHtml(ctx, 200, loginPage());
  });

  router.post('/login', async (ctx) => {
    const email = ctx.form['email'] ?? '';
    const password = ctx.form['password'] ?? '';
    const result = await login(pool, email, password);
    if (!result.ok) {
      const message =
        result.reason === 'locked'
          ? 'Account locked after repeated failures. Try again in 15 minutes.'
          : result.reason === 'disabled'
            ? 'This account is disabled. Contact an admin.'
            : 'Email or password is incorrect.';
      sendHtml(ctx, 401, loginPage(message));
      return;
    }
    redirect(ctx, '/', {
      'set-cookie': setCookie(SESSION_COOKIE, result.sessionId, {
        maxAgeSeconds: SESSION_DAYS * 86400,
      }),
    });
  });

  router.post('/logout', async (ctx) => {
    const sessionId = ctx.cookies[SESSION_COOKIE];
    if (sessionId && csrfValid(sessionId, ctx.form['csrf'] ?? '')) {
      await revokeSession(pool, sessionId);
    }
    redirect(ctx, '/login', {
      'set-cookie': setCookie(SESSION_COOKIE, '', { expire: true }),
    });
  });

  const invitePage = (ctx: Ctx, opts: { email: string; error?: string }) =>
    layout({
      title: 'Accept invite',
      body: html`
        <h1>Welcome to CM Coding Advisor</h1>
        ${opts.error ? html`<div class="error">${opts.error}</div>` : ''}
        <div class="card" style="max-width: 26rem">
          <p>Setting up the account for <strong>${opts.email}</strong>.</p>
          <form method="post" action="/invite/${ctx.params['token']}">
            <label for="name">Your name</label>
            <input id="name" name="name" type="text" required />
            <label for="password">Choose a password</label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autocomplete="new-password"
            />
            <p class="muted">At least 12 characters with a letter and a digit.</p>
            <p><button type="submit">Create account</button></p>
          </form>
        </div>
      `,
    });

  router.get('/invite/:token', async (ctx) => {
    const invite = await findInvite(pool, ctx.params['token'] ?? '');
    if (!invite) {
      sendHtml(ctx, 404, layout({ title: 'Invite', body: html`<p>Invite not found or expired.</p>` }));
      return;
    }
    sendHtml(ctx, 200, invitePage(ctx, { email: invite.email }));
  });

  router.post('/invite/:token', async (ctx) => {
    const invite = await findInvite(pool, ctx.params['token'] ?? '');
    if (!invite) {
      sendHtml(ctx, 404, layout({ title: 'Invite', body: html`<p>Invite not found or expired.</p>` }));
      return;
    }
    const password = ctx.form['password'] ?? '';
    const policyError = passwordPolicyError(password);
    if (policyError) {
      sendHtml(ctx, 400, invitePage(ctx, { email: invite.email, error: policyError }));
      return;
    }
    await acceptInvite(pool, invite, ctx.form['name'] ?? '', password);
    sendHtml(
      ctx,
      200,
      layout({
        title: 'Account created',
        body: html`<div class="notice">
          Account created. <a href="/login">Sign in</a> with your email and new password.
        </div>`,
      }),
    );
  });
}

export function csrfFor(sessionId: string): string {
  return csrfTokenFor(sessionId);
}
