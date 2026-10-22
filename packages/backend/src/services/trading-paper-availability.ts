/** Read-only SQLite availability. Installation proof and executable order authority are separate. */
import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
const capabilities=Object.freeze(['paper.account.read'] as const);
const declaration={appId:'trading',version:'1.0.0',schemaVersion:1,mode:'paper',capabilities};
/** Internal bundled metadata; the public projection deliberately omits the digest. */
export const PAPER_APP_MANIFEST=Object.freeze({...declaration,digest:createHash('sha256').update(JSON.stringify(declaration)).digest('hex')});
type State='demo_only'|'not_provisioned'|'incompatible'|'disabled'|'ready';
const project=(state:State)=>Object.freeze({appId:PAPER_APP_MANIFEST.appId,version:PAPER_APP_MANIFEST.version,mode:'paper' as const,state,readAccounts:state==='ready'||state==='disabled',executeOrders:false as const});
const schemas={
 paper_app_installations:{owner_id:'TEXT',app_id:'TEXT',version:'TEXT',schema_version:'INTEGER',manifest_digest:'TEXT',mode:'TEXT',status:'TEXT'},
 paper_accounts:{account_id:'TEXT',owner_id:'TEXT',mode:'TEXT',currency:'TEXT',cash:'INTEGER',exposure:'INTEGER',app_enabled:'INTEGER',app_revision:'INTEGER',stopped:'INTEGER'},
 paper_policies:{policy_id:'TEXT',account_id:'TEXT',revision:'INTEGER',policy_json:'TEXT'},
 paper_quotes:{account_id:'TEXT',symbol:'TEXT',quote_at:'INTEGER'},
 paper_reservations:{reservation_id:'TEXT',account_id:'TEXT',policy_id:'TEXT',idempotency_key:'TEXT',intent_hash:'TEXT',notional:'INTEGER',created_at:'INTEGER',status:'TEXT',cancelled_at:'INTEGER'},
} as const;
/** Only literal bundled names are used for schema inspection. Views and extra/changed columns refuse. */
function hasSchema(db:Database.Database,name:keyof typeof schemas):boolean {
 const tables=db.prepare("SELECT type FROM sqlite_master WHERE name=?").all(name) as {type:string}[];
 if(tables.length!==1||tables[0].type!=='table')return false;
 const columns=db.prepare(`PRAGMA table_info(${name})`).all() as {name:string;type:string}[];
 const expected=schemas[name] as Record<string,string>;
 return columns.length===Object.keys(expected).length&&columns.every(c=>Object.hasOwn(expected,c.name)&&c.type.toUpperCase()===expected[c.name]);
}
/** ownerId must come from the authenticated server actor, not request body or query. Never initializes. */
export function readPaperAvailability(db:Database.Database|null,ownerId:string){
 if(typeof ownerId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(ownerId))return project('incompatible');
 if(!db)return project('demo_only');
 try{return db.transaction(()=>{
  const exists=db.prepare("SELECT type FROM sqlite_master WHERE name='paper_app_installations'").get();
  if(!exists)return project('not_provisioned');
  if(!hasSchema(db,'paper_app_installations'))return project('incompatible');
  const rows=db.prepare('SELECT version,schema_version,manifest_digest,mode,status FROM paper_app_installations WHERE owner_id=? AND app_id=? LIMIT 2').all(ownerId,PAPER_APP_MANIFEST.appId) as {version:unknown;schema_version:unknown;manifest_digest:unknown;mode:unknown;status:unknown}[];
  if(!rows.length)return project('not_provisioned');
  if(rows.length!==1)return project('incompatible');
  const row=rows[0];
  if(row.version!==PAPER_APP_MANIFEST.version||row.schema_version!==PAPER_APP_MANIFEST.schemaVersion||row.manifest_digest!==PAPER_APP_MANIFEST.digest||row.mode!=='paper'||!['ready','disabled'].includes(row.status as string))return project('incompatible');
  for(const name of ['paper_accounts','paper_policies','paper_quotes','paper_reservations'] as const)if(!hasSchema(db,name))return project('incompatible');
  return project(row.status==='disabled'?'disabled':'ready');
 }).deferred();}catch{return project('incompatible');}
}
