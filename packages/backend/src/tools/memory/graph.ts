/**
 * memory_graph tool (CORE-MEM-GRAPH): read the memory knowledge graph.
 *
 *   op 'entities'  entities in the open drawers (optional name filter `q`, `kind`)
 *   op 'entity'    one entity (by `name` or `id`): its links and timeline
 *   op 'links'     active links in the open drawers
 *   op 'related'   memories reached from the entities named in `query`
 *                  (named entities -> up to two links -> attached memories)
 *   op 'pending'   links waiting for the owner's review (decide them with
 *                  memory_graph_review, which needs the owner's approval)
 *   op 'clusters'  groups of entities seen together: topic suggestions
 *   op 'topic_preview'  what making one cluster a topic would do (changes nothing)
 *   op 'memory'    the entities and links one memory holds (MEM-GAPS-02)
 *   op 'agent_view'  the map as another agent's runs would see it, within
 *                  the drawers open here (MEM-GAPS-02)
 *
 * memory_graph_topic (approval-gated): make a previewed cluster a topic, or
 * dismiss it ("not a topic").
 *
 * memory_graph_sync (approval-gated): "Rebuild map" (board M14) — index the
 * memories that have no current graph entry and prune orphan links.
 *
 * Same gates as the owner-only graph API: read-only, the run user must be the
 * owner account, never in a turn that answers an outsider, and only what the
 * drawers open for this run hold (memory/graph/read.ts scope). Pending links
 * are never used by recall and only listed by op 'pending'.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { toolMemoryDrawers, toolMemoryUser, toolOwnerTurn } from './scope.js';
import { one, sql } from '../../repositories/sql-steps.js';
import { entityDetail, findEntity, graphRecall, listEntities, listLinks, memoryEntities, syncMemoryGraph, type GraphScope } from '../../memory/graph/index.js';
import { ScopeInputError, agentViewMap } from '../../memory/scopes/index.js';
import { applyTopic, ClusterError, dismissCluster, graphClusters, topicPreview, type TopicPreview } from '../../memory/graph/clusters.js';

const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: `Memory graph: ${msg}` }], error: msg });
const OPS = ['entities', 'entity', 'links', 'related', 'pending', 'clusters', 'topic_preview', 'memory', 'agent_view'] as const;

function previewText(p: TopicPreview): string {
  const head = `Cluster "${p.cluster.name}" in ${p.cluster.drawer} (${p.cluster.entities.map((e) => e.name).join(', ')}; ${p.cluster.memoryIds.length} memories) as topic "${p.topicKey}":`;
  if (p.blocked) {
    const why = p.blocked.code === 'key_taken' ? `another memory (${p.blocked.memoryId}) of this drawer already has that key; pick another topic_key`
      : p.blocked.code === 'already_topic' ? `memory ${p.blocked.memoryId} already holds this topic` : 'every memory of the cluster already has its own key';
    return `${head} nothing can change: ${why}.`;
  }
  return [head, `- memory ${p.target!.memoryId} gets the key (the current answer): ${p.target!.preview}`,
    ...(p.keepKey.length ? [`- keep their own key (never renamed): ${p.keepKey.map((k) => `${k.memoryId} (${k.topicKey})`).join(', ')}`] : []),
    ...(p.related.length ? [`- unchanged, related: ${p.related.length} memories`] : []),
    `previewHash ${p.previewHash}. To apply, call memory_graph_topic with action "apply" (the owner approves the call).`].join('\n');
}

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
- pending: links waiting for the owner's review (approve or reject one with memory_graph_review)
- clusters: groups of entities the memory keeps mentioning together (topic suggestions)
- topic_preview: what making one cluster a topic would do (cluster_id, optional topic_key); changes nothing
- memory: the entities and links one memory holds (memory_id)
- agent_view: what another agent's runs could see of the map (agent_id, optional project slug), within the drawers open here

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
      cluster_id: { type: 'string', description: 'topic_preview: cluster id from op clusters' },
      topic_key: { type: 'string', description: 'topic_preview: the topic key (default: suggested from the cluster name)' },
      memory_id: { type: 'string', description: 'memory: the memory id' },
      agent_id: { type: 'string', description: 'agent_view: the agent' },
      project: { type: 'string', description: 'agent_view: project slug (default: no project)' },
      limit: { type: 'number', minimum: 1, maximum: 50, description: 'Maximum items (default 20)' },
    },
    required: ['op'],
  },

  async execute(params: Record<string, any>, context?: ToolExecutionContext): Promise<ToolResult> {
    const userId = toolMemoryUser(context);
    if (!userId) return fail('no user for this memory');
    if (!toolOwnerTurn(context)) return fail("only in the owner's own turn, not in a board task run");
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

    if (op === 'pending') {
      const links = await listLinks(scope, { status: 'pending', limit });
      const text = links.length
        ? links.map((l) => `- ${l.from.name} ${l.type} ${l.to.name} (link ${l.id}, from memory ${l.memoryIds.join(', ')})`).join('\n')
        : 'No links waiting for review in the open memory drawers.';
      return { content: [{ type: 'text', text }], data: { success: true, links } } as ToolResult;
    }

    if (op === 'clusters') {
      const clusters = await graphClusters(scope, { limit });
      const text = clusters.length
        ? clusters.map((c, i) => `${i + 1}. "${c.name}" in ${c.drawer}: ${c.entities.map((e) => e.name).join(', ')} — ${c.memoryIds.length} memories, suggested topic "${c.suggestedTopicKey ?? '?'}" [cluster ${c.id}]`).join('\n')
        : 'No topic suggestions in the open memory drawers.';
      return { content: [{ type: 'text', text }], data: { success: true, clusters } } as ToolResult;
    }

    if (op === 'memory') {
      const out = typeof params.memory_id === 'string' ? await memoryEntities(scope, params.memory_id) : null;
      if (!out) return fail('memory not found in the open memory drawers');
      const text = [
        `Memory ${out.memoryId} names: ${out.entities.map((e) => `${e.name} (${e.kind})`).join(', ') || 'nothing in the map'}.`,
        ...out.links.map((l) => `- ${l.from.name} ${l.type} ${l.to.name}${l.status === 'active' ? '' : ` (${l.status})`}`),
      ].join('\n');
      return { content: [{ type: 'text', text }], data: { success: true, ...out } } as ToolResult;
    }

    if (op === 'agent_view') {
      if (typeof params.agent_id !== 'string' || !params.agent_id) return fail('agent_id is required');
      try {
        // Only what is open here too: the other agent's view never shows more than this run may read.
        const view = await agentViewMap(userId, params.agent_id, { project: params.project, q: params.q, kind: params.kind, limit }, scope.drawers);
        if (!view) return fail('agent not found');
        const text = [
          `${view.agentName} reads ${view.readable.join(', ') || 'nothing'}${view.project ? ` in ${view.project}` : ''}; within this conversation's drawers it sees ${view.entities.length} entities and ${view.links.length} links.`,
          ...view.entities.map((e) => `- ${e.name} (${e.kind}), ${e.memories} memories`),
        ].join('\n');
        return { content: [{ type: 'text', text }], data: { success: true, view } } as ToolResult;
      } catch (err) {
        if (err instanceof ScopeInputError) return fail(err.message);
        throw err;
      }
    }

    if (op === 'topic_preview') {
      try {
        const preview = await topicPreview(scope, params.cluster_id, params.topic_key);
        return { content: [{ type: 'text', text: previewText(preview) }], data: { success: true, preview } } as ToolResult;
      } catch (err) {
        if (err instanceof ClusterError) return fail(err.message);
        throw err;
      }
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

export const memoryGraphTopicTool: Tool = {
  name: 'memory_graph_topic',
  description: `Act on a topic suggestion of the memory graph, after the owner approves this call.
action "apply" (cluster_id, preview_hash, optional topic_key): the memory named in memory_graph op "topic_preview" gets the topic key, so later saves of that topic update it (with history). Nothing is renamed; if anything changed since the preview, nothing happens.
action "dismiss" (cluster_id): "not a topic"; it is not suggested again until its members change.`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['apply', 'dismiss'] },
      cluster_id: { type: 'string' },
      preview_hash: { type: 'string', description: 'apply: previewHash from topic_preview' },
      topic_key: { type: 'string', description: 'apply: the same topic_key the preview used (default: suggested)' },
    },
    required: ['action', 'cluster_id'],
  },
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const userId = toolMemoryUser(context);
    if (!userId) return fail('no user for this memory');
    if (!toolOwnerTurn(context)) return fail("only in the owner's own turn, not in a board task run");
    if (context?.toolPolicy) return fail('not available when answering someone else');
    if (!(await isOwnerAccount(userId))) return fail('the memory graph is for the owner only');
    const scope: GraphScope = { userId, drawers: toolMemoryDrawers(context) };
    const actor = `agent:${context?.agentId ?? 'unknown'}`;
    try {
      // The owner's approval of this call is the explicit confirm.
      if (params.action === 'apply') {
        const r = await applyTopic(scope, params.cluster_id, { topicKey: params.topic_key, expectedPreviewHash: params.preview_hash, confirm: true }, actor);
        return { content: [{ type: 'text', text: `Memory ${r.memoryId} now holds the topic "${r.topicKey}" in ${r.drawer} (new version saved).` }], data: { success: true, ...r } } as ToolResult;
      }
      if (params.action === 'dismiss') {
        const r = await dismissCluster(scope, params.cluster_id, actor);
        return { content: [{ type: 'text', text: 'Not a topic: this group is not suggested again until it changes.' }], data: { success: true, ...r } } as ToolResult;
      }
      return fail('action must be apply or dismiss');
    } catch (err) {
      if (err instanceof ClusterError) return fail(err.message);
      throw err;
    }
  },
};

export const memoryGraphSyncTool: Tool = {
  name: 'memory_graph_sync',
  description: `Rebuild the owner's memory map after the owner approves this call: index memories that have no current map entry (up to limit, default 200) and remove links and entities nothing mentions any more. Memory text is not changed.`,
  input_schema: {
    type: 'object',
    properties: { limit: { type: 'number', description: 'Memories to index in this call (1-1000, default 200)' } },
  },
  async execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const userId = toolMemoryUser(context);
    if (!userId) return fail('no user for this memory');
    if (!toolOwnerTurn(context)) return fail("only in the owner's own turn, not in a board task run");
    if (context?.toolPolicy) return fail('not available when answering someone else');
    if (!(await isOwnerAccount(userId))) return fail('the memory graph is for the owner only');
    const limit = typeof params.limit === 'number' && Number.isInteger(params.limit) ? Math.min(1000, Math.max(1, params.limit)) : 200;
    // The owner's approval of this call is the explicit confirm.
    const r = await syncMemoryGraph(userId, limit);
    return { content: [{ type: 'text', text: `Map rebuilt: ${r.indexed} memories indexed, ${r.unchanged} unchanged, ${r.pruned.links} links and ${r.pruned.entities} entities removed.` }], data: { success: true, ...r } } as ToolResult;
  },
};
