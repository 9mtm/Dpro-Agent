/**
 * Memory version history (CORE-04/05).
 *
 * `memory_versions` is the append-only history of every memory change:
 * reviewed proposals (CORE-04) and, since CORE-05, every add/edit/delete
 * made through the API and the memory tools. Each row names the actor
 * (user id, or `agent:<agentId>`) and the reason.
 *
 * Drawer revisions count approved proposals (one approved proposal = +1).
 * A direct change is recorded at the drawer's current revision.
 *
 * Before the first recorded change of a memory that has no history yet, a
 * `baseline` row keeps its previous state, so an edit or delete can always
 * be traced back (and undone by hand) until the memory is forgotten (CORE-07).
 */

import { v4 as uuidv4 } from 'uuid';
import { all, lockName, one, run, sql, type Step } from '../repositories/sql-steps.js';
import type { Memory } from './types.js';
import type { DrawerRef } from './drawers.js';

export type VersionChange = 'baseline' | 'create' | 'update' | 'delete';

export interface VersionEntry { type: string; importance: number; content: string }

/** What Restore from the Trash needs beyond a version row (MEM-TRASH-01). */
export function trashSnapshot(m: Memory): string {
  return JSON.stringify({
    type: m.type, content: m.content, importanceScore: m.importanceScore ?? null, summary: m.summary ?? null, tags: m.tags ?? null,
    metadata: m.metadata ?? null, topicKey: m.topicKey ?? null, memoryLayer: m.memoryLayer ?? null, sourceAgentId: m.sourceAgentId ?? null,
    createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt ?? null,
  });
}

/** Actor id for an agent tool call. */
export function agentActor(agentId?: string | null): string {
  return agentId ? `agent:${agentId}` : 'agent';
}

export function importanceOf(m: Pick<Memory, 'importanceScore'>): number {
  const score = typeof m.importanceScore === 'number' ? m.importanceScore : 0.5;
  return Math.min(10, Math.max(1, Math.round(score * 10)));
}

export function versionEntryOf(m: Memory): VersionEntry {
  return { type: m.type, importance: importanceOf(m), content: m.content };
}

/** The drawer's revision: the highest drawer_revision recorded for it (0 = none). */
export function* drawerRevisionStep(userId: string, drawer: DrawerRef): Step<number> {
  const row = yield* one<{ rev: number | null }>(
    'SELECT MAX(drawer_revision) AS rev FROM memory_versions WHERE user_id = ? AND drawer_kind = ? AND drawer_key = ?',
    userId, drawer.kind, drawer.key || '',
  );
  return row?.rev ?? 0;
}

export function currentDrawerRevision(userId: string, drawer: DrawerRef): Promise<number> {
  return sql().read(drawerRevisionStep(userId, drawer));
}

/** Highest version of a memory's history, or null when it has none. */
export function* lastVersionStep(memoryId: string): Step<number | null> {
  const row = yield* one<{ v: number | null }>('SELECT MAX(version) AS v FROM memory_versions WHERE memory_id = ?', memoryId);
  return row?.v ?? null;
}

/**
 * Transaction lock for one memory's history (PostgreSQL): the next version
 * number is read and written while it is held, so two writers never pick
 * the same number (UNIQUE (memory_id, version) would refuse the second).
 */
export function* lockMemoryHistory(memoryId: string): Step<void> {
  yield* lockName(`memory-history:${memoryId}`);
}

export interface RecordVersionInput {
  memoryId: string;
  userId: string;
  drawer: DrawerRef;
  change: VersionChange;
  entry: VersionEntry | null;
  actor: string;
  reason?: string | null;
  proposalId?: string | null;
  /** Drawer revision of the row; default the drawer's current revision. */
  revision?: number;
  /** JSON of the whole memory at a 'delete' (Trash restore, MEM-TRASH-01). */
  snapshot?: string | null;
}

/** Append one version row (SQL step; run it inside a transaction). */
export function* recordVersionStep(input: RecordVersionInput): Step<void> {
  yield* lockMemoryHistory(input.memoryId);
  const v = ((yield* lastVersionStep(input.memoryId)) ?? 0) + 1;
  const rev = input.revision ?? (yield* drawerRevisionStep(input.userId, input.drawer));
  yield* run(`
    INSERT INTO memory_versions (id, memory_id, user_id, drawer_kind, drawer_key, drawer_revision, version, change, type, content, importance_score, proposal_id, created_by, reason, snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, uuidv4(), input.memoryId, input.userId, input.drawer.kind, input.drawer.key || '', rev, v, input.change,
    input.entry?.type ?? null, input.entry?.content ?? null, input.entry ? input.entry.importance / 10 : null,
    input.proposalId ?? null, input.actor, typeof input.reason === 'string' ? input.reason.slice(0, 200) : null, input.snapshot ?? null);
}

/** Append one version row (one transaction). */
export function recordVersion(input: RecordVersionInput): Promise<void> {
  return sql().tx(() => recordVersionStep(input));
}

/** Record the state before the first change of a memory without history (SQL step). */
export function* recordBaselineIfMissingStep(m: Memory, actor: string, reason?: string | null, revision?: number): Step<void> {
  yield* lockMemoryHistory(m.id);
  if ((yield* lastVersionStep(m.id)) !== null) return;
  yield* recordVersionStep({
    memoryId: m.id, userId: m.userId, drawer: m.drawer || { kind: 'owner' }, change: 'baseline',
    entry: versionEntryOf(m), actor, reason, revision,
  });
}

export function recordBaselineIfMissing(m: Memory, actor: string, reason?: string | null, revision?: number): Promise<void> {
  return sql().tx(() => recordBaselineIfMissingStep(m, actor, reason, revision));
}

/** History of one memory, oldest first. */
export function memoryVersions(userId: string, memoryId: string): Promise<any[]> {
  return sql().read(all(`
    SELECT memory_id AS "memoryId", drawer_kind AS "drawerKind", drawer_key AS "drawerKey", drawer_revision AS "drawerRevision",
           version, change, type, content, importance_score AS "importanceScore", proposal_id AS "proposalId",
           created_by AS "createdBy", reason, created_at AS "createdAt"
      FROM memory_versions WHERE user_id = ? AND memory_id = ? ORDER BY version ASC
  `, userId, memoryId));
}
