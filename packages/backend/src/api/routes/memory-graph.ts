/**
 * Memory knowledge graph API (CORE-MEM-GRAPH). Owner only (auth gate owner
 * tier for /api/memory/graph*, route access 'owner', handler role check).
 * The user always comes from the token: the owner's own graph. Read API for
 * the graph view, the owner's review of important new links, and a catch-up
 * job.
 *
 *   GET  /api/memory/graph/entities          ?q=&kind=&limit=&drawers=a,b   entities, most memories first
 *   GET  /api/memory/graph/entities/:id      ?drawers=                       entity + links + timeline
 *   GET  /api/memory/graph/links             ?status=&limit=&drawers=        links (pending = waiting for review)
 *   POST /api/memory/graph/links/:id/approve                                 pending -> active
 *   POST /api/memory/graph/links/:id/reject                                  pending -> rejected
 *   POST /api/memory/graph/sync              { limit? }                      index memories without a graph, prune orphans
 *   GET  /api/memory/graph/clusters          ?limit=&drawers=                 topic suggestions (<= 150 entities in all)
 *   POST /api/memory/graph/clusters/:id/topic-preview  { topicKey? }          read only: what making it a topic would do
 *   POST /api/memory/graph/clusters/:id/topic  { topicKey?, expectedPreviewHash, confirm: true }  one memory gets the key (versioned)
 *   POST /api/memory/graph/clusters/:id/dismiss                               "not a topic"
 *   GET  /api/memory/graph/memories/:id      ?drawers=                       the entities and links one memory holds (MEM-GAPS-02)
 *   GET  /api/memory/graph/agent-view/:agentId ?project=&q=&kind=&limit=     the map limited to what that agent may read
 *
 * `drawers` (drawer ids, comma separated) narrows any read to those drawers.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { repositories } from '../../repositories/index.js';
import type { Actor } from '../../repositories/actor.js';
import { requestMeta } from '../../repositories/audit.js';
import { actorOrReply, requireOwner } from '../../repositories/scope.js';
import { DrawerInputError, parseDrawerId, type DrawerRef } from '../../memory/drawers.js';
import { decideLink, entityDetail, listEntities, listLinks, syncMemoryGraph, type GraphScope } from '../../memory/graph/index.js';
import { applyTopic, ClusterError, dismissCluster, graphClusters, topicPreview } from '../../memory/graph/clusters.js';
import { memoryEntities } from '../../memory/graph/read.js';
import { ScopeInputError, agentViewMap } from '../../memory/scopes/index.js';

function ownerOf(request: FastifyRequest, reply: FastifyReply): Actor | null {
  return actorOrReply(reply, actorOf(request), requireOwner);
}

function query(request: FastifyRequest): Record<string, unknown> {
  const q = request.query;
  return q && typeof q === 'object' ? q as Record<string, unknown> : {};
}

/** The owner's graph scope; `drawers` narrows it. Throws DrawerInputError. */
function scopeOf(owner: Actor, q: Record<string, unknown>): GraphScope {
  const userId = owner.userId!;
  if (typeof q.drawers !== 'string' || !q.drawers.trim()) return { userId };
  const drawers: DrawerRef[] = q.drawers.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50).map(parseDrawerId);
  return { userId, drawers };
}

