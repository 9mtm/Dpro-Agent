import {useEffect,useRef,useState} from 'react';
import type {SessionClient} from './session';
type Settings={enabled:boolean;intervalMinutes:15|30|60;nextRun:number;lastRun:number|null;status:'idle'|'scanning'|'importing'|'review'|'error';lastImported:number;lastProposed:number;notice:string};
const PATH='/api/memory/import/local/automatic';
/** A saved local schedule; enabling it explicitly opts into direct saving of extracted memories. */
export function AutomaticProjectImport({client}:{client:SessionClient}){
 const [settings,setSettings]=useState<Settings>(),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const live=useRef(true),ticket=useRef(0),saving=useRef(false);
 useEffect(()=>{
  live.current=true;
  async function load(){if(saving.current)return;const t=++ticket.current;try{const r=await client.request({method:'GET',path:PATH} as never);if(live.current&&ticket.current===t&&r.status===200)setSettings((r.body as {settings:Settings}).settings);}catch{/* Retry with the next status refresh. */}}
  void load();const timer=setInterval(()=>void load(),5000);return()=>{live.current=false;ticket.current++;clearInterval(timer);};
 },[client]);
 async function save(enabled:boolean,intervalMinutes:Settings['intervalMinutes']){
  if(busy)return;saving.current=true;const t=++ticket.current;setBusy(true);setNotice('');
  try{const r=await client.request({method:'PUT',path:PATH,body:{enabled,intervalMinutes}} as never);if(!live.current||ticket.current!==t)return;if(r.status!==200)throw Error();setSettings((r.body as {settings:Settings}).settings);}
  catch{if(live.current)setNotice('Automatic import settings could not be saved.');}
  finally{saving.current=false;if(live.current)setBusy(false);}
 }
 return <section className="local-import-job" aria-label="Automatic project-file import">
  <div className="local-import-tools"><label><input type="checkbox" role="switch" checked={settings?.enabled??false} disabled={!settings||busy} onChange={e=>void save(e.target.checked,settings?.intervalMinutes??60)}/> Automatic import</label>
   <label>Check for new files <select aria-label="Automatic import interval" value={settings?.intervalMinutes??60} disabled={!settings||busy} onChange={e=>void save(settings?.enabled??false,Number(e.target.value) as Settings['intervalMinutes'])}><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option><option value={60}>Every hour</option></select></label></div>
  <p className="fine-print">New or changed project files are imported automatically when enabled. When enabled, new memories are saved directly without an approval prompt. Previously imported files and existing facts are skipped. Manual imports still wait for your approval. Checks run while Dpro is open, with missed checks picked up at the next start.</p>
  {!settings?<p role="status">Loading automatic import settings…</p>:<><p role="status">{settings.enabled?`Automatic import on · ${settings.status}`:'Automatic import off'}. {settings.notice}</p>
   {settings.enabled&&<p className="fine-print">Next check: {settings.nextRun>Date.now()?new Date(settings.nextRun).toLocaleString():'Due now'}. {settings.lastRun?`Last check: ${new Date(settings.lastRun).toLocaleString()} · ${settings.lastImported} files · ${settings.lastProposed} new memories processed.`:''}</p>}</>}
  {notice&&<p role="alert">{notice}</p>}
 </section>;
}
