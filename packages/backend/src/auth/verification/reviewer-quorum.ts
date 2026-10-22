import {createHash} from 'node:crypto';
import {sql,one,all,lockName,dialect,type Step} from '../../repositories/sql-steps.js';
import {forUpdate} from '../../db/pg/dialect.js';
import {parseReviewerDraft,type ReviewerDraftInput} from './reviewer-policy.js';
import {isSystemAccount} from '../default-accounts.js';
export class ReviewerQuorumError extends Error{
 constructor(readonly code:'reviewer_quorum_required'|'reviewer_denied'|'reviewer_policy_unavailable'){super(code);}
}
export type QuorumApprovalRow={id:string;status:string;params_hash:string|null;tool_name:string;agent_id:string|null;user_id:string|null;session_id:string|null;category:string|null;origin:string|null;delegated_from:string|null;run_scope:string|null;requested_at:string};
const fields='id,status,params_hash,tool_name,agent_id,user_id,session_id,category,origin,delegated_from,run_scope,requested_at';
/** Shared exact request identity for future verified-vote producers and the execution sink. */
export function quorumRequestHash(row:QuorumApprovalRow):string{
 if(!row||typeof row.id!=='string'||!row.id||typeof row.params_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.params_hash))throw new ReviewerQuorumError('reviewer_policy_unavailable');
 const payload=JSON.stringify(['human-quorum-request-v1',row.id,row.params_hash,row.tool_name,row.agent_id,row.user_id,row.session_id,row.category,row.origin,row.delegated_from,row.run_scope,row.requested_at]);
 if(payload.length>1048576)throw new ReviewerQuorumError('reviewer_policy_unavailable');
 return createHash('sha256').update(payload).digest('hex');
}
export function quorumPolicyHash(policy:ReviewerDraftInput):string{return createHash('sha256').update(JSON.stringify(['human-quorum-policy-v1',policy])).digest('hex');}
type PolicyRow={id:string;version:number;policy_json:string;approved_at:number};
type Vote={receipt_hash:string|null;proof_session_hash:string|null;user_id:string;actor_kind:string;decision:string;request_hash:string;policy_hash:string;token_version:number;factor_version:number;created_at:number;expires_at:number};
type Person={role:string;status:string;email_verified:number;token_version:number;enabled:number|null;factor_version:number|null};
const unavailable=()=>new ReviewerQuorumError('reviewer_policy_unavailable');
export function quorumRequestExpiry(row:QuorumApprovalRow){const raw=row.requested_at,time=Date.parse(raw.endsWith('Z')?raw:raw.replace(' ','T')+'Z');if(!Number.isFinite(time))throw unavailable();return time+86400000;}
/** Caller composes this with the existing proof/approval CAS in one transaction. */
export function* requireReviewerQuorumStep(ownerId:string,approvalId:string,paramsHash:string,now=Date.now()):Step<void>{
 if(typeof ownerId!=='string'||!ownerId||!Number.isSafeInteger(now)||now<0)throw unavailable();
 // All future activation/revocation/vote writes must take this lock FIRST.
 yield* lockName('human-reviewer-policy-runtime');const d=yield* dialect();
 const policies=yield* all<PolicyRow>(`SELECT id,version,policy_json,approved_at FROM human_reviewer_policies WHERE status='active' ORDER BY id${forUpdate(d)}`);
 if(policies.length===0)return;
 if(policies.length>1000)throw unavailable();
 // Read without row lock first; owner locks must precede the approval lock, as in tool proof.
 const preview=yield* one<QuorumApprovalRow>('SELECT '+fields+' FROM tool_approvals WHERE id=?',approvalId);
 if(!preview||preview.status!=='pending'||preview.params_hash!==paramsHash)throw unavailable();
 const required:{row:PolicyRow;policy:ReviewerDraftInput}[]=[];
 for(const row of policies){
  let policy:ReviewerDraftInput;
  try{if(!Number.isSafeInteger(Number(row.version))||Number(row.version)<1||!Number.isSafeInteger(Number(row.approved_at))||Number(row.approved_at)>now)throw unavailable();policy=parseReviewerDraft(JSON.parse(row.policy_json),Number(row.approved_at));}catch{throw unavailable();}
  if(preview.agent_id!==null&&policy.scope.agentIds.includes(preview.agent_id)&&policy.scope.toolNames.includes(preview.tool_name))required.push({row,policy});
 }
 if(required.length===0)return;
 const ids=[...new Set([ownerId,...required.flatMap(p=>p.policy.reviewerIds)])].sort();
 for(const id of ids)yield* lockName('verification-enrollment:'+id);
 const people=new Map<string,Person>();
 for(const id of ids){
  const person=yield* one<Omit<Person,'enabled'|'factor_version'>>(`SELECT role,status,email_verified,token_version FROM users WHERE id=?${forUpdate(d)}`,id);
  const factor=yield* one<{enabled:number;version:number}>(`SELECT enabled,version FROM verification_factors WHERE user_id=?${forUpdate(d)}`,id);
  if(person)people.set(id,{...person,enabled:factor?.enabled??null,factor_version:factor?.version??null});
 }
 // Match boundApproval's lock order, including when another owner requests proof for this row.
 const generation=yield* one<{version:number}>(`SELECT version FROM approval_proof_policy WHERE id=1${forUpdate(d)}`);
 if(!generation||!Number.isSafeInteger(Number(generation.version))||Number(generation.version)<1)throw unavailable();
 const current=yield* one<QuorumApprovalRow>(`SELECT ${fields} FROM tool_approvals WHERE id=?${forUpdate(d)}`,approvalId);
 if(!current||current.status!=='pending'||current.params_hash!==paramsHash||quorumRequestHash(current)!==quorumRequestHash(preview))throw unavailable();
 const expires=quorumRequestExpiry(current);if(expires<=now||expires-86400000>now)throw unavailable();
 const requestHash=quorumRequestHash(current);
 for(const {row,policy} of required){
  // Expiry never silently disables a required rule.
  if(policy.expiresAt<=now)throw unavailable();
  const policyHash=quorumPolicyHash(policy);
  const votes=yield* all<Vote>('SELECT receipt_hash,proof_session_hash,user_id,actor_kind,decision,request_hash,policy_hash,token_version,factor_version,created_at,expires_at FROM human_reviewer_votes WHERE policy_id=? AND policy_version=? AND approval_id=?',row.id,Number(row.version),approvalId);
  const accepted=new Set<string>();
  for(const vote of votes){
   if(vote.request_hash!==requestHash||vote.policy_hash!==policyHash||vote.actor_kind!=='user'||!policy.reviewerIds.includes(vote.user_id)||(!policy.allowInitiatorVote&&vote.user_id===current.user_id)||isSystemAccount(vote.user_id))continue;
   // A matching human veto is terminal for this policy/request version, even after account revocation.
   if(vote.decision==='deny')throw new ReviewerQuorumError('reviewer_denied');
   const person=people.get(vote.user_id);
   if(vote.decision!=='approve'||!person||typeof vote.receipt_hash!=='string'||!/^[a-f0-9]{64}$/.test(vote.receipt_hash)||typeof vote.proof_session_hash!=='string'||!/^[a-f0-9]{64}$/.test(vote.proof_session_hash)||![person.token_version,person.factor_version,vote.token_version,vote.factor_version,vote.created_at,vote.expires_at].every(value=>Number.isSafeInteger(Number(value))&&Number(value)>0)||!['owner','admin','user'].includes(person.role)||person.status!=='active'||Number(person.email_verified)!==1||Number(person.enabled)!==1||Number(person.token_version)!==Number(vote.token_version)||Number(person.factor_version)!==Number(vote.factor_version)||Number(vote.created_at)>now||Number(vote.expires_at)<=now||Number(vote.expires_at)>Math.min(expires,policy.expiresAt))continue;
   accepted.add(vote.user_id);
  }
  if(accepted.size<policy.requiredVotes)throw new ReviewerQuorumError('reviewer_quorum_required');
 }
}
/** Test/review visibility only; no policy or vote mutation is exposed here. */
export async function checkReviewerQuorum(ownerId:string,approvalId:string,paramsHash:string,now=Date.now()){
 await sql().tx(()=>requireReviewerQuorumStep(ownerId,approvalId,paramsHash,now));
}