export async function memoryGraphRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };

  const withScope = (request: FastifyRequest, reply: FastifyReply): { owner: Actor; scope: GraphScope } | null => {
    const owner = ownerOf(request, reply);
    if (owner === null) return null;
    try {
      return { owner, scope: scopeOf(owner, query(request)) };
    } catch (err) {
      if (err instanceof DrawerInputError) { reply.code(400).send({ error: err.message }); return null; }
      throw err;
    }
  };

  fastify.get('/api/memory/graph/entities', { config }, async (request, reply) => {
    const ctx = withScope(request, reply);
    if (!ctx) return reply;
    const q = query(request);
    return { entities: await listEntities(ctx.scope, { q: q.q, kind: q.kind, limit: q.limit }) };
  });

  fastify.get('/api/memory/graph/entities/:id', { config }, async (request, reply) => {
    const ctx = withScope(request, reply);
    if (!ctx) return reply;
    const detail = await entityDetail(ctx.scope, (request.params as { id: string }).id);
    if (!detail) return reply.code(404).send({ error: 'Entity not found' });
    return detail;
  });

  fastify.get('/api/memory/graph/links', { config }, async (request, reply) => {
    const ctx = withScope(request, reply);
    if (!ctx) return reply;
    const q = query(request);
    return { links: await listLinks(ctx.scope, { status: q.status, limit: q.limit }) };
  });

  fastify.get('/api/memory/graph/memories/:id', { config }, async (request, reply) => {
    const ctx = withScope(request, reply);
    if (!ctx) return reply;
    const out = await memoryEntities(ctx.scope, (request.params as { id: string }).id);
    if (!out) return reply.code(404).send({ error: 'Memory not found', code: 'not_found' });
    return out;
  });

  fastify.get('/api/memory/graph/agent-view/:agentId', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply);
    if (owner === null) return reply;
    try {
      const out = await agentViewMap(owner.userId!, (request.params as { agentId: string }).agentId, query(request));
      if (!out) return reply.code(404).send({ error: 'Agent not found', code: 'not_found' });
      return out;
    } catch (err) {
      if (err instanceof ScopeInputError) return reply.code(err.status).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  for (const decision of ['approve', 'reject'] as const) {
    fastify.post(`/api/memory/graph/links/:id/${decision}`, { config }, async (request, reply) => {
      const owner = ownerOf(request, reply);
      if (owner === null) return reply;
      const id = (request.params as { id: string }).id;
      const res = await decideLink(owner.userId!, id, decision, owner.userId!);
      if (!res) return reply.code(404).send({ error: 'No pending link with that id' });
      void repositories.audit.record(owner, {
        event_type: 'data.update', event_category: 'data_modification', severity: 'info',
        resource_type: 'memory_graph_link', resource_id: id, action: `memory_graph.link_${decision}`, success: true, metadata: {},
      }, requestMeta(request));
      return { link: res };
    });
  }

  // ---- clusters -> topics (nothing changes without the owner's confirm) ----
  const bodyOf = (request: FastifyRequest): Record<string, unknown> =>
    request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
  const clusterFail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ClusterError) return reply.code(err.status).send({ error: err.message, code: err.code });
    throw err;
  };
  const clusterId = (request: FastifyRequest) => (request.params as { id: string }).id;

  fastify.get('/api/memory/graph/clusters', { config }, async (request, reply) => {
    const ctx = withScope(request, reply);
    if (!ctx) return reply;
    const n = Number(query(request).limit ?? 50);
    return { clusters: await graphClusters(ctx.scope, { limit: Number.isInteger(n) && n >= 1 && n <= 200 ? n : 50 }) };
  });

  fastify.post('/api/memory/graph/clusters/:id/topic-preview', { config }, async (request, reply) => {
    const ctx = withScope(request, reply);
    if (!ctx) return reply;
    try { return { preview: await topicPreview(ctx.scope, clusterId(request), bodyOf(request).topicKey) }; } catch (err) { return clusterFail(reply, err); }
  });

  fastify.post('/api/memory/graph/clusters/:id/topic', { config }, async (request, reply) => {
    const ctx = withScope(request, reply);
    if (!ctx) return reply;
    try {
      const result = await applyTopic(ctx.scope, clusterId(request), bodyOf(request), ctx.owner.userId!);
      void repositories.audit.record(ctx.owner, {
        event_type: 'data.update', event_category: 'data_modification', severity: 'info',
        resource_type: 'memory', resource_id: result.memoryId, action: 'memory_graph.cluster_topic', success: true, metadata: { topicKey: result.topicKey, drawer: result.drawer },
      }, requestMeta(request));
      return { result };
    } catch (err) { return clusterFail(reply, err); }
  });

  fastify.post('/api/memory/graph/clusters/:id/dismiss', { config }, async (request, reply) => {
    const ctx = withScope(request, reply);
    if (!ctx) return reply;
    try { return await dismissCluster(ctx.scope, clusterId(request), ctx.owner.userId!); } catch (err) { return clusterFail(reply, err); }
  });

  fastify.post('/api/memory/graph/sync', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply);
    if (owner === null) return reply;
    const b = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    const limit = typeof b.limit === 'number' ? b.limit : 200;
    return syncMemoryGraph(owner.userId!, limit);
  });
}
