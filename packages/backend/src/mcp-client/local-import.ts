import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { clampTimeout, checkCommand, checkSecretMap, checkServerUrl, isLoopbackHost, type McpTransport } from './config.js';
import { createServer, type ServerInput } from './service.js';
import { listServerRows, readSecrets, parseList } from './store.js';
import { redactImportText } from '../memory/import/redact.js';

export class LocalMcpError extends Error {
 constructor(readonly code: string, readonly status = 400) { super(code); }
}
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const digest = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const sorted = (x: Record<string,string> = {}) => Object.fromEntries(Object.entries(x).sort(([a],[b]) => a.localeCompare(b)));
/** Deliberately bounded TOML subset for MCP tables. Unsupported syntax fails closed. */
export function parseMcpToml(text: string): Record<string, unknown> {
 const servers: Record<string, any> = Object.create(null); let target: Record<string, any> | null = null;
 let pending = '';
 for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim(); if (!pending && (!line || line.startsWith('#'))) continue;
  if (!pending && line.startsWith('[')) {
   target = null;
   if (!line.startsWith('[mcp_servers.')) continue;
   const m = /^\[mcp_servers\.("(?:[^"\\]|\\.)+"|'[^']+'|[A-Za-z0-9_-]+)(?:\.(env|http_headers))?\]\s*(?:#.*)?$/.exec(line);
   if (!m) throw new LocalMcpError('unsupported_toml');
   const name = m[1].startsWith('"') ? JSON.parse(m[1]) : m[1].replace(/^'|'$/g,'');
   if (!Object.hasOwn(servers,name)) servers[name] = Object.create(null);
   target = m[2] ? (servers[name][m[2]] ??= Object.create(null)) : servers[name]; continue;
  }
  if (!target) continue;
  pending += (pending ? '\n' : '') + raw;
  const pair = /^\s*("(?:[^"\\]|\\.)+"|'[^']+'|[A-Za-z0-9_-]+)\s*=\s*([\s\S]*)$/.exec(pending);
  if (!pair) throw new LocalMcpError('unsupported_toml');
  let quote = '', escaped = false, depth = 0, clean = '';
  for (let i=0; i<pair[2].length; i++) {
   const c=pair[2][i];
   if (quote) { clean+=c; if (escaped) escaped=false; else if(c==='\\'&&quote==='"')escaped=true; else if(c===quote)quote=''; }
   else if(c==='"'||c==="'"){quote=c;clean+=c;}
   else if(c==='#'){while(i<pair[2].length&&pair[2][i]!=='\n')i++;clean+='\n';}
   else {if(c==='[')depth++;if(c===']')depth--;clean+=c;}
  }
  if (quote || depth>0) { if(pending.length>65536)throw new LocalMcpError('unsupported_toml'); continue; }
  const literal=clean.trim(); let value: unknown;
  try {
   if (/^'[^'\n]*'$/.test(literal)) value=literal.slice(1,-1);
   else if(literal.startsWith('[')) {
    // Arrays are strings only; single quoted strings are converted without evaluation.
    if(!literal.endsWith(']')||depth!==0)throw Error();
    let remaining=literal.slice(1,-1).trim();const values:string[]=[];
    while(remaining){const token=/^(?:"(?:[^"\\]|\\.)*"|'[^']*')/.exec(remaining);if(!token)throw Error();
     values.push(token[0].startsWith("'")?token[0].slice(1,-1):JSON.parse(token[0]));remaining=remaining.slice(token[0].length).trim();
     if(remaining){if(!remaining.startsWith(','))throw Error();remaining=remaining.slice(1).trim();}
    }value=values;
   } else value=JSON.parse(literal);
  } catch {throw new LocalMcpError('unsupported_toml');}
  const key=pair[1].startsWith('"')?JSON.parse(pair[1]):pair[1].replace(/^'|'$/g,'');
  if(Object.hasOwn(target,key))throw new LocalMcpError('unsupported_toml');target[key]=value;pending='';
 }
 if(pending)throw new LocalMcpError('unsupported_toml');return servers;
}
function normalized(raw: Record<string,any>, name: string): ServerInput {
 const allowed=['type','transport','command','args','env','url','headers','http_headers','enabled','startup_timeout_sec'];
 if(Object.keys(raw).some(k=>!allowed.includes(k)))throw new LocalMcpError('unsupported_configuration');
 const transport: McpTransport = raw.command ? 'stdio' : raw.type==='sse'||raw.transport==='sse' ? 'sse':'http';
 if((raw.headers&&raw.http_headers)||(raw.transport&&!['stdio','http','sse'].includes(raw.transport))||(raw.type==='stdio'&&!raw.command)||(raw.command&&((raw.type&&raw.type!=='stdio')||(raw.transport&&raw.transport!=='stdio')))||(raw.type&&!['stdio','http','sse','streamable-http'].includes(raw.type)))throw new LocalMcpError('unsupported_configuration');
 const startupTimeoutMs=raw.startup_timeout_sec===undefined?undefined:clampTimeout(typeof raw.startup_timeout_sec==='number'?raw.startup_timeout_sec*1000:NaN);
 const safeName=name.toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,24).replace(/-+$/,'');
 if(!safeName)throw new LocalMcpError('invalid_configuration');
 if(transport==='stdio') {
  if(raw.url||raw.headers||raw.http_headers)throw new LocalMcpError('unsupported_configuration');
  const launch=checkCommand(raw.command,raw.args), env=checkSecretMap(raw.env,'env');
  // Arguments are stored as launch metadata, never as credentials. Refuse likely inline secrets.
  const launchText=JSON.stringify(launch);
  if(Object.entries(env??{}).some(([key,v])=>v.length>3&&launchText.includes(v)&&!(key==='NODE_REPL_NODE_PATH'&&path.isAbsolute(v)&&/^node(?:\.exe)?$/i.test(path.basename(v))))||redactImportText(launchText).text!==launchText||/(?:token|password|secret|api[_-]?key|authorization)(?:[=\s"':]|$)/i.test(launchText))throw new LocalMcpError('inline_secret_requires_manual_setup');
  return {name:safeName,transport,...(startupTimeoutMs===undefined?{}:{startupTimeoutMs}),...launch,...(env?{env}: {})};
 }
 if(raw.command||raw.args||raw.env)throw new LocalMcpError('unsupported_configuration');
 const url=checkServerUrl(raw.url,true); if(url.search||url.hash)throw new LocalMcpError('url_credentials_require_manual_setup');
 const headers=checkSecretMap(raw.headers??raw.http_headers,'headers');
 return {name:safeName,transport,...(startupTimeoutMs===undefined?{}:{startupTimeoutMs}),url:url.toString(),allowRemote:!isLoopbackHost(url.hostname),...(headers?{headers}:{})};
}
function fingerprint(input: ServerInput) {
 return digest({startupTimeoutMs:input.startupTimeoutMs??30000,transport:input.transport,command:input.command??null,args:input.args??[],url:input.url??null,allowRemote:input.allowRemote===true,env:sorted(input.env as any),headers:sorted(input.headers as any)});
}
type Source={id:string;name:string;origin:string;file:string;key:string;project?:string;input?:ServerInput;issue?:string;hash?:string};
/** An MCP server entry found in a config file (DISCOVER-01); nothing is stored. */
export type FoundMcp=Omit<Source,'id'>;
/** Claude Desktop's config file on macOS, Windows and Linux. */
export function claudeDesktopConfig(home:string,platform:NodeJS.Platform=process.platform){
 if(platform==='darwin')return path.join(home,'Library','Application Support','Claude','claude_desktop_config.json');
 if(platform==='win32')return path.join(home,'AppData','Roaming','Claude','claude_desktop_config.json');
 return path.join(home,'.config','Claude','claude_desktop_config.json');
}
type Scan={id:string;owner:string;sources:Source[];skipped:number};
export class LocalMcpImport {
 private scans=new Map<string,Scan>(); private queue: Promise<unknown>=Promise.resolve();
 constructor(readonly home=os.homedir()){}
 private async read(file:string) {
  const home=await fs.realpath(this.home);const resolved=await fs.realpath(file);
  if(!resolved.startsWith(home+path.sep))throw new LocalMcpError('source_unavailable');
  // Reject symlinks in every component below the selected home.
  let current=home;for(const part of path.relative(home,resolved).split(path.sep)){current=path.join(current,part);if((await fs.lstat(current)).isSymbolicLink())throw new LocalMcpError('source_unavailable');}
  if(path.resolve(file)!==resolved && path.resolve(file)!==path.join(path.resolve(this.home),path.relative(home,resolved)))throw new LocalMcpError('source_unavailable');
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();if(!stat.isFile()||stat.size>1024*1024)throw new LocalMcpError('source_unavailable');const buffer=Buffer.alloc(1024*1024+1);let size=0;while(size<buffer.length){const read=await handle.read(buffer,size,buffer.length-size,null);if(!read.bytesRead)break;size+=read.bytesRead;}if(size>1024*1024)throw new LocalMcpError('source_unavailable');return buffer.subarray(0,size).toString('utf8');}finally{await handle.close();}
 }
 private async configurations(file:string):Promise<any> {const text=await this.read(file);return file.endsWith('.toml')?{mcpServers:parseMcpToml(text)}:JSON.parse(text);}
 async scan(owner:string) {
  const scan:Scan={id:randomUUID(),owner,sources:[],skipped:0};
  const found=await this.found();scan.skipped=found.skipped;scan.sources=found.servers.map(s=>({id:randomUUID(),...s}));
  while(this.scans.size>=8)this.scans.delete(this.scans.keys().next().value!);this.scans.set(scan.id,scan);
  return {id:scan.id,skipped:scan.skipped,sources:scan.sources.map(s=>({id:s.id,name:s.name,origin:s.origin,supported:!s.issue,issue:s.issue??null}))};
 }
 /** Every MCP server in the known config files, plus extra files such as a project's .mcp.json (DISCOVER-01). */
 async found(extra:{origin:string;file:string}[]=[]):Promise<{servers:FoundMcp[];skipped:number}>{
  const servers:FoundMcp[]=[];let skipped=0;
  const files=[{origin:'Claude',file:path.join(this.home,'.claude.json')},{origin:'Claude Desktop',file:claudeDesktopConfig(this.home)},{origin:'Codex',file:path.join(this.home,'.codex','config.toml')},...extra];
  for(const {origin,file} of files)try{
   const config=await this.configurations(file);
   const groups=[{project:undefined as string|undefined,servers:config.mcpServers}];
   if(object(config.projects))for(const [project,value]of Object.entries(config.projects).slice(0,100))if(object(value))groups.push({project,servers:value.mcpServers});
   for(const group of groups)if(object(group.servers))for(const [key,raw]of Object.entries(group.servers).slice(0,200)){
    if(servers.length>=500){skipped++;continue;}
    const source:FoundMcp={name:redactImportText(key).text.slice(0,100),origin,file,key,project:group.project};
    try{if(!object(raw))throw Error();source.input=normalized(raw,key);source.hash=fingerprint(source.input);}catch(e){source.issue=e instanceof LocalMcpError?e.code:'invalid_configuration';}
    servers.push(source);
   }
  }catch{skipped++;}
  return {servers,skipped};
 }
 /** The id of a Dpro MCP server with exactly this launch configuration, if any. */
 existing(input:ServerInput){return this.duplicate(input);}
 /** DISCOVER-01: add a found server, switched off; `keepSecrets` false leaves its env / header values out (the owner adds them later). */
 async importFound(owner:string,found:FoundMcp,hash:string,keepSecrets=true){
  const operation=this.queue.then(async()=>{
   if(found.issue)throw new LocalMcpError(found.issue);
   const input=await this.current({id:'',...found});if(hash!==found.hash||hash!==fingerprint(input))throw new LocalMcpError('preview_changed',409);
   const existingId=await this.duplicate(input);if(existingId)return {id:existingId,duplicate:true};
   const name=String(input.name);if((await listServerRows()).some(r=>r.name===name))throw new LocalMcpError('name_conflict',409);
   const {env:_e,headers:_h,...bare}=input;
   const server=await createServer(keepSecrets?input:bare,owner,{dormantImport:true});return {id:server.id,duplicate:false};
  });this.queue=operation.catch(()=>{});return operation;
 }
 private source(owner:string,scanId:string,sourceId:string){const scan=this.scans.get(scanId);if(!scan||scan.owner!==owner)throw new LocalMcpError('scan_not_found',404);const source=scan.sources.find(s=>s.id===sourceId);if(!source)throw new LocalMcpError('source_not_found',404);return source;}
 private async current(source:Source) {
  const config=await this.configurations(source.file),group=source.project?config.projects?.[source.project]:config;
  const raw=group?.mcpServers?.[source.key];if(!object(raw))throw new LocalMcpError('source_unavailable');return normalized(raw,source.key);
 }
 private async duplicate(input:ServerInput){
  for(const row of await listServerRows()){
   const secrets=await readSecrets(row);
   if(fingerprint({transport:row.transport,command:row.command??undefined,args:parseList(row.args),url:row.url??undefined,allowRemote:row.allow_remote===1,startupTimeoutMs:row.startup_timeout_ms??row.timeout_ms,...secrets})===fingerprint(input))return row.id;
  }return null;
 }
 async preview(owner:string,scanId:string,sourceId:string) {
  const source=this.source(owner,scanId,sourceId);if(source.issue)throw new LocalMcpError(source.issue);
  const input=await this.current(source);if(fingerprint(input)!==source.hash)throw new LocalMcpError('preview_changed',409);
  return {startupTimeoutMs:input.startupTimeoutMs??null,name:input.name,transport:input.transport,command:input.command??null,args:input.args??[],url:input.url??null,allowRemote:input.allowRemote===true,envNames:Object.keys(input.env??{}),headerNames:Object.keys(input.headers??{}),hash:source.hash,existingId:await this.duplicate(input)};
 }
 async import(owner:string,scanId:string,sourceId:string,hash:string) {
  const operation=this.queue.then(async()=>{
   const source=this.source(owner,scanId,sourceId);if(source.issue)throw new LocalMcpError(source.issue);
   const input=await this.current(source);if(hash!==source.hash||hash!==fingerprint(input))throw new LocalMcpError('preview_changed',409);
   const existingId=await this.duplicate(input);if(existingId)return {id:existingId,duplicate:true};
   const name=String(input.name);const rows=await listServerRows();if(rows.some(r=>r.name===name))throw new LocalMcpError('name_conflict',409);
   const server=await createServer(input,owner,{dormantImport:true});return {id:server.id,duplicate:false};
  });this.queue=operation.catch(()=>{});return operation;
 }
}
