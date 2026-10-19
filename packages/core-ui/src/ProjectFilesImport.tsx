import { useEffect, useRef, useState } from 'react';
import type { SessionClient } from './session';
import type { LocalImportController } from './local-import';
type Document = { id: string; root: string; relative: string; bytes: number; imported: boolean };
type Preview = { id: string; name: string; text: string; truncated: boolean };
const BASE='/api/memory/import/local/documents';
/** Explicit folder choice and redacted previews; import work belongs to the server. */
export function ProjectFilesImport({client,controller,busy}:{client:SessionClient;controller:LocalImportController;busy:boolean}) {
 const [roots,setRoots]=useState<string[]>([]),[folder,setFolder]=useState(''),[documents,setDocuments]=useState<Document[]>([]),[selected,setSelected]=useState<string[]>([]);
 const [query,setQuery]=useState('');
 const visible=documents.filter(d=>!query.trim()||(d.relative+' '+d.root).toLowerCase().includes(query.trim().toLowerCase()));
 const [preview,setPreview]=useState<Preview>(),[notice,setNotice]=useState(''),[loading,setLoading]=useState(false);
 const alive=useRef(true),ticket=useRef(0),savedCursor=useRef<string|undefined>(undefined);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;ticket.current++;};},[]);
 const add=(paths:string[])=>{setRoots(old=>[...new Set([...old,...paths])].slice(0,8));setDocuments([]);setSelected([]);setPreview(undefined);setLoading(false);ticket.current++;};
 async function choose(){try{const bridge=(window as unknown as {dproApp?:{chooseProjectFolders?:()=>Promise<string[]>}}).dproApp;if(!bridge?.chooseProjectFolders){setNotice('Enter a project folder path below.');return;}const paths=await bridge.chooseProjectFolders();if(alive.current&&paths.length)add(paths);}catch{if(alive.current)setNotice('The folder chooser could not open. Enter the path below.');}}
 async function scan(automatic=false,resume=false){const t=++ticket.current;setLoading(true);setNotice('Searching for project files…');setPreview(undefined);setSelected([]);setQuery('');
  const found=new Map<string,Document>(resume?documents.map(d=>[d.id,d]):[]);if(!resume){setDocuments([]);savedCursor.current=undefined;}let cursor=resume?savedCursor.current:undefined;
  try{do{
   const r=await client.request({method:'POST',path:BASE,body:automatic?{auto:true,...(cursor?{cursor}:{})}:{roots}} as never);if(!alive.current||ticket.current!==t)return;
   if(r.status!==200)throw Error();const body=r.body as {documents:Document[];limited:boolean;scanned:number;nextCursor:string|null};
   for(const doc of body.documents)found.set(doc.id,doc);setDocuments([...found.values()]);cursor=body.nextCursor??undefined;savedCursor.current=cursor;
   setNotice(cursor?`Searching… checked ${body.scanned} entries · ${found.size} project files found.`:`Search complete · ${found.size} project files found.${body.limited?' Some folders reached the scan limit; choose a smaller folder to scan further.':''}`);
  }while(automatic&&cursor);
  }catch{if(alive.current&&ticket.current===t)setNotice('The search could not finish. Retry or choose a project folder. Results already found are kept.');}
  finally{if(alive.current&&ticket.current===t)setLoading(false);}
 }
 async function open(id:string){const t=++ticket.current;setPreview(undefined);setNotice('Opening redacted preview…');
  try{const r=await client.request({method:'GET',path:BASE+'/'+id} as never);if(!alive.current||ticket.current!==t)return;if(r.status!==200)throw Error();setPreview(r.body as Preview);setNotice('');}
  catch{if(alive.current&&ticket.current===t)setNotice('The file is unavailable or changed. Scan the folder again.');}
 }
 useEffect(()=>{void scan(true);},[]);
 return <section className="local-import-preview" aria-label="Project files import">
  <h3>Import project files</h3><p className="fine-print">Your computer is scanned automatically for CLAUDE.md, AGENTS.md, handoff, task notes and documentation in your personal folders. System, hidden, credential and dependency folders are skipped. You can also choose additional folders. Text files up to 1 MB are supported; long files are condensed. Files stay unchanged. Secrets are masked before preview or processing; manual imports below wait for your approval.</p>
  <div className="local-import-tools"><button type="button" disabled={busy||loading} onClick={()=>void scan(true)}>Scan computer</button><button type="button" disabled={busy||loading} onClick={()=>void choose()}>Choose folders…</button>
   <input aria-label="Project folder path" placeholder="/path/to/project" value={folder} disabled={busy||loading} onChange={e=>setFolder(e.target.value)}/>
   <button type="button" disabled={busy||loading||!folder.startsWith('/')} onClick={()=>{add([folder.trim()]);setFolder('');}}>Add folder</button></div>
  <ul>{roots.map(root=><li key={root}><code>{root}</code> <button type="button" disabled={busy||loading} aria-label={'Remove folder '+root} onClick={()=>{setRoots(roots.filter(r=>r!==root));setDocuments([]);setSelected([]);setPreview(undefined);}}>Remove</button></li>)}</ul>
  <button type="button" disabled={!roots.length||busy||loading} onClick={()=>void scan()}>{loading?'Searching…':'Find project files'}</button>
  {loading&&<button type="button" onClick={()=>{ticket.current++;setLoading(false);setNotice('Search paused. Files already found are available to preview and select.');}}>Pause search</button>}
  {!loading&&savedCursor.current&&<button type="button" onClick={()=>void scan(true,true)}>Continue search</button>}
  {notice&&<p role="status">{notice}</p>}
  {!!documents.length&&<><p className="fine-print">Duplicate file content is listed once. Already imported files are marked. Changed files are scanned as a new version; repeated facts are left out.</p>
   <input aria-label="Filter project files" placeholder="Find by file name or project folder" value={query} onChange={e=>setQuery(e.target.value)}/><div className="local-import-tools"><button type="button" disabled={busy} onClick={()=>setSelected(visible.filter(d=>!d.imported).slice(0,400).map(d=>d.id))}>Select new files (up to 400)</button>
    <button type="button" disabled={busy||!selected.length} onClick={()=>{void controller.importDocuments(selected);setSelected([]);}}>Import selected files ({selected.length})</button></div>
   <p className="fine-print">{visible.length} matching files. Showing the first 200; filter by name or project to narrow results.</p><ul>{visible.slice(0,200).map(doc=><li key={doc.id}><div className="local-import-row"><input type="checkbox" aria-label={'Select file '+doc.relative} checked={selected.includes(doc.id)} disabled={busy||doc.imported} onChange={()=>setSelected(old=>old.includes(doc.id)?old.filter(id=>id!==doc.id):[...old,doc.id])}/>
    <button type="button" className="local-import-open" disabled={loading} onClick={()=>void open(doc.id)} aria-label={'Preview file '+doc.relative}><span>{doc.relative}</span><span className="local-import-meta">{doc.root} · {Math.ceil(doc.bytes/1024)} KB{doc.imported?' · imported':''} · Preview →</span></button></div></li>)}</ul></>}
  {preview&&<aside aria-label="Project file preview"><header><h4>{preview.name}</h4><button type="button" onClick={()=>{ticket.current++;setPreview(undefined);}}>Close file preview</button></header><p className="fine-print">Read-only. Secrets masked. {preview.truncated?'Preview shortened; import reads the file within the documented size limit.':''}</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'24rem',overflow:'auto'}} dir="auto">{preview.text}</pre></aside>}
 </section>;
}
