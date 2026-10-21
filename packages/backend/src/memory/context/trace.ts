/**
 * Reply recall trace (MEM-CACHE-01, migration 111): what one chat turn put
 * into its context — the owner's pinned scope facts, memories (pinned /
 * topic / graph / meaning / keyword), the handoff note — and how the context was built (turns kept in full or
 * summarised, cache hit, size, time to first word).
 *
 * Stored per run, linked to the assistant message through
 * chat_messages.run_id. Ids, drawers and reasons only; the read joins the
 * current memory (a forgotten memory shows as forgotten, without text).
 * Turns that answer an outside sender store nothing (the caller does not
 * call saveTrace for them).
 */

import { all, one, run, sql, tableExists } from '../../repositories/sql-steps.js';
import { percentile } from './metrics.js';
import type { TraceItem } from './pack.js';
import { parseDrawerId, drawerId as drawerIdOf } from '../drawers.js';

export interface TraceContext {
  /** Messages of the conversation sent to the model in full. */
  keptTurns: number;
  /** Older messages given as summaries. */
  summarisedTurns: number;
  /** Summary rows used (ids), oldest first. */
  summaries: Array<{ id: string; turns: number; source: 'model' | 'fallback' | 'inline' }>;
  /** Messages left out entirely (over budget even as summaries). */
  droppedTurns: number;
  fromCache: { pack: boolean; recall: boolean };
  budgetTokens: number;
  numCtx: number;
}

export interface TraceRecord {
  runId: string;
  userId: string;
  sessionId: string;
  agentId: string | null;
  items: TraceItem[];
  context: TraceContext;
  packHit: boolean;
  packChars: number;
  promptTokens: number;
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
let ready: boolean | null = null;
async function tableReady(): Promise<boolean> {
  if (ready) return true;
  ready = await sql().read(tableExists('memory_recall_traces')).catch(() => false);
  return ready;
}
export function resetTraceForTests(): void { ready = null; }

export async function saveTrace(t: TraceRecord): Promise<void> {
  if (!ID.test(t.runId) || !(await tableReady())) return;
  await sql().read(run(`
    INSERT INTO memory_recall_traces (run_id, user_id, session_id, agent_id, items, context, pack_hit, pack_chars, prompt_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (run_id) DO UPDATE SET items = excluded.items, context = excluded.context, pack_hit = excluded.pack_hit,
      pack_chars = excluded.pack_chars, prompt_tokens = excluded.prompt_tokens
    WHERE memory_recall_traces.user_id = excluded.user_id`,
    t.runId, t.userId, t.sessionId.slice(0, 200), t.agentId, JSON.stringify(t.items.slice(0, 64)), JSON.stringify(t.context),
    t.packHit ? 1 : 0, Math.round(t.packChars), Math.round(t.promptTokens), new Date().toISOString()));
}

/** Time to the first word of the reply, once per run. */
export async function setTraceTtft(runId: string, ms: number): Promise<void> {
  if (!ID.test(runId) || !(await tableReady())) return;
  await sql().read(run('UPDATE memory_recall_traces SET ttft_ms = ? WHERE run_id = ? AND ttft_ms IS NULL', Math.max(0, Math.round(ms)), runId));
}

interface TraceRow {
  run_id: string; user_id: string; session_id: string; agent_id: string | null; items: string; context: string;
  pack_hit: number; pack_chars: number; prompt_tokens: number; ttft_ms: number | null; created_at: string;
}

export interface TraceView {
  runId: string;
  messageId: string | null;
  sessionId: string;
  agentId: string | null;
  createdAt: string;
  items: Array<TraceItem & {
    /** active = as used; changed = edited since; moved = now in another drawer; deleted; forgotten (no text). */
    state: 'active' | 'changed' | 'moved' | 'deleted' | 'forgotten';
    type?: string;
    /** Current text, one line, at most 300 characters (memories still present). */
    preview?: string;
    /** Current drawer when it moved. */
    nowIn?: string;
  }>;
  context: TraceContext & { packChars: number; promptTokens: number; ttftMs: number | null };
}

const parse = <T>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };
const oneLine = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

