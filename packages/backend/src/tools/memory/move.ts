/**
 * memory_move tool (MEM-CACHE-01): move one of the owner's memories to
 * another drawer ("this belongs to project alpha", "keep this for Sara").
 *
 * Owner only: the run must be the owner's own turn (never one that answers
 * an outsider), both drawers must be open for the run and the agent may
 * write them (CORE-PERMS-01), and every call waits for a one-time owner
 * approval (APPROVAL_REQUIRED_TOOLS). Versioned like an edit; the topic key
 * goes with the memory and must be free in the new drawer.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { toolMemoryUser } from './scope.js';
import { repositories } from '../../repositories/index.js';
import { toolActor } from '../../repositories/actor.js';
import { ScopeError } from '../../repositories/scope.js';
import { DrawerInputError, drawerId, parseDrawerId } from '../../memory/drawers.js';
import { MoveError } from '../../memory/learning.js';
import { TopicKeyTakenError } from '../../memory/storage.js';

const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `Move refused: ${msg}` }], error: msg });

export const memoryMoveTool: Tool = {
  name: 'memory_move',
  description: `Move a memory (id from memory_search) to another drawer when it was saved in the wrong place.
Drawers: "owner", "experience", "project:<slug>", "task:<id>", "people:<id>".
Both drawers must be open in this conversation. The owner approves each move;
the memory keeps its text, history and topic key.`,
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Memory id' },
      drawer: { type: 'string', description: 'Target drawer, e.g. "project:alpha"' },
      reason: { type: 'string', description: 'Why it moves (kept in the history)' },
    },
    required: ['id', 'drawer'],
  },
  async execute(params: { id?: unknown; drawer?: unknown; reason?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    if (!toolMemoryUser(context)) return fail('no user for this memory');
    if (context?.toolPolicy) return fail('not available when answering someone else');
    if (typeof params.id !== 'string' || !params.id) return fail('id is required');
    let to;
    try { to = parseDrawerId(params.drawer); } catch (err) {
      if (err instanceof DrawerInputError) return fail('drawer must be like "owner" or "project:alpha"');
      throw err;
    }
    try {
      const { memory, from } = await repositories.memory.move(toolActor(context), params.id, to, typeof params.reason === 'string' ? params.reason : null);
      return {
        content: [{ type: 'text', text: `Memory ${memory.id} moved from ${drawerId(from)} to ${drawerId(to)} (new version saved).` }],
        data: { success: true, memoryId: memory.id, from: drawerId(from), to: drawerId(to) },
      } as ToolResult;
    } catch (err) {
      if (err instanceof ScopeError) return fail(err.message);
      if (err instanceof MoveError) return fail(err.message);
      if (err instanceof TopicKeyTakenError) return fail(err.message);
      throw err;
    }
  },
};
