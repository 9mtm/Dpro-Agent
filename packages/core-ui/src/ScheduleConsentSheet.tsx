import {useEffect,useId,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {SessionClient} from './session';
import {ScheduleConsentController} from './schedule-consent-controller';
import {UiIcon} from './ui-icons';
const display=(value:string)=>value.replace(/\[REDACTED:[a-z_]+\]/g,'Hidden').replace(/%5Bhidden%5D/gi,'Hidden');
const timing=(expression:string)=>{const daily=/^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expression);if(daily)return `Daily at ${daily[2].padStart(2,'0')}:${daily[1].padStart(2,'0')}`;const interval=/^\*\/(\d+) \* \* \* \*$/.exec(expression);return expression==='* * * * *'?'Every minute':interval?`Every ${interval[1]} minutes`:'Custom schedule';};
function ReviewValue({value}:{value:unknown}){
 if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&(value as {hidden?:boolean}).hidden===true)return <span className="fine-print">Hidden</span>;
 if(Array.isArray(value))return <ol>{value.map((child,index)=><li key={index}><ReviewValue value={child}/></li>)}</ol>;
 if(value&&typeof value==='object')return <dl className="schedule-consent-values">{Object.entries(value).map(([key,child])=><div key={key}><dt>{key}</dt><dd><ReviewValue value={child}/></dd></div>)}</dl>;
 return <span className="schedule-consent-text">{typeof value==='string'?display(value):value===null?'None':String(value)}</span>;
}
/** Reusable sheet for the existing selected-task inspector; it never executes the task. */
export function ScheduleConsentSheet({client,jobId,jobName,action,onClose}:{client:SessionClient;jobId:string;jobName:string;action:'authorize'|'revoke';onClose:()=>void}){
 const controller=useMemo(()=>new ScheduleConsentController(client,jobId,action),[client,jobId,action]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot),[hours,setHours]=useState(24),[code,setCode]=useState('');
 const dialog=useRef<HTMLDialogElement>(null),codeInput=useRef<HTMLInputElement>(null),confirm=useRef<HTMLButtonElement>(null),dismiss=useRef<HTMLButtonElement>(null),title=useId(),form=useId();
 const owner=client.getSnapshot().phase==='authenticated'&&client.getSnapshot().user?.role==='owner';
 const closeRef=useRef(onClose);closeRef.current=onClose;
 const close=()=>{controller.cancel();setCode('');dialog.current?.close();closeRef.current();};
 useEffect(()=>{
  if(!owner)return;const invoker=document.activeElement,element=dialog.current;element?.showModal();void controller.load();const epoch=client.getSnapshot().epoch;
  const unsubscribe=client.subscribe(()=>{const current=client.getSnapshot();if(current.epoch!==epoch||current.phase!=='authenticated'||current.user?.role!=='owner'){controller.cancel();setCode('');element?.close();closeRef.current();}});
  return()=>{unsubscribe();controller.cancel();element?.close();if(invoker instanceof HTMLElement&&invoker.isConnected)invoker.focus();};
 },[client,controller,owner]);
 useEffect(()=>{if(state.phase==='code')codeInput.current?.focus();if(state.phase==='verified')confirm.current?.focus();if(['applied','unknown','unavailable'].includes(state.phase))dismiss.current?.focus();},[state.phase]);
 if(!owner)return null;
 const subject=state.review?.name??jobName,busy=['loading','loading-code','verifying','applying'].includes(state.phase),review=state.review;
 return <dialog ref={dialog} className="verification-sheet schedule-consent-sheet" aria-labelledby={title} onCancel={event=>{event.preventDefault();close();}}>
  <header><UiIcon name="clock" size={20}/><h3 id={title}>{action==='authorize'?'Authorize scheduled action':'Revoke task permission'}</h3></header>
  <p className="approval-verification-tool">{subject}</p>
  {review&&<div className="schedule-consent-review"><dl className="schedule-consent-facts"><dt>Destination</dt><dd><ReviewValue value={review.actionType==='api-call'?review.action.url:review.action.to}/></dd><dt>Action</dt><dd>{review.actionType==='api-call'?'Service request':'Message delivery'}</dd><dt>Schedule</dt><dd>{timing(review.cronExpression)} · {review.timeZone}</dd></dl>
   <details><summary>Reviewed content and delivery details</summary><ReviewValue value={review.action}/><p className="fine-print">Schedule pattern: {review.cronExpression}</p></details>{review.maskedFields.length>0&&<p className="fine-print">Credentials and sensitive values are hidden.</p>}
  </div>}
  {state.phase==='review'&&action==='authorize'&&<label className="schedule-consent-duration">Permission duration<select aria-label="Permission duration" value={hours} onChange={event=>{const next=Number(event.target.value);setHours(next);void controller.load(next);}}><option value={1}>One hour</option><option value={24}>One day</option><option value={168}>One week</option></select></label>}
  {state.expiresAt&&<p className="fine-print">Permission until {new Date(state.expiresAt).toLocaleString()}.</p>}
  {action==='authorize'?<p className="fine-print">Permission covers this reviewed action. This does not run it now.</p>:<p>Future runs stop until you authorize this task again. A run already started may finish.</p>}
  {busy&&<p role="status">{state.phase==='applying'?'Saving permission…':state.phase==='verifying'?'Checking code…':state.phase==='loading-code'?'Preparing verification…':'Loading reviewed action…'}</p>}
  {state.notice&&<p role="alert">{state.notice==='refused'?'Code refused. Check your authenticator and try again.':state.notice==='limited'?'Too many attempts. Close this window and wait before trying again.':state.notice==='expired'?'Verification expired. Close this window and review the task again.':'Permission unavailable. Close this window and refresh the task.'}</p>}
  {(state.phase==='code'||state.phase==='verifying')&&<form id={form} onSubmit={event=>{event.preventDefault();const submitted=code;setCode('');void controller.verify(submitted);}}><fieldset disabled={state.phase==='verifying'}><label>Authenticator code<input ref={codeInput} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={code} onChange={event=>setCode(event.target.value.trim())}/></label><p className="fine-print">Verifying the code does not change permission.</p></fieldset></form>}
  {state.phase==='verified'&&<p role="status">Verified. Confirm {action==='authorize'?'permission for':'revoking permission for'} this reviewed action?</p>}
  {state.phase==='applied'&&<p role="status">{action==='authorize'?'Permission granted.':'Permission revoked.'}</p>}
  {state.phase==='unknown'&&<div role="alert"><p>The result could not be confirmed. Close this window and refresh the task before taking another action.</p>{state.readback&&<p className="fine-print">Current permission: {state.readback==='authorized'?'active':state.readback==='authorization_required'?'authorization required':'not required'}. This does not confirm the last change.</p>}</div>}
  <div className="actions"><button ref={dismiss} type="button" onClick={close}>{state.phase==='applied'?'Done':'Cancel'}</button>
   {state.phase==='review'&&<button type="button" className="primary" onClick={()=>void controller.startVerification()}>Continue to verification</button>}
   {(state.phase==='code'||state.phase==='verifying')&&<button form={form} type="submit" className="primary" disabled={state.phase==='verifying'}>Verify code</button>}
   {state.phase==='verified'&&<button ref={confirm} type="button" className="primary" onClick={()=>void controller.apply()}>{action==='authorize'?'Authorize':'Revoke permission'}</button>}
  </div>
 </dialog>;
}
