import type {FastifyInstance,FastifyReply} from 'fastify';
import {AuthTokenError} from '../../auth/jwt.js';
import {ReviewerIdentityError,reviewerRequestIdentity} from '../../auth/verification/reviewer-request.js';
import {VerificationChallengeLimitError} from '../../auth/verification/challenges.js';
import {scheduleRevocationOperationHash,type ScheduleRevocationOperation,scheduleAuthorizationOperationHash,type ScheduleAuthorizationOperation} from '../../auth/verification/operation-proof.js';
import {ScheduleDefinitionError} from '../../scheduler/authorization-definition.js';
import {ScheduleAuthorizationError,scheduledAuthorizationPreview,issueScheduledAuthorization,completeScheduledAuthorization,authorizeScheduledJob,assertScheduledDispatch,scheduledRevocationTarget,issueScheduledRevocation,completeScheduledRevocation,revokeScheduledAuthorization} from '../../scheduler/authorization.js';
import {sql,one} from '../../repositories/sql-steps.js';
import {dialect} from '../../repositories/sql-steps.js';
import {rowToJob,type CronJobRow} from '../../scheduler/store.js';
import {changePasswordRateLimit} from '../rate-limit-config.js';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const invalid={error:'Invalid schedule authorization request',code:'invalid_schedule_authorization'};
const unavailable={error:'Schedule authorization unavailable',code:'schedule_authorization_unavailable'};
function refused(reply:FastifyReply,error:unknown){
 if(error instanceof AuthTokenError)return reply.code(401).send({error:'Sign in required',code:'unauthenticated'});
 if(error instanceof ReviewerIdentityError)return reply.code(403).send({error:'Verified owner required',code:'owner_verification_required'});
 if(error instanceof VerificationChallengeLimitError)return reply.code(429).send({error:'Too many attempts',code:'rate_limited'});
 if(error instanceof ScheduleDefinitionError)return reply.code(400).send(invalid);
 if(error instanceof ScheduleAuthorizationError)return reply.code(error.code==='invalid'?400:error.code==='forbidden'||error.code==='proof_refused'?403:409).send(error.code==='invalid'?invalid:unavailable);
 return reply.code(503).send(unavailable);
}
/** Owner consent is separate from job enablement and execution. */
export async function schedulerAuthorizationRoutes(app:FastifyInstance){
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','no-store');});
 app.get('/api/scheduler/jobs/:id/authorization',{config:{access:'owner'}},async(request,reply)=>{
  try{
   await reviewerRequestIdentity(request,true);const {id}=request.params as {id:string};
   if(!uuid(id)||Object.keys(request.query as object).length)return reply.code(400).send(invalid);
   const job=await sql().read(one<CronJobRow>('SELECT * FROM cron_jobs WHERE id=?',id));
   if(!job)return reply.code(404).send(unavailable);
   const d=await sql().read(dialect()),current=rowToJob(d,job);
   if(current.actionType!=='api-call'&&current.actionType!=='send-message')return {jobId:id,status:'not_required'};
   let status:'authorized'|'authorization_required'='authorization_required';
   try{await assertScheduledDispatch(current,'manual');status='authorized';}catch(error){if(!(error instanceof ScheduleAuthorizationError)&&!(error instanceof ScheduleDefinitionError))throw error;}
   await reviewerRequestIdentity(request,true);
   return {jobId:id,status};
  }catch(error){return refused(reply,error);}
 });
 for(const action of ['authorize','revoke'] as const)for(const phase of ['preview','challenge','complete','apply'] as const){
  app.post('/api/scheduler/jobs/:id/authorization/'+(action==='revoke'?'revoke/':'')+phase,{config:{access:'owner',rateLimit:changePasswordRateLimit},bodyLimit:4096},async(request,reply)=>{
   try{
    const {context,actor}=await reviewerRequestIdentity(request,true),{id}=request.params as {id:string},body=request.body;
    const keys=phase==='preview'?(action==='revoke'?[]:['expiresAt']):phase==='challenge'?['operation']:phase==='complete'?['operation','challenge','code']:['operation','receipt'];
    if(!uuid(id)||Object.keys(request.query as object).length||!exact(body,keys))return reply.code(400).send(invalid);
    if(phase==='preview'){
     if(action==='revoke')return {operation:await scheduledRevocationTarget(context,actor,id)};
     if(!Number.isSafeInteger(body.expiresAt))return reply.code(400).send(invalid);
     return await scheduledAuthorizationPreview(context,actor,id,body.expiresAt as number);
    }
    const operation=body.operation as ScheduleAuthorizationOperation;
    try{if(action==='revoke')scheduleRevocationOperationHash(body.operation as ScheduleRevocationOperation);else scheduleAuthorizationOperationHash(operation);}catch{return reply.code(400).send(invalid);}
    if(operation.jobId!==id)return reply.code(400).send(invalid);
    if(phase==='challenge'){
     const result=action==='revoke'?await issueScheduledRevocation(context,actor,body.operation as ScheduleRevocationOperation):await issueScheduledAuthorization(context,actor,operation);return {challenge:result.token,expiresAt:result.expiresAt};
    }
    if(phase==='complete'){
     if(typeof body.challenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.challenge)||typeof body.code!=='string'||!/^[0-9]{6}$/.test(body.code))return reply.code(400).send(invalid);
     const result=action==='revoke'?await completeScheduledRevocation(body.challenge,context,actor,body.operation as ScheduleRevocationOperation,body.code):await completeScheduledAuthorization(body.challenge,context,actor,operation,body.code);
     return result?{receipt:result.receipt,expiresAt:result.expiresAt}:reply.code(403).send({error:'Verification refused',code:'verification_refused'});
    }
    if(typeof body.receipt!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.receipt))return reply.code(400).send(invalid);
    return action==='revoke'?await revokeScheduledAuthorization(body.receipt,context,actor,body.operation as ScheduleRevocationOperation):await authorizeScheduledJob(body.receipt,context,actor,operation);
   }catch(error){return refused(reply,error);}
  });
 }
}
