import {sql,one,run,lockName,dialect,type Step} from '../../repositories/sql-steps.js';
import {forUpdate} from '../../db/pg/dialect.js';
import type {Actor} from '../../repositories/actor.js';
import {isSystemAccount} from '../default-accounts.js';
export type ReviewerDraftInput=Readonly<{name:string;scope:Readonly<{agentIds:readonly string[];toolNames:readonly string[]}>;reviewerIds:readonly string[];requiredVotes:number;allowInitiatorVote:boolean;expiresAt:number}>;
export type ReviewerDraft=Readonly<{id:string;revision:number;status:'draft';policy:ReviewerDraftInput;updatedAt:number}>;
/** Trusted server actor/session context only; never an HTTP body or agent-provided label. */
export type ReviewerDraftContext={actor:Actor;tokenVersion:number};
export class ReviewerDraftError extends Error{
 constructor(readonly code:'invalid'|'forbidden'|'conflict'|'ineligible'){super('Reviewer draft '+code);}
}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const userId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const resourceId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
function list(v:unknown,max:number,valid:(v:unknown)=>v is string):readonly string[]{
 if(!Array.isArray(v)||v.length<1||v.length>max||!v.every(valid)||new Set(v).size!==v.length)throw new ReviewerDraftError('invalid');
 return Object.freeze([...v].sort());
}
/** Exact, finite scopes only. No wildcard, privilege fields, agent voters or activation switches. */
export function parseReviewerDraft(input:unknown,now=Date.now()):ReviewerDraftInput{
 if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-7776000000||!record(input)||!exact(input,['name','scope','reviewerIds','requiredVotes','allowInitiatorVote','expiresAt'])||typeof input.name!=='string'||input.name.trim()!==input.name||input.name.length<1||input.name.length>100||/[\x00-\x1f\x7f]/.test(input.name)||!record(input.scope)||!exact(input.scope,['agentIds','toolNames'])||!Number.isInteger(input.requiredVotes)||(input.requiredVotes as number)<1||(input.requiredVotes as number)>10||typeof input.allowInitiatorVote!=='boolean'||!Number.isSafeInteger(input.expiresAt)||(input.expiresAt as number)<=now||(input.expiresAt as number)>now+7776000000)throw new ReviewerDraftError('invalid');
 const reviewerIds=list(input.reviewerIds,20,userId),agentIds=list(input.scope.agentIds,50,resourceId),toolNames=list(input.scope.toolNames,50,resourceId);
 if(reviewerIds.some(isSystemAccount)||reviewerIds.length<(input.requiredVotes as number)+(input.allowInitiatorVote?0:1))throw new ReviewerDraftError('invalid');
 return Object.freeze({name:input.name,scope:Object.freeze({agentIds,toolNames}),reviewerIds,requiredVotes:input.requiredVotes as number,allowInitiatorVote:input.allowInitiatorVote,expiresAt:input.expiresAt as number});
}
function ownerId(context:ReviewerDraftContext):string{
 if(!context||context.actor?.kind!=='user'||context.actor.role!=='owner'||context.actor.agentId!==undefined||context.actor.channel!==undefined||!userId(context.actor.userId)||isSystemAccount(context.actor.userId)||!Number.isSafeInteger(context.tokenVersion)||context.tokenVersion<1)throw new ReviewerDraftError('forbidden');
 return context.actor.userId;
}
function* currentOwner(context:ReviewerDraftContext):Step<string>{
 const id=ownerId(context),d=yield* dialect();
 const user=yield* one<{role:string;status:string;email_verified:number;token_version:number}>(`SELECT role,status,email_verified,token_version FROM users WHERE id=?${forUpdate(d)}`,id);
 if(!user||user.role!=='owner'||user.status!=='active'||Number(user.email_verified)!==1||Number(user.token_version)!==context.tokenVersion)throw new ReviewerDraftError('forbidden');
 return id;
}
/** Internal staged drafts only. No runtime route, reviewer assignment, vote or execution is created. */
export async function saveReviewerDraft(context:ReviewerDraftContext,id:string,expectedRevision:number,input:unknown,now=Date.now()):Promise<ReviewerDraft>{
 const owner=ownerId(context),trusted:ReviewerDraftContext={actor:{kind:'user',role:'owner',userId:owner},tokenVersion:context.tokenVersion},policy=parseReviewerDraft(input,now);
 if(!validId(id)||!Number.isInteger(expectedRevision)||expectedRevision<0||expectedRevision>=2147483647)throw new ReviewerDraftError('invalid');
 return sql().tx(function*(){
  yield* lockName('human-reviewer-drafts');
  for(const person of [...new Set([owner,...policy.reviewerIds])].sort())yield* lockName('verification-enrollment:'+person);
  yield* currentOwner(trusted);const d=yield* dialect();
  for(const person of [...new Set([owner,...policy.reviewerIds])].sort()){
   const user=yield* one<{role:string;status:string;email_verified:number}>(`SELECT role,status,email_verified FROM users WHERE id=?${forUpdate(d)}`,person);
   const factor=yield* one<{enabled:number}>(`SELECT enabled FROM verification_factors WHERE user_id=?${forUpdate(d)}`,person);
   if(!user||!['owner','admin','user'].includes(user.role)||user.status!=='active'||Number(user.email_verified)!==1||!factor||Number(factor.enabled)!==1)throw new ReviewerDraftError('ineligible');
  }
  const row=yield* one<{revision:number}>(`SELECT revision FROM human_reviewer_drafts WHERE id=?${forUpdate(d)}`,id);
  if(Number(row?.revision??0)!==expectedRevision)throw new ReviewerDraftError('conflict');
  const revision=expectedRevision+1,payload=JSON.stringify(policy);
  const changed=row?yield* run('UPDATE human_reviewer_drafts SET revision=?,policy_json=?,updated_by=?,updated_at=? WHERE id=? AND revision=?',revision,payload,owner,now,id,expectedRevision):yield* run('INSERT INTO human_reviewer_drafts(id,revision,policy_json,updated_by,updated_at) VALUES(?,?,?,?,?)',id,revision,payload,owner,now);
  if(changed.changes!==1)throw new ReviewerDraftError('conflict');
  return Object.freeze({id,revision,status:'draft' as const,policy,updatedAt:now});
 });
}
/** Returns saved drafts even after expiry so owners can review them; never treats them as authority. */
export async function readReviewerDraft(context:ReviewerDraftContext,id:string):Promise<ReviewerDraft|null>{
 const owner=ownerId(context),trusted:ReviewerDraftContext={actor:{kind:'user',role:'owner',userId:owner},tokenVersion:context.tokenVersion};if(!validId(id))throw new ReviewerDraftError('invalid');
 return sql().tx(function*(){
  yield* lockName('verification-enrollment:'+owner);yield* currentOwner(trusted);
  const row=yield* one<{revision:number;policy_json:string;updated_at:number;status:string}>('SELECT revision,policy_json,updated_at,status FROM human_reviewer_drafts WHERE id=?',id);
  if(!row)return null;if(row.status!=='draft')throw new ReviewerDraftError('invalid');
  return Object.freeze({id,revision:Number(row.revision),status:'draft' as const,policy:parseReviewerDraft(JSON.parse(row.policy_json),Number(row.updated_at)),updatedAt:Number(row.updated_at)});
 });
}
