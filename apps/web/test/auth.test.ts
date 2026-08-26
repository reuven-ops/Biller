import { beforeAll, describe, expect, it } from 'vitest';
import {
  csrfTokenFor,
  csrfValid,
  hashPassword,
  passwordPolicyError,
  verifyPassword,
} from '../src/auth.js';
import { parseCookies, Router, setCookie } from '../src/http.js';
import { escapeHtml, html, raw } from '../src/html.js';

beforeAll(() => {
  process.env['SESSION_SECRET'] = 'test-secret-for-unit-tests';
});

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const hash = await hashPassword('correct horse 42 battery');
    expect(hash.startsWith('scrypt:')).toBe(true);
    expect(await verifyPassword('correct horse 42 battery', hash)).toBe(true);
    expect(await verifyPassword('wrong password 42', hash)).toBe(false);
  });

  it('two hashes of the same password differ by salt', async () => {
    const a = await hashPassword('correct horse 42 battery');
    const b = await hashPassword('correct horse 42 battery');
    expect(a).not.toBe(b);
  });

  it('enforces the policy', () => {
    expect(passwordPolicyError('short1')).toContain('12');
    expect(passwordPolicyError('all letters here no digit')).toContain('digit');
    expect(passwordPolicyError('long enough with digit 7')).toBeNull();
  });

  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt:aa:bb')).toBe(false);
  });
});

describe('csrf', () => {
  it('accepts the derived token and rejects others', () => {
    const token = csrfTokenFor('session-1');
    expect(csrfValid('session-1', token)).toBe(true);
    expect(csrfValid('session-2', token)).toBe(false);
    expect(csrfValid('session-1', 'forged')).toBe(false);
    expect(csrfValid('session-1', '')).toBe(false);
  });
});

describe('http plumbing', () => {
  it('parses cookies', () => {
    expect(parseCookies('a=1; advisor_session=abc%20d; empty')).toEqual({
      a: '1',
      advisor_session: 'abc d',
    });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('builds cookies with security attributes', () => {
    const cookie = setCookie('s', 'v', { maxAgeSeconds: 60 });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=60');
    expect(setCookie('s', '', { expire: true })).toContain('Max-Age=0');
  });

  it('routes with params and rejects non-matches', () => {
    const router = new Router();
    router.get('/q/:id', () => {});
    router.post('/login', () => {});
    expect(router.match('GET', '/q/abc-123')?.params).toEqual({ id: 'abc-123' });
    expect(router.match('POST', '/q/abc-123')).toBeNull();
    expect(router.match('GET', '/q/abc/extra')).toBeNull();
    expect(router.match('POST', '/login')).not.toBeNull();
  });
});

describe('html escaping', () => {
  it('escapes interpolations by default', () => {
    const page = html`<p>${'<script>alert(1)</script>'}</p>`;
    expect(page.value).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('passes raw only when marked and joins arrays', () => {
    const items = ['a<b', 'c'];
    const page = html`<ul>
      ${items.map((i) => html`<li>${i}</li>`)}${raw('<hr />')}
    </ul>`;
    expect(page.value).toContain('<li>a&lt;b</li>');
    expect(page.value).toContain('<hr />');
  });

  it('escapeHtml covers the five specials', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
