/** Same-transaction typed schedule fence. Snapshots are comparison data, never bearer authority. */
import type Database from 'better-sqlite3';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {assertScheduledDispatchInTransaction,assertPaperScheduleAuthorityInTransaction} from './authorization.js';
import {rowToJob,type CronJobRow} from './store.js';
import {capturePaperRuntimeAction} from './authorization-definition.js';
import {readTrustedPaperRuntimeConsentInTransaction} from '../services/trading-paper-runtime-consent.js';
function fail():never{throw Error('scheduled paper admission unavailable');}
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
const uint=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=1;
function exact(value:unknown,keys:readonly string[]):value is Record<string,unknown>{if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;const own=Reflect.ownKeys(value);return own.length===keys.length&&own.every(k=>typeof k==='string'&&keys.includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)!,'value'));}
export function capturePaperScheduleExecutionRequest(value:unknown){if(!exact(value,['jobId','trigger'])||!uuid(value.jobId)||!['manual','scheduled'].includes(value.trigger as string))fail();return Object.freeze({jobId:value.jobId,trigger:value.trigger as 'manual'|'scheduled'});}
export type PaperScheduleExecutionFence=Readonly<{jobId:string;trigger:'manual'|'scheduled';consentId:string;ownerId:string;definitionId:string;definitionDigest:string;jobRevision:number;authorizationRevision:number;definitionHash:string;expiresAt:number}>;
const fields=['jobId','trigger','consentId','ownerId','definitionId','definitionDigest','jobRevision','authorizationRevision','definitionHash','expiresAt'] as const;
export function capturePaperScheduleExecutionFence(value:unknown):PaperScheduleExecutionFence{
 if(!exact(value,fields))fail();capturePaperScheduleExecutionRequest({jobId:value.jobId,trigger:value.trigger});
 if(!uuid(value.consentId)||!uuid(value.definitionId)||typeof value.ownerId!=='string'||!value.ownerId||value.ownerId.length>128||/[\x00-\x20\x7f]/.test(value.ownerId)||!hash(value.definitionDigest)||!hash(value.definitionHash)||!uint(value.jobRevision)||!uint(value.authorizationRevision)||!uint(value.expiresAt))fail();
 return Object.freeze(Object.fromEntries(fields.map(k=>[k,value[k]]))) as PaperScheduleExecutionFence;
}
function resolve(db:Database.Database,value:unknown,now:number,postSettlement:boolean):PaperScheduleExecutionFence{
 if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!db.inTransaction||!uint(now))fail();const ref=capturePaperScheduleExecutionRequest(value);
 const row=db.prepare('SELECT * FROM main.cron_jobs WHERE id=?').get(ref.jobId) as CronJobRow|undefined;if(!row||row.action_type!=='paper-runtime-cycle')fail();
 const job=rowToJob('sqlite',row),admitted=postSettlement?assertPaperScheduleAuthorityInTransaction(db,job,ref.trigger,now):assertScheduledDispatchInTransaction(db,job,ref.trigger,now),action=capturePaperRuntimeAction(job.actionData),consent=readTrustedPaperRuntimeConsentInTransaction(db,action.consentId,now);
 if(consent.ownerId!==admitted.ownerId)fail();
 return Object.freeze({jobId:ref.jobId,trigger:ref.trigger,consentId:consent.consentId,ownerId:consent.ownerId,definitionId:consent.definitionId,definitionDigest:consent.definitionDigest,jobRevision:admitted.jobRevision,authorizationRevision:admitted.authorizationRevision,definitionHash:admitted.definitionHash,expiresAt:admitted.expiresAt});
}
/** Initial read planning only; actual writes must resolve the same persisted authority again. */
export function resolvePaperScheduleExecutionInTransaction(db:Database.Database,value:unknown,now:number){return resolve(db,value,now,false);}
export function assertPaperScheduleExecutionFenceInTransaction(db:Database.Database,value:unknown,ownerId:string,consentId:string,definitionId:string,definitionDigest:string,now:number){return check(db,value,ownerId,consentId,definitionId,definitionDigest,now,false);}
/** Schedule-only postcondition; dispatcher must also call the separately named runtime POST guard. */
export function assertPaperScheduleExecutionFencePostSettlementInTransaction(db:Database.Database,value:unknown,ownerId:string,consentId:string,definitionId:string,definitionDigest:string,now:number){return check(db,value,ownerId,consentId,definitionId,definitionDigest,now,true);}
function check(db:Database.Database,value:unknown,ownerId:string,consentId:string,definitionId:string,definitionDigest:string,now:number,postSettlement:boolean){
 const expected=capturePaperScheduleExecutionFence(value),current=resolve(db,{jobId:expected.jobId,trigger:expected.trigger},now,postSettlement);
 if(JSON.stringify(current)!==JSON.stringify(expected)||current.ownerId!==ownerId||current.consentId!==consentId||current.definitionId!==definitionId||current.definitionDigest!==definitionDigest)fail();return current;
}
