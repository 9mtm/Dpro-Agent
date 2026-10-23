/** Read-only canonical due planning. A returned key never supplies dispatch or schedule authority. */
import type Database from 'better-sqlite3';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {readTrustedPaperRuntimeConsentInTransaction} from './trading-paper-runtime-consent.js';
import {derivePaperRuntimeDueAttemptKey} from './trading-paper-dispatch-attempts.js';
function fail():never{throw Error('paper due plan unavailable');}
export function readDuePaperRuntimeAttemptKeyInTransaction(db:Database.Database,consentId:string,now:number){
 if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db||!db.inTransaction||!Number.isSafeInteger(now)||now<1)fail();
 const s=readTrustedPaperRuntimeConsentInTransaction(db,consentId,now),j=s.journal;
 if(s.runtimePrincipal!=='bundled.paper.deterministic.v1')fail();
 for(const a of j.attempts)if(a.attemptKey!==derivePaperRuntimeDueAttemptKey(consentId,s.definitionId,s.definitionDigest,a.sequence))fail();
 if(j.blockedByUnknown)fail();const pending=j.attempts.find(a=>a.status==='pending');if(pending)return pending.attemptKey;
 if(s.status!=='granted'||now>=s.definition.limits.expiresAt||j.attemptCount>=s.definition.limits.maxAttempts||j.lastClaimAt!==null&&BigInt(now)-BigInt(j.lastClaimAt)<BigInt(s.definition.limits.cadenceMs))fail();
 return derivePaperRuntimeDueAttemptKey(consentId,s.definitionId,s.definitionDigest,j.attemptCount+1);
}
