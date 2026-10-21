/**
 * Knowledge-graph clusters -> automatic topics (CORE-MEM-GRAPH, MEM-GRAPH-CLUSTER).
 *
 * A cluster is a group of entities the graph keeps seeing together inside one
 * drawer: named in the same memories, or joined by an active link learned
 * from a memory of that drawer. The owner entity and, in a project drawer,
 * the drawer's own project (every memory there names it) are left out: they
 * would join everything. A cluster with at least two entities and two memories is a
 * topic suggestion; the map never gets more than MAX_CLUSTER_NODES entities.
 *
 * Nothing changes without the owner:
 *   preview   read only: which memory would get the topic key (the newest
 *             memory of the cluster without one: a topic keeps one current
 *             answer, saving the topic again updates it with history), which
 *             keep their own key (a key is never renamed), and whether the key
 *             is already used in the drawer (then nothing can be applied)
 *   apply     the owner's confirm with the preview's hash; a versioned topic-key
 *             change of that one memory (409 when anything changed since)
 *   dismiss   "not a topic": not suggested again until its members change
 *
 * Every read is limited to a GraphScope (the owner's drawers or the drawers
 * open for an agent run); archived projects are left out (scopedMemoryIds).
 */

import { createHash } from 'node:crypto';
import { all, run, sql, tableExists } from '../../repositories/sql-steps.js';
import { drawerId, DRAWER_KEY_SQL, DRAWER_KIND_SQL, type DrawerRef } from '../drawers.js';
import { getMemoryStorage } from '../storage.js';
import { setTopicKeyVersioned } from '../learning.js';
import { normalizeTopicKey, suggestTopicKey, TopicKeyError } from '../topic-key.js';
import { OWNER_ENTITY } from './extract.js';
import { scopedMemoryIds, type GraphScope } from './recall.js';
import { graphTablesExist } from './store.js';
import { normalizeName } from './types.js';

export const MAX_CLUSTER_NODES = 150;
const PREVIEW = 160;

export class ClusterError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400, readonly code = 'invalid_request') { super(message); }
}

export interface GraphCluster {
  id: string;
  drawer: string;
  /** The entity with the most memories: the suggested topic name. */
  name: string;
  suggestedTopicKey: string | null;
  entities: Array<{ id: string; name: string; kind: string; memories: number }>;
  memoryIds: string[];
}

export interface TopicPreview {
  cluster: GraphCluster;
  topicKey: string;
  /** The memory that gets the key, or null (nothing to change). */
  target: { memoryId: string; preview: string } | null;
  /** Cluster memories that already have a key: kept as they are, never renamed. */
  keepKey: Array<{ memoryId: string; topicKey: string }>;
  /** Other cluster memories (history of the topic), unchanged. */
  related: string[];
  /** Why nothing can be applied, else null. */
  blocked: { code: 'key_taken' | 'already_topic' | 'nothing_to_change'; memoryId?: string } | null;
  previewHash: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const oneLine = (s: string) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > PREVIEW ? `${t.slice(0, PREVIEW - 1)}…` : t; };

interface MemRow { id: string; dk: string; dkey: string; topic_key: string | null; content: string; created_at: string }

/** The entity of a project drawer's own project (the extractor attaches it to every memory there). */
function isDrawerProject(e: { norm_name: string; aliases: string }, key: string): boolean {
  const k = normalizeName(key.replace(/[-_]+/g, ' '));
  if (!k) return false;
  let aliases: unknown = [];
  try { aliases = JSON.parse(e.aliases || '[]'); } catch { aliases = []; }
  return e.norm_name === k || (Array.isArray(aliases) && (aliases.includes(k) || aliases.includes(normalizeName(key))));
}

let dismissReady: boolean | null = null;
async function dismissTable(): Promise<boolean> {
  if (dismissReady) return true;
  dismissReady = await sql().read(tableExists('memory_graph_cluster_dismissals')).catch(() => false);
  return dismissReady;
}