/** Linearized tool admission; active human rules cannot be lifted by a category's allow mode. */
export async function requiresReviewerApproval(agentId:string|undefined,toolName:string,now=Date.now()):Promise<boolean>{
 if(!agentId)return false;
 if(typeof agentId!=='string'||typeof toolName!=='string'||!Number.isSafeInteger(now)||now<0)throw unavailable();
 return sql().tx(function*(){
  yield* lockName('human-reviewer-policy-runtime');
  const rows=yield* all<PolicyRow>("SELECT id,version,policy_json,approved_at FROM human_reviewer_policies WHERE status='active' ORDER BY id LIMIT 1001");
  if(rows.length>1000)throw unavailable();
  let required=false;
  for(const row of rows){
   let policy:ReviewerDraftInput;
   try{if(!Number.isSafeInteger(Number(row.version))||Number(row.version)<1||!Number.isSafeInteger(Number(row.approved_at))||Number(row.approved_at)>now)throw unavailable();policy=parseReviewerDraft(JSON.parse(row.policy_json),Number(row.approved_at));}catch{throw unavailable();}
   // Expired matching rules still require explicit withdrawal; they never silently allow execution.
   if(policy.scope.agentIds.includes(agentId)&&policy.scope.toolNames.includes(toolName))required=true;
  }
  return required;
 });
}
