/**
 * Memory knowledge graph store (CORE-MEM-GRAPH): writes the graph of one
 * memory, removes it again, prunes orphans, and the owner's link review.
 *
 * Incremental: a saved memory is (re)indexed alone. Its old attachments and
 * link sources are replaced in ONE transaction that first checks the memory
 * row still holds the extracted text (a memory forgotten or edited while the
 * model was thinking is never attached again; the newer save re-indexes it).
 *
 * Orphans: a link with no source memory left, an entity with no memory and
 * no link, and rows of memories whose row is gone (a plain delete keeps
 * history, not graph rows) are removed by `pruneGraphStep`.
 *
 * Important new links (IMPORTANT_LINK_TYPES) learned from a memory the owner
 * has not seen (auto-saved learning, an agent or an outsider turn) start
 * `pending`: recall ignores them until the owner approves. For a non-owner
 * account they are not stored (like important memories, CORE-05). A link the
 * owner rejected stays rejected.
 */

import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { all, dialect, one, run, sql, tableExists, type Step } from '../../repositories/sql-steps.js';
import { nowIsoText } from '../../db/pg/dialect.js';
import type { Memory } from '../types.js';
import { extractGraph } from './extract.js';
import {
  IMPORTANT_LINK_TYPES,
  MAX_ALIASES,
  normalizeName,
  type EntityKind,
  type GraphExtraction,
  type LinkStatus,
  type LinkType,
} from './types.js';

export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

let tablesReady: boolean | null = null;

/** True when migrations 100-102 ran (older test databases may lack them). */
export async function graphTablesExist(): Promise<boolean> {
  if (tablesReady === null) tablesReady = await sql().read(tableExists('memory_graph_state'));
  return tablesReady;
}

/** Sources the owner has seen: written by an account or approved in a proposal. */
function ownerReviewed(memory: Memory): boolean {
  const m = memory.metadata || {};
  if (m.proposalId || m.source === 'owner') return true;
  if (m.learned === 'routine') return false;
  return !['agent', 'extraction', 'outsider', 'learning'].includes(String(m.source || ''));
}

interface EntityRow { id: string; kind: EntityKind; name: string; norm_name: string; aliases: string }

function parseAliases(s: string | null | undefined): string[] {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}

/** Find the entity of a normalized name (its name or an alias), or create it. */
function* upsertEntityStep(userId: string, name: string, kind: EntityKind, aliases: string[], byNorm: Map<string, EntityRow>): Step<EntityRow | null> {
  const norm = normalizeName(name);
  if (!norm) return null;
  const aliasNorms = aliases.map(normalizeName).filter((a) => a && a !== norm);
  let row = byNorm.get(norm) ?? [...byNorm.values()].find((e) => parseAliases(e.aliases).includes(norm))
    ?? aliasNorms.map((a) => byNorm.get(a)).find(Boolean);
  if (!row) {
    row = { id: uuidv4(), kind, name, norm_name: norm, aliases: JSON.stringify(aliasNorms.slice(0, MAX_ALIASES)) };
    yield* run(`INSERT INTO memory_graph_entities (id, user_id, kind, name, norm_name, aliases) VALUES (?, ?, ?, ?, ?, ?)`,
      row.id, userId, row.kind, row.name, row.norm_name, row.aliases);
    byNorm.set(norm, row);
    return row;
  }
  // A more specific kind wins over 'topic'; new spellings become aliases.
  const known = new Set([row.norm_name, ...parseAliases(row.aliases)]);
  const add = [norm, ...aliasNorms].filter((a) => !known.has(a));
  const nextKind = row.kind === 'topic' && kind !== 'topic' ? kind : row.kind;
  if (add.length || nextKind !== row.kind) {
    const d = yield* dialect();
    row.aliases = JSON.stringify([...parseAliases(row.aliases), ...add].slice(0, MAX_ALIASES));
    row.kind = nextKind;
    yield* run(`UPDATE memory_graph_entities SET kind = ?, aliases = ?, updated_at = ${nowIsoText(d)} WHERE id = ? AND user_id = ?`, row.kind, row.aliases, row.id, userId);
  }
  return row;
}

/** Remove one memory's attachments and link sources (no pruning). */
function* detachMemoryStep(userId: string, memoryId: string): Step<void> {
  yield* run('DELETE FROM memory_graph_mentions WHERE memory_id = ? AND user_id = ?', memoryId, userId);
  yield* run('DELETE FROM memory_graph_link_sources WHERE memory_id = ? AND user_id = ?', memoryId, userId);
  yield* run('DELETE FROM memory_graph_state WHERE memory_id = ? AND user_id = ?', memoryId, userId);
}

