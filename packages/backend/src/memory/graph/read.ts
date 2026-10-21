/**
 * Graph reads (CORE-MEM-GRAPH) for the owner's graph view and the
 * memory_graph agent tool: entities, links, one entity with its links and
 * its timeline (attached memories, oldest first).
 *
 * Everything is limited to a GraphScope: the user's own graph, and when
 * drawers are given only what those drawers hold: an entity is listed when a
 * memory in scope names it, a link when a memory in scope taught it, a
 * timeline entry when the memory is in scope. Memory text is returned as a
 * short preview.
 */

import { all, one, sql } from '../../repositories/sql-steps.js';
import { DRAWER_KEY_SQL, DRAWER_KIND_SQL } from '../drawers.js';
import { scopedMemoryIds, type GraphScope } from './recall.js';
import { graphTablesExist } from './store.js';
import { isEntityKind, normalizeName, type LinkStatus } from './types.js';

export interface GraphEntity {
  id: string;
  kind: string;
  name: string;
  aliases: string[];
  memories: number;
  links: number;
  updatedAt: string;
}

export interface GraphLink {
  id: string;
  type: string;
  status: LinkStatus;
  from: { id: string; name: string; kind: string };
  to: { id: string; name: string; kind: string };
  /** Source memories in scope. */
  memoryIds: string[];
  createdAt: string;
}

export interface TimelineEntry {
  memoryId: string;
  createdAt: string;
  drawer: string;
  type: string;
  preview: string;
}

const PREVIEW = 160;
const clampLimit = (n: unknown, d: number, max: number) => {
  const v = typeof n === 'number' ? n : typeof n === 'string' ? parseInt(n, 10) : NaN;
  return Number.isFinite(v) ? Math.max(1, Math.min(max, Math.floor(v))) : d;
};
const aliasesOf = (s: string) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const preview = (s: string) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > PREVIEW ? `${t.slice(0, PREVIEW)}...` : t; };

/** Entities in scope, most attached memories first. `q` filters by name, `kind` by kind. */
export async function listEntities(scope: GraphScope, opts: { q?: unknown; kind?: unknown; limit?: unknown } = {}): Promise<GraphEntity[]> {
  if (!(await graphTablesExist())) return [];
  if (scope.drawers && scope.drawers.length === 0) return [];
  const inScope = scopedMemoryIds(scope);
  const params: Array<string | number> = [scope.userId, ...inScope.params, scope.userId];
  let where = 'e.user_id = ?';
  if (isEntityKind(opts.kind)) { where += ' AND e.kind = ?'; params.push(opts.kind); }
  const rows = await sql().read(all<{ id: string; kind: string; name: string; norm_name: string; aliases: string; updated_at: string; memories: number }>(`
    SELECT e.id, e.kind, e.name, e.norm_name, e.aliases, e.updated_at, COUNT(mm.memory_id) AS memories
      FROM memory_graph_entities e
      JOIN memory_graph_mentions mm ON mm.entity_id = e.id AND mm.user_id = ? AND mm.memory_id IN (${inScope.sql})
     WHERE ${where}
     GROUP BY e.id, e.kind, e.name, e.norm_name, e.aliases, e.updated_at
     ORDER BY COUNT(mm.memory_id) DESC, e.name, e.id`, ...params));
  const q = typeof opts.q === 'string' && opts.q.trim() ? normalizeName(opts.q) : '';
  const filtered = q ? rows.filter((r) => r.norm_name.includes(q) || aliasesOf(r.aliases).some((a: string) => a.includes(q))) : rows;
  const limit = clampLimit(opts.limit, 100, 500);
  const out: GraphEntity[] = [];
  for (const r of filtered.slice(0, limit)) {
    out.push({ id: r.id, kind: r.kind, name: r.name, aliases: aliasesOf(r.aliases), memories: Number(r.memories), links: await linkCount(scope, r.id), updatedAt: r.updated_at });
  }
  return out;
}

async function linkCount(scope: GraphScope, entityId: string): Promise<number> {
  const inScope = scopedMemoryIds(scope);
  const row = await sql().read(one<{ n: number }>(`
    SELECT COUNT(*) AS n FROM memory_graph_links l
     WHERE l.user_id = ? AND l.status = 'active' AND (l.src_id = ? OR l.dst_id = ?)
       AND EXISTS (SELECT 1 FROM memory_graph_link_sources s WHERE s.link_id = l.id AND s.memory_id IN (${inScope.sql}))`,
    scope.userId, entityId, entityId, ...inScope.params));
  return Number(row?.n ?? 0);
}

