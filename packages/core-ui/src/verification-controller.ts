import type {SessionClient} from './session';
import {VERIFICATION_PATH as P,verificationResponse} from './verification-contract.js';
type State=Readonly<{phase:'loading'|'ready'|'working'|'unavailable';enabled?:boolean;setup?:Readonly<{secret:string;expiresAt:number}>;notice?:'refused'|'limited'|'unknown'|'expired'}>;
export class VerificationController{
 #state:State=Object.freeze({phase:'loading'});#listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;#expiry:ReturnType<typeof setTimeout>|undefined;
 constructor(private readonly client:Pick<SessionClient,'request'>){}
 getSnapshot=()=>this.#state;
 subscribe=(fn:()=>void)=>{this.#listeners.add(fn);return()=>{this.#listeners.delete(fn);};};
 #publish(state:State){this.#state=Object.freeze(state);this.#listeners.forEach(fn=>fn());}
 cancel(){if(this.#expiry)clearTimeout(this.#expiry);this.#expiry=undefined;this.#generation++;this.#pending?.abort();this.#pending=undefined;this.#publish({phase:'loading'});}
 async load(){
  this.cancel();const generation=this.#generation;this.#pending=new AbortController();
  try{const result=await this.client.request({method:'GET',path:P},this.#pending.signal);if(generation!==this.#generation)return;
   const value=verificationResponse(P,result.status,result.body);
   if(result.status!==200||!value||!('enabled'in value))throw Error();this.#publish({phase:'ready',enabled:value.enabled});
  }catch{if(generation===this.#generation)this.#publish({phase:'unavailable'});}
 }
 async act(action:'enroll'|'confirm'|'disable',password:string,code?:string){
  if(this.#state.phase!=='ready'||this.#state.enabled===undefined)return;
  if((action==='enroll'&&this.#state.enabled)||(action==='confirm'&&!this.#state.setup)||(action==='disable'&&!this.#state.enabled))return;
  if(action==='confirm'&&this.#state.setup!.expiresAt<=Date.now()){this.#publish({phase:'ready',enabled:false,notice:'expired'});return;}
  const prior=this.#state,generation=this.#generation;this.#pending=new AbortController();this.#publish({...prior,phase:'working',notice:undefined});
  try{
   const path=P+'/'+action,result=await this.client.request({method:'POST',path,body:{password,...(action==='enroll'?{}:{code})}},this.#pending.signal);
   if(generation!==this.#generation)return;
   const value=verificationResponse(path,result.status,result.body);
   if(result.status!==200||!value){if(result.status===429||result.status===403)this.#publish({...prior,phase:'ready',notice:result.status===429?'limited':'refused'});else{this.cancel();this.#publish({phase:'unavailable',notice:'unknown'});}return;}
   if(action==='enroll'&&'secret'in value){
    const delay=value.expiresAt-Date.now();if(delay<=0||delay>605000)throw Error();
    this.#publish({phase:'ready',enabled:false,setup:Object.freeze({secret:value.secret,expiresAt:value.expiresAt})});
    this.#expiry=setTimeout(()=>{if(generation!==this.#generation)return;if(this.#state.phase==='working'){this.cancel();this.#publish({phase:'unavailable',notice:'unknown'});}else this.#publish({phase:'ready',enabled:false,notice:'expired'});},delay);return;}
   this.cancel(); // SessionClient already moved to recovery acknowledgment/sign-in.
  }catch{if(generation===this.#generation){this.cancel();this.#publish({phase:'unavailable',notice:'unknown'});}}
 }
}
