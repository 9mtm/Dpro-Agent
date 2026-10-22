/** Fixed repository and immutable commit only. Fetching content confers no install authority. */
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {isValidSkillSourcePath} from '../skills/skill-ids.js';
export class PinnedSkillSourceError extends Error{constructor(){super('Skill source unavailable');}}
const fail=()=>new PinnedSkillSourceError();
export class PinnedSkillSource{
 constructor(private readonly transport:typeof fetch=fetch,private readonly timeoutMs=10000){if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw fail();}
 async fetch(input:unknown,signal?:AbortSignal){
  if(!input||typeof input!=='object'||types.isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).length!==2||!['commit','sourcePath'].every(k=>Object.hasOwn(input,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(input,k)!,'value')))throw fail();
  const {commit,sourcePath}=input as Record<string,unknown>;
  if(typeof commit!=='string'||!/^[a-f0-9]{40}$/.test(commit)||/^0+$/.test(commit)||!isValidSkillSourcePath(sourcePath)||signal?.aborted)throw fail();
  const url='https://api.github.com/repos/anthropics/skills/contents/'+sourcePath.split('/').map(encodeURIComponent).join('/')+'/SKILL.md?ref='+commit;
  const controller=new AbortController(),abort=()=>controller.abort();
  const aborted=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(fail()),{once:true}));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(abort,this.timeoutMs);let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;let body:ReadableStream<Uint8Array>|null=null;
  try{
   const response=await Promise.race([this.transport(url,{redirect:'error',credentials:'omit',signal:controller.signal,headers:{Accept:'application/vnd.github.raw+json','X-GitHub-Api-Version':'2022-11-28'}}),aborted]);
   body=response.body;
   if(response.status!==200||response.redirected||(response.url&&response.url!==url)||!response.body)throw fail();
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>200000))throw fail();
   reader=response.body.getReader();const chunks:Uint8Array[]=[];let total=0;
   while(true){const part=await Promise.race([reader.read(),aborted]);if(part.done)break;total+=part.value.byteLength;if(total>200000)throw fail();chunks.push(part.value);}
   if(total===0||controller.signal.aborted)throw fail();
   const bytes=Buffer.concat(chunks,total),content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
   if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(content))throw fail();
   return Object.freeze({provider:'anthropic-skills' as const,commit,sourcePath,content,contentHash:createHash('sha256').update(bytes).digest('hex'),byteLength:total});
  }catch{throw fail();}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();if(reader){void reader.cancel().catch(()=>{});}else if(body){void body.cancel().catch(()=>{});}}
 }
}