/**
 * Remove the user's orphans: rows of memories that no longer exist, links
 * without a source memory, entities without a memory and without a link.
 */
export function* pruneGraphStep(userId: string): Step<{ links: number; entities: number }> {
  const gone = `NOT IN (SELECT id FROM memories WHERE user_id = ?)`;
  yield* run(`DELETE FROM memory_graph_mentions WHERE user_id = ? AND memory_id ${gone}`, userId, userId);
  yield* run(`DELETE FROM memory_graph_link_sources WHERE user_id = ? AND memory_id ${gone}`, userId, userId);
  yield* run(`DELETE FROM memory_graph_state WHERE user_id = ? AND memory_id ${gone}`, userId, userId);
  const links = yield* run(`DELETE FROM memory_graph_links WHERE user_id = ? AND id NOT IN (SELECT link_id FROM memory_graph_link_sources WHERE user_id = ?)`, userId, userId);
  const entities = yield* run(`
    DELETE FROM memory_graph_entities WHERE user_id = ?
       AND id NOT IN (SELECT entity_id FROM memory_graph_mentions WHERE user_id = ?)
       AND id NOT IN (SELECT src_id FROM memory_graph_links WHERE user_id = ?)
       AND id NOT IN (SELECT dst_id FROM memory_graph_links WHERE user_id = ?)`, userId, userId, userId, userId);
  return { links: links.changes, entities: entities.changes };
}

/**
 * CORE-07: a forgotten memory leaves no graph row: its attachments, link
 * sources and state go, then the links and entities it alone held up.
 * Joins the forget transaction.
 */
export function* forgetMemoryGraphStep(userId: string, memoryId: string): Step<void> {
  if (!(yield* tableExists('memory_graph_state'))) return;
  yield* detachMemoryStep(userId, memoryId);
  yield* pruneGraphStep(userId);
}

export interface IndexResult {
  status: 'indexed' | 'unchanged' | 'gone';
  method?: GraphExtraction['method'];
  entities?: number;
  links?: number;
  pending?: number;
}

