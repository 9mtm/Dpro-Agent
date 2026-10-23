/** Explicit human-owner installation review only; no runtime, account seed or execution dispatch. */
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type Database from 'better-sqlite3';
import {getDatabase} from '../../db/index.js';
import {dbDriver} from '../../db/pg/config.js';
import {isSystemAccount} from '../../auth/default-accounts.js';
import {AuthTokenError,verifyRequestTokenAsync} from '../../auth/jwt.js';
import {reviewerRequestIdentity,ReviewerIdentityError} from '../../auth/verification/reviewer-request.js';
import {changePasswordRateLimit} from '../rate-limit-config.js';
import {inspectPaperBundlePreparation} from '../../services/trading-paper-bundle-schema.js';
import {BUNDLED_PAPER_INSTALLATION,readPaperInstallation} from '../../services/trading-paper-installation.js';
import {readReviewedPaperInstallationAccess,stagePaperInstallReview,readPaperInstallReview,issuePaperInstallProof,completePaperInstallProof,applyPaperInstallReview} from '../../services/trading-paper-install-review.js';

const invalid={code:'invalid_paper_install_request'},unavailable={code:'paper_installation_unavailable'};
const uint=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const uuid=(value:unknown):value is string=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const token=(value:unknown):value is string=>typeof value==='string'&&value.length===43&&/^[A-Za-z0-9_-]{43}$/.test(value);
function exact(value:unknown,keys:string[]):value is Record<string,unknown>{
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
  &&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));
}
const proofLimit={...changePasswordRateLimit,keyGenerator:(request:FastifyRequest)=>changePasswordRateLimit.keyGenerator(request).replace('change-password-user:','paper-install-proof-user:'),errorResponseBuilder:()=>({statusCode:429,code:'rate_limited',error:'Too many installation verification attempts'})};
const readLimit={...proofLimit,max:100,timeWindow:'1 minute',keyGenerator:(request:FastifyRequest)=>changePasswordRateLimit.keyGenerator(request).replace('change-password-user:','paper-install-read-user:')};
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
function stageInput(body:unknown):body is Record<string,unknown>{
 if(!exact(body,['action','expectedRevision','manifestDigest','capabilities'])||!['install','disable','remove_retained'].includes(body.action as string)||!uint(body.expectedRevision)
  ||typeof body.manifestDigest!=='string'||body.manifestDigest.length!==64||!/^[a-f0-9]{64}$/.test(body.manifestDigest)||!Array.isArray(body.capabilities))return false;
 const caps=body.capabilities;
 if(caps.length>2||new Set(caps).size!==caps.length||caps.some(cap=>!['paper.account.read','paper.bot.manage'].includes(cap)))return false;
 return body.action==='install'?body.expectedRevision===0&&caps.includes('paper.account.read'):body.expectedRevision>=1&&caps.length===0;
}

