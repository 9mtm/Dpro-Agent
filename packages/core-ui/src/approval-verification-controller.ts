import type {SessionClient} from './session';
import {APPROVALS_PATH,approvalResponse} from './approvals-contract.js';
type State=Readonly<{phase:'closed'|'loading'|'code'|'verifying'|'verified'|'unavailable'|'spent';notice?:'refused'|'limited'|'expired'|'unavailable'}>;
export class ApprovalVerificationController{
 #state:State=Object.freeze({phase:'closed'});#listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;#expiry:ReturnType<typeof setTimeout>|undefined;#challenge:string|undefined;#receipt:string|undefined;#expiresAt=0;
 constructor(private readonly client:Pick<SessionClient,'request'>,private readonly id:string,private readonly paramsHash:string){}
 getSnapshot=()=>this.#state;
 subscribe=(fn:()=>void)=>{this.#listeners.add(fn);return()=>{this.#listeners.delete(fn);};};
 #publish(state:State){this.#state=Object.freeze(state);this.#listeners.forEach(fn=>fn());}
 cancel(){this.#generation++;this.#pending?.abort();this.#pending=undefined;if(this.#expiry)clearTimeout(this.#expiry);this.#expiry=undefined;this.#challenge=undefined;this.#receipt=undefined;this.#expiresAt=0;this.#publish({phase:'closed'});}
 #expire(){this.cancel();this.#publish({phase:'unavailable',notice:'expired'});}
 #arm(expiresAt:number,max:number){const delay=expiresAt-Date.now();if(!Number.isSafeInteger(expiresAt)||delay<=0||delay>max)throw Error();if(this.#expiry)clearTimeout(this.#expiry);this.#expiresAt=expiresAt;this.#expiry=setTimeout(()=>this.#expire(),delay);}
 async start(){
  this.cancel();const generation=this.#generation;this.#pending=new AbortController();this.#publish({phase:'loading'});
  try{const path=`${APPROVALS_PATH}/${this.id}/verification`,r=await this.client.request({method:'POST',path,body:{paramsHash:this.paramsHash}},this.#pending.signal);if(generation!==this.#generation)return;
   const value=approvalResponse(path,r.status,r.body) as {challenge?:string;expiresAt:number};
   if(r.status!==200||!value.challenge){this.#publish({phase:'unavailable',notice:r.status===429?'limited':'unavailable'});return;}
   this.#arm(value.expiresAt,305000);this.#challenge=value.challenge;this.#publish({phase:'code'});
  }catch{if(generation===this.#generation){this.cancel();this.#publish({phase:'unavailable',notice:'unavailable'});}}
 }
 async verify(code:string){
  if(this.#state.phase!=='code'||!this.#challenge||!/^[0-9]{6}$/.test(code))return;
  if(this.#expiresAt<=Date.now()){this.#expire();return;}
  const generation=this.#generation,challenge=this.#challenge;this.#pending=new AbortController();this.#publish({phase:'verifying'});
  try{const path=`${APPROVALS_PATH}/${this.id}/verification/complete`,r=await this.client.request({method:'POST',path,body:{paramsHash:this.paramsHash,challenge,code}},this.#pending.signal);if(generation!==this.#generation)return;
   const value=approvalResponse(path,r.status,r.body) as {receipt?:string;expiresAt:number;code?:string};
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
