import { logAudit } from '../services/audit-logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer, enableServer, refreshServer, updateServer } from './service.js';
import os from 'node:os';
import { getServerRowByName, readSecrets, parseList } from './store.js';
import { isExecToolsEnabled } from '../tools/exec-policy.js';
import { mcpServersBaseDir, ensureServerWorkDir } from './config.js';
const NAME='genvr-local';
const DESCRIPTION='Bundled GenVR local authoring';
/** Live MCP connection file written by the local Studio host (core-ui scripts/genvr-studio-host.cjs). */
export const studioConnectionFile=()=>path.resolve(process.env.DPRO_GENVR_CONNECTION||path.join(os.homedir(),'.genvr','dpro-studio','studio-connection.json'));
const PACKAGE_HASH='45006dc0085c4c34b5d42d9321c3ca342dd9f2a85590f6b8191c8ef5973fa201';
let queue:Promise<unknown>=Promise.resolve();
/** Register the pinned bundled authoring server; keep all normal execution and grant gates. */
export function ensureGenvrMcp(ownerId:string) {
 const work=queue.then(async()=>{
  const entry=fileURLToPath(new URL('../../../core-ui/vendor/genvr/package/dist/mcp.js',import.meta.url));
  try{if((await fs.lstat(entry)).isSymbolicLink()||createHash('sha256').update(await fs.readFile(entry)).digest('hex')!==PACKAGE_HASH)return {status:'unavailable',id:null};}catch{return {status:'unavailable',id:null};}
  const worldDir=path.join(mcpServersBaseDir(),NAME,'worlds');
  const env={GENVR_WORLD_DIR:worldDir,GENVR_STUDIO_CONNECTION:studioConnectionFile()};
  let row=await getServerRowByName(NAME),upgraded=false;
  if(!row){const saved=await createServer({name:NAME,description:DESCRIPTION,transport:'stdio',command:process.execPath,args:[entry],env},ownerId,{dormantImport:true});row=await getServerRowByName(NAME);if(!row)return {status:'unavailable',id:saved.id};}
  const secrets=await readSecrets(row);
  const same=row.transport==='stdio'&&row.command===process.execPath&&JSON.stringify(parseList(row.args))===JSON.stringify([entry])&&JSON.stringify(Object.keys(secrets.env).sort())===JSON.stringify(Object.keys(env).sort())&&Object.entries(env).every(([k,v])=>secrets.env[k]===v)&&!Object.keys(secrets.headers).length;
  if(!same){
   // An earlier bundled package (other path/version/env) is re-pointed to this one: the launch
   // changes, so its approval and tool grants are reset like any edited server. Anything else
   // registered under this name is left alone.
   const bundled=row.transport==='stdio'&&row.description===DESCRIPTION&&!Object.keys(secrets.headers).length&&Object.keys(secrets.env).every(k=>k in env)&&parseList(row.args).length===1&&/[\\/]vendor[\\/]genvr[\\/]package[\\/]dist[\\/]mcp\.js$/.test(parseList(row.args)[0]??'');
   if(!bundled)return {status:'conflict',id:row.id};
   if(!isExecToolsEnabled())return {status:'blocked',id:row.id};
   await updateServer(row.id,{command:process.execPath,args:[entry],env},ownerId);upgraded=true;
   row=await getServerRowByName(NAME);if(!row)return {status:'unavailable',id:null};
  }
  // A deliberate disable after the first activation is retained on future visits.
  if(row.enabled!==1&&row.approved_at&&!upgraded)return {status:'disabled',id:row.id};
  if(!isExecToolsEnabled())return {status:'blocked',id:row.id};
  try{
   ensureServerWorkDir(NAME);
   if(row.enabled!==1){await enableServer(row.id,{launchHash:row.launch_hash},ownerId);logAudit({event_type:'mcp.server.change',event_category:'system',severity:'info',user_id:ownerId,action:'mcp_server.bundled_genvr_enable',success:true,resource_type:'mcp_server',resource_id:row.id,metadata:{package:'3d-world-sdk',version:'0.3.0-preview.14',upgraded}});}
   await refreshServer(row.id,ownerId);
   return {status:'ready',id:row.id};
  }catch{return {status:'blocked',id:row.id};}
 });queue=work.catch(()=>{});return work;
}
