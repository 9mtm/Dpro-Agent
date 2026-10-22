import {captureScheduledDefinition,ScheduleDefinitionError} from './authorization-definition.js';
import {redactImportText} from '../memory/import/redact.js';
import {isSecretKey} from '../credentials/secret-mask.js';
import type {ScheduleAuthorizationOperation} from '../auth/verification/operation-proof.js';
const hidden=Object.freeze({hidden:true});
const unsafe=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/;
function fail():never{throw new ScheduleDefinitionError();}
/** Conservative display projection, not an arbitrary-secret detector or a request authorization. */
export function scheduledActionReview(input:unknown,operation:Pick<ScheduleAuthorizationOperation,'jobId'|'definitionHash'>){
 const captured=captureScheduledDefinition(input),definition=captured.definition;
 if(operation.definitionHash!==captured.definitionHash||operation.jobId!==definition.id)fail();
 const masked=new Set<string>();
 function text(value:string,path:string){
  if(unsafe.test(value))fail();
  let output=value.replace(/https?:\/\/[^\s<>"']+/gi,raw=>{
   try{
    const url=new URL(raw);let changed=false;
    if(url.username||url.password){url.username='';url.password='';changed=true;}
    if(url.hash){url.hash='';changed=true;}
    if(url.search){const query=new URLSearchParams();for(const key of url.searchParams.keys()){if(redactImportText(key).text!==key)fail();query.append(key,'[hidden]');}url.search=query.toString();changed=true;}
    const decoded=decodeURIComponent(url.pathname);if(redactImportText(decoded).text!==decoded){url.pathname='/[hidden]';changed=true;}
    if(changed)masked.add(path);return url.href;
   }catch(error){if(error instanceof ScheduleDefinitionError)throw error;masked.add(path);return '[hidden URL]';}
  });
  const clean=redactImportText(output).text;if(clean!==output)masked.add(path);return clean;
 }
 function visit(value:unknown,path:string,secret=false):unknown{
  if(secret){masked.add(path);return hidden;}
  if(typeof value==='string')return text(value,path);
  if(value===null||typeof value==='boolean'||typeof value==='number')return value;
  if(Array.isArray(value))return Object.freeze(value.map((item,index)=>visit(item,path+'['+index+']')));
  if(!value||typeof value!=='object')return fail();
  const result=Object.create(null) as Record<string,unknown>;
  for(const [key,item] of Object.entries(value)){
   if(unsafe.test(key)||redactImportText(key).text!==key)fail();
   const child=path+'.'+key;result[key]=visit(item,child,isSecretKey(key)||/^(authorization|proxy-authorization|cookie|set-cookie|client[_-]?secret|signature|sig)$/i.test(key));
  }
  return Object.freeze(result);
 }
 const actionData=definition.actionData as Record<string,unknown>,action=Object.create(null) as Record<string,unknown>;
 for(const [key,value] of Object.entries(actionData)){
  if(key==='headers'){
   const headers=Object.create(null) as Record<string,unknown>;
   for(const name of Object.keys(value as object)){if(redactImportText(name).text!==name)fail();headers[name]=hidden;masked.add('action.headers.'+name);}
   action.headers=Object.freeze(headers);
  }else action[key]=visit(value,'action.'+key);
 }
 const review=Object.freeze({definitionHash:captured.definitionHash,name:text(definition.name,'name'),description:definition.description===null?null:text(definition.description,'description'),cronExpression:definition.cronExpression,timeZone:definition.timeZone,actionType:definition.actionType,action:Object.freeze(action),maskedFields:Object.freeze([...masked].sort())});
 if(Buffer.byteLength(JSON.stringify(review),'utf8')>65536)fail();return review;
}
