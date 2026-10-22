import {createHash} from 'node:crypto';
import type {Actor} from '../../repositories/actor.js';
import {sql,one,run,lockName,dialect,type Step} from '../../repositories/sql-steps.js';
import {forUpdate} from '../../db/pg/dialect.js';
import {isSystemAccount} from '../default-accounts.js';
import {parseReviewerDraft} from './reviewer-policy.js';
import {quorumRequestHash,quorumPolicyHash,quorumRequestExpiry,type QuorumApprovalRow} from './reviewer-quorum.js';
import {reviewerVoteOperationHash,issueOperationChallenge,completeOperationChallenge,consumeOperationReceiptStep,type OperationContext,type ReviewerVoteOperation} from './operation-proof.js';
export class ReviewerVoteError extends Error{constructor(readonly code:'invalid'|'forbidden'|'changed'|'unavailable'|'proof_refused'|'conflict'){super('Reviewer vote '+code);}}
export type ReviewerVoteReference=Omit<ReviewerVoteOperation,'kind'|'policyVersion'>;
type BaseReference=Omit<ReviewerVoteReference,'requestHash'|'policyHash'>;
function capture(context:OperationContext,actor:Actor){
 if(!context||actor?.kind!=='user'||!['owner','admin','user'].includes(actor.role)||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==context.userId||typeof context.userId!=='string'||!context.userId||context.userId.length>200||isSystemAccount(context.userId)||typeof context.sessionHash!=='string'||!/^[a-f0-9]{64}$/.test(context.sessionHash)||!Number.isSafeInteger(context.tokenVersion)||context.tokenVersion<1||!Number.isSafeInteger(context.factorVersion)||context.factorVersion<1)throw new ReviewerVoteError('forbidden');
 return {context:Object.freeze({...context}),actor:Object.freeze({...actor})};
}
function reference(input:ReviewerVoteReference):Readonly<ReviewerVoteReference>{
 if(!input||Object.keys(input).sort().join(',')!=='approvalId,decision,paramsHash,policyHash,policyId,policyRevision,requestHash')throw new ReviewerVoteError('invalid');
 try{reviewerVoteOperationHash({kind:'reviewer_vote',...input,policyVersion:1});}catch{throw new ReviewerVoteError('invalid');}
 return Object.freeze({...input});
}
function* target(context:OperationContext,actor:Actor,base:BaseReference,expected:ReviewerVoteReference|undefined,now:number):Step<{operation:ReviewerVoteOperation;expiresAt:number}>{
 context=capture(context,actor).context;
 try{reviewerVoteOperationHash({kind:'reviewer_vote',...base,requestHash:'0'.repeat(64),policyHash:'0'.repeat(64),policyVersion:1});}catch{throw new ReviewerVoteError('invalid');}
 if(!Number.isSafeInteger(now)||now<=0||now>Number.MAX_SAFE_INTEGER-300000)throw new ReviewerVoteError('invalid');
 yield* lockName('human-reviewer-policy-runtime');const d=yield* dialect();
 const row=yield* one<{version:number;status:string;policy_json:string;approved_at:number}>(`SELECT version,status,policy_json,approved_at FROM human_reviewer_policies WHERE id=?${forUpdate(d)}`,base.policyId);
 if(!row||row.status!=='active')throw new ReviewerVoteError('unavailable');
 if(Number(row.version)!==base.policyRevision||!Number.isSafeInteger(Number(row.approved_at))||Number(row.approved_at)>now)throw new ReviewerVoteError('changed');
 let policy;try{policy=parseReviewerDraft(JSON.parse(row.policy_json),Number(row.approved_at));}catch{throw new ReviewerVoteError('unavailable');}
 if(policy.expiresAt<=now)throw new ReviewerVoteError('unavailable');
 if(!policy.reviewerIds.includes(context.userId))throw new ReviewerVoteError('forbidden');
 yield* lockName('verification-enrollment:'+context.userId);
 const user=yield* one<{role:string;status:string;email_verified:number;token_version:number}>(`SELECT role,status,email_verified,token_version FROM users WHERE id=?${forUpdate(d)}`,context.userId);
 const factor=yield* one<{version:number;enabled:number}>(`SELECT version,enabled FROM verification_factors WHERE user_id=?${forUpdate(d)}`,context.userId);
 if(!user||!['owner','admin','user'].includes(user.role)||user.status!=='active'||Number(user.email_verified)!==1||Number(user.token_version)!==context.tokenVersion||!factor||Number(factor.enabled)!==1||Number(factor.version)!==context.factorVersion)throw new ReviewerVoteError('forbidden');
 const generation=yield* one<{version:number}>(`SELECT version FROM approval_proof_policy WHERE id=1${forUpdate(d)}`);
 if(!generation||!Number.isSafeInteger(Number(generation.version))||Number(generation.version)<1)throw new ReviewerVoteError('unavailable');
 const request=yield* one<QuorumApprovalRow>(`SELECT id,status,params_hash,tool_name,agent_id,user_id,session_id,category,origin,delegated_from,run_scope,requested_at FROM tool_approvals WHERE id=?${forUpdate(d)}`,base.approvalId);
 if(!request||request.status!=='pending'||request.params_hash!==base.paramsHash)throw new ReviewerVoteError('changed');
 if(request.agent_id===null||!policy.scope.agentIds.includes(request.agent_id)||!policy.scope.toolNames.includes(request.tool_name)||(!policy.allowInitiatorVote&&request.user_id===context.userId))throw new ReviewerVoteError('forbidden');
 const expiresAt=Math.min(quorumRequestExpiry(request),policy.expiresAt);
 if(expiresAt<=now||quorumRequestExpiry(request)-86400000>now)throw new ReviewerVoteError('unavailable');
 const operation:ReviewerVoteOperation={kind:'reviewer_vote',...base,requestHash:quorumRequestHash(request),policyHash:quorumPolicyHash(policy),policyVersion:Number(generation.version)};
 if(expected&&(expected.requestHash!==operation.requestHash||expected.policyHash!==operation.policyHash))throw new ReviewerVoteError('changed');
 return {operation,expiresAt};
}
/** Authorized server preview only; does not prove or record a decision. */
export async function reviewerVoteTarget(context:OperationContext,actor:Actor,policyId:string,policyRevision:number,approvalId:string,paramsHash:string,decision:'approve'|'deny',now=Date.now()){
 const trusted=capture(context,actor),base={policyId,policyRevision,approvalId,paramsHash,decision};return (await sql().tx(()=>target(trusted.context,trusted.actor,base,undefined,now))).operation;
}
function baseOf(ref:ReviewerVoteReference):BaseReference{return {policyId:ref.policyId,policyRevision:ref.policyRevision,approvalId:ref.approvalId,paramsHash:ref.paramsHash,decision:ref.decision};}
export async function issueReviewerVoteChallenge(context:OperationContext,actor:Actor,input:ReviewerVoteReference,now=Date.now()){
 const trusted=capture(context,actor),ref=reference(input),bound=await sql().tx(()=>target(trusted.context,trusted.actor,baseOf(ref),ref,now));return issueOperationChallenge(trusted.context,bound.operation,now);
}
/** OTP completion produces proof only; no vote, approval, tool or session is created. */
export async function completeReviewerVoteChallenge(token:unknown,context:OperationContext,actor:Actor,input:ReviewerVoteReference,code:unknown,now=Date.now()){
 const trusted=capture(context,actor),ref=reference(input),bound=await sql().tx(()=>target(trusted.context,trusted.actor,baseOf(ref),ref,now));return completeOperationChallenge(token,trusted.context,bound.operation,code,now);
}
type SavedVote={decision:string;request_hash:string;policy_hash:string;token_version:number;factor_version:number;expires_at:number;receipt_hash:string|null;proof_session_hash:string|null;revision:number};
/** Read only this assigned human's slot; never exposes proof/session fingerprints or changes a vote. */
export async function readReviewerVote(context:OperationContext,actor:Actor,input:ReviewerVoteReference,now=Date.now()){
 const trusted=capture(context,actor),ref=reference(input);
 return sql().tx(function*(){
  const bound=yield* target(trusted.context,trusted.actor,baseOf(ref),ref,now);
  const saved=yield* one<SavedVote&{actor_kind:string;created_at:number}>('SELECT actor_kind,decision,request_hash,policy_hash,token_version,factor_version,created_at,expires_at,receipt_hash,proof_session_hash,revision FROM human_reviewer_votes WHERE policy_id=? AND policy_version=? AND approval_id=? AND user_id=?',ref.policyId,ref.policyRevision,ref.approvalId,trusted.context.userId);
  if(!saved||saved.actor_kind!=='user'||saved.request_hash!==ref.requestHash||saved.policy_hash!==ref.policyHash||!['approve','deny'].includes(saved.decision)||!Number.isSafeInteger(Number(saved.revision))||Number(saved.revision)<1||Number(saved.revision)>2147483647)return null;
  // The executor keeps a matching human veto terminal after account/factor changes.
  const current=saved.decision==='deny'||Number(saved.token_version)===trusted.context.tokenVersion&&Number(saved.factor_version)===trusted.context.factorVersion&&typeof saved.receipt_hash==='string'&&/^[a-f0-9]{64}$/.test(saved.receipt_hash)&&typeof saved.proof_session_hash==='string'&&/^[a-f0-9]{64}$/.test(saved.proof_session_hash)&&Number.isSafeInteger(Number(saved.created_at))&&Number(saved.created_at)>0&&Number(saved.created_at)<=now&&Number.isSafeInteger(Number(saved.expires_at))&&Number(saved.expires_at)>now&&Number(saved.expires_at)<=bound.expiresAt;
  return Object.freeze({decision:saved.decision as 'approve'|'deny',revision:Number(saved.revision),status:current?'current' as const:'verification_required' as const});
 });
}
/** Internal authenticated human vote writer. Recording never executes the pending tool. */
export async function castReviewerVote(receipt:unknown,context:OperationContext,actor:Actor,input:ReviewerVoteReference,now=Date.now()){
 const trusted=capture(context,actor),ref=reference(input);
 if(typeof receipt!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(receipt))throw new ReviewerVoteError('proof_refused');
 const receiptHash=createHash('sha256').update(receipt).digest('hex');
 return sql().tx(function*(){
  const bound=yield* target(trusted.context,trusted.actor,baseOf(ref),ref,now),d=yield* dialect(),key=[ref.policyId,ref.policyRevision,ref.approvalId,trusted.context.userId] as const;
  const saved=yield* one<SavedVote>(`SELECT decision,request_hash,policy_hash,token_version,factor_version,expires_at,receipt_hash,proof_session_hash,revision FROM human_reviewer_votes WHERE policy_id=? AND policy_version=? AND approval_id=? AND user_id=?${forUpdate(d)}`,...key);
  if(saved&&(saved.decision!==ref.decision||saved.request_hash!==ref.requestHash||saved.policy_hash!==ref.policyHash))throw new ReviewerVoteError('conflict');
  if(saved&&saved.receipt_hash===receiptHash&&saved.proof_session_hash===trusted.context.sessionHash&&Number(saved.token_version)===trusted.context.tokenVersion&&Number(saved.factor_version)===trusted.context.factorVersion&&(ref.decision==='deny'||Number(saved.expires_at)>now))return Object.freeze({recorded:true,decision:ref.decision,revision:Number(saved.revision),idempotent:true});
  if(!(yield* consumeOperationReceiptStep(receipt,trusted.context,bound.operation,now)))throw new ReviewerVoteError('proof_refused');
  const revision=Number(saved?.revision??0)+1;
  if(!Number.isSafeInteger(revision)||revision<1||revision>2147483647)throw new ReviewerVoteError('unavailable');
  const changed=saved?yield* run("UPDATE human_reviewer_votes SET actor_kind='user',token_version=?,factor_version=?,created_at=?,expires_at=?,receipt_hash=?,proof_session_hash=?,revision=? WHERE policy_id=? AND policy_version=? AND approval_id=? AND user_id=? AND revision=?",trusted.context.tokenVersion,trusted.context.factorVersion,now,bound.expiresAt,receiptHash,trusted.context.sessionHash,revision,...key,Number(saved.revision)):yield* run("INSERT INTO human_reviewer_votes(policy_id,policy_version,approval_id,user_id,actor_kind,decision,request_hash,policy_hash,token_version,factor_version,created_at,expires_at,receipt_hash,proof_session_hash,revision) VALUES(?,?,?,?,'user',?,?,?,?,?,?,?,?,?,?)",...key,ref.decision,ref.requestHash,ref.policyHash,trusted.context.tokenVersion,trusted.context.factorVersion,now,bound.expiresAt,receiptHash,trusted.context.sessionHash,revision);
  if(changed.changes!==1)throw new ReviewerVoteError('conflict');
  yield* run('INSERT INTO human_reviewer_vote_events(policy_id,policy_version,approval_id,user_id,revision,decision,request_hash,policy_hash,token_version,factor_version,receipt_hash,proof_session_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',...key,revision,ref.decision,ref.requestHash,ref.policyHash,trusted.context.tokenVersion,trusted.context.factorVersion,receiptHash,trusted.context.sessionHash,now,bound.expiresAt);
  return Object.freeze({recorded:true,decision:ref.decision,revision,idempotent:false});
 });
}
