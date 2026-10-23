/** One explicit due PAPER attempt only. No scheduler action, timer, worker, provider or automatic registration. */
import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {readTrustedPaperRuntimeConsentInTransaction} from './trading-paper-runtime-consent.js';
import {dispatchPaperRuntimeAttempt} from './trading-paper-runtime-dispatch.js';
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
function key(consentId:string,definitionId:string,digest:string,sequence:number){
 return 'due:'+createHash('sha256').update(JSON.stringify(['paper-runtime-due-attempt-v1',consentId,definitionId,digest,sequence])).digest('hex');
}
/**
 * Derives one next journal sequence, never missed time buckets or catch-up work. An expired pending lease is
 * delegated only for unknown reconciliation; existing pending attempts are never executed or resumed.
 * The downstream dispatcher independently rechecks current consent/owner/install/policy/risk before claiming
 * and atomically at settlement. A snapshot or deterministic key is not a grant to bypass those checks.
 */
export function dispatchDuePaperRuntimeConsent(db:Database.Database,value:unknown,nowOverride?:number){
 try{
  if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||db.inTransaction)fail();
  const consentId=input(value);
  const attemptKey=db.transaction(()=>{
   const now=time(nowOverride),s=readTrustedPaperRuntimeConsentInTransaction(db,consentId,now),j=s.journal;
   if(s.runtimePrincipal!=='bundled.paper.deterministic.v1')fail();
   for(const a of j.attempts)if(a.attemptKey!==key(consentId,s.definitionId,s.definitionDigest,a.sequence))fail();
   if(j.blockedByUnknown)fail();
   const pending=j.attempts.find(a=>a.status==='pending');if(pending)return pending.attemptKey;
   if(s.status!=='granted'||now>=s.definition.limits.expiresAt||j.attemptCount>=s.definition.limits.maxAttempts
    ||j.lastClaimAt!==null&&BigInt(now)-BigInt(j.lastClaimAt)<BigInt(s.definition.limits.cadenceMs))fail();
   return key(consentId,s.definitionId,s.definitionDigest,j.attemptCount+1);
  }).deferred();
  // The read snapshot is released before either dispatcher write transaction. Default clocks are resampled.
  return dispatchPaperRuntimeAttempt(db,{consentId,attemptKey},nowOverride);
 }catch{return deny();}
}
