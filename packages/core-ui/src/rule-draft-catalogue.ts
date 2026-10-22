import type {SessionClient} from './session';
import type {RulePolicy,EligibleHuman} from './reviewer-policies-controller';
import {allowedReviewer,reviewerResponse} from './reviewers-contract.js';
export type RuleChoice=Readonly<{id:string;name:string}>;
const resource=(value:string)=>/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
export async function loadRulePeople(client:Pick<SessionClient,'request'>,signal:AbortSignal):Promise<readonly EligibleHuman[]>{
 const people:EligibleHuman[]=[],ids=new Set<string>(),cursors=new Set<string>();let cursor:string|null=null;
 for(let page=0;page<201;page++){
  if(signal.aborted)throw Error('Cancelled');
  const path='/api/reviewer-policies/eligible-humans'+(cursor?'?cursor='+encodeURIComponent(cursor):''),r=await client.request({method:'GET',path},signal),value=reviewerResponse(path,r.status,r.body);if(r.status!==200||signal.aborted)throw Error('People unavailable');
  for(const person of value.items as EligibleHuman[]){if(ids.has(person.id))throw Error('Repeated identity');ids.add(person.id);people.push(Object.freeze({...person}));}
  if(value.nextCursor===null)return Object.freeze(people);cursor=value.nextCursor as string;if(cursors.has(cursor))throw Error('Repeated cursor');cursors.add(cursor);
 }
 throw Error('People limit');
}
export async function loadRuleAgents(client:Pick<SessionClient,'request'>,signal:AbortSignal):Promise<readonly RuleChoice[]>{
 const r=await client.request({method:'GET',path:'/api/agents'},signal),body=r.body as {agents?:{id:string;name?:string}[]};
 if(r.status!==200||signal.aborted||!Array.isArray(body.agents)||body.agents.length>10000)throw Error('Agents unavailable');
 const agents=body.agents.filter(v=>typeof v.id==='string'&&resource(v.id)&&typeof v.name==='string'&&v.name.length>0&&v.name.length<=200).map(v=>Object.freeze({id:v.id,name:v.name!}));
 if(new Set(agents.map(v=>v.id)).size!==agents.length)throw Error('Repeated agent');return Object.freeze(agents);
}
export async function loadRuleActions(client:Pick<SessionClient,'request'>,agentIds:readonly string[],signal:AbortSignal):Promise<readonly RuleChoice[]>{
 if(agentIds.length>50||!agentIds.every(resource)||new Set(agentIds).size!==agentIds.length)throw Error('Invalid agents');const actions=new Map<string,RuleChoice>();
 for(const id of agentIds){
  if(signal.aborted)throw Error('Cancelled');const r=await client.request({method:'GET',path:'/api/agents/'+id+'/tool-grants'},signal),body=r.body as {available?:{name:string;allowedByServer:boolean}[]};
  if(r.status!==200||signal.aborted||!Array.isArray(body.available)||body.available.length>2000)throw Error('Actions unavailable');
  for(const tool of body.available){if(typeof tool.name!=='string'||!resource(tool.name)||typeof tool.allowedByServer!=='boolean')throw Error('Invalid action');if(tool.allowedByServer)actions.set(tool.name,Object.freeze({id:tool.name,name:tool.name.replaceAll('_',' ')}));}
  if(actions.size>2000)throw Error('Action limit');
 }
 return Object.freeze([...actions.values()].sort((a,b)=>a.name.localeCompare(b.name)));
}
export function validRuleDraft(id:string,policy:RulePolicy,people:readonly EligibleHuman[],agents:readonly RuleChoice[],actions:readonly RuleChoice[],now=Date.now()){
 return allowedReviewer('PUT','/api/reviewer-policies/'+id+'/draft',{expectedRevision:0,policy})&&policy.expiresAt>now&&policy.expiresAt<=now+7776000000&&policy.reviewerIds.every(id=>people.some(p=>p.id===id))&&policy.scope.agentIds.every(id=>agents.some(a=>a.id===id))&&policy.scope.toolNames.every(id=>actions.some(a=>a.id===id));
}
