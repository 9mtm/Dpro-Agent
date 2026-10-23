/** Internal reviewed execute-capability overlay only. No dispatcher, scheduler, API or original registry wiring. */
import type Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import type {Actor} from '../repositories/actor.js';
import {sql} from '../repositories/sql-steps.js';
import {consumeOperationReceiptStep,paperExecutionUpgradeOperationHash,type OperationContext} from '../auth/verification/operation-proof.js';
import {readPaperExecutionUpgradeReviewInTransaction} from './trading-paper-execution-upgrade-review.js';
import {PAPER_EXECUTION_OVERLAY_SQL,inspectPaperExecutionOverlaySchema,assertNoPaperExecutionOverlay} from './trading-paper-execution-overlay-schema.js';
import {PAPER_EXECUTION_UPGRADE_CANDIDATE,lookupPaperManifest} from './trading-paper-manifest-catalog.js';
import {BUNDLED_PAPER_INSTALLATION,readPaperInstallation} from './trading-paper-installation.js';
import {fingerprintReviewedPaperInstallationInTransaction,readReviewedPaperInstallationAccess} from './trading-paper-install-review.js';
import {readPaperRuntimePreservationInTransaction,inspectPaperRuntimeStorageInTransaction,readTrustedPaperRuntimeConsentInTransaction,assertPaperRuntimeEligibilityInTransaction} from './trading-paper-runtime-consent.js';
import {readPaperDispatchPreservationPrefixInTransaction} from './trading-paper-dispatch-attempts.js';
import {readPaperExecutionUpgradeAffectedSetInTransaction} from './trading-paper-execution-upgrade.js';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
const uint=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
function fail():never{throw Error('paper execution overlay unavailable');}
const deny=()=>Object.freeze({ok:false as const,reason:'unavailable' as const,executionGranted:false as const,runtimeConnected:false as const});
function plain(v:unknown,keys:readonly string[]):v is Record<string,unknown>{if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return false;const own=Reflect.ownKeys(v);return own.length===keys.length&&own.every(k=>typeof k==='string'&&keys.includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value'));}
function identity(db:Database.Database,writable=false){if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||db.inTransaction||writable&&db.pragma('query_only',{simple:true})!==0)fail();}
function human(db:Database.Database,actor:Actor,now:number,context?:OperationContext,policyVersion?:number){
 if(!actor||actor.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||typeof actor.userId!=='string'||!actor.userId||actor.userId.length>128||/[\x00-\x20\x7f]/.test(actor.userId)||isSystemAccount(actor.userId)||!uint(now,1))fail();
 const auth=['users','verification_factors','verification_receipts','approval_proof_policy'];
 const temporary=db.prepare('SELECT name,tbl_name FROM sqlite_temp_master').all() as {name:string;tbl_name:string}[];
 if(temporary.some(r=>auth.includes(r.name.toLowerCase())||auth.includes(r.tbl_name.toLowerCase())))fail();
 for(const name of auth)if(!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(name))fail();
 const user=db.prepare('SELECT role,status,email_verified,token_version FROM main.users WHERE id=?').get(actor.userId) as Record<string,unknown>|undefined;
 const factor=db.prepare('SELECT enabled,version FROM main.verification_factors WHERE user_id=?').get(actor.userId) as Record<string,unknown>|undefined;
 const policy=db.prepare('SELECT version FROM main.approval_proof_policy WHERE id=1').get() as {version:number}|undefined;
 if(user?.role!=='owner'||user.status!=='active'||user.email_verified!==1||!uint(user.token_version,1)||factor?.enabled!==1||!uint(factor.version,1)||!policy||!uint(policy.version,1))fail();
 if(context&&(context.userId!==actor.userId||context.tokenVersion!==user.token_version||context.factorVersion!==factor.version||!hash(context.sessionHash)))fail();
 if(policyVersion!==undefined&&policy.version!==policyVersion)fail();return actor.userId;
}
type Review=ReturnType<typeof readPaperExecutionUpgradeReviewInTransaction>;
type Overlay={id:string;owner_id:string;installation_id:string;baseline_revision:number;baseline_manifest_digest:string;target_version:string;target_manifest_digest:string;effective_revision:number;review_id:string;created_at:number;event_id:string};
type Event={id:string;overlay_id:string;owner_id:string;review_id:string;context_json:string;definition_hash:string;review_hash:string;receipt_hash:string;created_at:number;bindings_hash:string;event_hash:string};
type Binding={consent_id:string;overlay_id:string;owner_id:string;definition_id:string;definition_digest:string;baseline_json:string;baseline_hash:string;created_at:number};
const eventFields=['id','overlay_id','owner_id','review_id','context_json','definition_hash','review_hash','receipt_hash','created_at','bindings_hash'] as const;
const eventHash=(e:Omit<Event,'event_hash'>)=>sha(JSON.stringify(['paper-execution-upgrade-applied-v1',...eventFields.map(k=>e[k])]));
const bindingsHash=(rows:readonly Binding[])=>sha(JSON.stringify(['paper-execution-upgrade-bindings-v1',rows]));
function base(db:Database.Database,ownerId:string,now:number){
 const installation=readPaperInstallation(db,ownerId,()=>now),access=readReviewedPaperInstallationAccess(db,ownerId,()=>now);
 if(!installation.ok||installation.state!=='provisioned'||access.state!=='ready')fail();return installation;
}
function bindingBaseline(db:Database.Database,ownerId:string,saved:Review['definition']['affected']['consents'][number],proved:Review['definition']['retained'][number],now:number){
 const current=readTrustedPaperRuntimeConsentInTransaction(db,saved.consentId,now);
 if(current.definitionId!==saved.definitionId||current.definitionDigest!==saved.definitionDigest||current.createdAt!==saved.createdAt||current.status!==saved.status||current.journal.attemptCount!==saved.attemptCount||current.journal.lastClaimAt!==saved.lastClaimAt)fail();
 const d=current.definition;if(d.installationId!==saved.installationId||d.installationRevision!==saved.installationRevision||d.manifestDigest!==saved.manifestDigest||JSON.stringify(d.limits)!==JSON.stringify(saved.limits))fail();
 if(current.status==='granted'&&now<d.limits.expiresAt)assertPaperRuntimeEligibilityInTransaction(db,saved.consentId,now,true);
 const prefix=readPaperDispatchPreservationPrefixInTransaction(db,ownerId,saved.definitionId,saved.attemptCount,now);
 const runtimePreservation=readPaperRuntimePreservationInTransaction(db,ownerId,saved.consentId,now);
 if(prefix.lastClaimAt!==saved.lastClaimAt||proved.consentId!==saved.consentId||JSON.stringify(prefix)!==JSON.stringify(proved.preservationPrefix)||JSON.stringify(runtimePreservation)!==JSON.stringify(proved.runtimePreservation))fail();
 return {version:1,original:saved,prefix,runtimePreservation};
}
function checkProof(db:Database.Database,e:Event,review:Review){
 const p=db.prepare('SELECT * FROM main.verification_receipts WHERE token_hash=?').get(e.receipt_hash) as Record<string,unknown>|undefined,c=review.context;
 if(!p||p.user_id!==c.userId||p.session_hash!==c.sessionHash||p.token_version!==c.tokenVersion||p.factor_version!==c.factorVersion||p.operation_hash!==paperExecutionUpgradeOperationHash(review.operation)||p.consumed_at!==e.created_at||!uint(p.expires_at,1)||p.expires_at<=e.created_at)fail();
}
function validate(db:Database.Database,ownerId:string,now:number){
 // Base disable/removal refuses execution before consulting any damaged overlay history.
 const installation=base(db,ownerId,now);inspectPaperExecutionOverlaySchema(db);
 const overlays=db.prepare('SELECT * FROM main.paper_execution_overlays WHERE owner_id=? LIMIT 2').all(ownerId) as Overlay[];
 if(overlays.length!==1)fail();const o=overlays[0];
 if(!uuid(o.id)||o.owner_id!==ownerId||o.installation_id!==installation.installationId||o.baseline_revision!==installation.revision||o.baseline_manifest_digest!==BUNDLED_PAPER_INSTALLATION.manifestDigest||!uuid(o.review_id)||!uuid(o.event_id)||!uint(o.created_at,1)||o.created_at>now||o.effective_revision!==o.baseline_revision+1)fail();
 const catalog=lookupPaperManifest(o.target_version,o.target_manifest_digest);if(catalog?.manifest!==PAPER_EXECUTION_UPGRADE_CANDIDATE||!catalog.candidate||catalog.installable||catalog.executable)fail();
 const events=db.prepare('SELECT * FROM main.paper_execution_upgrade_events WHERE owner_id=? LIMIT 2').all(ownerId) as Event[];if(events.length!==1)fail();const e=events[0];
 if(e.id!==o.event_id||e.overlay_id!==o.id||e.owner_id!==ownerId||e.review_id!==o.review_id||e.created_at!==o.created_at||!hash(e.receipt_hash)||!hash(e.bindings_hash)||eventHash(e)!==e.event_hash||typeof e.context_json!=='string'||Buffer.byteLength(e.context_json,'utf8')>1024)fail();
 const c=JSON.parse(e.context_json);if(!plain(c,['userId','sessionHash','tokenVersion','factorVersion'])||c.userId!==ownerId||!hash(c.sessionHash)||!uint(c.tokenVersion,1)||!uint(c.factorVersion,1)||JSON.stringify(c)!==e.context_json)fail();
 const review=readPaperExecutionUpgradeReviewInTransaction(db,c as unknown as OperationContext,{kind:'user',role:'owner',userId:ownerId},o.review_id,now,true),d=review.definition,a=d.affected;
 if(e.definition_hash!==review.row.definition_hash||e.review_hash!==review.row.review_hash||e.created_at<review.row.created_at||e.created_at>=review.row.expires_at||d.ownerId!==ownerId||d.version!==1||JSON.stringify(d.addedCapabilities)!==JSON.stringify(['paper.runtime.execute'])||d.canApply!==false||d.executionGranted!==false||d.runtimeConnected!==false||!a.ok||a.installationId!==o.installation_id||a.installationRevision!==o.baseline_revision||a.currentManifestDigest!==o.baseline_manifest_digest||a.targetManifestDigest!==o.target_manifest_digest||d.request.expectedRevision!==o.baseline_revision||d.request.targetManifestDigest!==o.target_manifest_digest||a.blocked)fail();
 checkProof(db,e,review);
 if(fingerprintReviewedPaperInstallationInTransaction(db,ownerId,now)!==a.installationFingerprint)fail();
 const bindings=db.prepare('SELECT * FROM main.paper_execution_bindings WHERE owner_id=? ORDER BY consent_id LIMIT 1001').all(ownerId) as Binding[];
 const current=inspectPaperRuntimeStorageInTransaction(db,ownerId,now).filter(c=>c.installationId===o.installation_id).sort((x,y)=>x.consentId.localeCompare(y.consentId));
 if(bindings.length!==a.consents.length||bindings.length!==current.length||bindings.length>1000||bindingsHash(bindings)!==e.bindings_hash)fail();
 for(let i=0;i<bindings.length;i++){
  const b=bindings[i],original=a.consents[i];if(b.consent_id!==original.consentId||b.consent_id!==current[i].consentId||b.overlay_id!==o.id||b.owner_id!==ownerId||b.definition_id!==original.definitionId||b.definition_digest!==original.definitionDigest||b.created_at!==o.created_at||typeof b.baseline_json!=='string'||Buffer.byteLength(b.baseline_json,'utf8')>8192||sha(b.baseline_json)!==b.baseline_hash)fail();
  const stored=JSON.parse(b.baseline_json);if(!plain(stored,['version','original','prefix','runtimePreservation'])||stored.version!==1||JSON.stringify(stored)!==b.baseline_json||JSON.stringify(stored.original)!==JSON.stringify(original))fail();
  const proved=d.retained[i];if(!proved||proved.consentId!==b.consent_id||JSON.stringify(stored.prefix)!==JSON.stringify(proved.preservationPrefix)||JSON.stringify(stored.runtimePreservation)!==JSON.stringify(proved.runtimePreservation))fail();
  const runtimePreservation=readPaperRuntimePreservationInTransaction(db,ownerId,b.consent_id,now);
  if(runtimePreservation.immutableProvenanceFingerprint!==proved.runtimePreservation.immutableProvenanceFingerprint||original.status==='revoked'&&runtimePreservation.revocationFingerprint!==proved.runtimePreservation.revocationFingerprint)fail();
  const s=readTrustedPaperRuntimeConsentInTransaction(db,b.consent_id,now),p=readPaperDispatchPreservationPrefixInTransaction(db,ownerId,b.definition_id,original.attemptCount,now);
  if(JSON.stringify(p)!==JSON.stringify(stored.prefix)||s.definitionId!==b.definition_id||s.definitionDigest!==b.definition_digest||s.createdAt!==original.createdAt||original.status==='revoked'&&s.status!=='revoked'||s.definition.installationId!==original.installationId||s.definition.installationRevision!==original.installationRevision||s.definition.manifestDigest!==original.manifestDigest||JSON.stringify(s.definition.limits)!==JSON.stringify(original.limits)||s.journal.attemptCount<original.attemptCount)fail();
 }
 return {overlay:o,event:e,review};
}
function projection(v:ReturnType<typeof validate>,replayed?:boolean){return Object.freeze({ok:true as const,overlayId:v.overlay.id,reviewId:v.overlay.review_id,installationId:v.overlay.installation_id,baselineRevision:v.overlay.baseline_revision,effectiveRevision:v.overlay.effective_revision,baselineManifestDigest:v.overlay.baseline_manifest_digest,effectiveManifestDigest:v.overlay.target_manifest_digest,capability:'paper.runtime.execute' as const,executionGranted:true as const,runtimeConnected:false as const,...(replayed===undefined?{}:{replayed})});}
export function initializePaperExecutionUpgradeApplications(db:Database.Database){identity(db,true);db.transaction(()=>{inspectPaperExecutionOverlaySchema(db,false);db.exec(PAPER_EXECUTION_OVERLAY_SQL);inspectPaperExecutionOverlaySchema(db);}).immediate();}
export async function applyPaperExecutionUpgrade(db:Database.Database,context:OperationContext,actor:Actor,id:string,receipt:unknown,now=Date.now()){
 try{
  identity(db,true);if(!uuid(id)||typeof receipt!=='string'||receipt.length!==43||!/^[A-Za-z0-9_-]{43}$/.test(receipt))fail();
  const c=Object.freeze({userId:context?.userId,sessionHash:context?.sessionHash,tokenVersion:context?.tokenVersion,factorVersion:context?.factorVersion}),a=Object.freeze({...actor}),receiptHash=sha(receipt);
  return await sql().tx(function*(){
   const ownerId=human(db,a,now,c);inspectPaperExecutionOverlaySchema(db);
   const existing=db.prepare('SELECT id FROM main.paper_execution_overlays WHERE owner_id=? LIMIT 1').get(ownerId);
   if(existing){const historical=validate(db,ownerId,now);human(db,a,now,c,historical.review.row.policy_version);if(historical.overlay.review_id!==id||historical.event.receipt_hash!==receiptHash||historical.event.context_json!==JSON.stringify(c))fail();return projection(historical,true);}
   assertNoPaperExecutionOverlay(db,ownerId);
   const reviewed=readPaperExecutionUpgradeReviewInTransaction(db,c,a,id,now),d=reviewed.definition,affected=d.affected;
   if(affected.blocked)fail();const created=now,overlayId=randomUUID(),eventId=randomUUID();
   const bindings=affected.consents.map((saved,index)=>{const baseline=bindingBaseline(db,ownerId,saved,d.retained[index],now),text=JSON.stringify(baseline);return {consent_id:saved.consentId,overlay_id:overlayId,owner_id:ownerId,definition_id:saved.definitionId,definition_digest:saved.definitionDigest,baseline_json:text,baseline_hash:sha(text),created_at:created};});
   if(!(yield* consumeOperationReceiptStep(receipt,c,reviewed.operation,now)))fail();
   const overlay:Overlay={id:overlayId,owner_id:ownerId,installation_id:affected.installationId,baseline_revision:affected.installationRevision,baseline_manifest_digest:affected.currentManifestDigest,target_version:PAPER_EXECUTION_UPGRADE_CANDIDATE.version,target_manifest_digest:affected.targetManifestDigest,effective_revision:affected.installationRevision+1,review_id:id,created_at:created,event_id:eventId};
   db.prepare('INSERT INTO main.paper_execution_overlays VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(overlay));
   for(const b of bindings)db.prepare('INSERT INTO main.paper_execution_bindings VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(b));
   const event:Event={id:eventId,overlay_id:overlayId,owner_id:ownerId,review_id:id,context_json:JSON.stringify(c),definition_hash:reviewed.row.definition_hash,review_hash:reviewed.row.review_hash,receipt_hash:receiptHash,created_at:created,bindings_hash:bindingsHash(bindings),event_hash:''};event.event_hash=eventHash(event);
   db.prepare('INSERT INTO main.paper_execution_upgrade_events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(event));
   const preserved=readPaperExecutionUpgradeAffectedSetInTransaction(db,a,d.request,now);if(!preserved.ok||!('affectedSetDigest' in preserved)||preserved.affectedSetDigest!==affected.affectedSetDigest)fail();
   affected.consents.forEach((saved,index)=>bindingBaseline(db,ownerId,saved,d.retained[index],now));
   human(db,a,now,c,reviewed.row.policy_version);return projection(validate(db,ownerId,now),false);
  },{immediate:true});
 }catch{return deny();}
}
/** Current installation execute capability only. Every future actual effect still requires separate consent/risk/schedule guards. */
export function readEffectivePaperExecutionAccess(db:Database.Database,actor:Actor,now=Date.now()){
 try{identity(db);return db.transaction(()=>{const ownerId=human(db,actor,now);return projection(validate(db,ownerId,now));}).deferred();}catch{return deny();}
}

/** Actual strict-path admission only. Caller must own BEGIN IMMEDIATE; returned snapshots are not bearer grants. */
export function assertReviewedPaperExecutionConsentInTransaction(db:Database.Database,ownerId:string,consentId:string,definitionId:string,definitionDigest:string,now:number){
 return assertExecutionConsent(db,ownerId,consentId,definitionId,definitionDigest,now,false);
}
/** Strict-path postcondition only: permits the just-settled bot to reach its existing finite successful-tick cap. */
export function assertReviewedPaperExecutionConsentPostSettlementInTransaction(db:Database.Database,ownerId:string,consentId:string,definitionId:string,definitionDigest:string,now:number){
 return assertExecutionConsent(db,ownerId,consentId,definitionId,definitionDigest,now,true);
}
function assertExecutionConsent(db:Database.Database,ownerId:string,consentId:string,definitionId:string,definitionDigest:string,now:number,afterSettlement:boolean){
 if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!db.inTransaction||!uuid(consentId)||!uuid(definitionId)||!hash(definitionDigest))fail();
 human(db,{kind:'user',role:'owner',userId:ownerId},now);
 const effective=validate(db,ownerId,now),bound=effective.review.definition.affected.consents.find(c=>c.consentId===consentId);
 if(!bound||bound.definitionId!==definitionId||bound.definitionDigest!==definitionDigest)fail();
 const current=assertPaperRuntimeEligibilityInTransaction(db,consentId,now,afterSettlement);
 if(current.ownerId!==ownerId||current.definitionId!==definitionId||current.definitionDigest!==definitionDigest)fail();
 return current;
}
