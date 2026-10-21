/**
 * Scope tree, scope search and the memory explorer (MEM-SCALE-01).
 *
 * The tree (company -> departments -> projects, plus people and agents)
 * carries counts and a health flag per scope, computed on the server from
 * a handful of GROUP BY queries over indexed columns and cached per owner
 * (SCOPE_TREE_TTL_MS, dropped on every scope change), so opening or
 * switching a scope never scans memory text.
 *
 * Health: problem = open conflicts; attention = reviews waiting, a very
 * large drawer or no new memory for STALE_DAYS; else ok.
 *
 * The explorer pages the memories of one scope on the server (cursor on
 * created_at, id; newest first) with filter counts (facets).
 */

import { all, dialect, one, sql, type Step } from '../../repositories/sql-steps.js';
import { likeCi } from '../../db/pg/dialect.js';
import { drawerId, isValidDrawerKey, parseDrawerId, DrawerInputError, type DrawerKind } from '../drawers.js';
import { GENERAL_DEPARTMENT, ScopeInputError, departmentStep, listDepartmentsStep, listProjectsStep, type ProjectScope } from './store.js';

export const SCOPE_TREE_TTL_MS = 15_000;
export const STALE_DAYS = 90;
export const LARGE_SCOPE = 2000;

export type Health = 'ok' | 'attention' | 'problem';
export interface ScopeCounts { memories: number; pendingReviews: number; conflicts: number; pinnedFacts: number; lastMemoryAt: string | null }
export interface HealthFlag { health: Health; reasons: string[] }

export interface TreeProject extends ProjectScope, ScopeCounts, HealthFlag {}
export interface TreeDepartment extends ScopeCounts, HealthFlag { id: string; name: string; isDefault: boolean; projects: number; archivedProjects: number }
export interface ScopeTree {
  generatedAt: string;
  cached: boolean;
  company: ScopeCounts & HealthFlag & { drawers: Record<string, number>; departments: number; projects: number; archivedProjects: number };
  departments: TreeDepartment[];
  projects: TreeProject[];
  people: Array<ScopeCounts & HealthFlag & { key: string }>;
  agents: { total: number; withTemplate: number; withExceptions: number };
}

const zero = (): ScopeCounts => ({ memories: 0, pendingReviews: 0, conflicts: 0, pinnedFacts: 0, lastMemoryAt: null });

export function healthOf(c: ScopeCounts, now = Date.now()): HealthFlag {
  const reasons: string[] = [];
  if (c.conflicts > 0) reasons.push('conflicts');
  if (c.pendingReviews > 0) reasons.push('reviews_waiting');
  if (c.memories > LARGE_SCOPE) reasons.push('large');
  if (c.memories > 0 && c.lastMemoryAt && now - Date.parse(c.lastMemoryAt) > STALE_DAYS * 86_400_000) reasons.push('stale');
  return { health: c.conflicts > 0 ? 'problem' : reasons.length ? 'attention' : 'ok', reasons };
}

const add = (a: ScopeCounts, b: ScopeCounts) => {
  a.memories += b.memories; a.pendingReviews += b.pendingReviews; a.conflicts += b.conflicts;
  if (b.lastMemoryAt && (!a.lastMemoryAt || b.lastMemoryAt > a.lastMemoryAt)) a.lastMemoryAt = b.lastMemoryAt;
};

