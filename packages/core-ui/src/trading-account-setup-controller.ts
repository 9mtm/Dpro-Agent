import {tradingPaperResponse} from './trading-paper-contract.js';
import type {SessionClient} from './session';
import {allowedTradingAccountSetup,tradingAccountSetupResponse} from './trading-account-setup-contract.js';
type Row=Readonly<Record<string,unknown>>;
type Phase='idle'|'loading'|'ready'|'staging'|'review'|'challenging'|'code'|'verifying'|'verified'|'applying'|'applied'|'unknown'|'unavailable'|'closed';
type State=Readonly<{phase:Phase;accounts:readonly Row[]|null;hasMore:boolean;review:Row|null;recoveryRead:boolean;notice?:'unavailable'|'refused'|'expired'|'limited'}>;
type Client=Pick<SessionClient,'request'|'getSnapshot'|'subscribe'>;
// Only generated review/account identity persists here; no proof values survive controller disposal.
type Uncertain=Readonly<{reviewId:string;accountId:string}>;
const unsettled=new WeakMap<object,Map<string,Uncertain>>();
const base='/api/trading-paper/account-setup',catalogue='/api/trading-paper/accounts';
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
/** Manual create-once account consent only. Does not start a runtime or execute orders. */
export class TradingAccountSetupController{
 #state:State=Object.freeze({phase:'idle',accounts:null,hasMore:false,review:null,recoveryRead:false});
 #listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;#closed=false;
 #epoch:number;#owner:string;#unsubscribe:()=>void=()=>{};#challenge='';#receipt='';#challengeUntil=0;#receiptUntil=0;
 constructor(private readonly client:Client){const s=client.getSnapshot();this.#epoch=s.epoch;this.#owner=s.user?.id??'';this.#unsubscribe=client.subscribe(()=>{if(!this.#authorized())this.close();});if(this.#closed)this.#unsubscribe();else if(!this.#authorized())this.close();}
 getSnapshot=()=>this.#state;
 subscribe=(fn:()=>void)=>{this.#listeners.add(fn);return()=>{this.#listeners.delete(fn);};};
 #authorized(){const s=this.client.getSnapshot();return !this.#closed&&!!this.#owner&&s.epoch===this.#epoch&&s.mode==='live'&&s.phase==='authenticated'&&s.user?.role==='owner'&&s.user.id===this.#owner;}
 #publish(patch:Partial<State>){this.#state=Object.freeze({...this.#state,...patch});this.#listeners.forEach(fn=>fn());}
 #uncertain(){return unsettled.get(this.client)?.get(this.#owner);}
 #remember(review:Row){let owners=unsettled.get(this.client);if(!owners){owners=new Map();unsettled.set(this.client,owners);}owners.set(this.#owner,Object.freeze({reviewId:String(review.id),accountId:String(review.accountId)}));}
 #forget(){unsettled.get(this.client)?.delete(this.#owner);}
 #clearProof(){this.#challenge=this.#receipt='';this.#challengeUntil=this.#receiptUntil=0;}
 #liveReview(){return !!this.#state.review&&Number(this.#state.review.expiresAt)>Date.now()&&Number((this.#state.review.policy as Row).expiresAt)>Date.now();}
 #current(generation:number){return generation===this.#generation&&this.#authorized();}
 #begin(){if(!this.#authorized()){this.close();return null;}this.#pending?.abort();this.#pending=new AbortController();return ++this.#generation;}
 #busy(){return ['loading','staging','challenging','verifying','applying'].includes(this.#state.phase);}
 async #request(method:'GET'|'POST',path:string,body?:unknown){return this.client.request({method,path,...(body===undefined?{}:{body})} as never,this.#pending?.signal);}
 #fail(status?:number){this.#clearProof();this.#publish({phase:this.#uncertain()?'unknown':'unavailable',notice:status===429?'limited':this.#state.review&&!this.#liveReview()?'expired':'unavailable',recoveryRead:false});}
 close(){if(this.#closed)return;this.#closed=true;this.#generation++;this.#pending?.abort();this.#unsubscribe();this.#clearProof();this.#publish({phase:'closed',accounts:null,hasMore:false,review:null,recoveryRead:false,notice:undefined});}
 cancelReview(){if(!this.#authorized()){this.close();return;}this.#generation++;this.#pending?.abort();this.#clearProof();this.#publish({phase:this.#uncertain()?'unknown':'ready',review:null,recoveryRead:false,notice:undefined});}
 async load(){
  if(this.#busy())return;const generation=this.#begin();if(generation===null)return;this.#clearProof();this.#publish({phase:'loading',accounts:null,hasMore:false,review:null,recoveryRead:false,notice:undefined});
  try{const r=await this.#request('GET',catalogue);if(!this.#current(generation))return;if(r.status!==200){this.#fail(r.status);return;}
   const value=tradingPaperResponse(catalogue,r.status,r.body),accounts=freeze(value.accounts as Row[]);
   if(accounts.some(a=>typeof a.accountId!=='string'||/[\x00-\x20\x7f]/.test(a.accountId)))throw Error('account_reference');
   // A catalogue cannot verify immutable policy/profile configuration. Never infer apply success.
   this.#publish({phase:this.#uncertain()?'unknown':'ready',accounts,hasMore:value.hasMore as boolean,recoveryRead:!!this.#uncertain()});
  }catch{if(this.#current(generation))this.#fail();}
 }
 /** Explicit acknowledgement after a fresh COMPLETE account catalogue; never asserts failure or success. */
 acknowledgeUnknown(){if(!this.#authorized()){this.close();return false;}if(this.#state.phase!=='unknown'||!this.#state.recoveryRead||this.#state.hasMore||!this.#state.accounts)return false;this.#forget();this.#publish({phase:'ready',review:null,recoveryRead:false,notice:undefined});return true;}
 async stage(input:unknown){
  if(this.#busy()||this.#uncertain()||!allowedTradingAccountSetup('POST',base+'/reviews',input))return;
  const raw=input as Record<string,unknown>,policy=raw.policy as Record<string,unknown>,execution=raw.execution as Record<string,unknown>;
  const expected={currency:raw.currency,initialCashMinor:raw.initialCashMinor,policy:{expiresAt:policy.expiresAt,symbols:[...policy.symbols as string[]].sort(),maxOrder:policy.maxOrder,maxExposure:policy.maxExposure,maxDailyLoss:policy.maxDailyLoss,maxOrders:policy.maxOrders,cooldownMs:policy.cooldownMs,maxQuoteAgeMs:policy.maxQuoteAgeMs},execution:{feeBps:execution.feeBps,slippageBps:execution.slippageBps}};
  if(Number(expected.policy.expiresAt)<=Date.now()||Number(expected.policy.expiresAt)>Date.now()+30*86400000)return;
  const generation=this.#begin();if(generation===null)return;this.#clearProof();this.#publish({phase:'staging',review:null,recoveryRead:false,notice:undefined});
  try{const path=base+'/reviews',r=await this.#request('POST',path,expected);if(!this.#current(generation))return;if(r.status!==200){this.#fail(r.status);return;}
   const review=tradingAccountSetupResponse(path,r.status,r.body);
   const execution=review.execution as Row;
   if(review.currency!==expected.currency||review.initialCashMinor!==expected.initialCashMinor||JSON.stringify(review.policy)!==JSON.stringify(expected.policy)||execution.feeBps!==expected.execution.feeBps||execution.slippageBps!==expected.execution.slippageBps)throw Error('review_binding');
   if(Number(review.expiresAt)<=Date.now()||Number(review.expiresAt)>Date.now()+300000||Number((review.policy as Row).expiresAt)<=Date.now())throw Error('review_expired');
   this.#publish({phase:'review',review:freeze(review)});
  }catch{if(this.#current(generation))this.#fail();}
 }
 async startVerification(){
  if(this.#state.phase!=='review')return;if(!this.#liveReview()){this.#fail();return;}const generation=this.#begin();if(generation===null)return;this.#publish({phase:'challenging',notice:undefined});
  try{const path=base+'/reviews/'+this.#state.review!.id+'/challenge',r=await this.#request('POST',path,{});if(!this.#current(generation))return;if(r.status!==200){this.#fail(r.status);return;}const value=tradingAccountSetupResponse(path,r.status,r.body);
   if(!this.#liveReview()||Number(value.expiresAt)<=Date.now()||Number(value.expiresAt)>Date.now()+300000)throw Error('expired');this.#challenge=String(value.challenge);this.#challengeUntil=Number(value.expiresAt);this.#publish({phase:'code'});
  }catch{if(this.#current(generation))this.#fail();}
 }
 async verify(code:string){
  if(this.#state.phase!=='code'||code.length!==6||!/^\d{6}$/.test(code))return;if(!this.#liveReview()||this.#challengeUntil<=Date.now()){this.#fail();return;}const generation=this.#begin();if(generation===null)return;this.#publish({phase:'verifying',notice:undefined});
  try{const path=base+'/reviews/'+this.#state.review!.id+'/complete',r=await this.#request('POST',path,{challenge:this.#challenge,code});if(!this.#current(generation))return;
   if(r.status===403&&(r.body as Record<string,unknown>)?.code==='verification_refused'&&this.#liveReview()&&this.#challengeUntil>Date.now()){this.#publish({phase:'code',notice:'refused'});return;}
   if(r.status!==200){this.#fail(r.status);return;}const value=tradingAccountSetupResponse(path,r.status,r.body);if(!this.#liveReview()||Number(value.expiresAt)<=Date.now()||Number(value.expiresAt)>Date.now()+120000)throw Error('expired');
   this.#receipt=String(value.receipt);this.#receiptUntil=Number(value.expiresAt);this.#challenge='';this.#publish({phase:'verified'});
  }catch{if(this.#current(generation))this.#fail();}
 }
 async apply(){
  if(this.#state.phase!=='verified'||this.#uncertain())return;if(!this.#liveReview()||this.#receiptUntil<=Date.now()){this.#fail();return;}const generation=this.#begin();if(generation===null)return;
  const review=this.#state.review!,receipt=this.#receipt;this.#clearProof();this.#remember(review);this.#publish({phase:'applying',recoveryRead:false,notice:undefined});
  try{const path=base+'/reviews/'+review.id+'/apply',r=await this.#request('POST',path,{receipt});if(!this.#current(generation))return;if(r.status!==200)throw Error('uncertain');const value=tradingAccountSetupResponse(path,r.status,r.body),result=value.result as Record<string,unknown>;
   if(value.reviewId!==review.id||result.accountId!==review.accountId||result.policyId!==review.policyId)throw Error('uncertain');
   this.#forget();this.#publish({phase:'applied',accounts:null,hasMore:false});
  }catch{if(this.#current(generation))this.#publish({phase:'unknown',accounts:null,hasMore:false,recoveryRead:false});}
 }
}
