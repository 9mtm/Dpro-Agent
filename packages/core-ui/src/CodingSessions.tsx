import {useEffect,useState,useSyncExternalStore} from 'react';
import {LocalImportController} from './local-import';
import type {LocalSession} from './local-import-contract.js';
import type {SessionClient} from './session';
import type {ConversationsController} from './conversations';

/** Search only sanitized catalogue metadata, never the source files. */
export function codingSessionMatches(sessions:readonly LocalSession[],folder:string,query='',source=''){
 const root=folder.replace(/\/$/,''),needle=query.trim().toLowerCase();
 return sessions.filter(row=>(row.source==='claude-code'||row.source==='codex')&&row.cwd?.replace(/\/$/,'')===root&&(!source||row.source===source)&&row.title.toLowerCase().includes(needle))
  .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
}

export function CodingSessions({client,controller,folder}:{client:SessionClient;controller:ConversationsController;folder:string}){
 const [c]=useState(()=>new LocalImportController(client));
 const s=useSyncExternalStore(c.subscribe,c.getSnapshot,c.getSnapshot);
 const [query,setQuery]=useState(''),[source,setSource]=useState(''),[page,setPage]=useState(0);
 useEffect(()=>()=>c.dispose(),[c]);
 const all=codingSessionMatches(s.sessions,folder),rows=codingSessionMatches(s.sessions,folder,query,source);
 const current=Math.min(page,Math.max(0,Math.ceil(rows.length/20)-1)),start=current*20;
 const resetPreview=()=>{setPage(0);c.closePreview();};
 return <section className="coding-sessions" aria-label="Previous coding sessions">
  <button type="button" className="link-button" disabled={s.phase==='loading'} onClick={()=>{c.closePreview();void c.load();}}>{s.phase==='loading'?'Looking for coding sessions…':'Browse Claude Code & Codex sessions'}</button>
  {s.phase==='ready'&&<>
   <p className="fine-print">Previous local sessions in this folder. Continue opens a separate branch; the original stays unchanged. Preview does not import memories. Up to 400 recent sessions are scanned.</p>
   <div className="catalogue-filters">
    <label>Search<input type="search" aria-label="Search coding sessions" placeholder="Conversation title" value={query} onChange={e=>{setQuery(e.target.value);resetPreview();}}/></label>
    <label>Source<select aria-label="Session source" value={source} onChange={e=>{setSource(e.target.value);resetPreview();}}><option value="">All coding apps</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option></select></label>
    <button type="button" onClick={()=>{setQuery('');setSource('');resetPreview();}}>Clear session filters</button>
   </div>
   <p className="fine-print" role="status">{rows.length} of {all.length} folder sessions · Newest first</p>
   {!rows.length&&<p>{all.length?'No sessions match these filters.':'No matching recent sessions found for this exact folder.'}</p>}
   <ul aria-label="Coding session results">{rows.slice(start,start+20).map(row=><li className="coding-session-row" key={row.id}>
    <button type="button" className="link-button" onClick={()=>void c.preview(row.id)}>{row.source==='codex'?'Codex':'Claude Code'} · {row.title||'Untitled session'}</button>
    <span className="fine-print">{row.updatedAt.slice(0,10)} · {row.turns} turns</span>
   </li>)}</ul>
   {rows.length>20&&<div className="actions" aria-label="Coding session pages"><button type="button" disabled={!current} onClick={()=>{setPage(current-1);c.closePreview();}}>Previous sessions</button><span>{start+1}–{Math.min(start+20,rows.length)} of {rows.length}</span><button type="button" disabled={start+20>=rows.length} onClick={()=>{setPage(current+1);c.closePreview();}}>Next sessions</button></div>}
  </>}
  {s.phase==='error'&&<p role="alert">Coding sessions could not be read. Try again.</p>}
  {s.previewLoading&&<p role="status">Reading conversation…</p>}{s.previewError&&<p role="alert">{s.previewError}</p>}
  {s.preview&&<div className="coding-session-preview"><h4>Previous conversation</h4>
   {s.preview.messages.map((m,i)=><div key={i}><strong>{m.role==='user'?'You':'Assistant'}</strong><p dir="auto">{m.text}</p></div>)}
   {s.preview.truncated&&<p>Preview shortened. Native continuation retains the source session context.</p>}
   <button type="button" onClick={()=>{const row=rows.find(r=>r.id===s.preview?.id);if(row&&(row.source==='codex'||row.source==='claude-code')){controller.resumeCodingSession(row.id,row.source);c.closePreview();}}}>Continue this coding session</button><button type="button" onClick={()=>c.closePreview()}>Close preview</button>
  </div>}
 </section>;
}
