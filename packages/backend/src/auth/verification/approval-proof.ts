import {createHash} from 'node:crypto';
import {sql,one,run,dialect,lockName,type Step} from '../../repositories/sql-steps.js';
import {forUpdate} from '../../db/pg/dialect.js';
import {approvalOperationHash,issueOperationChallenge,completeOperationChallenge,consumeOperationReceiptStep,type OperationContext,type ApprovalOperation} from './operation-proof.js';
/** This generation invalidates proof; it does not itself enable a permission or enforcement policy. */
type ApprovalRow={id:string;status:string;params_hash:string|null;tool_name:string;agent_id:string|null;user_id:string|null;session_id:string|null;category:string|null;origin:string|null;delegated_from:string|null;run_scope:string|null;requested_at:string};
function* boundApproval(context:OperationContext,id:string,expectedHash:string,now:number):Step<ApprovalOperation>{
 // Reuse exact operation validation before any query.
 approvalOperationHash({kind:'tool_approval',approvalId:id,paramsHash:expectedHash,policyVersion:0});
 if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-300000)throw Error('Invalid approval proof time');
 yield* lockName('verification-enrollment:'+context.userId);const d=yield* dialect();
 const owner=yield* one<{role:string;status:string;token_version:number;email_verified:number}>(`SELECT role,status,token_version,email_verified FROM users WHERE id=?${forUpdate(d)}`,context.userId);
 if(!owner||owner.role!=='owner'||owner.status!=='active'||Number(owner.email_verified)!==1||Number(owner.token_version)!==context.tokenVersion)throw Error('Owner approval context changed');
 const policy=yield* one<{version:number}>(`SELECT version FROM approval_proof_policy WHERE id=1${forUpdate(d)}`);
 if(!policy||!Number.isSafeInteger(Number(policy.version))||Number(policy.version)<1)throw Error('Approval proof policy unavailable');
 const row=yield* one<ApprovalRow>(`SELECT id,status,params_hash,tool_name,agent_id,user_id,session_id,category,origin,delegated_from,run_scope,requested_at FROM tool_approvals WHERE id=?${forUpdate(d)}`,id);
 if(!row||row.status!=='pending'||row.params_hash!==expectedHash)throw Error('Approval request changed');
 const requested=Date.parse(row.requested_at.endsWith('Z')?row.requested_at:row.requested_at.replace(' ','T')+'Z');
 if(!Number.isFinite(requested)||requested>now||now-requested>=86400000)throw Error('Approval request expired');
 const target=JSON.stringify([row.tool_name,row.agent_id,row.user_id,row.session_id,row.category,row.origin,row.delegated_from,row.run_scope,row.requested_at]);
 if(target.length>1048576)throw Error('Approval target unavailable');
 return {kind:'tool_approval',approvalId:row.id,paramsHash:expectedHash,policyVersion:Number(policy.version),targetHash:createHash('sha256').update(target).digest('hex')};
}
export async function issueApprovalProofChallenge(context:OperationContext,id:string,paramsHash:string,now=Date.now()){
 const operation=await sql().tx(()=>boundApproval(context,id,paramsHash,now));
 return issueOperationChallenge(context,operation,now);
}
/** Proves this current request only; no tool is executed here. */
export async function completeApprovalProofChallenge(token:unknown,context:OperationContext,id:string,paramsHash:string,code:unknown,now=Date.now()){
 const operation=await sql().tx(()=>boundApproval(context,id,paramsHash,now));
 return completeOperationChallenge(token,context,operation,code,now);
}
/** Internal secure claim: execution must retain existing decrypt/hash and current tool-grant checks. */
export function* claimApprovalWithReceiptStep(receipt:unknown,context:OperationContext,id:string,paramsHash:string,now=Date.now()):Step<boolean>{
 const operation=yield* boundApproval(context,id,paramsHash,now);
 if(!(yield* consumeOperationReceiptStep(receipt,context,operation,now)))return false;
 const changed=yield* run("UPDATE tool_approvals SET status='approved',decided_at=?,decided_by=? WHERE id=? AND status='pending' AND params_hash=?",new Date(now).toISOString().slice(0,19).replace('T',' '),context.userId,id,paramsHash);
 if(changed.changes!==1)throw Error('Approval claim conflict');
 return true;
}

/** Serializes the legacy claim with enrollment so an enabled factor cannot be omitted. */
export function* claimApprovalWithoutReceiptStep(ownerId:string,id:string,paramsHash:string,now=Date.now()):Step<{kind:'claimed'|'required'|'forbidden';changes:number}>{
 yield* lockName('verification-enrollment:'+ownerId);const d=yield* dialect();
 const owner=yield* one<{role:string;status:string}>(`SELECT role,status FROM users WHERE id=?${forUpdate(d)}`,ownerId);
 if(!owner||owner.role!=='owner'||owner.status!=='active')return {kind:'forbidden',changes:0};
 const factor=yield* one<{enabled:number}>(`SELECT enabled FROM verification_factors WHERE user_id=?${forUpdate(d)}`,ownerId);
 if(factor&&Number(factor.enabled)===1)return {kind:'required',changes:0};
 const result=yield* run("UPDATE tool_approvals SET status='approved',decided_at=?,decided_by=? WHERE id=? AND status='pending' AND params_hash=?",new Date(now).toISOString().slice(0,19).replace('T',' '),ownerId,id,paramsHash);
 return {kind:'claimed',changes:result.changes};
}
