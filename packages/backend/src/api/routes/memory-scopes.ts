/**
 * Memory at scale API (MEM-SCALE-01). Owner only (auth gate owner tier for
 * /api/memory/scopes* and /api/memory/access*, route access 'owner',
 * handler role check). Every change is written to the audit log.
 *
 * Scope tree and explorer
 *   GET  /api/memory/scopes/tree?fresh=1           company / departments / projects / people / agents, counts + health
 *   GET  /api/memory/scopes/search?q=&kinds=&limit= scopes by name (department, project, people, agent)
 *   GET  /api/memory/scopes/agents?q=&cursor=&limit= agents as scopes, paged
 *   GET  /api/memory/scopes/memories?scope=&q=&type=&layer=&topic=&cursor=&limit=
 *                                                   memories of one scope, newest first, cursor paging + facets
 * Departments
 *   POST /api/memory/scopes/departments            { name } -> 201 { department }
 *   PATCH /api/memory/scopes/departments/:id       { name } -> { department }
 *   POST /api/memory/scopes/departments/:id/delete-preview            -> { department, effects, previewHash }
 *   POST /api/memory/scopes/departments/:id/delete { expectedPreviewHash, confirm: true } -> { department, effects }
 * Pinned facts (company | department:<id> | project:<slug>)
 *   GET  /api/memory/scopes/pinned?scope=          -> { scope, facts }
 *   POST /api/memory/scopes/pinned                 { scope, text } -> 201 { fact }
 *   PATCH /api/memory/scopes/pinned/:id            { text?, position? } -> { fact }
 *   DELETE /api/memory/scopes/pinned/:id           -> { ok: true }
 * Project lifecycle (pin | unpin | archive | unarchive | move | merge | forget)
 *   POST /api/memory/scopes/projects/:slug/preview { action, target?, departmentId? } -> { action, project, target?, department?, effects, previewHash }
 *   POST /api/memory/scopes/projects/:slug/apply   { action, target?, departmentId?, expectedPreviewHash, confirm: true } -> { action, project, effects, result }
 *   GET  /api/memory/scopes/projects/:slug/export  -> { project, files: [{ name, content }] }
 * Access by inheritance
 *   GET  /api/memory/access                        -> { version, rules, templates }
 *   POST /api/memory/access/preview                { changes } -> { previewHash, version, agentsAffected, projectsAffected, ... }
 *   POST /api/memory/access/apply                  { changes, expectedPreviewHash, confirm: true } -> { version, preview }
 *   GET  /api/memory/access/effective/:agentId?project= -> effective access per drawer kind + why
 *
 * Errors: 400 { error, code } (invalid_scope, preview_hash_required, confirm_required),
 * 404 not_found, 409 (preview_changed, name_taken, no_change, too_many, target_archived).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { repositories } from '../../repositories/index.js';
import type { Actor } from '../../repositories/actor.js';
import { requestMeta } from '../../repositories/audit.js';
import { actorOrReply, requireOwner } from '../../repositories/scope.js';
import { resolveFileAgent } from '../../memory/memory-files.js';
import {
  ScopeInputError, accessOverview, addPinnedFact, applyAccessChanges, applyProjectAction, createDepartment, deleteDepartment, effectiveAccess,
  exploreScope, exportProject, invalidateScopeTree, listAgentScopes, listPinnedFacts, parseActionInput, parsePinnedScope, pinnedScopeId,
  previewAccessChanges, previewDeleteDepartment, previewProjectAction, removePinnedFact, renameDepartment, scopeTree, searchScopes, updatePinnedFact,
} from '../../memory/scopes/index.js';

function ownerOf(request: FastifyRequest, reply: FastifyReply): Actor | null {
  return actorOrReply(reply, actorOf(request), requireOwner);
}

const q = (request: FastifyRequest): Record<string, unknown> => {
  const v = request.query;
  return v && typeof v === 'object' ? v as Record<string, unknown> : {};
};

function body(request: FastifyRequest): Record<string, unknown> {
  const b = request.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw new ScopeInputError('Body must be a JSON object');
  return b as Record<string, unknown>;
}

function send(reply: FastifyReply, err: unknown) {
  if (err instanceof ScopeInputError) return reply.code(err.status).send({ error: err.message, code: err.code });
  throw err;
}

function audit(request: FastifyRequest, owner: Actor, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown>, success = true) {
  void repositories.audit.record(owner, {
    event_type: 'data.update', event_category: 'data_modification', severity: success ? 'info' : 'warning',
    resource_type: resourceType, resource_id: resourceId, action, success, metadata,
  }, requestMeta(request));
}

function requireConfirm(b: Record<string, unknown>): void {
  if (b.confirm !== true) throw new ScopeInputError('Confirm the change (confirm: true)', 400, 'confirm_required');
}

export async function memoryScopeRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };
  type Handler = (owner: Actor, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  const route = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, handler: Handler) => fastify.route({
    method, url, config,
    handler: async (request, reply) => {
      const owner = ownerOf(request, reply);
      if (owner === null) return reply;
      try { return await handler(owner, request, reply); } catch (err) { return send(reply, err); }
    },
  });

  // ---- tree, search, agents, explorer ----
  route('GET', '/api/memory/scopes/tree', async (owner, request) => {
    const fresh = q(request).fresh;
    return scopeTree(owner.userId!, { fresh: fresh === '1' || fresh === 'true' });
  });
  route('GET', '/api/memory/scopes/search', async (owner, request) => {
    const x = q(request);
    return { hits: await searchScopes(owner.userId!, x.q, x.kinds, x.limit) };
  });
  route('GET', '/api/memory/scopes/agents', async (owner, request) => listAgentScopes(owner.userId!, q(request)));
  route('GET', '/api/memory/scopes/memories', async (owner, request) => exploreScope(owner.userId!, q(request)));

  // ---- departments ----
  route('POST', '/api/memory/scopes/departments', async (owner, request, reply) => {
    const department = await createDepartment(owner.userId!, body(request).name, owner.userId!);
    invalidateScopeTree(owner.userId!);
    audit(request, owner, 'memory_scope.department_create', 'memory_department', department.id, { name: department.name });
    return reply.code(201).send({ department });
  });
  route('PATCH', '/api/memory/scopes/departments/:id', async (owner, request) => {
    const id = (request.params as { id: string }).id;
    const department = await renameDepartment(owner.userId!, id, body(request).name);
    invalidateScopeTree(owner.userId!);
    audit(request, owner, 'memory_scope.department_rename', 'memory_department', id, { name: department.name });
    return { department };
  });
  route('POST', '/api/memory/scopes/departments/:id/delete-preview', async (owner, request) => previewDeleteDepartment(owner.userId!, (request.params as { id: string }).id));
  route('POST', '/api/memory/scopes/departments/:id/delete', async (owner, request) => {
    const id = (request.params as { id: string }).id;
    const b = body(request);
    requireConfirm(b);
    const out = await deleteDepartment(owner.userId!, id, b.expectedPreviewHash);
    audit(request, owner, 'memory_scope.department_delete', 'memory_department', id, { name: out.department.name, effects: out.effects });
    return { department: out.department, effects: out.effects };
  });

  // ---- pinned facts ----
  route('GET', '/api/memory/scopes/pinned', async (owner, request) => {
    const scope = parsePinnedScope(q(request).scope ?? 'company');
    return { scope: pinnedScopeId(scope), facts: await listPinnedFacts(owner.userId!, scope) };
  });
  route('POST', '/api/memory/scopes/pinned', async (owner, request, reply) => {
    const b = body(request);
    const fact = await addPinnedFact(owner.userId!, parsePinnedScope(b.scope), b.text, owner.userId!);
    invalidateScopeTree(owner.userId!);
    audit(request, owner, 'memory_scope.pinned_add', 'memory_pinned_fact', fact.id, { scope: fact.scope, chars: fact.text.length });
    return reply.code(201).send({ fact });
  });
  route('PATCH', '/api/memory/scopes/pinned/:id', async (owner, request) => {
    const id = (request.params as { id: string }).id;
    const b = body(request);
    const fact = await updatePinnedFact(owner.userId!, id, { text: b.text, position: b.position });
    audit(request, owner, 'memory_scope.pinned_update', 'memory_pinned_fact', id, { scope: fact.scope, chars: fact.text.length });
    return { fact };
  });
  route('DELETE', '/api/memory/scopes/pinned/:id', async (owner, request, reply) => {
    const id = (request.params as { id: string }).id;
    const fact = await removePinnedFact(owner.userId!, id);
    if (!fact) return reply.code(404).send({ error: 'Pinned fact not found', code: 'not_found' });
    invalidateScopeTree(owner.userId!);
    audit(request, owner, 'memory_scope.pinned_remove', 'memory_pinned_fact', id, { scope: fact.scope });
    return { ok: true };
  });

  // ---- project lifecycle ----
  route('POST', '/api/memory/scopes/projects/:slug/preview', async (owner, request) =>
    previewProjectAction(owner.userId!, (request.params as { slug: string }).slug, parseActionInput(body(request))));
  route('POST', '/api/memory/scopes/projects/:slug/apply', async (owner, request) => {
    const slug = (request.params as { slug: string }).slug;
    const b = body(request);
    const input = parseActionInput(b);
    requireConfirm(b);
    const agent = await resolveFileAgent().catch(() => '(none)');
    try {
      const { preview, result } = await applyProjectAction(owner.userId!, slug, input, b.expectedPreviewHash, owner.userId!, agent);
      audit(request, owner, `memory_scope.project_${input.action}`, 'memory_project', slug, { effects: preview.effects, result: { ...result, conflictReviews: undefined } });
      return { action: input.action, project: preview.project, effects: preview.effects, result };
    } catch (err) {
      if (err instanceof ScopeInputError && err.status === 409) audit(request, owner, `memory_scope.project_${input.action}`, 'memory_project', slug, { code: err.code }, false);
      throw err;
    }
  });
  route('GET', '/api/memory/scopes/projects/:slug/export', async (owner, request) => {
    const slug = (request.params as { slug: string }).slug;
    const out = await exportProject(owner.userId!, slug);
    audit(request, owner, 'memory_scope.project_export', 'memory_project', slug, { files: out.files.map((f) => f.name) });
    return out;
  });

  // ---- access by inheritance ----
  route('GET', '/api/memory/access', async (owner) => accessOverview(owner.userId!));
  route('POST', '/api/memory/access/preview', async (owner, request) => previewAccessChanges(owner.userId!, body(request).changes, owner.userId!));
  route('POST', '/api/memory/access/apply', async (owner, request) => {
    const b = body(request);
    requireConfirm(b);
    try {
      const out = await applyAccessChanges(owner.userId!, b.changes, b.expectedPreviewHash, owner.userId!);
      invalidateScopeTree(owner.userId!);
      const { sample: _sample, ...counts } = out.preview;
      audit(request, owner, 'memory_access.apply', 'memory_access', owner.userId!, { changes: b.changes, counts, version: out.version });
      return out;
    } catch (err) {
      if (err instanceof ScopeInputError && err.status === 409) audit(request, owner, 'memory_access.apply', 'memory_access', owner.userId!, { code: err.code }, false);
      throw err;
    }
  });
  route('GET', '/api/memory/access/effective/:agentId', async (owner, request, reply) => {
    const project = q(request).project;
    const out = await effectiveAccess(owner.userId!, (request.params as { agentId: string }).agentId, typeof project === 'string' && project ? project : null);
    if (!out) return reply.code(404).send({ error: 'Agent not found', code: 'not_found' });
    return out;
  });
}
