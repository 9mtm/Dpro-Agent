import type {SessionClient} from './session';
import type {ScheduleReview} from './schedule-consent-controller';
import {allowedScheduleDefinition,scheduleDefinitionResponse} from './scheduler-definitions-contract.js';
type State=Readonly<{phase:'closed'|'loading'|'ready'|'saving'|'saved'|'conflict'|'unknown'|'unavailable';review:ScheduleReview|null;notice?:'invalid'|'limited'|'unavailable';readback?:'exists'|'missing'|'unavailable'}>;
const freeze=<T,>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
/** Owns one revisioned edit. It never runs, resumes or authorizes the job. */
export class ScheduledDefinitionController{
 #state:State=Object.freeze({phase:'closed',review:null});#listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;#revision=0;
 readonly path:string;
 constructor(private readonly client:Pick<SessionClient,'request'>,readonly id:string,private readonly creating=false){
  this.path='/api/scheduler/definitions/'+id;if(!allowedScheduleDefinition('GET',this.path))throw Error('Invalid schedule');
 }
 getSnapshot=()=>this.#state;
 subscribe=(listener:()=>void)=>{this.#listeners.add(listener);return()=>{this.#listeners.delete(listener);};};
 #publish(state:State){this.#state=Object.freeze(state);this.#listeners.forEach(listener=>listener());}
 cancel(){this.#generation++;this.#pending?.abort();this.#pending=undefined;this.#revision=0;this.#publish({phase:'closed',review:null});}
 async load(){
  if(['saving','saved','unknown'].includes(this.#state.phase))return;
  this.cancel();const generation=this.#generation;
  if(this.creating){this.#publish({phase:'ready',review:null});return;}
  this.#pending=new AbortController();this.#publish({phase:'loading',review:null});
  try{const response=await this.client.request({method:'GET',path:this.path},this.#pending.signal);if(generation!==this.#generation)return;const value=scheduleDefinitionResponse(this.path,response.status,response.body);
   if(response.status!==200||!value.review)throw Error('Unavailable');this.#revision=value.revision as number;
   const {definitionHash:_hash,...review}=value.review as Record<string,unknown>;this.#publish({phase:'ready',review:freeze(review as ScheduleReview)});
  }catch{if(generation===this.#generation)this.#publish({phase:'unavailable',review:null,notice:'unavailable'});}
 }
 async save(changes:unknown){
  if(this.#state.phase!=='ready')return;
  const request={expectedRevision:this.#revision,changes};
  if(!allowedScheduleDefinition('PUT',this.path,request)){this.#publish({...this.#state,notice:'invalid'});return;}
  // The shared validator rejects accessors and non-JSON before this immutable copy.
  const body=freeze(JSON.parse(JSON.stringify(request))),expected=this.#revision,generation=this.#generation;this.#pending=new AbortController();this.#publish({...this.#state,phase:'saving',notice:undefined});
  try{const response=await this.client.request({method:'PUT',path:this.path,body},this.#pending.signal);if(generation!==this.#generation)return;const value=scheduleDefinitionResponse(this.path,response.status,response.body);
   if(response.status===409){this.#publish({...this.#state,phase:'conflict'});return;}
   if(response.status===400||response.status===429){this.#publish({...this.#state,phase:'ready',notice:response.status===429?'limited':'invalid'});return;}
   if(response.status!==200||value.revision!==expected+1||value.enabled!==false||typeof value.definitionHash!=='string'||!/^[a-f0-9]{64}$/.test(value.definitionHash))throw Error('Unknown save');
   this.#revision=value.revision as number;this.#publish({...this.#state,phase:'saved'});
  }catch{
   if(generation!==this.#generation)return;this.#publish({...this.#state,phase:'unknown'});
   try{const response=await this.client.request({method:'GET',path:this.path},this.#pending.signal),value=scheduleDefinitionResponse(this.path,response.status,response.body);if(generation===this.#generation)this.#publish({...this.#state,readback:response.status===200&&value.review?'exists':response.status===404?'missing':'unavailable'});}catch{if(generation===this.#generation)this.#publish({...this.#state,readback:'unavailable'});}
  }
 }
}
