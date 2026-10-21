/**
 * Memory Save Tool
 *
 * Save important information to the agent's memory system
 * Information persists across conversations and can be recalled later
 */

import type { Tool, ToolResult } from '../types.js';
import type { MemoryType } from '../../memory/types.js';
import type { ToolExecutionContext } from '../types.js';
import { toolMemoryUser } from './scope.js';
import { repositories } from '../../repositories/index.js';
import { toolMemoryActor } from '../../repositories/actor.js';
import { isUserConversation, linkAgentProposal } from '../../services/chat-memory.js';
import { DrawerInputError, defaultDrawerForType, parseDrawerId, sameDrawer, type DrawerRef } from '../../memory/drawers.js';

interface MemorySaveParams {
  /** The information to remember */
  content: string;
  /** Type of memory: fact, preference, task, conversation, goal */
  type?: MemoryType;
  /** How important is this information (1-10, default: 5) */
  importance?: number;
  /** Tags for categorization (optional) */
  tags?: string[];
  /** Additional metadata (optional) */
  metadata?: Record<string, any>;
  /** Ignored: the user comes from the run context (CORE-03) */
  userId?: unknown;
  /** Drawer id, e.g. "project:alpha" (only a drawer loaded for this turn) */
  drawer?: string;
  /** Stable topic key (CORE-MEM-TOPIC), e.g. "favorite-editor"; normalized */
  topic_key?: string;
}

