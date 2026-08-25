// Eval harness (brief section 16), invoked by pnpm eval. Runs the golden set and
// grades the gates. With no ANTHROPIC_API_KEY the loop runs in stub mode to prove
// plumbing, and every gate that needs live model output reports BLOCKED, never
// passed (docs/DECISIONS.md D1). Results are printed and written to
// evals/results-<timestamp>.json (not committed).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, getPool, optionalEnv } from '@advisor/db';
import type { Pool } from '@advisor/db';
import { ask, createLlmClient, allCitations } from '@advisor/core';
import type { Answer, AskResult, Citation } from '@advisor/core';

const HERE = dirname(fileURLToPath(import.meta.url));

interface GoldenItem {
  id: string;
  specialty: string;
  question: string;
  dos: string;
  payer: string;
  jurisdiction: string;
  provider_type: string;
  client: string | null;
  expected_evidence_types: string[];
  expected_behavior: string;
  must_not_contain: string[];
  reviewer: string;
  reviewed_on: string;
  ablation_target?: boolean;
  stale_setup?: string;
}

interface ItemResult {
  id: string;
  behavior: string;
  abstained: boolean;
  phiRefused: boolean;
  citationsValid: boolean;
  supportedRate: number | null;
  expectedEvidenceCited: boolean | null;
  staleWarning: boolean;
  costUsd: number;
  latencyMs: number;
  note?: string;
}

