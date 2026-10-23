/** Internal execution-upgrade review and proof only. No apply, consumption, installation writes or runtime connection. */
import {assertNoPaperExecutionOverlay} from './trading-paper-execution-overlay-schema.js';
import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import type {Actor} from '../repositories/actor.js';
import {sql} from '../repositories/sql-steps.js';
import {issueOperationChallenge,completeOperationChallenge,type OperationContext,type PaperExecutionUpgradeOperation} from '../auth/verification/operation-proof.js';
import {readPaperDispatchPreservationPrefixInTransaction} from './trading-paper-dispatch-attempts.js';
import {readPaperRuntimePreservationInTransaction,readTrustedPaperRuntimeConsentInTransaction} from './trading-paper-runtime-consent.js';
import {readPaperExecutionUpgradeAffectedSetInTransaction} from './trading-paper-execution-upgrade.js';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const uint=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
function fail():never{throw Error('paper execution upgrade review unavailable');}
const deny=()=>Object.freeze({ok:false as const,reason:'unavailable' as const});
function plain(value:unknown,keys:readonly string[]):value is Record<string,unknown>{
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
 const own=Reflect.ownKeys(value);return own.length===keys.length&&own.every(k=>typeof k==='string'&&keys.includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)!,'value'));
}
const reviewSQL=`CREATE TABLE IF NOT EXISTS paper_execution_upgrade_reviews(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_hash TEXT NOT NULL,token_version INTEGER NOT NULL,factor_version INTEGER NOT NULL,policy_version INTEGER NOT NULL,definition_json TEXT NOT NULL,definition_hash TEXT NOT NULL,review_hash TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL CHECK(status='staged'));`;
type ObjectRow={type:string;name:string;tbl_name:string;sql:string|null};
const objects=(db:Database.Database,temp=false)=>db.prepare(`SELECT type,name,tbl_name,sql FROM ${temp?'sqlite_temp_master':'sqlite_master'} WHERE type IN ('table','index','view','trigger') ORDER BY type,name`).all() as ObjectRow[];
const reference=new Database(':memory:');let expected:readonly ObjectRow[];
try{reference.exec(reviewSQL);expected=Object.freeze(objects(reference).map(r=>Object.freeze({...r})));}finally{reference.close();}
const names=new Set(expected.map(r=>r.name)),authNames=new Set(['users','verification_factors','verification_challenges','verification_receipts','approval_proof_policy']);
function identity(db:Database.Database,writable=true){if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||db.inTransaction||writable&&db.pragma('query_only',{simple:true})!==0)fail();}
function schema(db:Database.Database,complete=true){
 const related=(r:ObjectRow)=>names.has(r.name.toLowerCase())||names.has(r.tbl_name.toLowerCase());
 if(objects(db,true).some(r=>related(r)||authNames.has(r.name.toLowerCase())||authNames.has(r.tbl_name.toLowerCase())))fail();
 const found=objects(db).filter(related);
 for(const r of found){const wanted=expected.find(e=>e.name===r.name);if(!wanted||JSON.stringify(r)!==JSON.stringify(wanted))fail();}
 if(complete&&found.length!==expected.length)fail();
}
function capture(context:OperationContext,actor:Actor,now:number){
 if(!context||!actor||actor.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==context.userId||typeof context.userId!=='string'||!context.userId||context.userId.length>128||/[\x00-\x20\x7f]/.test(context.userId)||isSystemAccount(context.userId)||typeof context.sessionHash!=='string'||context.sessionHash.length!==64||!/^[a-f0-9]{64}$/.test(context.sessionHash)||!uint(context.tokenVersion,1)||!uint(context.factorVersion,1)||!uint(now,1)||now>Number.MAX_SAFE_INTEGER-300000)fail();
 return Object.freeze({userId:context.userId,sessionHash:context.sessionHash,tokenVersion:context.tokenVersion,factorVersion:context.factorVersion});
}
function input(value:unknown){
 if(!plain(value,['expectedRevision','targetManifestDigest'])||!uint(value.expectedRevision,1)||typeof value.targetManifestDigest!=='string'||value.targetManifestDigest.length!==64||!/^[a-f0-9]{64}$/.test(value.targetManifestDigest))fail();
 return Object.freeze({expectedRevision:value.expectedRevision,targetManifestDigest:value.targetManifestDigest});
}
function active(db:Database.Database,c:OperationContext){
 schema(db);const u=db.prepare('SELECT role,status,email_verified,token_version FROM main.users WHERE id=?').get(c.userId) as Record<string,unknown>|undefined;
 const f=db.prepare('SELECT enabled,version FROM main.verification_factors WHERE user_id=?').get(c.userId) as Record<string,unknown>|undefined;
 const p=db.prepare('SELECT version FROM main.approval_proof_policy WHERE id=1').get() as {version:number}|undefined;
 if(u?.role!=='owner'||u.status!=='active'||u.email_verified!==1||u.token_version!==c.tokenVersion||f?.enabled!==1||f.version!==c.factorVersion||!p||!uint(p.version,1))fail();return p.version;
}
function target(db:Database.Database,c:OperationContext,actor:Actor,request:ReturnType<typeof input>,now:number){
 const affected=readPaperExecutionUpgradeAffectedSetInTransaction(db,{kind:'user',role:'owner',userId:c.userId},request,now);
 if(!affected.ok||!('affectedSetDigest' in affected)||affected.blocked)fail();
 const retained=Object.freeze(affected.consents.map(saved=>{const consent=readTrustedPaperRuntimeConsentInTransaction(db,saved.consentId,now),d=consent.definition;return Object.freeze({preservationPrefix:readPaperDispatchPreservationPrefixInTransaction(db,c.userId,saved.definitionId,saved.attemptCount,now),runtimePreservation:readPaperRuntimePreservationInTransaction(db,c.userId,saved.consentId,now),consentId:saved.consentId,botId:d.botId,currency:consent.currency,amountUnit:d.strategy.side==='buy'?'account_minor_units':'whole_asset_units',strategy:Object.freeze({...d.strategy}),status:saved.status,attemptsConsumed:saved.attemptCount,maxAttempts:d.limits.maxAttempts,cadenceMs:d.limits.cadenceMs,expiresAt:d.limits.expiresAt});}));
 return Object.freeze({version:1,ownerId:c.userId,request,retained,addedCapabilities:Object.freeze(['paper.runtime.execute']),affected,canApply:false,runtimeConnected:false,executionGranted:false});
}
type Review={id:string;owner_id:string;session_hash:string;token_version:number;factor_version:number;policy_version:number;definition_json:string;definition_hash:string;review_hash:string;created_at:number;expires_at:number;status:string};
const reviewHash=(r:Review)=>sha(JSON.stringify(['paper-execution-upgrade-review-v1',r.id,r.owner_id,r.session_hash,r.token_version,r.factor_version,r.policy_version,r.definition_hash,r.created_at,r.expires_at]));
// A bounded 1000-consent set is permitted; raw attempts, proof tokens, sessions and fences are never embedded.
const maxDefinitionBytes=1048576;
function row(db:Database.Database,c:OperationContext,actor:Actor,id:string,now:number,historical=false){
 if(!uuid(id))fail();schema(db);if(!historical)assertNoPaperExecutionOverlay(db,c.userId);const version=historical?undefined:active(db,c),r=db.prepare('SELECT * FROM main.paper_execution_upgrade_reviews WHERE id=? AND owner_id=?').get(id,c.userId) as Review|undefined;
 if(!r||r.status!=='staged'||r.session_hash!==c.sessionHash||r.token_version!==c.tokenVersion||r.factor_version!==c.factorVersion||(!historical&&r.policy_version!==version)||!uint(r.created_at,1)||r.created_at>now||!uint(r.expires_at,1)||r.expires_at-r.created_at!==300000||(!historical&&r.expires_at<=now)||typeof r.definition_json!=='string'||Buffer.byteLength(r.definition_json,'utf8')>maxDefinitionBytes||sha(r.definition_json)!==r.definition_hash||reviewHash(r)!==r.review_hash)fail();
 const d=JSON.parse(r.definition_json);if(!plain(d,['version','ownerId','request','retained','addedCapabilities','affected','canApply','runtimeConnected','executionGranted'])||d.version!==1||d.ownerId!==c.userId||JSON.stringify(d)!==r.definition_json)fail();
 if(!uint(r.policy_version,1))fail();
 if(historical)return {row:r,definition:d as unknown as ReturnType<typeof target>};
 const current=target(db,c,actor,input(d.request),now);if(JSON.stringify(current)!==r.definition_json)fail();return {row:r,definition:current};
}
function publicReview(r:ReturnType<typeof row>){return Object.freeze({ok:true as const,id:r.row.id,createdAt:r.row.created_at,expiresAt:r.row.expires_at,addedCapabilities:r.definition.addedCapabilities,retained:r.definition.retained,affected:r.definition.affected,canApply:false as const,runtimeConnected:false as const,executionGranted:false as const,startsWorker:false as const});}
const operation=(r:Review):PaperExecutionUpgradeOperation=>({kind:'paper_execution_upgrade',reviewId:r.id,reviewHash:r.review_hash,reviewExpiresAt:r.expires_at,policyVersion:r.policy_version});
/** Explicit isolated review storage only; never initializes installation, consent or dispatch schemas. */
export function initializePaperExecutionUpgradeReviews(db:Database.Database){identity(db);db.transaction(()=>{schema(db,false);db.exec(reviewSQL);schema(db);}).immediate();}
export async function stagePaperExecutionUpgradeReview(db:Database.Database,context:OperationContext,actor:Actor,value:unknown,now=Date.now()){
 try{identity(db);const c=capture(context,actor,now),request=input(value),id=randomUUID();return await sql().tx(function*(){
  assertNoPaperExecutionOverlay(db,c.userId);const version=active(db,c),definition=JSON.stringify(target(db,c,actor,request,now));if(Buffer.byteLength(definition,'utf8')>maxDefinitionBytes)fail();
  const count=db.prepare('SELECT count(*) n FROM main.paper_execution_upgrade_reviews WHERE owner_id=? AND expires_at>?').get(c.userId,now) as {n:number};if(count.n>=8)fail();
  const r:Review={id,owner_id:c.userId,session_hash:c.sessionHash,token_version:c.tokenVersion,factor_version:c.factorVersion,policy_version:version,definition_json:definition,definition_hash:sha(definition),review_hash:'',created_at:now,expires_at:now+300000,status:'staged'};r.review_hash=reviewHash(r);
  db.prepare('INSERT INTO main.paper_execution_upgrade_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(r.id,r.owner_id,r.session_hash,r.token_version,r.factor_version,r.policy_version,r.definition_json,r.definition_hash,r.review_hash,r.created_at,r.expires_at,r.status);return publicReview(row(db,c,actor,id,now));
 },{immediate:true});}catch{return deny();}
}
export async function readPaperExecutionUpgradeReview(db:Database.Database,context:OperationContext,actor:Actor,id:string,now=Date.now()){
 try{identity(db,false);const c=capture(context,actor,now);return db.transaction(()=>publicReview(row(db,c,actor,id,now))).deferred();}catch{return deny();}
}
async function proof(db:Database.Database,context:OperationContext,actor:Actor,id:string,now:number){identity(db);const c=capture(context,actor,now);return sql().tx(function*(){return {context:c,operation:operation(row(db,c,actor,id,now).row)};},{immediate:true});}
export async function issuePaperExecutionUpgradeProof(db:Database.Database,c:OperationContext,a:Actor,id:string,now=Date.now()){
 try{const p=await proof(db,c,a,id,now),result=await issueOperationChallenge(p.context,p.operation,now);await proof(db,p.context,a,id,now);return result;}catch{return null;}
}
export async function completePaperExecutionUpgradeProof(db:Database.Database,c:OperationContext,a:Actor,id:string,challenge:unknown,code:unknown,now=Date.now()){
 try{const p=await proof(db,c,a,id,now),result=await completeOperationChallenge(challenge,p.context,p.operation,code,now);await proof(db,p.context,a,id,now);return result;}catch{return null;}
}

/** Trusted composition only: historical mode verifies immutable review bytes/binding, never current execution authority. */
export function readPaperExecutionUpgradeReviewInTransaction(db:Database.Database,context:OperationContext,actor:Actor,id:string,now:number,historical=false){
 if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!db.inTransaction||typeof historical!=='boolean')fail();
 const c=capture(context,actor,now),saved=row(db,c,actor,id,now,historical);
 return {row:Object.freeze({...saved.row}),definition:saved.definition,context:c,operation:operation(saved.row)};
}
