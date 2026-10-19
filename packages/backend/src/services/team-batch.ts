/**
 * Batch hire for company setup (ONBOARD-TEAM-02, decision D-ONBOARD-TEAM).
 *
 * The owner reviews a distribution (company-plan.ts planDistribution: a count
 * and a persona per role for each department) and hires it as one batch:
 *
 *   createBatch  stores the plan as one pending item per agent. The id comes
 *                from the client, so sending the same batch again is a no-op;
 *                the same id with a different plan is refused.
 *   runBatch     creates up to `max` pending items, in order. Each item's
 *                agent (name reserved, row inserted, personality v1 seeded)
 *                and its 'created' mark are one transaction, and the mark is
 *                only set from 'pending'; a second run, a reload or a run in
 *                another tab never creates the same agent twice.
 *   batchStatus  progress, for the review screen and for resuming after a
 *                reload.
 *
 * Names are not part of the plan: each agent gets a fresh unused name in the
 * batch language when it is created, and the name is reserved for good then.
 * Tool grants per department wait for CORE-PERMS-01; agents start without
 * grants, like a single hire before its permissions are saved.
 */

import { createHash } from 'node:crypto';
import { all, dialect, one, run, sql, type Step } from '../repositories/sql-steps.js';
import { nowText } from '../db/pg/dialect.js';
import { insertAgentConfigStep, newAgentId } from '../repositories/agents-config.js';
import { AgentNameTakenError, isNameLanguage, resolveNamingLanguage, suggestAgentNames, type NameLanguage } from './agent-names.js';
import { isPresetId, type AgentRole } from './personality.js';
import {
  CompanyPlanInputError, MAX_TOTAL_HEADCOUNT, TEAM_ROLES, departmentShare, parseDepartments, type TeamRole,
} from './company-plan.js';

export const MAX_RUN_ITEMS = 50;
const BATCH_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class TeamBatchError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface BatchDepartmentInput {
  department: string;
  count: number;
  /** Optional persona per role; the department default otherwise. */
  presets?: Partial<Record<TeamRole, string>>;
  specialties?: { name: string; count: number; description: string }[];
}

export interface BatchProgress {
  id: string;
  total: number;
  created: number;
  failed: number;
  pending: number;
  done: boolean;
  createdAt: string;
  departments: Array<{ department: string; total: number; created: number; failed: number }>;
}

export interface RunResultItem {
  seq: number;
  status: 'created' | 'failed';
  agentId?: string;
  name?: string;
  code?: string;
}

interface PlannedItem { seq: number; department: string; role: TeamRole; title: string; preset: string; specialty?: string | null; description?: string | null }

/** Validated plan items, numbered from 1 in department order (leads first). */
export function expandBatch(raw: unknown): PlannedItem[] {
  if (!Array.isArray(raw)) throw new CompanyPlanInputError('departments must be a list');
  const ids = parseDepartments(raw.map((d) => (d && typeof d === 'object' ? (d as BatchDepartmentInput).department : d)));
  if (ids.length !== raw.length) throw new CompanyPlanInputError('Each department may appear only once');
  const items: PlannedItem[] = [];
  raw.forEach((entry, i) => {
    const d = entry as BatchDepartmentInput;
    for (const k of Object.keys(d)) if (!['department', 'count', 'presets', 'specialties'].includes(k)) throw new CompanyPlanInputError(`Unknown field "${k.slice(0, 40)}"`);
    if (typeof d.count !== 'number' || !Number.isInteger(d.count) || d.count < 1 || d.count > MAX_TOTAL_HEADCOUNT) {
      throw new CompanyPlanInputError(`Each department count must be a whole number from 1 to ${MAX_TOTAL_HEADCOUNT}`);
    }
    const share = departmentShare(ids[i], d.count);
    const presets = { ...share.presets };
    if (d.presets !== undefined) {
      if (!d.presets || typeof d.presets !== 'object' || Array.isArray(d.presets)) throw new CompanyPlanInputError('presets must be an object of role -> persona');
      for (const [role, preset] of Object.entries(d.presets)) {
        if (!(TEAM_ROLES as readonly string[]).includes(role)) throw new CompanyPlanInputError('presets may only name manager, specialist or evaluator');
        if (!isPresetId(preset)) throw new CompanyPlanInputError('Unknown persona');
        presets[role as TeamRole] = preset;
      }
    }
    let assigned: {name:string;description:string}[] | undefined;
    if(d.specialties!==undefined){
      if(!Array.isArray(d.specialties)||d.specialties.length<1||d.specialties.length>50)throw new CompanyPlanInputError('Choose up to 50 specialties per department');
      const seen=new Set<string>();assigned=[];
      for(const entry of d.specialties){
        if(!entry||typeof entry!=='object'||Object.keys(entry).some(k=>!['name','count','description'].includes(k))||typeof entry.name!=='string'||typeof entry.description!=='string'||!Number.isSafeInteger(entry.count)||entry.count<0||entry.count>d.count)throw new CompanyPlanInputError('Invalid specialty');
        const name=entry.name.normalize('NFKC').trim(),description=entry.description.trim();
        if(!name||name.length>80||description.length>1800||/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name)||/[\u0000\u202a-\u202e\u2066-\u2069]/.test(description)||seen.has(name.toLowerCase()))throw new CompanyPlanInputError('Specialty names must be unique and descriptions bounded');
        seen.add(name.toLowerCase());for(let n=0;n<entry.count;n++)assigned.push({name,description});
      }
      if(assigned.length!==d.count)throw new CompanyPlanInputError('Specialty counts must equal the department count');
    }
    let specialtyIndex=0;
    for (const role of TEAM_ROLES) {
      for (let n = 0; n < share.roles[role]; n++) {
        const selected=assigned?.[specialtyIndex++];
        items.push({ seq: items.length + 1, department: share.department, role, title: selected?.name??share.titles[role], preset: presets[role], ...(selected?{specialty:selected.name,description:selected.description}:{}) });
      }
    }
  });
  if (items.length > MAX_TOTAL_HEADCOUNT) throw new CompanyPlanInputError(`At most ${MAX_TOTAL_HEADCOUNT} agents in total`);
  return items;
}

