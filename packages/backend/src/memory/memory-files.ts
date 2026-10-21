import { readRegularFile, FileReadError } from '../services/read-regular-file.js';
/**
 * Memory files (CORE-04): the database is canonical; every drawer can be
 * exported as a readable Markdown file, and an edited file comes back only
 * as a reviewed proposal.
 *
 *   export   DB -> <agent dir>/memory/<userId>/<drawer>.md (generated header)
 *   propose  edited text (uploaded, or read from the exported file when the
 *            owner asks for it) -> diff against the DB -> pending proposal
 *   approve  applies the diff in one transaction as a new drawer revision,
 *            with per-memory history in memory_versions; re-exports the file
 *   reject   nothing changes
 *
 * B2.2b-4: the database work is SQL steps (repositories/sql-steps.ts), so
 * one copy runs on SQLite and PostgreSQL. A decision locks the proposal row
 * (FOR UPDATE on PostgreSQL) and claims it with a conditional UPDATE: of two
 * decisions at the same time exactly one wins, the other gets 409
 * `already_decided` and writes nothing. The drawer's next revision is taken
 * under a per-drawer transaction lock (lockName), so two approvals of one
 * drawer never share a revision number.
 *
 * Nothing watches the files: a file edit never reaches the database unless
 * the owner submits it and approves the resulting proposal.
 *
 * File format (one block per memory):
 *
 *   ### m:<memory id> | <type> | importance <1-10>
 *   <content lines>
 *
 * New entries use `### new | <type> | importance <n>` (type and importance
 * optional: fact / 5). A removed block deletes that memory. Content lines
 * that start with `###` are written with a leading backslash.
 */

import { dataPath } from '../config/data-root.js';
import { isoUtc } from '../api/timestamps.js';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { all, dialect, lockName, one, run, sql, type Step } from '../repositories/sql-steps.js';
import { forUpdate, nowIsoText } from '../db/pg/dialect.js';
import { getMemoryStorage } from './storage.js';
import { drawerRevisionStep, lastVersionStep, lockMemoryHistory } from './versions.js';
import { isMemoryType, type Memory, type MemoryType, type ImportanceLevel, type MultiTierLayer } from './types.js';
import { drawerId, normalizeDrawer, parseDrawerId, type DrawerRef } from './drawers.js';

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_CHANGES = 500;
const MAX_ENTRY = 50_000;
const SAFE_SEGMENT = /^[A-Za-z0-9_.@-]{1,200}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MEMORY_ID = /^[A-Za-z0-9_.@-]{1,200}$/;
const OTHER_TYPE = /^[a-z][a-z_-]{0,31}$/;

/** Machine codes on decision errors (UI-IP-04): `already_decided`, `stale`, `review_changed`, `review_hash_required`. */
export type MemoryFileErrorCode = 'already_decided' | 'stale' | 'review_changed' | 'review_hash_required';

export class MemoryFileError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400, readonly code?: MemoryFileErrorCode) { super(message); }
}

interface Entry { type: string; importance: number; content: string }
export type MemoryChange =
  /** `topicKey` (CORE-MEM-TOPIC): the new memory takes this key of its drawer. */
  | { op: 'add'; after: Entry; topicKey?: string }
  | { op: 'update'; id: string; before: Entry; after: Entry }
  | { op: 'delete'; id: string; before: Entry };

export interface MemoryProposal {
  id: string;
  userId: string;
  agentId: string;
  drawer: DrawerRef;
  drawerId: string;
  baseHash: string;
  baseRevision: number;
  changes: MemoryChange[];
  status: 'pending' | 'approved' | 'rejected' | 'stale' | 'cancelled';
  /** upload/file: edited export (CORE-04); learning/agent: important learned item or agent change (CORE-05); import: imported text (CLI-02). */
  source: 'upload' | 'file' | 'learning' | 'agent' | 'import';
  note: string | null;
  createdBy: string;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  appliedRevision: number | null;
  /** Why it needs review (learning/agent proposals), e.g. ["people", "money"]. */
  reasons: string[];
  /** Import batch that created it (CLI-02), else null. */
  importBatchId: string | null;
  /**
   * CORE-MEM-CONFLICT: the existing memory this proposal's new text
   * contradicts (its one change is an update of that memory), else null.
   */
  conflictWith: string | null;
  /** How a conflict proposal was decided (keep_new / keep_old / keep_both), else null. */
  decision: ConflictDecision | null;
  /**
   * sha256 of the reviewed content (proposal id, drawer, base revision, base
   * hash, source, changes). Approve/reject must send it back as
   * `expectedReviewHash`, so a decision only applies to what was shown.
   */
  reviewHash: string;
}

/** The owner's choices for a conflict proposal (CORE-MEM-CONFLICT). */
export const CONFLICT_DECISIONS = ['keep_new', 'keep_old', 'keep_both'] as const;
export type ConflictDecision = typeof CONFLICT_DECISIONS[number];

export function isConflictDecision(value: unknown): value is ConflictDecision {
  return typeof value === 'string' && (CONFLICT_DECISIONS as readonly string[]).includes(value);
}

