/**
 * Forgetting (CORE-07; MEMORY_VISION "Forgetting rules v1").
 *
 * "Forget this" removes a memory completely:
 *   - the memory row (and with it its stored embedding)
 *   - the text of every version: the history rows are removed and ONE
 *     tombstone stays (memory_versions change 'forget': memory id, user,
 *     drawer, time, actor; no type, no text)
 *   - rows of the hybrid index (memory_index / memory_chunks / memory_fts /
 *     memory_relations), quality/enrichment/sharing logs and relationships
 *   - the per-memory Markdown copy (every type it ever had) and the drawer's
 *     exported files (re-exported in every agent folder where they exist)
 *   - its text in proposals (redacted); pending proposals that touch it are
 *     cancelled
 *   - its lines in stored weekly summaries (re-rendered without it; a model
 *     text that may quote it is dropped)
 *
 * A plain delete (DELETE /api/memory/:id, memory_delete) keeps the history so
 * it can be undone; forget cannot be undone. Only the memory's own user
 * forgets it (others get "not found"); forget-all and retention are owner-only.
 *
 * B2.2b-4: every database change is ONE transaction (SQL steps, both
 * drivers). On PostgreSQL the hybrid index rows live in the same database
 * and are removed in that transaction too; the work outside the database
 * (readable copies, exports, the SQLite index file) runs after the commit
 * (afterPgCommit: never for a rolled-back forget; deferred to the outer
 * COMMIT when forget runs inside a caller's transaction, `reexported` is
 * then empty). Lock order (PostgreSQL): proposal rows, then the memory row,
 * then its history, the same order a proposal approval takes.
 * PostgreSQL has no secure_delete: deleted tuples stay in the table file
 * until VACUUM reuses the space.
 */

import fs from 'fs';
import path from 'path';
import { all, columnExists, dialect, one, run, sql, tableExists, type Step } from '../repositories/sql-steps.js';
import { afterPgCommit } from '../db/pg/pool.js';
import { forUpdate, likeCi, nowIsoText } from '../db/pg/dialect.js';
import { getMemoryStorage } from './storage.js';
import { normalizeDrawer, drawerId, type DrawerRef } from './drawers.js';
import { exportDrawerFileIfPresent } from './memory-files.js';
import { drawerRevisionStep, lockMemoryHistory } from './versions.js';
import { renderDigest, type WeeklyDigest } from './weekly-summary.js';
import { purgePgIndexStep } from './indexer-pg.js';
import { forgetMemoryGraphStep } from './graph/store.js';
import { DEFAULT_MEMORY_CONFIG, type Memory, type MemoryType } from './types.js';
import { v4 as uuidv4 } from 'uuid';

export interface ForgetResult {
  memoryId: string;
  drawerId: string;
  forgottenAt: string;
  actor: string;
  /** Pending proposals cancelled because they touched the memory. */
  cancelledProposals: string[];
  /** Agent folders whose drawer export was rewritten. */
  reexported: string[];
}

const ID = /^[A-Za-z0-9_.@-]{1,200}$/;

/** True when this user has a forget tombstone for the memory. */
export async function isForgotten(userId: string, memoryId: string): Promise<boolean> {
  return !!(await sql().read(one(`SELECT 1 AS ok FROM memory_versions WHERE user_id = ? AND memory_id = ? AND change = 'forget'`, userId, memoryId)));
}

/**
 * Drawer of a memory of this user: the live row's drawer, else the drawer of
 * its last version (a memory deleted earlier). Null when unknown or already
 * forgotten.
 */
export async function forgettableDrawer(userId: string, memoryId: string): Promise<DrawerRef | null> {
  if (typeof memoryId !== 'string' || !ID.test(memoryId)) return null;
  const live = await getMemoryStorage().getOwned(userId, memoryId);
  if (live) return live.drawer ?? null;
  const last = await sql().read(one<{ drawer_kind: string; drawer_key: string; change: string }>(
    `SELECT drawer_kind, drawer_key, change FROM memory_versions WHERE user_id = ? AND memory_id = ? ORDER BY version DESC LIMIT 1`, userId, memoryId));
  if (!last || last.change === 'forget') return null;
  try { return normalizeDrawer(last.drawer_key ? { kind: last.drawer_kind, key: last.drawer_key } : { kind: last.drawer_kind }); } catch { return null; }
}

