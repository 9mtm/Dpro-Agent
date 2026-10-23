import type Database from 'better-sqlite3';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {createHash} from 'node:crypto';
import type {Actor} from '../repositories/actor.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import {sql,one,run,lockName,dialect,sqliteSync,type Step} from '../repositories/sql-steps.js';
import {forUpdate} from '../db/pg/dialect.js';
import {rowToJob,type CronJobRow} from './store.js';
import {scheduledActionReview} from './authorization-review.js';
import {captureScheduledDefinition} from './authorization-definition.js';
import {scheduleAuthorizationOperationHash,issueOperationChallenge,completeOperationChallenge,consumeOperationReceiptStep,type OperationContext,type ScheduleAuthorizationOperation,scheduleRevocationOperationHash,type ScheduleRevocationOperation} from '../auth/verification/operation-proof.js';
export class ScheduleAuthorizationError extends Error{constructor(readonly code:'invalid'|'forbidden'|'changed'|'proof_refused'){super('Scheduled authorization '+code);}}
function capture(context:OperationContext,actor:Actor){
 if(!context||actor?.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==context.userId||typeof context.userId!=='string'||!context.userId||context.userId.length>200||isSystemAccount(context.userId)||typeof context.sessionHash!=='string'||!/^[a-f0-9]{64}$/.test(context.sessionHash)||!Number.isSafeInteger(context.tokenVersion)||context.tokenVersion<1||!Number.isSafeInteger(context.factorVersion)||context.factorVersion<1)throw new ScheduleAuthorizationError('forbidden');
 return {context:Object.freeze({...context}),actor:Object.freeze({...actor})};
}
function reviewed(operation:ScheduleAuthorizationOperation){scheduleAuthorizationOperationHash(operation);return Object.freeze({...operation});}
function* target(context:OperationContext,actor:Actor,id:string,expiresAt:number,expected:ScheduleAuthorizationOperation|undefined,now:number):Step<ScheduleAuthorizationOperation>{
 capture(context,actor);scheduleAuthorizationOperationHash({kind:'schedule_authorization',jobId:id,jobRevision:1,authorizationRevision:0,definitionHash:'0'.repeat(64),authorizationExpiresAt:expiresAt,policyVersion:1});
 if(!Number.isSafeInteger(now)||now<1||expiresAt<=now||expiresAt-now>7776000000)throw new ScheduleAuthorizationError('invalid');
 yield* lockName('scheduled-job:'+id);const d=yield* dialect();
 yield* lockName('verification-enrollment:'+context.userId);
 const owner=yield* one<{role:string;status:string;email_verified:number;token_version:number}>(`SELECT role,status,email_verified,token_version FROM users WHERE id=?${forUpdate(d)}`,context.userId);
 const factor=yield* one<{version:number;enabled:number}>(`SELECT version,enabled FROM verification_factors WHERE user_id=?${forUpdate(d)}`,context.userId);
 if(!owner||owner.role!=='owner'||owner.status!=='active'||Number(owner.email_verified)!==1||Number(owner.token_version)!==context.tokenVersion||!factor||Number(factor.enabled)!==1||Number(factor.version)!==context.factorVersion)throw new ScheduleAuthorizationError('forbidden');
 const policy=yield* one<{version:number}>(`SELECT version FROM approval_proof_policy WHERE id=1${forUpdate(d)}`);
 if(!policy||!Number.isSafeInteger(Number(policy.version))||Number(policy.version)<1)throw new ScheduleAuthorizationError('changed');
 const job=yield* one<CronJobRow>(`SELECT * FROM cron_jobs WHERE id=?${forUpdate(d)}`,id);if(!job)throw new ScheduleAuthorizationError('changed');
 const definition=captureScheduledDefinition(rowToJob(d,job));
 let version=yield* one<{revision:number}>(`SELECT revision FROM scheduled_job_security_versions WHERE job_id=?${forUpdate(d)}`,id);
 // An explicit owner preview may track a legacy row, but never authorizes or changes its action.
 if(!version){yield* run('INSERT INTO scheduled_job_security_versions(job_id,revision) VALUES(?,1)',id);version={revision:1};}
 const prior=yield* one<{version:number}>(`SELECT version FROM scheduled_job_authorizations WHERE job_id=?${forUpdate(d)}`,id);
 // Reserve the final version for revocation; exhausted histories must never grant unrevokable authority.
 if(prior&&Number(prior.version)>=2147483646)throw new ScheduleAuthorizationError('changed');
 const operation=Object.freeze({kind:'schedule_authorization' as const,jobId:id,jobRevision:Number(version.revision),authorizationRevision:Number(prior?.version??0),definitionHash:definition.definitionHash,authorizationExpiresAt:expiresAt,policyVersion:Number(policy.version)});
 scheduleAuthorizationOperationHash(operation);
 if(expected&&scheduleAuthorizationOperationHash(expected)!==scheduleAuthorizationOperationHash(operation))throw new ScheduleAuthorizationError('changed');
 return operation;
}
export async function scheduledAuthorizationTarget(context:OperationContext,actor:Actor,id:string,expiresAt:number,now=Date.now()){
 const trusted=capture(context,actor);return sql().tx(()=>target(trusted.context,trusted.actor,id,expiresAt,undefined,now));
}
/** Review and operation are derived while the same job lock/transaction remains held. */
export async function scheduledAuthorizationPreview(context:OperationContext,actor:Actor,id:string,expiresAt:number,now=Date.now()){
 const trusted=capture(context,actor);
 return sql().tx(function*(){
  const operation=yield* target(trusted.context,trusted.actor,id,expiresAt,undefined,now);
  const d=yield* dialect(),row=yield* one<CronJobRow>('SELECT * FROM cron_jobs WHERE id=?',id);
  if(!row)throw new ScheduleAuthorizationError('changed');
  return Object.freeze({operation,review:scheduledActionReview(rowToJob(d,row),operation)});
 });
}
export async function issueScheduledAuthorization(context:OperationContext,actor:Actor,input:ScheduleAuthorizationOperation,now=Date.now()){
 const trusted=capture(context,actor),operation=reviewed(input);await sql().tx(()=>target(trusted.context,trusted.actor,operation.jobId,operation.authorizationExpiresAt,operation,now));return issueOperationChallenge(trusted.context,operation,now);
}
export async function completeScheduledAuthorization(token:unknown,context:OperationContext,actor:Actor,input:ScheduleAuthorizationOperation,code:unknown,now=Date.now()){
 const trusted=capture(context,actor),operation=reviewed(input);await sql().tx(()=>target(trusted.context,trusted.actor,operation.jobId,operation.authorizationExpiresAt,operation,now));return completeOperationChallenge(token,trusted.context,operation,code,now);
}
/** Explicit authorization only. It never enables, dispatches or executes the job. */
export async function authorizeScheduledJob(receipt:unknown,context:OperationContext,actor:Actor,input:ScheduleAuthorizationOperation,now=Date.now()){
 const trusted=capture(context,actor),operation=reviewed(input);
 return sql().tx(function*(){
  yield* target(trusted.context,trusted.actor,operation.jobId,operation.authorizationExpiresAt,operation,now);
  if(!(yield* consumeOperationReceiptStep(receipt,trusted.context,operation,now)))throw new ScheduleAuthorizationError('proof_refused');
  const version=operation.authorizationRevision+1,receiptHash=createHash('sha256').update(receipt as string).digest('hex');
  const values=[version,operation.jobRevision,operation.definitionHash,trusted.context.userId,trusted.context.tokenVersion,trusted.context.factorVersion,operation.policyVersion,now,operation.authorizationExpiresAt,receiptHash,trusted.context.sessionHash] as const;
  const changed=operation.authorizationRevision===0?yield* run('INSERT INTO scheduled_job_authorizations(version,job_revision,definition_hash,owner_id,token_version,factor_version,policy_version,authorized_at,expires_at,receipt_hash,session_hash,job_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',...values,operation.jobId):yield* run("UPDATE scheduled_job_authorizations SET status='authorized',version=?,job_revision=?,definition_hash=?,owner_id=?,token_version=?,factor_version=?,policy_version=?,authorized_at=?,expires_at=?,receipt_hash=?,session_hash=? WHERE job_id=? AND version=?",...values,operation.jobId,operation.authorizationRevision);
  if(changed.changes!==1)throw new ScheduleAuthorizationError('changed');
  yield* run('INSERT INTO scheduled_job_authorization_events(version,job_revision,definition_hash,owner_id,token_version,factor_version,policy_version,authorized_at,expires_at,receipt_hash,session_hash,job_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',...values,operation.jobId);
  return Object.freeze({jobId:operation.jobId,jobRevision:operation.jobRevision,authorizationRevision:version,expiresAt:operation.authorizationExpiresAt});
 });
}

