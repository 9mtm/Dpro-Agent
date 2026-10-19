/** Owner-selected project documentation. Originals stay read-only; the private catalog survives restart. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { dataPath } from '../../config/data-root.js';
import { redactImportText } from './redact.js';
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_FILES = 400, MAX_ENTRIES = 30000;
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
type Entry = { id: string; root: string; file: string; digest: string; relative: string; bytes: number; updatedAt: string };
export type ProjectDocument = Omit<Entry, 'file' | 'digest'>;
const skip = /^(?:node_modules|vendor|dist|build|coverage|target|venv|__pycache__|Library|Applications|Pictures|Movies|Music|Caches|Trash|_migration|backups|archives|external-sources|reference|references)$/i;
const secret = /(?:^|[._-])(?:secret|secrets|credential|credentials|password|passwords|token|tokens|private[-_]key)(?:[._-]|$)/i;
const named = /^(?:claude|agents|readme|handoff|backlog|tasks|project_memory|architecture|decisions|design_brief)(?:[._-].*)?\.(?:md|txt|rst)$/i;
function eligible(relative: string) { const parts=relative.split(path.sep); return !parts.some(x=>x.startsWith('.') || skip.test(x) || secret.test(x)) && /\.(md|txt|rst)$/i.test(relative) && (named.test(parts.at(-1)!) || parts.slice(0,-1).some(x=>/^(docs|documentation)$/i.test(x))); }
const catalogFile = (user: string) => dataPath('project-document-catalogs', hash(user)+'.json');
async function catalog(user: string): Promise<Record<string,Entry>> { try { return JSON.parse(await fs.readFile(catalogFile(user),'utf8')); } catch (e: any) { if(e.code==='ENOENT')return {};throw e; } }
async function save(user: string, entries: Record<string,Entry>) { const file=catalogFile(user);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(entries),{mode:0o600,flag:'wx'});await fs.rename(temp,file); }
async function read(entry: Entry) {
 const real=await fs.realpath(entry.file);if(real!==entry.file || !real.startsWith(entry.root+path.sep) || !eligible(path.relative(entry.root,real)))throw Error('Document unavailable');
 const fd=await fs.open(real,constants.O_RDONLY|constants.O_NOFOLLOW);
 try { const s=await fd.stat();if(!s.isFile() || s.size>MAX_DOCUMENT_BYTES)throw Error('Document is too large');const b=Buffer.alloc(MAX_DOCUMENT_BYTES+1);const {bytesRead}=await fd.read(b,0,b.length,0);if(bytesRead>MAX_DOCUMENT_BYTES)throw Error('Document is too large');const text=b.subarray(0,bytesRead).toString('utf8');if(text.includes('\0'))throw Error('Not a text document');return {text,stat:s}; } finally {await fd.close();}
}
async function scan(user: string, roots: unknown) {
 const automatic = !!roots && typeof roots === 'object' && !Array.isArray(roots) && (roots as {auto?:unknown}).auto === true;
 if(automatic)return scanComputerPage(user,(roots as {cursor?:unknown}).cursor,(roots as {purpose?:unknown}).purpose==='watch');
 if(!Array.isArray(roots)||!roots.length||roots.length>8||roots.some(r=>typeof r!=='string'||r.length>2048||!path.isAbsolute(r)))throw Error('Choose 1–8 project folders');
 const entries=await catalog(user), found: ProjectDocument[]=[];let visited=0,limited=false;const seen=new Set<string>();
 for(const input of roots) {
  const root=await fs.realpath(input);if(root===path.parse(root).root||(!automatic && root===os.homedir())||!(await fs.stat(root)).isDirectory())throw Error('Choose a project folder, not the whole computer or home folder');
  async function walk(dir: string, depth: number): Promise<void> {
   let items;try{items=await fs.readdir(dir,{withFileTypes:true});}catch{return;}
   const priority=(name:string)=>named.test(name)?0:/^(Documents|Desktop|Projects|Developer|Work|docs)$/i.test(name)?1:2;
   items.sort((a,b)=>priority(a.name)-priority(b.name)||a.name.localeCompare(b.name));
   for(const item of items) {
    if(++visited>MAX_ENTRIES||found.length>=MAX_FILES){limited=true;return;}
    if(item.isSymbolicLink()||item.name.startsWith('.')||skip.test(item.name)||secret.test(item.name))continue;
    const file=path.join(dir,item.name),relative=path.relative(root,file);
    if(item.isDirectory()){if(depth>0)await walk(file,depth-1);else limited=true;}
    else if(item.isFile()&&eligible(relative)) {
     try {const {text,stat}=await read({root,file} as Entry);const digest=hash(text),id=hash(user+'\0'+digest).slice(0,32);if(seen.has(id))continue;seen.add(id);
      const pieces=relative.split(path.sep),docIndex=pieces.reduce((last,p,i)=>/^(docs|documentation)$/i.test(p)?i:last,-1);
      const projectRoot=automatic?(docIndex>=0?path.join(root,...pieces.slice(0,docIndex)):path.dirname(file)):root;
      const entry={id,root:projectRoot,file,digest,relative:path.relative(projectRoot,file),bytes:stat.size,updatedAt:stat.mtime.toISOString()};entries[id]=entry;const {file:_,digest:__,...visible}=entry;found.push(visible);
     } catch { /* Unreadable, oversized and non-text documents are omitted. */ }
    }
   }
  }
  await walk(root,automatic?12:5);
 }
 await save(user,entries);return {documents:found,limited};
}
export async function readProjectDocument(user: string,id: string) {
 if(!/^[a-f0-9]{32}$/.test(id))return null;
 const entry=(await catalog(user))[id];if(!entry)return null;
 const {text}=await read(entry);if(hash(text)!==entry.digest)throw Error('Document changed. Scan the folder again before importing.');
 return {entry,text};
}
export async function previewProjectDocument(user: string,id: string) {
 const doc=await readProjectDocument(user,id);if(!doc)return null;
 const clean=redactImportText(doc.text).text;
 return {id,name:doc.entry.relative,text:clean.slice(0,20000),truncated:clean.length>20000};
}

