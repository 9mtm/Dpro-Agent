/**
 * Cron job store (B2.2c): `cron_jobs` and `job_executions` on the process
 * driver, as SQL steps (repositories/sql-steps.ts). Used by the cron engine,
 * the scheduler routes and the memory jobs.
 *
 * Column kinds: on SQLite last_run / next_run / created_at / updated_at /
 * executed_at are DATETIME columns that hold the ISO strings the engine
 * writes (Date.toISOString()); on PostgreSQL they are timestamptz. Writes
 * bind the same ISO string on both drivers. Comparisons bind an ISO string
 * too: compared as text on SQLite (both sides ISO), cast on PostgreSQL.
 *
 * Rows read on PostgreSQL carry the timestamptz text form
 * ('YYYY-MM-DD HH:MM:SS[.f]', UTC); rowToJob / historyEntry turn them into
 * the same values SQLite gives (Date objects, ISO strings). SQLite rows are
 * passed through exactly as before.
 *
 * Several processes on one PostgreSQL database each run a cron engine.
 * claimRun() lets exactly one of them run a scheduled tick: a conditional
 * UPDATE of last_run to the tick's slot (one statement, so two clients
 * cannot both win). SQLite has one process and does not claim (unchanged).
 */

import type { Dialect } from '../db/pg/dialect.js';
import { isoUtc } from '../api/timestamps.js';
import { all, dialect, lockName, one, run, sql, type Step } from '../repositories/sql-steps.js';
import type { CronActionType, CronJob } from './types.js';

export interface CronJobRow {
  id: string;
  name: string;
  description: string | null;
  cron_expression: string;
  action_type: string;
  action_data: string;
  enabled: number;
  last_run: string | null;
  next_run: string | null;
  created_at: string;
  updated_at: string;
}

/** A bound ISO time compared with a cron timestamp column. */
function tsArg(d: Dialect): string {
  return d === 'postgres' ? '(?)::timestamptz' : '?';
}

/** A stored timestamp as a Date (PostgreSQL text is UTC; SQLite values as before). */
function toDate(d: Dialect, v: string | null | undefined): Date | undefined {
  if (!v) return undefined;
  return new Date(d === 'postgres' ? (isoUtc(v) ?? v) : v);
}

export function rowToJob(d: Dialect, row: CronJobRow): CronJob {
  return {
    id: row.id,
    name: row.name,
    description: row.description as string | undefined,
    cronExpression: row.cron_expression,
    actionType: row.action_type as CronActionType,
    actionData: JSON.parse(row.action_data),
    enabled: Boolean(row.enabled),
    lastRun: toDate(d, row.last_run),
    nextRun: toDate(d, row.next_run),
    createdAt: toDate(d, row.created_at) ?? new Date(row.created_at),
    updatedAt: toDate(d, row.updated_at) ?? new Date(row.updated_at),
  };
}

function* listEnabledStep(): Step<CronJob[]> {
  const d = yield* dialect();
  const rows = yield* all<CronJobRow>(`SELECT * FROM cron_jobs WHERE enabled = 1`);
  return rows.map((r) => rowToJob(d, r));
}

/** Enabled jobs (the engine loads them at start). */
export function listEnabledJobs(): Promise<CronJob[]> {
  return sql().read(listEnabledStep());
}

