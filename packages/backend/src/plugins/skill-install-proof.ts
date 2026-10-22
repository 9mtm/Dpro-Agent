/** Server-read staged review metadata only; proof completion does not apply installation. */
import type {Actor} from '../repositories/actor.js';
import {readSkillReview} from './skill-review-stage.js';
import {issueOperationChallenge,completeOperationChallenge,type OperationContext,type SkillInstallOperation} from '../auth/verification/operation-proof.js';
async function current(context:OperationContext,actor:Actor,id:string,now:number):Promise<SkillInstallOperation>{
 const stage=await readSkillReview(context,actor,id,now);
 return Object.freeze({kind:'skill_install',reviewId:stage.id,reviewHash:stage.reviewHash,reviewExpiresAt:stage.expiresAt,policyVersion:stage.policyVersion});
}
export async function issueSkillInstallProof(context:OperationContext,actor:Actor,id:string,now=Date.now()){
 const operation=await current(context,actor,id,now);return issueOperationChallenge(context,operation,now);
}
export async function completeSkillInstallProof(context:OperationContext,actor:Actor,id:string,challenge:unknown,code:unknown,now=Date.now()){
 const operation=await current(context,actor,id,now);return completeOperationChallenge(challenge,context,operation,code,now);
}
