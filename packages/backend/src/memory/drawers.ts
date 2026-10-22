/**
 * Memory drawers (CORE-03).
 *
 * Every memory belongs to exactly one drawer of its user:
 *   owner       preferences and standing decisions of the owner (no key)
 *   project     one drawer per project (key = project slug)
 *   experience  what worked and what failed (no key)
 *   task        the current task / run, temporary (key = task or run id)
 *   people      one drawer per person (key = person id)
 *
 * Economy rule: a chat turn or a sub-agent loads only the drawers it needs.
 * `selectDrawers` decides which ones (pure function); retrieval then reads
 * only those drawers, so another project's drawer is never loaded.
 *
 * Memory stays strictly per user (S0-Q.11): drawers only narrow a user's own
 * memories, they never widen access to someone else's.
 */

import type { MemoryType } from './types.js';
import { run, sql, type Step } from '../repositories/sql-steps.js';

export const DRAWER_KINDS = ['owner', 'project', 'experience', 'task', 'people'] as const;
export type DrawerKind = typeof DRAWER_KINDS[number];

export interface DrawerRef {
  kind: DrawerKind;
  /** Project slug, task/run id or person id; absent for owner and experience. */
  key?: string;
  /** Trusted run restriction: shared project memory can be read but never written. */
  readOnly?: boolean;
}

const KEYED: ReadonlySet<DrawerKind> = new Set(['project', 'task', 'people']);
/** Project keys are lower-case slugs. */
const PROJECT_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Task/run ids and person ids: plain identifiers (also safe as a file-name part). */
const ID_KEY = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

/** At most this many people drawers are opened for one turn. */
export const MAX_PEOPLE_DRAWERS = 10;

export class DrawerInputError extends Error {}

export function isDrawerKind(value: unknown): value is DrawerKind {
  return typeof value === 'string' && (DRAWER_KINDS as readonly string[]).includes(value);
}

export function isValidDrawerKey(kind: DrawerKind, key: unknown): key is string {
  if (typeof key !== 'string') return false;
  if (kind === 'project') return PROJECT_KEY.test(key);
  return ID_KEY.test(key) && !key.includes('..');
}

/** Validated copy of a drawer reference, or throws DrawerInputError. */
export function normalizeDrawer(value: unknown): DrawerRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DrawerInputError('Invalid drawer');
  const { kind, key } = value as { kind?: unknown; key?: unknown };
  if (!isDrawerKind(kind)) throw new DrawerInputError('Invalid drawer kind');
  if (KEYED.has(kind)) {
    if (!isValidDrawerKey(kind, key)) throw new DrawerInputError(`Invalid ${kind} drawer key`);
    return { kind, key };
  }
  if (key !== undefined && key !== null && key !== '') throw new DrawerInputError(`The ${kind} drawer has no key`);
  return { kind };
}

/** `owner`, `experience`, `project:alpha`, `task:run-1`, `people:p-42`. */
export function drawerId(d: DrawerRef): string {
  return d.key ? `${d.kind}:${d.key}` : d.kind;
}

/** Parse a drawer id (as used in URLs). Throws DrawerInputError. */
export function parseDrawerId(value: unknown): DrawerRef {
  if (typeof value !== 'string' || value.length > 200) throw new DrawerInputError('Invalid drawer');
  const i = value.indexOf(':');
  return i < 0
    ? normalizeDrawer({ kind: value })
    : normalizeDrawer({ kind: value.slice(0, i), key: value.slice(i + 1) });
}

export function sameDrawer(a: DrawerRef, b: DrawerRef): boolean {
  return a.kind === b.kind && (a.key || '') === (b.key || '');
}

function uniqueDrawers(list: DrawerRef[]): DrawerRef[] {
  const out: DrawerRef[] = [];
  for (const d of list) if (!out.some((x) => sameDrawer(x, d))) out.push(d);
  return out;
}

