// Database job locks with heartbeats (brief section 8.8): one worker instance, but a
// restart must never duplicate a run. A lock without a heartbeat for 30 minutes is
// dead and may be taken over.
import { randomUUID } from 'node:crypto';
import type { Pool } from '@advisor/db';

export const DEAD_LOCK_MINUTES = 30;

export interface JobLock {
  jobName: string;
  holder: string;
  release: () => Promise<void>;
  heartbeat: () => Promise<void>;
}

/** Returns the lock, or null when another live holder has it. */
export async function acquireJobLock(pool: Pool, jobName: string): Promise<JobLock | null> {
  const holder = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const res = await pool.query(
    `INSERT INTO job_locks (job_name, locked_by, locked_at, heartbeat_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (job_name) DO UPDATE
       SET locked_by = EXCLUDED.locked_by, locked_at = now(), heartbeat_at = now()
       WHERE job_locks.heartbeat_at < now() - interval '${DEAD_LOCK_MINUTES} minutes'
     RETURNING locked_by`,
    [jobName, holder],
  );
  if (res.rowCount === 0 || res.rows[0]?.locked_by !== holder) return null;
  return {
    jobName,
    holder,
    release: async () => {
      await pool.query(`DELETE FROM job_locks WHERE job_name = $1 AND locked_by = $2`, [
        jobName,
        holder,
      ]);
    },
    heartbeat: async () => {
      await pool.query(
        `UPDATE job_locks SET heartbeat_at = now() WHERE job_name = $1 AND locked_by = $2`,
        [jobName, holder],
      );
    },
  };
}

/** Runs fn under the lock with a heartbeat every intervalMs; skips when locked elsewhere. */
export async function withJobLock<T>(
  pool: Pool,
  jobName: string,
  fn: () => Promise<T>,
  intervalMs = 60_000,
): Promise<{ ran: boolean; result?: T }> {
  const lock = await acquireJobLock(pool, jobName);
  if (!lock) return { ran: false };
  const timer = setInterval(() => {
    void lock.heartbeat().catch(() => {});
  }, intervalMs);
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    clearInterval(timer);
    await lock.release().catch(() => {});
  }
}
