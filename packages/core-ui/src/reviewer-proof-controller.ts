import {allowedScheduleAuthorization,scheduleAuthorizationResponse} from './scheduler-authorization-contract.js';
import type {SessionClient} from './session';
import {allowedReviewer,reviewerResponse} from './reviewers-contract.js';
export type ReviewerVoteReference=Readonly<{policyId:string;policyRevision:number;approvalId:string;paramsHash:string;requestHash:string;policyHash:string;decision:'approve'|'deny'}>;
export type ReviewerProofTarget=Readonly<{kind:'vote';reference:ReviewerVoteReference}|{kind:'policy';id:string;action:'activate'|'revoke';revision:number;paramsHash:string}|{kind:'schedule';id:string;action:'authorize'|'revoke';operation:Readonly<Record<string,unknown>>}>;
type State=Readonly<{phase:'closed'|'loading'|'code'|'verifying'|'verified'|'unavailable'|'spent';notice?:'refused'|'limited'|'expired'|'unavailable'}>;
export class ReviewerProofController{
 #state:State=Object.freeze({phase:'closed'});#listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;#expiry:ReturnType<typeof setTimeout>|undefined;#challenge:string|undefined;#receipt:string|undefined;#expiresAt=0;
 #base:string;#body:Readonly<Record<string,unknown>>;#project:typeof reviewerResponse;
 constructor(private readonly client:Pick<SessionClient,'request'>,target:ReviewerProofTarget){
  this.#project=target.kind==='schedule'?scheduleAuthorizationResponse:reviewerResponse;
  this.#base=target.kind==='schedule'?`/api/scheduler/jobs/${target.id}/authorization${target.action==='revoke'?'/revoke':''}`:target.kind==='vote'?'/api/reviewer-votes':`/api/reviewer-policies/${target.id}/${target.action}`;
  const body=target.kind==='schedule'?{operation:Object.freeze({...target.operation})}:target.kind==='vote'?{...target.reference}:{revision:target.revision,paramsHash:target.paramsHash};
  if(!(target.kind==='schedule'?allowedScheduleAuthorization:allowedReviewer)('POST',this.#base+'/challenge',body))throw Error('Invalid reviewed target');
  this.#body=Object.freeze(body);
 }
 getSnapshot=()=>this.#state;
 subscribe=(fn:()=>void)=>{this.#listeners.add(fn);return()=>{this.#listeners.delete(fn);};};
 #publish(state:State){this.#state=Object.freeze(state);this.#listeners.forEach(fn=>fn());}
 cancel(){this.#generation++;this.#pending?.abort();this.#pending=undefined;if(this.#expiry)clearTimeout(this.#expiry);this.#expiry=undefined;this.#challenge=undefined;this.#receipt=undefined;this.#expiresAt=0;this.#publish({phase:'closed'});}
 #expire(){this.cancel();this.#publish({phase:'unavailable',notice:'expired'});}
 #arm(expiresAt:number,max:number){const delay=expiresAt-Date.now();if(!Number.isSafeInteger(expiresAt)||delay<=0||delay>max)throw Error();if(this.#expiry)clearTimeout(this.#expiry);this.#expiresAt=expiresAt;this.#expiry=setTimeout(()=>this.#expire(),delay);}
 async start(){
  this.cancel();const generation=this.#generation;this.#pending=new AbortController();this.#publish({phase:'loading'});
  try{const path=this.#base+'/challenge',r=await this.client.request({method:'POST',path,body:{...this.#body}},this.#pending.signal);if(generation!==this.#generation)return;
   const value=this.#project(path,r.status,r.body) as {challenge?:string;expiresAt:number};
   if(r.status!==200||!value.challenge){this.#publish({phase:'unavailable',notice:r.status===429?'limited':'unavailable'});return;}
   this.#arm(value.expiresAt,305000);this.#challenge=value.challenge;this.#publish({phase:'code'});
  }catch{if(generation===this.#generation){this.cancel();this.#publish({phase:'unavailable',notice:'unavailable'});}}
 }
 async verify(code:string){
  if(this.#state.phase!=='code'||!this.#challenge||!/^[0-9]{6}$/.test(code))return;
  if(this.#expiresAt<=Date.now()){this.#expire();return;}
  const generation=this.#generation,challenge=this.#challenge;this.#pending=new AbortController();this.#publish({phase:'verifying'});
  try{const path=this.#base+'/complete',r=await this.client.request({method:'POST',path,body:{...this.#body,challenge,code}},this.#pending.signal);if(generation!==this.#generation)return;
   const value=this.#project(path,r.status,r.body) as {receipt?:string;expiresAt:number;code?:string};
   if(r.status===403&&value.code==='verification_refused'){this.#publish({phase:'code',notice:'refused'});return;}
   if(r.status!==200||!value.receipt){this.cancel();this.#publish({phase:'unavailable',notice:r.status===429?'limited':'unavailable'});return;}
   this.#challenge=undefined;this.#arm(value.expiresAt,125000);this.#receipt=value.receipt;this.#publish({phase:'verified'});
  }catch{if(generation===this.#generation){this.cancel();this.#publish({phase:'unavailable',notice:'unavailable'});}}
 }
 takeReceipt():string|undefined{
  if(this.#state.phase!=='verified'||!this.#receipt)return;
  if(this.#expiresAt<=Date.now()){this.#expire();return;}
  const receipt=this.#receipt;this.cancel();this.#publish({phase:'spent'});return receipt;
 }
}
