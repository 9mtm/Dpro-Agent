/** Explicit manual-owner workflow; agent install requests cannot supply this identity or proof. */
import type {FastifyInstance,FastifyReply} from 'fastify';
import {AuthTokenError} from '../../auth/jwt.js';
import {reviewerRequestIdentity,ReviewerIdentityError} from '../../auth/verification/reviewer-request.js';
import {VerificationChallengeLimitError} from '../../auth/verification/challenges.js';
import {PinnedSkillSource,PinnedSkillSourceError} from '../../plugins/pinned-skill-source.js';
import {isValidSkillArtifactTarget,SkillArtifactError} from '../../plugins/skill-artifact.js';
import {isValidSkillSourcePath} from '../../skills/skill-ids.js';
import {SkillLibraryError} from '../../skills/markdown-bundle.js';
import {centralSkills} from '../../skills/central-store.js';
import {stageSkillReview,readSkillReview,skillReviewOwnerStep,SkillReviewStageError} from '../../plugins/skill-review-stage.js';
import {issueSkillInstallProof,completeSkillInstallProof} from '../../plugins/skill-install-proof.js';
import {ReviewedSkillInstaller} from '../../plugins/skill-install-apply.js';
import {sql,one} from '../../repositories/sql-steps.js';
import {changePasswordRateLimit} from '../rate-limit-config.js';
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const token=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
const invalid={error:'Invalid skill installation request',code:'invalid_skill_installation'};
const unavailable={error:'Skill installation unavailable',code:'skill_installation_unavailable'};
function refused(reply:FastifyReply,error:unknown){
 if(error instanceof AuthTokenError)return reply.code(401).send({error:'Sign in required',code:'unauthenticated'});
 if(error instanceof ReviewerIdentityError)return reply.code(403).send({error:'Verified owner required',code:'owner_verification_required'});
 if(error instanceof VerificationChallengeLimitError)return reply.code(429).send({error:'Too many attempts',code:'rate_limited'});
 if(error instanceof PinnedSkillSourceError)return reply.code(502).send({error:'Skill source unavailable',code:'skill_source_unavailable'});
 if(error instanceof SkillArtifactError||error instanceof SkillLibraryError&&error.status===400)return reply.code(400).send(invalid);
 if(error instanceof SkillReviewStageError)return reply.code(error.code==='invalid'?400:error.code==='forbidden'?403:error.code==='limit'?429:error.code==='changed'?409:404).send(error.code==='invalid'?invalid:unavailable);
 return reply.code(503).send(unavailable);
}
export async function skillInstallRoutes(app:FastifyInstance,options:{source?:Pick<PinnedSkillSource,'fetch'>;installer?:ReviewedSkillInstaller}={}){
 const source=options.source??new PinnedSkillSource(),installer=options.installer??new ReviewedSkillInstaller(),base='/api/skills/reviewed-installs';
 app.addHook('onRequest',async(_r,reply)=>{reply.header('Cache-Control','no-store');});
 app.post(base+'/stage',{config:{access:'owner',rateLimit:changePasswordRateLimit},bodyLimit:2048},async(request,reply)=>{
  try{
   const {context,actor}=await reviewerRequestIdentity(request,true),body=request.body;
   if(Object.keys(request.query as object).length||!exact(body,['commit','sourcePath','targetName'])||typeof body.commit!=='string'||!/^[a-f0-9]{40}$/.test(body.commit)||/^0+$/.test(body.commit)||!isValidSkillSourcePath(body.sourcePath)||!isValidSkillArtifactTarget(body.targetName))return reply.code(400).send(invalid);
   const commit=body.commit,sourcePath=body.sourcePath,targetName=body.targetName;
   await sql().tx(()=>skillReviewOwnerStep(context,actor,Date.now()));
   const count=await sql().read(one<{n:number}>('SELECT COUNT(*) AS n FROM skill_install_reviews WHERE owner_id=? AND expires_at>?',context.userId,Date.now()));if(Number(count?.n??0)>=8)return reply.code(429).send(unavailable);
   const cancellation=new AbortController(),abort=()=>cancellation.abort();request.raw.once('aborted',abort);if(request.raw.aborted)abort();
   let artifact;try{artifact=await source.fetch({commit,sourcePath},cancellation.signal);}finally{request.raw.removeListener('aborted',abort);}
   if(artifact.provider!=='anthropic-skills'||artifact.commit!==commit||artifact.sourcePath!==sourcePath)throw new SkillArtifactError();
   await reviewerRequestIdentity(request,true);await centralSkills().initialize();
   const existing=await sql().read(one<{revision:number;content_hash:string}>('SELECT revision,content_hash FROM central_skills WHERE name=?',targetName));
   const staged=await stageSkillReview(context,actor,{provider:artifact.provider,commit:artifact.commit,sourcePath:artifact.sourcePath,targetName,expectedRevision:Number(existing?.revision??0),previousContentHash:existing?.content_hash??null,expectedContentHash:artifact.contentHash,content:artifact.content});
   return {id:staged.id,expiresAt:staged.expiresAt};
  }catch(error){return refused(reply,error);}
 });
 app.get(base+'/:id',{config:{access:'owner'}},async(request,reply)=>{
  try{const {context,actor}=await reviewerRequestIdentity(request,true),{id}=request.params as {id:string};if(!uuid(id)||Object.keys(request.query as object).length)return reply.code(400).send(invalid);const s=await readSkillReview(context,actor,id);return {id:s.id,expiresAt:s.expiresAt,reviewHash:s.reviewHash,operation:s.review.operation,files:s.review.bundle.files};}catch(error){return refused(reply,error);}
 });
 for(const phase of ['challenge','complete','apply'] as const)app.post(base+'/:id/'+phase,{config:{access:'owner',rateLimit:changePasswordRateLimit},bodyLimit:2048},async(request,reply)=>{
  try{
   const {context,actor}=await reviewerRequestIdentity(request,true),{id}=request.params as {id:string},body=request.body;
   if(!uuid(id)||Object.keys(request.query as object).length||!exact(body,phase==='challenge'?[]:phase==='complete'?['challenge','code']:['receipt']))return reply.code(400).send(invalid);
   if(phase==='challenge'){const r=await issueSkillInstallProof(context,actor,id);return {challenge:r.token,expiresAt:r.expiresAt};}
   if(phase==='complete'){
    if(!token(body.challenge)||typeof body.code!=='string'||!/^\d{6}$/.test(body.code))return reply.code(400).send(invalid);
    const result=await completeSkillInstallProof(context,actor,id,body.challenge,body.code);return result??reply.code(403).send({error:'Verification refused',code:'verification_refused'});
   }
   if(!token(body.receipt))return reply.code(400).send(invalid);return await installer.apply(context,actor,id,body.receipt);
  }catch(error){return refused(reply,error);}
 });
}
