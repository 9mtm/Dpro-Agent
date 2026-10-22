const record=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const opaque=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
const integer=(v,min=1)=>Number.isSafeInteger(v)&&v>=min&&v<=2147483647;
const time=v=>Number.isSafeInteger(v)&&v>0;
const line=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const account=v=>line(v,200)&&v.trim()===v&&!['mock-user','1'].includes(v);
const resource=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const list=(v,max,valid)=>Array.isArray(v)&&v.length>0&&v.length<=max&&v.every(valid)&&new Set(v).size===v.length;
const refKeys=['policyId','policyRevision','approvalId','paramsHash','requestHash','policyHash','decision'];
function validReference(v){return record(v)&&uuid(v.policyId)&&integer(v.policyRevision)&&uuid(v.approvalId)&&hash(v.paramsHash)&&hash(v.requestHash)&&hash(v.policyHash)&&['approve','deny'].includes(v.decision);}
function policy(v){return exact(v,['name','scope','reviewerIds','requiredVotes','allowInitiatorVote','expiresAt'])&&line(v.name,100)&&v.name.trim()===v.name&&exact(v.scope,['agentIds','toolNames'])&&list(v.scope.agentIds,50,resource)&&list(v.scope.toolNames,50,resource)&&list(v.reviewerIds,20,account)&&integer(v.requiredVotes)&&v.requiredVotes<=10&&typeof v.allowInitiatorVote==='boolean'&&v.reviewerIds.length>=v.requiredVotes+(v.allowInitiatorVote?0:1)&&time(v.expiresAt);}
function route(path){
 if(typeof path!=='string'||!path.startsWith('/api/')||/[\\#]/.test(path))return null;
 const parts=path.split('?');if(parts.length>2||parts[0].includes('%'))return null;
 const p=parts[0],q=new URLSearchParams(parts[1]??''),keys=[...q.keys()];if(new Set(keys).size!==keys.length)return null;
 const cursor=valid=>keys.length===0||(keys.length===1&&keys[0]==='cursor'&&valid(q.get('cursor')));
 if(p==='/api/reviewer-policies')return cursor(uuid)?{kind:'inventory'}:null;
 if(p==='/api/reviewer-policies/eligible-humans')return cursor(account)?{kind:'humans'}:null;
 if(p==='/api/reviewer-requests/policies')return !keys.length?{kind:'assigned'}:null;
 let m=p.match(/^\/api\/reviewer-policies\/([^/]+)(?:\/(draft|activate|revoke)(?:\/(preview|challenge|complete|apply))?)?$/);
 if(m&&uuid(m[1])&&!keys.length){
  if(!m[2])return {kind:'state',id:m[1]};
  if(m[2]==='draft'&&!m[3])return {kind:'draft',id:m[1]};
  if(['activate','revoke'].includes(m[2])&&m[3])return {kind:'control',id:m[1],action:m[2],phase:m[3]};return null;
 }
 m=p.match(/^\/api\/reviewer-requests\/([^/]+)(?:\/([^/]+))?$/);
 if(m&&uuid(m[1])){
  if(!m[2])return cursor(uuid)?{kind:'queue',id:m[1]}:null;
  if(uuid(m[2])&&keys.length===4&&['revision','paramsHash','requestHash','policyHash'].every(k=>q.has(k))&&/^[1-9][0-9]{0,9}$/.test(q.get('revision'))&&integer(Number(q.get('revision')))&&['paramsHash','requestHash','policyHash'].every(k=>hash(q.get(k))))return {kind:'detail',id:m[1],approvalId:m[2],revision:Number(q.get('revision')),paramsHash:q.get('paramsHash'),requestHash:q.get('requestHash'),policyHash:q.get('policyHash')};
 }
 m=p.match(/^\/api\/reviewer-votes\/(challenge|complete|cast)$/);return m&&!keys.length?{kind:'vote',phase:m[1]}:null;
}
export const reviewerRoute=path=>typeof path==='string'&&/^\/api\/reviewer-(policies|requests|votes)(?:[/?]|$)/.test(path);
export const reviewerOwnerRoute=path=>typeof path==='string'&&/^\/api\/reviewer-policies(?:[/?]|$)/.test(path);
export function allowedReviewer(method,path,body){
 const r=route(path);if(!r)return false;
 if(['inventory','humans','assigned','state','queue','detail'].includes(r.kind))return method==='GET'&&body===undefined;
 if(r.kind==='draft')return method==='GET'&&body===undefined||method==='PUT'&&exact(body,['expectedRevision','policy'])&&integer(body.expectedRevision,0)&&body.expectedRevision<2147483647&&policy(body.policy);
 if(method!=='POST')return false;
 if(r.kind==='vote'){
  const fields=r.phase==='challenge'?refKeys:r.phase==='complete'?[...refKeys,'challenge','code']:[...refKeys,'receipt'];
  return exact(body,fields)&&validReference(body)&&(r.phase==='challenge'||r.phase==='complete'&&opaque(body.challenge)&&typeof body.code==='string'&&/^[0-9]{6}$/.test(body.code)||r.phase==='cast'&&opaque(body.receipt));
 }
 const fields=r.phase==='preview'?['revision']:r.phase==='challenge'?['revision','paramsHash']:r.phase==='complete'?['revision','paramsHash','challenge','code']:['revision','paramsHash','receipt'];
 return exact(body,fields)&&integer(body.revision)&&(r.phase==='preview'||hash(body.paramsHash))&&(r.phase!=='complete'||opaque(body.challenge)&&typeof body.code==='string'&&/^[0-9]{6}$/.test(body.code))&&(r.phase!=='apply'||opaque(body.receipt));
}
const fail=()=>{throw Error('protocol');};
function ownVote(v){if(v===null)return null;if(!record(v)||!['approve','deny'].includes(v.decision)||!integer(v.revision)||!['current','verification_required'].includes(v.status)||v.decision==='deny'&&v.status!=='current')return fail();return {decision:v.decision,revision:v.revision,status:v.status};}
function pickReference(v){if(!validReference(v))return fail();return Object.fromEntries(refKeys.map(k=>[k,v[k]]));}
function pickPolicy(v){if(!policy(v))return fail();return {name:v.name,scope:{agentIds:[...v.scope.agentIds],toolNames:[...v.scope.toolNames]},reviewerIds:[...v.reviewerIds],requiredVotes:v.requiredVotes,allowInitiatorVote:v.allowInitiatorVote,expiresAt:v.expiresAt};}
function json(value){let nodes=0,size=0;function visit(v,depth){if(++nodes>20000||depth>40)return fail();if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;if(typeof v==='string'){if((size+=v.length)>1048576)return fail();return v;}if(Array.isArray(v))return v.map(x=>visit(x,depth+1));if(record(v))return Object.fromEntries(Object.entries(v).map(([k,x])=>{if((size+=k.length)>1048576)return fail();return [k,visit(x,depth+1)];}));return fail();}return visit(value,0);}
function page(body,validCursor,project){if(!Array.isArray(body.items)||body.items.length>50||!(body.nextCursor===null||validCursor(body.nextCursor)))return fail();const items=body.items.map(project);if(new Set(items.map(v=>v.id??v.reference.approvalId)).size!==items.length)return fail();return {items,nextCursor:body.nextCursor};}
/** Explicit projections only; opaque proof never becomes authentication or a remembered session. */
export function reviewerResponse(path,status,body){
 const r=route(path);if(!r||!record(body))return fail();
 if(status!==200){const codes=new Set(['unauthenticated','forbidden','inactive_user','human_verification_required','owner_verification_required','review_unavailable','invalid_review_request','verification_refused','rate_limited','review_conflict','invalid_policy_request','policy_unavailable']);return {code:codes.has(body.code)?body.code:'review_unavailable'};}
 if(['token','user','deviceToken','recoveryCodes','secret'].some(k=>Object.hasOwn(body,k)))return fail();
 if((r.kind==='vote'||r.kind==='control')&&['challenge','complete'].includes(r.phase)){
  const key=r.phase==='challenge'?'challenge':'receipt',other=key==='receipt'?'challenge':'receipt';if(!opaque(body[key])||!time(body.expiresAt)||Object.hasOwn(body,other))return fail();return {[key]:body[key],expiresAt:body.expiresAt};
 }
 if(r.kind==='vote'){if(body.recorded!==true||!['approve','deny'].includes(body.decision)||!integer(body.revision)||typeof body.idempotent!=='boolean')return fail();return {recorded:true,decision:body.decision,revision:body.revision,idempotent:body.idempotent};}
 if(r.kind==='control'){
  if(body.id!==r.id)return fail();
  if(r.phase==='preview'){if(body.action!==r.action||!integer(body.revision)||!hash(body.paramsHash))return fail();return {id:body.id,revision:body.revision,paramsHash:body.paramsHash,action:body.action};}
  if(!integer(body.version)||body.status!==(r.action==='activate'?'active':'revoked'))return fail();return {id:body.id,version:body.version,status:body.status};
 }
 if(r.kind==='draft'){if(body.id!==r.id||!integer(body.revision)||body.status!=='draft'||!time(body.updatedAt))return fail();return {id:body.id,revision:body.revision,status:'draft',policy:pickPolicy(body.policy),updatedAt:body.updatedAt};}
 if(r.kind==='state'){if(body.id!==r.id||!integer(body.version)||!['active','revoked'].includes(body.status)||typeof body.unavailable!=='boolean'||body.unavailable!==(body.policy===null))return fail();return {id:body.id,version:body.version,status:body.status,policy:body.policy===null?null:pickPolicy(body.policy),unavailable:body.unavailable};}
 if(r.kind==='inventory')return page(body,uuid,v=>{if(!record(v)||!uuid(v.id)||!(v.draftRevision===null||integer(v.draftRevision))||!(v.version===null||integer(v.version))||!['active','revoked','draft'].includes(v.status)||(v.name!==undefined&&v.name!==null&&!line(v.name,100))||(v.draftPending!==undefined&&typeof v.draftPending!=='boolean'))return fail();return {id:v.id,...(v.name!==undefined?{name:v.name}:{}),...(v.draftPending!==undefined?{draftPending:v.draftPending}:{}),draftRevision:v.draftRevision,version:v.version,status:v.status};});
 if(r.kind==='humans')return page(body,account,v=>{if(!record(v)||!account(v.id)||!line(v.name,320)||!['owner','admin','user'].includes(v.role))return fail();return {id:v.id,name:v.name,role:v.role};});
 if(r.kind==='assigned'){
  if(!Array.isArray(body.policies)||body.policies.length>1000)return fail();const policies=body.policies.map(v=>{if(!record(v)||!uuid(v.id)||!integer(v.revision)||!line(v.name,100)||!integer(v.requiredVotes)||v.requiredVotes>10||!time(v.expiresAt))return fail();return {id:v.id,revision:v.revision,name:v.name,requiredVotes:v.requiredVotes,expiresAt:v.expiresAt};});if(new Set(policies.map(v=>v.id)).size!==policies.length)return fail();return {policies};
 }
 if(r.kind==='queue')return page(body,uuid,v=>{if(!record(v)||!resource(v.toolName)||!resource(v.agentId)||!line(v.requestedAt,40)||!Number.isFinite(Date.parse(v.requestedAt)))return fail();const reference=pickReference(v.reference);if(reference.policyId!==r.id)return fail();return {reference,toolName:v.toolName,agentId:v.agentId,requestedAt:v.requestedAt,...(v.ownVote!==undefined?{ownVote:ownVote(v.ownVote)}:{})};});
 if(r.kind==='detail'){
  const reference=pickReference(body.reference);if(reference.policyId!==r.id||reference.approvalId!==r.approvalId||reference.policyRevision!==r.revision||reference.paramsHash!==r.paramsHash||reference.requestHash!==r.requestHash||reference.policyHash!==r.policyHash||!Array.isArray(body.maskedFields)||body.maskedFields.length>10000||!body.maskedFields.every(v=>line(v,1000)))return fail();
  return {reference,params:json(body.params),maskedFields:[...body.maskedFields],runScope:json(body.runScope),...(body.ownVote!==undefined?{ownVote:ownVote(body.ownVote)}:{})};
 }
 return fail();
}
