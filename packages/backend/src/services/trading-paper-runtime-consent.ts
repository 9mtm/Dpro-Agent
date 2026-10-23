/** Reviewed deterministic paper dispatch consent only. No worker, timer, provider or trade execution. */
import {readEffectiveInstallationInTransaction} from './trading-paper-execution-upgrade-apply.js';
import {assertNoPaperExecutionOverlay} from './trading-paper-execution-overlay-schema.js';
import {BUNDLED_PAPER_INSTALLATION} from './trading-paper-manifest.js';
import {PAPER_EXECUTION_UPGRADE_CANDIDATE} from './trading-paper-manifest-catalog.js';
import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import type {Actor} from '../repositories/actor.js';
import {sql} from '../repositories/sql-steps.js';
import {issueOperationChallenge,completeOperationChallenge,consumeOperationReceiptStep,paperRuntimeConsentOperationHash,type PaperRuntimeConsentOperation,type OperationContext} from '../auth/verification/operation-proof.js';
import {readReviewedPaperBotTarget} from './trading-paper-bot-activation.js';
import {capturePaperDispatchDefinition,type PaperDispatchDefinition} from './trading-paper-dispatch-contract.js';
import {fingerprintPaperDispatchHistoryInTransaction,provisionTrustedPaperDispatchDefinitionInTransaction,readTrustedPaperDispatchDefinitionInTransaction} from './trading-paper-dispatch-attempts.js';
const principal='bundled.paper.deterministic.v1' as const;
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
function fail():never{throw Error('paper runtime consent unavailable');}
const deny=()=>({ok:false as const,reason:'unavailable' as const});
const uint=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
const token=(v:unknown):v is string=>typeof v==='string'&&v.length===43&&/^[A-Za-z0-9_-]{43}$/.test(v);
function plain(v:unknown,keys:string[]):v is Record<string,unknown>{
 if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return false;
 const own=Reflect.ownKeys(v);return own.length===keys.length&&own.every(k=>typeof k==='string'&&keys.includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value'));
}
const schemaSQL=`CREATE TABLE IF NOT EXISTS paper_runtime_reviews(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_hash TEXT NOT NULL,token_version INTEGER NOT NULL,factor_version INTEGER NOT NULL,policy_version INTEGER NOT NULL,definition_json TEXT NOT NULL,definition_hash TEXT NOT NULL,review_hash TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS paper_runtime_consents(id TEXT PRIMARY KEY,review_id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,bot_id TEXT NOT NULL,definition_id TEXT NOT NULL UNIQUE,definition_digest TEXT NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL,UNIQUE(owner_id,bot_id));
CREATE TABLE IF NOT EXISTS paper_runtime_events(id TEXT PRIMARY KEY,review_id TEXT NOT NULL UNIQUE,consent_id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,session_hash TEXT NOT NULL,token_version INTEGER NOT NULL,factor_version INTEGER NOT NULL,policy_version INTEGER NOT NULL,definition_hash TEXT NOT NULL,review_hash TEXT NOT NULL,receipt_hash TEXT NOT NULL,created_at INTEGER NOT NULL,event_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS paper_runtime_revocations(id TEXT PRIMARY KEY,consent_id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,created_at INTEGER NOT NULL,event_hash TEXT NOT NULL);`;
type ObjectRow={type:string;name:string;tbl_name:string;sql:string|null};
const objects=(db:Database.Database,temp=false)=>db.prepare(`SELECT type,name,tbl_name,sql FROM ${temp?'sqlite_temp_master':'sqlite_master'} WHERE type IN ('table','index','view','trigger') ORDER BY type,name`).all() as ObjectRow[];
const reference=new Database(':memory:');let expected:readonly ObjectRow[];
try{reference.exec(schemaSQL);expected=Object.freeze(objects(reference).map(r=>Object.freeze({...r})));}finally{reference.close();}
const names=new Set(expected.map(r=>r.name)),tables=new Set(['paper_runtime_reviews','paper_runtime_consents','paper_runtime_events','paper_runtime_revocations']);
const authNames=new Set(['users','verification_factors','verification_challenges','verification_receipts','approval_proof_policy']);
function identity(db:Database.Database){if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||db.inTransaction)fail();}
function schema(db:Database.Database,complete=true){
 const related=(r:ObjectRow)=>names.has(r.name.toLowerCase())||tables.has(r.tbl_name.toLowerCase());
 if(objects(db,true).some(r=>related(r)||authNames.has(r.name.toLowerCase())||authNames.has(r.tbl_name.toLowerCase())))fail();
 const found=objects(db).filter(related);
 if(found.some(r=>JSON.stringify(r)!==JSON.stringify(expected.find(e=>e.name===r.name)))||complete&&found.length!==expected.length)fail();
 for(const name of authNames)if(!db.prepare("SELECT 1 FROM main.sqlite_master WHERE name=? COLLATE NOCASE AND type='table'").get(name))fail();
}
function human(db:Database.Database,actor:Actor,now:number){
 if(!actor||actor.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||typeof actor.userId!=='string'||!actor.userId||actor.userId.length>128||/[\x00-\x20\x7f]/.test(actor.userId)||isSystemAccount(actor.userId)||!uint(now,1)||now>Number.MAX_SAFE_INTEGER-2592000000)fail();
 schema(db);const user=db.prepare('SELECT role,status,email_verified,token_version FROM main.users WHERE id=?').get(actor.userId) as Record<string,unknown>|undefined;
 if(user?.role!=='owner'||user.status!=='active'||user.email_verified!==1||!uint(user.token_version,1))fail();return {ownerId:actor.userId,user};
}
function capture(context:OperationContext,actor:Actor,now:number):OperationContext{
 if(!context||!actor||actor.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==context.userId||typeof context.userId!=='string'||!context.userId||context.userId.length>128||/[\x00-\x20\x7f]/.test(context.userId)||isSystemAccount(context.userId)||!hash(context.sessionHash)||!uint(context.tokenVersion,1)||!uint(context.factorVersion,1)||!uint(now,1)||now>Number.MAX_SAFE_INTEGER-2592000000)fail();
 return Object.freeze({userId:context.userId,sessionHash:context.sessionHash,tokenVersion:context.tokenVersion,factorVersion:context.factorVersion});
}
function active(db:Database.Database,c:OperationContext,actor:Actor,now:number){
 const {user}=human(db,actor,now),factor=db.prepare('SELECT enabled,version FROM main.verification_factors WHERE user_id=?').get(c.userId) as Record<string,unknown>|undefined;
 const policy=db.prepare('SELECT version FROM main.approval_proof_policy WHERE id=1').get() as {version:number}|undefined;
 if(user.token_version!==c.tokenVersion||factor?.enabled!==1||factor.version!==c.factorVersion||!policy||!uint(policy.version,1))fail();return policy.version;
}
function input(value:unknown){
 if(!plain(value,['botId','strategy','limits'])||!uuid(value.botId)||!plain(value.strategy,['kind','version','symbol','side','amount'])||!plain(value.limits,['expiresAt','maxAttempts','cadenceMs']))fail();
 const s=value.strategy,l=value.limits;
 if(s.kind!=='fixed-paper-order'||s.version!==1||typeof s.symbol!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(s.symbol)||!['buy','sell'].includes(s.side as string)||!uint(s.amount,1)||s.amount>1e12||!uint(l.expiresAt,1)||!uint(l.maxAttempts,1)||l.maxAttempts>1000||!uint(l.cadenceMs,1000)||l.cadenceMs>86400000)fail();
 return {botId:value.botId,strategy:{kind:'fixed-paper-order' as const,version:1 as const,symbol:s.symbol,side:s.side as 'buy'|'sell',amount:s.amount},limits:{expiresAt:l.expiresAt,maxAttempts:l.maxAttempts,cadenceMs:l.cadenceMs}};
}
type Request=ReturnType<typeof input>;
type Definition={version:1;consentId:string;definitionId:string;runtimePrincipal:typeof principal;currency:string;activationReviewId:string;activationReviewHash:string;activationDefinitionHash:string;dispatch:PaperDispatchDefinition;dispatchDigest:string;runtimeConnected:false};
function definition(db:Database.Database,ownerId:string,r:Request,consentId:string,definitionId:string,now:number,allowExhausted=false,binding:'base'|'effective'='base'):Definition{
 const target=readReviewedPaperBotTarget(db,ownerId,r.botId,now,allowExhausted);if(!target.ok)fail();const d=target.definition;
 if(r.limits.expiresAt> d.expiresAt||r.limits.cadenceMs<Math.max(d.cooldownMs,d.limits.cooldownMs,1000)||!d.limits.symbols.includes(r.strategy.symbol)||d.execution.unitScale!==1||r.strategy.side==='buy'&&r.strategy.amount>d.limits.maxOrder)fail();
 const installed=binding==='effective'?readEffectiveInstallationInTransaction(db,ownerId,now):{installationId:target.installationId,effectiveRevision:target.installationRevision,manifestDigest:target.manifestDigest};
 const captured=capturePaperDispatchDefinition({version:1,mode:'paper',ownerId,botId:r.botId,accountId:d.accountId,policyId:d.policyId,policyRevision:d.policyRevision,appRevision:d.appRevision,installationId:installed.installationId,installationRevision:installed.effectiveRevision,manifestDigest:installed.manifestDigest,policyHash:d.policyHash,profileHash:d.profileHash,quoteSource:'stored-paper-quote',strategy:r.strategy,limits:r.limits},now);if(!captured)fail();
 return {version:1,consentId,definitionId,runtimePrincipal:principal,currency:d.currency,activationReviewId:target.reviewId,activationReviewHash:target.activationReviewHash,activationDefinitionHash:target.activationDefinitionHash,dispatch:captured.definition as PaperDispatchDefinition,dispatchDigest:captured.digest,runtimeConnected:false};
}
/** Saved proof-bound metadata chooses the decoder; callers never supply a binding selector. */
function savedBinding(d:Definition):'base'|'effective'{
 if(d.dispatch.manifestDigest===BUNDLED_PAPER_INSTALLATION.manifestDigest)return 'base';
 if(d.dispatch.manifestDigest===PAPER_EXECUTION_UPGRADE_CANDIDATE.manifestDigest)return 'effective';
 fail();
}
type Review={id:string;owner_id:string;session_hash:string;token_version:number;factor_version:number;policy_version:number;definition_json:string;definition_hash:string;review_hash:string;created_at:number;expires_at:number;status:string};
const reviewHash=(r:Review)=>sha(JSON.stringify(['paper-runtime-review-v1',r.id,r.owner_id,r.session_hash,r.token_version,r.factor_version,r.policy_version,r.definition_hash,r.created_at,r.expires_at]));
function savedReview(db:Database.Database,ownerId:string,id:string,now:number){
 if(!uuid(id))fail();const r=db.prepare('SELECT * FROM main.paper_runtime_reviews WHERE id=? AND owner_id=?').get(id,ownerId) as Review|undefined;
 if(!r||!hash(r.session_hash)||!uint(r.token_version,1)||!uint(r.factor_version,1)||!uint(r.policy_version,1)||!uint(r.created_at,1)||r.created_at>now||!uint(r.expires_at,1)||r.expires_at-r.created_at!==300000||!['staged','applied'].includes(r.status)||typeof r.definition_json!=='string'||Buffer.byteLength(r.definition_json,'utf8')>16384||sha(r.definition_json)!==r.definition_hash||reviewHash(r)!==r.review_hash)fail();
 const d=JSON.parse(r.definition_json);if(!plain(d,['version','consentId','definitionId','runtimePrincipal','currency','activationReviewId','activationReviewHash','activationDefinitionHash','dispatch','dispatchDigest','runtimeConnected'])||d.version!==1||!uuid(d.consentId)||!uuid(d.definitionId)||!uuid(d.activationReviewId)||!hash(d.activationReviewHash)||!hash(d.activationDefinitionHash)||d.runtimePrincipal!==principal||typeof d.currency!=='string'||!/^[A-Z]{3}$(?![\s\S])/.test(d.currency)||d.runtimeConnected!==false)fail();
 const captured=capturePaperDispatchDefinition(d.dispatch,r.created_at);if(!captured||captured.definition.ownerId!==ownerId||captured.digest!==d.dispatchDigest||JSON.stringify(d)!==r.definition_json)fail();
 return {row:r,definition:d as unknown as Definition};
}
function currentReview(db:Database.Database,c:OperationContext,actor:Actor,id:string,now:number,historical=false){
 const version=active(db,c,actor,now),saved=savedReview(db,c.userId,id,now),r=saved.row;
 if(r.session_hash!==c.sessionHash||r.token_version!==c.tokenVersion||r.factor_version!==c.factorVersion||r.policy_version!==version)fail();
 if(!historical){if(r.status!=='staged'||r.expires_at<=now)fail();const d=saved.definition,binding=savedBinding(d);if(binding==='base')assertNoPaperExecutionOverlay(db,c.userId);const recomputed=definition(db,c.userId,{botId:d.dispatch.botId,strategy:d.dispatch.strategy,limits:d.dispatch.limits},d.consentId,d.definitionId,now,false,binding);if(JSON.stringify(recomputed)!==r.definition_json)fail();}
 return saved;
}
const operation=(r:Review):PaperRuntimeConsentOperation=>({kind:'paper_runtime_consent',reviewId:r.id,reviewHash:r.review_hash,reviewExpiresAt:r.expires_at,policyVersion:r.policy_version});
const eventFields=['id','review_id','consent_id','owner_id','session_hash','token_version','factor_version','policy_version','definition_hash','review_hash','receipt_hash','created_at'];
const eventHash=(e:Record<string,unknown>)=>sha(JSON.stringify(['paper-runtime-event-v1',...eventFields.map(k=>e[k])]));
const revokeHash=(r:Record<string,unknown>)=>sha(JSON.stringify(['paper-runtime-revoke-v1',r.id,r.consent_id,r.owner_id,r.created_at]));
function history(db:Database.Database,ownerId:string,id:string,now:number,expectedReceipt?:string){
 if(!uuid(id))fail();const consent=db.prepare('SELECT * FROM main.paper_runtime_consents WHERE id=? AND owner_id=?').get(id,ownerId) as Record<string,unknown>|undefined;
 if(!consent||!uuid(consent.review_id)||!uint(consent.created_at,1)||consent.created_at>now||!['granted','revoked'].includes(consent.status as string))fail();
 const saved=savedReview(db,ownerId,consent.review_id,now),r=saved.row,d=saved.definition;
 if(r.status!=='applied'||consent.id!==d.consentId||consent.bot_id!==d.dispatch.botId||consent.definition_id!==d.definitionId||consent.definition_digest!==d.dispatchDigest||consent.created_at<r.created_at||consent.created_at>=r.expires_at||consent.created_at>=d.dispatch.limits.expiresAt)fail();
 const e=db.prepare('SELECT * FROM main.paper_runtime_events WHERE consent_id=?').get(id) as Record<string,unknown>|undefined;
 if(!e||!uuid(e.id)||e.review_id!==r.id||e.consent_id!==id||e.owner_id!==ownerId||e.session_hash!==r.session_hash||e.token_version!==r.token_version||e.factor_version!==r.factor_version||e.policy_version!==r.policy_version||e.definition_hash!==r.definition_hash||e.review_hash!==r.review_hash||!hash(e.receipt_hash)||expectedReceipt!==undefined&&e.receipt_hash!==expectedReceipt||e.created_at!==consent.created_at||eventHash(e)!==e.event_hash)fail();
 const proof=db.prepare('SELECT * FROM main.verification_receipts WHERE token_hash=?').get(e.receipt_hash) as Record<string,unknown>|undefined;
 if(!proof||proof.user_id!==ownerId||proof.session_hash!==r.session_hash||proof.token_version!==r.token_version||proof.factor_version!==r.factor_version||proof.operation_hash!==paperRuntimeConsentOperationHash(operation(r))||proof.consumed_at!==e.created_at||!uint(proof.expires_at,1)||proof.expires_at<=Number(e.created_at))fail();
 const journal=readTrustedPaperDispatchDefinitionInTransaction(db,ownerId,d.definitionId,now);if(journal.createdAt!==e.created_at||journal.definitionDigest!==d.dispatchDigest||JSON.stringify(journal.definition)!==JSON.stringify(d.dispatch))fail();
 const revocation=db.prepare('SELECT * FROM main.paper_runtime_revocations WHERE consent_id=?').get(id) as Record<string,unknown>|undefined;
 if(consent.status==='revoked'?(!revocation||!uuid(revocation.id)||revocation.owner_id!==ownerId||!uint(revocation.created_at,1)||revocation.created_at<Number(e.created_at)||revocation.created_at>now||revokeHash(revocation)!==revocation.event_hash):revocation!==undefined)fail();
 const {status:originalStatus,...immutableConsent}=consent;
 const immutableProvenanceFingerprint=sha(JSON.stringify(['paper-runtime-immutable-provenance-v1',r,immutableConsent,e,proof]));
 const revocationFingerprint=revocation?sha(JSON.stringify(['paper-runtime-original-revocation-v1',revocation])):null;
 return {saved,consent,revocation,journal,immutableProvenanceFingerprint,revocationFingerprint,provenanceFingerprint:sha(JSON.stringify(['paper-runtime-preservation-v1',r,consent,e,proof,revocation??null]))};
}
function effectiveDisclosure(d:Definition){return savedBinding(d)==='effective'?{installationBinding:Object.freeze({kind:'reviewed_execution_overlay' as const,installationId:d.dispatch.installationId,revision:d.dispatch.installationRevision,manifestDigest:d.dispatch.manifestDigest})}:{};}
function publicReview(s:ReturnType<typeof savedReview>){const d=s.definition;return Object.freeze({...effectiveDisclosure(d),ok:true as const,id:s.row.id,consentId:d.consentId,botId:d.dispatch.botId,accountId:d.dispatch.accountId,expiresAt:s.row.expires_at,runtimePrincipal:principal,currency:d.currency,amountUnit:d.dispatch.strategy.side==='buy'?'account_minor_units' as const:'whole_asset_units' as const,engineExecution:false as const,providerAccess:false as const,modelCosts:false as const,strategy:Object.freeze({...d.dispatch.strategy}),limits:Object.freeze({...d.dispatch.limits}),runtimeConnected:false as const,startsWorker:false as const,connectsBroker:false as const});}
function publicConsent(h:ReturnType<typeof history>,replayed?:boolean){const d=h.saved.definition;return Object.freeze({...effectiveDisclosure(d),ok:true as const,consentId:d.consentId,reviewId:h.saved.row.id,botId:d.dispatch.botId,definitionId:d.definitionId,definitionDigest:d.dispatchDigest,status:h.consent.status as 'granted'|'revoked',createdAt:h.consent.created_at as number,revokedAt:h.revocation?.created_at as number|undefined??null,runtimePrincipal:principal,currency:d.currency,amountUnit:d.dispatch.strategy.side==='buy'?'account_minor_units' as const:'whole_asset_units' as const,engineExecution:false as const,providerAccess:false as const,modelCosts:false as const,strategy:Object.freeze({...d.dispatch.strategy}),limits:Object.freeze({...d.dispatch.limits}),attemptCount:h.journal.attemptCount,runtimeConnected:false as const,...(replayed===undefined?{}:{replayed})});}
/** Explicit four-table consent storage only; dispatch journal and trading schemas remain prerequisites. */
export function initializePaperRuntimeConsent(db:Database.Database){identity(db);db.transaction(()=>{schema(db,false);db.exec(schemaSQL);schema(db);}).immediate();}
async function stageRuntime(db:Database.Database,context:OperationContext,actor:Actor,value:unknown,now:number,effective:boolean){
 try{identity(db);const c=capture(context,actor,now),request=input(value),id=randomUUID(),consentId=randomUUID(),definitionId=randomUUID();return await sql().tx(function*(){
  const version=active(db,c,actor,now);if(!effective)assertNoPaperExecutionOverlay(db,c.userId);if(db.prepare('SELECT 1 FROM main.paper_runtime_consents WHERE owner_id=? AND bot_id=?').get(c.userId,request.botId))fail();
  // Journal prerequisite is read-only; no authority inferred from this empty schema.
  if(!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='paper_dispatch_definitions'").get()||!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='paper_dispatch_attempts'").get())fail();
  const d=definition(db,c.userId,request,consentId,definitionId,now,false,effective?'effective':'base'),json=JSON.stringify(d);if(Buffer.byteLength(json,'utf8')>16384)fail();
  if((db.prepare("SELECT count(*) n FROM main.paper_runtime_reviews WHERE owner_id=? AND status='staged' AND expires_at>?").get(c.userId,now) as {n:number}).n>=8)fail();
  const r:Review={id,owner_id:c.userId,session_hash:c.sessionHash,token_version:c.tokenVersion,factor_version:c.factorVersion,policy_version:version,definition_json:json,definition_hash:sha(json),review_hash:'',created_at:now,expires_at:now+300000,status:'staged'};r.review_hash=reviewHash(r);
  db.prepare('INSERT INTO main.paper_runtime_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(r.id,r.owner_id,r.session_hash,r.token_version,r.factor_version,r.policy_version,r.definition_json,r.definition_hash,r.review_hash,r.created_at,r.expires_at,r.status);return publicReview(currentReview(db,c,actor,id,now));
 },{immediate:true});}catch{return deny();}
}
export async function readPaperRuntimeReview(db:Database.Database,context:OperationContext,actor:Actor,id:string,now=Date.now()){try{identity(db);const c=capture(context,actor,now);return await sql().tx(function*(){return publicReview(currentReview(db,c,actor,id,now));},{immediate:true});}catch{return deny();}}
async function proof(db:Database.Database,context:OperationContext,actor:Actor,id:string,now:number){identity(db);const c=capture(context,actor,now);return sql().tx(function*(){return {context:c,operation:operation(currentReview(db,c,actor,id,now).row)};},{immediate:true});}
export async function issuePaperRuntimeProof(db:Database.Database,c:OperationContext,a:Actor,id:string,now=Date.now()){try{const p=await proof(db,c,a,id,now),result=await issueOperationChallenge(p.context,p.operation,now);await proof(db,p.context,a,id,now);return result;}catch{return null;}}
export async function completePaperRuntimeProof(db:Database.Database,c:OperationContext,a:Actor,id:string,challenge:unknown,code:unknown,now=Date.now()){try{const p=await proof(db,c,a,id,now),result=await completeOperationChallenge(challenge,p.context,p.operation,code,now);await proof(db,p.context,a,id,now);return result;}catch{return null;}}
export async function applyPaperRuntimeConsent(db:Database.Database,context:OperationContext,actor:Actor,id:string,receipt:unknown,now=Date.now()){
 try{identity(db);const c=capture(context,actor,now);if(!token(receipt))fail();const receiptHash=sha(receipt);return await sql().tx(function*(){
  const saved=currentReview(db,c,actor,id,now,true),r=saved.row,d=saved.definition;
  if(db.prepare('SELECT 1 FROM main.paper_runtime_events WHERE review_id=?').get(id))return publicConsent(history(db,c.userId,d.consentId,now,receiptHash),true);
  currentReview(db,c,actor,id,now);if(db.prepare('SELECT 1 FROM main.paper_runtime_consents WHERE owner_id=? AND bot_id=?').get(c.userId,d.dispatch.botId)||db.prepare('SELECT 1 FROM main.paper_dispatch_definitions WHERE id=?').get(d.definitionId))fail();
  if(!(yield* consumeOperationReceiptStep(receipt,c,operation(r),now)))fail();
  const journal=provisionTrustedPaperDispatchDefinitionInTransaction(db,c.userId,{definitionId:d.definitionId,definition:d.dispatch},now);if(journal.replayed||journal.definitionDigest!==d.dispatchDigest||journal.createdAt!==now||journal.attemptCount!==0||journal.lastClaimAt!==null)fail();
  db.prepare('INSERT INTO main.paper_runtime_consents VALUES(?,?,?,?,?,?,?,?)').run(d.consentId,id,c.userId,d.dispatch.botId,d.definitionId,d.dispatchDigest,now,'granted');
  const e={id:randomUUID(),review_id:id,consent_id:d.consentId,owner_id:c.userId,session_hash:c.sessionHash,token_version:c.tokenVersion,factor_version:c.factorVersion,policy_version:r.policy_version,definition_hash:r.definition_hash,review_hash:r.review_hash,receipt_hash:receiptHash,created_at:now};
  db.prepare('INSERT INTO main.paper_runtime_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...eventFields.map(k=>e[k as keyof typeof e]),eventHash(e));
  if(db.prepare("UPDATE main.paper_runtime_reviews SET status='applied' WHERE id=? AND status='staged'").run(id).changes!==1)fail();
  if(savedBinding(d)==='base')assertNoPaperExecutionOverlay(db,c.userId);
  if(active(db,c,actor,now)!==r.policy_version||JSON.stringify(definition(db,c.userId,{botId:d.dispatch.botId,strategy:d.dispatch.strategy,limits:d.dispatch.limits},d.consentId,d.definitionId,now,false,savedBinding(d)))!==r.definition_json)fail();
  return publicConsent(history(db,c.userId,d.consentId,now,receiptHash),false);
 },{immediate:true});}catch{return deny();}
}
/** Historical consent read is not a current runtime eligibility decision. No journal fencing token is disclosed. */
export function readPaperRuntimeConsent(db:Database.Database,actor:Actor,id:string,now=Date.now()){
 try{identity(db);return db.transaction(()=>{const {ownerId}=human(db,actor,now);return publicConsent(history(db,ownerId,id,now));}).deferred();}catch{return deny();}
}
/** Minimal persisted reference for emergency revocation. It proves neither execution eligibility nor intact grant history. */
export function readPaperRuntimeConsentReference(db:Database.Database,actor:Actor,botId:string,now=Date.now()){
 try{
  identity(db);
  return db.transaction(()=>{
   const {ownerId}=human(db,actor,now);if(!uuid(botId))fail();
   const rows=db.prepare('SELECT * FROM main.paper_runtime_consents WHERE owner_id=? AND bot_id=? LIMIT 2').all(ownerId,botId) as Record<string,unknown>[];
   if(rows.length!==1)fail();const consent=rows[0];
   if(!uuid(consent.id)||consent.owner_id!==ownerId||consent.bot_id!==botId||!uuid(consent.review_id)||!uuid(consent.definition_id)||!hash(consent.definition_digest)||!uint(consent.created_at,1)||consent.created_at>now||!['granted','revoked'].includes(consent.status as string))fail();
   const revocation=db.prepare('SELECT * FROM main.paper_runtime_revocations WHERE consent_id=?').get(consent.id) as Record<string,unknown>|undefined;
   if(consent.status==='revoked'){
    if(!revocation||!uuid(revocation.id)||revocation.consent_id!==consent.id||revocation.owner_id!==ownerId||!uint(revocation.created_at,1)||revocation.created_at<consent.created_at||revocation.created_at>now||revokeHash(revocation)!==revocation.event_hash)fail();
   }else if(revocation)fail();
   return Object.freeze({ok:true as const,consentId:consent.id,botId,status:consent.status as 'granted'|'revoked',createdAt:consent.created_at,runtimeConnected:false as const});
  }).deferred();
 }catch{return deny();}
}
/** Emergency one-way revocation deliberately does not depend on journal or proof integrity. */
export function revokePaperRuntimeConsent(db:Database.Database,actor:Actor,id:string,now=Date.now()){
 try{
  identity(db);
  return db.transaction(()=>{
   const {ownerId}=human(db,actor,now);
   if(!uuid(id))fail();
   const consent=db.prepare('SELECT * FROM main.paper_runtime_consents WHERE id=? AND owner_id=?').get(id,ownerId) as Record<string,unknown>|undefined;
   if(!consent||consent.id!==id||!uuid(consent.review_id)||!uuid(consent.bot_id)||!uuid(consent.definition_id)||!hash(consent.definition_digest)||!uint(consent.created_at,1)||consent.created_at>now||!['granted','revoked'].includes(consent.status as string))fail();
   const existing=db.prepare('SELECT * FROM main.paper_runtime_revocations WHERE consent_id=?').get(id) as Record<string,unknown>|undefined;
   const valid=(r:Record<string,unknown>)=>uuid(r.id)&&r.consent_id===id&&r.owner_id===ownerId&&uint(r.created_at,1)&&r.created_at>=Number(consent.created_at)&&r.created_at<=now&&revokeHash(r)===r.event_hash;
   if(consent.status==='revoked'){
    if(!existing||!valid(existing))fail();
    return Object.freeze({ok:true as const,consentId:id,status:'revoked' as const,revokedAt:existing.created_at as number,replayed:true,runtimeConnected:false as const});
   }
   if(existing)fail();
   const r={id:randomUUID(),consent_id:id,owner_id:ownerId,created_at:now};
   db.prepare('INSERT INTO main.paper_runtime_revocations VALUES(?,?,?,?,?)').run(r.id,r.consent_id,r.owner_id,r.created_at,revokeHash(r));
   if(db.prepare("UPDATE main.paper_runtime_consents SET status='revoked' WHERE id=? AND owner_id=? AND status='granted'").run(id,ownerId).changes!==1)fail();
   const after=db.prepare('SELECT * FROM main.paper_runtime_revocations WHERE consent_id=?').get(id) as Record<string,unknown>|undefined;
   const saved=db.prepare('SELECT * FROM main.paper_runtime_consents WHERE id=? AND owner_id=?').get(id,ownerId) as Record<string,unknown>|undefined;
   if(!after||!valid(after)||after.id!==r.id||after.created_at!==now||!saved||saved.status!=='revoked'||Object.keys(consent).some(k=>k!=='status'&&consent[k]!==saved[k]))fail();
   human(db,actor,now);
   return Object.freeze({ok:true as const,consentId:id,status:'revoked' as const,revokedAt:now,replayed:false,runtimeConnected:false as const});
  }).immediate();
 }catch{return deny();}
}

/** Trusted composition read only. Requires the caller's SQLite transaction; returns no dispatch authority or fence. */
export function readTrustedPaperRuntimeConsentInTransaction(db:Database.Database,consentId:string,now:number){
 if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!db.inTransaction||!uuid(consentId)||!uint(now,1))fail();
 schema(db);
 const row=db.prepare('SELECT owner_id FROM main.paper_runtime_consents WHERE id=?').get(consentId) as {owner_id:string}|undefined;
 if(!row)fail();
 const actor:Actor={kind:'user',role:'owner',userId:row.owner_id};
 human(db,actor,now);
 const h=history(db,row.owner_id,consentId,now),d=h.saved.definition;
 return Object.freeze({ownerId:row.owner_id,consentId,definitionId:d.definitionId,definitionDigest:d.dispatchDigest,currency:d.currency,runtimePrincipal:principal,status:h.consent.status as 'granted'|'revoked',createdAt:h.consent.created_at as number,reviewCreatedAt:h.saved.row.created_at,definition:h.journal.definition,journal:h.journal,runtimeConnected:false as const});
}
/** Trusted current gate, not a public grant. Caller must own BEGIN IMMEDIATE at the actual effects boundary. */
export function assertPaperRuntimeEligibilityInTransaction(db:Database.Database,consentId:string,now:number,allowExhausted=false){
 if(typeof allowExhausted!=='boolean')fail();
 const snapshot=readTrustedPaperRuntimeConsentInTransaction(db,consentId,now);
 if(snapshot.status!=='granted')fail();
 const h=history(db,snapshot.ownerId,consentId,now),d=h.saved.definition;
 const current=definition(db,snapshot.ownerId,{botId:d.dispatch.botId,strategy:d.dispatch.strategy,limits:d.dispatch.limits},d.consentId,d.definitionId,now,allowExhausted,savedBinding(d));
 if(JSON.stringify(current)!==h.saved.row.definition_json)fail();
 return snapshot;
}
/**
 * Offline bounded storage audit only. Reuses original review/proof/journal validation without current execution
 * eligibility. Missing/partial storage or orphan applied grants refuse; no initializer, repair or absence grant.
 */
