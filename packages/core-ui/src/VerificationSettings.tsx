import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {SessionClient} from './session';
import {VerificationController} from './verification-controller';
export function VerificationSettings({client}:{client:SessionClient}){
 const [open,setOpen]=useState(false);
 if(client.getSnapshot().user?.role==='guest')return null;
 return <><div className="settings-row"><div><span>Two-step verification</span><p className="fine-print">Add an authenticator and recovery codes to your account.</p></div><button type="button" onClick={()=>setOpen(true)}>Manage verification</button></div>{open&&<VerificationSheet client={client} onClose={()=>setOpen(false)}/>}</>;
}
function VerificationSheet({client,onClose}:{client:SessionClient;onClose:()=>void}){
 const controller=useMemo(()=>new VerificationController(client),[client]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 const dialog=useRef<HTMLDialogElement>(null),[password,setPassword]=useState(''),[code,setCode]=useState('');
 useEffect(()=>{const element=dialog.current;element?.showModal();void controller.load();return()=>{controller.cancel();element?.close();};},[controller]);
 const close=()=>{dialog.current?.close();onClose();};
 const busy=state.phase==='loading'||state.phase==='working';
 return <dialog ref={dialog} className="verification-sheet" aria-labelledby="verification-title" onCancel={event=>{event.preventDefault();close();}}>
  <h3 id="verification-title">Two-step verification</h3>
  {state.phase==='loading'?<p role="status">Checking verification…</p>:state.phase==='unavailable'?<><p role="alert">Verification is unavailable. Check account status before continuing.</p><button type="button" onClick={()=>void controller.load()}>Check again</button></>:<>
   <p>{state.enabled?'On · An authenticator code is required at sign-in.':'Off · Sign-in uses your password.'}</p>
   {state.notice&&<p role="alert">{state.notice==='refused'?'Password or code refused. Check them and try again.':state.notice==='limited'?'Too many attempts. Wait before trying again.':state.notice==='expired'?'Setup expired. Start again for a new key.':'Outcome unknown. Check your account status before trying again.'}</p>}
   {state.setup&&<section aria-label="Authenticator setup"><p>Add this key in your authenticator as Dpro Agent.</p><label>Setup key<code className="verification-setup-key">{state.setup.secret}</code></label><p className="fine-print">Keep it private. Setup expires after ten minutes.</p></section>}
   <form onSubmit={event=>{event.preventDefault();const submitted=password,submittedCode=code;setPassword('');setCode('');void controller.act(state.enabled?'disable':state.setup?'confirm':'enroll',submitted,submittedCode);}}>
    <fieldset disabled={busy}><label htmlFor="verification-settings-password">Password</label><input id="verification-settings-password" autoFocus type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={event=>setPassword(event.target.value)}/>
    {(state.enabled||state.setup)&&<><label htmlFor="verification-settings-code">Authenticator code</label><input id="verification-settings-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={code} onChange={event=>setCode(event.target.value.trim())}/><p className="fine-print">This signs out every device. You will sign in again afterward.</p></>}
    <button className="primary" type="submit">{state.enabled?'Turn off':state.setup?'Turn on':'Set up authenticator'}</button></fieldset>
   </form>{state.phase==='working'&&<p role="status">Verifying…</p>}
  </>}
  <button type="button" onClick={close}>Cancel</button>
 </dialog>;
}
