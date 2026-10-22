import {UiIcon} from './ui-icons';
import {useEffect,useRef,useState} from 'react';
import type {ConversationsController} from './conversations';
type FolderView=Awaited<ReturnType<ConversationsController['browseProjectFolders']>>;
/** Opens only after an explicit click; cancel never changes the selected folder. */
export function ProjectFolderPicker({controller,onSelect,onClose}:{controller:ConversationsController;onSelect:(path:string)=>void;onClose:()=>void}){
 const [pathDraft,setPathDraft]=useState(''),[query,setQuery]=useState('');
 const dialog=useRef<HTMLDialogElement>(null),sequence=useRef(0);const [view,setView]=useState<FolderView|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState('');
 const load=async(path?:string)=>{const key=++sequence.current;setBusy(true);setError('');try{const next=await controller.browseProjectFolders(path);if(key===sequence.current){setView(next);setPathDraft(next.path);setQuery('');}}catch{if(key===sequence.current)setError('This folder could not be opened. Choose another folder or try again.');}finally{if(key===sequence.current)setBusy(false);}};
 useEffect(()=>{const focus=document.activeElement;dialog.current?.showModal();void load();return()=>{sequence.current++;dialog.current?.close();if(focus instanceof HTMLElement)focus.focus();};},[controller]);
 return <dialog ref={dialog} className="folder-picker" aria-label="Choose project folder" onCancel={e=>{e.preventDefault();onClose();}}>
  <h3>Choose project folder</h3><p className="fine-print">Browse folders on this computer. Choosing a folder does not import its files.</p>
  <form className="folder-path-entry" onSubmit={e=>{e.preventDefault();void load(pathDraft.trim()||undefined);}}><button type="button" title="Up one folder" aria-label="Up one folder" disabled={busy||!view?.parent} onClick={()=>void load(view!.parent!)}><UiIcon name="arrow-up" size={15}/></button><label><span className="sr-only">Folder path</span><input aria-label="Folder path" dir="ltr" value={pathDraft} disabled={busy} onChange={e=>setPathDraft(e.target.value)} placeholder="Enter a folder path"/></label><button type="submit" title="Open folder path" aria-label="Open folder path" disabled={busy}><UiIcon name="arrow-up" size={15}/></button></form>
  <label className="folder-search"><UiIcon name="search" size={14}/><input type="search" aria-label="Filter folders" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Filter this folder"/></label>
  {busy&&<p role="status">Loading folders…</p>}{error&&<p role="alert">{error} <button type="button" onClick={()=>void load(view?.path)}>Try again</button></p>}
  <ul className="folder-picker-list" aria-label="Folders">{view?.entries.filter(entry=>entry.name.toLowerCase().includes(query.toLowerCase())).map(entry=><li key={entry.path}><button type="button" disabled={busy} onClick={()=>void load(entry.path)}><UiIcon name="folder" size={15}/>{entry.name}</button></li>)}</ul>
  {view&&!busy&&!view.entries.length&&!error&&<p>No subfolders. You can choose this folder.</p>}{view?.truncated&&<p>Only the first 500 folders are shown.</p>}
  <div className="actions"><button type="button" className="primary" disabled={busy||!!error||!view?.selectable} onClick={()=>view&&onSelect(view.path)}>Use this folder</button><button type="button" onClick={onClose}>Cancel</button></div>
 </dialog>;
}