export function inspectPaperRuntimeStorageInTransaction(db:Database.Database,ownerId:string,now:number){
 if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!db.inTransaction)fail();
 human(db,{kind:'user',role:'owner',userId:ownerId},now);
 const reviews=db.prepare('SELECT id FROM main.paper_runtime_reviews WHERE owner_id=? ORDER BY created_at,id LIMIT 1001').all(ownerId) as {id:string}[];
 const consents=db.prepare('SELECT id FROM main.paper_runtime_consents WHERE owner_id=? ORDER BY created_at,id LIMIT 1001').all(ownerId) as {id:string}[];
 if(reviews.length>1000||consents.length>1000)fail();
 for(const r of reviews)savedReview(db,ownerId,r.id,now);
 if(db.prepare("SELECT 1 FROM main.paper_runtime_reviews r WHERE r.owner_id=? AND r.status='applied' AND NOT EXISTS(SELECT 1 FROM main.paper_runtime_consents c WHERE c.owner_id=r.owner_id AND c.review_id=r.id) LIMIT 1").get(ownerId)
  ||db.prepare('SELECT 1 FROM main.paper_runtime_events e WHERE e.owner_id=? AND NOT EXISTS(SELECT 1 FROM main.paper_runtime_consents c WHERE c.owner_id=e.owner_id AND c.id=e.consent_id AND c.review_id=e.review_id) LIMIT 1').get(ownerId)
  ||db.prepare('SELECT 1 FROM main.paper_runtime_revocations r WHERE r.owner_id=? AND NOT EXISTS(SELECT 1 FROM main.paper_runtime_consents c WHERE c.owner_id=r.owner_id AND c.id=r.consent_id) LIMIT 1').get(ownerId))fail();
 return Object.freeze(consents.map(c=>{
  const h=history(db,ownerId,c.id,now),d=h.saved.definition;
  return Object.freeze({consentId:d.consentId,botId:d.dispatch.botId,installationId:d.dispatch.installationId,manifestDigest:d.dispatch.manifestDigest,status:h.consent.status as 'granted'|'revoked',createdAt:h.consent.created_at as number});
 }));
}

