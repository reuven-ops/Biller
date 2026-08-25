// The Ask page and answer views (brief section 13.1). POST /ask starts the agent
// loop in the background; /q/<id> meta-refreshes while it runs, then renders the
// answer from qa_log so live answers and history share one rendering path.
import type { Pool } from '@advisor/db';
import {
  loadJurisdictions,
  loadPayers,
  loadProviderTypes,
  type Answer,
  type EvidenceRecord,
} from '@advisor/core';
import { questionsInLastHour, RATE_LIMIT_PER_HOUR } from '../auth.js';
import { getPending, startAsk } from '../asks.js';
import { html, layout, type Safe } from '../html.js';
import { redirect, sendHtml, type Handler, type Router } from '../http.js';
import { renderAnswerHtml } from '../render-answer.js';

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

const EXAMPLES = [
  'Can 97140 be billed with 98940 on the same date of service for Medicare, and what modifier applies?',
  'What is the KX modifier threshold amount for physical therapy this year?',
  'Does Medicare cover 90837 by telehealth after the latest telehealth rules?',
  'What documentation does Medicare require for the AT modifier on chiropractic claims?',
];

async function clientOptions(
  pool: Pool,
  clientIds: string[],
): Promise<{ id: string; name: string }[]> {
  if (clientIds.length === 0) return [];
  const res = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM clients WHERE id = ANY($1) AND active ORDER BY name',
    [clientIds],
  );
  return res.rows;
}

