/** SQLite-only reservation foundation. No fills, broker calls or runtime registration. */
import type Database from 'better-sqlite3';
import {createHash, randomUUID} from 'node:crypto';
import {admitPaperOrder} from './trading-paper-policy.js';

export interface PaperPolicy {
 id:string; revision:number; appRevision:number; currency:string; ownerId:string; accountId:string;
 enabled:boolean; mode:'paper'; expiresAt:number; symbols:string[]; maxOrder:number; maxExposure:number;
 maxDailyLoss:number; maxOrders:number; cooldownMs:number; maxQuoteAgeMs:number;
}
export interface PaperProposal {
 accountId:string; policyId:string; policyRevision:number; appRevision:number; currency:string;
 symbol:string; side:'buy'|'sell'; notional:number; idempotencyKey:string;
}
type Result={ok:true;reservationId:string;replayed:boolean;notional:number}|{ok:false;reason:string};
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x))&&Reflect.ownKeys(x).every(k=>typeof k==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(x,k)!,'value'));
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const uint=(x:unknown,min=0):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=min;
const fields=['accountId','policyId','policyRevision','appRevision','currency','symbol','side','notional','idempotencyKey'];
function proposal(x:unknown):x is PaperProposal {
 return object(x)&&Object.keys(x).length===fields.length&&fields.every(k=>Object.hasOwn(x,k))&&['accountId','policyId','symbol','idempotencyKey'].every(k=>id(x[k]))&&uint(x.policyRevision,1)&&uint(x.appRevision,1)&&uint(x.notional,1)&&typeof x.currency==='string'&&/^[A-Z]{3}$/.test(x.currency)&&['buy','sell'].includes(x.side as string);
}
function policyValid(p:unknown):p is PaperPolicy {
 return object(p)&&['id','ownerId','accountId'].every(k=>id(p[k]))&&['revision','appRevision','expiresAt','maxOrder','maxExposure','maxDailyLoss','maxOrders','maxQuoteAgeMs'].every(k=>uint(p[k],1))&&uint(p.cooldownMs)&&typeof p.enabled==='boolean'&&p.mode==='paper'&&typeof p.currency==='string'&&/^[A-Z]{3}$/.test(p.currency)&&Array.isArray(p.symbols)&&p.symbols.length>0&&p.symbols.length<=500&&p.symbols.every(id);
}
export function initializePaperLedger(db:Database.Database):void {
 db.exec(`CREATE TABLE IF NOT EXISTS paper_accounts(account_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode='paper'), currency TEXT NOT NULL, cash INTEGER NOT NULL CHECK(cash>=0), exposure INTEGER NOT NULL CHECK(exposure>=0), app_enabled INTEGER NOT NULL, app_revision INTEGER NOT NULL, stopped INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS paper_policies(policy_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, revision INTEGER NOT NULL, policy_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS paper_quotes(account_id TEXT NOT NULL,symbol TEXT NOT NULL,quote_at INTEGER NOT NULL,PRIMARY KEY(account_id,symbol));
 CREATE TABLE IF NOT EXISTS paper_reservations(reservation_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,policy_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,intent_hash TEXT NOT NULL,notional INTEGER NOT NULL CHECK(notional>0),created_at INTEGER NOT NULL,UNIQUE(account_id,idempotency_key));`);
}
/** Trusted provisioning only; never expose this helper as an order/configuration endpoint. */
export function provisionPaperAccount(db:Database.Database,input:{policy:PaperPolicy;cash:number;exposure:number}):void {
 if(!object(input)||!policyValid(input.policy)||!uint(input.cash)||!uint(input.exposure))throw Error('invalid provisioning');
 const p=input.policy;
 db.transaction(()=>{
  db.prepare('INSERT INTO paper_accounts VALUES(?,?,?,?,?,?,?,?,?)').run(p.accountId,p.ownerId,'paper',p.currency,input.cash,input.exposure,1,p.appRevision,0);
  db.prepare('INSERT INTO paper_policies VALUES(?,?,?,?)').run(p.id,p.accountId,p.revision,JSON.stringify(p));
 }).immediate();
}
/** Trusted market-data ingestion; timestamps still rechecked after acquiring the reservation lock. */
export function recordPaperQuote(db:Database.Database,accountId:string,symbol:string,quoteAt:number):void {
 if(!id(accountId)||!id(symbol)||!uint(quoteAt))throw Error('invalid quote');
 db.prepare('INSERT INTO paper_quotes VALUES(?,?,?) ON CONFLICT(account_id,symbol) DO UPDATE SET quote_at=excluded.quote_at').run(accountId,symbol,quoteAt);
}
/** Revocation is deliberately one-way here. New reviewed policy provisioning is a separate concern. */
export function revokePaperPolicy(db:Database.Database,ownerId:string,accountId:string,policyId:string):boolean {
 if(![ownerId,accountId,policyId].every(id))return false;
 return db.transaction(()=>{
  const a=db.prepare('SELECT owner_id FROM paper_accounts WHERE account_id=?').get(accountId) as {owner_id:string}|undefined;
  const row=db.prepare('SELECT policy_json FROM paper_policies WHERE policy_id=? AND account_id=?').get(policyId,accountId) as {policy_json:string}|undefined;
  if(a?.owner_id!==ownerId||!row)return false;
  const p=JSON.parse(row.policy_json);p.enabled=false;
  db.prepare('UPDATE paper_policies SET policy_json=? WHERE policy_id=?').run(JSON.stringify(p),policyId);return true;
 }).immediate();
}
/** Caller supplies authenticated owner identity, never policy, balance, quote or permission snapshots. */
export function reservePaperOrder(db:Database.Database,ownerId:string,input:unknown,clock:()=>number=Date.now):Result {
 if(!id(ownerId)||!proposal(input))return {ok:false,reason:'invalid'};
 const intent={accountId:input.accountId,policyId:input.policyId,policyRevision:input.policyRevision,appRevision:input.appRevision,currency:input.currency,symbol:input.symbol,side:input.side,notional:input.notional,idempotencyKey:input.idempotencyKey};
 const hash=createHash('sha256').update(JSON.stringify(intent)).digest('hex');
 return db.transaction(():Result=>{
  const now=clock();if(!uint(now))return {ok:false,reason:'invalid_clock'};
  const a=db.prepare('SELECT * FROM paper_accounts WHERE account_id=?').get(intent.accountId) as {owner_id:string;currency:string;mode:string;cash:number;exposure:number;app_enabled:number;app_revision:number;stopped:number}|undefined;
  if(!a||a.owner_id!==ownerId||!uint(a.cash)||!uint(a.exposure))return {ok:false,reason:'unavailable'};
  const old=db.prepare('SELECT reservation_id,intent_hash,notional FROM paper_reservations WHERE account_id=? AND idempotency_key=?').get(intent.accountId,intent.idempotencyKey) as {reservation_id:string;intent_hash:string;notional:number}|undefined;
  if(old)return old.intent_hash===hash?{ok:true,reservationId:old.reservation_id,replayed:true,notional:old.notional}:{ok:false,reason:'idempotency_conflict'};
  const row=db.prepare('SELECT * FROM paper_policies WHERE policy_id=? AND account_id=?').get(intent.policyId,intent.accountId) as {revision:number;policy_json:string}|undefined;
  const quote=db.prepare('SELECT quote_at FROM paper_quotes WHERE account_id=? AND symbol=?').get(intent.accountId,intent.symbol) as {quote_at:number}|undefined;
  if(!row||!quote)return {ok:false,reason:'unavailable'};
  const p:unknown=JSON.parse(row.policy_json);if(!policyValid(p)||p.revision!==row.revision)return {ok:false,reason:'unavailable'};
  const pending=db.prepare('SELECT notional,created_at,policy_id FROM paper_reservations WHERE account_id=?').all(intent.accountId) as {notional:number;created_at:number;policy_id:string}[];
  let reserved=0,orders=0,lastOrderAt=0;
  const day=Math.floor(now/86400000);
  for(const r of pending){reserved+=r.notional;if(!Number.isSafeInteger(reserved))return {ok:false,reason:'limit'};if(r.policy_id===p.id){lastOrderAt=Math.max(lastOrderAt,r.created_at);if(Math.floor(r.created_at/86400000)===day)orders++;}}
  // No fills exist: daily losses are zero, all reservations remain pending and conservative exposure.
  const verdict=admitPaperOrder(p,intent,{accountId:intent.accountId,policyId:p.id,policyRevision:row.revision,appRevision:a.app_revision,currency:a.currency,quoteSymbol:intent.symbol,accountMode:a.mode,ownerId,appEnabled:a.app_enabled===1,stopped:a.stopped!==0,now,quoteAt:quote.quote_at,exposure:a.exposure,reserved,dailyLoss:0,orders,lastOrderAt});
  if(!verdict.allowed)return {ok:false,reason:verdict.reason};
  if(reserved>a.cash||intent.notional>a.cash-reserved)return {ok:false,reason:'cash'};
  const reservationId=randomUUID();
  db.prepare('INSERT INTO paper_reservations VALUES(?,?,?,?,?,?,?)').run(reservationId,intent.accountId,p.id,intent.idempotencyKey,hash,intent.notional,now);
  return {ok:true,reservationId,replayed:false,notional:intent.notional};
 }).immediate();
}
