// Contract and payer policy uploads against a real scratch database: tier 5
// isolation with fee schedule parsing, tier 4 policy storage, and the Phase 4
// acceptance check that a revised policy upload produces a change event that
// appears in the weekly digest.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import AdmZip from 'adm-zip';
import { migrate } from '@advisor/db';
import { syncSources } from '@advisor/ingest';
import { importContract, importPayerPolicy } from '../src/contracts-store.js';
import { weeklyDigest } from '../src/digest.js';

const run = process.env.RUN_INTEGRATION === '1';
const suite = run ? describe : describe.skip;

function urlWith(base: string, user: string, password: string, database: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

/** Minimal real DOCX: a zip whose word/document.xml holds one paragraph per line. */
function docxOf(...paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document><w:body>${body}</w:body></w:document>`;
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(xml, 'utf8'));
  return zip.toBuffer();
}

suite('contract and payer policy uploads against a real database', () => {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? '';
  const migratorPw = process.env.TEST_MIGRATOR_PASSWORD ?? '';
  const appPw = process.env.TEST_APP_PASSWORD ?? '';
  const dbName = `advisor_contracts_${Date.now()}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let clientId: string;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    admin.on('error', () => {});
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName} OWNER migrator`);
    await migrate(urlWith(adminUrl, 'migrator', migratorPw, dbName));
    pool = new pg.Pool({ connectionString: urlWith(adminUrl, 'app', appPw, dbName), max: 3 });
    pool.on('error', () => {});
    await syncSources(pool);
    const c = await pool.query<{ id: string }>(
      `INSERT INTO clients (name) VALUES ('Test Clinic') RETURNING id`,
    );
    clientId = c.rows[0]!.id;
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('stores a CSV fee schedule as tier 5 with client isolation and parsed rows', async () => {
    const csv = [
      'CPT,Modifier,Allowed Amount',
      '98940,,42.10',
      '97140,59,38.55',
      'not-a-code,,1.00',
    ].join('\n');
    const outcome = await importContract(pool, {
      clientId,
      payer: 'UnitedHealthcare',
      title: 'UHC 2026 fee schedule',
      contractType: 'fee_schedule',
      effectiveDate: '2026-01-01',
      terminationDate: null,
      portalPath: 'Portal > Contracts > UHC 2026',
      filename: 'uhc-2026.csv',
      data: Buffer.from(csv, 'utf8'),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.feeRows).toBe(2);
    const doc = await pool.query<{ tier: number; client_id: string }>(
      `SELECT tier, client_id FROM documents WHERE source_id = 'client_contracts'`,
    );
    expect(doc.rows[0]!.tier).toBe(5);
    expect(doc.rows[0]!.client_id).toBe(clientId);
    const fees = await pool.query<{ cpt: string; allowed_amount: string }>(
      `SELECT cpt, allowed_amount FROM client_fee_schedule ORDER BY cpt`,
    );
    expect(fees.rows.map((r) => r.cpt)).toEqual(['97140', '98940']);
    const chunks = await pool.query<{ tier: number; client_id: string }>(
      `SELECT c.tier, c.client_id FROM chunks c
       JOIN documents d ON d.id = c.document_id WHERE d.source_id = 'client_contracts'`,
    );
    expect(chunks.rows.length).toBeGreaterThan(0);
    for (const row of chunks.rows) {
      expect(row.tier).toBe(5);
      expect(row.client_id).toBe(clientId);
    }
  });

  it('a revised policy upload supersedes the old version, records a change event, and shows in the digest', async () => {
    const upload = {
      payer: 'UnitedHealthcare',
      title: 'Chiropractic services reimbursement policy',
      effectiveDate: '2026-01-01',
      portalPath: 'https://www.uhcprovider.com/example/policy',
      filename: 'uhc-chiro-policy.docx',
    };
    const v1 = await importPayerPolicy(pool, {
      ...upload,
      data: docxOf(
        'Chiropractic manipulative treatment is reimbursable for codes 98940 to 98942.',
        'Modifier 25 is required on evaluation and management services billed the same day.',
      ),
    });
    expect(v1.ok).toBe(true);

    const v2 = await importPayerPolicy(pool, {
      ...upload,
      data: docxOf(
        'Chiropractic manipulative treatment is reimbursable for codes 98940 to 98943.',
        'Modifier 25 is required on evaluation and management services billed the same day.',
        'Effective July 2026 visit frequency above 24 per year requires records on request.',
      ),
    });
    expect(v2.ok).toBe(true);

    const docs = await pool.query<{ id: string; superseded_by: string | null }>(
      `SELECT id, superseded_by FROM documents WHERE source_id = 'payer_policies'`,
    );
    expect(docs.rows).toHaveLength(2);
    const superseded = docs.rows.find((d) => d.superseded_by !== null);
    const currentDoc = docs.rows.find((d) => d.superseded_by === null);
    expect(superseded?.superseded_by).toBe(currentDoc?.id);

    const events = await pool.query<{ change_type: string }>(
      `SELECT c.change_type FROM change_events c
       JOIN documents d ON d.id = c.document_id
       WHERE d.source_id = 'payer_policies' ORDER BY c.detected_at`,
    );
    expect(events.rows.map((r) => r.change_type)).toEqual(['new', 'revised']);

    const digest = await weeklyDigest(pool);
    const policyChanges = digest.changes.filter((c) => c.source_id === 'payer_policies');
    expect(policyChanges.some((c) => c.change_type === 'revised')).toBe(true);
    expect(policyChanges.every((c) => c.payer === 'UnitedHealthcare')).toBe(true);
  });

  it('re-uploading the identical policy file changes nothing', async () => {
    const data = docxOf(
      'Spinal manipulation coverage requires documentation of a subluxation by exam or imaging.',
    );
    const upload = {
      payer: 'Aetna',
      title: 'Chiropractic services CPB',
      effectiveDate: null,
      portalPath: 'https://www.aetna.com/cpb/medical/data/100_199/0107.html',
      filename: 'aetna-cpb-0107.docx',
      data,
    };
    await importPayerPolicy(pool, upload);
    await importPayerPolicy(pool, upload);
    const docs = await pool.query(
      `SELECT id FROM documents WHERE source_id = 'payer_policies' AND payer = 'Aetna'`,
    );
    expect(docs.rows).toHaveLength(1);
    const events = await pool.query(
      `SELECT c.id FROM change_events c JOIN documents d ON d.id = c.document_id
       WHERE d.source_id = 'payer_policies' AND d.payer = 'Aetna'`,
    );
    expect(events.rows).toHaveLength(1);
  });
});
