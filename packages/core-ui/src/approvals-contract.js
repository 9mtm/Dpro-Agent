export const APPROVALS_PATH='/api/approvals';
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v),uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),line=(v,n)=>typeof v==='string'&&v.length<=n,nullable=(v,n)=>v===null||line(v,n);
export function approvalRoute(path){return /^\/api\/approvals\/[a-f0-9-]{36}\?view=review$/i.test(path)||path==='/api/approvals?status=pending'||/^\/api\/approvals\?limit=100$/.test(path)||/^\/api\/approvals\?status=(pending|approved|denied|executed|failed|expired)&limit=100$/.test(path)||/^\/api\/approvals\/[a-f0-9-]{36}(\/(approve|deny|verification(?:\/complete)?))?$/i.test(path);}
const opaque=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
const exact=(body,fields)=>object(body)&&Object.keys(body).length===fields.length&&fields.every(field=>Object.hasOwn(body,field));
export function allowedApproval(method,path,body){
 if(!approvalRoute(path))return false;
 if(method==='GET')return body===undefined&&(path.includes('?')||/^\/api\/approvals\/[a-f0-9-]{36}$/i.test(path));
 if(method!=='POST')return false;
 if(path.endsWith('/deny'))return body===undefined||exact(body,[]);
 if(path.endsWith('/verification/complete'))return exact(body,['paramsHash','challenge','code'])&&hex(body.paramsHash)&&opaque(body.challenge)&&typeof body.code==='string'&&/^[0-9]{6}$/.test(body.code);
 if(path.endsWith('/verification'))return exact(body,['paramsHash'])&&hex(body.paramsHash);
 if(!path.endsWith('/approve')||!object(body)||!hex(body.paramsHash))return false;
 return exact(body,['paramsHash'])||(exact(body,['paramsHash','verificationReceipt'])&&opaque(body.verificationReceipt));
}

function json(value){let size=0,nodes=0;function visit(v,depth){if(++nodes>10000||depth>16)throw Error('protocol');if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;if(typeof v==='string'){size+=v.length;if(size>100000)throw Error('protocol');return v;}if(Array.isArray(v))return v.map(x=>visit(x,depth+1));if(object(v))return Object.fromEntries(Object.entries(v).map(([k,x])=>{size+=k.length;return [k,visit(x,depth+1)];}));throw Error('protocol');}return visit(value,0);}
const statuses=['pending','approved','denied','executed','failed','expired'];
function row(v){if(!object(v)||!uuid(v.id)||!statuses.includes(v.status)||!nullable(v.agentId,100)||!line(v.toolName,200)||!nullable(v.category,60)||typeof v.truncated!=='boolean'||!line(v.requestedAt,40)||!nullable(v.expiresAt,40)||!nullable(v.decidedAt,40)||!nullable(v.executedAt,40)||!nullable(v.resultPreview,1000)||!nullable(v.error,1000))throw Error('protocol');return {...(uuid(v.sessionId)?{sessionId:v.sessionId}:{}),id:v.id,status:v.status,agentId:v.agentId,toolName:v.toolName,category:v.category,paramsPreview:json(v.paramsPreview),truncated:v.truncated,requestedAt:v.requestedAt,expiresAt:v.expiresAt,decidedAt:v.decidedAt,executedAt:v.executedAt,resultPreview:v.resultPreview,error:v.error};}
export function approvalResponse(path,status,body){
 if(/\/verification(?:\/complete)?$/.test(path)){
  if(status!==200)return {code:status===429&&body?.code==='rate_limited'?'rate_limited':status===401?'unauthenticated':(status===403||status===409)&&body?.code==='verification_refused'?'verification_refused':'approval_unavailable'};
  const field=path.endsWith('/complete')?'receipt':'challenge',other=field==='receipt'?'challenge':'receipt';
  if(!object(body)||!opaque(body[field])||!Number.isSafeInteger(body.expiresAt)||body.expiresAt<0||['token','user','deviceToken',other].some(key=>Object.hasOwn(body,key)))throw Error('protocol');
  return {[field]:body[field],expiresAt:body.expiresAt};
 }
 if(status!==200)return {code:status===403&&['verification_required','reviewer_quorum_required','reviewer_denied','reviewer_policy_unavailable'].includes(body?.code)?body.code:status===403?'forbidden':status===404?'not_found':status===409?'approval_changed':'approval_unavailable'};if(!object(body))throw Error('protocol');if(path.startsWith(APPROVALS_PATH+'?')){if(!Array.isArray(body.approvals)||body.approvals.length>100)throw Error('protocol');const list=body.approvals.map(row);if(new Set(list.map(v=>v.id)).size!==list.length)throw Error('protocol');return {approvals:list};}const approval=row(body.approval);if(approval.id!==path.split('?')[0].split('/')[3])throw Error('protocol');if(path.endsWith('/approve')){if(!object(body.result)||typeof body.result.ok!=='boolean')throw Error('protocol');return {approval,result:{ok:body.result.ok}};}if(path.endsWith('/deny'))return {approval};if(!(body.approval.paramsHash===null||hex(body.approval.paramsHash))||!Array.isArray(body.approval.maskedFields)||body.approval.maskedFields.length>10000||!body.approval.maskedFields.every(f=>line(f,1000)))throw Error('protocol');if(body.approval.verificationRequired!==undefined&&typeof body.approval.verificationRequired!=='boolean')throw Error('protocol');return {approval:{...approval,...(body.approval.verificationRequired!==undefined?{verificationRequired:body.approval.verificationRequired}:{}),params:json(body.approval.params),paramsHash:body.approval.paramsHash,maskedFields:body.approval.maskedFields,runScope:json(body.approval.runScope)}};}
