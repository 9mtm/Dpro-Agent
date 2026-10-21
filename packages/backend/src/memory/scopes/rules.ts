/**
 * Review rules per scope (MEM-GAPS-02, migration 121 memory_scope_rules).
 *
 * What happens to a fact an agent learns, set per scope and inherited
 * company -> department -> project (null = inherit; the company falls back
 * to the defaults):
 *
 *   routine        save (default) | ask  — ask = routine facts wait in Review too
 *   important      ask (default) | save  — save = important facts are saved at
 *                  once, except the ones that always ask (ALWAYS_ASK: secrets,
 *                  outsiders, permissions, low confidence, overwrites)
 *   contradiction  ask (default) | keep_new | keep_both — the owner's standing
 *                  answer to a conflict (the old text always stays in history)
 *
 * A department also names its reviewer (an agent that sees the department's
 * waiting reviews; the owner still approves every decision), and the company
 * row holds the weekly summary time (day 0-6 = Sunday-Saturday, hour 0-23),
 * which reschedules the owner's weekly-summary job.
 *
 * Which scope a learned fact belongs to: a project drawer -> that project
 * (its department, then the company); every other drawer -> the company.
 * A chat the owner reviews (Accept / Reject in the chat) always asks.
 */

import { v4 as uuidv4 } from 'uuid';
import { all, one, run, sql, type Step } from '../../repositories/sql-steps.js';
import type { DrawerRef } from '../drawers.js';
import { parseAccessScope, type AccessScope } from './access.js';
import { GENERAL_DEPARTMENT, ScopeInputError, departmentStep, listProjectsStep } from './store.js';

export const ROUTINE_RULES = ['save', 'ask'] as const;
export const IMPORTANT_RULES = ['ask', 'save'] as const;
export const CONTRADICTION_RULES = ['ask', 'keep_new', 'keep_both'] as const;
export type RoutineRule = (typeof ROUTINE_RULES)[number];
export type ImportantRule = (typeof IMPORTANT_RULES)[number];
export type ContradictionRule = (typeof CONTRADICTION_RULES)[number];

export const DEFAULT_RULES = { routine: 'save', important: 'ask', contradiction: 'ask' } as const;
/** Reasons that always wait for the owner, whatever the rules say. */
export const ALWAYS_ASK: ReadonlySet<string> = new Set(['credentials', 'outsider', 'permissions', 'low-confidence', 'overwrite', 'chat']);

