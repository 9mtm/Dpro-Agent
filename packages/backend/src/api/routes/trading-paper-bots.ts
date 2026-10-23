/** Human-owner management only. Deliberately exposes no tick, order, reservation, strategy or engine endpoint. */
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type Database from 'better-sqlite3';
import {getDatabase} from '../../db/index.js';
import {dbDriver} from '../../db/pg/config.js';
import {isSystemAccount} from '../../auth/default-accounts.js';
import {AuthTokenError,verifyRequestTokenAsync} from '../../auth/jwt.js';
import {reviewerRequestIdentity,ReviewerIdentityError} from '../../auth/verification/reviewer-request.js';
import {changePasswordRateLimit} from '../rate-limit-config.js';
import {readPaperBotAvailability} from '../../services/trading-paper-bot-availability.js';
import {readPaperAvailability} from '../../services/trading-paper-availability.js';
import {stopPaperBot,revokePaperBot} from '../../services/trading-paper-bots.js';
import {stagePaperBotActivation,readPaperBotActivation,issuePaperBotActivationProof,completePaperBotActivationProof,applyPaperBotActivation} from '../../services/trading-paper-bot-activation.js';
const invalid={code:'invalid_paper_bot_request'},unavailable={code:'paper_bot_management_unavailable'};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const uint=(value:unknown,min=0):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;
const token=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));
const grantingLimit={...changePasswordRateLimit,keyGenerator:(request:FastifyRequest)=>changePasswordRateLimit.keyGenerator(request).replace('change-password-user:','paper-bot-proof-user:'),errorResponseBuilder:()=>({statusCode:429,code:'rate_limited',error:'Too many paper bot verification attempts'})};
const managementLimit={...changePasswordRateLimit,max:100,timeWindow:'1 minute',keyGenerator:(request:FastifyRequest)=>changePasswordRateLimit.keyGenerator(request).replace('change-password-user:','paper-bot-management-user:'),errorResponseBuilder:()=>({statusCode:429,code:'rate_limited',error:'Too many paper bot management requests'})};
const stopLimit={...managementLimit,keyGenerator:(request:FastifyRequest)=>managementLimit.keyGenerator(request).replace('paper-bot-management-user:','paper-bot-stop-user:')};
function refuse(reply:FastifyReply,error:unknown){
 if(error instanceof AuthTokenError)return reply.code(401).send({code:'unauthenticated'});
 if(error instanceof ReviewerIdentityError)return reply.code(403).send({code:'owner_verification_required'});
 return reply.code(503).send(unavailable);
}
async function human(request:FastifyRequest){
 const verified=await verifyRequestTokenAsync(request),actor=request.actor;
 if(isSystemAccount(verified.userId)||!actor||actor.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==verified.userId||verified.user.role!=='owner')throw new ReviewerIdentityError();
 return verified.userId;
}
/** Optional dependency remains null by default. No schema or application installation is created here. */
export async function tradingPaperBotRoutes(app:FastifyInstance,options:{ledger:()=>Database.Database|null}){
 const base='/api/trading-paper/bots';
 app.addHook('onSend',async(_request,reply,payload)=>{reply.header('Cache-Control','no-store');return payload;});
 function database(stopping=false){
  const db=options.ledger();
  if(!db||dbDriver()!=='sqlite'||getDatabase().getDb()!==db)throw Error('Unavailable');
  for(const table of (stopping?['paper_accounts','paper_bots']:['paper_accounts','paper_bots','paper_bot_ticks','paper_bot_activation_reviews','paper_bot_activation_events']))
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw Error('Unavailable');
  db.prepare('SELECT bot_id,owner_id,account_id,policy_id,policy_revision,app_revision,expires_at,max_successful_ticks,cooldown_ms,status,successful_ticks,last_success_at,created_at FROM paper_bots LIMIT 0').all();
  if(stopping)return db;
  db.prepare('SELECT id,bot_id,owner_id,definition_json,definition_hash,review_hash,session_hash,token_version,factor_version,policy_version,created_at,expires_at,status FROM paper_bot_activation_reviews LIMIT 0').all();
  db.prepare('SELECT id,review_id,bot_id,owner_id,session_hash,token_version,factor_version,policy_version,definition_hash,review_hash,receipt_hash,created_at,event_hash FROM paper_bot_activation_events LIMIT 0').all();
  return db;
 }
 function available(db:Database.Database,owner:string,grant:boolean){const state=readPaperAvailability(db,owner),bot=readPaperBotAvailability(db,owner);if(grant?state.state!=='ready'||bot.state!=='ready':!state.readAccounts||!['ready','disabled'].includes(bot.state))throw Error('Unavailable');}
 app.get(base,{config:{access:'owner',rateLimit:managementLimit}},async(request,reply)=>{
  try{
   const owner=await human(request);if(Object.keys(request.query as object).length||request.body!==undefined)return reply.code(400).send(invalid);
   const db=database();available(db,owner,false);const now=Date.now();
   // This validates bounded descriptors, not the entire tick journal or execution authority.
   const rows=db.prepare('SELECT b.*,a.currency,a.mode FROM paper_bots b JOIN paper_accounts a ON a.account_id=b.account_id WHERE b.owner_id=? AND a.owner_id=? ORDER BY b.bot_id LIMIT 101').all(owner,owner) as Array<Record<string,unknown>>;
   if(rows.some(row=>!['bot_id','account_id','policy_id'].every(key=>id(row[key]))||row.mode!=='paper'||typeof row.currency!=='string'||!/^[A-Z]{3}$/.test(row.currency)
     ||!['policy_revision','app_revision','expires_at','max_successful_ticks','created_at'].every(key=>uint(row[key],1))||Number(row.max_successful_ticks)>1000
     ||!uint(row.cooldown_ms)||!uint(row.successful_ticks)||row.successful_ticks>Number(row.max_successful_ticks)
     ||!['active','stopped','revoked'].includes(row.status as string)||Number(row.expires_at)<=Number(row.created_at)||Number(row.created_at)>now
     ||(row.successful_ticks===0?row.last_success_at!==null:!uint(row.last_success_at)||row.last_success_at<Number(row.created_at)||row.last_success_at>now)))throw Error('Unavailable');
   return {mode:'paper',running:false,bots:rows.slice(0,100).map(row=>({botId:row.bot_id,accountId:row.account_id,policyId:row.policy_id,policyRevision:row.policy_revision,appRevision:row.app_revision,currency:row.currency,expiresAt:row.expires_at,maxSuccessfulTicks:row.max_successful_ticks,cooldownMs:row.cooldown_ms,status:row.status==='active'&&Number(row.expires_at)<=now?'expired':row.status,successfulTicks:row.successful_ticks,lastSuccessAt:row.last_success_at,createdAt:row.created_at,running:false})),hasMore:rows.length>100};
  }catch(error){return refuse(reply,error);}
 });
 app.post(base+'/reviews',{config:{access:'owner',rateLimit:grantingLimit},bodyLimit:2048},async(request,reply)=>{
  try{
   await human(request);if(Object.keys(request.query as object).length||!exact(request.body,['accountId','policyId','policyRevision','appRevision','expiresAt','maxSuccessfulTicks','cooldownMs']))return reply.code(400).send(invalid);
   const body=request.body;if(!id(body.accountId)||!id(body.policyId)||!['policyRevision','appRevision','expiresAt','maxSuccessfulTicks'].every(key=>uint(body[key],1))||Number(body.maxSuccessfulTicks)>1000||!uint(body.cooldownMs))return reply.code(400).send(invalid);
   const db=database(),{context,actor}=await reviewerRequestIdentity(request,true);available(db,context.userId,true);
   const result=await stagePaperBotActivation(db,context,actor,body,Date.now(),true);return result.ok?result:reply.code(409).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
 app.get(base+'/reviews/:reviewId',{config:{access:'owner'}},async(request,reply)=>{
  try{await human(request);const {reviewId}=request.params as {reviewId:string};if(!uuid(reviewId)||Object.keys(request.query as object).length||request.body!==undefined)return reply.code(400).send(invalid);
   const db=database(),{context,actor}=await reviewerRequestIdentity(request,true);available(db,context.userId,true);const result=await readPaperBotActivation(db,context,actor,reviewId,Date.now(),true);return result.ok?result:reply.code(404).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
 for(const phase of ['challenge','complete','apply'] as const)app.post(base+'/reviews/:reviewId/'+phase,{config:{access:'owner',rateLimit:grantingLimit},bodyLimit:2048},async(request,reply)=>{
  try{await human(request);const {reviewId}=request.params as {reviewId:string},body=request.body;
   if(!uuid(reviewId)||Object.keys(request.query as object).length||!exact(body,phase==='challenge'?[]:phase==='complete'?['challenge','code']:['receipt']))return reply.code(400).send(invalid);
   if(phase==='complete'&&(!token(body.challenge)||typeof body.code!=='string'||!/^\d{6}$/.test(body.code))||phase==='apply'&&!token(body.receipt))return reply.code(400).send(invalid);
   const db=database(),{context,actor}=await reviewerRequestIdentity(request,true);available(db,context.userId,true);
   if(phase==='challenge'){const result=await issuePaperBotActivationProof(db,context,actor,reviewId,Date.now(),true);return result?{challenge:result.token,expiresAt:result.expiresAt}:reply.code(409).send(unavailable);}
   if(phase==='complete'){const result=await completePaperBotActivationProof(db,context,actor,reviewId,body.challenge,body.code,Date.now(),true);return result??reply.code(403).send({code:'verification_refused'});}
   const result=await applyPaperBotActivation(db,context,actor,reviewId,body.receipt,Date.now(),true);return result.ok?result:reply.code(409).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
 for(const action of ['stop','revoke'] as const)app.post(base+'/:botId/'+action,{config:{access:'owner',rateLimit:stopLimit},bodyLimit:1024},async(request,reply)=>{
  try{const owner=await human(request),{botId}=request.params as {botId:string};if(!id(botId)||Object.keys(request.query as object).length||!exact(request.body,[]))return reply.code(400).send(invalid);
   const db=database(true),account=db.prepare('SELECT b.bot_id FROM paper_bots b JOIN paper_accounts a ON a.account_id=b.account_id WHERE b.bot_id=? AND b.owner_id=? AND a.owner_id=? AND a.mode=?').get(botId,owner,owner,'paper');
   if(!account)return reply.code(404).send(unavailable);
   const result=(action==='stop'?stopPaperBot:revokePaperBot)(db,owner,botId);return result.ok?{mode:'paper',botId,status:result.status,running:false}:reply.code(409).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
}
