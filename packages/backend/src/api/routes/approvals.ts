import {ReviewerQuorumError} from '../../auth/verification/reviewer-quorum.js';
import {createHash} from 'node:crypto';
import {verifyRequestTokenAsync,AuthTokenError} from '../../auth/jwt.js';
import {sql,one} from '../../repositories/sql-steps.js';
import {issueApprovalProofChallenge,completeApprovalProofChallenge} from '../../auth/verification/approval-proof.js';
import {VerificationChallengeLimitError} from '../../auth/verification/challenges.js';
import {changePasswordRateLimit} from '../rate-limit-config.js';
/**
 * Tool approvals API (S1.3). Owner only: the auth gate's tier rule for
 * /api/approvals is 'owner', each route declares access 'owner', and the
 * handlers check the role again.
 *
 *   GET  /api/approvals?status=pending   list (masked parameter previews)
 *   GET  /api/approvals/:id              full view: exact parameters (secrets masked) + paramsHash
 *   POST /api/approvals/:id/approve      { paramsHash } approve once: runs exactly those parameters
 *   POST /api/approvals/:id/deny         deny: it never runs
 *
 * BE-UI-01: every approval carries `expiresAt` (requestedAt + 24 h, after
 * which the server marks it expired) and all timestamps (requestedAt,
 * decidedAt, executedAt, expiresAt) are ISO-8601 UTC with `Z`. Use the HTTP
 * `Date` response header for clock drift.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ApprovalStateError,
  ApprovalVerificationRequiredError,
  approveAndRun,
  denyApproval,
  getApprovalDetail,
  listApprovals,
  APPROVAL_TTL_HOURS,
} from '../../tools/approvals.js';
import { isoPlusHours, isoUtc } from '../timestamps.js';

/** API view of an approval record: ISO UTC timestamps + absolute expiresAt. */
function view<T extends { requestedAt: string; decidedAt: string | null; executedAt: string | null }>(r: T): T & { expiresAt: string | null } {
  return {
    ...r,
    requestedAt: isoUtc(r.requestedAt) as string,
    decidedAt: isoUtc(r.decidedAt),
    executedAt: isoUtc(r.executedAt),
    expiresAt: isoPlusHours(r.requestedAt, APPROVAL_TTL_HOURS),
  };
}
import { logAudit } from '../../services/audit-logger.js';

const STATUSES = new Set(['pending', 'approved', 'denied', 'executed', 'failed', 'expired']);
const ID = /^[0-9a-f-]{36}$/i;

function ownerOf(request: FastifyRequest, reply: FastifyReply): string | null {
  const user = request.authUser;
  if (!user) { reply.code(401).send({ error: 'Authentication required' }); return null; }
  if (user.role !== 'owner') { reply.code(403).send({ error: 'This action requires the owner account' }); return null; }
  return user.id;
}

function audit(request: FastifyRequest, ownerId: string, action: string, approvalId: string, success: boolean, metadata: Record<string, unknown>) {
  logAudit({
    event_type: 'data.update',
    event_category: 'data_modification',
    severity: action === 'approve' ? 'warning' : 'info',
    user_id: ownerId,
    ip_address: request.ip,
    user_agent: request.headers['user-agent'],
    request_method: request.method,
    request_path: request.routeOptions?.url ?? undefined,
    resource_type: 'tool_approval',
    resource_id: approvalId,
    action: `tool_approval.${action}`,
    success,
    metadata,
  });
}

