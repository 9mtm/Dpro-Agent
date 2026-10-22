/**
 * Task board (BOARD-01, D-COMPANY-OPS): a kanban-style board for the company.
 *
 * A board has ordered columns; a column has ordered cards. A card has a
 * title, description, priority, optional due date, the agents working on it,
 * the departments taking part, and a comment thread. Cards are archived,
 * never deleted. Card edits and moves are versioned (expectedVersion).
 *
 * The owner's first read creates the company board from the default
 * template (Ideas / Backlog / To do / In progress / Review / Done). BOARD-03:
 * more boards per company, per department, or shared by departments, each
 * from a template (services/board-templates.ts) with a colour. Step 1 is owner-only;
 * agents commenting and moving cards through a tool come in a later step.
 */

import { randomUUID, createHash } from 'node:crypto';
import { orderedId } from '../repositories/ordered-id.js';
import { all, dialect, one, run, sql, type Step } from '../repositories/sql-steps.js';
import { nowText } from '../db/pg/dialect.js';
import { normalizeDepartment } from './personality.js';
import { BOARD_COLORS, BOARD_TEMPLATES, DEFAULT_TEMPLATE, boardTemplate, templateForDepartment } from './board-templates.js';

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const CARD_TYPES = ['task', 'idea', 'bug', 'milestone', 'request'] as const;
export type CardType = (typeof CARD_TYPES)[number];
export const MAX_LABELS = 30;
export const MAX_CARD_LABELS = 10;
export const MAX_CHECKLIST = 50;
/** Labels a new board starts with (the owner renames, recolours or adds more). */
export const DEFAULT_LABELS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'Important', color: 'red' }, { name: 'Waiting', color: 'orange' }, { name: 'Quick win', color: 'green' }, { name: 'Needs owner', color: 'purple' },
];
export type Priority = (typeof PRIORITIES)[number];
export const MAX_COLUMNS = 20;
export const MAX_CARDS_PER_BOARD = 5000;
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 5000;
export const MAX_COMMENT = 4000;
export const MAX_CARD_AGENTS = 50;
export const MAX_CARD_DEPARTMENTS = 12;

export class BoardError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const bad = (message: string) => new BoardError(400, 'invalid_board', message);
const notFound = (what: string) => new BoardError(404, 'not_found', `${what} not found`);