function* buildTreeStep(ownerId: string, now: number): Step<ScopeTree> {
  const drawerRows = yield* all<{ kind: string; key: string | null; n: number; last: string | null }>(
    'SELECT drawer_kind AS kind, drawer_key AS key, COUNT(*) AS n, MAX(created_at) AS last FROM memories WHERE user_id = ? GROUP BY drawer_kind, drawer_key', ownerId);
  const reviewRows = yield* all<{ kind: string; key: string; n: number; c: number }>(
    `SELECT drawer_kind AS kind, drawer_key AS key, COUNT(*) AS n, SUM(CASE WHEN conflict_with IS NOT NULL THEN 1 ELSE 0 END) AS c
       FROM memory_file_proposals WHERE user_id = ? AND status = 'pending' GROUP BY drawer_kind, drawer_key`, ownerId);
  const pinnedRows = yield* all<{ kind: string; id: string; n: number }>(
    'SELECT scope_kind AS kind, scope_id AS id, COUNT(*) AS n FROM memory_pinned_facts WHERE owner_id = ? GROUP BY scope_kind, scope_id', ownerId);
  const departments = yield* listDepartmentsStep(ownerId);
  const projects = yield* listProjectsStep(ownerId);
  const agentsTotal = Number((yield* one<{ n: number }>('SELECT COUNT(*) AS n FROM agents_config'))?.n ?? 0);
  const withTemplate = Number((yield* one<{ n: number }>('SELECT COUNT(*) AS n FROM memory_agent_roles WHERE owner_id = ?', ownerId))?.n ?? 0);
  const withExceptions = Number((yield* one<{ n: number }>("SELECT COUNT(DISTINCT agent_id) AS n FROM memory_access_rules WHERE owner_id = ? AND agent_id <> ''", ownerId))?.n ?? 0);

  const byDrawer = new Map<string, ScopeCounts>();
  const counts = (kind: string, key: string) => {
    const id = `${kind}:${key}`;
    let c = byDrawer.get(id);
    if (!c) { c = zero(); byDrawer.set(id, c); }
    return c;
  };
  // Rows saved before drawers have no kind yet (the startup backfill sets it): count them as owner.
  for (const r of drawerRows) { const c = counts(r.kind || 'owner', r.key || ''); c.memories += Number(r.n); if (r.last && (!c.lastMemoryAt || r.last > c.lastMemoryAt)) c.lastMemoryAt = r.last; }
  for (const r of reviewRows) { const c = counts(r.kind, r.key || ''); c.pendingReviews += Number(r.n); c.conflicts += Number(r.c ?? 0); }
  const pinned = new Map(pinnedRows.map((r) => [`${r.kind}:${r.id}`, Number(r.n)]));

  const company = zero();
  const drawers: Record<string, number> = {};
  for (const [id, c] of byDrawer) {
    add(company, c);
    const kind = id.slice(0, id.indexOf(':'));
    drawers[kind] = (drawers[kind] ?? 0) + c.memories;
  }
  company.pinnedFacts = pinned.get('company:') ?? 0;

  const deptOf = new Map(departments.map((d) => [d.id, { ...d, ...zero(), projects: 0, archivedProjects: 0 }]));
  const treeProjects: TreeProject[] = projects.map((p) => {
    const c = { ...(byDrawer.get(`project:${p.slug}`) ?? zero()) };
    c.pinnedFacts = pinned.get(`project:${p.slug}`) ?? 0;
    const d = deptOf.get(p.departmentId) ?? deptOf.get(GENERAL_DEPARTMENT)!;
    if (p.archived) d.archivedProjects++;
    else { d.projects++; add(d, c); }
    return { ...p, departmentId: deptOf.has(p.departmentId) ? p.departmentId : GENERAL_DEPARTMENT, ...c, ...healthOf(c, now) };
  });
  const treeDepartments: TreeDepartment[] = [...deptOf.values()].map((d) => {
    d.pinnedFacts = pinned.get(`department:${d.id}`) ?? 0;
    return { ...d, ...healthOf(d, now) };
  });
  const people = [...byDrawer].filter(([id]) => id.startsWith('people:')).map(([id, c]) => ({ key: id.slice('people:'.length), ...c, ...healthOf(c, now) }))
    .sort((a, b) => b.memories - a.memories || a.key.localeCompare(b.key));
  return {
    generatedAt: new Date(now).toISOString(),
    cached: false,
    company: {
      ...company, ...healthOf(company, now), drawers,
      departments: departments.length, projects: projects.filter((p) => !p.archived).length, archivedProjects: projects.filter((p) => p.archived).length,
    },
    departments: treeDepartments,
    projects: treeProjects,
    people,
    agents: { total: agentsTotal, withTemplate, withExceptions },
  };
}

const treeCache = new Map<string, { at: number; tree: ScopeTree }>();

