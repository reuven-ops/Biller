import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { intEnv } from './env.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * Substitutes build-time parameters. The only one today is {{EMBEDDING_DIM}}
 * (docs/DECISIONS.md D4). The checksum is computed after substitution so a
 * dimension change is detected as a changed migration rather than silently applied.
 */
export function renderMigration(sql: string, params: { embeddingDim: number }): string {
  return sql.replaceAll('{{EMBEDDING_DIM}}', String(params.embeddingDim));
}

export async function listMigrations(
  dir: string = MIGRATIONS_DIR,
  params: { embeddingDim: number } = { embeddingDim: intEnv('EMBEDDING_DIM', 768) },
): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Set<string>();
  const files: MigrationFile[] = [];
  for (const name of entries) {
    const prefix = name.split('_')[0];
    if (prefix === undefined || !/^\d{4}$/.test(prefix)) {
      throw new Error(`Migration file name must start with a 4-digit ordinal: ${name}`);
    }
    if (seen.has(prefix)) {
      throw new Error(`Duplicate migration ordinal ${prefix} (${name})`);
    }
    seen.add(prefix);
    const raw = await readFile(join(dir, name), 'utf8');
    const sql = renderMigration(raw, params);
    files.push({ name, sql, checksum: checksumOf(sql) });
  }
  return files;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies pending migrations in order inside one transaction per file, recording each
 * in schema_migrations. Re-running is a no-op. A checksum mismatch on an applied
 * migration aborts: applied migrations are immutable.
 */
export async function migrate(
  connectionString: string,
  dir: string = MIGRATIONS_DIR,
  params?: { embeddingDim: number },
): Promise<MigrateResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrateResult = { applied: [], skipped: [] };
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    // One migrator at a time.
    await client.query('SELECT pg_advisory_lock(727001)');
    const appliedRows = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const appliedByName = new Map(appliedRows.rows.map((r) => [r.name, r.checksum]));
    const files = params ? await listMigrations(dir, params) : await listMigrations(dir);
    for (const file of files) {
      const existing = appliedByName.get(file.name);
      if (existing !== undefined) {
        if (existing !== file.checksum) {
          throw new Error(
            `Migration ${file.name} was already applied with a different checksum. ` +
              `Applied migrations are immutable; add a new migration instead.`,
          );
        }
        result.skipped.push(file.name);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file.name,
          file.checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
      result.applied.push(file.name);
    }
    return result;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(727001)');
    } catch {
      // connection already broken; nothing to release
    }
    await client.end();
  }
}
