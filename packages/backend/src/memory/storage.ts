/**
 * Memory Storage
 *
 * Stores memories in the database (canonical) + markdown files (readable
 * copies). B2.2b-4: the SQL runs as SQL steps (repositories/sql-steps.ts) on
 * the process driver, SQLite or PostgreSQL. Vectors stay JSON text in
 * memories.embedding (a text column on both drivers); similarity and the
 * BM25 lexical score are computed here in JS on both drivers, so recall
 * ranks the same rows the same way on SQLite and PostgreSQL.
 */

import { dataPathOr } from '../config/data-root.js';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { all, columnExists, dialect, lockName, one, run, sql, type Step } from '../repositories/sql-steps.js';
import { LEGACY_HASH_MODEL, getEmbeddingService } from './embedding.js';
import { lexicalTokens } from './text-normalize.js';
import { MIN_RECALL_SCORE, WORKING_LAYER_BOOST, bm25Scores, hybridScore, vectorScore } from './hybrid.js';
import {
  DRAWER_KEY_SQL,
  DRAWER_KIND_SQL,
  backfillMemoryDrawersStep,
  defaultDrawerForType,
  drawerSqlFilter,
  normalizeDrawer,
  type DrawerRef,
} from './drawers.js';
import type {
  Memory,
  MemoryType,
  MemorySearchQuery,
  MemorySearchResult,
  IMemoryStorage
} from './types.js';

/** A single safe path segment: letters, digits, `_`, `-`, `.`, `@`; never `.`/`..`. */
/** At most this many stale vectors are re-embedded during one search. */
export const LAZY_REEMBED_PER_SEARCH = 16;

function isSafeSegment(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.@-]{1,200}$/.test(value) && value !== '.' && value !== '..';
}

/** SQLite only: the legacy runtime DDL of `memories` (PostgreSQL: migrations-pg 040b and later). */
const SQLITE_MEMORIES_DDL = [
  `CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding TEXT,
        memory_layer TEXT DEFAULT 'factual',
        status TEXT DEFAULT 'active',
        metadata TEXT,
        importance_score REAL DEFAULT 0.5,
        tags TEXT,
        created_at TEXT NOT NULL,
        last_accessed_at INTEGER,
        access_count INTEGER DEFAULT 0,
        expiry_timestamp INTEGER,
        consolidation_status TEXT DEFAULT 'pending'
      )`,
  'CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)',
  'CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(memory_layer)',
  'CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance_score)',
];

/** SQLite only: columns added to old databases (normally by the migrations). */
const SQLITE_MEMORIES_COLUMNS: Array<[string, string]> = [
  // Multi-Tier Memory columns
  ['memory_layer', "TEXT DEFAULT 'factual'"],
  ['expiry_timestamp', 'INTEGER'],
  ['consolidation_status', "TEXT DEFAULT 'pending'"],
  ['importance_score', 'REAL DEFAULT 0.5'],
  ['last_accessed_at', 'INTEGER'],
  // CORE-03 drawers (normally added by migration 058)
  ['drawer_kind', 'TEXT'],
  ['drawer_key', 'TEXT'],
  // CORE-06 embedding model per vector (normally added by migration 063)
  ['embedding_model', 'TEXT'],
  ['embedding_dims', 'INTEGER'],
  // CORE-MEM-TOPIC (normally added by migration 096)
  ['topic_key', 'TEXT'],
];

const SQLITE_MEMORIES_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(memory_layer)',
  'CREATE INDEX IF NOT EXISTS idx_memories_expiry ON memories(expiry_timestamp) WHERE expiry_timestamp IS NOT NULL',
  "CREATE INDEX IF NOT EXISTS idx_memories_consolidation ON memories(consolidation_status) WHERE memory_layer = 'experiential'",
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_topic_key ON memories(user_id, drawer_kind, drawer_key, topic_key) WHERE topic_key IS NOT NULL',
];

const UPSERT_COLUMNS = [
  'id', 'user_id', 'type', 'content', 'embedding', 'memory_layer', 'status',
  'metadata', 'importance_score', 'tags', 'created_at', 'last_accessed_at', 'access_count',
  'expiry_timestamp', 'consolidation_status', 'drawer_kind', 'drawer_key',
  'embedding_model', 'embedding_dims',
];

