/**
 * Chat memory (CHAT-PRO-02 E).
 *
 *   "Remember this"   the owner saves (an edited copy of) a chat message as a
 *                     memory in a drawer: the conversation's project drawer,
 *                     "About you" (owner) or the agent's lessons (experience).
 *                     Owner only, at most MAX_REMEMBER characters, secrets are
 *                     removed first (the import redaction), saved through the
 *                     memory repository (versioned) with a link back to the
 *                     conversation and the message.
 *   agent proposals   in a saved conversation every memory_save of the agent
 *                     becomes a memory proposal (never saved by itself); the
 *                     chat shows it with Accept / Reject, decided through the
 *                     existing proposal routes with the review hash.
 *   the list          memories and proposals that came from a conversation,
 *                     with their current state (saved, removed, waiting, rejected).
 */

import { randomUUID } from 'node:crypto';
import { q } from '../repositories/sql-steps.js';
import { repositories } from '../repositories/index.js';
import type { Actor } from '../repositories/actor.js';
import { findConversation, findProject } from '../repositories/chat-conversations.js';
import { drawerId, type DrawerRef } from '../memory/drawers.js';
import { MEMORY_TYPES, isMemoryType, type ImportanceLevel, type Memory, type MemoryType } from '../memory/types.js';
import type { MemoryProposal } from '../memory/memory-files.js';
import { redactImportText } from '../memory/import/redact.js';

/** Characters one "Remember this" may save. */
export const MAX_REMEMBER = 4000;
/** Links one conversation lists (newest kept). */
export const MAX_CHAT_MEMORIES = 100;
const PREVIEW = 300;
/** Drawers "Remember this" offers. */
export const REMEMBER_DRAWERS = ['project', 'owner', 'experience'] as const;
export type RememberDrawer = (typeof REMEMBER_DRAWERS)[number];

export class ChatMemoryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const bad = (message: string) => new ChatMemoryError(400, 'invalid_request', message);
const notFound = () => new ChatMemoryError(404, 'not_found', 'Not found');

export type ChatMemoryStatus = 'saved' | 'removed' | 'pending' | 'rejected' | 'stale' | 'cancelled';
export interface ChatMemory {
  id: string;
  kind: 'remembered' | 'proposed';
  messageId: string | null;
  drawerId: string;
  text: string;
  memoryId: string | null;
  proposalId: string | null;
  status: ChatMemoryStatus;
  createdAt: string;
}

interface LinkRow {
  id: string; message_id: string | null; kind: 'remembered' | 'proposed'; memory_id: string | null; proposal_id: string | null;
  drawer_kind: string; drawer_key: string; preview: string; created_at: string;
  mem_id: string | null; mem_content: string | null; p_status: MemoryProposal['status'] | null;
}

const preview = (s: string) => (s.length > PREVIEW ? `${s.slice(0, PREVIEW - 1)}…` : s);
const drawerOf = (kind: string, key: string): DrawerRef => (key ? { kind, key } : { kind }) as DrawerRef;

/** The conversation (the caller's own) or 404. */
async function ownConversation(userId: string, conversationId: string) {
  const c = typeof conversationId === 'string' ? await findConversation(userId, conversationId) : undefined;
  if (!c) throw notFound();
  return c;
}

/** The drawer "Remember this" saves into; the project drawer only for a project conversation. */
async function rememberDrawer(userId: string, projectId: string | null, choice: unknown): Promise<DrawerRef> {
  if (!REMEMBER_DRAWERS.includes(choice as RememberDrawer)) throw bad('drawer must be project, owner or experience');
  if (choice !== 'project') return { kind: choice as 'owner' | 'experience' };
  const project = projectId ? await findProject(userId, projectId) : undefined;
  if (!project) throw bad('This conversation has no project');
  return { kind: 'project', key: project.slug };
}

/**
 * "Remember this" on a chat message (owner). Body: { messageId | runId, content,
 * drawer: 'project' | 'owner' | 'experience', type?, importance? }.
 */
