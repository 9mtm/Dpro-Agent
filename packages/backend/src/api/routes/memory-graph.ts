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

  fastify.post('/api/memory/graph/sync', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply);
    if (owner === null) return reply;
    const b = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    const limit = typeof b.limit === 'number' ? b.limit : 200;
    return syncMemoryGraph(owner.userId!, limit);
  });
}