/**
 * Insert or update a memory row. Was INSERT OR REPLACE (SQLite only); an
 * upsert on the id keeps the columns it does not list (sharing, quality)
 * and the rows that reference the memory, and never moves a memory id to
 * another user (`changes` is 0 then). The topic key (CORE-MEM-TOPIC) is set
 * on insert only; an update keeps it (setTopicKeyStep changes it).
 */
const UPSERT_SQL = `
  INSERT INTO memories (${UPSERT_COLUMNS.join(', ')}, topic_key)
  VALUES (${UPSERT_COLUMNS.map(() => '?').join(', ')}, ?)
  ON CONFLICT (id) DO UPDATE SET ${UPSERT_COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}
  WHERE memories.user_id = excluded.user_id`;

/** The topic key is already used by another memory of the drawer (CORE-MEM-TOPIC). */
export class TopicKeyTakenError extends Error {
  constructor(readonly holderId: string) { super('That topic key is already used by another memory in this drawer'); }
}

export class MemoryStorage implements IMemoryStorage {
  private memoryDir: string;

  constructor(memoryDir = dataPathOr('../../.data/memory', 'memory')) {
    this.memoryDir = memoryDir;
  }

  private get embeddingService(): ReturnType<typeof getEmbeddingService> {
    return getEmbeddingService();
  }

  /**
   * Initialize storage (create directories and tables)
   */
  async initialize(): Promise<void> {
    // Create memory directory
    await fs.mkdir(this.memoryDir, { recursive: true });

    // SQLite: the legacy runtime DDL. PostgreSQL: the table and its columns
    // come from migrations-pg (040b, 041, 047, 048, 058, 063).
    if (sql().dialect === 'sqlite') {
      await sql().read(sqliteDdlStep(SQLITE_MEMORIES_DDL));
      try {
        await sql().read(sqliteColumnsStep());
      } catch (err) {
        // Columns already exist or other error, continue
        console.log('[Memory] Migration check completed');
      }
    }

    // CORE-03: rows saved before drawers get the default drawer for their type.
    try {
      await sql().tx(() => backfillMemoryDrawersStep());
    } catch (err) {
      console.warn('[Memory] Drawer backfill failed:', (err as Error).message);
    }
  }

  /**
   * Save a memory to both markdown file and database
   */
  async save(memory: Memory): Promise<void> {
    // Validate the file location first (throws on a bad id/userId/type), so an
    // invalid memory is never written to the database either; then the
    // embedding if not provided.
    await this.ensureEmbedding(memory);

    await sql().read(this.writeRowStep(memory));

    // Save to markdown file
    await this.saveToMarkdown(memory);
  }

  /**
   * Validate the memory's file location and set its embedding when it has
   * none (async work done before a transaction that writes the row).
   */
  async ensureEmbedding(memory: Memory): Promise<void> {
    this.getMarkdownPath(memory);
    if (!memory.embedding) {
      const e = await this.embeddingService.embedDetailed(memory.content);
      memory.embedding = e.vector;
      memory.embeddingModel = e.model;
    }
  }

  /**
   * Embedding for a text (exposed so callers can prepare rows before a
   * database transaction, e.g. applying a reviewed proposal).
   */
  async embed(text: string): Promise<number[]> {
    return this.embeddingService.embed(text);
  }

  /** writeRowStep on the process driver. */
  async writeRow(memory: Memory): Promise<void> {
    await sql().read(this.writeRowStep(memory));
  }