export async function rememberFromChat(actor: Actor, userId: string, conversationId: string, body: Record<string, unknown>): Promise<{ memory: ChatMemory; redacted: number; duplicate: boolean }> {
  const c = await ownConversation(userId, conversationId);
  const keys = ['messageId', 'runId', 'content', 'drawer', 'type', 'importance'];
  if (Object.keys(body).some((k) => !keys.includes(k))) throw bad('Unknown field');
  // The message by its id, or a reply by its run (a reply that just finished in the page has no id there yet).
  const hasId = typeof body.messageId === 'string' && body.messageId.length > 0;
  const hasRun = typeof body.runId === 'string' && body.runId.length > 0;
  if (hasId === hasRun) throw bad('messageId or runId is required');
  const message = hasId
    ? await q.one<{ id: string }>('SELECT id FROM chat_messages WHERE id = ? AND session_id = ?', body.messageId, c.id)
    : await q.one<{ id: string }>("SELECT id FROM chat_messages WHERE run_id = ? AND session_id = ? AND role = 'assistant'", body.runId as string, c.id);
  if (!message) throw bad('That message is not in this conversation');
  if (typeof body.content !== 'string' || !body.content.trim()) throw bad('content is required');
  if ([...body.content].length > MAX_REMEMBER) throw bad(`content must be at most ${MAX_REMEMBER} characters`);
  if (body.type !== undefined && !isMemoryType(body.type)) throw bad(`type must be one of ${MEMORY_TYPES.join(', ')}`);
  if (body.importance !== undefined && (!Number.isInteger(body.importance) || (body.importance as number) < 1 || (body.importance as number) > 10)) throw bad('importance must be 1-10');
  const drawer = await rememberDrawer(userId, c.projectId, body.drawer);

  // Secrets never reach memory (the same redaction the memory import uses).
  const red = redactImportText(body.content.trim());
  const content = red.text.trim();
  if (!content.replace(/\[REDACTED:[a-z_]+\]/g, '').trim()) throw new ChatMemoryError(400, 'only_secrets', 'Nothing is left to remember once secrets are removed');

  // The same text already in that drawer: link it instead of saving it twice.
  const existing = await q.one<{ id: string }>(
    "SELECT id FROM memories WHERE user_id = ? AND content = ? AND COALESCE(drawer_kind, '') = ? AND COALESCE(drawer_key, '') = ? AND status = 'active'",
    userId, content, drawer.kind, drawer.key ?? '');
  let memoryId = existing?.id;
  if (!memoryId) {
    const importance = (body.importance as number | undefined) ?? 7;
    const draft: Omit<Memory, 'userId'> = {
      id: randomUUID(), type: (body.type as MemoryType | undefined) ?? 'fact', content,
      importance: importance as ImportanceLevel, importanceScore: importance / 10,
      memoryLayer: importance >= 8 ? 'factual' : importance >= 6 ? 'experiential' : 'working',
      expiryTimestamp: importance >= 8 ? null : Date.now() + (importance >= 6 ? 90 : 1) * 24 * 60 * 60 * 1000,
      consolidationStatus: 'pending', status: 'active',
      metadata: { source: 'chat', conversationId: c.id, messageId: message.id, ...(red.total ? { redacted: red.total } : {}) },
      createdAt: new Date(), lastAccessedAt: Date.now(), accessCount: 0, drawer,
    };
    memoryId = (await repositories.memory.create(actor, draft, 'chat:remember')).id;
  }
  const linked = await q.one<{ id: string }>("SELECT id FROM chat_memory_links WHERE conversation_id = ? AND memory_id = ? AND kind = 'remembered'", c.id, memoryId);
  const id = linked?.id ?? randomUUID();
  if (!linked) {
    await q.run(`INSERT INTO chat_memory_links (id, user_id, conversation_id, message_id, kind, memory_id, drawer_kind, drawer_key, preview)
      VALUES (?, ?, ?, ?, 'remembered', ?, ?, ?, ?)`, id, userId, c.id, message.id, memoryId, drawer.kind, drawer.key ?? '', preview(content));
  }
  const memory = (await conversationMemories(userId, c.id)).find((m) => m.id === id)!;
  return { memory, redacted: red.total, duplicate: !!existing };
}