function fingerprint(language: string, items: readonly PlannedItem[]): string {
  const h = createHash('sha256').update(language);
  for (const it of items) h.update(`\n${it.seq}|${it.department}|${it.role}|${it.preset}`);
  if(items.some(it=>it.specialty))h.update('\nspecialties:'+JSON.stringify(items.map(it=>[it.specialty??null,it.description??null])));
  return h.digest('hex');
}

function* progressStep(id: string, ownerId: string): Step<BatchProgress | null> {
  const batch = yield* one<{ id: string; total: number; created_at: string }>(
    'SELECT id, total, created_at FROM team_hire_batches WHERE id = ? AND owner_id = ?', id, ownerId);
  if (!batch) return null;
  const rows = yield* all<{ department: string; status: string; n: number }>(
    'SELECT department, status, COUNT(*) AS n FROM team_hire_batch_items WHERE batch_id = ? GROUP BY department, status', id);
  const deps = new Map<string, { department: string; total: number; created: number; failed: number }>();
  const order = yield* all<{ department: string }>(
    'SELECT department, MIN(seq) AS first_seq FROM team_hire_batch_items WHERE batch_id = ? GROUP BY department ORDER BY first_seq', id);
  for (const o of order) deps.set(o.department, { department: o.department, total: 0, created: 0, failed: 0 });
  let created = 0; let failed = 0; let pending = 0;
  for (const r of rows) {
    const n = Number(r.n);
    const d = deps.get(r.department)!;
    d.total += n;
    if (r.status === 'created') { d.created += n; created += n; } else if (r.status === 'failed') { d.failed += n; failed += n; } else pending += n;
  }
  const total = Number(batch.total);
  return { id, total, created, failed, pending, done: pending === 0, createdAt: batch.created_at, departments: [...deps.values()] };
}

export function batchStatus(id: string, ownerId: string): Promise<BatchProgress | null> {
  return sql().read(progressStep(id, ownerId));
}

