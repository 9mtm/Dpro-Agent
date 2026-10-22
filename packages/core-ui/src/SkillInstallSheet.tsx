import {useEffect,useId,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {SessionClient} from './session';
import {SkillInstallController} from './skill-install-controller';
import {UiIcon} from './ui-icons';
type Source=Readonly<{commit:string;sourcePath:string;targetName:string}>;
/** Selected manual-owner review. Mounting the parent catalogue never installs a skill. */
export function SkillInstallSheet({client,source,onClose}:{client:SessionClient;source:Source;onClose:(result:'applied'|'unknown'|'cancelled')=>void}){
 const controller=useMemo(()=>new SkillInstallController(client,{commit:source.commit,sourcePath:source.sourcePath,targetName:source.targetName}),[client,source.commit,source.sourcePath,source.targetName]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot),session=useSyncExternalStore(client.subscribe,client.getSnapshot,client.getSnapshot),[code,setCode]=useState('');
 const dialog=useRef<HTMLDialogElement>(null),dismiss=useRef<HTMLButtonElement>(null),input=useRef<HTMLInputElement>(null),confirm=useRef<HTMLButtonElement>(null),title=useId(),form=useId(),callback=useRef(onClose);callback.current=onClose;
 const owner=session.phase==='authenticated'&&session.user?.role==='owner';
 const close=()=>{const phase=controller.getSnapshot().phase;controller.cancel();setCode('');dialog.current?.close();callback.current(phase==='applied'?'applied':phase==='unknown'||phase==='applying'?'unknown':'cancelled');};
 useEffect(()=>{
  if(!owner)return;const invoker=document.activeElement,element=dialog.current,epoch=client.getSnapshot().epoch;let ended=false;
  element?.showModal();dismiss.current?.focus();void controller.load();
  const unsubscribe=client.subscribe(()=>{const current=client.getSnapshot();if(!ended&&(current.epoch!==epoch||current.phase!=='authenticated'||current.user?.role!=='owner')){ended=true;const phase=controller.getSnapshot().phase;controller.cancel();setCode('');element?.close();callback.current(phase==='applying'||phase==='unknown'?'unknown':'cancelled');}});
  return()=>{ended=true;unsubscribe();controller.cancel();setCode('');element?.close();if(invoker instanceof HTMLElement&&invoker.isConnected)invoker.focus();};
 },[client,controller,owner]);
 useEffect(()=>{if(state.phase==='code')input.current?.focus();if(state.phase==='verified')confirm.current?.focus();if(['applied','unknown','unavailable'].includes(state.phase))dismiss.current?.focus();},[state.phase]);
 if(!owner)return null;
 const review=state.review,busy=['loading','loading-code','verifying','applying'].includes(state.phase),done=['applied','unknown','unavailable'].includes(state.phase);
 return <dialog ref={dialog} className="verification-sheet skill-install-sheet" aria-labelledby={title} onCancel={event=>{event.preventDefault();close();}}>
  <header><UiIcon name="file" size={20}/><h3 id={title}>Review skill</h3></header>
  <div className="skill-install-body">
   <p className="skill-install-name">{review?.name??source.targetName}</p>
   <p className="fine-print">Official skills repository · Fixed version</p>
   {review&&<><p>{review.description}</p><p className="fine-print">{review.updating?'Updates existing guidance.':'Adds guidance to your library.'} No tools or agent assignments.</p>
    <details className="skill-install-source"><summary>Source details</summary><dl><dt>File</dt><dd>{source.sourcePath}/SKILL.md</dd><dt>Version</dt><dd>{review.version}</dd></dl></details>
    <section aria-label="Reviewed skill content"><h4>SKILL.md</h4><pre tabIndex={0}>{review.content}</pre></section>
   </>}
   {busy&&<p role="status">{state.phase==='applying'?'Installing reviewed skill…':state.phase==='verifying'?'Checking code…':state.phase==='loading-code'?'Preparing verification…':'Loading reviewed skill…'}</p>}
   {state.notice&&<p role="alert">{state.notice==='refused'?'Code refused. Check your authenticator and try again.':state.notice==='limited'?'Too many attempts. Close this window and wait before trying again.':state.notice==='expired'?'Review expired. Close this window and review the skill again.':'Installation unavailable. Close this window and refresh the library.'}</p>}
   {(state.phase==='code'||state.phase==='verifying')&&<form id={form} onSubmit={event=>{event.preventDefault();const submitted=code;setCode('');void controller.verify(submitted);}}><fieldset disabled={state.phase==='verifying'}><label>Authenticator code<input ref={input} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={code} onChange={event=>setCode(event.target.value.replace(/[^0-9]/g,'').slice(0,6))}/></label><p className="fine-print">Verification alone does not install the skill.</p></fieldset></form>}
   {state.phase==='verified'&&<p role="status">Identity verified. Install the exact content you reviewed?</p>}
   {state.phase==='applied'&&<p role="status">{review?.updating?'Guidance updated.':'Added to library.'} The skill stays unassigned.</p>}
   {state.phase==='unknown'&&<p role="alert">The installation result could not be confirmed. Close this window and refresh the library before trying again.</p>}
  </div>
  <footer className="actions"><button ref={dismiss} type="button" onClick={close}>{done?'Close':'Cancel'}</button>
   {state.phase==='review'&&<button className="primary" type="button" onClick={()=>void controller.startVerification()}>Continue</button>}
   {(state.phase==='code'||state.phase==='verifying')&&<button className="primary" type="submit" form={form} disabled={state.phase==='verifying'}>Verify code</button>}
   {state.phase==='verified'&&<button ref={confirm} className="primary" type="button" onClick={()=>void controller.apply()}>Install skill</button>}
  </footer>
 </dialog>;
}
