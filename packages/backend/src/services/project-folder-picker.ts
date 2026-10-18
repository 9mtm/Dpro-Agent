import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
/** Explicit owner-only directory browsing; never reads file contents or follows entries. */
export async function projectFolders(raw?: string, home=os.homedir()) {
 const root=await fs.realpath(home);
 if(raw!==undefined&&(typeof raw!=='string'||raw.length>4096||/[\x00-\x1f]/.test(raw)||!path.isAbsolute(raw)))throw Error('invalid_folder');
 const current=await fs.realpath(raw??root);
 if(current!==root&&!current.startsWith(root+path.sep))throw Error('invalid_folder');
 const dir=await fs.opendir(current);const entries:{name:string;path:string}[]=[];let scanned=0,truncated=false;
 for await(const entry of dir){if(++scanned>10000){truncated=true;break;}if(entry.name.startsWith('.')||!entry.isDirectory()||entry.isSymbolicLink())continue;entries.push({name:entry.name,path:path.join(current,entry.name)});}
 entries.sort((a,b)=>a.name.localeCompare(b.name));
 return {path:current,parent:current===root?null:path.dirname(current),selectable:current!==root,entries:entries.slice(0,500),truncated:truncated||entries.length>500};
}
