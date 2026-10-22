import type {FastifyInstance,FastifyReply} from 'fastify';
import {AuthTokenError} from '../../auth/jwt.js';
import {ReviewerIdentityError,reviewerRequestIdentity} from '../../auth/verification/reviewer-request.js';
import {ReviewerDraftError,readReviewerDraft,saveReviewerDraft,parseReviewerDraft} from '../../auth/verification/reviewer-policy.js';
import {sql,all,one} from '../../repositories/sql-steps.js';
import {reviewerDraftProofTarget,issueReviewerDraftChallenge,completeReviewerDraftChallenge} from '../../auth/verification/reviewer-policy-proof.js';
import {reviewerPolicyRevocationTarget,issueReviewerPolicyRevocation,completeReviewerPolicyRevocation,activateReviewerPolicy,revokeReviewerPolicy} from '../../auth/verification/reviewer-policy-state.js';
import {VerificationChallengeLimitError} from '../../auth/verification/challenges.js';
import {changePasswordRateLimit} from '../rate-limit-config.js';
import {SYSTEM_ACCOUNT_IDS} from '../../auth/default-accounts.js';
const invalid={error:'Invalid policy request',code:'invalid_policy_request'};
const unavailable={error:'Policy unavailable',code:'policy_unavailable'};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function refused(reply:FastifyReply,error:unknown){
 if(error instanceof AuthTokenError)return reply.code(401).send({error:'Sign in required',code:'unauthenticated'});
 if(error instanceof ReviewerIdentityError)return reply.code(403).send({error:'Verified owner required',code:'owner_verification_required'});
 if(error instanceof VerificationChallengeLimitError)return reply.code(429).send({error:'Too many attempts',code:'rate_limited'});
 if(error instanceof ReviewerDraftError)return reply.code(error.code==='invalid'?400:error.code==='forbidden'?403:409).send(error.code==='invalid'?invalid:unavailable);
 return reply.code(503).send(unavailable);
}
/** Protected owner management. Preview and OTP completion never activate or withdraw a rule. */
export async function reviewerPolicyRoutes(app:FastifyInstance){
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','no-store');});
 app.get('/api/reviewer-policies/eligible-humans',{config:{access:'owner'}},async(request,reply)=>{
  try{
   await reviewerRequestIdentity(request,true);const query=request.query as {cursor?:string};
   if(Object.keys(query).some(k=>k!=='cursor')||(query.cursor!==undefined&&(typeof query.cursor!=='string'||query.cursor.length<1||query.cursor.length>200||query.cursor.trim()!==query.cursor||/[\x00-\x1f\x7f]/.test(query.cursor))))return reply.code(400).send(invalid);
   const excluded=[...SYSTEM_ACCOUNT_IDS];
   const rows=await sql().read(all<{id:string;username:string;role:string}>(
    `SELECT u.id,u.username,u.role FROM users u JOIN verification_factors f ON f.user_id=u.id WHERE u.id>? AND u.status='active' AND u.email_verified=1 AND u.role IN ('owner','admin','user') AND f.enabled=1 AND f.version>0 AND u.token_version>0${excluded.length?' AND u.id NOT IN ('+excluded.map(()=>'?').join(',')+')':''} ORDER BY u.id LIMIT 51`,query.cursor??'',...excluded));
   await reviewerRequestIdentity(request,true);
   return {items:rows.slice(0,50).map(row=>({id:row.id,name:row.username,role:row.role})),nextCursor:rows.length>50?rows[49].id:null};
  }catch(error){return refused(reply,error);}
 });
 app.get('/api/reviewer-policies',{config:{access:'owner'}},async(request,reply)=>{
  try{
   await reviewerRequestIdentity(request,true);const query=request.query as {cursor?:string};
   if(Object.keys(query).some(k=>k!=='cursor')||(query.cursor!==undefined&&!uuid(query.cursor)))return reply.code(400).send(invalid);
   const rows=await sql().read(all<{id:string}>('SELECT id FROM (SELECT id FROM human_reviewer_drafts UNION SELECT id FROM human_reviewer_policies) AS policy_ids WHERE id>? ORDER BY id LIMIT 51',query.cursor??''));
   const items=[];
   for(const row of rows.slice(0,50)){
    const draft=await sql().read(one<{revision:number;policy_json:string;updated_at:number}>('SELECT revision,policy_json,updated_at FROM human_reviewer_drafts WHERE id=?',row.id));
    const state=await sql().read(one<{version:number;status:string;policy_json:string;approved_at:number}>('SELECT version,status,policy_json,approved_at FROM human_reviewer_policies WHERE id=?',row.id));
    const normalized=(source:{policy_json:string}|undefined,time:number)=>{
     if(!source||source.policy_json.length>1048576)return null;
     try{return parseReviewerDraft(JSON.parse(source.policy_json),time);}catch{return null;}
    };
    const draftPolicy=normalized(draft,Number(draft?.updated_at)),runtimePolicy=normalized(state,Number(state?.approved_at));
    const name=draftPolicy?.name??runtimePolicy?.name??null;
    const draftPending=!!draftPolicy&&(state?.status!=='active'||!runtimePolicy||JSON.stringify(draftPolicy)!==JSON.stringify(runtimePolicy));
    items.push({id:row.id,name,draftPending,draftRevision:draft?Number(draft.revision):null,version:state?Number(state.version):null,status:state?.status??'draft'});
   }
   await reviewerRequestIdentity(request,true);
   return {items,nextCursor:rows.length>50?rows[49].id:null};
  }catch(error){return refused(reply,error);}
 });
 app.get('/api/reviewer-policies/:id',{config:{access:'owner'}},async(request,reply)=>{
  try{
   await reviewerRequestIdentity(request,true);const {id}=request.params as {id:string};
   if(!uuid(id)||Object.keys(request.query as object).length)return reply.code(400).send(invalid);
   const row=await sql().read(one<{version:number;status:string;policy_json:string;approved_at:number}>('SELECT version,status,policy_json,approved_at FROM human_reviewer_policies WHERE id=?',id));
   if(!row)return reply.code(404).send(unavailable);
   let policy=null;try{policy=parseReviewerDraft(JSON.parse(row.policy_json),Number(row.approved_at));}catch{}
   await reviewerRequestIdentity(request,true);
   // Invalid historical content is never echoed; an active unavailable rule remains explicitly withdrawable.
   return {id,version:Number(row.version),status:row.status,policy,unavailable:policy===null};
  }catch(error){return refused(reply,error);}
 });
 app.get('/api/reviewer-policies/:id/draft',{config:{access:'owner'}},async(request,reply)=>{
  try{
   const {context,actor}=await reviewerRequestIdentity(request,true),{id}=request.params as {id:string};
   if(!uuid(id)||Object.keys(request.query as object).length)return reply.code(400).send(invalid);
   const draft=await readReviewerDraft({actor,tokenVersion:context.tokenVersion},id);
   return draft??reply.code(404).send(unavailable);
  }catch(error){return refused(reply,error);}
 });
 app.put('/api/reviewer-policies/:id/draft',{config:{access:'owner',rateLimit:changePasswordRateLimit},bodyLimit:32768},async(request,reply)=>{
  try{
   const {context,actor}=await reviewerRequestIdentity(request,true),{id}=request.params as {id:string},body=request.body;
   if(!uuid(id)||Object.keys(request.query as object).length||!exact(body,['expectedRevision','policy'])||!Number.isSafeInteger(body.expectedRevision))return reply.code(400).send(invalid);
   return await saveReviewerDraft({actor,tokenVersion:context.tokenVersion},id,body.expectedRevision as number,body.policy);
  }catch(error){return refused(reply,error);}
 });
 for(const action of ['activate','revoke'] as const)for(const phase of ['preview','challenge','complete','apply'] as const){
  app.post('/api/reviewer-policies/:id/'+action+'/'+phase,{config:{access:'owner',rateLimit:changePasswordRateLimit},bodyLimit:4096},async(request,reply)=>{
   try{
    const {context,actor}=await reviewerRequestIdentity(request,true),{id}=request.params as {id:string},body=request.body;
    const keys=phase==='preview'?['revision']:phase==='challenge'?['revision','paramsHash']:phase==='complete'?['revision','paramsHash','challenge','code']:['revision','paramsHash','receipt'];
    if(!uuid(id)||Object.keys(request.query as object).length||!exact(body,keys)||!Number.isSafeInteger(body.revision)||(body.revision as number)<1||(body.revision as number)>2147483647||(phase!=='preview'&&(typeof body.paramsHash!=='string'||!/^[a-f0-9]{64}$/.test(body.paramsHash)))||(phase==='complete'&&(typeof body.challenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.challenge)||typeof body.code!=='string'||!/^[0-9]{6}$/.test(body.code)))||(phase==='apply'&&(typeof body.receipt!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.receipt))))return reply.code(400).send(invalid);
    const revision=body.revision as number,hash=body.paramsHash as string;
    if(phase==='preview'){
     const target=action==='activate'?await reviewerDraftProofTarget(context,actor,id,revision):await reviewerPolicyRevocationTarget(context,actor,id,revision);
     return {id,revision,paramsHash:target.paramsHash,action};
    }
    if(phase==='challenge'){
     const result=action==='activate'?await issueReviewerDraftChallenge(context,actor,id,revision,hash):await issueReviewerPolicyRevocation(context,actor,id,revision,hash);
     return {challenge:result.token,expiresAt:result.expiresAt};
    }
    if(phase==='complete'){
     const result=action==='activate'?await completeReviewerDraftChallenge(body.challenge,context,actor,id,revision,hash,body.code):await completeReviewerPolicyRevocation(body.challenge,context,actor,id,revision,hash,body.code);
     return result?{receipt:result.receipt,expiresAt:result.expiresAt}:reply.code(403).send({error:'Verification refused',code:'verification_refused'});
    }
    const result=action==='activate'?await activateReviewerPolicy(body.receipt,context,actor,id,revision,hash):await revokeReviewerPolicy(body.receipt,context,actor,id,revision,hash);
    return {id:result.id,version:result.version,status:result.status};
   }catch(error){return refused(reply,error);}
  });
 }
}