/** The owner's scope tree (cached for SCOPE_TREE_TTL_MS; `fresh` rebuilds it). */
export async function scopeTree(ownerId: string, opts: { fresh?: boolean; now?: number } = {}): Promise<ScopeTree> {
  const now = opts.now ?? Date.now();
  const hit = treeCache.get(ownerId);
  if (!opts.fresh && hit && now - hit.at < SCOPE_TREE_TTL_MS) return { ...hit.tree, cached: true };
  const tree = await sql().read(buildTreeStep(ownerId, now));
  treeCache.set(ownerId, { at: now, tree });
  return tree;
}

export function invalidateScopeTree(ownerId?: string): void {
  if (ownerId) treeCache.delete(ownerId); else treeCache.clear();
}

// ---------------------------------------------------------------------------
// Search scopes by name
// ---------------------------------------------------------------------------

export const SCOPE_SEARCH_KINDS = ['department', 'project', 'people', 'agent'] as const;
export type ScopeSearchKind = (typeof SCOPE_SEARCH_KINDS)[number];
export interface ScopeHit { kind: ScopeSearchKind; id: string; name: string; departmentId?: string; archived?: boolean; memories?: number }

const escLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function searchScopes(ownerId: string, qInput: unknown, kindsInput?: unknown, limitInput?: unknown): Promise<ScopeHit[]> {
  const q = typeof qInput === 'string' ? qInput.trim().toLowerCase().slice(0, 80) : '';
  if (!q) throw new ScopeInputError('q is required');
  const kinds = typeof kindsInput === 'string' && kindsInput
    ? kindsInput.split(',').map((s) => s.trim()).filter((k): k is ScopeSearchKind => (SCOPE_SEARCH_KINDS as readonly string[]).includes(k))
    : [...SCOPE_SEARCH_KINDS];
  const limit = Math.min(Math.max(Number(limitInput) || 50, 1), 200);
  const tree = await scopeTree(ownerId);
  const hits: ScopeHit[] = [];
  const has = (s: string) => s.toLowerCase().includes(q);
  if (kinds.includes('department')) for (const d of tree.departments) if (has(d.name)) hits.push({ kind: 'department', id: d.id, name: d.name, memories: d.memories });
  if (kinds.includes('project')) for (const p of tree.projects) if (has(p.name) || has(p.slug)) hits.push({ kind: 'project', id: p.slug, name: p.name, departmentId: p.departmentId, archived: p.archived, memories: p.memories });
  if (kinds.includes('people')) for (const p of tree.people) if (has(p.key)) hits.push({ kind: 'people', id: p.key, name: p.key, memories: p.memories });
  if (kinds.includes('agent') && hits.length < limit) {
    const d = await sql().read(dialect());
    const rows = await sql().read(all<{ id: string; name: string }>(
      `SELECT id, name FROM agents_config WHERE name ${likeCi(d)} ? ESCAPE '\\' OR id ${likeCi(d)} ? ESCAPE '\\' ORDER BY name, id LIMIT ?`,
      `%${escLike(q)}%`, `%${escLike(q)}%`, limit));
    for (const r of rows) hits.push({ kind: 'agent', id: r.id, name: r.name });
  }
  return hits.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Agents as scopes (paged: up to thousands)
// ---------------------------------------------------------------------------

const encodeCursor = (parts: string[]) => Buffer.from(JSON.stringify(parts)).toString('base64url');
function decodeCursor(value: unknown, n: number): string[] | null {
  if (value === undefined || value === null || value === '') return null;
  try {
    const v = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'string')) return v;
  } catch { /* invalid */ }
  throw new ScopeInputError('Invalid cursor');
}

