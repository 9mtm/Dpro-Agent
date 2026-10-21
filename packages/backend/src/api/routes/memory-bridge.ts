/**
 * Memory bridge for coding agents (MEM-BRIDGE-01).
 *
 * Owner only (auth gate owner tier + handler check):
 *   GET   /api/memory-bridge                                    status: CLIs (kill switch, registration), project folders, registrations
 *   PUT   /api/memory-bridge/clients/:client                    { enabled } kill switch (off also deletes the CLI's token)
 *   GET   /api/memory-bridge/clients/:client/registration       dry run: the server entry for the CLI's config file + previewHash
 *   POST  /api/memory-bridge/clients/:client/registration       { previewHash, confirm: true } backs up the file, then writes it
 *   POST  /api/memory-bridge/registrations/:id/undo             restores the backup (or removes only Dpro's entry)
 *   GET   /api/memory-bridge/projects/:projectId/files          dry run of AGENTS.md / CLAUDE.md / GEMINI.md (+ .git/info/exclude)
 *   POST  /api/memory-bridge/projects/:projectId/files          { previewHash, confirm: true } writes them; kept in sync from then on
 *   PATCH /api/memory-bridge/projects/:projectId                { filesEnabled: false?, backflowEnabled?, gitExclude? }
 *   POST  /api/memory-bridge/projects/:projectId/backflow       imports the CLIs' own memory files as review proposals now
 *   GET   /api/memory-bridge/audit?limit=&client=&projectId=    what the bridge did (activity log), newest first
 *
 * The dpro-memory MCP server (public in the gate; loopback only, own proof):
 *   POST  /api/memory-bridge/mcp/session   { client, nonce, proof } -> { token }   (install proof, CLI switched on)
 *   POST  /api/memory-bridge/mcp/call      header x-dpro-bridge-token; { client, cwd, tool, args } -> { text, data }
 *
 * Errors: { error, code } with 400 / 401 / 403 / 404 / 409 / 422.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import {
  activity, backflowNow, BridgeError, bridgeStatus, filesApply, filesPreview, mcpCall, openSession, registrationApply, registrationPreview,
  registrationUndo, setClient, setFolder,
} from '../../memory/bridge/service.js';

const OWNER_ONLY = ['owner'] as const;
export const BRIDGE_TOKEN_HEADER = 'x-dpro-bridge-token';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string | undefined>; Body: unknown }>;
const bodyOf = (r: { body?: unknown }): Record<string, any> => (r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body as Record<string, any> : {});

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof BridgeError) return reply.code(err.status).send({ error: err.message, code: err.code });
  throw err;
}

export async function memoryBridgeRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  const owner = (request: FastifyRequest, reply: FastifyReply) => authorizeActiveRole(request, reply, OWNER_ONLY);
  /** Runs `fn` for the owner; BridgeError -> its status. */
  const asOwner = (fn: (ownerId: string, request: Req) => Promise<unknown>) => async (request: Req, reply: FastifyReply) => {
    const ownerId = owner(request, reply);
    if (ownerId === null) return reply;
    try { return await fn(ownerId, request); } catch (err) { return fail(reply, err); }
  };

  fastify.get('/api/memory-bridge', { config }, asOwner((o) => bridgeStatus(o)));
  fastify.put('/api/memory-bridge/clients/:client', { config }, asOwner((o, r) => setClient(o, r.params.client, bodyOf(r).enabled)));
  fastify.get('/api/memory-bridge/clients/:client/registration', { config }, asOwner(async (o, r) => ({ preview: await registrationPreview(o, r.params.client) })));
  fastify.post('/api/memory-bridge/clients/:client/registration', { config }, asOwner((o, r) => registrationApply(o, r.params.client, bodyOf(r))));
  fastify.post('/api/memory-bridge/registrations/:id/undo', { config }, asOwner((o, r) => registrationUndo(o, r.params.id)));
  fastify.get('/api/memory-bridge/projects/:projectId/files', { config }, asOwner(async (o, r) => ({ preview: await filesPreview(o, r.params.projectId) })));
  fastify.post('/api/memory-bridge/projects/:projectId/files', { config }, asOwner(async (o, r) => ({ result: await filesApply(o, r.params.projectId, bodyOf(r)) })));
  fastify.patch('/api/memory-bridge/projects/:projectId', { config }, asOwner(async (o, r) => ({ folder: await setFolder(o, r.params.projectId, bodyOf(r)) })));
  fastify.post('/api/memory-bridge/projects/:projectId/backflow', { config }, asOwner(async (o, r) => ({ result: await backflowNow(o, r.params.projectId) })));
  fastify.get('/api/memory-bridge/audit', { config }, asOwner(async (o, r) => ({
    entries: await activity(o, { limit: r.query?.limit, client: r.query?.client, projectId: r.query?.projectId }),
  })));

  // --- the dpro-memory MCP server (no user token; its own proof, this machine only) ---
  const local = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (LOOPBACK.has(request.socket?.remoteAddress ?? '')) return true;
    reply.code(403).send({ error: 'Only from this computer', code: 'forbidden' });
    return false;
  };

  fastify.post('/api/memory-bridge/mcp/session', async (request: Req, reply) => {
    if (!local(request, reply)) return reply;
    try { return await openSession(bodyOf(request).client, bodyOf(request).nonce, bodyOf(request).proof); } catch (err) { return fail(reply, err); }
  });

  fastify.post('/api/memory-bridge/mcp/call', async (request: Req, reply) => {
    if (!local(request, reply)) return reply;
    const b = bodyOf(request);
    try { return await mcpCall(b.client, request.headers[BRIDGE_TOKEN_HEADER], b.cwd, b.tool, b.args ?? {}); } catch (err) { return fail(reply, err); }
  });
}
