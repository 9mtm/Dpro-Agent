/** Reviewed create-once paper account consent. No HTTP, account updates or runtime dispatch. */
import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import type {Actor} from '../repositories/actor.js';
import {sql} from '../repositories/sql-steps.js';
import {issueOperationChallenge,completeOperationChallenge,consumeOperationReceiptStep,paperAccountSetupOperationHash,type PaperAccountSetupOperation,type OperationContext} from '../auth/verification/operation-proof.js';
import {BUNDLED_PAPER_INSTALLATION,readPaperInstallation} from './trading-paper-installation.js';
import {readReviewedPaperInstallationAccess} from './trading-paper-install-review.js';
import {reviewTrustedPaperAccountInTransaction,provisionTrustedPaperAccountInTransaction,type PaperAccountSetupInput} from './trading-paper-account-setup.js';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function fail():never{throw Error('paper account review unavailable');}
const deny=()=>({ok:false as const,reason:'unavailable' as const});
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const uint=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
function plain(v:unknown,keys:string[]):v is Record<string,unknown>{
 if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return false;
 const own=Reflect.ownKeys(v);return own.length===keys.length&&own.every(k=>typeof k==='string'&&keys.includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value'));
}
const reviewSQL=`CREATE TABLE IF NOT EXISTS paper_account_reviews(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_hash TEXT NOT NULL,token_version INTEGER NOT NULL,factor_version INTEGER NOT NULL,policy_version INTEGER NOT NULL,definition_json TEXT NOT NULL,definition_hash TEXT NOT NULL,review_hash TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS paper_account_review_events(id TEXT PRIMARY KEY,review_id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,session_hash TEXT NOT NULL,token_version INTEGER NOT NULL,factor_version INTEGER NOT NULL,policy_version INTEGER NOT NULL,definition_hash TEXT NOT NULL,review_hash TEXT NOT NULL,receipt_hash TEXT NOT NULL,setup_id TEXT NOT NULL UNIQUE,result_json TEXT NOT NULL,created_at INTEGER NOT NULL,event_hash TEXT NOT NULL);`;
type ObjectRow={type:string;name:string;tbl_name:string;sql:string|null};
const objects=(db:Database.Database,temp=false)=>db.prepare(`SELECT type,name,tbl_name,sql FROM ${temp?'sqlite_temp_master':'sqlite_master'} WHERE type IN ('table','index','view','trigger') ORDER BY type,name`).all() as ObjectRow[];
const reference=new Database(':memory:');let expected:readonly ObjectRow[];
try{reference.exec(reviewSQL);expected=Object.freeze(objects(reference).map(row=>Object.freeze({...row})));}finally{reference.close();}
const names=new Set(expected.map(row=>row.name)),authNames=new Set(['users','verification_factors','verification_challenges','verification_receipts','approval_proof_policy']);
function identity(db:Database.Database){if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||db.inTransaction)fail();}
function schema(db:Database.Database,complete=true){
 const related=(row:ObjectRow)=>names.has(row.name.toLowerCase())||names.has(row.tbl_name.toLowerCase());
 if(objects(db,true).some(row=>related(row)||authNames.has(row.name.toLowerCase())||authNames.has(row.tbl_name.toLowerCase())))fail();
 const found=objects(db).filter(related);
 for(const row of found){const wanted=expected.find(item=>item.name===row.name);if(!wanted||JSON.stringify(row)!==JSON.stringify(wanted))fail();}
 if(complete&&found.length!==expected.length)fail();
}
function capture(context:OperationContext,actor:Actor,now:number):OperationContext{
 if(!context||!actor||actor.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==context.userId||typeof context.userId!=='string'||!context.userId||context.userId.length>128||/[\x00-\x20\x7f]/.test(context.userId)||isSystemAccount(context.userId)
  ||typeof context.sessionHash!=='string'||context.sessionHash.length!==64||!/^[a-f0-9]{64}$/.test(context.sessionHash)||!uint(context.tokenVersion,1)||!uint(context.factorVersion,1)||!uint(now,1)||now>Number.MAX_SAFE_INTEGER-300000)fail();
 return Object.freeze({userId:context.userId,sessionHash:context.sessionHash,tokenVersion:context.tokenVersion,factorVersion:context.factorVersion});
}
function active(db:Database.Database,context:OperationContext){
 schema(db);const user=db.prepare('SELECT role,status,email_verified,token_version FROM main.users WHERE id=?').get(context.userId) as Record<string,unknown>|undefined;
 const factor=db.prepare('SELECT enabled,version FROM main.verification_factors WHERE user_id=?').get(context.userId) as Record<string,unknown>|undefined;
 const policy=db.prepare('SELECT version FROM main.approval_proof_policy WHERE id=1').get() as {version:number}|undefined;
 if(user?.role!=='owner'||user.status!=='active'||user.email_verified!==1||user.token_version!==context.tokenVersion||factor?.enabled!==1||factor.version!==context.factorVersion||!policy||!uint(policy.version,1))fail();return policy.version;
}
const fields=['currency','initialCashMinor','policy','execution'];
function captureInput(input:unknown){
 if(!plain(input,fields)||!plain(input.policy,['expiresAt','symbols','maxOrder','maxExposure','maxDailyLoss','maxOrders','cooldownMs','maxQuoteAgeMs'])||!plain(input.execution,['feeBps','slippageBps']))fail();
 const raw=input.policy.symbols;if(!Array.isArray(raw)||Object.getPrototypeOf(raw)!==Array.prototype||raw.length<1||raw.length>100||Reflect.ownKeys(raw).length!==raw.length+1)fail();
 const symbols:unknown[]=[];
 for(let i=0;i<raw.length;i++){const descriptor=Object.getOwnPropertyDescriptor(raw,i);if(!descriptor||!Object.hasOwn(descriptor,'value'))fail();symbols.push(descriptor.value);}
 return {currency:input.currency,initialCashMinor:input.initialCashMinor,policy:{...input.policy,symbols},execution:{...input.execution}};
}
function request(db:Database.Database,context:OperationContext,input:ReturnType<typeof captureInput>,reviewId:string,accountId:string,policyId:string,now:number){
 const installation=readPaperInstallation(db,context.userId,()=>now),access=readReviewedPaperInstallationAccess(db,context.userId,()=>now);
 if(!installation.ok||installation.state!=='provisioned'||access.state!=='ready'||!access.readAccounts)fail();
 return reviewTrustedPaperAccountInTransaction(db,context.userId,{idempotencyKey:'account-setup:'+reviewId,accountId,policyId,installationId:installation.installationId,expectedInstallationRevision:installation.revision,manifestDigest:BUNDLED_PAPER_INSTALLATION.manifestDigest,...input},now);
}
type Definition={version:1;ownerId:string;request:PaperAccountSetupInput;runtimeConnected:false};
type ReviewRow={id:string;owner_id:string;session_hash:string;token_version:number;factor_version:number;policy_version:number;definition_json:string;definition_hash:string;review_hash:string;created_at:number;expires_at:number;status:string};
const reviewHash=(row:ReviewRow)=>sha(JSON.stringify(['paper-account-setup-review-v1',row.id,row.owner_id,row.session_hash,row.token_version,row.factor_version,row.definition_hash,row.policy_version,row.created_at,row.expires_at]));
function row(db:Database.Database,context:OperationContext,id:string,version:number,now:number,historical=false){
 if(!uuid(id))fail();const saved=db.prepare('SELECT * FROM main.paper_account_reviews WHERE id=? AND owner_id=?').get(id,context.userId) as ReviewRow|undefined;
 if(!saved||saved.session_hash!==context.sessionHash||saved.token_version!==context.tokenVersion||saved.factor_version!==context.factorVersion||saved.policy_version!==version||!uint(saved.created_at,1)||saved.created_at>now||!uint(saved.expires_at,1)||saved.expires_at-saved.created_at!==300000||!['staged','applied'].includes(saved.status)
  ||typeof saved.definition_json!=='string'||Buffer.byteLength(saved.definition_json,'utf8')>16384||sha(saved.definition_json)!==saved.definition_hash||reviewHash(saved)!==saved.review_hash||!historical&&(saved.status!=='staged'||saved.expires_at<=now))fail();
 const d=JSON.parse(saved.definition_json);
 if(!plain(d,['version','ownerId','request','runtimeConnected'])||d.version!==1||d.ownerId!==context.userId||d.runtimeConnected!==false||!plain(d.request,['idempotencyKey','accountId','policyId','installationId','expectedInstallationRevision','manifestDigest','currency','initialCashMinor','policy','execution'])
  ||d.request.idempotencyKey!=='account-setup:'+id||typeof d.request.accountId!=='string'||!d.request.accountId.startsWith('account-')||!uuid(d.request.accountId.slice(8))||typeof d.request.policyId!=='string'||!d.request.policyId.startsWith('policy-')||!uuid(d.request.policyId.slice(7))
  ||!uuid(d.request.installationId)||d.request.expectedInstallationRevision!==1||d.request.manifestDigest!==BUNDLED_PAPER_INSTALLATION.manifestDigest||JSON.stringify(d)!==saved.definition_json)fail();
 const storedRequest=d.request;
 if(!historical){
  const captured=captureInput(Object.fromEntries(fields.map(key=>[key,storedRequest[key]]))),current=request(db,context,captured,id,storedRequest.accountId as string,storedRequest.policyId as string,now);
  if(JSON.stringify(current)!==JSON.stringify(storedRequest))fail();
 }
 return {row:saved,definition:d as unknown as Definition};
}
function publicReview(current:ReturnType<typeof row>){
 const {row:saved,definition:d}=current,r=d.request;
 return Object.freeze({ok:true as const,id:saved.id,expiresAt:saved.expires_at,appId:'trading',version:BUNDLED_PAPER_INSTALLATION.version,mode:'paper',accountId:r.accountId,policyId:r.policyId,installationRevision:r.expectedInstallationRevision,currency:r.currency,initialCashMinor:r.initialCashMinor,
  policy:Object.freeze({...r.policy,symbols:Object.freeze([...r.policy.symbols])}),execution:Object.freeze({...r.execution,unitScale:1}),appRevision:1,policyRevision:1,profileRevision:1,runtimeConnected:false,createsAccount:true,startsBot:false,connectsBroker:false});
}
const operation=(saved:ReviewRow):PaperAccountSetupOperation=>({kind:'paper_account_setup',reviewId:saved.id,reviewHash:saved.review_hash,reviewExpiresAt:saved.expires_at,policyVersion:saved.policy_version});
const eventFields=['id','review_id','owner_id','session_hash','token_version','factor_version','policy_version','definition_hash','review_hash','receipt_hash','setup_id','result_json','created_at'];
const eventHash=(event:Record<string,unknown>)=>sha(JSON.stringify(['paper-account-setup-review-event-v1',...eventFields.map(key=>event[key])]));
function receiptAt(db:Database.Database,context:OperationContext,saved:ReviewRow,hash:string,at:number){
 const receipt=db.prepare('SELECT * FROM main.verification_receipts WHERE token_hash=?').get(hash) as Record<string,unknown>|undefined;
 if(!receipt||receipt.user_id!==context.userId||receipt.session_hash!==context.sessionHash||receipt.token_version!==context.tokenVersion||receipt.factor_version!==context.factorVersion||receipt.operation_hash!==paperAccountSetupOperationHash(operation(saved))||receipt.consumed_at!==at||!uint(receipt.expires_at,1)||receipt.expires_at<=at)fail();
}
/** Explicit review/event tables only; trading schemas and setup journal remain explicit prerequisites. */
export function initializePaperAccountReviews(db:Database.Database){identity(db);db.transaction(()=>{schema(db,false);db.exec(reviewSQL);schema(db);}).immediate();}
export async function stagePaperAccountReview(db:Database.Database,context:OperationContext,actor:Actor,input:unknown,now=Date.now()){
 try{
  identity(db);const c=capture(context,actor,now),captured=captureInput(input),id=randomUUID(),accountId='account-'+randomUUID(),policyId='policy-'+randomUUID();
  return await sql().tx(function*(){
   const version=active(db,c),definition=JSON.stringify({version:1,ownerId:c.userId,request:request(db,c,captured,id,accountId,policyId,now),runtimeConnected:false});if(Buffer.byteLength(definition,'utf8')>16384)fail();
   const count=db.prepare("SELECT count(*) n FROM main.paper_account_reviews WHERE owner_id=? AND status='staged' AND expires_at>?").get(c.userId,now) as {n:number};if(count.n>=8)fail();
   const saved:ReviewRow={id,owner_id:c.userId,session_hash:c.sessionHash,token_version:c.tokenVersion,factor_version:c.factorVersion,policy_version:version,definition_json:definition,definition_hash:sha(definition),review_hash:'',created_at:now,expires_at:now+300000,status:'staged'};saved.review_hash=reviewHash(saved);
   db.prepare('INSERT INTO main.paper_account_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(saved.id,saved.owner_id,saved.session_hash,saved.token_version,saved.factor_version,saved.policy_version,saved.definition_json,saved.definition_hash,saved.review_hash,saved.created_at,saved.expires_at,saved.status);
   return publicReview(row(db,c,id,version,now));
  },{immediate:true});
 }catch{return deny();}
}
export async function readPaperAccountReview(db:Database.Database,context:OperationContext,actor:Actor,id:string,now=Date.now()){
 try{identity(db);const c=capture(context,actor,now);return await sql().tx(function*(){return publicReview(row(db,c,id,active(db,c),now));},{immediate:true});}catch{return deny();}
}
async function proof(db:Database.Database,context:OperationContext,actor:Actor,id:string,now:number){
 identity(db);const c=capture(context,actor,now);return sql().tx(function*(){return {context:c,operation:operation(row(db,c,id,active(db,c),now).row)};},{immediate:true});
}
export async function issuePaperAccountProof(db:Database.Database,context:OperationContext,actor:Actor,id:string,now=Date.now()){
 try{const current=await proof(db,context,actor,id,now),result=await issueOperationChallenge(current.context,current.operation,now);await proof(db,current.context,actor,id,now);return result;}catch{return null;}
}
export async function completePaperAccountProof(db:Database.Database,context:OperationContext,actor:Actor,id:string,token:unknown,code:unknown,now=Date.now()){
 try{const current=await proof(db,context,actor,id,now),result=await completeOperationChallenge(token,current.context,current.operation,code,now);await proof(db,current.context,actor,id,now);return result;}catch{return null;}
}
export async function applyPaperAccountReview(db:Database.Database,context:OperationContext,actor:Actor,id:string,receipt:unknown,now=Date.now()){
 try{
  identity(db);const c=capture(context,actor,now);if(typeof receipt!=='string'||receipt.length!==43||!/^[A-Za-z0-9_-]{43}$/.test(receipt))fail();const hash=sha(receipt);
  return await sql().tx(function*(){
   const version=active(db,c),current=row(db,c,id,version,now,true),saved=current.row;
   const event=db.prepare('SELECT * FROM main.paper_account_review_events WHERE review_id=?').get(id) as Record<string,unknown>|undefined;
   if(event){
    if(saved.status!=='applied'||!uuid(event.id)||event.review_id!==saved.id||event.owner_id!==c.userId||event.session_hash!==c.sessionHash||event.token_version!==c.tokenVersion||event.factor_version!==c.factorVersion||event.policy_version!==version||event.definition_hash!==saved.definition_hash||event.review_hash!==saved.review_hash||event.receipt_hash!==hash
     ||!uuid(event.setup_id)||typeof event.result_json!=='string'||Buffer.byteLength(event.result_json,'utf8')>1024||event.event_hash!==eventHash(event)||!uint(event.created_at,1)||event.created_at<saved.created_at||event.created_at>=saved.expires_at||event.created_at>now)fail();
    receiptAt(db,c,saved,hash,event.created_at);const acknowledged=provisionTrustedPaperAccountInTransaction(db,c.userId,current.definition.request,now);
    const setup=db.prepare('SELECT created_at FROM main.paper_account_setups WHERE id=?').get(event.setup_id) as {created_at:number}|undefined;
    if(!acknowledged.replayed||acknowledged.setupId!==event.setup_id||JSON.stringify(acknowledged.result)!==event.result_json||setup?.created_at!==event.created_at)fail();
    return {ok:true as const,reviewId:id,setupId:acknowledged.setupId,result:acknowledged.result,replayed:true};
   }
   row(db,c,id,version,now);if(!(yield* consumeOperationReceiptStep(receipt,c,operation(saved),now)))fail();
   const applied=provisionTrustedPaperAccountInTransaction(db,c.userId,current.definition.request,now);if(applied.replayed)fail();
   const e={id:randomUUID(),review_id:id,owner_id:c.userId,session_hash:c.sessionHash,token_version:c.tokenVersion,factor_version:c.factorVersion,policy_version:version,definition_hash:saved.definition_hash,review_hash:saved.review_hash,receipt_hash:hash,setup_id:applied.setupId,result_json:JSON.stringify(applied.result),created_at:now};
   db.prepare('INSERT INTO main.paper_account_review_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...eventFields.map(key=>e[key as keyof typeof e]),eventHash(e));
   if(db.prepare("UPDATE main.paper_account_reviews SET status='applied' WHERE id=? AND status='staged'").run(id).changes!==1||active(db,c)!==version)fail();
   receiptAt(db,c,saved,hash,now);const after=row(db,c,id,version,now,true);if(after.row.status!=='applied'||after.row.definition_json!==saved.definition_json||after.row.review_hash!==saved.review_hash||readReviewedPaperInstallationAccess(db,c.userId,()=>now).state!=='ready')fail();
   const confirmed=provisionTrustedPaperAccountInTransaction(db,c.userId,current.definition.request,now);if(!confirmed.replayed||confirmed.setupId!==applied.setupId||JSON.stringify(confirmed.result)!==JSON.stringify(applied.result))fail();
   const setup=db.prepare('SELECT created_at FROM main.paper_account_setups WHERE id=?').get(applied.setupId) as {created_at:number}|undefined;if(setup?.created_at!==now)fail();
   const persisted=db.prepare('SELECT * FROM main.paper_account_review_events WHERE review_id=?').get(id) as Record<string,unknown>|undefined;
   if(!persisted||persisted.event_hash!==eventHash(persisted)||eventFields.some(key=>persisted[key]!==e[key as keyof typeof e]))fail();
   return {ok:true as const,reviewId:id,setupId:applied.setupId,result:applied.result,replayed:false};
  },{immediate:true});
 }catch{return deny();}
}
