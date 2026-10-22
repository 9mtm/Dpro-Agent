import {createHash} from 'node:crypto';
import {sql,one,run,lockName,dialect,type Step} from '../../repositories/sql-steps.js';
import {forUpdate} from '../../db/pg/dialect.js';
import type {Actor} from '../../repositories/actor.js';
import {parseReviewerDraft,ReviewerDraftError} from './reviewer-policy.js';
import {captureReviewerOwnerContext,consumeReviewerDraftReceiptStep} from './reviewer-policy-proof.js';
import {reviewerPolicyOperationHash,reviewerPolicyRevokeOperationHash,issueOperationChallenge,completeOperationChallenge,consumeOperationReceiptStep,type OperationContext,type ReviewerPolicyRevokeOperation} from './operation-proof.js';
const MAX=2147483647;
function reviewedHash(value:unknown):asserts value is string{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new ReviewerDraftError('invalid');}
function* generation():Step<number>{const d=yield* dialect(),row=yield* one<{version:number}>(`SELECT version FROM approval_proof_policy WHERE id=1${forUpdate(d)}`);if(!row||!Number.isSafeInteger(Number(row.version))||Number(row.version)<1||Number(row.version)>=MAX)throw new ReviewerDraftError('invalid');return Number(row.version);}
function* advanceGeneration(prior:number):Step<void>{if((yield* run('UPDATE approval_proof_policy SET version=version+1 WHERE id=1 AND version=?',prior)).changes!==1)throw new ReviewerDraftError('conflict');}
/** Internal producer only. The actual executor enforces every active matching policy. */
export async function activateReviewerPolicy(receipt:unknown,context:OperationContext,actor:Actor,id:string,draftRevision:number,expectedHash:string,now=Date.now()){
 reviewedHash(expectedHash);const trusted=captureReviewerOwnerContext(context,actor);
 return sql().tx(function*(){
  yield* lockName('human-reviewer-policy-runtime');
  if(!(yield* consumeReviewerDraftReceiptStep(receipt,trusted.context,trusted.actor,id,draftRevision,expectedHash,now)))throw new ReviewerDraftError('forbidden');
  const d=yield* dialect(),priorGeneration=yield* generation();
  const draft=yield* one<{revision:number;policy_json:string}>(`SELECT revision,policy_json FROM human_reviewer_drafts WHERE id=?${forUpdate(d)}`,id);
  if(!draft||Number(draft.revision)!==draftRevision)throw new ReviewerDraftError('conflict');
  const policy=parseReviewerDraft(JSON.parse(draft.policy_json),now),payload=JSON.stringify(policy);
  const existing=yield* one<{version:number;status:string}>(`SELECT version,status FROM human_reviewer_policies WHERE id=?${forUpdate(d)}`,id);
  const version=Number(existing?.version??0)+1;
  if(!Number.isSafeInteger(version)||version<1||version>MAX)throw new ReviewerDraftError('invalid');
  if(!existing||existing.status!=='active'){const count=yield* one<{n:number}>("SELECT COUNT(*) AS n FROM human_reviewer_policies WHERE status='active'");if(Number(count?.n??0)>=1000)throw new ReviewerDraftError('invalid');}
  const changed=existing?yield* run("UPDATE human_reviewer_policies SET version=?,status='active',policy_json=?,approved_by=?,approved_at=? WHERE id=? AND version=?",version,payload,trusted.context.userId,now,id,Number(existing.version)):yield* run("INSERT INTO human_reviewer_policies(id,version,status,policy_json,approved_by,approved_at) VALUES(?,?,'active',?,?,?)",id,version,payload,trusted.context.userId,now);
  if(changed.changes!==1)throw new ReviewerDraftError('conflict');
  const operation={kind:'reviewer_policy' as const,action:'activate' as const,policyId:id,draftRevision,paramsHash:expectedHash,policyVersion:priorGeneration};
  yield* run("INSERT INTO human_reviewer_policy_events(policy_id,version,action,policy_json,draft_revision,owner_id,owner_token_version,owner_factor_version,operation_hash,created_at) VALUES(?,?,'activate',?,?,?,?,?,?,?)",id,version,payload,draftRevision,trusted.context.userId,trusted.context.tokenVersion,trusted.context.factorVersion,reviewerPolicyOperationHash(operation),now);
  yield* advanceGeneration(priorGeneration);
  return Object.freeze({id,version,status:'active' as const});
 });
}
function* revokeTarget(context:OperationContext,actor:Actor,id:string,revision:number,expectedHash:string|undefined,now:number):Step<ReviewerPolicyRevokeOperation>{
 const trusted=captureReviewerOwnerContext(context,actor);context=trusted.context;
 reviewerPolicyRevokeOperationHash({kind:'reviewer_policy_revoke',policyId:id,policyRevision:revision,paramsHash:'0'.repeat(64),policyVersion:1});
 if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-300000)throw new ReviewerDraftError('invalid');
 yield* lockName('human-reviewer-policy-runtime');yield* lockName('verification-enrollment:'+context.userId);const d=yield* dialect();
 const owner=yield* one<{role:string;status:string;email_verified:number;token_version:number}>(`SELECT role,status,email_verified,token_version FROM users WHERE id=?${forUpdate(d)}`,context.userId);
 const factor=yield* one<{version:number;enabled:number}>(`SELECT version,enabled FROM verification_factors WHERE user_id=?${forUpdate(d)}`,context.userId);
 if(!owner||owner.role!=='owner'||owner.status!=='active'||Number(owner.email_verified)!==1||Number(owner.token_version)!==context.tokenVersion||!factor||Number(factor.enabled)!==1||Number(factor.version)!==context.factorVersion)throw new ReviewerDraftError('forbidden');
 const policyVersion=yield* generation();
 const row=yield* one<{version:number;status:string;policy_json:string;approved_by:string;approved_at:number}>(`SELECT version,status,policy_json,approved_by,approved_at FROM human_reviewer_policies WHERE id=?${forUpdate(d)}`,id);
 if(!row||row.status!=='active'||Number(row.version)!==revision||row.policy_json.length>1048576)throw new ReviewerDraftError('conflict');
 // Bind raw saved content so an expired/unavailable rule can still be explicitly withdrawn.
 const paramsHash=createHash('sha256').update(JSON.stringify(['reviewer-policy-revoke-target-v1',id,revision,row.policy_json,row.approved_by,Number(row.approved_at)])).digest('hex');
 if(expectedHash!==undefined&&paramsHash!==expectedHash)throw new ReviewerDraftError('conflict');
 return {kind:'reviewer_policy_revoke',policyId:id,policyRevision:revision,paramsHash,policyVersion};
}
export async function reviewerPolicyRevocationTarget(context:OperationContext,actor:Actor,id:string,revision:number,now=Date.now()){
 const trusted=captureReviewerOwnerContext(context,actor);return sql().tx(()=>revokeTarget(trusted.context,trusted.actor,id,revision,undefined,now));
}
export async function issueReviewerPolicyRevocation(context:OperationContext,actor:Actor,id:string,revision:number,expectedHash:string,now=Date.now()){
 reviewedHash(expectedHash);const trusted=captureReviewerOwnerContext(context,actor),operation=await sql().tx(()=>revokeTarget(trusted.context,trusted.actor,id,revision,expectedHash,now));return issueOperationChallenge(trusted.context,operation,now);
}
export async function completeReviewerPolicyRevocation(token:unknown,context:OperationContext,actor:Actor,id:string,revision:number,expectedHash:string,code:unknown,now=Date.now()){
 reviewedHash(expectedHash);const trusted=captureReviewerOwnerContext(context,actor),operation=await sql().tx(()=>revokeTarget(trusted.context,trusted.actor,id,revision,expectedHash,now));return completeOperationChallenge(token,trusted.context,operation,code,now);
}
/** Revocation consumes exact owner proof with versioned state/history/global invalidation atomically. */
export async function revokeReviewerPolicy(receipt:unknown,context:OperationContext,actor:Actor,id:string,revision:number,expectedHash:string,now=Date.now()){
 reviewedHash(expectedHash);const trusted=captureReviewerOwnerContext(context,actor);
 return sql().tx(function*(){
  yield* lockName('human-reviewer-policy-runtime');
  const operation=yield* revokeTarget(trusted.context,trusted.actor,id,revision,expectedHash,now);
  if(!(yield* consumeOperationReceiptStep(receipt,trusted.context,operation,now)))throw new ReviewerDraftError('forbidden');
  if(revision>=MAX)throw new ReviewerDraftError('invalid');
  const row=yield* one<{policy_json:string}>('SELECT policy_json FROM human_reviewer_policies WHERE id=?',id);
  if(!row||(yield* run("UPDATE human_reviewer_policies SET version=version+1,status='revoked',approved_by=?,approved_at=? WHERE id=? AND version=? AND status='active'",trusted.context.userId,now,id,revision)).changes!==1)throw new ReviewerDraftError('conflict');
  yield* run("INSERT INTO human_reviewer_policy_events(policy_id,version,action,policy_json,draft_revision,owner_id,owner_token_version,owner_factor_version,operation_hash,created_at) VALUES(?,?,'revoke',?,NULL,?,?,?,?,?)",id,revision+1,row.policy_json,trusted.context.userId,trusted.context.tokenVersion,trusted.context.factorVersion,reviewerPolicyRevokeOperationHash(operation),now);
  yield* advanceGeneration(operation.policyVersion);
  return Object.freeze({id,version:revision+1,status:'revoked' as const});
 });
}
