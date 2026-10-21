/**
 * Memory access by inheritance (MEM-SCALE-01).
 *
 * Per drawer kind, read and write are resolved in this order; the last rule
 * that says allow or deny wins (inherit = no say):
 *
 *   default (allow) -> company -> department of the project -> project
 *     -> the agent's exceptions: company -> department -> project
 *        (an exception may end at `endsAt`; an ended one is ignored)
 *
 * The result is then capped by the agent layer: the agent's own permissions
 * (agent_permissions, CORE-PERMS-01) intersected with its role template, if
 * it has one. A rule can therefore never give an agent more than its own
 * permissions; with no rules at all an agent keeps exactly what CORE-PERMS-01
 * gives it (the behaviour before this file). Write needs read. A delegated
 * run still gets the strictest of every agent in the chain
 * (agent-permissions.ts strictest).
 *
 * Besides the drawer kinds the grid has two scope columns (MEM-GAPS-02):
 * 'company' = the company's pinned facts, 'department' = the pinned facts of
 * the project's department. Their rules live in memory_access_scope_rules
 * (migration 121) and resolve in the same order; an agent's own permissions
 * do not name them (no cap there), a role template caps them only when it
 * lists them (scopeRead / scopeWrite; null = no cap). Write on a scope column
 * = the agent may ask (owner-approved) to change that scope's pinned facts.
 *
 * Every change goes preview -> apply: the preview counts the agents and
 * projects whose effective access changes, and its previewHash (which
 * includes the owner's access version) must come back with the apply, so a
 * change only lands on what the owner saw. Policies are per owner (the
 * company); a run uses the policies of its own user.
 */

import { createHash } from 'node:crypto';
import { all, one, run, sql, sqliteSync, type Step } from '../../repositories/sql-steps.js';
import { DRAWER_KINDS, isValidDrawerKey, type DrawerKind } from '../drawers.js';
import { GENERAL_DEPARTMENT, ScopeInputError, cleanName, departmentStep, listProjectsStep, normName } from './store.js';
import type { AgentPermissions } from '../../tools/agent-permissions.js';

export const ACCESS_MODES = ['allow', 'deny', 'inherit'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];
export type AccessScopeKind = 'company' | 'department' | 'project';
/** The two scope columns of the access grid (pinned facts of the company / of the project's department). */
export const SCOPE_COLUMNS = ['company', 'department'] as const;
export type ScopeColumn = (typeof SCOPE_COLUMNS)[number];
/** Every column of the access grid: the drawer kinds, then the scope columns. */
export const ACCESS_COLUMNS = [...DRAWER_KINDS, ...SCOPE_COLUMNS] as const;
export type AccessColumn = DrawerKind | ScopeColumn;
export const isScopeColumn = (k: unknown): k is ScopeColumn => (SCOPE_COLUMNS as readonly unknown[]).includes(k);
export interface AccessScope { kind: AccessScopeKind; id: string }

export const MAX_CHANGES = 100;
export const MAX_ASSIGN_AGENTS = 5000;
export const MAX_TEMPLATES = 200;
const SAMPLE = 20;

