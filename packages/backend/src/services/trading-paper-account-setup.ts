/** Trusted internal create-once paper setup. This is NOT human authorization or a public endpoint. */
import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import {inspectPaperBundleSchema} from './trading-paper-bundle-schema.js';
import {BUNDLED_PAPER_INSTALLATION,readPaperInstallation} from './trading-paper-installation.js';
import {readReviewedPaperInstallationAccess} from './trading-paper-install-review.js';
import {readPaperAccount,type PaperPolicy} from './trading-paper-ledger.js';
import {readPaperExecutionV2} from './trading-paper-read-v2.js';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const MAX=BigInt(Number.MAX_SAFE_INTEGER),DAY=86400000;
function fail():never{throw Error('paper account setup unavailable');}
const deny=()=>({ok:false as const,reason:'unavailable' as const});
const uint=(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
const id=(value:unknown):value is string=>typeof value==='string'&&value.length<=128&&!/[\x00-\x20\x7f]/.test(value)&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
function plain(value:unknown,keys:string[]):value is Record<string,unknown>{
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
 const own=Reflect.ownKeys(value);
 return own.length===keys.length&&own.every(key=>typeof key==='string'&&keys.includes(key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));
}
export interface PaperAccountSetupInput{
 idempotencyKey:string;accountId:string;policyId:string;installationId:string;expectedInstallationRevision:number;manifestDigest:string;currency:string;initialCashMinor:number;
 policy:{expiresAt:number;symbols:string[];maxOrder:number;maxExposure:number;maxDailyLoss:number;maxOrders:number;cooldownMs:number;maxQuoteAgeMs:number};
 execution:{feeBps:number;slippageBps:number};
}
const inputKeys=['idempotencyKey','accountId','policyId','installationId','expectedInstallationRevision','manifestDigest','currency','initialCashMinor','policy','execution'];
const policyKeys=['expiresAt','symbols','maxOrder','maxExposure','maxDailyLoss','maxOrders','cooldownMs','maxQuoteAgeMs'];
/** Current internal contract limits are explicit, not configurable defaults: cash<=1e12 minor,
 * expiry<=30 days, <=100 symbols, <=10000 orders, quote age<=300000ms, cooldown<=1 day. */
function normalize(input:unknown):PaperAccountSetupInput{
 if(!plain(input,inputKeys)||!plain(input.policy,policyKeys)||!plain(input.execution,['feeBps','slippageBps']))fail();
 const p=input.policy,e=input.execution;
 if(!['idempotencyKey','accountId','policyId'].every(key=>id(input[key]))||!uuid(input.installationId)||!uint(input.expectedInstallationRevision,1,1)
  ||input.manifestDigest!==BUNDLED_PAPER_INSTALLATION.manifestDigest||typeof input.currency!=='string'||input.currency.length!==3||!/^[A-Z]{3}$/.test(input.currency)
  ||!uint(input.initialCashMinor,1,1e12)||!uint(p.expiresAt,1)||!['maxOrder','maxExposure','maxDailyLoss'].every(key=>uint(p[key],1,input.initialCashMinor as number))
  ||Number(p.maxOrder)>Number(p.maxExposure)||!uint(p.maxOrders,1,10000)||!uint(p.cooldownMs,0,DAY)||!uint(p.maxQuoteAgeMs,1,300000)
  ||!uint(e.feeBps,0,10000)||!uint(e.slippageBps,0,10000))fail();
 const raw=p.symbols;
 if(!Array.isArray(raw)||Object.getPrototypeOf(raw)!==Array.prototype||raw.length<1||raw.length>100||Reflect.ownKeys(raw).length!==raw.length+1)fail();
 const symbols:string[]=[];
 for(let i=0;i<raw.length;i++){const descriptor=Object.getOwnPropertyDescriptor(raw,i);if(!descriptor||!Object.hasOwn(descriptor,'value')||!id(descriptor.value))fail();symbols.push(descriptor.value);}
 symbols.sort();if(new Set(symbols).size!==symbols.length)fail();
 return {idempotencyKey:input.idempotencyKey as string,accountId:input.accountId as string,policyId:input.policyId as string,installationId:input.installationId as string,expectedInstallationRevision:input.expectedInstallationRevision as number,manifestDigest:input.manifestDigest as string,currency:input.currency,initialCashMinor:input.initialCashMinor as number,
  policy:{expiresAt:p.expiresAt as number,symbols,maxOrder:p.maxOrder as number,maxExposure:p.maxExposure as number,maxDailyLoss:p.maxDailyLoss as number,maxOrders:p.maxOrders as number,cooldownMs:p.cooldownMs as number,maxQuoteAgeMs:p.maxQuoteAgeMs as number},execution:{feeBps:e.feeBps as number,slippageBps:e.slippageBps as number}};
}
const setupSQL='CREATE TABLE IF NOT EXISTS paper_account_setups(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,account_id TEXT NOT NULL UNIQUE,policy_id TEXT NOT NULL UNIQUE,installation_id TEXT NOT NULL,installation_revision INTEGER NOT NULL,request_json TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,event_hash TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(owner_id,idempotency_key));';
type ObjectRow={type:string;name:string;tbl_name:string;sql:string|null};
const objects=(db:Database.Database,temp=false)=>db.prepare(`SELECT type,name,tbl_name,sql FROM ${temp?'sqlite_temp_master':'sqlite_master'} WHERE type IN ('table','index','view','trigger') ORDER BY type,name`).all() as ObjectRow[];
const reference=new Database(':memory:');let expected:readonly ObjectRow[];
try{reference.exec(setupSQL);expected=Object.freeze(objects(reference).map(row=>Object.freeze({...row})));}finally{reference.close();}
const names=new Set(expected.map(row=>row.name.toLowerCase()));
function identity(db:Database.Database){if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db)fail();}
function schema(db:Database.Database,complete=true){
 const related=(row:ObjectRow)=>names.has(row.name.toLowerCase())||row.tbl_name.toLowerCase()==='paper_account_setups';
 const protectedNames=new Set(['users','verification_factors','verification_receipts','verification_challenges','approval_proof_policy']);
 if(objects(db,true).some(row=>related(row)||protectedNames.has(row.name.toLowerCase())||protectedNames.has(row.tbl_name.toLowerCase())))fail();
 const found=objects(db).filter(related);
 for(const row of found){const wanted=expected.find(item=>item.name===row.name);if(!wanted||JSON.stringify(wanted)!==JSON.stringify(row))fail();}
 if(complete&&found.length!==expected.length)fail();
}
function owner(db:Database.Database,ownerId:string){
 if(!id(ownerId)||isSystemAccount(ownerId))fail();
 const row=db.prepare('SELECT role,status,email_verified FROM main.users WHERE id=?').get(ownerId) as Record<string,unknown>|undefined;
 if(row?.role!=='owner'||row.status!=='active'||row.email_verified!==1)fail();
}
type SetupResult={accountId:string;policyId:string;appRevision:1;policyRevision:1;profileRevision:1;mode:'paper';runtimeConnected:false};
type Event={id:string;owner_id:string;idempotency_key:string;account_id:string;policy_id:string;installation_id:string;installation_revision:number;request_json:string;request_hash:string;result_json:string;event_hash:string;created_at:number};
const canonical=(ownerId:string,input:PaperAccountSetupInput)=>JSON.stringify({ownerId,...input});
const result=(input:PaperAccountSetupInput):SetupResult=>({accountId:input.accountId,policyId:input.policyId,appRevision:1,policyRevision:1,profileRevision:1,mode:'paper',runtimeConnected:false});
const eventHash=(row:Omit<Event,'event_hash'>)=>sha(JSON.stringify(['trusted-paper-account-setup-v1',row.id,row.owner_id,row.idempotency_key,row.account_id,row.policy_id,row.installation_id,row.installation_revision,row.request_json,row.request_hash,row.result_json,row.created_at]));
function validateEvent(row:Event,ownerId:string,input:PaperAccountSetupInput,now:number){
 if(!uuid(row.id)||row.owner_id!==ownerId||row.idempotency_key!==input.idempotencyKey||row.account_id!==input.accountId||row.policy_id!==input.policyId||row.installation_id!==input.installationId||row.installation_revision!==input.expectedInstallationRevision
  ||!uint(row.created_at,1)||row.created_at>now||typeof row.request_json!=='string'||Buffer.byteLength(row.request_json,'utf8')>16384||typeof row.result_json!=='string'||Buffer.byteLength(row.result_json,'utf8')>1024
  ||canonical(ownerId,input)!==row.request_json||sha(row.request_json)!==row.request_hash||JSON.stringify(result(input))!==row.result_json||eventHash(row)!==row.event_hash
  ||input.policy.expiresAt<=row.created_at||input.policy.expiresAt-row.created_at>30*DAY)fail();
 const saved=JSON.parse(row.request_json);if(!plain(saved,['ownerId',...inputKeys])||saved.ownerId!==ownerId)fail();
 const {ownerId:_,...request}=saved;if(canonical(ownerId,normalize(request))!==row.request_json)fail();
}
function persistedAccount(db:Database.Database,ownerId:string,input:PaperAccountSetupInput){
 const view=readPaperAccount(db,ownerId,input.accountId);
 if(!view.ok||view.currency!==input.currency||view.appRevision<1||!view.policies.some(p=>p.id===input.policyId))fail();
 const profile=db.prepare('SELECT account_id,owner_id,revision,fee_bps,slippage_bps,unit_scale,currency FROM main.paper_execution_profiles WHERE account_id=?').get(input.accountId) as Record<string,unknown>|undefined;
 if(!profile||profile.owner_id!==ownerId||profile.account_id!==input.accountId||profile.currency!==input.currency||profile.unit_scale!==1||!uint(profile.revision,1)||!uint(profile.fee_bps,0,10000)||!uint(profile.slippage_bps,0,10000))fail();
 // Full immutable reservation/fill validation, including historical quote/fee snapshots; no quote refresh.
 const projection=readPaperExecutionV2(db,ownerId,input.accountId,input.currency,view.exposure);if(!projection||projection.execution.untrackedExposure!==0)fail();
 const e=projection.execution,cash=BigInt(input.initialCashMinor)-BigInt(e.buyGrossTotal)-BigInt(e.buyFeeTotal)+BigInt(e.sellGrossTotal)-BigInt(e.sellFeeTotal);
 if(cash<0n||cash>MAX||cash!==BigInt(view.cash))fail();
}
/** Explicit journal-only initializer. Never prepares trading tables, grants, accounts or cash. */
export function initializePaperAccountSetup(db:Database.Database){
 identity(db);if(db.inTransaction)fail();db.transaction(()=>{schema(db,false);db.exec(setupSQL);schema(db);}).immediate();
}
/** Owns IMMEDIATE. Caller-supplied owner/configuration are trusted, NOT evidence of human consent. */
export function provisionTrustedPaperAccount(db:Database.Database,ownerId:string,input:unknown,clock:()=>number=Date.now){
 try{identity(db);if(db.inTransaction)fail();const captured=normalize(input);return db.transaction(()=>apply(db,ownerId,captured,clock())).immediate();}catch{return deny();}
}
/** Future reviewed composition: caller MUST own IMMEDIATE and roll back on throws. inTransaction
 * proves only an open transaction, not lock mode or owner approval. No untrusted callbacks accepted. */