/** Internal offline preservation digest. Full original consent proof/history and journal are validated first. */
export function fingerprintPaperRuntimeHistoryInTransaction(db:Database.Database,ownerId:string,consentId:string,now:number){
 if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!db.inTransaction||!uint(now,1))fail();
 schema(db);human(db,{kind:'user',role:'owner',userId:ownerId},now);const h=history(db,ownerId,consentId,now);
 return sha(JSON.stringify(['paper-runtime-full-preservation-v1',h.provenanceFingerprint,fingerprintPaperDispatchHistoryInTransaction(db,ownerId,h.saved.definition.definitionId,now)]));
}

/** Original proved consent provenance independent of later attempt suffixes and later legitimate revocation. */
export function readPaperRuntimePreservationInTransaction(db:Database.Database,ownerId:string,consentId:string,now:number){
 if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!db.inTransaction||!uint(now,1))fail();schema(db);human(db,{kind:'user',role:'owner',userId:ownerId},now);
 const h=history(db,ownerId,consentId,now);return Object.freeze({immutableProvenanceFingerprint:h.immutableProvenanceFingerprint,revocationFingerprint:h.revocationFingerprint});
}

/** Original v1 staging remains pre-overlay only, so no late unbound legacy grant is created. */
export async function stagePaperRuntimeConsent(db:Database.Database,context:OperationContext,actor:Actor,value:unknown,now=Date.now()){return stageRuntime(db,context,actor,value,now,false);}
/** Separate explicit effective-binding staging. Same runtime proof domain, one-ever bot consent and explicit apply. */
export async function stageEffectivePaperRuntimeConsent(db:Database.Database,context:OperationContext,actor:Actor,value:unknown,now=Date.now()){return stageRuntime(db,context,actor,value,now,true);}