  /**
   * Write (insert or update) the database row of a memory as a SQL step
   * (joins the caller's transaction). The embedding must already be set.
   * The drawer defaults by type (CORE-03). Does not write the per-memory
   * markdown copy (see writeMarkdownCopy).
   */
  *writeRowStep(memory: Memory): Step<void> {
    this.getMarkdownPath(memory);
    if (!memory.embedding) throw new Error('Memory embedding missing');
    const drawer = memory.drawer ? normalizeDrawer(memory.drawer) : defaultDrawerForType(memory.type);
    memory.drawer = drawer;
    // CORE-06: the model of the vector (known for vectors made by the
    // embedding service; anything else is 'unknown' and never compared).
    const embeddingModel = this.embeddingService.modelOf(memory.embedding) ?? memory.embeddingModel ?? 'unknown';
    memory.embeddingModel = embeddingModel;
    // CORE-MEM-TOPIC: a new row may only take a free topic key of its drawer.
    const topicKey = memory.topicKey || null;
    if (topicKey) {
      const holder = yield* this.getByTopicKeyStep(memory.userId, drawer, topicKey, true);
      if (holder && holder.id !== memory.id) throw new TopicKeyTakenError(holder.id);
    }

    const res = yield* run(UPSERT_SQL,
      memory.id,
      memory.userId,
      memory.type,
      memory.content,
      JSON.stringify(memory.embedding),
      memory.memoryLayer || 'factual',
      memory.status || 'active',
      JSON.stringify(memory.metadata),
      memory.importanceScore ?? 0.5,
      memory.tags ? JSON.stringify(memory.tags) : null,
      memory.createdAt.toISOString(),
      memory.lastAccessedAt || null,
      memory.accessCount ?? 0,
      memory.expiryTimestamp || null,
      memory.consolidationStatus || 'pending',
      drawer.kind,
      drawer.key || '',
      embeddingModel,
      memory.embedding.length,
      topicKey,
    );
    if (res.changes !== 1) throw new Error('Memory id belongs to another user');
  }

  /** Write the per-memory markdown copy (human-readable, not canonical). */
  async writeMarkdownCopy(memory: Memory): Promise<void> {
    await this.saveToMarkdown(memory);
  }

  /** Remove the per-memory markdown copy, if any. */
  async removeMarkdownCopy(memory: Memory): Promise<void> {
    try {
      await fs.unlink(this.getMarkdownPath(memory));
    } catch {
      // missing file or legacy row with an unsafe id/type
    }
  }

  /**
   * Memories of one user in the given drawers (no access-count side effect),
   * oldest first. CORE-03/04.
   */
  async getByDrawers(userId: string, drawers: DrawerRef[]): Promise<Memory[]> {
    return sql().read(this.getByDrawersStep(userId, drawers));
  }

  /**
   * getByDrawers as a SQL step (joins the caller's transaction); `lock`
   * takes the rows' locks on PostgreSQL (FOR UPDATE, inside a transaction).
   */
  *getByDrawersStep(userId: string, drawers: DrawerRef[], lock = false): Step<Memory[]> {
    const d = yield* dialect();
    const filter = drawerSqlFilter(drawers);
    const rows = yield* all(
      `SELECT * FROM memories WHERE user_id = ? AND ${filter.sql} ORDER BY created_at ASC, id ASC${lock && d === 'postgres' ? ' FOR UPDATE' : ''}`,
      userId, ...filter.params,
    );
    return rows.map((row) => this.rowToMemory(row));
  }

  /** The memory of this user + drawer with this topic key, or null (CORE-MEM-TOPIC). */
  async getByTopicKey(userId: string, drawer: DrawerRef, topicKey: string): Promise<Memory | null> {
    return sql().read(this.getByTopicKeyStep(userId, drawer, topicKey));
  }

  /**
   * getByTopicKey as a SQL step. `lock` serializes writers of one topic on
   * PostgreSQL (a transaction lock on the key, then FOR UPDATE on the row).
   */
  *getByTopicKeyStep(userId: string, drawer: DrawerRef, topicKey: string, lock = false): Step<Memory | null> {
    const d = normalizeDrawer(drawer);
    const dl = yield* dialect();
    if (lock) yield* lockName(`memory-topic:${userId}:${d.kind}:${d.key || ''}:${topicKey}`);
    const row = yield* one(
      `SELECT * FROM memories WHERE user_id = ? AND drawer_kind = ? AND drawer_key = ? AND topic_key = ?${lock && dl === 'postgres' ? ' FOR UPDATE' : ''}`,
      userId, d.kind, d.key || '', topicKey,
    );
    return row ? this.rowToMemory(row) : null;
  }

  /**
   * Set or clear a memory's topic key (SQL step). Throws TopicKeyTakenError
   * when another memory of its drawer holds the key. False when the memory
   * is not this user's.
   */
  *setTopicKeyStep(userId: string, id: string, topicKey: string | null): Step<boolean> {
    const m = yield* this.getOwnedStep(userId, id, true);
    if (!m) return false;
    if (topicKey) {
      const holder = yield* this.getByTopicKeyStep(userId, m.drawer!, topicKey, true);
      if (holder && holder.id !== id) throw new TopicKeyTakenError(holder.id);
    }
    const res = yield* run('UPDATE memories SET topic_key = ? WHERE id = ? AND user_id = ?', topicKey, id, userId);
    return res.changes === 1;
  }

