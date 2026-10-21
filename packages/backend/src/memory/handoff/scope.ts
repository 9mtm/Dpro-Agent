/**
 * Which handoff scope a turn or a tool call belongs to (CORE-MEM-HANDOFF).
 * Built only from trusted server context (the conversation row, the task
 * run row, the tools registry context), never from model input.
 */

import { one, sql } from '../../repositories/sql-steps.js';
import type { ToolExecutionContext } from '../../tools/types.js';
import { handoffBlock, handoffFor, MAIN_AGENT, type HandoffScope } from './store.js';

/** Small-agent runs are one-off delegated lookups: they keep no handoff. */
export const NO_HANDOFF_AGENTS = new Set(['small-local-agent']);

/** The agent a turn runs as: the given one, else the primary agent (as the chat turn resolves it), else MAIN_AGENT. */
export async function handoffAgentId(agentId?: string | null): Promise<string> {
  if (agentId) return agentId;
  const primary = await sql().read(one<{ id: string }>('SELECT id FROM agents_config WHERE is_primary = 1 ORDER BY id LIMIT 1'))
    ?? await sql().read(one<{ id: string }>('SELECT id FROM agents_config ORDER BY created_at, id LIMIT 1'));
  return primary?.id ?? MAIN_AGENT;
}

/** The scope of an owner's own saved conversation, or undefined when it is not theirs. */
export async function conversationScope(ownerId: string, conversationId: string, agentId?: string | null): Promise<HandoffScope | undefined> {
  const c = await sql().read(one<{ project_id: string | null }>('SELECT project_id FROM chat_sessions WHERE id = ? AND user_id = ?', conversationId, ownerId));
  if (!c) return undefined;
  return { ownerId, agentId: await handoffAgentId(agentId), kind: 'conversation', scopeId: conversationId, projectId: c.project_id ?? null };
}

/** Owner of a task run: the user who started it, else the instance owner (board tasks run without a user). */
export async function taskRunOwner(runUserId: string | null | undefined): Promise<string | undefined> {
  if (runUserId) return runUserId;
  const owner = await sql().read(one<{ id: string }>("SELECT id FROM users WHERE role = 'owner' AND COALESCE(status, 'active') = 'active' ORDER BY created_at ASC, id ASC LIMIT 1"));
  return owner?.id;
}

/** The scope of a task run (by its row), or undefined when it keeps none. */
export async function taskRunScope(run: { task_id: string; agent_id: string; user_id: string | null }): Promise<HandoffScope | undefined> {
  if (NO_HANDOFF_AGENTS.has(run.agent_id)) return undefined;
  const ownerId = await taskRunOwner(run.user_id);
  return ownerId ? { ownerId, agentId: run.agent_id, kind: 'task', scopeId: run.task_id, projectId: null } : undefined;
}

/**
 * The scope of a handoff tool call: an owner's own conversation (chat page
 * turn) or the board task of a durable task run. A channel (outside) turn,
 * a delegated small agent or any other context gets an error text.
 */
export async function toolHandoffScope(context: ToolExecutionContext | undefined): Promise<{ scope: HandoffScope; runId: string | null } | string> {
  if (!context || context.toolPolicy) return 'handoff notes are kept only in the owner\'s own chats and board tasks';
  if (context.taskId) {
    if (!context.taskRun || !context.agentId) return 'handoff notes are kept only inside a durable task run';
    const row = await sql().read(one<{ task_id: string; agent_id: string; user_id: string | null }>('SELECT task_id, agent_id, user_id FROM task_runs WHERE id = ?', context.taskRun.runId));
    if (!row || row.task_id !== context.taskId || row.agent_id !== context.agentId) return 'this task run is unknown';
    const scope = await taskRunScope(row);
    return scope ? { scope, runId: context.taskRun.runId } : 'this agent keeps no handoff notes';
  }
  if (context.chatPlan !== true || !context.userId || !context.sessionId) return 'handoff notes are kept only in the owner\'s own chats and board tasks';
  const scope = await conversationScope(context.userId, context.sessionId, context.agentId);
  if (!scope) return 'handoff notes are kept only in the owner\'s own saved conversations';
  const running = await sql().read(one<{ run_id: string }>("SELECT run_id FROM chat_run_journal WHERE session_id = ? AND user_id = ? AND state = 'running' ORDER BY started_at DESC LIMIT 1", context.sessionId, context.userId)).catch(() => undefined);
  return { scope, runId: running?.run_id ?? null };
}

/** The prompt block of the agent's newest note for an owner's own conversation (or its project), or ''. */
export async function conversationHandoffText(ownerId: string, conversationId: string, agentId?: string | null): Promise<string> {
  const scope = await conversationScope(ownerId, conversationId, agentId);
  const h = scope ? await handoffFor(scope) : undefined;
  return h && scope ? handoffBlock(h, scope) : '';
}

/** The newest note for an owner's own conversation as { id, scope, text } (MEM-CACHE-01 context pack / trace), or null. */
export async function packHandoffText(ownerId: string, conversationId: string, agentId?: string | null): Promise<{ id: string; scope: string; text: string } | null> {
  const scope = await conversationScope(ownerId, conversationId, agentId);
  const h = scope ? await handoffFor(scope) : undefined;
  return h && scope ? { id: h.id, scope: `${h.kind}:${h.scopeId}`, text: handoffBlock(h, scope) } : null;
}

/** The prompt block of the agent's newest note for a task run's board task, or ''. */
export async function taskHandoffText(run: { task_id: string; agent_id: string; user_id: string | null }): Promise<string> {
  const scope = await taskRunScope(run);
  const h = scope ? await handoffFor(scope) : undefined;
  return h && scope ? handoffBlock(h, scope) : '';
}