/** Proposals reviewed against the whole drawer (hash) vs. against each changed memory. */
export function isFileProposal(p: Pick<MemoryProposal, 'source'>): boolean {
  return p.source === 'upload' || p.source === 'file';
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function agentsRoot(): string {
  return dataPath('agents');
}

export function isValidAgentId(id: unknown): id is string {
  return typeof id === 'string' && AGENT_ID.test(id) && !id.includes('..');
}

/** The agent the files belong to: the given one if it exists, else the primary agent. */
export function resolveFileAgent(requested?: unknown): Promise<string> {
  return sql().read(resolveFileAgentStep(requested));
}

export function* resolveFileAgentStep(requested?: unknown): Step<string> {
  if (requested !== undefined && requested !== null && requested !== '') {
    if (!isValidAgentId(requested)) throw new MemoryFileError('Invalid agent id');
    const row = yield* one<{ id: string }>('SELECT id FROM agents_config WHERE id = ?', requested);
    if (!row) throw new MemoryFileError('Agent not found', 404);
    return row.id;
  }
  const row = (yield* one<{ id: string }>('SELECT id FROM agents_config WHERE is_primary = 1 ORDER BY id LIMIT 1'))
    ?? (yield* one<{ id: string }>('SELECT id FROM agents_config ORDER BY id LIMIT 1'));
  if (!row || !isValidAgentId(row.id)) throw new MemoryFileError('No agent to export memory for', 404);
  return row.id;
}

/** `owner.md`, `experience.md`, `project--alpha.md`, `people--p-42.md` ... */
export function drawerFileName(drawer: DrawerRef): string {
  const d = normalizeDrawer(drawer);
  return d.key ? `${d.kind}--${d.key}.md` : `${d.kind}.md`;
}

/**
 * Absolute path of a drawer's export file. Every part is a validated plain
 * segment and the result must stay inside <cwd>/.data/agents/<agent>/memory/<user>
 * (never under public/).
 */
export function drawerFilePath(agentId: string, userId: string, drawer: DrawerRef): string {
  if (!isValidAgentId(agentId)) throw new MemoryFileError('Invalid agent id');
  if (!SAFE_SEGMENT.test(userId) || userId === '.' || userId === '..') throw new MemoryFileError('Invalid user id');
  const root = agentsRoot();
  const userDir = path.resolve(root, agentId, 'memory', userId);
  const file = path.resolve(userDir, drawerFileName(drawer));
  if (path.dirname(file) !== userDir || !userDir.startsWith(root + path.sep)) {
    throw new MemoryFileError('Memory file path escapes the agent folder');
  }
  if (file.split(path.sep).includes('public')) throw new MemoryFileError('Memory files never live under public/');
  return file;
}

/** Path relative to the backend working directory (for API answers; no absolute paths). */
export function displayPath(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Render / parse
// ---------------------------------------------------------------------------

function importanceOf(m: Memory): number {
  const score = typeof m.importanceScore === 'number' ? m.importanceScore : 0.5;
  return Math.min(10, Math.max(1, Math.round(score * 10)));
}

function entryOf(m: Memory): Entry {
  return { type: m.type, importance: importanceOf(m), content: m.content };
}

function escapeContent(content: string): string {
  return content.split('\n').map((l) => (/^\\*###/.test(l) ? `\\${l}` : l)).join('\n');
}

function unescapeLine(line: string): string {
  return /^\\+###/.test(line) ? line.slice(1) : line;
}

function renderBlocks(memories: Memory[]): string {
  return memories.map((m) => {
    const e = entryOf(m);
    return `### m:${m.id} | ${e.type} | importance ${e.importance}\n${escapeContent(e.content)}\n`;
  }).join('\n');
}

/** Hash of a drawer's canonical content (ids, types, importance, text). */
export function drawerHash(memories: Memory[]): string {
  const h = createHash('sha256');
  for (const m of memories) {
    const e = entryOf(m);
    h.update(JSON.stringify([m.id, e.type, e.importance, e.content]));
    h.update('\n');
  }
  return h.digest('hex');
}

const HEADER_TAG = '<!-- agent-player:memory-export v1 -->';

function title(drawer: DrawerRef): string {
  switch (drawer.kind) {
    case 'owner': return 'About the owner';
    case 'experience': return 'Experience';
    case 'project': return `Project ${drawer.key}`;
    case 'task': return `Task ${drawer.key}`;
    case 'people': return `Person ${drawer.key}`;
  }
}

export function renderDrawerFile(drawer: DrawerRef, memories: Memory[], revision: number, exportedAt = new Date()): string {
  const id = drawerId(drawer);
  return [
    HEADER_TAG,
    '<!-- GENERATED FILE. The database is the canonical memory; this file is a readable copy of one drawer. -->',
    '<!-- Saving this file changes nothing by itself. Submit it for review (POST /api/memory/files/' + id + '/proposal); only an approved proposal is applied, as a new version. -->',
    `<!-- drawer: ${id} | revision: ${revision} | base: ${drawerHash(memories)} | exported: ${exportedAt.toISOString()} -->`,
    '',
    `# Memory: ${title(drawer)}`,
    '',
    'Edit, add or remove entries below. A new entry starts with a line like "### new | fact | importance 5".',
    '',
    renderBlocks(memories),
  ].join('\n');
}

interface ParsedFile {
  drawer: string;
  baseHash: string;
  entries: Array<{ id: string | null; type: string | null; importance: number | null; content: string; line: number }>;
}

const HEADING = /^###\s+(?:m:(\S+)|new)\s*(?:\|\s*([a-z][a-z_-]{0,31})\s*)?(?:\|\s*importance\s+(\d{1,2})\s*)?$/;

export function parseDrawerFile(text: string): ParsedFile {
  if (typeof text !== 'string') throw new MemoryFileError('File content must be text');
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new MemoryFileError('File is too large');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (!lines.some((l) => l.trim() === HEADER_TAG)) throw new MemoryFileError('Not a memory export file (header missing)');
  const meta = lines.map((l) => /^<!-- drawer: (\S+) \| revision: \d+ \| base: ([0-9a-f]{64}) \| exported: [^ ]+ -->$/.exec(l.trim())).find(Boolean);
  if (!meta) throw new MemoryFileError('Not a memory export file (drawer line missing)');

  const entries: ParsedFile['entries'] = [];
  let current: { id: string | null; type: string | null; importance: number | null; body: string[]; line: number } | null = null;
  const flush = () => {
    if (!current) return;
    const content = current.body.map(unescapeLine).join('\n').replace(/^\n+|\n+$/g, '');
    entries.push({ id: current.id, type: current.type, importance: current.importance, content, line: current.line });
  };
  lines.forEach((line, i) => {
    if (line.startsWith('###')) {
      const m = HEADING.exec(line.trim());
      if (!m) throw new MemoryFileError(`Line ${i + 1}: entry heading not understood`);
      flush();
      current = { id: m[1] ?? null, type: m[2] ?? null, importance: m[3] ? Number(m[3]) : null, body: [], line: i + 1 };
    } else if (current) {
      current.body.push(line);
    }
  });
  flush();
  return { drawer: meta[1], baseHash: meta[2], entries };
}

/** Diff an edited file against the drawer's current memories. */
export function diffDrawer(current: Memory[], parsed: ParsedFile): MemoryChange[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const changes: MemoryChange[] = [];
  for (const e of parsed.entries) {
    if (e.importance !== null && (e.importance < 1 || e.importance > 10)) throw new MemoryFileError(`Line ${e.line}: importance must be 1-10`);
    if (!e.content.trim()) throw new MemoryFileError(`Line ${e.line}: entry is empty (remove the whole block to delete it)`);
    if (e.content.length > MAX_ENTRY) throw new MemoryFileError(`Line ${e.line}: entry is too long`);
    if (e.id === null) {
      const type = e.type ?? 'fact';
      if (!isMemoryType(type)) throw new MemoryFileError(`Line ${e.line}: unknown memory type`);
      changes.push({ op: 'add', after: { type, importance: e.importance ?? 5, content: e.content } });
      continue;
    }
    if (!MEMORY_ID.test(e.id)) throw new MemoryFileError(`Line ${e.line}: invalid memory id`);
    const mem = byId.get(e.id);
    // Only memories of this drawer (and this user) can be edited from its file.
    if (!mem) throw new MemoryFileError(`Line ${e.line}: memory m:${e.id} is not in this drawer`);
    if (seen.has(e.id)) throw new MemoryFileError(`Line ${e.line}: memory m:${e.id} appears twice`);
    seen.add(e.id);
    const before = entryOf(mem);
    const type = e.type ?? before.type;
    if (type !== before.type && !isMemoryType(type)) throw new MemoryFileError(`Line ${e.line}: unknown memory type`);
    if (!isMemoryType(type) && !OTHER_TYPE.test(type)) throw new MemoryFileError(`Line ${e.line}: unknown memory type`);
    const after: Entry = { type, importance: e.importance ?? before.importance, content: e.content };
    if (after.type !== before.type || after.importance !== before.importance || after.content !== before.content) {
      changes.push({ op: 'update', id: e.id, before, after });
    }
  }
  for (const m of current) {
    if (!seen.has(m.id)) changes.push({ op: 'delete', id: m.id, before: entryOf(m) });
  }
  if (changes.length > MAX_CHANGES) throw new MemoryFileError('Too many changes in one proposal');
  return changes;
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

export function drawerRevision(userId: string, drawer: DrawerRef): Promise<number> {
  return sql().read(drawerRevisionStep(userId, drawer));
}

function currentMemories(userId: string, drawer: DrawerRef): Step<Memory[]> {
  return getMemoryStorage().getByDrawersStep(userId, [drawer]);
}

/**
 * Transaction lock for one drawer of one user (PostgreSQL): a change that
 * reads the drawer's content or revision and then writes runs alone.
 */
function* lockDrawer(userId: string, drawer: DrawerRef): Step<void> {
  yield* lockName(`memory-drawer:${userId}:${drawerId(drawer)}`);
}

export interface DrawerFileView {
  drawer: DrawerRef;
  drawerId: string;
  agentId: string;
  revision: number;
  hash: string;
  count: number;
  path: string;
  content: string;
}

/** The export text of a drawer (no write). */
export function viewDrawerFile(userId: string, agentId: string, drawer: DrawerRef): Promise<DrawerFileView> {
  return sql().read(viewDrawerFileStep(userId, agentId, drawer));
}

function* viewDrawerFileStep(userId: string, agentId: string, drawer: DrawerRef): Step<DrawerFileView> {
  const d = normalizeDrawer(drawer);
  const memories = yield* currentMemories(userId, d);
  const revision = yield* drawerRevisionStep(userId, d);
  return {
    drawer: d, drawerId: drawerId(d), agentId, revision, hash: drawerHash(memories), count: memories.length,
    path: displayPath(drawerFilePath(agentId, userId, d)),
    content: renderDrawerFile(d, memories, revision),
  };
}

async function refuseNonRegular(file: string): Promise<boolean> {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile()) throw new MemoryFileError('The memory file path is not a regular file', 409);
    return true;
  } catch (err: any) {
    if (err instanceof MemoryFileError) throw err;
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

/** Write a drawer's export file (DB -> file only). */
export async function exportDrawerFile(userId: string, agentId: string, drawer: DrawerRef): Promise<DrawerFileView> {
  const view = await viewDrawerFile(userId, agentId, drawer);
  const file = drawerFilePath(agentId, userId, view.drawer);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await refuseNonRegular(file);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, view.content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  await fs.rename(tmp, file);
  return view;
}

/**
 * Re-export a drawer in every agent folder where its file already exists, so
 * exported copies follow the database after a direct change (CORE-05/07).
 * Best effort: the database stays canonical. Returns the agents re-exported.
 */
export async function exportDrawerFileIfPresent(userId: string, drawer: DrawerRef): Promise<string[]> {
  const done: string[] = [];
  let agents: string[] = [];
  try { agents = await fs.readdir(agentsRoot()); } catch { return done; }
  for (const agentId of agents) {
    if (!isValidAgentId(agentId)) continue;
    let file: string;
    try { file = drawerFilePath(agentId, userId, drawer); } catch { continue; }
    try {
      const st = await fs.lstat(file);
      if (!st.isFile()) continue;
    } catch { continue; }
    try { await exportDrawerFile(userId, agentId, drawer); done.push(agentId); } catch { /* re-export later */ }
  }
  return done;
}

/** Read the exported file of a drawer as it is on disk (owner edited it). */
export async function readDrawerFile(userId: string, agentId: string, drawer: DrawerRef): Promise<string> {
  const file = drawerFilePath(agentId, userId, drawer);
  if (!(await refuseNonRegular(file))) throw new MemoryFileError('This drawer has not been exported yet', 404);
  try {
    const { data } = await readRegularFile(file, MAX_FILE_BYTES, { root: path.dirname(file) });
    return data.toString('utf8');
  } catch (error) {
    if (error instanceof FileReadError) throw new MemoryFileError(error.message);
    throw error;
  }
}

/** Canonical hash of what a reviewer sees in a proposal (see MemoryProposal.reviewHash). */
export function proposalReviewHash(p: Pick<MemoryProposal, 'id' | 'drawerId' | 'baseRevision' | 'baseHash' | 'source' | 'changes'>): string {
  return createHash('sha256')
    .update(JSON.stringify(['memory-proposal-review/v1', p.id, p.drawerId, p.baseRevision, p.baseHash, p.source, p.changes]))
    .digest('hex');
}

function rowToProposal(row: any): MemoryProposal {
  const drawer = normalizeDrawer(row.drawer_key ? { kind: row.drawer_kind, key: row.drawer_key } : { kind: row.drawer_kind });
  const changes: MemoryChange[] = JSON.parse(row.changes);
  const reviewHash = proposalReviewHash({
    id: row.id, drawerId: drawerId(drawer), baseRevision: row.base_revision, baseHash: row.base_hash, source: row.source, changes,
  });
  return {
    id: row.id, userId: row.user_id, agentId: row.agent_id, drawer, drawerId: drawerId(drawer),
    baseHash: row.base_hash, baseRevision: row.base_revision, changes,
    status: row.status, source: row.source, note: row.note ?? null,
    // BE-UI-01: ISO-8601 UTC with Z for the API.
    createdBy: row.created_by, createdAt: isoUtc(row.created_at) as string,
    decidedBy: row.decided_by ?? null, decidedAt: isoUtc(row.decided_at), appliedRevision: row.applied_revision ?? null,
    reasons: parseReasons(row.reasons),
    importBatchId: row.import_batch_id ?? null,
    conflictWith: row.conflict_with ?? null,
    decision: isConflictDecision(row.decision) ? row.decision : null,
    reviewHash,
  };
}

function parseReasons(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const list = JSON.parse(value);
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

/** Pending proposals per user before new learning/agent proposals are refused. */
export const MAX_PENDING_PROPOSALS = 200;

export function pendingProposalCount(userId: string): Promise<number> {
  return sql().read(pendingProposalCountStep(userId));
}

export function* pendingProposalCountStep(userId: string): Step<number> {
  const row = yield* one<{ n: number }>(`SELECT COUNT(*) AS n FROM memory_file_proposals WHERE user_id = ? AND status = 'pending'`, userId);
  return row?.n ?? 0;
}

/**
 * Transaction lock for a user's proposal queue (PostgreSQL), so two writers
 * cannot both pass the MAX_PENDING_PROPOSALS check.
 */
export function* lockProposalQueue(userId: string): Step<void> {
  yield* lockName(`memory-proposals:${userId}`);
}

/**
 * Create a pending proposal from explicit changes (CORE-05: an important
 * learned item, or an agent edit/delete of an important memory). Reviewed
 * per changed memory: on approval every updated/deleted memory must still
 * be exactly as `before`, otherwise the proposal goes stale.
 */
export interface ChangeProposalInput {
  userId: string; agentId: string; drawer: DrawerRef; changes: MemoryChange[]; source: 'learning' | 'agent' | 'import' | 'file';
  reasons: string[]; note?: string | null; createdBy: string; importBatchId?: string | null;
  /** Import (CLI-02) checks capacity for the whole batch up front. */
  skipPendingLimit?: boolean;
  /** CORE-MEM-CONFLICT: the existing memory the change contradicts (its one change updates it). */
  conflictWith?: string | null;
}

export function createChangeProposal(input: ChangeProposalInput): Promise<MemoryProposal> {
  return sql().tx(() => createChangeProposalStep(input));
}

/** createChangeProposal as a SQL step (inside a transaction: the import commit). */
export function* createChangeProposalStep(input: ChangeProposalInput): Step<MemoryProposal> {
  const d = normalizeDrawer(input.drawer);
  if (!Array.isArray(input.changes) || input.changes.length === 0) throw new MemoryFileError('The proposal has no changes');
  if (input.changes.length > MAX_CHANGES) throw new MemoryFileError('Too many changes in one proposal');
  if (!input.skipPendingLimit) {
    yield* lockProposalQueue(input.userId);
    if ((yield* pendingProposalCountStep(input.userId)) >= MAX_PENDING_PROPOSALS) {
      throw new MemoryFileError('Too many proposals are waiting for review', 409);
    }
  }
  if (input.conflictWith) {
    const [only] = input.changes;
    if (input.changes.length !== 1 || only.op !== 'update' || only.id !== input.conflictWith) {
      throw new MemoryFileError('A conflict proposal updates exactly the memory it conflicts with');
    }
  }
  const current = yield* currentMemories(input.userId, d);
  const revision = yield* drawerRevisionStep(input.userId, d);
  const id = uuidv4();
  yield* run(`
    INSERT INTO memory_file_proposals (id, user_id, agent_id, drawer_kind, drawer_key, base_hash, base_revision, changes, status, source, note, created_by, reasons, import_batch_id, conflict_with)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `, id, input.userId, input.agentId, d.kind, d.key || '', drawerHash(current), revision,
    JSON.stringify(input.changes), input.source, typeof input.note === 'string' ? input.note.slice(0, 500) : null,
    input.createdBy, JSON.stringify(input.reasons.slice(0, 20)), input.importBatchId ?? null, input.conflictWith ?? null);
  return (yield* getProposalStep(input.userId, id))!;
}

/**
 * Create a pending proposal from edited export text. The file must belong to
 * this drawer and be based on the drawer's current content; otherwise 409
 * (export again), so an old copy can never silently revert newer memory.
 */
export function createProposal(input: {
  userId: string; agentId: string; drawer: DrawerRef; text: string; source: 'upload' | 'file'; note?: string | null;
}): Promise<MemoryProposal> {
  return sql().tx(() => createProposalStep(input));
}

function* createProposalStep(input: {
  userId: string; agentId: string; drawer: DrawerRef; text: string; source: 'upload' | 'file'; note?: string | null;
}): Step<MemoryProposal> {
  const d = normalizeDrawer(input.drawer);
  const parsed = parseDrawerFile(input.text);
  let fileDrawer: DrawerRef;
  try { fileDrawer = parseDrawerId(parsed.drawer); } catch { throw new MemoryFileError('The file names an invalid drawer'); }
  if (drawerId(fileDrawer) !== drawerId(d)) throw new MemoryFileError('This file belongs to another drawer');
  const current = yield* currentMemories(input.userId, d);
  if (parsed.baseHash !== drawerHash(current)) {
    throw new MemoryFileError('The memory changed since this file was exported; export it again and redo the edit', 409);
  }
  const changes = diffDrawer(current, parsed);
  if (changes.length === 0) throw new MemoryFileError('The file has no changes');
  const note = typeof input.note === 'string' ? input.note.slice(0, 500) : null;
  const revision = yield* drawerRevisionStep(input.userId, d);
  const id = uuidv4();
  yield* run(`
    INSERT INTO memory_file_proposals (id, user_id, agent_id, drawer_kind, drawer_key, base_hash, base_revision, changes, status, source, note, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `, id, input.userId, input.agentId, d.kind, d.key || '', parsed.baseHash, revision,
    JSON.stringify(changes), input.source, note, input.userId);
  return (yield* getProposalStep(input.userId, id))!;
}

const PROPOSAL_ID = /^[A-Za-z0-9-]{1,64}$/;

/** A proposal of this user, or null (another user's proposal is invisible). */
export function getProposal(userId: string, id: string): Promise<MemoryProposal | null> {
  return sql().read(getProposalStep(userId, id));
}

/** getProposal as a SQL step; `lock` = FOR UPDATE on PostgreSQL (inside a transaction). */
export function* getProposalStep(userId: string, id: string, lock = false): Step<MemoryProposal | null> {
  if (typeof id !== 'string' || !PROPOSAL_ID.test(id)) return null;
  const d = yield* dialect();
  const row = yield* one(`SELECT * FROM memory_file_proposals WHERE id = ? AND user_id = ?${lock ? forUpdate(d) : ''}`, id, userId);
  return row ? rowToProposal(row) : null;
}

/** Every pending proposal of a user, oldest first (at most `limit`; review groups, MEM-GAPS-02). */
export async function listPendingProposals(userId: string, limit = 2000): Promise<MemoryProposal[]> {
  const rows = await sql().read(all("SELECT * FROM memory_file_proposals WHERE user_id = ? AND status = 'pending' ORDER BY created_at, id LIMIT ?", userId, Math.max(1, Math.min(5000, limit))));
  return rows.map(rowToProposal);
}

export async function listProposals(userId: string, status?: string): Promise<MemoryProposal[]> {
  const rows = status
    ? await sql().read(all('SELECT * FROM memory_file_proposals WHERE user_id = ? AND status = ? ORDER BY created_at DESC, id LIMIT 200', userId, status))
    : await sql().read(all('SELECT * FROM memory_file_proposals WHERE user_id = ? ORDER BY created_at DESC, id LIMIT 200', userId));
  return rows.map(rowToProposal);
}

function layerFor(importance: number): { memoryLayer: MultiTierLayer; expiryTimestamp: number | null } {
  if (importance >= 8) return { memoryLayer: 'factual', expiryTimestamp: null };
  if (importance >= 6) return { memoryLayer: 'experiential', expiryTimestamp: Date.now() + 90 * 24 * 60 * 60 * 1000 };
  return { memoryLayer: 'working', expiryTimestamp: Date.now() + 24 * 60 * 60 * 1000 };
}

export interface ApplyResult { proposal: MemoryProposal; revision: number; applied: { added: string[]; updated: string[]; deleted: string[] } }

const REVIEW_HASH = /^[0-9a-f]{64}$/;

/**
 * The checks every decision makes on a proposal row: it exists for this user,
 * is still pending, and the caller reviewed exactly its current content.
 * Run before the slow work and again inside the deciding transaction, where
 * `lock` takes the row lock on PostgreSQL (a concurrent decision waits here
 * and then sees the decided status).
 */
function* decidable(userId: string, id: string, expectedReviewHash: unknown, lock = false): Step<MemoryProposal> {
  const proposal = yield* getProposalStep(userId, id, lock);
  if (!proposal) throw new MemoryFileError('Proposal not found', 404);
  if (proposal.status !== 'pending') throw new MemoryFileError(`Proposal is already ${proposal.status}`, 409, 'already_decided');
  if (typeof expectedReviewHash !== 'string' || !REVIEW_HASH.test(expectedReviewHash)) {
    throw new MemoryFileError('expectedReviewHash is required (the reviewHash of the proposal you reviewed)', 400, 'review_hash_required');
  }
  if (expectedReviewHash !== proposal.reviewHash) {
    throw new MemoryFileError('The proposal changed since it was reviewed; open it again', 409, 'review_changed');
  }
  return proposal;
}

/** Atomically move a pending proposal to its decided status; 409 if another decision won. */
function* claimDecision(
  userId: string, id: string, status: 'approved' | 'rejected' | 'stale', decidedBy: string, note: string | null = null,
  decision: ConflictDecision | null = null,
): Step<void> {
  const d = yield* dialect();
  const res = yield* run(`
    UPDATE memory_file_proposals SET status = ?, decided_by = ?, decided_at = ${nowIsoText(d)}, note = COALESCE(?, note), decision = ?
    WHERE id = ? AND user_id = ? AND status = 'pending'
  `, status, decidedBy, note, decision, id, userId);
  if (res.changes !== 1) throw new MemoryFileError('Proposal was already decided', 409, 'already_decided');
}

/** Post-commit file work never fails a decision that is already committed. */
async function bestEffort(what: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch (err: any) {
    console.warn(`[memory-files] ${what} failed after commit (the database is canonical): ${err?.code ?? err?.name ?? 'error'}`);
  }
}

/**
 * Approve: apply the proposal in one transaction as drawer revision n+1.
 * Refused (proposal marked stale, 409 `stale`) when the drawer changed after
 * the proposal was made. Only pending proposals of this user, and only with
 * the reviewHash the caller reviewed (409 `review_changed`).
 *
 * Embeddings are computed first (async). The transaction then re-checks the
 * proposal and claims it with a conditional status update; when a concurrent
 * approve/reject won meanwhile, the claim fails, the transaction rolls back
 * and nothing is written (409 `already_decided`).
 */
export async function approveProposal(
  userId: string, id: string, decidedBy: string, expectedReviewHash: unknown, opts: { keepBoth?: boolean } = {},
): Promise<ApplyResult> {
  const proposal = await sql().read(decidable(userId, id, expectedReviewHash));
  const storage = getMemoryStorage();
  const drawer = proposal.drawer;
  // CORE-MEM-CONFLICT: approving a conflict proposal = keep new (the existing
  // memory gets the new text as a new version); keep both adds the new text
  // as its own memory instead and leaves the existing one as it is.
  if (opts.keepBoth && !proposal.conflictWith) throw new MemoryFileError('Only a conflict proposal can keep both', 400);
  const decision: ConflictDecision | null = proposal.conflictWith ? (opts.keepBoth ? 'keep_both' : 'keep_new') : null;
  const changes: MemoryChange[] = opts.keepBoth
    ? proposal.changes.map((c) => (c.op === 'update' ? { op: 'add', after: c.after } : c))
    : proposal.changes;

  // Embeddings first (async); the database work below is one transaction (SQL steps).
  const embeddings = new Map<number, number[]>();
  for (const [i, c] of changes.entries()) {
    if (c.op !== 'delete') embeddings.set(i, await storage.embed(c.after.content));
  }

  const applied = { added: [] as string[], updated: [] as string[], deleted: [] as string[] };
  const written: Memory[] = [];
  const removed: Memory[] = [];
  let revision = 0;
  let stale = false;

  const reason = `proposal:${proposal.source}`;
  function* record(memoryId: string, change: string, e: Entry | null, rev: number): Step<void> {
    yield* lockMemoryHistory(memoryId);
    const v = ((yield* lastVersionStep(memoryId)) ?? 0) + 1;
    yield* run(`
      INSERT INTO memory_versions (id, memory_id, user_id, drawer_kind, drawer_key, drawer_revision, version, change, type, content, importance_score, proposal_id, created_by, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, uuidv4(), memoryId, userId, drawer.kind, drawer.key || '', rev, v, change,
      e?.type ?? null, e?.content ?? null, e ? e.importance / 10 : null, proposal.id, decidedBy, change === 'baseline' ? 'before first change' : reason);
  }
  function* recordBaseline(m: Memory, rev: number): Step<void> {
    yield* lockMemoryHistory(m.id);
    if ((yield* lastVersionStep(m.id)) === null) yield* record(m.id, 'baseline', entryOf(m), rev);
  }

  await sql().tx(function* () {
    // Re-check now, with the row locked (a decision may have happened during the embedding await).
    yield* decidable(userId, id, expectedReviewHash, true);
    // One approval per drawer at a time: the content check and the next revision belong together.
    yield* lockDrawer(userId, drawer);
    // The drawer's rows are locked too (PostgreSQL), so a concurrent forget or
    // edit of one of them waits for this decision, or wins before the check.
    const current = yield* storage.getByDrawersStep(userId, [drawer], true);
    const byId = new Map(current.map((m) => [m.id, m]));
    if (isFileProposal(proposal)) {
      if (drawerHash(current) !== proposal.baseHash) stale = true;
    } else {
      // CORE-05: each changed memory must still be exactly what was reviewed.
      for (const c of changes) {
        if (c.op === 'add') continue;
        const now = byId.get(c.id);
        if (!now || JSON.stringify(entryOf(now)) !== JSON.stringify(c.before)) { stale = true; break; }
      }
    }
    // CORE-MEM-TOPIC: a new memory's topic key must still be free in the drawer.
    for (const c of changes) {
      if (stale) break;
      if (c.op === 'add' && c.topicKey && (yield* storage.getByTopicKeyStep(userId, drawer, c.topicKey, true))) stale = true;
    }
    if (stale) { yield* claimDecision(userId, id, 'stale', decidedBy); return; }
    // The claim: exactly one decision moves the row out of 'pending'.
    yield* claimDecision(userId, id, 'approved', decidedBy, null, decision);
    const prev = yield* drawerRevisionStep(userId, drawer);
    revision = prev + 1;
    for (const [i, c] of changes.entries()) {
      if (c.op === 'add') {
        const now = Date.now();
        const mem: Memory = {
          id: uuidv4(), userId, type: c.after.type as MemoryType, content: c.after.content,
          importance: c.after.importance as ImportanceLevel, importanceScore: c.after.importance / 10,
          ...layerFor(c.after.importance), consolidationStatus: 'pending', status: 'active',
          metadata: { source: isFileProposal(proposal) ? 'memory_file' : proposal.source, proposalId: proposal.id }, createdAt: new Date(now), lastAccessedAt: now,
          accessCount: 0, embedding: embeddings.get(i), drawer, topicKey: c.topicKey ?? null,
          // MEM-GAPS-02: an agent's proposal keeps the agent that proposed it (server-written created_by).
          sourceAgentId: proposalSourceAgent(proposal.createdBy),
        };
        yield* storage.writeRowStep(mem);
        yield* record(mem.id, 'create', c.after, revision);
        applied.added.push(mem.id);
        written.push(mem);
      } else if (c.op === 'update') {
        const old = byId.get(c.id);
        if (!old) throw new MemoryFileError('Proposal does not match the drawer', 409, 'stale');
        yield* recordBaseline(old, prev);
        const mem: Memory = {
          ...old, type: c.after.type as MemoryType, content: c.after.content,
          importance: c.after.importance as ImportanceLevel, importanceScore: c.after.importance / 10,
          embedding: embeddings.get(i), drawer,
        };
        yield* storage.writeRowStep(mem);
        yield* record(mem.id, 'update', c.after, revision);
        applied.updated.push(mem.id);
        written.push(mem);
        if (old.type !== mem.type) removed.push(old);
      } else {
        const old = byId.get(c.id);
        if (!old) throw new MemoryFileError('Proposal does not match the drawer', 409, 'stale');
        yield* recordBaseline(old, prev);
        yield* run('DELETE FROM memories WHERE id = ? AND user_id = ?', old.id, userId);
        yield* record(old.id, 'delete', null, revision);
        applied.deleted.push(old.id);
        removed.push(old);
      }
    }
    yield* run('UPDATE memory_file_proposals SET applied_revision = ? WHERE id = ? AND user_id = ?', revision, proposal.id, userId);
  });

  if (stale) throw new MemoryFileError('The memory changed after this proposal was made; it was marked stale', 409, 'stale');

  // Readable copies follow the database (best effort; the DB is canonical and
  // the approval is committed, so a file problem never fails the response).
  for (const m of removed) await bestEffort('removing a memory copy', () => storage.removeMarkdownCopy(m));
  for (const m of written) await bestEffort('writing a memory copy', () => storage.writeMarkdownCopy(m));
  await bestEffort('re-exporting the drawer', () => exportDrawerFile(userId, proposal.agentId, drawer));

  return { proposal: (await getProposal(userId, proposal.id))!, revision, applied };
}

/** Reject: nothing in the memory changes (a conflict proposal: keep old). Same checks and claim as approve. */
export async function rejectProposal(userId: string, id: string, decidedBy: string, expectedReviewHash: unknown, note?: unknown): Promise<MemoryProposal> {
  await sql().tx(function* () {
    const p = yield* decidable(userId, id, expectedReviewHash, true);
    yield* claimDecision(userId, id, 'rejected', decidedBy, typeof note === 'string' && note ? note.slice(0, 500) : null, p.conflictWith ? 'keep_old' : null);
  });
  return (await getProposal(userId, id))!;
}

/**
 * Decide a conflict proposal (CORE-MEM-CONFLICT), owner only (callers check):
 *   keep_new   the existing memory gets the new text as a new version
 *   keep_old   nothing changes (= reject)
 *   keep_both  the new text is added as its own memory; the existing one stays
 * Same review-hash checks, claim and transaction as approve/reject (CORE-04b):
 * of two decisions exactly one wins, the other gets 409 `already_decided`.
 */
export async function decideConflict(
  userId: string, id: string, decision: unknown, decidedBy: string, expectedReviewHash: unknown, note?: unknown,
): Promise<{ decision: ConflictDecision; proposal: MemoryProposal; applied: ApplyResult['applied'] | null }> {
  if (!isConflictDecision(decision)) throw new MemoryFileError('decision must be keep_new, keep_old or keep_both');
  const p = await getProposal(userId, id);
  if (!p) throw new MemoryFileError('Proposal not found', 404);
  if (!p.conflictWith) throw new MemoryFileError('This proposal is not a conflict', 400);
  if (decision === 'keep_old') return { decision, proposal: await rejectProposal(userId, id, decidedBy, expectedReviewHash, note), applied: null };
  const result = await approveProposal(userId, id, decidedBy, expectedReviewHash, { keepBoth: decision === 'keep_both' });
  return { decision, proposal: result.proposal, applied: result.applied };
}

/** The agents_config id of a proposal written by an agent run (`agent:<id>`), else null. */
export function proposalSourceAgent(createdBy: string | null | undefined): string | null {
  const m = /^agent:([A-Za-z0-9_.:-]{1,128})$/.exec(createdBy ?? '');
  return m ? m[1] : null;
}

/** Version history of a drawer, newest first. */
export async function drawerVersions(userId: string, drawer: DrawerRef, limit = 200): Promise<any[]> {
  const rows = await sql().read(all(`
    SELECT memory_id AS "memoryId", drawer_revision AS "drawerRevision", version, change, type, content,
           importance_score AS "importanceScore", proposal_id AS "proposalId", created_by AS "createdBy", created_at AS "createdAt"
      FROM memory_versions WHERE user_id = ? AND drawer_kind = ? AND drawer_key = ?
     ORDER BY drawer_revision DESC, memory_id, version DESC LIMIT ?
  `, userId, drawer.kind, drawer.key || '', Math.max(1, Math.min(1000, limit))));
  return rows.map((r: any) => ({ ...r, createdAt: isoUtc(r.createdAt) }));
}
