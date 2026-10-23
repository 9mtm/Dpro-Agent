import type {SessionClient} from './session';
import {allowedTradingInstall,tradingInstallResponse} from './trading-install-contract.js';
type Row=Readonly<Record<string,unknown>>;
type Phase='idle'|'loading'|'ready'|'staging'|'review'|'challenging'|'code'|'verifying'|'verified'|'applying'|'applied'|'unknown'|'unavailable'|'closed';
type State=Readonly<{phase:Phase;installation:Row|null;review:Row|null;recoveryRead:boolean;notice?:'unavailable'|'refused'|'expired'|'limited'}>;
type Client=Pick<SessionClient,'request'|'getSnapshot'|'subscribe'>;
// Only public review identity persists here; verification secrets never survive controller disposal.
const unsettled=new WeakMap<object,Set<string>>();
const base='/api/trading-paper/installation';
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
/** Manual installation consent only. Does not start a runtime, seed accounts or execute orders. */
export class TradingInstallController{
 #state:State=Object.freeze({phase:'idle',installation:null,review:null,recoveryRead:false});
 #listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;#closed=false;
 #epoch:number;#owner:string;#unsubscribe:()=>void=()=>{};#challenge='';#receipt='';#challengeUntil=0;#receiptUntil=0;
 constructor(private readonly client:Client){const s=client.getSnapshot();this.#epoch=s.epoch;this.#owner=s.user?.id??'';this.#unsubscribe=client.subscribe(()=>{if(!this.#authorized())this.close();});if(this.#closed)this.#unsubscribe();else if(!this.#authorized())this.close();}
 getSnapshot=()=>this.#state;
 subscribe=(fn:()=>void)=>{this.#listeners.add(fn);return()=>{this.#listeners.delete(fn);};};
 #authorized(){const s=this.client.getSnapshot();return !this.#closed&&!!this.#owner&&s.epoch===this.#epoch&&s.mode==='live'&&s.phase==='authenticated'&&s.user?.role==='owner'&&s.user.id===this.#owner;}
 #publish(patch:Partial<State>){this.#state=Object.freeze({...this.#state,...patch});this.#listeners.forEach(fn=>fn());}
 #uncertain(){return unsettled.get(this.client)?.has(this.#owner)===true;}
 #remember(){let owners=unsettled.get(this.client);if(!owners){owners=new Set();unsettled.set(this.client,owners);}owners.add(this.#owner);}
 #forget(){unsettled.get(this.client)?.delete(this.#owner);}
 #clearProof(){this.#challenge=this.#receipt='';this.#challengeUntil=this.#receiptUntil=0;}
 #liveReview(){return !!this.#state.review&&Number(this.#state.review.expiresAt)>Date.now();}
 #current(generation:number){return generation===this.#generation&&this.#authorized();}
 #begin(){if(!this.#authorized()){this.close();return null;}this.#pending?.abort();this.#pending=new AbortController();return ++this.#generation;}
 #busy(){return ['loading','staging','challenging','verifying','applying'].includes(this.#state.phase);}
 async #request(method:'GET'|'POST',path:string,body?:unknown){return this.client.request({method,path,...(body===undefined?{}:{body})} as never,this.#pending?.signal);}
 #fail(status?:number){this.#clearProof();this.#publish({phase:this.#uncertain()?'unknown':'unavailable',notice:status===429?'limited':this.#state.review&&!this.#liveReview()?'expired':'unavailable',recoveryRead:false});}
 close(){if(this.#closed)return;this.#closed=true;this.#generation++;this.#pending?.abort();this.#unsubscribe();this.#clearProof();this.#publish({phase:'closed',installation:null,review:null,recoveryRead:false,notice:undefined});}
 cancelReview(){if(!this.#authorized()){this.close();return;}this.#generation++;this.#pending?.abort();this.#clearProof();this.#publish({phase:this.#uncertain()?'unknown':'ready',review:null,recoveryRead:false,notice:undefined});}
 async load(){
  if(this.#busy())return;const generation=this.#begin();if(generation===null)return;this.#clearProof();this.#publish({phase:'loading',installation:null,review:null,recoveryRead:false,notice:undefined});
  try{const r=await this.#request('GET',base);if(!this.#current(generation))return;if(r.status!==200){this.#fail(r.status);return;}
   const installation=freeze(tradingInstallResponse(base,r.status,r.body));
   // Current status alone cannot identify the outcome of a lost operation response.
   this.#publish({phase:this.#uncertain()?'unknown':'ready',installation,recoveryRead:this.#uncertain()});
  }catch{if(this.#current(generation))this.#fail();}
 }
 /** Explicit acknowledgement of fresh status; never asserts that the uncertain request failed. */
 acknowledgeUnknown(){if(!this.#authorized()){this.close();return false;}if(this.#state.phase!=='unknown'||!this.#state.recoveryRead||!this.#state.installation)return false;this.#forget();this.#publish({phase:'ready',review:null,recoveryRead:false,notice:undefined});return true;}
 async stage(input:unknown){
  if(this.#busy()||this.#uncertain()||!allowedTradingInstall('POST',base+'/reviews',input))return;
  const raw=input as Record<string,unknown>,expected={action:raw.action,expectedRevision:raw.expectedRevision,manifestDigest:raw.manifestDigest,capabilities:[...raw.capabilities as string[]].sort()};
  const generation=this.#begin();if(generation===null)return;this.#clearProof();this.#publish({phase:'staging',review:null,recoveryRead:false,notice:undefined});
  try{const path=base+'/reviews',r=await this.#request('POST',path,expected);if(!this.#current(generation))return;if(r.status!==200){this.#fail(r.status);return;}
   const review=tradingInstallResponse(path,r.status,r.body);
   if(review.action!==expected.action||review.expectedRevision!==expected.expectedRevision||review.manifestDigest!==expected.manifestDigest||JSON.stringify(review.capabilities)!==JSON.stringify(expected.capabilities))throw Error('review_binding');
   if(Number(review.expiresAt)<=Date.now()||Number(review.expiresAt)>Date.now()+300000)throw Error('review_expired');
   this.#publish({phase:'review',review:freeze(review)});
  }catch{if(this.#current(generation))this.#fail();}
 }
 async startVerification(){
  if(this.#state.phase!=='review')return;if(!this.#liveReview()){this.#fail();return;}const generation=this.#begin();if(generation===null)return;this.#publish({phase:'challenging',notice:undefined});
  try{const path=base+'/reviews/'+this.#state.review!.id+'/challenge',r=await this.#request('POST',path,{});if(!this.#current(generation))return;if(r.status!==200){this.#fail(r.status);return;}const value=tradingInstallResponse(path,r.status,r.body);
   if(!this.#liveReview()||Number(value.expiresAt)<=Date.now()||Number(value.expiresAt)>Date.now()+300000)throw Error('expired');this.#challenge=String(value.challenge);this.#challengeUntil=Number(value.expiresAt);this.#publish({phase:'code'});
  }catch{if(this.#current(generation))this.#fail();}
 }
 async verify(code:string){
  if(this.#state.phase!=='code'||code.length!==6||!/^\d{6}$/.test(code))return;if(!this.#liveReview()||this.#challengeUntil<=Date.now()){this.#fail();return;}const generation=this.#begin();if(generation===null)return;this.#publish({phase:'verifying',notice:undefined});
  try{const path=base+'/reviews/'+this.#state.review!.id+'/complete',r=await this.#request('POST',path,{challenge:this.#challenge,code});if(!this.#current(generation))return;
   if(r.status===403&&(r.body as Record<string,unknown>)?.code==='verification_refused'&&this.#liveReview()&&this.#challengeUntil>Date.now()){this.#publish({phase:'code',notice:'refused'});return;}
   if(r.status!==200){this.#fail(r.status);return;}const value=tradingInstallResponse(path,r.status,r.body);if(!this.#liveReview()||Number(value.expiresAt)<=Date.now()||Number(value.expiresAt)>Date.now()+120000)throw Error('expired');
   this.#receipt=String(value.receipt);this.#receiptUntil=Number(value.expiresAt);this.#challenge='';this.#publish({phase:'verified'});
  }catch{if(this.#current(generation))this.#fail();}
 }
 async apply(){
  if(this.#state.phase!=='verified'||this.#uncertain())return;if(!this.#liveReview()||this.#receiptUntil<=Date.now()){this.#fail();return;}const generation=this.#begin();if(generation===null)return;
  const review=this.#state.review!,receipt=this.#receipt;this.#clearProof();this.#remember();this.#publish({phase:'applying',recoveryRead:false,notice:undefined});
  try{const path=base+'/reviews/'+review.id+'/apply',r=await this.#request('POST',path,{receipt});if(!this.#current(generation))return;if(r.status!==200)throw Error('uncertain');const value=tradingInstallResponse(path,r.status,r.body),result=value.result as Record<string,unknown>;
   const expectedStatus=review.action==='install'?'provisioned':review.action==='disable'?'disabled':'removed_retained';
   if(value.reviewId!==review.id||result.status!==expectedStatus||result.revision!==Number(review.expectedRevision)+1)throw Error('uncertain');
   this.#forget();this.#publish({phase:'applied',installation:null});
  }catch{if(this.#current(generation))this.#publish({phase:'unknown',installation:null,recoveryRead:false});}
 }
}