export type ScheduledDispatchAdmission=Readonly<{definition:ReturnType<typeof captureScheduledDefinition>['definition'];ownerId:string;jobRevision:number;authorizationRevision:number;definitionHash:string;expiresAt:number}>;

/** Shared SQL-only validation. Caller owns its transaction; metadata is not an authorization token. */
export function assertScheduledDispatchStep(job:import('./types.js').CronJob,trigger:'manual'|'scheduled',now:number,requireEnabled=false):Step<ScheduledDispatchAdmission>{
 const snapshot=captureScheduledDefinition(job);
 const identity=Object.freeze({id:snapshot.definition.id});
 return scheduledDispatchStep(identity,snapshot,trigger,now,requireEnabled);
}
function* scheduledDispatchStep(job:Readonly<{id:string}>,snapshot:ReturnType<typeof captureScheduledDefinition>,trigger:'manual'|'scheduled',now:number,requireEnabled:boolean):Step<ScheduledDispatchAdmission>{
  if(!Number.isSafeInteger(now)||now<1||(trigger!=='manual'&&trigger!=='scheduled')||typeof requireEnabled!=='boolean')throw new ScheduleAuthorizationError('invalid');
  yield* lockName('scheduled-job:'+job.id);const d=yield* dialect();
  const consent=yield* one<{status:string;version:number;job_revision:number;definition_hash:string;owner_id:string;token_version:number;factor_version:number;policy_version:number;authorized_at:number;expires_at:number;receipt_hash:string;session_hash:string}>(`SELECT * FROM scheduled_job_authorizations WHERE job_id=?${forUpdate(d)}`,job.id);
  if(!consent||consent.status!=='authorized'||!Number.isSafeInteger(Number(consent.version))||Number(consent.version)<1||Number(consent.version)>2147483647||!Number.isSafeInteger(Number(consent.authorized_at))||Number(consent.authorized_at)<1||Number(consent.authorized_at)>now||!Number.isSafeInteger(Number(consent.expires_at))||Number(consent.expires_at)<=now||Number(consent.expires_at)-Number(consent.authorized_at)>7776000000||!/^[a-f0-9]{64}$/.test(consent.receipt_hash)||!/^[a-f0-9]{64}$/.test(consent.session_hash)||typeof consent.owner_id!=='string'||!consent.owner_id||isSystemAccount(consent.owner_id))throw new ScheduleAuthorizationError('forbidden');
  const event=yield* one<Record<string,unknown>>(`SELECT * FROM scheduled_job_authorization_events WHERE job_id=? AND version=?${forUpdate(d)}`,job.id,Number(consent.version));
  const grantFields=['job_id','version','job_revision','definition_hash','owner_id','token_version','factor_version','policy_version','authorized_at','expires_at','receipt_hash','session_hash'] as const;
  const grant={...consent,job_id:job.id};
  if(!event||grantFields.some(field=>event[field]!==grant[field]))throw new ScheduleAuthorizationError('forbidden');
  const receipt=yield* one<{token_hash:string;user_id:string;session_hash:string;operation_hash:string;token_version:number;factor_version:number;expires_at:number;consumed_at:number|null}>(`SELECT * FROM verification_receipts WHERE token_hash=?${forUpdate(d)}`,consent.receipt_hash);
  let operationHash:string;
  try{operationHash=scheduleAuthorizationOperationHash({kind:'schedule_authorization',jobId:job.id,jobRevision:Number(consent.job_revision),authorizationRevision:Number(consent.version)-1,definitionHash:consent.definition_hash,authorizationExpiresAt:Number(consent.expires_at),policyVersion:Number(consent.policy_version)});}catch{throw new ScheduleAuthorizationError('forbidden');}
  if(!receipt||receipt.token_hash!==consent.receipt_hash||receipt.user_id!==consent.owner_id||receipt.session_hash!==consent.session_hash||receipt.operation_hash!==operationHash||Number(receipt.token_version)!==Number(consent.token_version)||Number(receipt.factor_version)!==Number(consent.factor_version)||receipt.consumed_at===null||!Number.isSafeInteger(Number(receipt.consumed_at))||Number(receipt.consumed_at)!==Number(consent.authorized_at)||!Number.isSafeInteger(Number(receipt.expires_at))||Number(receipt.expires_at)<=Number(consent.authorized_at))throw new ScheduleAuthorizationError('forbidden');
  yield* lockName('verification-enrollment:'+consent.owner_id);
  const owner=yield* one<{role:string;status:string;email_verified:number;token_version:number}>(`SELECT role,status,email_verified,token_version FROM users WHERE id=?${forUpdate(d)}`,consent.owner_id);
  const factor=yield* one<{version:number;enabled:number}>(`SELECT version,enabled FROM verification_factors WHERE user_id=?${forUpdate(d)}`,consent.owner_id);
  const policy=yield* one<{version:number}>(`SELECT version FROM approval_proof_policy WHERE id=1${forUpdate(d)}`);
  if(!owner||owner.role!=='owner'||owner.status!=='active'||Number(owner.email_verified)!==1||!Number.isSafeInteger(Number(consent.token_version))||Number(consent.token_version)<1||Number(owner.token_version)!==Number(consent.token_version)||!factor||Number(factor.enabled)!==1||!Number.isSafeInteger(Number(consent.factor_version))||Number(consent.factor_version)<1||Number(factor.version)!==Number(consent.factor_version)||!policy||!Number.isSafeInteger(Number(consent.policy_version))||Number(consent.policy_version)<1||Number(policy.version)!==Number(consent.policy_version))throw new ScheduleAuthorizationError('forbidden');
  const current=yield* one<CronJobRow>(`SELECT * FROM cron_jobs WHERE id=?${forUpdate(d)}`,job.id);
  const revision=yield* one<{revision:number}>(`SELECT revision FROM scheduled_job_security_versions WHERE job_id=?${forUpdate(d)}`,job.id);
  if(!current||!revision||!Number.isSafeInteger(Number(consent.job_revision))||Number(consent.job_revision)<1||Number(revision.revision)!==Number(consent.job_revision))throw new ScheduleAuthorizationError('changed');
  if(Number(current.enabled)!==0&&Number(current.enabled)!==1)throw new ScheduleAuthorizationError('changed');
  const persisted=rowToJob(d,current);
  if(((requireEnabled||trigger==='scheduled')&&!persisted.enabled)||snapshot.definitionHash!==consent.definition_hash||captureScheduledDefinition(persisted).definitionHash!==snapshot.definitionHash)throw new ScheduleAuthorizationError('changed');
 return Object.freeze({definition:snapshot.definition,ownerId:consent.owner_id,jobRevision:Number(consent.job_revision),authorizationRevision:Number(consent.version),definitionHash:consent.definition_hash,expiresAt:Number(consent.expires_at)});
}

