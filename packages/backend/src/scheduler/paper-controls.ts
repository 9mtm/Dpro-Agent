/** Internal owner controls only. No engine observation, timer registration, initialization or new proof grant. */
import type Database from 'better-sqlite3';
import type {Actor} from '../repositories/actor.js';
import type {OperationContext} from '../auth/verification/operation-proof.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {readPaperRuntimeOwnerReferenceInTransaction} from '../services/trading-paper-runtime-consent.js';
import {capturePaperRuntimeAction} from './authorization-definition.js';
import {inspectPausedPaperScheduleAdmissionInTransaction} from './authorization.js';
import {rowToJob,type CronJobRow} from './store.js';
function fail():never{throw Error('paper schedule control unavailable');}
const deny=()=>Object.freeze({ok:false as const,reason:'unavailable' as const});
const uint=(v:unknown,min=1):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
function plain(v:unknown,keys:readonly string[]):v is Record<string,unknown>{
 if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return false;
 const own=Reflect.ownKeys(v);return own.length===keys.length&&own.every(k=>typeof k==='string'&&keys.includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value'));
}
function captured(context:OperationContext,actor:Actor,granting=false){
 if(!plain(actor,['kind','role','userId'])||actor.kind!=='user'||actor.role!=='owner'||typeof actor.userId!=='string'||!actor.userId||actor.userId.length>128||/[\x00-\x20\x7f]/.test(actor.userId)||isSystemAccount(actor.userId)||!plain(context,['userId','sessionHash','tokenVersion','factorVersion'])||context.userId!==actor.userId||!hash(context.sessionHash)||!uint(context.tokenVersion)||!uint(context.factorVersion,granting?1:0))fail();
 return Object.freeze({userId:actor.userId,sessionHash:context.sessionHash,tokenVersion:context.tokenVersion,factorVersion:context.factorVersion});
}
function request(value:unknown,enable=false){
 const keys=enable?['jobId','jobRevision','authorizationRevision','definitionHash']:['jobId'];if(!plain(value,keys)||!uuid(value.jobId))fail();
 if(enable&&(!uint(value.jobRevision)||value.jobRevision>2147483647||!uint(value.authorizationRevision)||value.authorizationRevision>2147483647||!hash(value.definitionHash)))fail();
 return Object.freeze({jobId:value.jobId,...(enable?{jobRevision:value.jobRevision as number,authorizationRevision:value.authorizationRevision as number,definitionHash:value.definitionHash as string}:{})});
}
function clock(now?:number){const value=now===undefined?Date.now():now;if(!uint(value))fail();return value;}
function identity(db:Database.Database,writable:boolean){if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||db.inTransaction||!db.open||writable&&db.pragma('query_only',{simple:true})!==0)fail();}
const columns={users:['id','role','status','email_verified','token_version'],cron_jobs:['id','name','description','cron_expression','action_type','action_data','enabled','last_run','next_run','created_at','updated_at']} as const;
function schema(db:Database.Database){
 for(const [table,fields] of Object.entries(columns)){
  if(db.prepare('SELECT 1 FROM sqlite_temp_master WHERE name=? COLLATE NOCASE OR tbl_name=? COLLATE NOCASE LIMIT 1').get(table,table)||!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(table)||db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='trigger' AND tbl_name=? COLLATE NOCASE LIMIT 1").get(table))fail();
  const primary=(db.prepare(`PRAGMA main.table_info(${table})`).all() as {name:string;pk:number}[]).filter(r=>r.pk>0);if(primary.length!==1||primary[0].name!=='id'||primary[0].pk!==1)fail();db.prepare(`SELECT ${fields.join(',')} FROM main.${table} LIMIT 0`).all();
 }
}
type Context=ReturnType<typeof captured>;
function owned(db:Database.Database,c:Context,id:string,now:number){
 schema(db);const user=db.prepare('SELECT role,status,email_verified,token_version FROM main.users WHERE id=?').get(c.userId) as Record<string,unknown>|undefined;
 if(user?.role!=='owner'||user.status!=='active'||user.email_verified!==1||user.token_version!==c.tokenVersion)fail();
 const row=db.prepare('SELECT * FROM main.cron_jobs WHERE id=?').get(id) as CronJobRow|undefined;if(!row||row.id!==id||row.action_type!=='paper-runtime-cycle'||![0,1].includes(row.enabled))fail();
 const action=capturePaperRuntimeAction(JSON.parse(row.action_data)),reference=readPaperRuntimeOwnerReferenceInTransaction(db,c.userId,action.consentId,now);
 return {row,reference};
}
const unobserved=Object.freeze({registration:'not_observed' as const,runtimeConnection:'not_observed' as const});
function admitted(db:Database.Database,c:Context,id:string,now:number){
 const value=owned(db,c,id,now),admission=inspectPausedPaperScheduleAdmissionInTransaction(db,rowToJob('sqlite',value.row),c.userId,now);
 const grant=db.prepare('SELECT session_hash,token_version,factor_version FROM main.scheduled_job_authorizations WHERE job_id=?').get(id) as Record<string,unknown>|undefined;
 // Activation is deliberately restricted to the original proof session; a new session needs reauthorization.
 if(grant?.session_hash!==c.sessionHash||grant.token_version!==c.tokenVersion||grant.factor_version!==c.factorVersion)fail();
 return {...value,admission};
}
/** Exact saved-state activation only. Current original proof is reused, never consumed again or replaced. */
export function enablePaperSchedule(db:Database.Database,context:OperationContext,actor:Actor,value:unknown,nowOverride?:number){
 try{const c=captured(context,actor,true),r=request(value,true);identity(db,true);
  return db.transaction(()=>{const now=clock(nowOverride),before=admitted(db,c,r.jobId,now),a=before.admission;
   if(a.jobRevision!==r.jobRevision||a.authorizationRevision!==r.authorizationRevision||a.definitionHash!==r.definitionHash)fail();
   const replayed=before.row.enabled===1;if(!replayed&&db.prepare("UPDATE main.cron_jobs SET enabled=1 WHERE id=? AND enabled=0 AND action_type='paper-runtime-cycle'").run(r.jobId).changes!==1)fail();
   const afterNow=clock(nowOverride);if(afterNow<now)fail();const after=admitted(db,c,r.jobId,afterNow);
   if(after.row.enabled!==1||after.reference.consentId!==before.reference.consentId||after.admission.jobRevision!==a.jobRevision||after.admission.authorizationRevision!==a.authorizationRevision||after.admission.definitionHash!==a.definitionHash||after.admission.expiresAt!==a.expiresAt)fail();
   return Object.freeze({ok:true as const,jobId:r.jobId,consentId:after.reference.consentId,savedEnabled:true as const,authorization:'authorized' as const,jobRevision:a.jobRevision,authorizationRevision:a.authorizationRevision,definitionHash:a.definitionHash,replayed,...unobserved});
  }).immediate();
 }catch{return deny();}
}
/** Risk-reducing stop requires current human ownership/token, not intact execution proofs or an enabled factor. */
export function disablePaperSchedule(db:Database.Database,context:OperationContext,actor:Actor,value:unknown,nowOverride?:number){
 try{const c=captured(context,actor),r=request(value);identity(db,true);
  return db.transaction(()=>{const now=clock(nowOverride),before=owned(db,c,r.jobId,now),replayed=before.row.enabled===0;
   if(!replayed&&db.prepare("UPDATE main.cron_jobs SET enabled=0 WHERE id=? AND enabled=1 AND action_type='paper-runtime-cycle'").run(r.jobId).changes!==1)fail();
   const afterNow=clock(nowOverride);if(afterNow<now)fail();const after=owned(db,c,r.jobId,afterNow);
   if(after.row.enabled!==0||after.reference.consentId!==before.reference.consentId||after.row.action_data!==before.row.action_data)fail();
   return Object.freeze({ok:true as const,jobId:r.jobId,consentId:after.reference.consentId,savedEnabled:false as const,authorization:'not_checked' as const,replayed,...unobserved});
  }).immediate();
 }catch{return deny();}
}
function readControlSnapshot(db:Database.Database,c:Context,r:ReturnType<typeof request>,now:number){
 const current=owned(db,c,r.jobId,now);let authorization:'authorized'|'unavailable'='unavailable',metadata:Partial<{jobRevision:number;authorizationRevision:number;definitionHash:string}>={};
 try{const a=inspectPausedPaperScheduleAdmissionInTransaction(db,rowToJob('sqlite',current.row),c.userId,now);authorization='authorized';metadata={jobRevision:a.jobRevision,authorizationRevision:a.authorizationRevision,definitionHash:a.definitionHash};}catch{/* Owned saved state remains observable when execution authority is unavailable. */}
 return Object.freeze({ok:true as const,jobId:r.jobId,consentId:current.reference.consentId,savedEnabled:current.row.enabled===1,authorization,...metadata,...unobserved});
}
/** Read-only saved state. Physical registration/connection belong to a separately owned engine, never inferred here. */
export function readPaperScheduleControl(db:Database.Database,context:OperationContext,actor:Actor,value:unknown,nowOverride?:number){
 try{const c=captured(context,actor),r=request(value);identity(db,false);return db.transaction(()=>readControlSnapshot(db,c,r,clock(nowOverride))).deferred();}catch{return deny();}
}
/** Trusted read composition only; caller owns one snapshot. Same ownership/schema checks as the public read. */
export function readPaperScheduleControlInTransaction(db:Database.Database,context:OperationContext,actor:Actor,value:unknown,now:number){
 try{const c=captured(context,actor),r=request(value);if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!db.open||!db.inTransaction)fail();return readControlSnapshot(db,c,r,clock(now));}catch{return deny();}
}
