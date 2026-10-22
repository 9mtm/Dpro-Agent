import type {SessionClient} from './session';
import {skillInstallResponse} from './skill-install-contract.js';
export type CatalogueSkill=Readonly<{commit:string;sourcePath:string;targetName:string}>;
type State=Readonly<{phase:'idle'|'loading'|'ready'|'unavailable'|'closed';skills:readonly CatalogueSkill[];selected:CatalogueSkill|null;review:Readonly<{ticket:number;source:CatalogueSkill}>|null;unknownTargets:readonly string[];notice?:'limited'|'unavailable'|'applied'|'unknown'}>;
// An unresolved write remains uncertain across navigation/remount of the same signed-in owner.
const ledgers=new WeakMap<object,Map<string,Set<string>>>();
export class SkillCatalogueController{
 #state:State=Object.freeze({phase:'idle',skills:Object.freeze([]),selected:null,review:null,unknownTargets:Object.freeze([])});#listeners=new Set<()=>void>();#generation=0;#ticket=0;#pending:AbortController|undefined;#unsubscribe:(()=>void)|undefined;#closed=false;#epoch:number;#ownerId:string;#unknown:Set<string>;#reads=0;#unknownAt=new Map<string,number>();
 constructor(private readonly client:Pick<SessionClient,'request'|'getSnapshot'|'subscribe'>){const s=client.getSnapshot();this.#epoch=s.epoch;this.#ownerId=s.user?.id??'';let owners=ledgers.get(client);if(!owners){owners=new Map();ledgers.set(client,owners);}let unknown=owners.get(this.#ownerId);if(!unknown){unknown=new Set();owners.set(this.#ownerId,unknown);}this.#unknown=unknown;this.#publish({});}
 getSnapshot=()=>this.#state;
 subscribe=(fn:()=>void)=>{this.#listeners.add(fn);return()=>{this.#listeners.delete(fn);};};
 #publish(patch:Partial<State>){this.#state=Object.freeze({...this.#state,...patch,unknownTargets:Object.freeze((patch.phase??this.#state.phase)==='closed'?[]:[...this.#unknown].sort())});this.#listeners.forEach(fn=>fn());}
 #owner(){const s=this.client.getSnapshot();return !this.#closed&&s.epoch===this.#epoch&&s.phase==='authenticated'&&s.user?.role==='owner'&&s.user.id===this.#ownerId&&!!this.#ownerId;}
 #watch(){if(!this.#unsubscribe)this.#unsubscribe=this.client.subscribe(()=>{if(!this.#owner())this.close();});}
 close(){if(this.#closed)return;if(this.#state.review)this.#unknown.add(this.#state.review.source.targetName);this.#closed=true;this.#generation++;this.#pending?.abort();this.#unsubscribe?.();this.#unsubscribe=undefined;this.#publish({phase:'closed',skills:Object.freeze([]),selected:null,review:null,notice:undefined});}
 async load(){
  if(!this.#owner()){this.close();return;}if(this.#state.review)return;this.#watch();this.#generation++;const g=this.#generation;this.#pending?.abort();this.#pending=new AbortController();const selected=this.#state.selected?.targetName;this.#publish({phase:'loading',selected:null,notice:undefined});
  try{const path='/api/skills/reviewed-installs/catalogue',r=await this.client.request({method:'GET',path},this.#pending.signal);if(g!==this.#generation||!this.#owner())return;const value=skillInstallResponse(path,r.status,r.body);if(r.status!==200){this.#publish({phase:'unavailable',skills:Object.freeze([]),notice:r.status===429?'limited':'unavailable'});return;}this.#reads++;const skills=Object.freeze((value.skills as CatalogueSkill[]).map(s=>Object.freeze({...s})));this.#publish({phase:'ready',skills,selected:skills.find(s=>s.targetName===selected)??null});}catch{if(g===this.#generation&&this.#owner())this.#publish({phase:'unavailable',skills:Object.freeze([]),notice:'unavailable'});}
 }
 select(targetName:string){if(!this.#owner()||this.#state.phase!=='ready'||this.#state.review)return;const selected=this.#state.skills.find(s=>s.targetName===targetName)??null;this.#publish({selected,notice:selected&&this.#unknown.has(selected.targetName)?'unknown':undefined});}
 beginReview(){if(!this.#owner()||this.#state.phase!=='ready'||!this.#state.selected||this.#state.review||this.#unknown.has(this.#state.selected.targetName))return null;const review=Object.freeze({ticket:++this.#ticket,source:this.#state.selected});this.#publish({review,notice:undefined});return review;}
 finishReview(ticket:number,result:'applied'|'unknown'|'cancelled'){
  if(!this.#owner()||this.#state.review?.ticket!==ticket||!['applied','unknown','cancelled'].includes(result))return false;const name=this.#state.review.source.targetName;if(result==='unknown'){this.#unknown.add(name);this.#unknownAt.set(name,this.#reads);}this.#publish({review:null,notice:result==='cancelled'?undefined:result});return true;
 }
 /** Deliberate acknowledgement after refreshing; it never proves the last write failed or succeeded. */
 acknowledgeUnknown(targetName:string){if(!this.#owner()||this.#state.phase!=='ready'||this.#state.review||this.#state.selected?.targetName!==targetName||!this.#unknown.has(targetName)||this.#reads<=(this.#unknownAt.get(targetName)??0))return false;this.#unknown.delete(targetName);this.#publish({notice:undefined});return true;}
}
