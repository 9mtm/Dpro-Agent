import {createHash,randomBytes} from 'node:crypto';
import {sql,one,run,lockName,dialect,type Step} from '../../repositories/sql-steps.js';
import {forUpdate} from '../../db/pg/dialect.js';
import {issueChallenge,type VerificationBinding} from './challenges.js';
import {factorChallengeStep} from './enrollment.js';
export type OperationContext={userId:string;sessionHash:string;tokenVersion:number;factorVersion:number};
export type ApprovalOperation={kind:'tool_approval';approvalId:string;paramsHash:string;policyVersion:number;targetHash?:string};
export type ReviewerPolicyOperation={kind:'reviewer_policy';action:'activate';policyId:string;draftRevision:number;paramsHash:string;policyVersion:number};
export type ReviewerPolicyRevokeOperation={kind:'reviewer_policy_revoke';policyId:string;policyRevision:number;paramsHash:string;policyVersion:number};
export type ReviewerVoteOperation={kind:'reviewer_vote';policyId:string;policyRevision:number;approvalId:string;paramsHash:string;requestHash:string;policyHash:string;decision:'approve'|'deny';policyVersion:number};
export type ScheduleAuthorizationOperation={kind:'schedule_authorization';jobId:string;jobRevision:number;authorizationRevision:number;definitionHash:string;authorizationExpiresAt:number;policyVersion:number};
export type ScheduleRevocationOperation={kind:'schedule_authorization_revoke';jobId:string;authorizationRevision:number;paramsHash:string;policyVersion:number};
export type SkillInstallOperation={kind:'skill_install';reviewId:string;reviewHash:string;reviewExpiresAt:number;policyVersion:number};
export type VerificationOperation=SkillInstallOperation|ApprovalOperation|ReviewerPolicyOperation|ReviewerPolicyRevokeOperation|ReviewerVoteOperation|ScheduleAuthorizationOperation|ScheduleRevocationOperation;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Server-derived action metadata only; never copy context/policy identity from HTTP input. */
export function approvalOperationHash(operation:ApprovalOperation):string{
 if(!operation||operation.kind!=='tool_approval'||typeof operation.approvalId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operation.approvalId)||typeof operation.paramsHash!=='string'||!/^[a-f0-9]{64}$/.test(operation.paramsHash)||!Number.isSafeInteger(operation.policyVersion)||operation.policyVersion<0||(operation.targetHash!==undefined&&(typeof operation.targetHash!=='string'||!/^[a-f0-9]{64}$/.test(operation.targetHash))))throw Error('Invalid verification operation');
 return hash(JSON.stringify(['tool-approval-proof-v1',operation.approvalId.toLowerCase(),operation.paramsHash,operation.policyVersion,operation.targetHash??null]));
}
/** Separate domain: policy-management proof can never authorize a tool call. */
export function reviewerPolicyOperationHash(operation:ReviewerPolicyOperation):string{
 if(!operation||Object.keys(operation).sort().join(',')!=='action,draftRevision,kind,paramsHash,policyId,policyVersion'||operation.kind!=='reviewer_policy'||operation.action!=='activate'||typeof operation.policyId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operation.policyId)||!Number.isInteger(operation.draftRevision)||operation.draftRevision<1||operation.draftRevision>2147483647||typeof operation.paramsHash!=='string'||!/^[a-f0-9]{64}$/.test(operation.paramsHash)||!Number.isSafeInteger(operation.policyVersion)||operation.policyVersion<1)throw Error('Invalid reviewer policy operation');
 return hash(JSON.stringify(['reviewer-policy-proof-v1',operation.action,operation.policyId,operation.draftRevision,operation.paramsHash,operation.policyVersion]));
}
/** Revocation proof is distinct from activation and tool execution proof. */
export function reviewerPolicyRevokeOperationHash(operation:ReviewerPolicyRevokeOperation):string{
 if(!operation||Object.keys(operation).sort().join(',')!=='kind,paramsHash,policyId,policyRevision,policyVersion'||operation.kind!=='reviewer_policy_revoke'||typeof operation.policyId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operation.policyId)||!Number.isInteger(operation.policyRevision)||operation.policyRevision<1||operation.policyRevision>2147483647||typeof operation.paramsHash!=='string'||!/^[a-f0-9]{64}$/.test(operation.paramsHash)||!Number.isSafeInteger(operation.policyVersion)||operation.policyVersion<1)throw Error('Invalid reviewer policy revocation');
 return hash(JSON.stringify(['reviewer-policy-revoke-proof-v1',operation.policyId,operation.policyRevision,operation.paramsHash,operation.policyVersion]));
}
/** A human decision is bound independently of policy changes and owner execution proof. */
export function reviewerVoteOperationHash(operation:ReviewerVoteOperation):string{
 const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v),hex=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 if(!operation||Object.keys(operation).sort().join(',')!=='approvalId,decision,kind,paramsHash,policyHash,policyId,policyRevision,policyVersion,requestHash'||operation.kind!=='reviewer_vote'||!uuid(operation.policyId)||!uuid(operation.approvalId)||!Number.isInteger(operation.policyRevision)||operation.policyRevision<1||operation.policyRevision>2147483647||!Number.isSafeInteger(operation.policyVersion)||operation.policyVersion<1||!hex(operation.paramsHash)||!hex(operation.requestHash)||!hex(operation.policyHash)||!['approve','deny'].includes(operation.decision))throw Error('Invalid reviewer vote operation');
 return hash(JSON.stringify(['human-reviewer-vote-proof-v1',operation.policyId,operation.policyRevision,operation.approvalId,operation.paramsHash,operation.requestHash,operation.policyHash,operation.decision,operation.policyVersion]));
}
/** Durable scheduled-job consent has a separate exact domain; proof alone grants no authority. */
export function scheduleAuthorizationOperationHash(operation:ScheduleAuthorizationOperation):string{
 if(!operation||Object.keys(operation).sort().join(',')!=='authorizationExpiresAt,authorizationRevision,definitionHash,jobId,jobRevision,kind,policyVersion'||operation.kind!=='schedule_authorization'||typeof operation.jobId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operation.jobId)||!Number.isInteger(operation.jobRevision)||operation.jobRevision<1||operation.jobRevision>2147483647||!Number.isInteger(operation.authorizationRevision)||operation.authorizationRevision<0||operation.authorizationRevision>2147483646||typeof operation.definitionHash!=='string'||!/^[a-f0-9]{64}$/.test(operation.definitionHash)||!Number.isSafeInteger(operation.authorizationExpiresAt)||operation.authorizationExpiresAt<1||!Number.isSafeInteger(operation.policyVersion)||operation.policyVersion<1)throw Error('Invalid scheduled authorization operation');
 return hash(JSON.stringify(['scheduled-job-authorization-proof-v1',operation.jobId,operation.jobRevision,operation.authorizationRevision,operation.definitionHash,operation.authorizationExpiresAt,operation.policyVersion]));
}
/** Revoking a consent can never be used to grant or run it. */
export function scheduleRevocationOperationHash(operation:ScheduleRevocationOperation):string{
 if(!operation||Object.keys(operation).sort().join(',')!=='authorizationRevision,jobId,kind,paramsHash,policyVersion'||operation.kind!=='schedule_authorization_revoke'||typeof operation.jobId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operation.jobId)||!Number.isInteger(operation.authorizationRevision)||operation.authorizationRevision<1||operation.authorizationRevision>2147483646||typeof operation.paramsHash!=='string'||!/^[a-f0-9]{64}$/.test(operation.paramsHash)||!Number.isSafeInteger(operation.policyVersion)||operation.policyVersion<1)throw Error('Invalid scheduled revocation operation');
 return hash(JSON.stringify(['scheduled-job-authorization-revoke-proof-v1',operation.jobId,operation.authorizationRevision,operation.paramsHash,operation.policyVersion]));
}
/** Separate domain for reviewed Markdown storage; completion itself never installs it. */
export function skillInstallOperationHash(operation:SkillInstallOperation):string{
 if(!operation||Object.keys(operation).sort().join(',')!=='kind,policyVersion,reviewExpiresAt,reviewHash,reviewId'||operation.kind!=='skill_install'||typeof operation.reviewId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operation.reviewId)||typeof operation.reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(operation.reviewHash)||!Number.isSafeInteger(operation.reviewExpiresAt)||operation.reviewExpiresAt<1||!Number.isSafeInteger(operation.policyVersion)||operation.policyVersion<1)throw Error('Invalid skill install operation');
 return hash(JSON.stringify(['reviewed-markdown-install-proof-v1',operation.reviewId,operation.reviewHash,operation.reviewExpiresAt,operation.policyVersion]));
}
function operationHash(operation:VerificationOperation):string{
 if(operation?.kind==='skill_install')return skillInstallOperationHash(operation);
 if(operation?.kind==='schedule_authorization_revoke')return scheduleRevocationOperationHash(operation);
 if(operation?.kind==='schedule_authorization')return scheduleAuthorizationOperationHash(operation);
 if(operation?.kind==='reviewer_vote')return reviewerVoteOperationHash(operation);
 if(operation?.kind==='reviewer_policy_revoke')return reviewerPolicyRevokeOperationHash(operation);
 return operation?.kind==='reviewer_policy'?reviewerPolicyOperationHash(operation):approvalOperationHash(operation as ApprovalOperation);
}
function binding(context:OperationContext,operation:VerificationOperation,now:number):VerificationBinding{
 if(!context||typeof context.userId!=='string'||!context.userId||context.userId.length>200||typeof context.sessionHash!=='string'||!/^[a-f0-9]{64}$/.test(context.sessionHash)||!Number.isSafeInteger(context.tokenVersion)||context.tokenVersion<1||!Number.isSafeInteger(context.factorVersion)||context.factorVersion<1||!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-300000)throw Error('Invalid operation verification context');
 if(operation?.kind==='schedule_authorization'&&(operation.authorizationExpiresAt<=now||operation.authorizationExpiresAt-now>7776000000))throw Error('Invalid scheduled authorization expiry');
 if(operation?.kind==='skill_install'&&(operation.reviewExpiresAt<=now||operation.reviewExpiresAt-now>300000))throw Error('Invalid skill review expiry');
 return {...context,purpose:'reverify',operationHash:operationHash(operation)};
}
function* currentContext(context:OperationContext):Step<boolean>{
 yield* lockName('verification-enrollment:'+context.userId);const d=yield* dialect();
 const user=yield* one<{status:string;email_verified:number;token_version:number}>(`SELECT status,email_verified,token_version FROM users WHERE id=?${forUpdate(d)}`,context.userId);
 const factor=yield* one<{enabled:number;version:number}>(`SELECT enabled,version FROM verification_factors WHERE user_id=?${forUpdate(d)}`,context.userId);
 return !!user&&user.status==='active'&&Number(user.email_verified)===1&&Number(user.token_version)===context.tokenVersion&&!!factor&&Number(factor.enabled)===1&&Number(factor.version)===context.factorVersion;
}
export async function issueOperationChallenge(context:OperationContext,operation:VerificationOperation,now=Date.now()){
 const b=binding(context,operation,now);
 if(!(await sql().tx(()=>currentContext(context))))throw Error('Operation verification context changed');
 return issueChallenge(b,now);
}
/** Creates proof only; does not approve, claim or execute the target operation. */
export async function completeOperationChallenge(token:unknown,context:OperationContext,operation:VerificationOperation,code:unknown,now=Date.now()):Promise<{receipt:string;expiresAt:number}|null>{
 const b=binding(context,operation,now),receipt=randomBytes(32).toString('base64url'),expiresAt=now+120000;
 const accepted=await sql().tx(function*(){
  if(!(yield* currentContext(context)))return false;
  if(!(yield* factorChallengeStep(token,b,code,'totp',now)))return false;
  yield* run('INSERT INTO verification_receipts(token_hash,user_id,session_hash,operation_hash,token_version,factor_version,expires_at) VALUES(?,?,?,?,?,?,?)',hash(receipt),context.userId,context.sessionHash,b.operationHash,context.tokenVersion,context.factorVersion,expiresAt);
  return true;
 });
 return accepted?{receipt,expiresAt}:null;
}
/** Caller MUST run this step with its own action CAS in the same sql().tx transaction. */
export function* consumeOperationReceiptStep(receipt:unknown,context:OperationContext,operation:VerificationOperation,now=Date.now()):Step<boolean>{
 const b=binding(context,operation,now);
 if(typeof receipt!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(receipt))return false;
 if(!(yield* currentContext(context)))return false;
 const d=yield* dialect();
 const row=yield* one<{user_id:string;session_hash:string;operation_hash:string;token_version:number;factor_version:number;expires_at:number;consumed_at:number|null}>(`SELECT * FROM verification_receipts WHERE token_hash=?${forUpdate(d)}`,hash(receipt));
 if(!row||row.consumed_at!==null||Number(row.expires_at)<=now||row.user_id!==context.userId||row.session_hash!==context.sessionHash||row.operation_hash!==b.operationHash||Number(row.token_version)!==context.tokenVersion||Number(row.factor_version)!==context.factorVersion)return false;
 return (yield* run('UPDATE verification_receipts SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?',now,hash(receipt),now)).changes===1;
}
