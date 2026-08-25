// Pending question registry. A POST to /ask starts the agent loop in the
// background and redirects to /q/<id>; the page meta-refreshes until the loop
// finishes, then renders from qa_log so history and live views share one path.
import { randomUUID } from 'node:crypto';
import type { Pool } from '@advisor/db';
import { ask, createLlmClient, type AskRequest, type AskResult } from '@advisor/core';

export interface PendingAsk {
  id: string;
  userId: string;
  question: string;
  startedAt: number;
  status: 'running' | 'done' | 'error';
  qaLogId: string | null;
  error: string | null;
  result: AskResult | null;
}

const pending = new Map<string, PendingAsk>();
const KEEP_DONE_MS = 60 * 60 * 1000;

function prune(): void {
  const cutoff = Date.now() - KEEP_DONE_MS;
  for (const [id, entry] of pending)
    if (entry.status !== 'running' && entry.startedAt < cutoff) pending.delete(id);
}

export function startAsk(pool: Pool, userId: string, req: AskRequest): string {
  prune();
  const id = randomUUID();
  const entry: PendingAsk = {
    id,
    userId,
    question: req.question,
    startedAt: Date.now(),
    status: 'running',
    qaLogId: null,
    error: null,
    result: null,
  };
  pending.set(id, entry);
  const llm = createLlmClient();
  void ask(pool, llm, req)
    .then((result) => {
      entry.status = 'done';
      entry.result = result;
      entry.qaLogId = result.qaLogId;
    })
    .catch((err: unknown) => {
      entry.status = 'error';
      entry.error = err instanceof Error ? err.message : String(err);
    });
  return id;
}

export function getPending(id: string): PendingAsk | undefined {
  return pending.get(id);
}