export interface OwnRules {
  routine: RoutineRule | null;
  important: ImportantRule | null;
  contradiction: ContradictionRule | null;
  reviewerAgentId: string | null;
  weeklyDay: number | null;
  weeklyHour: number | null;
  /** Company row: days in the Trash before forgetting (0 = never; null = default). */
  trashDays: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface EffectiveRules {
  routine: RoutineRule;
  important: ImportantRule;
  contradiction: ContradictionRule;
  /** The scope each rule comes from ('default' when nothing set it). */
  from: { routine: string; important: string; contradiction: string };
  /** The department's reviewer (department and project scopes), else null. */
  reviewerAgentId: string | null;
  weekly: { day: number; hour: number };
  /** Days a deleted memory stays in the Trash (0 = never forgotten by itself). */
  trashDays: number;
}

interface Row {
  scope_kind: string; scope_id: string; routine: RoutineRule | null; important: ImportantRule | null; contradiction: ContradictionRule | null;
  reviewer_agent_id: string | null; weekly_day: number | null; weekly_hour: number | null; trash_days?: number | null; updated_by: string | null; updated_at: string | null;
}

const AGENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const scopeId = (s: AccessScope) => (s.kind === 'company' ? 'company' : `${s.kind}:${s.id}`);
const own = (r: Row | undefined): OwnRules => ({
  routine: r?.routine ?? null, important: r?.important ?? null, contradiction: r?.contradiction ?? null,
  reviewerAgentId: r?.reviewer_agent_id ?? null, weeklyDay: r?.weekly_day ?? null, weeklyHour: r?.weekly_hour ?? null,
  trashDays: r?.trash_days ?? null,
  updatedBy: r?.updated_by ?? null, updatedAt: r?.updated_at ?? null,
});

/** The default weekly time: jobs.ts WEEKLY_SUMMARY_CRON (Monday 08:00). */
const DEFAULT_WEEKLY = { day: 1, hour: 8 };
/** MEM-TRASH-01: allowed Trash keep-days (0 = never) and the default. */
export const TRASH_DAYS = [0, 7, 30, 90] as const;
export const DEFAULT_TRASH_DAYS = 30;

/** The chain of a scope: company; company -> department; company -> department of the project -> project. */
function* chainStep(ownerId: string, scope: AccessScope): Step<AccessScope[]> {
  if (scope.kind === 'company') return [scope];
  if (scope.kind === 'department') return [{ kind: 'company', id: '' }, scope];
  const p = yield* one<{ department_id: string | null }>('SELECT department_id FROM memory_project_scopes WHERE owner_id = ? AND slug = ?', ownerId, scope.id);
  return [{ kind: 'company', id: '' }, { kind: 'department', id: p?.department_id || GENERAL_DEPARTMENT }, scope];
}

function* rowsStep(ownerId: string, chain: AccessScope[]): Step<Map<string, Row>> {
  const rows = yield* all<Row>(`SELECT * FROM memory_scope_rules WHERE owner_id = ? AND (${chain.map(() => '(scope_kind = ? AND scope_id = ?)').join(' OR ')})`,
    ownerId, ...chain.flatMap((s) => [s.kind, s.id]));
  return new Map(rows.map((r) => [r.scope_kind === 'company' ? 'company' : `${r.scope_kind}:${r.scope_id}`, r]));
}

function resolve(chain: AccessScope[], rows: Map<string, Row>): EffectiveRules {
  const out: EffectiveRules = {
    ...DEFAULT_RULES, from: { routine: 'default', important: 'default', contradiction: 'default' },
    reviewerAgentId: null, weekly: { ...DEFAULT_WEEKLY }, trashDays: DEFAULT_TRASH_DAYS,
  };
  for (const s of chain) {
    const r = rows.get(scopeId(s));
    if (!r) continue;
    if (r.routine) { out.routine = r.routine; out.from.routine = scopeId(s); }
    if (r.important) { out.important = r.important; out.from.important = scopeId(s); }
    if (r.contradiction) { out.contradiction = r.contradiction; out.from.contradiction = scopeId(s); }
    if (s.kind === 'department') out.reviewerAgentId = r.reviewer_agent_id ?? null;
    if (s.kind === 'company' && r.weekly_day !== null && r.weekly_hour !== null) out.weekly = { day: Number(r.weekly_day), hour: Number(r.weekly_hour) };
    if (s.kind === 'company' && r.trash_days !== null && r.trash_days !== undefined) out.trashDays = Number(r.trash_days);
  }
  return out;
}

function* existsStep(ownerId: string, scope: AccessScope): Step<void> {
  if (scope.kind === 'department' && !(yield* departmentStep(ownerId, scope.id))) throw new ScopeInputError('Department not found', 404, 'not_found');
  if (scope.kind === 'project' && !(yield* listProjectsStep(ownerId)).some((p) => p.slug === scope.id)) throw new ScopeInputError('Project not found', 404, 'not_found');
}

/** A scope's own rules and the rules in effect there. */
export async function scopeRules(ownerId: string, scopeInput: unknown): Promise<{ scope: string; own: OwnRules; effective: EffectiveRules }> {
  const scope = parseAccessScope(scopeInput ?? 'company');
  return sql().read((function* () {
    yield* existsStep(ownerId, scope);
    const chain = yield* chainStep(ownerId, scope);
    const rows = yield* rowsStep(ownerId, chain);
    return { scope: scopeId(scope), own: own(rows.get(scopeId(scope))), effective: resolve(chain, rows) };
  })());
}

/** Every scope with rules of its own (for an overview). */
export async function listScopeRules(ownerId: string): Promise<Array<{ scope: string; own: OwnRules }>> {
  const rows = await sql().read(all<Row>('SELECT * FROM memory_scope_rules WHERE owner_id = ? ORDER BY scope_kind, scope_id', ownerId));
  return rows.map((r) => ({ scope: r.scope_kind === 'company' ? 'company' : `${r.scope_kind}:${r.scope_id}`, own: own(r) }));
}

/** The rules for a fact learned into this drawer (never throws: defaults on any error). */
export async function rulesForDrawer(ownerId: string, drawer: DrawerRef): Promise<EffectiveRules> {
  const scope: AccessScope = drawer.kind === 'project' && drawer.key ? { kind: 'project', id: drawer.key } : { kind: 'company', id: '' };
  try {
    return await sql().read((function* () {
      const chain = yield* chainStep(ownerId, scope);
      return resolve(chain, yield* rowsStep(ownerId, chain));
    })());
  } catch {
    return resolve([], new Map());
  }
}

export interface RulesInput { routine?: unknown; important?: unknown; contradiction?: unknown; reviewerAgentId?: unknown; weeklyDay?: unknown; weeklyHour?: unknown; trashDays?: unknown }
const FIELDS = ['routine', 'important', 'contradiction', 'reviewerAgentId', 'weeklyDay', 'weeklyHour', 'trashDays'] as const;

/** Validated changes: a field left out keeps its value, null clears it (inherit). */
export function parseRulesInput(scope: AccessScope, input: Record<string, unknown>): Partial<Record<(typeof FIELDS)[number], string | number | null>> {
  const unknown = Object.keys(input).find((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown) throw new ScopeInputError(`Unknown field "${unknown.slice(0, 40)}"`);
  const out: Partial<Record<(typeof FIELDS)[number], string | number | null>> = {};
  const pick = (k: 'routine' | 'important' | 'contradiction', allowed: readonly string[]) => {
    if (input[k] === undefined) return;
    if (input[k] !== null && !allowed.includes(input[k] as string)) throw new ScopeInputError(`${k} must be ${allowed.join(', ')} or null (inherit)`);
    out[k] = input[k] as string | null;
  };
  pick('routine', ROUTINE_RULES);
  pick('important', IMPORTANT_RULES);
  pick('contradiction', CONTRADICTION_RULES);
  if (input.reviewerAgentId !== undefined) {
    if (scope.kind !== 'department') throw new ScopeInputError('A reviewer is set per department');
    if (input.reviewerAgentId !== null && (typeof input.reviewerAgentId !== 'string' || !AGENT_ID.test(input.reviewerAgentId))) throw new ScopeInputError('reviewerAgentId is invalid');
    out.reviewerAgentId = input.reviewerAgentId as string | null;
  }
  for (const [k, max] of [['weeklyDay', 6], ['weeklyHour', 23]] as const) {
    if (input[k] === undefined) continue;
    if (scope.kind !== 'company') throw new ScopeInputError('The weekly summary time is set for the company');
    if (input[k] !== null && (!Number.isInteger(input[k]) || (input[k] as number) < 0 || (input[k] as number) > max)) throw new ScopeInputError(`${k} must be 0-${max} or null`);
    out[k] = input[k] as number | null;
  }
  if (input.trashDays !== undefined) {
    if (scope.kind !== 'company') throw new ScopeInputError('The Trash keep-days are set for the company');
    if (input.trashDays !== null && !(TRASH_DAYS as readonly unknown[]).includes(input.trashDays)) throw new ScopeInputError(`trashDays must be ${TRASH_DAYS.join(', ')} (0 = never) or null`);
    out.trashDays = input.trashDays as number | null;
  }
  if ((out.weeklyDay === undefined) !== (out.weeklyHour === undefined) || (out.weeklyDay === null) !== (out.weeklyHour === null)) {
    throw new ScopeInputError('Give weeklyDay and weeklyHour together');
  }
  if (!Object.keys(out).length) throw new ScopeInputError('Nothing to change', 409, 'no_change');
  return out;
}

const COLUMN: Record<(typeof FIELDS)[number], string> = {
  routine: 'routine', important: 'important', contradiction: 'contradiction', reviewerAgentId: 'reviewer_agent_id', weeklyDay: 'weekly_day', weeklyHour: 'weekly_hour', trashDays: 'trash_days',
};

/** Save a scope's rules (owner only; callers audit). Reschedules the weekly summary when its time changes. */
export async function setScopeRules(ownerId: string, scopeInput: unknown, input: Record<string, unknown>, by: string): Promise<{ scope: string; own: OwnRules; effective: EffectiveRules }> {
  const scope = parseAccessScope(scopeInput ?? 'company');
  const changes = parseRulesInput(scope, input);
  await sql().tx(function* () {
    yield* existsStep(ownerId, scope);
    if (typeof changes.reviewerAgentId === 'string' && !(yield* one('SELECT 1 AS x FROM agents_config WHERE id = ?', changes.reviewerAgentId))) {
      throw new ScopeInputError('Agent not found', 404, 'not_found');
    }
    yield* run(`INSERT INTO memory_scope_rules (owner_id, scope_kind, scope_id, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (owner_id, scope_kind, scope_id) DO NOTHING`, ownerId, scope.kind, scope.id, by, new Date().toISOString());
    const keys = Object.keys(changes) as Array<keyof typeof changes>;
    yield* run(`UPDATE memory_scope_rules SET ${keys.map((k) => `${COLUMN[k]} = ?`).join(', ')}, updated_by = ?, updated_at = ?
      WHERE owner_id = ? AND scope_kind = ? AND scope_id = ?`, ...keys.map((k) => changes[k] ?? null), by, new Date().toISOString(), ownerId, scope.kind, scope.id);
  }, { immediate: true });
  const out = await scopeRules(ownerId, scopeId(scope));
  if (changes.weeklyDay !== undefined) await scheduleWeekly(ownerId, out.effective.weekly);
  return out;
}

/** Move the owner's weekly-summary job to this time (a running cron engine picks it up at once). */
async function scheduleWeekly(ownerId: string, at: { day: number; hour: number }): Promise<void> {
  // Loaded here: learning.ts imports this file and jobs.ts imports learning (retention).
  const { MEMORY_JOB_ACTION, memoryJobName } = await import('../jobs.js');
  const { upsertNamedJob } = await import('../../scheduler/store.js');
  const { getCronEngine } = await import('../../scheduler/engine.js');
  const { job } = await upsertNamedJob(uuidv4(), {
    name: memoryJobName('weekly-summary', ownerId), description: 'Weekly memory summary (what I learned this week)',
    cronExpression: `0 ${at.hour} * * ${at.day}`, actionType: MEMORY_JOB_ACTION, actionData: { job: 'weekly-summary', userId: ownerId },
  });
  const engine = getCronEngine();
  if (engine.isStarted() && job.enabled) engine.scheduleJob(job);
}
