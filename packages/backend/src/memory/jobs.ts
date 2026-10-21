/**
 * Scheduled memory jobs (CORE-05/07), run in-process by the cron engine
 * ('memory-job' action; never an HTTP call). Each job is for ONE owner
 * account (owner-scoped) and local only.
 *
 *   weekly-summary  "what I learned this week" (memory/weekly-summary.ts)
 *   retention       task TTL + experience consolidation (memory/retention.ts);
 *                   does nothing until the owner turns retention on
 *   trash           forgets what stayed in the Trash longer than the
 *                   company's trashDays (MEM-TRASH-01; 0 = never)
 */

import { v4 as uuidv4 } from 'uuid';
import { all, one, sql } from '../repositories/sql-steps.js';
import { ensureNamedJob } from '../scheduler/store.js';
import { runWeeklySummary } from './weekly-summary.js';
import { runRetention } from './retention.js';
import { expireTrash } from './trash.js';
import { logAudit } from '../services/audit-logger.js';

export const MEMORY_JOB_ACTION = 'memory-job';
export const WEEKLY_SUMMARY_CRON = '0 8 * * 1'; // Mondays 08:00
export const RETENTION_CRON = '0 4 * * *'; // daily 04:00 (no-op while retention is off)
export const TRASH_CRON = '30 3 * * *'; // daily 03:30 (no-op while trashDays is 0)
export type MemoryJobName = 'weekly-summary' | 'retention' | 'trash';
const JOBS: ReadonlySet<string> = new Set(['weekly-summary', 'retention', 'trash']);
const SCHEDULE: ReadonlyArray<[MemoryJobName, string, string]> = [
  ['weekly-summary', WEEKLY_SUMMARY_CRON, 'Weekly memory summary (what I learned this week)'],
  ['retention', RETENTION_CRON, 'Memory retention rules (task TTL, experience consolidation); only when turned on'],
  ['trash', TRASH_CRON, 'Memory Trash: forget what stayed longer than the keep-days'],
];

async function isOwner(userId: unknown): Promise<boolean> {
  if (typeof userId !== 'string' || !userId) return false;
  const row = await sql().read(one<{ role: string; status: string }>(`SELECT role, status FROM users WHERE id = ?`, userId));
  return !!row && row.role === 'owner' && (row.status ?? 'active') === 'active';
}

/** Run one memory job (called by the cron engine). */
export async function runMemoryJob(action: { job?: unknown; userId?: unknown }): Promise<unknown> {
  const job = action?.job;
  if (typeof job !== 'string' || !JOBS.has(job)) throw new Error('Unknown memory job');
  if (!(await isOwner(action.userId))) throw new Error('Memory jobs run only for an active owner account');
  const userId = action.userId as string;
  if (job === 'weekly-summary') {
    const rec = await runWeeklySummary(userId, { actor: 'scheduler' });
    return { summaryId: rec.id, totals: rec.digest.totals };
  }
  if (job === 'retention') {
    const res = await runRetention(userId, { requireEnabled: true, actor: 'retention' });
    if (!res.skipped) {
      logAudit({
        event_type: 'data.delete', event_category: 'data_modification', severity: 'info', user_id: userId,
        resource_type: 'memory_retention', resource_id: res.id, action: 'memory_retention.run', success: true,
        metadata: { scheduled: true, forgotten: res.forgotten, actions: res.actions.length },
      });
    }
    return { runId: res.id, skipped: res.skipped ?? null, forgotten: res.forgotten, actions: res.actions.length };
  }
  if (job === 'trash') {
    const res = await expireTrash(userId);
    if (res.forgotten || res.projects) {
      logAudit({
        event_type: 'data.delete', event_category: 'data_modification', severity: 'info', user_id: userId,
        resource_type: 'memory_trash', resource_id: userId, action: 'memory.trash_expire', success: true,
        metadata: { scheduled: true, ...res },
      });
    }
    return res;
  }
  throw new Error('Unknown memory job');
}

export function memoryJobName(job: MemoryJobName, userId: string): string {
  return `memory-${job}-${userId}`;
}

/**
 * Make sure every active owner account has its weekly summary job (idempotent).
 * Returns the jobs created. The cron engine loads them from cron_jobs.
 *
 * B2.2c: owners and cron_jobs are both on the process driver; each job is
 * checked and inserted in one transaction under a per-name lock
 * (scheduler/store.ts ensureNamedJob), so two processes never create the
 * same job twice.
 */
export async function ensureMemoryJobs(): Promise<Array<{ id: string; name: string; cronExpression: string; actionData: Record<string, unknown> }>> {
  const owners = await sql().read(all<{ id: string }>(`SELECT id FROM users WHERE role = 'owner' AND COALESCE(status, 'active') = 'active' ORDER BY id`));
  const created: Array<{ id: string; name: string; cronExpression: string; actionData: Record<string, unknown> }> = [];
  for (const { id: userId } of owners) {
    for (const [job, cronExpression, description] of SCHEDULE) {
      const name = memoryJobName(job, userId);
      const id = uuidv4();
      const actionData = { job, userId };
      const inserted = await ensureNamedJob(id, { name, description, cronExpression, actionType: MEMORY_JOB_ACTION, actionData });
      if (!inserted) continue;
      created.push({ id, name, cronExpression, actionData });
    }
  }
  return created;
}
