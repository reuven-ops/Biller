// Integration tests for job locks and the document store (RUN_INTEGRATION=1).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '@advisor/db/migrate';
import { acquireJobLock } from '../src/job-locks.js';
import { upsertDocument } from '../src/doc-store.js';

const run = process.env.RUN_INTEGRATION === '1';
const suite = run ? describe : describe.skip;

function urlWith(base: string, user: string, password: string, database: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

suite('job locks and document store', () => {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? '';
  const migratorPw = process.env.TEST_MIGRATOR_PASSWORD ?? '';
  const appPw = process.env.TEST_APP_PASSWORD ?? '';
  const dbName = `advisor_ingest_test_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName} OWNER migrator`);
    await migrate(urlWith(adminUrl, 'migrator', migratorPw, dbName));
    pool = new pg.Pool({ connectionString: urlWith(adminUrl, 'app', appPw, dbName), max: 5 });
    await pool.query(
      `INSERT INTO sources (id, name, publisher, kind, cadence_days, tier)
       VALUES ('test_src', 'Test', 'Test', 'download', 7, 2)`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('only one holder wins a contested lock; release frees it', async () => {
    const first = await acquireJobLock(pool, 'contested');
    expect(first).not.toBeNull();
    const second = await acquireJobLock(pool, 'contested');
    expect(second).toBeNull();
    await first!.release();
    const third = await acquireJobLock(pool, 'contested');
    expect(third).not.toBeNull();
    await third!.release();
  });

  it('a dead lock (stale heartbeat) is taken over', async () => {
    const first = await acquireJobLock(pool, 'dead-lock');
    expect(first).not.toBeNull();
    await pool.query(
      `UPDATE job_locks SET heartbeat_at = now() - interval '31 minutes' WHERE job_name = 'dead-lock'`,
    );
    const takeover = await acquireJobLock(pool, 'dead-lock');
    expect(takeover).not.toBeNull();
    await takeover!.release();
  });

  it('document versions: new, unchanged, revised with supersession and change events', async () => {
    const base = {
      sourceId: 'test_src',
      externalId: 'DOC-1',
      docType: 'manual',
      title: 'Test Document',
      url: 'https://www.cms.gov/test',
      effectiveDate: '2026-01-01',
      revisionDate: null,
      retiredDate: null,
      tier: 2 as const,
      jurisdiction: [],
      payer: null,
      lob: null,
      clientId: null,
      storagePath: null,
      metadata: {},
    };
    const v1 = await upsertDocument(pool, { ...base, versionHash: 'hash-a' });
    expect(v1.outcome).toBe('new');
    const again = await upsertDocument(pool, { ...base, versionHash: 'hash-a' });
    expect(again.outcome).toBe('unchanged');
    expect(again.documentId).toBe(v1.documentId);
    const v2 = await upsertDocument(pool, { ...base, versionHash: 'hash-b' });
    expect(v2.outcome).toBe('revised');
    expect(v2.supersededDocumentId).toBe(v1.documentId);

    const superseded = await pool.query<{ superseded_by: string }>(
      `SELECT superseded_by FROM documents WHERE id = $1`,
      [v1.documentId],
    );
    expect(superseded.rows[0]?.superseded_by).toBe(v2.documentId);

    const events = await pool.query<{ change_type: string }>(
      `SELECT change_type FROM change_events ce
       JOIN documents d ON d.id = ce.document_id
       WHERE d.external_id = 'DOC-1' ORDER BY ce.detected_at`,
    );
    expect(events.rows.map((r: { change_type: string }) => r.change_type)).toEqual([
      'new',
      'revised',
    ]);
  });
});
