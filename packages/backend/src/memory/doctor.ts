/**
 * Memory doctor (CORE-MEM-DOCTOR): a read-only health check of one user's
 * memory, and safe fixes that run only with an explicit confirm.
 *
 * Checks (ids and counts only; memory text never appears in a report):
 *   duplicate         same type + same text (case/space/punctuation-insensitive)
 *                     in one drawer; fix: the extra copies are deleted
 *                     (versioned, reversible), the one with a topic key or
 *                     else the oldest is kept
 *   expired           working/experience items past their expiry time that
 *                     are still stored; fix: deleted (versioned, reversible)
 *   embedding-missing no vector; fix: embedded with the current model
 *   embedding-stale   vector of another model than the current one, or with
 *                     a wrong stored size; fix: re-embedded (skipped while the
 *                     current model does not answer)
 *   orphan-versions   history of a memory that no longer exists but was never
 *                     closed by a delete/forget; fix: a closing `delete`
 *                     version (the history stays as it is)
 *   broken-drawer     a drawer kind/key the drawer rules refuse; fix: the
 *                     memory moves to the default drawer of its type (versioned)
 *   topic-key-invalid a topic key not in canonical form; fix: normalized, or
 *                     cleared when the canonical key is taken
 *   graph-orphan      knowledge-map rows left behind (MEM-GAPS-02): mentions,
 *                     link sources or index state of a memory that is gone, a
 *                     link with no source memory, an entity with no memory and
 *                     no link; fix: removed (the graph prune). Whole-memory
 *                     checks only (an agent run's drawer scope skips it).
 *
 * The report carries `reportHash` (sha256 of its issues). A fix must send
 * `confirm: true` and the hash of the report the owner saw; when the memory
 * changed meanwhile the fix is refused (409 `report_changed`) and nothing is
 * written. Only the listed kinds are fixed. Owner only (callers check); an
 * agent run is limited to the drawers open for it.
 */

import { createHash } from 'crypto';
import { all, run, sql, type Step } from '../repositories/sql-steps.js';
import { getMemoryStorage, TopicKeyTakenError } from './storage.js';
import { getEmbeddingService } from './embedding.js';
import {
  defaultDrawerForType,
  drawerId,
  drawerSqlFilter,
  normalizeDrawer,
  type DrawerRef,
} from './drawers.js';
import { deleteVersioned } from './learning.js';
import { recordBaselineIfMissingStep, recordVersionStep, versionEntryOf } from './versions.js';
import { isTopicKey, suggestTopicKey } from './topic-key.js';
import { graphTablesExist, pruneGraphStep } from './graph/store.js';
import type { Memory } from './types.js';

export const DOCTOR_KINDS = [
  'duplicate', 'expired', 'embedding-missing', 'embedding-stale', 'orphan-versions', 'broken-drawer', 'topic-key-invalid', 'graph-orphan',
] as const;
export type DoctorKind = typeof DOCTOR_KINDS[number];

/** At most this many issues of one kind are listed (the counts stay exact). */
export const MAX_ISSUES_PER_KIND = 200;

export interface DoctorIssue {
  kind: DoctorKind;
  /** Drawer of the memories, when known ('?' for a broken drawer). */
  drawerId: string;
  /** Affected memory ids; for a duplicate the first one is kept. */
  memoryIds: string[];
  /** Short machine detail (model ids, counts), never memory text. */
  detail?: string;
}

export interface DoctorReport {
  checkedAt: string;
  embeddingModel: string;
  total: number;
  counts: Record<DoctorKind, number>;
  issues: DoctorIssue[];
  /** sha256 of the issues; a fix must send it back (expectedReportHash). */
  reportHash: string;
}

export interface DoctorFixResult {
  fixed: Record<DoctorKind, number>;
  skipped: Array<{ kind: DoctorKind; memoryId: string; reason: string }>;
  report: DoctorReport;
}

export class DoctorError extends Error {
  constructor(message: string, readonly status: 400 | 409, readonly code: 'confirm_required' | 'report_hash_required' | 'report_changed' | 'invalid_kinds') {
    super(message);
  }
}

export interface DoctorScope {
  /** Only these drawers (agent runs); absent = all of the user's memory. */
  drawers?: readonly DrawerRef[] | null;
  now?: Date;
}

function normText(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
}

