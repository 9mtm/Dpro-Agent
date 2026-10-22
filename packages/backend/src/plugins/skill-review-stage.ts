/** Internal review staging only. A staged record is never an installation permission. */
import {createHash,randomUUID} from 'node:crypto';
import type {Actor} from '../repositories/actor.js';
import type {OperationContext} from '../auth/verification/operation-proof.js';
import {isSystemAccount} from '../auth/default-accounts.js';
import {sql,one,run,lockName,dialect,type Step} from '../repositories/sql-steps.js';
import {forUpdate} from '../db/pg/dialect.js';
import {prepareSkillArtifactReview} from './skill-artifact.js';
export class SkillReviewStageError extends Error{constructor(readonly code:'invalid'|'forbidden'|'changed'|'unavailable'|'limit'){super('Skill review '+code);}}
type Review=ReturnType<typeof prepareSkillArtifactReview>;
export type SkillReviewRead=Readonly<{id:string;expiresAt:number;reviewHash:string;policyVersion:number;review:Review}>;
type StageRow={id:string;owner_id:string;session_hash:string;token_version:number;factor_version:number;policy_version:number;created_at:number;expires_at:number;target_id:string|null;review_json:string;review_hash:string};
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
function capture(context:OperationContext,actor:Actor,now:number){
 if(!context||actor?.kind!=='user'||actor.role!=='owner'||actor.agentId!==undefined||actor.channel!==undefined||actor.userId!==context.userId||typeof context.userId!=='string'||!context.userId||context.userId.length>200||isSystemAccount(context.userId)||typeof context.sessionHash!=='string'||!/^[a-f0-9]{64}$/.test(context.sessionHash)||!Number.isSafeInteger(context.tokenVersion)||context.tokenVersion<1||!Number.isSafeInteger(context.factorVersion)||context.factorVersion<1)throw new SkillReviewStageError('forbidden');
 if(!Number.isSafeInteger(now)||now<1||now>Number.MAX_SAFE_INTEGER-300000)throw new SkillReviewStageError('invalid');
 return Object.freeze({userId:context.userId,sessionHash:context.sessionHash,tokenVersion:context.tokenVersion,factorVersion:context.factorVersion});
}
function* active(context:OperationContext):Step<number>{
 yield* lockName('verification-enrollment:'+context.userId);const d=yield* dialect();
 const user=yield* one<{role:string;status:string;email_verified:number;token_version:number}>(`SELECT role,status,email_verified,token_version FROM users WHERE id=?${forUpdate(d)}`,context.userId);
 const factor=yield* one<{enabled:number;version:number}>(`SELECT enabled,version FROM verification_factors WHERE user_id=?${forUpdate(d)}`,context.userId);
 const policy=yield* one<{version:number}>(`SELECT version FROM approval_proof_policy WHERE id=1${forUpdate(d)}`);
 if(!user||user.role!=='owner'||user.status!=='active'||Number(user.email_verified)!==1||Number(user.token_version)!==context.tokenVersion||!factor||Number(factor.enabled)!==1||Number(factor.version)!==context.factorVersion)throw new SkillReviewStageError('forbidden');
 if(!policy||!Number.isSafeInteger(Number(policy.version))||Number(policy.version)<1)throw new SkillReviewStageError('changed');
 return Number(policy.version);
}
function* target(review:Review):Step<string|null>{
 const t=review.operation.target;yield* lockName('central-skill:'+t.name);const d=yield* dialect();
 const row=yield* one<{id:string;revision:number;content_hash:string}>(`SELECT id,revision,content_hash FROM central_skills WHERE name=?${forUpdate(d)}`,t.name);
 if(row?Number(row.revision)!==t.expectedRevision||row.content_hash!==t.previousContentHash:t.expectedRevision!==0||t.previousContentHash!==null)throw new SkillReviewStageError('changed');
 return row?.id??null;
}
export async function stageSkillReview(context:OperationContext,actor:Actor,input:unknown,now=Date.now()){
 const owner=capture(context,actor,now),review=prepareSkillArtifactReview(input),id=randomUUID(),expiresAt=now+300000;
 return sql().tx(function*(){
  const policyVersion=yield* active(owner),targetId=yield* target(review);
  const count=yield* one<{n:number}>('SELECT COUNT(*) AS n FROM skill_install_reviews WHERE owner_id=? AND expires_at>?',owner.userId,now);
  if(Number(count?.n??0)>=8)throw new SkillReviewStageError('limit');
  const reviewJson=JSON.stringify(review),reviewHash=digest(JSON.stringify(['skill-review-stage-v1',id,targetId,review.planHash,policyVersion,expiresAt]));
  yield* run('INSERT INTO skill_install_reviews(id,owner_id,session_hash,token_version,factor_version,policy_version,created_at,expires_at,target_id,review_json,review_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,owner.userId,owner.sessionHash,owner.tokenVersion,owner.factorVersion,policyVersion,now,expiresAt,targetId,reviewJson,reviewHash);
  return Object.freeze({id,expiresAt,reviewHash,policyVersion,review});
 });
}
export function* readSkillReviewStep(context:OperationContext,actor:Actor,id:string,now=Date.now()):Step<SkillReviewRead>{
 const owner=capture(context,actor,now);if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw new SkillReviewStageError('invalid');
  const policyVersion=yield* active(owner),row=yield* one<StageRow>('SELECT * FROM skill_install_reviews WHERE id=? AND owner_id=?',id,owner.userId);
  if(!row||row.session_hash!==owner.sessionHash||Number(row.token_version)!==owner.tokenVersion||Number(row.factor_version)!==owner.factorVersion)throw new SkillReviewStageError('unavailable');
  if(Number(row.policy_version)!==policyVersion||Number(row.created_at)>now||Number(row.expires_at)<=now||Number(row.expires_at)-Number(row.created_at)!==300000)throw new SkillReviewStageError('changed');
  let review:Review;try{review=JSON.parse(row.review_json);if(digest(JSON.stringify(review.operation))!==review.planHash||digest(JSON.stringify(review.bundle.files))!==review.operation.bundle.hash||review.bundle.hash!==review.operation.bundle.hash)throw Error();}catch{throw new SkillReviewStageError('unavailable');}
  const targetId=yield* target(review);
  if(targetId!==row.target_id||digest(JSON.stringify(['skill-review-stage-v1',id,targetId,review.planHash,policyVersion,Number(row.expires_at)]))!==row.review_hash)throw new SkillReviewStageError('changed');
  // Restore immutability after JSON persistence; callers cannot mutate the staged object.
  Object.freeze(review.operation.source);Object.freeze(review.operation.target);Object.freeze(review.operation.bundle);Object.freeze(review.operation);
  for(const file of review.bundle.files)Object.freeze(file);Object.freeze(review.bundle.files);Object.freeze(review.bundle);Object.freeze(review);
  return Object.freeze({id,expiresAt:Number(row.expires_at),reviewHash:row.review_hash,policyVersion,review});
}

export async function readSkillReview(context:OperationContext,actor:Actor,id:string,now=Date.now()){
 return sql().tx(()=>readSkillReviewStep(context,actor,id,now));
}
export function* skillReviewOwnerStep(context:OperationContext,actor:Actor,now:number):Step<number>{
 return yield* active(capture(context,actor,now));
}