export async function listAgentScopes(ownerId: string, opts: { q?: unknown; cursor?: unknown; limit?: unknown }) {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const after = decodeCursor(opts.cursor, 2);
  const q = typeof opts.q === 'string' ? opts.q.trim().slice(0, 80) : '';
  return sql().read((function* () {
    const d = yield* dialect();
    const where: string[] = [];
    const params: Array<string | number> = [ownerId, ownerId];
    if (q) { where.push(`(a.name ${likeCi(d)} ? ESCAPE '\\' OR a.id ${likeCi(d)} ? ESCAPE '\\')`); params.push(`%${escLike(q)}%`, `%${escLike(q)}%`); }
    if (after) { where.push('(a.name > ? OR (a.name = ? AND a.id > ?))'); params.push(after[0], after[0], after[1]); }
    params.push(limit + 1);
    const rows = yield* all<{ id: string; name: string; department: string | null; template_id: string | null; template_name: string | null; exceptions: number }>(`
      SELECT a.id, a.name, a.department, r.template_id, t.name AS template_name,
             (SELECT COUNT(*) FROM memory_access_rules x WHERE x.owner_id = ? AND x.agent_id = a.id) AS exceptions
        FROM agents_config a
        LEFT JOIN memory_agent_roles r ON r.agent_id = a.id AND r.owner_id = ?
        LEFT JOIN memory_role_templates t ON t.id = r.template_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.name, a.id LIMIT ?`, ...params);
    const page = rows.slice(0, limit);
    return {
      agents: page.map((r) => ({ id: r.id, name: r.name, department: r.department ?? null, template: r.template_id ? { id: r.template_id, name: r.template_name ?? r.template_id } : null, exceptions: Number(r.exceptions) })),
      nextCursor: rows.length > limit ? encodeCursor([page[page.length - 1].name, page[page.length - 1].id]) : null,
    };
  })());
}

// ---------------------------------------------------------------------------
// Explorer: memories of one scope, filtered and paged on the server
// ---------------------------------------------------------------------------

export interface ExplorerItem { id: string; type: string; preview: string; drawerId: string; topicKey: string | null; importance: number; layer: string; createdAt: string; sourceAgentId: string | null }
export interface ExplorerPage { scope: string; items: ExplorerItem[]; nextCursor: string | null; total: number; facets: { type: Record<string, number>; layer: Record<string, number>; drawer: Record<string, number> } }

export const PREVIEW_CHARS = 280;
const TYPE = /^[a-z][a-z_-]{0,31}$/;

/** SQL condition (on `memories`) for a scope id; throws ScopeInputError. */
function* scopeCondition(ownerId: string, scope: string): Step<{ sql: string; params: string[] }> {
  if (scope === 'company') return { sql: '1 = 1', params: [] };
  const i = scope.indexOf(':');
  const kind = i < 0 ? scope : scope.slice(0, i);
  const id = i < 0 ? '' : scope.slice(i + 1);
  if (kind === 'department') {
    if (!(yield* departmentStep(ownerId, id))) throw new ScopeInputError('Department not found', 404, 'not_found');
    return id === GENERAL_DEPARTMENT
      ? { sql: "drawer_kind = 'project' AND drawer_key NOT IN (SELECT slug FROM memory_project_scopes WHERE owner_id = ? AND department_id IS NOT NULL)", params: [ownerId] }
      : { sql: "drawer_kind = 'project' AND drawer_key IN (SELECT slug FROM memory_project_scopes WHERE owner_id = ? AND department_id = ?)", params: [ownerId, id] };
  }
  if (kind === 'agent') {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new ScopeInputError('Invalid agent');
    return { sql: 'source_agent_id = ?', params: [id] };
  }
  try {
    const d = parseDrawerId(scope);
    return { sql: 'drawer_kind = ? AND drawer_key = ?', params: [d.kind, d.key || ''] };
  } catch (err) {
    if (err instanceof DrawerInputError) throw new ScopeInputError('Invalid scope');
    throw err;
  }
}

