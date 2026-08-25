// Auth against a real scratch database: lockout, sessions, invites, rate limit.
// Runs when RUN_INTEGRATION=1 with TEST_ADMIN_DATABASE_URL (see db package tests).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '@advisor/db';
import {
  acceptInvite,
  createInvite,
  findInvite,
  loadSessionUser,
  login,
  LOCKOUT_THRESHOLD,
  questionsInLastHour,
  revokeSession,
} from '../src/auth.js';

const run = process.env.RUN_INTEGRATION === '1';
const suite = run ? describe : describe.skip;

function urlWith(base: string, user: string, password: string, database: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

suite('web auth against a real database', () => {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? '';
  const migratorPw = process.env.TEST_MIGRATOR_PASSWORD ?? '';
  const appPw = process.env.TEST_APP_PASSWORD ?? '';
  const dbName = `advisor_webauth_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    process.env['SESSION_SECRET'] = 'integration-test-secret';
    admin = new pg.Client({ connectionString: adminUrl });
    admin.on('error', () => {});
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName} OWNER migrator`);
    await migrate(urlWith(adminUrl, 'migrator', migratorPw, dbName));
    pool = new pg.Pool({ connectionString: urlWith(adminUrl, 'app', appPw, dbName), max: 3 });
    pool.on('error', () => {});
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('invite accept creates an active user who can sign in', async () => {
    const token = await createInvite(pool, 'lead@example.test', 'lead', null);
    const invite = await findInvite(pool, token);
    expect(invite?.email).toBe('lead@example.test');
    await acceptInvite(pool, invite!, 'Lead Person', 'a fine password 42');
    // The invite is single-use.
    expect(await findInvite(pool, token)).toBeNull();

    const result = await login(pool, 'lead@example.test', 'a fine password 42');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.role).toBe('lead');
      const loaded = await loadSessionUser(pool, result.sessionId);
      expect(loaded?.email).toBe('lead@example.test');
      await revokeSession(pool, result.sessionId);
      expect(await loadSessionUser(pool, result.sessionId)).toBeNull();
    }
  });

  it('locks the account after repeated failures', async () => {
    const token = await createInvite(pool, 'locked@example.test', 'biller', null);
    const invite = await findInvite(pool, token);
    await acceptInvite(pool, invite!, '', 'a fine password 42');
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      const bad = await login(pool, 'locked@example.test', 'wrong password 9');
      expect(bad.ok).toBe(false);
    }
    const after = await login(pool, 'locked@example.test', 'a fine password 42');
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('locked');
  });

  it('unknown emails fail without revealing existence', async () => {
    const result = await login(pool, 'nobody@example.test', 'whatever password 1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_credentials');
  });

  it('rate limit counts qa_log rows for the user in the last hour', async () => {
    const token = await createInvite(pool, 'asker@example.test', 'biller', null);
    const invite = await findInvite(pool, token);
    const userId = await acceptInvite(pool, invite!, '', 'a fine password 42');
    expect(await questionsInLastHour(pool, userId)).toBe(0);
    await pool.query(
      `INSERT INTO qa_log (user_id, question_text, dos, payer, jurisdiction) VALUES ($1, 'q', now()::date, 'p', 'j')`,
      [userId],
    );
    expect(await questionsInLastHour(pool, userId)).toBe(1);
  });
});
