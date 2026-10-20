/**
 * Agent handoff notes (CORE-MEM-HANDOFF), owner only (auth gate owner tier +
 * handler check). The owner sees and edits only their own notes; an edit is
 * a new version (source "owner") that the agent's next session starts from.
 *
 *   GET /api/handoffs?agentId=&kind=&limit=           newest note of every scope { handoffs }
 *   GET /api/handoffs/:kind/:scopeId?agentId=          { handoff, history } (kind: conversation | task)
 *   PUT /api/handoffs/:kind/:scopeId                   { agentId, done?, left?, next?, questions? } -> { handoff }
 *
 * 400 { code: 'invalid_handoff' }, 404 { code: 'not_found' } (also for a scope of another owner).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { cleanHandoff, handoffHistory, HandoffInputError, HANDOFF_KINDS, listHandoffs, saveHandoff, type HandoffKind, type HandoffScope } from '../../memory/handoff/store.js';
import { conversationScope } from '../../memory/handoff/scope.js';
import { one, sql } from '../../repositories/sql-steps.js';

const OWNER_ONLY = ['owner'] as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const AGENT_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

type Req = FastifyRequest<{ Params: { kind?: string; scopeId?: string }; Querystring: Record<string, string | undefined>; Body: unknown }>;

export async function agentHandoffRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  const owner = (request: FastifyRequest, reply: FastifyReply) => authorizeActiveRole(request, reply, OWNER_ONLY);
  const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error, code: 'invalid_handoff' });
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'Not found', code: 'not_found' });

  /** The scope named by the path, only when it is the caller's own. */
  async function scopeOf(ownerId: string, kind: string | undefined, scopeId: string | undefined, agentId: unknown): Promise<HandoffScope | 'bad' | undefined> {
    if (!(HANDOFF_KINDS as readonly string[]).includes(kind ?? '') || !ID.test(scopeId ?? '') || typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return 'bad';
    if (kind === 'conversation') return conversationScope(ownerId, scopeId!, agentId);
    // A board task: one this agent ran (a task run row) or one with a note of this owner already.
    const known = await sql().read(one('SELECT 1 AS x FROM task_runs WHERE task_id = ? AND agent_id = ? LIMIT 1', scopeId!, agentId))
      ?? await sql().read(one("SELECT 1 AS x FROM agent_handoffs WHERE owner_id = ? AND agent_id = ? AND scope_kind = 'task' AND scope_id = ? LIMIT 1", ownerId, agentId, scopeId!));
    return known ? { ownerId, agentId, kind: kind as HandoffKind, scopeId: scopeId!, projectId: null } : undefined;
  }

  fastify.get('/api/handoffs', { config }, async (request: Req, reply) => {
    const ownerId = owner(request, reply);
    if (ownerId === null) return reply;
    const { agentId, kind, limit } = request.query ?? {};
    if (agentId !== undefined && !AGENT_ID.test(agentId)) return bad(reply, 'invalid agentId');
    if (kind !== undefined && !(HANDOFF_KINDS as readonly string[]).includes(kind)) return bad(reply, 'kind must be conversation or task');
    const n = limit === undefined ? undefined : Number(limit);
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 200)) return bad(reply, 'limit must be 1-200');
    return { handoffs: await listHandoffs(ownerId, { agentId, kind: kind as HandoffKind | undefined, limit: n }) };
  });

  fastify.get('/api/handoffs/:kind/:scopeId', { config }, async (request: Req, reply) => {
    const ownerId = owner(request, reply);
    if (ownerId === null) return reply;
    const scope = await scopeOf(ownerId, request.params.kind, request.params.scopeId, request.query?.agentId);
    if (scope === 'bad') return bad(reply, 'kind, scope id and agentId are required');
    if (!scope) return notFound(reply);
    const history = await handoffHistory(scope);
    return { handoff: history[0] ?? null, history };
  });

  fastify.put('/api/handoffs/:kind/:scopeId', { config }, async (request: Req, reply) => {
    const ownerId = owner(request, reply);
    if (ownerId === null) return reply;
    const b = request.body;
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return bad(reply, 'Body must be a JSON object');
    const unknown = Object.keys(b).find((k) => !['agentId', 'done', 'left', 'next', 'questions'].includes(k));
    if (unknown) return bad(reply, `Unknown field "${unknown.slice(0, 40)}"`);
    const scope = await scopeOf(ownerId, request.params.kind, request.params.scopeId, (b as Record<string, unknown>).agentId);
    if (scope === 'bad') return bad(reply, 'kind, scope id and agentId are required');
    if (!scope) return notFound(reply);
    try {
      return { handoff: await saveHandoff(scope, cleanHandoff(b), 'owner') };
    } catch (err) {
      if (err instanceof HandoffInputError) return bad(reply, err.message);
      throw err;
    }
  });
}
