import { useEffect, useRef, useState } from 'react';
import { GenVRTeam, type SpaceAgent } from './GenVRTeam';
import type { SessionClient } from './session';
import { GENVR_PATH, GENVR_AGENTS, genvrId, validStudioProject } from './genvr-contract.js';
type Project={id:string;title:string;agentCount?:number};
export function GenVRPage({client,active}:{client:SessionClient;active:boolean}){
 const frame=useRef<HTMLIFrameElement>(null),revisions=useRef(new Map<string,number>()),opening=useRef<string | undefined>(undefined);
 const selection=useRef<SpaceAgent[]|undefined>(undefined);
 const [mcp,setMcp]=useState('Preparing local MCP…');
 useEffect(()=>{if(!active)return;if(client.getSnapshot().user?.role!=='owner'){setMcp('Local MCP setup is managed by the workspace owner.');return;}let disposed=false;void client.request({method:'POST',path:'/api/genvr/mcp/bootstrap',body:{}} as never).then(result=>{if(disposed)return;const state=(result.body as {status?:string})?.status;setMcp(result.status!==200?'Local MCP could not be prepared.':state==='ready'?'Local MCP ready · choose tools for each agent in its MCP tab.':state==='blocked'?'Local MCP configured · blocked by the server execution policy or working-folder configuration.':state==='disabled'?'Local MCP disabled · enable it in Settings → MCP when needed.':state==='conflict'?'Local MCP needs review in Settings → MCP.':'Local MCP package unavailable in this build.');}).catch(()=>{if(!disposed)setMcp('Local MCP could not be prepared.');});return()=>{disposed=true;};},[client,active]);
 const [editing,setEditing]=useState<{project?:Record<string,any>;revision?:number;team:SpaceAgent[]}|null>(null);
 const [channel,setChannel]=useState(''),[phase,setPhase]=useState('idle'),[notice,setNotice]=useState('');
 const [projects,setProjects]=useState<Project[]>([]),[listing,setListing]=useState('loading'),[query,setQuery]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{
  if(!active||channel)return;let disposed=false;setListing('loading');
  void client.request({method:'GET',path:GENVR_PATH} as never).then(result=>{
   if(disposed)return;const body=result.body as {projects?:Project[]};if(result.status!==200||!Array.isArray(body?.projects)){setListing('error');return;}
   setProjects(body.projects);setListing('ready');
  }).catch(()=>{if(!disposed)setListing('error');});return()=>{disposed=true;};
 },[client,active,channel,retry]);
 function open(id?:string){selection.current=undefined;opening.current=id;setNotice('');setPhase('loading');setChannel(crypto.randomUUID());}
 useEffect(()=>{
  if(!channel)return;let disposed=false;
  const send=(value:Record<string,unknown>)=>frame.current?.contentWindow?.postMessage({type:'dpro-genvr',channel,...value},window.location.origin);
  const receive=async(event:MessageEvent)=>{
   if(disposed||event.source!==frame.current?.contentWindow||event.origin!==window.location.origin||event.data?.type!=='dpro-genvr'||event.data.channel!==channel)return;
   const data=event.data;if(data.operation==='ready'){send({operation:'start',projectId:opening.current,storageNamespace:client.getSnapshot().user?.id});return;}if(data.operation==='mounted'){setPhase('ready');return;}
   if(data.operation==='unavailable'){setPhase('unavailable');return;}
   if(data.operation==='open-failed'){setNotice('Choose the saved space from the Studio project menu to open it.');return;}
   if(data.operation==='closed'){if(data.ok){setChannel('');setPhase('idle');}else setNotice('Studio is busy or saving failed. Keep it open and save or export your edits.');return;}
   if(typeof data.id!=='string'||!/^\d{1,10}$/.test(data.id))return;
   try{
    if(data.operation==='agents'&&genvrId(data.value)){
     const [saved,roster]=await Promise.all([client.request({method:'GET',path:`${GENVR_PATH}/${data.value}`} as never),client.request({method:'GET',path:GENVR_AGENTS} as never)]);
     if(saved.status!==200||roster.status!==200)throw Error();
     const members=(saved.body as {agents:SpaceAgent[]}).agents,available=(roster.body as {agents:{id:string;name:string;avatar:number|null}[]}).agents;
     const rows=members.flatMap(member=>{const agent=available.find(a=>a.id===member.id);return agent?[{id:agent.id,name:agent.name,avatar:agent.avatar??member.avatar}]:[];});
     if(!disposed)send({id:data.id,response:true,ok:true,value:rows});return;
    }
    if(data.operation==='catalog-list'){
     const items:unknown[]=[],ids=new Set<string>();let after:string|null=null;
     for(let page=0;page<3;page++){const result=await client.request({method:'GET',path:'/api/genvr/market'+(after?'?after='+after:'')} as never);if(result.status!==200)throw Error();const body=result.body as {items:{manifest:{id:string}}[];next:string|null};for(const item of body.items)if(!ids.has(item.manifest.id)){ids.add(item.manifest.id);items.push(item);}if(!body.next||body.next===after)break;after=body.next;}
     if(!disposed)send({id:data.id,response:true,ok:true,value:items});return;
    }
    if(data.operation==='catalog-asset'&&typeof data.value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.value)&&!data.value.includes('..')){
     const result=await client.request({method:'GET',path:'/api/genvr/market/items/'+data.value} as never);if(result.status!==200)throw Error();if(!disposed)send({id:data.id,response:true,ok:true,value:(result.body as {asset:unknown}).asset});return;
    }
    const request=data.operation==='list'?{method:'GET',path:GENVR_PATH}:data.operation==='read'&&genvrId(data.value)?{method:'GET',path:`${GENVR_PATH}/${data.value}`}:
     data.operation==='write'&&validStudioProject(data.value)?{method:'PUT',path:`${GENVR_PATH}/${data.value.id}`,body:{project:data.value,revision:revisions.current.get(data.value.id)??0,...(selection.current?{agents:selection.current}:{})}}:null;
    if(!request)return;const result=await client.request(request as never);if(disposed)return;
    if(result.status!==200){send({id:data.id,response:true,ok:false,conflict:result.status===409});return;}
    const body=result.body as {projects?:unknown;project?:{id:string};revision?:number};
    if(data.operation==='read'&&body.project&&body.revision){revisions.current.set(body.project.id,body.revision);selection.current=undefined;}
    if(data.operation==='write'&&body.revision){revisions.current.set(data.value.id,body.revision);selection.current=undefined;}
    send({id:data.id,response:true,ok:true,value:data.operation==='list'?body.projects:data.operation==='read'?body.project:undefined});
   }catch{if(!disposed)send({id:data.id,response:true,ok:false});}
  };
  window.addEventListener('message',receive);const timer=setTimeout(()=>{if(!disposed)setPhase(current=>current==='loading'?'unavailable':current);},20000);
  return()=>{disposed=true;clearTimeout(timer);window.removeEventListener('message',receive);};
 },[client,channel]);
 const visible=projects.filter(project=>project.title.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
 return <div className="genvr-page"><header className="genvr-toolbar"><div><h2>GenVR</h2><p className="fine-print">Your private spaces in this workspace. Film exports are saved separately.</p></div>
 {channel?<button type="button" onClick={()=>{setNotice('');frame.current?.contentWindow?.postMessage({type:'dpro-genvr',channel,operation:'close'},window.location.origin);}}>Save & close Studio</button>:<button type="button" className="primary" disabled={editing!==null} onClick={()=>setEditing({team:[]})}>Create space</button>}</header>
 <p className="fine-print" role="status">{mcp}</p>
 {notice&&<p role="alert">{notice}</p>}
 {editing?<GenVRTeam key={editing.project?.id??'new'} client={client} initial={editing.team} creating={!editing.project} onCancel={()=>setEditing(null)} onConfirm={async team=>{if(!editing.project){open();selection.current=team;setEditing(null);return;}const result=await client.request({method:'PUT',path:`${GENVR_PATH}/${editing.project.id}`,body:{project:editing.project,revision:editing.revision,agents:team}} as never);if(result.status!==200)throw Error();setEditing(null);setRetry(n=>n+1);}}/>:!channel?<section className="genvr-library" aria-label="My spaces"><div className="genvr-library-heading"><h3>My spaces <span className="fine-print">{projects.length}</span></h3><input type="search" aria-label="Search spaces" placeholder="Search spaces" value={query} maxLength={200} onChange={event=>setQuery(event.target.value)}/></div>
 {listing==='loading'?<p role="status">Loading your spaces…</p>:listing==='error'?<div role="alert"><p>Your spaces could not be loaded.</p><button type="button" onClick={()=>setRetry(value=>value+1)}>Try again</button></div>:projects.length===0?<p className="empty-note">No spaces yet. Create your first space above, or import a saved project inside Studio.</p>:visible.length===0?<p className="empty-note">No spaces match your search.</p>:<ul className="genvr-world-list">{visible.map(project=><li key={project.id}><button type="button" className="genvr-world-row" onClick={()=>open(project.id)} aria-label={`Open space: ${project.title}`}><span aria-hidden="true">◇</span><strong>{project.title}</strong><span className="fine-print">{project.agentCount??0} agents · Open space →</span></button><button type="button" aria-label={`Manage agents: ${project.title}`} onClick={()=>{setNotice('');void client.request({method:'GET',path:`${GENVR_PATH}/${project.id}`} as never).then(result=>{if(result.status!==200)throw Error();const body=result.body as {project:Record<string,any>;revision:number;agents:SpaceAgent[]};setEditing({project:body.project,revision:body.revision,team:body.agents});}).catch(()=>setNotice('Space agents could not be loaded. Try again.'));}}>Manage agents</button></li>)}</ul>}
 </section>:<>{phase==='loading'&&<p role="status">Opening GenVR Studio…</p>}{phase==='unavailable'&&<p role="alert">GenVR is unavailable in this build. Your saved spaces remain in your workspace.</p>}<iframe ref={frame} title="GenVR Studio" className="genvr-frame" src={`/genvr/studio.html#${channel}`} sandbox="allow-scripts allow-same-origin allow-downloads allow-pointer-lock"/></>}
 </div>;
}
