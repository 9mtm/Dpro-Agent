import type {FastifyInstance} from 'fastify';
import {AuthTokenError} from '../../auth/jwt.js';
import {reviewerRequestIdentity,ReviewerIdentityError} from '../../auth/verification/reviewer-request.js';
import {parseReviewerDraft} from '../../auth/verification/reviewer-policy.js';
import {reviewerVoteTarget,readReviewerVote,ReviewerVoteError} from '../../auth/verification/reviewer-votes.js';
import {quorumRequestHash,type QuorumApprovalRow} from '../../auth/verification/reviewer-quorum.js';
import {sql,all,one} from '../../repositories/sql-steps.js';
import {readBoundReviewerParams} from '../../tools/approvals.js';
type PolicyRow={id:string;version:number;policy_json:string;approved_at:number};
const unavailable={error:'Review unavailable',code:'review_unavailable'};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function assigned(row:PolicyRow,userId:string,now:number){
 try{
  if(!uuid(row.id)||!Number.isSafeInteger(Number(row.version))||Number(row.version)<1||!Number.isSafeInteger(Number(row.approved_at))||Number(row.approved_at)>now)return null;
  const policy=parseReviewerDraft(JSON.parse(row.policy_json),Number(row.approved_at));
  return policy.expiresAt>now&&policy.reviewerIds.includes(userId)?policy:null;
 }catch{return null;}
}
/** Assigned review only. No owner approval access or implicit vote. */
export async function reviewerRequestRoutes(app:FastifyInstance){
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','no-store');});
 app.get('/api/reviewer-requests/:policyId/:approvalId',{config:{access:'user'}},async(request,reply)=>{
  try{
   const identity=await reviewerRequestIdentity(request),{context,actor}=identity,{policyId,approvalId}=request.params as {policyId:string;approvalId:string};
   const query=request.query as Record<string,unknown>,keys=['revision','paramsHash','requestHash','policyHash'];
   if(!uuid(policyId)||!uuid(approvalId)||Object.keys(query).length!==keys.length||keys.some(k=>typeof query[k]!=='string')||!/^([1-9][0-9]{0,9})$/.test(query.revision as string)||Number(query.revision)>2147483647||['paramsHash','requestHash','policyHash'].some(k=>!/^[a-f0-9]{64}$/.test(query[k] as string)))return reply.code(400).send({error:'Invalid review request',code:'invalid_review_request'});
   const before=await reviewerVoteTarget(context,actor,policyId,Number(query.revision),approvalId,query.paramsHash as string,'approve');
   if(before.requestHash!==query.requestHash||before.policyHash!==query.policyHash)return reply.code(404).send(unavailable);
   const detail=await readBoundReviewerParams(approvalId,before.paramsHash,before.requestHash);
   if(!detail)return reply.code(404).send(unavailable);
   const after=await reviewerVoteTarget(context,actor,policyId,Number(query.revision),approvalId,before.paramsHash,'approve');
   if(JSON.stringify(after)!==JSON.stringify(before))return reply.code(404).send(unavailable);
   const current=await reviewerRequestIdentity(request);
   if(current.context.factorVersion!==context.factorVersion||current.context.tokenVersion!==context.tokenVersion)return reply.code(404).send(unavailable);
   const {kind:_kind,policyVersion:_generation,...reference}=before;
   const ownVote=await readReviewerVote(context,actor,reference);
   return {reference,...detail,ownVote};
  }catch(error){return reply.code(error instanceof AuthTokenError?401:error instanceof ReviewerIdentityError?403:error instanceof ReviewerVoteError?404:503).send(unavailable);}
 });
 app.get('/api/reviewer-requests/policies',{config:{access:'user'}},async(request,reply)=>{
  try{
   const {context}=await reviewerRequestIdentity(request);
   if(Object.keys(request.query as object).length)return reply.code(400).send({error:'Invalid review request',code:'invalid_review_request'});
   const rows=await sql().read(all<PolicyRow>("SELECT id,version,policy_json,approved_at FROM human_reviewer_policies WHERE status='active' ORDER BY id LIMIT 1001"));
   if(rows.length>1000)return reply.code(503).send(unavailable);
   const now=Date.now(),policies=rows.flatMap(row=>{
    const policy=assigned(row,context.userId,now);
    return policy?[{id:row.id,revision:Number(row.version),name:policy.name,requiredVotes:policy.requiredVotes,expiresAt:policy.expiresAt}]:[];
   });
   await reviewerRequestIdentity(request);
   return {policies};
  }catch(error){return reply.code(error instanceof AuthTokenError?401:error instanceof ReviewerIdentityError?403:503).send(unavailable);}
 });
 app.get('/api/reviewer-requests/:policyId',{config:{access:'user'}},async(request,reply)=>{
  try{
   const {context,actor}=await reviewerRequestIdentity(request),{policyId}=request.params as {policyId:string},query=request.query as {cursor?:string};
   if(!uuid(policyId)||Object.keys(query).some(key=>key!=='cursor')||(query.cursor!==undefined&&!uuid(query.cursor)))return reply.code(400).send({error:'Invalid review request',code:'invalid_review_request'});
   const row=await sql().read(one<PolicyRow>("SELECT id,version,policy_json,approved_at FROM human_reviewer_policies WHERE id=? AND status='active'",policyId));
   const policy=row&&assigned(row,context.userId,Date.now());
   if(!row||!policy)return reply.code(404).send(unavailable);
   // Scope predicates apply BEFORE pagination: unrelated approvals never influence items or cursors.
   const agents=policy.scope.agentIds,tools=policy.scope.toolNames;
   const candidates=await sql().read(all<QuorumApprovalRow>(
    `SELECT id,status,params_hash,tool_name,agent_id,user_id,session_id,category,origin,delegated_from,run_scope,requested_at FROM tool_approvals WHERE status='pending' AND id>? AND agent_id IN (${agents.map(()=>'?').join(',')}) AND tool_name IN (${tools.map(()=>'?').join(',')})${policy.allowInitiatorVote?'':' AND (user_id IS NULL OR user_id<>?)'} ORDER BY id LIMIT 51`,
    query.cursor??'',...agents,...tools,...(policy.allowInitiatorVote?[]:[context.userId])));
   const items=[];
   for(const candidate of candidates.slice(0,50)){
    try{
     const operation=await reviewerVoteTarget(context,actor,row.id,Number(row.version),candidate.id,candidate.params_hash??'','approve');
     if(operation.requestHash!==quorumRequestHash(candidate))continue;
     const {kind:_kind,policyVersion:_generation,...reference}=operation;
     const ownVote=await readReviewerVote(context,actor,reference);
     items.push({reference,toolName:candidate.tool_name,agentId:candidate.agent_id,requestedAt:candidate.requested_at,ownVote});
    }catch(error){
     if(!(error instanceof ReviewerVoteError))throw error;
     if(error.code==='forbidden')return reply.code(404).send(unavailable);
     if(error.code!=='changed'&&error.code!=='unavailable')throw error;
    }
   }
   // Fence policy replacement/revocation while candidates were being checked; return no partial page.
   const current=await sql().read(one<PolicyRow>("SELECT id,version,policy_json,approved_at FROM human_reviewer_policies WHERE id=? AND status='active'",policyId));
   if(!current||Number(current.version)!==Number(row.version)||current.policy_json!==row.policy_json||!assigned(current,context.userId,Date.now()))return reply.code(404).send(unavailable);
   await reviewerRequestIdentity(request);
   return {items,nextCursor:candidates.length>50?candidates[49].id:null};
  }catch(error){return reply.code(error instanceof AuthTokenError?401:error instanceof ReviewerIdentityError?403:503).send(unavailable);}
 });
}