/** Write an extraction as the graph of one memory (one transaction). */
export function* writeMemoryGraphStep(memory: Memory, hash: string, ex: GraphExtraction, owner: boolean): Step<IndexResult> {
  const userId = memory.userId;
  const live = yield* one<{ content: string }>('SELECT content FROM memories WHERE id = ? AND user_id = ?', memory.id, userId);
  if (!live || contentHash(live.content) !== hash) return { status: 'gone' };
  yield* detachMemoryStep(userId, memory.id);

  const existing = yield* all<EntityRow>('SELECT id, kind, name, norm_name, aliases FROM memory_graph_entities WHERE user_id = ?', userId);
  const byNorm = new Map(existing.map((e) => [e.norm_name, e]));
  const ids = new Map<string, string>();
  for (const e of ex.entities) {
    const row = yield* upsertEntityStep(userId, e.name, e.kind, e.aliases || [], byNorm);
    if (!row) continue;
    ids.set(normalizeName(e.name), row.id);
    yield* run(`INSERT INTO memory_graph_mentions (memory_id, entity_id, user_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, memory.id, row.id, userId);
  }

  const reviewed = ownerReviewed(memory);
  let links = 0;
  let pending = 0;
  for (const l of ex.links) {
    const src = ids.get(normalizeName(l.from));
    const dst = ids.get(normalizeName(l.to));
    if (!src || !dst || src === dst) continue;
    const important = IMPORTANT_LINK_TYPES.has(l.type) && !reviewed;
    let link = yield* one<{ id: string; status: LinkStatus }>(
      'SELECT id, status FROM memory_graph_links WHERE user_id = ? AND src_id = ? AND type = ? AND dst_id = ?', userId, src, l.type, dst);
    if (!link) {
      // Like an important memory: a non-owner account's important link is not kept.
      if (important && !owner) continue;
      link = { id: uuidv4(), status: important ? 'pending' : 'active' };
      yield* run('INSERT INTO memory_graph_links (id, user_id, src_id, type, dst_id, status) VALUES (?, ?, ?, ?, ?, ?)',
        link.id, userId, src, l.type, dst, link.status);
    }
    yield* run('INSERT INTO memory_graph_link_sources (link_id, memory_id, user_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', link.id, memory.id, userId);
    links++;
    if (link.status === 'pending') pending++;
  }
  yield* run('INSERT INTO memory_graph_state (memory_id, user_id, content_hash, method) VALUES (?, ?, ?, ?)', memory.id, userId, hash, ex.method);
  yield* pruneGraphStep(userId);
  return { status: 'indexed', method: ex.method, entities: ids.size, links, pending };
}

/** Extract (outside any transaction) and write the graph of one memory. */
export async function indexMemoryGraph(memory: Memory, opts: { force?: boolean } = {}): Promise<IndexResult> {
  if (!(await graphTablesExist())) return { status: 'gone' };
  const hash = contentHash(memory.content);
  if (!opts.force) {
    const state = await sql().read(one<{ content_hash: string }>('SELECT content_hash FROM memory_graph_state WHERE memory_id = ? AND user_id = ?', memory.id, memory.userId));
    if (state?.content_hash === hash) return { status: 'unchanged' };
  }
  const ex = await extractGraph(memory.content, { userId: memory.userId, drawer: memory.drawer });
  const role = await sql().read(one<{ role: string }>('SELECT role FROM users WHERE id = ?', memory.userId));
  const owner = role?.role === 'owner';
  return sql().tx(() => writeMemoryGraphStep(memory, hash, ex, owner));
}

// ---------------------------------------------------------------------------
// Save hook: one queue, so graph writes never race each other
// ---------------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

/**
 * Called once after a memory row is committed (storage.ts, readable copy
 * step). Runs in the background; a failure is logged, never thrown into the
 * save. Credentials and secrets never reach memory rows, so nothing secret
 * is sent to the model here.
 */
export function onMemorySaved(memory: Memory): void {
  if (!memory?.id || !memory.userId || typeof memory.content !== 'string') return;
  const snapshot = { ...memory };
  queue = queue.then(() => indexMemoryGraph(snapshot)).catch((err) => {
    console.warn('[MemoryGraph] indexing failed:', (err as Error).message);
  });
}

/** Resolves when every queued graph update has finished (tests, sync). */
export function graphIdle(): Promise<void> {
  return queue.then(() => undefined, () => undefined);
}

/**
 * Index the user's memories that have no graph yet or changed since
 * (catch-up for rows saved before the graph or by paths without the hook),
 * then prune. Owner job (routes) and tests.
 */
export async function syncMemoryGraph(userId: string, limit = 200): Promise<{ indexed: number; unchanged: number; pruned: { links: number; entities: number } }> {
  await graphIdle();
  if (!(await graphTablesExist())) return { indexed: 0, unchanged: 0, pruned: { links: 0, entities: 0 } };
  const { getMemoryStorage } = await import('../storage.js');
  const rows = await sql().read(all<{ id: string; content: string; content_hash: string | null }>(`
    SELECT m.id, m.content, s.content_hash FROM memories m
      LEFT JOIN memory_graph_state s ON s.memory_id = m.id AND s.user_id = m.user_id
     WHERE m.user_id = ? ORDER BY m.created_at, m.id`, userId));
  let indexed = 0;
  let unchanged = 0;
  for (const r of rows) {
    if (r.content_hash === contentHash(r.content)) { unchanged++; continue; }
    if (indexed >= Math.max(1, Math.min(1000, limit))) break;
    const memory = await getMemoryStorage().getOwned(userId, r.id);
    if (!memory) continue;
    const res = await indexMemoryGraph(memory, { force: true });
    if (res.status === 'indexed') indexed++;
  }
  const pruned = await sql().tx(() => pruneGraphStep(userId));
  return { indexed, unchanged, pruned };
}

/** Owner review of a pending link: approve -> active, reject -> rejected. Null when not pending. */
export async function decideLink(userId: string, linkId: string, decision: 'approve' | 'reject', decidedBy: string): Promise<{ id: string; status: LinkStatus } | null> {
  if (typeof linkId !== 'string' || !linkId) return null;
  const status: LinkStatus = decision === 'approve' ? 'active' : 'rejected';
  const res = await sql().tx(function* () {
    const d = yield* dialect();
    return yield* run(`UPDATE memory_graph_links SET status = ?, decided_by = ?, decided_at = ${nowIsoText(d)} WHERE id = ? AND user_id = ? AND status = 'pending'`,
      status, decidedBy, linkId, userId);
  });
  return res.changes === 1 ? { id: linkId, status } : null;
}

export type { LinkType };
