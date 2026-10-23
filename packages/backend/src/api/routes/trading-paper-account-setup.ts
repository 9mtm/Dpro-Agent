/** Human-owner reviewed account creation only. No reset, update, order or runtime endpoint. */
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type Database from 'better-sqlite3';
import {getDatabase} from '../../db/index.js';
import {dbDriver} from '../../db/pg/config.js';
import {isSystemAccount} from '../../auth/default-accounts.js';
import {AuthTokenError,verifyRequestTokenAsync} from '../../auth/jwt.js';
import {reviewerRequestIdentity,ReviewerIdentityError} from '../../auth/verification/reviewer-request.js';
import {changePasswordRateLimit} from '../rate-limit-config.js';
import {stagePaperAccountReview,readPaperAccountReview,issuePaperAccountProof,completePaperAccountProof,applyPaperAccountReview} from '../../services/trading-paper-account-review.js';

const invalid={code:'invalid_paper_account_setup_request'},unavailable={code:'paper_account_setup_unavailable'};
const uint=(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
const uuid=(value:unknown):value is string=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const token=(value:unknown):value is string=>typeof value==='string'&&value.length===43&&/^[A-Za-z0-9_-]{43}$/.test(value);
const symbol=(value:unknown):value is string=>typeof value==='string'&&value.length<=128&&!/[\x00-\x20\x7f]/.test(value)&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
function exact(value:unknown,keys:string[]):value is Record<string,unknown>{
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
  &&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));
}
function stageInput(body:unknown,now:number):body is Record<string,unknown>{
 if(!exact(body,['currency','initialCashMinor','policy','execution'])||typeof body.currency!=='string'||body.currency.length!==3||!/^[A-Z]{3}$/.test(body.currency)||!uint(body.initialCashMinor,1,1e12)
  ||!exact(body.policy,['expiresAt','symbols','maxOrder','maxExposure','maxDailyLoss','maxOrders','cooldownMs','maxQuoteAgeMs'])||!exact(body.execution,['feeBps','slippageBps']))return false;
 const p=body.policy,e=body.execution;
 if(!uint(p.expiresAt,now+1,now+30*86400000)||!['maxOrder','maxExposure','maxDailyLoss'].every(key=>uint(p[key],1,body.initialCashMinor as number))||Number(p.maxOrder)>Number(p.maxExposure)
  ||!uint(p.maxOrders,1,10000)||!uint(p.cooldownMs,0,86400000)||!uint(p.maxQuoteAgeMs,1,300000)||!uint(e.feeBps,0,10000)||!uint(e.slippageBps,0,10000))return false;
 const raw=p.symbols;
 if(!Array.isArray(raw)||Object.getPrototypeOf(raw)!==Array.prototype||raw.length<1||raw.length>100||Reflect.ownKeys(raw).length!==raw.length+1)return false;
 const symbols:string[]=[];
 for(let i=0;i<raw.length;i++){const descriptor=Object.getOwnPropertyDescriptor(raw,i);if(!descriptor||!Object.hasOwn(descriptor,'value')||!symbol(descriptor.value))return false;symbols.push(descriptor.value);}
 return new Set(symbols).size===symbols.length;
}
const proofLimit={...changePasswordRateLimit,keyGenerator:(request:FastifyRequest)=>changePasswordRateLimit.keyGenerator(request).replace('change-password-user:','paper-account-setup-proof-user:'),errorResponseBuilder:()=>({statusCode:429,code:'rate_limited',error:'Too many account setup verification attempts'})};
const readLimit={...proofLimit,max:100,timeWindow:'1 minute',keyGenerator:(request:FastifyRequest)=>changePasswordRateLimit.keyGenerator(request).replace('change-password-user:','paper-account-setup-read-user:'),errorResponseBuilder:()=>({statusCode:429,code:'rate_limited',error:'Too many account setup reads'})};
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
export async function tradingPaperAccountSetupRoutes(app:FastifyInstance,options:{ledger:()=>Database.Database|null}){
 const base='/api/trading-paper/account-setup';
 app.addHook('onSend',async(_request,reply,payload)=>{reply.header('Cache-Control','no-store');return payload;});
 function database(){
  const db=options.ledger();if(!db||dbDriver()!=='sqlite'||getDatabase().getDb()!==db)throw Error('Unavailable');
  for(const table of ['paper_account_reviews','paper_account_review_events','paper_account_setups'])if(!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(table))throw Error('Unavailable');
  db.prepare('SELECT id,owner_id,session_hash,token_version,factor_version,policy_version,definition_json,definition_hash,review_hash,created_at,expires_at,status FROM main.paper_account_reviews LIMIT 0').all();
  db.prepare('SELECT id,review_id,owner_id,session_hash,token_version,factor_version,policy_version,definition_hash,review_hash,receipt_hash,setup_id,result_json,created_at,event_hash FROM main.paper_account_review_events LIMIT 0').all();
  db.prepare('SELECT id,owner_id,idempotency_key,account_id,policy_id,installation_id,installation_revision,request_json,request_hash,result_json,event_hash,created_at FROM main.paper_account_setups LIMIT 0').all();
  return db;
 }
 app.post(base+'/reviews',{config:{access:'owner',rateLimit:proofLimit},bodyLimit:16384},async(request,reply)=>{
  try{
   await human(request);const now=Date.now();if(Object.keys(request.query as object).length||!stageInput(request.body,now))return reply.code(400).send(invalid);
   const db=database(),{context,actor}=await reviewerRequestIdentity(request,true),result=await stagePaperAccountReview(db,context,actor,request.body,now);return result.ok?result:reply.code(409).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
 app.get(base+'/reviews/:reviewId',{config:{access:'owner',rateLimit:readLimit}},async(request,reply)=>{
  try{
   await human(request);const {reviewId}=request.params as {reviewId:string};if(!uuid(reviewId)||Object.keys(request.query as object).length||request.body!==undefined)return reply.code(400).send(invalid);
   const db=database(),{context,actor}=await reviewerRequestIdentity(request,true),result=await readPaperAccountReview(db,context,actor,reviewId,Date.now());return result.ok?result:reply.code(404).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
 for(const phase of ['challenge','complete','apply'] as const)app.post(base+'/reviews/:reviewId/'+phase,{config:{access:'owner',rateLimit:proofLimit},bodyLimit:2048},async(request,reply)=>{
  try{
   await human(request);const {reviewId}=request.params as {reviewId:string},body=request.body;
   if(!uuid(reviewId)||Object.keys(request.query as object).length||!exact(body,phase==='challenge'?[]:phase==='complete'?['challenge','code']:['receipt']))return reply.code(400).send(invalid);
   if(phase==='complete'&&(!token(body.challenge)||typeof body.code!=='string'||body.code.length!==6||!/^\d{6}$/.test(body.code))||phase==='apply'&&!token(body.receipt))return reply.code(400).send(invalid);
   const db=database(),{context,actor}=await reviewerRequestIdentity(request,true);
   if(phase==='challenge'){const result=await issuePaperAccountProof(db,context,actor,reviewId,Date.now());return result?{challenge:result.token,expiresAt:result.expiresAt}:reply.code(409).send(unavailable);}
   if(phase==='complete'){const result=await completePaperAccountProof(db,context,actor,reviewId,body.challenge,body.code,Date.now());return result?{receipt:result.receipt,expiresAt:result.expiresAt}:reply.code(403).send({code:'verification_refused'});}
   const result=await applyPaperAccountReview(db,context,actor,reviewId,body.receipt,Date.now());return result.ok?result:reply.code(409).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
}
