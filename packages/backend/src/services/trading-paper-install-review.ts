/** Reviewed owner paper provisioning. No HTTP, ready projection, account seed or runtime dispatch. */
import {lookupSupportedPaperHistoryManifest} from './trading-paper-manifest-catalog.js';
import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import type {Actor} from '../repositories/actor.js';
import {sql} from '../repositories/sql-steps.js';
import {issueOperationChallenge,completeOperationChallenge,consumeOperationReceiptStep,paperAppInstallOperationHash,type PaperAppInstallOperation,type OperationContext} from '../auth/verification/operation-proof.js';
import {PAPER_BUNDLE_SCHEMA} from './trading-paper-bundle-schema.js';
import {BUNDLED_PAPER_INSTALLATION,readPaperInstallation,reviewPaperInstallationInTransaction,provisionTrustedPaperInstallationInTransaction} from './trading-paper-installation.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function fail():never{throw Error('paper installation review unavailable');}
const deny=()=>({ok:false as const,reason:'unavailable' as const});
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const uint=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
function plain(v:unknown,keys:string[]):v is Record<string,unknown>{return !!v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===keys.length&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&keys.includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value'));}
const reviewSQL=`CREATE TABLE IF NOT EXISTS paper_install_reviews(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_hash TEXT NOT NULL,token_version INTEGER NOT NULL,factor_version INTEGER NOT NULL,policy_version INTEGER NOT NULL,definition_json TEXT NOT NULL,definition_hash TEXT NOT NULL,review_hash TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS paper_install_review_events(id TEXT PRIMARY KEY,review_id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,session_hash TEXT NOT NULL,token_version INTEGER NOT NULL,factor_version INTEGER NOT NULL,policy_version INTEGER NOT NULL,definition_hash TEXT NOT NULL,review_hash TEXT NOT NULL,receipt_hash TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,result_json TEXT NOT NULL,created_at INTEGER NOT NULL,event_hash TEXT NOT NULL);`;
type ObjectRow={type:string;name:string;tbl_name:string;sql:string|null};
const objects=(db:Database.Database,temp=false)=>db.prepare(`SELECT type,name,tbl_name,sql FROM ${temp?'sqlite_temp_master':'sqlite_master'} WHERE type IN ('table','index','view','trigger') ORDER BY type,name`).all() as ObjectRow[];
const reference=new Database(':memory:');let expected:readonly ObjectRow[];try{reference.exec(reviewSQL);expected=Object.freeze(objects(reference).map(o=>Object.freeze({...o})));}finally{reference.close();}
const names=new Set(expected.map(o=>o.name)),authNames=new Set(['users','verification_factors','verification_challenges','verification_receipts','approval_proof_policy']);
function identity(db:Database.Database,allowTransaction=false){if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!allowTransaction&&db.inTransaction)fail();}
function schema(db:Database.Database,complete=true){const related=(o:ObjectRow)=>names.has(o.name.toLowerCase())||names.has(o.tbl_name.toLowerCase());if(objects(db,true).some(o=>related(o)||authNames.has(o.name.toLowerCase())||authNames.has(o.tbl_name.toLowerCase())))fail();const found=objects(db).filter(related);for(const row of found){const wanted=expected.find(o=>o.name===row.name);if(!wanted||JSON.stringify(row)!==JSON.stringify(wanted))fail();}if(complete&&found.length!==expected.length)fail();}
function capture(c:OperationContext,a:Actor,now:number):OperationContext{
 if(!c||!a||a.kind!=='user'||a.role!=='owner'||a.agentId!==undefined||a.channel!==undefined||a.userId!==c.userId||typeof c.userId!=='string'||!c.userId||c.userId.length>128||/[\x00-\x20\x7f]/.test(c.userId)||isSystemAccount(c.userId)||typeof c.sessionHash!=='string'||c.sessionHash.length!==64||!/^[a-f0-9]{64}$/.test(c.sessionHash)||!uint(c.tokenVersion,1)||!uint(c.factorVersion,1)||!uint(now,1)||now>Number.MAX_SAFE_INTEGER-300000)fail();return Object.freeze({userId:c.userId,sessionHash:c.sessionHash,tokenVersion:c.tokenVersion,factorVersion:c.factorVersion});
}
function active(db:Database.Database,c:OperationContext){schema(db);const u=db.prepare('SELECT role,status,email_verified,token_version FROM main.users WHERE id=?').get(c.userId) as Record<string,unknown>|undefined,f=db.prepare('SELECT enabled,version FROM main.verification_factors WHERE user_id=?').get(c.userId) as Record<string,unknown>|undefined,p=db.prepare('SELECT version FROM main.approval_proof_policy WHERE id=1').get() as {version:number}|undefined;if(u?.role!=='owner'||u.status!=='active'||u.email_verified!==1||u.token_version!==c.tokenVersion||f?.enabled!==1||f.version!==c.factorVersion||!p||!uint(p.version,1))fail();return p.version;}
function request(input:unknown,id:string){
 if(!plain(input,['action','expectedRevision','manifestDigest','capabilities']))fail();const raw=input.capabilities;
 if(!Array.isArray(raw)||Object.getPrototypeOf(raw)!==Array.prototype||raw.length>2||Reflect.ownKeys(raw).length!==raw.length+1)fail();const caps:unknown[]=[];
 for(let i=0;i<raw.length;i++){const descriptor=Object.getOwnPropertyDescriptor(raw,i);if(!descriptor||!Object.hasOwn(descriptor,'value'))fail();caps.push(descriptor.value);}
 return {...input,capabilities:Object.freeze(caps),idempotencyKey:'app-install:'+id};
}
function target(db:Database.Database,c:OperationContext,input:unknown,id:string,now:number){
 const reviewed=reviewPaperInstallationInTransaction(db,c.userId,request(input,id),now);
 return {version:1,ownerId:c.userId,request:reviewed.request,current:reviewed.current,manifest:BUNDLED_PAPER_INSTALLATION,retainsData:true,createsAccounts:false,runtimeConnected:false};
}
type Review={id:string;owner_id:string;session_hash:string;token_version:number;factor_version:number;policy_version:number;definition_json:string;definition_hash:string;review_hash:string;created_at:number;expires_at:number;status:string};
const fields=['action','expectedRevision','manifestDigest','capabilities'];
const reviewHash=(r:Review)=>sha(JSON.stringify(['paper-app-install-review-v1',r.id,r.owner_id,r.session_hash,r.token_version,r.factor_version,r.definition_hash,r.policy_version,r.created_at,r.expires_at]));
function row(db:Database.Database,c:OperationContext,id:string,version:number,now:number,historical=false){
 if(!uuid(id))fail();const r=db.prepare('SELECT * FROM main.paper_install_reviews WHERE id=? AND owner_id=?').get(id,c.userId) as Review|undefined;
 if(!r||r.session_hash!==c.sessionHash||r.token_version!==c.tokenVersion||r.factor_version!==c.factorVersion||r.policy_version!==version||!uint(r.created_at,1)||r.created_at>now||r.expires_at-r.created_at!==300000||!uint(r.expires_at,1)||!['staged','applied'].includes(r.status)||typeof r.definition_json!=='string'||Buffer.byteLength(r.definition_json,'utf8')>8192||sha(r.definition_json)!==r.definition_hash||reviewHash(r)!==r.review_hash||(!historical&&(r.status!=='staged'||r.expires_at<=now)))fail();
 const d=JSON.parse(r.definition_json);if(!plain(d,['version','ownerId','request','current','manifest','retainsData','createsAccounts','runtimeConnected'])||!plain(d.current,['state','revision','installationId'])||!plain(d.request,['action','expectedRevision','manifestDigest','capabilities','idempotencyKey'])||d.version!==1||d.ownerId!==c.userId||d.request?.idempotencyKey!=='app-install:'+r.id||JSON.stringify(d)!==r.definition_json||!plain(d.manifest,['appId','implementationId','version','kind','mode','schemaVersion','schemaDigest','capabilities','manifestDigest'])||JSON.stringify(d.manifest)!==JSON.stringify(lookupSupportedPaperHistoryManifest(d.manifest.version,d.manifest.manifestDigest))||d.request.manifestDigest!==d.manifest.manifestDigest||d.retainsData!==true||d.createsAccounts!==false||d.runtimeConnected!==false)fail();
 const storedRequest=d.request as Record<string,unknown>,storedCurrent=d.current as Record<string,unknown>;if(!uint(storedCurrent.revision)||storedCurrent.revision!==storedRequest.expectedRevision||(storedCurrent.revision===0?storedCurrent.state!=='not_provisioned'||storedCurrent.installationId!==null:!uuid(storedCurrent.installationId)||!(storedCurrent.revision===1&&storedCurrent.state==='provisioned'||storedCurrent.revision===2&&storedCurrent.state==='disabled')))fail();
 const input=Object.fromEntries(fields.map(k=>[k,storedRequest[k]]));if(!historical&&JSON.stringify(target(db,c,input,id,now))!==r.definition_json)fail();return {row:r,definition:d as unknown as ReturnType<typeof target>,input};
}
function publicReview(current:ReturnType<typeof row>){const {row:r,definition:d}=current;return Object.freeze({ok:true as const,id:r.id,expiresAt:r.expires_at,appId:'trading',version:BUNDLED_PAPER_INSTALLATION.version,mode:'paper',action:d.request.action,expectedRevision:d.request.expectedRevision,capabilities:Object.freeze([...d.request.capabilities]),currentState:d.current.state,manifestDigest:BUNDLED_PAPER_INSTALLATION.manifestDigest,schemaDigest:BUNDLED_PAPER_INSTALLATION.schemaDigest,schemaVersion:BUNDLED_PAPER_INSTALLATION.schemaVersion,implementationId:BUNDLED_PAPER_INSTALLATION.implementationId,dataEffects:Object.freeze({verifiesSchemaTables:PAPER_BUNDLE_SCHEMA.tableCount,createsAccounts:false,seedsCash:false,retainsData:true}),runtimeConnected:false,createsAccounts:false,retainsData:true});}
const operation=(r:Review):PaperAppInstallOperation=>({kind:'paper_app_install',reviewId:r.id,reviewHash:r.review_hash,reviewExpiresAt:r.expires_at,policyVersion:r.policy_version});
const eventFields=['id','review_id','owner_id','session_hash','token_version','factor_version','policy_version','definition_hash','review_hash','receipt_hash','operation_id','result_json','created_at'];
const eventHash=(e:Record<string,unknown>)=>sha(JSON.stringify(['paper-app-install-review-event-v1',...eventFields.map(k=>e[k])]));
function receiptAt(db:Database.Database,c:OperationContext,r:Review,receiptHash:string,at:number){const p=db.prepare('SELECT * FROM main.verification_receipts WHERE token_hash=?').get(receiptHash) as Record<string,unknown>|undefined;if(!p||p.user_id!==c.userId||p.session_hash!==c.sessionHash||p.token_version!==c.tokenVersion||p.factor_version!==c.factorVersion||p.operation_hash!==paperAppInstallOperationHash(operation(r))||p.consumed_at!==at||!uint(p.expires_at,1)||p.expires_at<=at)fail();}
/** Explicit review storage only; never initializes the app registry or trading data. */
export function initializePaperInstallReviews(db:Database.Database){identity(db);db.transaction(()=>{schema(db,false);db.exec(reviewSQL);schema(db);}).immediate();}
export async function stagePaperInstallReview(db:Database.Database,context:OperationContext,actor:Actor,input:unknown,now=Date.now()){
 try{identity(db);const c=capture(context,actor,now),id=randomUUID();if(!plain(input,fields))fail();const prepared=request(input,id),captured=Object.fromEntries(fields.map(k=>[k,prepared[k as keyof typeof prepared]]));return await sql().tx(function*(){const version=active(db,c),definition=JSON.stringify(target(db,c,captured,id,now));if(Buffer.byteLength(definition,'utf8')>8192)fail();const count=db.prepare("SELECT count(*) n FROM main.paper_install_reviews WHERE owner_id=? AND status='staged' AND expires_at>?").get(c.userId,now) as {n:number};if(count.n>=8)fail();const r:Review={id,owner_id:c.userId,session_hash:c.sessionHash,token_version:c.tokenVersion,factor_version:c.factorVersion,policy_version:version,definition_json:definition,definition_hash:sha(definition),review_hash:'',created_at:now,expires_at:now+300000,status:'staged'};r.review_hash=reviewHash(r);db.prepare('INSERT INTO main.paper_install_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(r.id,r.owner_id,r.session_hash,r.token_version,r.factor_version,r.policy_version,r.definition_json,r.definition_hash,r.review_hash,r.created_at,r.expires_at,r.status);return publicReview(row(db,c,id,version,now));},{immediate:true});}catch{return deny();}
}
export async function readPaperInstallReview(db:Database.Database,context:OperationContext,actor:Actor,id:string,now=Date.now()){
 try{identity(db);const c=capture(context,actor,now);return await sql().tx(function*(){return publicReview(row(db,c,id,active(db,c),now));},{immediate:true});}catch{return deny();}
}
async function proof(db:Database.Database,context:OperationContext,actor:Actor,id:string,now:number){identity(db);const c=capture(context,actor,now);return sql().tx(function*(){return {context:c,operation:operation(row(db,c,id,active(db,c),now).row)};},{immediate:true});}
export async function issuePaperInstallProof(db:Database.Database,context:OperationContext,actor:Actor,id:string,now=Date.now()){
 try{const current=await proof(db,context,actor,id,now),result=await issueOperationChallenge(current.context,current.operation,now);await proof(db,current.context,actor,id,now);return result;}catch{return null;}
}
export async function completePaperInstallProof(db:Database.Database,context:OperationContext,actor:Actor,id:string,token:unknown,code:unknown,now=Date.now()){
 try{const current=await proof(db,context,actor,id,now),result=await completeOperationChallenge(token,current.context,current.operation,code,now);await proof(db,current.context,actor,id,now);return result;}catch{return null;}
}
export async function applyPaperInstallReview(db:Database.Database,context:OperationContext,actor:Actor,id:string,receipt:unknown,now=Date.now()){
 try{identity(db);const c=capture(context,actor,now);if(typeof receipt!=='string'||receipt.length!==43||!/^[A-Za-z0-9_-]{43}$/.test(receipt))fail();const hash=sha(receipt);
 return await sql().tx(function*(){const version=active(db,c),current=row(db,c,id,version,now,true),r=current.row;
  const event=db.prepare('SELECT * FROM main.paper_install_review_events WHERE review_id=?').get(id) as Record<string,unknown>|undefined;
  if(event){if(r.status!=='applied'||!uuid(event.id)||event.review_id!==r.id||event.owner_id!==c.userId||event.session_hash!==c.sessionHash||event.token_version!==c.tokenVersion||event.factor_version!==c.factorVersion||event.policy_version!==version||event.definition_hash!==r.definition_hash||event.review_hash!==r.review_hash||event.receipt_hash!==hash||!uuid(event.operation_id)||typeof event.result_json!=='string'||Buffer.byteLength(event.result_json,'utf8')>1024||event.event_hash!==eventHash(event)||!uint(event.created_at,1)||event.created_at<r.created_at||event.created_at>=r.expires_at||event.created_at>now)fail();receiptAt(db,c,r,hash,event.created_at);const acknowledged=provisionTrustedPaperInstallationInTransaction(db,c.userId,current.definition.request,now);if(!acknowledged.replayed||acknowledged.operationId!==event.operation_id||JSON.stringify(acknowledged.result)!==event.result_json)fail();return {ok:true as const,reviewId:id,operationId:acknowledged.operationId,result:acknowledged.result,replayed:true};}
  row(db,c,id,version,now);if(!(yield* consumeOperationReceiptStep(receipt,c,operation(r),now)))fail();const applied=provisionTrustedPaperInstallationInTransaction(db,c.userId,current.definition.request,now);if(applied.replayed)fail();
  const e={id:randomUUID(),review_id:r.id,owner_id:c.userId,session_hash:c.sessionHash,token_version:c.tokenVersion,factor_version:c.factorVersion,policy_version:version,definition_hash:r.definition_hash,review_hash:r.review_hash,receipt_hash:hash,operation_id:applied.operationId,result_json:JSON.stringify(applied.result),created_at:now};db.prepare('INSERT INTO main.paper_install_review_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...eventFields.map(k=>e[k as keyof typeof e]),eventHash(e));
  if(db.prepare("UPDATE main.paper_install_reviews SET status='applied' WHERE id=? AND status='staged'").run(id).changes!==1)fail();if(active(db,c)!==version)fail();receiptAt(db,c,r,hash,now);const after=row(db,c,id,version,now,true);if(after.row.status!=='applied'||after.row.definition_json!==r.definition_json||after.row.review_hash!==r.review_hash)fail();const confirmed=provisionTrustedPaperInstallationInTransaction(db,c.userId,current.definition.request,now);if(!confirmed.replayed||confirmed.operationId!==applied.operationId||JSON.stringify(confirmed.result)!==JSON.stringify(applied.result))fail();return {ok:true as const,reviewId:id,operationId:applied.operationId,result:applied.result,replayed:false};
 },{immediate:true});}catch{return deny();}
}

/**
 * Limited adapter access from current grants and historical committed owner consent. Read-only, including under caller lock.
 * Normal login/token/factor rotation does not erase committed installation consent. Current owner and revocations still apply.
 * Disabled archive reads are owner retention access, never an active app execution grant. Removed apps receive no app reads.
 */
export function readReviewedPaperInstallationAccess(db:Database.Database|null,userId:string,clock:()=>number=Date.now){
 const project=(state:'demo_only'|'not_provisioned'|'incompatible'|'disabled'|'ready',readAccounts=false,readBots=false,manageBots=false)=>Object.freeze({state,readAccounts,readBots,manageBots,executeOrders:false as const});
 if(!db)return project('demo_only');
 try{identity(db,true);return db.transaction(()=>{
  const now=clock();if(!uint(now,1)||typeof userId!=='string'||!userId||userId.length>128||/[\x00-\x20\x7f]/.test(userId)||isSystemAccount(userId))fail();
  const live=db.prepare('SELECT role,status,email_verified FROM main.users WHERE id=?').get(userId) as Record<string,unknown>|undefined;if(live?.role!=='owner'||live.status!=='active'||live.email_verified!==1)fail();
  schema(db,false);const present=db.prepare("SELECT 1 FROM main.sqlite_master WHERE name IN ('paper_installations','paper_install_grants','paper_install_operations','paper_schema_journal') COLLATE NOCASE LIMIT 1").get();if(!present)return project('not_provisioned');
  schema(db);const installation=readPaperInstallation(db,userId,()=>now);if(!installation.ok)fail();if(installation.state==='not_provisioned')return project('not_provisioned');
  const operations=db.prepare("SELECT * FROM main.paper_install_operations WHERE owner_id=? AND app_id='trading' LIMIT 4").all(userId) as Record<string,unknown>[];
  const first=operations.find(o=>{if(typeof o.request_json!=='string'||Buffer.byteLength(o.request_json,'utf8')>4096)fail();return JSON.parse(o.request_json).action==='install';});if(!first||!uuid(first.id))fail();
  const e=db.prepare('SELECT * FROM main.paper_install_review_events WHERE operation_id=?').get(first.id) as Record<string,unknown>|undefined;
  if(!e||!uuid(e.id)||!uuid(e.review_id)||e.owner_id!==userId||!uint(e.created_at,1)||e.created_at>now||e.created_at!==first.created_at||e.result_json!==first.result_json||e.event_hash!==eventHash(e)||typeof e.receipt_hash!=='string'||e.receipt_hash.length!==64||!/^[a-f0-9]{64}$/.test(e.receipt_hash))fail();
  const consent=capture({userId,sessionHash:e.session_hash as string,tokenVersion:e.token_version as number,factorVersion:e.factor_version as number},{kind:'user',role:'owner',userId},now);
  if(!uint(e.policy_version,1))fail();const reviewed=row(db,consent,e.review_id,e.policy_version,now,true),r=reviewed.row;
  if(r.status!=='applied'||e.session_hash!==r.session_hash||e.token_version!==r.token_version||e.factor_version!==r.factor_version||e.policy_version!==r.policy_version||e.definition_hash!==r.definition_hash||e.review_hash!==r.review_hash||e.created_at<r.created_at||e.created_at>=r.expires_at||reviewed.definition.request.action!=='install'||reviewed.definition.request.expectedRevision!==0||first.request_json!==JSON.stringify({ownerId:userId,...reviewed.definition.request}))fail();
  receiptAt(db,consent,r,e.receipt_hash,e.created_at);
  if(installation.state==='removed_retained')return project('not_provisioned');
  const original=reviewed.definition.request.capabilities,read=original.includes('paper.account.read'),bots=original.includes('paper.bot.manage');
  if(installation.state==='disabled')return project('disabled',read,bots,false);
  if(installation.state!=='provisioned'||!read||!installation.capabilities?.includes('paper.account.read')||JSON.stringify(installation.capabilities)!==JSON.stringify(original))fail();
  return project('ready',true,bots,bots);
 }).deferred();}catch{return project('incompatible');}
}

/** Internal offline original-install fingerprint; requires same-handle snapshot and fully reviewed ready provenance. */
export function fingerprintReviewedPaperInstallationInTransaction(db:Database.Database,userId:string,now:number){
 identity(db,true);if(!db.inTransaction||!uint(now,1)||readReviewedPaperInstallationAccess(db,userId,()=>now).state!=='ready')fail();
 // These exact rows have already been validated by the registry and reviewed-access validators in this snapshot.
 const installation=db.prepare("SELECT * FROM main.paper_installations WHERE owner_id=? AND app_id='trading'").get(userId);
 const operations=db.prepare("SELECT * FROM main.paper_install_operations WHERE owner_id=? AND app_id='trading' ORDER BY created_at,id LIMIT 4").all(userId) as Record<string,unknown>[];
 const grants=db.prepare("SELECT * FROM main.paper_install_grants WHERE owner_id=? AND app_id='trading' ORDER BY capability").all(userId);
 const first=operations.find(o=>JSON.parse(o.request_json as string).action==='install');if(!first)fail();
 const event=db.prepare('SELECT * FROM main.paper_install_review_events WHERE operation_id=?').get(first.id) as Record<string,unknown>;
 const review=db.prepare('SELECT * FROM main.paper_install_reviews WHERE id=?').get(event.review_id);
 const proof=db.prepare('SELECT * FROM main.verification_receipts WHERE token_hash=?').get(event.receipt_hash);
 return sha(JSON.stringify(['paper-reviewed-install-preservation-v1',installation,operations,grants,review,event,proof]));
}
