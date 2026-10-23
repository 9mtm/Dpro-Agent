import {readReviewedPaperInstallationAccess} from './trading-paper-install-review.js';
/** Read-only bundled bot-management capability metadata. No installer or execution authority is implemented here. */
import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
const capabilities=Object.freeze(['paper.bot.manage'] as const);
const declaration={appId:'trading',version:'1.0.0',schemaVersion:1,mode:'paper',capabilities};
export const PAPER_BOT_MANIFEST=Object.freeze({...declaration,digest:createHash('sha256').update(JSON.stringify(declaration)).digest('hex')});
/** Manual management only; owner consent for account reads never implies bot management. */
export function readPaperBotAvailability(db:Database.Database|null,ownerId:string){
 const access=readReviewedPaperInstallationAccess(db,ownerId);
 const state=access.state==='ready'||access.state==='disabled'?(access.manageBots?'ready':access.readBots?'disabled':'not_provisioned'):access.state;
 return Object.freeze({state});
}
