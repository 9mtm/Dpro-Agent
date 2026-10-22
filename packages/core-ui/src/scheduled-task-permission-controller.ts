import type {SessionClient} from './session';
import {scheduleAuthorizationResponse} from './scheduler-authorization-contract.js';
export type SelectedSchedule=Readonly<{id:string;actionType:string;enabled:boolean}>;
type Permission='unknown'|'authorized'|'authorization_required'|'not_required';
type Commands=Readonly<{edit:boolean;authorize:boolean;revoke:boolean;resume:boolean;run:boolean;pause:boolean}>;
type State=Readonly<{phase:'idle'|'loading'|'ready'|'unavailable'|'closed';selected:SelectedSchedule|null;permission:Permission;commands:Commands}>;
const none:Commands=Object.freeze({edit:false,authorize:false,revoke:false,resume:false,run:false,pause:false});
const uuid=(id:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const external=(job:SelectedSchedule)=>job.actionType==='api-call'||job.actionType==='send-message';
const internalImplemented=(job:SelectedSchedule)=>job.actionType==='memory-job'||job.actionType==='evolve-agent';
function capture(value:SelectedSchedule):SelectedSchedule{
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).length!==3||!['id','actionType','enabled'].every(key=>Object.hasOwn(value,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value')))throw Error('Invalid selected task');
 if(typeof value.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value.id)||value.id.includes('..')||typeof value.actionType!=='string'||!/^[a-z][a-z0-9-]{0,59}$/.test(value.actionType)||typeof value.enabled!=='boolean')throw Error('Invalid selected task');
 return Object.freeze({id:value.id,actionType:value.actionType,enabled:value.enabled});
}
/** Advisory UI state only. Dispatch still requires the server's current permission checks. */
export class ScheduledTaskPermissionController{
 #state:State=Object.freeze({phase:'idle',selected:null,permission:'unknown',commands:none});#listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;#unsubscribe:(()=>void)|undefined;#closed=false;#epoch:number;
 constructor(private readonly client:Pick<SessionClient,'request'|'getSnapshot'|'subscribe'>){this.#epoch=client.getSnapshot().epoch;}
 #watch(){
  if(this.#unsubscribe)return;
  this.#unsubscribe=this.client.subscribe(()=>{const current=this.client.getSnapshot();if(current.epoch!==this.#epoch||!this.#owner())this.close();});
 }
 getSnapshot=()=>this.#state;
 subscribe=(listener:()=>void)=>{this.#listeners.add(listener);return()=>{this.#listeners.delete(listener);};};
 #owner(){const current=this.client.getSnapshot();return current.phase==='authenticated'&&current.user?.role==='owner';}
 #publish(phase:State['phase'],selected:SelectedSchedule|null,permission:Permission){
  const isExternal=selected&&external(selected),manageable=!!isExternal&&uuid(selected!.id),ready=phase==='ready',permitted=ready&&selected&&(isExternal?permission==='authorized':internalImplemented(selected)&&permission==='not_required');
  const commands=!selected||!this.#owner()||this.#closed?none:Object.freeze({edit:manageable,authorize:manageable,revoke:manageable,resume:!!permitted&&!selected.enabled,run:!!permitted,pause:selected.enabled});
  this.#state=Object.freeze({phase,selected,permission,commands});this.#listeners.forEach(listener=>listener());
 }
 #clear(){this.#generation++;this.#pending?.abort();this.#pending=undefined;}
 close(){if(this.#closed)return;this.#closed=true;this.#clear();this.#unsubscribe?.();this.#unsubscribe=undefined;this.#publish('closed',null,'unknown');}
 async select(value:SelectedSchedule|null){
  if(this.#closed)return;if(this.client.getSnapshot().epoch!==this.#epoch){this.close();return;}this.#watch();this.#clear();if(!this.#owner()){this.#publish('unavailable',null,'unknown');return;}
  if(value===null){this.#publish('idle',null,'unknown');return;}
  let selected:SelectedSchedule;try{selected=capture(value);}catch{this.#publish('unavailable',null,'unknown');return;}
  if(!external(selected)){this.#publish('ready',selected,'not_required');return;}
  if(!uuid(selected.id)){this.#publish('unavailable',selected,'unknown');return;}
  const generation=this.#generation;this.#pending=new AbortController();this.#publish('loading',selected,'unknown');
  try{
   const path='/api/scheduler/jobs/'+selected.id+'/authorization',response=await this.client.request({method:'GET',path},this.#pending.signal);
   if(generation!==this.#generation||this.#closed)return;
   const result=scheduleAuthorizationResponse(path,response.status,response.body);
   if(response.status!==200||!['authorized','authorization_required'].includes(result.status as string))throw Error('Permission unavailable');
   this.#publish('ready',selected,result.status as Permission);
  }catch{if(generation===this.#generation&&!this.#closed)this.#publish('unavailable',selected,'unknown');}
 }
 /** Clear advisory permission immediately when a sheet opens/closes or a metadata refresh starts. */
 invalidate(){if(this.#closed)return;this.#clear();this.#publish(this.#state.selected?'loading':'idle',this.#state.selected,'unknown');}
 /** After editor/consent closes, metadata must be reread by the caller before this refresh. */
 refresh(value:SelectedSchedule){return this.select(value);}
}
