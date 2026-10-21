/**
 * memory_graph tool (CORE-MEM-GRAPH): read the memory knowledge graph.
 *
 *   op 'entities'  entities in the open drawers (optional name filter `q`, `kind`)
 *   op 'entity'    one entity (by `name` or `id`): its links and timeline
 *   op 'links'     active links in the open drawers
 *   op 'related'   memories reached from the entities named in `query`
 *                  (named entities -> up to two links -> attached memories)
 *
 * Same gates as the owner-only graph API: read-only, the run user must be the
 * owner account, never in a turn that answers an outsider, and only what the
 * drawers open for this run hold (memory/graph/read.ts scope). Pending links
 * are not shown to agents.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { toolMemoryDrawers, toolMemoryUser } from './scope.js';
import { one, sql } from '../../repositories/sql-steps.js';
import { entityDetail, findEntity, graphRecall, listEntities, listLinks, type GraphScope } from '../../memory/graph/index.js';

const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `Memory graph: ${msg}` }], error: msg });
const OPS = ['entities', 'entity', 'links', 'related'] as const;

async function isOwnerAccount(userId: string): Promise<boolean> {
  const row = await sql().read(one<{ role: string }>('SELECT role FROM users WHERE id = ?', userId));
  return row?.role === 'owner';
}

export const memoryGraphTool: Tool = {
  name: 'memory_graph',
  description: `Read the owner's memory knowledge graph: people, projects, places, topics, agents, tasks and decisions named in memory, how they link (works_on, prefers, decided, part_of, depends_on, replaces, contradicts), and each one's timeline.

Ops:
- entities: list known entities (optional q = name filter, kind)
- entity: one entity by name or id, with its links and the memories that mention it (oldest first)
- links: list links
- related: memories reached from the names in "query" through their links (use when a question names a person or project but shares no words with the facts)

Only the memory drawers open for this conversation are read. Read-only.`,
  input_schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: [...OPS], description: 'What to read' },
      q: { type: 'string', description: 'entities: name filter' },
      kind: { type: 'string', enum: ['person', 'project', 'place', 'topic', 'agent', 'task', 'decision'], description: 'entities: kind filter' },
      name: { type: 'string', description: 'entity: entity name' },
      id: { type: 'string', description: 'entity: entity id' },
      query: { type: 'string', description: 'related: the question or names' },
      limit: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum items (default 20)' },
    },
    required: ['op'],
  },

  async execute(params: Record<string, any>, context?: ToolExecutionContext): Promise<ToolResult> {
    const userId = toolMemoryUser(context);
    if (!userId) return fail('no user for this memory');
    if (context?.toolPolicy) return fail('not available when answering someone else');
    if (!(await isOwnerAccount(userId))) return fail('the memory graph is for the owner only');
    const op = params?.op;
    if (!OPS.includes(op)) return fail(`op must be one of ${OPS.join(', ')}`);
    const scope: GraphScope = { userId, drawers: toolMemoryDrawers(context) };
    const limit = typeof params.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(params.limit))) : 20;

    if (op === 'entities') {
      const entities = await listEntities(scope, { q: params.q, kind: params.kind, limit });
      const text = entities.length
        ? entities.map((e, i) => `${i + 1}. ${e.name} (${e.kind}) — ${e.memories} memories, ${e.links} links [id ${e.id}]`).join('\n')
        : 'No entities in the open memory drawers.';
      return { content: [{ type: 'text', text }], data: { success: true, entities } } as ToolResult;
    }

    if (op === 'links') {
      const links = await listLinks(scope, { status: 'active', limit });
      const text = links.length ? links.map((l) => `- ${l.from.name} ${l.type} ${l.to.name}`).join('\n') : 'No links in the open memory drawers.';
      return { content: [{ type: 'text', text }], data: { success: true, links } } as ToolResult;
    }

    if (op === 'entity') {
      const id = typeof params.id === 'string' && params.id ? params.id
        : typeof params.name === 'string' ? (await findEntity(scope, params.name))?.id : undefined;
      const detail = id ? await entityDetail(scope, id) : null;
      if (!detail) return fail('entity not found in the open memory drawers');
      const links = detail.links.filter((l) => l.status === 'active');
      const lines = [
        `${detail.entity.name} (${detail.entity.kind})`,
        ...(links.length ? ['Links:', ...links.map((l) => `- ${l.from.name} ${l.type} ${l.to.name}`)] : []),
        'Timeline:',
        ...detail.timeline.slice(-limit).map((t) => `- ${t.createdAt.slice(0, 10)} [${t.drawer}] ${t.preview} (memory ${t.memoryId})`),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }], data: { success: true, entity: detail.entity, links, timeline: detail.timeline.slice(-limit) } } as ToolResult;
    }

    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query) return fail('query is required');
    const hits = await graphRecall(scope, query, { limit });
    const memories = hits.slice(0, limit).map((h) => ({ id: h.memory.id, content: h.memory.content, type: h.memory.type, score: Math.round(h.similarity * 100) / 100 }));
    const text = memories.length ? memories.map((m, i) => `${i + 1}. ${m.content} (memory ${m.id})`).join('\n') : `No linked memories for: "${query}"`;
    return { content: [{ type: 'text', text }], data: { success: true, count: memories.length, memories } } as ToolResult;
  },
};