/** Tombstones of a user (id, drawer, time, actor only). */
export async function listTombstones(userId: string, limit = 200): Promise<Array<{ memoryId: string; drawerId: string; forgottenAt: string; actor: string }>> {
  const rows = await sql().read(all(`
    SELECT memory_id, drawer_kind, drawer_key, created_at, created_by FROM memory_versions
     WHERE user_id = ? AND change = 'forget' ORDER BY created_at DESC, memory_id LIMIT ?
  `, userId, Math.max(1, Math.min(1000, limit))));
  return rows.map((r) => ({
    memoryId: r.memory_id,
    drawerId: r.drawer_key ? `${r.drawer_kind}:${r.drawer_key}` : r.drawer_kind,
    forgottenAt: r.created_at,
    actor: r.created_by,
  }));
}

function mentions(value: unknown, id: string, texts: string[]): boolean {
  if (typeof value !== 'string') return false;
  if (value.includes(id)) return true;
  return texts.some((t) => t.length >= 3 && value.includes(t));
}

/** Redact a proposal's changes that touch the memory (by id or by its text). */
function redactChanges(changes: any[], id: string, texts: string[]): { changes: any[]; touched: boolean } {
  let touched = false;
  const textSet = new Set(texts);
  const out = changes.map((c) => {
    const hit = c?.id === id || textSet.has(c?.before?.content) || textSet.has(c?.after?.content);
    if (!hit) return c;
    touched = true;
    return { op: c.op, ...(c.id ? { id: c.id } : {}), redacted: true };
  });
  return { changes: out, touched };
}

function* scrubProposals(userId: string, id: string, texts: string[], actor: string): Step<string[]> {
  const d = yield* dialect();
  const cancelled: string[] = [];
  // Locked (PostgreSQL): a decision on one of them waits, or has already won.
  const rows = yield* all<{ id: string; status: string; changes: string }>(
    `SELECT id, status, changes FROM memory_file_proposals WHERE user_id = ? ORDER BY id${forUpdate(d)}`, userId);
  for (const row of rows) {
    if (!mentions(row.changes, id, texts)) continue;
    let changes: any[];
    try { changes = JSON.parse(row.changes); } catch { changes = []; }
    const r = redactChanges(Array.isArray(changes) ? changes : [], id, texts);
    if (!r.touched) continue;
    if (row.status === 'pending') {
      yield* run(`UPDATE memory_file_proposals SET changes = ?, status = 'cancelled', decided_by = ?, decided_at = ${nowIsoText(d)}, note = 'cancelled: a memory it touched was forgotten' WHERE id = ?`,
        JSON.stringify(r.changes), actor, row.id);
      cancelled.push(row.id);
    } else {
      yield* run('UPDATE memory_file_proposals SET changes = ? WHERE id = ?', JSON.stringify(r.changes), row.id);
    }
  }
  return cancelled;
}

function* scrubSummaries(userId: string, id: string, texts: string[]): Step<void> {
  const rows = yield* all<{ id: string; digest: string; text: string; model_text: string | null }>(
    'SELECT id, digest, text, model_text FROM memory_weekly_summaries WHERE user_id = ?', userId);
  const previews = texts.map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 60)).filter((t) => t.length >= 3);
  for (const row of rows) {
    if (!mentions(row.digest, id, previews) && !mentions(row.text, id, previews) && !mentions(row.model_text, id, previews)) continue;
    let digest: WeeklyDigest;
    try { digest = JSON.parse(row.digest); } catch { continue; }
    for (const d of digest.drawers || []) {
      d.items = (d.items || []).filter((i) => i.memoryId !== id && !previews.some((p) => (i.preview || '').includes(p)));
    }
    yield* run('UPDATE memory_weekly_summaries SET digest = ?, text = ?, model_text = NULL, model = NULL WHERE id = ?',
      JSON.stringify(digest), renderDigest(digest), row.id);
  }
}

