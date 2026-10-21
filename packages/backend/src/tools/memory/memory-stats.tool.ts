/**
 * Memory Stats Tool
 *
 * Returns a summary of what the agent knows about a user:
 * total count, breakdown by type, most-used tags, oldest/newest entries.
 *
 * Useful for agents to understand their own knowledge base before
 * deciding whether to save new information or run a reflection.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { toolMemoryUser } from './scope.js';
import { repositories } from '../../repositories/index.js';
import { toolMemoryActor } from '../../repositories/actor.js';

export const memoryStatsTool: Tool = {
  name: 'memory_stats',
  description: `Get a quick summary of stored memories for a user.

Returns:
- Total memory count and size breakdown by type
- Top 10 most-used tags
- Oldest and newest memory timestamps
- How many high-importance (>= 7) memories exist

Only the memory drawers open for this conversation are counted.

Use this before memory_reflect or memory_search to understand what you know.`,

  input_schema: {
    type: 'object',
    properties: {},
    required: [],
    examples: [
      {
        description: 'Get overview of stored memories and knowledge base',
      },
    ],
  },

  async execute(_params: Record<string, any>, context?: ToolExecutionContext): Promise<ToolResult> {
    // CORE-03: the run's own user (never a model-supplied id), open drawers
    // only (B1.6: counted by the memory repository from the tool call's actor).
    if (!toolMemoryUser(context)) {
      return { content: [{ type: 'text', text: 'No memories stored yet for this user.' }] };
    }

    try {
      const stats = await repositories.memory.stats(await toolMemoryActor(context));
      if (!stats || stats.total === 0) {
        return {
          content: [{ type: 'text', text: 'No memories stored yet for this user.' }],
        };
      }
      const { total, byType, topTags } = stats;
      const highImp = stats.highImportance;
      const dates = { oldest: stats.oldest ?? undefined, newest: stats.newest ?? undefined };

      // Build readable output
      const lines: string[] = [];
      lines.push('Memory stats (drawers open for this conversation)');
      lines.push(`Total: ${total} memories`);
      lines.push(`High importance (>= 7): ${highImp}`);
      lines.push('');

      lines.push('By type:');
      for (const row of byType) {
        lines.push(`  ${row.type}: ${row.n}`);
      }

      if (topTags.length > 0) {
        lines.push('');
        lines.push('Top tags:');
        for (const [tag, count] of topTags) {
          lines.push(`  ${tag}: ${count}x`);
        }
      }

      lines.push('');
      lines.push(`Date range: ${dates?.oldest?.slice(0, 10) ?? '?'} → ${dates?.newest?.slice(0, 10) ?? '?'}`);

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        data: {
          total,
          highImportance: highImp,
          byType: Object.fromEntries(byType.map(r => [r.type, r.n])),
          topTags: Object.fromEntries(topTags),
          oldest: dates?.oldest,
          newest: dates?.newest,
        },
      } as any;

    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Error getting memory stats: ${error.message}` }],
        error: error.message,
      };
    }
  },
};
