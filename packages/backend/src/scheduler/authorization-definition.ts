import {createHash} from 'node:crypto';
import cron from 'node-cron';
export class ScheduleDefinitionError extends Error{constructor(){super('Invalid scheduled action definition');}}
function fail():never{throw new ScheduleDefinitionError();}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
function snapshot(value:unknown,depth:number,budget:{nodes:number}):unknown{
 if(depth>12||++budget.nodes>4000)fail();
 if(value===null||typeof value==='boolean')return value;
 if(typeof value==='string'){if(value.length>32768)fail();return value;}
 if(typeof value==='number'){if(!Number.isFinite(value))fail();return value;}
 if(Array.isArray(value)){if(value.length>1000||Object.keys(value).length!==value.length)fail();return Object.freeze(Array.from({length:value.length},(_,index)=>{const d=Object.getOwnPropertyDescriptor(value,String(index));if(!d||!Object.hasOwn(d,'value'))fail();return snapshot(d.value,depth+1,budget);}));}
 if(!object(value))return fail();
 const out=Object.create(null) as Record<string,unknown>;
 for(const key of Object.keys(value).sort()){
  if(key.length>200||['__proto__','prototype','constructor'].includes(key))fail();
  const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))fail();
  out[key]=snapshot(descriptor.value,depth+1,budget);
 }
 return Object.freeze(out);
}
/** Copy caller JSON before any asynchronous lock or database operation. */
export function captureScheduledJson(input:unknown){
 const value=snapshot(input,0,{nodes:0});if(Buffer.byteLength(JSON.stringify(value),'utf8')>32768)fail();return value;
}
/** Exact typed paper action, captured before JSON copying can discard hidden fields. */
export function capturePaperRuntimeAction(value:unknown){
 if(!object(value))fail();const keys=Reflect.ownKeys(value),d=Object.getOwnPropertyDescriptor(value,'consentId');
 if(keys.length!==1||keys[0]!=='consentId'||!d||!Object.hasOwn(d,'value')||typeof d.value!=='string'||d.value.length!==36||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(d.value))fail();
 return Object.freeze({consentId:d.value as string});
}
function actionShape(type:string,value:unknown):void{
 if(!object(value))fail();
 if(type==='paper-runtime-cycle'){capturePaperRuntimeAction(value);return;}
 const keys=type==='api-call'?['method','url','headers','body']:['channelId','to','content','options'];
 if(Object.keys(value).some(k=>!keys.includes(k)))fail();
 if(type==='api-call'){
  if(!['GET','POST','PUT','DELETE','PATCH'].includes(value.method as string)||typeof value.url!=='string'||value.url.length>2048||!/^https?:\/\//.test(value.url)||/[\x00-\x20\x7f]/.test(value.url))fail();
  let url:URL;try{url=new URL(value.url);}catch{return fail();}
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.hash)fail();
  if(value.method==='GET'&&Object.hasOwn(value,'body'))fail();
  if(value.headers!==undefined){
   if(!object(value.headers)||Object.keys(value.headers).length>50)fail();
   const denied=new Set(['host','content-length','transfer-encoding','connection','upgrade','proxy-connection']);
   for(const [key,header] of Object.entries(value.headers))if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)||denied.has(key.toLowerCase())||typeof header!=='string'||header.length>4096||/[\x00-\x1f\x7f]/.test(header))fail();
  }
 }else{
  if(typeof value.channelId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,99}$/.test(value.channelId)||typeof value.to!=='string'||value.to.length<1||value.to.length>500||value.to.trim()!==value.to||/[\x00-\x1f\x7f]/.test(value.to)||typeof value.content!=='string'||value.content.length<1||value.content.length>20000||value.options!==undefined&&!object(value.options))fail();
 }
}
const fields=new Set(['id','name','description','cronExpression','actionType','actionData','enabled','lastRun','nextRun','createdAt','updatedAt']);
/** Captures authority-relevant data only; it neither authorizes nor executes a job. */
export function captureScheduledDefinition(input:unknown,timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone){
 if(!object(input)||Object.keys(input).some(k=>!fields.has(k)))fail();
 for(const key of Object.keys(input)){const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,'value'))fail();}
 if(typeof input.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.id)||typeof input.name!=='string'||input.name.trim()!==input.name||input.name.length<1||input.name.length>200||/[\x00-\x1f\x7f]/.test(input.name)||input.description!==undefined&&input.description!==null&&(typeof input.description!=='string'||input.description.length>2000)||typeof input.cronExpression!=='string'||input.cronExpression.trim()!==input.cronExpression||input.cronExpression.length>200||!cron.validate(input.cronExpression)||!['api-call','send-message','paper-runtime-cycle'].includes(input.actionType as string)||!object(input.actionData)||typeof timeZone!=='string'||timeZone.length>100)fail();
 try{new Intl.DateTimeFormat('en',{timeZone}).format(0);}catch{return fail();}
 if(input.actionType==='paper-runtime-cycle')capturePaperRuntimeAction(input.actionData);
 const actionData=snapshot(input.actionData,0,{nodes:0});actionShape(input.actionType as string,actionData);
 const definition=Object.freeze({id:input.id,name:input.name,description:input.description??null,cronExpression:input.cronExpression,timeZone,actionType:input.actionType as 'api-call'|'send-message'|'paper-runtime-cycle',actionData});
 const serialized=JSON.stringify(definition);if(Buffer.byteLength(serialized,'utf8')>32768)fail();
 return Object.freeze({definition,definitionHash:createHash('sha256').update('scheduled-action-definition-v1\0'+serialized).digest('hex')});
}
