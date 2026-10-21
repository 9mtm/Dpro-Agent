/**
 * Memory Search Tool
 *
 * Search the agent's memory system for relevant information
 * Uses semantic search to find related memories
 */

import type { Tool, ToolResult } from '../types.js';
import type { ImportanceLevel, MemoryType } from '../../memory/types.js';
import type { ToolExecutionContext } from '../types.js';
import { toolMemoryUser } from './scope.js';
import { repositories } from '../../repositories/index.js';
import { toolMemoryActor } from '../../repositories/actor.js';

interface MemorySearchParams {
  /** Search query */
  query: string;
  /** Ignored: the user comes from the run context (CORE-03) */
  userId?: unknown;
  /** Maximum number of results (default: 5) */
  limit?: number;
  /** Filter by memory type (optional) */
  type?: MemoryType;
  /** Filter by Multi-Tier Memory layer (working, experiential, factual) */
  layer?: 'working' | 'experiential' | 'factual';
  /** Minimum importance level to include (1-10, optional) */
  minImportance?: number;
  /** Filter by tags (optional) */
  tags?: string[];
  /** Filter by visibility (private, team, public) */
  visibility?: 'private' | 'team' | 'public';
  /** Include shared memories from team/public (default: true) */
  includeShared?: boolean;
  /** Only show team-critical memories (default: false) */
  teamCriticalOnly?: boolean;
  /** Filter by source agent ID */
  sourceAgentId?: string;
}