export interface BoardColumn { id: string; name: string; position: number }
export interface BoardCard {
  id: string; columnId: string; title: string; description: string; priority: Priority; position: number;
  dueDate: string | null; taskId: string | null; archived: boolean; version: number;
  agents: string[]; departments: string[]; comments: number; createdAt: string; updatedAt: string;
  /** BOARD-03 step B */
  type: CardType; startDate: string | null; cover: string | null; labels: string[]; checklist: { done: number; total: number };
  /** CHAT-PRO-02 I step 2: the chat conversation this card was made from (null = made on the board). */
  conversationId: string | null;
}
export interface BoardLabel { id: string; name: string; color: string; position: number }
export interface ChecklistItem { id: string; text: string; done: boolean; position: number }
export interface BoardMeta {
  id: string; name: string; description: string; template: string; color: string; departments: string[];
  /** company: no departments; department: one; shared: several. */
  kind: 'company' | 'department' | 'shared'; managedDepartment?:boolean; departmentActive?:boolean; archived: boolean; version: number;
}
export interface Board extends BoardMeta { columns: BoardColumn[]; cards: BoardCard[]; labels: BoardLabel[] }
export interface BoardComment { id: string; authorKind: 'user' | 'agent'; authorId: string; body: string; createdAt: string }

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Trimmed single-line text, 1..max, no control characters. */
function line(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  const s = v.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!s) throw bad(`${field} is required`);
  if ([...s].length > max) throw bad(`${field} must be at most ${max} characters`);
  return s;
}
/** Multi-line text 0..max (newlines kept, other control characters refused). */
function text(v: unknown, field: string, max: number, required = false): string {
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  const s = v.replace(/\r\n?/g, '\n').trim();
  if (required && !s) throw bad(`${field} is required`);
  if ([...s].length > max) throw bad(`${field} must be at most ${max} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/.test(s)) throw bad(`${field} contains invalid characters`);
  return s;
}
function priority(v: unknown): Priority {
  if (!(PRIORITIES as readonly unknown[]).includes(v)) throw bad(`priority must be one of ${PRIORITIES.join(', ')}`);
  return v as Priority;
}
function dueDate(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw bad('dueDate must be YYYY-MM-DD or null');
  return v;
}
function cardType(v: unknown): CardType {
  if (!(CARD_TYPES as readonly unknown[]).includes(v)) throw bad(`type must be one of ${CARD_TYPES.join(', ')}`);
  return v as CardType;
}
function cover(v: unknown): string | null {
  if (v === null) return null;
  if (!(BOARD_COLORS as readonly unknown[]).includes(v)) throw bad(`cover must be a board colour or null`);
  return v as string;
}
function idList(v: unknown, field: string, max: number): string[] {
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(x))) throw bad(`${field} must be a list of at most ${max} ids`);
  return [...new Set(v as string[])];
}
function departments(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > MAX_CARD_DEPARTMENTS) throw bad(`departments must be a list of at most ${MAX_CARD_DEPARTMENTS} names`);
  const out: string[] = [];
  for (const raw of v) {
    let d: string | null;
    try { d = normalizeDepartment(raw); } catch { throw bad('Each department must be a name of at most 64 characters'); }
    if (!d || !/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(d)) throw bad('Department names may use letters, numbers, spaces, - and _');
    if (!out.includes(d)) out.push(d);
  }
  return out;
}
const onlyKeys = (body: Record<string, unknown>, keys: readonly string[]) => {
  const k = Object.keys(body).find((x) => !keys.includes(x));
  if (k) throw bad(`Unknown field "${k.slice(0, 40)}"`);
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function* boardRow(ownerId: string, boardId: string): Step<{ id: string; name: string }> {
  const b = yield* one<{ id: string; name: string }>('SELECT id, name FROM boards WHERE id = ? AND owner_id = ?', boardId, ownerId);
  if (!b) throw notFound('Board');
  return b;
}

/** Board header: name, description, template, colour, departments, kind, archived, version. */
function* boardMeta(boardId: string): Step<BoardMeta> {
  const b = yield* one<{ id: string; name: string; description: string; template: string; color: string; archived: number; version: number }>(
    'SELECT id, name, description, template, color, archived, version FROM boards WHERE id = ?', boardId);
  const linked=yield* one<{active:number}>('SELECT active FROM board_department_sources WHERE board_id = ?',boardId);
  const departments = (yield* all<{ department: string }>('SELECT department FROM board_departments WHERE board_id = ? ORDER BY department', boardId)).map((d) => d.department);
  return {
    id: b!.id, name: b!.name, description: b!.description, template: b!.template, color: b!.color, departments,
    kind: departments.length === 0 ? 'company' : departments.length === 1 ? 'department' : 'shared',
    managedDepartment:!!linked,departmentActive:linked?Number(linked.active)===1:true,archived: Number(b!.archived) === 1, version: Number(b!.version),
  };
}

function* cardsOf(boardId: string, includeArchived: boolean, onlyCard?: string): Step<BoardCard[]> {
  const rows = yield* all<{
    id: string; column_id: string; title: string; description: string; priority: Priority; position: number; due_date: string | null;
    task_id: string | null; archived: number; version: number; created_at: string; updated_at: string;
    card_type: CardType; start_date: string | null; cover: string | null; conversation_id: string | null;
  }>(`SELECT id, column_id, title, description, priority, position, due_date, task_id, archived, version, created_at, updated_at, card_type, start_date, cover, conversation_id
      FROM board_cards WHERE board_id = ?${includeArchived ? '' : ' AND archived = 0'}${onlyCard ? ' AND id = ?' : ''} ORDER BY position, created_at`,
  ...(onlyCard ? [boardId, onlyCard] : [boardId]));
  if (rows.length === 0) return [];
  const agents = yield* all<{ card_id: string; agent_id: string }>(
    'SELECT a.card_id, a.agent_id FROM board_card_agents a JOIN board_cards c ON c.id = a.card_id WHERE c.board_id = ? ORDER BY a.agent_id', boardId);
  const deps = yield* all<{ card_id: string; department: string }>(
    'SELECT d.card_id, d.department FROM board_card_departments d JOIN board_cards c ON c.id = d.card_id WHERE c.board_id = ? ORDER BY d.department', boardId);
  const counts = yield* all<{ card_id: string; n: number }>(
    'SELECT m.card_id, COUNT(*) AS n FROM board_card_comments m JOIN board_cards c ON c.id = m.card_id WHERE c.board_id = ? GROUP BY m.card_id', boardId);
  const labels = yield* all<{ card_id: string; label_id: string }>(
    'SELECT l.card_id, l.label_id FROM board_card_labels l JOIN board_cards c ON c.id = l.card_id JOIN board_labels b ON b.id = l.label_id WHERE c.board_id = ? ORDER BY b.position', boardId);
  const checks = yield* all<{ card_id: string; total: number; done: number }>(
    'SELECT k.card_id, COUNT(*) AS total, SUM(k.done) AS done FROM board_card_checklist k JOIN board_cards c ON c.id = k.card_id WHERE c.board_id = ? GROUP BY k.card_id', boardId);
  const group = <T extends { card_id: string }>(list: T[], pick: (x: T) => string) => {
    const m = new Map<string, string[]>();
    for (const x of list) m.set(x.card_id, [...(m.get(x.card_id) ?? []), pick(x)]);
    return m;
  };
  const byAgents = group(agents, (x) => x.agent_id);
  const byDeps = group(deps, (x) => x.department);
  const byCount = new Map(counts.map((x) => [x.card_id, Number(x.n)]));
  const byLabels = group(labels, (x) => x.label_id);
  const byCheck = new Map(checks.map((x) => [x.card_id, { done: Number(x.done ?? 0), total: Number(x.total) }]));
  return rows.map((r) => ({
    id: r.id, columnId: r.column_id, title: r.title, description: r.description, priority: r.priority, position: Number(r.position),
    dueDate: r.due_date, taskId: r.task_id, archived: Number(r.archived) === 1, version: Number(r.version),
    agents: byAgents.get(r.id) ?? [], departments: byDeps.get(r.id) ?? [], comments: byCount.get(r.id) ?? 0,
    createdAt: r.created_at, updatedAt: r.updated_at,
    type: r.card_type, startDate: r.start_date, cover: r.cover, labels: byLabels.get(r.id) ?? [], checklist: byCheck.get(r.id) ?? { done: 0, total: 0 },
    conversationId: r.conversation_id ?? null,
  }));
}

function* labelsOf(boardId: string): Step<BoardLabel[]> {
  return (yield* all<BoardLabel>('SELECT id, name, color, position FROM board_labels WHERE board_id = ? ORDER BY position', boardId))
    .map((l) => ({ id: l.id, name: l.name, color: l.color, position: Number(l.position) }));
}

function* boardStep(ownerId: string, boardId: string, includeArchived = false): Step<Board> {
  yield* boardRow(ownerId, boardId);
  const meta = yield* boardMeta(boardId);
  const columns = (yield* all<BoardColumn>('SELECT id, name, position FROM board_columns WHERE board_id = ? ORDER BY position', boardId))
    .map((c) => ({ id: c.id, name: c.name, position: Number(c.position) }));
  return { ...meta, columns, cards: yield* cardsOf(boardId, includeArchived), labels: yield* labelsOf(boardId) };
}

function* insertBoard(ownerId: string, input: { name: string; description: string; template: string; color: string; departments: string[] }): Step<string> {
  const d = yield* dialect();
  const id = randomUUID();
  const tpl = boardTemplate(input.template) ?? boardTemplate(DEFAULT_TEMPLATE)!;
  yield* run(`INSERT INTO boards (id, owner_id, name, description, template, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ${nowText(d)}, ${nowText(d)})`,
    id, ownerId, input.name, input.description, tpl.id, input.color);
  for (const [i, name] of tpl.columns.entries()) {
    yield* run('INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)', randomUUID(), id, name, (i + 1) * 1000);
  }
  for (const dep of input.departments) yield* run('INSERT INTO board_departments (board_id, department) VALUES (?, ?)', id, dep);
  for (const [i, l] of DEFAULT_LABELS.entries()) yield* run('INSERT INTO board_labels (id, board_id, name, color, position) VALUES (?, ?, ?, ?, ?)', randomUUID(), id, l.name, l.color, (i + 1) * 1000);
  return id;
}

export interface BoardSummary extends BoardMeta { cards: number; open: number }

/**
 * The owner's boards with card counts (archived boards only when asked).
 * The first call creates the company board from the default template.
 */
export function listBoards(ownerId: string, includeArchived = false): Promise<BoardSummary[]> {
  return sql().tx(function* () {
    const any = yield* one('SELECT id FROM boards WHERE owner_id = ? LIMIT 1', ownerId);
    if (!any) yield* insertBoard(ownerId, { name: 'Company board', description: 'Work for the whole company.', template: DEFAULT_TEMPLATE, color: 'blue', departments: [] });
    const rows = yield* all<{ id: string }>(`SELECT id FROM boards WHERE owner_id = ?${includeArchived ? '' : ' AND archived = 0'} ORDER BY created_at, id`, ownerId);
    const out: BoardSummary[] = [];
    for (const r of rows) {
      const meta = yield* boardMeta(r.id);
      const c = yield* one<{ n: number; open: number }>(`
        SELECT COUNT(*) AS n, SUM(CASE WHEN col.position < (SELECT MAX(position) FROM board_columns WHERE board_id = ?) THEN 1 ELSE 0 END) AS open
        FROM board_cards c JOIN board_columns col ON col.id = c.column_id WHERE c.board_id = ? AND c.archived = 0`, r.id, r.id);
      out.push({ ...meta, cards: Number(c?.n ?? 0), open: Number(c?.open ?? 0) });
    }
    // Company boards first, then department boards, then shared ones; each by name.
    const rank = { company: 0, department: 1, shared: 2 } as const;
    return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }, { immediate: true });
}

function boardInput(body: Record<string, unknown>, partial: boolean) {
  const out: { name?: string; description?: string; template?: string; color?: string; departments?: string[] } = {};
  if (body.name !== undefined || !partial) out.name = line(body.name, 'name', 80);
  if (body.description !== undefined) out.description = text(body.description, 'description', 500);
  if (body.template !== undefined) {
    if (typeof body.template !== 'string' || !boardTemplate(body.template)) throw bad(`template must be one of ${BOARD_TEMPLATES.map((t) => t.id).join(', ')}`);
    out.template = body.template;
  }
  if (body.color !== undefined) {
    if (!(BOARD_COLORS as readonly unknown[]).includes(body.color)) throw bad(`color must be one of ${BOARD_COLORS.join(', ')}`);
    out.color = body.color as string;
  }
  if (body.departments !== undefined) out.departments = departments(body.departments);
  return out;
}

export const MAX_BOARDS = 200;

/** A new board from a template: company (no departments), one department, or shared by several. */
export function createBoard(ownerId: string, body: Record<string, unknown>): Promise<Board> {
  onlyKeys(body, ['name', 'description', 'template', 'color', 'departments']);
  const input = boardInput(body, false);
  return sql().tx(function* () {
    const n = yield* one<{ n: number }>('SELECT COUNT(*) AS n FROM boards WHERE owner_id = ?', ownerId);
    if (Number(n?.n ?? 0) >= MAX_BOARDS) throw bad(`At most ${MAX_BOARDS} boards`);
    const id = yield* insertBoard(ownerId, { name: input.name!, description: input.description ?? '', template: input.template ?? DEFAULT_TEMPLATE, color: input.color ?? 'blue', departments: input.departments ?? [] });
    return yield* boardStep(ownerId, id);
  }, { immediate: true });
}

/** Rename, describe, recolour, change departments or archive a board (versioned). */
export function updateBoard(ownerId: string, boardId: string, body: Record<string, unknown>): Promise<Board> {
  onlyKeys(body, ['expectedVersion', 'name', 'description', 'color', 'departments', 'archived']);
  const expected = body.expectedVersion;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1) throw new BoardError(400, 'invalid_version', 'expectedVersion is required');
  const input = boardInput(body, true);
  if (body.archived !== undefined && typeof body.archived !== 'boolean') throw bad('archived must be true or false');
  return sql().tx(function* () {
    const d = yield* dialect();
    yield* boardRow(ownerId, boardId);
    const meta = yield* boardMeta(boardId);
    if (meta.version !== expected) {
      throw Object.assign(new BoardError(409, 'version_conflict', 'This board was changed meanwhile. Review it and try again.'), { currentBoard: meta });
    }
    const sets: string[] = []; const args: Array<string | number> = [];
    if (input.name !== undefined) { sets.push('name = ?'); args.push(input.name); }
    if (input.description !== undefined) { sets.push('description = ?'); args.push(input.description); }
    if (input.color !== undefined) { sets.push('color = ?'); args.push(input.color); }
    if (body.archived !== undefined) { sets.push('archived = ?'); args.push(body.archived ? 1 : 0); }
    if(input.departments&&meta.managedDepartment&&[...input.departments].sort().join()!==[...meta.departments].sort().join())throw bad('This board follows its company department. Change the department at its source.');
    if (input.departments) {
      yield* run('DELETE FROM board_departments WHERE board_id = ?', boardId);
      for (const dep of input.departments) yield* run('INSERT INTO board_departments (board_id, department) VALUES (?, ?)', boardId, dep);
    }
    const r = yield* run(`UPDATE boards SET ${[...sets, 'version = version + 1', `updated_at = ${nowText(d)}`].join(', ')} WHERE id = ? AND version = ?`, ...args, boardId, expected);
    if (r.changes !== 1) throw new BoardError(409, 'version_conflict', 'This board was changed meanwhile. Review it and try again.');
    return yield* boardStep(ownerId, boardId, false);
  }, { immediate: true });
}

export function getBoard(ownerId: string, boardId: string, includeArchived = false): Promise<Board> {
  return sql().read(boardStep(ownerId, boardId, includeArchived));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function* columnOf(boardId: string, columnId: unknown): Step<{ id: string }> {
  if (typeof columnId !== 'string') throw bad('columnId is required');
  const c = yield* one<{ id: string }>('SELECT id FROM board_columns WHERE id = ? AND board_id = ?', columnId, boardId);
  if (!c) throw notFound('Column');
  return c;
}

function* knownAgents(ids: string[]): Step<void> {
  for (const id of ids) {
    if (!(yield* one('SELECT id FROM agents_config WHERE id = ?', id))) throw bad('Unknown agent');
  }
}

function* nextPosition(columnId: string): Step<number> {
  const r = yield* one<{ p: number | null }>('SELECT MAX(position) AS p FROM board_cards WHERE column_id = ?', columnId);
  return (r?.p === null || r?.p === undefined ? 0 : Number(r.p)) + 1000;
}

function* setLabels(boardId: string, cardId: string, labels: string[] | undefined): Step<void> {
  if (!labels) return;
  for (const id of labels) {
    if (!(yield* one('SELECT id FROM board_labels WHERE id = ? AND board_id = ?', id, boardId))) throw bad('Unknown label');
  }
  yield* run('DELETE FROM board_card_labels WHERE card_id = ?', cardId);
  for (const id of labels) yield* run('INSERT INTO board_card_labels (card_id, label_id) VALUES (?, ?)', cardId, id);
}

function datesOk(start: string | null, due: string | null) {
  if (start && due && start > due) throw bad('The start date cannot be after the due date');
}

function* setLinks(cardId: string, agents: string[] | undefined, deps: string[] | undefined): Step<void> {
  if (agents) {
    yield* knownAgents(agents);
    yield* run('DELETE FROM board_card_agents WHERE card_id = ?', cardId);
    for (const a of agents) yield* run('INSERT INTO board_card_agents (card_id, agent_id) VALUES (?, ?)', cardId, a);
  }
  if (deps) {
    yield* run('DELETE FROM board_card_departments WHERE card_id = ?', cardId);
    for (const d of deps) yield* run('INSERT INTO board_card_departments (card_id, department) VALUES (?, ?)', cardId, d);
  }
}

// ---------------------------------------------------------------------------
// Activity (CHAT-PRO-02 I step 2): what happened to a card, so the chat it
// came from can show moves, comments and "done".
// ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = ['created', 'moved', 'done', 'comment', 'archived', 'restored'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type Actor = { kind: 'user' | 'agent'; id: string };
export interface CardActivity { id: string; kind: ActivityKind; actorKind: 'user' | 'agent'; actorId: string; detail: string; createdAt: string }
/** Characters of a comment kept in the activity line. */
export const ACTIVITY_DETAIL = 200;

/** Ids are time-ordered (orderedId), so the id alone keeps the order within one second. */
function* logActivity(cardId: string, kind: ActivityKind, actor: Actor, detail = ''): Step<void> {
  const d = yield* dialect();
  yield* run(`INSERT INTO board_card_activity (id, card_id, kind, actor_kind, actor_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ${nowText(d)})`,
    orderedId(), cardId, kind, actor.kind, actor.id, [...detail.replace(/\s+/g, ' ').trim()].slice(0, ACTIVITY_DETAIL).join(''));
}

/** A move into the board's last column counts as done. */
function* moveKind(boardId: string, columnId: string): Step<{ kind: ActivityKind; name: string }> {
  const cols = yield* all<{ id: string; name: string }>('SELECT id, name FROM board_columns WHERE board_id = ? ORDER BY position', boardId);
  const col = cols.find((c) => c.id === columnId);
  return { kind: cols.length > 1 && cols[cols.length - 1].id === columnId ? 'done' : 'moved', name: col?.name ?? '' };
}

/** The newest activity of a card (oldest first), at most `limit`. */
export function* cardActivity(cardId: string, limit = 20): Step<CardActivity[]> {
  const rows = yield* all<{ id: string; kind: ActivityKind; actor_kind: 'user' | 'agent'; actor_id: string; detail: string; created_at: string }>(
    'SELECT id, kind, actor_kind, actor_id, detail, created_at FROM board_card_activity WHERE card_id = ? ORDER BY id DESC LIMIT ?', cardId, limit);
  return rows.reverse().map((r) => ({ id: r.id, kind: r.kind, actorKind: r.actor_kind, actorId: r.actor_id, detail: r.detail, createdAt: r.created_at }));
}

export function addColumn(ownerId: string, boardId: string, body: Record<string, unknown>): Promise<Board> {
  onlyKeys(body, ['name']);
  const name = line(body.name, 'name', 60);
  return sql().tx(function* () {
    yield* boardRow(ownerId, boardId);
    const r = yield* one<{ n: number; p: number | null }>('SELECT COUNT(*) AS n, MAX(position) AS p FROM board_columns WHERE board_id = ?', boardId);
    if (Number(r?.n ?? 0) >= MAX_COLUMNS) throw bad(`A board can have at most ${MAX_COLUMNS} columns`);
    yield* run('INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)', randomUUID(), boardId, name, (r?.p === null || r?.p === undefined ? 0 : Number(r.p)) + 1000);
    return yield* boardStep(ownerId, boardId);
  }, { immediate: true });
}

export function renameColumn(ownerId: string, boardId: string, columnId: string, body: Record<string, unknown>): Promise<Board> {
  onlyKeys(body, ['name']);
  const name = line(body.name, 'name', 60);
  return sql().tx(function* () {
    yield* boardRow(ownerId, boardId);
    yield* columnOf(boardId, columnId);
    yield* run('UPDATE board_columns SET name = ? WHERE id = ?', name, columnId);
    return yield* boardStep(ownerId, boardId);
  }, { immediate: true });
}

export function createCard(ownerId: string, boardId: string, body: Record<string, unknown>, opts: { conversationId?: string } = {}): Promise<BoardCard> {
  onlyKeys(body, ['columnId', 'title', 'description', 'priority', 'dueDate', 'agents', 'departments', 'type', 'startDate', 'cover', 'labels']);
  const title = line(body.title, 'title', MAX_TITLE);
  const type = body.type === undefined ? 'task' : cardType(body.type);
  const start = body.startDate === undefined ? null : dueDate(body.startDate);
  const cov = body.cover === undefined ? null : cover(body.cover);
  const labels = body.labels === undefined ? [] : idList(body.labels, 'labels', MAX_CARD_LABELS);
  const description = body.description === undefined ? '' : text(body.description, 'description', MAX_DESCRIPTION);
  const prio = body.priority === undefined ? 'normal' : priority(body.priority);
  const due = body.dueDate === undefined ? null : dueDate(body.dueDate);
  const agents = body.agents === undefined ? [] : idList(body.agents, 'agents', MAX_CARD_AGENTS);
  const deps = body.departments === undefined ? [] : departments(body.departments);
  datesOk(start, due);
  return sql().tx(function* () {
    const d = yield* dialect();
    yield* boardRow(ownerId, boardId);
    const col = yield* columnOf(boardId, body.columnId);
    const total = yield* one<{ n: number }>('SELECT COUNT(*) AS n FROM board_cards WHERE board_id = ?', boardId);
    if (Number(total?.n ?? 0) >= MAX_CARDS_PER_BOARD) throw bad(`A board can hold at most ${MAX_CARDS_PER_BOARD} cards`);
    const id = randomUUID();
    yield* run(`INSERT INTO board_cards (id, board_id, column_id, title, description, priority, position, due_date, created_by, card_type, start_date, cover, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowText(d)}, ${nowText(d)})`, id, boardId, col.id, title, description, prio, yield* nextPosition(col.id), due, ownerId, type, start, cov);
    yield* setLinks(id, agents, body.departments===undefined?(yield* boardMeta(boardId)).departments:deps);
    yield* setLabels(boardId, id, labels);
    if (opts.conversationId) yield* run('UPDATE board_cards SET conversation_id = ? WHERE id = ?', opts.conversationId, id);
    yield* logActivity(id, 'created', { kind: 'user', id: ownerId }, (yield* moveKind(boardId, col.id)).name);
    return (yield* cardsOf(boardId, true, id))[0];
  }, { immediate: true });
}

/**
 * Edit or move a card. `expectedVersion` is required; a stale one gives 409
 * with the current card. Moving: `columnId` and optional `beforeCardId`
 * (null or absent = end of the column).
 */
export function updateCard(ownerId: string, boardId: string, cardId: string, body: Record<string, unknown>): Promise<BoardCard> {
  onlyKeys(body, ['expectedVersion', 'title', 'description', 'priority', 'dueDate', 'agents', 'departments', 'columnId', 'beforeCardId', 'archived', 'type', 'startDate', 'cover', 'labels']);
  const expected = body.expectedVersion;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1) throw new BoardError(400, 'invalid_version', 'expectedVersion is required');
  const sets: string[] = []; const args: Array<string | number | null> = [];
  if (body.title !== undefined) { sets.push('title = ?'); args.push(line(body.title, 'title', MAX_TITLE)); }
  if (body.description !== undefined) { sets.push('description = ?'); args.push(text(body.description, 'description', MAX_DESCRIPTION)); }
  if (body.priority !== undefined) { sets.push('priority = ?'); args.push(priority(body.priority)); }
  const newDue = body.dueDate === undefined ? undefined : dueDate(body.dueDate);
  const newStart = body.startDate === undefined ? undefined : dueDate(body.startDate);
  if (newDue !== undefined) { sets.push('due_date = ?'); args.push(newDue); }
  if (newStart !== undefined) { sets.push('start_date = ?'); args.push(newStart); }
  if (body.type !== undefined) { sets.push('card_type = ?'); args.push(cardType(body.type)); }
  if (body.cover !== undefined) { sets.push('cover = ?'); args.push(cover(body.cover)); }
  const labelIds = body.labels === undefined ? undefined : idList(body.labels, 'labels', MAX_CARD_LABELS);
  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') throw bad('archived must be true or false');
    sets.push('archived = ?'); args.push(body.archived ? 1 : 0);
  }
  const agents = body.agents === undefined ? undefined : idList(body.agents, 'agents', MAX_CARD_AGENTS);
  const deps = body.departments === undefined ? undefined : departments(body.departments);
  if (body.beforeCardId !== undefined && body.beforeCardId !== null && typeof body.beforeCardId !== 'string') throw bad('beforeCardId must be a card id or null');
  return sql().tx(function* () {
    const d = yield* dialect();
    yield* boardRow(ownerId, boardId);
    const card = yield* one<{ version: number; column_id: string; start_date: string | null; due_date: string | null; archived: number }>('SELECT version, column_id, start_date, due_date, archived FROM board_cards WHERE id = ? AND board_id = ?', cardId, boardId);
    if (!card) throw notFound('Card');
    datesOk(newStart === undefined ? card.start_date : newStart, newDue === undefined ? card.due_date : newDue);
    if (Number(card.version) !== expected) {
      const current = (yield* cardsOf(boardId, true, cardId))[0];
      throw Object.assign(new BoardError(409, 'version_conflict', 'This card was changed meanwhile. Review it and try again.'), { current });
    }
    if (body.columnId !== undefined) {
      const col = yield* columnOf(boardId, body.columnId);
      let pos: number;
      const before = body.beforeCardId as string | null | undefined;
      if (before) {
        const b = yield* one<{ position: number; column_id: string }>('SELECT position, column_id FROM board_cards WHERE id = ? AND board_id = ?', before, boardId);
        if (!b || b.column_id !== col.id) throw bad('beforeCardId must be a card in that column');
        const prev = yield* one<{ p: number | null }>('SELECT MAX(position) AS p FROM board_cards WHERE column_id = ? AND position < ? AND id != ?', col.id, b.position, cardId);
        const lo = prev?.p === null || prev?.p === undefined ? Number(b.position) - 1000 : Number(prev.p);
        pos = Math.floor((lo + Number(b.position)) / 2);
        if (pos <= lo || pos >= Number(b.position)) {
          // No gap left: renumber the column, then place the card before `before`.
          const ids = (yield* all<{ id: string }>('SELECT id FROM board_cards WHERE column_id = ? AND id != ? ORDER BY position, created_at', col.id, cardId)).map((x) => x.id);
          let p = 1000;
          for (const id of ids) {
            if (id === before) { pos = p; p += 1000; }
            yield* run('UPDATE board_cards SET position = ? WHERE id = ?', p, id);
            p += 1000;
          }
        }
      } else {
        pos = yield* nextPosition(col.id);
      }
      sets.push('column_id = ?', 'position = ?'); args.push(col.id, pos);
      if (col.id !== card.column_id) { const m = yield* moveKind(boardId, col.id); yield* logActivity(cardId, m.kind, { kind: 'user', id: ownerId }, m.name); }
    }
    if (body.archived !== undefined && (Number(card.archived) === 1) !== body.archived) yield* logActivity(cardId, body.archived ? 'archived' : 'restored', { kind: 'user', id: ownerId });
    yield* setLinks(cardId, agents, deps);
    yield* setLabels(boardId, cardId, labelIds);
    const r = yield* run(`UPDATE board_cards SET ${[...sets, 'version = version + 1', `updated_at = ${nowText(d)}`].join(', ')} WHERE id = ? AND version = ?`, ...args, cardId, expected);
    if (r.changes !== 1) throw new BoardError(409, 'version_conflict', 'This card was changed meanwhile. Review it and try again.');
    return (yield* cardsOf(boardId, true, cardId))[0];
  }, { immediate: true });
}

export function listComments(ownerId: string, boardId: string, cardId: string): Promise<BoardComment[]> {
  return sql().read((function* () {
    yield* boardRow(ownerId, boardId);
    if (!(yield* one('SELECT id FROM board_cards WHERE id = ? AND board_id = ?', cardId, boardId))) throw notFound('Card');
    return (yield* all<{ id: string; author_kind: 'user' | 'agent'; author_id: string; body: string; created_at: string }>(
      'SELECT id, author_kind, author_id, body, created_at FROM board_card_comments WHERE card_id = ? ORDER BY created_at, id LIMIT 500', cardId))
      .map((c) => ({ id: c.id, authorKind: c.author_kind, authorId: c.author_id, body: c.body, createdAt: c.created_at }));
  })());
}

export function addComment(ownerId: string, boardId: string, cardId: string, body: Record<string, unknown>, author: { kind: 'user' | 'agent'; id: string }): Promise<BoardComment[]> {
  onlyKeys(body, ['body']);
  const textBody = text(body.body, 'body', MAX_COMMENT, true);
  return sql().tx(function* () {
    const d = yield* dialect();
    yield* boardRow(ownerId, boardId);
    if (!(yield* one('SELECT id FROM board_cards WHERE id = ? AND board_id = ?', cardId, boardId))) throw notFound('Card');
    yield* run(`INSERT INTO board_card_comments (id, card_id, author_kind, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ${nowText(d)})`,
      randomUUID(), cardId, author.kind, author.id, textBody);
    yield* logActivity(cardId, 'comment', author, textBody);
    return (yield* all<{ id: string; author_kind: 'user' | 'agent'; author_id: string; body: string; created_at: string }>(
      'SELECT id, author_kind, author_id, body, created_at FROM board_card_comments WHERE card_id = ? ORDER BY created_at, id LIMIT 500', cardId))
      .map((c) => ({ id: c.id, authorKind: c.author_kind, authorId: c.author_id, body: c.body, createdAt: c.created_at }));
  }, { immediate: true });
}

// ---------------------------------------------------------------------------
// Agents on the board (BOARD-02): an agent works only on cards it is
// assigned to, on its run user's boards. Comments are signed by the agent.
// ---------------------------------------------------------------------------

export interface AgentCard { id: string; boardId: string; title: string; description: string; column: string; priority: Priority; dueDate: string | null; departments: string[] }

/** Cards the agent is assigned to (not archived), most urgent first, at most 50. */
export function agentCards(ownerId: string, agentId: string): Promise<AgentCard[]> {
  return sql().read((function* () {
    const rows = yield* all<{ id: string; board_id: string; title: string; description: string; col: string; priority: Priority; due_date: string | null }>(`
      SELECT c.id, c.board_id, c.title, c.description, col.name AS col, c.priority, c.due_date
      FROM board_cards c
      JOIN board_card_agents a ON a.card_id = c.id
      JOIN boards b ON b.id = c.board_id
      JOIN board_columns col ON col.id = c.column_id
      WHERE a.agent_id = ? AND b.owner_id = ? AND b.archived = 0 AND c.archived = 0
      ORDER BY CASE c.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, c.due_date IS NULL, c.due_date, c.created_at
      LIMIT 50`, agentId, ownerId);
    const out: AgentCard[] = [];
    for (const r of rows) {
      const deps = (yield* all<{ department: string }>('SELECT department FROM board_card_departments WHERE card_id = ? ORDER BY department', r.id)).map((d) => d.department);
      out.push({ id: r.id, boardId: r.board_id, title: r.title, description: r.description.slice(0, 1000), column: r.col, priority: r.priority, dueDate: r.due_date, departments: deps });
    }
    return out;
  })());
}

function* assignedCard(ownerId: string, agentId: string, cardId: unknown): Step<{ id: string; board_id: string; version: number }> {
  if (typeof cardId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(cardId)) throw bad('cardId is required');
  const card = yield* one<{ id: string; board_id: string; version: number }>(`
    SELECT c.id, c.board_id, c.version FROM board_cards c
    JOIN boards b ON b.id = c.board_id
    JOIN board_card_agents a ON a.card_id = c.id AND a.agent_id = ?
    WHERE c.id = ? AND b.owner_id = ? AND c.archived = 0`, agentId, cardId, ownerId);
  // Not assigned looks the same as missing: an agent cannot probe other cards.
  if (!card) throw notFound('Card');
  return card;
}

/** The agent adds a comment to a card it is assigned to. */
export function agentComment(ownerId: string, agentId: string, cardId: unknown, body: unknown): Promise<number> {
  const textBody = text(body, 'comment', MAX_COMMENT, true);
  return sql().tx(function* () {
    const d = yield* dialect();
    const card = yield* assignedCard(ownerId, agentId, cardId);
    yield* run(`INSERT INTO board_card_comments (id, card_id, author_kind, author_id, body, created_at) VALUES (?, ?, 'agent', ?, ?, ${nowText(d)})`,
      randomUUID(), card.id, agentId, textBody);
    yield* logActivity(card.id, 'comment', { kind: 'agent', id: agentId }, textBody);
    const n = yield* one<{ n: number }>('SELECT COUNT(*) AS n FROM board_card_comments WHERE card_id = ?', card.id);
    return Number(n?.n ?? 0);
  }, { immediate: true });
}

/** The agent moves a card it is assigned to into another column (by name, case-insensitive), at the end. Never into the last column. */
export function agentMove(ownerId: string, agentId: string, cardId: unknown, columnName: unknown): Promise<{ column: string }> {
  const wanted = line(columnName, 'column', 60).toLowerCase();
  return sql().tx(function* () {
    const d = yield* dialect();
    const card = yield* assignedCard(ownerId, agentId, cardId);
    const cols = yield* all<{ id: string; name: string }>('SELECT id, name FROM board_columns WHERE board_id = ? ORDER BY position', card.board_id);
    const col = cols.find((c) => c.name.toLowerCase() === wanted);
    if (!col) throw bad(`No column named "${wanted.slice(0, 60)}". Columns: ${cols.map((c) => c.name).join(', ')}`);
    // Finishing is the owner's decision: an agent never moves a card into "Done" or the board's last column.
    if (col.name.toLowerCase() === 'done' || col.id === cols[cols.length - 1].id) throw new BoardError(403, 'owner_only_column', `Only the owner moves cards to "${col.name}". Move it to the column before it when your work is ready.`);
    const pos = yield* nextPosition(col.id);
    const r = yield* run(`UPDATE board_cards SET column_id = ?, position = ?, version = version + 1, updated_at = ${nowText(d)} WHERE id = ? AND version = ?`,
      col.id, pos, card.id, card.version);
    if (r.changes !== 1) throw new BoardError(409, 'version_conflict', 'The card was changed meanwhile; try again.');
    yield* logActivity(card.id, 'moved', { kind: 'agent', id: agentId }, col.name);
    return { column: col.name };
  }, { immediate: true });
}

// ---------------------------------------------------------------------------
// Labels and checklists (BOARD-03 step B)
// ---------------------------------------------------------------------------

export function addLabel(ownerId: string, boardId: string, body: Record<string, unknown>): Promise<Board> {
  onlyKeys(body, ['name', 'color']);
  const name = line(body.name, 'name', 40);
  const color = cover(body.color);
  if (!color) throw bad('color is required');
  return sql().tx(function* () {
    yield* boardRow(ownerId, boardId);
    const r = yield* one<{ n: number; p: number | null }>('SELECT COUNT(*) AS n, MAX(position) AS p FROM board_labels WHERE board_id = ?', boardId);
    if (Number(r?.n ?? 0) >= MAX_LABELS) throw bad(`A board can have at most ${MAX_LABELS} labels`);
    yield* run('INSERT INTO board_labels (id, board_id, name, color, position) VALUES (?, ?, ?, ?, ?)', randomUUID(), boardId, name, color, (r?.p === null || r?.p === undefined ? 0 : Number(r.p)) + 1000);
    return yield* boardStep(ownerId, boardId);
  }, { immediate: true });
}

export function updateLabel(ownerId: string, boardId: string, labelId: string, body: Record<string, unknown>): Promise<Board> {
  onlyKeys(body, ['name', 'color']);
  const sets: string[] = []; const args: string[] = [];
  if (body.name !== undefined) { sets.push('name = ?'); args.push(line(body.name, 'name', 40)); }
  if (body.color !== undefined) { const c = cover(body.color); if (!c) throw bad('color is required'); sets.push('color = ?'); args.push(c); }
  if (sets.length === 0) throw bad('Nothing to change');
  return sql().tx(function* () {
    yield* boardRow(ownerId, boardId);
    const r = yield* run(`UPDATE board_labels SET ${sets.join(', ')} WHERE id = ? AND board_id = ?`, ...args, labelId, boardId);
    if (r.changes !== 1) throw notFound('Label');
    return yield* boardStep(ownerId, boardId);
  }, { immediate: true });
}

function* checklistOf(cardId: string): Step<ChecklistItem[]> {
  return (yield* all<{ id: string; text: string; done: number; position: number }>('SELECT id, text, done, position FROM board_card_checklist WHERE card_id = ? ORDER BY position', cardId))
    .map((i) => ({ id: i.id, text: i.text, done: Number(i.done) === 1, position: Number(i.position) }));
}

function* cardOfBoard(ownerId: string, boardId: string, cardId: string): Step<void> {
  yield* boardRow(ownerId, boardId);
  if (!(yield* one('SELECT id FROM board_cards WHERE id = ? AND board_id = ?', cardId, boardId))) throw notFound('Card');
}

export function listChecklist(ownerId: string, boardId: string, cardId: string): Promise<ChecklistItem[]> {
  return sql().read((function* () { yield* cardOfBoard(ownerId, boardId, cardId); return yield* checklistOf(cardId); })());
}

export function addChecklistItem(ownerId: string, boardId: string, cardId: string, body: Record<string, unknown>): Promise<ChecklistItem[]> {
  onlyKeys(body, ['text']);
  const t = line(body.text, 'text', 300);
  return sql().tx(function* () {
    yield* cardOfBoard(ownerId, boardId, cardId);
    const r = yield* one<{ n: number; p: number | null }>('SELECT COUNT(*) AS n, MAX(position) AS p FROM board_card_checklist WHERE card_id = ?', cardId);
    if (Number(r?.n ?? 0) >= MAX_CHECKLIST) throw bad(`A card can have at most ${MAX_CHECKLIST} checklist items`);
    yield* run('INSERT INTO board_card_checklist (id, card_id, text, done, position) VALUES (?, ?, ?, 0, ?)', randomUUID(), cardId, t, (r?.p === null || r?.p === undefined ? 0 : Number(r.p)) + 1000);
    return yield* checklistOf(cardId);
  }, { immediate: true });
}

/** Tick, untick, reword or remove (remove: true) one checklist item. */
export function updateChecklistItem(ownerId: string, boardId: string, cardId: string, itemId: string, body: Record<string, unknown>): Promise<ChecklistItem[]> {
  onlyKeys(body, ['text', 'done', 'remove']);
  if (body.remove !== undefined && body.remove !== true) throw bad('remove must be true');
  if (body.done !== undefined && typeof body.done !== 'boolean') throw bad('done must be true or false');
  const t = body.text === undefined ? undefined : line(body.text, 'text', 300);
  if (body.remove === undefined && body.done === undefined && t === undefined) throw bad('Nothing to change');
  return sql().tx(function* () {
    yield* cardOfBoard(ownerId, boardId, cardId);
    const item = yield* one('SELECT id FROM board_card_checklist WHERE id = ? AND card_id = ?', itemId, cardId);
    if (!item) throw notFound('Checklist item');
    if (body.remove === true) {
      yield* run('DELETE FROM board_card_checklist WHERE id = ?', itemId);
    } else {
      if (t !== undefined) yield* run('UPDATE board_card_checklist SET text = ? WHERE id = ?', t, itemId);
      if (body.done !== undefined) yield* run('UPDATE board_card_checklist SET done = ? WHERE id = ?', body.done ? 1 : 0, itemId);
    }
    return yield* checklistOf(cardId);
  }, { immediate: true });
}

/** The checklist of a card the agent is assigned to. */
export function agentChecklist(ownerId: string, agentId: string, cardId: unknown): Promise<ChecklistItem[]> {
  return sql().read((function* () { const card = yield* assignedCard(ownerId, agentId, cardId); return yield* checklistOf(card.id); })());
}

/** The agent ticks (or unticks) a checklist item on a card it is assigned to. */
export function agentCheck(ownerId: string, agentId: string, cardId: unknown, itemId: unknown, done: unknown): Promise<ChecklistItem[]> {
  if (typeof itemId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(itemId)) return Promise.reject(bad('item_id is required'));
  if (typeof done !== 'boolean') return Promise.reject(bad('done must be true or false'));
  return sql().tx(function* () {
    const card = yield* assignedCard(ownerId, agentId, cardId);
    const r = yield* run('UPDATE board_card_checklist SET done = ? WHERE id = ? AND card_id = ?', done ? 1 : 0, itemId, card.id);
    if (r.changes !== 1) throw notFound('Checklist item');
    return yield* checklistOf(card.id);
  }, { immediate: true });
}


function boardDepartmentName(raw:string,key:string){
 try{const name=normalizeDepartment(raw);if(name&&/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(name))return name;}catch{/* Registered display names may contain punctuation absent from legacy agent department keys. */}
 const base=raw.normalize('NFKC').replace(/&/g,' and ').replace(/[^\p{L}\p{N} _-]/gu,' ').replace(/\s+/g,' ').trim().toLowerCase();
 return base&&base.length<=64?base:(base.slice(0,48)||'department')+'-'+createHash('sha256').update(key).digest('hex').slice(0,8);
}
/** Idempotent owner-authorised provisioning from actual departments, never the specialty catalogue. */
export function syncDepartmentBoards(ownerId:string){
 return sql().tx(function*(){
  const sources=new Map<string,{key:string;name:string;display:string}>();
  const registered=yield* all<{id:string;name:string}>('SELECT id,name FROM memory_departments WHERE owner_id = ? ORDER BY id',ownerId);
  for(const d of registered){const key='registry:'+d.id;let name=boardDepartmentName(d.name,key);if(sources.has(name))name=name.slice(0,48)+'-'+createHash('sha256').update(key).digest('hex').slice(0,8);sources.set(name,{key,name,display:d.name});}
  // Agent configuration is the installation's company-wide team catalogue.
  const assigned=yield* all<{department:string}>('SELECT DISTINCT department FROM agents_config WHERE department IS NOT NULL AND department <> ? ORDER BY department','');
  for(const d of assigned){const name=boardDepartmentName(d.department,'agents:'+d.department);if(!sources.has(name))sources.set(name,{key:'agents:'+name,name,display:d.department});}
  let count=Number((yield* one<{n:number}>('SELECT COUNT(*) AS n FROM boards WHERE owner_id = ?',ownerId))?.n??0),created=0;
  const company=yield* one('SELECT b.id FROM boards b WHERE b.owner_id = ? AND b.archived = 0 AND NOT EXISTS (SELECT 1 FROM board_departments d WHERE d.board_id = b.id) LIMIT 1',ownerId);
  if(!company){if(count>=MAX_BOARDS)throw bad('Board limit reached');yield* insertBoard(ownerId,{name:'Company board',description:'Company tasks and department oversight.',template:DEFAULT_TEMPLATE,color:'blue',departments:[]});count++;created++;}
  yield* run('UPDATE board_department_sources SET active = 0 WHERE owner_id = ?',ownerId);
  for(const source of sources.values()){
   let link=yield* one<{board_id:string;department:string;auto_name:string}>('SELECT board_id,department,auto_name FROM board_department_sources WHERE owner_id = ? AND source_key = ?',ownerId,source.key);
   if(!link)link=yield* one<{board_id:string;department:string;auto_name:string}>('SELECT board_id,department,auto_name FROM board_department_sources WHERE owner_id = ? AND department = ? ORDER BY board_id LIMIT 1',ownerId,source.name);
   const autoName=(source.display+' board').slice(0,80);
   if(link){
    const b=yield* one<{name:string}>('SELECT name FROM boards WHERE id = ? AND owner_id = ?',link.board_id,ownerId);
    if(b&&link.department!==source.name){
      yield* run('UPDATE boards SET version = version + 1 WHERE owner_id = ? AND id IN (SELECT board_id FROM board_departments WHERE department = ?)',ownerId,link.department);
      yield* run('INSERT INTO board_departments(board_id,department) SELECT d.board_id,? FROM board_departments d JOIN boards b ON b.id = d.board_id WHERE b.owner_id = ? AND d.department = ? ON CONFLICT DO NOTHING',source.name,ownerId,link.department);
      yield* run('DELETE FROM board_departments WHERE department = ? AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)',link.department,ownerId);
      yield* run('UPDATE board_cards SET version = version + 1 WHERE id IN (SELECT cd.card_id FROM board_card_departments cd JOIN board_cards c ON c.id = cd.card_id JOIN boards b ON b.id = c.board_id WHERE b.owner_id = ? AND cd.department = ?)',ownerId,link.department);
      yield* run('INSERT INTO board_card_departments(card_id,department) SELECT cd.card_id,? FROM board_card_departments cd JOIN board_cards c ON c.id = cd.card_id JOIN boards b ON b.id = c.board_id WHERE b.owner_id = ? AND cd.department = ? ON CONFLICT DO NOTHING',source.name,ownerId,link.department);
      yield* run('DELETE FROM board_card_departments WHERE department = ? AND card_id IN (SELECT c.id FROM board_cards c JOIN boards b ON b.id = c.board_id WHERE b.owner_id = ?)',link.department,ownerId);
    }
    if(b&&b.name===link.auto_name&&b.name!==autoName)yield* run('UPDATE boards SET name = ?, version = version + 1 WHERE id = ?',autoName,link.board_id);
    yield* run('UPDATE board_department_sources SET source_key = ?, department = ?, auto_name = ?, active = 1 WHERE board_id = ?',source.key,source.name,autoName,link.board_id);
    continue;
   }
   // Adopt an existing single-department board, including an archived one; never resurrect archived work.
   const existing=yield* one<{id:string;name:string}>(`SELECT b.id,b.name FROM boards b JOIN board_departments d ON d.board_id = b.id WHERE b.owner_id = ? AND d.department = ? AND (SELECT COUNT(*) FROM board_departments x WHERE x.board_id = b.id) = 1 AND NOT EXISTS (SELECT 1 FROM board_department_sources l WHERE l.board_id = b.id) ORDER BY b.archived,b.created_at,b.id LIMIT 1`,ownerId,source.name);
   let boardId=existing?.id;
   if(!boardId){if(count>=MAX_BOARDS)throw bad('Board limit reached');boardId=yield* insertBoard(ownerId,{name:autoName,description:'Work for '+source.display+'.',template:templateForDepartment(source.display),color:'blue',departments:[source.name]});count++;created++;}
   yield* run('INSERT INTO board_department_sources(board_id,owner_id,source_key,department,auto_name,active) VALUES(?,?,?,?,?,1)',boardId,ownerId,source.key,source.name,autoName);
  }
  return {created,departments:sources.size};
 },{immediate:true});
}

/** Cross-board references retain the original task ID, state and discussion. */
export function relatedBoardTasks(ownerId:string,boardId:string){
 return sql().read((function*(){
  yield* boardRow(ownerId,boardId);const meta=yield* boardMeta(boardId);
  const deps=meta.departments;
  const marks=deps.map(()=>'?').join(',');
  const relevant=deps.length?` AND (EXISTS (SELECT 1 FROM board_departments bd WHERE bd.board_id = c.board_id AND bd.department IN (${marks})) OR EXISTS (SELECT 1 FROM board_card_departments cd WHERE cd.card_id = c.id AND cd.department IN (${marks})) OR EXISTS (SELECT 1 FROM board_card_agents ca JOIN agents_config a ON a.id = ca.agent_id WHERE ca.card_id = c.id AND a.department IN (${marks})))`:'';
  const args=[ownerId,boardId,...deps,...deps,...deps];
  const where=' FROM board_cards c JOIN boards b ON b.id = c.board_id JOIN board_columns col ON col.id = c.column_id WHERE b.owner_id = ? AND b.id <> ? AND b.archived = 0 AND c.archived = 0'+relevant;
  const total=Number((yield* one<{n:number}>('SELECT COUNT(*) AS n'+where,...args))?.n??0);
  const tasks=yield* all<{cardId:string;boardId:string;boardName:string;title:string;status:string;priority:string;dueDate:string|null}>('SELECT c.id AS "cardId",b.id AS "boardId",b.name AS "boardName",c.title,col.name AS status,c.priority,c.due_date AS "dueDate"'+where+' ORDER BY c.updated_at DESC,c.id LIMIT 500',...args);
  return {tasks,total,limited:total>tasks.length};
 })());
}
