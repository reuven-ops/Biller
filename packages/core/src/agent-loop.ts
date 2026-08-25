// The agent loop (brief section 10): normalize question, PHI screen, composer with
// tools (maximum 14 tool calls), submit_answer, verifier, qa_log.
import type { Pool } from '@advisor/db';
import { optionalEnv } from '@advisor/db';
import type { Answer } from './answer-schema.js';
import { abstention, validateAnswer } from './answer-schema.js';
import type { LlmClient, LlmMessage } from './llm.js';
import { modelConfig } from './llm.js';
import { phiScreen, promptText, promptVersion } from './phi.js';
import { newToolContext, dispatchTool, TOOL_DEFINITIONS } from './tools.js';
import type { ToolContext } from './tools.js';
import { verifyAnswer } from './verifier.js';
import type { VerifierOutput } from './verifier.js';
import { queryCodes } from './retrieval.js';

export const MAX_TOOL_CALLS = 14;
const EVIDENCE_CONTEXT_CHAR_CAP = 160_000; // roughly the 40K token evidence cap

export interface AskRequest {
  question: string;
  dos?: string | undefined;
  payer?: string | undefined;
  jurisdiction?: string | undefined;
  providerType?: string | undefined;
  clientId?: string | undefined;
  userId?: string | undefined;
  userClientIds?: string[] | undefined;
  refreshSource?: ((sourceId: string) => Promise<string>) | undefined;
}

export interface AskResult {
  answer: Answer;
  verifier: VerifierOutput | null;
  phiRefused: boolean;
  qaLogId: string | null;
  toolCalls: { name: string; input: unknown }[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number };
  stubMode: boolean;
}

interface Normalized {
  dos: string;
  payer: string;
  jurisdiction: string;
  providerType: string;
  setting: string;
  client: string | null;
  defaultsApplied: string[];
  codesMentioned: string[];
}

export function normalizeQuestion(req: AskRequest): Normalized {
  const defaultsApplied: string[] = [];
  const tz = optionalEnv('DEFAULT_TZ', 'America/New_York');
  let dos = req.dos;
  if (!dos) {
    dos = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    defaultsApplied.push(`DOS defaulted to today (${dos}) in ${tz}`);
  }
  let payer = req.payer;
  if (!payer) {
    payer = optionalEnv('DEFAULT_PAYER', 'Medicare Part B');
    defaultsApplied.push(`payer defaulted to ${payer}`);
  }
  let jurisdiction = req.jurisdiction;
  if (!jurisdiction) {
    jurisdiction = 'FL';
    defaultsApplied.push('jurisdiction defaulted to FL (First Coast, JN)');
  }
  let providerType = req.providerType;
  if (!providerType) {
    providerType = 'inferred from context';
    defaultsApplied.push('provider type inferred from context');
  }
  defaultsApplied.push('setting defaulted to office, POS 11');
  return {
    dos,
    payer,
    jurisdiction,
    providerType,
    setting: 'office, POS 11',
    client: req.clientId ?? null,
    defaultsApplied,
    codesMentioned: queryCodes(req.question),
  };
}

async function freshnessBlock(
  pool: Pool,
  ctx: ToolContext,
  normalized: Normalized,
): Promise<Answer['freshness']> {
  // Sources used plus the sources expected for the question class (brief 12.3).
  const expected = new Set(ctx.sourcesUsed);
  if (normalized.codesMentioned.length >= 2) expected.add('cms_ncci_ptp');
  if (/pay|payment|rate|rvu|fee|reimburs/i.test(normalized.payer + ' ')) expected.add('cms_mpfs');
  if (/medicare/i.test(normalized.payer)) expected.add('cms_mcd');
  else {
    expected.add('payer_policies');
    expected.add('payer_call_notes');
  }
  const res = await pool.query<{
    id: string;
    cadence_days: number;
    last_success_at: Date | null;
    stale: boolean;
  }>(
    `SELECT id, cadence_days, last_success_at,
            (last_error IS NOT NULL OR last_success_at IS NULL
             OR now() - last_success_at > (cadence_days * interval '1 day') * 1.5) AS stale
     FROM sources WHERE enabled AND id = ANY($1::text[])`,
    [[...expected]],
  );
  return {
    as_of: new Date().toISOString().slice(0, 10),
    stale_sources: res.rows
      .filter((r) => r.stale)
      .map((r) => ({
        source_id: r.id,
        last_success_at: r.last_success_at?.toISOString() ?? 'never',
        cadence_days: r.cadence_days,
      })),
  };
}

