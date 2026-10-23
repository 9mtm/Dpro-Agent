/** Internal schema-only preparation for the fixed bundled paper app. No installation, grants or runtime activation. */
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {getDatabase} from '../db/index.js';
import {dbDriver} from '../db/pg/config.js';
import {applyPaperBundleSchema} from './trading-paper-schema-definition.js';
type SchemaObject=Readonly<{type:string;name:string;tbl_name:string;sql:string|null}>;
const unavailable=()=>({ok:false as const,reason:'unavailable' as const});
const fail=()=>{throw Error('paper schema unavailable');};
function identity(db:Database.Database){if(dbDriver()!=='sqlite'||getDatabase().getDb()!==db)fail();}
function objects(db:Database.Database):SchemaObject[]{return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY type,name").all() as SchemaObject[];}
// Derive SQLite's exact representation from the same definitions used by public initializers.
// This temporary in-memory reference never inspects or changes the application's database.
const reference=new Database(':memory:');
let expected:readonly SchemaObject[];
try{reference.transaction(()=>applyPaperBundleSchema(reference)).immediate();expected=Object.freeze(objects(reference).map(row=>Object.freeze({...row})));}finally{reference.close();}
const tables=Object.freeze(expected.filter(row=>row.type==='table').map(row=>row.name));
const byName=new Map(expected.map(row=>[row.name,row]));
const tableSet=new Set(tables);
export const PAPER_BUNDLE_SCHEMA=Object.freeze({implementationId:'bundled.trading.paper.v1',schemaVersion:1,tableCount:tables.length,
 digest:createHash('sha256').update(JSON.stringify(['paper-bundle-schema-v1',expected])).digest('hex')});
function existing(db:Database.Database,complete:boolean){
 const temporary=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_temp_master WHERE type IN ('table','index','trigger','view')").all() as SchemaObject[];
 if(temporary.some(row=>tableSet.has(row.tbl_name.toLowerCase())||byName.has(row.name.toLowerCase())))fail();
 const found=objects(db).filter(row=>tableSet.has(row.tbl_name.toLowerCase())||byName.has(row.name.toLowerCase()));
 for(const row of found){const wanted=byName.get(row.name);if(!wanted||JSON.stringify(row)!==JSON.stringify(wanted))fail();}
 if(complete&&found.length!==expected.length)fail();
}
/** Read-only exact-schema assessment; no lazy initialization or installation state is returned. */
export function inspectPaperBundleSchema(db:Database.Database){
 try{identity(db);existing(db,true);return {ok:true as const,schemaDigest:PAPER_BUNDLE_SCHEMA.digest,tableCount:tables.length};}catch{return unavailable();}
}
/**
 * Trusted installer composition only: exact main handle and caller-owned IMMEDIATE transaction are required.
 * inTransaction cannot prove lock mode or owner approval. Caller must let exceptions roll back ALL effects.
 * Does not consume a proof, write a grant/installation record or make the backend use this database.
 */
export function preparePaperBundleSchemaInTransaction(db:Database.Database){
 identity(db);if(!db.inTransaction)fail();existing(db,false);applyPaperBundleSchema(db);existing(db,true);
 return {schemaDigest:PAPER_BUNDLE_SCHEMA.digest,tableCount:tables.length};
}
/** Owns one IMMEDIATE transaction for all fifteen tables and the history index. Never called at startup or by a route. */
export function preparePaperBundleSchema(db:Database.Database){
 try{identity(db);if(db.inTransaction)fail();return db.transaction(()=>({ok:true as const,...preparePaperBundleSchemaInTransaction(db)})).immediate();}catch{return unavailable();}
}

/** Read-only preflight for current supported schema subsets. Missing tables are permitted, unknown definitions are not. */
export function inspectPaperBundlePreparation(db:Database.Database){
 try{identity(db);existing(db,false);return {ok:true as const,schemaDigest:PAPER_BUNDLE_SCHEMA.digest};}catch{return unavailable();}
}
