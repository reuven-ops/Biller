// Call notes (brief section 14.3, Appendix C): creation with the PHI screen,
// lead approve, retire, and reconfirm, append-only call_note_history, and the
// tier 6 corpus document so search_policy finds every unexpired note.
import { createHash } from 'node:crypto';
import type { Pool } from '@advisor/db';
import { phiScreen, type LlmClient } from '@advisor/core';
import { estimateTokens, extractCodes, replaceChunks, upsertDocument } from '@advisor/ingest';

export const NOTE_TOPICS = [
  'coverage',
  'modifier',
  'documentation',
  'prior auth',
  'timely filing',
  'appeals',
  'fee schedule',
  'other',
] as const;

export interface CallNoteInput {
  payer: string;
  planProduct: string | null;
  lob: string | null;
  state: string | null;
  codes: string[];
  modifiers: string[];
  topic: string;
  ruleAsStated: string;
  repName: string | null;
  callReference: string | null;
  callDate: string; // YYYY-MM-DD
  calledByUserId: string;
  clientId: string | null;
  claimExampleRef: string | null;
  repConfidence: 'stated' | 'implied' | 'unsure';
  attachmentTexts: { filename: string; text: string }[];
}

export interface CallNoteRow {
  id: string;
  payer: string;
  plan_product: string | null;
  lob: string | null;
  state: string | null;
  codes: string[];
  modifiers: string[];
  topic: string;
  rule_as_stated: string;
  rep_name: string | null;
  call_reference: string | null;
  call_date: string;
  client_id: string | null;
  rep_confidence: string | null;
  status: string;
  expires_on: string;
  reconfirmed_on: string | null;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function validateNote(input: CallNoteInput): string | null {
  if (!input.payer.trim()) return 'Payer is required.';
  if (input.codes.length === 0) return 'At least one code is required.';
  if (!(NOTE_TOPICS as readonly string[]).includes(input.topic)) return 'Pick a topic.';
  if (input.ruleAsStated.trim().length < 10)
    return 'Rule as stated is required; write what the representative said.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.callDate)) return 'Call date is required.';
  if (!['stated', 'implied', 'unsure'].includes(input.repConfidence))
    return 'Pick the rep confidence.';
  return null;
}

/** The note as retrieval text, in plain prose so quotes read naturally in answers. */
export function renderNoteText(note: CallNoteRow): string {
  const lines = [
    `Payer call note: ${note.payer}${note.plan_product ? `, ${note.plan_product}` : ''}${note.lob ? `, ${note.lob}` : ''}${note.state ? `, ${note.state}` : ''}.`,
    `Topic: ${note.topic}. Codes: ${note.codes.join(', ')}${note.modifiers.length ? `. Modifiers: ${note.modifiers.join(', ')}` : ''}.`,
    `Rule as stated by the payer representative (confidence ${note.rep_confidence ?? 'unknown'}): ${note.rule_as_stated}`,
    `Representative: ${note.rep_name ?? 'not recorded'}. Call reference: ${note.call_reference ?? 'none'}. Call date: ${note.call_date}. Status: ${note.status}.`,
  ];
  return lines.join('\n');
}

async function writeHistory(
  pool: Pool,
  noteId: string,
  action: string,
  actorUserId: string,
  snapshot: unknown,
): Promise<void> {
  await pool.query(
    `INSERT INTO call_note_history (note_id, action, actor_user_id, snapshot) VALUES ($1,$2,$3,$4)`,
    [noteId, action, actorUserId, JSON.stringify(snapshot)],
  );
}

/**
 * Mirrors a note into the corpus as a tier 6 document with one chunk per note
 * plus one per attachment. retired_date carries the expiry (or the retire date),
 * so retrieval and the verifier exclude expired notes automatically.
 */
export async function syncNoteToCorpus(
  pool: Pool,
  note: CallNoteRow,
  attachmentTexts: { filename: string; text: string }[] = [],
): Promise<void> {
  const text = renderNoteText(note);
  const retired =
    note.status === 'retired' ? new Date().toISOString().slice(0, 10) : note.expires_on;
  const versionHash = createHash('sha256')
    .update(text + retired + attachmentTexts.map((a) => a.text).join('\n'))
    .digest('hex');
  const doc = await upsertDocument(pool, {
    sourceId: 'payer_call_notes',
    externalId: `note-${note.id}`,
    docType: 'call_note',
    title: `Call note, ${note.payer}, ${note.topic}, ${note.call_date}`,
    url: null,
    versionHash,
    effectiveDate: note.call_date,
    revisionDate: null,
    retiredDate: retired,
    tier: 6,
    jurisdiction: note.state ? [note.state] : [],
    payer: note.payer,
    lob: note.lob,
    clientId: note.client_id,
    storagePath: null,
    metadata: { note_id: note.id, status: note.status },
  });
  if (doc.outcome === 'unchanged') return;
  const chunks = [
    {
      sectionPath: 'call note',
      ordinal: 0,
      text,
      tokenCount: estimateTokens(text),
      tier: 6 as const,
      clientId: note.client_id,
      effectiveDate: note.call_date,
      retiredDate: retired,
      codesMentioned: [...new Set([...note.codes, ...extractCodes(text)])].sort(),
      metadata: { note_id: note.id },
    },
    ...attachmentTexts.map((a, i) => ({
      sectionPath: `attachment ${a.filename}`,
      ordinal: i + 1,
      text: `Attachment ${a.filename} to the call note above:\n${a.text.slice(0, 8000)}`,
      tokenCount: estimateTokens(a.text),
      tier: 6 as const,
      clientId: note.client_id,
      effectiveDate: note.call_date,
      retiredDate: retired,
      codesMentioned: extractCodes(a.text),
      metadata: { note_id: note.id, attachment: a.filename },
    })),
  ];
  await replaceChunks(pool, doc.documentId, chunks);
}

export type CreateNoteResult =
  { ok: true; noteId: string } | { ok: false; error: string; phi?: boolean };

export async function createCallNote(
  pool: Pool,
  llm: LlmClient,
  input: CallNoteInput,
): Promise<CreateNoteResult> {
  const invalid = validateNote(input);
  if (invalid) return { ok: false, error: invalid };

  // PHI screen on the free text and every attachment; on a hit nothing persists.
  const screened = [input.ruleAsStated, ...input.attachmentTexts.map((a) => a.text)];
  for (const text of screened) {
    const phi = await phiScreen(llm, text);
    if (phi.phi) {
      return {
        ok: false,
        phi: true,
        error:
          'The note appears to contain protected health information ' +
          `(${phi.categories.join(', ') || 'identifier pattern'}). Remove names, dates of birth, ` +
          'member IDs, and record numbers, then save again. Nothing was saved.',
      };
    }
  }

  const expires = addDays(input.callDate, 365);
  const res = await pool.query<CallNoteRow>(
    `INSERT INTO payer_call_notes (payer, plan_product, lob, state, codes, modifiers, topic,
       rule_as_stated, rep_name, call_reference, call_date, called_by_user_id, client_id,
       claim_example_id, rep_confidence, expires_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id, payer, plan_product, lob, state, codes, modifiers, topic, rule_as_stated,
       rep_name, call_reference, call_date::text AS call_date, client_id, rep_confidence,
       status, expires_on::text AS expires_on, reconfirmed_on::text AS reconfirmed_on`,
    [
      input.payer,
      input.planProduct,
      input.lob,
      input.state,
      input.codes,
      input.modifiers,
      input.topic,
      input.ruleAsStated,
      input.repName,
      input.callReference,
      input.callDate,
      input.calledByUserId,
      input.clientId,
      input.claimExampleRef,
      input.repConfidence,
      expires,
    ],
  );
  const note = res.rows[0];
  if (!note) return { ok: false, error: 'Insert failed.' };
  await writeHistory(pool, note.id, 'created', input.calledByUserId, note);
  await syncNoteToCorpus(pool, note, input.attachmentTexts);
  return { ok: true, noteId: note.id };
}

async function loadNote(pool: Pool, noteId: string): Promise<CallNoteRow | null> {
  const res = await pool.query<CallNoteRow>(
    `SELECT id, payer, plan_product, lob, state, codes, modifiers, topic, rule_as_stated,
       rep_name, call_reference, call_date::text AS call_date, client_id, rep_confidence,
       status, expires_on::text AS expires_on, reconfirmed_on::text AS reconfirmed_on
     FROM payer_call_notes WHERE id::text = $1`,
    [noteId],
  );
  return res.rows[0] ?? null;
}

async function transition(
  pool: Pool,
  noteId: string,
  actorUserId: string,
  action: 'approved' | 'retired' | 'reconfirmed',
  update: string,
  params: unknown[],
): Promise<boolean> {
  const res = await pool.query(update, [noteId, ...params]);
  if (!res.rowCount) return false;
  const note = await loadNote(pool, noteId);
  if (!note) return false;
  await writeHistory(pool, noteId, action, actorUserId, note);
  await syncNoteToCorpus(pool, note);
  return true;
}

export async function approveNote(pool: Pool, noteId: string, leadId: string): Promise<boolean> {
  return transition(
    pool,
    noteId,
    leadId,
    'approved',
    `UPDATE payer_call_notes SET status = 'lead_approved', approved_by = $2, approved_at = now()
     WHERE id::text = $1 AND status = 'unverified'`,
    [leadId],
  );
}

export async function retireNote(pool: Pool, noteId: string, leadId: string): Promise<boolean> {
  return transition(
    pool,
    noteId,
    leadId,
    'retired',
    `UPDATE payer_call_notes SET status = 'retired' WHERE id::text = $1 AND status <> 'retired'`,
    [],
  );
}

/** Reconfirmation resets expiry to today plus 365 (Appendix C behavior). */
export async function reconfirmNote(pool: Pool, noteId: string, leadId: string): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  return transition(
    pool,
    noteId,
    leadId,
    'reconfirmed',
    `UPDATE payer_call_notes SET reconfirmed_on = $2, expires_on = $3
     WHERE id::text = $1 AND status <> 'retired'`,
    [today, addDays(today, 365)],
  );
}
