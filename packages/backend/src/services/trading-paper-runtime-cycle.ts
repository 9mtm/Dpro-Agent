/** One explicit due PAPER attempt only. No scheduler action, timer, worker, provider or automatic registration. */
import type Database from 'better-sqlite3';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {readDuePaperRuntimeAttemptKeyInTransaction} from './trading-paper-runtime-due-plan.js';
import {dispatchReviewedCanonicalPaperRuntimeAttempt,dispatchCanonicalPaperRuntimeAttempt} from './trading-paper-runtime-dispatch.js';
const deny=()=>({ok:false as const,reason:'unavailable' as const});
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
function fail():never{throw Error('paper runtime cycle unavailable');}
function input(value:unknown){
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
 const keys=Reflect.ownKeys(value),descriptor=Object.getOwnPropertyDescriptor(value,'consentId');
 if(keys.length!==1||keys[0]!=='consentId'||!descriptor||!Object.hasOwn(descriptor,'value')||!uuid(descriptor.value))fail();
 return descriptor.value;
}
function time(value?:number){const now=value===undefined?Date.now():value;if(!Number.isSafeInteger(now)||now<1)fail();return now;}
/**
 * Derives one next journal sequence, never missed time buckets or catch-up work. An expired pending lease is
 * delegated only for unknown reconciliation; existing pending attempts are never executed or resumed.
 * The downstream dispatcher independently rechecks current consent/owner/install/policy/risk before claiming
 * and atomically at settlement. A snapshot or deterministic key is not a grant to bypass those checks.
 */
function dispatchDue(db:Database.Database,value:unknown,nowOverride:number|undefined,reviewedExecution:boolean){
 try{
  if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||db.inTransaction)fail();
  const consentId=input(value);
  const attemptKey=db.transaction(()=>readDuePaperRuntimeAttemptKeyInTransaction(db,consentId,time(nowOverride))).deferred();
  // The read snapshot is released before either dispatcher write transaction. Default clocks are resampled.
  return reviewedExecution?dispatchReviewedCanonicalPaperRuntimeAttempt(db,{consentId,attemptKey},nowOverride):dispatchCanonicalPaperRuntimeAttempt(db,{consentId,attemptKey},nowOverride);
 }catch{return deny();}
}

/** Existing trusted internal due path remains compatible and does not assert execution capability. */
export function dispatchDuePaperRuntimeConsent(db:Database.Database,value:unknown,nowOverride?:number){return dispatchDue(db,value,nowOverride,false);}
/** New strict path; actual claim and settlement each validate the reviewed overlay inside their write transaction. */
export function dispatchDueReviewedPaperRuntimeConsent(db:Database.Database,value:unknown,nowOverride?:number){return dispatchDue(db,value,nowOverride,true);}
