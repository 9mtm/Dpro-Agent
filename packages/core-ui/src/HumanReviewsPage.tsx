import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import type {SessionClient} from './session';
import {ApprovalPage} from './ApprovalPage';
import {HumanReviewsController} from './human-reviews-controller';
import {ReviewerVerificationSheet} from './ReviewerVerificationSheet';
import type {ReviewerProofTarget} from './reviewer-proof-controller';
import {UiIcon} from './ui-icons';
import {ContextMenu,useMenu} from './desktop-ui';
const notices={verification:'Enable account verification before reviewing requests.',unavailable:'Reviews are unavailable. Reload to try again.',changed:'This request changed or is no longer available. Reload the list.',recorded:'Your decision was recorded. It did not execute the action.',unknown:'The decision outcome is unknown. Check with the owner before starting again.',refused:'The decision was refused. Reload and review the request again.',conflict:'A different decision is already recorded for this request.'};
function ReviewValue({value,depth=0}:{value:unknown;depth?:number}){
 if(value===null)return <span>None</span>;
 if(typeof value!=='object')return <span>{String(value)}</span>;
 if(!Array.isArray(value)&&(value as {masked?:boolean}).masked===true)return <span>Hidden</span>;
 if(depth>6)return <details><summary>More details</summary><pre tabIndex={0}>{JSON.stringify(value,null,2)}</pre></details>;
 return Array.isArray(value)?<ol>{value.map((v,i)=><li key={i}><ReviewValue value={v} depth={depth+1}/></li>)}</ol>:<dl>{Object.entries(value).map(([key,v])=><div key={key}><dt>{key.replaceAll('_',' ').replace(/([a-z])([A-Z])/g,'$1 $2')}</dt><dd><ReviewValue value={v} depth={depth+1}/></dd></div>)}</dl>;
}
export function ApprovalsWorkspace({client,active,slot,onDecision,onAccount}:{client:SessionClient;active:boolean;slot:HTMLElement|null;onDecision:()=>void;onAccount:()=>void}){
 const owner=client.getSnapshot().user?.role==='owner';const [place,setPlace]=useState<'execution'|'reviews'>(owner?'execution':'reviews');
 const sidebar=<nav className="dk-sidebar" aria-label="Approvals places"><p className="section-label dk-label">Approvals</p>{owner&&<button type="button" className="nav-item dk-place" aria-current={place==='execution'?'page':undefined} onClick={()=>setPlace('execution')}><UiIcon name="clock" size={15}/>Execution requests</button>}<button type="button" className="nav-item dk-place" aria-current={place==='reviews'?'page':undefined} onClick={()=>setPlace('reviews')}><UiIcon name="shield" size={15}/>My reviews</button></nav>;
 return <>{slot?(active?createPortal(sidebar,slot):null):sidebar}{owner&&<div hidden={place!=='execution'}><ApprovalPage client={client} active={active&&place==='execution'} onDecision={onDecision}/></div>}<div hidden={place!=='reviews'}><HumanReviewsPage client={client} active={active&&place==='reviews'} onAccount={onAccount}/></div></>;
}
export function HumanReviewsPage({client,active,onAccount}:{client:SessionClient;active:boolean;onAccount?:()=>void}){
 const controller=useMemo(()=>new HumanReviewsController(client),[client]),state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 const [reviewed,setReviewed]=useState(false),[decision,setDecision]=useState<'approve'|'deny'>('approve'),[proof,setProof]=useState<ReviewerProofTarget|null>(null),[search,setSearch]=useState('');
 const verifyButton=useRef<HTMLButtonElement>(null),reloadButton=useRef<HTMLButtonElement>(null),restoreFocus=useRef(false),rows=useRef<(HTMLButtonElement|null)[]>([]),menu=useMenu();
 useEffect(()=>{if(active)void controller.load();else controller.cancel();return()=>controller.cancel();},[controller,active]);
 useEffect(()=>{setReviewed(false);setProof(null);setDecision(state.detail?.ownVote?.decision??'approve');},[state.detail]);
 useEffect(()=>{const epoch=client.getSnapshot().epoch;return client.subscribe(()=>{if(client.getSnapshot().epoch!==epoch){controller.cancel();setProof(null);setReviewed(false);}});},[client,controller]);
 useEffect(()=>{if(restoreFocus.current&&!proof&&active&&state.phase!=='recording'){const target=verifyButton.current&&!verifyButton.current.disabled?verifyButton.current:reloadButton.current;target?.focus();restoreFocus.current=false;}},[proof,active,state.phase]);
 const closeProof=()=>{restoreFocus.current=true;setProof(null);};
 const busy=state.phase==='loading'||state.phase==='detail'||state.phase==='recording'||!!proof;
 const detail=state.detail,selected=state.items.find(i=>i.reference.approvalId===detail?.reference.approvalId),items=state.items.filter(i=>(i.toolName+' '+i.agentId).toLowerCase().includes(search.toLowerCase()));
 return <div className="human-reviews" data-selected={!!detail} aria-label="My reviews">
  <header className="human-review-toolbar"><h2>My reviews</h2><label><span className="sr-only">Find a request</span><input type="search" placeholder="Find a request" value={search} disabled={busy} onChange={e=>setSearch(e.target.value)}/></label><button type="button" ref={reloadButton} className="tool" title="Reload reviews" aria-label="Reload reviews" disabled={busy} onClick={()=>void controller.load()}><UiIcon name="refresh" size={16}/></button></header>
  <label className="human-policy-picker">Review rule<select value={state.policyId??''} disabled={busy||!state.policies.length} onChange={e=>void controller.choosePolicy(e.target.value)}><option value="" disabled>Choose a rule</option>{state.policies.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
  {state.notice&&<p className="human-review-notice" role="status">{notices[state.notice]}</p>}{state.notice==='verification'&&onAccount&&<button type="button" onClick={onAccount}>Account verification</button>}
  {busy&&!proof&&<p role="status">{state.phase==='recording'?'Recording your decision…':'Loading reviews…'}</p>}
  {state.phase==='ready'&&!state.policies.length&&<p className="human-review-empty">No review rules are assigned to you.</p>}
  <div className="human-review-panes"><section className="human-review-list" aria-label="Assigned requests"><ul>{items.map((item,index)=><li key={item.reference.approvalId}><button type="button" ref={element=>{rows.current[index]=element;}} aria-pressed={detail?.reference.approvalId===item.reference.approvalId} disabled={busy} onClick={()=>void controller.open(item)} onContextMenu={e=>menu.at(e,[{label:'Review request',icon:'shield',run:()=>void controller.open(item),disabled:busy}])} onKeyDown={e=>{if(e.key==='ContextMenu'||e.shiftKey&&e.key==='F10'){menu.at(e,[{label:'Review request',icon:'shield',run:()=>void controller.open(item),disabled:busy}]);return;}const next=e.key==='ArrowDown'?(index+1)%items.length:e.key==='ArrowUp'?(index-1+items.length)%items.length:e.key==='Home'?0:e.key==='End'?items.length-1:undefined;if(next!==undefined){e.preventDefault();rows.current[next]?.focus();}}}><UiIcon name="tool" size={18}/><span><strong>{item.toolName.replaceAll('_',' ')}</strong><small>{item.agentId.replaceAll('-',' ')}{item.ownVote?' · '+(item.ownVote.status==='verification_required'?'Verify again':item.ownVote.decision==='approve'?'Approved':'Declined'):''}</small></span></button></li>)}</ul>{state.phase==='ready'&&state.policyId&&!items.length&&<p className="human-review-empty">No requests in this view.</p>}{state.nextCursor&&<button disabled={busy} onClick={()=>state.policyId&&void controller.choosePolicy(state.policyId,state.nextCursor!)}>Next requests</button>}</section>
  <section className="human-review-detail" aria-label="Selected review">{detail?<>
   <button type="button" className="tool human-review-back" title="Back to requests" aria-label="Back to requests" disabled={busy} onClick={()=>controller.closeDetail()}><UiIcon name="arrow-left" size={16}/></button><h3><UiIcon name="tool" size={18}/> {selected?.toolName.replaceAll('_',' ')??'Review this request'}</h3><p className="fine-print">Hidden credentials stay hidden. Your decision does not execute this action.</p><h4>Requested action</h4><div className="human-review-values"><ReviewValue value={detail.params}/></div><details><summary>Action context</summary><ReviewValue value={detail.runScope}/></details>
   {detail.ownVote?.status==='current'?<p role="status">Your decision is already recorded: {detail.ownVote.decision==='approve'?'Approve':'Decline'}. It does not execute the action.</p>:<>{detail.ownVote?.status==='verification_required'&&<p role="status">Your previous approval needs fresh verification before it can count.</p>}<label>Decision<select value={decision} disabled={busy||state.locked||!!detail.ownVote} onChange={e=>{setDecision(e.target.value as 'approve'|'deny');setReviewed(false);}}><option value="approve">Approve</option><option value="deny">Decline</option></select></label>
   <label className="check"><input type="checkbox" checked={reviewed} disabled={busy||state.locked||detail.params===null} onChange={e=>setReviewed(e.target.checked)}/>I reviewed this exact request and my selected decision.</label>
   <button type="button" className="primary" ref={verifyButton} disabled={busy||state.locked||!reviewed||detail.params===null} onClick={()=>setProof(Object.freeze({kind:'vote',reference:Object.freeze({...detail.reference,decision})}))}>{detail.ownVote?'Verify again':'Verify decision'}</button></> }
  </>:<p className="human-review-empty">Select a request to review its details.</p>}</section></div>
  {menu.menu&&<ContextMenu menu={menu.menu} onClose={menu.close}/>}
  {proof&&active&&detail&&<ReviewerVerificationSheet client={client} target={proof} subject={(decision==='approve'?'Approve':'Decline')+' · '+(selected?.toolName.replaceAll('_',' ')??'this request')} finalLabel="Record decision" onClose={closeProof} onConfirm={receipt=>{const reference=proof.kind==='vote'?proof.reference:null;closeProof();if(reference)void controller.record(reference,receipt);}}/>}
 </div>;
}
