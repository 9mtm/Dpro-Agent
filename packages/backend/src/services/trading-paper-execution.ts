/** Whole-unit buy simulation only. Explicit caller-owned SQLite initialization; no runtime or broker adapter. */
import type Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {admitPaperOrder} from './trading-paper-policy.js';
import {paperLedgerTotals,paperFillFeeLoss,hasPaperTable} from './trading-paper-ledger.js';
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const uint=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value'));
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const MAX=BigInt(Number.MAX_SAFE_INTEGER),safe=(v:bigint)=>v>=0n&&v<=MAX;
const ceil=(n:bigint,d:bigint)=>(n+d-1n)/d;
const deny=(reason:string)=>({ok:false as const,reason});
type Profile={account_id:string;owner_id:string;revision:number;fee_bps:number;slippage_bps:number;unit_scale:number;currency:string};
type Quote={account_id:string;symbol:string;price_minor:number;quoted_at:number;revision:number;currency:string;unit_scale:number};
type Fill={fill_id:string;account_id:string;reservation_id:string;execution_key:string;request_hash:string;intent_hash:string;quantity_units:number;price_minor:number;fee_minor:number;total_minor:number;created_at:number};
const profileRead='SELECT account_id,owner_id,revision,fee_bps,slippage_bps,unit_scale,currency FROM paper_execution_profiles WHERE account_id=?';
const quoteRead='SELECT account_id,symbol,price_minor,quoted_at,revision,currency,unit_scale FROM paper_execution_quotes WHERE account_id=? AND symbol=?';
function profileValid(p:Profile){return id(p.account_id)&&id(p.owner_id)&&uint(p.revision,1)&&uint(p.fee_bps)&&p.fee_bps<=10000&&uint(p.slippage_bps)&&p.slippage_bps<=10000&&p.unit_scale===1&&typeof p.currency==='string'&&/^[A-Z]{3}$/.test(p.currency);}
function quoteValid(q:Quote){return id(q.account_id)&&id(q.symbol)&&uint(q.price_minor,1)&&uint(q.quoted_at)&&uint(q.revision,1)&&q.unit_scale===1&&typeof q.currency==='string'&&/^[A-Z]{3}$/.test(q.currency);}
export function initializePaperExecution(db:Database.Database){db.transaction(()=>db.exec(`
 CREATE TABLE IF NOT EXISTS paper_execution_profiles(account_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,revision INTEGER NOT NULL,fee_bps INTEGER NOT NULL,slippage_bps INTEGER NOT NULL,unit_scale INTEGER NOT NULL,currency TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS paper_execution_quotes(account_id TEXT NOT NULL,symbol TEXT NOT NULL,price_minor INTEGER NOT NULL,quoted_at INTEGER NOT NULL,revision INTEGER NOT NULL,currency TEXT NOT NULL,unit_scale INTEGER NOT NULL,PRIMARY KEY(account_id,symbol));
 CREATE TABLE IF NOT EXISTS paper_fills(fill_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,execution_key TEXT NOT NULL,request_hash TEXT NOT NULL,intent_hash TEXT NOT NULL,quantity_units INTEGER NOT NULL,price_minor INTEGER NOT NULL,fee_minor INTEGER NOT NULL,total_minor INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(account_id,execution_key));
 CREATE TABLE IF NOT EXISTS paper_positions(account_id TEXT NOT NULL,symbol TEXT NOT NULL,quantity_units INTEGER NOT NULL,cost_minor INTEGER NOT NULL,PRIMARY KEY(account_id,symbol));
 `)).immediate();}
