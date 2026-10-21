/**
 * "Found on this computer" (DISCOVER-01, board M17). Owner only (auth gate:
 * /api/memory/import*) and only from this computer (loopback), like the other
 * local imports. Every change is audited.
 *
 *   GET  /api/memory/import/discovery                  projects, items, settings (scans when nothing was read yet)
 *   POST /api/memory/import/discovery/scan             read again now
 *   PUT  /api/memory/import/discovery/settings         { watch, intervalMinutes: 15 | 30 | 60 }
 *   PUT  /api/memory/import/discovery/roots/:id        { watch } one project folder
 *   GET  /api/memory/import/discovery/items/:id        preview (redacted) + previewHash
 *   POST /api/memory/import/discovery/import           { items: [{ id, previewHash, secret? }] } (1-100)
 *   POST /api/memory/import/discovery/items/:id/ignore { on }
 *   POST /api/memory/import/discovery/items/:id/remove take it out of Dpro (the file stays)
 *   POST /api/memory/import/discovery/items/:id/keep   gone from this computer: keep it in Dpro
 *
 * DISCOVER-02 (board M18):
 *   GET  …/places[?parent=<id>]           folders and drives (top level, or one folder's subfolders)
 *   PUT  …/places                         { allow?, deny?, exclude? } place ids (several at once)
 *   POST …/places                         { path } add a folder or drive by its path (allowed)
 *   POST …/places/:id/count               files and size under a folder (limited)
 *   PUT  …/kinds                          { notes?, tools?, skills?, mcp?, ssh? }
 *   PUT  …/roots/:id/hidden               { kind, on } don't show a kind from a project
 *   POST …/groups                         { name, roots: [project ids] } show as one project
 *   DELETE …/groups/:id                   separate again
 *   POST …/suggestions/:key/dismiss       "not the same"
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { repositories } from '../../repositories/index.js';
import type { Actor } from '../../repositories/actor.js';
import { requestMeta } from '../../repositories/audit.js';
import { actorOrReply, requireOwner } from '../../repositories/scope.js';
import { isLoopbackPeer } from './terminal.js';
import * as D from '../../discovery/service.js';

const BASE = '/api/memory/import/discovery';
const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export async function discoveryRoutes(fastify: FastifyInstance, options: D.DiscoveryOptions = {}) {
  const config = { access: 'owner' as const };
  const owner = (request: FastifyRequest, reply: FastifyReply): Actor | null => {
    const a = actorOrReply(reply, actorOf(request), requireOwner);
    if (a === null) return null;
    if (!isLoopbackPeer(request)) { reply.code(403).send({ error: 'Reading this computer works only on this computer', code: 'not_loopback' }); return null; }
    return a;
  };
  const audit = (request: FastifyRequest, a: Actor, action: string, id: string, metadata: Record<string, unknown>) =>
    void repositories.audit.record(a, { event_type: action.endsWith('remove') ? 'data.delete' : 'data.update', event_category: 'data_modification', severity: 'info', resource_type: 'discovery', resource_id: id, action, success: true, metadata }, requestMeta(request));
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof D.DiscoveryError) return reply.code(e.status).send({ code: e.code });
    const status = (e as { status?: unknown })?.status;
    const code = (e as { code?: unknown })?.code;
    if (typeof status === 'number' && status >= 400 && status < 500 && typeof code === 'string') return reply.code(status).send({ code });
    return reply.code(500).send({ code: 'discovery_failed' });
  };

  fastify.get(BASE, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    try { return await D.view(a.userId!, options); } catch (e) { return fail(reply, e); }
  });
  fastify.post(`${BASE}/scan`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    if (request.body !== undefined && (!record(request.body) || Object.keys(request.body).length)) return reply.code(400).send({ code: 'invalid_input' });
    try { return await D.view(a.userId!, { ...options, rescan: true }); } catch (e) { return fail(reply, e); }
  });
  fastify.put(`${BASE}/settings`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    try { const s = await D.setSettings(a.userId!, request.body); audit(request, a, 'discovery.settings', '-', s); return { settings: s }; } catch (e) { return fail(reply, e); }
  });
  fastify.put<{ Params: { id: string } }>(`${BASE}/roots/:id`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    const b = request.body;
    if (!record(b) || Object.keys(b).join(',') !== 'watch') return reply.code(400).send({ code: 'invalid_input' });
    try { const r = await D.setRootWatch(a.userId!, request.params.id, b.watch); audit(request, a, 'discovery.root_watch', r.id, { watch: r.watch }); return r; } catch (e) { return fail(reply, e); }
  });
  fastify.get<{ Params: { id: string } }>(`${BASE}/items/:id`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    if (!ID.test(request.params.id)) return reply.code(400).send({ code: 'invalid_input' });
    try { return { item: await D.preview(a.userId!, request.params.id, options) }; } catch (e) { return fail(reply, e); }
  });
  fastify.post(`${BASE}/import`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    const b = request.body;
    const ok = record(b) && Object.keys(b).join(',') === 'items' && Array.isArray(b.items) && b.items.length >= 1 && b.items.length <= 100
      && b.items.every((i) => record(i) && Object.keys(i).every((k) => ['id', 'previewHash', 'secret'].includes(k)) && typeof i.id === 'string' && ID.test(i.id) && typeof i.previewHash === 'string' && HASH.test(i.previewHash) && (i.secret === undefined || i.secret === 'credentials' || i.secret === 'leave'))
      && new Set((b.items as { id: string }[]).map((i) => i.id)).size === b.items.length;
    if (!ok) return reply.code(400).send({ code: 'invalid_input' });
    try {
      const results = await D.importItems(a.userId!, (b as { items: { id: string; previewHash: string; secret?: 'credentials' | 'leave' }[] }).items, options);
      audit(request, a, 'discovery.import', '-', { items: results.length, imported: results.filter((r) => r.ok).length });
      return { results };
    } catch (e) { return fail(reply, e); }
  });
  fastify.post<{ Params: { id: string } }>(`${BASE}/items/:id/ignore`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    const b = request.body;
    if (!record(b) || Object.keys(b).join(',') !== 'on' || typeof b.on !== 'boolean') return reply.code(400).send({ code: 'invalid_input' });
    try { const r = await D.ignore(a.userId!, request.params.id, b.on); audit(request, a, 'discovery.ignore', r.id, { on: r.ignored }); return r; } catch (e) { return fail(reply, e); }
  });
  const ids = (x: unknown) => Array.isArray(x) && x.length <= 200 && x.every((i) => typeof i === 'string' && ID.test(i));
  fastify.get<{ Querystring: { parent?: string } }>(`${BASE}/places`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    const parent = request.query.parent;
    if (parent !== undefined && !ID.test(parent)) return reply.code(400).send({ code: 'invalid_input' });
    try { return await D.places(a.userId!, parent, options); } catch (e) { return fail(reply, e); }
  });
  fastify.put(`${BASE}/places`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    const b = request.body;
    if (!record(b) || !Object.keys(b).length || Object.keys(b).some((k) => !['allow', 'deny', 'exclude'].includes(k)) || !Object.values(b).every(ids)) return reply.code(400).send({ code: 'invalid_input' });
    try { const r = await D.setPlaces(a.userId!, b as { allow?: string[]; deny?: string[]; exclude?: string[] }, options); audit(request, a, 'discovery.places', '-', r); return r; } catch (e) { return fail(reply, e); }
  });
  fastify.post(`${BASE}/places`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    const b = request.body;
    if (!record(b) || Object.keys(b).join(',') !== 'path') return reply.code(400).send({ code: 'invalid_input' });
    try { const r = await D.addPlace(a.userId!, b.path, options); audit(request, a, 'discovery.place_add', r.place.id, {}); return r; } catch (e) { return fail(reply, e); }
  });
  fastify.post<{ Params: { id: string } }>(`${BASE}/places/:id/count`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    if (!ID.test(request.params.id)) return reply.code(400).send({ code: 'invalid_input' });
    try { return await D.countPlace(a.userId!, request.params.id, options); } catch (e) { return fail(reply, e); }
  });
  fastify.put(`${BASE}/kinds`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    try { const k = await D.setKinds(a.userId!, request.body); audit(request, a, 'discovery.kinds', '-', k); return { kinds: k }; } catch (e) { return fail(reply, e); }
  });
  fastify.put<{ Params: { id: string } }>(`${BASE}/roots/:id/hidden`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    const b = request.body;
    if (!record(b) || Object.keys(b).sort().join(',') !== 'kind,on') return reply.code(400).send({ code: 'invalid_input' });
    try { const r = await D.hideKind(a.userId!, request.params.id, b.kind, b.on); audit(request, a, 'discovery.hide_kind', r.id, { kind: r.kind, hidden: r.hidden }); return r; } catch (e) { return fail(reply, e); }
  });
  fastify.post(`${BASE}/groups`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    const b = request.body;
    if (!record(b) || Object.keys(b).sort().join(',') !== 'name,roots') return reply.code(400).send({ code: 'invalid_input' });
    try { const r = await D.mergeRoots(a.userId!, b.name, b.roots); audit(request, a, 'discovery.merge', r.group.id, { folders: r.group.folders }); return r; } catch (e) { return fail(reply, e); }
  });
  fastify.delete<{ Params: { id: string } }>(`${BASE}/groups/:id`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    try { const r = await D.separateGroup(a.userId!, request.params.id); audit(request, a, 'discovery.separate', r.id, {}); return r; } catch (e) { return fail(reply, e); }
  });
  fastify.post<{ Params: { key: string } }>(`${BASE}/suggestions/:key/dismiss`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    if (request.body !== undefined && (!record(request.body) || Object.keys(request.body).length)) return reply.code(400).send({ code: 'invalid_input' });
    try { return await D.dismissSuggestion(a.userId!, request.params.key); } catch (e) { return fail(reply, e); }
  });
  for (const action of ['remove', 'keep'] as const) fastify.post<{ Params: { id: string } }>(`${BASE}/items/:id/${action}`, { config }, async (request, reply) => {
    const a = owner(request, reply); if (!a) return reply;
    if (request.body !== undefined && (!record(request.body) || Object.keys(request.body).length)) return reply.code(400).send({ code: 'invalid_input' });
    try { const r = action === 'remove' ? await D.remove(a.userId!, request.params.id) : await D.keep(a.userId!, request.params.id); audit(request, a, `discovery.${action}`, request.params.id, {}); return r; } catch (e) { return fail(reply, e); }
  });
}