const scans = new Map<string, Promise<unknown>>();
export async function scanProjectDocuments(user: string, roots: unknown) {
 const previous=scans.get(user)??Promise.resolve();
 const next=previous.catch(()=>{}).then(()=>scan(user,roots));scans.set(user,next);
 try{return await next;}finally{if(scans.get(user)===next)scans.delete(user);}
}

type ScanState={cursor:string;queue:{dir:string;depth:number;offset:number}[];scanned:number;seen:string[];limited:boolean};
async function scanComputerPage(user:string,cursor:unknown,watch=false) {
 const file=catalogFile(user)+(watch?'.watch.scan':'.scan'),home=await fs.realpath(os.homedir());
 let state:ScanState;
 if(cursor!==undefined){
  if(typeof cursor!=='string'||!/^[a-f0-9]{32}$/.test(cursor))throw Error('Invalid scan cursor');
  state=JSON.parse(await fs.readFile(file,'utf8'));if(state.cursor!==cursor)throw Error('Scan replaced');
 }else state={cursor:randomUUID().replace(/-/g,''),queue:[{dir:home,depth:32,offset:0}],scanned:0,seen:[],limited:false};
 const entries=await catalog(user),seen=new Set(state.seen),documents:ProjectDocument[]=[];let visited=0;
 while(state.queue.length&&visited<2000&&documents.length<100){
  const current=state.queue[0];let items;
  try{items=await fs.readdir(current.dir,{withFileTypes:true});}catch{state.queue.shift();continue;}
  const priority=(name:string)=>named.test(name)?0:/^(Documents|Desktop|Projects|Developer|Work|docs)$/i.test(name)?1:2;
  items.sort((a,b)=>priority(a.name)-priority(b.name)||a.name.localeCompare(b.name));
  while(current.offset<items.length&&visited<2000&&documents.length<100){
   const item=items[current.offset++];visited++;state.scanned++;
   if(item.isSymbolicLink()||item.name.startsWith('.')||skip.test(item.name)||secret.test(item.name))continue;
   const candidate=path.join(current.dir,item.name),relative=path.relative(home,candidate);
   if(item.isDirectory()){if(current.depth)state.queue.push({dir:candidate,depth:current.depth-1,offset:0});else state.limited=true;continue;}
   if(!item.isFile()||!eligible(relative))continue;
   try{
    const {text,stat}=await read({root:home,file:candidate} as Entry),digest=hash(text),id=hash(user+'\0'+digest).slice(0,32);if(seen.has(id))continue;seen.add(id);
    const pieces=relative.split(path.sep),docIndex=pieces.reduce((last,p,i)=>/^(docs|documentation)$/i.test(p)?i:last,-1);
    const root=docIndex>=0?path.join(home,...pieces.slice(0,docIndex)):path.dirname(candidate);
    const entry={id,root,file:candidate,digest,relative:path.relative(root,candidate),bytes:stat.size,updatedAt:stat.mtime.toISOString()};entries[id]=entry;
    const {file:_,digest:__,...visible}=entry;documents.push(visible);
   }catch{/* Not a readable project document. */}
  }
  if(current.offset>=items.length)state.queue.shift();
 }
 state.seen=[...seen];await save(user,entries);
 await fs.writeFile(file+'.tmp',JSON.stringify(state),{mode:0o600});await fs.rename(file+'.tmp',file);
 return {documents,limited:state.limited,scanned:state.scanned,nextCursor:state.queue.length?state.cursor:null};
}
