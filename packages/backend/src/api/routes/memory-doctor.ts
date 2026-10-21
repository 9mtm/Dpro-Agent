/**
 * Memory doctor API (CORE-MEM-DOCTOR). Owner only (auth gate owner tier for
 * /api/memory/doctor*, route access 'owner', repository owner rule). Acts on
 * the owner's own memory; reports carry ids and counts, never memory text.
 *
 *   GET  /api/memory/doctor        read-only health check (+ reportHash)
 *   POST /api/memory/doctor/fix    { confirm: true, expectedReportHash, kinds? }
 *                                  safe fixes of the reviewed report (audited);
 *                                  without confirm nothing changes (400
 *                                  `confirm_required`); a changed memory -> 409
 *                                  `report_changed`
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { repositories } from '../../repositories/index.js';
import type { Actor } from '../../repositories/actor.js';
import { actorOrReply, requireOwner, sendScopeError } from '../../repositories/scope.js';
import { DoctorError } from '../../memory/doctor.js';
import { logAudit } from '../../services/audit-logger.js';

function body(request: FastifyRequest): Record<string, unknown> {
  const b = request.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {};
}

/** The owner account's actor (central rule), else 401/403 sent and null. */
function ownerOf(request: FastifyRequest, reply: FastifyReply): Actor | null {
  return actorOrReply(reply, actorOf(request), requireOwner);
}

export async function memoryDoctorRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const };

  fastify.get('/api/memory/doctor', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply);
    if (owner === null) return reply;
    try {
      return await repositories.memory.doctorCheck(owner);
    } catch (err) { return sendScopeError(reply, err); }
  });

  fastify.post('/api/memory/doctor/fix', { config }, async (request, reply) => {
    const owner = ownerOf(request, reply);
    if (owner === null) return reply;
    const b = body(request);
    try {
      const result = await repositories.memory.doctorFix(owner, { confirm: b.confirm, expectedReportHash: b.expectedReportHash, kinds: b.kinds });
      logAudit({
        event_type: 'data.update', event_category: 'data_modification', severity: 'info',
        user_id: owner.userId, ip_address: request.ip, user_agent: request.headers['user-agent'],
        request_method: request.method, request_path: request.routeOptions?.url ?? undefined,
        resource_type: 'memory', action: 'memory_doctor.fix', success: true, metadata: { fixed: result.fixed, skipped: result.skipped.length },
      });
      return result;
    } catch (err) {
      if (err instanceof DoctorError) return reply.code(err.status).send({ error: err.message, code: err.code });
      return sendScopeError(reply, err);
    }
  });
}