function zero(): Record<DoctorKind, number> {
  return Object.fromEntries(DOCTOR_KINDS.map((k) => [k, 0])) as Record<DoctorKind, number>;
}

interface RawRow { id: string; type: string; drawer_kind: string | null; drawer_key: string | null; topic_key: string | null }

async function memoriesOf(userId: string, drawers: readonly DrawerRef[] | null | undefined): Promise<Memory[]> {
  const storage = getMemoryStorage();
  if (drawers) return storage.getByDrawers(userId, [...drawers]);
  const list = await storage.getByUser(userId);
  return list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Raw drawer columns (the Memory object already holds the repaired default). */
function* rawDrawersStep(userId: string, drawers: readonly DrawerRef[] | null | undefined): Step<RawRow[]> {
  const filter = drawers ? drawerSqlFilter([...drawers]) : { sql: '1 = 1', params: [] as string[] };
  return yield* all<RawRow>(
    `SELECT id, type, drawer_kind, drawer_key, topic_key FROM memories WHERE user_id = ? AND ${filter.sql} ORDER BY created_at ASC, id ASC`,
    userId, ...filter.params,
  );
}

/** Memory ids with a history but no row, whose last change is not delete/forget. */
function* orphanVersionsStep(userId: string, drawers: readonly DrawerRef[] | null | undefined): Step<Array<{ memoryId: string; drawerKind: string; drawerKey: string; versions: number }>> {
  const rows = yield* all<{ memory_id: string; drawer_kind: string; drawer_key: string; change: string; n: number }>(`
    SELECT v.memory_id, v.drawer_kind, v.drawer_key, v.change,
           (SELECT COUNT(*) FROM memory_versions c WHERE c.memory_id = v.memory_id AND c.user_id = v.user_id) AS n
      FROM memory_versions v
     WHERE v.user_id = ?
       AND v.version = (SELECT MAX(w.version) FROM memory_versions w WHERE w.memory_id = v.memory_id AND w.user_id = v.user_id)
       AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = v.memory_id)
     ORDER BY v.memory_id
  `, userId);
  const inScope = (kind: string, key: string) => !drawers || drawers.some((d) => d.kind === kind && (d.key || '') === (key || ''));
  return rows
    .filter((r) => r.change !== 'delete' && r.change !== 'forget' && inScope(r.drawer_kind, r.drawer_key))
    .map((r) => ({ memoryId: r.memory_id, drawerKind: r.drawer_kind, drawerKey: r.drawer_key || '', versions: Number(r.n) }));
}

function brokenDrawer(r: RawRow): boolean {
  if (r.drawer_kind === null) return false; // pre-drawer row: derived default, filled on start-up
  try {
    normalizeDrawer(r.drawer_key ? { kind: r.drawer_kind, key: r.drawer_key } : { kind: r.drawer_kind });
    return false;
  } catch { return true; }
}

function hashIssues(issues: DoctorIssue[]): string {
  return createHash('sha256').update(JSON.stringify(['memory-doctor/v1', issues])).digest('hex');
}

/** The health check (read only: SELECTs only, no access-count update, no network). */
export async function checkMemory(userId: string, scope: DoctorScope = {}): Promise<DoctorReport> {
  const now = (scope.now ?? new Date()).getTime();
  const target = getEmbeddingService().targetModel();
  const memories = await memoriesOf(userId, scope.drawers);
  const raw = await sql().read(rawDrawersStep(userId, scope.drawers));
  const orphans = await sql().read(orphanVersionsStep(userId, scope.drawers));
  const counts = zero();
  const issues: DoctorIssue[] = [];
  const add = (issue: DoctorIssue, n = 1) => {
    counts[issue.kind] += n;
    if (issues.filter((i) => i.kind === issue.kind).length < MAX_ISSUES_PER_KIND) issues.push(issue);
  };

  // Duplicates: one group per drawer + type + normalized text.
  const groups = new Map<string, Memory[]>();
  for (const m of memories) {
    const k = JSON.stringify([drawerId(m.drawer!), m.type, normText(m.content)]);
    groups.set(k, [...(groups.get(k) || []), m]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keep = group.find((m) => m.topicKey) ?? group[0];
    add({ kind: 'duplicate', drawerId: drawerId(keep.drawer!), memoryIds: [keep.id, ...group.filter((m) => m !== keep).map((m) => m.id)] }, group.length - 1);
  }

  for (const m of memories) {
    const d = drawerId(m.drawer!);
    if (m.expiryTimestamp && m.expiryTimestamp < now) add({ kind: 'expired', drawerId: d, memoryIds: [m.id], detail: m.memoryLayer });
    if (!m.embedding || m.embedding.length === 0) {
      add({ kind: 'embedding-missing', drawerId: d, memoryIds: [m.id] });
    } else if (m.embeddingModel !== target) {
      add({ kind: 'embedding-stale', drawerId: d, memoryIds: [m.id], detail: `${m.embeddingModel} -> ${target}` });
    }
  }

  // Stored size vs vector length (a vector written by hand or cut off).
  const dims = await sql().read(all<{ id: string; embedding_dims: number | null }>(
    'SELECT id, embedding_dims FROM memories WHERE user_id = ? AND embedding IS NOT NULL', userId));
  const dimsById = new Map(dims.map((r) => [r.id, r.embedding_dims]));
  for (const m of memories) {
    const stored = dimsById.get(m.id);
    if (m.embedding?.length && m.embeddingModel === target && stored != null && Number(stored) !== m.embedding.length) {
      add({ kind: 'embedding-stale', drawerId: drawerId(m.drawer!), memoryIds: [m.id], detail: `dims ${stored} != ${m.embedding.length}` });
    }
  }

  for (const o of orphans) {
    add({ kind: 'orphan-versions', drawerId: o.drawerKey ? `${o.drawerKind}:${o.drawerKey}` : o.drawerKind, memoryIds: [o.memoryId], detail: `${o.versions} versions` });
  }
  for (const r of raw) {
    if (brokenDrawer(r)) add({ kind: 'broken-drawer', drawerId: '?', memoryIds: [r.id], detail: `kind ${String(r.drawer_kind).slice(0, 20)}` });
    if (r.topic_key !== null && !isTopicKey(r.topic_key)) add({ kind: 'topic-key-invalid', drawerId: '?', memoryIds: [r.id] });
  }

  if (!scope.drawers) {
    const g = await graphOrphans(userId);
    if (g.total) add({ kind: 'graph-orphan', drawerId: 'graph', memoryIds: g.memoryIds, detail: `mentions ${g.mentions}, link sources ${g.sources}, state ${g.state}, links ${g.links}, entities ${g.entities}` }, g.total);
  }

  const ordered = DOCTOR_KINDS.flatMap((k) => issues.filter((i) => i.kind === k));
  return {
    checkedAt: new Date(now).toISOString(),
    embeddingModel: target,
    total: memories.length,
    counts,
    issues: ordered,
    reportHash: hashIssues(ordered),
  };
}

export function parseDoctorKinds(value: unknown): DoctorKind[] {
  if (value === undefined || value === null) return [...DOCTOR_KINDS];
  if (!Array.isArray(value) || value.length === 0 || !value.every((k) => (DOCTOR_KINDS as readonly string[]).includes(k))) {
    throw new DoctorError(`kinds must be a non-empty list of: ${DOCTOR_KINDS.join(', ')}`, 400, 'invalid_kinds');
  }
  return [...new Set(value as DoctorKind[])];
}

/** Knowledge-map rows the graph prune would remove (counts; ids of gone memories, at most 50). */
async function graphOrphans(userId: string): Promise<{ total: number; mentions: number; sources: number; state: number; links: number; entities: number; memoryIds: string[] }> {
  const none = { total: 0, mentions: 0, sources: 0, state: 0, links: 0, entities: 0, memoryIds: [] };
  if (!(await graphTablesExist())) return none;
  return sql().read((function* () {
    const gone = 'NOT IN (SELECT id FROM memories WHERE user_id = ?)';
    const n = function* (q: string, ...p: string[]) { return Number((yield* all<{ n: number }>(q, ...p))[0]?.n ?? 0); };
    const mentions = yield* n(`SELECT COUNT(*) AS n FROM memory_graph_mentions WHERE user_id = ? AND memory_id ${gone}`, userId, userId);
    const sources = yield* n(`SELECT COUNT(*) AS n FROM memory_graph_link_sources WHERE user_id = ? AND memory_id ${gone}`, userId, userId);
    const state = yield* n(`SELECT COUNT(*) AS n FROM memory_graph_state WHERE user_id = ? AND memory_id ${gone}`, userId, userId);
    // After those rows go: links without a live source, then entities without a live mention or a kept link.
    const links = yield* n(`SELECT COUNT(*) AS n FROM memory_graph_links WHERE user_id = ? AND id NOT IN
      (SELECT link_id FROM memory_graph_link_sources WHERE user_id = ? AND memory_id IN (SELECT id FROM memories WHERE user_id = ?))`, userId, userId, userId);
    const entities = yield* n(`SELECT COUNT(*) AS n FROM memory_graph_entities e WHERE e.user_id = ?
      AND e.id NOT IN (SELECT entity_id FROM memory_graph_mentions WHERE user_id = ? AND memory_id IN (SELECT id FROM memories WHERE user_id = ?))
      AND e.id NOT IN (SELECT l.src_id FROM memory_graph_links l WHERE l.user_id = ? AND l.id IN (SELECT link_id FROM memory_graph_link_sources WHERE user_id = ? AND memory_id IN (SELECT id FROM memories WHERE user_id = ?)))
      AND e.id NOT IN (SELECT l.dst_id FROM memory_graph_links l WHERE l.user_id = ? AND l.id IN (SELECT link_id FROM memory_graph_link_sources WHERE user_id = ? AND memory_id IN (SELECT id FROM memories WHERE user_id = ?)))`,
    userId, userId, userId, userId, userId, userId, userId, userId, userId);
    const ids = yield* all<{ id: string }>(`SELECT DISTINCT memory_id AS id FROM (
      SELECT memory_id FROM memory_graph_mentions WHERE user_id = ? AND memory_id ${gone}
      UNION SELECT memory_id FROM memory_graph_link_sources WHERE user_id = ? AND memory_id ${gone}
      UNION SELECT memory_id FROM memory_graph_state WHERE user_id = ? AND memory_id ${gone}) x ORDER BY id LIMIT 50`, userId, userId, userId, userId, userId, userId);
    return { total: mentions + sources + state + links + entities, mentions, sources, state, links, entities, memoryIds: ids.map((r) => r.id) };
  })());
}

/**
 * Apply the safe fixes of the reported issues. Nothing is written unless
 * `confirm === true` and `expectedReportHash` is the hash of the current
 * report (the one the owner reviewed).
 */
export async function fixMemory(userId: string, input: {
  confirm: unknown; expectedReportHash: unknown; kinds?: unknown; actor: string;
}, scope: DoctorScope = {}): Promise<DoctorFixResult> {
  if (input.confirm !== true) throw new DoctorError('Nothing was changed: send confirm: true to apply the fixes', 400, 'confirm_required');
  if (typeof input.expectedReportHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedReportHash)) {
    throw new DoctorError('expectedReportHash is required (the reportHash of the check you reviewed)', 400, 'report_hash_required');
  }
  const kinds = new Set(parseDoctorKinds(input.kinds));
  const report = await checkMemory(userId, scope);
  if (report.reportHash !== input.expectedReportHash) {
    throw new DoctorError('The memory changed since the check; run the check again', 409, 'report_changed');
  }
  const storage = getMemoryStorage();
  const fixed = zero();
  const skipped: DoctorFixResult['skipped'] = [];
  const reason = (k: DoctorKind) => `doctor:${k}`;

  // Re-embedding first (async model calls), one batch.
  const toEmbed = report.issues.filter((i) => (i.kind === 'embedding-missing' || i.kind === 'embedding-stale') && kinds.has(i.kind));
  if (toEmbed.length) {
    const target = getEmbeddingService().targetModel();
    const mems = (await Promise.all(toEmbed.map((i) => storage.getOwned(userId, i.memoryIds[0])))).filter((m): m is Memory => !!m);
    const fresh = await getEmbeddingService().embedManyDetailed(mems.map((m) => m.content));
    for (const [n, m] of mems.entries()) {
      const kind = toEmbed.find((i) => i.memoryIds[0] === m.id)!.kind;
      if (fresh[n].model !== target) { skipped.push({ kind, memoryId: m.id, reason: 'embedding model not available' }); continue; }
      if (await storage.setEmbedding(userId, m.id, m.content, fresh[n].vector, fresh[n].model)) fixed[kind]++;
      else skipped.push({ kind, memoryId: m.id, reason: 'changed meanwhile' });
    }
  }

  for (const issue of report.issues) {
    if (!kinds.has(issue.kind)) continue;
    if (issue.kind === 'duplicate') {
      for (const id of issue.memoryIds.slice(1)) {
        if (await deleteVersioned(userId, id, input.actor, reason('duplicate'))) fixed.duplicate++;
      }
    } else if (issue.kind === 'expired') {
      if (await deleteVersioned(userId, issue.memoryIds[0], input.actor, reason('expired'))) fixed.expired++;
    } else if (issue.kind === 'orphan-versions') {
      const memoryId = issue.memoryIds[0];
      const [kind, key] = issue.drawerId.split(/:(.*)/s);
      const closed = await sql().tx(function* () {
        // Still an orphan inside the transaction (no row, last change not delete/forget).
        const still = (yield* orphanVersionsStep(userId, null)).some((o) => o.memoryId === memoryId);
        if (!still) return false;
        yield* recordVersionStep({ memoryId, userId, drawer: { kind: kind as DrawerRef['kind'], ...(key ? { key } : {}) }, change: 'delete', entry: null, actor: input.actor, reason: reason('orphan-versions') });
        return true;
      });
      if (closed) fixed['orphan-versions']++;
    } else if (issue.kind === 'broken-drawer' || issue.kind === 'topic-key-invalid') {
      const id = issue.memoryIds[0];
      const done = await sql().tx(function* () {
        const m = yield* storage.getOwnedStep(userId, id, true);
        if (!m) return false;
        if (issue.kind === 'broken-drawer') return yield* moveToDefaultDrawer(userId, m, input.actor);
        return yield* repairTopicKey(userId, m, input.actor);
      });
      if (done) fixed[issue.kind]++;
      else skipped.push({ kind: issue.kind, memoryId: id, reason: 'changed meanwhile' });
    } else if (issue.kind === 'graph-orphan') {
      // The prune removes every orphan row of the user at once; fixed = what was reported minus what is left.
      await sql().tx(() => pruneGraphStep(userId));
      fixed['graph-orphan'] += Math.max(0, report.counts['graph-orphan'] - (await graphOrphans(userId)).total);
    }
  }
  return { fixed, skipped, report: await checkMemory(userId, scope) };
}

/** broken-drawer fix: the default drawer of the type; a taken topic key is cleared. */
function* moveToDefaultDrawer(userId: string, m: Memory, actor: string): Step<boolean> {
  const raw = (yield* all<RawRow>('SELECT id, type, drawer_kind, drawer_key, topic_key FROM memories WHERE id = ? AND user_id = ?', m.id, userId))[0];
  if (!raw || !brokenDrawer(raw)) return false;
  const target = defaultDrawerForType(m.type);
  let topicKey = raw.topic_key;
  if (topicKey) {
    const holder = yield* getMemoryStorage().getByTopicKeyStep(userId, target, topicKey, true);
    if (holder && holder.id !== m.id) topicKey = null;
  }
  yield* run('UPDATE memories SET drawer_kind = ?, drawer_key = ?, topic_key = ? WHERE id = ? AND user_id = ?',
    target.kind, target.key || '', topicKey, m.id, userId);
  yield* recordBaselineIfMissingStep({ ...m, drawer: target }, actor, 'before first change');
  yield* recordVersionStep({ memoryId: m.id, userId, drawer: target, change: 'update', entry: versionEntryOf(m), actor, reason: 'doctor:broken-drawer' });
  return true;
}

/** topic-key-invalid fix: the canonical key, or none when it is taken or empty. */
function* repairTopicKey(userId: string, m: Memory, actor: string): Step<boolean> {
  if (m.topicKey == null || isTopicKey(m.topicKey)) return false;
  const canonical = suggestTopicKey(m.topicKey);
  let next: string | null = canonical;
  try {
    yield* getMemoryStorage().setTopicKeyStep(userId, m.id, next);
  } catch (err) {
    if (!(err instanceof TopicKeyTakenError)) throw err;
    next = null;
    yield* getMemoryStorage().setTopicKeyStep(userId, m.id, null);
  }
  yield* recordBaselineIfMissingStep(m, actor, 'before first change');
  yield* recordVersionStep({ memoryId: m.id, userId, drawer: m.drawer!, change: 'update', entry: versionEntryOf(m), actor, reason: `doctor:topic-key:${next ?? '(none)'}` });
  return true;
}
