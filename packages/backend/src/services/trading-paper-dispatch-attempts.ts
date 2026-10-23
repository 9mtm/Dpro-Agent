/** Internal provider-free bookkeeping only. No consent, runtime activation, scheduler or trade effect. */
import Database from 'better-sqlite3';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import {capturePaperDispatchDefinition} from './trading-paper-dispatch-contract.js';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const uint=(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
const id=(value:unknown):value is string=>typeof value==='string'&&value.length<=128&&!/[\x00-\x20\x7f]/.test(value)&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const digest=(value:unknown):value is string=>typeof value==='string'&&value.length===64&&/^[a-f0-9]{64}$/.test(value);
const fence=(value:unknown):value is string=>typeof value==='string'&&value.length===43&&/^[A-Za-z0-9_-]{43}$/.test(value);
function plain(value:unknown,keys:string[]):value is Record<string,unknown>{
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
 const own=Reflect.ownKeys(value);return own.length===keys.length&&own.every(key=>typeof key==='string'&&keys.includes(key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));
}
function fail():never{throw Error('paper dispatch journal unavailable');}
const deny=(reason='unavailable')=>({ok:false as const,reason});
const schemaSQL=`CREATE TABLE IF NOT EXISTS paper_dispatch_definitions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,digest TEXT NOT NULL,canonical_json TEXT NOT NULL,created_at INTEGER NOT NULL,attempt_count INTEGER NOT NULL,last_claim_at INTEGER,UNIQUE(owner_id,digest));
CREATE TABLE IF NOT EXISTS paper_dispatch_attempts(id TEXT PRIMARY KEY,definition_id TEXT NOT NULL,owner_id TEXT NOT NULL,attempt_key TEXT NOT NULL,sequence INTEGER NOT NULL,lease_ms INTEGER NOT NULL,request_json TEXT NOT NULL,request_hash TEXT NOT NULL,fence_token TEXT NOT NULL,claimed_at INTEGER NOT NULL,lease_until INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','completed','failed','unknown')),finished_at INTEGER,event_hash TEXT NOT NULL,UNIQUE(owner_id,attempt_key),UNIQUE(definition_id,sequence));
CREATE UNIQUE INDEX IF NOT EXISTS paper_dispatch_single_pending ON paper_dispatch_attempts(definition_id) WHERE status='pending';`;
type ObjectRow={type:string;name:string;tbl_name:string;sql:string|null};
const objects=(db:Database.Database,temp=false)=>db.prepare(`SELECT type,name,tbl_name,sql FROM ${temp?'sqlite_temp_master':'sqlite_master'} WHERE type IN ('table','index','view','trigger') ORDER BY type,name`).all() as ObjectRow[];
const reference=new Database(':memory:');let expected:readonly ObjectRow[];
try{reference.exec(schemaSQL);expected=Object.freeze(objects(reference).map(row=>Object.freeze({...row})));}finally{reference.close();}
const names=new Set(expected.map(row=>row.name.toLowerCase())),tables=new Set(['paper_dispatch_definitions','paper_dispatch_attempts']);
function identity(db:Database.Database,allowTransaction=false){if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!allowTransaction&&db.inTransaction)fail();}
function schema(db:Database.Database,complete=true){
 const related=(row:ObjectRow)=>names.has(row.name.toLowerCase())||tables.has(row.tbl_name.toLowerCase());
 if(objects(db,true).some(row=>related(row)||row.name.toLowerCase()==='users'||row.tbl_name.toLowerCase()==='users'))fail();
 const found=objects(db).filter(related);
 for(const row of found){const wanted=expected.find(item=>item.name===row.name);if(!wanted||JSON.stringify(wanted)!==JSON.stringify(row))fail();}
 if(complete&&found.length!==expected.length)fail();
}
function owner(db:Database.Database,ownerId:string){
 if(!id(ownerId)||isSystemAccount(ownerId))fail();
 const row=db.prepare('SELECT role,status,email_verified FROM main.users WHERE id=?').get(ownerId) as Record<string,unknown>|undefined;
 if(row?.role!=='owner'||row.status!=='active'||row.email_verified!==1)fail();
}
function time(override?:number){const now=override===undefined?Date.now():override;if(!uint(now,1))fail();return now;}
type DefinitionRow={id:string;owner_id:string;digest:string;canonical_json:string;created_at:number;attempt_count:number;last_claim_at:number|null};
type Status='pending'|'completed'|'failed'|'unknown';
type Attempt={id:string;definition_id:string;owner_id:string;attempt_key:string;sequence:number;lease_ms:number;request_json:string;request_hash:string;fence_token:string;claimed_at:number;lease_until:number;status:Status;finished_at:number|null;event_hash:string};
const claimFields=['definitionId','definitionDigest','attemptKey','leaseMs'];
interface Claim{definitionId:string;definitionDigest:string;attemptKey:string;leaseMs:number}
function claimInput(value:unknown):Claim{
 if(!plain(value,claimFields)||!uuid(value.definitionId)||!digest(value.definitionDigest)||!id(value.attemptKey)||!uint(value.leaseMs,1000,60000))fail();
 return {definitionId:value.definitionId,definitionDigest:value.definitionDigest,attemptKey:value.attemptKey,leaseMs:value.leaseMs};
}
const claimJSON=(ownerId:string,value:Claim)=>JSON.stringify({domain:'paper-dispatch-attempt-claim-v1',ownerId,...value});
const eventHash=(row:Omit<Attempt,'event_hash'>)=>sha(JSON.stringify(['paper-dispatch-attempt-event-v1',row.id,row.definition_id,row.owner_id,row.attempt_key,row.sequence,row.lease_ms,row.request_json,row.request_hash,row.fence_token,row.claimed_at,row.lease_until,row.status,row.finished_at]));
const leaseEnd=(claimedAt:number,leaseMs:number,expiresAt:number)=>Number(BigInt(claimedAt)+BigInt(leaseMs)>BigInt(expiresAt)?BigInt(expiresAt):BigInt(claimedAt)+BigInt(leaseMs));
function load(db:Database.Database,ownerId:string,definitionId:string,now:number){
 schema(db);owner(db,ownerId);if(!uuid(definitionId))fail();
 const row=db.prepare('SELECT * FROM main.paper_dispatch_definitions WHERE id=?').get(definitionId) as DefinitionRow|undefined;
 if(!row||row.owner_id!==ownerId||!uuid(row.id)||!digest(row.digest)||!uint(row.created_at,1)||row.created_at>now||!uint(row.attempt_count,0,1000)||typeof row.canonical_json!=='string'||Buffer.byteLength(row.canonical_json,'utf8')>8192)fail();
 const raw=JSON.parse(row.canonical_json);
 if(!plain(raw,['domain','definition'])||raw.domain!=='paper-dispatch-definition-v1')fail();
 // Original capture time validates historical definitions after their expiry; never extend expiry on replay.
 const captured=capturePaperDispatchDefinition(raw.definition,row.created_at);
 if(!captured||captured.definition.ownerId!==ownerId||captured.canonical!==row.canonical_json||captured.digest!==row.digest||row.attempt_count>captured.definition.limits.maxAttempts)fail();
 const attempts=db.prepare('SELECT * FROM main.paper_dispatch_attempts WHERE definition_id=? ORDER BY sequence LIMIT 1001').all(definitionId) as Attempt[];
 if(attempts.length!==row.attempt_count||attempts.length>captured.definition.limits.maxAttempts)fail();
 let previous:Attempt|undefined;
 for(let i=0;i<attempts.length;i++){
  const a=attempts[i],request:Claim={definitionId,definitionDigest:row.digest,attemptKey:a.attempt_key,leaseMs:a.lease_ms};
  if(!uuid(a.id)||a.definition_id!==definitionId||a.owner_id!==ownerId||!id(a.attempt_key)||a.sequence!==i+1||!uint(a.lease_ms,1000,60000)||!fence(a.fence_token)
   ||typeof a.request_json!=='string'||Buffer.byteLength(a.request_json,'utf8')>2048||a.request_json!==claimJSON(ownerId,request)||a.request_hash!==sha(a.request_json)||eventHash(a)!==a.event_hash
   ||!uint(a.claimed_at,1)||a.claimed_at<row.created_at||a.claimed_at>now||a.claimed_at>=captured.definition.limits.expiresAt||!uint(a.lease_until,1)||a.lease_until!==leaseEnd(a.claimed_at,a.lease_ms,captured.definition.limits.expiresAt)||a.lease_until<=a.claimed_at
   ||!['pending','completed','failed','unknown'].includes(a.status))fail();
  if(a.status==='pending'?(a.finished_at!==null||i!==attempts.length-1):!uint(a.finished_at,1)||a.finished_at<a.claimed_at||a.finished_at>now||a.status==='unknown'&&a.finished_at<a.lease_until||a.status!=='unknown'&&a.finished_at>=a.lease_until)fail();
  if(previous&&(previous.status==='pending'||previous.status==='unknown'||a.claimed_at-previous.claimed_at<captured.definition.limits.cadenceMs||a.claimed_at<Number(previous.finished_at)))fail();
  previous=a;
 }
 if(row.last_claim_at!==(previous?.claimed_at??null))fail();
 return {row,definition:captured.definition,attempts,pending:attempts.find(a=>a.status==='pending'),unknown:attempts.some(a=>a.status==='unknown')};
}
function projectAttempt(a:Attempt,now:number){return {attemptId:a.id,attemptKey:a.attempt_key,sequence:a.sequence,claimedAt:a.claimed_at,leaseUntil:a.lease_until,status:a.status,finishedAt:a.finished_at,leaseExpired:a.status==='pending'&&now>=a.lease_until};}
function projection(journal:ReturnType<typeof load>,now:number){
 return {ok:true as const,definitionId:journal.row.id,definitionDigest:journal.row.digest,createdAt:journal.row.created_at,expiresAt:journal.definition.limits.expiresAt,maxAttempts:journal.definition.limits.maxAttempts,cadenceMs:journal.definition.limits.cadenceMs,attemptCount:journal.row.attempt_count,lastClaimAt:journal.row.last_claim_at,blockedByUnknown:journal.unknown,attempts:journal.attempts.map(a=>projectAttempt(a,now)),journalOnly:true as const,runtimeConnected:false as const};
}
function transitionUnknown(db:Database.Database,a:Attempt,now:number){
 if(a.status!=='pending'||now<a.lease_until)fail();const updated={...a,status:'unknown' as const,finished_at:now};
 if(db.prepare("UPDATE main.paper_dispatch_attempts SET status='unknown',finished_at=?,event_hash=? WHERE id=? AND status='pending' AND fence_token=?").run(now,eventHash(updated),a.id,a.fence_token).changes!==1)fail();
}
function acknowledgment(a:Attempt,now:number,replayed:boolean,includeFence=false){return {ok:true as const,...projectAttempt(a,now),replayed,journalOnly:true as const,runtimeConnected:false as const,...(includeFence&&a.status==='pending'&&now<a.lease_until?{fenceToken:a.fence_token}:{})};}
/** Explicit journal schema only. No trading/account/install tables, activity flag or runtime binding. */
export function initializePaperDispatchAttempts(db:Database.Database){identity(db);db.transaction(()=>{schema(db,false);db.exec(schemaSQL);schema(db);}).immediate();}
/** Trusted definition capture only; hash/owner metadata is not human approval or dispatch authority. */
export function provisionTrustedPaperDispatchDefinition(db:Database.Database,ownerId:string,input:unknown,nowOverride?:number){
 try{identity(db);return db.transaction(()=>provisionTrustedPaperDispatchDefinitionInTransaction(db,ownerId,input,time(nowOverride))).immediate();}catch{return deny();}
}
/**
 * Trusted composition only. Caller owns an IMMEDIATE transaction and must roll back on every throw.
 * inTransaction cannot prove lock mode, consent or caller trust. This helper supplies none of those rights.
 */
