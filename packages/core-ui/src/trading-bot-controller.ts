import type {SessionClient} from './session';
import {allowedTradingBot,tradingBotResponse} from './trading-bot-contract.js';
type Row=Readonly<Record<string,unknown>>;
type Phase='idle'|'loading'|'ready'|'staging'|'review'|'challenging'|'code'|'verifying'|'verified'|'applying'|'applied'|'unknown'|'unavailable'|'closed';
type State=Readonly<{phase:Phase;bots:readonly Row[]|null;hasMore:boolean;review:Row|null;recoveryRead:boolean;notice?:'unavailable'|'refused'|'expired'|'limited'|'stop_unconfirmed'}>;
type Client=Pick<SessionClient,'request'|'getSnapshot'|'subscribe'>;
type Uncertain=Readonly<{reviewId:string;botId:string;expected:Row}>;
// Same-client/owner uncertainty survives controller disposal. No proof, code or receipt is retained here.
const unsettled=new WeakMap<object,Map<string,Uncertain>>();
const base='/api/trading-paper/bots';
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
/** Session-bound manual management. No tick generation, scheduler or automatic activation. */
export class TradingBotController{
 #state:State=Object.freeze({phase:'idle',bots:null,hasMore:false,review:null,recoveryRead:false});
 #listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;#management=new Set<AbortController>();#stopHints=new Map<string,'stopped'|'revoked'>();
 #closed=false;#epoch:number;#owner:string;#unsubscribe:()=>void=()=>{};#challenge='';#receipt='';#challengeUntil=0;#receiptUntil=0;
 constructor(private readonly client:Client){const s=client.getSnapshot();this.#epoch=s.epoch;this.#owner=s.user?.id??'';this.#unsubscribe=client.subscribe(()=>{if(!this.#authorized())this.close();});if(this.#closed)this.#unsubscribe();else if(!this.#authorized())this.close();}
 getSnapshot=()=>this.#state;
 subscribe=(fn:()=>void)=>{this.#listeners.add(fn);return()=>{this.#listeners.delete(fn);};};
 #authorized(){const s=this.client.getSnapshot();return !this.#closed&&!!this.#owner&&s.epoch===this.#epoch&&s.phase==='authenticated'&&s.user?.role==='owner'&&s.user.id===this.#owner;}
 #publish(patch:Partial<State>){this.#state=Object.freeze({...this.#state,...patch});this.#listeners.forEach(fn=>fn());}
 #uncertain(){return unsettled.get(this.client)?.get(this.#owner);}
 #remember(value:Uncertain){let owners=unsettled.get(this.client);if(!owners){owners=new Map();unsettled.set(this.client,owners);}owners.set(this.#owner,value);}
 #forget(){unsettled.get(this.client)?.delete(this.#owner);}
 #withStopHint(bot:Row):Row{const hint=this.#stopHints.get(String(bot.botId));return hint&&bot.status!=='revoked'?freeze({...bot,status:hint}):bot;}
 #clearProof(){this.#challenge=this.#receipt='';this.#challengeUntil=this.#receiptUntil=0;}
 #liveReview(){return !!this.#state.review&&Number(this.#state.review.expiresAt)>Date.now()&&Number(this.#state.review.botExpiresAt)>Date.now();}
 #current(generation:number){return generation===this.#generation&&this.#authorized();}
 #begin(){if(!this.#authorized()){this.close();return null;}this.#pending?.abort();this.#pending=new AbortController();return ++this.#generation;}
 #busy(){return ['loading','staging','challenging','verifying','applying'].includes(this.#state.phase);}
 async #request(method:'GET'|'POST',path:string,body?:unknown){return this.client.request({method,path,...(body===undefined?{}:{body})} as never,this.#pending?.signal);}
 #fail(status?:number){this.#clearProof();this.#publish({phase:this.#uncertain()?'unknown':'unavailable',notice:status===429?'limited':this.#state.review&&!this.#liveReview()?'expired':'unavailable',recoveryRead:false});}
 close(){if(this.#closed)return;this.#closed=true;this.#generation++;this.#pending?.abort();this.#management.forEach(c=>c.abort());this.#management.clear();this.#stopHints.clear();this.#unsubscribe();this.#clearProof();this.#publish({phase:'closed',bots:null,hasMore:false,review:null,recoveryRead:false,notice:undefined});}
 cancelReview(){if(!this.#authorized()){this.close();return;}this.#generation++;this.#pending?.abort();this.#clearProof();this.#publish({phase:this.#uncertain()?'unknown':'ready',review:null,recoveryRead:false,notice:undefined});}
 async load(){
  if(this.#busy())return;const generation=this.#begin();if(generation===null)return;this.#clearProof();this.#publish({phase:'loading',bots:null,hasMore:false,review:null,recoveryRead:false,notice:undefined});
  try{const r=await this.#request('GET',base);if(!this.#current(generation))return;if(r.status!==200){this.#fail(r.status);return;}
   const result=tradingBotResponse(base,r.status,r.body),bots=Object.freeze((result.bots as Record<string,unknown>[]).map(b=>this.#withStopHint(freeze(b)))),pending=this.#uncertain();
   const found=pending&&bots.find(b=>b.botId===pending.botId&&Object.entries(pending.expected).every(([key,value])=>b[key]===value));
   if(found)this.#forget();this.#publish({phase:pending&&!found?'unknown':found?'applied':'ready',bots,hasMore:result.hasMore as boolean,recoveryRead:!!pending&&!found});
  }catch{if(this.#current(generation))this.#fail();}
 }
 /** Explicit acknowledgement after a fresh COMPLETE list; absence is never described as proof of failure. */
 acknowledgeUnknown(){if(!this.#authorized()){this.close();return false;}if(this.#state.phase!=='unknown'||!this.#state.recoveryRead||this.#state.hasMore||!this.#state.bots)return false;this.#forget();this.#publish({phase:'ready',review:null,recoveryRead:false,notice:undefined});return true;}
 async stage(input:unknown){
  if(this.#busy()||this.#uncertain())return;if(!allowedTradingBot('POST',base+'/reviews',input))return;
  const generation=this.#begin();if(generation===null)return;const expected={...input as Record<string,unknown>};this.#clearProof();this.#publish({phase:'staging',review:null,recoveryRead:false,notice:undefined});
  try{const path=base+'/reviews',r=await this.#request('POST',path,expected);if(!this.#current(generation))return;if(r.status!==200){this.#fail(r.status);return;}
   const review=tradingBotResponse(path,r.status,r.body);
   for(const [key,value] of Object.entries(expected)){const returned=key==='expiresAt'?review.botExpiresAt:review[key];if(returned!==value)throw Error('review_binding');}
   if(Number(review.expiresAt)<=Date.now()||Number(review.expiresAt)>Date.now()+300000||Number(review.botExpiresAt)<=Date.now())throw Error('review_expired');
   this.#publish({phase:'review',review:freeze(review)});
  }catch{if(this.#current(generation))this.#fail();}
 }
 async startVerification(){
  if(this.#state.phase!=='review')return;if(!this.#liveReview()){this.#fail();return;}const generation=this.#begin();if(generation===null)return;this.#publish({phase:'challenging',notice:undefined});
  try{const path=base+'/reviews/'+this.#state.review!.id+'/challenge',r=await this.#request('POST',path,{});if(!this.#current(generation))return;if(r.status!==200){this.#fail(r.status);return;}const value=tradingBotResponse(path,r.status,r.body);
   if(!this.#liveReview()||Number(value.expiresAt)<=Date.now()||Number(value.expiresAt)>Date.now()+300000)throw Error('expired');this.#challenge=String(value.challenge);this.#challengeUntil=Number(value.expiresAt);this.#publish({phase:'code'});
  }catch{if(this.#current(generation))this.#fail();}
 }
 async verify(code:string){
  if(this.#state.phase!=='code'||!/^\d{6}$/.test(code))return;if(!this.#liveReview()||this.#challengeUntil<=Date.now()){this.#fail();return;}const generation=this.#begin();if(generation===null)return;this.#publish({phase:'verifying',notice:undefined});
  try{const path=base+'/reviews/'+this.#state.review!.id+'/complete',r=await this.#request('POST',path,{challenge:this.#challenge,code});if(!this.#current(generation))return;
   if(r.status===403&&(r.body as Record<string,unknown>)?.code==='verification_refused'&&this.#liveReview()&&this.#challengeUntil>Date.now()){this.#publish({phase:'code',notice:'refused'});return;}
   if(r.status!==200){this.#fail(r.status);return;}const value=tradingBotResponse(path,r.status,r.body);if(!this.#liveReview()||Number(value.expiresAt)<=Date.now()||Number(value.expiresAt)>Date.now()+120000)throw Error('expired');
   this.#receipt=String(value.receipt);this.#receiptUntil=Number(value.expiresAt);this.#challenge='';this.#publish({phase:'verified'});
  }catch{if(this.#current(generation))this.#fail();}
 }
 async apply(){
  if(this.#state.phase!=='verified'||this.#uncertain())return;if(!this.#liveReview()||this.#receiptUntil<=Date.now()){this.#fail();return;}const generation=this.#begin();if(generation===null)return;
  const review=this.#state.review!,receipt=this.#receipt;this.#clearProof();
  const expected=freeze(Object.fromEntries(['accountId','policyId','policyRevision','appRevision','currency','maxSuccessfulTicks','cooldownMs'].map(k=>[k,review[k]]).concat([['expiresAt',review.botExpiresAt]])));
  this.#remember(freeze({reviewId:String(review.id),botId:String(review.botId),expected}));this.#publish({phase:'applying',recoveryRead:false,notice:undefined});
  try{const path=base+'/reviews/'+review.id+'/apply',r=await this.#request('POST',path,{receipt});if(!this.#current(generation))return;if(r.status!==200)throw Error('uncertain');const value=tradingBotResponse(path,r.status,r.body);
   if(value.botId!==review.botId||value.reviewId!==review.id)throw Error('uncertain');this.#forget();this.#publish({phase:'applied'});
  }catch{if(this.#current(generation))this.#publish({phase:'unknown',recoveryRead:false});}
 }
 /** Risk-reducing commands stay independent of proof/list availability and in-flight review work. */
 async stop(botId:string,action:'stop'|'revoke'='stop'){
  if(!this.#authorized()){this.close();return false;}if(!id(botId)||!['stop','revoke'].includes(action))return false;
  const pending=new AbortController();this.#management.add(pending);
  try{const path=base+'/'+encodeURIComponent(botId)+'/'+action,r=await this.client.request({method:'POST',path,body:{}} as never,pending.signal);if(!this.#authorized())return false;if(r.status!==200)throw Error('unconfirmed');const value=tradingBotResponse(path,r.status,r.body);if(value.botId!==botId)throw Error('unconfirmed');
   const status=value.status as 'stopped'|'revoked';if(status==='revoked'||!this.#stopHints.has(botId))this.#stopHints.set(botId,status);
   const bots=this.#state.bots?.map(b=>b.botId===botId?this.#withStopHint(b):b)??null;this.#publish({bots:bots?Object.freeze(bots):null,notice:undefined});return true;
  }catch{if(this.#authorized())this.#publish({notice:'stop_unconfirmed'});return false;}finally{this.#management.delete(pending);}
 }
}
