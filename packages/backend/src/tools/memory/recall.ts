/**
 * memory_recall tool (MEM-CACHE-01): "what this reply remembered", read only.
 *
 *   op 'trace'      the recall trace of one of this agent's own replies: by
 *                   message_id or run_id, or (neither) its newest reply in this
 *                   conversation — the pinned facts, memories (why each one:
 *                   pinned / topic / graph / meaning / keyword) and handoff note
 *                   it used, and how its context was built
 *   op 'summaries'  the stored summaries of older turns of this conversation
 *   op 'metrics'    cache hit rates, context size, time to the first word
 *
 * Same gates as the owner-only recall API: the run user is the owner
 * account, never a turn that answers an outsider; a trace only of a reply of
 * this agent in the owner's own conversations; a forgotten memory shows no
 * text (trace.ts), and an item of a drawer that is not open for this run
 * (another project's memory, a reply in another conversation) is listed
 * without its text.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { all, one, sql } from '../../repositories/sql-steps.js';
import { traceForMessage, traceForRun, traceMetrics, type TraceView } from '../../memory/context/trace.js';
import { cacheMetrics } from '../../memory/context/metrics.js';
import { reviewOwner } from './review.js';
import { toolMemoryDrawers } from './scope.js';
import { drawerId } from '../../memory/drawers.js';
import { getProject } from '../../memory/scopes/store.js';

/** The trace with text only for items of drawers open for this run. */
async function openItemsOnly(t: TraceView, ownerId: string, context?: ToolExecutionContext): Promise<TraceView> {
  const drawers = toolMemoryDrawers(context);
  const open = new Set(drawers.map(drawerId));
  // A department fact only for the department of a project open in this run (unknown -> hidden).
  const departments = new Set<string>();
  for (const d of drawers) {
    if (d.kind !== 'project' || !d.key) continue;
    const p = await getProject(ownerId, d.key).catch(() => null);
    if (p && !p.archived) departments.add(`department:${p.departmentId}`);
  }
  const visible = (i: TraceView['items'][number]): boolean => {
    if (i.kind === 'handoff') return true; // a note of this agent's own conversation or task
    if (i.kind === 'fact') return i.drawer === 'company' ? open.has('owner') : i.drawer?.startsWith('department:') ? departments.has(i.drawer) : !!i.drawer && open.has(i.drawer);
    return !!i.drawer && open.has(i.drawer) && (!i.nowIn || open.has(i.nowIn));
  };
  // MEM-GAPS-02: drawers of the trace are named only when open in this run; the rest is a count.
  const named = (list: string[]) => list.filter((d) => open.has(d));
  const notLoaded = t.notLoaded
    ? { drawers: t.notLoaded.drawers.filter((d) => open.has(d.drawer)), more: t.notLoaded.more + t.notLoaded.drawers.filter((d) => !open.has(d.drawer)).length }
    : null;
  const traceContext = t.context.drawers ? { ...t.context, drawers: { loaded: named(t.context.drawers.loaded), noAccess: named(t.context.drawers.noAccess) } } : t.context;
  return { ...t, context: traceContext, notLoaded, items: t.items.map((i) => (visible(i) ? i : { ...i, preview: undefined, hidden: true } as typeof i)) };
}

const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `memory_recall refused: ${msg}` }], error: msg });
const ok = (text: string, data: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text }], data: { success: true, ...data } } as ToolResult);
const OPS = ['trace', 'summaries', 'metrics'] as const;

function traceText(t: TraceView): string {
  const c = t.context;
  const lines = t.items.map((i) => {
    const what = i.kind === 'fact' ? `pinned fact [${i.drawer}]` : i.kind === 'handoff' ? `handoff note [${i.drawer}]` : `memory ${i.id} [${i.drawer}] (${i.why}${typeof i.score === 'number' ? ` ${i.score}` : ''})`;
    const state = i.state === 'active' ? '' : ` — now ${i.state}${i.nowIn ? ` (in ${i.nowIn})` : ''}`;
    const hidden = (i as { hidden?: boolean }).hidden ? ' (drawer not open in this conversation)' : '';
    return `- ${what}${i.preview ? `: ${i.preview}` : ''}${hidden}${state}`;
  });
  return [
    `Reply ${t.messageId ?? t.runId} (${t.createdAt}) used ${t.items.length} item(s):`,
    ...(lines.length ? lines : ['- nothing from memory']),
    ...(t.notLoaded && (t.notLoaded.drawers.length || t.notLoaded.more)
      ? [`Not loaded: ${[...t.notLoaded.drawers.map((d) => `${d.drawer} (${d.why.replace('_', ' ')})`), ...(t.notLoaded.more ? [`${t.notLoaded.more} other drawer(s)`] : [])].join(', ')}.`]
      : []),
    `Context: ${c.keptTurns} turn(s) in full, ${c.summarisedTurns} as summaries, ${c.droppedTurns} left out; pack ${c.fromCache?.pack ? 'from cache' : 'built'}, ${c.packChars} memory characters, ~${c.promptTokens} prompt tokens${c.ttftMs !== null ? `, first word after ${c.ttftMs} ms` : ''}.`,
  ].join('\n');
}

