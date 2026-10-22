import type {FastifyInstance} from 'fastify';
import {AuthTokenError} from '../../auth/jwt.js';
import {reviewerRequestIdentity,ReviewerIdentityError} from '../../auth/verification/reviewer-request.js';
import {ReviewerVoteError,issueReviewerVoteChallenge,completeReviewerVoteChallenge,castReviewerVote,type ReviewerVoteReference} from '../../auth/verification/reviewer-votes.js';
import {VerificationChallengeLimitError} from '../../auth/verification/challenges.js';
import {changePasswordRateLimit} from '../rate-limit-config.js';

const refusal={error:'Review unavailable',code:'review_unavailable'};
const referenceFields={
 policyId:{type:'string',minLength:1,maxLength:200},policyRevision:{type:'integer',minimum:1,maximum:2147483647},
 approvalId:{type:'string',minLength:1,maxLength:200},paramsHash:{type:'string',pattern:'^[a-f0-9]{64}$'},
 requestHash:{type:'string',pattern:'^[a-f0-9]{64}$'},policyHash:{type:'string',pattern:'^[a-f0-9]{64}$'},decision:{type:'string',enum:['approve','deny']},
};
const opaque={type:'string',pattern:'^[A-Za-z0-9_-]{43}$'};
/** Assigned human votes require exact request-bound proof and an explicit recording action. */
export async function reviewerVoteRoutes(app:FastifyInstance){
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','no-store');});
 for(const action of ['challenge','complete','cast'] as const){
  const extra=action==='challenge'?{}:action==='complete'?{challenge:opaque,code:{type:'string',pattern:'^[0-9]{6}$'}}:{receipt:opaque};
  const properties={...referenceFields,...extra},allowed=Object.keys(properties);
  app.post('/api/reviewer-votes/'+action,{
   config:{access:'user',rateLimit:changePasswordRateLimit},bodyLimit:8192,
   preValidation:async(request,reply)=>{
    const body=request.body as Record<string,unknown>|null;
    if(Object.keys(request.query as object).length||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!allowed.includes(key))||allowed.some(key=>key==='policyRevision'?!Number.isSafeInteger(body[key]):typeof body[key]!=='string'))return reply.code(400).send({error:'Invalid review request',code:'invalid_review_request'});
   },
   schema:{body:{type:'object',additionalProperties:false,required:allowed,properties}},
  },async(request,reply)=>{
   try{
    const {context,actor}=await reviewerRequestIdentity(request),body=request.body as ReviewerVoteReference&{challenge?:string;code?:string;receipt?:string};
    // Pick reviewed fields explicitly; identity and proof-policy generation are always server-derived.
    const ref:ReviewerVoteReference={policyId:body.policyId,policyRevision:body.policyRevision,approvalId:body.approvalId,paramsHash:body.paramsHash,requestHash:body.requestHash,policyHash:body.policyHash,decision:body.decision};
    if(action==='challenge'){
     const result=await issueReviewerVoteChallenge(context,actor,ref);
     return {challenge:result.token,expiresAt:result.expiresAt};
    }
    if(action==='complete'){
     const result=await completeReviewerVoteChallenge(body.challenge,context,actor,ref,body.code);
     if(!result)return reply.code(403).send({error:'Verification refused',code:'verification_refused'});
     return {receipt:result.receipt,expiresAt:result.expiresAt};
    }
    const result=await castReviewerVote(body.receipt,context,actor,ref);
    return {recorded:result.recorded,decision:result.decision,revision:result.revision,idempotent:result.idempotent};
   }catch(error){
    if(error instanceof AuthTokenError)return reply.code(401).send({error:'Sign in required',code:'unauthenticated'});
    if(error instanceof ReviewerIdentityError)return reply.code(403).send({error:'Verified human account required',code:'human_verification_required'});
    if(error instanceof VerificationChallengeLimitError)return reply.code(429).send({error:'Too many attempts',code:'rate_limited'});
    if(error instanceof ReviewerVoteError){
     if(error.code==='invalid')return reply.code(400).send({error:'Invalid review request',code:'invalid_review_request'});
     if(error.code==='proof_refused')return reply.code(403).send({error:'Verification refused',code:'verification_refused'});
     if(error.code==='conflict')return reply.code(409).send({error:'Decision already recorded',code:'review_conflict'});
     // Do not reveal whether an unassigned policy or pending request exists.
     return reply.code(404).send(refusal);
    }
    return reply.code(503).send(refusal);
   }
  });
 }
}
