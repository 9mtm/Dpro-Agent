import type {Actor} from '../repositories/actor.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import {sql,one,run,lockName,dialect,type Step} from '../repositories/sql-steps.js';
import {forUpdate} from '../db/pg/dialect.js';
import {rowToJob,advanceSecurityRevision,type CronJobRow} from './store.js';
import type {CronJob} from './types.js';
import {captureScheduledDefinition,captureScheduledJson} from './authorization-definition.js';
import {scheduledActionReview} from './authorization-review.js';
export class ScheduledDefinitionError extends Error{constructor(readonly code:'invalid'|'forbidden'|'conflict'){super('Schedule definition '+code);}}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function identity(actor:Actor,tokenVersion:number){
 if(actor?.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||typeof actor.userId!=='string'||!actor.userId||actor.userId.length>200||isSystemAccount(actor.userId)||!Number.isSafeInteger(tokenVersion)||tokenVersion<1)throw new ScheduledDefinitionError('forbidden');
 return Object.freeze({...actor,userId:actor.userId});
}
function* currentOwner(actor:ReturnType<typeof identity>,tokenVersion:number):Step<void>{
 yield* lockName('verification-enrollment:'+actor.userId);const d=yield* dialect();
 const user=yield* one<{role:string;status:string;email_verified:number;token_version:number}>(`SELECT role,status,email_verified,token_version FROM users WHERE id=?${forUpdate(d)}`,actor.userId);
 if(!user||user.role!=='owner'||user.status!=='active'||Number(user.email_verified)!==1||Number(user.token_version)!==tokenVersion)throw new ScheduledDefinitionError('forbidden');
}
function changes(input:unknown){
 const value=captureScheduledJson(input) as Record<string,unknown>;
 if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(key=>!['name','description','cronExpression','actionType','actionData'].includes(key))||Object.keys(value).length===0)throw new ScheduledDefinitionError('invalid');
 return value;
}
/** Reads only masked display. Explicit owner inspection may initialize legacy revision tracking. */
export async function readScheduledDefinition(actor:Actor,tokenVersion:number,id:string){
 const trusted=identity(actor,tokenVersion);if(!uuid(id))throw new ScheduledDefinitionError('invalid');
 return sql().tx(function*(){
  yield* lockName('scheduled-job:'+id);yield* currentOwner(trusted,tokenVersion);const d=yield* dialect();
  const row=yield* one<CronJobRow>(`SELECT * FROM cron_jobs WHERE id=?${forUpdate(d)}`,id);if(!row)return null;
  const job=rowToJob(d,row),definition=captureScheduledDefinition(job);
  let version=yield* one<{revision:number}>(`SELECT revision FROM scheduled_job_security_versions WHERE job_id=?${forUpdate(d)}`,id);
  if(!version){yield* run('INSERT INTO scheduled_job_security_versions(job_id,revision) VALUES(?,1)',id);version={revision:1};}
  const revision=Number(version.revision);if(!Number.isInteger(revision)||revision<1||revision>2147483647)throw new ScheduledDefinitionError('conflict');
  return Object.freeze({jobId:id,revision,enabled:job.enabled,review:scheduledActionReview(job,{jobId:id,definitionHash:definition.definitionHash})});
 });
}
/** Exact revisioned save only. New or changed external actions are always paused and never authorized here. */
export async function saveScheduledDefinition(actor:Actor,tokenVersion:number,id:string,expectedRevision:number,input:unknown,now=Date.now()){
 const trusted=identity(actor,tokenVersion),update=changes(input);
 if(!uuid(id)||!Number.isInteger(expectedRevision)||expectedRevision<0||expectedRevision>=2147483647||!Number.isSafeInteger(now)||now<1||now>8640000000000000)throw new ScheduledDefinitionError('invalid');
 return sql().tx(function*(){
  yield* lockName('scheduled-job:'+id);yield* currentOwner(trusted,tokenVersion);const d=yield* dialect();
  const row=yield* one<CronJobRow>(`SELECT * FROM cron_jobs WHERE id=?${forUpdate(d)}`,id),version=yield* one<{revision:number}>(`SELECT revision FROM scheduled_job_security_versions WHERE job_id=?${forUpdate(d)}`,id);
  if(expectedRevision===0?(!!row||!!version):(!row||!version||Number(version.revision)!==expectedRevision))throw new ScheduledDefinitionError('conflict');
  const previous=row?rowToJob(d,row):undefined;
  if(previous&&!['api-call','send-message'].includes(previous.actionType))throw new ScheduledDefinitionError('invalid');
  if(!previous&&['name','cronExpression','actionType','actionData'].some(key=>!Object.hasOwn(update,key)))throw new ScheduledDefinitionError('invalid');
  let actionData=Object.hasOwn(update,'actionData')?update.actionData:previous?.actionData;
  if(previous&&Object.hasOwn(update,'actionData')&&(!Object.hasOwn(update,'actionType')||update.actionType===previous.actionType)){
   if(!actionData||typeof actionData!=='object'||Array.isArray(actionData))throw new ScheduledDefinitionError('invalid');
   actionData={...previous.actionData,...actionData};
  }
  const job={...previous,...update,id,actionData,enabled:false,createdAt:previous?.createdAt??new Date(now),updatedAt:new Date(now)} as CronJob;
  const captured=captureScheduledDefinition(job);
  // Refuse an unsafe/unbounded native review before persisting an authoring change.
  scheduledActionReview(job,{jobId:id,definitionHash:captured.definitionHash});
  if(row)yield* run('UPDATE cron_jobs SET name=?,description=?,cron_expression=?,action_type=?,action_data=?,enabled=0,updated_at=? WHERE id=?',job.name,job.description??null,job.cronExpression,job.actionType,JSON.stringify(job.actionData),job.updatedAt.toISOString(),id);
  else yield* run('INSERT INTO cron_jobs(id,name,description,cron_expression,action_type,action_data,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?)',id,job.name,job.description??null,job.cronExpression,job.actionType,JSON.stringify(job.actionData),job.createdAt.toISOString(),job.updatedAt.toISOString());
  yield* advanceSecurityRevision(id);const revision=expectedRevision+1;
  yield* run('INSERT INTO scheduled_job_definition_events(job_id,revision,edited_by,edited_at,token_version,definition_hash) VALUES(?,?,?,?,?,?)',id,revision,trusted.userId,now,tokenVersion,captured.definitionHash);
  return Object.freeze({job,revision,definitionHash:captured.definitionHash});
 });
}