/** A saved conversation of this user (agent runs: memory_save there becomes a proposal). */
export async function isUserConversation(userId: string | undefined, sessionId: string | undefined): Promise<boolean> {
  if (!userId || !sessionId) return false;
  return !!(await q.one('SELECT 1 AS x FROM chat_sessions WHERE id = ? AND user_id = ?', sessionId, userId));
}

/** Link an agent's memory proposal to the conversation and the newest owner message. */
export async function linkAgentProposal(userId: string, conversationId: string, proposal: MemoryProposal): Promise<void> {
  const last = await q.one<{ id: string }>("SELECT id FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC, id DESC LIMIT 1", conversationId);
  // An add, or the new text of an update (a topic-key update or a conflict, CORE-MEM-TOPIC/CONFLICT).
  const change = proposal.changes.find((ch) => ch.op === 'add') ?? proposal.changes.find((ch) => ch.op === 'update');
  const text = change && 'after' in change ? change.after.content : '';
  await q.run(`INSERT INTO chat_memory_links (id, user_id, conversation_id, message_id, kind, proposal_id, drawer_kind, drawer_key, preview)
    VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`, randomUUID(), userId, conversationId, last?.id ?? null, proposal.id, proposal.drawer.kind, proposal.drawer.key ?? '', preview(text));
}

/** Memories and proposals that came from a conversation (the caller's own), oldest first. */
export async function conversationMemories(userId: string, conversationId: string): Promise<ChatMemory[]> {
  const c = await ownConversation(userId, conversationId);
  const rows = await q.all<LinkRow>(`
    SELECT l.id, l.message_id, l.kind, l.memory_id, l.proposal_id, l.drawer_kind, l.drawer_key, l.preview, l.created_at,
           m.id AS mem_id, m.content AS mem_content, p.status AS p_status
      FROM chat_memory_links l
      LEFT JOIN memories m ON m.id = l.memory_id AND m.user_id = l.user_id
      LEFT JOIN memory_file_proposals p ON p.id = l.proposal_id AND p.user_id = l.user_id
     WHERE l.conversation_id = ? AND l.user_id = ?
     ORDER BY l.created_at DESC, l.id DESC LIMIT ${MAX_CHAT_MEMORIES}`, c.id, userId);
  const out: ChatMemory[] = [];
  for (const r of rows.reverse()) {
    let memoryId = r.mem_id;
    let text = r.mem_content ?? r.preview;
    let status: ChatMemoryStatus = memoryId ? 'saved' : 'removed';
    if (r.kind === 'proposed') {
      status = r.p_status === 'approved' ? 'removed' : (r.p_status ?? 'cancelled');
      if (r.p_status === 'approved') {
        // The memory an approved proposal created or changed (a conflict kept new, a topic update), if it still exists.
        const made = await q.one<{ id: string; content: string }>(`SELECT m.id, m.content FROM memory_versions v JOIN memories m ON m.id = v.memory_id AND m.user_id = v.user_id
          WHERE v.proposal_id = ? AND v.user_id = ? AND v.change IN ('create', 'update') ORDER BY v.version DESC LIMIT 1`, r.proposal_id!, userId);
        if (made) { memoryId = made.id; text = made.content; status = 'saved'; }
      }
    }
    out.push({
      id: r.id, kind: r.kind, messageId: r.message_id, drawerId: drawerId(drawerOf(r.drawer_kind, r.drawer_key)),
      text: preview(text), memoryId: status === 'saved' ? memoryId : null, proposalId: r.proposal_id, status, createdAt: r.created_at,
    });
  }
  return out;
}
