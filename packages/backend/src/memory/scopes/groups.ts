/**
 * Groups of projects (MEM-UX-02): a client or a team that holds several
 * projects. A project is in at most one group. Owner only.
 *
 * shareWithin = true: a turn that opens one project of the group also opens
 * the group's other projects (withGroupDrawers), so an agent working on one
 * of a client's projects reads what was learned on the others. Archived and
 * trashed projects are never opened this way. The agent's own permissions
 * and the access rules still apply (they work per drawer kind), and every
 * widening is written to the audit log by the caller.
 */

import { randomUUID } from 'node:crypto';
import { all, one, run, sql, type Step } from '../../repositories/sql-steps.js';
import type { DrawerRef } from '../drawers.js';
import { ScopeInputError, assertProjectSlug, cleanName, normName, projectStep } from './store.js';
import { bumpAccessVersionStep, invalidateAccess } from './access.js';
import { invalidateScopeTree } from './tree.js';

export const MAX_GROUPS = 200;
export const MAX_GROUP_PROJECTS = 500;
const GROUP_ID = /^grp-[a-f0-9]{12}$/;

export interface ProjectGroup { id: string; name: string; label: string | null; shareWithin: boolean; projects: string[]; createdAt: string; updatedAt: string }

interface GroupRow { id: string; name: string; label: string | null; share_within: number; created_at: string; updated_at: string }

function cleanLabel(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new ScopeInputError('label must be text');
  // eslint-disable-next-line no-control-regex
  const label = v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 40);
  return label || null;
}

function shareOf(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new ScopeInputError('shareWithin must be true or false');
  return v;
}

