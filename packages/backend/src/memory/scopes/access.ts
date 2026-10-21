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
export interface AccessScope { kind: AccessScopeKind; id: string }

export const MAX_CHANGES = 100;
export const MAX_ASSIGN_AGENTS = 5000;
export const MAX_TEMPLATES = 200;
const SAMPLE = 20;

export interface AccessRule {
  id: string;
  scope: string;
  agentId: string | null;
  drawerKind: DrawerKind;
  read: AccessMode;
  write: AccessMode;
  endsAt: string | null;
  expired: boolean;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface RoleTemplate { id: string; name: string; memoryRead: DrawerKind[]; memoryWrite: DrawerKind[]; agents: number }

// ---------------------------------------------------------------------------
// Bit masks: kind i -> read bit 2i, write bit 2i+1
// ---------------------------------------------------------------------------

const KINDS = [...DRAWER_KINDS] as DrawerKind[];
const ALL = (1 << (KINDS.length * 2)) - 1;
const READ_BIT = (k: DrawerKind) => 1 << (KINDS.indexOf(k) * 2);
const WRITE_BIT = (k: DrawerKind) => 1 << (KINDS.indexOf(k) * 2 + 1);

export function maskOf(read: readonly DrawerKind[], write: readonly DrawerKind[]): number {
  let m = 0;
  for (const k of read) m |= READ_BIT(k);
  for (const k of write) if (read.includes(k)) m |= WRITE_BIT(k);
  return m;
}

/** Write needs read. */
function normalizeMask(m: number): number {
  let out = m;
  for (const k of KINDS) if (!(m & READ_BIT(k))) out &= ~WRITE_BIT(k);
  return out;
}

export function kindsOf(m: number): { read: DrawerKind[]; write: DrawerKind[] } {
  return { read: KINDS.filter((k) => m & READ_BIT(k)), write: KINDS.filter((k) => m & WRITE_BIT(k)) };
}

// ---------------------------------------------------------------------------
// Snapshot: everything resolution needs, loaded once per owner and version
// ---------------------------------------------------------------------------

interface RuleRow { id: string; scope_kind: AccessScopeKind; scope_id: string; agent_id: string; drawer_kind: DrawerKind; read_mode: AccessMode; write_mode: AccessMode; ends_at: string | null; reason: string | null; created_by: string | null; created_at: string }
interface TemplateRow { id: string; name: string; memory_read: string; memory_write: string }

export interface AccessSnapshot {
  ownerId: string;
  version: number;
  rules: RuleRow[];
  templates: Map<string, { id: string; name: string; mask: number; read: DrawerKind[]; write: DrawerKind[] }>;
  roles: Map<string, string>;
  /** project slug -> department id (only projects outside General). */
  projectDept: Map<string, string>;
}

const scopeKey = (kind: AccessScopeKind, id: string) => (kind === 'company' ? 'company' : `${kind}:${id}`);
const kindsFromJson = (text: string): DrawerKind[] => {
  try { const v = JSON.parse(text); return Array.isArray(v) ? KINDS.filter((k) => v.includes(k)) : []; } catch { return []; }
};

function* loadSnapshotStep(ownerId: string): Step<AccessSnapshot> {
  const version = Number((yield* one<{ version: number }>('SELECT version FROM memory_access_versions WHERE owner_id = ?', ownerId))?.version ?? 0);
  const rules = yield* all<RuleRow>('SELECT * FROM memory_access_rules WHERE owner_id = ? ORDER BY created_at, id', ownerId);
  const trows = yield* all<TemplateRow>('SELECT id, name, memory_read, memory_write FROM memory_role_templates WHERE owner_id = ? ORDER BY norm_name, id', ownerId);
  const roles = yield* all<{ agent_id: string; template_id: string }>('SELECT agent_id, template_id FROM memory_agent_roles WHERE owner_id = ?', ownerId);
  const depts = yield* all<{ slug: string; department_id: string }>('SELECT slug, department_id FROM memory_project_scopes WHERE owner_id = ? AND department_id IS NOT NULL', ownerId);
  const templates = new Map<string, { id: string; name: string; mask: number; read: DrawerKind[]; write: DrawerKind[] }>();
  for (const t of trows) {
    const read = kindsFromJson(t.memory_read);
    const write = kindsFromJson(t.memory_write).filter((k) => read.includes(k));
    templates.set(t.id, { id: t.id, name: t.name, mask: maskOf(read, write), read, write });
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
  const m = effectiveMask(snap, p.agentId, maskOf(p.memoryRead, p.memoryWrite), project, now);
  const k = kindsOf(m);
  return { ...p, memoryRead: p.memoryRead.filter((x) => k.read.includes(x)), memoryWrite: p.memoryWrite.filter((x) => k.write.includes(x)) };
}

export interface WhyStep { layer: 'default' | 'company' | 'department' | 'project' | 'agent-company' | 'agent-department' | 'agent-project' | 'agent-permissions' | 'role-template'; value: 'allow' | 'deny'; ruleId?: string; endsAt?: string | null; name?: string }
export interface KindAccess { read: boolean; write: boolean; readWhy: WhyStep[]; writeWhy: WhyStep[] }

/** Effective access of one agent in one project, per drawer kind, with every layer that decided it. */
export function explainAccess(snap: AccessSnapshot, agentId: string, own: { read: DrawerKind[]; write: DrawerKind[] }, project: string | null, now = Date.now()): Record<DrawerKind, KindAccess> {
  const ix = indexed(snap);
  const keys = chainKeys(snap, project);
  const layerOf = (key: string, agent: boolean): WhyStep['layer'] => {
    const kind = key === 'company' ? 'company' : key.slice(0, key.indexOf(':')) as 'department' | 'project';
    return (agent ? `agent-${kind}` : kind) as WhyStep['layer'];
  };
  const tId = snap.roles.get(agentId);
  const template = tId ? snap.templates.get(tId) : undefined;
  const out = {} as Record<DrawerKind, KindAccess>;
  for (const k of KINDS) {
    const why = { read: [{ layer: 'default', value: 'allow' }] as WhyStep[], write: [{ layer: 'default', value: 'allow' }] as WhyStep[] };
    const consider = (r: RuleRow, layer: WhyStep['layer']) => {
      if (r.drawer_kind !== k) return;
      if (r.read_mode !== 'inherit') why.read.push({ layer, value: r.read_mode, ruleId: r.id, endsAt: r.ends_at });
      if (r.write_mode !== 'inherit') why.write.push({ layer, value: r.write_mode, ruleId: r.id, endsAt: r.ends_at });
    };
    for (const key of keys) for (const r of ix.base.get(key) ?? []) consider(r, layerOf(key, false));
    const own2 = ix.agent.get(agentId);
    for (const key of keys) for (const r of own2?.get(key) ?? []) if (!ended(r, now)) consider(r, layerOf(key, true));
    why.read.push({ layer: 'agent-permissions', value: own.read.includes(k) ? 'allow' : 'deny' });
    why.write.push({ layer: 'agent-permissions', value: own.write.includes(k) ? 'allow' : 'deny' });
    if (template) {
      why.read.push({ layer: 'role-template', value: template.read.includes(k) ? 'allow' : 'deny', name: template.name });
      why.write.push({ layer: 'role-template', value: template.write.includes(k) ? 'allow' : 'deny', name: template.name });
    }
    out[k] = { read: false, write: false, readWhy: why.read, writeWhy: why.write };
  }
  const m = effectiveMask(snap, agentId, maskOf(own.read, own.write), project, now);
  for (const k of KINDS) { out[k].read = !!(m & READ_BIT(k)); out[k].write = !!(m & WRITE_BIT(k)); }
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

export async function accessOverview(ownerId: string): Promise<{ version: number; rules: AccessRule[]; templates: RoleTemplate[] }> {
  const snap = await accessSnapshot(ownerId);
  const counts = new Map<string, number>();
  for (const t of snap.roles.values()) counts.set(t, (counts.get(t) ?? 0) + 1);
  return {
    version: snap.version,
    rules: snap.rules.map((r) => ruleView(r)),
    templates: [...snap.templates.values()].map((t) => ({ id: t.id, name: t.name, memoryRead: t.read, memoryWrite: t.write, agents: counts.get(t.id) ?? 0 })),
  };
}

// ---------------------------------------------------------------------------
// Changes: parse, simulate, preview, apply
// ---------------------------------------------------------------------------

export type AccessChange =
  | { op: 'set_rule'; scope: AccessScope; agentId: string | null; drawerKind: DrawerKind; read: AccessMode; write: AccessMode; endsAt: string | null; reason: string | null }
  | { op: 'clear_rule'; scope: AccessScope; agentId: string | null; drawerKind: DrawerKind }
  | { op: 'save_template'; id: string | null; name: string; memoryRead: DrawerKind[]; memoryWrite: DrawerKind[] }
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
        if (!(KINDS as unknown[]).includes(o.drawerKind)) throw new ScopeInputError(`changes[${i}].drawerKind must be one of ${KINDS.join(', ')}`);
        const drawerKind = o.drawerKind as DrawerKind;
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
        return { op: 'save_template', id: id as string | null, name: cleanName(o.name, 'role template'), memoryRead, memoryWrite };
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
      snap.templates.set(id, { id, name: c.name, mask: maskOf(c.memoryRead, c.memoryWrite), read: c.memoryRead, write: c.memoryWrite });
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
  const own = new Map(rows.map((r) => [r.agent_id, maskOf(kindsFromJson(r.memory_read), kindsFromJson(r.memory_write))]));
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
  sample: Array<{ agentId: string; agentName: string; project: string | null; before: { read: DrawerKind[]; write: DrawerKind[] }; after: { read: DrawerKind[]; write: DrawerKind[] } }>;
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
      if (sample.length < SAMPLE) sample.push({ agentId: a.id, agentName: a.name, project: p, before: kindsOf(b), after: kindsOf(x) });
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
    for (const r of before.rules) if (!afterIds.has(r.id)) yield* run('DELETE FROM memory_access_rules WHERE owner_id = ? AND id = ?', ownerId, r.id);
    const beforeIds = new Map(before.rules.map((r) => [r.id, r]));
    for (const r of after.rules) {
      const old = beforeIds.get(r.id);
      if (old && JSON.stringify(old) === JSON.stringify(r)) continue;
      if (old) {
        yield* run('UPDATE memory_access_rules SET read_mode = ?, write_mode = ?, ends_at = ?, reason = ?, created_by = ? WHERE owner_id = ? AND id = ?',
          r.read_mode, r.write_mode, r.ends_at, r.reason, r.created_by, ownerId, r.id);
      } else {
        yield* run(`INSERT INTO memory_access_rules (id, owner_id, scope_kind, scope_id, agent_id, drawer_kind, read_mode, write_mode, ends_at, reason, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.id, ownerId, r.scope_kind, r.scope_id, r.agent_id, r.drawer_kind, r.read_mode, r.write_mode, r.ends_at, r.reason, r.created_by, r.created_at);
      }
    }
    // Templates.
    for (const t of before.templates.values()) if (!after.templates.has(t.id)) yield* run('DELETE FROM memory_role_templates WHERE owner_id = ? AND id = ?', ownerId, t.id);
    for (const t of after.templates.values()) {
      const old = before.templates.get(t.id);
      if (old && old.name === t.name && old.mask === t.mask) continue;
      const nowIso = new Date(now).toISOString();
      if (old) {
        yield* run('UPDATE memory_role_templates SET name = ?, norm_name = ?, memory_read = ?, memory_write = ?, updated_at = ? WHERE owner_id = ? AND id = ?',
          t.name, normName(t.name), JSON.stringify(t.read), JSON.stringify(t.write), nowIso, ownerId, t.id);
      } else {
        yield* run('INSERT INTO memory_role_templates (id, owner_id, name, norm_name, memory_read, memory_write, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          t.id, ownerId, t.name, normName(t.name), JSON.stringify(t.read), JSON.stringify(t.write), by, nowIso, nowIso);
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
    effective: { memoryRead: KINDS.filter((k) => kinds[k].read), memoryWrite: KINDS.filter((k) => kinds[k].write) },
    kinds,
  };
}
