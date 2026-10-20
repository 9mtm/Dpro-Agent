/**
 * Memory files API (CORE-04). Owner only (auth gate owner tier for
 * /api/memory/files* and /api/memory/proposals*, route access 'owner',
 * handler role check). The user always comes from the token and every
 * drawer/proposal is the caller's own (another user's -> 404).
 *
 *   GET  /api/memory/files                       drawers with revision + export path
 *   GET  /api/memory/files/:drawer               export text (no write)
 *   GET  /api/memory/files/:drawer/versions      version history of the drawer
 *   POST /api/memory/files/:drawer/export        write the readable file (DB -> file)
 *   POST /api/memory/files/:drawer/proposal      { content? , note? } edited text, or
 *                                                the exported file as saved on disk
 *   GET  /api/memory/proposals?status=           proposals, newest first
 *   GET  /api/memory/proposals/:id               one proposal with its diff and reviewHash
 *   POST /api/memory/proposals/:id/approve       { expectedReviewHash } apply as a new version (audited)
 *   POST /api/memory/proposals/:id/reject        { expectedReviewHash, note? } nothing changes (audited)
 *   POST /api/memory/proposals/:id/decide        { decision, expectedReviewHash, note? } a conflict proposal
 *                                                (CORE-MEM-CONFLICT): keep_new | keep_old | keep_both (audited)
 *
 * Decision errors carry a machine `code`: 400 `review_hash_required`,
 * 409 `already_decided` | `stale` | `review_changed`.
 *
 * `:drawer` is `owner`, `experience`, `project:<slug>`, `task:<id>` or
 * `people:<id>`. `agentId` (query or body) picks the agent folder; default
 * the primary agent. The database stays canonical: a file never reaches it
 * except through an approved proposal.
 */

import { actorOf } from '../../auth/auth-gate.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logAudit } from '../../services/audit-logger.js';
import { getMemoryStorage } from '../../memory/storage.js';
import { DrawerInputError, drawerId, parseDrawerId, type DrawerRef } from '../../memory/drawers.js';
import {
  MemoryFileError,
  drawerFilePath,
  drawerRevision,
  displayPath,
  resolveFileAgent,
  type MemoryProposal,
} from '../../memory/memory-files.js';
import { repositories } from '../../repositories/index.js';
import { ScopeError, actorOrReply, requireOwner } from '../../repositories/scope.js';

const STATUSES = new Set(['pending', 'approved', 'rejected', 'stale', 'cancelled']);

/** Owner account id (central rule, repositories/scope.ts), else 401/403 sent and null. */
function ownerOf(request: FastifyRequest, reply: FastifyReply): string | null {
  const actor = actorOrReply(reply, actorOf(request), requireOwner);
  return actor ? actor.userId ?? null : null;
}

