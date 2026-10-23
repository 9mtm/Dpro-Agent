/** Offline compatibility inspection only. No reviewed upgrade, migration, execution grant or installation writes. */
import type Database from 'better-sqlite3';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import type {Actor} from '../repositories/actor.js';
import {BUNDLED_PAPER_INSTALLATION,readPaperInstallation} from './trading-paper-installation.js';
import {readReviewedPaperInstallationAccess} from './trading-paper-install-review.js';
import {PAPER_EXECUTION_UPGRADE_CANDIDATE,lookupPaperManifest} from './trading-paper-manifest-catalog.js';
import {inspectPaperRuntimeStorageInTransaction} from './trading-paper-runtime-consent.js';
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
export function inspectPaperExecutionUpgradeCompatibility(db:Database.Database,actor:Actor,value:unknown,nowOverride?:number){
 try{
  if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||db.inTransaction)fail();
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
   return Object.freeze({ok:true as const,state:affected?'migration_required' as const:'reviewed_upgrade_not_implemented' as const,currentVersion:BUNDLED_PAPER_INSTALLATION.version,targetVersion:target.manifest.version,expectedRevision:installation.revision,...flags});
  }).deferred();
 }catch{return deny();}
}
