/**
 * Memory scope tree store (MEM-SCALE-01): company -> department -> project.
 *
 * The company is the owner. A project is one of the owner's project drawers
 * (key = slug); it is known from a chat project, from memories saved in its
 * drawer, or from a stored scope row (migration 105). A project without a
 * department row is in "General" (GENERAL_DEPARTMENT, never stored).
 *
 * Archived projects are kept but never loaded into a reply or recall:
 * `NOT_ARCHIVED_SQL` keeps their memories out of every recall search and
 * `withoutArchivedDrawers` drops their drawer from a turn.
 *
 * Every lookup carries the owner id: a scope is never read across users.
 */

import { randomUUID } from 'node:crypto';
import { all, one, run, sql, type Step } from '../../repositories/sql-steps.js';
import { isValidDrawerKey, type DrawerRef } from '../drawers.js';

export const GENERAL_DEPARTMENT = 'general';
export const GENERAL_NAME = 'General';
export const MAX_DEPARTMENTS = 200;
const DEPARTMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class ScopeInputError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400, readonly code = 'invalid_scope') { super(message); }
}

export interface Department { id: string; name: string; isDefault: boolean }

export interface ProjectScope {
  slug: string;
  name: string;
  departmentId: string;
  pinned: boolean;
  archived: boolean;
  archivedAt: string | null;
  mergedInto: string | null;
  /** chat_projects.id of the owner's chat project with this slug, else null. */
  chatProjectId: string | null;
}

/**
 * SQL condition (on `memories`): the row is not in an archived project
 * drawer of its user. Used by every recall search (storage.search, graph recall).
 */
export const NOT_ARCHIVED_SQL = `NOT EXISTS (SELECT 1 FROM memory_project_scopes ps
  WHERE ps.owner_id = memories.user_id AND memories.drawer_kind = 'project'
    AND ps.slug = memories.drawer_key AND ps.archived_at IS NOT NULL)`;

export const normName = (name: string): string => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export function cleanName(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new ScopeInputError(`Give the ${what} a name`);
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!name) throw new ScopeInputError(`Give the ${what} a name`);
  return name;
}

