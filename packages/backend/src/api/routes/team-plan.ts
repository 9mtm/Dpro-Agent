import {teamResources} from '../../services/team-resources.js';
import { COMPANY_SPECIALTIES } from '../../services/company-specialties.js';
/**
 * Company setup: team catalogue and team proposal (ONBOARD-TEAM-01). Owner
 * only (auth gate owner tier + handler check). Both routes only read: the plan
 * proposes names without reserving them, and nothing is created here. The UI
 * hires each reviewed proposal with POST /api/agents.
 *
 *   GET  /api/onboarding/team-catalogue  -> { sizes: [{id,label}], departments: [{id,label,summary}], maxDepartments, maxCustomDepartments }
 *   POST /api/onboarding/team-plan       { size, departments: string[], language? }
 *                                        -> { size, language, hires: [{department, departmentLabel, role, title, description, preset, name}] }
 *                                        400 { error, code: 'invalid_plan' }
 *
 * ONBOARD-TEAM-02 (total headcount + batch hire):
 *   POST /api/onboarding/team-distribution { departments, total? , counts?: {dep: n} }
 *        -> { total, departments: [{department, departmentLabel, count, roles, titles, presets}] }  (reads nothing)
 *   POST /api/onboarding/team-batches      { id, language?, departments: [{department, count, presets?}] }
 *        -> 201 new / 200 same plan again: { created, batch: progress }; 409 batch_conflict
 *   GET  /api/onboarding/team-batches      -> { batches: progress[] }  the owner's unfinished batches
 *   GET  /api/onboarding/team-batches/:id  -> { batch: progress }
 *   POST /api/onboarding/team-batches/:id/run { max?: 1-50, retryFailed?: boolean }
 *        -> { results: [{seq, status, agentId?, name?, code?}], batch: progress }
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import {
  COMPANY_SIZES, COMPANY_SIZE_LABELS, CompanyPlanInputError, DEPARTMENTS, MAX_CUSTOM_DEPARTMENTS, MAX_DEPARTMENTS, MAX_TOTAL_HEADCOUNT,
  planCompany, planDistribution,
} from '../../services/company-plan.js';
import { TeamBatchError, batchStatus, createBatch, openBatches, runBatch } from '../../services/team-batch.js';
import { PRESETS } from '../../services/personality.js';

const OWNER_ONLY = ['owner'] as const;
const owner = (request: FastifyRequest, reply: FastifyReply) => authorizeActiveRole(request, reply, OWNER_ONLY);

export async function teamPlanRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };

  fastify.post('/api/onboarding/team-resources',{config,bodyLimit:60000},async(request,reply)=>{
    if(owner(request,reply)===null)return reply;
    try{if(!request.body||typeof request.body!=='object'||Array.isArray(request.body))throw new CompanyPlanInputError('Invalid plan');return await teamResources(request.body as Record<string,unknown>);}catch(err){if(err instanceof CompanyPlanInputError)return reply.code(400).send({code:'invalid_plan'});return reply.code(503).send({code:'resources_unavailable'});}
  });
  fastify.get('/api/onboarding/team-catalogue', { config }, async (request, reply) => {
    if (owner(request, reply) === null) return reply;
    return {
      sizes: COMPANY_SIZES.map((id) => ({ id, label: COMPANY_SIZE_LABELS[id] })),
      departments: DEPARTMENTS.map(({ id, label, summary }) => ({ id, label, summary })),
      specialties: COMPANY_SPECIALTIES,
      maxDepartments: MAX_DEPARTMENTS,
      maxCustomDepartments: MAX_CUSTOM_DEPARTMENTS,
      maxTotal: MAX_TOTAL_HEADCOUNT,
      personas: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label })),
    };
  });

  fastify.post<{ Body: unknown }>('/api/onboarding/team-plan', { config }, async (request, reply) => {
    if (owner(request, reply) === null) return reply;
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ error: 'Invalid body', code: 'invalid_plan' });
    const unknown = Object.keys(body).find((k) => !['size', 'departments', 'language'].includes(k));
    if (unknown) return reply.code(400).send({ error: `Unknown field "${unknown.slice(0, 40)}"`, code: 'invalid_plan' });
    try {
      return await planCompany(body as Record<string, unknown>);
    } catch (err) {
      if (err instanceof CompanyPlanInputError) return reply.code(400).send({ error: err.message, code: 'invalid_plan' });
      throw err;
    }
  });

  const onlyKeys = (body: unknown, keys: readonly string[], reply: FastifyReply): Record<string, unknown> | null => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) { reply.code(400).send({ error: 'Invalid body', code: 'invalid_plan' }); return null; }
    const unknown = Object.keys(body).find((k) => !keys.includes(k));
    if (unknown) { reply.code(400).send({ error: `Unknown field "${unknown.slice(0, 40)}"`, code: 'invalid_plan' }); return null; }
    return body as Record<string, unknown>;
  };
  const failure = (err: unknown, reply: FastifyReply) => {
    if (err instanceof CompanyPlanInputError) return reply.code(400).send({ error: err.message, code: 'invalid_plan' });
    if (err instanceof TeamBatchError) return reply.code(err.status).send({ error: err.message, code: err.code });
    throw err;
  };

  fastify.post<{ Body: unknown }>('/api/onboarding/team-distribution', { config }, async (request, reply) => {
    if (owner(request, reply) === null) return reply;
    const body = onlyKeys(request.body, ['departments', 'total', 'counts'], reply);
    if (!body) return reply;
    try { return planDistribution(body); } catch (err) { return failure(err, reply); }
  });

  fastify.post<{ Body: unknown }>('/api/onboarding/team-batches', { config }, async (request, reply) => {
    const ownerId = owner(request, reply);
    if (ownerId === null) return reply;
    const body = onlyKeys(request.body, ['id', 'language', 'departments'], reply);
    if (!body) return reply;
    try {
      const { created, progress } = await createBatch(ownerId, body);
      return reply.code(created ? 201 : 200).send({ created, batch: progress });
    } catch (err) { return failure(err, reply); }
  });

  fastify.get('/api/onboarding/team-batches', { config }, async (request, reply) => {
    const ownerId = owner(request, reply);
    if (ownerId === null) return reply;
    return { batches: await openBatches(ownerId) };
  });

  fastify.get<{ Params: { id: string } }>('/api/onboarding/team-batches/:id', { config }, async (request, reply) => {
    const ownerId = owner(request, reply);
    if (ownerId === null) return reply;
    const batch = await batchStatus(String(request.params.id).slice(0, 64), ownerId);
    if (!batch) return reply.code(404).send({ error: 'Batch not found', code: 'batch_not_found' });
    return { batch };
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>('/api/onboarding/team-batches/:id/run', { config }, async (request, reply) => {
    const ownerId = owner(request, reply);
    if (ownerId === null) return reply;
    const body = request.body === undefined || request.body === null ? {} : onlyKeys(request.body, ['max', 'retryFailed'], reply);
    if (!body) return reply;
    try {
      const { results, progress } = await runBatch(ownerId, String(request.params.id).slice(0, 64), body);
      return { results, batch: progress };
    } catch (err) { return failure(err, reply); }
  });
}
