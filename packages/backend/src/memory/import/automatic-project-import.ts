/** Opt-in local project import schedule. Enabled schedules save their own redacted extracted facts automatically. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {dataPath} from '../../config/data-root.js';
import {q} from '../../repositories/sql-steps.js';
import {scanProjectDocuments} from './project-documents.js';
import {getJob,importedSessions,latestImportJob,startImport,type ExtractFn} from './local-import.js';
export type AutomaticImportSettings={enabled:boolean;intervalMinutes:15|30|60;nextRun:number;lastRun:number|null;status:'idle'|'scanning'|'importing'|'review'|'error';lastImported:number;lastProposed:number;notice:string};
type Saved=AutomaticImportSettings&{userId:string};
const folder=()=>dataPath('automatic-project-import');
const file=(user:string)=>path.join(folder(),createHash('sha256').update(user).digest('hex')+'.json');
const defaults=(userId:string):Saved=>({userId,enabled:false,intervalMinutes:60,nextRun:0,lastRun:null,status:'idle',lastImported:0,lastProposed:0,notice:'Automatic import is off. Manual imports wait for approval. Enabled automatic imports save new memories directly.'});
async function read(user:string):Promise<Saved>{try{return JSON.parse(await fs.readFile(file(user),'utf8'));}catch(e:any){if(e.code==='ENOENT')return defaults(user);throw e;}}
const writes=new Map<string,Promise<Saved>>();
async function patch(user:string,update:(s:Saved)=>Saved):Promise<Saved>{
 const previous=writes.get(user)??Promise.resolve(defaults(user));
 const next=previous.catch(()=>defaults(user)).then(async()=>{const value=update(await read(user));await fs.mkdir(folder(),{recursive:true,mode:0o700});const temp=file(user)+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});await fs.rename(temp,file(user));return value;});
 writes.set(user,next);try{return await next;}finally{if(writes.get(user)===next)writes.delete(user);}
}
const visible=({userId:_,...settings}:Saved):AutomaticImportSettings=>settings;
export async function automaticImportSettings(user:string){return visible(await read(user));}
export async function configureAutomaticImport(user:string,input:unknown,now=Date.now()){
 const b=input as Record<string,unknown>;
 if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['enabled','intervalMinutes'].includes(k))||typeof b.enabled!=='boolean'||![15,30,60].includes(b.intervalMinutes as number))throw Error('Invalid automatic import settings');
 return visible(await patch(user,s=>({...s,enabled:b.enabled as boolean,intervalMinutes:b.intervalMinutes as 15|30|60,nextRun:b.enabled?now:0,...(!b.enabled?{status:'idle' as const,notice:'Automatic import is off. Saved import jobs remain available.'}:{notice:'Automatic import is enabled: new redacted memories are saved without a review prompt.'})})));
}
let timer:ReturnType<typeof setInterval>|undefined,stopped=false;
const active=new Map<string,Promise<void>>();
type Options={now?:number;extract?:ExtractFn;home?:string;scan?:(user:string,cursor?:string)=>Promise<{documents:{id:string}[];nextCursor?:string|null}>;pollMs?:number};
async function run(user:string,opts:Options){
 const now=opts.now??Date.now();await patch(user,s=>({...s,lastRun:now,nextRun:now+s.intervalMinutes*60000,status:'scanning',lastImported:0,lastProposed:0,notice:'Searching for new or changed project files…'}));
 const allowed=async()=>!stopped&&(await read(user)).enabled;
 try{
  const previous=await latestImportJob(user);
  if(previous&&previous.done<previous.total){await patch(user,s=>({...s,status:'review',notice:'An existing import is running or needs attention. Review its saved progress first.'}));return;}
  const known=await importedSessions(user),ids=new Set<string>();let cursor:string|undefined;
  do{if(!await allowed())return;const page=opts.scan?await opts.scan(user,cursor):await scanProjectDocuments(user,{auto:true,purpose:'watch',...(cursor?{cursor}:{})});for(const doc of page.documents)if(!known.has(doc.id))ids.add(doc.id);cursor='nextCursor' in page?page.nextCursor??undefined:undefined;}while(cursor);
  const pending=[...ids];let count=0,proposed=0;
  for(let offset=0;offset<pending.length;offset+=400){
   if(!await allowed())return;
   await patch(user,s=>({...s,status:'importing',notice:`Importing new project files (${count}/${pending.length})…`}));
   let job=await startImport(user,pending.slice(offset,offset+400),{extract:opts.extract,home:opts.home,automatic:true});
   while(job.status==='running'){if(!await allowed())return;await new Promise<void>(r=>{setTimeout(r,opts.pollMs??1000);});job=(await getJob(user,job.id))!;}
   count+=job.done;proposed+=job.proposed;
   await patch(user,s=>({...s,lastImported:count,lastProposed:proposed}));
   if(job.status!=='done'){await patch(user,s=>({...s,status:'review',notice:'Import paused with saved progress. Check the local model or review waiting memories, then resume.'}));return;}
  }
  await patch(user,s=>({...s,status:'idle',lastImported:count,lastProposed:proposed,notice:proposed?`${proposed} new memories processed automatically. Open Memory to see saved items.`:'Search complete. No new information needs review.'}));
 }catch{await patch(user,s=>({...s,status:'error',notice:'Automatic import could not finish. Saved progress is retained; retry or check the current import.'}));}
}
/** Explicit tick is testable with a clock and local fixtures; importing this module starts no work. */
export async function runDueAutomaticImports(opts:Options={}){
 let files:string[];try{files=await fs.readdir(folder());}catch(e:any){if(e.code==='ENOENT')return;throw e;}
 const jobs:Promise<void>[]=[];
 for(const name of files){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const s=JSON.parse(await fs.readFile(path.join(folder(),name),'utf8')) as Saved;
  if(!s.enabled||(s.nextRun>(opts.now??Date.now())&&!['scanning','importing'].includes(s.status))||active.has(s.userId))continue;
  const promise=(async()=>{const owner=await q.one<{role:string;status:string}>('SELECT role,status FROM users WHERE id=?',s.userId);if(owner?.role==='owner'&&owner.status==='active')await run(s.userId,opts);})().finally(()=>active.delete(s.userId));active.set(s.userId,promise);jobs.push(promise);
 }
 await Promise.allSettled(jobs);
}
export function startAutomaticProjectImports(){if(timer)return;stopped=false;timer=setInterval(()=>{void runDueAutomaticImports().catch(()=>{});},15000);timer.unref();void runDueAutomaticImports().catch(()=>{});}
export async function stopAutomaticProjectImports(){stopped=true;clearInterval(timer);timer=undefined;await Promise.allSettled([...active.values()]);}