export interface AccessRule {
  id: string;
  scope: string;
  agentId: string | null;
  drawerKind: AccessColumn;
  read: AccessMode;
  write: AccessMode;
  endsAt: string | null;
  expired: boolean;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface RoleTemplate { id: string; name: string; memoryRead: DrawerKind[]; memoryWrite: DrawerKind[]; scopeRead: ScopeColumn[] | null; scopeWrite: ScopeColumn[] | null; agents: number }

// ---------------------------------------------------------------------------
// Bit masks: column i -> read bit 2i, write bit 2i+1
// ---------------------------------------------------------------------------

const KINDS = [...DRAWER_KINDS] as DrawerKind[];
const COLUMNS = [...ACCESS_COLUMNS] as AccessColumn[];
const ALL = (1 << (COLUMNS.length * 2)) - 1;
const READ_BIT = (k: AccessColumn) => 1 << (COLUMNS.indexOf(k) * 2);
const WRITE_BIT = (k: AccessColumn) => 1 << (COLUMNS.indexOf(k) * 2 + 1);
/** Read + write of both scope columns (no cap from the agent's own permissions). */
const SCOPE_ALL = SCOPE_COLUMNS.reduce((m, k) => m | READ_BIT(k) | WRITE_BIT(k), 0);

export function maskOf(read: readonly AccessColumn[], write: readonly AccessColumn[]): number {
  let m = 0;
  for (const k of read) m |= READ_BIT(k);
  for (const k of write) if (read.includes(k)) m |= WRITE_BIT(k);
  return m;
}

/** Write needs read. */
function normalizeMask(m: number): number {
  let out = m;
  for (const k of COLUMNS) if (!(m & READ_BIT(k))) out &= ~WRITE_BIT(k);
  return out;
}

export function kindsOf(m: number): { read: DrawerKind[]; write: DrawerKind[] } {
  return { read: KINDS.filter((k) => m & READ_BIT(k)), write: KINDS.filter((k) => m & WRITE_BIT(k)) };
}

/** Every column of a mask (drawer kinds, then company / department). */
export function columnsOf(m: number): { read: AccessColumn[]; write: AccessColumn[] } {
  return { read: COLUMNS.filter((k) => m & READ_BIT(k)), write: COLUMNS.filter((k) => m & WRITE_BIT(k)) };
}

/** The mask of an agent's own permissions: its drawer kinds, and both scope columns (not capped there). */
export const ownMaskOf = (read: readonly DrawerKind[], write: readonly DrawerKind[]): number => maskOf(read, write) | SCOPE_ALL;

// ---------------------------------------------------------------------------
// Snapshot: everything resolution needs, loaded once per owner and version
// ---------------------------------------------------------------------------

interface RuleRow { id: string; scope_kind: AccessScopeKind; scope_id: string; agent_id: string; drawer_kind: AccessColumn; read_mode: AccessMode; write_mode: AccessMode; ends_at: string | null; reason: string | null; created_by: string | null; created_at: string }
interface TemplateRow { id: string; name: string; memory_read: string; memory_write: string; scope_read: string | null; scope_write: string | null }
interface TemplateEntry { id: string; name: string; mask: number; read: DrawerKind[]; write: DrawerKind[]; scopeRead: ScopeColumn[] | null; scopeWrite: ScopeColumn[] | null }

export interface AccessSnapshot {
  ownerId: string;
  version: number;
  rules: RuleRow[];
  templates: Map<string, TemplateEntry>;
  roles: Map<string, string>;
  /** project slug -> department id (only projects outside General). */
  projectDept: Map<string, string>;
}

const scopeKey = (kind: AccessScopeKind, id: string) => (kind === 'company' ? 'company' : `${kind}:${id}`);
const kindsFromJson = (text: string): DrawerKind[] => {
  try { const v = JSON.parse(text); return Array.isArray(v) ? KINDS.filter((k) => v.includes(k)) : []; } catch { return []; }
};
const scopesFromJson = (text: string | null): ScopeColumn[] | null => {
  if (text === null || text === undefined) return null;
  try { const v = JSON.parse(text); return Array.isArray(v) ? SCOPE_COLUMNS.filter((k) => v.includes(k)) : []; } catch { return []; }
};

/** A template's mask: its drawer kinds, and its scope columns (all of them when it names none: null). */
function templateEntry(id: string, name: string, read: DrawerKind[], write: DrawerKind[], scopeRead: ScopeColumn[] | null, scopeWrite: ScopeColumn[] | null): TemplateEntry {
  const w = write.filter((k) => read.includes(k));
  const sw = scopeRead === null ? null : (scopeWrite ?? []).filter((k) => scopeRead.includes(k));
  const mask = maskOf(read, w) | (scopeRead === null ? SCOPE_ALL : maskOf(scopeRead, sw ?? []));
  return { id, name, mask, read, write: w, scopeRead, scopeWrite: scopeRead === null ? null : sw };
}

/** Rules of both tables (drawer kinds; scope columns, migration 121), oldest first. */
const RULES_SQL = `SELECT id, scope_kind, scope_id, agent_id, drawer_kind, read_mode, write_mode, ends_at, reason, created_by, created_at FROM memory_access_rules WHERE owner_id = ?
  UNION ALL SELECT id, scope_kind, scope_id, agent_id, drawer_kind, read_mode, write_mode, ends_at, reason, created_by, created_at FROM memory_access_scope_rules WHERE owner_id = ?
  ORDER BY created_at, id`;
const rulesTable = (column: AccessColumn) => (isScopeColumn(column) ? 'memory_access_scope_rules' : 'memory_access_rules');

function* loadSnapshotStep(ownerId: string): Step<AccessSnapshot> {
  const version = Number((yield* one<{ version: number }>('SELECT version FROM memory_access_versions WHERE owner_id = ?', ownerId))?.version ?? 0);
  const rules = yield* all<RuleRow>(RULES_SQL, ownerId, ownerId);
  const trows = yield* all<TemplateRow>('SELECT id, name, memory_read, memory_write, scope_read, scope_write FROM memory_role_templates WHERE owner_id = ? ORDER BY norm_name, id', ownerId);
  const roles = yield* all<{ agent_id: string; template_id: string }>('SELECT agent_id, template_id FROM memory_agent_roles WHERE owner_id = ?', ownerId);
  const depts = yield* all<{ slug: string; department_id: string }>('SELECT slug, department_id FROM memory_project_scopes WHERE owner_id = ? AND department_id IS NOT NULL', ownerId);
  const templates = new Map<string, TemplateEntry>();
  for (const t of trows) {
    templates.set(t.id, templateEntry(t.id, t.name, kindsFromJson(t.memory_read), kindsFromJson(t.memory_write), scopesFromJson(t.scope_read), scopesFromJson(t.scope_write)));
  }
  return {
    ownerId, version, rules, templates,
    roles: new Map(roles.map((r) => [r.agent_id, r.template_id])),
    projectDept: new Map(depts.map((d) => [d.slug, d.department_id])),
  };
}

const cache = new Map<string, AccessSnapshot>();

/** The owner's snapshot (cached until the next change through this module). */
export async function accessSnapshot(ownerId: string): Promise<AccessSnapshot> {
  const hit = cache.get(ownerId);
  if (hit) return hit;
  const snap = await sql().read(loadSnapshotStep(ownerId));
  cache.set(ownerId, snap);
  return snap;
}

/** accessSnapshot, synchronously: SQLite only. */
export function accessSnapshotSync(ownerId: string): AccessSnapshot {
  const hit = cache.get(ownerId);
  if (hit) return hit;
  const snap = sqliteSync(loadSnapshotStep(ownerId));
  cache.set(ownerId, snap);
  return snap;
}

export function invalidateAccess(ownerId?: string): void {
  if (ownerId) cache.delete(ownerId); else cache.clear();
}

/** Bump the owner's access version (inside the caller's transaction). */
export function* bumpAccessVersionStep(ownerId: string): Step<number> {
  yield* run('INSERT INTO memory_access_versions (owner_id, version) VALUES (?, 0) ON CONFLICT (owner_id) DO NOTHING', ownerId);
  yield* run('UPDATE memory_access_versions SET version = version + 1 WHERE owner_id = ?', ownerId);
  invalidateAccess(ownerId);
  return Number((yield* one<{ version: number }>('SELECT version FROM memory_access_versions WHERE owner_id = ?', ownerId))?.version ?? 0);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const ended = (r: Pick<RuleRow, 'ends_at'>, now: number) => !!r.ends_at && Date.parse(r.ends_at) <= now;

/** The scope chain of a run in this project (null = no project: company only). */
function chainKeys(snap: AccessSnapshot, project: string | null): string[] {
  if (!project) return ['company'];
  return ['company', scopeKey('department', snap.projectDept.get(project) ?? GENERAL_DEPARTMENT), scopeKey('project', project)];
}

interface Indexed { base: Map<string, RuleRow[]>; agent: Map<string, Map<string, RuleRow[]>> }
const indexCache = new WeakMap<AccessSnapshot, Indexed>();
function indexed(snap: AccessSnapshot): Indexed {
  let ix = indexCache.get(snap);
  if (ix) return ix;
  ix = { base: new Map(), agent: new Map() };
  for (const r of snap.rules) {
    const key = scopeKey(r.scope_kind, r.scope_id);
    if (!r.agent_id) {
      ix.base.set(key, [...(ix.base.get(key) ?? []), r]);
    } else {
      const m = ix.agent.get(r.agent_id) ?? new Map<string, RuleRow[]>();
      m.set(key, [...(m.get(key) ?? []), r]);
      ix.agent.set(r.agent_id, m);
    }
  }
  indexCache.set(snap, ix);
  return ix;
}

function applyRule(m: number, r: RuleRow): number {
  let out = m;
  if (r.read_mode === 'allow') out |= READ_BIT(r.drawer_kind);
  else if (r.read_mode === 'deny') out &= ~READ_BIT(r.drawer_kind);
  if (r.write_mode === 'allow') out |= WRITE_BIT(r.drawer_kind);
  else if (r.write_mode === 'deny') out &= ~WRITE_BIT(r.drawer_kind);
  return out;
}

/** The scope rules' mask for everyone in this project (no agent exceptions). */
function baseMask(snap: AccessSnapshot, project: string | null): number {
  const ix = indexed(snap);
  let m = ALL;
  for (const key of chainKeys(snap, project)) for (const r of ix.base.get(key) ?? []) m = applyRule(m, r);
  return m;
}

function chainMask(snap: AccessSnapshot, project: string | null, agentId: string, now: number, base = baseMask(snap, project)): number {
  const own = indexed(snap).agent.get(agentId);
  if (!own) return base;
  let m = base;
  for (const key of chainKeys(snap, project)) for (const r of own.get(key) ?? []) if (!ended(r, now)) m = applyRule(m, r);
  return m;
}

function templateMask(snap: AccessSnapshot, agentId: string): number {
  const t = snap.roles.get(agentId);
  return t ? (snap.templates.get(t)?.mask ?? 0) : ALL;
}

/** The effective mask of an agent in a project, given its own permissions mask (CORE-PERMS-01). */
export function effectiveMask(snap: AccessSnapshot, agentId: string, ownMask: number, project: string | null, now = Date.now()): number {
  return normalizeMask(chainMask(snap, project, agentId, now) & ownMask & templateMask(snap, agentId));
}

/**
 * Narrow a run's permissions by the owner's policies for this project
 * (never widens: the result is a subset of `p`).
 */
export function narrowPermissions(p: AgentPermissions, snap: AccessSnapshot, project: string | null, now = Date.now()): AgentPermissions {
  const m = effectiveMask(snap, p.agentId, ownMaskOf(p.memoryRead, p.memoryWrite), project, now);
  const k = columnsOf(m);
  return {
    ...p,
    memoryRead: p.memoryRead.filter((x) => k.read.includes(x)),
    memoryWrite: p.memoryWrite.filter((x) => k.write.includes(x)),
    scopeRead: SCOPE_COLUMNS.filter((x) => k.read.includes(x) && (!p.scopeRead || p.scopeRead.includes(x))),
    scopeWrite: SCOPE_COLUMNS.filter((x) => k.write.includes(x) && (!p.scopeWrite || p.scopeWrite.includes(x))),
  };
}

export interface WhyStep { layer: 'default' | 'company' | 'department' | 'project' | 'agent-company' | 'agent-department' | 'agent-project' | 'agent-permissions' | 'role-template'; value: 'allow' | 'deny'; ruleId?: string; endsAt?: string | null; name?: string }
export interface KindAccess { read: boolean; write: boolean; readWhy: WhyStep[]; writeWhy: WhyStep[] }

/** Effective access of one agent in one project, per drawer kind, with every layer that decided it. */
export function explainAccess(snap: AccessSnapshot, agentId: string, own: { read: DrawerKind[]; write: DrawerKind[] }, project: string | null, now = Date.now()): Record<AccessColumn, KindAccess> {
  const ix = indexed(snap);
  const keys = chainKeys(snap, project);
  const layerOf = (key: string, agent: boolean): WhyStep['layer'] => {
    const kind = key === 'company' ? 'company' : key.slice(0, key.indexOf(':')) as 'department' | 'project';
    return (agent ? `agent-${kind}` : kind) as WhyStep['layer'];
  };
  const tId = snap.roles.get(agentId);
  const template = tId ? snap.templates.get(tId) : undefined;
  const out = {} as Record<AccessColumn, KindAccess>;
  for (const k of COLUMNS) {
    const why = { read: [{ layer: 'default', value: 'allow' }] as WhyStep[], write: [{ layer: 'default', value: 'allow' }] as WhyStep[] };
    const consider = (r: RuleRow, layer: WhyStep['layer']) => {
      if (r.drawer_kind !== k) return;
      if (r.read_mode !== 'inherit') why.read.push({ layer, value: r.read_mode, ruleId: r.id, endsAt: r.ends_at });
      if (r.write_mode !== 'inherit') why.write.push({ layer, value: r.write_mode, ruleId: r.id, endsAt: r.ends_at });
    };
    for (const key of keys) for (const r of ix.base.get(key) ?? []) consider(r, layerOf(key, false));
    const own2 = ix.agent.get(agentId);
    for (const key of keys) for (const r of own2?.get(key) ?? []) if (!ended(r, now)) consider(r, layerOf(key, true));
    if (!isScopeColumn(k)) {
      why.read.push({ layer: 'agent-permissions', value: own.read.includes(k) ? 'allow' : 'deny' });
      why.write.push({ layer: 'agent-permissions', value: own.write.includes(k) ? 'allow' : 'deny' });
    }
    if (template && (!isScopeColumn(k) || template.scopeRead !== null)) {
      why.read.push({ layer: 'role-template', value: template.mask & READ_BIT(k) ? 'allow' : 'deny', name: template.name });
      why.write.push({ layer: 'role-template', value: template.mask & WRITE_BIT(k) ? 'allow' : 'deny', name: template.name });
    }
    out[k] = { read: false, write: false, readWhy: why.read, writeWhy: why.write };
  }
  const m = effectiveMask(snap, agentId, ownMaskOf(own.read, own.write), project, now);
  for (const k of COLUMNS) { out[k].read = !!(m & READ_BIT(k)); out[k].write = !!(m & WRITE_BIT(k)); }
  return out;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function ruleView(r: RuleRow, now = Date.now()): AccessRule {
  return {
    id: r.id, scope: scopeKey(r.scope_kind, r.scope_id), agentId: r.agent_id || null, drawerKind: r.drawer_kind,
    read: r.read_mode, write: r.write_mode, endsAt: r.ends_at, expired: ended(r, now), reason: r.reason,
    createdBy: r.created_by, createdAt: r.created_at,
  };
}

export const templateView = (t: TemplateEntry, agents: number): RoleTemplate => ({
  id: t.id, name: t.name, memoryRead: t.read, memoryWrite: t.write, scopeRead: t.scopeRead, scopeWrite: t.scopeWrite, agents,
});

export async function accessOverview(ownerId: string): Promise<{ version: number; rules: AccessRule[]; templates: RoleTemplate[] }> {
  const snap = await accessSnapshot(ownerId);
  const counts = new Map<string, number>();
  for (const t of snap.roles.values()) counts.set(t, (counts.get(t) ?? 0) + 1);
  return {
    version: snap.version,
    rules: snap.rules.map((r) => ruleView(r)),
    templates: [...snap.templates.values()].map((t) => templateView(t, counts.get(t.id) ?? 0)),
  };
}

// ---------------------------------------------------------------------------
// Changes: parse, simulate, preview, apply
// ---------------------------------------------------------------------------

export type AccessChange =
  | { op: 'set_rule'; scope: AccessScope; agentId: string | null; drawerKind: AccessColumn; read: AccessMode; write: AccessMode; endsAt: string | null; reason: string | null }
  | { op: 'clear_rule'; scope: AccessScope; agentId: string | null; drawerKind: AccessColumn }
  /** scopeRead / scopeWrite: undefined = keep the template's scope columns (null for a new one = no cap). */
  | { op: 'save_template'; id: string | null; name: string; memoryRead: DrawerKind[]; memoryWrite: DrawerKind[]; scopeRead?: ScopeColumn[] | null; scopeWrite?: ScopeColumn[] }
  | { op: 'delete_template'; id: string }
  | { op: 'assign_template'; template: string | null; agentIds: string[] };

const AGENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TEMPLATE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseAccessScope(value: unknown): AccessScope {
  if (value === 'company') return { kind: 'company', id: '' };
  if (typeof value !== 'string' || value.length > 100) throw new ScopeInputError('scope must be company, department:<id> or project:<slug>');
  const i = value.indexOf(':');
  const kind = value.slice(0, i);
  const id = value.slice(i + 1);
  if (kind === 'department' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) return { kind, id };
  if (kind === 'project' && isValidDrawerKey('project', id)) return { kind, id };
  throw new ScopeInputError('scope must be company, department:<id> or project:<slug>');
}

function parseKinds(v: unknown, field: string): DrawerKind[] {
  if (!Array.isArray(v) || !v.every((k) => (KINDS as unknown[]).includes(k)) || new Set(v).size !== v.length) {
    throw new ScopeInputError(`${field} must be a list of drawer kinds (${KINDS.join(', ')})`);
  }
  return KINDS.filter((k) => v.includes(k));
}

function parseScopeColumns(v: unknown, field: string): ScopeColumn[] {
  if (!Array.isArray(v) || !v.every((k) => isScopeColumn(k)) || new Set(v).size !== v.length) {
    throw new ScopeInputError(`${field} must be a list of ${SCOPE_COLUMNS.join(', ')}`);
  }
  return SCOPE_COLUMNS.filter((k) => v.includes(k));
}

const mode = (v: unknown, field: string): AccessMode => {
  if (!(ACCESS_MODES as readonly unknown[]).includes(v)) throw new ScopeInputError(`${field} must be allow, deny or inherit`);
  return v as AccessMode;
};

/** Validated changes (shape only; existence is checked against the database in validateStep). */
export function parseAccessChanges(input: unknown, now = Date.now()): AccessChange[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CHANGES) throw new ScopeInputError(`changes must be a list of 1-${MAX_CHANGES} changes`);
  return input.map((c, i): AccessChange => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new ScopeInputError(`changes[${i}] must be an object`);
    const o = c as Record<string, unknown>;
    const agentId = o.agentId === undefined || o.agentId === null || o.agentId === '' ? null : o.agentId;
    if (agentId !== null && (typeof agentId !== 'string' || !AGENT_ID.test(agentId))) throw new ScopeInputError(`changes[${i}].agentId is invalid`);
    switch (o.op) {
      case 'set_rule': case 'clear_rule': {
        const scope = parseAccessScope(o.scope);
        if (!(COLUMNS as unknown[]).includes(o.drawerKind)) throw new ScopeInputError(`changes[${i}].drawerKind must be one of ${COLUMNS.join(', ')}`);
        const drawerKind = o.drawerKind as AccessColumn;
        if (o.op === 'clear_rule') return { op: 'clear_rule', scope, agentId: agentId as string | null, drawerKind };
        const read = mode(o.read ?? 'inherit', `changes[${i}].read`);
        const write = mode(o.write ?? 'inherit', `changes[${i}].write`);
        let endsAt: string | null = null;
        if (o.endsAt !== undefined && o.endsAt !== null && o.endsAt !== '') {
          if (!agentId) throw new ScopeInputError(`changes[${i}].endsAt is only for an agent exception`);
          const t = typeof o.endsAt === 'string' ? Date.parse(o.endsAt) : NaN;
          if (!Number.isFinite(t) || t <= now) throw new ScopeInputError(`changes[${i}].endsAt must be a future time`);
          endsAt = new Date(t).toISOString();
        }
        const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim().slice(0, 200) : null;
        return { op: 'set_rule', scope, agentId: agentId as string | null, drawerKind, read, write, endsAt, reason };
      }
      case 'save_template': {
        const id = o.id === undefined || o.id === null ? null : o.id;
        if (id !== null && (typeof id !== 'string' || !TEMPLATE_ID.test(id))) throw new ScopeInputError(`changes[${i}].id is invalid`);
        const memoryRead = parseKinds(o.memoryRead, `changes[${i}].memoryRead`);
        const memoryWrite = parseKinds(o.memoryWrite, `changes[${i}].memoryWrite`);
        if (memoryWrite.some((k) => !memoryRead.includes(k))) throw new ScopeInputError(`changes[${i}].memoryWrite may only name kinds memoryRead names`);
        const out: AccessChange = { op: 'save_template', id: id as string | null, name: cleanName(o.name, 'role template'), memoryRead, memoryWrite };
        if (o.scopeRead !== undefined) {
          const scopeRead = o.scopeRead === null ? null : parseScopeColumns(o.scopeRead, `changes[${i}].scopeRead`);
          const scopeWrite = o.scopeWrite === undefined || o.scopeWrite === null ? [] : parseScopeColumns(o.scopeWrite, `changes[${i}].scopeWrite`);
          if (scopeRead === null ? scopeWrite.length > 0 : scopeWrite.some((k) => !scopeRead.includes(k))) throw new ScopeInputError(`changes[${i}].scopeWrite may only name columns scopeRead names`);
          Object.assign(out, { scopeRead, scopeWrite });
        } else if (o.scopeWrite !== undefined) {
          throw new ScopeInputError(`changes[${i}].scopeWrite needs scopeRead`);
        }
        return out;
      }
      case 'delete_template':
        if (typeof o.id !== 'string' || !TEMPLATE_ID.test(o.id)) throw new ScopeInputError(`changes[${i}].id is invalid`);
        return { op: 'delete_template', id: o.id };
      case 'assign_template': {
        const template = o.template === null ? null : o.template;
        if (template !== null && (typeof template !== 'string' || !template.trim() || template.length > 80)) throw new ScopeInputError(`changes[${i}].template must be a template id or name, or null`);
        if (!Array.isArray(o.agentIds) || o.agentIds.length === 0 || o.agentIds.length > MAX_ASSIGN_AGENTS || !o.agentIds.every((a) => typeof a === 'string' && AGENT_ID.test(a))) {
          throw new ScopeInputError(`changes[${i}].agentIds must be 1-${MAX_ASSIGN_AGENTS} agent ids`);
        }
        return { op: 'assign_template', template: template as string | null, agentIds: [...new Set(o.agentIds as string[])] };
      }
      default:
        throw new ScopeInputError(`changes[${i}].op must be set_rule, clear_rule, save_template, delete_template or assign_template`);
    }
  });
}

/** Template id of an id or a name (in the snapshot, after earlier changes), or null. */
function templateRef(snap: AccessSnapshot, ref: string): string | null {
  if (snap.templates.has(ref)) return ref;
  const n = normName(ref);
  for (const t of snap.templates.values()) if (normName(t.name) === n) return t.id;
  return null;
}

/** Stable id of a template created by a change (same in preview and apply). */
const newTemplateId = (ownerId: string, version: number, name: string) =>
  `tpl-${createHash('sha256').update(`${ownerId}\n${version}\n${normName(name)}`).digest('hex').slice(0, 16)}`;

/**
 * The snapshot after the changes (pure; for the preview and to write the
 * same result). Throws ScopeInputError for a change that cannot apply.
 */
export function simulate(before: AccessSnapshot, changes: AccessChange[], by: string, now = Date.now()): AccessSnapshot {
  const snap: AccessSnapshot = {
    ...before,
    rules: [...before.rules],
    templates: new Map(before.templates),
    roles: new Map(before.roles),
  };
  const nowIso = new Date(now).toISOString();
  for (const c of changes) {
    if (c.op === 'set_rule' || c.op === 'clear_rule') {
      const agent = c.agentId ?? '';
      const i = snap.rules.findIndex((r) => r.scope_kind === c.scope.kind && r.scope_id === c.scope.id && r.agent_id === agent && r.drawer_kind === c.drawerKind);
      if (c.op === 'clear_rule') { if (i >= 0) snap.rules.splice(i, 1); continue; }
      if (c.read === 'inherit' && c.write === 'inherit') { if (i >= 0) snap.rules.splice(i, 1); continue; }
      const row: RuleRow = {
        id: i >= 0 ? snap.rules[i].id : `rule-${createHash('sha256').update(`${before.ownerId}\n${before.version}\n${c.scope.kind}:${c.scope.id}\n${agent}\n${c.drawerKind}`).digest('hex').slice(0, 16)}`,
        scope_kind: c.scope.kind, scope_id: c.scope.id, agent_id: agent, drawer_kind: c.drawerKind,
        read_mode: c.read, write_mode: c.write, ends_at: c.endsAt, reason: c.reason, created_by: by, created_at: i >= 0 ? snap.rules[i].created_at : nowIso,
      };
      if (i >= 0) snap.rules[i] = row; else snap.rules.push(row);
    } else if (c.op === 'save_template') {
      const id = c.id ?? templateRef(snap, c.name) ?? newTemplateId(before.ownerId, before.version, c.name);
      if (c.id && !snap.templates.has(c.id)) throw new ScopeInputError('Role template not found', 404, 'not_found');
      for (const t of snap.templates.values()) if (t.id !== id && normName(t.name) === normName(c.name)) throw new ScopeInputError('Another role template has that name', 409, 'name_taken');
      if (!snap.templates.has(id) && snap.templates.size >= MAX_TEMPLATES) throw new ScopeInputError('Too many role templates', 409, 'too_many');
      const old = snap.templates.get(id);
      const scopeRead = c.scopeRead !== undefined ? c.scopeRead : (old?.scopeRead ?? null);
      const scopeWrite = c.scopeRead !== undefined ? (c.scopeWrite ?? []) : (old?.scopeWrite ?? null);
      snap.templates.set(id, templateEntry(id, c.name, c.memoryRead, c.memoryWrite, scopeRead, scopeWrite));
    } else if (c.op === 'delete_template') {
      if (!snap.templates.delete(c.id)) throw new ScopeInputError('Role template not found', 404, 'not_found');
      for (const [a, t] of [...snap.roles]) if (t === c.id) snap.roles.delete(a);
    } else {
      const id = c.template === null ? null : templateRef(snap, c.template);
      if (c.template !== null && !id) throw new ScopeInputError('Role template not found', 404, 'not_found');
      for (const a of c.agentIds) { if (id) snap.roles.set(a, id); else snap.roles.delete(a); }
    }
  }
  return snap;
}

interface AgentCap { id: string; name: string; mask: number }

/** Every agent with its own permissions mask (no row = every kind, as CORE-PERMS-01). */
function* agentCapsStep(): Step<AgentCap[]> {
  const agents = yield* all<{ id: string; name: string }>('SELECT id, name FROM agents_config ORDER BY id');
  const rows = yield* all<{ agent_id: string; memory_read: string; memory_write: string }>('SELECT agent_id, memory_read, memory_write FROM agent_permissions');
  const own = new Map(rows.map((r) => [r.agent_id, ownMaskOf(kindsFromJson(r.memory_read), kindsFromJson(r.memory_write))]));
  return agents.map((a) => ({ id: a.id, name: a.name, mask: own.get(a.id) ?? ALL }));
}

/** Projects counted by a preview: active (not archived) projects, plus "no project". */
function* previewProjectsStep(ownerId: string): Step<Array<string | null>> {
  const projects = yield* listProjectsStep(ownerId);
  return [null, ...projects.filter((p) => !p.archived).map((p) => p.slug)];
}

export interface AccessDiff {
  agentsAffected: number;
  projectsAffected: number;
  /** Runs without a project (company rules only) change for some agent. */
  noProjectAffected: boolean;
  pairsChanged: number;
  widened: number;
  narrowed: number;
  agentsTotal: number;
  projectsTotal: number;
  sample: Array<{ agentId: string; agentName: string; project: string | null; before: { read: AccessColumn[]; write: AccessColumn[] }; after: { read: AccessColumn[]; write: AccessColumn[] } }>;
}

/** Compare two snapshots over every agent x project (bit masks: 3,000 x 100 is a few ms). */
export function diffAccess(before: AccessSnapshot, after: AccessSnapshot, agents: AgentCap[], projects: Array<string | null>, now = Date.now()): AccessDiff {
  const agentsHit = new Set<string>();
  const projectsHit = new Set<string | null>();
  let pairs = 0, widened = 0, narrowed = 0;
  const sample: AccessDiff['sample'] = [];
  const bIx = indexed(before), aIx = indexed(after);
  for (const p of projects) {
    const bBase = baseMask(before, p);
    const aBase = baseMask(after, p);
    for (const a of agents) {
      const bChain = bIx.agent.has(a.id) ? chainMask(before, p, a.id, now, bBase) : bBase;
      const aChain = aIx.agent.has(a.id) ? chainMask(after, p, a.id, now, aBase) : aBase;
      const b = normalizeMask(bChain & a.mask & templateMask(before, a.id));
      const x = normalizeMask(aChain & a.mask & templateMask(after, a.id));
      if (b === x) continue;
      pairs++;
      if (x & ~b) widened++;
      if (b & ~x) narrowed++;
      agentsHit.add(a.id);
      projectsHit.add(p);
      if (sample.length < SAMPLE) sample.push({ agentId: a.id, agentName: a.name, project: p, before: columnsOf(b), after: columnsOf(x) });
    }
  }
  return {
    agentsAffected: agentsHit.size,
    projectsAffected: [...projectsHit].filter((p) => p !== null).length,
    noProjectAffected: projectsHit.has(null),
    pairsChanged: pairs, widened, narrowed,
    agentsTotal: agents.length, projectsTotal: projects.length - 1, sample,
  };
}

/** Existence checks for a change set: departments, projects, agents, templates. */
function* validateStep(ownerId: string, changes: AccessChange[]): Step<void> {
  const projects = new Set((yield* listProjectsStep(ownerId)).map((p) => p.slug));
  const agentIds = new Set((yield* all<{ id: string }>('SELECT id FROM agents_config')).map((r) => r.id));
  for (const c of changes) {
    if (c.op === 'set_rule' || c.op === 'clear_rule') {
      if (c.scope.kind === 'department' && !(yield* departmentStep(ownerId, c.scope.id))) throw new ScopeInputError('Department not found', 404, 'not_found');
      if (c.scope.kind === 'project' && !projects.has(c.scope.id)) throw new ScopeInputError('Project not found', 404, 'not_found');
      if (c.agentId && !agentIds.has(c.agentId)) throw new ScopeInputError('Agent not found', 404, 'not_found');
    }
    if (c.op === 'assign_template') {
      const missing = c.agentIds.find((a) => !agentIds.has(a));
      if (missing) throw new ScopeInputError(`Agent not found: ${missing.slice(0, 40)}`, 404, 'not_found');
    }
  }
}

export interface AccessPreview extends AccessDiff { version: number; changes: number; previewHash: string }

const hashOf = (ownerId: string, version: number, changes: AccessChange[]) =>
  createHash('sha256').update(JSON.stringify({ ownerId, version, changes })).digest('hex');

function* previewStep(ownerId: string, changes: AccessChange[], by: string, now: number): Step<{ preview: AccessPreview; before: AccessSnapshot; after: AccessSnapshot }> {
  yield* validateStep(ownerId, changes);
  const before = yield* loadSnapshotStep(ownerId);
  const after = simulate(before, changes, by, now);
  const diff = diffAccess(before, after, yield* agentCapsStep(), yield* previewProjectsStep(ownerId), now);
  return { preview: { ...diff, version: before.version, changes: changes.length, previewHash: hashOf(ownerId, before.version, changes) }, before, after };
}

/** How many agents / projects the changes affect, before saving. */
export async function previewAccessChanges(ownerId: string, input: unknown, by: string, now = Date.now()): Promise<AccessPreview> {
  const changes = parseAccessChanges(input, now);
  return (await sql().read(previewStep(ownerId, changes, by, now))).preview;
}

/** Preview of an arbitrary snapshot edit (used by project moves): affected agents/projects. */
export function* previewSnapshotEditStep(ownerId: string, edit: (s: AccessSnapshot) => AccessSnapshot, projects?: Array<string | null>, now = Date.now()): Step<AccessDiff> {
  const before = yield* loadSnapshotStep(ownerId);
  const after = edit({ ...before, rules: [...before.rules], templates: new Map(before.templates), roles: new Map(before.roles), projectDept: new Map(before.projectDept) });
  return diffAccess(before, after, yield* agentCapsStep(), projects ?? (yield* previewProjectsStep(ownerId)), now);
}

/**
 * Apply the changes when `expectedPreviewHash` is the hash of a preview of
 * these same changes at the current version (else 409 preview_changed).
 * Writes the simulated result: rules and roles touched by the changes.
 */
export async function applyAccessChanges(ownerId: string, input: unknown, expectedPreviewHash: unknown, by: string, now = Date.now()): Promise<{ preview: AccessPreview; version: number }> {
  const changes = parseAccessChanges(input, now);
  if (typeof expectedPreviewHash !== 'string' || !expectedPreviewHash) throw new ScopeInputError('expectedPreviewHash is required (preview the change first)', 400, 'preview_hash_required');
  const result = await sql().tx(function* () {
    const { preview, before, after } = yield* previewStep(ownerId, changes, by, now);
    if (preview.previewHash !== expectedPreviewHash) throw new ScopeInputError('The access policies changed since the preview. Preview again.', 409, 'preview_changed');
    // Rules: delete removed, upsert changed.
    const afterIds = new Map(after.rules.map((r) => [r.id, r]));
    for (const r of before.rules) if (!afterIds.has(r.id)) yield* run(`DELETE FROM ${rulesTable(r.drawer_kind)} WHERE owner_id = ? AND id = ?`, ownerId, r.id);
    const beforeIds = new Map(before.rules.map((r) => [r.id, r]));
    for (const r of after.rules) {
      const old = beforeIds.get(r.id);
      if (old && JSON.stringify(old) === JSON.stringify(r)) continue;
      if (old) {
        yield* run(`UPDATE ${rulesTable(r.drawer_kind)} SET read_mode = ?, write_mode = ?, ends_at = ?, reason = ?, created_by = ? WHERE owner_id = ? AND id = ?`,
          r.read_mode, r.write_mode, r.ends_at, r.reason, r.created_by, ownerId, r.id);
      } else {
        yield* run(`INSERT INTO ${rulesTable(r.drawer_kind)} (id, owner_id, scope_kind, scope_id, agent_id, drawer_kind, read_mode, write_mode, ends_at, reason, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.id, ownerId, r.scope_kind, r.scope_id, r.agent_id, r.drawer_kind, r.read_mode, r.write_mode, r.ends_at, r.reason, r.created_by, r.created_at);
      }
    }
    // Templates.
    for (const t of before.templates.values()) if (!after.templates.has(t.id)) yield* run('DELETE FROM memory_role_templates WHERE owner_id = ? AND id = ?', ownerId, t.id);
    for (const t of after.templates.values()) {
      const old = before.templates.get(t.id);
      const scopes = (x: TemplateEntry) => JSON.stringify([x.scopeRead, x.scopeWrite]);
      if (old && old.name === t.name && old.mask === t.mask && scopes(old) === scopes(t)) continue;
      const nowIso = new Date(now).toISOString();
      const sr = t.scopeRead === null ? null : JSON.stringify(t.scopeRead);
      const sw = t.scopeWrite === null ? null : JSON.stringify(t.scopeWrite);
      if (old) {
        yield* run('UPDATE memory_role_templates SET name = ?, norm_name = ?, memory_read = ?, memory_write = ?, scope_read = ?, scope_write = ?, updated_at = ? WHERE owner_id = ? AND id = ?',
          t.name, normName(t.name), JSON.stringify(t.read), JSON.stringify(t.write), sr, sw, nowIso, ownerId, t.id);
      } else {
        yield* run('INSERT INTO memory_role_templates (id, owner_id, name, norm_name, memory_read, memory_write, scope_read, scope_write, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          t.id, ownerId, t.name, normName(t.name), JSON.stringify(t.read), JSON.stringify(t.write), sr, sw, by, nowIso, nowIso);
      }
    }
    // Roles.
    for (const [a] of before.roles) if (!after.roles.has(a)) yield* run('DELETE FROM memory_agent_roles WHERE owner_id = ? AND agent_id = ?', ownerId, a);
    for (const [a, t] of after.roles) {
      if (before.roles.get(a) === t) continue;
      yield* run(`INSERT INTO memory_agent_roles (owner_id, agent_id, template_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (owner_id, agent_id) DO UPDATE SET template_id = excluded.template_id, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at`,
      ownerId, a, t, by, new Date(now).toISOString());
    }
    const version = yield* bumpAccessVersionStep(ownerId);
    return { preview, version };
  }, { immediate: true });
  invalidateAccess(ownerId);
  return result;
}

/** Effective access + why for one agent (project optional). Null for an unknown agent. */
export async function effectiveAccess(ownerId: string, agentId: string, project: string | null, now = Date.now()) {
  if (!AGENT_ID.test(agentId)) return null;
  const agent = await sql().read(one<{ id: string; name: string }>('SELECT id, name FROM agents_config WHERE id = ?', agentId));
  if (!agent) return null;
  if (project !== null && !isValidDrawerKey('project', project)) throw new ScopeInputError('Invalid project');
  const row = await sql().read(one<{ memory_read: string; memory_write: string }>('SELECT memory_read, memory_write FROM agent_permissions WHERE agent_id = ?', agentId));
  const own = row
    ? { read: kindsFromJson(row.memory_read), write: kindsFromJson(row.memory_write).filter((k) => kindsFromJson(row.memory_read).includes(k)) }
    : { read: [...KINDS], write: [...KINDS] };
  const snap = await accessSnapshot(ownerId);
  const tId = snap.roles.get(agentId);
  const kinds = explainAccess(snap, agentId, own, project, now);
  return {
    agentId, agentName: agent.name, project,
    department: project ? (snap.projectDept.get(project) ?? GENERAL_DEPARTMENT) : null,
    version: snap.version,
    ownPermissions: { memoryRead: own.read, memoryWrite: own.write, stored: !!row },
    template: tId ? { id: tId, name: snap.templates.get(tId)?.name ?? tId } : null,
    exceptions: snap.rules.filter((r) => r.agent_id === agentId).map((r) => ruleView(r, now)),
    effective: {
      memoryRead: KINDS.filter((k) => kinds[k].read), memoryWrite: KINDS.filter((k) => kinds[k].write),
      scopeRead: SCOPE_COLUMNS.filter((k) => kinds[k].read), scopeWrite: SCOPE_COLUMNS.filter((k) => kinds[k].write),
    },
    kinds,
  };
}

// ---------------------------------------------------------------------------
// Who has access to a scope (MEM-GAPS-02)
// ---------------------------------------------------------------------------

/** Rule keys of a scope: company; company -> department; company -> department of the project -> project. */
function scopeChainKeys(snap: AccessSnapshot, scope: AccessScope): string[] {
  if (scope.kind === 'company') return ['company'];
  if (scope.kind === 'department') return ['company', scopeKey('department', scope.id)];
  return chainKeys(snap, scope.id);
}

/** One agent's effective mask in a scope's chain (same layers as effectiveMask). */
function scopeMask(snap: AccessSnapshot, keys: string[], a: AgentCap, now: number, base: number): number {
  const own = indexed(snap).agent.get(a.id);
  let m = base;
  if (own) for (const key of keys) for (const r of own.get(key) ?? []) if (!ended(r, now)) m = applyRule(m, r);
  return normalizeMask(m & a.mask & templateMask(snap, a.id));
}

function baseMaskOf(snap: AccessSnapshot, keys: string[]): number {
  const ix = indexed(snap);
  let m = ALL;
  for (const key of keys) for (const r of ix.base.get(key) ?? []) m = applyRule(m, r);
  return m;
}

export interface ScopeAgents {
  scope: string;
  column: AccessColumn;
  mode: 'read' | 'write';
  /** Agents with that access (after q). */
  count: number;
  /** Every agent. */
  total: number;
  agents: Array<{ id: string; name: string; read: boolean; write: boolean; template: string | null; exception: boolean }>;
  nextCursor: string | null;
}

/**
 * The agents that may read (or write) one column of a scope: company,
 * department:<id> (company -> department rules, no project) or
 * project:<slug>. Paged by name; `q` filters by name or id.
 */
export async function agentsWithAccess(ownerId: string, input: { scope?: unknown; column?: unknown; mode?: unknown; q?: unknown; cursor?: unknown; limit?: unknown }, now = Date.now()): Promise<ScopeAgents> {
  const scope = parseAccessScope(input.scope ?? 'company');
  const column = (input.column ?? (scope.kind === 'project' ? 'project' : 'owner')) as AccessColumn;
  if (!COLUMNS.includes(column)) throw new ScopeInputError(`column must be one of ${COLUMNS.join(', ')}`);
  const mode = input.mode ?? 'read';
  if (mode !== 'read' && mode !== 'write') throw new ScopeInputError('mode must be read or write');
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
  const offset = input.cursor === undefined || input.cursor === '' ? 0 : Number.parseInt(String(input.cursor), 36);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ScopeInputError('Invalid cursor');
  const q = typeof input.q === 'string' ? input.q.trim().toLowerCase().slice(0, 80) : '';
  const { agents, snap } = await sql().read((function* () {
    if (scope.kind === 'department' && !(yield* departmentStep(ownerId, scope.id))) throw new ScopeInputError('Department not found', 404, 'not_found');
    if (scope.kind === 'project' && !(yield* listProjectsStep(ownerId)).some((p) => p.slug === scope.id)) throw new ScopeInputError('Project not found', 404, 'not_found');
    return { agents: yield* agentCapsStep(), snap: yield* loadSnapshotStep(ownerId) };
  })());
  const keys = scopeChainKeys(snap, scope);
  const base = baseMaskOf(snap, keys);
  const bit = mode === 'read' ? READ_BIT(column) : WRITE_BIT(column);
  const exceptions = indexed(snap).agent;
  const hits = agents
    .filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
    .map((a) => ({ a, m: scopeMask(snap, keys, a, now, base) }))
    .filter((x) => x.m & bit)
    .sort((x, y) => x.a.name.localeCompare(y.a.name) || x.a.id.localeCompare(y.a.id));
  const page = hits.slice(offset, offset + limit);
  return {
    scope: scopeKey(scope.kind, scope.id), column, mode, count: hits.length, total: agents.length,
    agents: page.map(({ a, m }) => ({
      id: a.id, name: a.name, read: !!(m & READ_BIT(column)), write: !!(m & WRITE_BIT(column)),
      template: snap.roles.get(a.id) ?? null,
      exception: keys.some((k) => (exceptions.get(a.id)?.get(k) ?? []).some((r) => r.drawer_kind === column && !ended(r, now))),
    })),
    nextCursor: offset + limit < hits.length ? (offset + limit).toString(36) : null,
  };
}

/** How many agents may read (or write) one column in every scope: company, each department, each active project. */
export async function accessCounts(ownerId: string, input: { column?: unknown; mode?: unknown } = {}, now = Date.now()) {
  const column = (input.column ?? 'project') as AccessColumn;
  if (!COLUMNS.includes(column)) throw new ScopeInputError(`column must be one of ${COLUMNS.join(', ')}`);
  const mode = input.mode ?? 'read';
  if (mode !== 'read' && mode !== 'write') throw new ScopeInputError('mode must be read or write');
  const bit = mode === 'read' ? READ_BIT(column) : WRITE_BIT(column);
  const { agents, snap, departments, projects } = await sql().read((function* () {
    const ds = yield* all<{ id: string }>('SELECT id FROM memory_departments WHERE owner_id = ? ORDER BY id', ownerId);
    return {
      agents: yield* agentCapsStep(), snap: yield* loadSnapshotStep(ownerId),
      departments: [GENERAL_DEPARTMENT, ...ds.map((d) => d.id)],
      projects: (yield* listProjectsStep(ownerId)).filter((p) => !p.archived).map((p) => p.slug),
    };
  })());
  const count = (scope: AccessScope) => {
    const keys = scopeChainKeys(snap, scope);
    const base = baseMaskOf(snap, keys);
    let n = 0;
    for (const a of agents) if (scopeMask(snap, keys, a, now, base) & bit) n++;
    return n;
  };
  return {
    column, mode, total: agents.length,
    company: count({ kind: 'company', id: '' }),
    departments: Object.fromEntries(departments.map((id) => [id, count({ kind: 'department', id })])),
    projects: Object.fromEntries(projects.map((slug) => [slug, count({ kind: 'project', id: slug })])),
  };
}

/** One role template with the agents that use it (paged by name). */
export async function templateDetail(ownerId: string, id: string, opts: { cursor?: unknown; limit?: unknown } = {}) {
  if (!TEMPLATE_ID.test(id)) throw new ScopeInputError('Role template not found', 404, 'not_found');
  const snap = await accessSnapshot(ownerId);
  const t = snap.templates.get(id);
  if (!t) throw new ScopeInputError('Role template not found', 404, 'not_found');
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const offset = opts.cursor === undefined || opts.cursor === '' ? 0 : Number.parseInt(String(opts.cursor), 36);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ScopeInputError('Invalid cursor');
  const rows = await sql().read(all<{ id: string; name: string }>(`
    SELECT a.id, a.name FROM memory_agent_roles r JOIN agents_config a ON a.id = r.agent_id
     WHERE r.owner_id = ? AND r.template_id = ? ORDER BY a.name, a.id LIMIT ? OFFSET ?`, ownerId, id, limit + 1, offset));
  let agents = 0;
  for (const x of snap.roles.values()) if (x === id) agents++;
  return {
    template: templateView(t, agents),
    agents: rows.slice(0, limit),
    nextCursor: rows.length > limit ? (offset + limit).toString(36) : null,
  };
}