const INSERT_JOB = `INSERT INTO cron_jobs (id, name, description, cron_expression, action_type, action_data, enabled, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Caller holds this job's lock and changes the definition in the same transaction. */
export function* advanceSecurityRevision(id:string):Step<void>{
 const result=yield* run('INSERT INTO scheduled_job_security_versions(job_id,revision) VALUES(?,1) ON CONFLICT(job_id) DO UPDATE SET revision=scheduled_job_security_versions.revision+1 WHERE scheduled_job_security_versions.revision<2147483647',id);
 if(result.changes!==1)throw Error('Scheduled job revision exhausted');
}
/** Store a new job (route POST /api/scheduler/jobs). */
export async function insertJob(job: CronJob): Promise<void> {
  await sql().tx(function*(){yield* lockName('scheduled-job:'+job.id);yield* run(INSERT_JOB,
    job.id, job.name, job.description || null, job.cronExpression, job.actionType,
    JSON.stringify(job.actionData), job.enabled ? 1 : 0, job.createdAt.toISOString(), job.updatedAt.toISOString());yield* advanceSecurityRevision(job.id);});
}

/** Replace a job's definition (route PUT /api/scheduler/jobs/:id). */
function* replaceJobDefinition(job:CronJob,legacy:boolean):Step<void>{yield* lockName('scheduled-job:'+job.id);
  if(legacy){const current=yield* one<{action_type:string}>('SELECT action_type FROM cron_jobs WHERE id=?',job.id);if(current?.action_type==='paper-runtime-cycle'||job.actionType==='paper-runtime-cycle')throw Error('Reviewed paper definition required');}
  const changed=yield* run(`
    UPDATE cron_jobs
    SET name = ?, description = ?, cron_expression = ?, action_type = ?, action_data = ?, enabled = ?, updated_at = ?
    WHERE id = ?`,
  job.name, job.description || null, job.cronExpression, job.actionType, JSON.stringify(job.actionData),
  job.enabled ? 1 : 0, job.updatedAt.toISOString(), job.id);if(changed.changes===1)yield* advanceSecurityRevision(job.id);
}

export async function updateJobDefinition(job:CronJob):Promise<void>{await sql().tx(()=>replaceJobDefinition(job,false));}
/** Legacy UI mutations cannot edit either side of a typed paper transition under the actual job lock. */
export async function updateLegacyJobDefinition(job:CronJob):Promise<void>{await sql().tx(()=>replaceJobDefinition(job,true));}
export async function setLegacyJobEnabled(id:string,enabled:boolean,updatedAt:Date):Promise<void>{
 await sql().tx(function*(){yield* lockName('scheduled-job:'+id);const current=yield* one<{action_type:string}>('SELECT action_type FROM cron_jobs WHERE id=?',id);if(enabled&&current?.action_type==='paper-runtime-cycle')throw Error('Paper schedule execution unavailable');yield* run('UPDATE cron_jobs SET enabled=?,updated_at=? WHERE id=?',enabled?1:0,updatedAt.toISOString(),id);});
}

export async function setJobEnabled(id: string, enabled: boolean, updatedAt: Date): Promise<void> {
  await sql().read(run('UPDATE cron_jobs SET enabled = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, updatedAt.toISOString(), id));
}

export async function deleteJob(id: string): Promise<void> {
  await sql().tx(function*(){yield* lockName('scheduled-job:'+id);const changed=yield* run('DELETE FROM cron_jobs WHERE id = ?', id);if(changed.changes===1)yield* advanceSecurityRevision(id);});
}

/** The engine's after-run update of last_run / next_run. */
export async function recordRunTimes(job: CronJob): Promise<void> {
  await sql().read(run(`
    UPDATE cron_jobs
    SET last_run = ?, next_run = ?, updated_at = ?
    WHERE id = ?`,
  job.lastRun?.toISOString() || null, job.nextRun?.toISOString() || null, new Date().toISOString(), job.id));
}

export interface ExecutionRecord {
  jobId: string;
  success: boolean;
  output?: string | null;
  error?: string | null;
  executedAt: Date;
  duration: number;
}

export async function saveExecution(h: ExecutionRecord): Promise<void> {
  await sql().read(run(`
    INSERT INTO job_executions (job_id, success, output, error, executed_at, duration)
    VALUES (?, ?, ?, ?, ?, ?)`,
  h.jobId, h.success ? 1 : 0, h.output || null, h.error || null, h.executedAt.toISOString(), h.duration));
}

export interface HistoryEntry {
  id: number;
  success: boolean;
  output: string | null;
  error: string | null;
  executedAt: string;
  duration: number | null;
}

function* historyStep(jobId: string, limit: number): Step<HistoryEntry[]> {
  const d = yield* dialect();
  const rows = yield* all<any>(`
    SELECT * FROM job_executions
    WHERE job_id = ?
    ORDER BY executed_at DESC, id DESC
    LIMIT ?`, jobId, limit);
  return rows.map((h) => ({
    id: h.id,
    success: Boolean(h.success),
    output: h.output,
    error: h.error,
    executedAt: d === 'postgres' ? (isoUtc(h.executed_at) ?? h.executed_at) : h.executed_at,
    duration: h.duration,
  }));
}

/** Newest executions of a job (route GET /api/scheduler/jobs/:id/history). */
export function jobHistory(jobId: string, limit = 100): Promise<HistoryEntry[]> {
  return sql().read(historyStep(jobId, limit));
}

/**
 * The slot of a scheduled tick: the tick time cut to the minute (5-field
 * cron), or to the second (6-field cron with seconds). Every process that
 * fires the same tick computes the same slot.
 */
export function tickSlot(cronExpression: string, at: number = Date.now()): Date {
  const fields = cronExpression.trim().split(/\s+/).length;
  const unit = fields >= 6 ? 1000 : 60_000;
  return new Date(Math.floor(at / unit) * unit);
}

function* claimStep(jobId: string, slotIso: string): Step<boolean> {
  const d = yield* dialect();
  const t = tsArg(d);
  // One statement: of several clients claiming the same slot, exactly one
  // sees last_run < slot and moves it to the slot; the others change nothing.
  const res = yield* run(
    `UPDATE cron_jobs SET last_run = ${t} WHERE id = ? AND enabled = 1 AND (last_run IS NULL OR last_run < ${t})`,
    slotIso, jobId, slotIso,
  );
  return res.changes === 1;
}

/**
 * Claim one scheduled tick of a job (PostgreSQL, several processes): true for
 * exactly one caller per slot; false when another process already ran it, the
 * job was disabled or deleted. SQLite (one process): always true, no write.
 */
export async function claimRun(jobId: string, slot: Date): Promise<boolean> {
  const runner = sql();
  if (runner.dialect !== 'postgres') return true;
  return runner.read(claimStep(jobId, slot.toISOString()));
}

export interface JobDefinition {
  name: string;
  description: string | null;
  cronExpression: string;
  actionType: CronActionType;
  actionData: Record<string, unknown>;
}

function* ensureJobStep(id: string, def: JobDefinition, nowIso: string): Step<boolean> {
  // cron_jobs.name has no unique index: a per-name lock keeps two processes
  // from both inserting the same named job (PostgreSQL; SQLite needs none).
  yield* lockName(`cron_jobs:name:${def.name}`);
  if (yield* one('SELECT 1 AS ok FROM cron_jobs WHERE name = ?', def.name)) return false;
  yield* run(INSERT_JOB, id, def.name, def.description, def.cronExpression, def.actionType,
    JSON.stringify(def.actionData), 1, nowIso, nowIso);
  return true;
}

/**
 * Insert an enabled job unless one with this name exists (one transaction).
 * True when it was inserted.
 */
export function ensureNamedJob(id: string, def: JobDefinition): Promise<boolean> {
  return sql().tx(() => ensureJobStep(id, def, new Date().toISOString()));
}

/** The job with this name (the first one when several share it), or undefined. */
export async function getJobByName(name: string): Promise<CronJob | undefined> {
  return sql().read((function* (): Step<CronJob | undefined> {
    const d = yield* dialect();
    const row = yield* one<CronJobRow>('SELECT * FROM cron_jobs WHERE name = ?', name);
    return row ? rowToJob(d, row) : undefined;
  })());
}

function* upsertNamedStep(newId: string, def: JobDefinition, nowIso: string): Step<{ job: CronJob; created: boolean }> {
  const d = yield* dialect();
  // Same per-name lock as ensureNamedJob: two processes never both insert.
  yield* lockName(`cron_jobs:name:${def.name}`);
  const existing = yield* one<{ id: string }>('SELECT id FROM cron_jobs WHERE name = ?', def.name);
  let created = false;
  if (existing) {
    yield* run(`
      UPDATE cron_jobs
      SET cron_expression = ?, action_type = ?, action_data = ?, updated_at = ?
      WHERE name = ?`,
    def.cronExpression, def.actionType, JSON.stringify(def.actionData), nowIso, def.name);
  } else {
    yield* run(INSERT_JOB, newId, def.name, def.description, def.cronExpression, def.actionType,
      JSON.stringify(def.actionData), 1, nowIso, nowIso);
    created = true;
  }
  const row = yield* one<CronJobRow>('SELECT * FROM cron_jobs WHERE name = ?', def.name);
  return { job: rowToJob(d, row!), created };
}

/**
 * Insert an enabled named job, or (when one with this name exists) update its
 * schedule and action; the description and enabled flag of an existing job
 * are kept. One transaction under the name lock. Returns the stored job.
 */
export function upsertNamedJob(newId: string, def: JobDefinition): Promise<{ job: CronJob; created: boolean }> {
  return sql().tx(() => upsertNamedStep(newId, def, new Date().toISOString()));
}

/** Delete the job with this name; its id when one was deleted. */
export async function deleteJobByName(name: string): Promise<string | undefined> {
  return sql().tx(function* (): Step<string | undefined> {
    yield* lockName(`cron_jobs:name:${name}`);
    const row = yield* one<{ id: string }>('SELECT id FROM cron_jobs WHERE name = ?', name);
    if (!row) return undefined;
    yield* run('DELETE FROM cron_jobs WHERE id = ?', row.id);
    return row.id;
  });
}