export function assertProjectSlug(slug: unknown): asserts slug is string {
  if (!isValidDrawerKey('project', slug)) throw new ScopeInputError('Invalid project');
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export function* listDepartmentsStep(ownerId: string): Step<Department[]> {
  const rows = yield* all<{ id: string; name: string }>('SELECT id, name FROM memory_departments WHERE owner_id = ? ORDER BY norm_name, id', ownerId);
  return [{ id: GENERAL_DEPARTMENT, name: GENERAL_NAME, isDefault: true }, ...rows.map((r) => ({ id: r.id, name: r.name, isDefault: false }))];
}

export function* departmentStep(ownerId: string, id: string): Step<Department | null> {
  if (id === GENERAL_DEPARTMENT) return { id, name: GENERAL_NAME, isDefault: true };
  if (typeof id !== 'string' || !DEPARTMENT_ID.test(id)) return null;
  const r = yield* one<{ id: string; name: string }>('SELECT id, name FROM memory_departments WHERE owner_id = ? AND id = ?', ownerId, id);
  return r ? { id: r.id, name: r.name, isDefault: false } : null;
}

export function getDepartment(ownerId: string, id: string): Promise<Department | null> {
  return sql().read(departmentStep(ownerId, id));
}

export async function createDepartment(ownerId: string, nameInput: unknown, by: string): Promise<Department> {
  const name = cleanName(nameInput, 'department');
  return sql().tx(function* () {
    if (normName(name) === normName(GENERAL_NAME)) throw new ScopeInputError('That department already exists', 409, 'name_taken');
    if (yield* one('SELECT 1 AS x FROM memory_departments WHERE owner_id = ? AND norm_name = ?', ownerId, normName(name))) {
      throw new ScopeInputError('That department already exists', 409, 'name_taken');
    }
    const n = (yield* one<{ n: number }>('SELECT COUNT(*) AS n FROM memory_departments WHERE owner_id = ?', ownerId))?.n ?? 0;
    if (Number(n) >= MAX_DEPARTMENTS) throw new ScopeInputError('Too many departments', 409, 'too_many');
    const id = `dept-${randomUUID().slice(0, 12)}`;
    yield* run('INSERT INTO memory_departments (id, owner_id, name, norm_name, created_by) VALUES (?, ?, ?, ?, ?)', id, ownerId, name, normName(name), by);
    return { id, name, isDefault: false };
  }, { immediate: true });
}

export async function renameDepartment(ownerId: string, id: string, nameInput: unknown): Promise<Department> {
  if (id === GENERAL_DEPARTMENT) throw new ScopeInputError('The General department cannot be renamed');
  const name = cleanName(nameInput, 'department');
  return sql().tx(function* () {
    const d = yield* departmentStep(ownerId, id);
    if (!d) throw new ScopeInputError('Department not found', 404, 'not_found');
    const taken = yield* one<{ id: string }>('SELECT id FROM memory_departments WHERE owner_id = ? AND norm_name = ?', ownerId, normName(name));
    if ((taken && taken.id !== id) || normName(name) === normName(GENERAL_NAME)) throw new ScopeInputError('That department already exists', 409, 'name_taken');
    yield* run(`UPDATE memory_departments SET name = ?, norm_name = ?, updated_at = ? WHERE owner_id = ? AND id = ?`, name, normName(name), new Date().toISOString(), ownerId, id);
    return { id, name, isDefault: false };
  }, { immediate: true });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

interface ScopeRow { slug: string; name: string | null; department_id: string | null; pinned: number; archived_at: string | null; merged_into: string | null }

/**
 * Every project of the owner: chat projects, project drawers that hold
 * memories (an indexed DISTINCT) and stored scope rows. Sorted pinned
 * first, then by name.
 */
export function* listProjectsStep(ownerId: string): Step<ProjectScope[]> {
  const chats = yield* all<{ id: string; slug: string; name: string }>('SELECT id, slug, name FROM chat_projects WHERE user_id = ?', ownerId);
  const drawers = yield* all<{ key: string }>("SELECT DISTINCT drawer_key AS key FROM memories WHERE user_id = ? AND drawer_kind = 'project'", ownerId);
  const rows = yield* all<ScopeRow>('SELECT slug, name, department_id, pinned, archived_at, merged_into FROM memory_project_scopes WHERE owner_id = ?', ownerId);
  const bySlug = new Map<string, ProjectScope>();
  const base = (slug: string): ProjectScope => ({ slug, name: slug, departmentId: GENERAL_DEPARTMENT, pinned: false, archived: false, archivedAt: null, mergedInto: null, chatProjectId: null });
  for (const d of drawers) if (d.key && isValidDrawerKey('project', d.key)) bySlug.set(d.key, base(d.key));
  for (const r of rows) {
    const p = bySlug.get(r.slug) ?? base(r.slug);
    if (r.name) p.name = r.name;
    p.departmentId = r.department_id || GENERAL_DEPARTMENT;
    p.pinned = Number(r.pinned) === 1;
    p.archivedAt = r.archived_at;
    p.archived = !!r.archived_at;
    p.mergedInto = r.merged_into;
    bySlug.set(r.slug, p);
  }
  for (const c of chats) {
    const p = bySlug.get(c.slug) ?? base(c.slug);
    p.chatProjectId = c.id;
    p.name = c.name || p.name;
    bySlug.set(c.slug, p);
  }
  return [...bySlug.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
}

export function listProjects(ownerId: string): Promise<ProjectScope[]> {
  return sql().read(listProjectsStep(ownerId));
}

/** One project of the owner, or null when no chat project, memory or scope row knows it. */
export function* projectStep(ownerId: string, slug: string): Step<ProjectScope | null> {
  if (!isValidDrawerKey('project', slug)) return null;
  const chat = yield* one<{ id: string; name: string }>('SELECT id, name FROM chat_projects WHERE user_id = ? AND slug = ?', ownerId, slug);
  const row = yield* one<ScopeRow>('SELECT slug, name, department_id, pinned, archived_at, merged_into FROM memory_project_scopes WHERE owner_id = ? AND slug = ?', ownerId, slug);
  const has = yield* one("SELECT 1 AS x FROM memories WHERE user_id = ? AND drawer_kind = 'project' AND drawer_key = ? LIMIT 1", ownerId, slug);
  if (!chat && !row && !has) return null;
  return {
    slug,
    name: chat?.name || row?.name || slug,
    departmentId: row?.department_id || GENERAL_DEPARTMENT,
    pinned: Number(row?.pinned) === 1,
    archived: !!row?.archived_at,
    archivedAt: row?.archived_at ?? null,
    mergedInto: row?.merged_into ?? null,
    chatProjectId: chat?.id ?? null,
  };
}

export function getProject(ownerId: string, slug: string): Promise<ProjectScope | null> {
  return sql().read(projectStep(ownerId, slug));
}

/** Insert the scope row when missing, then apply `set` (column -> value). */
export function* upsertProjectRowStep(ownerId: string, slug: string, set: Partial<Record<'name' | 'department_id' | 'pinned' | 'archived_at' | 'merged_into', string | number | null>>, by: string): Step<void> {
  yield* run(`INSERT INTO memory_project_scopes (owner_id, slug, updated_by) VALUES (?, ?, ?) ON CONFLICT (owner_id, slug) DO NOTHING`, ownerId, slug, by);
  const cols = Object.keys(set) as Array<keyof typeof set>;
  if (!cols.length) return;
  yield* run(`UPDATE memory_project_scopes SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE owner_id = ? AND slug = ?`,
    ...cols.map((c) => set[c] ?? null), by, new Date().toISOString(), ownerId, slug);
}

// ---------------------------------------------------------------------------
// Archive: never loaded into a reply or recall
// ---------------------------------------------------------------------------

export async function archivedProjects(ownerId: string): Promise<Set<string>> {
  const rows = await sql().read(all<{ slug: string }>('SELECT slug FROM memory_project_scopes WHERE owner_id = ? AND archived_at IS NOT NULL', ownerId));
  return new Set(rows.map((r) => r.slug));
}

/** The drawers without archived project drawers of this user (fail closed: on error every project drawer is dropped). */
export async function withoutArchivedDrawers(ownerId: string | null | undefined, drawers: DrawerRef[]): Promise<DrawerRef[]> {
  if (!ownerId || !drawers.some((d) => d.kind === 'project')) return drawers;
  try {
    const archived = await archivedProjects(ownerId);
    return drawers.filter((d) => d.kind !== 'project' || !archived.has(d.key || ''));
  } catch {
    return drawers.filter((d) => d.kind !== 'project');
  }
}