/** Trusted reviewed configuration only, not a human authorization implementation. */
export function configurePaperExecution(db:Database.Database,input:{ownerId:string;accountId:string;revision:number;feeBps:number;slippageBps:number;unitScale:number;currency:string}){
 if(!record(input))throw Error('invalid execution profile');
 const p:Profile={account_id:input.accountId,owner_id:input.ownerId,revision:input.revision,fee_bps:input.feeBps,slippage_bps:input.slippageBps,unit_scale:input.unitScale,currency:input.currency};if(!profileValid(p))throw Error('invalid execution profile');
 db.transaction(()=>{const account=db.prepare('SELECT owner_id,mode,currency FROM paper_accounts WHERE account_id=?').get(p.account_id) as {owner_id:string;mode:string;currency:string}|undefined;if(!account||account.owner_id!==p.owner_id||account.mode!=='paper'||account.currency!==p.currency)throw Error('unavailable execution account');
 const old=db.prepare(profileRead).get(p.account_id) as Profile|undefined;if(old&&old.revision>=p.revision){if(JSON.stringify(old)===JSON.stringify(p))return;throw Error('execution profile revision conflict');}
 db.prepare('INSERT INTO paper_execution_profiles VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET owner_id=excluded.owner_id,revision=excluded.revision,fee_bps=excluded.fee_bps,slippage_bps=excluded.slippage_bps,unit_scale=excluded.unit_scale,currency=excluded.currency').run(p.account_id,p.owner_id,p.revision,p.fee_bps,p.slippage_bps,p.unit_scale,p.currency);
 }).immediate();
}
/** Trusted ingestion only. Price and ordinary freshness timestamp commit together. */
export function recordPaperExecutionQuote(db:Database.Database,input:{accountId:string;symbol:string;priceMinor:number;quotedAt:number;revision:number;currency:string;unitScale:number}){
 if(!record(input))throw Error('invalid execution quote');const q:Quote={account_id:input.accountId,symbol:input.symbol,price_minor:input.priceMinor,quoted_at:input.quotedAt,revision:input.revision,currency:input.currency,unit_scale:input.unitScale};if(!quoteValid(q))throw Error('invalid execution quote');
 db.transaction(()=>{const account=db.prepare('SELECT mode,currency FROM paper_accounts WHERE account_id=?').get(q.account_id) as {mode:string;currency:string}|undefined;if((account?.mode!=='paper'||account.currency!==q.currency))throw Error('unavailable execution account');const old=db.prepare(quoteRead).get(q.account_id,q.symbol) as Quote|undefined;if(old&&old.revision>=q.revision){if(JSON.stringify(old)===JSON.stringify(q))return;throw Error('execution quote revision conflict');}
 db.prepare('INSERT INTO paper_execution_quotes VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,symbol) DO UPDATE SET price_minor=excluded.price_minor,quoted_at=excluded.quoted_at,revision=excluded.revision,currency=excluded.currency,unit_scale=excluded.unit_scale').run(q.account_id,q.symbol,q.price_minor,q.quoted_at,q.revision,q.currency,q.unit_scale);
 db.prepare('INSERT INTO paper_quotes VALUES(?,?,?) ON CONFLICT(account_id,symbol) DO UPDATE SET quote_at=excluded.quote_at').run(q.account_id,q.symbol,q.quoted_at);
 }).immediate();
}
const receipt=(f:Fill,replayed:boolean)=>({ok:true as const,fillId:f.fill_id,status:'filled' as const,replayed,quantityUnits:f.quantity_units,priceMinor:f.price_minor,feeMinor:f.fee_minor,totalMinor:f.total_minor});
/** Request contains identity only. All price, policy, cash and fee authority is reloaded under the write lock. */
export function executePaperBuy(db:Database.Database,ownerId:string,input:unknown,clock:()=>number=Date.now){
 if(!id(ownerId)||!record(input)||Object.keys(input).length!==3||!['accountId','reservationId','executionKey'].every(k=>id(input[k])))return deny('invalid');
 const accountId=input.accountId as string,reservationId=input.reservationId as string,executionKey=input.executionKey as string,requestHash=hash(JSON.stringify({accountId,reservationId,executionKey}));
 return db.transaction(()=>{
  const now=clock();if(!uint(now))return deny('invalid_clock');
  const a=db.prepare('SELECT * FROM paper_accounts WHERE account_id=?').get(accountId) as {owner_id:string;mode:string;currency:string;cash:number;exposure:number;app_enabled:number;app_revision:number;stopped:number}|undefined;
  if(!a||a.owner_id!==ownerId||a.mode!=='paper'||!uint(a.cash)||!uint(a.exposure)||!uint(a.app_revision,1)||![0,1].includes(a.app_enabled)||![0,1].includes(a.stopped))return deny('unavailable');
  if(hasPaperTable(db,'paper_sell_fills')&&db.prepare('SELECT 1 FROM paper_sell_fills WHERE account_id=? AND execution_key=?').get(accountId,executionKey))return deny('idempotency_conflict');
  const old=db.prepare('SELECT * FROM paper_fills WHERE account_id=? AND execution_key=?').get(accountId,executionKey) as Fill|undefined;
  if(old){
   if(old.request_hash!==requestHash||old.reservation_id!==reservationId||!id(old.fill_id)||![old.quantity_units,old.price_minor,old.total_minor].every(v=>uint(v,1))||!uint(old.fee_minor)||!uint(old.created_at)||typeof old.intent_hash!=='string'||!/^[a-f0-9]{64}$/.test(old.intent_hash)||BigInt(old.quantity_units)*BigInt(old.price_minor)+BigInt(old.fee_minor)!==BigInt(old.total_minor))return deny('idempotency_conflict');
   const original=db.prepare('SELECT r.intent_hash,r.notional,i.canonical_json FROM paper_reservations r JOIN paper_reservation_intents i ON i.reservation_id=r.reservation_id WHERE r.account_id=? AND r.reservation_id=?').get(accountId,reservationId) as {intent_hash:string;notional:number;canonical_json:string}|undefined;
   if(!original||original.intent_hash!==old.intent_hash||typeof original.canonical_json!=='string'||original.canonical_json.length>8192||hash(original.canonical_json)!==old.intent_hash||!uint(original.notional,1)||old.total_minor>original.notional)return deny('idempotency_conflict');
   return receipt(old,true);
  }
  if(db.prepare('SELECT 1 FROM paper_fills WHERE reservation_id=?').get(reservationId))return deny('already_filled');
  const r=db.prepare('SELECT * FROM paper_reservations WHERE account_id=? AND reservation_id=?').get(accountId,reservationId) as {notional:number;status:string;created_at:number;policy_id:string;intent_hash:string}|undefined;
  const saved=db.prepare('SELECT * FROM paper_reservation_intents WHERE reservation_id=?').get(reservationId) as {canonical_json:string;profile_json:string|null;profile_hash:string|null;quote_json:string|null;quote_hash:string|null}|undefined;
  if(!r||r.status!=='pending'||!uint(r.notional,1)||!uint(r.created_at)||r.created_at>now||!saved||typeof saved.canonical_json!=='string'||saved.canonical_json.length>8192||hash(saved.canonical_json)!==r.intent_hash)return deny('unavailable');
  let intent:Record<string,unknown>,p:Record<string,unknown>;try{intent=JSON.parse(saved.canonical_json);const row=db.prepare('SELECT policy_json,revision FROM paper_policies WHERE policy_id=? AND account_id=?').get(r.policy_id,accountId) as {policy_json:string;revision:number}|undefined;if(!row||row.policy_json.length>65536)return deny('unavailable');p=JSON.parse(row.policy_json);if(!record(p)||p.revision!==row.revision)return deny('unavailable');}catch{return deny('unavailable');}
  if(!record(intent)||intent.accountId!==accountId||intent.policyId!==r.policy_id||intent.notional!==r.notional||intent.side!=='buy'||typeof intent.symbol!=='string')return deny('unsupported_intent');
  const profile=db.prepare(profileRead).get(accountId) as Profile|undefined,quote=db.prepare(quoteRead).get(accountId,intent.symbol) as Quote|undefined;
  if(!profile||!quote||!profileValid(profile)||!quoteValid(quote)||profile.owner_id!==ownerId||profile.currency!==a.currency||quote.currency!==a.currency||JSON.stringify(profile)!==saved.profile_json||hash(JSON.stringify(profile))!==saved.profile_hash||JSON.stringify(quote)!==saved.quote_json||hash(JSON.stringify(quote))!==saved.quote_hash)return deny('execution_snapshot_changed');
  const ordinary=db.prepare('SELECT quote_at FROM paper_quotes WHERE account_id=? AND symbol=?').get(accountId,intent.symbol) as {quote_at:number}|undefined;if(ordinary?.quote_at!==quote.quoted_at)return deny('quote');
  const price=ceil(BigInt(quote.price_minor)*(10000n+BigInt(profile.slippage_bps)),10000n);if(!safe(price)||price===0n)return deny('limit');
  const quantity=BigInt(r.notional)*10000n/(price*(10000n+BigInt(profile.fee_bps))),gross=quantity*price,fee=ceil(gross*BigInt(profile.fee_bps),10000n),total=gross+fee;
  if(quantity<1n||![quantity,gross,fee,total].every(safe)||total>BigInt(r.notional))return deny('limit');
  const summary=paperLedgerTotals(db,accountId,r.policy_id,now,reservationId),loss=paperFillFeeLoss(db,accountId,now);if(!summary||loss===null||summary.reserved<r.notional||!uint(p.maxDailyLoss,1)||BigInt(loss)+fee>BigInt(p.maxDailyLoss))return deny('limit');
  const reserved=summary.reserved-r.notional,verdict=admitPaperOrder(p,{...intent,notional:Number(total)},{accountId,policyId:p.id,policyRevision:p.revision,appRevision:a.app_revision,currency:a.currency,quoteSymbol:quote.symbol,accountMode:a.mode,ownerId,appEnabled:a.app_enabled===1,stopped:a.stopped!==0,now,quoteAt:quote.quoted_at,exposure:a.exposure,reserved,dailyLoss:loss,orders:summary.orders,lastOrderAt:summary.last});
  if(!verdict.allowed)return deny(verdict.reason);if(total+BigInt(reserved)>BigInt(a.cash)||!safe(BigInt(a.exposure)+gross))return deny('cash');
  const position=db.prepare('SELECT quantity_units,cost_minor FROM paper_positions WHERE account_id=? AND symbol=?').get(accountId,intent.symbol) as {quantity_units:number;cost_minor:number}|undefined;
  if(position&&(!uint(position.quantity_units)||!uint(position.cost_minor)))return deny('unavailable');const units=BigInt(position?.quantity_units??0)+quantity,cost=BigInt(position?.cost_minor??0)+gross;if(!safe(units)||!safe(cost))return deny('limit');
  const fill:Fill={fill_id:randomUUID(),account_id:accountId,reservation_id:reservationId,execution_key:executionKey,request_hash:requestHash,intent_hash:r.intent_hash,quantity_units:Number(quantity),price_minor:Number(price),fee_minor:Number(fee),total_minor:Number(total),created_at:now};
  db.prepare('UPDATE paper_accounts SET cash=?,exposure=? WHERE account_id=?').run(a.cash-Number(total),a.exposure+Number(gross),accountId);
  db.prepare('INSERT INTO paper_positions VALUES(?,?,?,?) ON CONFLICT(account_id,symbol) DO UPDATE SET quantity_units=excluded.quantity_units,cost_minor=excluded.cost_minor').run(accountId,intent.symbol,Number(units),Number(cost));
  db.prepare('INSERT INTO paper_fills VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(fill.fill_id,accountId,reservationId,executionKey,requestHash,r.intent_hash,fill.quantity_units,fill.price_minor,fill.fee_minor,fill.total_minor,now);
  return receipt(fill,false);
 }).immediate();
}