/** Drawer id of a memory row. */
const rowDrawer = (r: MemRow): string => drawerId(r.dkey ? { kind: r.dk as DrawerRef['kind'], key: r.dkey } : { kind: r.dk as DrawerRef['kind'] });

async function scopeMemories(scope: GraphScope): Promise<MemRow[]> {
  const inScope = scopedMemoryIds(scope);
  return sql().read(all<MemRow>(`
    SELECT id, ${DRAWER_KIND_SQL} AS dk, ${DRAWER_KEY_SQL} AS dkey, topic_key, content, created_at FROM memories
     WHERE id IN (${inScope.sql}) AND COALESCE(status, 'active') = 'active'`, ...inScope.params));
}

/** Topic suggestions in scope, biggest first. `includeDismissed` for preview/apply of a known id. */
export async function graphClusters(scope: GraphScope, opts: { limit?: number; includeDismissed?: boolean } = {}): Promise<GraphCluster[]> {
  if (!(await graphTablesExist())) return [];
  if (scope.drawers && scope.drawers.length === 0) return [];
  const mems = await scopeMemories(scope);
  if (!mems.length) return [];
  const byId = new Map(mems.map((m) => [m.id, m]));
  const inScope = scopedMemoryIds(scope);
  const owner = normalizeName(OWNER_ENTITY);
  const allMentions = await sql().read(all<{ memory_id: string; entity_id: string; name: string; kind: string; norm_name: string; aliases: string }>(`
    SELECT m.memory_id, e.id AS entity_id, e.name, e.kind, e.norm_name, e.aliases FROM memory_graph_mentions m JOIN memory_graph_entities e ON e.id = m.entity_id
     WHERE m.user_id = ? AND e.user_id = ? AND e.norm_name <> ? AND m.memory_id IN (${inScope.sql})`, scope.userId, scope.userId, owner, ...inScope.params));
  const mentions = allMentions.filter((m) => {
    const mem = byId.get(m.memory_id);
    return !(mem && mem.dk === 'project' && m.kind === 'project' && isDrawerProject(m, mem.dkey));
  });
  const links = await sql().read(all<{ memory_id: string; src_id: string; dst_id: string }>(`
    SELECT s.memory_id, l.src_id, l.dst_id FROM memory_graph_links l JOIN memory_graph_link_sources s ON s.link_id = l.id
     WHERE l.user_id = ? AND l.status = 'active' AND s.memory_id IN (${inScope.sql})`, scope.userId, ...inScope.params));

  // Union-find per drawer: key = drawer + entity.
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; let c = x; while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; } return r; };
  const add = (x: string) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a: string, b: string) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  const entity = new Map<string, { name: string; kind: string }>();
  const memEntities = new Map<string, Set<string>>();
  for (const m of mentions) {
    const mem = byId.get(m.memory_id);
    if (!mem) continue;
    entity.set(m.entity_id, { name: m.name, kind: m.kind });
    const set = memEntities.get(m.memory_id) ?? new Set<string>();
    set.add(m.entity_id);
    memEntities.set(m.memory_id, set);
  }
  for (const [memoryId, ents] of memEntities) {
    const d = rowDrawer(byId.get(memoryId)!);
    const list = [...ents];
    add(`${d}|${list[0]}`);
    for (let i = 1; i < list.length; i++) union(`${d}|${list[0]}`, `${d}|${list[i]}`);
  }
  for (const l of links) {
    const mem = byId.get(l.memory_id);
    if (!mem || !entity.has(l.src_id) || !entity.has(l.dst_id)) continue;
    const d = rowDrawer(mem);
    union(`${d}|${l.src_id}`, `${d}|${l.dst_id}`);
  }
  const groups = new Map<string, { drawer: string; entities: Map<string, Set<string>> }>();
  for (const [memoryId, ents] of memEntities) {
    const d = rowDrawer(byId.get(memoryId)!);
    for (const e of ents) {
      const root = find(`${d}|${e}`);
      const g = groups.get(root) ?? { drawer: d, entities: new Map<string, Set<string>>() };
      const ms = g.entities.get(e) ?? new Set<string>();
      ms.add(memoryId);
      g.entities.set(e, ms);
      groups.set(root, g);
    }
  }
  const dismissed = !opts.includeDismissed && (await dismissTable())
    ? new Set((await sql().read(all<{ cluster_id: string }>('SELECT cluster_id FROM memory_graph_cluster_dismissals WHERE user_id = ?', scope.userId))).map((r) => r.cluster_id))
    : new Set<string>();
  const out: GraphCluster[] = [];
  for (const g of groups.values()) {
    if (g.entities.size < 2) continue;
    const memoryIds = [...new Set([...g.entities.values()].flatMap((s) => [...s]))].sort();
    if (memoryIds.length < 2) continue;
    const ents = [...g.entities.entries()]
      .map(([id, ms]) => ({ id, name: entity.get(id)!.name, kind: entity.get(id)!.kind, memories: ms.size }))
      .sort((a, b) => b.memories - a.memories || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const id = sha(JSON.stringify([g.drawer, ents.map((e) => e.id).sort()])).slice(0, 32);
    if (dismissed.has(id)) continue;
    const suggestedTopicKey = suggestTopicKey(ents[0].name);
    // Already a topic: one of its memories holds the suggested key (also topics made before dismissals were recorded).
    if (!opts.includeDismissed && suggestedTopicKey && memoryIds.some((m) => byId.get(m)?.topic_key === suggestedTopicKey)) continue;
    out.push({ id, drawer: g.drawer, name: ents[0].name, suggestedTopicKey, entities: ents, memoryIds });
  }
  out.sort((a, b) => b.memoryIds.length - a.memoryIds.length || b.entities.length - a.entities.length || a.id.localeCompare(b.id));
  // The map never gets more than MAX_CLUSTER_NODES entities.
  const limited: GraphCluster[] = [];
  let nodes = 0;
  for (const c of out) {
    if (limited.length >= (opts.limit ?? 50)) break;
    if (nodes + c.entities.length > MAX_CLUSTER_NODES) continue;
    nodes += c.entities.length;
    limited.push(c);
  }
  return limited;
}