/** Admission boundary for external effects. Existing manually dispatched paused jobs retain their behavior. */
export async function assertScheduledDispatch(job:import('./types.js').CronJob,trigger:'manual'|'scheduled',now=Date.now()){
 const step=assertScheduledDispatchStep(job,trigger,now,false);
 const admission=await sql().tx(()=>step);
 return admission.definition;
}

const admissionPrimaryKeys=Object.freeze({cron_jobs:['id'],scheduled_job_security_versions:['job_id'],scheduled_job_authorizations:['job_id'],scheduled_job_authorization_events:['job_id','version'],users:['id'],verification_factors:['user_id'],approval_proof_policy:['id'],verification_receipts:['token_hash']});
const admissionColumns=Object.freeze({
 cron_jobs:'id,name,description,cron_expression,action_type,action_data,enabled,last_run,next_run,created_at,updated_at',
 scheduled_job_security_versions:'job_id,revision',
 scheduled_job_authorizations:'job_id,status,version,job_revision,definition_hash,owner_id,token_version,factor_version,policy_version,authorized_at,expires_at,receipt_hash,session_hash',
 scheduled_job_authorization_events:'job_id,version,job_revision,definition_hash,owner_id,token_version,factor_version,policy_version,authorized_at,expires_at,receipt_hash,session_hash',
 users:'id,role,status,email_verified,token_version',
 verification_factors:'user_id,version,enabled',
 approval_proof_policy:'id,version',
 verification_receipts:'token_hash,user_id,session_hash,operation_hash,token_version,factor_version,expires_at,consumed_at'
});
/** Trusted caller must own BEGIN IMMEDIATE: inTransaction alone cannot prove its lock mode.
 * This checks current authority again inside the same write transaction as future effects.
 * No transaction, initialization, proof consumption, or runtime connection is performed here.
 */
