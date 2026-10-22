import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export type SourceAddon={name:string;source:'claude-code'|'codex';kind:'plugin'|'hook';enabled:boolean|null;installed:boolean|null;count:number;label?:string};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const name=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=180&&/^[\p{L}\p{N}_.@/+:-]+$/u.test(v);
/** Fixed local metadata files only; never return commands, paths, settings or secrets. */
export async function chatAddons(home=os.homedir()){
 const items:SourceAddon[]=[],sources:{source:'claude-code'|'codex';status:'read'|'missing'|'unavailable'|'limited'}[]=[];
 const read=async(relative:string):Promise<{text:string;status:'read'}|{text:null;status:'missing'|'unavailable'|'limited'}>=>{
  try{const root=await fs.realpath(home),file=path.join(root,relative),real=await fs.realpath(file);if(!real.startsWith(root+path.sep))return {text:null,status:'unavailable'};const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())return {text:null,status:'unavailable'};if(stat.size>512*1024)return {text:null,status:'limited'};const handle=await fs.open(real,'r');try{const bytes=Buffer.alloc(512*1024+1);const {bytesRead}=await handle.read(bytes,0,bytes.length,0);if(bytesRead>512*1024)return {text:null,status:'limited'};return {text:bytes.subarray(0,bytesRead).toString('utf8'),status:'read'};}finally{await handle.close();}}
  catch(error){return {text:null,status:(error as NodeJS.ErrnoException).code==='ENOENT'?'missing':'unavailable'};}
 };
 const claude=await read('.claude/settings.json'),installed=await read('.claude/plugins/installed_plugins.json');
 try{const config=claude.text?JSON.parse(claude.text):{},manifest=installed.text?JSON.parse(installed.text):{};
  const enabled=record(config)&&record(config.enabledPlugins)?config.enabledPlugins:{},plugins=record(manifest)&&record(manifest.plugins)?manifest.plugins:{};
  for(const key of [...new Set([...Object.keys(plugins),...Object.keys(enabled)])].slice(0,350))if(name(key))items.push({name:key,source:'claude-code',kind:'plugin',installed:Object.hasOwn(plugins,key)?true:null,enabled:typeof enabled[key]==='boolean'?enabled[key] as boolean:null,count:0});
  const hooks=record(config)&&record(config.hooks)?config.hooks:{};
  for(const [event,rows] of Object.entries(hooks).slice(0,50))if(name(event)&&Array.isArray(rows))items.push({name:event,source:'claude-code',kind:'hook',installed:null,enabled:null,count:Math.min(rows.length,1000)});
  sources.push({source:'claude-code',status:claude.status==='read'||installed.status==='read'?'read':claude.status});
 }catch{sources.push({source:'claude-code',status:'unavailable'});}
 const codex=await read('.codex/config.toml');sources.push({source:'codex',status:codex.status});
 if(codex.text){let current:SourceAddon|null=null;for(const line of codex.text.split(/\r?\n/)){
   const section=/^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
   if(section){current=null;const match=/^plugins\."([^"\\]+)"$/.exec(section[1]);if(match&&name(match[1])&&items.length<500){current={name:match[1],source:'codex',kind:'plugin',installed:null,enabled:null,count:0};items.push(current);}continue;}
   if(current){const enabled=/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/.exec(line);if(enabled)current.enabled=enabled[1]==='true';}
  }}
 try{const root=await fs.realpath(home),base=await fs.realpath(path.join(root,'.codex/plugins/cache'));if(base.startsWith(root+path.sep)){
  const providers=(await fs.readdir(base,{withFileTypes:true})).filter(x=>x.isDirectory()&&!x.isSymbolicLink()&&/^[A-Za-z0-9._-]+$/.test(x.name)&&!x.name.startsWith('.')).slice(0,20);
  for(const provider of providers){const dirs=(await fs.readdir(path.join(base,provider.name),{withFileTypes:true})).filter(x=>x.isDirectory()&&!x.isSymbolicLink()&&/^[A-Za-z0-9._-]+$/.test(x.name)&&!x.name.startsWith('.')).slice(0,250);for(const plugin of dirs){if(items.length>=500)break;const key=plugin.name+'@'+provider.name;if(!items.some(x=>x.source==='codex'&&x.name===key))items.push({name:key,source:'codex',kind:'plugin',installed:null,enabled:null,count:0});}}
 }}catch{/* An empty or unreadable local cache is reported through source metadata. */}
 for(const item of items.filter(x=>x.source==='codex'&&x.kind==='plugin').slice(0,500)){
  const pieces=item.name.split('@');if(pieces.length!==2||!pieces.every(x=>/^[A-Za-z0-9._-]+$/.test(x)))continue;
  const relative=path.join('.codex','plugins','cache',pieces[1],pieces[0]);
  try{const root=await fs.realpath(home),cache=await fs.realpath(path.join(root,relative));if(!cache.startsWith(root+path.sep))continue;const versions=(await fs.readdir(cache,{withFileTypes:true})).filter(x=>x.isDirectory()&&!x.isSymbolicLink()).map(x=>x.name).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).slice(0,2);
   for(const version of versions){let found=false;for(const dir of ['.codex-plugin','.claude-plugin']){const data=await read(path.join(relative,version,dir,'plugin.json'));if(!data.text)continue;try{const manifest=JSON.parse(data.text),ui=record(manifest)&&record(manifest.interface)?manifest.interface:{};const label=ui.displayName??(record(manifest)?manifest.name:null);if(typeof label==='string'&&label.length>0&&label.length<=100&&!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(label)){item.label=label;item.installed=true;found=true;break;}}catch{}}
    if(found)break;
   }
  }catch{/* Missing cache metadata does not imply a plugin is installed. */}
 }
 return {items:items.filter(x=>x.source!=='codex'||x.installed||x.enabled!==null).slice(0,500),sources};
}
