import {useEffect,useId,useMemo,useRef,useSyncExternalStore} from 'react';
import type {SessionClient} from './session';
import {DesignRuleReviewController} from './design-rule-review-controller';
import {UiIcon} from './ui-icons';
export function DesignRuleReviewSheet({client,slug,ruleId,onClose}:{client:SessionClient;slug:string;ruleId:string;onClose:()=>void}){
 const controller=useMemo(()=>new DesignRuleReviewController(client,slug,ruleId),[client,slug,ruleId]),state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot),dialog=useRef<HTMLDialogElement>(null),dismiss=useRef<HTMLButtonElement>(null),title=useId(),closeRef=useRef(onClose);closeRef.current=onClose;
 const owner=client.getSnapshot().phase==='authenticated'&&client.getSnapshot().user?.role==='owner';
 const close=()=>{controller.cancel();dialog.current?.close();closeRef.current();};
 useEffect(()=>{if(!owner)return;const element=dialog.current,invoker=document.activeElement,epoch=client.getSnapshot().epoch;element?.showModal();void controller.load();dismiss.current?.focus();const unsubscribe=client.subscribe(()=>{const current=client.getSnapshot();if(current.epoch!==epoch||current.phase!=='authenticated'||current.user?.role!=='owner'){controller.cancel();element?.close();closeRef.current();}});return()=>{unsubscribe();controller.cancel();element?.close();if(invoker instanceof HTMLElement&&invoker.isConnected)invoker.focus();};},[client,controller,owner]);
 useEffect(()=>{if(['applied','stale','unknown','unavailable'].includes(state.phase))dismiss.current?.focus();},[state.phase]);
 if(!owner)return null;
 return <dialog ref={dialog} className="verification-sheet design-rule-sheet" aria-labelledby={title} onCancel={event=>{event.preventDefault();close();}}><header><UiIcon name="shield" size={20}/><h3 id={title}>Review project rule</h3></header><div className="design-rule-content">
  {state.rule&&<><p className="fine-print">Found in {state.rule.source}</p><p>{state.rule.confirmed?'Used as project guidance':'Not approved'}</p><pre className="design-rule-text" dir="auto">{state.rule.text}</pre><p className="fine-print">Project guidance cannot grant permissions or run actions.</p></>}
  {state.phase==='loading'&&<p role="status">Loading the full rule…</p>}{state.phase==='applying'&&<p role="status">Saving your choice…</p>}
  {state.limited&&<p role="alert">Wait before trying again.</p>}
  {state.phase==='applied'&&<p role="status">{state.rule?.confirmed?'Rule is now used as project guidance.':'Rule is no longer approved.'}{state.filePending?' The project file could not be refreshed; your stored choice was saved.':''}</p>}
  {state.phase==='stale'&&<div role="alert"><p>The project rules changed. Reload and review the current text before deciding.</p><button type="button" onClick={()=>void controller.load()}>Reload rule</button></div>}
  {state.phase==='unknown'&&<p role="alert">Unable to confirm the change. Close this window and refresh the project before deciding again. Do not repeat this request.</p>}
  {state.phase==='unavailable'&&<p role="alert">This exact rule is unavailable. Close this window and refresh the project.</p>}
 </div><div className="actions"><button ref={dismiss} type="button" onClick={close}>{['applied','unknown','unavailable'].includes(state.phase)?'Close':'Cancel'}</button>{state.phase==='review'&&<button type="button" className="primary" onClick={()=>void controller.apply()}>{state.rule?.confirmed?'Stop using rule':'Use rule'}</button>}</div></dialog>;
}