/** SQLite: remove the memory from the hybrid index file, when one exists on disk. */
async function removeFromIndexFile(id: string): Promise<void> {
  const file = path.resolve(process.cwd(), DEFAULT_MEMORY_CONFIG.dbPath);
  if (!fs.existsSync(file)) return;
  const { getMemoryIndexer } = await import('./indexer.js');
  await getMemoryIndexer().purge(id);
}

function* removeRelated(id: string): Step<void> {
  const d = yield* dialect();
  function* del(table: string, query: string, ...params: string[]): Step<void> {
    if (yield* tableExists(table)) yield* run(query, ...params);
  }
  yield* del('memory_sharing_audit', 'DELETE FROM memory_sharing_audit WHERE memory_id = ?', id);
  yield* del('memory_quality_history', 'DELETE FROM memory_quality_history WHERE memory_id = ?', id);
  yield* del('memory_enrichment_log', 'DELETE FROM memory_enrichment_log WHERE memory_id = ?', id);
  yield* del('memory_relationships', 'DELETE FROM memory_relationships WHERE source_memory_id = ? OR target_memory_id = ?', id, id);
  // PostgreSQL: the hybrid index is in this database, so it goes in this transaction.
  if (d === 'postgres' && (yield* tableExists('memory_index'))) yield* purgePgIndexStep(id);
  // Other memories that list it as related.
  if (yield* columnExists('memories', 'related_memory_ids')) {
    const rows = yield* all<{ id: string; related_memory_ids: string }>(
      `SELECT id, related_memory_ids FROM memories WHERE related_memory_ids ${likeCi(d)} ?`, `%${id}%`);
    for (const r of rows) {
      let list: unknown;
      try { list = JSON.parse(r.related_memory_ids); } catch { list = []; }
      const next = Array.isArray(list) ? list.filter((x) => x !== id) : [];
      yield* run('UPDATE memories SET related_memory_ids = ? WHERE id = ?', JSON.stringify(next), r.id);
    }
  }
}

/** SQLite only: a pragma, best effort (PostgreSQL has none of these). */
async function sqlitePragma(pragma: string): Promise<void> {
  if (sql().dialect !== 'sqlite') return;
  try { await sql().read(one(`PRAGMA ${pragma}`)); } catch { /* not supported / busy: done later */ }
}

/**
 * Forget one memory of this user completely. Works for a live memory and for
 * one that was deleted earlier (its history is then erased). Returns null
 * when the user has no such memory and no history of it.
 */
