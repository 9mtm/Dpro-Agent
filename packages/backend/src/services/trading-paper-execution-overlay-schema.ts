/** Isolated execution overlay schema only. No original installation rows or business schemas are modified. */
import Database from 'better-sqlite3';
export const PAPER_EXECUTION_OVERLAY_SQL=`CREATE TABLE IF NOT EXISTS paper_execution_overlays(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,installation_id TEXT NOT NULL,baseline_revision INTEGER NOT NULL,baseline_manifest_digest TEXT NOT NULL,target_version TEXT NOT NULL,target_manifest_digest TEXT NOT NULL,effective_revision INTEGER NOT NULL,review_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,event_id TEXT NOT NULL UNIQUE,UNIQUE(owner_id,installation_id));
CREATE TABLE IF NOT EXISTS paper_execution_upgrade_events(id TEXT PRIMARY KEY,overlay_id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,review_id TEXT NOT NULL UNIQUE,context_json TEXT NOT NULL,definition_hash TEXT NOT NULL,review_hash TEXT NOT NULL,receipt_hash TEXT NOT NULL,created_at INTEGER NOT NULL,bindings_hash TEXT NOT NULL,event_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS paper_execution_bindings(consent_id TEXT PRIMARY KEY,overlay_id TEXT NOT NULL,owner_id TEXT NOT NULL,definition_id TEXT NOT NULL UNIQUE,definition_digest TEXT NOT NULL,baseline_json TEXT NOT NULL,baseline_hash TEXT NOT NULL,created_at INTEGER NOT NULL);`;
type ObjectRow={type:string;name:string;tbl_name:string;sql:string|null};
const objects=(db:Database.Database,temp=false)=>db.prepare(`SELECT type,name,tbl_name,sql FROM ${temp?'sqlite_temp_master':'sqlite_master'} WHERE type IN ('table','index','view','trigger') ORDER BY type,name`).all() as ObjectRow[];
const reference=new Database(':memory:');let expected:readonly ObjectRow[];
try{reference.exec(PAPER_EXECUTION_OVERLAY_SQL);expected=Object.freeze(objects(reference).map(r=>Object.freeze({...r})));}finally{reference.close();}
const names=new Set(expected.map(r=>r.name));
export function inspectPaperExecutionOverlaySchema(db:Database.Database,required=true){
 const related=(r:ObjectRow)=>names.has(r.name.toLowerCase())||names.has(r.tbl_name.toLowerCase());
 if(objects(db,true).some(related))throw Error('paper execution overlay unavailable');
 const found=objects(db).filter(related);
 for(const r of found){const wanted=expected.find(e=>e.name===r.name);if(!wanted||JSON.stringify(r)!==JSON.stringify(wanted))throw Error('paper execution overlay unavailable');}
 if((required||found.length>0)&&found.length!==expected.length)throw Error('paper execution overlay unavailable');
 return found.length===expected.length;
}
/** Second staging is refused even for damaged/orphan overlay rows. No raw row grants anything. */
export function assertNoPaperExecutionOverlay(db:Database.Database,ownerId:string){
 if(!inspectPaperExecutionOverlaySchema(db,false))return;
 for(const name of ['paper_execution_overlays','paper_execution_upgrade_events','paper_execution_bindings'])if(db.prepare(`SELECT 1 FROM main.${name} WHERE owner_id=? LIMIT 1`).get(ownerId))throw Error('paper execution overlay unavailable');
}
