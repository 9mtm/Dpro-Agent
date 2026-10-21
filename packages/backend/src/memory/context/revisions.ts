/**
 * Change counters of a user's memory (MEM-CACHE-01, migration 110).
 *
 * Database triggers bump a counter per drawer on every write to `memories`
 * (insert, edit, move, delete, forget, archive, conflict decision...), one
 * for the knowledge-graph links ('graph') and one for handoff notes
 * ('handoff'). Code that changes what a turn may load without touching those
 * tables (access rules, inheritance, settings) calls bumpMemoryRevision, which
 * bumps '*' — a scope every cache key includes.
 *
 * A cache key made of these numbers changes with any write that can alter a
 * turn's memory context, whatever code path wrote it, so a cached context is
 * never served after its memory changed.
 */

import { all, run, sql, tableExists } from '../../repositories/sql-steps.js';
import { drawerId, type DrawerRef } from '../drawers.js';

/** The user-wide scope: bumped by code, included in every key. */
export const ANY_SCOPE = '*';
export const GRAPH_SCOPE = 'graph';
export const HANDOFF_SCOPE = 'handoff';

let tableReady: boolean | null = null;

async function ready(): Promise<boolean> {
  if (tableReady) return true;
  tableReady = await sql().read(tableExists('memory_cache_revisions')).catch(() => false);
  return tableReady;
}

/** Test hook: forget whether the table exists (a new throwaway database). */
export function resetRevisionsForTests(): void {
  tableReady = null;
}

/** Scopes of a turn: its drawers plus graph, handoff and '*'. Sorted, unique. */
export function turnScopes(drawers: readonly DrawerRef[]): string[] {
  return [...new Set([...drawers.map(drawerId), GRAPH_SCOPE, HANDOFF_SCOPE, ANY_SCOPE])].sort();
}

/**
 * Current revision of each scope (0 when never changed). Without the table
 * (an old database before migration 110) every call returns a fresh value,
 * so nothing is ever served from cache.
 */
export async function scopeRevisions(userId: string, scopes: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const s of scopes) out[s] = 0;
  if (!(await ready())) {
    out[ANY_SCOPE] = -Date.now() - Math.random();
    return out;
  }
  if (scopes.length === 0) return out;
  const rows = await sql().read(all<{ scope: string; revision: number }>(
    `SELECT scope, revision FROM memory_cache_revisions WHERE user_id = ? AND scope IN (${scopes.map(() => '?').join(', ')})`,
    userId, ...scopes,
  ));
  for (const r of rows) out[r.scope] = Number(r.revision);
  return out;
}

/** Bump a scope (default '*': anything about the user's memory access changed). */
export async function bumpMemoryRevision(userId: string, scope: string = ANY_SCOPE): Promise<void> {
  if (!userId || !(await ready())) return;
  await sql().read(run(
    `INSERT INTO memory_cache_revisions (user_id, scope, revision) VALUES (?, ?, 1)
       ON CONFLICT (user_id, scope) DO UPDATE SET revision = memory_cache_revisions.revision + 1`,
    userId, scope,
  ));
}
