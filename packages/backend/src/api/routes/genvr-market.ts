/** Read-only public Genvr catalog; no local credential forwarding, purchases or publication. */
import type { FastifyInstance } from 'fastify';
import { actorOf } from '../../auth/auth-gate.js';
import { requireMember, ScopeError } from '../../repositories/scope.js';
const ORIGIN='https://api.genvr.net';
const itemId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)&&!value.includes('..');
const record=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
async function bytes(response:Response,max:number){
 if(!response.ok||!response.body)throw Error('unavailable');const length=Number(response.headers.get('content-length'));if(length>max)throw Error('too_large');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>max)throw Error('too_large');chunks.push(next.value);}}finally{await reader.cancel();}
 return Buffer.concat(chunks);
}
export async function genvrMarketRoutes(app:FastifyInstance,fetcher:typeof fetch=(input,init)=>globalThis.fetch(input,init)){
 const get=async(url:string,max:number)=>bytes(await fetcher(url,{method:'GET',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10000),headers:{accept:'application/json'}}),max);
 const json=async(url:string,max:number)=>JSON.parse((await get(url,max)).toString('utf8'));
 const error=(reply:any,e:unknown)=>reply.code(e instanceof ScopeError?e.status:503).send({code:e instanceof ScopeError?'forbidden':'market_unavailable'});
 app.get<{Querystring:{after?:string}}>('/api/genvr/market',{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(request,reply)=>{try{
  requireMember(actorOf(request));if(Object.keys(request.query).some(key=>key!=='after')||(request.query.after!==undefined&&!itemId(request.query.after)))return reply.code(400).send({code:'invalid_input'});
  const query=new URLSearchParams({source:'user',limit:'200',...(request.query.after?{after:request.query.after}:{})});const data=await json(`${ORIGIN}/v1/catalog/items?${query}`,8*1024*1024);
  if(!record(data)||!Array.isArray(data.items)||data.items.length>200||!(data.next===null||itemId(data.next)))throw Error();
  const items=data.items.map((row:any)=>{if(!record(row)||!record(row.manifest)||!itemId(row.manifest.id)||typeof row.manifest.name!=='string'||row.manifest.name.length>200||!record(row.manifest.price)||!['free','paid'].includes(row.manifest.price.type))throw Error();return {manifest:row.manifest,picture:null,caption:typeof row.caption==='string'?row.caption.slice(0,2000):null,tags:Array.isArray(row.tags)?row.tags.filter((tag:unknown)=>typeof tag==='string').slice(0,30).map((tag:string)=>tag.slice(0,100)):[]};});
  return {items,next:data.next};
 }catch(e){return error(reply,e);}});
 app.get<{Params:{id:string}}>('/api/genvr/market/items/:id',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(request,reply)=>{try{
  requireMember(actorOf(request));if(!itemId(request.params.id))return reply.code(400).send({code:'invalid_input'});
  const data=await json(`${ORIGIN}/v1/items/${encodeURIComponent(request.params.id)}/package`,1024*1024);
  if(!record(data)||data.id!==request.params.id||!record(data.manifest)||data.manifest.id!==data.id||data.manifest.type!=='model'||data.manifest.price?.type!=='free'||!Array.isArray(data.files)||!data.files.length||data.files.length>32)throw Error();
  const paths=new Set<string>();let total=0;const files=[];
  for(const file of data.files){
   if(!record(file)||typeof file.path!=='string'||file.path.length>255||file.path.split('/').some((part:string)=>!part||part==='.'||part==='..'||!/^[A-Za-z0-9._-]+$/.test(part))||paths.has(file.path)||typeof file.url!=='string')throw Error();paths.add(file.path);
   const url=new URL(file.url);if(url.origin!==ORIGIN||url.username||url.password||url.hash||!url.pathname.startsWith('/files/'))throw Error();
   if(!['model/gltf-binary','model/gltf+json','application/octet-stream','application/json','image/png','image/jpeg','image/webp'].includes(file.contentType))throw Error();
   const body=await get(url.href,8*1024*1024);total+=body.length;if(total>16*1024*1024)throw Error();
   files.push({path:file.path,contentType:file.contentType,data:body.toString('base64')});
  }
  return {asset:{id:data.id,manifest:data.manifest,files}};
 }catch(e){return error(reply,e);}});
}