export function provisionTrustedPaperAccountInTransaction(db:Database.Database,ownerId:string,input:unknown,now:number){
 identity(db);if(!db.inTransaction)fail();return apply(db,ownerId,normalize(input),now);
}
function apply(db:Database.Database,ownerId:string,input:PaperAccountSetupInput,now:number){
 if(!uint(now,1))fail();owner(db,ownerId);schema(db);if(!inspectPaperBundleSchema(db).ok)fail();
 const installation=readPaperInstallation(db,ownerId,()=>now),access=readReviewedPaperInstallationAccess(db,ownerId,()=>now);
 if(!installation.ok||!('installationId' in installation)||installation.installationId!==input.installationId||installation.revision<input.expectedInstallationRevision||access.state==='incompatible')fail();
 const old=db.prepare('SELECT * FROM main.paper_account_setups WHERE owner_id=? AND idempotency_key=?').get(ownerId,input.idempotencyKey) as Event|undefined;
 if(old){validateEvent(old,ownerId,input,now);persistedAccount(db,ownerId,input);return {ok:true as const,replayed:true,setupId:old.id,result:result(input)};}
 reviewNewAccount(db,ownerId,input,now);
 // Separate initial account lifecycle; do not substitute the installation revision.
 const p:PaperPolicy={id:input.policyId,revision:1,appRevision:1,currency:input.currency,ownerId,accountId:input.accountId,enabled:true,mode:'paper',...input.policy};
 const requestJson=canonical(ownerId,input);if(Buffer.byteLength(requestJson,'utf8')>16384)fail();
 db.prepare('INSERT INTO main.paper_accounts VALUES(?,?,?,?,?,?,?,?,?)').run(input.accountId,ownerId,'paper',input.currency,input.initialCashMinor,0,1,1,0);
 db.prepare('INSERT INTO main.paper_policies VALUES(?,?,?,?)').run(input.policyId,input.accountId,1,JSON.stringify(p));
 db.prepare('INSERT INTO main.paper_execution_profiles VALUES(?,?,?,?,?,?,?)').run(input.accountId,ownerId,1,input.execution.feeBps,input.execution.slippageBps,1,input.currency);
 const row:Omit<Event,'event_hash'>={id:randomUUID(),owner_id:ownerId,idempotency_key:input.idempotencyKey,account_id:input.accountId,policy_id:input.policyId,installation_id:input.installationId,installation_revision:input.expectedInstallationRevision,request_json:requestJson,request_hash:sha(requestJson),result_json:JSON.stringify(result(input)),created_at:now};
 db.prepare('INSERT INTO main.paper_account_setups VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.owner_id,row.idempotency_key,row.account_id,row.policy_id,row.installation_id,row.installation_revision,row.request_json,row.request_hash,row.result_json,eventHash(row),now);
 owner(db,ownerId);schema(db);if(!inspectPaperBundleSchema(db).ok||readReviewedPaperInstallationAccess(db,ownerId,()=>now).state!=='ready')fail();
 const account=db.prepare('SELECT account_id,owner_id,mode,currency,cash,exposure,app_enabled,app_revision,stopped FROM main.paper_accounts WHERE account_id=?').get(input.accountId);
 const policy=db.prepare('SELECT policy_id,account_id,revision,policy_json FROM main.paper_policies WHERE policy_id=?').get(input.policyId);
 const profile=db.prepare('SELECT account_id,owner_id,revision,fee_bps,slippage_bps,unit_scale,currency FROM main.paper_execution_profiles WHERE account_id=?').get(input.accountId);
 if(JSON.stringify(account)!==JSON.stringify({account_id:input.accountId,owner_id:ownerId,mode:'paper',currency:input.currency,cash:input.initialCashMinor,exposure:0,app_enabled:1,app_revision:1,stopped:0})
  ||JSON.stringify(policy)!==JSON.stringify({policy_id:input.policyId,account_id:input.accountId,revision:1,policy_json:JSON.stringify(p)})
  ||JSON.stringify(profile)!==JSON.stringify({account_id:input.accountId,owner_id:ownerId,revision:1,fee_bps:input.execution.feeBps,slippage_bps:input.execution.slippageBps,unit_scale:1,currency:input.currency}))fail();
 const saved=db.prepare('SELECT * FROM main.paper_account_setups WHERE owner_id=? AND idempotency_key=?').get(ownerId,input.idempotencyKey) as Event|undefined;
 if(!saved||saved.id!==row.id)fail();validateEvent(saved,ownerId,input,now);persistedAccount(db,ownerId,input);
 return {ok:true as const,replayed:false,setupId:row.id,result:result(input)};
}

/** Read-only preflight for a future reviewed creation. Requires caller-owned transaction;
 * does not initialize storage, consume a proof, reserve IDs or authorize a person. */
export function reviewTrustedPaperAccountInTransaction(db:Database.Database,ownerId:string,input:unknown,now:number){
 identity(db);if(!db.inTransaction)fail();const captured=normalize(input);reviewNewAccount(db,ownerId,captured,now);
 if(Buffer.byteLength(canonical(ownerId,captured),'utf8')>16384)fail();
 return Object.freeze({...captured,policy:Object.freeze({...captured.policy,symbols:Object.freeze([...captured.policy.symbols])}),execution:Object.freeze({...captured.execution})});
}
function reviewNewAccount(db:Database.Database,ownerId:string,input:PaperAccountSetupInput,now:number){
 if(!uint(now,1))fail();owner(db,ownerId);schema(db);if(!inspectPaperBundleSchema(db).ok)fail();
 const installation=readPaperInstallation(db,ownerId,()=>now),access=readReviewedPaperInstallationAccess(db,ownerId,()=>now);
 if(!installation.ok||!('installationId' in installation)||installation.installationId!==input.installationId||installation.revision!==input.expectedInstallationRevision)fail();
 if(db.prepare('SELECT 1 FROM main.paper_account_setups WHERE owner_id=? AND idempotency_key=?').get(ownerId,input.idempotencyKey))fail();
 if(access.state!=='ready'||!access.readAccounts||installation.state!=='provisioned'||installation.revision!==input.expectedInstallationRevision||input.policy.expiresAt<=now||input.policy.expiresAt-now>30*DAY)fail();
 const policyTables=new Set(['paper_reservations','paper_sell_reservations','paper_bots','paper_bot_ticks']);
 for(const table of ['paper_accounts','paper_quotes','paper_reservations','paper_execution_profiles','paper_execution_quotes','paper_fills','paper_positions','paper_sell_reservations','paper_sell_fills','paper_bots','paper_bot_ticks']){
  const query=policyTables.has(table)?`SELECT 1 FROM main.${table} WHERE account_id=? OR policy_id=? LIMIT 1`:`SELECT 1 FROM main.${table} WHERE account_id=? LIMIT 1`;
  if(db.prepare(query).get(...(policyTables.has(table)?[input.accountId,input.policyId]:[input.accountId])))fail();
 }
 if(db.prepare('SELECT 1 FROM main.paper_policies WHERE policy_id=? OR account_id=?').get(input.policyId,input.accountId)||db.prepare('SELECT 1 FROM main.paper_account_setups WHERE account_id=? OR policy_id=?').get(input.accountId,input.policyId))fail();
 // Detached canonical intent/review rows carry their account bindings only in JSON. Refuse
 // malformed persisted JSON rather than overlook a hidden collision; fixed JSON paths only.
 for(const [table,column] of [['paper_reservation_intents','canonical_json'],['paper_bot_activation_reviews','definition_json']] as const){
  if(db.prepare(`SELECT 1 FROM main.${table} WHERE NOT json_valid(${column}) OR json_extract(${column},'$.accountId')=? OR json_extract(${column},'$.policyId')=? LIMIT 1`).get(input.accountId,input.policyId))fail();
 }
}
