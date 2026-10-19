/**
 * Memory API Routes
 *
 * RESTful endpoints for memory management
 */

import { actorOf } from '../../auth/auth-gate.js';
import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getMemoryStorage } from '../../memory/storage.js';
import { MEMORY_TYPES, isMemoryType } from '../../memory/types.js';
import { DrawerInputError, normalizeDrawer, ownerScopeFromInput, selectDrawers, type DrawerRef } from '../../memory/drawers.js';
import type { Memory, MemoryType, ImportanceLevel, MultiTierLayer } from '../../memory/types.js';
import { repositories } from '../../repositories/index.js';
import { requestMeta } from '../../repositories/audit.js';
import { ScopeError, sendScopeError } from '../../repositories/scope.js';
import { MemoryCursorError } from '../../memory/display-page.js';

const MAX_CONTENT = 50_000;
const MAX_METADATA_JSON = 64 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Editable memory fields (allowlist, S0-Q.17 review fix): content, summary,
 * type (one of MEMORY_TYPES), importance (1-10), metadata (object), tags
 * (strings). Anything else in the body is ignored. Returns an error string
 * for invalid values.
 */
function pickMemoryUpdates(body: unknown): { updates: Partial<Memory> } | { error: string } {
  const src = isPlainObject(body) ? body : {};
  const updates: Partial<Memory> = {};
  if (src.content !== undefined) {
    if (typeof src.content !== 'string' || !src.content.trim() || src.content.length > MAX_CONTENT) return { error: 'Invalid content' };
    updates.content = src.content;
  }
  if (src.summary !== undefined) {
    if (typeof src.summary !== 'string' || src.summary.length > 2000) return { error: 'Invalid summary' };
    updates.summary = src.summary;
  }
  if (src.type !== undefined) {
    if (!isMemoryType(src.type)) return { error: 'Invalid memory type' };
    updates.type = src.type;
  }
  if (src.importance !== undefined) {
    if (!Number.isInteger(src.importance) || (src.importance as number) < 1 || (src.importance as number) > 10) return { error: 'importance must be 1-10' };
    updates.importance = src.importance as ImportanceLevel;
  }
  if (src.metadata !== undefined) {
    if (!isPlainObject(src.metadata) || JSON.stringify(src.metadata).length > MAX_METADATA_JSON) return { error: 'Invalid metadata' };
    updates.metadata = src.metadata;
  }
  if (src.tags !== undefined) {
    if (!Array.isArray(src.tags) || src.tags.length > 50 || !src.tags.every(t => typeof t === 'string' && t.length <= 100)) return { error: 'Invalid tags' };
    updates.tags = src.tags as string[];
  }
  return { updates };
}

/**
 * CORE-03: drawers a recall request reads. Scope parameters `project`,
 * `task`, `people` (comma list) and `experience` (false to skip) select the
 * caller's own owner drawer + experience + only the named project/task/people
 * drawers. Returns null for invalid input.
 */
function recallDrawers(input: Record<string, unknown>): { drawers: DrawerRef[] } | null {
  try {
    return { drawers: selectDrawers(ownerScopeFromInput(input)) };
  } catch (err) {
    if (err instanceof DrawerInputError) return null;
    throw err;
  }
}

/**
 * SECURITY (S0-Q.11): every /api/memory* route needs a valid bearer token of an
 * active user. The user always comes from the token; `userId` in the query or
 * body is ignored. Memories of other users answer 404 (there is no owner-wide
 * memory view). Server-wide maintenance (consolidation run, its log) is
 * owner-only.
 *
 * B1-core / B1.6: every route goes through the memory repository
 * (repositories/memory.ts, memory-recall.ts) with the request's actor, which
 * enforces "own memories only" (and owner-only maintenance) centrally.
 */
const memoryRepo = repositories.memory;