export function assertScheduledDispatchInTransaction(db:Database.Database,job:import('./types.js').CronJob,trigger:'manual'|'scheduled',now=Date.now(),requireEnabled=true):ScheduledDispatchAdmission{
 if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!db.inTransaction||typeof requireEnabled!=='boolean'||db.pragma('query_only',{simple:true})!==0)throw new ScheduleAuthorizationError('forbidden');
 for(const [name,columns] of Object.entries(admissionColumns)){
  if(db.prepare('SELECT 1 FROM sqlite_temp_master WHERE name=? COLLATE NOCASE OR tbl_name=? COLLATE NOCASE LIMIT 1').get(name,name)||!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(name)||db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='trigger' AND tbl_name=? COLLATE NOCASE LIMIT 1").get(name))throw new ScheduleAuthorizationError('forbidden');
  db.prepare(`SELECT ${columns} FROM main.${name} LIMIT 0`).all();
  const primary=(db.prepare(`PRAGMA main.table_info(${name})`).all() as {name:string;pk:number}[]).filter(column=>column.pk>0).sort((a,b)=>a.pk-b.pk);
  const expected=admissionPrimaryKeys[name as keyof typeof admissionPrimaryKeys];
  if(primary.length!==expected.length||primary.some((column,index)=>column.name!==expected[index]||column.pk!==index+1))throw new ScheduleAuthorizationError('forbidden');
 }
 return sqliteSync(assertScheduledDispatchStep(job,trigger,now,requireEnabled));
}

