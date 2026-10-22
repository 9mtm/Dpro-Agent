import type {SessionClient} from './session';
import {ReviewerProofController} from './reviewer-proof-controller';
import {scheduleAuthorizationResponse} from './scheduler-authorization-contract.js';
export type ScheduleReview=Readonly<{name:string;description:string|null;cronExpression:string;timeZone:string;actionType:'api-call'|'send-message';action:Readonly<Record<string,unknown>>;maskedFields:readonly string[]}>;
type Phase='closed'|'loading'|'review'|'loading-code'|'code'|'verifying'|'verified'|'applying'|'applied'|'unknown'|'unavailable';
type State=Readonly<{phase:Phase;review:ScheduleReview|null;expiresAt?:number;notice?:'refused'|'limited'|'expired'|'unavailable';readback?:'authorized'|'authorization_required'|'not_required'}>;
const freeze=<T,>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
/** Owns only this dialog's reviewed action. No run/enable call and no automatic write retry. */
export class ScheduleConsentController{
 #state:State=Object.freeze({phase:'closed',review:null});#listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;#proof:ReviewerProofController|undefined;#unsubscribe:(()=>void)|undefined;#operation:Readonly<Record<string,unknown>>|undefined;
 readonly base:string;
 constructor(private readonly client:Pick<SessionClient,'request'>,readonly id:string,readonly action:'authorize'|'revoke'){
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)||!['authorize','revoke'].includes(action))throw Error('Invalid schedule');
  this.base='/api/scheduler/jobs/'+id+'/authorization'+(action==='revoke'?'/revoke':'');
 }
 getSnapshot=()=>this.#state;
 subscribe=(listener:()=>void)=>{this.#listeners.add(listener);return()=>{this.#listeners.delete(listener);};};
 #publish(state:State){this.#state=Object.freeze(state);this.#listeners.forEach(listener=>listener());}
 #clearProof(){this.#unsubscribe?.();this.#unsubscribe=undefined;this.#proof?.cancel();this.#proof=undefined;}
 cancel(){this.#generation++;this.#pending?.abort();this.#pending=undefined;this.#clearProof();this.#operation=undefined;this.#publish({phase:'closed',review:null});}
 async load(hours=24){
  if(this.#state.phase==='applying'||this.#state.phase==='unknown'||this.#state.phase==='applied')return;
  if(![1,24,168].includes(hours))return;
  this.cancel();const generation=this.#generation;this.#pending=new AbortController();this.#publish({phase:'loading',review:null});
  try{
   const path=this.base+'/preview',response=await this.client.request({method:'POST',path,body:this.action==='revoke'?{}:{expiresAt:Date.now()+hours*3600000}},this.#pending.signal);
   if(generation!==this.#generation)return;
   const value=scheduleAuthorizationResponse(path,response.status,response.body);
   if(response.status!==200){this.#publish({phase:'unavailable',review:null,notice:response.status===429?'limited':'unavailable'});return;}
   this.#operation=Object.freeze({...value.operation as Record<string,unknown>});
   const {definitionHash:_hash,...review}=(value.review??{}) as Record<string,unknown>;
   this.#publish({phase:'review',review:this.action==='authorize'?freeze(review as ScheduleReview):null,...(this.action==='authorize'?{expiresAt:this.#operation.authorizationExpiresAt as number}:{})});
  }catch{if(generation===this.#generation)this.#publish({phase:'unavailable',review:null,notice:'unavailable'});}
 }
 async startVerification(){
  if(this.#state.phase!=='review'||!this.#operation)return;
  if(this.action==='authorize'&&Number(this.#operation.authorizationExpiresAt)<=Date.now()){this.#publish({...this.#state,phase:'unavailable',notice:'expired'});return;}
  const proof=new ReviewerProofController(this.client,{kind:'schedule',id:this.id,action:this.action,operation:this.#operation});this.#proof=proof;
  this.#unsubscribe=proof.subscribe(()=>{
   if(this.#proof!==proof)return;const state=proof.getSnapshot();
   const phase=state.phase==='loading'?'loading-code':state.phase==='code'?'code':state.phase==='verifying'?'verifying':state.phase==='verified'?'verified':state.phase==='unavailable'?'unavailable':null;
   if(phase)this.#publish({...this.#state,phase,notice:state.notice});
  });await proof.start();
 }
 verify(code:string){return this.#proof?.verify(code);}
 async apply(){
  if(this.#state.phase!=='verified'||!this.#proof||!this.#operation)return;
  const operation=this.#operation,receipt=this.#proof.takeReceipt();if(!receipt)return;this.#clearProof();
  const generation=this.#generation;this.#pending=new AbortController();this.#publish({...this.#state,phase:'applying',notice:undefined});
  try{
   const path=this.base+'/apply',response=await this.client.request({method:'POST',path,body:{operation,receipt}},this.#pending.signal);
   if(generation!==this.#generation)return;
   const value=scheduleAuthorizationResponse(path,response.status,response.body);
   if(response.status!==200||value.authorizationRevision!==Number(operation.authorizationRevision)+1||this.action==='authorize'&&(value.jobRevision!==operation.jobRevision||value.expiresAt!==operation.authorizationExpiresAt))throw Error('Unsettled apply');
   this.#operation=undefined;this.#publish({...this.#state,phase:'applied'});
  }catch{
   if(generation!==this.#generation)return;this.#operation=undefined;this.#publish({...this.#state,phase:'unknown',notice:undefined});
   // Readback is advisory: a coarse status cannot prove whether this exact write committed.
   try{const path='/api/scheduler/jobs/'+this.id+'/authorization',response=await this.client.request({method:'GET',path},this.#pending.signal),value=scheduleAuthorizationResponse(path,response.status,response.body);if(generation===this.#generation&&response.status===200)this.#publish({...this.#state,readback:value.status as State['readback']});}catch{}
  }
 }
}