  /** The user's drawers that hold memories, with counts. */
  async listDrawers(userId: string): Promise<Array<DrawerRef & { count: number }>> {
    return sql().read(listDrawersStep(userId));
  }

  /** A memory of this user by id, without the access-count side effect (or null). */
  async getOwned(userId: string, id: string): Promise<Memory | null> {
    return sql().read(this.getOwnedStep(userId, id));
  }

  /** getOwned as a SQL step; `lock` takes the row lock on PostgreSQL (inside a transaction). */
  *getOwnedStep(userId: string, id: string, lock = false): Step<Memory | null> {
    if (typeof id !== 'string' || !id) return null;
    const d = yield* dialect();
    const row = yield* one(`SELECT * FROM memories WHERE id = ? AND user_id = ?${lock && d === 'postgres' ? ' FOR UPDATE' : ''}`, id, userId);
    return row ? this.rowToMemory(row) : null;
  }

  /**
   * Get a memory by ID
   */
  async get(id: string): Promise<Memory | null> {
    const row = await sql().read(one('SELECT * FROM memories WHERE id = ?', id));

    if (!row) return null;

    // Update access tracking
    await sql().read(run(`
      UPDATE memories
      SET last_accessed_at = ?, access_count = access_count + 1
      WHERE id = ?
    `, Date.now(), id));

    return this.rowToMemory(row);
  }

  /**
   * Get all memories for a user (with optional layer filter)
   */
  async getByUser(userId: string, layer?: string): Promise<Memory[]> {
    let query = `
      SELECT * FROM memories
      WHERE user_id = ?
    `;
    const params: any[] = [userId];

    if (layer) {
      query += ' AND memory_layer = ?';
      params.push(layer);
    }

    query += ' ORDER BY importance_score DESC, created_at DESC';

    const rows = await sql().read(all(query, ...params));
    return rows.map(row => this.rowToMemory(row));
  }

  /**
   * Delete a memory
   */
  async delete(id: string): Promise<void> {
    const memory = await this.get(id);
    if (!memory) return;

    // Delete from database
    await sql().read(run('DELETE FROM memories WHERE id = ?', id));

    // Delete markdown file (a legacy row with an unsafe id/type has no valid file path)
    try {
      await fs.unlink(this.getMarkdownPath(memory));
    } catch (err) {
      // File might not exist, ignore
    }
  }

  /**
   * Update a memory
   */
  async update(id: string, updates: Partial<Memory>): Promise<void> {
    const memory = await this.get(id);
    if (!memory) throw new Error(`Memory ${id} not found`);

    // Identity fields never change through an update.
    const updated = { ...memory, ...updates, id: memory.id, userId: memory.userId };
    let oldPath: string | null = null;
    try { oldPath = this.getMarkdownPath(memory); } catch { /* legacy row with an unsafe type */ }

    // Regenerate embedding if content changed
    if (updates.content) {
      const e = await this.embeddingService.embedDetailed(updated.content);
      updated.embedding = e.vector;
      updated.embeddingModel = e.model;
    }

    await this.save(updated);

    // A type change renames the markdown file: drop the old one.
    const newPath = this.getMarkdownPath(updated);
    if (oldPath && newPath !== oldPath) {
      await fs.unlink(oldPath).catch(() => { /* may not exist */ });
    }
  }

