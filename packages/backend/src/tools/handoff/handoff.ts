/**
 * The agent's own handoff note (CORE-MEM-HANDOFF): handoff_save writes a new
 * version of "done / left / next / open questions" for the conversation or
 * board task it works in now; handoff_read shows the newest one. Both touch
 * only that note of this agent and this owner (scope from the trusted run
 * context, memory/handoff/scope.ts), so every agent has them without a
 * grant. Never offered in a channel (outside) turn.
 */
import type { Tool, ToolResult } from '../types.js';
import { cleanHandoff, handoffBlock, HandoffInputError, latestHandoff, saveHandoff, MAX_ITEMS, MAX_ITEM_CHARS } from '../../memory/handoff/store.js';
import { toolHandoffScope } from '../../memory/handoff/scope.js';

const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], error: text });

const list = (what: string) => ({
  type: 'array',
  description: `${what} (up to ${MAX_ITEMS} short lines of at most ${MAX_ITEM_CHARS} characters)`,
  items: { type: 'string' },
});

export const handoffSaveTool: Tool = {
  name: 'handoff_save',
  selfOnly: true,
  description: 'Save a short handoff note for your next session in this chat or board task, so you can continue from it later: what is done, what is left, the next steps and open questions for the owner. Each call saves a new version; give the whole note every time. Never put keys, passwords or tokens in it.',
  input_schema: {
    type: 'object',
    properties: {
      done: list('What is finished'),
      left: list('What is still open'),
      next: list('The next steps'),
      questions: list('Open questions for the owner'),
    },
  },
  idempotent: true,
  async execute(params, context): Promise<ToolResult> {
    const where = await toolHandoffScope(context);
    if (typeof where === 'string') return fail(`Handoff not saved: ${where}.`);
    let body;
    try { body = cleanHandoff(params); } catch (err) {
      if (err instanceof HandoffInputError) return fail(`Handoff not saved: ${err.message}.`);
      throw err;
    }
    const h = await saveHandoff(where.scope, body, 'agent', where.runId);
    return { content: [{ type: 'text', text: `Handoff saved (version ${h.version}); your next session here starts from it.` }], details: { handoff: h } };
  },
};

export const handoffReadTool: Tool = {
  name: 'handoff_read',
  selfOnly: true,
  description: 'Read the newest handoff note you (or the owner) left for this chat or board task.',
  input_schema: { type: 'object', properties: {} },
  idempotent: true,
  async execute(_params, context): Promise<ToolResult> {
    const where = await toolHandoffScope(context);
    if (typeof where === 'string') return fail(`No handoff: ${where}.`);
    const h = await latestHandoff(where.scope);
    if (!h) return { content: [{ type: 'text', text: 'No handoff note yet for this chat or task.' }] };
    return { content: [{ type: 'text', text: handoffBlock(h) }], details: { handoff: h } };
  },
};
