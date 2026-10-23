import type {SessionClient} from './session';
import {tradingPaperResponse,tradingPaperRoute} from './trading-paper-contract.js';
type AccountDescriptor=Readonly<{accountId:string;currency:string;appEnabled:boolean;stopped:boolean}>;
type State=Readonly<{phase:'idle'|'loading'|'ready'|'unavailable'|'closed';accountId:string|null;accounts:readonly AccountDescriptor[]|null;hasMore:boolean;availability:Readonly<Record<string,unknown>>|null;account:Readonly<Record<string,unknown>>|null}>;
/** Read-only selection; discovery, provisioning and execution are separate capabilities. */
export class TradingPaperController{
 #state:State=Object.freeze({phase:'idle',accountId:null,accounts:null,hasMore:false,availability:null,account:null});
 #listeners=new Set<()=>void>();#generation=0;#pending:AbortController|undefined;#unsubscribe:(()=>void)|undefined;#closed=false;#epoch:number;#owner:string;
 constructor(private readonly client:Pick<SessionClient,'request'|'getSnapshot'|'subscribe'>){const s=client.getSnapshot();this.#epoch=s.epoch;this.#owner=s.user?.id??'';}
 getSnapshot=()=>this.#state;
 subscribe=(fn:()=>void)=>{this.#listeners.add(fn);return()=>{this.#listeners.delete(fn);};};
 #publish(patch:Partial<State>){this.#state=Object.freeze({...this.#state,...patch});this.#listeners.forEach(fn=>fn());}
 #authorized(){const s=this.client.getSnapshot();return !this.#closed&&s.epoch===this.#epoch&&s.phase==='authenticated'&&s.user?.role==='owner'&&s.user.id===this.#owner&&!!this.#owner;}
 close(){if(this.#closed)return;this.#closed=true;this.#generation++;this.#pending?.abort();this.#unsubscribe?.();this.#unsubscribe=undefined;this.#publish({phase:'closed',accountId:null,accounts:null,hasMore:false,availability:null,account:null});}
 async load(){
  if(!this.#authorized()){this.close();return;}
  if(!this.#unsubscribe)this.#unsubscribe=this.client.subscribe(()=>{if(!this.#authorized())this.close();});
  const generation=++this.#generation;this.#pending?.abort();const pending=this.#pending=new AbortController();
  this.#publish({phase:'loading',accounts:null,hasMore:false,accountId:null,availability:null,account:null});
  const current=()=>generation===this.#generation&&this.#authorized();
  try{
   const path='/api/trading-paper/availability',r=await this.client.request({method:'GET',path},pending.signal);if(!current())return;
   if(r.status!==200){this.#publish({phase:'unavailable'});return;}
   const availability=Object.freeze(tradingPaperResponse(path,r.status,r.body));
   if(!availability.readAccounts){this.#publish({phase:'unavailable',availability});return;}
   const listPath='/api/trading-paper/accounts',list=await this.client.request({method:'GET',path:listPath},pending.signal);if(!current())return;
   if(list.status!==200){this.#publish({phase:'unavailable',availability});return;}
   const value=tradingPaperResponse(listPath,list.status,list.body),accounts=Object.freeze((value.accounts as AccountDescriptor[]).map(a=>Object.freeze({...a})));
   this.#publish({phase:'ready',availability,accounts,hasMore:value.hasMore as boolean});
  }catch{if(current())this.#publish({phase:'unavailable',accounts:null,hasMore:false,availability:null});}
 }
 async select(accountId:string){
  if(!this.#authorized()){this.close();return;}
  if(!this.#unsubscribe)this.#unsubscribe=this.client.subscribe(()=>{if(!this.#authorized())this.close();});
  const generation=++this.#generation;this.#pending?.abort();const pending=this.#pending=new AbortController();
  this.#publish({phase:'loading',accountId:null,availability:null,account:null});
  if(typeof accountId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(accountId)){this.#publish({phase:'unavailable'});return;}
  if(this.#state.accounts!==null&&!this.#state.accounts.some(a=>a.accountId===accountId)){this.#publish({phase:'unavailable'});return;}
  const path='/api/trading-paper/accounts/'+encodeURIComponent(accountId);
  if(!tradingPaperRoute(path)){this.#publish({phase:'unavailable'});return;}
  const current=()=>generation===this.#generation&&this.#authorized();
  try{
   const availabilityPath='/api/trading-paper/availability';
   const r=await this.client.request({method:'GET',path:availabilityPath},pending.signal);if(!current())return;
   if(r.status!==200){this.#publish({phase:'unavailable'});return;}
   const availability=Object.freeze(tradingPaperResponse(availabilityPath,r.status,r.body));
   if(!availability.readAccounts){this.#publish({phase:'unavailable',availability});return;}
   const detail=await this.client.request({method:'GET',path},pending.signal);if(!current())return;
   if(detail.status!==200){this.#publish({phase:'unavailable',availability});return;}
   const account=tradingPaperResponse(path,detail.status,detail.body);
   for(const key of ['policies','reservations'] as const){const rows=account[key] as Record<string,unknown>[];rows.forEach(Object.freeze);Object.freeze(rows);}
   if(account.execution){const execution=account.execution as Record<string,unknown>;for(const key of ['fills','positions']){const rows=execution[key] as Record<string,unknown>[];rows.forEach(Object.freeze);Object.freeze(rows);}Object.freeze(execution);}
   if(account.sellHistory){const history=account.sellHistory as Record<string,unknown>;const rows=history.reservations as Record<string,unknown>[];rows.forEach(Object.freeze);Object.freeze(rows);Object.freeze(history);}
   this.#publish({phase:'ready',accountId,availability,account:Object.freeze(account)});
  }catch{if(current())this.#publish({phase:'unavailable',account:null,accountId:null,availability:null});}
 }
}