  /**
   * Hybrid search (CORE-06): BM25 over normalized tokens + cosine of vectors
   * of the same model (memory/hybrid.ts). Only the user's rows in the given
   * drawers are read. Rows whose vector is of another model than the
   * preferred one are re-embedded here (at most LAZY_REEMBED_PER_SEARCH per
   * search) when the preferred model is answering.
   */
  async search(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    const q = await this.embeddingService.embedQuery(query.query);

    // Ordered by (created_at, id) so equal scores keep one order on both drivers.
    let where = 'SELECT * FROM memories WHERE user_id = ?';
    const params: any[] = [query.userId];

    if (query.type) {
      where += ' AND type = ?';
      params.push(query.type);
    }

    if (query.layer) {
      where += ' AND memory_layer = ?';
      params.push(query.layer);
    }

    // CORE-03: only the selected drawers ([] selects nothing).
    if (query.drawers) {
      const filter = drawerSqlFilter(query.drawers);
      where += ` AND ${filter.sql}`;
      params.push(...filter.params);
    }

    // Support both legacy minImportance (1-10) and new minImportanceScore (0-1)
    if (query.minImportanceScore !== undefined) {
      where += ' AND importance_score >= ?';
      params.push(query.minImportanceScore);
    } else if (query.minImportance !== undefined) {
      // Convert legacy 1-10 scale to 0-1 scale
      where += ' AND importance_score >= ?';
      params.push(query.minImportance / 10);
    }

    const rows = await sql().read(all(`${where} ORDER BY created_at ASC, id ASC`, ...params));
    const memories = rows.map((row) => this.rowToMemory(row));
    if (q.model === this.embeddingService.targetModel()) await this.reembedStale(memories, q.model);

    const lexical = bm25Scores(lexicalTokens(query.query), memories.map((m) => lexicalTokens(m.content)));
    const results: MemorySearchResult[] = memories
      .map((memory, i) => {
        const comparable = memory.embedding && memory.embeddingModel === q.model && memory.embedding.length === q.dims;
        // A hash cosine without any lexical match is a bucket collision, not similarity.
        const vector = comparable && (q.semantic || lexical[i] > 0)
          ? vectorScore(this.embeddingService.similarity(q.vector, memory.embedding!), q.semantic)
          : null;
        let similarity = hybridScore(vector, lexical[i], q.semantic);
        if (similarity >= MIN_RECALL_SCORE && memory.memoryLayer === 'working') similarity += WORKING_LAYER_BOOST;
        return {
          memory,
          similarity,
          scoreBreakdown: { vectorScore: vector ?? 0, keywordScore: lexical[i], recencyScore: 0, importanceScore: memory.importanceScore ?? 0.5 },
        };
      })
      .filter((r) => r.similarity >= MIN_RECALL_SCORE)
      .sort((a, b) => b.similarity - a.similarity);

    return results.slice(0, query.limit || 10);
  }

  /** Re-embed up to LAZY_REEMBED_PER_SEARCH memories whose vector is not of `model`. */
  private async reembedStale(memories: Memory[], model: string): Promise<void> {
    const stale = memories.filter((m) => m.embeddingModel !== model).slice(0, LAZY_REEMBED_PER_SEARCH);
    if (stale.length === 0) return;
    const fresh = await this.embeddingService.embedManyDetailed(stale.map((m) => m.content));
    for (const [i, m] of stale.entries()) {
      const e = fresh[i];
      if (e.model !== model) continue; // provider fell back meanwhile: keep the old vector
      if (await this.setEmbedding(m.userId, m.id, m.content, e.vector, e.model)) {
        m.embedding = e.vector;
        m.embeddingModel = e.model;
      }
    }
  }

  /**
   * Store a new vector for a memory if its content is still `content`
   * (a concurrent edit wins). True when written.
   */
  async setEmbedding(userId: string, id: string, content: string, vector: number[], model: string): Promise<boolean> {
    const res = await sql().read(run(
      'UPDATE memories SET embedding = ?, embedding_model = ?, embedding_dims = ? WHERE id = ? AND user_id = ? AND content = ?',
      JSON.stringify(vector), model, vector.length, id, userId, content,
    ));
    return res.changes === 1;
  }

