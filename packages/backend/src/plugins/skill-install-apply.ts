/** Final document index publication; proof completion and preparation remain separate operations. */
import {createHash,randomUUID} from 'node:crypto';
import type {Actor} from '../repositories/actor.js';
import {dataPath} from '../config/data-root.js';
import {sql,one,run,type Step} from '../repositories/sql-steps.js';
import {verifyOperationReceiptStep,consumeOperationReceiptStep,type OperationContext,type SkillInstallOperation} from '../auth/verification/operation-proof.js';
import {readSkillReviewStep,skillReviewOwnerStep,SkillReviewStageError,type SkillReviewRead} from './skill-review-stage.js';
import {prepareReviewedObject} from '../skills/reviewed-object.js';
type Outcome=Readonly<{reviewId:string;skillId:string;name:string;revision:number;hash:string}>;
type Event={review_id:string;owner_id:string;session_hash:string;token_version:number;factor_version:number;policy_version:number;receipt_hash:string;skill_id:string;name:string;revision:number;content_hash:string};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const operation=(stage:SkillReviewRead):SkillInstallOperation=>({kind:'skill_install',reviewId:stage.id,reviewHash:stage.reviewHash,reviewExpiresAt:stage.expiresAt,policyVersion:stage.policyVersion});
function* previous(context:OperationContext,actor:Actor,id:string,receipt:string,now:number):Step<Outcome|null>{
 const policy=yield* skillReviewOwnerStep(context,actor,now),event=yield* one<Event>('SELECT * FROM skill_install_events WHERE review_id=?',id);
 if(!event)return null;
 if(event.owner_id!==context.userId||event.session_hash!==context.sessionHash||Number(event.token_version)!==context.tokenVersion||Number(event.factor_version)!==context.factorVersion||Number(event.policy_version)!==policy||event.receipt_hash!==hash(receipt))throw new SkillReviewStageError('forbidden');
 return Object.freeze({reviewId:id,skillId:event.skill_id,name:event.name,revision:Number(event.revision),hash:event.content_hash});
}
export class ReviewedSkillInstaller{
 constructor(private readonly root=dataPath('skill-library'),private readonly clock:()=>number=Date.now){}
 async apply(context:OperationContext,actor:Actor,id:string,receipt:unknown):Promise<Outcome>{
  const now=this.clock();
  if(typeof receipt!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(receipt)||typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new SkillReviewStageError('invalid');
  const owner=Object.freeze({...context}),human=Object.freeze({...actor});
  const admitted=await sql().tx(function*(){
   const done=yield* previous(owner,human,id,receipt,now);if(done)return {done};
   const stage=yield* readSkillReviewStep(owner,human,id,now);
   if(!(yield* verifyOperationReceiptStep(receipt,owner,operation(stage),now)))throw new SkillReviewStageError('forbidden');
   return {stage};
  });
  if(admitted.done)return admitted.done;
  const stage=admitted.stage!;
  // No index is visible here. A failure can leave only a reusable unindexed content object.
  await prepareReviewedObject(this.root,stage.review.bundle);
  const clock=this.clock;
  return sql().tx(function*(){
   const commitAt=clock();
   const done=yield* previous(owner,human,id,receipt,commitAt);if(done)return done;
   const fresh=yield* readSkillReviewStep(owner,human,id,commitAt);
   const admittedAt=clock();
   if(admittedAt>=fresh.expiresAt||fresh.reviewHash!==stage.reviewHash||!(yield* consumeOperationReceiptStep(receipt,owner,operation(fresh),admittedAt)))throw new SkillReviewStageError('forbidden');
   const b=fresh.review.bundle,t=fresh.review.operation.target;
   const existing=yield* one<{id:string}>('SELECT id FROM central_skills WHERE name=?',t.name),skillId=existing?.id??randomUUID(),revision=t.expectedRevision+1;
   if(existing&&(yield* one('SELECT agent_id FROM central_agent_skills WHERE skill_id=?',existing.id)))throw new SkillReviewStageError('changed');
   if(t.expectedRevision===0){
    const created=yield* run('INSERT INTO central_skills(id,name,description,version,revision,content_hash,origin) VALUES(?,?,?,?,1,?,?) ON CONFLICT(name) DO NOTHING',skillId,b.name,b.description,b.version,b.hash,'reviewed-marketplace');
    if(created.changes!==1)throw new SkillReviewStageError('changed');
   }else{
    const updated=yield* run('UPDATE central_skills SET description=?,version=?,revision=?,content_hash=?,origin=? WHERE id=? AND name=? AND revision=? AND content_hash=?',b.description,b.version,revision,b.hash,'reviewed-marketplace',skillId,t.name,t.expectedRevision,t.previousContentHash);
    if(updated.changes!==1)throw new SkillReviewStageError('changed');
   }
   yield* run('INSERT INTO skill_install_events(review_id,owner_id,session_hash,token_version,factor_version,policy_version,receipt_hash,skill_id,name,revision,content_hash,installed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,owner.userId,owner.sessionHash,owner.tokenVersion,owner.factorVersion,fresh.policyVersion,hash(receipt),skillId,b.name,revision,b.hash,admittedAt);
   return Object.freeze({reviewId:id,skillId,name:b.name,revision,hash:b.hash});
  });
 }
}
