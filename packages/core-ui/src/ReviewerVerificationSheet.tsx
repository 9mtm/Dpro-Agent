import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {SessionClient} from './session';
import {ReviewerProofController,type ReviewerProofTarget} from './reviewer-proof-controller';
export function ReviewerVerificationSheet({client,target,subject,finalLabel,onClose,onConfirm}:{client:SessionClient;target:ReviewerProofTarget;subject:string;finalLabel:'Record decision'|'Activate rule'|'Withdraw rule';onClose:()=>void;onConfirm:(receipt:string)=>void}){
 const controller=useMemo(()=>new ReviewerProofController(client,target),[client,target]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot),dialog=useRef<HTMLDialogElement>(null),[code,setCode]=useState('');
 useEffect(()=>{const element=dialog.current;element?.showModal();void controller.start();return()=>{controller.cancel();element?.close();};},[controller]);
 const close=()=>{controller.cancel();setCode('');dialog.current?.close();onClose();};
 const closeRef=useRef(close);closeRef.current=close;
 useEffect(()=>{const epoch=client.getSnapshot().epoch;return client.subscribe(()=>{const current=client.getSnapshot();if(current.epoch!==epoch||current.phase!=='authenticated')closeRef.current();});},[client,controller]);
 return <dialog ref={dialog} className="verification-sheet" aria-labelledby="reviewer-verification-title" onCancel={event=>{event.preventDefault();close();}}>
  <h3 id="reviewer-verification-title">Verify this decision</h3><p className="approval-verification-tool">{subject}</p>
  {(state.phase==='loading'||state.phase==='verifying')&&<p role="status">{state.phase==='loading'?'Preparing verification…':'Checking code…'}</p>}
  {state.notice&&<p role="alert">{state.notice==='refused'?'Code refused. Check your authenticator and try again.':state.notice==='limited'?'Too many attempts. Wait before starting again.':state.notice==='expired'?'Verification expired. Close this window and start again.':'Verification unavailable. Close this window and review the request again.'}</p>}
  {(state.phase==='code'||state.phase==='verifying')&&<form id="reviewer-verification-form" onSubmit={event=>{event.preventDefault();const submitted=code;setCode('');void controller.verify(submitted);}}><fieldset disabled={state.phase==='verifying'}><label htmlFor="reviewer-verification-code">Authenticator code</label><input id="reviewer-verification-code" autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={code} onChange={event=>setCode(event.target.value.trim())}/><p className="fine-print">Verification alone records nothing.</p></fieldset></form>}
  {state.phase==='verified'&&<p role="status">Verified. Confirm this reviewed decision?</p>}
  <div className="actions">
   {(state.phase==='code'||state.phase==='verifying')&&<button form="reviewer-verification-form" type="submit" className="primary" disabled={state.phase==='verifying'}>Verify code</button>}
   {state.phase==='verified'&&<button type="button" className="primary" autoFocus onClick={()=>{const receipt=controller.takeReceipt();if(!receipt)return;dialog.current?.close();onConfirm(receipt);}}>{finalLabel}</button>}
   <button type="button" onClick={close}>Cancel</button>
  </div>
 </dialog>;
}