export async function forgetMemory(userId: string, memoryId: string, actor: string): Promise<ForgetResult | null> {
  if (typeof memoryId !== 'string' || !ID.test(memoryId)) return null;
  const storage = getMemoryStorage();
  const forgottenAt = new Date().toISOString();

  // Freed pages are zeroed so deleted text does not linger in the file (SQLite).
  await sqlitePragma('secure_delete = ON');
  const done = await sql().tx(function* (): Step<{ drawer: DrawerRef; types: string[]; cancelled: string[] } | null> {
    const live = yield* storage.getOwnedStep(userId, memoryId);
    const history = yield* all<{ drawer_kind: string; drawer_key: string; type: string | null; content: string | null; change: string }>(
      `SELECT drawer_kind, drawer_key, type, content, change FROM memory_versions WHERE user_id = ? AND memory_id = ? ORDER BY version`, userId, memoryId);
    if (!live && (history.length === 0 || history.every((h) => h.change === 'forget'))) return null;

    let drawer: DrawerRef;
    if (live?.drawer) drawer = live.drawer;
    else {
      const h = history[history.length - 1];
      try { drawer = normalizeDrawer(h.drawer_key ? { kind: h.drawer_kind, key: h.drawer_key } : { kind: h.drawer_kind }); } catch { drawer = { kind: 'owner' }; }
    }
    const texts = [...new Set([live?.content, ...history.map((h) => h.content)].filter((t): t is string => typeof t === 'string' && t.length > 0))];
    const types = [...new Set([live?.type, ...history.map((h) => h.type)].filter((t): t is string => typeof t === 'string' && !!t))];

    // Lock order (see the header): proposals, memory row, history.
    const cancelled = yield* scrubProposals(userId, memoryId, texts, actor);
    yield* run('DELETE FROM memories WHERE id = ? AND user_id = ?', memoryId, userId);
    yield* lockMemoryHistory(memoryId);
    const revision = yield* drawerRevisionStep(userId, drawer);
    yield* run('DELETE FROM memory_versions WHERE memory_id = ? AND user_id = ?', memoryId, userId);
    yield* run(`
      INSERT INTO memory_versions (id, memory_id, user_id, drawer_kind, drawer_key, drawer_revision, version, change, type, content, importance_score, proposal_id, created_by, created_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'forget', NULL, NULL, NULL, NULL, ?, ?, NULL)
    `, uuidv4(), memoryId, userId, drawer.kind, drawer.key || '', revision, actor, forgottenAt);
    yield* removeRelated(memoryId);
    yield* forgetMemoryGraphStep(userId, memoryId); // CORE-MEM-GRAPH: attachments + orphan links
    yield* scrubSummaries(userId, memoryId, texts);
    return { drawer, types, cancelled };
  });
  if (!done) return null;

  // Outside the database, after the commit: index file (SQLite), readable
  // copies, exports (best effort, but each is attempted; the DB no longer
  // holds the memory).
  let reexported: string[] = [];
  const outside = async () => {
    if (sql().dialect === 'sqlite') {
      try { await removeFromIndexFile(memoryId); } catch (err) { console.warn('[Memory] Index removal failed:', (err as Error).message); }
    }
    for (const type of done.types) {
      await storage.removeMarkdownCopy({ id: memoryId, userId, type: type as MemoryType } as Memory);
    }
    reexported = await exportDrawerFileIfPresent(userId, done.drawer);
    await sqlitePragma('wal_checkpoint(TRUNCATE)');
  };
  if (sql().dialect === 'postgres') await afterPgCommit(outside);
  else await outside();

  return { memoryId, drawerId: drawerId(done.drawer), forgottenAt, actor, cancelledProposals: done.cancelled, reexported };
}

/**
 * Forget every memory of this user, or of one drawer (owner-only API).
 * Also erases the history of memories deleted earlier in that scope.
 */
export async function forgetAll(userId: string, actor: string, drawer?: DrawerRef | null): Promise<{ forgotten: number; results: ForgetResult[] }> {
  const ids = new Set<string>();
  const live = drawer ? await getMemoryStorage().getByDrawers(userId, [drawer]) : await getMemoryStorage().getByUser(userId);
  for (const m of live) ids.add(m.id);
  const hist = drawer
    ? await sql().read(all<{ memory_id: string }>(`SELECT DISTINCT memory_id FROM memory_versions WHERE user_id = ? AND drawer_kind = ? AND drawer_key = ? AND memory_id NOT IN (SELECT memory_id FROM memory_versions WHERE user_id = ? AND change = 'forget') ORDER BY memory_id`, userId, drawer.kind, drawer.key || '', userId))
    : await sql().read(all<{ memory_id: string }>(`SELECT DISTINCT memory_id FROM memory_versions WHERE user_id = ? AND memory_id NOT IN (SELECT memory_id FROM memory_versions WHERE user_id = ? AND change = 'forget') ORDER BY memory_id`, userId, userId));
  for (const r of hist) ids.add(r.memory_id);
  const results: ForgetResult[] = [];
  for (const id of ids) {
    const r = await forgetMemory(userId, id, actor);
    if (r) results.push(r);
  }
  return { forgotten: results.length, results };
}
