import { closePool, getPool } from '@advisor/db';

export async function runReportCommand(): Promise<void> {
  const pool = getPool();
  try {
    const res = await pool.query<{
      day: string;
      answers_n: string;
      abstain_n: string;
      phi_n: string;
      cost_usd: string;
      p50_ms: number | null;
      p95_ms: number | null;
      correct_n: string;
      incorrect_n: string;
      partial_n: string;
    }>(
      `SELECT to_char(q.ts::date, 'YYYY-MM-DD') AS day,
              count(*) AS answers_n,
              count(*) FILTER (WHERE q.abstained) AS abstain_n,
              count(*) FILTER (WHERE q.phi_flag) AS phi_n,
              coalesce(sum(q.cost_usd), 0)::numeric(10,2) AS cost_usd,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY q.latency_ms)::int AS p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY q.latency_ms)::int AS p95_ms,
              count(f.*) FILTER (WHERE f.verdict = 'correct') AS correct_n,
              count(f.*) FILTER (WHERE f.verdict = 'incorrect') AS incorrect_n,
              count(f.*) FILTER (WHERE f.verdict = 'partial') AS partial_n
       FROM qa_log q LEFT JOIN qa_feedback f ON f.qa_id = q.id
       GROUP BY q.ts::date ORDER BY q.ts::date DESC LIMIT 30`,
    );
    if (res.rowCount === 0) {
      console.log('No questions logged yet.');
      return;
    }
    console.log(
      'day         answers abstain phi  cost     p50ms  p95ms  correct incorrect partial',
    );
    for (const r of res.rows) {
      console.log(
        `${r.day}  ${r.answers_n.padStart(7)} ${r.abstain_n.padStart(7)} ${r.phi_n.padStart(3)}  $${r.cost_usd.padStart(6)} ${String(r.p50_ms ?? 0).padStart(6)} ${String(r.p95_ms ?? 0).padStart(6)}  ${r.correct_n.padStart(7)} ${r.incorrect_n.padStart(9)} ${r.partial_n.padStart(7)}`,
      );
    }
  } finally {
    await closePool();
  }
}
