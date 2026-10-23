/** Trusted internal bundled provisioning only. No human proof, public installer, ready projection or runtime activation. */
import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import {PAPER_BUNDLE_SCHEMA,preparePaperBundleSchemaInTransaction,inspectPaperBundleSchema,inspectPaperBundlePreparation} from './trading-paper-bundle-schema.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const id=(v:unknown):v is string=>typeof v==='string'&&!/[\x00-\x20\x7f]/.test(v)&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const uint=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
function fail():never{throw Error('paper installation unavailable');}
const deny=()=>({ok:false as const,reason:'unavailable' as const});
function plain(v:unknown,keys:string[]):v is Record<string,unknown>{if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return false;const own=Reflect.ownKeys(v);return own.length===keys.length&&own.every(k=>typeof k==='string'&&keys.includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value'));}
const capabilities=Object.freeze(['paper.account.read','paper.bot.manage'] as const);
const declaration=Object.freeze({appId:'trading',implementationId:PAPER_BUNDLE_SCHEMA.implementationId,version:'1.0.0',kind:'builtin',mode:'paper',schemaVersion:1,schemaDigest:PAPER_BUNDLE_SCHEMA.digest,capabilities});
/** Declaration integrity only: this is not a signature or hash of executable artifact bytes. */
export const BUNDLED_PAPER_INSTALLATION=Object.freeze({...declaration,manifestDigest:sha(JSON.stringify(declaration))});
type Action='install'|'disable'|'remove_retained';
type Request={action:Action;idempotencyKey:string;expectedRevision:number;manifestDigest:string;capabilities:string[]};
type Result={installationId:string;revision:number;status:'provisioned'|'disabled'|'removed_retained'};
type Installation={owner_id:string;app_id:string;installation_id:string;implementation_id:string;version:string;schema_digest:string;manifest_digest:string;revision:number;status:Result['status'];created_at:number;updated_at:number;last_operation_id:string};
type Operation={id:string;owner_id:string;app_id:string;idempotency_key:string;request_json:string;request_hash:string;result_json:string;event_hash:string;created_at:number};
const registrySQL=`
CREATE TABLE IF NOT EXISTS paper_installations(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,installation_id TEXT NOT NULL UNIQUE,implementation_id TEXT NOT NULL,version TEXT NOT NULL,schema_digest TEXT NOT NULL,manifest_digest TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('provisioned','disabled','removed_retained')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_operation_id TEXT NOT NULL,PRIMARY KEY(owner_id,app_id));
CREATE TABLE IF NOT EXISTS paper_install_grants(owner_id TEXT NOT NULL,app_id TEXT NOT NULL,capability TEXT NOT NULL,grant_operation_id TEXT NOT NULL,granted_at INTEGER NOT NULL,revoked_at INTEGER,revocation_operation_id TEXT,PRIMARY KEY(owner_id,app_id,capability));
CREATE TABLE IF NOT EXISTS paper_install_operations(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,app_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_json TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,event_hash TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(owner_id,idempotency_key));
CREATE TABLE IF NOT EXISTS paper_schema_journal(app_id TEXT NOT NULL,migration_id TEXT NOT NULL,schema_digest TEXT NOT NULL,operation_id TEXT NOT NULL,applied_at INTEGER NOT NULL,PRIMARY KEY(app_id,migration_id));`;
type ObjectRow={type:string;name:string;tbl_name:string;sql:string|null};
function objects(db:Database.Database,temporary=false){return db.prepare(`SELECT type,name,tbl_name,sql FROM ${temporary?'sqlite_temp_master':'sqlite_master'} WHERE type IN ('table','index','view','trigger') ORDER BY type,name`).all() as ObjectRow[];}
const reference=new Database(':memory:');let expected:readonly ObjectRow[];
try{reference.exec(registrySQL);expected=Object.freeze(objects(reference).map(o=>Object.freeze({...o})));}finally{reference.close();}
const owned=new Set(expected.map(o=>o.name.toLowerCase())),tables=new Set(expected.filter(o=>o.type==='table').map(o=>o.name));
function identity(db:Database.Database){if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db)fail();}
function schema(db:Database.Database,complete:boolean){
 const relevant=(o:ObjectRow)=>owned.has(o.name.toLowerCase())||tables.has(o.tbl_name.toLowerCase());if(objects(db,true).some(relevant))fail();const found=objects(db).filter(relevant);
 for(const row of found){const wanted=expected.find(o=>o.name===row.name);if(!wanted||JSON.stringify(row)!==JSON.stringify(wanted))fail();}if(complete&&found.length!==expected.length)fail();
}
function owner(db:Database.Database,userId:string){if(!id(userId)||isSystemAccount(userId))fail();const user=db.prepare('SELECT role,status,email_verified FROM main.users WHERE id=?').get(userId) as Record<string,unknown>|undefined;if(user?.role!=='owner'||user.status!=='active'||user.email_verified!==1)fail();}
function normalize(v:unknown):Request{
 if(!plain(v,['action','idempotencyKey','expectedRevision','manifestDigest','capabilities']))fail();
 if(!['install','disable','remove_retained'].includes(v.action as string)||!id(v.idempotencyKey)||!uint(v.expectedRevision)||v.manifestDigest!==BUNDLED_PAPER_INSTALLATION.manifestDigest)fail();
 const raw=v.capabilities;if(!Array.isArray(raw)||Object.getPrototypeOf(raw)!==Array.prototype||raw.length>2||Reflect.ownKeys(raw).length!==raw.length+1)fail();
 const caps:string[]=[];for(let i=0;i<raw.length;i++){const descriptor=Object.getOwnPropertyDescriptor(raw,i);if(!descriptor||!Object.hasOwn(descriptor,'value')||!capabilities.includes(descriptor.value))fail();caps.push(descriptor.value);}
 caps.sort();if(new Set(caps).size!==caps.length)fail();if(v.action==='install'?(v.expectedRevision!==0||!caps.includes('paper.account.read')):(v.expectedRevision<1||caps.length!==0))fail();
 return {action:v.action as Action,idempotencyKey:v.idempotencyKey,expectedRevision:v.expectedRevision,manifestDigest:v.manifestDigest,capabilities:caps};
}
const canonical=(userId:string,r:Request)=>JSON.stringify({ownerId:userId,...r});
const eventHash=(o:Omit<Operation,'event_hash'>)=>sha(JSON.stringify(['trusted-paper-install-v1',o.id,o.owner_id,o.app_id,o.idempotency_key,o.request_json,o.request_hash,o.result_json,o.created_at]));
function operation(o:Operation){
 if(!uuid(o.id)||!id(o.owner_id)||o.app_id!=='trading'||!id(o.idempotency_key)||!uint(o.created_at)||typeof o.request_json!=='string'||typeof o.result_json!=='string'||Buffer.byteLength(o.request_json,'utf8')>4096||Buffer.byteLength(o.result_json,'utf8')>1024)fail();
 const raw=JSON.parse(o.request_json),{ownerId,...input}=raw,r=normalize(input);if(ownerId!==o.owner_id||r.idempotencyKey!==o.idempotency_key||canonical(o.owner_id,r)!==o.request_json||sha(o.request_json)!==o.request_hash||eventHash(o)!==o.event_hash)fail();
 const result=JSON.parse(o.result_json) as Result;if(!plain(result,['installationId','revision','status'])||!uuid(result.installationId)||!uint(result.revision,1)||result.revision!==r.expectedRevision+1||result.status!==({install:'provisioned',disable:'disabled',remove_retained:'removed_retained'})[r.action]||JSON.stringify({installationId:result.installationId,revision:result.revision,status:result.status})!==o.result_json)fail();return {row:o,request:r,result};
}
function journal(db:Database.Database,now:number){
 const rows=db.prepare("SELECT * FROM main.paper_schema_journal WHERE app_id='trading'").all() as Record<string,unknown>[];if(rows.length!==1)fail();const j=rows[0];if(j.migration_id!=='bundle-v1'||j.schema_digest!==PAPER_BUNDLE_SCHEMA.digest||!uuid(j.operation_id)||!uint(j.applied_at)||j.applied_at>now)fail();
 const raw=db.prepare('SELECT * FROM main.paper_install_operations WHERE id=?').get(j.operation_id) as Operation|undefined;if(!raw)fail();const op=operation(raw);if(op.request.action!=='install'||op.row.created_at!==j.applied_at)fail();
}
function read(db:Database.Database,userId:string,now:number){
 schema(db,true);if(!inspectPaperBundleSchema(db).ok)fail();const row=db.prepare("SELECT * FROM main.paper_installations WHERE owner_id=? AND app_id='trading'").get(userId) as Installation|undefined;
 const ops=db.prepare("SELECT * FROM main.paper_install_operations WHERE owner_id=? AND app_id='trading' ORDER BY created_at,id LIMIT 4").all(userId) as Operation[],grants=db.prepare("SELECT * FROM main.paper_install_grants WHERE owner_id=? AND app_id='trading' ORDER BY capability").all(userId) as Record<string,unknown>[];
 if(!row){if(ops.length||grants.length)fail();return null;}if(!uuid(row.installation_id)||row.implementation_id!==declaration.implementationId||row.version!==declaration.version||row.schema_digest!==declaration.schemaDigest||row.manifest_digest!==BUNDLED_PAPER_INSTALLATION.manifestDigest||!uint(row.revision,1)||row.revision>3||!uint(row.created_at)||!uint(row.updated_at)||row.created_at>row.updated_at||row.updated_at>now||ops.length!==row.revision)fail();
 const history=ops.map(operation).sort((a,b)=>a.result.revision-b.result.revision);for(let i=0;i<history.length;i++){const h=history[i];if(h.row.owner_id!==userId||h.result.installationId!==row.installation_id||h.result.revision!==i+1||h.request.expectedRevision!==i||h.row.created_at>now||i===0&&h.request.action!=='install'||i>0&&(h.request.action==='install'||history[i-1].result.status==='removed_retained'||h.result.status===history[i-1].result.status||h.row.created_at<history[i-1].row.created_at))fail();}
 const first=history[0],last=history[history.length-1],revocation=history[1];if(last.row.id!==row.last_operation_id||last.result.status!==row.status||first.row.created_at!==row.created_at||last.row.created_at!==row.updated_at||grants.length!==first.request.capabilities.length)fail();
 grants.forEach((g,i)=>{if(g.capability!==first.request.capabilities[i]||g.grant_operation_id!==first.row.id||g.granted_at!==first.row.created_at||g.revoked_at!==(revocation?.row.created_at??null)||g.revocation_operation_id!==(revocation?.row.id??null))fail();});journal(db,now);return {row,history,grants};
}
function disableCompatibility(db:Database.Database,userId:string){
 const names=['paper_app_installations','paper_bot_installations'];
 const related=(o:ObjectRow)=>names.includes(o.name.toLowerCase())||names.includes(o.tbl_name.toLowerCase());
 if(objects(db,true).some(related)||objects(db).some(o=>related(o)&&o.type==='trigger'))fail();
 for(const name of names){const type=db.prepare('SELECT type FROM main.sqlite_master WHERE name=? COLLATE NOCASE').get(name) as {type:string}|undefined;if(!type)continue;if(type.type!=='table')fail();
  const expected:Record<string,string>={owner_id:'TEXT',app_id:'TEXT',version:'TEXT',schema_version:'INTEGER',manifest_digest:'TEXT',mode:'TEXT',status:'TEXT'};
  const columns=db.prepare(`PRAGMA main.table_info(${name})`).all() as {name:string;type:string}[];if(columns.length!==7||columns.some(c=>expected[c.name]!==c.type.toUpperCase()))fail();
  db.prepare(`UPDATE main.${name} SET status='disabled' WHERE owner_id=? AND app_id='trading'`).run(userId);
  const rows=db.prepare(`SELECT status FROM main.${name} WHERE owner_id=? AND app_id='trading' LIMIT 2`).all(userId) as {status:string}[];if(rows.length>1||rows.some(r=>r.status!=='disabled'))fail();
 }
}
/** Read-only internal projection; provisioned never means installed, connected or running. */
export function readPaperInstallation(db:Database.Database,userId:string,clock:()=>number=Date.now){
 try{identity(db);return db.transaction(()=>{owner(db,userId);const now=clock();if(!uint(now))fail();const current=read(db,userId,now);return current?{ok:true as const,state:current.row.status,revision:current.row.revision,installationId:current.row.installation_id,capabilities:current.row.status==='provisioned'?current.grants.map(g=>String(g.capability)):[],runtimeConnected:false as const}:{ok:true as const,state:'not_provisioned' as const,runtimeConnected:false as const};}).deferred();}catch{return deny();}
}
/**
 * Trusted internal sink, NOT human authorization. Future reviewed install must consume its own proof in this same transaction.
 * No public caller, compatibility ready rows, account seeds, network effects, reenable or reinstall are implemented.
 */
export function provisionTrustedPaperInstallation(db:Database.Database,userId:string,input:unknown,clock:()=>number=Date.now){
 try{identity(db);if(db.inTransaction)fail();const request=normalize(input);return db.transaction(()=>applyTrustedRegistry(db,userId,request,clock())).immediate();}catch{return deny();}
}
/** Trusted same-handle composition; caller must own IMMEDIATE and roll back on every thrown error. */
export function provisionTrustedPaperInstallationInTransaction(db:Database.Database,userId:string,input:unknown,now:number){
 identity(db);if(!db.inTransaction)fail();return applyTrustedRegistry(db,userId,normalize(input),now);
}
function applyTrustedRegistry(db:Database.Database,userId:string,request:Request,now:number){
  owner(db,userId);if(!uint(now))fail();schema(db,false);const registryExists=objects(db).some(o=>tables.has(o.name.toLowerCase()));
  if(registryExists){schema(db,true);}else{if(request.action!=='install')fail();db.exec(registrySQL);schema(db,true);preparePaperBundleSchemaInTransaction(db);}
  const prior=db.prepare('SELECT * FROM main.paper_install_operations WHERE owner_id=? AND idempotency_key=?').get(userId,request.idempotencyKey) as Operation|undefined;
  const current=read(db,userId,now);if(prior){const checked=operation(prior);if(prior.request_json!==canonical(userId,request)||!current||!current.history.some(h=>h.row.id===prior.id))fail();return {ok:true as const,replayed:true,operationId:prior.id,result:checked.result};}
  if(request.action==='install'?!!current:!current||current.row.revision!==request.expectedRevision||current.row.status==='removed_retained'||request.action==='disable'&&current.row.status!=='provisioned')fail();
  const operationId=randomUUID(),installationId=current?.row.installation_id??randomUUID(),result:Result={installationId,revision:request.expectedRevision+1,status:({install:'provisioned',disable:'disabled',remove_retained:'removed_retained'} as const)[request.action]};
  if(current&&now<current.row.updated_at)fail();const requestJson=canonical(userId,request),op={id:operationId,owner_id:userId,app_id:'trading',idempotency_key:request.idempotencyKey,request_json:requestJson,request_hash:sha(requestJson),result_json:JSON.stringify(result),created_at:now};
  db.prepare('INSERT INTO main.paper_install_operations VALUES(?,?,?,?,?,?,?,?,?)').run(op.id,op.owner_id,op.app_id,op.idempotency_key,op.request_json,op.request_hash,op.result_json,eventHash(op),now);
  if(!current){db.prepare('INSERT INTO main.paper_installations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(userId,'trading',installationId,declaration.implementationId,declaration.version,declaration.schemaDigest,BUNDLED_PAPER_INSTALLATION.manifestDigest,1,'provisioned',now,now,operationId);
   for(const capability of request.capabilities)db.prepare('INSERT INTO main.paper_install_grants VALUES(?,?,?,?,?,?,?)').run(userId,'trading',capability,operationId,now,null,null);
   const recorded=db.prepare("SELECT 1 FROM main.paper_schema_journal WHERE app_id='trading'").get();if(!recorded)db.prepare('INSERT INTO main.paper_schema_journal VALUES(?,?,?,?,?)').run('trading','bundle-v1',declaration.schemaDigest,operationId,now);
  }else{
   db.prepare("UPDATE main.paper_installations SET revision=?,status=?,updated_at=?,last_operation_id=? WHERE owner_id=? AND app_id='trading' AND revision=?").run(result.revision,result.status,now,operationId,userId,request.expectedRevision);
   db.prepare("UPDATE main.paper_install_grants SET revoked_at=?,revocation_operation_id=? WHERE owner_id=? AND app_id='trading' AND revoked_at IS NULL").run(now,operationId,userId);
   const invalid=db.prepare('SELECT 1 FROM main.paper_accounts WHERE owner_id=? AND (typeof(app_revision)!=\'integer\' OR app_revision<1 OR app_revision>=9007199254740991) LIMIT 1').get(userId);if(invalid)fail();
   const foreignBot=db.prepare('SELECT 1 FROM main.paper_bots b LEFT JOIN main.paper_accounts a ON a.account_id=b.account_id WHERE b.owner_id=? AND (a.owner_id IS NULL OR a.owner_id!=b.owner_id) LIMIT 1').get(userId);if(foreignBot)fail();
   disableCompatibility(db,userId);
   db.prepare('UPDATE main.paper_accounts SET app_enabled=0,app_revision=app_revision+1 WHERE owner_id=?').run(userId);
   db.prepare("UPDATE main.paper_bots SET status=? WHERE owner_id=? AND (status='active' OR (?='revoked' AND status='stopped'))").run(request.action==='remove_retained'?'revoked':'stopped',userId,request.action==='remove_retained'?'revoked':'stopped');
  }
  owner(db,userId);const verified=read(db,userId,now);if(!verified||verified.row.last_operation_id!==operationId||verified.row.revision!==result.revision||verified.row.status!==result.status)fail();return {ok:true as const,replayed:false,operationId,result};
}

/** Trusted read-only review in caller transaction. No schema initialization or grants. */
export function reviewPaperInstallationInTransaction(db:Database.Database,userId:string,input:unknown,now:number){
 identity(db);if(!db.inTransaction||!uint(now))fail();owner(db,userId);const request=normalize(input);schema(db,false);
 const registryExists=objects(db).some(o=>tables.has(o.name.toLowerCase()));let current:ReturnType<typeof read>=null;
 if(registryExists){schema(db,true);current=read(db,userId,now);if(db.prepare('SELECT 1 FROM main.paper_install_operations WHERE owner_id=? AND idempotency_key=?').get(userId,request.idempotencyKey))fail();}
 else if(!inspectPaperBundlePreparation(db).ok)fail();
 if(request.action==='install'?!!current:!current||current.row.revision!==request.expectedRevision||current.row.status==='removed_retained'||request.action==='disable'&&current.row.status!=='provisioned')fail();
 return Object.freeze({request:Object.freeze({...request,capabilities:Object.freeze([...request.capabilities])}),current:Object.freeze(current?{state:current.row.status,revision:current.row.revision,installationId:current.row.installation_id}:{state:'not_provisioned',revision:0,installationId:null})});
}
