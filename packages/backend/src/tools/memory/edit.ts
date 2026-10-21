/**
 * memory_edit / memory_delete tools (CORE-05).
 *
 * The agent may edit or delete its user's memories, only in drawers open for
 * the turn. Every change is versioned (actor = agent:<agentId>). A change to
 * an important memory, or one that makes a memory important, becomes a
 * proposal the owner approves; nothing changes before that. A delete keeps
 * the history (reversible); "forget" is memory_forget.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { toolMemoryUser } from './scope.js';
import type { AgentChangeResult } from '../../memory/learning.js';
import { repositories } from '../../repositories/index.js';
import { toolMemoryActor } from '../../repositories/actor.js';
import { ScopeError } from '../../repositories/scope.js';

/** B1.6: the memory repository reaches only the run user's memories in open drawers. */
async function change(context: ToolExecutionContext | undefined, input: Parameters<typeof repositories.memory.change>[1]): Promise<AgentChangeResult> {
  try {
    return await repositories.memory.change(await toolMemoryActor(context), input);
  } catch (err) {
    if (err instanceof ScopeError) return { status: 'refused', reason: err.message };
    throw err;
  }
}

function text(t: string, data?: Record<string, unknown>, error?: string): ToolResult {
  return { content: [{ type: 'text', text: t }], ...(data ? { data } : {}), ...(error ? { error } : {}) };
}

function answer(result: AgentChangeResult, op: 'update' | 'delete', id: string): ToolResult {
  if (result.status === 'refused') return text(`Memory ${op === 'delete' ? 'delete' : 'edit'} refused: ${result.reason}`, undefined, result.reason);
  if (result.status === 'proposed') {
    return text(
      `Waiting for owner approval (${result.reasons.join(', ')}). Nothing changes until the owner approves proposal ${result.proposal.id}.`,
      { success: true, pendingApproval: true, proposalId: result.proposal.id, reasons: result.reasons },
    );
  }
  return text(op === 'delete' ? `Memory ${id} deleted (kept in its history).` : `Memory ${id} updated (new version saved).`,
    { success: true, memoryId: id, op });
}

export const memoryEditTool: Tool = {
  name: 'memory_edit',
  description: `Correct or update an existing memory by id (from memory_search).
Only memories in drawers open for this conversation. Every edit is versioned.
Edits of important memories (owner identity/preferences, people, money,
credentials, health, legal, permissions, decisions) wait for the owner's approval.
topic_key names the memory's stable topic (applied at once; "" removes it), so a
later memory_save with that topic_key updates this memory.`,
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Memory id' },
      content: { type: 'string', description: 'New text' },
      importance: { type: 'number', description: 'New importance 1-10' },
      reason: { type: 'string', description: 'Why the memory changes (kept in the history)' },
      topic_key: { type: 'string', description: 'Stable topic key, e.g. "favorite-editor" ("" removes it)' },
    },
    required: ['id'],
  },
  async execute(params: { id?: unknown; content?: unknown; importance?: unknown; reason?: unknown; topic_key?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    if (!toolMemoryUser(context)) return text('Error: no user for this memory', undefined, 'No user for this memory');
    if (typeof params.id !== 'string' || !params.id) return text('Error: id is required', undefined, 'id is required');
    if (params.content !== undefined && (typeof params.content !== 'string' || !params.content.trim())) {
      return text('Error: content must be text', undefined, 'Invalid content');
    }
    if (params.topic_key !== undefined && params.topic_key !== null && typeof params.topic_key !== 'string') {
      return text('Error: topic_key must be text', undefined, 'Invalid topic key');
    }
    const result = await change(context, {
      memoryId: params.id, op: 'update',
      updates: {
        content: params.content as string | undefined,
        importance: typeof params.importance === 'number' ? params.importance : undefined,
        ...(params.topic_key !== undefined ? { topicKey: params.topic_key as string | null } : {}),
      },
      reason: typeof params.reason === 'string' ? params.reason : null,
    });
    return answer(result, 'update', params.id);
  },
};

export const memoryDeleteTool: Tool = {
  name: 'memory_delete',
  description: `Delete a memory that is wrong or no longer true, by id (from memory_search).
Only memories in drawers open for this conversation. The deletion is versioned
and can be traced; deleting an important memory waits for the owner's approval.
To erase something completely because the owner said "forget this", use memory_forget.`,
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Memory id' },
      reason: { type: 'string', description: 'Why the memory is deleted (kept in the history)' },
    },
    required: ['id'],
  },
  async execute(params: { id?: unknown; reason?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    if (!toolMemoryUser(context)) return text('Error: no user for this memory', undefined, 'No user for this memory');
    if (typeof params.id !== 'string' || !params.id) return text('Error: id is required', undefined, 'id is required');
    const result = await change(context, {
      memoryId: params.id, op: 'delete',
      reason: typeof params.reason === 'string' ? params.reason : null,
    });
    return answer(result, 'delete', params.id);
  },
};