function body(request: FastifyRequest): Record<string, unknown> {
  const b = request.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {};
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof MemoryFileError) return reply.code(err.status).send({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  if (err instanceof DrawerInputError) return reply.code(400).send({ error: err.message });
  if (err instanceof ScopeError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

function summary(p: MemoryProposal) {
  const count = (op: string) => p.changes.filter((c) => c.op === op).length;
  const { changes: _changes, ...rest } = p;
  return { ...rest, counts: { add: count('add'), update: count('update'), delete: count('delete') } };
}

type DrawerParams = { Params: { drawer: string } };
type IdParams = { Params: { id: string } };

export async function memoryFilesRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  // Columns/backfill for drawers (idempotent; normally done by the memory routes).
  await getMemoryStorage().initialize();

  const agentFrom = (request: FastifyRequest) =>
    resolveFileAgent((request.query as any)?.agentId ?? body(request).agentId);

  const audit = (request: FastifyRequest, ownerId: string, action: string, success: boolean, resourceId: string, metadata: Record<string, unknown>, error?: string) =>
    logAudit({
      event_type: 'data.update', event_category: 'data_modification', severity: 'info',
      user_id: ownerId, ip_address: request.ip, user_agent: request.headers['user-agent'],
      request_method: request.method, request_path: request.routeOptions?.url ?? undefined,
      resource_type: 'memory_proposal', resource_id: resourceId, action, success,
      ...(error ? { error_message: error } : {}), metadata,
    });

  fastify.get('/api/memory/files', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    try {
      const agentId = await agentFrom(request);
      const drawers = [];
      for (const d of await repositories.memory.drawers(actorOf(request))) {
        const ref: DrawerRef = d.key ? { kind: d.kind, key: d.key } : { kind: d.kind };
        drawers.push({ ...d, drawerId: drawerId(ref), revision: await drawerRevision(ownerId, ref), path: displayPath(drawerFilePath(agentId, ownerId, ref)) });
      }
      return { agentId, drawers };
    } catch (err) { return fail(reply, err); }
  });

  fastify.get<DrawerParams>('/api/memory/files/:drawer', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    try {
      return await repositories.memory.drawerFile(actorOf(request), await agentFrom(request), parseDrawerId(request.params.drawer));
    } catch (err) { return fail(reply, err); }
  });

  fastify.get<DrawerParams>('/api/memory/files/:drawer/versions', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    try {
      const drawer = parseDrawerId(request.params.drawer);
      return { drawerId: drawerId(drawer), revision: await drawerRevision(ownerId, drawer), versions: await repositories.memory.drawerHistory(actorOf(request), drawer) };
    } catch (err) { return fail(reply, err); }
  });

  fastify.post<DrawerParams>('/api/memory/files/:drawer/export', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    try {
      const view = await repositories.memory.exportDrawer(actorOf(request), await agentFrom(request), parseDrawerId(request.params.drawer));
      return { ...view, exported: true };
    } catch (err) { return fail(reply, err); }
  });

  fastify.post<DrawerParams>('/api/memory/files/:drawer/proposal', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    try {
      const drawer = parseDrawerId(request.params.drawer);
      const agentId = await agentFrom(request);
      const b = body(request);
      if (b.content !== undefined && typeof b.content !== 'string') return reply.code(400).send({ error: 'content must be text' });
      // Uploaded text, or the exported file as the owner saved it (read only on this request).
      const source = typeof b.content === 'string' ? 'upload' : 'file';
      const text = typeof b.content === 'string' ? b.content : await repositories.memory.readExportedDrawer(actorOf(request), agentId, drawer);
      const proposal = await repositories.memory.createProposal(actorOf(request), { agentId, drawer, text, source, note: typeof b.note === 'string' ? b.note : null });
      audit(request, ownerId, 'memory_proposal.create', true, proposal.id, { drawer: proposal.drawerId, source, counts: summary(proposal).counts });
      return reply.code(201).send(proposal);
    } catch (err) { return fail(reply, err); }
  });

  fastify.get('/api/memory/proposals', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    const status = (request.query as any)?.status;
    if (status !== undefined && !STATUSES.has(status)) return reply.code(400).send({ error: 'Invalid status' });
    return { proposals: (await repositories.memory.proposals(actorOf(request), status)).map(summary) };
  });

  fastify.get<IdParams>('/api/memory/proposals/:id', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    try {
      return await repositories.memory.proposal(actorOf(request), request.params.id);
    } catch (err) { return fail(reply, err); }
  });

  fastify.post<IdParams>('/api/memory/proposals/:id/approve', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    try {
      const result = await repositories.memory.approveProposal(actorOf(request), request.params.id, body(request).expectedReviewHash);
      audit(request, ownerId, 'memory_proposal.approve', true, request.params.id, {
        drawer: result.proposal.drawerId, revision: result.revision,
        added: result.applied.added.length, updated: result.applied.updated.length, deleted: result.applied.deleted.length,
      });
      return result;
    } catch (err) {
      if (err instanceof MemoryFileError && err.status !== 404) {
        audit(request, ownerId, 'memory_proposal.approve', false, request.params.id, err.code ? { code: err.code } : {}, err.message);
      }
      return fail(reply, err);
    }
  });

  fastify.post<IdParams>('/api/memory/proposals/:id/decide', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    const b = body(request);
    try {
      const result = await repositories.memory.decideConflict(actorOf(request), request.params.id, b.decision, b.expectedReviewHash, b.note);
      audit(request, ownerId, 'memory_proposal.decide', true, request.params.id, {
        drawer: result.proposal.drawerId, decision: result.decision,
        ...(result.applied ? { added: result.applied.added.length, updated: result.applied.updated.length } : {}),
      });
      return result;
    } catch (err) {
      if (err instanceof MemoryFileError && err.status !== 404) {
        audit(request, ownerId, 'memory_proposal.decide', false, request.params.id, err.code ? { code: err.code } : {}, err.message);
      }
      return fail(reply, err);
    }
  });

  fastify.post<IdParams>('/api/memory/proposals/:id/reject', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    try {
      const proposal = await repositories.memory.rejectProposal(actorOf(request), request.params.id, body(request).expectedReviewHash, body(request).note);
      audit(request, ownerId, 'memory_proposal.reject', true, proposal.id, { drawer: proposal.drawerId });
      return proposal;
    } catch (err) {
      if (err instanceof MemoryFileError && err.status !== 404) {
        audit(request, ownerId, 'memory_proposal.reject', false, request.params.id, err.code ? { code: err.code } : {}, err.message);
      }
      return fail(reply, err);
    }
  });
}
