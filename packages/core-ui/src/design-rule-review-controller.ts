import type {SessionClient} from './session';
import type {ProjectDesign} from './memory-desktop-contract.js';
import {allowedMemoryDesktop,memoryDesktopResponse} from './memory-desktop-contract.js';
type Rule=ProjectDesign['rules'][number];
type State=Readonly<{phase:'closed'|'loading'|'review'|'applying'|'applied'|'stale'|'unknown'|'unavailable';rule:Readonly<Pick<Rule,'text'|'source'|'confirmed'>>|null;limited?:boolean;filePending?:boolean}>;
/** One exact rule decision. Repository text is display data, never an instruction. */
export class DesignRuleReviewController{
 #state:State=Object.freeze({phase:'closed',rule:null});#listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;#rules:readonly Rule[]=[];
 readonly path:string;
 constructor(private readonly client:Pick<SessionClient,'request'|'getSnapshot'>,slug:string,private readonly id:string){
  this.path='/api/memory/projects/'+encodeURIComponent(slug)+'/design';if(!allowedMemoryDesktop('GET',this.path)||!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid rule');
 }
 getSnapshot=()=>this.#state;
 subscribe=(fn:()=>void)=>{this.#listeners.add(fn);return()=>{this.#listeners.delete(fn);};};
 #publish(state:State){this.#state=Object.freeze(state);this.#listeners.forEach(fn=>fn());}
 #owner(){const s=this.client.getSnapshot();return s.phase==='authenticated'&&s.user?.role==='owner';}
 cancel(){this.#generation++;this.#pending?.abort();this.#pending=undefined;this.#rules=[];this.#publish({phase:'closed',rule:null});}
 async load(){
  if(['applying','applied','unknown'].includes(this.#state.phase))return;
  this.cancel();if(!this.#owner()){this.#publish({phase:'unavailable',rule:null});return;}
  const generation=this.#generation,epoch=this.client.getSnapshot().epoch;this.#pending=new AbortController();this.#publish({phase:'loading',rule:null});
  try{const r=await this.client.request({method:'GET',path:this.path},this.#pending.signal);if(generation!==this.#generation)return;if(epoch!==this.client.getSnapshot().epoch||!this.#owner()){this.cancel();return;}
   const body=memoryDesktopResponse(this.path,r.status,r.body) as ProjectDesign;if(r.status!==200||!body?.rules?.every(rule=>rule.reviewable))throw Error('Unavailable');
   this.#rules=Object.freeze(body.rules.map(rule=>Object.freeze({...rule})));const rule=this.#rules.find(rule=>rule.id===this.id);if(!rule)throw Error('Changed');
   this.#publish({phase:'review',rule:Object.freeze({text:rule.text,source:rule.source,confirmed:rule.confirmed})});
  }catch{if(generation===this.#generation)this.#publish({phase:'unavailable',rule:null});}
 }
 async apply(){
  if(this.#state.phase!=='review'||!this.#state.rule||!this.#owner())return;
  const reviewed=this.#state.rule,approvedRules=this.#rules.filter(rule=>rule.confirmed&&rule.id!==this.id).map(rule=>rule.id as string);if(!reviewed.confirmed)approvedRules.push(this.id);
  const body={approvedRules,confirmRules:true};if(!allowedMemoryDesktop('PATCH',this.path,body))return;
  const generation=this.#generation,epoch=this.client.getSnapshot().epoch;this.#pending=new AbortController();this.#publish({phase:'applying',rule:reviewed});
  try{const r=await this.client.request({method:'PATCH',path:this.path,body},this.#pending.signal);if(generation!==this.#generation)return;if(epoch!==this.client.getSnapshot().epoch||!this.#owner()){this.cancel();return;}
   if(r.status===409){this.#publish({phase:'stale',rule:reviewed});return;}if(r.status===429){this.#publish({phase:'review',rule:reviewed,limited:true});return;}
   if(r.status!==200)throw Error('Unconfirmed');const result=memoryDesktopResponse(this.path,r.status,r.body) as ProjectDesign,rule=result.rules.find(rule=>rule.id===this.id);
   if(!rule||rule.text!==reviewed.text||rule.source!==reviewed.source||rule.confirmed===reviewed.confirmed||JSON.stringify(result.rules.filter(r=>r.confirmed).map(r=>r.id).sort())!==JSON.stringify([...approvedRules].sort()))throw Error('Unconfirmed');
   this.#rules=[];this.#publish({phase:'applied',rule:Object.freeze({text:rule.text,source:rule.source,confirmed:rule.confirmed}),filePending:!!result.file.problem});
  }catch{if(generation===this.#generation)this.#publish({phase:'unknown',rule:reviewed});}
 }
}