export function provisionTrustedPaperDispatchDefinitionInTransaction(db:Database.Database,ownerId:string,input:unknown,now:number){
 identity(db,true);if(!db.inTransaction)fail();time(now);
 if(!plain(input,['definitionId','definition'])||!uuid(input.definitionId))fail();const definitionId=input.definitionId,raw=input.definition;
 schema(db);owner(db,ownerId);
 const existing=db.prepare('SELECT * FROM main.paper_dispatch_definitions WHERE id=?').get(definitionId) as DefinitionRow|undefined;
 if(existing){const journal=load(db,ownerId,definitionId,now),captured=capturePaperDispatchDefinition(raw,journal.row.created_at);if(!captured||captured.canonical!==journal.row.canonical_json)fail();return {...projection(journal,now),replayed:true};}
 const captured=capturePaperDispatchDefinition(raw,now);if(!captured||captured.definition.ownerId!==ownerId||Buffer.byteLength(captured.canonical,'utf8')>8192)fail();
 if(db.prepare('SELECT 1 FROM main.paper_dispatch_definitions WHERE owner_id=? AND digest=?').get(ownerId,captured.digest)||db.prepare('SELECT 1 FROM main.paper_dispatch_attempts WHERE definition_id=?').get(definitionId))fail();
 db.prepare('INSERT INTO main.paper_dispatch_definitions VALUES(?,?,?,?,?,?,?)').run(definitionId,ownerId,captured.digest,captured.canonical,now,0,null);
 return {...projection(load(db,ownerId,definitionId,now),now),replayed:false};
}
/** Internal validated journal read for an existing caller snapshot; never initializes or repairs anything. */
export function readTrustedPaperDispatchDefinitionInTransaction(db:Database.Database,ownerId:string,definitionId:string,now:number){
 identity(db,true);if(!db.inTransaction)fail();time(now);
 const journal=load(db,ownerId,definitionId,now);
 return Object.freeze({...projection(journal,now),definition:journal.definition});
}
/** Shared canonical bookkeeping key only; identifiers and hashes never supply dispatch authority. */
export function derivePaperRuntimeDueAttemptKey(consentId:string,definitionId:string,definitionDigest:string,sequence:number){
 if(!uuid(consentId)||!uuid(definitionId)||!digest(definitionDigest)||!uint(sequence,1,1000))fail();
 return 'due:'+sha(JSON.stringify(['paper-runtime-due-attempt-v1',consentId,definitionId,definitionDigest,sequence]));
}
/** Attempt claims consume finite budget even when they later fail. No work is dispatched here. */
export function claimPaperDispatchAttempt(db:Database.Database,ownerId:string,input:unknown,nowOverride?:number){
 return claimAttempt(db,ownerId,input,nowOverride);
}
/** Exact canonical history and requested sequence are reread under the same actual claim write lock. */
export function claimCanonicalPaperDispatchAttempt(db:Database.Database,ownerId:string,input:unknown,consentId:string,nowOverride?:number){
 if(!uuid(consentId))return deny();
 return claimAttempt(db,ownerId,input,nowOverride,consentId);
}
function claimAttempt(db:Database.Database,ownerId:string,input:unknown,nowOverride?:number,canonicalConsentId?:string){

 try{
  identity(db);const request=claimInput(input);
  return db.transaction(()=>{
   const now=time(nowOverride),journal=load(db,ownerId,request.definitionId,now);if(journal.row.digest!==request.definitionDigest)fail();
   if(canonicalConsentId){
    for(const a of journal.attempts)if(a.attempt_key!==derivePaperRuntimeDueAttemptKey(canonicalConsentId,request.definitionId,request.definitionDigest,a.sequence))fail();
    const existing=journal.attempts.find(a=>a.attempt_key===request.attemptKey);
    if(request.attemptKey!==derivePaperRuntimeDueAttemptKey(canonicalConsentId,request.definitionId,request.definitionDigest,existing?.sequence??journal.row.attempt_count+1))fail();
   }
   const reused=db.prepare('SELECT * FROM main.paper_dispatch_attempts WHERE owner_id=? AND attempt_key=?').get(ownerId,request.attemptKey) as Attempt|undefined;
   if(reused){
    if(reused.definition_id!==request.definitionId||reused.request_json!==claimJSON(ownerId,request))fail();
    const old=journal.attempts.find(a=>a.id===reused.id);if(!old)fail();
    if(old.status==='pending'&&now>=old.lease_until){transitionUnknown(db,old,now);const checked=load(db,ownerId,request.definitionId,now);return acknowledgment(checked.attempts.find(a=>a.id===old.id)!,now,true);}
    return acknowledgment(old,now,true,true);
   }
   if(journal.pending&&now>=journal.pending.lease_until){transitionUnknown(db,journal.pending,now);load(db,ownerId,request.definitionId,now);return deny('unknown');}
   if(journal.unknown)return deny('unknown');if(journal.pending)return deny('pending');
   if(now>=journal.definition.limits.expiresAt||journal.row.attempt_count>=journal.definition.limits.maxAttempts)return deny('limit');
   if(journal.row.last_claim_at!==null&&now-journal.row.last_claim_at<journal.definition.limits.cadenceMs)return deny('cadence');
   const json=claimJSON(ownerId,request),a:Omit<Attempt,'event_hash'>={id:randomUUID(),definition_id:request.definitionId,owner_id:ownerId,attempt_key:request.attemptKey,sequence:journal.row.attempt_count+1,lease_ms:request.leaseMs,request_json:json,request_hash:sha(json),fence_token:randomBytes(32).toString('base64url'),claimed_at:now,lease_until:leaseEnd(now,request.leaseMs,journal.definition.limits.expiresAt),status:'pending',finished_at:null};
   if(db.prepare('UPDATE main.paper_dispatch_definitions SET attempt_count=?,last_claim_at=? WHERE id=? AND attempt_count=?').run(a.sequence,now,request.definitionId,journal.row.attempt_count).changes!==1)fail();
   db.prepare('INSERT INTO main.paper_dispatch_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(a.id,a.definition_id,a.owner_id,a.attempt_key,a.sequence,a.lease_ms,a.request_json,a.request_hash,a.fence_token,a.claimed_at,a.lease_until,a.status,a.finished_at,eventHash(a));
   const checked=load(db,ownerId,request.definitionId,now),saved=checked.attempts.find(row=>row.id===a.id);if(!saved||saved.fence_token!==a.fence_token)fail();return acknowledgment(saved,now,false,true);
  }).immediate();
 }catch{return deny();}
}
/** Completed is a trusted bookkeeping assertion, never evidence of a trade or side effect. */
export function finishPaperDispatchAttempt(db:Database.Database,ownerId:string,input:unknown,nowOverride?:number){
 try{identity(db);return db.transaction(()=>finishPaperDispatchAttemptInTransaction(db,ownerId,input,time(nowOverride))).immediate();}catch{return deny();}
}
/** Trusted caller-owned IMMEDIATE composition. Exceptions must roll back the outer transaction; no execution authority. */
export function finishPaperDispatchAttemptInTransaction(db:Database.Database,ownerId:string,input:unknown,now:number){
 identity(db,true);if(!db.inTransaction)fail();time(now);
 if(!plain(input,['definitionId','definitionDigest','attemptKey','fenceToken','outcome'])||!uuid(input.definitionId)||!digest(input.definitionDigest)||!id(input.attemptKey)||!fence(input.fenceToken)||!['completed','failed'].includes(input.outcome as string))fail();
 const request={...input};
   const journal=load(db,ownerId,request.definitionId as string,now);if(journal.row.digest!==request.definitionDigest)fail();
   const a=journal.attempts.find(row=>row.attempt_key===request.attemptKey);if(!a||a.fence_token!==request.fenceToken)fail();
   if(a.status!=='pending'){if(a.status===request.outcome)return acknowledgment(a,now,true);return deny(a.status==='unknown'?'unknown':'terminal');}
   if(now>=a.lease_until){transitionUnknown(db,a,now);load(db,ownerId,journal.row.id,now);return deny('unknown');}
   const updated={...a,status:request.outcome as 'completed'|'failed',finished_at:now};
   if(db.prepare("UPDATE main.paper_dispatch_attempts SET status=?,finished_at=?,event_hash=? WHERE id=? AND status='pending' AND fence_token=?").run(updated.status,now,eventHash(updated),a.id,a.fence_token).changes!==1)fail();
   const checked=load(db,ownerId,journal.row.id,now);return acknowledgment(checked.attempts.find(row=>row.id===a.id)!,now,false);
}
/** Expired/ambiguous work becomes terminal unknown; there is intentionally no retry/reset or renew API. */
export function reconcileExpiredPaperDispatchAttempt(db:Database.Database,ownerId:string,input:unknown,nowOverride?:number){
 try{
  identity(db);if(!plain(input,['definitionId','definitionDigest','attemptKey'])||!uuid(input.definitionId)||!digest(input.definitionDigest)||!id(input.attemptKey))fail();const request={...input};
  return db.transaction(()=>{
   const now=time(nowOverride),journal=load(db,ownerId,request.definitionId as string,now);if(journal.row.digest!==request.definitionDigest)fail();const a=journal.attempts.find(row=>row.attempt_key===request.attemptKey);if(!a)fail();
   if(a.status!=='pending')return acknowledgment(a,now,true);if(now<a.lease_until)return deny('pending');
   transitionUnknown(db,a,now);const checked=load(db,ownerId,journal.row.id,now);return acknowledgment(checked.attempts.find(row=>row.id===a.id)!,now,false);
  }).immediate();
 }catch{return deny();}
}
/** Read-only complete bounded journal. Deliberately excludes canonical definitions, raw event/request hashes and fencing tokens. */
export function readPaperDispatchAttempts(db:Database.Database,ownerId:string,definitionId:string,nowOverride?:number){
 try{identity(db);return db.transaction(()=>{const now=time(nowOverride);return projection(load(db,ownerId,definitionId,now),now);}).deferred();}catch{return deny();}
}

/** Internal offline fingerprint of fully validated journal content; no fence or raw event escapes. */
export function fingerprintPaperDispatchHistoryInTransaction(db:Database.Database,ownerId:string,definitionId:string,now:number){
 if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!db.inTransaction||!uint(now,1))fail();
 const j=load(db,ownerId,definitionId,now);
 return sha(JSON.stringify(['paper-dispatch-preservation-v1',j.row,j.attempts]));
}

/** Internal offline schema prerequisite, including empty journals; never initializes storage. */
export function assertPaperDispatchStorageInTransaction(db:Database.Database,ownerId:string){
 if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!db.inTransaction)fail();schema(db);owner(db,ownerId);
}