/** The owner's batches that still have pending or failed items, newest first. */
export async function openBatches(ownerId: string): Promise<BatchProgress[]> {
  const ids = await sql().read(all<{ id: string }>(`
    SELECT b.id FROM team_hire_batches b
    WHERE b.owner_id = ? AND EXISTS (SELECT 1 FROM team_hire_batch_items i WHERE i.batch_id = b.id AND i.status != 'created')
    ORDER BY b.created_at DESC, b.id DESC LIMIT 10`, ownerId));
  const out: BatchProgress[] = [];
  for (const r of ids) {
    const p = await batchStatus(r.id, ownerId);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Store a reviewed plan as a batch. Same id + same plan: the stored batch
 * (created: false). Same id + another plan, or another owner's id: 409.
 */
export async function createBatch(ownerId: string, input: { id?: unknown; language?: unknown; departments?: unknown }): Promise<{ created: boolean; progress: BatchProgress }> {
  if (typeof input.id !== 'string' || !BATCH_ID_RE.test(input.id)) throw new CompanyPlanInputError('id must be 8-64 letters, digits, - or _');
  if (input.language !== undefined && !isNameLanguage(input.language)) throw new CompanyPlanInputError('Unsupported language');
  const id = input.id;
  // No language: the owner's onboarding language (as for a single hire), fixed in the batch.
  const language: NameLanguage = await resolveNamingLanguage(ownerId, input.language);
  const items = expandBatch(input.departments);
  const print = fingerprint(language, items);

  const created = await sql().tx(function* () {
    const d = yield* dialect();
    const existing = yield* one<{ owner_id: string; fingerprint: string }>('SELECT owner_id, fingerprint FROM team_hire_batches WHERE id = ?', id);
    if (existing) {
      if (existing.owner_id !== ownerId || existing.fingerprint !== print) {
        throw new TeamBatchError(409, 'batch_conflict', 'A different batch already uses this id');
      }
      return false;
    }
    yield* run(`INSERT INTO team_hire_batches (id, owner_id, fingerprint, language, total, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ${nowText(d)}, ${nowText(d)})`,
      id, ownerId, print, language, items.length);
    for (const it of items) {
      yield* run('INSERT INTO team_hire_batch_items (batch_id, seq, department, role, title, preset, specialty, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, it.seq, it.department, it.role, it.title, it.preset, it.specialty??null, it.description??null);
    }
    return true;
  }, { immediate: true });
  return { created, progress: (await batchStatus(id, ownerId))! };
}

class AlreadyTaken extends Error {}

/** One process-wide run per batch at a time (the DB claim is the real guard). */
const running = new Set<string>();

/**
 * Create up to `max` pending items. `retryFailed` first puts failed items back
 * to pending. Returns this run's results and the progress after it.
 */
export async function runBatch(ownerId: string, id: string, opts: { max?: unknown; retryFailed?: unknown } = {}): Promise<{ results: RunResultItem[]; progress: BatchProgress }> {
  const max = opts.max === undefined ? 25 : opts.max;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > MAX_RUN_ITEMS) throw new CompanyPlanInputError(`max must be 1 to ${MAX_RUN_ITEMS}`);
  if (opts.retryFailed !== undefined && typeof opts.retryFailed !== 'boolean') throw new CompanyPlanInputError('retryFailed must be true or false');
  const batch = await sql().read(one<{ language: string }>('SELECT language FROM team_hire_batches WHERE id = ? AND owner_id = ?', id, ownerId));
  if (!batch) throw new TeamBatchError(404, 'batch_not_found', 'Batch not found');
  if (running.has(id)) throw new TeamBatchError(409, 'batch_running', 'This batch is already running');
  running.add(id);
  try {
    if (opts.retryFailed === true) {
      await sql().tx(function* () {
        const d = yield* dialect();
        yield* run(`UPDATE team_hire_batch_items SET status = 'pending', error_code = NULL, updated_at = ${nowText(d)} WHERE batch_id = ? AND status = 'failed'`, id);
      });
    }
    const language = batch.language as NameLanguage;
    const pending = await sql().read(all<PlannedItem>(
      `SELECT seq, department, role, title, preset, specialty, description FROM team_hire_batch_items WHERE batch_id = ? AND status = 'pending' ORDER BY seq LIMIT ${max}`, id));
    const results: RunResultItem[] = [];
    for (const it of pending) {
      const r = await createItem(ownerId, id, { ...it, seq: Number(it.seq) }, language);
      if (r) results.push(r);
    }
    return { results, progress: (await batchStatus(id, ownerId))! };
  } finally {
    running.delete(id);
  }
}

async function createItem(ownerId: string, batchId: string, it: PlannedItem, language: NameLanguage): Promise<RunResultItem | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [suggestion] = await suggestAgentNames(language, 1);
    const agentId = newAgentId();
    try {
      await sql().tx(function* () {
        const d = yield* dialect();
        // Claim first: only a pending item becomes created. A concurrent run
        // that already took it leaves 0 rows here, and this transaction rolls back.
        const claim = yield* run(
          `UPDATE team_hire_batch_items SET status = 'created', agent_id = ?, name = ?, error_code = NULL, updated_at = ${nowText(d)} WHERE batch_id = ? AND seq = ? AND status = 'pending'`,
          agentId, suggestion.name, batchId, it.seq);
        if (claim.changes !== 1) throw new AlreadyTaken();
        yield* insertAgentConfigStep({
          id: agentId,
          name: suggestion.name,
          language,
          body: { description: it.specialty ? `${it.specialty}: ${it.description??''}` : `${it.title} in ${labelOf(it.department)}.`, ...(it.specialty?{system_prompt:`Your specialty is ${it.specialty}.\n${it.description??''}\nWork within your assigned permissions. This job description grants no tools, credentials or external access.`}:{}) },
          role: it.role as AgentRole,
          department: it.department,
          explicit: { preset: it.preset },
          userId: ownerId,
        });
        if(it.specialty)yield* run('UPDATE agents_config SET specialty=? WHERE id=?',it.specialty,agentId);
      }, { immediate: true });
      return { seq: it.seq, status: 'created', agentId, name: suggestion.name };
    } catch (err) {
      if (err instanceof AlreadyTaken) return null;
      if (err instanceof AgentNameTakenError) continue; // a name was taken meanwhile: pick another
      console.error('[TeamBatch] create failed', { batchId, seq: it.seq, error: (err as Error)?.message });
      await markFailed(batchId, it.seq, 'create_failed');
      return { seq: it.seq, status: 'failed', code: 'create_failed' };
    }
  }
  await markFailed(batchId, it.seq, 'name_unavailable');
  return { seq: it.seq, status: 'failed', code: 'name_unavailable' };
}

function markFailed(batchId: string, seq: number, code: string): Promise<void> {
  return sql().tx(function* () {
    const d = yield* dialect();
    yield* run(`UPDATE team_hire_batch_items SET status = 'failed', error_code = ?, updated_at = ${nowText(d)} WHERE batch_id = ? AND seq = ? AND status = 'pending'`, code, batchId, seq);
  });
}

function labelOf(department: string): string {
  return departmentShare(department, 1).departmentLabel;
}
