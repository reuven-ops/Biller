import pg from 'pg';
import { requireEnv } from './env.js';

const { Pool } = pg;

let appPool: pg.Pool | undefined;

/** Application pool using the app role (DATABASE_URL). */
export function getPool(): pg.Pool {
  if (!appPool) {
    appPool = new Pool({ connectionString: requireEnv('DATABASE_URL'), max: 10 });
  }
  return appPool;
}

export async function closePool(): Promise<void> {
  if (appPool) {
    await appPool.end();
    appPool = undefined;
  }
}

export type { Pool, PoolClient, QueryResult } from 'pg';
