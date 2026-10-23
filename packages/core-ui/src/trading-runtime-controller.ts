import type {SessionClient} from './session';
import {allowedTradingRuntime,tradingRuntimeResponse} from './trading-runtime-contract.js';
type Row=Readonly<Record<string,unknown>>;
type Phase='idle'|'ready'|'staging'|'review'|'challenging'|'code'|'verifying'|'verified'|'applying'|'applied'|'loading'|'revoking'|'revoked'|'unknown'|'unavailable'|'closed';
type State=Readonly<{phase:Phase;review:Row|null;consent:Row|null;reference:Row|null;recoveryRead:boolean;uncertainties:readonly Readonly<{consentId:string;kind:'apply'|'revoke'}>[];notice?:'unavailable'|'refused'|'expired'|'limited'}>;
type Client=Pick<SessionClient,'request'|'getSnapshot'|'subscribe'>;
type Uncertain=Readonly<{consentId:string;kind:'apply'|'revoke';review:Row|null}>;
// Same-client/owner memory only. A process restart cannot preserve this warning; no proof is retained here.
const unsettled=new WeakMap<object,Map<string,Map<string,Uncertain>>>();
const base='/api/trading-paper/runtime';
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
function freeze<T>(v:T):T{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
export class TradingRuntimeController{
 #state:State=Object.freeze({phase:'idle',review:null,consent:null,reference:null,recoveryRead:false,uncertainties:Object.freeze([])});
 #listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;#closed=false;
 #epoch:number;#owner:string;#unsubscribe:()=>void=()=>{};#challenge='';#receipt='';#challengeUntil=0;#receiptUntil=0;#recoveryId='';
 constructor(private readonly client:Client){const s=client.getSnapshot();this.#epoch=s.epoch;this.#owner=s.user?.id??'';this.#unsubscribe=client.subscribe(()=>{if(!this.#authorized())this.close();});if(this.#closed)this.#unsubscribe();else if(!this.#authorized())this.close();else{const unknown=this.#uncertain();if(unknown)this.#state=Object.freeze({...this.#state,phase:'unknown',review:unknown.review,uncertainties:this.#publicUnknowns()});}}
 getSnapshot=()=>this.#state;
 subscribe=(fn:()=>void)=>{this.#listeners.add(fn);return()=>{this.#listeners.delete(fn);};};
 #authorized(){const s=this.client.getSnapshot();return !this.#closed&&!!this.#owner&&s.epoch===this.#epoch&&s.mode==='live'&&s.phase==='authenticated'&&s.user?.role==='owner'&&s.user.id===this.#owner;}
 #publicUnknowns(){return Object.freeze([...this.#unknowns()?.values()??[]].map(u=>Object.freeze({consentId:u.consentId,kind:u.kind})));}
 #publish(patch:Partial<State>){this.#state=Object.freeze({...this.#state,...patch,uncertainties:this.#closed?Object.freeze([]):this.#publicUnknowns()});this.#listeners.forEach(fn=>fn());}
 #unknowns(){return unsettled.get(this.client)?.get(this.#owner);}
 #uncertain(id?:string){return id?this.#unknowns()?.get(id):this.#unknowns()?.values().next().value as Uncertain|undefined;}
 #remember(consentId:string,kind:'apply'|'revoke',review:Row|null){let owners=unsettled.get(this.client);if(!owners){owners=new Map();unsettled.set(this.client,owners);}let records=owners.get(this.#owner);if(!records){records=new Map();owners.set(this.#owner,records);}records.set(consentId,Object.freeze({consentId,kind,review:review??records.get(consentId)?.review??null}));}
 #forget(id:string){this.#unknowns()?.delete(id);}
 #clearProof(){this.#challenge=this.#receipt='';this.#challengeUntil=this.#receiptUntil=0;}
 #liveReview(){return !!this.#state.review&&Number(this.#state.review.expiresAt)>Date.now()&&Number((this.#state.review.limits as Row).expiresAt)>Date.now();}
 #current(g:number){return g===this.#generation&&this.#authorized();}
 #begin(){if(!this.#authorized()){this.close();return null;}this.#pending?.abort();this.#pending=new AbortController();this.#recoveryId='';return ++this.#generation;}
 #busy(){return ['loading','staging','challenging','verifying','applying','revoking'].includes(this.#state.phase);}
 async #request(method:'GET'|'POST',path:string,body?:unknown){return this.client.request({method,path,...(body===undefined?{}:{body})} as never,this.#pending?.signal);}
 #fail(status?:number){this.#clearProof();this.#publish({phase:this.#uncertain()?'unknown':'unavailable',notice:status===429?'limited':this.#state.review&&!this.#liveReview()?'expired':'unavailable',recoveryRead:false});}
 #matches(consent:Row,review:Row){return consent.consentId===review.consentId&&consent.reviewId===review.id&&consent.botId===review.botId&&consent.currency===review.currency&&consent.amountUnit===review.amountUnit&&JSON.stringify(consent.strategy)===JSON.stringify(review.strategy)&&JSON.stringify(consent.limits)===JSON.stringify(review.limits)&&Number(consent.createdAt)<Number(review.expiresAt)&&Number(consent.createdAt)<=Date.now();}
 close(){if(this.#closed)return;this.#closed=true;this.#generation++;this.#pending?.abort();this.#unsubscribe();this.#clearProof();this.#publish({phase:'closed',review:null,consent:null,reference:null,recoveryRead:false,notice:undefined});}
 cancelReview(){if(!this.#authorized()){this.close();return;}this.#generation++;this.#pending?.abort();this.#clearProof();this.#recoveryId='';this.#publish({phase:this.#uncertain()?'unknown':'ready',review:null,consent:null,recoveryRead:false,notice:undefined});}
 async stage(value:unknown){
  if(this.#busy()||this.#uncertain()||!allowedTradingRuntime('POST',base+'/reviews',value))return;
  const v=value as Row,s=v.strategy as Row,l=v.limits as Row,expected=freeze({botId:v.botId,strategy:{kind:s.kind,version:s.version,symbol:s.symbol,side:s.side,amount:s.amount},limits:{expiresAt:l.expiresAt,maxAttempts:l.maxAttempts,cadenceMs:l.cadenceMs}});
  if(Number(l.expiresAt)<=Date.now()||Number(l.expiresAt)>Date.now()+30*86400000)return;
  const g=this.#begin();if(g===null)return;this.#clearProof();this.#publish({phase:'staging',review:null,consent:null,reference:null,recoveryRead:false,notice:undefined});
  try{const path=base+'/reviews',r=await this.#request('POST',path,expected);if(!this.#current(g))return;if(r.status!==200){this.#fail(r.status);return;}const review=tradingRuntimeResponse(path,r.status,r.body);
   if(review.botId!==expected.botId||JSON.stringify(review.strategy)!==JSON.stringify(expected.strategy)||JSON.stringify(review.limits)!==JSON.stringify(expected.limits)||Number(review.expiresAt)<=Date.now()||Number(review.expiresAt)>Date.now()+300000)throw Error('review_binding');
   this.#publish({phase:'review',review:freeze(review)});
  }catch{if(this.#current(g))this.#fail();}
 }
 async startVerification(){
  if(this.#state.phase!=='review')return;if(!this.#liveReview()){this.#fail();return;}const g=this.#begin();if(g===null)return;this.#publish({phase:'challenging',notice:undefined});
  try{const path=base+'/reviews/'+this.#state.review!.id+'/challenge',r=await this.#request('POST',path,{});if(!this.#current(g))return;if(r.status!==200){this.#fail(r.status);return;}const v=tradingRuntimeResponse(path,r.status,r.body);if(!this.#liveReview()||Number(v.expiresAt)<=Date.now()||Number(v.expiresAt)>Date.now()+300000)throw Error('expired');this.#challenge=String(v.challenge);this.#challengeUntil=Number(v.expiresAt);this.#publish({phase:'code'});}catch{if(this.#current(g))this.#fail();}
 }
 async verify(code:string){
  if(this.#state.phase!=='code'||code.length!==6||!/^\d{6}$/.test(code))return;if(!this.#liveReview()||this.#challengeUntil<=Date.now()){this.#fail();return;}const g=this.#begin();if(g===null)return;this.#publish({phase:'verifying',notice:undefined});
  try{const path=base+'/reviews/'+this.#state.review!.id+'/complete',r=await this.#request('POST',path,{challenge:this.#challenge,code});if(!this.#current(g))return;
   if(r.status===403&&(r.body as Row)?.code==='verification_refused'&&this.#liveReview()&&this.#challengeUntil>Date.now()){this.#publish({phase:'code',notice:'refused'});return;}
   if(r.status!==200){this.#fail(r.status);return;}const v=tradingRuntimeResponse(path,r.status,r.body);if(!this.#liveReview()||Number(v.expiresAt)<=Date.now()||Number(v.expiresAt)>Date.now()+120000)throw Error('expired');this.#receipt=String(v.receipt);this.#receiptUntil=Number(v.expiresAt);this.#challenge='';this.#publish({phase:'verified'});
  }catch{if(this.#current(g))this.#fail();}
 }
 async apply(){
  if(this.#state.phase!=='verified'||this.#uncertain())return;if(!this.#liveReview()||this.#receiptUntil<=Date.now()){this.#fail();return;}const g=this.#begin();if(g===null)return;
  const review=this.#state.review!,receipt=this.#receipt,id=String(review.consentId);this.#clearProof();this.#remember(id,'apply',review);this.#publish({phase:'applying',recoveryRead:false,notice:undefined});
  try{const path=base+'/reviews/'+review.id+'/apply',r=await this.#request('POST',path,{receipt});if(!this.#current(g))return;if(r.status!==200)throw Error('uncertain');const consent=tradingRuntimeResponse(path,r.status,r.body);if(!this.#matches(consent,review))throw Error('uncertain');this.#forget(id);this.#publish({phase:this.#uncertain()?'unknown':'applied',consent:freeze(consent)});}catch{if(this.#current(g))this.#publish({phase:'unknown',consent:null,recoveryRead:false});}
 }
 /** Minimal reference discovery is never a full historical read, grant or recovery acknowledgment. */
 async discoverConsent(botId:string){
  if(!uuid(botId)||this.#busy()&&this.#state.phase!=='loading')return;
  const g=this.#begin();if(g===null)return;this.#clearProof();this.#publish({phase:'loading',reference:null,consent:null,recoveryRead:false,notice:undefined});
  try{
   const path=base+'/bots/'+botId+'/consent-reference',r=await this.#request('GET',path);if(!this.#current(g))return;
   if(r.status!==200){this.#fail(r.status);return;}
   const reference=freeze(tradingRuntimeResponse(path,r.status,r.body));if(reference.botId!==botId||Number(reference.createdAt)>Date.now())throw Error('reference_binding');
   this.#publish({phase:this.#uncertain()?'unknown':'ready',reference,recoveryRead:false});
  }catch{if(this.#current(g))this.#fail();}
 }
 async loadConsent(id:string){
  if(this.#busy()||!uuid(id))return;const reference=this.#state.reference?.consentId===id?this.#state.reference:null;const g=this.#begin();if(g===null)return;this.#clearProof();this.#publish({phase:'loading',consent:null,recoveryRead:false,notice:undefined});
  try{const path=base+'/consents/'+id,r=await this.#request('GET',path);if(!this.#current(g))return;if(r.status!==200){this.#fail(r.status);return;}const consent=freeze(tradingRuntimeResponse(path,r.status,r.body)),unknown=this.#uncertain(id);
   if(reference&&(consent.botId!==reference.botId||consent.createdAt!==reference.createdAt||reference.status==='revoked'&&consent.status!=='revoked'))throw Error('reference_binding');
   if(Number(consent.createdAt)>Date.now()||consent.revokedAt!==null&&Number(consent.revokedAt)>Date.now()||unknown?.review&&!this.#matches(consent,unknown.review))throw Error('recovery_binding');
   const recovered=!!unknown&&(unknown.kind==='apply'||consent.status==='revoked');this.#recoveryId=recovered?id:'';this.#publish({phase:this.#uncertain()?'unknown':'ready',consent,recoveryRead:recovered});
  }catch{if(this.#current(g))this.#fail();}
 }
 acknowledgeUnknown(){if(!this.#authorized()){this.close();return false;}if(this.#state.phase!=='unknown'||!this.#state.recoveryRead||!this.#recoveryId||!this.#uncertain(this.#recoveryId))return false;this.#forget(this.#recoveryId);this.#recoveryId='';this.#publish({phase:this.#uncertain()?'unknown':'ready',review:null,recoveryRead:false,notice:undefined});return true;}
 /** Explicit one-way operation. It intentionally interrupts reads/proof/apply and requires no history read or factor state. */
 async revoke(id:string){
  if(!uuid(id))return;const reference=this.#state.reference?.consentId===id?this.#state.reference:null;const g=this.#begin();if(g===null)return;const review=this.#state.review?.consentId===id?this.#state.review:null;this.#clearProof();this.#remember(id,'revoke',review);this.#publish({phase:'revoking',reference:reference?null:this.#state.reference,recoveryRead:false,notice:undefined});
  try{const path=base+'/consents/'+id+'/revoke',r=await this.#request('POST',path,{});if(!this.#current(g))return;if(r.status!==200)throw Error('uncertain');const consent=freeze(tradingRuntimeResponse(path,r.status,r.body));if(Number(consent.revokedAt)>Date.now())throw Error('uncertain');this.#forget(id);this.#publish({phase:this.#uncertain()?'unknown':'revoked',consent,reference:reference?freeze({...reference,status:'revoked'}):this.#state.reference,review:null,recoveryRead:false});}catch{if(this.#current(g))this.#publish({phase:'unknown',consent:null,recoveryRead:false});}
 }
}
