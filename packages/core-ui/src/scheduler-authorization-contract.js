const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const opaque=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const time=value=>Number.isSafeInteger(value)&&value>0;
const revision=(value,min=1,max=2147483647)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const grantKeys=['kind','jobId','jobRevision','authorizationRevision','definitionHash','authorizationExpiresAt','policyVersion'];
const revokeKeys=['kind','jobId','authorizationRevision','paramsHash','policyVersion'];
function route(path){
 if(typeof path!=='string')return null;
 const match=path.match(/^\/api\/scheduler\/jobs\/([^/]+)\/authorization(?:\/(revoke))?(?:\/(preview|challenge|complete|apply))?$/);
 if(!match||!uuid(match[1])||path.endsWith('/'))return null;
 if(match[2]&&!match[3])return null;
 return {id:match[1],action:match[2]?'revoke':'authorize',phase:match[3]??'status'};
}
export const scheduleAuthorizationRoute=path=>typeof path==='string'&&/^\/api\/scheduler\/jobs\/[^/]+\/authorization(?:[/?]|$)/.test(path);
function validOperation(value,id,action){
 if(action==='revoke')return exact(value,revokeKeys)&&value.kind==='schedule_authorization_revoke'&&value.jobId===id&&revision(value.authorizationRevision,1,2147483646)&&hash(value.paramsHash)&&time(value.policyVersion);
 return exact(value,grantKeys)&&value.kind==='schedule_authorization'&&value.jobId===id&&revision(value.jobRevision)&&revision(value.authorizationRevision,0,2147483646)&&hash(value.definitionHash)&&time(value.authorizationExpiresAt)&&time(value.policyVersion);
}
export function allowedScheduleAuthorization(method,path,body){
 const r=route(path);if(!r)return false;
 if(r.phase==='status')return method==='GET'&&body===undefined;
 if(method!=='POST')return false;
 if(r.phase==='preview')return r.action==='revoke'?exact(body,[]):exact(body,['expiresAt'])&&time(body.expiresAt);
 const keys=r.phase==='challenge'?['operation']:r.phase==='complete'?['operation','challenge','code']:['operation','receipt'];
 return exact(body,keys)&&validOperation(body.operation,r.id,r.action)&&(r.phase!=='complete'||opaque(body.challenge)&&typeof body.code==='string'&&/^[0-9]{6}$/.test(body.code))&&(r.phase!=='apply'||opaque(body.receipt));
}
const fail=()=>{throw Error('protocol');};
function projectReview(value,operation){
 if(!exact(value,['definitionHash','name','description','cronExpression','timeZone','actionType','action','maskedFields'])||value.definitionHash!==operation.definitionHash||typeof value.name!=='string'||!value.name||value.name.length>200||!(value.description===null||typeof value.description==='string'&&value.description.length<=4000)||typeof value.cronExpression!=='string'||!value.cronExpression||value.cronExpression.length>200||typeof value.timeZone!=='string'||!value.timeZone||value.timeZone.length>100||!['api-call','send-message'].includes(value.actionType)||!record(value.action)||!Array.isArray(value.maskedFields)||value.maskedFields.length>4000||!value.maskedFields.every(field=>typeof field==='string'&&field.length>0&&field.length<=3000)||new Set(value.maskedFields).size!==value.maskedFields.length)return fail();
 const keys=value.actionType==='api-call'?['method','url','headers','body']:['channelId','to','content','options'];
 if(Object.keys(value.action).some(key=>!keys.includes(key)))return fail();
 if(value.actionType==='api-call'){
  if(!['GET','POST','PUT','DELETE','PATCH'].includes(value.action.method)||typeof value.action.url!=='string'||value.action.url.length>8192||value.action.headers!==undefined&&(!record(value.action.headers)||Object.keys(value.action.headers).length>50||!Object.values(value.action.headers).every(header=>exact(header,['hidden'])&&header.hidden===true)))return fail();
 }else if(typeof value.action.channelId!=='string'||typeof value.action.to!=='string'||typeof value.action.content!=='string')return fail();
 let nodes=0;
 function visit(item,depth){
  if(++nodes>6000||depth>16)return fail();
  if(item===null||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return item;
  if(typeof item==='string'){if(item.length>32768||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(item))return fail();return item;}
  if(Array.isArray(item)){if(item.length>4000)return fail();return item.map(child=>visit(child,depth+1));}
  if(!record(item))return fail();
  return Object.fromEntries(Object.entries(item).map(([key,child])=>{if(key.length>3000||['__proto__','prototype','constructor'].includes(key)||/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(key))return fail();return [key,visit(child,depth+1)];}));
 }
 const projected=visit(value,0);if(new TextEncoder().encode(JSON.stringify(projected)).length>65536)return fail();return projected;
}
/** Shared bounded masked display for revisioned editor readback. */
export const projectScheduledReview=(value,definitionHash)=>projectReview(value,{definitionHash});
/** Proof stays operation-scoped. It is never a login token or remembered session. */
export function scheduleAuthorizationResponse(path,status,body){
 const r=route(path);if(!r||!record(body))return fail();
 if(status!==200){const codes=new Set(['unauthenticated','forbidden','inactive_user','owner_verification_required','rate_limited','invalid_schedule_authorization','schedule_authorization_unavailable','verification_refused']);return {code:codes.has(body.code)?body.code:'schedule_authorization_unavailable'};}
 if(['token','user','deviceToken','secret','recoveryCodes'].some(key=>Object.hasOwn(body,key)))return fail();
 if(r.phase==='status'){
  if(body.jobId!==r.id||!['authorized','authorization_required','not_required'].includes(body.status))return fail();
  return {jobId:r.id,status:body.status};
 }
 if(r.phase==='preview'){
  if(!validOperation(body.operation,r.id,r.action))return fail();
  const keys=r.action==='revoke'?revokeKeys:grantKeys,operation=Object.fromEntries(keys.map(key=>[key,body.operation[key]]));return r.action==='revoke'?{operation}:{operation,review:projectReview(body.review,operation)};
 }
 if(r.phase==='challenge'||r.phase==='complete'){
  const key=r.phase==='challenge'?'challenge':'receipt',other=key==='receipt'?'challenge':'receipt';
  if(!opaque(body[key])||!time(body.expiresAt)||Object.hasOwn(body,other))return fail();return {[key]:body[key],expiresAt:body.expiresAt};
 }
 if(body.jobId!==r.id||!revision(body.authorizationRevision))return fail();
 if(r.action==='revoke'){if(body.status!=='revoked')return fail();return {jobId:r.id,authorizationRevision:body.authorizationRevision,status:'revoked'};}
 if(!revision(body.jobRevision)||!time(body.expiresAt))return fail();return {jobId:r.id,jobRevision:body.jobRevision,authorizationRevision:body.authorizationRevision,expiresAt:body.expiresAt};
}
