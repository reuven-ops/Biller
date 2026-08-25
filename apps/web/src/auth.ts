// Local auth (brief section 13): scrypt password hashes via node:crypto, database
// sessions, lockout after repeated failures, invite tokens, and CSRF tokens derived
// from the session with SESSION_SECRET. No password ever leaves this module.
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool } from '@advisor/db';
import { requireEnv } from '@advisor/db';

const scrypt = promisify(scryptCb);

export const SESSION_COOKIE = 'advisor_session';
export const SESSION_DAYS = 14;
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MINUTES = 15;
export const PASSWORD_MIN_LENGTH = 12;

export interface WebUser {
  id: string;
  email: string;
  name: string;
  role: 'biller' | 'lead' | 'admin';
  status: string;
  clientIds: string[];
}

export function passwordPolicyError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH)
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
    return 'Password must contain at least one letter and one digit.';
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = (await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function csrfTokenFor(sessionId: string): string {
  return createHmac('sha256', requireEnv('SESSION_SECRET')).update(sessionId).digest('hex');
}

export function csrfValid(sessionId: string, token: string): boolean {
  const expected = Buffer.from(csrfTokenFor(sessionId));
  const got = Buffer.from(token);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export async function createSession(pool: Pool, userId: string): Promise<string> {
  const id = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [id, userId],
  );
  return id;
}

export async function revokeSession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
}

export async function loadSessionUser(pool: Pool, sessionId: string): Promise<WebUser | null> {
  if (!/^[a-f0-9]{64}$/.test(sessionId)) return null;
  const res = await pool.query<{
    id: string;
    email: string;
    name: string;
    role: WebUser['role'];
    status: string;
    client_ids: string[] | null;
  }>(
    `SELECT u.id, u.email, u.name, u.role, u.status,
            array_remove(array_agg(uc.client_id), NULL) AS client_ids
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN user_clients uc ON uc.user_id = u.id
     WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'
     GROUP BY u.id`,
    [sessionId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    clientIds: row.client_ids ?? [],
  };
}

export type LoginResult =
  | { ok: true; sessionId: string; user: WebUser }
  | { ok: false; reason: 'bad_credentials' | 'locked' | 'disabled' };

export async function login(pool: Pool, email: string, password: string): Promise<LoginResult> {
  const res = await pool.query<{
    id: string;
    email: string;
    name: string;
    role: WebUser['role'];
    status: string;
    password_hash: string | null;
    failed_logins: number;
    locked_until: Date | null;
  }>(
    `SELECT id, email, name, role, status, password_hash, failed_logins, locked_until
     FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  const row = res.rows[0];
  if (!row || !row.password_hash) {
    // Constant-ish time: burn a hash check even when the user does not exist.
    await hashPassword('timing-equalizer');
    return { ok: false, reason: 'bad_credentials' };
  }
  if (row.locked_until && row.locked_until.getTime() > Date.now())
    return { ok: false, reason: 'locked' };
  if (row.status !== 'active') return { ok: false, reason: 'disabled' };
  const good = await verifyPassword(password, row.password_hash);
  if (!good) {
    await pool.query(
      `UPDATE users SET failed_logins = failed_logins + 1,
         locked_until = CASE WHEN failed_logins + 1 >= $2
           THEN now() + interval '${LOCKOUT_MINUTES} minutes' ELSE locked_until END
       WHERE id = $1`,
      [row.id, LOCKOUT_THRESHOLD],
    );
    return { ok: false, reason: 'bad_credentials' };
  }
  await pool.query(
    'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
    [row.id],
  );
  const sessionId = await createSession(pool, row.id);
  const user = await loadSessionUser(pool, sessionId);
  if (!user) return { ok: false, reason: 'disabled' };
  return { ok: true, sessionId, user };
}

/** Creates an invite and returns the raw token to embed in the invite URL. */
export async function createInvite(
  pool: Pool,
  email: string,
  role: WebUser['role'],
  createdBy: string | null,
): Promise<string> {
  const token = randomBytes(24).toString('hex');
  const tokenHash = createHmac('sha256', requireEnv('SESSION_SECRET')).update(token).digest('hex');
  await pool.query(
    `INSERT INTO invites (email, role, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
    [email, role, tokenHash, createdBy],
  );
  return token;
}

export interface InviteRow {
  id: string;
  email: string;
  role: WebUser['role'];
}

export async function findInvite(pool: Pool, token: string): Promise<InviteRow | null> {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const tokenHash = createHmac('sha256', requireEnv('SESSION_SECRET')).update(token).digest('hex');
  const res = await pool.query<InviteRow>(
    `SELECT id, email, role FROM invites
     WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  return res.rows[0] ?? null;
}

/** Accepts an invite: creates or activates the user with the given password. */
export async function acceptInvite(
  pool: Pool,
  invite: InviteRow,
  name: string,
  password: string,
): Promise<string> {
  const passwordHash = await hashPassword(password);
  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = lower($1)',
    [invite.email],
  );
  let userId: string;
  if (existing.rows[0]) {
    userId = existing.rows[0].id;
    await pool.query(
      `UPDATE users SET password_hash = $2, name = $3, status = 'active', failed_logins = 0, locked_until = NULL
       WHERE id = $1`,
      [userId, passwordHash, name],
    );
  } else {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name, role, password_hash, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
      [invite.email, name, invite.role, passwordHash],
    );
    userId = created.rows[0]?.id ?? '';
  }
  await pool.query('UPDATE invites SET accepted_at = now() WHERE id = $1', [invite.id]);
  return userId;
}

export async function auditAdminAction(
  pool: Pool,
  userId: string | null,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await pool.query('INSERT INTO admin_audit (user_id, action, detail) VALUES ($1, $2, $3)', [
    userId,
    action,
    JSON.stringify(detail),
  ]);
}

/** Brief section 13: 30 questions per user per hour, counted from qa_log. */
export async function questionsInLastHour(pool: Pool, userId: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM qa_log WHERE user_id = $1 AND ts > now() - interval '1 hour'`,
    [userId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

export const RATE_LIMIT_PER_HOUR = 30;
