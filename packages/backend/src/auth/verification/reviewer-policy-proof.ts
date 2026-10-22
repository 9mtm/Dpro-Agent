import {createHash} from 'node:crypto';
import type {Actor} from '../../repositories/actor.js';
import {sql,one,lockName,dialect,type Step} from '../../repositories/sql-steps.js';
import {forUpdate} from '../../db/pg/dialect.js';
import {isSystemAccount} from '../default-accounts.js';
import {parseReviewerDraft,ReviewerDraftError} from './reviewer-policy.js';
import {reviewerPolicyOperationHash,issueOperationChallenge,completeOperationChallenge,consumeOperationReceiptStep,type OperationContext,type ReviewerPolicyOperation} from './operation-proof.js';
export function captureReviewerOwnerContext(context:OperationContext,actor:Actor){
 if(!context||actor?.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==context.userId||typeof context.userId!=='string'||!context.userId||context.userId.length>200||isSystemAccount(context.userId)||typeof context.sessionHash!=='string'||!/^[a-f0-9]{64}$/.test(context.sessionHash)||!Number.isSafeInteger(context.tokenVersion)||context.tokenVersion<1||!Number.isSafeInteger(context.factorVersion)||context.factorVersion<1)throw new ReviewerDraftError('forbidden');
 return {context:Object.freeze({...context}),actor:Object.freeze({...actor})};
}
function reviewedHash(value:unknown):asserts value is string{
 if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new ReviewerDraftError('invalid');
}
function* target(context:OperationContext,actor:Actor,id:string,revision:number,expectedHash:string|undefined,now:number):Step<ReviewerPolicyOperation>{
 const trusted=captureReviewerOwnerContext(context,actor);context=trusted.context;
 reviewerPolicyOperationHash({kind:'reviewer_policy',action:'activate',policyId:id,draftRevision:revision,paramsHash:'0'.repeat(64),policyVersion:1});
 if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-300000||(expectedHash!==undefined&&!/^[a-f0-9]{64}$/.test(expectedHash)))throw new ReviewerDraftError('invalid');
 yield* lockName('human-reviewer-policy-runtime');yield* lockName('human-reviewer-drafts');const d=yield* dialect();
 const row=yield* one<{revision:number;status:string;policy_json:string;updated_at:number}>(`SELECT revision,status,policy_json,updated_at FROM human_reviewer_drafts WHERE id=?${forUpdate(d)}`,id);
 if(!row||row.status!=='draft'||Number(row.revision)!==revision||Number(row.updated_at)>now)throw new ReviewerDraftError('conflict');
 const policy=parseReviewerDraft(JSON.parse(row.policy_json),now),people=[...new Set([context.userId,...policy.reviewerIds])].sort();
 for(const person of people)yield* lockName('verification-enrollment:'+person);
 const versions:(string|number)[][]=[];
 for(const person of people){
  const user=yield* one<{role:string;status:string;email_verified:number;token_version:number}>(`SELECT role,status,email_verified,token_version FROM users WHERE id=?${forUpdate(d)}`,person);
  const factor=yield* one<{enabled:number;version:number}>(`SELECT enabled,version FROM verification_factors WHERE user_id=?${forUpdate(d)}`,person);
  if(!user||!['owner','admin','user'].includes(user.role)||user.status!=='active'||Number(user.email_verified)!==1||!Number.isSafeInteger(Number(user.token_version))||Number(user.token_version)<1||!factor||Number(factor.enabled)!==1||!Number.isSafeInteger(Number(factor.version))||Number(factor.version)<1)throw new ReviewerDraftError('ineligible');
  if(person===context.userId&&(user.role!=='owner'||Number(user.token_version)!==context.tokenVersion||Number(factor.version)!==context.factorVersion))throw new ReviewerDraftError('forbidden');
  versions.push([person,user.role,Number(user.token_version),Number(factor.version)]);
 }
 const generation=yield* one<{version:number}>(`SELECT version FROM approval_proof_policy WHERE id=1${forUpdate(d)}`);
 if(!generation||!Number.isSafeInteger(Number(generation.version))||Number(generation.version)<1)throw new ReviewerDraftError('invalid');
 const paramsHash=createHash('sha256').update(JSON.stringify(['reviewer-draft-target-v1',id,revision,policy,versions])).digest('hex');
 if(expectedHash!==undefined&&paramsHash!==expectedHash)throw new ReviewerDraftError('conflict');
 return {kind:'reviewer_policy',action:'activate',policyId:id,draftRevision:revision,paramsHash,policyVersion:Number(generation.version)};
}
/** Server preview of the precise candidate; does not activate the draft or assign reviewers. */
export async function reviewerDraftProofTarget(context:OperationContext,actor:Actor,id:string,revision:number,now=Date.now()){
 const trusted=captureReviewerOwnerContext(context,actor);return sql().tx(()=>target(trusted.context,trusted.actor,id,revision,undefined,now));
}
export async function issueReviewerDraftChallenge(context:OperationContext,actor:Actor,id:string,revision:number,expectedHash:string,now=Date.now()){
 reviewedHash(expectedHash);const trusted=captureReviewerOwnerContext(context,actor),operation=await sql().tx(()=>target(trusted.context,trusted.actor,id,revision,expectedHash,now));
 return issueOperationChallenge(trusted.context,operation,now);
}
/** Proves a candidate only. No active policy, reviewer authority or vote is created. */
export async function completeReviewerDraftChallenge(token:unknown,context:OperationContext,actor:Actor,id:string,revision:number,expectedHash:string,code:unknown,now=Date.now()){
 reviewedHash(expectedHash);const trusted=captureReviewerOwnerContext(context,actor),operation=await sql().tx(()=>target(trusted.context,trusted.actor,id,revision,expectedHash,now));
 return completeOperationChallenge(token,trusted.context,operation,code,now);
}
/** Future activation MUST compose this proof step and its state CAS in the same transaction. */
export function* consumeReviewerDraftReceiptStep(receipt:unknown,context:OperationContext,actor:Actor,id:string,revision:number,expectedHash:string,now=Date.now()):Step<boolean>{
 reviewedHash(expectedHash);const trusted=captureReviewerOwnerContext(context,actor),operation=yield* target(trusted.context,trusted.actor,id,revision,expectedHash,now);
 return yield* consumeOperationReceiptStep(receipt,trusted.context,operation,now);
}