export const memorySearchTool: Tool = {
  name: 'memory_search',
  description: `Search the agent's memory for relevant information, including shared team/public memories.

Use this tool when you need to:
- Recall information about the user
- Find user preferences
- Look up facts you previously learned
- Check if you know something
- Retrieve context from past conversations
- Access shared knowledge from other agents
- Find team-critical information

The search uses semantic similarity, so:
- You don't need exact keywords
- Related concepts will be found
- More recent and important memories rank higher
- By default, includes shared team/public memories

Examples:
- "What is the user's name?" → Finds name facts
- "User's programming preferences" → Finds language/tool preferences
- "Did user mention any goals?" → Finds goal-type memories
- "Team best practices for authentication" → Finds shared team knowledge
- "Public knowledge about API design" → Finds public shared memories

Filters:
- type: Filter by memory type (fact, preference, task, conversation, goal)
- layer: Filter by memory layer (working, experiential, factual)
- visibility: Filter by visibility (private, team, public)
- includeShared: Include team/public memories (default: true)
- teamCriticalOnly: Only show team-critical memories
- sourceAgentId: Filter by which agent created the memory
- minImportance: Only include memories above this importance (1-10)
- tags: Filter by specific tags
- limit: Maximum results to return (default: 5)

Returns:
- Relevant memories with their content
- Importance scores
- Visibility (private/team/public)
- Source agent (who created it)
- Team-critical flag
- When they were saved
- Associated metadata`,

  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What to search for',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 20,
        description: 'Maximum number of results (default: 5)',
      },
      type: {
        type: 'string',
        enum: ['fact', 'preference', 'task', 'conversation', 'goal'],
        description: 'Filter by memory type',
      },
      layer: {
        type: 'string',
        enum: ['working', 'experiential', 'factual'],
        description: 'Filter by memory layer: working (temporary, 24h), experiential (medium-term, 90 days), factual (permanent)',
      },
      minImportance: {
        type: 'number',
        minimum: 1,
        maximum: 10,
        description: 'Minimum importance level',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by tags',
      },
      visibility: {
        type: 'string',
        enum: ['private', 'team', 'public'],
        description: 'Filter by visibility level (private = only yours, team = shared with team, public = shared globally)',
      },
      includeShared: {
        type: 'boolean',
        description: 'Include team and public memories from other agents (default: true)',
      },
      teamCriticalOnly: {
        type: 'boolean',
        description: 'Only show memories marked as team-critical (default: false)',
      },
      sourceAgentId: {
        type: 'string',
        description: 'Filter by which agent created the memory',
      },
    },
    required: ['query'],
    examples: [
      {
        query: 'user preferences',
        description: 'Search for user preferences in memory',
      },
      {
        query: 'authentication discussion',
        type: 'conversation',
        description: 'Find conversations about authentication',
      },
      {
        query: 'API keys',
        tags: ['security', 'credentials'],
        limit: 5,
        description: 'Search for API key related memories with tags',
      },
    ],
  },

  async execute(rawParams, context?: ToolExecutionContext): Promise<ToolResult> {
    const params = rawParams as MemorySearchParams;
    try {
      // CORE-03: the run's own user and only the drawers selected for this turn
      // (B1.6: enforced by the memory repository from the tool call's actor).
      if (!toolMemoryUser(context)) throw new Error('No user for this memory search');

      // Search memories using new Multi-Tier Memory API
      const results = await repositories.memory.search(await toolMemoryActor(context), {
        query: params.query,
        type: params.type,
        layer: params.layer,
        limit: params.limit || 5,
        minImportance: params.minImportance as ImportanceLevel | undefined,
        // visibility / includeShared / teamCriticalOnly / sourceAgentId are not
        // applied by the memory search (they never were; follow-up in BACKLOG
        // TSC-01), so they are not passed.
      });

      // Extract memories from search results
      let filtered = results.map(r => r.memory);

      // Apply tag filter (not supported in storage.search yet)
      if (params.tags && params.tags.length > 0) {
        filtered = filtered.filter((m) => {
          // Only an array of tags counts (a string would match substrings).
          const memoryTags = Array.isArray(m.metadata?.tags) ? (m.metadata!.tags as unknown[]) : [];
          return params.tags!.some((tag) => memoryTags.includes(tag));
        });
      }

      if (filtered.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No memories found for: "${params.query}"${
                params.type ? `\nType filter: ${params.type}` : ''
              }${
                params.layer ? `\nLayer filter: ${params.layer}` : ''
              }${params.minImportance ? `\nMinimum importance: ${params.minImportance}` : ''}${
                params.tags ? `\nTags filter: ${params.tags.join(', ')}` : ''
              }\n\nTry:\n- Using a broader search query\n- Removing filters\n- Checking if this information was previously saved`,
            },
          ],
          data: {
            success: true,
            count: 0,
            memories: [],
          },
        };
      }

      // Format response text
      let responseText = `Found ${filtered.length} relevant ${filtered.length === 1 ? 'memory' : 'memories'} for: "${params.query}"\n\n`;

      filtered.forEach((memory, index) => {
        const savedDate = new Date(memory.createdAt).toLocaleDateString();
        const savedTime = new Date(memory.createdAt).toLocaleTimeString();

        // Display Multi-Tier Memory layer
        const layerDisplay = memory.memoryLayer === 'working'
          ? 'Working (24h)'
          : memory.memoryLayer === 'experiential'
          ? 'Experiential (90d)'
          : 'Factual (permanent)';

        // Use importanceScore if available, fallback to legacy importance
        const importance = memory.importanceScore
          ? Math.round(memory.importanceScore * 10)
          : (memory.importance || 5);

        // Display visibility with icons
        const visibilityDisplay = (memory as any).visibility === 'public'
          ? 'Public (all agents)'
          : (memory as any).visibility === 'team'
          ? 'Team (team members only)'
          : 'Private';

        responseText += `${index + 1}. ${memory.content}\n`;
        responseText += `   Type: ${memory.type} | Importance: ${importance}/10 | Layer: ${layerDisplay}\n`;
        responseText += `   Visibility: ${visibilityDisplay}`;

        // Show team-critical flag
        if ((memory as any).is_team_critical) {
          responseText += ' | TEAM-CRITICAL';
        }

        responseText += '\n';
        responseText += `   Saved: ${savedDate} ${savedTime} | Access count: ${memory.accessCount}\n`;

        // Show source agent if not current user's private memory
        if ((memory as any).source_agent_id && (memory as any).visibility !== 'private') {
          responseText += `   Source: Agent ${(memory as any).source_agent_id}\n`;
        }

        const tags = memory.metadata?.tags;
        if (Array.isArray(tags) && tags.length > 0) {
          responseText += `   Tags: ${tags.join(', ')}\n`;
        }

        responseText += '\n';
      });

      // Include helpful tips if filters were applied
      if (params.type || params.layer || params.minImportance || params.tags || params.visibility || params.teamCriticalOnly || params.sourceAgentId) {
        responseText += '---\n';
        responseText += 'Filters applied:\n';
        if (params.type) responseText += `- Type: ${params.type}\n`;
        if (params.layer) responseText += `- Layer: ${params.layer}\n`;
        if (params.visibility) responseText += `- Visibility: ${params.visibility}\n`;
        if (params.teamCriticalOnly) responseText += `- Team-critical only: Yes\n`;
        if (params.sourceAgentId) responseText += `- Source agent: ${params.sourceAgentId}\n`;
        if (params.minImportance) responseText += `- Min importance: ${params.minImportance}\n`;
        if (params.tags) responseText += `- Tags: ${params.tags.join(', ')}\n`;
        if (params.includeShared === false) responseText += `- Shared memories: Excluded\n`;
      }

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
        data: {
          success: true,
          count: filtered.length,
          query: params.query,
          memories: filtered.map((m: any) => ({
            id: m.id,
            content: m.content,
            type: m.type,
            importance: m.importanceScore ? Math.round(m.importanceScore * 10) : (m.importance || 5),
            importanceScore: m.importanceScore,
            memoryLayer: m.memoryLayer,
            visibility: m.visibility || 'private',
            sourceAgentId: m.source_agent_id,
            isTeamCritical: m.is_team_critical || false,
            teamId: m.team_id,
            createdAt: m.createdAt,
            accessCount: m.accessCount,
            tags: m.metadata?.tags || [],
          })),
        },
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching memories: ${error.message}`,
          },
        ],
        error: error.message,
      };
    }
  },
};
