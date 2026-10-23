import {readReviewedPaperInstallationAccess} from './trading-paper-install-review.js';
/** Read-only SQLite availability. Installation proof and executable order authority are separate. */
import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
const capabilities=Object.freeze(['paper.account.read'] as const);
const declaration={appId:'trading',version:'1.0.0',schemaVersion:1,mode:'paper',capabilities};
/** Internal bundled metadata; the public projection deliberately omits the digest. */
export const PAPER_APP_MANIFEST=Object.freeze({...declaration,digest:createHash('sha256').update(JSON.stringify(declaration)).digest('hex')});
type State='demo_only'|'not_provisioned'|'incompatible'|'disabled'|'ready';
const project=(state:State)=>Object.freeze({appId:PAPER_APP_MANIFEST.appId,version:PAPER_APP_MANIFEST.version,mode:'paper' as const,state,readAccounts:state==='ready'||state==='disabled',executeOrders:false as const});
/** Explicit same-main adapter only. Legacy declaration rows are not owner grants. Never initializes. */
export function readPaperAvailability(db:Database.Database|null,ownerId:string){
 const access=readReviewedPaperInstallationAccess(db,ownerId);return Object.freeze({...project(access.state),readAccounts:access.readAccounts});
}
