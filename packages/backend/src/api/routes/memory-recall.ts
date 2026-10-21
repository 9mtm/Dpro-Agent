/**
 * Reply recall trace, memory cache metrics and memory moves (MEM-CACHE-01).
 * Owner only (auth gate owner tier for /api/memory/recall*, /api/memory/cache*
 * and POST /api/memory/:id/move, route access 'owner', handler role check).
 * The user always comes from the token: the owner's own conversations and
 * memory; anything else answers 404.
 *
 *   GET  /api/memory/recall/messages/:messageId           what this reply used + how its context was built
 *   GET  /api/memory/recall/runs/:runId                   the same by run id (while the reply is still running)
 *   POST /api/memory/recall/messages/:messageId/correct   { memoryId, content, note? } -> 201 { proposal } (review proposal)
 *   POST /api/memory/recall/messages/:messageId/forget    { memoryId } -> { forgotten } (CORE-07, complete removal)
 *   GET  /api/memory/recall/conversations/:id/summaries   the conversation's stored summaries of older turns
 *   GET  /api/memory/cache/metrics                        cache hit rates, pack size, time to first word, budget
 *   POST /api/memory/cache/clear      { confirm: true }   drop the owner's cached context packs and recalls (rebuilt on the next turn)
 *   POST /api/memory/:id/move                             { drawer, reason? } -> { memory, from, to } (versioned)
 *
 * Correct and Forget accept only memories that the reply actually used.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { repositories } from '../../repositories/index.js';
import type { Actor } from '../../repositories/actor.js';
import { requestMeta } from '../../repositories/audit.js';
import { actorOrReply, requireOwner, sendScopeError } from '../../repositories/scope.js';
import { all, one, sql } from '../../repositories/sql-steps.js';
import { traceForMessage, traceForRun, traceMetrics, type TraceView } from '../../memory/context/trace.js';
import { cacheMetrics } from '../../memory/context/metrics.js';
import { contextBudget } from '../../memory/context/budget.js';
import { contextCacheEntries, dropContextCache } from '../../memory/context/cache.js';
import { getEmbeddingService } from '../../memory/embedding.js';
import { DrawerInputError, drawerId, parseDrawerId } from '../../memory/drawers.js';
import { MoveError, ownerCorrection, MAX_LEARNED_CONTENT } from '../../memory/learning.js';
import { MemoryFileError } from '../../memory/memory-files.js';
import { TopicKeyTakenError } from '../../memory/storage.js';

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function ownerOf(request: FastifyRequest, reply: FastifyReply): Actor | null {
  return actorOrReply(reply, actorOf(request), requireOwner);
}

const body = (request: FastifyRequest): Record<string, unknown> =>
  request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'Not found', code: 'not_found' });

/** The memory must be one this reply used. */
const usedMemory = (trace: TraceView, memoryId: unknown): memoryId is string =>
  typeof memoryId === 'string' && trace.items.some((i) => i.kind === 'memory' && i.id === memoryId);

