// Call notes pages (brief section 13.3): list with filters, the Appendix C add
// form, lead approve, retire, reconfirm, and the expiring-soon view.
import type { Pool } from '@advisor/db';
import { createLlmClient, loadJurisdictions, loadPayers } from '@advisor/core';
import { extractPdfLines } from '@advisor/ingest';
import {
  approveNote,
  createCallNote,
  NOTE_TOPICS,
  reconfirmNote,
  retireNote,
} from '../notes-store.js';
import { html, layout } from '../html.js';
import { redirect, sendHtml, type Handler, type Router } from '../http.js';

interface AuthedLike {
  user: {
    id: string;
    email: string;
    name: string;
    role: 'biller' | 'lead' | 'admin';
    clientIds: string[];
  };
  csrf: string;
}
type Authed = (
  minRole: 'biller' | 'lead' | 'admin',
  handler: (ctx: AuthedLike & Parameters<Handler>[0]) => Promise<void> | void,
) => Handler;

interface NoteListRow {
  id: string;
  payer: string;
  state: string | null;
  codes: string[];
  topic: string;
  rule_as_stated: string;
  call_date: string;
  status: string;
  expires_on: string;
  rep_confidence: string | null;
  called_by: string | null;
}

function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export function registerNotesRoutes(router: Router, pool: Pool, authed: Authed): void {
  router.get(
    '/notes',
    authed('biller', async (ctx) => {
      const payer = (ctx.query.get('payer') ?? '').trim();
      const code = (ctx.query.get('code') ?? '').trim().toUpperCase();
      const status = (ctx.query.get('status') ?? '').trim();
      const saved = ctx.query.get('saved');
      const where: string[] = [];
      const params: unknown[] = [];
      if (payer) {
        params.push(`%${payer}%`);
        where.push(`n.payer ILIKE $${params.length}`);
      }
      if (code) {
        params.push(code);
        where.push(`$${params.length} = ANY(n.codes)`);
      }
      if (status) {
        params.push(status);
        where.push(`n.status = $${params.length}`);
      }
      const res = await pool.query<NoteListRow>(
        `SELECT n.id, n.payer, n.state, n.codes, n.topic, n.rule_as_stated,
                n.call_date::text AS call_date, n.status, n.expires_on::text AS expires_on,
                n.rep_confidence, u.email AS called_by
         FROM payer_call_notes n LEFT JOIN users u ON u.id = n.called_by_user_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY n.call_date DESC LIMIT 100`,
        params,
      );
      const expiring = await pool.query<NoteListRow>(
        `SELECT n.id, n.payer, n.state, n.codes, n.topic, n.rule_as_stated,
                n.call_date::text AS call_date, n.status, n.expires_on::text AS expires_on,
                n.rep_confidence, NULL AS called_by
         FROM payer_call_notes n
         WHERE n.status <> 'retired' AND n.expires_on <= now()::date + 30
         ORDER BY n.expires_on LIMIT 20`,
      );
      const isLead = ctx.user.role !== 'biller';
      const actions = (r: NoteListRow) =>
        html`${
          r.status === 'unverified'
            ? html`<form class="inline" method="post" action="/notes/${r.id}/approve">
                <input type="hidden" name="csrf" value="${ctx.csrf}" />
                <button class="quiet" type="submit">Approve</button>
              </form>`
            : ''
        }
        ${
          r.status !== 'retired'
            ? html`<form class="inline" method="post" action="/notes/${r.id}/reconfirm">
                  <input type="hidden" name="csrf" value="${ctx.csrf}" />
                  <button class="quiet" type="submit">Reconfirm</button>
                </form>
                <form class="inline" method="post" action="/notes/${r.id}/retire">
                  <input type="hidden" name="csrf" value="${ctx.csrf}" />
                  <button class="quiet" type="submit">Retire</button>
                </form>`
            : ''
        }`;
      const noteTable = (rows: NoteListRow[]) =>
        html`<table>
          <thead>
            <tr>
              <th>Call date</th>
              <th>Payer</th>
              <th>Codes</th>
              <th>Rule as stated</th>
              <th>Status</th>
              <th>Expires</th>
              ${isLead ? html`<th></th>` : ''}
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (r) => html`
                <tr>
                  <td>${r.call_date}</td>
                  <td>${r.payer}${r.state ? html` <span class="muted">${r.state}</span>` : ''}</td>
                  <td>${r.codes.join(', ')}</td>
                  <td>
                    ${r.rule_as_stated.slice(0, 120)}${r.rule_as_stated.length > 120 ? '…' : ''}
                    <span class="muted">(${r.topic}, ${r.rep_confidence ?? 'unknown'})</span>
                  </td>
                  <td><span class="pill">${r.status}</span></td>
                  <td>${r.expires_on}</td>
                  ${isLead ? html`<td>${actions(r)}</td>` : ''}
                </tr>
              `,
            )}
          </tbody>
        </table>`;
      sendHtml(
        ctx,
        200,
        layout({
          title: 'Call notes',
          user: ctx.user,
          active: '/notes',
          csrf: ctx.csrf,
          body: html`
            <h1>Call notes</h1>
            ${saved ? html`<div class="notice">Call note saved. It is citable immediately as unverified; a lead reviews it.</div>` : ''}
            <p>
              <a href="/notes/new"><button type="button">Add call note</button></a>
            </p>
            <div class="card">
              <form method="get" action="/notes">
                <div class="row">
                  <div>
                    <label for="f-payer">Payer</label>
                    <input id="f-payer" name="payer" type="text" value="${payer}" />
                  </div>
                  <div>
                    <label for="f-code">Code</label>
                    <input id="f-code" name="code" type="text" value="${code}" />
                  </div>
                  <div>
                    <label for="f-status">Status</label>
                    <select id="f-status" name="status">
                      <option value="">any</option>
                      ${['unverified', 'lead_approved', 'retired'].map(
                        (s) =>
                          html`<option value="${s}" ${s === status ? 'selected' : ''}>
                            ${s}
                          </option>`,
                      )}
                    </select>
                  </div>
                </div>
                <p><button type="submit" class="quiet">Filter</button></p>
              </form>
            </div>
            <div class="card">
              ${res.rows.length ? noteTable(res.rows) : html`<p class="muted">No notes match. Record what a payer told you and the whole team benefits.</p>`}
            </div>
            <h2>Expiring within 30 days</h2>
            <div class="card">
              ${
                expiring.rows.length
                  ? noteTable(expiring.rows)
                  : html`<p class="muted">Nothing expiring soon.</p>`
              }
            </div>
          `,
        }),
      );
    }),
  );

  router.get(
    '/notes/new',
    authed('biller', async (ctx) => {
      const [payers, jurisdictions, clients] = await Promise.all([
        loadPayers(),
        loadJurisdictions(),
        ctx.user.clientIds.length
          ? pool.query<{ id: string; name: string }>(
              'SELECT id, name FROM clients WHERE id = ANY($1) AND active ORDER BY name',
              [ctx.user.clientIds],
            )
          : Promise.resolve({ rows: [] as { id: string; name: string }[] }),
      ]);
      const error = ctx.query.get('error');
      const today = new Date().toISOString().slice(0, 10);
      sendHtml(
        ctx,
        200,
        layout({
          title: 'Add call note',
          user: ctx.user,
          active: '/notes',
          csrf: ctx.csrf,
          body: html`
            <h1>Add call note</h1>
            ${error ? html`<div class="error">${error}</div>` : ''}
            <div class="card">
              <form method="post" action="/notes" enctype="multipart/form-data">
                <input type="hidden" name="csrf" value="${ctx.csrf}" />
                <div class="row">
                  <div>
                    <label for="n-payer">Payer</label>
                    <select id="n-payer" name="payer">
                      ${['Medicare Part B', 'Medicare Advantage', ...payers.map((p) => p.name)].map(
                        (p) => html`<option value="${p}">${p}</option>`,
                      )}
                    </select>
                  </div>
                  <div>
                    <label for="n-plan">Plan or product</label>
                    <input id="n-plan" name="plan_product" type="text" />
                  </div>
                  <div>
                    <label for="n-lob">Line of business</label>
                    <select id="n-lob" name="lob">
                      ${['Medicare', 'MA', 'Commercial', 'Medicaid', 'Other'].map(
                        (l) => html`<option value="${l}">${l}</option>`,
                      )}
                    </select>
                  </div>
                  <div>
                    <label for="n-state">State</label>
                    <select id="n-state" name="state">
                      ${jurisdictions.macs
                        .flatMap((m) => m.states)
                        .sort()
                        .map(
                          (s) =>
                            html`<option
                              value="${s}"
                              ${s === jurisdictions.default_state ? 'selected' : ''}
                            >
                              ${s}
                            </option>`,
                        )}
                    </select>
                  </div>
                </div>
                <div class="row">
                  <div>
                    <label for="n-codes">Codes (space or comma separated)</label>
                    <input id="n-codes" name="codes" type="text" required />
                  </div>
                  <div>
                    <label for="n-mods">Modifiers (optional)</label>
                    <input id="n-mods" name="modifiers" type="text" />
                  </div>
                  <div>
                    <label for="n-topic">Topic</label>
                    <select id="n-topic" name="topic">
                      ${NOTE_TOPICS.map((t) => html`<option value="${t}">${t}</option>`)}
                    </select>
                  </div>
                </div>
                <label for="n-rule">Rule as stated by the representative</label>
                <textarea
                  id="n-rule"
                  name="rule_as_stated"
                  required
                  placeholder="What did they say, in plain words. No patient names, DOBs, or member IDs."
                ></textarea>
                <div class="row">
                  <div>
                    <label for="n-rep">Rep name</label>
                    <input id="n-rep" name="rep_name" type="text" />
                  </div>
                  <div>
                    <label for="n-ref">Call reference number</label>
                    <input id="n-ref" name="call_reference" type="text" />
                  </div>
                  <div>
                    <label for="n-date">Call date</label>
                    <input id="n-date" name="call_date" type="date" value="${today}" required />
                  </div>
                  <div>
                    <label for="n-conf">Rep confidence</label>
                    <select id="n-conf" name="rep_confidence">
                      ${['stated', 'implied', 'unsure'].map((c) => html`<option value="${c}">${c}</option>`)}
                    </select>
                  </div>
                </div>
                <div class="row">
                  ${
                    clients.rows.length
                      ? html`<div>
                          <label for="n-client">Client (optional)</label>
                          <select id="n-client" name="client">
                            <option value="">none</option>
                            ${clients.rows.map((c) => html`<option value="${c.id}">${c.name}</option>`)}
                          </select>
                        </div>`
                      : ''
                  }
                  <div>
                    <label for="n-claim">Claim reference (optional, no patient identifiers)</label>
                    <input id="n-claim" name="claim_example_ref" type="text" />
                  </div>
                  <div>
                    <label for="n-att">Portal screenshot PDFs (optional, PHI screened)</label>
                    <input
                      id="n-att"
                      name="attachments"
                      type="file"
                      accept="application/pdf"
                      multiple
                    />
                  </div>
                </div>
                <p><button type="submit">Save call note</button></p>
                <p class="muted">
                  A note without a call reference number is weak evidence in an appeal. Notes are
                  citable immediately as unverified and expire ${365} days after the call date.
                </p>
              </form>
            </div>
          `,
        }),
      );
    }),
  );

  router.post(
    '/notes',
    authed('biller', async (ctx) => {
      const attachmentTexts: { filename: string; text: string }[] = [];
      for (const file of ctx.files.filter((f) => f.field === 'attachments')) {
        try {
          const extracted = await extractPdfLines(new Uint8Array(file.data));
          attachmentTexts.push({ filename: file.filename, text: extracted.lines.join('\n') });
        } catch {
          redirect(
            ctx,
            `/notes/new?error=${encodeURIComponent(`Could not read ${file.filename}; attach PDF files only.`)}`,
          );
          return;
        }
      }
      const clientId = ctx.form['client'] || null;
      if (clientId && !ctx.user.clientIds.includes(clientId)) {
        redirect(
          ctx,
          `/notes/new?error=${encodeURIComponent('You are not assigned to that client.')}`,
        );
        return;
      }
      const result = await createCallNote(pool, createLlmClient(), {
        payer: ctx.form['payer'] ?? '',
        planProduct: ctx.form['plan_product'] || null,
        lob: ctx.form['lob'] || null,
        state: ctx.form['state'] || null,
        codes: splitList(ctx.form['codes'] ?? ''),
        modifiers: splitList(ctx.form['modifiers'] ?? ''),
        topic: ctx.form['topic'] ?? '',
        ruleAsStated: (ctx.form['rule_as_stated'] ?? '').trim(),
        repName: ctx.form['rep_name'] || null,
        callReference: ctx.form['call_reference'] || null,
        callDate: ctx.form['call_date'] ?? '',
        calledByUserId: ctx.user.id,
        clientId,
        claimExampleRef: ctx.form['claim_example_ref'] || null,
        repConfidence: (ctx.form['rep_confidence'] ?? 'unsure') as 'stated' | 'implied' | 'unsure',
        attachmentTexts,
      });
      if (!result.ok) {
        redirect(ctx, `/notes/new?error=${encodeURIComponent(result.error)}`);
        return;
      }
      redirect(ctx, '/notes?saved=1');
    }),
  );

  const transition = (
    name: string,
    fn: (pool: Pool, id: string, leadId: string) => Promise<boolean>,
  ) => {
    router.post(
      `/notes/:id/${name}`,
      authed('lead', async (ctx) => {
        await fn(pool, ctx.params['id'] ?? '', ctx.user.id);
        redirect(ctx, '/notes');
      }),
    );
  };
  transition('approve', approveNote);
  transition('retire', retireNote);
  transition('reconfirm', reconfirmNote);
}
