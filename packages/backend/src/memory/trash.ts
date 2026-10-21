/**
 * Memory Trash (MEM-TRASH-01).
 *
 * Delete stays what it was (CORE-05): the memory row goes, the history keeps
 * its text, and since migration 122 the 'delete' row carries a snapshot of the
 * whole memory. The Trash is that state seen from the owner's side:
 *
 *   list      memories whose last version is a 'delete' (no live row, not
 *             forgotten), newest first, with the day they will be forgotten;
 *             plus projects moved to the Trash
 *   restore   the memory comes back with the same id, drawer, text, topic key
 *             (when still free) and metadata, as a 'create' version
 *   empty     forget (CORE-07) the given memories / projects, or everything
 *             in the Trash; the only step that cannot be undone
 *   expiry    a daily memory job forgets what stayed longer than the
 *             company's trashDays (7 | 30 | 90; 0 = never; default 30)
 *
 * Trashed memories are never recalled: there is no live row to search.
 * A project moved to the Trash has every memory deleted (reason
 * `trash:project:<slug>`) and is archived; Restore brings both back.
 * Deletes made by a project merge (conflict reviews) are not listed: the
 * review decides them.
 */

import { all, one, sql } from '../repositories/sql-steps.js';
import { isoUtc } from '../api/timestamps.js';
import { getMemoryStorage, TopicKeyTakenError } from './storage.js';
import { drawerId, normalizeDrawer, type DrawerRef } from './drawers.js';
import { forgetMemory } from './forget.js';
import { deleteVersioned, newMemory } from './learning.js';
import { recordVersionStep, versionEntryOf } from './versions.js';
import { DEFAULT_TRASH_DAYS, scopeRules } from './scopes/rules.js';
import { ScopeInputError, assertProjectSlug, listProjectsStep, projectStep, upsertProjectRowStep } from './scopes/store.js';
import { forgetProjectNow } from './scopes/lifecycle.js';
import { invalidateScopeTree } from './scopes/tree.js';
import { invalidateAccess } from './scopes/access.js';
import type { Memory, MemoryType } from './types.js';

const DAY = 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_.@-]{1,200}$/;
const MAX_TEXT = 2000;
const MAX_ITEMS = 5000;
export const PROJECT_TRASH_REASON = 'trash:project:';

export interface TrashItem {
  id: string;
  text: string;
  type: string | null;
  drawer: string;
  /** Project slug when the memory was in a project drawer. */
  project?: string;
  /** True when it went to the Trash with its whole project. */
  withProject?: boolean;
  deletedAt: string;
  deletedBy: string;
  /** When the expiry job forgets it; null = never (trashDays 0). */
  forgetAt: string | null;
}

export interface TrashProject { slug: string; name: string; trashedAt: string; forgetAt: string | null; memories: number }

interface Row {
  memory_id: string; drawer_kind: string; drawer_key: string; created_at: string; created_by: string; reason: string | null; snapshot: string | null;
  last_content: string | null; last_type: string | null; last_importance: number | null;
}

const ROWS_SQL = `
  SELECT v.memory_id, v.drawer_kind, v.drawer_key, v.created_at, v.created_by, v.reason, v.snapshot,
    (SELECT c.content FROM memory_versions c WHERE c.memory_id = v.memory_id AND c.user_id = v.user_id AND c.content IS NOT NULL ORDER BY c.version DESC LIMIT 1) AS last_content,
    (SELECT c.type FROM memory_versions c WHERE c.memory_id = v.memory_id AND c.user_id = v.user_id AND c.type IS NOT NULL ORDER BY c.version DESC LIMIT 1) AS last_type,
    (SELECT c.importance_score FROM memory_versions c WHERE c.memory_id = v.memory_id AND c.user_id = v.user_id AND c.importance_score IS NOT NULL ORDER BY c.version DESC LIMIT 1) AS last_importance
  FROM memory_versions v
  WHERE v.user_id = ? AND v.change = 'delete'
    AND v.version = (SELECT MAX(x.version) FROM memory_versions x WHERE x.memory_id = v.memory_id AND x.user_id = v.user_id)
    AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = v.memory_id)
    AND (v.reason IS NULL OR v.reason NOT LIKE 'merged from project:%')`;