async function clusterById(scope: GraphScope, clusterId: unknown): Promise<GraphCluster> {
  if (typeof clusterId !== 'string' || !/^[0-9a-f]{32}$/.test(clusterId)) throw new ClusterError('Cluster not found', 404, 'not_found');
  const c = (await graphClusters(scope, { includeDismissed: true, limit: 1000 })).find((x) => x.id === clusterId);
  if (!c) throw new ClusterError('Cluster not found', 404, 'not_found');
  return c;
}

/** Read only: what making the cluster a topic would do. Changes nothing. */
export async function topicPreview(scope: GraphScope, clusterId: unknown, topicKeyInput?: unknown): Promise<TopicPreview> {
  const cluster = await clusterById(scope, clusterId);
  let topicKey: string | null;
  try { topicKey = topicKeyInput === undefined || topicKeyInput === null || topicKeyInput === '' ? cluster.suggestedTopicKey : normalizeTopicKey(topicKeyInput); } catch (err) {
    if (err instanceof TopicKeyError) throw new ClusterError('Invalid topic key');
    throw err;
  }
  if (!topicKey) throw new ClusterError('Give the topic a key (letters or digits)');
  const rows = await sql().read(all<MemRow>(`
    SELECT id, ${DRAWER_KIND_SQL} AS dk, ${DRAWER_KEY_SQL} AS dkey, topic_key, content, created_at FROM memories
     WHERE user_id = ? AND id IN (${cluster.memoryIds.map(() => '?').join(', ')}) ORDER BY created_at DESC, id DESC`, scope.userId, ...cluster.memoryIds));
  const keepKey = rows.filter((r) => r.topic_key).map((r) => ({ memoryId: r.id, topicKey: r.topic_key! }));
  const free = rows.filter((r) => !r.topic_key);
  const holder = await sql().read(all<{ id: string }>(`
    SELECT id FROM memories WHERE user_id = ? AND topic_key = ? AND ${DRAWER_KIND_SQL} = ? AND ${DRAWER_KEY_SQL} = ?`,
    scope.userId, topicKey, cluster.drawer.split(':')[0], cluster.drawer.includes(':') ? cluster.drawer.slice(cluster.drawer.indexOf(':') + 1) : ''));
  let blocked: TopicPreview['blocked'] = null;
  if (holder.length) blocked = cluster.memoryIds.includes(holder[0].id) ? { code: 'already_topic', memoryId: holder[0].id } : { code: 'key_taken', memoryId: holder[0].id };
  else if (!free.length) blocked = { code: 'nothing_to_change' };
  const target = !blocked && free[0] ? { memoryId: free[0].id, preview: oneLine(free[0].content) } : null;
  const related = rows.filter((r) => r.id !== target?.memoryId && !r.topic_key).map((r) => r.id);
  const previewHash = sha(JSON.stringify([cluster.id, topicKey, target?.memoryId ?? null, blocked, rows.map((r) => [r.id, r.topic_key, sha(r.content)])]));
  return { cluster, topicKey, target, keepKey, related, blocked, previewHash };
}

