import {useEffect,useId,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {SessionClient} from './session';
import type {ChannelEntry} from './agent-connect-contract.js';
import {AGENT_CONNECT_PATH} from './agent-connect-contract.js';
import {ScheduledDefinitionController} from './scheduled-definition-controller';
import {scheduleDraft,scheduleDraftChanges,scheduleDeliveryReplacement,type ScheduleDraft} from './scheduled-definition-form';
import {UiIcon} from './ui-icons';
const blankAction={method:'GET',url:'',channelId:'',to:'',content:'',replaceHeaders:false,headers:'',replaceBody:false,body:'',replaceOptions:false,options:''};
/** Edits one task definition. Saving never enables, authorizes or runs it. */
export function ScheduledDefinitionSheet({client,jobId,creating=false,onClose,onOpenConnections}:{client:SessionClient;jobId:string;creating?:boolean;onClose:()=>void;onOpenConnections?:()=>void}){
 const controller=useMemo(()=>new ScheduledDefinitionController(client,jobId,creating),[client,jobId,creating]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 const [draft,setDraft]=useState(()=>scheduleDraft(null)),[notice,setNotice]=useState(''),[channels,setChannels]=useState<ChannelEntry[]>([]),[catalog,setCatalog]=useState<'loading'|'ready'|'unavailable'>('loading');
 const dialog=useRef<HTMLDialogElement>(null),name=useRef<HTMLInputElement>(null),dismiss=useRef<HTMLButtonElement>(null),title=useId(),form=useId();
 const closeRef=useRef(onClose);closeRef.current=onClose;
 const owner=client.getSnapshot().phase==='authenticated'&&client.getSnapshot().user?.role==='owner';
 function close(){controller.cancel();setDraft(scheduleDraft(null));setChannels([]);setNotice('');dialog.current?.close();closeRef.current();}
 useEffect(()=>{
  if(!owner)return;const invoker=document.activeElement,element=dialog.current,epoch=client.getSnapshot().epoch;let disposed=false;
  element?.showModal();void controller.load();
  void client.request({method:'GET',path:AGENT_CONNECT_PATH+'/catalog'}).then(response=>{if(disposed)return;const value=response.body as {channels?:ChannelEntry[]};if(response.status!==200||!Array.isArray(value.channels)){setCatalog('unavailable');return;}setChannels(value.channels.filter(channel=>channel.configured));setCatalog('ready');}).catch(()=>{if(!disposed)setCatalog('unavailable');});
  const unsubscribe=client.subscribe(()=>{const current=client.getSnapshot();if(current.epoch!==epoch||current.phase!=='authenticated'||current.user?.role!=='owner'){controller.cancel();setDraft(scheduleDraft(null));setChannels([]);setNotice('');element?.close();closeRef.current();}});
  return()=>{disposed=true;unsubscribe();controller.cancel();element?.close();if(invoker instanceof HTMLElement&&invoker.isConnected)invoker.focus();};
 },[client,controller,owner]);
 useEffect(()=>{if(state.phase==='ready'&&!state.notice){setDraft(scheduleDraft(state.review));setNotice('');name.current?.focus();}if(['saved','unknown','unavailable'].includes(state.phase))dismiss.current?.focus();},[state.phase,state.review]);
 const ready=state.phase==='ready',review=state.review,full=!review||draft.actionType!==review.actionType,replacing=full||draft.replaceAction;
 const update=<K extends keyof ScheduleDraft>(key:K,value:ScheduleDraft[K])=>{setDraft(current=>({...current,[key]:value}));setNotice('');};
 function submit(){if(!ready)return;try{const changes=scheduleDraftChanges(jobId,draft,review);if(!Object.keys(changes).length){setNotice('No changes to save.');return;}setNotice('');void controller.save(changes);}catch(error){setNotice(error instanceof Error?error.message:'Check the changed fields.');}}
 if(!owner)return null;
 return <dialog ref={dialog} className="verification-sheet schedule-editor-sheet" aria-labelledby={title} onCancel={event=>{event.preventDefault();close();}} onKeyDown={event=>{if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();submit();}}}>
  <header><UiIcon name="clock" size={20}/><h3 id={title}>{creating?'New scheduled task':'Edit scheduled task'}</h3></header>
  <p className="fine-print">Save paused. Review permission before enabling.</p>
  <div className="schedule-editor-content">
   {['closed','loading'].includes(state.phase)&&<p role="status">Loading task…</p>}
   {['ready','saving','conflict'].includes(state.phase)&&<form id={form} onSubmit={event=>{event.preventDefault();submit();}}><fieldset disabled={!ready}>
    <label>Name<input ref={name} required maxLength={200} value={draft.name} onChange={event=>update('name',event.target.value)}/></label>
    <label>Action<select value={draft.actionType} onChange={event=>{const actionType=event.target.value as ScheduleDraft['actionType'];setDraft(current=>({...current,...blankAction,actionType,replaceAction:true}));setNotice('');}}><option value="api-call">Send a service request</option><option value="send-message">Send a message</option></select></label>
    <div className="schedule-editor-pair"><label>Repeat<select value={draft.recurrence} onChange={event=>update('recurrence',event.target.value as ScheduleDraft['recurrence'])}>{review&&<option value="unchanged">Keep current schedule</option>}<option value="daily">Every day</option><option value="weekly">Every week</option><option value="custom">Custom schedule</option></select></label>
     {['daily','weekly'].includes(draft.recurrence)&&<label>Time<input type="time" required value={draft.time} onChange={event=>update('time',event.target.value)}/></label>}</div>
    {draft.recurrence==='weekly'&&<label>Day<select value={draft.weekday} onChange={event=>update('weekday',event.target.value)}>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day,index)=><option value={index} key={day}>{day}</option>)}</select></label>}
    <p className="fine-print">{review?`Application server time: ${review.timeZone}`:'Uses application server time.'}</p>
    {review&&!full&&<div className="schedule-editor-existing"><p className="fine-print">Current destination: {String(review.actionType==='api-call'?review.action.url:review.action.to).replace(/%5Bhidden%5D/gi,'Hidden').replace(/\[REDACTED:[a-z_]+\]/gi,'Hidden')}</p><label className="schedule-editor-toggle"><input type="checkbox" checked={draft.replaceAction} onChange={event=>setDraft(current=>scheduleDeliveryReplacement(current,event.target.checked))}/>Replace destination and delivery</label><p className="fine-print">Unchanged delivery details and hidden values are kept.</p></div>}
    {replacing&&(draft.actionType==='api-call'?<label>Destination<input type="url" required autoComplete="off" maxLength={2048} value={draft.url} placeholder="Service address" onChange={event=>update('url',event.target.value)}/></label>:<>
     <label>Integration<select required value={draft.channelId} onChange={event=>update('channelId',event.target.value)}><option value="">{catalog==='loading'?'Loading connections…':catalog==='unavailable'?'Connections unavailable':'Choose a configured integration'}</option>{channels.map(channel=><option key={channel.id} value={channel.id}>{channel.label}</option>)}</select></label>
     {catalog==='ready'&&!channels.length&&<div><p role="status">Configure an integration in Connections before creating a message task.</p>{onOpenConnections&&<button type="button" onClick={()=>{close();onOpenConnections();}}>Open connections</button>}</div>}
     <label>Recipient<input required maxLength={500} autoComplete="off" value={draft.to} onChange={event=>update('to',event.target.value)}/></label>
     <label>Message<textarea required maxLength={20000} rows={4} value={draft.content} onChange={event=>update('content',event.target.value)}/></label>
    </>)}
    <details open={draft.recurrence==='custom'?true:undefined}><summary>Advanced</summary><div className="schedule-editor-advanced">
     <label>Description<textarea rows={2} maxLength={2000} value={draft.description} onChange={event=>update('description',event.target.value)}/></label>
     {draft.recurrence==='custom'&&<label>Schedule pattern<input required maxLength={200} value={draft.cron} onChange={event=>update('cron',event.target.value)}/></label>}
     {draft.actionType==='api-call'?<>
      {replacing&&<label>Request method<select value={draft.method} onChange={event=>update('method',event.target.value)}>{['GET','POST','PUT','DELETE','PATCH'].map(method=><option key={method}>{method}</option>)}</select></label>}
      <label className="schedule-editor-toggle"><input type="checkbox" checked={draft.replaceHeaders} onChange={event=>{update('replaceHeaders',event.target.checked);update('headers','');}}/>Replace all request headers</label>
      {draft.replaceHeaders&&<label>New headers (JSON)<textarea required autoComplete="off" spellCheck={false} rows={3} value={draft.headers} onChange={event=>update('headers',event.target.value)}/></label>}
      <label className="schedule-editor-toggle"><input type="checkbox" checked={draft.replaceBody} onChange={event=>{update('replaceBody',event.target.checked);update('body','');}}/>Replace request content</label>
      {draft.replaceBody&&<label>New content (JSON)<textarea required autoComplete="off" spellCheck={false} rows={4} value={draft.body} onChange={event=>update('body',event.target.value)}/></label>}
     </>:<><label className="schedule-editor-toggle"><input type="checkbox" checked={draft.replaceOptions} onChange={event=>{update('replaceOptions',event.target.checked);update('options','');}}/>Replace delivery options</label>{draft.replaceOptions&&<label>New options (JSON)<textarea required autoComplete="off" spellCheck={false} rows={3} value={draft.options} onChange={event=>update('options',event.target.value)}/></label>}</>}
     <p className="fine-print">Replacement fields start empty. Enter the complete new value; other fields stay unchanged.</p>
    </div></details>
   </fieldset></form>}
   {state.phase==='saving'&&<p role="status">Saving paused task…</p>}
   {(notice||state.notice)&&<p role="alert">{notice||(state.notice==='limited'?'Wait before trying to save again.':'Check the changed fields. The task was not confirmed saved.')}</p>}
   {state.phase==='conflict'&&<div role="alert"><p>This task changed elsewhere. Your unsaved text is still shown. Reloading discards it.</p><button type="button" onClick={()=>void controller.load()}>Reload latest</button></div>}
   {state.phase==='saved'&&<p role="status">Saved paused. Permission is required before enabling.</p>}
   {state.phase==='unknown'&&<p role="alert">Unable to confirm save. Close this window and refresh the task before editing again. Do not repeat this save.</p>}
   {state.phase==='unavailable'&&<p role="alert">Task unavailable. Close this window and refresh the task.</p>}
  </div>
  <div className="actions"><button ref={dismiss} type="button" onClick={close}>{['saved','unknown','unavailable'].includes(state.phase)?'Close':'Cancel'}</button>{(ready||state.phase==='saving')&&<button type="submit" form={form} className="primary" disabled={!ready}>Save paused</button>}</div>
 </dialog>;
}