/** Links in scope (all statuses unless `status`), optionally of one entity. */
export async function listLinks(scope: GraphScope, opts: { status?: unknown; entityId?: string; ids?: readonly string[]; limit?: unknown } = {}): Promise<GraphLink[]> {
  if (!(await graphTablesExist())) return [];
  if (scope.drawers && scope.drawers.length === 0) return [];
  const inScope = scopedMemoryIds(scope);
  let where = 'l.user_id = ?';
  const params: Array<string | number> = [scope.userId];
  if (opts.status === 'active' || opts.status === 'pending' || opts.status === 'rejected') { where += ' AND l.status = ?'; params.push(opts.status); }
  if (opts.entityId) { where += ' AND (l.src_id = ? OR l.dst_id = ?)'; params.push(opts.entityId, opts.entityId); }
  if (opts.ids) {
    if (!opts.ids.length) return [];
    where += ` AND l.id IN (${opts.ids.map(() => '?').join(', ')})`; params.push(...opts.ids);
  }
  const rows = await sql().read(all<any>(`
    SELECT l.id, l.type, l.status, l.created_at, l.src_id, a.name AS src_name, a.kind AS src_kind, l.dst_id, b.name AS dst_name, b.kind AS dst_kind
      FROM memory_graph_links l
      JOIN memory_graph_entities a ON a.id = l.src_id
      JOIN memory_graph_entities b ON b.id = l.dst_id
     WHERE ${where}
     ORDER BY l.created_at DESC, l.id LIMIT ?`, ...params, clampLimit(opts.limit, 200, 1000)));
  const out: GraphLink[] = [];
  for (const r of rows) {
    const sources = await sql().read(all<{ memory_id: string }>(
      `SELECT memory_id FROM memory_graph_link_sources WHERE link_id = ? AND user_id = ? AND memory_id IN (${inScope.sql}) ORDER BY memory_id`,
      r.id, scope.userId, ...inScope.params));
    if (sources.length === 0) continue;
    out.push({
      id: r.id, type: r.type, status: r.status, createdAt: r.created_at,
      from: { id: r.src_id, name: r.src_name, kind: r.src_kind },
      to: { id: r.dst_id, name: r.dst_name, kind: r.dst_kind },
      memoryIds: sources.map((s) => s.memory_id),
    });
  }
  return out;
}

/** Attached memories of an entity in scope, oldest first. */
export async function entityTimeline(scope: GraphScope, entityId: string, limit: unknown = 200): Promise<TimelineEntry[]> {
  const inScope = scopedMemoryIds(scope);
  const rows = await sql().read(all<{ id: string; created_at: string; kind: string; key: string; type: string; content: string }>(`
    SELECT id, created_at, ${DRAWER_KIND_SQL} AS kind, ${DRAWER_KEY_SQL} AS key, type, content FROM memories
     WHERE id IN (SELECT memory_id FROM memory_graph_mentions WHERE entity_id = ? AND user_id = ?)
       AND id IN (${inScope.sql})
     ORDER BY created_at, id LIMIT ?`, entityId, scope.userId, ...inScope.params, clampLimit(limit, 200, 1000)));
  return rows.map((r) => ({ memoryId: r.id, createdAt: r.created_at, drawer: r.key ? `${r.kind}:${r.key}` : r.kind, type: r.type, preview: preview(r.content) }));
}

/** One entity in scope with its links and timeline; null when not visible in scope. */
export async function entityDetail(scope: GraphScope, entityId: string): Promise<{ entity: GraphEntity; links: GraphLink[]; timeline: TimelineEntry[] } | null> {
  if (!(await graphTablesExist()) || typeof entityId !== 'string' || !entityId) return null;
  const row = await sql().read(one<{ id: string; kind: string; name: string; aliases: string; updated_at: string }>(
    'SELECT id, kind, name, aliases, updated_at FROM memory_graph_entities WHERE id = ? AND user_id = ?', entityId, scope.userId));
  if (!row) return null;
  const timeline = await entityTimeline(scope, entityId);
  const links = await listLinks(scope, { entityId });
  if (timeline.length === 0 && links.length === 0) return null;
  return {
    entity: { id: row.id, kind: row.kind, name: row.name, aliases: aliasesOf(row.aliases), memories: timeline.length, links: links.filter((l) => l.status === 'active').length, updatedAt: row.updated_at },
    links,
    timeline,
  };
}

/** Find a visible entity by name (exact normalized name or alias first, then contained). */
export async function findEntity(scope: GraphScope, name: string): Promise<GraphEntity | null> {
  const norm = normalizeName(name);
  if (!norm) return null;
  const all = await listEntities(scope, { limit: 500 });
  return all.find((e) => normalizeName(e.name) === norm || e.aliases.includes(norm))
    ?? all.find((e) => normalizeName(e.name).includes(norm)) ?? null;
}

export interface MemoryEntities {
  memoryId: string;
  /** Entities the memory names (its mentions). */
  entities: Array<{ id: string; kind: string; name: string }>;
  /** Links this memory taught (it is one of their sources). */
  links: GraphLink[];
}

/**
 * The graph entities and links one memory holds (MEM-GAPS-02: memory ->
 * linked entities). Null when the memory is not in scope (another user's,
 * a drawer outside the scope, an archived project).
 */
export async function memoryEntities(scope: GraphScope, memoryId: string): Promise<MemoryEntities | null> {
  if (typeof memoryId !== 'string' || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(memoryId)) return null;
  const inScope = scopedMemoryIds(scope);
  const visible = await sql().read(one<{ id: string }>(`SELECT id FROM memories WHERE id = ? AND id IN (${inScope.sql})`, memoryId, ...inScope.params));
  if (!visible) return null;
  if (!(await graphTablesExist())) return { memoryId, entities: [], links: [] };
  const entities = await sql().read(all<{ id: string; kind: string; name: string }>(`
    SELECT e.id, e.kind, e.name FROM memory_graph_mentions m JOIN memory_graph_entities e ON e.id = m.entity_id AND e.user_id = m.user_id
     WHERE m.memory_id = ? AND m.user_id = ? ORDER BY e.name, e.id LIMIT 50`, memoryId, scope.userId));
  const linkIds = await sql().read(all<{ link_id: string }>('SELECT link_id FROM memory_graph_link_sources WHERE memory_id = ? AND user_id = ? LIMIT 50', memoryId, scope.userId));
  const links = await listLinks(scope, { ids: linkIds.map((r) => r.link_id), limit: 50 });
  return { memoryId, entities, links };
}
