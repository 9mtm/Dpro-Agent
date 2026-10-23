/** Reviewed deterministic paper runtime consent only. No dispatch, timer, provider or trading endpoints. */
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type Database from 'better-sqlite3';
import {getDatabase} from '../../db/index.js';
import {dbDriver} from '../../db/pg/config.js';
import {isSystemAccount} from '../../auth/default-accounts.js';
import {AuthTokenError,verifyRequestTokenAsync} from '../../auth/jwt.js';
import {reviewerRequestIdentity,ReviewerIdentityError} from '../../auth/verification/reviewer-request.js';
import {changePasswordRateLimit} from '../rate-limit-config.js';
import {stagePaperRuntimeConsent,readPaperRuntimeReview,issuePaperRuntimeProof,completePaperRuntimeProof,applyPaperRuntimeConsent,readPaperRuntimeConsent,revokePaperRuntimeConsent,readPaperRuntimeConsentReference} from '../../services/trading-paper-runtime-consent.js';

const invalid={code:'invalid_paper_runtime_request'},unavailable={code:'paper_runtime_unavailable'};
const uint=(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
const uuid=(value:unknown):value is string=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const token=(value:unknown):value is string=>typeof value==='string'&&value.length===43&&/^[A-Za-z0-9_-]{43}$/.test(value);
const symbol=(value:unknown):value is string=>typeof value==='string'&&value.length<=128&&!/[\x00-\x20\x7f]/.test(value)&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
function exact(value:unknown,keys:string[]):value is Record<string,unknown>{
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
  &&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));
}
function stageInput(body:unknown,now:number):body is Record<string,unknown>{
 if(!exact(body,['botId','strategy','limits'])||!uuid(body.botId)||!exact(body.strategy,['kind','version','symbol','side','amount'])||!exact(body.limits,['expiresAt','maxAttempts','cadenceMs']))return false;
 const s=body.strategy,l=body.limits;
 return s.kind==='fixed-paper-order'&&s.version===1&&symbol(s.symbol)&&['buy','sell'].includes(s.side as string)&&uint(s.amount,1,1e12)
  &&uint(l.expiresAt,now+1,now+30*86400000)&&uint(l.maxAttempts,1,1000)&&uint(l.cadenceMs,1000,86400000);
}
const proofLimit={...changePasswordRateLimit,keyGenerator:(request:FastifyRequest)=>changePasswordRateLimit.keyGenerator(request).replace('change-password-user:','paper-runtime-proof-user:'),errorResponseBuilder:()=>({statusCode:429,code:'rate_limited',error:'Too many runtime consent verification attempts'})};
const readLimit={...proofLimit,max:100,timeWindow:'1 minute',keyGenerator:(request:FastifyRequest)=>changePasswordRateLimit.keyGenerator(request).replace('change-password-user:','paper-runtime-read-user:'),errorResponseBuilder:()=>({statusCode:429,code:'rate_limited',error:'Too many runtime consent reads'})};
const revokeLimit={...readLimit,max:1000,keyGenerator:(request:FastifyRequest)=>changePasswordRateLimit.keyGenerator(request).replace('change-password-user:','paper-runtime-revoke-user:'),errorResponseBuilder:()=>({statusCode:429,code:'rate_limited',error:'Too many runtime revocations'})};
function refuse(reply:FastifyReply,error:unknown){
 if(error instanceof AuthTokenError)return reply.code(401).send({code:'unauthenticated'});
 if(error instanceof ReviewerIdentityError)return reply.code(403).send({code:'owner_verification_required'});
 return reply.code(503).send(unavailable);
}
async function human(request:FastifyRequest){
 const verified=await verifyRequestTokenAsync(request),actor=request.actor;
 if(isSystemAccount(verified.userId)||!actor||actor.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==verified.userId||verified.user.role!=='owner')throw new ReviewerIdentityError();
}
/** Same optional main database as the reviewed installation; no lazy journal or business initialization. */
export async function tradingPaperRuntimeRoutes(app:FastifyInstance,options:{ledger:()=>Database.Database|null}){
 const base='/api/trading-paper/runtime';
 app.addHook('onSend',async(_request,reply,payload)=>{reply.header('Cache-Control','no-store');return payload;});
 function database(granting=false){
  const db=options.ledger();if(!db||dbDriver()!=='sqlite'||getDatabase().getDb()!==db)throw Error('Unavailable');
  const columns:Record<string,string>={
   paper_runtime_reviews:'id,owner_id,session_hash,token_version,factor_version,policy_version,definition_json,definition_hash,review_hash,created_at,expires_at,status',
   paper_runtime_consents:'id,review_id,owner_id,bot_id,definition_id,definition_digest,created_at,status',
   paper_runtime_events:'id,review_id,consent_id,owner_id,session_hash,token_version,factor_version,policy_version,definition_hash,review_hash,receipt_hash,created_at,event_hash',
   paper_runtime_revocations:'id,consent_id,owner_id,created_at,event_hash',
   ...(granting?{
    paper_dispatch_definitions:'id,owner_id,digest,canonical_json,created_at,attempt_count,last_claim_at',
    paper_dispatch_attempts:'id,definition_id,owner_id,attempt_key,sequence,lease_ms,request_json,request_hash,fence_token,claimed_at,lease_until,status,finished_at,event_hash'
   }:{}),
  };
  for(const [table,fields]of Object.entries(columns)){
   if(!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(table))throw Error('Unavailable');
   // Both identifiers come exclusively from this fixed source-owned allowlist.
   db.prepare(`SELECT ${fields} FROM main.${table} LIMIT 0`).all();
  }
  return db;
 }
 app.post(base+'/reviews',{config:{access:'owner',rateLimit:proofLimit},bodyLimit:4096},async(request,reply)=>{
  try{
   await human(request);const now=Date.now();if(Object.keys(request.query as object).length||!stageInput(request.body,now))return reply.code(400).send(invalid);
   const db=database(true),{context,actor}=await reviewerRequestIdentity(request,true),result=await stagePaperRuntimeConsent(db,context,actor,request.body,now);return result.ok?result:reply.code(409).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
 app.get(base+'/reviews/:reviewId',{config:{access:'owner',rateLimit:readLimit}},async(request,reply)=>{
  try{
   await human(request);const {reviewId}=request.params as {reviewId:string};if(!uuid(reviewId)||Object.keys(request.query as object).length||request.body!==undefined)return reply.code(400).send(invalid);
   const db=database(true),{context,actor}=await reviewerRequestIdentity(request,true),result=await readPaperRuntimeReview(db,context,actor,reviewId,Date.now());return result.ok?result:reply.code(404).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
 for(const phase of ['challenge','complete','apply'] as const)app.post(base+'/reviews/:reviewId/'+phase,{config:{access:'owner',rateLimit:proofLimit},bodyLimit:2048},async(request,reply)=>{
  try{
   await human(request);const {reviewId}=request.params as {reviewId:string},body=request.body;
   if(!uuid(reviewId)||Object.keys(request.query as object).length||!exact(body,phase==='challenge'?[]:phase==='complete'?['challenge','code']:['receipt']))return reply.code(400).send(invalid);
   if(phase==='complete'&&(!token(body.challenge)||typeof body.code!=='string'||body.code.length!==6||!/^\d{6}$/.test(body.code))||phase==='apply'&&!token(body.receipt))return reply.code(400).send(invalid);
   const db=database(true),{context,actor}=await reviewerRequestIdentity(request,true);
   if(phase==='challenge'){const result=await issuePaperRuntimeProof(db,context,actor,reviewId,Date.now());return result?{challenge:result.token,expiresAt:result.expiresAt}:reply.code(409).send(unavailable);}
   if(phase==='complete'){const result=await completePaperRuntimeProof(db,context,actor,reviewId,body.challenge,body.code,Date.now());return result?{receipt:result.receipt,expiresAt:result.expiresAt}:reply.code(403).send({code:'verification_refused'});}
   const result=await applyPaperRuntimeConsent(db,context,actor,reviewId,body.receipt,Date.now());return result.ok?result:reply.code(409).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
 app.get(base+'/bots/:botId/consent-reference',{config:{access:'owner',rateLimit:readLimit}},async(request,reply)=>{
  try{
   await human(request);const {botId}=request.params as {botId:string};
   if(!uuid(botId)||Object.keys(request.query as object).length||request.body!==undefined)return reply.code(400).send(invalid);
   const result=readPaperRuntimeConsentReference(database(),request.actor!,botId,Date.now());
   return result.ok?result:reply.code(404).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
 app.get(base+'/consents/:consentId',{config:{access:'owner',rateLimit:readLimit}},async(request,reply)=>{
  try{
   await human(request);const {consentId}=request.params as {consentId:string};
   if(!uuid(consentId)||Object.keys(request.query as object).length||request.body!==undefined)return reply.code(400).send(invalid);
   const result=readPaperRuntimeConsent(database(),request.actor!,consentId,Date.now());
   return result.ok?result:reply.code(404).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
 app.post(base+'/consents/:consentId/revoke',{config:{access:'owner',rateLimit:revokeLimit},bodyLimit:2048},async(request,reply)=>{
  try{
   await human(request);const {consentId}=request.params as {consentId:string};
   if(!uuid(consentId)||Object.keys(request.query as object).length||!exact(request.body,[]))return reply.code(400).send(invalid);
   const result=revokePaperRuntimeConsent(database(),request.actor!,consentId,Date.now());
   return result.ok?result:reply.code(409).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });

}
