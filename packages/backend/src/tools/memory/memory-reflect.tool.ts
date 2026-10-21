/**
 * Memory Reflect Tool
 *
 * Reads recent memories, finds patterns and duplicate/related entries,
 * then writes a consolidated [REFLECTION] memory summarizing key insights.
 *
 * Inspired by the 6Rs pipeline — implements the "Reflect" and "Reduce" steps.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { v4 as uuidv4 } from 'uuid';
import type { Memory } from '../../memory/types.js';
import { sameDrawer } from '../../memory/drawers.js';
import { narrowestDrawer, toolMemoryUser } from './scope.js';
import { repositories } from '../../repositories/index.js';
import { toolMemoryActor } from '../../repositories/actor.js';

interface MemoryReflectParams {
  lookbackCount?: number;
  focus?: string;
}

export const memoryReflectTool: Tool = {
  name: 'memory_reflect',
  description: `Analyze recent memories, find patterns, and save a consolidated reflection.

Use this tool after completing a complex task or conversation to:
- Identify recurring themes and patterns in recent memories
- Spot duplicate or near-duplicate entries
- Summarize key insights into a single [REFLECTION] memory
- Surface the most important facts learned recently

Returns a structured reflection that helps build long-term understanding.

Only the memory drawers open for this conversation are read; the reflection
is saved into the narrowest of the drawers it was built from.

Parameters:
- lookbackCount: How many recent memories to analyze (default: 20, max: 50)
- focus: Optional topic to focus the reflection on (e.g. "coding preferences")`,

  input_schema: {
    type: 'object',
    properties: {
      lookbackCount: {
        type: 'number',
        description: 'Number of recent memories to analyze (default: 20, max: 50)',
      },
      focus: {
        type: 'string',
        description: 'Optional topic to focus the reflection on',
      },
    },
    required: [],
    examples: [
      {
        lookbackCount: 30,
        description: 'Analyze patterns from last 30 memories',
      },
      {
        focus: 'coding preferences',
        description: 'Reflect on coding-related patterns',
      },
    ],
  },

  async execute(params: Record<string, any>, context?: ToolExecutionContext): Promise<ToolResult> {
    const { lookbackCount = 20, focus } = params as MemoryReflectParams;
    const limit = Math.min(50, Math.max(1, Number(lookbackCount) || 20));
    // CORE-03: the run's own user (never a model-supplied id) and only the
    // drawers open for this turn. No user or no drawers -> nothing to read.
    // B1.6: read and saved through the memory repository (the tool call's actor).
    const actor = await toolMemoryActor(context);
    const drawers = [...(actor.drawers ?? [])];
    if (!toolMemoryUser(context) || drawers.length === 0) {
      return { content: [{ type: 'text', text: 'No memories found to reflect on.' }] };
    }

    try {
      // Same order as before: importance first, then newest.
      const allMemories = await repositories.memory.reachable(actor);

      if (allMemories.length === 0) {
        return {
          content: [{ type: 'text', text: 'No memories found to reflect on.' }],
        };
      }

      // Take the most recent N memories (getByUser returns ordered by importance DESC, created DESC)
      const recentMemories = allMemories.slice(0, limit);

      // Filter by focus topic if provided
      const targetMemories = focus
        ? recentMemories.filter(m =>
            m.content.toLowerCase().includes(focus.toLowerCase()) ||
            (m.metadata?.tags as string[] || []).some((t: string) =>
              t.toLowerCase().includes(focus.toLowerCase())
            )
          )
        : recentMemories;

      if (targetMemories.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No memories found matching focus topic: "${focus}"`,
          }],
        };
      }

      // === Reduce: Find patterns ===
      const byType: Record<string, Memory[]> = {};
      const tagCounts: Record<string, number> = {};
      const highImportance: Memory[] = [];
      const potentialDuplicates: Array<[Memory, Memory]> = [];

      for (const mem of targetMemories) {
        // Group by type
        if (!byType[mem.type]) byType[mem.type] = [];
        byType[mem.type].push(mem);

        // Count tags
        const tags = (mem.metadata?.tags as string[]) || [];
        for (const tag of tags) {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }

        // Track high-importance memories (use new importanceScore or legacy importance)
        const importance = mem.importanceScore ? mem.importanceScore * 10 : (mem.importance || 5);
        if (importance >= 7) {
          highImportance.push(mem);
        }
      }

      // Find near-duplicates (same type + first 40 chars similar)
      for (let i = 0; i < targetMemories.length; i++) {
        for (let j = i + 1; j < targetMemories.length; j++) {
          const a = targetMemories[i];
          const b = targetMemories[j];
          if (a.type === b.type) {
            const aPrefix = a.content.slice(0, 40).toLowerCase();
            const bPrefix = b.content.slice(0, 40).toLowerCase();
            if (aPrefix === bPrefix || a.content === b.content) {
              potentialDuplicates.push([a, b]);
            }
          }
        }
      }

      // === Build reflection text ===
      const lines: string[] = [];
      lines.push(`[REFLECTION] Analysis of ${targetMemories.length} memories${focus ? ` (focus: ${focus})` : ''}`);
      lines.push('');

      // Type breakdown
      lines.push('## Memory Distribution');
      for (const [type, mems] of Object.entries(byType)) {
        lines.push(`- ${type}: ${mems.length} entries`);
      }

      // Top tags
      const topTags = Object.entries(tagCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5);
      if (topTags.length > 0) {
        lines.push('');
        lines.push('## Most Frequent Tags');
        for (const [tag, count] of topTags) {
          lines.push(`- ${tag}: mentioned ${count}x`);
        }
      }

      // High-importance highlights
      if (highImportance.length > 0) {
        lines.push('');
        lines.push('## High-Priority Facts');
        for (const mem of highImportance.slice(0, 5)) {
          const imp = mem.importanceScore ? Math.round(mem.importanceScore * 10) : (mem.importance || 5);
          lines.push(`- [${mem.type}, importance:${imp}/10] ${mem.content.slice(0, 100)}`);
        }
      }

      // Duplicates warning
      if (potentialDuplicates.length > 0) {
        lines.push('');
        lines.push(`## Possible Duplicates (${potentialDuplicates.length} pairs)`);
        for (const [a, b] of potentialDuplicates.slice(0, 3)) {
          lines.push(`- "${a.content.slice(0, 60)}" ↔ "${b.content.slice(0, 60)}"`);
        }
      }

      const reflectionContent = lines.join('\n');

      // Saved into the narrowest drawer the analyzed memories came from (an open drawer).
      // CORE-PERMS-01: only drawers the agent may write.
      const writable = actor.writeKinds ? drawers.filter((d) => actor.writeKinds!.includes(d.kind)) : drawers;
      if (writable.length === 0) {
        return { content: [{ type: 'text', text: 'Reflection not saved: this agent may not write to any open memory drawer.' }], error: 'No writable memory drawer' };
      }
      const sourceDrawers = writable.filter((d) => targetMemories.some((m) => m.drawer && sameDrawer(m.drawer, d)));
      const drawer = narrowestDrawer(sourceDrawers) ?? narrowestDrawer(writable)!;

      // Save reflection as a new memory (Multi-Tier Memory: experiential layer)
      const reflectionMemory: Omit<Memory, 'userId'> = {
        id: uuidv4(),
        type: 'fact',
        content: reflectionContent,
        importance: 6,
        importanceScore: 0.6,
        memoryLayer: 'experiential', // Reflections are medium-term insights
        consolidationStatus: 'consolidated', // Already consolidated by nature
        expiryTimestamp: Date.now() + (90 * 24 * 60 * 60 * 1000), // 90 days
        metadata: {
          tags: ['reflection', 'analysis', ...(focus ? [focus] : [])],
          source: 'memory_reflect',
          analyzedCount: targetMemories.length,
          generatedAt: new Date().toISOString(),
        },
        status: 'active',
        createdAt: new Date(),
        lastAccessedAt: Date.now(),
        accessCount: 0,
        drawer,
      };

      await repositories.memory.saveDerived(actor, reflectionMemory);

      return {
        content: [{
          type: 'text',
          text: `Reflection saved (ID: ${reflectionMemory.id})\n\n${reflectionContent}`,
        }],
        data: {
          reflectionId: reflectionMemory.id,
          analyzedCount: targetMemories.length,
          duplicatesFound: potentialDuplicates.length,
          highImportanceCount: highImportance.length,
        },
      } as any;

    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error running reflection: ${error.message}`,
        }],
        error: error.message,
      };
    }
  },
};
