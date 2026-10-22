import type {SessionClient} from './session';
import {allowedReviewer,reviewerResponse} from './reviewers-contract.js';
import type {ReviewerVoteReference} from './reviewer-proof-controller';
export type ReviewPolicy=Readonly<{id:string;revision:number;name:string;requiredVotes:number;expiresAt:number}>;
export type OwnReviewVote=Readonly<{decision:'approve'|'deny';revision:number;status:'current'|'verification_required'}>;
export type ReviewItem=Readonly<{reference:ReviewerVoteReference;toolName:string;agentId:string;requestedAt:string;ownVote?:OwnReviewVote|null}>;
export type ReviewDetail=Readonly<{reference:ReviewerVoteReference;params:unknown;maskedFields:readonly string[];runScope:unknown;ownVote?:OwnReviewVote|null}>;
type State=Readonly<{phase:'idle'|'loading'|'ready'|'detail'|'recording'|'error';policies:readonly ReviewPolicy[];policyId?:string;items:readonly ReviewItem[];nextCursor:string|null;detail?:ReviewDetail;notice?:'unavailable'|'verification'|'changed'|'recorded'|'unknown'|'refused'|'conflict';locked?:boolean}>;
const initial=():State=>Object.freeze({phase:'idle',policies:[],items:[],nextCursor:null});
const same=(a:ReviewerVoteReference,b:ReviewerVoteReference)=>a.policyId===b.policyId&&a.policyRevision===b.policyRevision&&a.approvalId===b.approvalId&&a.paramsHash===b.paramsHash&&a.requestHash===b.requestHash&&a.policyHash===b.policyHash;
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export class HumanReviewsController{
 #state=initial();#listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;
 constructor(private readonly client:Pick<SessionClient,'request'>){}
 getSnapshot=()=>this.#state;
 subscribe=(fn:()=>void)=>{this.#listeners.add(fn);return()=>{this.#listeners.delete(fn);};};
 #publish(value:State){this.#state=freeze(value);this.#listeners.forEach(fn=>fn());}
 #begin(){this.#pending?.abort();this.#pending=new AbortController();return ++this.#generation;}
 cancel(){this.#generation++;this.#pending?.abort();this.#pending=undefined;this.#publish(initial());}
 async #read(path:string){const response=await this.client.request({method:'GET',path},this.#pending?.signal);const body=reviewerResponse(path,response.status,response.body);if(response.status!==200)throw Error(String(body.code));return body;}
 async load(){
  if(this.#state.phase==='recording')return;const generation=this.#begin();this.#publish({...initial(),phase:'loading'});
  try{const body=await this.#read('/api/reviewer-requests/policies');if(generation!==this.#generation)return;this.#publish({...initial(),phase:'ready',policies:body.policies as ReviewPolicy[]});}catch(error){if(generation===this.#generation)this.#publish({...initial(),phase:'error',notice:error instanceof Error&&error.message==='human_verification_required'?'verification':'unavailable'});}
 }
 async choosePolicy(id:string,cursor?:string){
  if(this.#state.phase==='recording'||!this.#state.policies.some(v=>v.id===id))return;
  const policies=this.#state.policies,generation=this.#begin();this.#publish({phase:'loading',policies,policyId:id,items:[],nextCursor:null});
  try{const path='/api/reviewer-requests/'+id+(cursor?'?cursor='+encodeURIComponent(cursor):''),body=await this.#read(path);if(generation!==this.#generation)return;this.#publish({phase:'ready',policies,policyId:id,items:body.items as ReviewItem[],nextCursor:body.nextCursor as string|null});}catch{if(generation===this.#generation)this.#publish({phase:'error',policies,policyId:id,items:[],nextCursor:null,notice:'unavailable'});}
 }
 async open(item:ReviewItem){
  if(this.#state.phase==='recording'||!this.#state.items.includes(item))return;
  const base=this.#state,generation=this.#begin();this.#publish({...base,phase:'detail',detail:undefined,notice:undefined,locked:false});
  const r=item.reference,path='/api/reviewer-requests/'+r.policyId+'/'+r.approvalId+'?'+new URLSearchParams({revision:String(r.policyRevision),paramsHash:r.paramsHash,requestHash:r.requestHash,policyHash:r.policyHash});
  try{const body=await this.#read(path);if(generation!==this.#generation)return;this.#publish({...base,phase:'ready',detail:body as unknown as ReviewDetail,notice:undefined,locked:(body as unknown as ReviewDetail).ownVote?.status==='current'});}catch{if(generation===this.#generation)this.#publish({...base,phase:'error',detail:undefined,notice:'changed'});}
 }
 closeDetail(){if(this.#state.phase==='recording')return;this.#begin();this.#publish({...this.#state,phase:'ready',detail:undefined,notice:undefined,locked:false});}
 async record(reference:ReviewerVoteReference,receipt:string){
  if(this.#state.phase!=='ready'||this.#state.locked||!this.#state.detail||!same(reference,this.#state.detail.reference))return;
  if(this.#state.detail.ownVote&&reference.decision!==this.#state.detail.ownVote.decision)return;
  reference=Object.freeze({...reference});
  if(!allowedReviewer('POST','/api/reviewer-votes/cast',{...reference,receipt}))return;
  const base=this.#state,generation=this.#begin();this.#publish({...base,phase:'recording',notice:undefined,locked:true});
  try{
   const path='/api/reviewer-votes/cast',response=await this.client.request({method:'POST',path,body:{...reference,receipt}},this.#pending?.signal),body=reviewerResponse(path,response.status,response.body);if(generation!==this.#generation)return;
   if(response.status!==200){const code=String(body.code);this.#publish({...base,phase:'error',notice:response.status===409&&code==='review_conflict'?'conflict':[401,403,404].includes(response.status)&&['verification_refused','review_unavailable','human_verification_required','unauthenticated','forbidden'].includes(code)?'refused':'unknown',locked:true});return;}
   if(body.decision!==reference.decision)throw Error('Decision mismatch');
   this.#publish({...base,phase:'ready',items:base.items.filter(i=>i.reference.approvalId!==reference.approvalId),detail:undefined,notice:'recorded',locked:false});
  }catch{if(generation===this.#generation)this.#publish({...base,phase:'error',notice:'unknown',locked:true});}
 }
}
