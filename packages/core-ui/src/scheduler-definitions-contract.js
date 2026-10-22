import {projectScheduledReview} from './scheduler-authorization-contract.js';
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const revision=(value,min=0,max=2147483646)=>Number.isInteger(value)&&value>=min&&value<=max;
const unsafe=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/;
function route(path){const match=typeof path==='string'&&path.match(/^\/api\/scheduler\/definitions\/([^/]+)$/);return match&&uuid(match[1])?{id:match[1]}:null;}
export const scheduleDefinitionRoute=path=>typeof path==='string'&&/^\/api\/scheduler\/definitions(?:[/?]|$)/.test(path);
function rawJson(value){let nodes=0;function visit(item,depth){if(++nodes>4000||depth>12)return false;if(item===null||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return true;if(typeof item==='string')return item.length<=32768&&!unsafe.test(item)&&!/(?:\[REDACTED:[a-z_]+\]|\[hidden\]|%5bhidden%5d|[•]{4})/i.test(item);if(Array.isArray(item)){if(item.length>1000||Object.keys(item).length!==item.length)return false;return Array.from({length:item.length},(_,index)=>{const d=Object.getOwnPropertyDescriptor(item,String(index));return d&&Object.hasOwn(d,'value')&&visit(d.value,depth+1);}).every(Boolean);}if(!record(item)||exact(item,['hidden'])&&item.hidden===true)return false;return Object.keys(item).every(key=>{const descriptor=Object.getOwnPropertyDescriptor(item,key);return key.length<=200&&!['__proto__','prototype','constructor'].includes(key)&&!unsafe.test(key)&&descriptor&&Object.hasOwn(descriptor,'value')&&visit(descriptor.value,depth+1);});}if(!visit(value,0))return false;return new TextEncoder().encode(JSON.stringify(value)).length<=32768;}
function changes(value,creating){
 if(!record(value)||!rawJson(value)||!Object.keys(value).length||Object.keys(value).some(key=>!['name','description','cronExpression','actionType','actionData'].includes(key)))return false;
 if(creating&&['name','cronExpression','actionType','actionData'].some(key=>!Object.hasOwn(value,key)))return false;
 if(Object.hasOwn(value,'name')&&(typeof value.name!=='string'||!value.name||value.name.length>200||value.name.trim()!==value.name||/[\x00-\x1f\x7f]/.test(value.name)))return false;
 if(Object.hasOwn(value,'description')&&!(value.description===null||typeof value.description==='string'&&value.description.length<=2000))return false;
 if(Object.hasOwn(value,'cronExpression')&&(typeof value.cronExpression!=='string'||!value.cronExpression||value.cronExpression.length>200||value.cronExpression.trim()!==value.cronExpression||/[\x00-\x1f\x7f]/.test(value.cronExpression)))return false;
 if(Object.hasOwn(value,'actionType')&&!['api-call','send-message'].includes(value.actionType))return false;
 if(Object.hasOwn(value,'actionData')){
  const action=value.actionData;if(!record(action)||Object.keys(action).some(key=>!['method','url','headers','body','channelId','to','content','options'].includes(key)))return false;
  if(creating&&(value.actionType==='api-call'?['method','url']:['channelId','to','content']).some(key=>!Object.hasOwn(action,key)))return false;
  if(Object.hasOwn(action,'method')&&!['GET','POST','PUT','DELETE','PATCH'].includes(action.method))return false;
  if(Object.hasOwn(action,'url')){if(typeof action.url!=='string'||action.url.length>2048||!/^https?:\/\//.test(action.url)||/[\x00-\x20\x7f]/.test(action.url))return false;try{const url=new URL(action.url);if(!url.hostname||url.username||url.password||url.hash)return false;}catch{return false;}}
  if(Object.hasOwn(action,'headers')){if(!record(action.headers)||Object.keys(action.headers).length>50)return false;const denied=['host','content-length','transfer-encoding','connection','upgrade','proxy-connection'];if(!Object.entries(action.headers).every(([name,header])=>/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)&&!denied.includes(name.toLowerCase())&&typeof header==='string'&&header.length<=4096&&!/[\x00-\x1f\x7f]/.test(header)))return false;}
  if(Object.hasOwn(action,'channelId')&&(typeof action.channelId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,99}$/.test(action.channelId)))return false;
  if(Object.hasOwn(action,'to')&&(typeof action.to!=='string'||!action.to||action.to.length>500||action.to.trim()!==action.to||/[\x00-\x1f\x7f]/.test(action.to)))return false;
  if(Object.hasOwn(action,'content')&&(typeof action.content!=='string'||!action.content||action.content.length>20000))return false;
  if(Object.hasOwn(action,'options')&&!record(action.options))return false;
 }
 return true;
}
export function allowedScheduleDefinition(method,path,body){if(!route(path))return false;if(method==='GET')return body===undefined;return method==='PUT'&&exact(body,['expectedRevision','changes'])&&revision(body.expectedRevision)&&changes(body.changes,body.expectedRevision===0);}
const fail=()=>{throw Error('protocol');};
export function scheduleDefinitionResponse(path,status,body){
 const r=route(path);if(!r||!record(body))return fail();
 if(status!==200){const codes=['unauthenticated','forbidden','inactive_user','invalid_schedule_definition','schedule_definition_conflict','schedule_definition_unavailable','rate_limited'];return {code:codes.includes(body.code)?body.code:'schedule_definition_unavailable'};}
 if(['token','user','deviceToken','secret','recoveryCodes','actionData'].some(key=>Object.hasOwn(body,key))||body.jobId!==r.id||!revision(body.revision,1,2147483647)||typeof body.enabled!=='boolean')return fail();
 if(Object.hasOwn(body,'review')){if(Object.hasOwn(body,'definitionHash'))return fail();if(!record(body.review)||!hash(body.review.definitionHash))return fail();return {jobId:r.id,revision:body.revision,enabled:body.enabled,review:projectScheduledReview(body.review,body.review.definitionHash)};}
 if(body.enabled!==false||!hash(body.definitionHash))return fail();return {jobId:r.id,revision:body.revision,enabled:false,definitionHash:body.definitionHash};
}
