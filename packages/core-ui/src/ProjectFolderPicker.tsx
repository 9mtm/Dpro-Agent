import {useEffect,useRef,useState} from 'react';
import type {ConversationsController} from './conversations';
type FolderView=Awaited<ReturnType<ConversationsController['browseProjectFolders']>>;
/** Opens only after an explicit click; cancel never changes the selected folder. */
export function ProjectFolderPicker({controller,onSelect,onClose}:{controller:ConversationsController;onSelect:(path:string)=>void;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),sequence=useRef(0);const [view,setView]=useState<FolderView|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState('');
 const load=async(path?:string)=>{const key=++sequence.current;setBusy(true);setError('');try{const next=await controller.browseProjectFolders(path);if(key===sequence.current)setView(next);}catch{if(key===sequence.current)setError('This folder could not be opened. Choose another folder or try again.');}finally{if(key===sequence.current)setBusy(false);}};
 useEffect(()=>{const focus=document.activeElement;dialog.current?.showModal();void load();return()=>{sequence.current++;dialog.current?.close();if(focus instanceof HTMLElement)focus.focus();};},[controller]);
 return <dialog ref={dialog} className="folder-picker" aria-label="Choose project folder" onCancel={e=>{e.preventDefault();onClose();}}>
  <h3>Choose project folder</h3><p className="fine-print">Browse folders on this computer. Choosing a folder does not import its files.</p>
  {view&&<><p className="folder-picker-path" dir="ltr">{view.path}</p><button type="button" disabled={busy||!view.parent} onClick={()=>void load(view.parent!)}>Up one folder</button></>}
  {busy&&<p role="status">Loading folders…</p>}{error&&<p role="alert">{error} <button type="button" onClick={()=>void load(view?.path)}>Try again</button></p>}
  <ul className="folder-picker-list" aria-label="Folders">{view?.entries.map(entry=><li key={entry.path}><button type="button" disabled={busy} onClick={()=>void load(entry.path)}>{entry.name}</button></li>)}</ul>
  {view&&!busy&&!view.entries.length&&!error&&<p>No subfolders. You can choose this folder.</p>}{view?.truncated&&<p>Only the first 500 folders are shown.</p>}
  <div className="actions"><button type="button" className="primary" disabled={busy||!!error||!view?.selectable} onClick={()=>view&&onSelect(view.path)}>Use this folder</button><button type="button" onClick={onClose}>Cancel</button></div>
 </dialog>;
}