function* revocationTarget(context:OperationContext,actor:Actor,id:string,expected:ScheduleRevocationOperation|undefined,now:number):Step<ScheduleRevocationOperation>{
 capture(context,actor);
 scheduleRevocationOperationHash({kind:'schedule_authorization_revoke',jobId:id,authorizationRevision:1,paramsHash:'0'.repeat(64),policyVersion:1});
 if(!Number.isSafeInteger(now)||now<1)throw new ScheduleAuthorizationError('invalid');
 yield* lockName('scheduled-job:'+id);const d=yield* dialect();
 yield* lockName('verification-enrollment:'+context.userId);
 const owner=yield* one<{role:string;status:string;email_verified:number;token_version:number}>(`SELECT role,status,email_verified,token_version FROM users WHERE id=?${forUpdate(d)}`,context.userId);
 const factor=yield* one<{version:number;enabled:number}>(`SELECT version,enabled FROM verification_factors WHERE user_id=?${forUpdate(d)}`,context.userId);
 if(!owner||owner.role!=='owner'||owner.status!=='active'||Number(owner.email_verified)!==1||Number(owner.token_version)!==context.tokenVersion||!factor||Number(factor.enabled)!==1||Number(factor.version)!==context.factorVersion)throw new ScheduleAuthorizationError('forbidden');
 const policy=yield* one<{version:number}>(`SELECT version FROM approval_proof_policy WHERE id=1${forUpdate(d)}`);
 const consent=yield* one<{version:number;status:string;job_revision:number;definition_hash:string;owner_id:string;authorized_at:number;expires_at:number}>(`SELECT version,status,job_revision,definition_hash,owner_id,authorized_at,expires_at FROM scheduled_job_authorizations WHERE job_id=?${forUpdate(d)}`,id);
 if(!consent||consent.status!=='authorized'||!policy)throw new ScheduleAuthorizationError('changed');
 const paramsHash=createHash('sha256').update(JSON.stringify(['schedule-consent-revocation-target-v1',id,Number(consent.version),Number(consent.job_revision),consent.definition_hash,consent.owner_id,Number(consent.authorized_at),Number(consent.expires_at)])).digest('hex');
 const operation=Object.freeze({kind:'schedule_authorization_revoke' as const,jobId:id,authorizationRevision:Number(consent.version),paramsHash,policyVersion:Number(policy.version)});
 scheduleRevocationOperationHash(operation);
 if(expected&&scheduleRevocationOperationHash(expected)!==scheduleRevocationOperationHash(operation))throw new ScheduleAuthorizationError('changed');
 return operation;
}
/** Revocation remains possible after a job was changed or deleted. It never enables or runs it. */
export async function scheduledRevocationTarget(context:OperationContext,actor:Actor,id:string,now=Date.now()){
 const trusted=capture(context,actor);return sql().tx(()=>revocationTarget(trusted.context,trusted.actor,id,undefined,now));
}
function reviewedRevocation(input:ScheduleRevocationOperation){scheduleRevocationOperationHash(input);return Object.freeze({...input});}
export async function issueScheduledRevocation(context:OperationContext,actor:Actor,input:ScheduleRevocationOperation,now=Date.now()){
 const trusted=capture(context,actor),operation=reviewedRevocation(input);await sql().tx(()=>revocationTarget(trusted.context,trusted.actor,operation.jobId,operation,now));return issueOperationChallenge(trusted.context,operation,now);
}
export async function completeScheduledRevocation(token:unknown,context:OperationContext,actor:Actor,input:ScheduleRevocationOperation,code:unknown,now=Date.now()){
 const trusted=capture(context,actor),operation=reviewedRevocation(input);await sql().tx(()=>revocationTarget(trusted.context,trusted.actor,operation.jobId,operation,now));return completeOperationChallenge(token,trusted.context,operation,code,now);
}
export async function revokeScheduledAuthorization(receipt:unknown,context:OperationContext,actor:Actor,input:ScheduleRevocationOperation,now=Date.now()){
 const trusted=capture(context,actor),operation=reviewedRevocation(input);
 return sql().tx(function*(){
  yield* revocationTarget(trusted.context,trusted.actor,operation.jobId,operation,now);
  if(!(yield* consumeOperationReceiptStep(receipt,trusted.context,operation,now)))throw new ScheduleAuthorizationError('proof_refused');
  const version=operation.authorizationRevision+1;
  const updated=yield* run("UPDATE scheduled_job_authorizations SET status='revoked',version=? WHERE job_id=? AND version=? AND status='authorized'",version,operation.jobId,operation.authorizationRevision);
  if(updated.changes!==1)throw new ScheduleAuthorizationError('changed');
  yield* run('INSERT INTO scheduled_job_authorization_revocations(job_id,version,prior_version,revoked_by,revoked_at,token_version,factor_version,policy_version,receipt_hash,session_hash) VALUES(?,?,?,?,?,?,?,?,?,?)',operation.jobId,version,operation.authorizationRevision,trusted.context.userId,now,trusted.context.tokenVersion,trusted.context.factorVersion,operation.policyVersion,createHash('sha256').update(receipt as string).digest('hex'),trusted.context.sessionHash);
  return Object.freeze({jobId:operation.jobId,authorizationRevision:version,status:'revoked' as const});
 });
}