export async function memoryRecallRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };

  fastify.get<{ Params: { messageId: string } }>('/api/memory/recall/messages/:messageId', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply);
    if (!owner) return reply;
    const trace = await traceForMessage(owner.userId!, request.params.messageId);
    if (!trace) return notFound(reply);
    reply.header('Cache-Control', 'no-store');
    return { trace };
  });

  fastify.get<{ Params: { runId: string } }>('/api/memory/recall/runs/:runId', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply);
    if (!owner) return reply;
    const trace = await traceForRun(owner.userId!, request.params.runId);
    if (!trace) return notFound(reply);
    reply.header('Cache-Control', 'no-store');
    return { trace };
  });

  fastify.post<{ Params: { messageId: string } }>('/api/memory/recall/messages/:messageId/correct', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply);
    if (!owner) return reply;
    const trace = await traceForMessage(owner.userId!, request.params.messageId);
    if (!trace) return notFound(reply);
    const b = body(request);
    if (!usedMemory(trace, b.memoryId)) return reply.code(404).send({ error: 'This reply did not use that memory', code: 'not_in_trace' });
    if (typeof b.content !== 'string' || !b.content.trim() || b.content.length > MAX_LEARNED_CONTENT) {
      return reply.code(400).send({ error: `content must be 1-${MAX_LEARNED_CONTENT} characters`, code: 'invalid_content' });
    }
    if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 500)) return reply.code(400).send({ error: 'note must be at most 500 characters', code: 'invalid_note' });
    try {
      const proposal = await ownerCorrection({
        userId: owner.userId!, memoryId: b.memoryId, content: b.content, agentId: trace.agentId,
        reasons: ['owner-correction', `reply:${request.params.messageId}`], note: typeof b.note === 'string' ? b.note : null,
      });
      if (!proposal) return reply.code(404).send({ error: 'Memory not found', code: 'not_found' });
      void repositories.audit.record(owner, {
        event_type: 'data.update', event_category: 'data_modification', severity: 'info',
        resource_type: 'memory', resource_id: b.memoryId, action: 'memory.correct_proposed', success: true,
        metadata: { proposalId: proposal.id, messageId: request.params.messageId },
      }, requestMeta(request));
      return reply.code(201).send({ proposal });
    } catch (err) {
      if (err instanceof MemoryFileError) return reply.code(err.status).send({ error: err.message, ...(err.code ? { code: err.code } : {}) });
      throw err;
    }
  });

  fastify.post<{ Params: { messageId: string } }>('/api/memory/recall/messages/:messageId/forget', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply);
    if (!owner) return reply;
    const trace = await traceForMessage(owner.userId!, request.params.messageId);
    if (!trace) return notFound(reply);
    const b = body(request);
    if (!usedMemory(trace, b.memoryId)) return reply.code(404).send({ error: 'This reply did not use that memory', code: 'not_in_trace' });
    let result;
    try {
      result = await repositories.memory.forget(owner, b.memoryId);
    } catch (err) { return sendScopeError(reply, err); }
    if (!result) return reply.code(404).send({ error: 'Memory not found', code: 'not_found' });
    void repositories.audit.record(owner, {
      event_type: 'data.delete', event_category: 'data_modification', severity: 'info',
      resource_type: 'memory', resource_id: result.memoryId, action: 'memory.forget', success: true,
      metadata: { drawer: result.drawerId, cancelledProposals: result.cancelledProposals.length, messageId: request.params.messageId },
    }, requestMeta(request));
    return { forgotten: result };
  });

  fastify.get<{ Params: { id: string } }>('/api/memory/recall/conversations/:id/summaries', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply);
    if (!owner) return reply;
    if (!ID.test(request.params.id)) return notFound(reply);
    const c = await sql().read(one<{ id: string }>('SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?', request.params.id, owner.userId!));
    if (!c) return notFound(reply);
    const rows = await sql().read(all<{ id: string; level: number; first_index: number; last_index: number; turns: number; summary: string; source: string; model: string | null; created_at: string }>(
      'SELECT id, level, first_index, last_index, turns, summary, source, model, created_at FROM chat_turn_summaries WHERE session_id = ? AND user_id = ? ORDER BY level, first_index',
      c.id, owner.userId!)).catch(() => []);
    reply.header('Cache-Control', 'no-store');
    return {
      summaries: rows.map((r) => ({
        id: r.id, level: r.level, firstTurn: r.first_index + 1, lastTurn: r.last_index + 1, turns: r.turns,
        text: r.summary, source: r.source, model: r.model, createdAt: r.created_at,
      })),
    };
  });

  fastify.get('/api/memory/cache/metrics', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply);
    if (!owner) return reply;
    const budget = contextBudget();
    reply.header('Cache-Control', 'no-store');
    return {
      process: { ...cacheMetrics(), entries: { context: contextCacheEntries(), embedding: getEmbeddingService().cache.entries } },
      recent: await traceMetrics(owner.userId!),
      budget: { numCtx: budget.numCtx, promptTokens: budget.promptTokens, summaryTokens: budget.summaryTokens, keepAlive: budget.keepAlive },
    };
  });

  // The owner's "Clear cache": only this owner's in-memory context entries. Nothing
  // stored is touched; every entry is keyed by memory revisions anyway, so this only
  // forces the next turn to rebuild its context.
  fastify.post('/api/memory/cache/clear', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply);
    if (!owner) return reply;
    const b = body(request);
    if (b.confirm !== true || Object.keys(b).some((k) => k !== 'confirm')) return reply.code(400).send({ error: 'Send confirm: true to clear the cache', code: 'confirm_required' });
    const cleared = dropContextCache(owner.userId!);
    void repositories.audit.record(owner, {
      event_type: 'data.update', event_category: 'data_modification', severity: 'info',
      resource_type: 'memory_cache', resource_id: owner.userId!, action: 'memory_cache.clear', success: true, metadata: { cleared },
    }, requestMeta(request));
    return { cleared };
  });

  fastify.post<{ Params: { id: string } }>('/api/memory/:id/move', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply);
    if (!owner) return reply;
    const b = body(request);
    let to;
    try { to = parseDrawerId(b.drawer); } catch (err) {
      if (err instanceof DrawerInputError) return reply.code(400).send({ error: 'Invalid drawer', code: 'invalid_drawer' });
      throw err;
    }
    if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 200)) return reply.code(400).send({ error: 'reason must be at most 200 characters', code: 'invalid_reason' });
    try {
      const { memory, from } = await repositories.memory.move(owner, request.params.id, to, typeof b.reason === 'string' ? b.reason : null);
      void repositories.audit.record(owner, {
        event_type: 'data.update', event_category: 'data_modification', severity: 'info',
        resource_type: 'memory', resource_id: memory.id, action: 'memory.move', success: true,
        metadata: { from: drawerId(from), to: drawerId(to) },
      }, requestMeta(request));
      const { embedding, embeddingModel, ...item } = memory;
      return { memory: item, from: drawerId(from), to: drawerId(to) };
    } catch (err) {
      if (err instanceof MoveError) return reply.code(400).send({ error: err.message, code: err.code });
      if (err instanceof TopicKeyTakenError) return reply.code(409).send({ error: err.message, code: 'topic_key_taken', memoryId: err.holderId });
      return sendScopeError(reply, err);
    }
  });
}
