/**
 * Settings → Connections: applications linked to this Dpro through an account
 * grant (owner only). Today: Genvr worlds. Tokens never appear in a response.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { genvrConnection, startGenvrLink, cancelGenvrLink, disconnectGenvr, errorCode } from '../../services/genvr-account.js';
import { listPublications, uploadTestWorld, publishTestWorld, PublicationError, type PublishInput } from '../../services/genvr-publication.js';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const empty = (v: unknown) => v === undefined || (record(v) && Object.keys(v).length === 0);
const confirmed = (v: unknown) => record(v) && Object.keys(v).length === 1 && v.confirm === true;
const CONTENT = ['violence', 'blood', 'horror', 'romance', 'userChat', 'paidItems'] as const;
function publishInput(v: unknown): PublishInput | null {
  if (!record(v) || Object.keys(v).sort().join(',') !== 'access,confirm,content,title,type' || v.confirm !== true) return null;
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 120 || /[\0-\x1f]/.test(v.title)) return null;
  if (!['game', 'event', 'social'].includes(v.type as string) || !['public', 'friends', 'invite'].includes(v.access as string)) return null;
  const c = v.content; if (!record(c) || Object.keys(c).sort().join(',') !== [...CONTENT].sort().join(',') || !CONTENT.every(k => typeof c[k] === 'boolean')) return null;
  return { title: v.title.trim(), type: v.type as PublishInput['type'], access: v.access as PublishInput['access'], content: c as PublishInput['content'] };
}

export async function connectionsRoutes(app: FastifyInstance) {
  const owner = (request: FastifyRequest, reply: FastifyReply): string | null => {
    if (!request.authUser || request.authUser.role !== 'owner') { void reply.code(403).send({ code: 'forbidden' }); return null; }
    return request.authUser.id;
  };
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof PublicationError) return reply.code(e.status).send({ code: e.code });
    const code = errorCode(e); return reply.code(code === 'unavailable' ? 503 : 502).send({ code });
  };
  const opts = { config: { access: 'owner' as const, rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.get('/api/connections', opts, async (request, reply) => {
    const user = owner(request, reply); if (!user) return;
    return { connections: [await genvrConnection(user)] };
  });
  app.post('/api/connections/genvr/link', opts, async (request, reply) => {
    const user = owner(request, reply); if (!user) return; if (!empty(request.body)) return reply.code(400).send({ code: 'invalid_input' });
    try { return { connection: await startGenvrLink(user) }; } catch (e) { return fail(reply, e); }
  });
  app.post('/api/connections/genvr/cancel', opts, async (request, reply) => {
    const user = owner(request, reply); if (!user) return; if (!empty(request.body)) return reply.code(400).send({ code: 'invalid_input' });
    return { connection: await cancelGenvrLink(user) };
  });
  app.post('/api/connections/genvr/disconnect', opts, async (request, reply) => {
    const user = owner(request, reply); if (!user) return; if (!confirmed(request.body)) return reply.code(400).send({ code: 'invalid_input' });
    return { connection: await disconnectGenvr(user) };
  });
  app.get('/api/connections/genvr/publications', opts, async (request, reply) => {
    const user = owner(request, reply); if (!user) return;
    return { publications: await listPublications(user) };
  });
  app.post('/api/connections/genvr/test-world/upload', opts, async (request, reply) => {
    const user = owner(request, reply); if (!user) return; if (!confirmed(request.body)) return reply.code(400).send({ code: 'invalid_input' });
    try { return { publication: await uploadTestWorld(user) }; } catch (e) { return fail(reply, e); }
  });
  app.post('/api/connections/genvr/test-world/publish', opts, async (request, reply) => {
    const user = owner(request, reply); if (!user) return; const input = publishInput(request.body); if (!input) return reply.code(400).send({ code: 'invalid_input' });
    try { return { publication: await publishTestWorld(user, input) }; } catch (e) { return fail(reply, e); }
  });
}