/**
 * Default drawer for a memory saved without one, and for rows that existed
 * before drawers: learned skills/insights go to experience, everything else
 * to the owner drawer (task/people/project drawers need a key we do not know).
 */
export function defaultDrawerForType(type: MemoryType | string | undefined): DrawerRef {
  return type === 'skill' || type === 'insight' ? { kind: 'experience' } : { kind: 'owner' };
}

/** SQL expression for a row's drawer kind, NULL (pre-drawer row) -> its default. */
export const DRAWER_KIND_SQL =
  "COALESCE(drawer_kind, CASE WHEN type IN ('skill', 'insight') THEN 'experience' ELSE 'owner' END)";
/** SQL expression for a row's drawer key ('' when none). */
export const DRAWER_KEY_SQL = "COALESCE(drawer_key, '')";

/**
 * SQL condition restricting rows to the given drawers. An empty list matches
 * nothing (`1 = 0`: a boolean on both drivers), so "no drawers selected"
 * really loads no memory.
 */
export function drawerSqlFilter(drawers: DrawerRef[]): { sql: string; params: string[] } {
  const list = uniqueDrawers(drawers.map((d) => normalizeDrawer(d)));
  if (list.length === 0) return { sql: '1 = 0', params: [] };
  const parts: string[] = [];
  const params: string[] = [];
  for (const d of list) {
    parts.push(`(${DRAWER_KIND_SQL} = ? AND ${DRAWER_KEY_SQL} = ?)`);
    params.push(d.kind, d.key || '');
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}

// ---------------------------------------------------------------------------
// Which drawers does a turn load?
// ---------------------------------------------------------------------------

export type DrawerAudience =
  /** The user's own direct chat with their agent. */
  | 'owner'
  /** A reply that goes to someone else: channel sender, public-room visitor (S0-A.14). */
  | 'outsider'
  /** A sub-agent run: only what its parent passed (D-SUBAGENTS). */
  | 'subagent';

export interface DrawerContext {
  audience: DrawerAudience;
  /** The one active project of this turn, if any. */
  project?: string | null;
  /** The current task / run id, if any. */
  task?: string | null;
  /** People mentioned in or linked to this turn. */
  people?: readonly string[] | null;
  /** Include the experience drawer (default true). */
  experience?: boolean;
  /** Sub-agents: the drawers the parent passed down. */
  passed?: readonly DrawerRef[] | null;
}

/**
 * Decide which drawers a chat turn or sub-agent run loads (pure).
 *
 *  - outsider: none. Owner memory never reaches an outsider (S0-A.14).
 *  - owner:    the owner drawer, experience (unless turned off), the ONE
 *              active project's drawer, the current task's drawer and the
 *              drawers of the people mentioned/linked (at most 10). Other
 *              projects, tasks and people are not loaded.
 *  - subagent: exactly the valid drawers its parent passed, nothing else.
 *
 * Invalid keys are dropped (never widen the selection on bad input).
 */
export function selectDrawers(ctx: DrawerContext): DrawerRef[] {
  if (!ctx || ctx.audience === 'outsider') return [];
  if (ctx.audience === 'subagent') {
    const out: DrawerRef[] = [];
    for (const d of ctx.passed || []) {
      try { out.push(normalizeDrawer(d)); } catch { /* dropped */ }
    }
    return uniqueDrawers(out);
  }
  if (ctx.audience !== 'owner') return [];

  const out: DrawerRef[] = [{ kind: 'owner' }];
  if (ctx.experience !== false) out.push({ kind: 'experience' });
  if (ctx.project && isValidDrawerKey('project', ctx.project)) out.push({ kind: 'project', key: ctx.project });
  if (ctx.task && isValidDrawerKey('task', ctx.task)) out.push({ kind: 'task', key: ctx.task });
  const people = (ctx.people || []).filter((p) => isValidDrawerKey('people', p));
  for (const p of people.slice(0, MAX_PEOPLE_DRAWERS)) out.push({ kind: 'people', key: p });
  return uniqueDrawers(out);
}

/**
 * Drawers a parent may hand to a sub-agent: the requested ones that the
 * parent itself has loaded (a subset, never more). No request -> none.
 */
export function subagentDrawers(parent: readonly DrawerRef[], requested: readonly unknown[] | null | undefined): DrawerRef[] {
  const out: DrawerRef[] = [];
  for (const r of requested || []) {
    let d: DrawerRef;
    try { d = typeof r === 'string' ? parseDrawerId(r) : normalizeDrawer(r); } catch { continue; }
    if (parent.some((p) => sameDrawer(p, d))) out.push(d);
  }
  return uniqueDrawers(out);
}

/**
 * Turn scope parameters from an API request (`project`, `task`, `people`
 * as a comma list or array) into a DrawerContext for the caller's own chat.
 * Throws DrawerInputError on invalid values so the caller sees a 400.
 */
export function ownerScopeFromInput(input: { project?: unknown; task?: unknown; people?: unknown; experience?: unknown }): DrawerContext {
  const ctx: DrawerContext = { audience: 'owner' };
  if (input.project !== undefined && input.project !== null && input.project !== '') {
    if (!isValidDrawerKey('project', input.project)) throw new DrawerInputError('Invalid project');
    ctx.project = input.project;
  }
  if (input.task !== undefined && input.task !== null && input.task !== '') {
    if (!isValidDrawerKey('task', input.task)) throw new DrawerInputError('Invalid task');
    ctx.task = input.task;
  }
  if (input.people !== undefined && input.people !== null && input.people !== '') {
    const list = Array.isArray(input.people)
      ? input.people
      : typeof input.people === 'string' ? input.people.split(',').map((s) => s.trim()).filter(Boolean) : null;
    if (!list || list.length > MAX_PEOPLE_DRAWERS || !list.every((p) => isValidDrawerKey('people', p))) {
      throw new DrawerInputError('Invalid people');
    }
    ctx.people = list as string[];
  }
  if (input.experience === false || input.experience === 'false' || input.experience === '0') ctx.experience = false;
  return ctx;
}

/**
 * Drawers of a chat turn (used by POST /api/chat). `includeOwnerMemory` is
 * false for a reply to an outsider (channel turn, S0-A.14): no drawers.
 * Otherwise the caller's own chat with the optional `memoryScope`
 * ({ project, task, people, experience }). Throws DrawerInputError.
 */
export function chatTurnDrawers(includeOwnerMemory: boolean, memoryScope: unknown): DrawerRef[] {
  if (!includeOwnerMemory) return selectDrawers({ audience: 'outsider' });
  const scope = memoryScope && typeof memoryScope === 'object' && !Array.isArray(memoryScope) ? memoryScope as Record<string, unknown> : {};
  return selectDrawers(ownerScopeFromInput(scope));
}

/**
 * Fill drawer_kind/drawer_key of rows saved before drawers existed (the
 * default for their type). Idempotent; logs counts only, never content.
 * One transaction (B2.2b-4: SQL steps, both drivers).
 */
export function* backfillMemoryDrawersStep(): Step<{ owner: number; experience: number }> {
  const exp = (yield* run(
    "UPDATE memories SET drawer_kind = 'experience', drawer_key = '' WHERE drawer_kind IS NULL AND type IN ('skill', 'insight')"
  )).changes;
  const own = (yield* run(
    "UPDATE memories SET drawer_kind = 'owner', drawer_key = '' WHERE drawer_kind IS NULL"
  )).changes;
  yield* run("UPDATE memories SET drawer_key = '' WHERE drawer_key IS NULL");
  if (own || exp) {
    console.log(`[Memory] Drawers assigned to existing memories: owner ${own}, experience ${exp}`);
  }
  return { owner: own, experience: exp };
}

/** backfillMemoryDrawersStep on the process driver (the argument of the old signature is ignored). */
export function backfillMemoryDrawers(_db?: unknown): Promise<{ owner: number; experience: number }> {
  return sql().tx(() => backfillMemoryDrawersStep());
}