function* groupsStep(ownerId: string): Step<ProjectGroup[]> {
  const rows = yield* all<GroupRow>('SELECT id, name, label, share_within, created_at, updated_at FROM memory_project_groups WHERE owner_id = ? ORDER BY norm_name, id', ownerId);
  const members = yield* all<{ slug: string; group_id: string }>('SELECT slug, group_id FROM memory_project_group_members WHERE owner_id = ? ORDER BY slug', ownerId);
  return rows.map((r) => ({
    id: r.id, name: r.name, label: r.label, shareWithin: Number(r.share_within) === 1,
    projects: members.filter((m) => m.group_id === r.id).map((m) => m.slug), createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

function* groupStep(ownerId: string, id: string): Step<ProjectGroup> {
  if (typeof id !== 'string' || !GROUP_ID.test(id)) throw new ScopeInputError('Group not found', 404, 'not_found');
  const g = (yield* groupsStep(ownerId)).find((x) => x.id === id);
  if (!g) throw new ScopeInputError('Group not found', 404, 'not_found');
  return g;
}

export function listGroups(ownerId: string): Promise<ProjectGroup[]> {
  return sql().read(groupsStep(ownerId));
}

function* nameFreeStep(ownerId: string, name: string, except?: string): Step<void> {
  const taken = yield* one<{ id: string }>('SELECT id FROM memory_project_groups WHERE owner_id = ? AND norm_name = ?', ownerId, normName(name));
  if (taken && taken.id !== except) throw new ScopeInputError('A group with that name already exists', 409, 'name_taken');
}

function* setProjectsStep(ownerId: string, id: string, input: unknown): Step<string[]> {
  if (!Array.isArray(input) || input.length > MAX_GROUP_PROJECTS) throw new ScopeInputError(`projects must be a list of at most ${MAX_GROUP_PROJECTS} projects`);
  const slugs = [...new Set(input)];
  for (const s of slugs) {
    assertProjectSlug(s);
    if (!(yield* projectStep(ownerId, s))) throw new ScopeInputError(`Project not found: ${String(s).slice(0, 80)}`, 404, 'not_found');
  }
  yield* run('DELETE FROM memory_project_group_members WHERE owner_id = ? AND group_id = ?', ownerId, id);
  for (const s of slugs as string[]) {
    // At most one group: a project dropped here leaves its old group.
    yield* run('DELETE FROM memory_project_group_members WHERE owner_id = ? AND slug = ?', ownerId, s);
    yield* run('INSERT INTO memory_project_group_members (owner_id, slug, group_id, added_at) VALUES (?, ?, ?, ?)', ownerId, s, id, new Date().toISOString());
  }
  return slugs as string[];
}

/** Create a group; `projects` (optional) join it at once. */
export async function createGroup(ownerId: string, body: Record<string, unknown>, by: string): Promise<ProjectGroup> {
  const name = cleanName(body.name, 'group');
  const label = cleanLabel(body.label);
  const share = body.shareWithin === undefined ? false : shareOf(body.shareWithin);
  const out = await sql().tx(function* () {
    yield* nameFreeStep(ownerId, name);
    const n = Number((yield* one<{ n: number }>('SELECT COUNT(*) AS n FROM memory_project_groups WHERE owner_id = ?', ownerId))?.n ?? 0);
    if (n >= MAX_GROUPS) throw new ScopeInputError('Too many groups', 409, 'too_many');
    const id = `grp-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date().toISOString();
    yield* run('INSERT INTO memory_project_groups (id, owner_id, name, norm_name, label, share_within, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, ownerId, name, normName(name), label, share ? 1 : 0, by, now, now);
    if (body.projects !== undefined) yield* setProjectsStep(ownerId, id, body.projects);
    if (share) yield* bumpAccessVersionStep(ownerId);
    return yield* groupStep(ownerId, id);
  }, { immediate: true });
  invalidateScopeTree(ownerId);
  return out;
}

/** Rename, relabel or switch shareWithin. */
export async function updateGroup(ownerId: string, id: string, body: Record<string, unknown>): Promise<ProjectGroup> {
  const unknown = Object.keys(body).find((k) => !['name', 'label', 'shareWithin'].includes(k));
  if (unknown) throw new ScopeInputError(`Unknown field "${unknown.slice(0, 40)}"`);
  if (!Object.keys(body).length) throw new ScopeInputError('Nothing to change', 409, 'no_change');
  const out = await sql().tx(function* () {
    const g = yield* groupStep(ownerId, id);
    const name = body.name === undefined ? g.name : cleanName(body.name, 'group');
    if (body.name !== undefined) yield* nameFreeStep(ownerId, name, id);
    const label = body.label === undefined ? g.label : cleanLabel(body.label);
    const share = body.shareWithin === undefined ? g.shareWithin : shareOf(body.shareWithin);
    yield* run('UPDATE memory_project_groups SET name = ?, norm_name = ?, label = ?, share_within = ?, updated_at = ? WHERE owner_id = ? AND id = ?',
      name, normName(name), label, share ? 1 : 0, new Date().toISOString(), ownerId, id);
    if (share !== g.shareWithin) yield* bumpAccessVersionStep(ownerId);
    return yield* groupStep(ownerId, id);
  }, { immediate: true });
  invalidateScopeTree(ownerId);
  return out;
}

/** Delete a group; its projects stay (they only leave the group). */
export async function deleteGroup(ownerId: string, id: string): Promise<{ id: string; projects: string[] }> {
  const out = await sql().tx(function* () {
    const g = yield* groupStep(ownerId, id);
    yield* run('DELETE FROM memory_project_group_members WHERE owner_id = ? AND group_id = ?', ownerId, id);
    yield* run('DELETE FROM memory_project_groups WHERE owner_id = ? AND id = ?', ownerId, id);
    if (g.shareWithin) yield* bumpAccessVersionStep(ownerId);
    return { id, projects: g.projects };
  }, { immediate: true });
  invalidateScopeTree(ownerId);
  return out;
}

/** Replace the group's projects (a project moves here from any other group). */
export async function setGroupProjects(ownerId: string, id: string, projects: unknown): Promise<ProjectGroup> {
  const out = await sql().tx(function* () {
    yield* groupStep(ownerId, id);
    yield* setProjectsStep(ownerId, id, projects);
    // Any group may have lost a sharing member: the access version moves.
    yield* bumpAccessVersionStep(ownerId);
    return yield* groupStep(ownerId, id);
  }, { immediate: true });
  invalidateScopeTree(ownerId);
  invalidateAccess(ownerId);
  return out;
}

/**
 * The other projects a turn in this project also reads: the members of its
 * group when the group shares within, without archived or trashed projects.
 */
export async function groupSiblings(ownerId: string, slug: string): Promise<{ groupId: string; projects: string[] } | null> {
  const rows = await sql().read(all<{ group_id: string; share_within: number; slug: string; archived_at: string | null; trashed_at: string | null }>(`
    SELECT m.group_id, g.share_within, o.slug, s.archived_at, s.trashed_at
      FROM memory_project_group_members m
      JOIN memory_project_groups g ON g.owner_id = m.owner_id AND g.id = m.group_id
      JOIN memory_project_group_members o ON o.owner_id = m.owner_id AND o.group_id = m.group_id AND o.slug <> m.slug
      LEFT JOIN memory_project_scopes s ON s.owner_id = o.owner_id AND s.slug = o.slug
     WHERE m.owner_id = ? AND m.slug = ? ORDER BY o.slug`, ownerId, slug));
  if (!rows.length || Number(rows[0].share_within) !== 1) return null;
  return { groupId: rows[0].group_id, projects: rows.filter((r) => !r.archived_at && !r.trashed_at).map((r) => r.slug) };
}

/**
 * The turn's drawers plus the project drawers its group shares (fail closed:
 * on any error the drawers come back unchanged). `added` lists the extra
 * drawers so the caller can audit the widening.
 */
export async function withGroupDrawers(ownerId: string | null | undefined, drawers: DrawerRef[], canReadSibling: (project: string) => Promise<boolean> = async () => false): Promise<{ drawers: DrawerRef[]; added: DrawerRef[]; groupId: string | null }> {
  const project = drawers.find((d) => d.kind === 'project' && d.key);
  if (!ownerId || !project) return { drawers, added: [], groupId: null };
  try {
    const sib = await groupSiblings(ownerId, project.key!);
    if (!sib) return { drawers, added: [], groupId: null };
    const added: DrawerRef[] = [];
    for (const key of sib.projects) {
      if (!drawers.some(d => d.kind === 'project' && d.key === key) && await canReadSibling(key)) added.push({kind:'project', key, readOnly:true});
    }
    return { drawers: [...drawers, ...added], added, groupId: sib.groupId };
  } catch {
    return { drawers, added: [], groupId: null };
  }
}
