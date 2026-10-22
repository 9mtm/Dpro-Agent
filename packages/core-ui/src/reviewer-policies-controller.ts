import type {SessionClient} from './session';
import {allowedReviewer,reviewerResponse} from './reviewers-contract.js';
import type {ReviewerProofTarget} from './reviewer-proof-controller';
export type RulePolicy=Readonly<{name:string;scope:Readonly<{agentIds:readonly string[];toolNames:readonly string[]}>;reviewerIds:readonly string[];requiredVotes:number;allowInitiatorVote:boolean;expiresAt:number}>;
export type RuleDraft=Readonly<{id:string;revision:number;status:'draft';policy:RulePolicy;updatedAt:number}>;
export type RuleRuntime=Readonly<{id:string;version:number;status:'active'|'revoked';policy:RulePolicy|null;unavailable:boolean}>;
export type RuleRow=Readonly<{id:string;name?:string|null;draftPending?:boolean;draftRevision:number|null;version:number|null;status:'draft'|'active'|'revoked'}>;
export type EligibleHuman=Readonly<{id:string;name:string;role:string}>;
type State=Readonly<{phase:'idle'|'loading'|'ready'|'detail'|'saving'|'preparing'|'applying'|'error';items:readonly RuleRow[];nextCursor:string|null;selectedId?:string;draft?:RuleDraft;runtime?:RuleRuntime;notice?:'unavailable'|'verification'|'changed'|'saved'|'applied'|'unknown'|'refused';locked?:boolean}>;
const initial=():State=>Object.freeze({phase:'idle',items:[],nextCursor:null});
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export class ReviewerPoliciesController{
 #state=initial();#listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;#prepared:ReviewerProofTarget|undefined;
 constructor(private readonly client:Pick<SessionClient,'request'>){}
 getSnapshot=()=>this.#state;
 subscribe=(fn:()=>void)=>{this.#listeners.add(fn);return()=>{this.#listeners.delete(fn);};};
 #publish(state:State){this.#state=freeze(state);this.#listeners.forEach(fn=>fn());}
 #busy(){return ['saving','applying','preparing'].includes(this.#state.phase);}
 #begin(){this.#pending?.abort();this.#pending=new AbortController();this.#prepared=undefined;return ++this.#generation;}
 cancel(){this.#generation++;this.#pending?.abort();this.#prepared=undefined;this.#publish(initial());}
 discardProof(){this.#prepared=undefined;}
 async #rpc(method:string,path:string,body?:unknown){const response=await this.client.request({method,path,...(body===undefined?{}:{body})} as never,this.#pending?.signal);const value=reviewerResponse(path,response.status,response.body);return {status:response.status,value};}
 async load(cursor?:string){
  if(this.#busy())return;const generation=this.#begin();this.#publish({...initial(),phase:'loading'});
  try{const path='/api/reviewer-policies'+(cursor?'?cursor='+encodeURIComponent(cursor):''),r=await this.#rpc('GET',path);if(generation!==this.#generation)return;if(r.status!==200)throw Error(String(r.value.code));this.#publish({phase:'ready',items:r.value.items as RuleRow[],nextCursor:r.value.nextCursor as string|null});}catch(error){if(generation===this.#generation)this.#publish({...initial(),phase:'error',notice:error instanceof Error&&error.message==='owner_verification_required'?'verification':'unavailable'});}
 }
 async open(id:string){
  if(this.#busy()||!this.#state.items.some(i=>i.id===id))return;const base=this.#state,generation=this.#begin();this.#publish({...base,phase:'detail',selectedId:id,draft:undefined,runtime:undefined,notice:undefined,locked:false});
  try{
   const [draft,runtime]=await Promise.all([this.#rpc('GET','/api/reviewer-policies/'+id+'/draft'),this.#rpc('GET','/api/reviewer-policies/'+id)]);if(generation!==this.#generation)return;
   if(![200,404].includes(runtime.status)||runtime.status!==200&&draft.status!==200)throw Error();
   this.#publish({...base,phase:'ready',selectedId:id,draft:draft.status===200?draft.value as unknown as RuleDraft:undefined,runtime:runtime.status===200?runtime.value as unknown as RuleRuntime:undefined,notice:![200,404].includes(draft.status)?'unavailable':undefined,locked:false});
  }catch{if(generation===this.#generation)this.#publish({...base,phase:'error',selectedId:id,draft:undefined,runtime:undefined,notice:'unavailable'});}
 }
 async save(id:string,expectedRevision:number,policy:RulePolicy){
  if(this.#busy())return;const body={expectedRevision,policy};if(!allowedReviewer('PUT','/api/reviewer-policies/'+id+'/draft',body))return;
  // Capture a plain immutable draft before any asynchronous transport or caller edits.
  const captured=freeze(JSON.parse(JSON.stringify(body))) as typeof body,base=this.#state,generation=this.#begin();this.#publish({...base,phase:'saving',notice:undefined,locked:true});
  try{const r=await this.#rpc('PUT','/api/reviewer-policies/'+id+'/draft',captured);if(generation!==this.#generation)return;if(r.status!==200){this.#publish({...base,phase:'error',notice:r.status===409?'changed':[400,401,403].includes(r.status)?'refused':'unknown',locked:true});return;}const draft=r.value as unknown as RuleDraft;this.#publish({...base,phase:'ready',selectedId:id,draft,runtime:base.selectedId===id?base.runtime:undefined,items:base.items.some(v=>v.id===id)?base.items.map(v=>v.id===id?{...v,name:draft.policy.name,draftPending:!base.runtime||base.runtime.status!=='active'||JSON.stringify(draft.policy)!==JSON.stringify(base.runtime.policy),draftRevision:draft.revision}:v):[...base.items,{id,name:draft.policy.name,draftPending:true,draftRevision:draft.revision,version:null,status:'draft'}],notice:'saved',locked:false});}catch{if(generation===this.#generation)this.#publish({...base,phase:'error',notice:'unknown',locked:true});}
 }
 async prepare(action:'activate'|'revoke'):Promise<ReviewerProofTarget|undefined>{
  const base=this.#state,id=base.selectedId,revision=action==='activate'?base.draft?.revision:base.runtime?.status==='active'?base.runtime.version:undefined;
  if(base.phase!=='ready'||base.locked||!id||!revision)return;
  const generation=this.#begin();this.#publish({...base,phase:'preparing',notice:undefined});
  try{const r=await this.#rpc('POST','/api/reviewer-policies/'+id+'/'+action+'/preview',{revision});if(generation!==this.#generation)return;if(r.status!==200||r.value.revision!==revision)throw Error();const target=Object.freeze({kind:'policy' as const,id,action,revision,paramsHash:r.value.paramsHash as string});this.#prepared=target;this.#publish({...base,phase:'ready',notice:undefined});return target;}catch{if(generation===this.#generation)this.#publish({...base,phase:'error',notice:'changed'});}
 }
 async apply(target:ReviewerProofTarget,receipt:string){
  const base=this.#state;
  if(base.phase!=='ready'||base.locked||target!==this.#prepared||target.kind!=='policy'||target.id!==base.selectedId)return;
  const path='/api/reviewer-policies/'+target.id+'/'+target.action+'/apply',body={revision:target.revision,paramsHash:target.paramsHash,receipt};if(!allowedReviewer('POST',path,body))return;
  const generation=this.#begin();this.#publish({...base,phase:'applying',locked:true,notice:undefined});
  try{const r=await this.#rpc('POST',path,body);if(generation!==this.#generation)return;if(r.status!==200){this.#publish({...base,phase:'error',notice:r.status===409?'changed':[400,401,403].includes(r.status)?'refused':'unknown',locked:true});return;}this.#publish({...base,phase:'ready',runtime:{id:target.id,version:r.value.version as number,status:r.value.status as 'active'|'revoked',policy:target.action==='activate'?base.draft!.policy:base.runtime?.policy??null,unavailable:target.action==='revoke'?(base.runtime?.unavailable??false):false},items:base.items.map(v=>v.id===target.id?{...v,version:r.value.version as number,status:r.value.status as 'active'|'revoked',draftPending:target.action==='revoke'?!!base.draft:false}:v),notice:'applied',locked:false});}catch{if(generation===this.#generation)this.#publish({...base,phase:'error',notice:'unknown',locked:true});}
 }
}
