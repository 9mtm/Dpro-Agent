import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {SessionClient} from './session';
import {ApprovalVerificationController} from './approval-verification-controller';
export function ApprovalVerificationSheet({client,id,paramsHash,toolName,onClose,onApprove}:{client:SessionClient;id:string;paramsHash:string;toolName:string;onClose:()=>void;onApprove:(receipt:string)=>void}){
 const controller=useMemo(()=>new ApprovalVerificationController(client,id,paramsHash),[client,id,paramsHash]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot),dialog=useRef<HTMLDialogElement>(null),[code,setCode]=useState('');
 useEffect(()=>{const element=dialog.current;element?.showModal();void controller.start();return()=>{controller.cancel();element?.close();};},[controller]);
 const close=()=>{controller.cancel();setCode('');dialog.current?.close();onClose();};
 const closeRef=useRef(close);closeRef.current=close;
 useEffect(()=>{const epoch=client.getSnapshot().epoch;return client.subscribe(()=>{const current=client.getSnapshot();if(current.epoch!==epoch||current.phase!=='authenticated')closeRef.current();});},[client,controller]);
 return <dialog ref={dialog} className="verification-sheet" aria-labelledby="approval-verification-title" onCancel={event=>{event.preventDefault();close();}}>
  <h3 id="approval-verification-title">Verify this approval</h3><p className="approval-verification-tool">{toolName} · one execution</p>
  {(state.phase==='loading'||state.phase==='verifying')&&<p role="status">{state.phase==='loading'?'Preparing verification…':'Checking code…'}</p>}
  {state.notice&&<p role="alert">{state.notice==='refused'?'Code refused. Check your authenticator and try again.':state.notice==='limited'?'Too many attempts. Wait before starting again.':state.notice==='expired'?'Verification expired. Close this window and start again.':'Verification unavailable. Close this window and review the request again.'}</p>}
  {(state.phase==='code'||state.phase==='verifying')&&<form id="approval-verification-form" onSubmit={event=>{event.preventDefault();const submitted=code;setCode('');void controller.verify(submitted);}}><fieldset disabled={state.phase==='verifying'}><label htmlFor="approval-verification-code">Authenticator code</label><input id="approval-verification-code" autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={code} onChange={event=>setCode(event.target.value.trim())}/><p className="fine-print">Verification alone does not run the tool.</p></fieldset></form>}
  {state.phase==='verified'&&<p role="status">Verified. Approve this reviewed request once?</p>}
  <div className="actions">
   {(state.phase==='code'||state.phase==='verifying')&&<button form="approval-verification-form" type="submit" className="primary" disabled={state.phase==='verifying'}>Verify code</button>}
   {state.phase==='verified'&&<button type="button" className="primary" autoFocus onClick={()=>{const receipt=controller.takeReceipt();if(!receipt)return;dialog.current?.close();onApprove(receipt);}}>Approve once</button>}
   <button type="button" onClick={close}>Cancel</button>
  </div>
 </dialog>;
}
