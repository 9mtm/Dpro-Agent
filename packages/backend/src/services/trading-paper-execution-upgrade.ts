/** Offline compatibility inspection only. No reviewed upgrade, migration, execution grant or installation writes. */
import {assertPaperDispatchStorageInTransaction} from './trading-paper-dispatch-attempts.js';
import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import type {Actor} from '../repositories/actor.js';
import {BUNDLED_PAPER_INSTALLATION,readPaperInstallation} from './trading-paper-installation.js';
import {fingerprintReviewedPaperInstallationInTransaction,readReviewedPaperInstallationAccess} from './trading-paper-install-review.js';
import {PAPER_EXECUTION_UPGRADE_CANDIDATE,lookupPaperManifest} from './trading-paper-manifest-catalog.js';
import {fingerprintPaperRuntimeHistoryInTransaction,readTrustedPaperRuntimeConsentInTransaction,inspectPaperRuntimeStorageInTransaction} from './trading-paper-runtime-consent.js';
const flags=Object.freeze({canApply:false as const,runtimeConnected:false as const,executionGranted:false as const});
const deny=()=>Object.freeze({ok:false as const,reason:'unavailable' as const,...flags});
function fail():never{throw Error('paper execution upgrade unavailable');}
function capture(value:unknown){
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
 const keys=Reflect.ownKeys(value);if(keys.length!==2||keys.some(k=>typeof k!=='string'||!['expectedRevision','targetManifestDigest'].includes(k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)!,'value')))fail();
 const v=value as Record<string,unknown>;
 if(typeof v.expectedRevision!=='number'||!Number.isSafeInteger(v.expectedRevision)||v.expectedRevision<1||typeof v.targetManifestDigest!=='string'||v.targetManifestDigest.length!==64||!/^[a-f0-9]{64}$/.test(v.targetManifestDigest))fail();
 return {expectedRevision:v.expectedRevision,targetManifestDigest:v.targetManifestDigest};
}
function inspect(db:Database.Database,actor:Actor,value:unknown,nowOverride:number|undefined,includeAffected:boolean,callerTransaction=false){
 try{
  if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||db.inTransaction!==callerTransaction)fail();
  const request=capture(value);
  if(!actor||actor.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||typeof actor.userId!=='string'||!actor.userId||actor.userId.length>128||/[\x00-\x20\x7f]/.test(actor.userId)||isSystemAccount(actor.userId))fail();
  const ownerId=actor.userId;
  return db.transaction(()=>{
   const now=nowOverride===undefined?Date.now():nowOverride;if(!Number.isSafeInteger(now)||now<1)fail();
   const target=lookupPaperManifest('1.1.0',request.targetManifestDigest);if(!target||target.manifest!==PAPER_EXECUTION_UPGRADE_CANDIDATE||!target.candidate||target.installable||target.executable)fail();
   const access=readReviewedPaperInstallationAccess(db,ownerId,()=>now),installation=readPaperInstallation(db,ownerId,()=>now);
   if(access.state!=='ready'||!installation.ok||installation.state!=='provisioned'||installation.revision!==request.expectedRevision)fail();
   const bindings=inspectPaperRuntimeStorageInTransaction(db,ownerId,now);
   // Historical grant bindings survive revocation; reusing them after changing installation metadata is unsafe.
   const affected=bindings.some(r=>r.installationId===installation.installationId);
   if(includeAffected){
    assertPaperDispatchStorageInTransaction(db,ownerId);
    const rows=bindings.filter(r=>r.installationId===installation.installationId).sort((a,b)=>a.consentId.localeCompare(b.consentId)).map(binding=>{
     const saved=readTrustedPaperRuntimeConsentInTransaction(db,binding.consentId,now),d=saved.definition,j=saved.journal;
     if(d.installationId!==installation.installationId||d.manifestDigest!==BUNDLED_PAPER_INSTALLATION.manifestDigest)fail();
     const historyFingerprint=fingerprintPaperRuntimeHistoryInTransaction(db,ownerId,binding.consentId,now);
     const pending=j.attempts.some(a=>a.status==='pending');
     return Object.freeze({consentId:saved.consentId,definitionId:saved.definitionId,definitionDigest:saved.definitionDigest,status:saved.status,createdAt:saved.createdAt,installationId:d.installationId,installationRevision:d.installationRevision,manifestDigest:d.manifestDigest,limits:Object.freeze({...d.limits}),attemptCount:j.attemptCount,lastClaimAt:j.lastClaimAt,historyFingerprint,pending,unknown:j.blockedByUnknown,blocked:pending||j.blockedByUnknown});
    });
    if(new Set(rows.map(r=>r.consentId)).size!==rows.length||new Set(rows.map(r=>r.definitionId)).size!==rows.length)fail();
    const preserved=Object.freeze({installationFingerprint:fingerprintReviewedPaperInstallationInTransaction(db,ownerId,now),installationId:installation.installationId,installationRevision:installation.revision,currentManifestDigest:BUNDLED_PAPER_INSTALLATION.manifestDigest,targetManifestDigest:target.manifest.manifestDigest,consents:Object.freeze(rows)});
    const affectedSetDigest=createHash('sha256').update(JSON.stringify(['paper-execution-upgrade-affected-set-v1',preserved])).digest('hex');
    return Object.freeze({ok:true as const,state:affected?'migration_required' as const:'reviewed_upgrade_not_implemented' as const,affectedSetDigest,...preserved,blocked:rows.some(r=>r.blocked),...flags});
   }
   return Object.freeze({ok:true as const,state:affected?'migration_required' as const:'reviewed_upgrade_not_implemented' as const,currentVersion:BUNDLED_PAPER_INSTALLATION.version,targetVersion:target.manifest.version,expectedRevision:installation.revision,...flags});
  }).deferred();
 }catch{return deny();}
}

/** Offline compatibility interface remains unchanged. */
export function inspectPaperExecutionUpgradeCompatibility(db:Database.Database,actor:Actor,value:unknown,nowOverride?:number){return inspect(db,actor,value,nowOverride,false);}
/** Read-only preservation fingerprint, never an apply token or execution grant. Expired pending work stays pending. */
export function readPaperExecutionUpgradeAffectedSet(db:Database.Database,actor:Actor,value:unknown,nowOverride?:number){return inspect(db,actor,value,nowOverride,true);}

/** Internal same-snapshot composition only. Caller owns the transaction; this grants nothing. */
export function readPaperExecutionUpgradeAffectedSetInTransaction(db:Database.Database,actor:Actor,value:unknown,now:number){return inspect(db,actor,value,now,true,true);}