/** Repository 404s keep this route's message; other scope errors as sent. */
function memoryError(reply: import('fastify').FastifyReply, err: unknown) {
  if (err instanceof ScopeError && err.status === 404) return reply.code(404).send({ error: 'Memory not found' });
  return sendScopeError(reply, err);
}

export async function memoryRoutes(fastify: FastifyInstance) {
  // Initialize storage
  await getMemoryStorage().initialize();

  // Encapsulated to this plugin: applies to the memory routes only.
  fastify.addHook('preHandler', async (request, reply) => {
    if (!actorOf(request)) return reply.code(401).send({ error: 'Authentication required' });
  });

  fastify.get<{ Querystring: { cursor?: string } }>('/api/memory/page', async (request, reply) => {
    if (Object.keys(request.query).some(k => k !== 'cursor') || (request.query.cursor !== undefined && typeof request.query.cursor !== 'string')) return reply.code(400).send({ error: 'Invalid memory cursor' });
    try { return await memoryRepo.displayPage(actorOf(request), request.query.cursor); }
    catch (err) {
      if (err instanceof MemoryCursorError) return reply.code(400).send({ error: 'Invalid memory cursor' });
      return memoryError(reply, err);
    }
  });

  /** GET /api/memory - compatibility list; embeddings remain internal. */
  fastify.get('/api/memory', async (request, reply) => {
    let memories;
    try {
      memories = await memoryRepo.list(actorOf(request));
    } catch (err) { return memoryError(reply, err); }

    return {
      success: true,
      count: memories.length,
      memories: memories.map(({ embedding, embeddingModel, ...item }) => item)
    };
  });

  /**
   * GET /api/memory/drawers - The caller's drawers with memory counts (CORE-03)
   */
  fastify.get('/api/memory/drawers', async (request, reply) => {
    try {
      return { success: true, drawers: await memoryRepo.drawers(actorOf(request)) };
    } catch (err) { return memoryError(reply, err); }
  });

  /**
   * GET /api/memory/:id - Get a specific memory
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/memory/:id',
    async (request, reply) => {
      const { id } = request.params;

      let memory;
      try {
        memory = await memoryRepo.get(actorOf(request), id);
      } catch (err) { return memoryError(reply, err); }

      return {
        success: true,
        memory
      };
    }
  );

  /**
   * POST /api/memory - Create a new memory
   */
  fastify.post('/api/memory', async (request, reply) => {
    const body = { ...(request.body as object || {}) } as {
      type: MemoryType;
      content: string;
      importance?: number;
      metadata?: Record<string, any>;
      drawer?: unknown;
    };

    // CORE-03: optional drawer { kind, key? }; default by type.
    let drawer: DrawerRef | undefined;
    if (body.drawer !== undefined && body.drawer !== null) {
      try {
        drawer = normalizeDrawer(body.drawer);
      } catch (err) {
        if (err instanceof DrawerInputError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    }

    if (!body.type || !body.content) {
      return reply.code(400).send({
        error: 'type and content are required'
      });
    }
    // The type is part of the markdown file name: only known types.
    if (!isMemoryType(body.type)) {
      return reply.code(400).send({ error: 'Invalid memory type' });
    }
    if (typeof body.content !== 'string' || body.content.length > MAX_CONTENT) {
      return reply.code(400).send({ error: 'Invalid content' });
    }
    if (body.importance !== undefined && (!Number.isInteger(body.importance) || body.importance < 1 || body.importance > 10)) {
      return reply.code(400).send({ error: 'importance must be 1-10' });
    }
    if (body.metadata !== undefined && (!isPlainObject(body.metadata) || JSON.stringify(body.metadata).length > MAX_METADATA_JSON)) {
      return reply.code(400).send({ error: 'Invalid metadata' });
    }

    // Determine memory layer based on importance (same logic as memory_save tool)
    const importance = body.importance || 5;
    let memoryLayer: MultiTierLayer = 'working';
    let expiryTimestamp: number | null = Date.now() + (24 * 60 * 60 * 1000); // 24h default

    if (importance >= 8) {
      // High importance → Factual (permanent)
      memoryLayer = 'factual';
      expiryTimestamp = null; // Never expires
    } else if (importance >= 6) {
      // Medium importance → Experiential (90 days)
      memoryLayer = 'experiential';
      expiryTimestamp = Date.now() + (90 * 24 * 60 * 60 * 1000);
    }
    // Low importance stays in working memory (24h expiry)

    const draft: Omit<Memory, 'userId'> = {
      id: uuidv4(),
      type: body.type,
      content: body.content,
      importance: importance as ImportanceLevel,
      memoryLayer,
      importanceScore: importance / 10,
      consolidationStatus: 'pending',
      expiryTimestamp,
      status: 'active',
      metadata: body.metadata || {},
      createdAt: new Date(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      ...(drawer ? { drawer } : {}),
    };

    // CORE-05: the account's own add, versioned (actor = the caller); the
    // owner of the memory is always the actor (repository).
    let memory: Memory;
    try {
      memory = await memoryRepo.create(actorOf(request), draft, 'api');
    } catch (err) { return memoryError(reply, err); }

    return {
      success: true,
      memory
    };
  });

  /**
   * PUT /api/memory/:id - Update a memory
   */
  fastify.put<{ Params: { id: string } }>(
    '/api/memory/:id',
    async (request, reply) => {
      const { id } = request.params;
      try {
        await memoryRepo.assertAccess(actorOf(request), id);
      } catch (err) { return memoryError(reply, err); }
      // Allowlist of editable fields; identity and bookkeeping fields never change.
      const picked = pickMemoryUpdates(request.body);
      if ('error' in picked) {
        return reply.code(400).send({ error: picked.error });
      }
      const { updates } = picked;

      try {
        // CORE-05: baseline + new version, actor = the caller.
        const updated = await memoryRepo.update(actorOf(request), id, updates, 'api');

        return {
          success: true,
          memory: updated
        };
      } catch (err: any) {
        return reply.code(404).send({ error: 'Memory not found' });
      }
    }
  );

  /**
   * DELETE /api/memory/:id - Delete a memory
   */
  fastify.delete<{ Params: { id: string } }>(
    '/api/memory/:id',
    async (request, reply) => {
      const { id } = request.params;
      // CORE-05: the history keeps the old text (reversible); forget (CORE-07) removes everything.
      try {
        await memoryRepo.delete(actorOf(request), id, 'api');
      } catch (err) { return memoryError(reply, err); }

      return {
        success: true,
        message: 'Memory deleted'
      };
    }
  );

  /**
   * GET /api/memory/:id/versions - Version history of one own memory (CORE-05)
   */
  fastify.get<{ Params: { id: string } }>('/api/memory/:id/versions', async (request, reply) => {
    let versions;
    try {
      versions = await memoryRepo.versions(actorOf(request), request.params.id);
    } catch (err) { return memoryError(reply, err); }
    return { success: true, memoryId: request.params.id, versions };
  });

  /**
   * POST /api/memory/:id/forget - Forget one own memory completely (CORE-07):
   * row, version text, index rows, readable copies and exports. Only a
   * tombstone (id, time, actor) stays. Another user's memory -> 404.
   */
  fastify.post<{ Params: { id: string } }>('/api/memory/:id/forget', async (request, reply) => {
    let result;
    try {
      result = await memoryRepo.forget(actorOf(request), request.params.id);
    } catch (err) { return memoryError(reply, err); }
    if (!result) return reply.code(404).send({ error: 'Memory not found' });
    void repositories.audit.record(actorOf(request), {
      event_type: 'data.delete', event_category: 'data_modification', severity: 'info',
      resource_type: 'memory', resource_id: result.memoryId, action: 'memory.forget', success: true,
      metadata: { drawer: result.drawerId, cancelledProposals: result.cancelledProposals.length },
    }, requestMeta(request));
    return { success: true, forgotten: result };
  });

  /**
   * GET /api/memory/forgotten - The caller's tombstones (id, drawer, time, actor; no text)
   */
  fastify.get('/api/memory/forgotten', async (request, reply) => {
    try {
      return { success: true, tombstones: await memoryRepo.tombstones(actorOf(request)) };
    } catch (err) { return memoryError(reply, err); }
  });

  /**
   * POST /api/memory/search - Search own memories (Multi-Tier Memory filters)
   */
  fastify.post('/api/memory/search', async (request, reply) => {
    const body = { ...(request.body as object || {}) } as {
      query: string;
      type?: MemoryType;
      layer?: MultiTierLayer;
      limit?: number;
      minImportance?: number;
      minImportanceScore?: number;
    };

    if (!body.query) {
      return reply.code(400).send({
        error: 'query is required'
      });
    }
    // Browsing one's own memory searches every drawer; with scope parameters
    // (project/task/people/experience) it reads only those drawers (CORE-03).
    const input = body as Record<string, unknown>;
    const scoped = ['project', 'task', 'people', 'experience'].some((k) => input[k] !== undefined);
    const scope = scoped ? recallDrawers(input) : {};
    if (!scope) return reply.code(400).send({ error: 'Invalid drawer scope' });

    let results;
    try {
      results = await memoryRepo.search(actorOf(request), {
        ...scope,
        query: body.query,
        type: body.type,
        layer: body.layer,
        limit: body.limit,
        minImportance: body.minImportance as ImportanceLevel | undefined,
        minImportanceScore: body.minImportanceScore,
      });
    } catch (err) { return memoryError(reply, err); }

    return {
      success: true,
      count: results.length,
      results
    };
  });

  /**
   * POST /api/memory/extract - Extract memories from text
   */
  fastify.post('/api/memory/extract', async (request, reply) => {
    const body = { ...(request.body as object || {}) } as { text: string };

    if (!body.text || typeof body.text !== 'string') {
      return reply.code(400).send({
        error: 'text is required'
      });
    }

    // CORE-05: extracted items are classified; routine ones are saved, important
    // ones become proposals for the owner (or are not saved for other accounts).
    let outcome;
    try {
      outcome = await memoryRepo.extract(actorOf(request), body.text);
    } catch (err) { return memoryError(reply, err); }

    return {
      success: true,
      count: outcome.saved.length,
      memories: outcome.saved,
      proposals: outcome.proposed.map((p) => ({ id: p.id, drawerId: p.drawerId, reasons: p.reasons, status: p.status })),
      skipped: outcome.skipped,
    };
  });

  /**
   * GET /api/memory/relevant - Find relevant memories for a query
   */
  fastify.get('/api/memory/relevant', async (request, reply) => {
    const { query, limit } = request.query as {
      query: string;
      limit?: string;
    };

    if (!query) {
      return reply.code(400).send({
        error: 'query is required'
      });
    }
    // CORE-03: chat recall reads only the drawers of this turn (never "all").
    const scope = recallDrawers(request.query as Record<string, unknown>);
    if (!scope) return reply.code(400).send({ error: 'Invalid drawer scope' });

    let memories;
    try {
      memories = await memoryRepo.relevant(actorOf(request), query, limit ? parseInt(limit) : 5, scope.drawers);
    } catch (err) { return memoryError(reply, err); }

    return {
      success: true,
      count: memories.length,
      memories
    };
  });

  /**
   * GET /api/memory/summary - Memory summary of the caller
   */
  fastify.get('/api/memory/summary', async (request, reply) => {
    try {
      const summary = await memoryRepo.summary(actorOf(request));
      return { success: true, summary };
    } catch (err) { return memoryError(reply, err); }
  });

  /**
   * POST /api/memory/consolidate - Consolidate similar own memories
   */
  fastify.post('/api/memory/consolidate', async (request, reply) => {
    let consolidated: number;
    try {
      consolidated = await memoryRepo.consolidateDuplicates(actorOf(request));
    } catch (err) { return memoryError(reply, err); }

    return {
      success: true,
      consolidated,
      message: `Consolidated ${consolidated} duplicate memories`
    };
  });

  /**
   * GET /api/memory/types - Get all memory types
   */
  fastify.get('/api/memory/types', async (request, reply) => {
    return {
      success: true,
      types: MEMORY_TYPES
    };
  });

  // ============ Multi-Tier Memory System Endpoints ============

  /**
   * GET /api/memory/layers/stats - Get statistics for all memory layers
   */
  fastify.get('/api/memory/layers/stats', async (request, reply) => {
    try {
      const stats = await memoryRepo.layerStats(actorOf(request));
      return { success: true, stats };
    } catch (err) { return memoryError(reply, err); }
  });

  /**
   * POST /api/memory/layers/promote - Promote an own memory to the next layer
   */
  fastify.post('/api/memory/layers/promote', async (request, reply) => {
    const body = { ...(request.body as object || {}) } as {
      memoryId: string;
      targetLayer: 'experiential' | 'factual';
    };

    if (!body.memoryId || !body.targetLayer) {
      return reply.code(400).send({
        error: 'memoryId and targetLayer are required'
      });
    }

    let success = false;
    try {
      success = await memoryRepo.promote(actorOf(request), body.memoryId, body.targetLayer);
    } catch (err) { return memoryError(reply, err); }

    if (!success) {
      return reply.code(400).send({
        error: `Failed to promote memory to ${body.targetLayer} layer`
      });
    }

    return {
      success: true,
      message: `Memory promoted to ${body.targetLayer} layer`
    };
  });

  /**
   * POST /api/memory/layers/consolidate - Manually trigger memory consolidation
   * (runs across every user's memories: owner only)
   */
  fastify.post('/api/memory/layers/consolidate', async (request, reply) => {
    let result;
    try {
      result = await memoryRepo.runConsolidation(actorOf(request));
    } catch (err) { return memoryError(reply, err); }

    return {
      success: true,
      result,
      message: `Consolidated ${result.consolidated} memories, promoted ${result.promoted}, expired ${result.expired}`
    };
  });

  /**
   * GET /api/memory/layers/consolidate/log - Server-wide consolidation log (owner only)
   */
  fastify.get('/api/memory/layers/consolidate/log', async (request, reply) => {
    const { limit } = request.query as { limit?: string };
    let log;
    try {
      log = await memoryRepo.consolidationLog(actorOf(request), limit ? parseInt(limit) : 10);
    } catch (err) { return memoryError(reply, err); }

    return {
      success: true,
      count: log.length,
      log
    };
  });

  /**
   * GET /api/memory/layers/candidates - Get promotion candidates
   */
  fastify.get('/api/memory/layers/candidates', async (request, reply) => {
    let candidates;
    try {
      candidates = await memoryRepo.promotionCandidates(actorOf(request));
    } catch (err) { return memoryError(reply, err); }

    return {
      success: true,
      count: candidates.length,
      candidates
    };
  });

  /**
   * POST /api/memory/importance - Update memory importance score
   */
  fastify.post('/api/memory/importance', async (request, reply) => {
    const body = request.body as {
      memoryId: string;
      importanceScore: number;
    };

    if (!body.memoryId || body.importanceScore === undefined) {
      return reply.code(400).send({
        error: 'memoryId and importanceScore are required'
      });
    }

    let success: boolean;
    try {
      success = await memoryRepo.setImportanceScore(actorOf(request), body.memoryId, body.importanceScore);
    } catch (err) { return memoryError(reply, err); }

    if (!success) {
      return reply.code(404).send({ error: 'Memory not found' });
    }

    return {
      success: true,
      message: 'Importance score updated'
    };
  });
}