export function registerAskRoutes(router: Router, pool: Pool, authed: Authed): void {
  router.get(
    '/',
    authed('biller', async (ctx) => {
      const [payers, jurisdictions, providerTypes, clients] = await Promise.all([
        loadPayers(),
        loadJurisdictions(),
        loadProviderTypes(),
        clientOptions(pool, ctx.user.clientIds),
      ]);
      const payerNames = [
        'Medicare Part B',
        'Medicare Advantage',
        ...payers.map((p) => p.name).filter((n) => !n.startsWith('Medicare')),
      ];
      const today = new Date().toISOString().slice(0, 10);
      const used = await questionsInLastHour(pool, ctx.user.id);
      sendHtml(
        ctx,
        200,
        layout({
          title: 'Ask',
          user: ctx.user,
          active: '/',
          csrf: ctx.csrf,
          body: html`
            <h1>Ask a coding or billing question</h1>
            <div class="card">
              <form method="post" action="/ask">
                <input type="hidden" name="csrf" value="${ctx.csrf}" />
                <label for="question">Question</label>
                <textarea
                  id="question"
                  name="question"
                  required
                  placeholder="No patient names, dates of birth, or IDs. Describe codes, payer, and situation."
                ></textarea>
                <div class="row">
                  <div>
                    <label for="dos">Date of service</label>
                    <input id="dos" name="dos" type="date" value="${today}" />
                  </div>
                  <div>
                    <label for="payer">Payer</label>
                    <select id="payer" name="payer">
                      ${payerNames.map((p) => html`<option value="${p}">${p}</option>`)}
                    </select>
                  </div>
                  <div>
                    <label for="jurisdiction">State</label>
                    <select id="jurisdiction" name="jurisdiction">
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
                  <div>
                    <label for="provider">Provider type</label>
                    <select id="provider" name="provider">
                      ${providerTypes.map((t) => html`<option value="${t.id}">${t.name}</option>`)}
                    </select>
                  </div>
                  ${
                    clients.length
                      ? html`<div>
                          <label for="client">Client</label>
                          <select id="client" name="client">
                            <option value="">none</option>
                            ${clients.map((c) => html`<option value="${c.id}">${c.name}</option>`)}
                          </select>
                        </div>`
                      : ''
                  }
                </div>
                <p><button type="submit">Ask</button></p>
              </form>
              <p class="muted">
                ${RATE_LIMIT_PER_HOUR - used} of ${RATE_LIMIT_PER_HOUR} questions left this hour.
                Answers cite retrieved evidence only; the tool abstains when evidence is missing.
              </p>
            </div>
            <h2>Example questions</h2>
            <div class="card">
              <ul>
                ${EXAMPLES.map((q) => html`<li>${q}</li>`)}
              </ul>
            </div>
          `,
        }),
      );
    }),
  );

  router.post(
    '/ask',
    authed('biller', async (ctx) => {
      const question = (ctx.form['question'] ?? '').trim();
      if (!question) {
        redirect(ctx, '/');
        return;
      }
      const used = await questionsInLastHour(pool, ctx.user.id);
      if (used >= RATE_LIMIT_PER_HOUR) {
        sendHtml(
          ctx,
          429,
          layout({
            title: 'Rate limit',
            user: ctx.user,
            csrf: ctx.csrf,
            body: html`<div class="error">
              You have asked ${used} questions in the last hour. The limit is ${RATE_LIMIT_PER_HOUR}
              per hour; try again shortly.
            </div>`,
          }),
        );
        return;
      }
      const clientId = ctx.form['client'] || undefined;
      if (clientId && !ctx.user.clientIds.includes(clientId)) {
        sendHtml(
          ctx,
          403,
          layout({
            title: 'Not allowed',
            user: ctx.user,
            csrf: ctx.csrf,
            body: html`<div class="error">You are not assigned to that client.</div>`,
          }),
        );
        return;
      }
      const id = startAsk(pool, ctx.user.id, {
        question,
        dos: ctx.form['dos'] || undefined,
        payer: ctx.form['payer'] || undefined,
        jurisdiction: ctx.form['jurisdiction'] || undefined,
        providerType: ctx.form['provider'] || undefined,
        clientId,
        userId: ctx.user.id,
        userClientIds: ctx.user.clientIds,
      });
      redirect(ctx, `/q/${id}`);
    }),
  );

  router.get(
    '/q/:id',
    authed('biller', async (ctx) => {
      const id = ctx.params['id'] ?? '';
      const entry = getPending(id);
      if (entry) {
        if (entry.status === 'running') {
          const seconds = Math.round((Date.now() - entry.startedAt) / 1000);
          sendHtml(
            ctx,
            200,
            layout({
              title: 'Working',
              user: ctx.user,
              csrf: ctx.csrf,
              refreshSeconds: 5,
              body: html`
                <h1>Composing the answer</h1>
                <div class="card">
                  <p>${entry.question}</p>
                  <p class="muted">
                    ${seconds}s elapsed. The agent is retrieving evidence, checking NCCI and fee
                    schedule tables, and verifying every statement. This page refreshes on its own;
                    a thorough answer usually takes one to three minutes.
                  </p>
                </div>
              `,
            }),
          );
          return;
        }
        if (entry.status === 'error') {
          sendHtml(
            ctx,
            500,
            layout({
              title: 'Failed',
              user: ctx.user,
              csrf: ctx.csrf,
              body: html`<div class="error">The answer failed: ${entry.error}</div>
                <p><a href="/">Ask again</a></p>`,
            }),
          );
          return;
        }
        if (entry.qaLogId) {
          redirect(ctx, `/q/${entry.qaLogId}`);
          return;
        }
      }
      // Not pending: render from qa_log (also the path for history links).
      const res = await pool.query<{
        id: string;
        question_text: string | null;
        answer: Answer | null;
        evidence: EvidenceRecord[];
        phi_flag: boolean;
        user_id: string | null;
        client_id: string | null;
        cost_usd: string;
        latency_ms: number;
      }>(
        `SELECT id, question_text, answer, evidence, phi_flag, user_id, client_id, cost_usd, latency_ms
         FROM qa_log WHERE id::text = $1`,
        [id],
      );
      const row = res.rows[0];
      if (!row) {
        sendHtml(
          ctx,
          404,
          layout({
            title: 'Not found',
            user: ctx.user,
            csrf: ctx.csrf,
            body: html`<p>No such question. It may have been lost in a restart; ask again.</p>`,
          }),
        );
        return;
      }
      // Client-scoped answers are visible only to users assigned to that client.
      if (
        row.client_id &&
        !ctx.user.clientIds.includes(row.client_id) &&
        ctx.user.role !== 'admin'
      ) {
        sendHtml(
          ctx,
          403,
          layout({
            title: 'Not allowed',
            user: ctx.user,
            csrf: ctx.csrf,
            body: html`<div class="error">
              This answer is scoped to a client you are not assigned to.
            </div>`,
          }),
        );
        return;
      }
      if (row.phi_flag) {
        sendHtml(
          ctx,
          200,
          layout({
            title: 'Refused',
            user: ctx.user,
            csrf: ctx.csrf,
            body: html`<div class="error">
                This question was refused because it appeared to contain protected health
                information. The question text was not saved. Remove names, dates of birth, member
                IDs, and record numbers, then ask again.
              </div>
              <p><a href="/">Ask again</a></p>`,
          }),
        );
        return;
      }
      if (!row.answer) {
        sendHtml(
          ctx,
          200,
          layout({
            title: 'No answer',
            user: ctx.user,
            csrf: ctx.csrf,
            body: html`<p>No stored answer for this question.</p>`,
          }),
        );
        return;
      }
      const feedbackDone = ctx.query.get('fb') ?? undefined;
      // Similar past questions from team history (brief 13.1), full-text ranked,
      // respecting client scope.
      const similar = await pool.query<{ id: string; question_text: string; ts: Date }>(
        `SELECT id, question_text, ts FROM qa_log
         WHERE id::text <> $1 AND question_text IS NOT NULL AND answer IS NOT NULL
           AND ($3::uuid[] IS NULL OR client_id IS NULL OR client_id = ANY($3))
           AND to_tsvector('english', question_text) @@ plainto_tsquery('english', $2)
         ORDER BY ts_rank(to_tsvector('english', question_text), plainto_tsquery('english', $2)) DESC,
                  ts DESC
         LIMIT 5`,
        [row.id, row.question_text ?? '', ctx.user.role === 'admin' ? null : ctx.user.clientIds],
      );
      const body: Safe = html`
        <h1>Answer</h1>
        <div class="card"><strong>Q:</strong> ${row.question_text ?? ''}</div>
        ${renderAnswerHtml({
          answer: row.answer,
          evidence: row.evidence,
          qaId: row.id,
          csrf: ctx.csrf,
          feedbackDone,
        })}
        ${
          similar.rows.length
            ? html`<h2>Similar past questions</h2>
                <div class="card">
                  <ul>
                    ${similar.rows.map(
                      (s) =>
                        html`<li>
                          <a href="/q/${s.id}">${s.question_text.slice(0, 120)}</a>
                          <span class="muted">${s.ts.toISOString().slice(0, 10)}</span>
                        </li>`,
                    )}
                  </ul>
                </div>`
            : ''
        }
        <p class="muted">
          Cost $${Number(row.cost_usd).toFixed(2)}, ${Math.round(row.latency_ms / 1000)}s.
          <a href="/">Ask another question</a>
        </p>
      `;
      sendHtml(
        ctx,
        200,
        layout({ title: 'Answer', user: ctx.user, active: '/', csrf: ctx.csrf, body }),
      );
    }),
  );

  router.post(
    '/q/:id/feedback',
    authed('biller', async (ctx) => {
      const verdict = ctx.form['verdict'] ?? '';
      if (!['correct', 'incorrect', 'partial'].includes(verdict)) {
        redirect(ctx, `/q/${ctx.params['id']}`);
        return;
      }
      await pool.query(
        'INSERT INTO qa_feedback (qa_id, user_id, verdict, note) VALUES ($1, $2, $3, $4)',
        [ctx.params['id'], ctx.user.id, verdict, ctx.form['note'] || null],
      );
      redirect(ctx, `/q/${ctx.params['id']}?fb=${verdict}`);
    }),
  );

  router.post(
    '/q/:id/request-source',
    authed('biller', async (ctx) => {
      const qa = await pool.query<{ missing: string[] | null }>(
        `SELECT (answer -> 'missing_sources') AS missing FROM qa_log WHERE id::text = $1`,
        [ctx.params['id']],
      );
      const missing = qa.rows[0]?.missing ?? [];
      await pool.query(
        `INSERT INTO source_requests (qa_id, requested_by, payer_or_source, note, status)
         VALUES ($1, $2, $3, $4, 'open')`,
        [
          ctx.params['id'],
          ctx.user.id,
          missing.join(', ') || 'unspecified',
          ctx.form['note'] || 'Requested from an abstained answer',
        ],
      );
      redirect(ctx, `/q/${ctx.params['id']}?fb=source-requested`);
    }),
  );
}
