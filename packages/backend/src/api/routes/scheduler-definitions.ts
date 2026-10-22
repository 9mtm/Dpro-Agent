import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {AuthTokenError,verifyRequestTokenAsync} from '../../auth/jwt.js';
import {readScheduledDefinition,saveScheduledDefinition,ScheduledDefinitionError} from '../../scheduler/definitions.js';
import {ScheduleDefinitionError} from '../../scheduler/authorization-definition.js';
import {getCronEngine} from '../../scheduler/engine.js';
import {changePasswordRateLimit} from '../rate-limit-config.js';
const invalid={error:'Invalid schedule definition',code:'invalid_schedule_definition'};
const unavailable={error:'Schedule definition unavailable',code:'schedule_definition_unavailable'};
async function owner(request:FastifyRequest){
 const verified=await verifyRequestTokenAsync(request),actor=request.actor;
 if(!actor||actor.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==verified.userId||verified.user.role!=='owner')throw new ScheduledDefinitionError('forbidden');
 return {actor,tokenVersion:Number(verified.user.token_version??1)};
}
function refused(reply:FastifyReply,error:unknown){
 if(error instanceof AuthTokenError)return reply.code(401).send({error:'Sign in required',code:'unauthenticated'});
 if(error instanceof ScheduleDefinitionError)return reply.code(400).send(invalid);
 if(error instanceof ScheduledDefinitionError)return reply.code(error.code==='invalid'?400:error.code==='forbidden'?403:409).send(error.code==='invalid'?invalid:error.code==='conflict'?{error:'Schedule changed. Reload before saving.',code:'schedule_definition_conflict'}:unavailable);
 return reply.code(503).send(unavailable);
}
/** Saving a definition is independent of authorization, enablement and execution. */
export async function schedulerDefinitionRoutes(app:FastifyInstance){
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','no-store');});
 app.get('/api/scheduler/definitions/:id',{config:{access:'owner'}},async(request,reply)=>{
  try{const identity=await owner(request),{id}=request.params as {id:string};if(Object.keys(request.query as object).length)return reply.code(400).send(invalid);const result=await readScheduledDefinition(identity.actor,identity.tokenVersion,id);return result??reply.code(404).send(unavailable);}catch(error){return refused(reply,error);}
 });
 app.put('/api/scheduler/definitions/:id',{config:{access:'owner',rateLimit:changePasswordRateLimit},bodyLimit:65536},async(request,reply)=>{
  try{
   const identity=await owner(request),{id}=request.params as {id:string},body=request.body as Record<string,unknown>;
   if(Object.keys(request.query as object).length||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==2||!Object.hasOwn(body,'expectedRevision')||!Object.hasOwn(body,'changes')||!Number.isInteger(body.expectedRevision))return reply.code(400).send(invalid);
   const result=await saveScheduledDefinition(identity.actor,identity.tokenVersion,id,body.expectedRevision as number,body.changes);
   getCronEngine().rememberPausedJob(result.job);
   return {jobId:id,revision:result.revision,enabled:false,definitionHash:result.definitionHash};
  }catch(error){return refused(reply,error);}
 });
}
