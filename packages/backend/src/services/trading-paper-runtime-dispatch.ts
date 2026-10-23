/** Internal deterministic PAPER dispatch only. No timer, provider, HTTP or caller-selected trading authority. */
import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {readTrustedPaperRuntimeConsentInTransaction,assertPaperRuntimeEligibilityInTransaction} from './trading-paper-runtime-consent.js';
import {claimPaperDispatchAttempt,finishPaperDispatchAttemptInTransaction} from './trading-paper-dispatch-attempts.js';
import {reservePaperOrder} from './trading-paper-ledger.js';
import {reservePaperSell} from './trading-paper-sells.js';
import {runPaperBotTickInTransaction,isPaperBotTickRefusal} from './trading-paper-bots.js';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const business=Symbol('paper runtime business refusal');
function fail():never{throw Error('paper runtime dispatch unavailable');}
const deny=()=>({ok:false as const,reason:'unavailable' as const});
const uint=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
function request(v:unknown){
 if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail();
 const keys=Reflect.ownKeys(v);if(keys.length!==2||keys.some(k=>typeof k!=='string'||!['consentId','attemptKey'].includes(k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value')))fail();
 const r=v as Record<string,unknown>;if(!uuid(r.consentId)||!id(r.attemptKey))fail();return {consentId:r.consentId,attemptKey:r.attemptKey};
}
function clock(override?:number){const now=override===undefined?Date.now():override;if(!uint(now,1))fail();return now;}
type Snapshot=ReturnType<typeof readTrustedPaperRuntimeConsentInTransaction>;
type Attempt=Snapshot['journal']['attempts'][number];
function key(s:Snapshot,a:Attempt){return 'runtime:'+sha(JSON.stringify(['paper-runtime-attempt-effects-v1',s.consentId,s.definitionId,s.definitionDigest,a.attemptKey,a.attemptId]));}
function proposal(s:Snapshot,k:string){
 const d=s.definition,base={accountId:d.accountId,policyId:d.policyId,policyRevision:d.policyRevision,appRevision:d.appRevision,currency:s.currency,symbol:d.strategy.symbol};
 return d.strategy.side==='buy'?{...base,side:'buy' as const,notional:d.strategy.amount,idempotencyKey:k}:{...base,quantityUnits:d.strategy.amount,idempotencyKey:k};
}
function linked(db:Database.Database,s:Snapshot,a:Attempt){
 const k=key(s,a),d=s.definition,buy=db.prepare('SELECT r.*,i.canonical_json,i.profile_json,i.profile_hash FROM main.paper_reservations r LEFT JOIN main.paper_reservation_intents i ON i.reservation_id=r.reservation_id WHERE r.account_id=? AND r.idempotency_key=?').get(d.accountId,k) as Record<string,unknown>|undefined;
 const sell=db.prepare('SELECT * FROM main.paper_sell_reservations WHERE account_id=? AND idempotency_key=?').get(d.accountId,k) as Record<string,unknown>|undefined;
 const ticks=db.prepare('SELECT * FROM main.paper_bot_ticks WHERE tick_key=? LIMIT 2').all(k) as Record<string,unknown>[];
 return {k,buy,sell,ticks};
}
function noEffects(db:Database.Database,s:Snapshot,a:Attempt){
 const l=linked(db,s,a);if(l.buy||l.sell||l.ticks.length)fail();
}
function replayCompleted(db:Database.Database,s:Snapshot,a:Attempt,now:number){
 const l=linked(db,s,a),d=s.definition,r=d.strategy.side==='buy'?l.buy:l.sell;
 if(!r||d.strategy.side==='buy'&&l.sell||d.strategy.side==='sell'&&l.buy||l.ticks.length!==1||a.finishedAt===null)fail();
 const reservationId=d.strategy.side==='buy'?r.reservation_id:r.id,canonical=d.strategy.side==='buy'?r.canonical_json:r.intent_json;
 if(!id(reservationId)||canonical!==JSON.stringify(proposal(s,l.k))||r.intent_hash!==sha(canonical as string)||r.policy_id!==d.policyId||!uint(r.created_at,1)||r.created_at<a.claimedAt||r.created_at>a.finishedAt||r.cancelled_at!==null)fail();
 if(typeof r.profile_json!=='string'||Buffer.byteLength(r.profile_json,'utf8')>8192||sha(r.profile_json)!==d.profileHash||r.profile_hash!==d.profileHash)fail();
 const t=l.ticks[0];if(t.bot_id!==d.botId||t.account_id!==d.accountId||t.policy_id!==d.policyId||t.policy_revision!==d.policyRevision||t.app_revision!==d.appRevision||t.tick_key!==l.k||t.side!==d.strategy.side||t.reservation_id!==reservationId||t.created_at!==r.created_at)fail();
 const result=runPaperBotTickInTransaction(db,s.ownerId,{botId:d.botId,tickKey:l.k,side:d.strategy.side,reservationId},now);
 if(!('ok' in result)||result.ok!==true||result.replayed!==true||!('fillId' in result)||!id(result.fillId))fail();
 return Object.freeze({ok:true as const,consentId:s.consentId,attemptId:a.attemptId,status:'completed' as const,replayed:true,fillId:result.fillId,mode:'paper' as const,runtimeConnected:false as const});
}
function existing(db:Database.Database,s:Snapshot,a:Attempt,now:number){
 const raw=db.prepare('SELECT lease_ms FROM main.paper_dispatch_attempts WHERE id=? AND definition_id=? AND owner_id=?').get(a.attemptId,s.definitionId,s.ownerId) as {lease_ms:number}|undefined;if(raw?.lease_ms!==60000)fail();
 if(a.status==='completed')return replayCompleted(db,s,a,now);
 if(a.status==='failed')noEffects(db,s,a);
 return Object.freeze({ok:true as const,consentId:s.consentId,attemptId:a.attemptId,status:a.status,replayed:true,mode:'paper' as const,runtimeConnected:false as const});
}
/**
 * Exact consent/key only. Claims persist before effects; crashes consume budget and leave pending/unknown.
 * The two write transactions intentionally recheck authority after the durable claim. Unknown work is never retried.
 */
export function dispatchPaperRuntimeAttempt(db:Database.Database,value:unknown,nowOverride?:number){
 try{
  if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||db.inTransaction)fail();const r=request(value);
  const initial=db.transaction(()=>{
   const now=clock(nowOverride),s=readTrustedPaperRuntimeConsentInTransaction(db,r.consentId,now),a=s.journal.attempts.find(a=>a.attemptKey===r.attemptKey);
   if(s.runtimePrincipal!=='bundled.paper.deterministic.v1')fail();
   if(a&&a.status!=='pending')return {snapshot:s,terminal:existing(db,s,a,now)};
   if(!a)assertPaperRuntimeEligibilityInTransaction(db,r.consentId,now);
   return {snapshot:s,terminal:null};
  }).deferred();
  if(initial.terminal)return initial.terminal;
  const s=initial.snapshot,claim=claimPaperDispatchAttempt(db,s.ownerId,{definitionId:s.definitionId,definitionDigest:s.definitionDigest,attemptKey:r.attemptKey,leaseMs:60000},nowOverride);
  if(!claim.ok)return deny();
  if(claim.replayed){
   return db.transaction(()=>{
    const now=clock(nowOverride),current=readTrustedPaperRuntimeConsentInTransaction(db,r.consentId,now),a=current.journal.attempts.find(a=>a.attemptId===claim.attemptId);if(!a)fail();return existing(db,current,a,now);
   }).deferred();
  }
  if(!('fenceToken' in claim)||typeof claim.fenceToken!=='string')fail();
  return db.transaction(()=>{
   const now=clock(nowOverride),current=readTrustedPaperRuntimeConsentInTransaction(db,r.consentId,now),a=current.journal.attempts.find(a=>a.attemptId===claim.attemptId);
   if(!a||a.status!=='pending'||now>=a.leaseUntil)fail();
   // Missing/colliding original effects are ambiguous; do not turn them into failed/no-effect acknowledgments.
   noEffects(db,current,a);
   try{
    return db.transaction(()=>{
     let eligible:Snapshot;try{eligible=assertPaperRuntimeEligibilityInTransaction(db,r.consentId,now);}catch{throw business;}
     const d=eligible.definition,k=key(eligible,a),p=proposal(eligible,k);
     const reserved=d.strategy.side==='buy'?reservePaperOrder(db,eligible.ownerId,p,()=>now):reservePaperSell(db,eligible.ownerId,p,()=>now);
     if(!reserved.ok)throw business;if(reserved.replayed)fail();
     const result=runPaperBotTickInTransaction(db,eligible.ownerId,{botId:d.botId,tickKey:k,side:d.strategy.side,reservationId:reserved.reservationId},now);
     if(!('ok' in result)||result.ok!==true||result.replayed!==false)fail();
     // Final successful bot tick may exactly reach the cap; only this postcheck permits equality.
     const completedAt=clock(nowOverride);if(completedAt<now||completedAt>=a.leaseUntil)throw business;
     try{assertPaperRuntimeEligibilityInTransaction(db,r.consentId,completedAt,true);}catch{throw business;}
     const finished=finishPaperDispatchAttemptInTransaction(db,eligible.ownerId,{definitionId:eligible.definitionId,definitionDigest:eligible.definitionDigest,attemptKey:r.attemptKey,fenceToken:claim.fenceToken,outcome:'completed'},completedAt);
     if(!finished.ok||finished.replayed||finished.status!=='completed')fail();
     const after=readTrustedPaperRuntimeConsentInTransaction(db,r.consentId,completedAt),saved=after.journal.attempts.find(x=>x.attemptId===a.attemptId);if(!saved)fail();
     const ack=replayCompleted(db,after,saved,completedAt);return Object.freeze({...ack,replayed:false});
    })();
   }catch(error){
    if(error!==business&&!isPaperBotTickRefusal(error))throw error;
    noEffects(db,current,a);
    const failedAt=clock(nowOverride);if(failedAt<now||failedAt>=a.leaseUntil)fail();
    const finished=finishPaperDispatchAttemptInTransaction(db,current.ownerId,{definitionId:current.definitionId,definitionDigest:current.definitionDigest,attemptKey:r.attemptKey,fenceToken:claim.fenceToken,outcome:'failed'},failedAt);
    if(!finished.ok||finished.replayed||finished.status!=='failed')fail();
    const after=readTrustedPaperRuntimeConsentInTransaction(db,r.consentId,failedAt),saved=after.journal.attempts.find(x=>x.attemptId===a.attemptId);if(!saved)fail();return Object.freeze({...existing(db,after,saved,failedAt),replayed:false});
   }
  }).immediate();
 }catch{return deny();}
}
