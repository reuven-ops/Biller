// Call notes against a real scratch database: creation with corpus sync and
// history, PHI rejection without persistence, lead transitions, expiry math.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '@advisor/db';
import { StubLlmClient } from '@advisor/core';
import { syncSources } from '@advisor/ingest';
import {
  addDays,
  approveNote,
  createCallNote,
  reconfirmNote,
  renderNoteText,
  retireNote,
  type CallNoteInput,
} from '../src/notes-store.js';

const run = process.env.RUN_INTEGRATION === '1';
const suite = run ? describe : describe.skip;

function urlWith(base: string, user: string, password: string, database: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

function noteInput(userId: string, overrides: Partial<CallNoteInput> = {}): CallNoteInput {
  return {
    payer: 'UnitedHealthcare',
    planProduct: 'Choice Plus',
    lob: 'Commercial',
    state: 'FL',
    codes: ['97140'],
    modifiers: ['59'],
    topic: 'modifier',
    ruleAsStated:
      'The representative said modifier 59 on 97140 with 98940 is payable when regions differ.',
    repName: 'Alex',
    callReference: 'REF-12345',
    callDate: '2026-08-25',
    calledByUserId: userId,
    clientId: null,
    claimExampleRef: null,
    repConfidence: 'stated',
    attachmentTexts: [],
    ...overrides,
  };
}

suite('call notes against a real database', () => {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? '';
  const migratorPw = process.env.TEST_MIGRATOR_PASSWORD ?? '';
  const appPw = process.env.TEST_APP_PASSWORD ?? '';
  const dbName = `advisor_notes_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let userId: string;

  beforeAll(async () => {
    process.env['SESSION_SECRET'] = 'integration-test-secret';
    admin = new pg.Client({ connectionString: adminUrl });
    admin.on('error', () => {});
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName} OWNER migrator`);
    await migrate(urlWith(adminUrl, 'migrator', migratorPw, dbName));
    pool = new pg.Pool({ connectionString: urlWith(adminUrl, 'app', appPw, dbName), max: 3 });
    pool.on('error', () => {});
    await syncSources(pool);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email, role, status) VALUES ('noter@example.test', 'biller', 'active') RETURNING id`,
    );
    userId = u.rows[0]!.id;
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('creates a note with history and a tier 6 corpus chunk expiring with the note', async () => {
    const result = await createCallNote(pool, new StubLlmClient(), noteInput(userId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const note = await pool.query<{ status: string; expires_on: string }>(
      `SELECT status, expires_on::text AS expires_on FROM payer_call_notes WHERE id = $1`,
      [result.noteId],
    );
    expect(note.rows[0]?.status).toBe('unverified');
    expect(note.rows[0]?.expires_on).toBe(addDays('2026-08-25', 365));
    const history = await pool.query(
      `SELECT action FROM call_note_history WHERE note_id = $1 ORDER BY ts`,
      [result.noteId],
    );
    expect(history.rows.map((r) => (r as { action: string }).action)).toEqual(['created']);
    const chunk = await pool.query<{
      tier: number;
      retired_date: string;
      codes_mentioned: string[];
      text: string;
    }>(
      `SELECT c.tier, c.retired_date::text AS retired_date, c.codes_mentioned, c.text
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE d.external_id = $1`,
      [`note-${result.noteId}`],
    );
    expect(chunk.rows[0]?.tier).toBe(6);
    expect(chunk.rows[0]?.retired_date).toBe(addDays('2026-08-25', 365));
    expect(chunk.rows[0]?.codes_mentioned).toContain('97140');
    expect(chunk.rows[0]?.text).toContain('modifier 59');
  });

  it('refuses PHI and persists nothing', async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM payer_call_notes`);
    const result = await createCallNote(
      pool,
      new StubLlmClient(),
      noteInput(userId, {
        ruleAsStated: 'Patient John Smith, member ID ABC123456789, was denied for 97140.',
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.phi).toBe(true);
    const after = await pool.query(`SELECT count(*)::int AS n FROM payer_call_notes`);
    expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n);
  });

  it('lead approve, reconfirm, and retire write history and move the corpus expiry', async () => {
    const created = await createCallNote(pool, new StubLlmClient(), noteInput(userId));
    if (!created.ok) throw new Error('create failed');
    const id = created.noteId;
    expect(await approveNote(pool, id, userId)).toBe(true);
    expect(await reconfirmNote(pool, id, userId)).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    const afterReconfirm = await pool.query<{ expires_on: string }>(
      `SELECT expires_on::text AS expires_on FROM payer_call_notes WHERE id = $1`,
      [id],
    );
    expect(afterReconfirm.rows[0]?.expires_on).toBe(addDays(today, 365));
    expect(await retireNote(pool, id, userId)).toBe(true);
    const doc = await pool.query<{ retired_date: string }>(
      `SELECT retired_date::text AS retired_date FROM documents
       WHERE external_id = $1 AND superseded_by IS NULL`,
      [`note-${id}`],
    );
    expect(doc.rows[0]?.retired_date).toBe(today);
    const history = await pool.query(
      `SELECT action FROM call_note_history WHERE note_id = $1 ORDER BY ts`,
      [id],
    );
    expect(history.rows.map((r) => (r as { action: string }).action)).toEqual([
      'created',
      'approved',
      'reconfirmed',
      'retired',
    ]);
    // Approve on a retired note is refused.
    expect(await approveNote(pool, id, userId)).toBe(false);
  });

  it('renderNoteText carries the fields answers quote', () => {
    const text = renderNoteText({
      id: 'x',
      payer: 'Aetna',
      plan_product: null,
      lob: 'Commercial',
      state: 'FL',
      codes: ['90837'],
      modifiers: [],
      topic: 'timely filing',
      rule_as_stated: 'The filing limit is 180 days from the date of service.',
      rep_name: 'Sam',
      call_reference: 'A-1',
      call_date: '2026-08-25',
      client_id: null,
      rep_confidence: 'stated',
      status: 'unverified',
      expires_on: '2027-08-25',
      reconfirmed_on: null,
    });
    expect(text).toContain('Aetna');
    expect(text).toContain('timely filing');
    expect(text).toContain('180 days');
    expect(text).toContain('Call reference: A-1');
  });
});
