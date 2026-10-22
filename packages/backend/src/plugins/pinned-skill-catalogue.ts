/** Fixed public repository metadata only; no document download, proof or installation. */
import {isValidSkillSourcePath} from '../skills/skill-ids.js';
import {isValidSkillArtifactTarget} from './skill-artifact.js';
export class PinnedSkillCatalogueError extends Error{constructor(){super('Skill catalogue unavailable');}}
const fail=()=>new PinnedSkillCatalogueError();
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v)&&!/^0+$/.test(v);
const repo='https://api.github.com/repos/anthropics/skills';
export class PinnedSkillCatalogue{
 constructor(private readonly transport:typeof fetch=fetch,private readonly timeoutMs=10000){if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw fail();}
 async list(signal?:AbortSignal){
  if(signal?.aborted)throw fail();const controller=new AbortController(),abort=()=>controller.abort();
  const aborted=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(fail()),{once:true}));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(abort,this.timeoutMs);
  const read=async(url:string,maximum:number)=>{
   let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,body:ReadableStream<Uint8Array>|null=null;
   try{
    const response=await Promise.race([this.transport(url,{redirect:'error',credentials:'omit',signal:controller.signal,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}}),aborted]);body=response.body;
    const length=response.headers.get('content-length');if(response.status!==200||response.redirected||(response.url&&response.url!==url)||!body||length!==null&&(!/^\d+$/.test(length)||Number(length)>maximum))throw fail();
    reader=body.getReader();let total=0;const chunks:Uint8Array[]=[];
    while(true){const part=await Promise.race([reader.read(),aborted]);if(part.done)break;total+=part.value.byteLength;if(total>maximum)throw fail();chunks.push(part.value);}
    if(!total||controller.signal.aborted)throw fail();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,total))) as unknown;
   }finally{if(reader)void reader.cancel().catch(()=>{});else if(body)void body.cancel().catch(()=>{});}
  };
  try{
   // Resolve the default branch ONCE. A contents-directory SHA must never substitute for this commit.
   const commits=await read(repo+'/commits?per_page=1',100000);
   if(!Array.isArray(commits)||commits.length!==1||!record(commits[0])||!sha(commits[0].sha)||!record(commits[0].commit)||!record(commits[0].commit.tree)||!sha(commits[0].commit.tree.sha))throw fail();
   const commit=commits[0].sha,treeSha=commits[0].commit.tree.sha;
   const listing=await read(repo+'/git/trees/'+treeSha+'?recursive=1',2000000);
   if(!record(listing)||listing.sha!==treeSha||listing.truncated!==false||!Array.isArray(listing.tree)||listing.tree.length>10000)throw fail();
   const skills:Readonly<{commit:string;sourcePath:string;targetName:string}>[]=[],names=new Set<string>(),paths=new Set<string>();
   for(const entry of listing.tree){
    if(!record(entry)||typeof entry.path!=='string'||entry.path.length>1000)throw fail();
    if(!entry.path.startsWith('skills/')||!entry.path.endsWith('/SKILL.md'))continue;
    // Links, executable modes and submodules are never catalogue guidance documents.
    if(entry.type!=='blob'||entry.mode!=='100644')continue;
    const sourcePath=entry.path.slice(0,-9),targetName=sourcePath.split('/').at(-1)!;
    if(!isValidSkillSourcePath(sourcePath)||!isValidSkillArtifactTarget(targetName)||!sha(entry.sha)||!Number.isSafeInteger(entry.size)||Number(entry.size)<1||Number(entry.size)>200000||names.has(targetName)||paths.has(sourcePath)||skills.length>=500)throw fail();
    names.add(targetName);paths.add(sourcePath);skills.push(Object.freeze({commit,sourcePath,targetName}));
   }
   if(controller.signal.aborted)throw fail();skills.sort((a,b)=>a.targetName.localeCompare(b.targetName));return Object.freeze({provider:'anthropic-skills' as const,commit,skills:Object.freeze(skills)});
  }catch{throw fail();}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
 }
}
