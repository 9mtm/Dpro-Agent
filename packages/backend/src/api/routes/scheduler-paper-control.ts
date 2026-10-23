/** Explicit per-server paper scheduling only; no default dependency or global engine adoption. */
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type Database from 'better-sqlite3';
import {getDatabase} from '../../db/index.js';
import {dbDriver} from '../../db/pg/config.js';
import {backgroundEnabled} from '../../config/background.js';
import {AuthTokenError} from '../../auth/jwt.js';
import {reviewerRequestIdentity,ReviewerIdentityError} from '../../auth/verification/reviewer-request.js';
import {paperScheduleOwnerRequestIdentity} from '../../auth/verification/paper-schedule-request.js';
import {enablePaperSchedule,disablePaperSchedule,readPaperScheduleControl,readPaperScheduleControlInTransaction} from '../../scheduler/paper-controls.js';
import {readTrustedPaperRuntimeConsentInTransaction} from '../../services/trading-paper-runtime-consent.js';
import {OwnedPaperCronEngine} from '../../scheduler/engine.js';
import {logAudit} from '../../services/audit-logger.js';
import {changePasswordRateLimit} from '../rate-limit-config.js';
const invalid=Object.freeze({code:'invalid_paper_schedule_control'}),unavailable=Object.freeze({code:'paper_schedule_control_unavailable',available:false});
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
const revision=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=1&&v<=2147483647;
function exact(v:unknown,keys:string[]):v is Record<string,unknown>{if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return false;const own=Reflect.ownKeys(v);return own.length===keys.length&&own.every(k=>typeof k==='string'&&keys.includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value'));}
const limit=(suffix:string,max:number)=>({...changePasswordRateLimit,max,timeWindow:'1 minute',keyGenerator:(r:FastifyRequest)=>changePasswordRateLimit.keyGenerator(r).replace('change-password-user:','paper-schedule-'+suffix+'-user:'),errorResponseBuilder:()=>({statusCode:429,code:'rate_limited',error:'Too many paper schedule requests'})});
function refused(reply:FastifyReply,error:unknown,stateMayHaveChanged=false){const extra=stateMayHaveChanged?{stateMayHaveChanged:true}:{};if(error instanceof AuthTokenError)return reply.code(401).send({code:'unauthenticated',...extra});if(error instanceof ReviewerIdentityError)return reply.code(403).send({code:'owner_verification_required',...extra});return reply.code(503).send({...unavailable,...extra});}
/** Dependency is copied once. This plugin never calls or mutates the default CronEngine singleton. */
export async function schedulerPaperControlRoutes(app:FastifyInstance,options:{ledger:Database.Database|null}){
 const ledger=options.ledger,engine=ledger?new OwnedPaperCronEngine(ledger):null;let closed=false,epoch=0,starting=false;
 function database(){if(closed||!ledger||!ledger.open||dbDriver()!=='sqlite'||getDatabase().getDb()!==ledger)throw Error('Unavailable');return ledger;}
 app.addHook('onSend',async(_request,reply,payload)=>{reply.header('Cache-Control','no-store');return payload;});
 app.addHook('onReady',async()=>{
  const generation=epoch;if(closed)return;try{database();starting=true;await engine!.start();if(closed||generation!==epoch)await engine!.stop();}catch{/* Explicit unavailable dependency never prevents unrelated server routes from starting. */}finally{starting=false;}
 });
 app.addHook('onClose',async()=>{closed=true;++epoch;if(engine&&(starting||engine.isStarted()))await engine.stop();});
 function observed(jobId:string,control:ReturnType<typeof readPaperScheduleControl>,ownerId:string,now:number){
  const status=engine?.getPaperStatus(jobId),registered=engine?.getPaperRegistration(jobId),valid=control.ok&&control.authorization==='authorized';
  const current=!!(valid&&registered&&registered.consentId===control.consentId&&registered.jobRevision===('jobRevision' in control?control.jobRevision:null)&&registered.authorizationRevision===('authorizationRevision' in control?control.authorizationRevision:null)&&registered.definitionHash===('definitionHash' in control?control.definitionHash:null));
  const observation=Object.freeze({scope:'this_server' as const,started:engine?.isStarted()??false,registered:status?.registered??false,phase:status?.phase??'unavailable',callbackAt:status?.callbackAt??null,attemptId:status?.attemptId??null,replayed:status?.replayed??null,registrationCurrent:current});
  let dispatch:Readonly<{state:'unavailable'|'pending'|'unknown'|'cadence'|'exhausted'|'ready';attemptCount?:number;maxAttempts?:number}>=Object.freeze({state:'unavailable'});
  if(control.ok&&ledger?.open)try{
    const snapshot=readTrustedPaperRuntimeConsentInTransaction(ledger,control.consentId,now);
    if(snapshot.ownerId!==ownerId)throw Error('Unavailable');
    const journal=snapshot.journal,limits=snapshot.definition.limits;
    const state=snapshot.status!=='granted'||now>=limits.expiresAt?'unavailable':journal.blockedByUnknown?'unknown':journal.attempts.some(a=>a.status==='pending')?'pending':journal.attemptCount>=limits.maxAttempts?'exhausted':journal.lastClaimAt!==null&&now<journal.lastClaimAt+limits.cadenceMs?'cadence':'ready';
    dispatch=Object.freeze({state,attemptCount:journal.attemptCount,maxAttempts:limits.maxAttempts});
  }catch{/* An unavailable journal never becomes execution availability. */}
  const available=!!(control.ok&&control.savedEnabled&&valid&&current&&dispatch.state==='ready'&&observation.registered&&observation.started&&!['unavailable','pending','unknown'].includes(observation.phase)&&backgroundEnabled()&&ledger?.open&&ledger.pragma('query_only',{simple:true})===0);
  return {engine:observation,dispatch,available};
 }
 function status(db:Database.Database,identity:Awaited<ReturnType<typeof paperScheduleOwnerRequestIdentity>>,id:string){
  return db.transaction(()=>{const now=Date.now(),control=readPaperScheduleControlInTransaction(db,identity.context,identity.actor,{jobId:id},now);return {control,...observed(id,control,identity.context.userId,now)};}).deferred();
 }
 function audit(request:FastifyRequest,id:string,action:'enable'|'disable',ownerId:string,success:boolean,registered:boolean,stateMayHaveChanged=false){logAudit({event_type:'system.config.change',event_category:'system',severity:success?'info':'warning',user_id:ownerId,request_method:request.method,request_path:request.routeOptions.url,resource_type:'paper_schedule',resource_id:id,action:'paper_schedule.'+action,success,metadata:{registered,scope:'this_server',...(stateMayHaveChanged?{stateMayHaveChanged:true}:{})}});}
 const base='/api/scheduler/jobs/:id/paper-control';
 app.get(base,{config:{access:'owner',rateLimit:limit('read',100)}},async(request,reply)=>{
  try{
   const {id}=request.params as {id:string};if(!uuid(id)||Object.keys(request.query as object).length||request.body!==undefined)return reply.code(400).send(invalid);
   const identity=await paperScheduleOwnerRequestIdentity(request),db=database(),snapshot=status(db,identity,id);
   return snapshot.control.ok?{ok:true,...snapshot}:reply.code(404).send(unavailable);
  }catch(error){return refused(reply,error);}
 });
 app.post(base+'/enable',{config:{access:'owner',rateLimit:limit('enable',20)},bodyLimit:1024},async(request,reply)=>{
  let changed=false,ownerId:string|null=null,jobId:string|null=null;
  try{
   const {id}=request.params as {id:string},body=request.body;if(!uuid(id)||Object.keys(request.query as object).length||!exact(body,['jobRevision','authorizationRevision','definitionHash'])||!revision(body.jobRevision)||!revision(body.authorizationRevision)||!hash(body.definitionHash))return reply.code(400).send(invalid);
   const initial=await reviewerRequestIdentity(request,true);ownerId=initial.context.userId;jobId=id;const db=database(),result=enablePaperSchedule(db,initial.context,initial.actor,{jobId:id,...body});
   if(!result.ok){audit(request,id,'enable',initial.context.userId,false,false);return reply.code(409).send(unavailable);}changed=true;
   const current=await reviewerRequestIdentity(request,true);if(JSON.stringify(current.context)!==JSON.stringify(initial.context)||closed)throw new AuthTokenError('Unauthorized: Context changed');
   const registrationAccepted=engine?.registerOwnedPaperJob(id,{ownerId:current.context.userId,consentId:result.consentId,jobRevision:result.jobRevision,authorizationRevision:result.authorizationRevision,definitionHash:result.definitionHash})??false;
   const final=await reviewerRequestIdentity(request,true);if(JSON.stringify(final.context)!==JSON.stringify(initial.context)||closed)throw new AuthTokenError('Unauthorized: Context changed');
   const snapshot=status(db,final,id);if(!snapshot.control.ok)throw Error('Unavailable');const {control,...observation}=snapshot;audit(request,id,'enable',final.context.userId,true,observation.engine.registered);
   return {ok:true,action:'enable',replayed:result.replayed,applied:{savedEnabled:true,jobRevision:result.jobRevision,authorizationRevision:result.authorizationRevision,definitionHash:result.definitionHash},registrationAccepted,control,...observation};
  }catch(error){if(ownerId&&jobId)audit(request,jobId,'enable',ownerId,false,engine?.getPaperStatus(jobId)?.registered??false,changed);return refused(reply,error,changed);}
 });
 app.post(base+'/disable',{config:{access:'owner',rateLimit:limit('disable',1000)},bodyLimit:1024},async(request,reply)=>{
  let changed=false,ownerId:string|null=null,jobId:string|null=null;
  try{
   const {id}=request.params as {id:string};if(!uuid(id)||Object.keys(request.query as object).length||!exact(request.body,[]))return reply.code(400).send(invalid);
   const initial=await paperScheduleOwnerRequestIdentity(request);ownerId=initial.context.userId;jobId=id;const db=database(),result=disablePaperSchedule(db,initial.context,initial.actor,{jobId:id});
   if(!result.ok){audit(request,id,'disable',initial.context.userId,false,false);return reply.code(409).send(unavailable);}changed=true;engine?.unscheduleJob(id);
   const final=await paperScheduleOwnerRequestIdentity(request);if(final.context.userId!==initial.context.userId||final.context.sessionHash!==initial.context.sessionHash||final.context.tokenVersion!==initial.context.tokenVersion||closed)throw new AuthTokenError('Unauthorized: Context changed');
   const snapshot=status(db,final,id);if(!snapshot.control.ok)throw Error('Unavailable');const {control,...observation}=snapshot;audit(request,id,'disable',final.context.userId,true,observation.engine.registered);
   return {ok:true,action:'disable',replayed:result.replayed,control,...observation};
  }catch(error){if(ownerId&&jobId)audit(request,jobId,'disable',ownerId,false,engine?.getPaperStatus(jobId)?.registered??false,changed);return refused(reply,error,changed);}
 });
}