function parseSnapshot(s: string | null): Record<string, any> {
  if (!s) return {};
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

const forgetAtOf = (at: string, days: number): string | null => (days > 0 ? new Date(Date.parse(at) + days * DAY).toISOString() : null);

function toItem(r: Row, days: number): TrashItem {
  const snap = parseSnapshot(r.snapshot);
  const text = typeof snap.content === 'string' ? snap.content : r.last_content ?? '';
  const deletedAt = isoUtc(r.created_at) ?? r.created_at;
  return {
    id: r.memory_id,
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
    type: typeof snap.type === 'string' ? snap.type : r.last_type,
    drawer: r.drawer_key ? `${r.drawer_kind}:${r.drawer_key}` : r.drawer_kind,
    ...(r.drawer_kind === 'project' && r.drawer_key ? { project: r.drawer_key } : {}),
    ...(r.reason?.startsWith(PROJECT_TRASH_REASON) ? { withProject: true } : {}),
    deletedAt,
    deletedBy: r.created_by,
    forgetAt: forgetAtOf(deletedAt, days),
  };
}

/** The company's Trash keep-days (0 = never forgotten by itself). */
export async function trashDays(ownerId: string): Promise<number> {
  try { return (await scopeRules(ownerId, 'company')).effective.trashDays; } catch { return DEFAULT_TRASH_DAYS; }
}

async function trashRows(ownerId: string, memoryId?: string): Promise<Row[]> {
  return sql().read(all<Row>(`${ROWS_SQL}${memoryId ? ' AND v.memory_id = ?' : ''} ORDER BY v.created_at DESC, v.memory_id LIMIT ?`,
    ownerId, ...(memoryId ? [memoryId] : []), MAX_ITEMS));
}

/** Everything in the owner's Trash. */
export async function listTrash(ownerId: string): Promise<{ items: TrashItem[]; projects: TrashProject[]; trashDays: number }> {
  const days = await trashDays(ownerId);
  const items = (await trashRows(ownerId)).map((r) => toItem(r, days));
  const projects = (await sql().read(listProjectsStep(ownerId))).filter((p) => p.trashedAt).map((p) => {
    const trashedAt = isoUtc(p.trashedAt) ?? p.trashedAt!;
    return { slug: p.slug, name: p.name, trashedAt, forgetAt: forgetAtOf(trashedAt, days), memories: items.filter((i) => i.withProject && i.project === p.slug).length };
  });
  return { items, projects, trashDays: days };
}

export interface RestoreResult { id: string; drawer: string; topicKeyDropped: boolean }

/** Restore one memory from the Trash (same id). 404 when not in the Trash, 409 when it is live. */
export async function restoreMemory(ownerId: string, id: string, actor: string): Promise<RestoreResult> {
  if (typeof id !== 'string' || !ID.test(id)) throw new ScopeInputError('Memory not found', 404, 'not_found');
  const storage = getMemoryStorage();
  if (await storage.getOwned(ownerId, id)) throw new ScopeInputError('The memory is not in the Trash', 409, 'not_in_trash');
  const [row] = await trashRows(ownerId, id);
  if (!row) throw new ScopeInputError('Memory not found', 404, 'not_found');
  const snap = parseSnapshot(row.snapshot);
  const content = typeof snap.content === 'string' ? snap.content : row.last_content;
  const type = (typeof snap.type === 'string' ? snap.type : row.last_type) as MemoryType | null;
  if (!content || !type) throw new ScopeInputError('This memory has no text left to restore', 409, 'nothing_to_restore');
  const drawer: DrawerRef = normalizeDrawer(row.drawer_key ? { kind: row.drawer_kind, key: row.drawer_key } : { kind: row.drawer_kind });
  const score = typeof snap.importanceScore === 'number' ? snap.importanceScore : row.last_importance ?? 0.5;
  const importance = Math.min(10, Math.max(1, Math.round(score * 10)));
  const metadata = snap.metadata && typeof snap.metadata === 'object' ? snap.metadata : {};
  const build = (topicKey: string | null): Memory => {
    const m = newMemory(ownerId, drawer, { type, content, importance }, metadata, topicKey);
    m.id = id;
    m.importanceScore = score;
    if (typeof snap.summary === 'string') m.summary = snap.summary;
    if (Array.isArray(snap.tags)) m.tags = snap.tags.filter((t: unknown) => typeof t === 'string');
    if (typeof snap.memoryLayer === 'string') m.memoryLayer = snap.memoryLayer as Memory['memoryLayer'];
    if (typeof snap.sourceAgentId === 'string') m.sourceAgentId = snap.sourceAgentId;
    const created = typeof snap.createdAt === 'string' ? new Date(snap.createdAt) : null;
    if (created && !Number.isNaN(created.getTime())) m.createdAt = created;
    return m;
  };
  const write = async (m: Memory) => {
    await storage.ensureEmbedding(m);
    await sql().tx(function* () {
      yield* recordVersionStep({ memoryId: id, userId: ownerId, drawer, change: 'create', entry: versionEntryOf(m), actor, reason: 'restored from Trash' });
      yield* storage.writeRowStep(m);
    });
    await storage.writeMarkdownCopy(m).catch(() => undefined);
  };
  const topicKey = typeof snap.topicKey === 'string' && snap.topicKey ? snap.topicKey : null;
  let topicKeyDropped = false;
  try {
    await write(build(topicKey));
  } catch (err) {
    if (!(err instanceof TopicKeyTakenError)) throw err;
    // Another memory of the drawer took the topic meanwhile: restore without it.
    topicKeyDropped = true;
    await write(build(null));
  }
  return { id, drawer: drawerId(drawer), topicKeyDropped };
}

export interface EmptyInput { ids?: unknown; projects?: unknown }

function idList(v: unknown, what: string, check: (s: string) => boolean): string[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > MAX_ITEMS || !v.every((x) => typeof x === 'string' && check(x))) throw new ScopeInputError(`${what} must be a list of ids`);
  return [...new Set(v as string[])];
}

