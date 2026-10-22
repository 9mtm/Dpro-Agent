import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chatAddons} from './chat-addons.js';
const record=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const valid=(x:string)=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/.test(x);
const text=(x:unknown,max:number)=>typeof x==='string'?x.slice(0,max).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,''):'';
/** Local marketplace snapshots only. Never downloads packages or returns executable source fields. */
export async function addonCatalogue(home=os.homedir()){
 const items:{id:string;name:string;description:string;publisher:string;source:'claude-code'|'codex';present:boolean}[]=[],sources:{source:string;name:string;status:string}[]=[];
 let root:string;try{root=await fs.realpath(home);}catch{return {items,sources};}
 const inventory=await chatAddons(home);
 const scan=async(relative:string,source:'claude-code'|'codex',tail:string)=>{
  try{const base=await fs.realpath(path.join(root,relative));if(!base.startsWith(root+path.sep))return;
   const providers=(await fs.readdir(base,{withFileTypes:true})).filter(x=>x.isDirectory()&&!x.isSymbolicLink()&&valid(x.name)).slice(0,30);
   for(const provider of providers){if(items.length>=800)break;try{
    const file=path.join(base,provider.name,tail),stat=await fs.lstat(file),real=await fs.realpath(file);if(!stat.isFile()||stat.isSymbolicLink()||!real.startsWith(root+path.sep))continue;
    if(stat.size>1024*1024){sources.push({source,name:provider.name,status:'limited'});continue;}
    const h=await fs.open(real,'r');let data:unknown;try{const bytes=Buffer.alloc(1024*1024+1),result=await h.read(bytes,0,bytes.length,0);if(result.bytesRead>1024*1024)continue;data=JSON.parse(bytes.subarray(0,result.bytesRead).toString('utf8'));}finally{await h.close();}
    if(!record(data)||!Array.isArray(data.plugins))continue;
    const publisher=typeof data.name==='string'&&valid(data.name)?data.name:provider.name;
    sources.push({source,name:publisher,status:'local_snapshot'});
    for(const row of data.plugins.slice(0,800)){if(items.length>=800)break;if(!record(row)||typeof row.name!=='string'||!valid(row.name))continue;const id=row.name+'@'+publisher;if(items.some(x=>x.source===source&&x.id===id))continue;const local=inventory.items.find(x=>x.source===source&&x.name===id);items.push({id,name:text(row.name,150),description:text(row.description,1000),publisher,source,present:local?.installed===true});}
   }catch{/* One unreadable provider does not hide other catalogue snapshots. */}}
  }catch{/* No local catalogue for this source. */}
 };
 await scan('.claude/plugins/marketplaces','claude-code','.claude-plugin/marketplace.json');
 await scan('.codex/plugins/cache','codex','.agents/plugins/marketplace.json');
 return {items,sources};
}