async function view(row: TraceRow): Promise<TraceView> {
  const items = parse<TraceItem[]>(row.items, []);
  const memIds = items.filter((i) => i.kind === 'memory').map((i) => i.id);
  const mems = memIds.length ? await sql().read(all<{ id: string; type: string; content: string; drawer_kind: string | null; drawer_key: string | null; status: string | null; created_at: string }>(
    `SELECT id, type, content, drawer_kind, drawer_key, status, created_at FROM memories WHERE user_id = ? AND id IN (${memIds.map(() => '?').join(', ')})`,
    row.user_id, ...memIds)) : [];
  const byId = new Map(mems.map((m) => [m.id, m]));
  const forgotten = memIds.length ? new Set((await sql().read(all<{ memory_id: string }>(
    `SELECT memory_id FROM memory_versions WHERE user_id = ? AND change = 'forget' AND memory_id IN (${memIds.map(() => '?').join(', ')})`,
    row.user_id, ...memIds)).catch(() => [])).map((r) => r.memory_id)) : new Set<string>();
  const changedSince = memIds.length ? new Set((await sql().read(all<{ memory_id: string }>(
    `SELECT DISTINCT memory_id FROM memory_versions WHERE user_id = ? AND change = 'update' AND created_at > ? AND memory_id IN (${memIds.map(() => '?').join(', ')})`,
    row.user_id, row.created_at, ...memIds)).catch(() => [])).map((r) => r.memory_id)) : new Set<string>();
  const handoffIds = items.filter((i) => i.kind === 'handoff').map((i) => i.id);
  const handoffs = handoffIds.length ? new Set((await sql().read(all<{ id: string }>(
    `SELECT id FROM agent_handoffs WHERE owner_id = ? AND id IN (${handoffIds.map(() => '?').join(', ')})`, row.user_id, ...handoffIds)).catch(() => [])).map((r) => r.id)) : new Set<string>();
  const factIds = items.filter((i) => i.kind === 'fact').map((i) => i.id);
  const facts = factIds.length ? new Map((await sql().read(all<{ id: string; text: string; updated_at: string }>(
    `SELECT id, text, updated_at FROM memory_pinned_facts WHERE owner_id = ? AND id IN (${factIds.map(() => '?').join(', ')})`, row.user_id, ...factIds)).catch(() => []))
    .map((f) => [f.id, f])) : new Map<string, { id: string; text: string; updated_at: string }>();
  const out: TraceView['items'] = items.map((i) => {
    if (i.kind === 'fact') {
      const f = facts.get(i.id);
      if (!f) return { ...i, state: 'deleted' };
      return { ...i, preview: oneLine(f.text, 300), state: f.updated_at > row.created_at ? 'changed' : 'active' };
    }
    if (i.kind === 'handoff') return { ...i, state: handoffs.has(i.id) ? 'active' : 'deleted' };
    const m = byId.get(i.id);
    if (!m) return { ...i, state: forgotten.has(i.id) ? 'forgotten' : 'deleted' };
    let now: string | null = null;
    try { now = drawerIdOf(parseDrawerId(m.drawer_key ? `${m.drawer_kind}:${m.drawer_key}` : (m.drawer_kind ?? 'owner'))); } catch { now = null; }
    const moved = !!(i.drawer && now && now !== i.drawer);
    return {
      ...i, type: m.type, preview: oneLine(m.content, 300),
      state: moved ? 'moved' : changedSince.has(i.id) ? 'changed' : 'active',
      ...(moved ? { nowIn: now! } : {}),
    };
  });
  const message = await sql().read(one<{ id: string }>("SELECT id FROM chat_messages WHERE run_id = ? AND role = 'assistant'", row.run_id)).catch(() => undefined);
  return {
    runId: row.run_id, messageId: message?.id ?? null, sessionId: row.session_id, agentId: row.agent_id, createdAt: row.created_at,
    items: out,
    context: { ...parse<TraceContext>(row.context, {} as TraceContext), packChars: row.pack_chars, promptTokens: row.prompt_tokens, ttftMs: row.ttft_ms },
  };
}

/** The trace of one run of this user, or undefined. */
export async function traceForRun(userId: string, runId: string): Promise<TraceView | undefined> {
  if (!ID.test(runId) || !(await tableReady())) return undefined;
  const row = await sql().read(one<TraceRow>('SELECT * FROM memory_recall_traces WHERE run_id = ? AND user_id = ?', runId, userId));
  return row ? view(row) : undefined;
}

/** The trace of one assistant message of this user's own conversation, or undefined. */
export async function traceForMessage(userId: string, messageId: string): Promise<TraceView | undefined> {
  if (!ID.test(messageId) || !(await tableReady())) return undefined;
  const msg = await sql().read(one<{ run_id: string | null }>(`
    SELECT m.run_id FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
     WHERE m.id = ? AND m.role = 'assistant' AND s.user_id = ?`, messageId, userId));
  return msg?.run_id ? traceForRun(userId, msg.run_id) : undefined;
}

/** Numbers over the user's last `limit` stored turns. */
export async function traceMetrics(userId: string, limit = 200) {
  if (!(await tableReady())) return { turns: 0, packHitRate: null, avgPackChars: null, avgPromptTokens: null, ttftMs: { p50: null, p90: null } };
  const rows = await sql().read(all<{ pack_hit: number; pack_chars: number; prompt_tokens: number; ttft_ms: number | null }>(
    'SELECT pack_hit, pack_chars, prompt_tokens, ttft_ms FROM memory_recall_traces WHERE user_id = ? ORDER BY created_at DESC, run_id DESC LIMIT ?', userId, limit));
  const n = rows.length;
  const avg = (f: (r: (typeof rows)[number]) => number) => (n ? Math.round(rows.reduce((a, r) => a + f(r), 0) / n) : null);
  const ttft = rows.map((r) => r.ttft_ms).filter((v): v is number => typeof v === 'number');
  return {
    turns: n,
    packHitRate: n ? rows.filter((r) => r.pack_hit).length / n : null,
    avgPackChars: avg((r) => r.pack_chars),
    avgPromptTokens: avg((r) => r.prompt_tokens),
    ttftMs: { p50: percentile(ttft, 50), p90: percentile(ttft, 90) },
  };
}

/** Remove the traces of a conversation (it was deleted). */
export async function deleteSessionTraces(sessionId: string): Promise<void> {
  if (!(await tableReady())) return;
  await sql().read(run('DELETE FROM memory_recall_traces WHERE session_id = ?', sessionId));
}
