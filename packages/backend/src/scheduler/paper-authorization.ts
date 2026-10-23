/** SQLite-only paper schedule inspection. No timer, dispatch or authorization token is created here. */
import type Database from 'better-sqlite3';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {readTrustedPaperRuntimeConsentInTransaction} from '../services/trading-paper-runtime-consent.js';
import {assertReviewedPaperExecutionConsentInTransaction} from '../services/trading-paper-execution-upgrade-apply.js';
import {capturePaperRuntimeAction} from './authorization-definition.js';
function fail():never{throw Error('paper schedule unavailable');}
function handle(db:Database.Database){if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!db.inTransaction)fail();const names=['cron_jobs','scheduled_job_security_versions','scheduled_job_authorizations','scheduled_job_authorization_events','users','verification_factors','verification_receipts','approval_proof_policy'];const temp=db.prepare('SELECT name,tbl_name FROM sqlite_temp_master').all() as {name:string;tbl_name:string}[];if(temp.some(r=>names.includes(r.name.toLowerCase())||names.includes(r.tbl_name.toLowerCase())))fail();for(const name of names)if(!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(name))fail();}
/** Previous paper references must remain owner-scoped even when being replaced with a generic action. */
export function assertPaperScheduleOwnerInTransaction(db:Database.Database,ownerId:string,action:unknown,now:number){
 handle(db);const data=capturePaperRuntimeAction(action),consent=readTrustedPaperRuntimeConsentInTransaction(db,data.consentId,now);if(consent.ownerId!==ownerId)fail();return consent;
}
export function inspectPaperScheduleInTransaction(db:Database.Database,ownerId:string,action:unknown,now:number,expiresAt?:number){
 const consent=assertPaperScheduleOwnerInTransaction(db,ownerId,action,now);
 const checked=assertReviewedPaperExecutionConsentInTransaction(db,ownerId,consent.consentId,consent.definitionId,consent.definitionDigest,now),d=checked.definition;
 if(expiresAt!==undefined&&(!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt>d.limits.expiresAt))fail();
 return Object.freeze({consentId:checked.consentId,botId:d.botId,mode:'paper' as const,symbol:d.strategy.symbol,side:d.strategy.side,amount:d.strategy.amount,amountUnit:d.strategy.side==='buy'?'account_minor_units' as const:'whole_asset_units' as const,currency:checked.currency,maxAttempts:d.limits.maxAttempts,attemptsConsumed:checked.journal.attemptCount,cadenceMs:d.limits.cadenceMs,runtimeExpiresAt:d.limits.expiresAt,scheduleExpiresAt:expiresAt??null,runtimeConnected:false as const,executionAvailable:false as const});
}
