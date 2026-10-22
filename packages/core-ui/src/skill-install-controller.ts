import type {SessionClient} from './session';
type Source=Readonly<{commit:string;sourcePath:string;targetName:string}>;
type Review=Readonly<{name:string;description:string;version:string;content:string;updating:boolean;expiresAt:number}>;
type Phase='closed'|'loading'|'review'|'loading-code'|'code'|'verifying'|'verified'|'applying'|'applied'|'unknown'|'unavailable';
type State=Readonly<{phase:Phase;review:Review|null;notice?:'refused'|'limited'|'expired'|'unavailable'}>;
const rec=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>rec(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hex=(v:unknown,n=64):v is string=>typeof v==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const token=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
const int=(v:unknown,min=0,max=2147483646):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const future=(v:unknown):v is number=>int(v,Date.now()+1,Date.now()+600000);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(v);
/** Manual selected-source review; proof completion never invokes installation. */
export class SkillInstallController{
 #state:State=Object.freeze({phase:'closed',review:null});#listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;#id='';#challenge='';#receipt='';#challengeUntil=0;#receiptUntil=0;#revision=0;#hash='';
 readonly source:Source;
 constructor(private readonly client:Pick<SessionClient,'request'>,source:Source){
  if(!exact(source,['commit','sourcePath','targetName'])||!hex(source.commit,40)||/^0+$/.test(source.commit)||typeof source.sourcePath!=='string'||source.sourcePath.length>400||!/^skills\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(source.sourcePath)||typeof source.targetName!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(source.targetName)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(source.targetName))throw Error('Invalid skill source');
  this.source=Object.freeze({...source});
 }
 getSnapshot=()=>this.#state;
 subscribe=(fn:()=>void)=>{this.#listeners.add(fn);return()=>{this.#listeners.delete(fn);};};
 #publish(s:State){this.#state=Object.freeze(s);this.#listeners.forEach(fn=>fn());}
 cancel(){this.#generation++;this.#pending?.abort();this.#pending=undefined;this.#id=this.#challenge=this.#receipt=this.#hash='';this.#revision=this.#challengeUntil=this.#receiptUntil=0;this.#publish({phase:'closed',review:null});}
 #live(){return !!this.#state.review&&this.#state.review.expiresAt>Date.now();}
 async #request(method:'GET'|'POST',suffix:string,body?:unknown){this.#pending=new AbortController();return this.client.request({method,path:'/api/skills/reviewed-installs'+suffix,...(body===undefined?{}:{body})} as never,this.#pending.signal);}
 #fail(status?:number){this.#challenge=this.#receipt='';this.#publish({...this.#state,phase:'unavailable',notice:status===429?'limited':!this.#live()&&this.#state.review?'expired':'unavailable'});}
 async load(){
  if(this.#state.phase!=='closed')return;const g=this.#generation;this.#publish({phase:'loading',review:null});
  try{
   const r=await this.#request('POST','/stage',this.source);if(g!==this.#generation)return;if(r.status!==200){this.#fail(r.status);return;}const s=r.body;if(!exact(s,['id','expiresAt'])||!uuid(s.id)||!future(s.expiresAt))throw Error('protocol');this.#id=s.id;
   const response=await this.#request('GET','/'+this.#id);if(g!==this.#generation)return;if(response.status!==200){this.#fail(response.status);return;}
   const v=response.body;if(!exact(v,['id','expiresAt','reviewHash','operation','files'])||v.id!==s.id||v.expiresAt!==s.expiresAt||!future(v.expiresAt)||!hex(v.reviewHash))throw Error('protocol');
   const o=v.operation;if(!exact(o,['kind','version','source','target','contentHash','byteLength','effect','enabled','bundle'])||o.kind!=='skill_install'||o.version!==1||o.effect!=='store-markdown-only'||o.enabled!==false||!hex(o.contentHash)||!int(o.byteLength,1,200000))throw Error('protocol');
   if(!exact(o.source,['provider','commit','path'])||o.source.provider!=='anthropic-skills'||o.source.commit!==this.source.commit||o.source.path!==this.source.sourcePath)throw Error('protocol');
   const t=o.target;if(!exact(t,['name','expectedRevision','previousContentHash'])||t.name!==this.source.targetName||!int(t.expectedRevision)||!(t.expectedRevision===0?t.previousContentHash===null:hex(t.previousContentHash)))throw Error('protocol');
   const b=o.bundle;if(!exact(b,['hash','name','description','version','redactions','byteLength'])||!hex(b.hash)||b.name!==t.name||!text(b.description,2000)||!text(b.version,80)||!int(b.redactions)||!int(b.byteLength,1,200000)||!Array.isArray(v.files)||v.files.length!==1)throw Error('protocol');
   const f=v.files[0];if(!exact(f,['path','content'])||f.path!=='SKILL.md'||!text(f.content,200000)||new TextEncoder().encode(f.content).length!==b.byteLength)throw Error('protocol');
   this.#revision=t.expectedRevision;this.#hash=b.hash;this.#publish({phase:'review',review:Object.freeze({name:this.source.targetName,description:b.description,version:b.version,content:f.content,updating:t.expectedRevision>0,expiresAt:v.expiresAt})});
  }catch{if(g===this.#generation)this.#fail();}
 }
 async startVerification(){
  if(this.#state.phase!=='review')return;if(!this.#live()){this.#fail();return;}const g=this.#generation;this.#publish({...this.#state,phase:'loading-code'});
  try{const r=await this.#request('POST','/'+this.#id+'/challenge',{});if(g!==this.#generation)return;if(r.status!==200){this.#fail(r.status);return;}if(!exact(r.body,['challenge','expiresAt'])||!token(r.body.challenge)||!future(r.body.expiresAt)||!this.#live())throw Error('protocol');this.#challenge=r.body.challenge;this.#challengeUntil=r.body.expiresAt;this.#publish({...this.#state,phase:'code'});}catch{if(g===this.#generation)this.#fail();}
 }
 async verify(code:string){
  if(this.#state.phase!=='code'||!/^\d{6}$/.test(code))return;if(!this.#live()||this.#challengeUntil<=Date.now()){this.#fail();return;}const g=this.#generation;this.#publish({...this.#state,phase:'verifying',notice:undefined});
  try{const r=await this.#request('POST','/'+this.#id+'/complete',{challenge:this.#challenge,code});if(g!==this.#generation)return;if(r.status===403&&rec(r.body)&&r.body.code==='verification_refused'&&this.#live()&&this.#challengeUntil>Date.now()){this.#publish({...this.#state,phase:'code',notice:'refused'});return;}if(r.status!==200){this.#fail(r.status);return;}if(!exact(r.body,['receipt','expiresAt'])||!token(r.body.receipt)||!future(r.body.expiresAt)||!this.#live())throw Error('protocol');this.#receipt=r.body.receipt;this.#receiptUntil=r.body.expiresAt;this.#challenge='';this.#publish({...this.#state,phase:'verified'});}catch{if(g===this.#generation)this.#fail();}
 }
 async apply(){
  if(this.#state.phase!=='verified')return;if(!this.#live()||this.#receiptUntil<=Date.now()){this.#fail();return;}const g=this.#generation,receipt=this.#receipt;this.#receipt='';this.#publish({...this.#state,phase:'applying'});
  try{const r=await this.#request('POST','/'+this.#id+'/apply',{receipt});if(g!==this.#generation)return;const b=r.body;if(r.status!==200||!exact(b,['reviewId','skillId','name','revision','hash'])||b.reviewId!==this.#id||!uuid(b.skillId)||b.name!==this.source.targetName||b.revision!==this.#revision+1||b.hash!==this.#hash)throw Error('Unsettled result');this.#publish({...this.#state,phase:'applied'});}catch{if(g===this.#generation)this.#publish({...this.#state,phase:'unknown'});}
 }
}
