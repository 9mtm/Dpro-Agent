/**
 * Graph recall (CORE-MEM-GRAPH): entities named in the request -> expand up
 * to two links -> the memories attached to those entities, merged with the
 * keyword + meaning results of storage.search (CORE-06).
 *
 * Drawers (CORE-03) are applied at every step, not only at the end:
 *   - a link is followed only when at least one memory it was learned from is
 *     in an allowed drawer (another project's drawer never steers recall);
 *   - only memories in the allowed drawers are loaded.
 * Only `active` links are followed (pending ones wait for the owner).
 *
 * Score of a graph hit (0-1, same scale as hybridScore): GRAPH_WEIGHT times
 * the entity weight (named in the request 1, one link away 0.6, two links
 * away 0.35). A memory found by both the search and the graph keeps the
 * higher score plus BOTH_BONUS.
 */

import { all, sql } from '../../repositories/sql-steps.js';
import { drawerSqlFilter, type DrawerRef } from '../drawers.js';
import { lexicalTokens } from '../text-normalize.js';
import type { Memory, MemorySearchQuery, MemorySearchResult } from '../types.js';
import { graphTablesExist } from './store.js';
import { containsName } from './types.js';

export const GRAPH_WEIGHT = 0.45;
export const HOP_WEIGHTS = [1, 0.6, 0.35] as const;
export const BOTH_BONUS = 0.05;
/** At most this many entities are added per hop, and memories pulled per recall. */
export const MAX_FRONTIER = 25;
export const MAX_GRAPH_MEMORIES = 50;

export interface GraphScope {
  userId: string;
  /** Allowed drawers; undefined = all of the user's drawers (an account reading its own memory). */
  drawers?: DrawerRef[];
}

/** SQL subquery: ids of the user's memories in the scope's drawers (+ optional search filters). */
export function scopedMemoryIds(scope: GraphScope, filters: Pick<MemorySearchQuery, 'type' | 'layer' | 'minImportance' | 'minImportanceScore'> = {}): { sql: string; params: Array<string | number> } {
  let where = 'user_id = ?';
  const params: Array<string | number> = [scope.userId];
  if (scope.drawers) {
    const f = drawerSqlFilter(scope.drawers);
    where += ` AND ${f.sql}`;
    params.push(...f.params);
  }
  if (filters.type) { where += ' AND type = ?'; params.push(filters.type); }
  if (filters.layer) { where += ' AND memory_layer = ?'; params.push(filters.layer); }
  if (filters.minImportanceScore !== undefined) { where += ' AND importance_score >= ?'; params.push(filters.minImportanceScore); }
  else if (filters.minImportance !== undefined) { where += ' AND importance_score >= ?'; params.push(filters.minImportance / 10); }
  return { sql: `SELECT id FROM memories WHERE ${where}`, params };
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Entities of the user named in a text (by name or alias, whole tokens). */
export async function entitiesNamedIn(userId: string, text: string): Promise<Array<{ id: string; name: string; kind: string }>> {
  const tokens = lexicalTokens(text);
  if (tokens.length === 0) return [];
  const rows = await sql().read(all<{ id: string; name: string; kind: string; norm_name: string; aliases: string }>(
    'SELECT id, name, kind, norm_name, aliases FROM memory_graph_entities WHERE user_id = ? ORDER BY id', userId));
  return rows.filter((r) => {
    if (containsName(tokens, r.norm_name)) return true;
    try { return (JSON.parse(r.aliases || '[]') as unknown[]).some((a) => typeof a === 'string' && containsName(tokens, a)); } catch { return false; }
  }).map((r) => ({ id: r.id, name: r.name, kind: r.kind }));
}

/**
 * Entity weights reachable from the seeds through active links whose source
 * memories are in scope (at most `hops` links away).
 */
export async function expandEntities(scope: GraphScope, seeds: string[], hops = 2): Promise<Map<string, number>> {
  const weight = new Map<string, number>(seeds.map((id) => [id, HOP_WEIGHTS[0]]));
  let frontier = [...new Set(seeds)].slice(0, MAX_FRONTIER);
  const inScope = scopedMemoryIds(scope);
  for (let hop = 1; hop <= Math.min(2, hops) && frontier.length; hop++) {
    const ph = placeholders(frontier.length);
    const rows = await sql().read(all<{ src_id: string; dst_id: string }>(`
      SELECT l.src_id, l.dst_id FROM memory_graph_links l
       WHERE l.user_id = ? AND l.status = 'active' AND (l.src_id IN (${ph}) OR l.dst_id IN (${ph}))
         AND EXISTS (SELECT 1 FROM memory_graph_link_sources s
                      WHERE s.link_id = l.id AND s.memory_id IN (${inScope.sql}))
       ORDER BY l.created_at, l.id`,
      scope.userId, ...frontier, ...frontier, ...inScope.params));
    const next: string[] = [];
    const set = new Set(frontier);
    for (const r of rows) {
      for (const other of [set.has(r.src_id) ? r.dst_id : null, set.has(r.dst_id) ? r.src_id : null]) {
        if (!other || weight.has(other) || next.length >= MAX_FRONTIER) continue;
        weight.set(other, HOP_WEIGHTS[hop]);
        next.push(other);
      }
    }
    frontier = next;
  }
  return weight;
}

/** Memory ids attached to weighted entities, in scope, with their graph score. */
export async function attachedMemoryScores(scope: GraphScope, weights: Map<string, number>, filters: Parameters<typeof scopedMemoryIds>[1] = {}): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...weights.keys()];
  if (ids.length === 0) return out;
  const inScope = scopedMemoryIds(scope, filters);
  const rows = await sql().read(all<{ entity_id: string; memory_id: string }>(`
    SELECT entity_id, memory_id FROM memory_graph_mentions
     WHERE user_id = ? AND entity_id IN (${placeholders(ids.length)}) AND memory_id IN (${inScope.sql})
     ORDER BY memory_id`,
    scope.userId, ...ids, ...inScope.params));
  for (const r of rows) {
    const s = GRAPH_WEIGHT * (weights.get(r.entity_id) ?? 0);
    if (s > (out.get(r.memory_id) ?? 0)) out.set(r.memory_id, s);
  }
  return out;
}