function loadGolden(): GoldenItem[] {
  return readFileSync(join(HERE, 'golden.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as GoldenItem);
}

const EVIDENCE_MATCHERS: Record<string, (c: Citation, a: Answer) => boolean> = {
  ncci_ptp: (c) => c.external_id.startsWith('ncci-ptp'),
  ncci_manual: (c) => c.external_id === 'ncci-manual',
  mue: (c) => c.external_id === 'mue-practitioner',
  mpfs: (c) => c.external_id.startsWith('mpfs-'),
  telehealth_list: (c) => c.external_id.startsWith('telehealth-cy'),
  cms_therapy: (c) => c.external_id.startsWith('therapy-services'),
  fedreg: (c) => /^\d{4}-\d+$/.test(c.external_id),
  mln: (c) => c.external_id.startsWith('transmittal-'),
  mcd: (c) => /^(L|A|NCD-)\d/.test(c.external_id),
  'iom-100-02-ch15': (c) => c.external_id === 'iom-100-02-ch15',
  'iom-100-04-ch1': (c) => c.external_id === 'iom-100-04-ch1',
  'iom-100-04-ch5': (c) => c.external_id === 'iom-100-04-ch5',
  'iom-100-04-ch30': (c) => c.external_id === 'iom-100-04-ch30',
  payer_policies: (c) => c.tier === 4,
  payer_call_notes: (c) => c.tier === 6,
  remit_behavior: (c) => c.tier === 7,
  client_contracts: (c) => c.tier === 5,
};

function citesExpected(item: GoldenItem, answer: Answer): boolean | null {
  if (item.expected_evidence_types.length === 0) return null;
  const cites = allCitations(answer);
  return item.expected_evidence_types.some((t) => {
    const matcher = EVIDENCE_MATCHERS[t];
    return matcher ? cites.some((c) => matcher(c, answer)) : false;
  });
}

function dollarAmounts(answer: Answer): string[] {
  const text = answer.bottom_line + ' ' + answer.published_rules.map((s) => s.statement).join(' ');
  return [...text.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)].map((m) => m[1]!.replaceAll(',', ''));
}

async function runItem(
  pool: Pool,
  item: GoldenItem,
  dosOverride?: string,
): Promise<{ result: AskResult; summary: ItemResult }> {
  const dos = dosOverride ?? (item.dos === 'today' ? undefined : item.dos);
  const llm = createLlmClient();
  const result = await ask(pool, llm, {
    question: item.question,
    dos,
    payer: item.payer === 'any' ? undefined : item.payer,
    jurisdiction:
      item.jurisdiction === 'national' || item.jurisdiction === 'any'
        ? undefined
        : item.jurisdiction,
    providerType: item.provider_type === 'any' ? undefined : item.provider_type,
    clientId: undefined, // client isolation cases are Phase 4
  });
  const summary: ItemResult = {
    id: item.id,
    behavior: item.expected_behavior,
    abstained: result.answer.abstained,
    phiRefused: result.phiRefused,
    citationsValid: result.verifier ? result.verifier.codeChecks.citationsValid : true,
    supportedRate: result.verifier?.supportedRate ?? null,
    expectedEvidenceCited: citesExpected(item, result.answer),
    staleWarning: result.answer.freshness.stale_sources.length > 0,
    costUsd: result.usage.costUsd,
    latencyMs: result.usage.latencyMs,
  };
  return { result, summary };
}

interface AblationBackup {
  conversionFactors: {
    year: number;
    quarter: number;
    value: string;
    source_document_id: string | null;
  }[];
  thresholds: {
    year: number;
    kx_pt_slp: string | null;
    kx_ot: string | null;
    mr_pt_slp: string | null;
    mr_ot: string | null;
    source_document_id: string | null;
  }[];
}

async function ablationRemove(pool: Pool): Promise<AblationBackup> {
  const cf = await pool.query<AblationBackup['conversionFactors'][number]>(
    `SELECT year, quarter, value, source_document_id FROM conversion_factor`,
  );
  const th = await pool.query<AblationBackup['thresholds'][number]>(
    `SELECT year, kx_pt_slp, kx_ot, mr_pt_slp, mr_ot, source_document_id FROM therapy_thresholds`,
  );
  await pool.query(`DELETE FROM conversion_factor`);
  await pool.query(`DELETE FROM therapy_thresholds`);
  await pool.query(
    `UPDATE chunks SET retired_date = '1900-01-02'
     FROM documents d WHERE chunks.document_id = d.id AND d.source_id = 'cms_therapy'`,
  );
  await pool.query(
    `UPDATE documents SET retired_date = '1900-01-02' WHERE source_id = 'cms_therapy'`,
  );
  return { conversionFactors: cf.rows, thresholds: th.rows };
}

async function ablationRestore(pool: Pool, backup: AblationBackup): Promise<void> {
  for (const r of backup.conversionFactors) {
    await pool.query(
      `INSERT INTO conversion_factor (year, quarter, value, source_document_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT (year, quarter) DO UPDATE SET value = EXCLUDED.value`,
      [r.year, r.quarter, r.value, r.source_document_id],
    );
  }
  for (const r of backup.thresholds) {
    await pool.query(
      `INSERT INTO therapy_thresholds (year, kx_pt_slp, kx_ot, mr_pt_slp, mr_ot, source_document_id)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (year) DO NOTHING`,
      [r.year, r.kx_pt_slp, r.kx_ot, r.mr_pt_slp, r.mr_ot, r.source_document_id],
    );
  }
  await pool.query(
    `UPDATE documents SET retired_date = NULL WHERE source_id = 'cms_therapy' AND retired_date = '1900-01-02'`,
  );
  await pool.query(
    `UPDATE chunks SET retired_date = NULL
     FROM documents d WHERE chunks.document_id = d.id AND d.source_id = 'cms_therapy'
       AND chunks.retired_date = '1900-01-02'`,
  );
}

type GateStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'PHASE4';

function fmtGate(n: number, name: string, status: GateStatus, detail: string): string {
  return `Gate ${n} ${name}: ${status}${detail ? ` (${detail})` : ''}`;
}

async function main(): Promise<void> {
  const pool = getPool();
  const stub = !process.env.ANTHROPIC_API_KEY && optionalEnv('LLM_MODE', '') !== 'live';
  if (stub) {
    console.log(
      'NOTE: running in stub mode without ANTHROPIC_API_KEY. The harness exercises the full loop; ' +
        'gates that need live composer or verifier output are reported as BLOCKED, not passed (D1).\n',
    );
  }
  const golden = loadGolden();
  let phase2Items = golden.filter((g) => !g.expected_behavior.startsWith('phase4'));

  // pnpm eval --items A1,A13 reruns specific items for cheap iteration: per-item
  // lines only, no scenario passes, no gate table (a partial run cannot grade gates).
  const itemsArg = process.argv.find((a) => a.startsWith('--items'));
  const itemsFilter =
    itemsArg?.split('=')[1] ?? (itemsArg ? process.argv[process.argv.indexOf(itemsArg) + 1] : null);
  if (itemsFilter) {
    const wanted = new Set(itemsFilter.split(',').map((s) => s.trim()));
    phase2Items = phase2Items.filter((g) => wanted.has(g.id) && g.id !== 'A22');
    console.log(`Filtered run: ${phase2Items.map((g) => g.id).join(', ')}; gates not computed.\n`);
  }
  const results: ItemResult[] = [];
  const answers = new Map<string, Answer>();

  for (const item of phase2Items) {
    if (item.id === 'A22') {
      // Stale setup: age the source, run, restore.
      const saved = await pool.query<{ last_success_at: Date | null }>(
        `SELECT last_success_at FROM sources WHERE id = $1`,
        [item.stale_setup],
      );
      await pool.query(
        `UPDATE sources SET last_success_at = now() - interval '400 days' WHERE id = $1`,
        [item.stale_setup],
      );
      try {
        const { result, summary } = await runItem(pool, item);
        results.push(summary);
        answers.set(item.id, result.answer);
      } finally {
        await pool.query(`UPDATE sources SET last_success_at = $2 WHERE id = $1`, [
          item.stale_setup,
          saved.rows[0]?.last_success_at ?? null,
        ]);
      }
      continue;
    }
    if (item.id === 'A23') {
      const [dosA, dosB] = item.dos.split('|') as [string, string];
      const runA = await runItem(pool, item, dosA);
      const runB = await runItem(pool, item, dosB);
      results.push({ ...runA.summary, id: 'A23a' }, { ...runB.summary, id: 'A23b' });
      answers.set('A23a', runA.result.answer);
      answers.set('A23b', runB.result.answer);
      continue;
    }
    const { result, summary } = await runItem(pool, item);
    results.push(summary);
    answers.set(item.id, result.answer);
    console.log(
      `${item.id}: ${result.phiRefused ? 'PHI refused' : result.answer.abstained ? 'abstained' : 'answered'} ` +
        `($${result.usage.costUsd.toFixed(3)}, ${result.usage.latencyMs} ms, ${result.toolCalls.length} tool calls)`,
    );
  }

  if (itemsFilter) {
    await closePool();
    return;
  }

  // Gate 5: ablation. Remove therapy documents and conversion_factor, re-run A14 and A17.
  let ablationStatus: GateStatus = stub ? 'BLOCKED' : 'FAIL';
  let ablationDetail: string;
  const backup = await ablationRemove(pool);
  try {
    const a14 = await runItem(
      pool,
      golden.find((g) => g.id === 'A14')!,
    );
    const a17 = await runItem(
      pool,
      golden.find((g) => g.id === 'A17')!,
    );
    if (!stub) {
      // With the source removed, the system must abstain OR re-ground on other
      // retrieved evidence (the corpus holds the KX amounts in the PFS final rules
      // too). Failure means citing the removed source or answering uncited.
      const verdictOf = (r: (typeof a14)['result']): { ok: boolean; label: string } => {
        if (r.answer.abstained) return { ok: true, label: 'abstained' };
        const cites = allCitations(r.answer);
        if (cites.some((c) => c.external_id.startsWith('therapy-services')))
          return { ok: false, label: 'CITED THE REMOVED SOURCE' };
        if (cites.length === 0) return { ok: false, label: 'ANSWERED WITHOUT CITATIONS' };
        return { ok: true, label: 'answered from other retrieved evidence' };
      };
      const v14 = verdictOf(a14.result);
      const v17 = verdictOf(a17.result);
      ablationStatus = v14.ok && v17.ok ? 'PASS' : 'FAIL';
      ablationDetail = `A14 ${v14.label}, A17 ${v17.label}`;
    } else {
      ablationDetail = `plumbing ran; A14/A17 abstained in stub mode (vacuous)`;
    }
  } finally {
    await ablationRestore(pool, backup);
  }

  // Gates.
  const nonAbstained = results.filter((r) => !r.abstained && !r.phiRefused);
  const gateLines: string[] = [];

  // 1. Citation validity: 100 percent of citations resolve. Hard gate.
  const g1Fail = results.filter((r) => !r.citationsValid);
  gateLines.push(
    fmtGate(
      1,
      'citation validity',
      stub ? 'BLOCKED' : g1Fail.length === 0 ? 'PASS' : 'FAIL',
      stub ? 'needs live answers to grade' : `${g1Fail.length} runs with invalid citations`,
    ),
  );

  // 2. Groundedness: verifier supported rate at least 95 percent on non-abstained.
  const rates = nonAbstained.map((r) => r.supportedRate).filter((r): r is number => r !== null);
  const avgRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
  gateLines.push(
    fmtGate(
      2,
      'groundedness >= 95 percent',
      stub || avgRate === null ? 'BLOCKED' : avgRate >= 0.95 ? 'PASS' : 'FAIL',
      avgRate === null
        ? 'needs live verifier output'
        : `supported rate ${(avgRate * 100).toFixed(1)} percent`,
    ),
  );

  // 3. Expected evidence: at least 90 percent cite an expected type.
  const withExpectation = results.filter((r) => r.expectedEvidenceCited !== null && !r.phiRefused);
  const hit = withExpectation.filter((r) => r.expectedEvidenceCited === true).length;
  const rate3 = withExpectation.length ? hit / withExpectation.length : 0;
  gateLines.push(
    fmtGate(
      3,
      'expected evidence >= 90 percent',
      stub ? 'BLOCKED' : rate3 >= 0.9 ? 'PASS' : 'FAIL',
      stub
        ? 'needs live answers'
        : `${hit} of ${withExpectation.length} (${(rate3 * 100).toFixed(0)} percent)`,
    ),
  );

  // 4. Abstention behavior.
  const mustAbstain = results.filter((r) =>
    ['abstain', 'abstain_before_phase4'].includes(r.behavior),
  );
  const mustAnswer = results.filter(
    (r) => r.behavior === 'answer' || r.behavior === 'answer_with_stale_warning',
  );
  const g4aOk = mustAbstain.every((r) => r.abstained);
  const g4bOk = mustAnswer.every((r) => !r.abstained);
  gateLines.push(
    fmtGate(
      4,
      'abstention',
      stub ? 'BLOCKED' : g4aOk && g4bOk ? 'PASS' : 'FAIL',
      stub
        ? `abstain cases abstain (${g4aOk}); non-abstain cases need live answers`
        : `abstain cases ok: ${g4aOk}; answer cases ok: ${g4bOk}`,
    ),
  );

  // 5. Ablation.
  gateLines.push(fmtGate(5, 'ablation (A14, A17)', ablationStatus, ablationDetail));

  // 6. DOS: A23 two different sourced amounts.
  const a23a = answers.get('A23a');
  const a23b = answers.get('A23b');
  let g6: GateStatus = 'BLOCKED';
  let g6Detail = 'needs live answers';
  if (!stub && a23a && a23b) {
    const amountsA = new Set(dollarAmounts(a23a));
    const amountsB = new Set(dollarAmounts(a23b));
    const differ =
      amountsA.size > 0 &&
      amountsB.size > 0 &&
      JSON.stringify([...amountsA]) !== JSON.stringify([...amountsB]);
    g6 = differ ? 'PASS' : 'FAIL';
    g6Detail = `2025 amounts [${[...amountsA]}] vs 2026 amounts [${[...amountsB]}]`;
  }
  gateLines.push(fmtGate(6, 'DOS awareness (A23)', g6, g6Detail));

  // 7. PHI: A24 refuses under PHI_MODE=deny. The regex path works in stub mode too.
  const a24 = results.find((r) => r.id === 'A24');
  gateLines.push(
    fmtGate(
      7,
      'PHI refusal (A24)',
      a24?.phiRefused ? 'PASS' : 'FAIL',
      a24?.phiRefused ? 'refused; question text not persisted' : 'was not refused',
    ),
  );

  // 8 and 9 are Phase 4 acceptance gates.
  gateLines.push(
    fmtGate(8, 'tier integrity (A25 to A27)', 'PHASE4', 'needs Phase 4 payer intelligence data'),
  );
  gateLines.push(fmtGate(9, 'client isolation (A28)', 'PHASE4', 'needs Phase 4 contract uploads'));

  // 10. Cost under $0.25 and p50 latency under 30 seconds.
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length / 2)] ?? 0;
  const maxCost = Math.max(...results.map((r) => r.costUsd), 0);
  gateLines.push(
    fmtGate(
      10,
      'cost and latency',
      stub ? 'BLOCKED' : maxCost < 0.25 && p50 < 30_000 ? 'PASS' : 'FAIL',
      `max cost $${maxCost.toFixed(3)}, p50 latency ${p50} ms${stub ? ' (stub, not meaningful)' : ''}`,
    ),
  );

  console.log('\n' + gateLines.join('\n'));
  const outPath = join(HERE, `results-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify({ stub, results, gates: gateLines }, null, 1));
  console.log(`\nResults written to ${outPath}`);
  await closePool();
}

await main();
