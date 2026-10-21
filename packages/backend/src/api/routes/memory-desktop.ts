/**
 * Memory as a desktop program (MEM-UX-02 backend). Owner only (auth gate
 * owner tier for /api/memory/trash*, /api/memory/groups*,
 * /api/memory/projects* and POST /api/memory/:id/restore; handler role
 * check). Every change is written to the audit log.
 *
 * Trash (MEM-TRASH-01; DELETE /api/memory/:id moves a memory to the Trash)
 *   GET  /api/memory/trash                          { items, projects, trashDays }
 *   POST /api/memory/:id/restore                    -> { restored: { id, drawer, topicKeyDropped } }
 *   POST /api/memory/trash/empty                    { confirm: "EMPTY", ids?, projects? } -> { forgotten, projects, skipped }
 *   POST /api/memory/trash/projects/:slug           move a whole project to the Trash
 *   POST /api/memory/trash/projects/:slug/restore   bring it back with its memories
 *   (keep-days: PUT /api/memory/scopes/rules { scope: "company", trashDays: 7 | 30 | 90 | 0 })
 * Groups of projects
 *   GET    /api/memory/groups                       { groups }
 *   POST   /api/memory/groups                       { name, label?, shareWithin?, projects? } -> 201 { group }
 *   PATCH  /api/memory/groups/:id                   { name?, label?, shareWithin? } -> { group }
 *   DELETE /api/memory/groups/:id                   -> { id, projects } (the projects stay)
 *   PUT    /api/memory/groups/:id/projects          { projects: [slugs] } -> { group }
 *
 * Errors: 400 { error, code }, 404 not_found, 409 (no_change, not_in_trash, name_taken, too_many).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { repositories } from '../../repositories/index.js';
import type { Actor } from '../../repositories/actor.js';
import { requestMeta } from '../../repositories/audit.js';
import { actorOrReply, requireOwner } from '../../repositories/scope.js';
import { ScopeInputError } from '../../memory/scopes/store.js';
import { createGroup, deleteGroup, listGroups, setGroupProjects, updateGroup } from '../../memory/scopes/groups.js';
import { emptyTrash, listTrash, restoreMemory, restoreProject, trashProject } from '../../memory/trash.js';

function body(request: FastifyRequest): Record<string, unknown> {
  const b = request.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw new ScopeInputError('Body must be a JSON object');
  return b as Record<string, unknown>;
}

const param = (request: FastifyRequest, name: string): string => String((request.params as Record<string, unknown>)[name] ?? '');

export async function memoryDesktopRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  type Handler = (owner: Actor, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  const route = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, handler: Handler) => fastify.route({
    method, url, config,
    handler: async (request, reply) => {
      const owner = actorOrReply(reply, actorOf(request), requireOwner);
      if (owner === null) return reply;
      try {
        return await handler(owner, request, reply);
      } catch (err) {
        if (err instanceof ScopeInputError) return reply.code(err.status).send({ error: err.message, code: err.code });
        throw err;
      }
    },
  });
  const audit = (request: FastifyRequest, owner: Actor, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown>, eventType: 'data.update' | 'data.delete' = 'data.update') => {
    void repositories.audit.record(owner, {
      event_type: eventType, event_category: 'data_modification', severity: 'info',
      resource_type: resourceType, resource_id: resourceId, action, success: true, metadata,
    }, requestMeta(request));
  };

  // ---- Trash ----
  route('GET', '/api/memory/trash', async (owner) => listTrash(owner.userId!));
  route('POST', '/api/memory/:id/restore', async (owner, request) => {
    const restored = await restoreMemory(owner.userId!, param(request, 'id'), owner.userId!);
    audit(request, owner, 'memory.restore', 'memory', restored.id, { drawer: restored.drawer, topicKeyDropped: restored.topicKeyDropped });
    return { restored };
  });
  route('POST', '/api/memory/trash/empty', async (owner, request) => {
    const b = body(request);
    if (b.confirm !== 'EMPTY') throw new ScopeInputError('Confirm with confirm: "EMPTY" (this cannot be undone)', 400, 'confirm_required');
    const out = await emptyTrash(owner.userId!, { ids: b.ids, projects: b.projects }, owner.userId!);
    audit(request, owner, 'memory.trash_empty', 'memory_trash', owner.userId!, { forgotten: out.forgotten.length, projects: out.projects, skipped: out.skipped.length }, 'data.delete');
    return out;
  });
  route('POST', '/api/memory/trash/projects/:slug', async (owner, request) => {
    const out = await trashProject(owner.userId!, param(request, 'slug'), owner.userId!);
    audit(request, owner, 'memory_scope.project_trash', 'memory_project', out.project, { memories: out.memories });
    return out;
  });
  route('POST', '/api/memory/trash/projects/:slug/restore', async (owner, request) => {
    const out = await restoreProject(owner.userId!, param(request, 'slug'), owner.userId!);
    audit(request, owner, 'memory_scope.project_restore', 'memory_project', out.project, { restored: out.restored });
    return out;
  });

  // ---- Groups of projects ----
  route('GET', '/api/memory/groups', async (owner) => ({ groups: await listGroups(owner.userId!) }));
  route('POST', '/api/memory/groups', async (owner, request, reply) => {
    const group = await createGroup(owner.userId!, body(request), owner.userId!);
    audit(request, owner, 'memory_group.create', 'memory_group', group.id, { name: group.name, shareWithin: group.shareWithin, projects: group.projects });
    return reply.code(201).send({ group });
  });
  route('PATCH', '/api/memory/groups/:id', async (owner, request) => {
    const b = body(request);
    const group = await updateGroup(owner.userId!, param(request, 'id'), b);
    audit(request, owner, 'memory_group.update', 'memory_group', group.id, { fields: Object.keys(b), shareWithin: group.shareWithin });
    return { group };
  });
  route('DELETE', '/api/memory/groups/:id', async (owner, request) => {
    const out = await deleteGroup(owner.userId!, param(request, 'id'));
    audit(request, owner, 'memory_group.delete', 'memory_group', out.id, { projects: out.projects }, 'data.delete');
    return out;
  });
  route('PUT', '/api/memory/groups/:id/projects', async (owner, request) => {
    const group = await setGroupProjects(owner.userId!, param(request, 'id'), body(request).projects);
    audit(request, owner, 'memory_group.projects', 'memory_group', group.id, { projects: group.projects, shareWithin: group.shareWithin });
    return { group };
  });
}
