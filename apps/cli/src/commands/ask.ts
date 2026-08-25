import { closePool, getPool } from '@advisor/db';
import { ask, createLlmClient, renderAnswer } from '@advisor/core';

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runAskCommand(args: string[]): Promise<void> {
  const question = args.find((a) => !a.startsWith('--'));
  if (!question) {
    console.error(
      'Usage: pnpm ask "question" [--dos YYYY-MM-DD] [--payer P] [--jurisdiction J] [--provider T] [--client C]',
    );
    process.exitCode = 1;
    return;
  }
  const pool = getPool();
  const llm = createLlmClient();
  try {
    if (llm.mode === 'stub') {
      console.error(
        'NOTE: no ANTHROPIC_API_KEY is configured; running in stub mode. The engine runs end to end but no real answer is composed (docs/DECISIONS.md D1).',
      );
    }
    const result = await ask(pool, llm, {
      question,
      dos: flagValue(args, '--dos'),
      payer: flagValue(args, '--payer'),
      jurisdiction: flagValue(args, '--jurisdiction'),
      providerType: flagValue(args, '--provider'),
      clientId: flagValue(args, '--client'),
    });
    console.log(renderAnswer(result.answer));
    console.log(
      `\n(${result.toolCalls.length} tool calls, ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens, ` +
        `$${result.usage.costUsd.toFixed(4)}, ${result.usage.latencyMs} ms` +
        `${result.qaLogId ? `, qa_log ${result.qaLogId}` : ''})`,
    );
  } finally {
    await closePool();
  }
}