/**
 * Forget what is in the Trash: the given memory ids and project slugs, or
 * everything when neither is given. Ids that are not in the Trash are
 * skipped (a live memory is never forgotten through the Trash).
 */
export async function emptyTrash(ownerId: string, input: EmptyInput, actor: string): Promise<{ forgotten: string[]; projects: string[]; skipped: string[] }> {
  const ids = idList(input.ids, 'ids', (s) => ID.test(s));
  const slugs = idList(input.projects, 'projects', (s) => { try { assertProjectSlug(s); return true; } catch { return false; } });
  const all = ids === null && slugs === null;
  const inTrash = new Set((await trashRows(ownerId)).map((r) => r.memory_id));
  const forgotten: string[] = [];
  const skipped: string[] = [];
  const projects: string[] = [];
  const trashedProjects = (await sql().read(listProjectsStep(ownerId))).filter((p) => p.trashedAt);
  for (const p of trashedProjects) {
    if (!all && !(slugs ?? []).includes(p.slug)) continue;
    await forgetProjectNow(ownerId, p, actor);
    projects.push(p.slug);
  }
  for (const slug of slugs ?? []) if (!projects.includes(slug)) skipped.push(`project:${slug}`);
  const stillInTrash = new Set((await trashRows(ownerId)).map((r) => r.memory_id));
  for (const id of all ? [...stillInTrash] : ids ?? []) {
    // Not in the Trash -> skipped; forgotten with its project just now -> done already.
    if (!stillInTrash.has(id)) { if (!inTrash.has(id)) skipped.push(id); continue; }
    if (await forgetMemory(ownerId, id, actor)) forgotten.push(id);
  }
  return { forgotten, projects, skipped };
}

