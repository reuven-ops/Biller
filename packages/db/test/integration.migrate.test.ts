// Integration tests: apply migrations to a scratch database and prove the grant model.
// Run only when RUN_INTEGRATION=1 (CLAUDE.md conventions). Requires the bootstrap roles
// from deploy/initdb/01-roles.sh and these URLs in the environment:
//   TEST_ADMIN_DATABASE_URL   superuser or createdb-capable connection
//   TEST_MIGRATOR_PASSWORD, TEST_APP_PASSWORD  passwords for the migrator and app roles
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '../src/migrate.js';

const run = process.env.RUN_INTEGRATION === '1';
const suite = run ? describe : describe.skip;

function urlWith(base: string, user: string, password: string, database: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

suite('migrate against a real database', () => {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? '';
  const migratorPw = process.env.TEST_MIGRATOR_PASSWORD ?? '';
  const appPw = process.env.TEST_APP_PASSWORD ?? '';
  const dbName = `advisor_test_${Date.now()}`;
  let admin: pg.Client;
  let migratorUrl: string;
  let appUrl: string;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    admin.on('error', () => {});
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName} OWNER migrator`);
    migratorUrl = urlWith(adminUrl, 'migrator', migratorPw, dbName);
    appUrl = urlWith(adminUrl, 'app', appPw, dbName);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('applies cleanly, and a second run is a no-op', async () => {
    const first = await migrate(migratorUrl);
    expect(first.applied.length).toBeGreaterThanOrEqual(7);
    expect(first.skipped).toHaveLength(0);

    const second = await migrate(migratorUrl);
    expect(second.applied).toHaveLength(0);
    expect(second.skipped.length).toBe(first.applied.length);
  });

  it('created the tables from brief section 5', async () => {
    const c = new pg.Client({ connectionString: migratorUrl });
    c.on('error', () => {});
    await c.connect();
    const res = await c.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = new Set(res.rows.map((r) => r.table_name));
    for (const expected of [
      'sources',
      'documents',
      'chunks',
      'codes',
      'ncci_ptp',
      'mue',
      'mpfs',
      'conversion_factor',
      'gpci',
      'icd10cm',
      'payer_call_notes',
      'call_note_history',
      'remit_behavior',
      'remit_imports',
      'clients',
      'user_clients',
      'users',
      'sessions',
      'invites',
      'qa_log',
      'qa_feedback',
      'change_events',
      'source_requests',
      'ingest_runs',
      'job_locks',
      'metrics_daily',
    ]) {
      expect(tables, `missing table ${expected}`).toContain(expected);
    }
    await c.end();
  });

  it('app role can INSERT and SELECT but not UPDATE or DELETE on append-only tables', async () => {
    const c = new pg.Client({ connectionString: appUrl });
    c.on('error', () => {});
    await c.connect();
    const inserted = await c.query<{ id: string }>(
      `INSERT INTO qa_log (question_text) VALUES ('test question') RETURNING id`,
    );
    const id = inserted.rows[0]?.id;
    expect(id).toBeTruthy();
    const selected = await c.query(`SELECT question_text FROM qa_log WHERE id = $1`, [id]);
    expect(selected.rowCount).toBe(1);
    await expect(
      c.query(`UPDATE qa_log SET question_text = 'edited' WHERE id = $1`, [id]),
    ).rejects.toThrow(/permission denied/);
    await expect(c.query(`DELETE FROM qa_log WHERE id = $1`, [id])).rejects.toThrow(
      /permission denied/,
    );
    for (const table of ['qa_feedback', 'change_events', 'call_note_history']) {
      await expect(c.query(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/);
    }
    await c.end();
  });

  it('app role cannot run DDL or write the migration ledger', async () => {
    const c = new pg.Client({ connectionString: appUrl });
    c.on('error', () => {});
    await c.connect();
    await expect(c.query(`CREATE TABLE should_fail (id int)`)).rejects.toThrow(/permission denied/);
    await expect(
      c.query(`INSERT INTO schema_migrations (name, checksum) VALUES ('x', 'y')`),
    ).rejects.toThrow(/permission denied/);
    await c.end();
  });

  it('app role has normal DML elsewhere', async () => {
    const c = new pg.Client({ connectionString: appUrl });
    c.on('error', () => {});
    await c.connect();
    await c.query(
      `INSERT INTO sources (id, name, publisher, kind, cadence_days, tier)
       VALUES ('test_source', 'Test', 'Test', 'download', 7, 2)`,
    );
    await c.query(`UPDATE sources SET enabled = false WHERE id = 'test_source'`);
    await c.query(`DELETE FROM sources WHERE id = 'test_source'`);
    await c.end();
  });
});