/** Today's model spend from qa_log, for the daily cost cap. */
export async function spendTodayUsd(pool: Pool): Promise<number> {
  const res = await pool.query<{ total: string | null }>(
    `SELECT sum(cost_usd)::text AS total FROM qa_log WHERE ts >= date_trunc('day', now())`,
  );
  return Number(res.rows[0]?.total ?? 0);
}

export async function ask(pool: Pool, llm: LlmClient, req: AskRequest): Promise<AskResult> {
  const started = Date.now();
  const models = modelConfig();
  const cap = Number(optionalEnv('DAILY_COST_CAP_USD', '25'));
  if (llm.mode === 'live') {
    const spent = await spendTodayUsd(pool);
    if (spent >= cap) {
      throw new Error(
        `Daily cost cap reached ($${spent.toFixed(2)} of $${cap}); answers pause until tomorrow or the cap is raised.`,
      );
    }
  }
  const composerPrompt = promptText('composer.md');
  const normalized = normalizeQuestion(req);
  const ctx = newToolContext(pool, {
    userClientIds: req.userClientIds ?? [],
    dos: normalized.dos,
    jurisdiction: normalized.jurisdiction,
    payer: normalized.payer,
    refreshSource: req.refreshSource,
  });
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
  const toolCalls: { name: string; input: unknown }[] = [];

  // PHI screen: on a hit under PHI_MODE=deny, refuse and never persist the text.
  const phi = await phiScreen(llm, req.question);
  if (phi.phi && optionalEnv('PHI_MODE', 'deny') === 'deny') {
    const freshness = await freshnessBlock(pool, ctx, normalized);
    const refusal = abstention(
      {
        dos: normalized.dos,
        payer: normalized.payer,
        jurisdiction: normalized.jurisdiction,
        provider_type: normalized.providerType,
        setting: normalized.setting,
        client: normalized.client,
        defaults_applied: normalized.defaultsApplied,
      },
      `The question appears to contain protected health information (${phi.categories.join(', ')}). ` +
        'Remove patient identifiers (names, dates of birth, member IDs) and ask again with a de-identified scenario.',
      [],
      freshness,
    );
    refusal.next_action = { type: 'none', script: null };
    usage.latencyMs = Date.now() - started;
    const qaLogId = await writeQaLog(
      pool,
      req,
      normalized,
      null,
      refusal,
      null,
      usage,
      true,
      models,
    );
    return {
      answer: refusal,
      verifier: null,
      phiRefused: true,
      qaLogId,
      toolCalls,
      usage,
      stubMode: llm.mode === 'stub',
    };
  }

  // Composer loop.
  const messages: LlmMessage[] = [
    {
      role: 'user',
      content:
        `Question: ${req.question}\n\n` +
        `Run context: DOS ${normalized.dos}; payer ${normalized.payer}; jurisdiction ${normalized.jurisdiction}; ` +
        `provider type ${normalized.providerType}; setting ${normalized.setting}; ` +
        `client ${normalized.client ?? 'none'}; defaults applied: ${normalized.defaultsApplied.join('; ')}. ` +
        `Codes mentioned in the question: ${normalized.codesMentioned.join(', ') || 'none detected'}. ` +
        `As-of date: ${new Date().toISOString().slice(0, 10)}.`,
    },
  ];

  let submitted: Answer | null = null;
  let submitError: string | null = null;
  for (let round = 0; round < MAX_TOOL_CALLS + 2 && submitted === null; round++) {
    const res = await llm.complete({
      model: models.composer,
      system: composerPrompt,
      messages,
      tools: TOOL_DEFINITIONS,
      toolChoice:
        toolCalls.length >= MAX_TOOL_CALLS
          ? { type: 'tool', name: 'submit_answer' }
          : { type: 'any' },
      maxTokens: 16000,
    });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    usage.costUsd += res.usage.costUsd;

    const toolUses = res.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      submitError = 'composer produced no tool call';
      break;
    }
    messages.push({ role: 'assistant', content: res.content });
    const results: {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }[] = [];
    for (const use of toolUses) {
      if (use.type !== 'tool_use') continue;
      if (use.name === 'submit_answer') {
        const input = use.input as { answer?: unknown };
        const validated = validateAnswer(input.answer);
        if (validated.ok) {
          submitted = validated.answer;
          results.push({ type: 'tool_result', tool_use_id: use.id, content: 'accepted' });
        } else {
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: `Answer rejected by schema validation: ${validated.errors}. Fix and resubmit.`,
            is_error: true,
          });
        }
        continue;
      }
      toolCalls.push({ name: use.name, input: use.input });
      try {
        const result = await dispatchTool(ctx, use.name, use.input);
        let text = JSON.stringify(result);
        const budgetLeft = EVIDENCE_CONTEXT_CHAR_CAP - ctx.registry.totalTextLength();
        if (text.length > Math.max(4000, budgetLeft)) {
          text =
            text.slice(0, Math.max(4000, budgetLeft)) + '... [truncated: evidence context cap]';
        }
        results.push({ type: 'tool_result', tool_use_id: use.id, content: text });
      } catch (err) {
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: `tool error: ${(err as Error).message}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  const freshness = await freshnessBlock(pool, ctx, normalized);
  let answer: Answer;
  if (submitted) {
    answer = submitted;
    // The composer's freshness block is advisory; the computed one is authoritative.
    answer.freshness = freshness;
  } else {
    answer = abstention(
      {
        dos: normalized.dos,
        payer: normalized.payer,
        jurisdiction: normalized.jurisdiction,
        provider_type: normalized.providerType,
        setting: normalized.setting,
        client: normalized.client,
        defaults_applied: normalized.defaultsApplied,
      },
      submitError ??
        (llm.mode === 'stub'
          ? 'The model is running in stub mode without an ANTHROPIC_API_KEY; no real answer can be composed.'
          : 'The composer did not submit a valid answer.'),
      [],
      freshness,
    );
  }

  const verifier = submitted
    ? await verifyAnswer(llm, req.question, answer, ctx.registry, {
        dos: normalized.dos,
        userClientIds: req.userClientIds ?? [],
      })
    : null;
  const finalAnswer = verifier ? verifier.finalAnswer : answer;
  usage.latencyMs = Date.now() - started;

  const qaLogId = await writeQaLog(
    pool,
    req,
    normalized,
    ctx,
    finalAnswer,
    verifier,
    usage,
    false,
    models,
  );
  return {
    answer: finalAnswer,
    verifier,
    phiRefused: false,
    qaLogId,
    toolCalls,
    usage,
    stubMode: llm.mode === 'stub',
  };
}

async function writeQaLog(
  pool: Pool,
  req: AskRequest,
  normalized: Normalized,
  ctx: ToolContext | null,
  answer: Answer,
  verifier: VerifierOutput | null,
  usage: { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number },
  phiFlag: boolean,
  models: { composer: string; verifier: string; light: string },
): Promise<string | null> {
  const composerPrompt = promptText('composer.md');
  try {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO qa_log (user_id, question_text, question_meta, dos, payer, jurisdiction,
         provider_type, client_id, evidence, answer, verifier, models, prompt_versions,
         tokens_in, tokens_out, cost_usd, latency_ms, phi_flag, abstained)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING id`,
      [
        req.userId ?? null,
        phiFlag ? null : req.question, // PHI questions are never persisted
        JSON.stringify({
          codes_mentioned: normalized.codesMentioned,
          defaults: normalized.defaultsApplied,
        }),
        normalized.dos,
        normalized.payer,
        normalized.jurisdiction,
        normalized.providerType,
        req.clientId ?? null,
        JSON.stringify(ctx ? ctx.registry.all() : []),
        JSON.stringify(answer),
        verifier
          ? JSON.stringify({
              codeChecks: verifier.codeChecks,
              items: verifier.items,
              supportedRate: verifier.supportedRate,
              removed: verifier.removed,
              abstainedByVerifier: verifier.abstainedByVerifier,
              modelMode: verifier.modelMode,
            })
          : null,
        JSON.stringify(models),
        JSON.stringify({
          composer: promptVersion(composerPrompt),
          verifier: verifier?.promptVersion ?? null,
        }),
        usage.inputTokens,
        usage.outputTokens,
        usage.costUsd,
        usage.latencyMs,
        phiFlag,
        answer.abstained,
      ],
    );
    return res.rows[0]?.id ?? null;
  } catch (err) {
    console.error(`qa_log write failed: ${(err as Error).message}`);
    return null;
  }
}