export const memorySaveTool: Tool = {
  name: 'memory_save',
  description: `Save important information to memory for future recall.

Use this tool when you learn something important about:
- User preferences (favorite color, language, etc.)
- Facts about the user (name, location, job, etc.)
- Tasks or goals the user mentioned
- Important conversation context
- User's habits or patterns

Routine facts are saved at once. Important items (owner identity or
preferences, people, money, credentials, health, legal, permissions,
decisions, or anything contradicting an existing memory) wait for the
owner's approval; the result then says "Waiting for owner approval".

Evolving facts: give a stable topic_key (e.g. "favorite-editor",
"project-alpha-status"). Saving the same topic_key again updates that memory
as a new version instead of adding a second one; a value that contradicts it
(negated or opposite) waits for the owner's decision (keep new / keep old /
keep both). Any title works as a key: "Favorite Editor" -> "favorite-editor".

The saved information will be:
- Stored in the memory system (every change is versioned)
- Searchable via memory_search tool
- Automatically recalled in relevant future conversations

Memory types:
- "fact": Factual information (user's name, location, etc.)
- "preference": User preferences (likes, dislikes, settings)
- "task": Tasks, TODOs, or goals
- "conversation": Important conversation context
- "goal": Long-term goals or objectives

Importance scale (1-10):
- 1-3: Low importance (minor details)
- 4-6: Medium importance (useful context)
- 7-9: High importance (critical facts)
- 10: Critical (user's name, core preferences)

Examples:
- "User's name is Ahmed" (type: fact, importance: 10)
- "User prefers Arabic language" (type: preference, importance: 8)
- "User wants to learn Python" (type: goal, importance: 7)
- "User mentioned visiting Paris last summer" (type: conversation, importance: 4)`,

  input_schema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The information to remember',
      },
      type: {
        type: 'string',
        enum: ['fact', 'preference', 'task', 'conversation', 'goal'],
        description: 'Type of memory (default: conversation)',
      },
      importance: {
        type: 'number',
        minimum: 1,
        maximum: 10,
        description: 'Importance level 1-10 (default: 5)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags for categorization',
      },
      metadata: {
        type: 'object',
        description: 'Additional metadata',
      },
      drawer: {
        type: 'string',
        description: 'Memory drawer: "owner", "experience", or one of the drawers open for this conversation such as "project:<slug>", "task:<id>", "people:<id>". Default: chosen by type.',
      },
      topic_key: {
        type: 'string',
        description: 'Stable topic of an evolving fact (e.g. "favorite-editor"). The same topic_key in the same drawer updates that memory as a new version.',
      },
    },
    required: ['content'],
    examples: [
      {
        content: 'User prefers dark mode and concise responses',
        type: 'preference',
        description: 'Save user preference to memory',
      },
      {
        content: 'Discussed implementing authentication using JWT tokens',
        type: 'conversation',
        tags: ['auth', 'jwt', 'security'],
        description: 'Save conversation topic with tags',
      },
      {
        content: 'User birthday is March 15th',
        type: 'fact',
        description: 'Save personal fact about user',
      },
    ],
  },

  async execute(rawParams, context?: ToolExecutionContext): Promise<ToolResult> {
    const params = rawParams as MemorySaveParams;
    try {
      // CORE-03: the run's own user; a drawer only from those open for this turn.
      if (!toolMemoryUser(context)) throw new Error('No user for this memory');
      const actor = await toolMemoryActor(context);
      const open = actor.drawers ?? [];
      let drawer: DrawerRef = defaultDrawerForType(params.type || 'conversation');
      if (params.drawer !== undefined && params.drawer !== null && params.drawer !== '') {
        try {
          drawer = parseDrawerId(params.drawer);
        } catch (err) {
          if (err instanceof DrawerInputError) throw new Error('Invalid drawer');
          throw err;
        }
      }
      if (!open.some((d) => sameDrawer(d, drawer))) {
        throw new Error('That memory drawer is not open for this conversation');
      }
      // CORE-PERMS-01: the owner may make a drawer read-only for this agent.
      if (actor.writeKinds && !actor.writeKinds.includes(drawer.kind)) {
        throw new Error('This agent may not write to that memory drawer');
      }

      // Validate importance
      const importance = Math.max(1, Math.min(10, params.importance || 5));
      const type = params.type || 'conversation';

      // CORE-05: routine facts are saved (versioned); important ones become a
      // proposal the owner approves. Outsider turns never auto-save (B1.6:
      // the memory repository sets user, drawers, origin and version actor).
      // CHAT-PRO-02 E: in a saved chat conversation the owner decides every
      // memory in the chat (Accept / Reject); nothing is saved by itself.
      const chat = context?.chatPlan === true && !context.toolPolicy && await isUserConversation(context.userId, context.sessionId);
      const outcome = await repositories.memory.learn(actor, {
        candidates: [{ content: params.content, type, importance, drawer, ...(params.topic_key !== undefined ? { topicKey: params.topic_key } : {}) }],
        metadata: { ...params.metadata, tags: params.tags || [], savedAt: new Date().toISOString() },
        ...(chat ? { review: true } : {}),
      });
      const memory = outcome.saved[0];
      const proposal = outcome.proposed[0];
      const updated = outcome.updated[0];

      if (updated) {
        return {
          content: [{ type: 'text', text: `Updated memory ${updated.id} (topic "${updated.topicKey}") as a new version.` }],
          data: { success: true, memoryId: updated.id, topicKey: updated.topicKey, updatedExisting: true },
        };
      }

      if (proposal && chat) {
        await linkAgentProposal(context!.userId!, context!.sessionId!, proposal);
        return {
          content: [{ type: 'text', text: `Proposed to the owner: the chat shows this memory with Accept and Reject. It is saved only if the owner accepts it (proposal ${proposal.id}).` }],
          data: { success: true, pendingApproval: true, proposalId: proposal.id, reasons: proposal.reasons },
        };
      }
      if (proposal?.conflictWith) {
        return {
          content: [{
            type: 'text',
            text: `Waiting for the owner: this contradicts memory ${proposal.conflictWith}. Nothing was overwritten; the owner keeps the new text, the old one, or both (proposal ${proposal.id}).`,
          }],
          data: { success: true, pendingApproval: true, conflict: true, conflictWith: proposal.conflictWith, proposalId: proposal.id, reasons: proposal.reasons },
        };
      }
      if (proposal) {
        return {
          content: [{
            type: 'text',
            text: `Waiting for owner approval: this memory touches ${proposal.reasons.filter((r) => !r.startsWith('conflicts-with:')).join(', ') || 'an important topic'}. ` +
              `It is saved only after the owner approves proposal ${proposal.id}.`,
          }],
          data: { success: true, pendingApproval: true, proposalId: proposal.id, reasons: proposal.reasons },
        };
      }
      if (!memory) {
        const reason = outcome.skipped[0]?.reason || 'not saved';
        if (reason === 'already known') {
          return { content: [{ type: 'text', text: 'Already in memory; nothing new saved.' }], data: { success: true, duplicate: true } };
        }
        throw new Error(reason === 'needs owner approval' ? 'This memory needs owner approval and was not saved' : reason);
      }
      const memoryLayer = memory.memoryLayer;
      const expiryTimestamp = memory.expiryTimestamp;

      // Layer display name
      const layerDisplay = memoryLayer === 'working'
        ? 'Working (24h)'
        : memoryLayer === 'experiential'
        ? 'Experiential (90 days)'
        : 'Factual (permanent)';

      return {
        content: [
          {
            type: 'text',
            text: `✓ Memory saved successfully!\n\nContent: ${params.content}\nType: ${memory.type}\nImportance: ${importance}/10 (${layerDisplay})\nID: ${memory.id}${
              params.tags && params.tags.length > 0 ? `\nTags: ${params.tags.join(', ')}` : ''
            }\n\nThis information will be recalled automatically in future relevant conversations.`,
          },
        ],
        data: {
          success: true,
          memoryId: memory.id,
          type: memory.type,
          importance,
          memoryLayer,
          expiryTimestamp,
          ...(memory.topicKey ? { topicKey: memory.topicKey } : {}),
        },
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Error saving memory: ${error.message}`,
          },
        ],
        error: error.message,
      };
    }
  },
};