async function proofContext(request:FastifyRequest){
 if(request.actor&&request.actor.kind!=='user')throw new AuthTokenError('Unauthorized: Human account required');
 const verified=await verifyRequestTokenAsync(request);
 if(verified.user.role!=='owner'||(request.actor&&request.actor.userId!==verified.userId))throw new AuthTokenError('Unauthorized: Owner required');
 const factor=await sql().read(one<{version:number;enabled:number}>('SELECT version,enabled FROM verification_factors WHERE user_id=?',verified.userId));
 if(!factor||Number(factor.enabled)!==1)throw Error('Verification unavailable');
 return {userId:verified.userId,sessionHash:createHash('sha256').update(request.headers.authorization!.slice(7)).digest('hex'),tokenVersion:Number(verified.user.token_version||1),factorVersion:Number(factor.version)};
}
function proofError(reply:FastifyReply,error:unknown){
 if(error instanceof AuthTokenError)return reply.code(401).send({code:'unauthenticated'});
 if(error instanceof VerificationChallengeLimitError)return reply.header('Retry-After','300').code(429).send({code:'rate_limited'});
 return reply.code(409).send({code:'verification_refused'});
}
export async function approvalsRoutes(fastify: FastifyInstance) {
  const config = { access: 'owner' as const }; // read by the auth gate (route may only raise its level)
  for(const complete of [false,true]){
    const fields=complete?['paramsHash','challenge','code']:['paramsHash'];
    fastify.post<{Params:{id:string};Body:{paramsHash:string;challenge?:string;code?:string}}>('/api/approvals/:id/verification'+(complete?'/complete':''),{
      config:{...config,rateLimit:changePasswordRateLimit},
      preValidation:async(request,reply)=>{
        const body=request.body;
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(request.query as object).length||Object.keys(body).length!==fields.length||!fields.every(field=>Object.hasOwn(body,field)))return reply.code(400).send({code:'verification_refused'});
      },schema:{body:{type:'object',additionalProperties:false,required:fields,properties:{paramsHash:{type:'string',pattern:'^[a-f0-9]{64}$'},...(complete?{challenge:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'},code:{type:'string',pattern:'^[0-9]{6}$'}}:{})}}}
    },async(request,reply)=>{
      reply.header('Cache-Control','no-store');
      if(ownerOf(request,reply)===null)return reply;
      try{
        const context=await proofContext(request);
        if(!complete){const issued=await issueApprovalProofChallenge(context,request.params.id,request.body.paramsHash);return {challenge:issued.token,expiresAt:issued.expiresAt};}
        const result=await completeApprovalProofChallenge(request.body.challenge,context,request.params.id,request.body.paramsHash,request.body.code);
        return result??reply.code(403).send({code:'verification_refused'});
      }catch(error){return proofError(reply,error);}
    });
  }


  fastify.get<{ Querystring: { status?: string; limit?: string } }>('/api/approvals', { config }, async (request, reply) => {
    if (ownerOf(request, reply) === null) return reply;
    const status = request.query?.status;
    if (status !== undefined && !STATUSES.has(status)) return reply.code(400).send({ error: 'Invalid status' });
    return { approvals: (await listApprovals({ status, limit: Number(request.query?.limit) || undefined })).map(view) };
  });

  fastify.get<{ Params: { id: string } }>('/api/approvals/:id', { config }, async (request, reply) => {
    const ownerId=ownerOf(request,reply);
    if (ownerId===null) return reply;
    if (!ID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid id' });
    const record = await getApprovalDetail(request.params.id);
    if (!record) return reply.code(404).send({ error: 'Approval not found' });
    const factor=await sql().read(one<{enabled:number}>('SELECT enabled FROM verification_factors WHERE user_id=?',ownerId));
    reply.header('Cache-Control','no-store');
    return { approval: {...view(record),verificationRequired:!!factor&&Number(factor.enabled)===1} };
  });

  fastify.post<{ Params: { id: string }; Body: { paramsHash?: string;verificationReceipt?:string } }>('/api/approvals/:id/approve', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    if (!ID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid id' });
    const body=request.body;
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['paramsHash','verificationReceipt'].includes(key))||(Object.hasOwn(body,'verificationReceipt')&&(typeof body.verificationReceipt!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.verificationReceipt))))return reply.code(400).send({code:'verification_refused'});
    const paramsHash = body.paramsHash;
    if (typeof paramsHash !== 'string' || !/^[0-9a-f]{64}$/.test(paramsHash)) {
      return reply.code(400).send({ error: 'paramsHash from GET /api/approvals/:id is required' });
    }
    try {
      const proof=body.verificationReceipt!==undefined?{receipt:body.verificationReceipt,context:await proofContext(request)}:undefined;
      const { record, result } = await approveAndRun(request.params.id, ownerId, paramsHash,proof);
      audit(request, ownerId, 'approve', record.id, record.status === 'executed', { tool: record.toolName, agentId: record.agentId, status: record.status });
      return { approval: view(record), result: { ok: !result.error, preview: record.resultPreview, error: record.error } };
    } catch (err: any) {
      if(err instanceof ReviewerQuorumError)return reply.code(403).send({code:err.code});
      if (err instanceof ApprovalVerificationRequiredError)return reply.code(403).send({code:'verification_required'});
      if (err instanceof ApprovalStateError) return reply.code(err.status).send({ error: err.message });
      if(body.verificationReceipt!==undefined)return proofError(reply,err);
      throw err;
    }
  });

  fastify.post<{ Params: { id: string } }>('/api/approvals/:id/deny', { config }, async (request, reply) => {
    const ownerId = ownerOf(request, reply);
    if (ownerId === null) return reply;
    if (!ID.test(request.params.id)) return reply.code(400).send({ error: 'Invalid id' });
    try {
      const record = await denyApproval(request.params.id, ownerId);
      audit(request, ownerId, 'deny', record.id, true, { tool: record.toolName, agentId: record.agentId });
      return { approval: view(record) };
    } catch (err: any) {
      if (err instanceof ApprovalStateError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });
}