export async function exploreScope(ownerId: string, input: { scope?: unknown; q?: unknown; type?: unknown; layer?: unknown; topic?: unknown; cursor?: unknown; limit?: unknown }): Promise<ExplorerPage> {
  const scope = typeof input.scope === 'string' && input.scope ? input.scope : 'company';
  if (scope.length > 200) throw new ScopeInputError('Invalid scope');
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 200);
  const q = typeof input.q === 'string' ? input.q.trim().slice(0, 200) : '';
  const type = input.type === undefined || input.type === '' ? null : input.type;
  if (type !== null && (typeof type !== 'string' || !TYPE.test(type))) throw new ScopeInputError('Invalid type');
  const layer = input.layer === undefined || input.layer === '' ? null : input.layer;
  if (layer !== null && (typeof layer !== 'string' || !TYPE.test(layer))) throw new ScopeInputError('Invalid layer');
  const topic = input.topic === undefined || input.topic === '' ? null : input.topic;
  if (topic !== null && topic !== 'has' && topic !== 'none') throw new ScopeInputError('topic must be has or none');
  const after = decodeCursor(input.cursor, 2);
  return sql().read((function* () {
    const d = yield* dialect();
    const cond = yield* scopeCondition(ownerId, scope);
    // Base: owner + scope + text search (facets count over this).
    const base = [`user_id = ?`, `(${cond.sql})`];
    const baseParams: Array<string | number> = [ownerId, ...cond.params];
    if (q) { base.push(`content ${likeCi(d)} ? ESCAPE '\\'`); baseParams.push(`%${escLike(q)}%`); }
    const filters = [...base];
    const filterParams = [...baseParams];
    if (type) { filters.push('type = ?'); filterParams.push(type); }
    if (layer) { filters.push("COALESCE(memory_layer, 'factual') = ?"); filterParams.push(layer); }
    if (topic === 'has') filters.push('topic_key IS NOT NULL');
    if (topic === 'none') filters.push('topic_key IS NULL');
    const total = Number((yield* one<{ n: number }>(`SELECT COUNT(*) AS n FROM memories WHERE ${filters.join(' AND ')}`, ...filterParams))?.n ?? 0);
    const page = [...filters];
    const pageParams = [...filterParams];
    if (after) { page.push('(created_at < ? OR (created_at = ? AND id < ?))'); pageParams.push(after[0], after[0], after[1]); }
    const rows = yield* all<{ id: string; type: string; content: string; drawer_kind: string | null; drawer_key: string | null; topic_key: string | null; importance_score: number | null; memory_layer: string | null; created_at: string; source_agent_id: string | null }>(
      `SELECT id, type, content, drawer_kind, drawer_key, topic_key, importance_score, memory_layer, created_at, source_agent_id
         FROM memories WHERE ${page.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, ...pageParams, limit + 1);
    const facet = function* (col: string) {
      const r = yield* all<{ v: string | null; n: number }>(`SELECT ${col} AS v, COUNT(*) AS n FROM memories WHERE ${base.join(' AND ')} GROUP BY ${col} ORDER BY n DESC LIMIT 50`, ...baseParams);
      return Object.fromEntries(r.map((x) => [x.v ?? '', Number(x.n)]));
    };
    const type_ = yield* facet('type');
    const layer_ = yield* facet("COALESCE(memory_layer, 'factual')");
    const drawerRows = yield* all<{ k: string | null; key: string | null; n: number }>(
      `SELECT drawer_kind AS k, drawer_key AS key, COUNT(*) AS n FROM memories WHERE ${base.join(' AND ')} GROUP BY drawer_kind, drawer_key ORDER BY n DESC LIMIT 50`, ...baseParams);
    const items = rows.slice(0, limit).map((r): ExplorerItem => ({
      id: r.id, type: r.type, preview: r.content.length > PREVIEW_CHARS ? `${r.content.slice(0, PREVIEW_CHARS)}…` : r.content,
      drawerId: drawerIdOf(r.drawer_kind, r.drawer_key), topicKey: r.topic_key, importance: Math.round((r.importance_score ?? 0.5) * 10),
      layer: r.memory_layer ?? 'factual', createdAt: r.created_at, sourceAgentId: r.source_agent_id ?? null,
    }));
    const last = items[items.length - 1];
    return {
      scope, items, total,
      nextCursor: rows.length > limit && last ? encodeCursor([last.createdAt, last.id]) : null,
      facets: { type: type_, layer: layer_, drawer: Object.fromEntries(drawerRows.map((r) => [drawerIdOf(r.k, r.key), Number(r.n)])) },
    };
  })());
}

function drawerIdOf(kind: string | null, key: string | null): string {
  const k = (kind || 'owner') as DrawerKind;
  return key && isValidDrawerKey(k, key) ? drawerId({ kind: k, key }) : k;
}