/** Graph hits for a request (no search part). Never throws: a graph problem returns []. */
export async function graphRecall(scope: GraphScope, query: string, opts: Parameters<typeof scopedMemoryIds>[1] & { limit?: number } = {}): Promise<MemorySearchResult[]> {
  try {
    if (scope.drawers && scope.drawers.length === 0) return [];
    if (!(await graphTablesExist())) return [];
    const seeds = await entitiesNamedIn(scope.userId, query);
    if (seeds.length === 0) return [];
    const weights = await expandEntities(scope, seeds.map((s) => s.id));
    const scores = await attachedMemoryScores(scope, weights, opts);
    const top = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, Math.min(MAX_GRAPH_MEMORIES, (opts.limit ?? 10) * 3));
    const { getMemoryStorage } = await import('../storage.js');
    const out: MemorySearchResult[] = [];
    for (const [id, score] of top) {
      const memory: Memory | null = await getMemoryStorage().getOwned(scope.userId, id);
      if (!memory) continue;
      out.push({ memory, similarity: score, scoreBreakdown: { vectorScore: 0, keywordScore: 0, recencyScore: 0, importanceScore: memory.importanceScore ?? 0.5 } });
    }
    return out;
  } catch (err) {
    console.warn('[MemoryGraph] recall failed:', (err as Error).message);
    return [];
  }
}

/** Merge search results with graph hits (by memory id), best first, `limit` kept. */
export function mergeRecall(search: MemorySearchResult[], graph: MemorySearchResult[], limit: number): MemorySearchResult[] {
  const byId = new Map<string, MemorySearchResult>();
  for (const r of search) byId.set(r.memory.id, r);
  for (const g of graph) {
    const prev = byId.get(g.memory.id);
    if (!prev) { byId.set(g.memory.id, g); continue; }
    byId.set(g.memory.id, { ...prev, similarity: Math.max(prev.similarity, g.similarity) + BOTH_BONUS });
  }
  return [...byId.values()].sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

/** storage.search results with the graph hits of the same query and scope merged in. */
export async function withGraphRecall(query: MemorySearchQuery, search: MemorySearchResult[]): Promise<MemorySearchResult[]> {
  const limit = query.limit || 10;
  const graph = await graphRecall({ userId: query.userId, ...(query.drawers ? { drawers: query.drawers } : {}) }, query.query, {
    type: query.type, layer: query.layer, minImportance: query.minImportance, minImportanceScore: query.minImportanceScore, limit,
  });
  return graph.length ? mergeRecall(search, graph, limit) : search;
}