/** The owner's confirm: the previewed memory gets the topic key (versioned). */
export async function applyTopic(scope: GraphScope, clusterId: unknown, input: { topicKey?: unknown; expectedPreviewHash?: unknown; confirm?: unknown }, actor: string): Promise<{ topicKey: string; memoryId: string; drawer: string }> {
  if (input?.confirm !== true) throw new ClusterError('Send confirm: true after reviewing the preview', 400, 'confirm_required');
  if (typeof input.expectedPreviewHash !== 'string') throw new ClusterError('expectedPreviewHash is required');
  const p = await topicPreview(scope, clusterId, input.topicKey);
  if (p.previewHash !== input.expectedPreviewHash) throw new ClusterError('The cluster changed since the preview; preview again', 409, 'stale');
  if (p.blocked || !p.target) throw new ClusterError(p.blocked?.code === 'key_taken' ? 'Another memory of this drawer already has that topic key' : 'Nothing to change', 409, p.blocked?.code ?? 'nothing_to_change');
  const memory = await getMemoryStorage().getOwned(scope.userId, p.target.memoryId);
  if (!memory) throw new ClusterError('The cluster changed since the preview; preview again', 409, 'stale');
  await setTopicKeyVersioned(memory, p.topicKey, actor);
  // A group made a topic is not suggested again until its members change (like "not a topic").
  if (await dismissTable()) {
    await sql().read(run(`INSERT INTO memory_graph_cluster_dismissals (user_id, cluster_id, drawer_id, dismissed_by) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id, cluster_id) DO NOTHING`, scope.userId, p.cluster.id, p.cluster.drawer, `topic:${p.topicKey}`.slice(0, 120)));
  }
  return { topicKey: p.topicKey, memoryId: memory.id, drawer: p.cluster.drawer };
}

/** "Not a topic": the cluster is not suggested again until its members change. */
export async function dismissCluster(scope: GraphScope, clusterId: unknown, by: string): Promise<{ id: string; dismissed: true }> {
  const c = await clusterById(scope, clusterId);
  if (!(await dismissTable())) throw new ClusterError('Dismissing needs migration 120', 409, 'not_ready');
  await sql().read(run(`INSERT INTO memory_graph_cluster_dismissals (user_id, cluster_id, drawer_id, dismissed_by) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, cluster_id) DO NOTHING`, scope.userId, c.id, c.drawer, by));
  return { id: c.id, dismissed: true };
}
