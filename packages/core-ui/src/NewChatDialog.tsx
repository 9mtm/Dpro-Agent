import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {ProjectFolderPicker} from './ProjectFolderPicker';
import type {ConversationsController} from './conversations';
export function NewChatDialog({controller,onClose}:{controller:ConversationsController;onClose:()=>void}){
 const s=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot),dialog=useRef<HTMLDialogElement>(null);
 const [pick,setPick]=useState(false),[folder,setFolder]=useState(''),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const old=document.activeElement;dialog.current?.showModal();void controller.loadProjects();return()=>{dialog.current?.close();if(old instanceof HTMLElement)old.focus();};},[controller]);
 const start=(id:string)=>{controller.filterProject(id);controller.newChat();onClose();};
 const useFolder=async()=>{if(!folder||!name.trim()||busy)return;const existing=s.projects.find(p=>p.folder===folder);if(existing){start(existing.id);return;}setBusy(true);const err=await controller.createProject({name,folder,repoUrl:''});setBusy(false);if(err)setError(err);else onClose();};
 return <dialog ref={dialog} className="folder-picker new-chat-dialog" aria-label="Start a new chat" onCancel={e=>{e.preventDefault();onClose();}}>
  <h2>New chat</h2><p className="fine-print">Choose where this conversation belongs. Coding apps work in the selected project folder.</p>
  <button type="button" className="new-chat-choice" disabled={busy} onClick={()=>start('')}><strong>General conversation</strong><span>No project folder. Ask questions or plan your work.</span></button>
  <button type="button" className="new-chat-choice" disabled={busy} onClick={()=>setPick(true)}><strong>Choose a folder…</strong><span>Chat and work with files in a project.</span></button>
  {s.projects.length>0&&<label>Existing project<select aria-label="Choose an existing project" value="" disabled={busy} onChange={e=>e.target.value&&start(e.target.value)}><option value="">Select a project…</option>{s.projects.map(p=><option key={p.id} value={p.id}>{p.name}{p.folder?' · '+p.folder:''}</option>)}</select></label>}
  {folder&&<div className="new-chat-folder"><label>Project name<input aria-label="New chat project name" value={name} maxLength={80} disabled={busy} onChange={e=>setName(e.target.value)}/></label><p className="folder-picker-path" dir="ltr">{folder}</p><button type="button" className="primary" disabled={busy||!name.trim()} onClick={()=>void useFolder()}>{busy?'Opening…':'Start in this folder'}</button></div>}
  {error&&<p role="alert">{error}</p>}<div className="actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button></div>
  {pick&&<ProjectFolderPicker controller={controller} onClose={()=>setPick(false)} onSelect={p=>{setFolder(p);setName(p.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0,80)||'Project');setPick(false);}}/>}
 </dialog>;
}