export const memoryRecallTool: Tool = {
  name: 'memory_recall',
  description: `Read what one of your own replies remembered (read only).
op "trace": the pinned facts, memories (and why each was used) and handoff note a reply used, and how its context was built. Give message_id or run_id; without them, your newest reply in this conversation.
op "summaries": the stored summaries of the older turns of this conversation.
op "metrics": memory cache hit rates, context size and time to the first word.`,
  input_schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: [...OPS] },
      message_id: { type: 'string', description: 'trace: the reply message id' },
      run_id: { type: 'string', description: 'trace: the reply run id' },
    },
    required: ['op'],
  },
  async execute(params: { op?: unknown; message_id?: unknown; run_id?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    const owner = await reviewOwner(context);
    if (typeof owner !== 'string') return fail(owner.refused);
    if (!(OPS as readonly unknown[]).includes(params?.op)) return fail(`op must be one of ${OPS.join(', ')}`);

    if (params.op === 'metrics') {
      const m = { process: cacheMetrics(), recent: await traceMetrics(owner) };
      const rate = m.recent.packHitRate === null ? 'n/a' : `${Math.round(m.recent.packHitRate * 100)}%`;
      return ok(`Last ${m.recent.turns} turn(s): context pack from cache ${rate}, ~${m.recent.avgPromptTokens ?? 0} prompt tokens on average, first word p50 ${m.recent.ttftMs.p50 ?? 'n/a'} ms.`, m);
    }

    const session = typeof context?.sessionId === 'string' ? context.sessionId : '';
    if (params.op === 'summaries') {
      const own = session ? await sql().read(one('SELECT 1 AS x FROM chat_sessions WHERE id = ? AND user_id = ?', session, owner)) : undefined;
      if (!own) return fail('summaries are kept only for the owner\'s saved conversations');
      const rows = await sql().read(all<{ id: string; level: number; first_index: number; last_index: number; turns: number; summary: string; source: string }>(
        'SELECT id, level, first_index, last_index, turns, summary, source FROM chat_turn_summaries WHERE session_id = ? AND user_id = ? ORDER BY level, first_index', session, owner)).catch(() => []);
      const summaries = rows.map((r) => ({ id: r.id, level: Number(r.level), firstTurn: Number(r.first_index) + 1, lastTurn: Number(r.last_index) + 1, turns: Number(r.turns), text: r.summary, source: r.source }));
      return ok(summaries.length ? summaries.map((s) => `- turns ${s.firstTurn}-${s.lastTurn}: ${s.text}`).join('\n') : 'No summaries yet: the whole conversation still fits.', { summaries });
    }

    let trace: TraceView | undefined;
    if (typeof params.message_id === 'string' && params.message_id) trace = await traceForMessage(owner, params.message_id);
    else if (typeof params.run_id === 'string' && params.run_id) trace = await traceForRun(owner, params.run_id);
    else if (session) {
      const agent = context?.agentId ? 'agent_id = ?' : 'agent_id IS NULL';
      const row = await sql().read(one<{ run_id: string }>(
        `SELECT run_id FROM memory_recall_traces WHERE user_id = ? AND session_id = ? AND ${agent} ORDER BY created_at DESC, run_id DESC LIMIT 1`,
        owner, session, ...(context?.agentId ? [context.agentId] : []))).catch(() => undefined);
      trace = row ? await traceForRun(owner, row.run_id) : undefined;
    }
    // Only this agent's own replies.
    if (!trace || (trace.agentId ?? null) !== (context?.agentId ?? null)) return fail('no reply of yours with that id');
    const shown = await openItemsOnly(trace, owner, context);
    return ok(traceText(shown), { trace: shown });
  },
};
