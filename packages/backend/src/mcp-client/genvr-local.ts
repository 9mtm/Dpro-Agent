import { logAudit } from '../services/audit-logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer, enableServer, refreshServer } from './service.js';
import { getServerRowByName, readSecrets, parseList } from './store.js';
import { isExecToolsEnabled } from '../tools/exec-policy.js';
import { mcpServersBaseDir, ensureServerWorkDir } from './config.js';
const NAME='genvr-local';
const PACKAGE_HASH='8d0dfefb011d03d12e7a4c1552d4fb060a99bf06a8ed149c2fdaad75c4fa0b15';
let queue:Promise<unknown>=Promise.resolve();
/** Register the pinned bundled authoring server; keep all normal execution and grant gates. */
export function ensureGenvrMcp(ownerId:string) {
 const work=queue.then(async()=>{
  const entry=fileURLToPath(new URL('../../../core-ui/vendor/genvr/package/dist/mcp.js',import.meta.url));
  try{if((await fs.lstat(entry)).isSymbolicLink()||createHash('sha256').update(await fs.readFile(entry)).digest('hex')!==PACKAGE_HASH)return {status:'unavailable',id:null};}catch{return {status:'unavailable',id:null};}
  const worldDir=path.join(mcpServersBaseDir(),NAME,'worlds');
  let row=await getServerRowByName(NAME);
  if(!row){const saved=await createServer({name:NAME,description:'Bundled GenVR local authoring',transport:'stdio',command:process.execPath,args:[entry],env:{GENVR_WORLD_DIR:worldDir}},ownerId,{dormantImport:true});row=await getServerRowByName(NAME);if(!row)return {status:'unavailable',id:saved.id};}
  const secrets=await readSecrets(row);
  if(row.transport!=='stdio'||row.command!==process.execPath||JSON.stringify(parseList(row.args))!==JSON.stringify([entry])||JSON.stringify(Object.keys(secrets.env))!==JSON.stringify(['GENVR_WORLD_DIR'])||secrets.env.GENVR_WORLD_DIR!==worldDir||Object.keys(secrets.headers).length)return {status:'conflict',id:row.id};
  // A deliberate disable after the first activation is retained on future visits.
  if(row.enabled!==1&&row.approved_at)return {status:'disabled',id:row.id};
  if(!isExecToolsEnabled())return {status:'blocked',id:row.id};
  try{
   ensureServerWorkDir(NAME);
   if(row.enabled!==1){await enableServer(row.id,{launchHash:row.launch_hash},ownerId);logAudit({event_type:'mcp.server.change',event_category:'system',severity:'info',user_id:ownerId,action:'mcp_server.bundled_genvr_enable',success:true,resource_type:'mcp_server',resource_id:row.id,metadata:{package:'3d-world-sdk',version:'0.3.0-preview.11'}});}
   await refreshServer(row.id,ownerId);
   return {status:'ready',id:row.id};
  }catch{return {status:'blocked',id:row.id};}
 });queue=work.catch(()=>{});return work;
}
