// pnpm users add <email> <role> [--name N] [--password P]
// pnpm users invite <email> <role>   prints an invite URL for the new user
// pnpm users list
import { closePool, getPool, optionalEnv } from '@advisor/db';

const ROLES = ['biller', 'lead', 'admin'] as const;
type Role = (typeof ROLES)[number];

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runUsersCommand(args: string[]): Promise<void> {
  const [action, email, role] = args;
  const pool = getPool();
  try {
    if (action === 'list') {
      const res = await pool.query<{
        email: string;
        role: string;
        status: string;
        last_login_at: Date | null;
      }>('SELECT email, role, status, last_login_at FROM users ORDER BY email');
      for (const r of res.rows)
        console.log(
          `${r.email.padEnd(36)} ${r.role.padEnd(7)} ${r.status.padEnd(9)} last login ${r.last_login_at?.toISOString() ?? 'never'}`,
        );
      if (res.rowCount === 0) console.log('No users yet. Use: pnpm users add <email> <role>');
      return;
    }
    if ((action !== 'add' && action !== 'invite') || !email || !ROLES.includes(role as Role)) {
      console.error(
        'Usage: pnpm users add <email> <biller|lead|admin> [--name N] [--password P] | pnpm users invite <email> <role> | pnpm users list',
      );
      process.exitCode = 1;
      return;
    }
    if (action === 'invite') {
      const { createInvite } = await import('@advisor/web');
      const token = await createInvite(pool, email, role as Role, null);
      const base = optionalEnv('APP_BASE_URL', 'http://localhost:3000');
      console.log(`Invite link for ${email} (${role}), valid 7 days:`);
      console.log(`${base}/invite/${token}`);
      return;
    }
    const password = flagValue(args, '--password');
    const name = flagValue(args, '--name') ?? '';
    if (password) {
      const { hashPassword, passwordPolicyError } = await import('@advisor/web');
      const policyError = passwordPolicyError(password);
      if (policyError) {
        console.error(policyError);
        process.exitCode = 1;
        return;
      }
      const hash = await hashPassword(password);
      await pool.query(
        `INSERT INTO users (email, name, role, password_hash, status) VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT ((lower(email))) DO UPDATE SET role = $3, password_hash = $4, status = 'active'`,
        [email, name, role, hash],
      );
      console.log(`User ${email} (${role}) is ready to sign in.`);
    } else {
      await pool.query(
        `INSERT INTO users (email, name, role, status) VALUES ($1, $2, $3, 'invited')
         ON CONFLICT ((lower(email))) DO UPDATE SET role = $3`,
        [email, name, role],
      );
      const { createInvite } = await import('@advisor/web');
      const token = await createInvite(pool, email, role as Role, null);
      const base = optionalEnv('APP_BASE_URL', 'http://localhost:3000');
      console.log(`User ${email} (${role}) created. Invite link, valid 7 days:`);
      console.log(`${base}/invite/${token}`);
    }
  } finally {
    await closePool();
  }
}
