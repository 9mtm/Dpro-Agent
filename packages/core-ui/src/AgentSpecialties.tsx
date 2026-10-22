import {useEffect,useState} from 'react';
import type {SessionClient} from './session';
import {TEMPLATES_PATH} from './specialty-contract.js';
import {UiIcon} from './ui-icons';
export function AgentSpecialties({client,agentId}:{client:SessionClient;agentId:string}){
 const [items,setItems]=useState<{id:string;name:string;department:string;revision:number}[]>([]),[phase,setPhase]=useState('loading');
 const owner=client.getSnapshot().user?.role==='owner';
 useEffect(()=>{let stopped=false;if(!owner)return;setPhase('loading');void client.request({method:'GET',path:TEMPLATES_PATH+'/assigned/'+encodeURIComponent(agentId)} as never).then(r=>{if(stopped)return;if(r.status!==200){setPhase('error');return;}setItems((r.body as {templates:typeof items}).templates);setPhase('ready');}).catch(()=>{if(!stopped)setPhase('error');});return()=>{stopped=true;};},[client,agentId,owner]);
 if(!owner)return null;
 return <section className="card-sub" aria-label="Linked specialties"><h4>Specialties</h4>{phase==='loading'?<p role="status">Loading specialties…</p>:phase==='error'?<p role="alert">Could not load linked specialties. Reopen this agent to try again.</p>:items.length?<ul className="specialty-linked-list">{items.map(s=><li key={s.id}><UiIcon name="layers" size={16}/><span><strong>{s.name}</strong><small>{s.department} · Revision {s.revision}</small></span></li>)}</ul>:<p>No specialty linked. Open Specialties in the footer to assign a role to this agent.</p>}</section>;
}
