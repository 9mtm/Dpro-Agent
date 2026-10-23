/** Read-only bundled bot-management capability metadata. No installer or execution authority is implemented here. */
import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
const capabilities=Object.freeze(['paper.bot.manage'] as const);
const declaration={appId:'trading',version:'1.0.0',schemaVersion:1,mode:'paper',capabilities};
export const PAPER_BOT_MANIFEST=Object.freeze({...declaration,digest:createHash('sha256').update(JSON.stringify(declaration)).digest('hex')});
type State='demo_only'|'not_provisioned'|'incompatible'|'disabled'|'ready';
/** ownerId is authenticated server identity. Explicit installation metadata must be provisioned separately. */
export function readPaperBotAvailability(db:Database.Database|null,ownerId:string):Readonly<{state:State}> {
 const project=(state:State)=>Object.freeze({state});
 if(typeof ownerId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(ownerId))return project('incompatible');
 if(!db)return project('demo_only');
 try{
  const table=db.prepare("SELECT type FROM sqlite_master WHERE name='paper_bot_installations'").all() as {type:string}[];
  if(!table.length)return project('not_provisioned');if(table.length!==1||table[0].type!=='table')return project('incompatible');
  const schema:Record<string,string>={owner_id:'TEXT',app_id:'TEXT',version:'TEXT',schema_version:'INTEGER',manifest_digest:'TEXT',mode:'TEXT',status:'TEXT'};
  const columns=db.prepare('PRAGMA table_info(paper_bot_installations)').all() as {name:string;type:string}[];
  if(columns.length!==Object.keys(schema).length||columns.some(column=>!Object.hasOwn(schema,column.name)||schema[column.name]!==column.type.toUpperCase()))return project('incompatible');
  const rows=db.prepare('SELECT version,schema_version,manifest_digest,mode,status FROM paper_bot_installations WHERE owner_id=? AND app_id=? LIMIT 2').all(ownerId,PAPER_BOT_MANIFEST.appId) as Record<string,unknown>[];
  if(!rows.length)return project('not_provisioned');if(rows.length!==1)return project('incompatible');const row=rows[0];
  if(row.version!==PAPER_BOT_MANIFEST.version||row.schema_version!==PAPER_BOT_MANIFEST.schemaVersion||row.manifest_digest!==PAPER_BOT_MANIFEST.digest||row.mode!=='paper'||!['ready','disabled'].includes(row.status as string))return project('incompatible');
  return project(row.status==='disabled'?'disabled':'ready');
 }catch{return project('incompatible');}
}