/** The daily job: forget what stayed in the Trash longer than trashDays. */
export async function expireTrash(ownerId: string, now = Date.now()): Promise<{ trashDays: number; forgotten: number; projects: number }> {
  const days = await trashDays(ownerId);
  if (days <= 0) return { trashDays: days, forgotten: 0, projects: 0 };
  const cutoff = now - days * DAY;
  let projects = 0;
  for (const p of (await sql().read(listProjectsStep(ownerId))).filter((x) => x.trashedAt)) {
    if (Date.parse(isoUtc(p.trashedAt) ?? '') > cutoff) continue;
    await forgetProjectNow(ownerId, p, 'trash-expiry');
    projects++;
  }
  let forgotten = 0;
  for (const r of await trashRows(ownerId)) {
    if (Date.parse(isoUtc(r.created_at) ?? '') > cutoff) continue;
    if (await forgetMemory(ownerId, r.memory_id, 'trash-expiry')) forgotten++;
  }
  return { trashDays: days, forgotten, projects };
}

/** Move a whole project to the Trash: its memories are deleted (restorable) and it is archived. */
export async function trashProject(ownerId: string, slug: string, by: string): Promise<{ project: string; memories: number; trashedAt: string }> {
  assertProjectSlug(slug);
  const project = await sql().read(projectStep(ownerId, slug));
  if (!project) throw new ScopeInputError('Project not found', 404, 'not_found');
  if (project.trashedAt) throw new ScopeInputError('The project is already in the Trash', 409, 'no_change');
  const trashedAt = new Date().toISOString();
  const drawer: DrawerRef = { kind: 'project', key: slug };
  let memories = 0;
  for (const m of await getMemoryStorage().getByDrawers(ownerId, [drawer])) {
    if (await deleteVersioned(ownerId, m.id, by, `${PROJECT_TRASH_REASON}${slug}`)) memories++;
  }
  await sql().tx(() => upsertProjectRowStep(ownerId, slug, { trashed_at: trashedAt, archived_at: project.archivedAt ?? trashedAt, pinned: 0 }, by), { immediate: true });
  invalidateScopeTree(ownerId);
  invalidateAccess(ownerId);
  return { project: slug, memories, trashedAt };
}

/** Bring a project back from the Trash with the memories that went with it. */
export async function restoreProject(ownerId: string, slug: string, by: string): Promise<{ project: string; restored: number }> {
  assertProjectSlug(slug);
  const row = await sql().read(one<{ trashed_at: string | null; archived_at: string | null }>('SELECT trashed_at, archived_at FROM memory_project_scopes WHERE owner_id = ? AND slug = ?', ownerId, slug));
  if (!row) throw new ScopeInputError('Project not found', 404, 'not_found');
  if (!row.trashed_at) throw new ScopeInputError('The project is not in the Trash', 409, 'not_in_trash');
  let restored = 0;
  for (const r of await trashRows(ownerId)) {
    if (r.drawer_kind !== 'project' || r.drawer_key !== slug || r.reason !== `${PROJECT_TRASH_REASON}${slug}`) continue;
    await restoreMemory(ownerId, r.memory_id, by);
    restored++;
  }
  // Archived by the move to the Trash (same time) -> unarchived; archived before -> stays archived.
  const unarchive = row.archived_at === row.trashed_at;
  await sql().tx(() => upsertProjectRowStep(ownerId, slug, unarchive ? { trashed_at: null, archived_at: null } : { trashed_at: null }, by), { immediate: true });
  invalidateScopeTree(ownerId);
  invalidateAccess(ownerId);
  return { project: slug, restored };
}
