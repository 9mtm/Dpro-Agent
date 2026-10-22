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
type Status='pending'|'cancelled';
type Result={ok:true;reservationId:string;replayed:boolean;notional:number;status:Status}|{ok:false;reason:string};
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x))&&Reflect.ownKeys(x).every(k=>typeof k==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(x,k)!,'value'));
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const uint=(x:unknown,min=0):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=min;
type Account={owner_id:string;currency:string;mode:string;cash:number;exposure:number;app_enabled:number;app_revision:number;stopped:number};
const validAccount=(a:Account)=>a.mode==='paper'&&/^[A-Z]{3}$/.test(a.currency)&&uint(a.cash)&&uint(a.exposure)&&uint(a.app_revision,1)&&[0,1].includes(a.app_enabled)&&[0,1].includes(a.stopped);
function totals(db:Database.Database,accountId:string,policyId='',now=0){
 try{
  const row=db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='pending' THEN notional ELSE 0 END),0) reserved,
   COUNT(*) count,COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) pending,
   COALESCE(SUM(CASE WHEN policy_id=? AND created_at>=? AND created_at<? THEN 1 ELSE 0 END),0) orders,
   COALESCE(MAX(CASE WHEN policy_id=? THEN created_at ELSE 0 END),0) last,
   COALESCE(SUM(CASE WHEN status NOT IN ('pending','cancelled') OR typeof(notional)!='integer' OR notional<=0 OR notional>9007199254740991 OR typeof(created_at)!='integer' OR created_at<0 OR created_at>9007199254740991 OR (status='pending' AND cancelled_at IS NOT NULL) OR (status='cancelled' AND (cancelled_at IS NULL OR typeof(cancelled_at)!='integer' OR cancelled_at<created_at OR cancelled_at>9007199254740991)) THEN 1 ELSE 0 END),0) invalid
   FROM paper_reservations WHERE account_id=?`).safeIntegers(true).get(policyId,Math.floor(now/86400000)*86400000,Math.floor(now/86400000)*86400000+86400000,policyId,accountId) as Record<string,bigint>;
  if(Object.values(row).some(n=>n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))||row.invalid!==0n)return null;
  return {reserved:Number(row.reserved),count:Number(row.count),pending:Number(row.pending),orders:Number(row.orders),last:Number(row.last)};
 }catch(error){if(error instanceof Error&&error.message==='integer overflow')return null;throw error;}
}
const fields=['accountId','policyId','policyRevision','appRevision','currency','symbol','side','notional','idempotencyKey'];
function proposal(x:unknown):x is PaperProposal {
 return object(x)&&Object.keys(x).length===fields.length&&fields.every(k=>Object.hasOwn(x,k))&&['accountId','policyId','symbol','idempotencyKey'].every(k=>id(x[k]))&&uint(x.policyRevision,1)&&uint(x.appRevision,1)&&uint(x.notional,1)&&typeof x.currency==='string'&&/^[A-Z]{3}$/.test(x.currency)&&['buy','sell'].includes(x.side as string);
}
function policyValid(p:unknown):p is PaperPolicy {
 return object(p)&&['id','ownerId','accountId'].every(k=>id(p[k]))&&['revision','appRevision','expiresAt','maxOrder','maxExposure','maxDailyLoss','maxOrders','maxQuoteAgeMs'].every(k=>uint(p[k],1))&&uint(p.cooldownMs)&&typeof p.enabled==='boolean'&&p.mode==='paper'&&typeof p.currency==='string'&&/^[A-Z]{3}$/.test(p.currency)&&Array.isArray(p.symbols)&&p.symbols.length>0&&p.symbols.length<=500&&p.symbols.every(id);
}
export function initializePaperLedger(db:Database.Database):void {
 db.transaction(()=>{
 db.exec(`CREATE TABLE IF NOT EXISTS paper_accounts(account_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode='paper'), currency TEXT NOT NULL, cash INTEGER NOT NULL CHECK(cash>=0), exposure INTEGER NOT NULL CHECK(exposure>=0), app_enabled INTEGER NOT NULL, app_revision INTEGER NOT NULL, stopped INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS paper_policies(policy_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, revision INTEGER NOT NULL, policy_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS paper_quotes(account_id TEXT NOT NULL,symbol TEXT NOT NULL,quote_at INTEGER NOT NULL,PRIMARY KEY(account_id,symbol));
 CREATE TABLE IF NOT EXISTS paper_reservations(reservation_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,policy_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,intent_hash TEXT NOT NULL,notional INTEGER NOT NULL CHECK(notional>0),created_at INTEGER NOT NULL,UNIQUE(account_id,idempotency_key));`);
 // Explicit caller-owned initialization upgrades the preceding reservation-only schema.
 const columns=(db.prepare('PRAGMA table_info(paper_reservations)').all() as {name:string}[]).map(c=>c.name);
 if(!columns.includes('status'))db.exec("ALTER TABLE paper_reservations ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','cancelled'))");
 if(!columns.includes('cancelled_at'))db.exec('ALTER TABLE paper_reservations ADD COLUMN cancelled_at INTEGER');
 db.exec('CREATE INDEX IF NOT EXISTS paper_reservations_account_history ON paper_reservations(account_id,created_at,reservation_id)');
 }).immediate();
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
  if(!a||a.owner_id!==ownerId||!validAccount(a))return {ok:false,reason:'unavailable'};
  const old=db.prepare('SELECT reservation_id,intent_hash,notional,status FROM paper_reservations WHERE account_id=? AND idempotency_key=?').get(intent.accountId,intent.idempotencyKey) as {reservation_id:string;intent_hash:string;notional:number;status:Status}|undefined;
  if(old){if(!['pending','cancelled'].includes(old.status)||!uint(old.notional,1))return {ok:false,reason:'unavailable'};return old.intent_hash===hash?{ok:true,reservationId:old.reservation_id,replayed:true,notional:old.notional,status:old.status}:{ok:false,reason:'idempotency_conflict'};}
  const row=db.prepare('SELECT * FROM paper_policies WHERE policy_id=? AND account_id=?').get(intent.policyId,intent.accountId) as {revision:number;policy_json:string}|undefined;
  const quote=db.prepare('SELECT quote_at FROM paper_quotes WHERE account_id=? AND symbol=?').get(intent.accountId,intent.symbol) as {quote_at:number}|undefined;
  if(!row||!quote)return {ok:false,reason:'unavailable'};
  const p:unknown=JSON.parse(row.policy_json);if(!policyValid(p)||p.revision!==row.revision)return {ok:false,reason:'unavailable'};
  const summary=totals(db,intent.accountId,p.id,now);if(!summary)return {ok:false,reason:'limit'};
  const {reserved,orders,last:lastOrderAt}=summary;
  // No fills exist: daily losses are zero. Cancellation never resets accepted-order history.
  const verdict=admitPaperOrder(p,intent,{accountId:intent.accountId,policyId:p.id,policyRevision:row.revision,appRevision:a.app_revision,currency:a.currency,quoteSymbol:intent.symbol,accountMode:a.mode,ownerId,appEnabled:a.app_enabled===1,stopped:a.stopped!==0,now,quoteAt:quote.quote_at,exposure:a.exposure,reserved,dailyLoss:0,orders,lastOrderAt});
  if(!verdict.allowed)return {ok:false,reason:verdict.reason};
  if(reserved>a.cash||intent.notional>a.cash-reserved)return {ok:false,reason:'cash'};
  const reservationId=randomUUID();
  db.prepare('INSERT INTO paper_reservations(reservation_id,account_id,policy_id,idempotency_key,intent_hash,notional,created_at) VALUES(?,?,?,?,?,?,?)').run(reservationId,intent.accountId,p.id,intent.idempotencyKey,hash,intent.notional,now);
  return {ok:true,reservationId,replayed:false,notional:intent.notional,status:'pending'};
 }).immediate();
}

/** One-way emergency stop. It does not cancel pending reservations or any future in-flight fills. */
export function stopPaperAccount(db:Database.Database,ownerId:string,accountId:string):boolean {
 if(![ownerId,accountId].every(id))return false;
 return db.transaction(()=>db.prepare('UPDATE paper_accounts SET stopped=1 WHERE account_id=? AND owner_id=?').run(accountId,ownerId).changes===1).immediate();
}
/** One-way disable; no implicit resume/re-enable capability is provided. */
export function disablePaperApp(db:Database.Database,ownerId:string,accountId:string):boolean {
 if(![ownerId,accountId].every(id))return false;
 return db.transaction(()=>db.prepare('UPDATE paper_accounts SET app_enabled=0 WHERE account_id=? AND owner_id=?').run(accountId,ownerId).changes===1).immediate();
}

/** Pending reservations only: no broker cancellation or fill lifecycle is implied. */
export function cancelPaperReservation(db:Database.Database,ownerId:string,accountId:string,reservationId:string,clock:()=>number=Date.now):Result {
 if(![ownerId,accountId,reservationId].every(id))return {ok:false,reason:'invalid'};
 return db.transaction(():Result=>{
  const now=clock();if(!uint(now))return {ok:false,reason:'invalid_clock'};
  const account=db.prepare('SELECT owner_id FROM paper_accounts WHERE account_id=?').get(accountId) as {owner_id:string}|undefined;
  if(account?.owner_id!==ownerId)return {ok:false,reason:'unavailable'};
  const row=db.prepare('SELECT notional,status,created_at FROM paper_reservations WHERE account_id=? AND reservation_id=?').get(accountId,reservationId) as {notional:number;status:Status;created_at:number}|undefined;
  if(!row||!uint(row.notional,1)||!['pending','cancelled'].includes(row.status))return {ok:false,reason:'unavailable'};
  if(row.status==='cancelled')return {ok:true,reservationId,replayed:true,notional:row.notional,status:'cancelled'};
  if(now<row.created_at)return {ok:false,reason:'invalid_clock'};
  db.prepare("UPDATE paper_reservations SET status='cancelled',cancelled_at=? WHERE account_id=? AND reservation_id=? AND status='pending'").run(now,accountId,reservationId);
  return {ok:true,reservationId,replayed:false,notional:row.notional,status:'cancelled'};
 }).immediate();
}

/** Safe owner-scoped read model. HTTP authentication remains the caller's responsibility. */
export function readPaperAccount(db:Database.Database,ownerId:string,accountId:string){
 if(![ownerId,accountId].every(id))return {ok:false as const,reason:'invalid'};
 return db.transaction(()=>{
  const a=db.prepare('SELECT owner_id,mode,currency,cash,exposure,app_enabled,app_revision,stopped FROM paper_accounts WHERE account_id=?').get(accountId) as {owner_id:string;mode:string;currency:string;cash:number;exposure:number;app_enabled:number;app_revision:number;stopped:number}|undefined;
  if(!a||a.owner_id!==ownerId||!validAccount(a))return {ok:false as const,reason:'unavailable'};
  const summary=totals(db,accountId);if(!summary)return {ok:false as const,reason:'unavailable'};
  const {reserved,pending:pendingCount}=summary;
  const rows=db.prepare('SELECT reservation_id,policy_id,notional,created_at,status,cancelled_at FROM paper_reservations WHERE account_id=? ORDER BY created_at DESC,reservation_id DESC LIMIT 200').all(accountId) as {reservation_id:string;policy_id:string;notional:number;created_at:number;status:Status;cancelled_at:number|null}[];
  if(reserved>a.cash||!Number.isSafeInteger(a.exposure+reserved)||rows.some(r=>!id(r.reservation_id)||!id(r.policy_id)))return {ok:false as const,reason:'unavailable'};
  const policies=db.prepare('SELECT policy_id,revision,policy_json FROM paper_policies WHERE account_id=? ORDER BY policy_id').all(accountId) as {policy_id:string;revision:number;policy_json:string}[];
  const safePolicies=[];
  for(const row of policies){let p:unknown;try{p=JSON.parse(row.policy_json);}catch{return {ok:false as const,reason:'unavailable'};}if(!policyValid(p)||p.id!==row.policy_id||p.accountId!==accountId||p.ownerId!==ownerId||p.revision!==row.revision)return {ok:false as const,reason:'unavailable'};safePolicies.push({id:row.policy_id,revision:row.revision,enabled:p.enabled,expiresAt:p.expiresAt});}
  return {ok:true as const,accountId,mode:a.mode,currency:a.currency,cash:a.cash,availableCash:a.cash-reserved,exposure:a.exposure,pendingExposure:reserved,totalExposure:a.exposure+reserved,pendingCount,appEnabled:a.app_enabled===1,appRevision:a.app_revision,stopped:a.stopped!==0,policies:safePolicies,reservationCount:summary.count,reservations:rows.reverse().map(r=>({id:r.reservation_id,policyId:r.policy_id,notional:r.notional,createdAt:r.created_at,status:r.status,cancelledAt:r.cancelled_at}))};
 }).deferred();
}