  /**
   * Save memory to markdown file
   */
  private async saveToMarkdown(memory: Memory): Promise<void> {
    const filePath = this.getMarkdownPath(memory);

    // Create directory for user if needed
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // Generate markdown content
    const content = `---
id: ${memory.id}
type: ${memory.type}
layer: ${memory.memoryLayer || 'factual'}
importance_score: ${memory.importanceScore ?? 0.5}
consolidation_status: ${memory.consolidationStatus || 'pending'}
created: ${memory.createdAt.toISOString()}
accessed: ${memory.lastAccessedAt ? new Date(memory.lastAccessedAt).toISOString() : 'never'}
access_count: ${memory.accessCount ?? 0}
expiry: ${memory.expiryTimestamp ? new Date(memory.expiryTimestamp).toISOString() : 'permanent'}
---

# ${this.getMemoryTitle(memory)}

${memory.content}

## Metadata

\`\`\`json
${JSON.stringify(memory.metadata, null, 2)}
\`\`\`
`;

    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Get markdown file path for a memory
   */
  private getMarkdownPath(memory: Memory): string {
    // SECURITY: userId, id and type become path segments. Only plain names are
    // accepted, and the resolved path must stay inside <memoryDir>/<userId>.
    if (!isSafeSegment(memory.userId) || !isSafeSegment(memory.id)) {
      throw new Error('Invalid memory id or user id');
    }
    // Not limited to MEMORY_TYPES here: the memory_save tool also stores
    // 'conversation'/'goal'. The API routes accept only MEMORY_TYPES.
    if (typeof memory.type !== 'string' || !/^[a-z][a-z_-]{0,31}$/.test(memory.type)) {
      throw new Error('Invalid memory type');
    }
    const root = path.resolve(this.memoryDir);
    const userDir = path.resolve(root, memory.userId);
    const filePath = path.resolve(userDir, `${memory.type}-${memory.id}.md`);
    if (path.dirname(userDir) !== root || path.dirname(filePath) !== userDir) {
      throw new Error('Memory path escapes the memory directory');
    }
    return filePath;
  }

  /**
   * Get title for memory
   */
  private getMemoryTitle(memory: Memory): string {
    const preview = memory.content.slice(0, 50);
    return preview + (memory.content.length > 50 ? '...' : '');
  }

  /**
   * Convert database row to Memory object
   */
  private rowToMemory(row: any): Memory {
    return {
      id: row.id,
      userId: row.user_id,
      type: row.type as MemoryType,
      content: row.content,
      embedding: row.embedding ? JSON.parse(row.embedding) : undefined,
      embeddingModel: row.embedding ? (row.embedding_model || LEGACY_HASH_MODEL) : undefined,
      memoryLayer: row.memory_layer || 'factual',
      importanceScore: row.importance_score ?? 0.5,
      status: row.status || 'active',
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      createdAt: new Date(row.created_at),
      lastAccessedAt: row.last_accessed_at || null,
      accessCount: row.access_count ?? 0,
      tags: row.tags ? JSON.parse(row.tags) : [],
      expiryTimestamp: row.expiry_timestamp || null,
      consolidationStatus: row.consolidation_status || 'pending',
      drawer: rowDrawer(row),
      topicKey: row.topic_key ?? null,
    };
  }
}

/** The user's drawers that hold memories, with counts (SQL step). */
export function* listDrawersStep(userId: string): Step<Array<DrawerRef & { count: number }>> {
  const rows = yield* all<{ kind: DrawerRef['kind']; key: string; count: number }>(
    `SELECT ${DRAWER_KIND_SQL} AS kind, ${DRAWER_KEY_SQL} AS key, COUNT(*) AS count
       FROM memories WHERE user_id = ? GROUP BY 1, 2 ORDER BY 1, 2`,
    userId,
  );
  return rows.map((r) => (r.key ? { kind: r.kind, key: r.key, count: r.count } : { kind: r.kind, count: r.count }));
}

/** SQLite only: run DDL statements one by one. */
function* sqliteDdlStep(statements: readonly string[]): Step<void> {
  for (const stmt of statements) yield* run(stmt);
}

/** SQLite only: add the columns an old memories table lacks, then their indexes. */
function* sqliteColumnsStep(): Step<void> {
  for (const [name, type] of SQLITE_MEMORIES_COLUMNS) {
    if (!(yield* columnExists('memories', name))) yield* run(`ALTER TABLE memories ADD COLUMN ${name} ${type}`);
  }
  yield* sqliteDdlStep(SQLITE_MEMORIES_INDEXES);
}

function rowDrawer(row: any): DrawerRef {
  if (row.drawer_kind) {
    try {
      return normalizeDrawer(row.drawer_key ? { kind: row.drawer_kind, key: row.drawer_key } : { kind: row.drawer_kind });
    } catch {
      // unknown stored value: fall through to the type default
    }
  }
  return defaultDrawerForType(row.type);
}

// Singleton instance
let memoryStorage: MemoryStorage | null = null;

export function getMemoryStorage(): MemoryStorage {
  if (!memoryStorage) {
    memoryStorage = new MemoryStorage();
  }
  return memoryStorage;
}