/** Default dependency remains null. Storage must have been initialized explicitly by a trusted caller. */
export async function tradingPaperInstallRoutes(app:FastifyInstance,options:{ledger:()=>Database.Database|null}){
 const base='/api/trading-paper/installation';
 app.addHook('onSend',async(_request,reply,payload)=>{reply.header('Cache-Control','no-store');return payload;});
 function database(){
  const db=options.ledger();
  if(!db||dbDriver()!=='sqlite'||getDatabase().getDb()!==db)throw Error('Unavailable');
  for(const table of ['paper_install_reviews','paper_install_review_events'])if(!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(table))throw Error('Unavailable');
  db.prepare('SELECT id,owner_id,session_hash,token_version,factor_version,policy_version,definition_json,definition_hash,review_hash,created_at,expires_at,status FROM main.paper_install_reviews LIMIT 0').all();
  db.prepare('SELECT id,review_id,owner_id,session_hash,token_version,factor_version,policy_version,definition_hash,review_hash,receipt_hash,operation_id,result_json,created_at,event_hash FROM main.paper_install_review_events LIMIT 0').all();
  return db;
 }
 app.get(base,{config:{access:'owner',rateLimit:readLimit}},async(request,reply)=>{
  try{
   const owner=await human(request);if(Object.keys(request.query as object).length||request.body!==undefined)return reply.code(400).send(invalid);
   const db=database();return db.transaction(()=>{
    const now=Date.now(),access=readReviewedPaperInstallationAccess(db,owner,()=>now);
    if(access.state==='incompatible'||access.state==='demo_only')throw Error('Unavailable');
    const registryPresent=!!db.prepare("SELECT 1 FROM main.sqlite_master WHERE name IN ('paper_installations','paper_install_grants','paper_install_operations','paper_schema_journal') COLLATE NOCASE LIMIT 1").get();
    if(!registryPresent){
     if(access.state!=='not_provisioned'||!inspectPaperBundlePreparation(db).ok)throw Error('Unavailable');
     return {appId:'trading',version:BUNDLED_PAPER_INSTALLATION.version,manifestDigest:BUNDLED_PAPER_INSTALLATION.manifestDigest,mode:'paper',state:'not_provisioned',revision:0,installationId:null,capabilities:[],access,runtimeConnected:false,createsAccounts:false,retainsData:true};
    }
    const installation=readPaperInstallation(db,owner,()=>now);if(!installation.ok)throw Error('Unavailable');
    return {appId:'trading',version:BUNDLED_PAPER_INSTALLATION.version,manifestDigest:BUNDLED_PAPER_INSTALLATION.manifestDigest,mode:'paper',state:installation.state,revision:'revision' in installation?installation.revision:0,installationId:'installationId' in installation?installation.installationId:null,capabilities:'capabilities' in installation?installation.capabilities:[],access,runtimeConnected:false,createsAccounts:false,retainsData:true};
   }).deferred();
  }catch(error){return refuse(reply,error);}
 });
 app.post(base+'/reviews',{config:{access:'owner',rateLimit:proofLimit},bodyLimit:2048},async(request,reply)=>{
  try{
   await human(request);if(Object.keys(request.query as object).length||!stageInput(request.body))return reply.code(400).send(invalid);
   const db=database(),{context,actor}=await reviewerRequestIdentity(request,true);
   const result=await stagePaperInstallReview(db,context,actor,request.body,Date.now());return result.ok?result:reply.code(409).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
 app.get(base+'/reviews/:reviewId',{config:{access:'owner',rateLimit:readLimit}},async(request,reply)=>{
  try{
   await human(request);const {reviewId}=request.params as {reviewId:string};if(!uuid(reviewId)||Object.keys(request.query as object).length||request.body!==undefined)return reply.code(400).send(invalid);
   const db=database(),{context,actor}=await reviewerRequestIdentity(request,true),result=await readPaperInstallReview(db,context,actor,reviewId,Date.now());return result.ok?result:reply.code(404).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
 for(const phase of ['challenge','complete','apply'] as const)app.post(base+'/reviews/:reviewId/'+phase,{config:{access:'owner',rateLimit:proofLimit},bodyLimit:2048},async(request,reply)=>{
  try{
   await human(request);const {reviewId}=request.params as {reviewId:string},body=request.body;
   if(!uuid(reviewId)||Object.keys(request.query as object).length||!exact(body,phase==='challenge'?[]:phase==='complete'?['challenge','code']:['receipt']))return reply.code(400).send(invalid);
   if(phase==='complete'&&(!token(body.challenge)||typeof body.code!=='string'||body.code.length!==6||!/^\d{6}$/.test(body.code))||phase==='apply'&&!token(body.receipt))return reply.code(400).send(invalid);
   const db=database(),{context,actor}=await reviewerRequestIdentity(request,true);
   if(phase==='challenge'){const result=await issuePaperInstallProof(db,context,actor,reviewId,Date.now());return result?{challenge:result.token,expiresAt:result.expiresAt}:reply.code(409).send(unavailable);}
   if(phase==='complete'){const result=await completePaperInstallProof(db,context,actor,reviewId,body.challenge,body.code,Date.now());return result?{receipt:result.receipt,expiresAt:result.expiresAt}:reply.code(403).send({code:'verification_refused'});}
   const result=await applyPaperInstallReview(db,context,actor,reviewId,body.receipt,Date.now());return result.ok?result:reply.code(409).send(unavailable);
  }catch(error){return refuse(reply,error);}
 });
}
