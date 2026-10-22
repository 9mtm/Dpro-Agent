import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {SessionClient} from './session';
import {ReviewerPoliciesController,type RulePolicy} from './reviewer-policies-controller';
import {RuleDraftEditor} from './RuleDraftEditor';
import type {ReviewerProofTarget} from './reviewer-proof-controller';
import {ReviewerVerificationSheet} from './ReviewerVerificationSheet';
import {UiIcon} from './ui-icons';
import {ContextMenu,useMenu} from './desktop-ui';
import {reviewerResponse} from './reviewers-contract.js';
const notices={unavailable:'Approval rules are unavailable. Reload to try again.',verification:'Enable account verification before managing approval rules.',changed:'The rule changed or can no longer be applied. Reload its details.',saved:'Draft saved. It is not enforced until activated.',applied:'The rule was updated.',unknown:'The result is unknown. Reload and check the current rule before another change.',refused:'The change was refused. Reload and review the current rule.'};
export function ReviewerPoliciesSettings({client,onAccount}:{client:SessionClient;onAccount:()=>void}){
 const controller=useMemo(()=>new ReviewerPoliciesController(client),[client]),state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot),[proof,setProof]=useState<ReviewerProofTarget|null>(null),[search,setSearch]=useState(''),[reviewed,setReviewed]=useState(false);
 const actionButton=useRef<HTMLButtonElement>(null),reloadButton=useRef<HTMLButtonElement>(null),restore=useRef(false),rows=useRef<(HTMLButtonElement|null)[]>([]),menu=useMenu();
 const [people,setPeople]=useState<Record<string,string>>({}),[agents,setAgents]=useState<Record<string,string>>({});
 const [editor,setEditor]=useState<{id:string;revision:number;policy?:RulePolicy}|null>(null),[editorNotice,setEditorNotice]=useState('');
 const editorOpener=useRef<HTMLButtonElement|null>(null);
 useEffect(()=>{void controller.load();return()=>controller.cancel();},[controller]);
 useEffect(()=>{setReviewed(false);setProof(null);},[state.selectedId,state.draft,state.runtime]);
 useEffect(()=>{const epoch=client.getSnapshot().epoch;return client.subscribe(()=>{if(client.getSnapshot().epoch!==epoch){controller.cancel();setProof(null);setEditor(null);setReviewed(false);}});},[client,controller]);
 useEffect(()=>{if(restore.current&&!proof&&!editor&&!['applying','preparing','saving'].includes(state.phase)){(editorOpener.current?.isConnected&&!editorOpener.current.disabled?editorOpener.current:actionButton.current&&!actionButton.current.disabled?actionButton.current:reloadButton.current)?.focus();editorOpener.current=null;restore.current=false;}},[proof,editor,state.phase]);
 const busy=['loading','detail','saving','preparing','applying'].includes(state.phase)||!!proof||!!editor,policy=state.draft?.policy??state.runtime?.policy,changed=!!state.draft&&(!state.runtime||state.runtime.status!=='active'||JSON.stringify(state.draft.policy)!==JSON.stringify(state.runtime.policy));
 const newRule=(opener:HTMLButtonElement)=>{editorOpener.current=opener;setEditorNotice('');setEditor({id:crypto.randomUUID(),revision:0});};
 const editRule=(opener:HTMLButtonElement)=>{if(!state.selectedId||!policy)return;editorOpener.current=opener;setEditorNotice('');setEditor({id:state.selectedId,revision:state.draft?.revision??state.items.find(i=>i.id===state.selectedId)?.draftRevision??0,policy});};
 const closeEditor=()=>{restore.current=true;setEditor(null);setEditorNotice('');};
 useEffect(()=>{
  setPeople({});setAgents({});if(!policy)return;const abort=new AbortController();let stopped=false;
  const load=async()=>{
   try{
    const response=await client.request({method:'GET',path:'/api/agents'},abort.signal),body=response.body as {agents?:{id:string;name?:string}[]};
    if(!stopped&&response.status===200&&Array.isArray(body.agents))setAgents(Object.fromEntries(body.agents.filter(v=>typeof v.name==='string'&&v.name.length>0).map(v=>[v.id,v.name!])));
    const names:Record<string,string>={},seen=new Set<string>();let cursor:string|null=null;
    for(let page=0;page<201;page++){
     const path='/api/reviewer-policies/eligible-humans'+(cursor?'?cursor='+encodeURIComponent(cursor):''),r=await client.request({method:'GET',path},abort.signal),value=reviewerResponse(path,r.status,r.body);if(stopped||r.status!==200)return;
     for(const person of value.items as {id:string;name:string}[])if(policy.reviewerIds.includes(person.id))names[person.id]=person.name;
     if(policy.reviewerIds.every(id=>names[id])||value.nextCursor===null){if(!stopped)setPeople(names);return;}
     cursor=value.nextCursor as string;if(seen.has(cursor))return;seen.add(cursor);
    }
   }catch{/* Leave activation unavailable when named identities cannot be reviewed. */}
  };void load();return()=>{stopped=true;abort.abort();};
 },[client,policy]);
 const identitiesReady=!!policy&&policy.reviewerIds.every(id=>!!people[id])&&policy.scope.agentIds.every(id=>!!agents[id]);
 const prepare=async(action:'activate'|'revoke')=>{const target=await controller.prepare(action);if(target)setProof(target);};
 const closeProof=(confirmed=false)=>{if(!confirmed)controller.discardProof();restore.current=true;setProof(null);};
 const items=state.items.filter(row=>((row.name??'')+' '+row.status).toLowerCase().includes(search.toLowerCase()));
 return <section className="reviewer-policies" data-selected={!!state.selectedId} aria-label="Approval rules">
  <header className="human-review-toolbar"><h3>Approval rules</h3><label><span className="sr-only">Find a rule</span><input type="search" placeholder="Find a rule" value={search} disabled={busy} onChange={e=>setSearch(e.target.value)}/></label>{state.items.length>0&&<button type="button" className="tool" title="New rule" aria-label="New rule" disabled={busy||state.locked} onClick={e=>newRule(e.currentTarget)}><UiIcon name="compose" size={16}/></button>}<button type="button" className="tool" ref={reloadButton} title="Reload approval rules" aria-label="Reload approval rules" disabled={busy} onClick={()=>void controller.load()}><UiIcon name="refresh" size={16}/></button></header>
  {state.notice&&<p role="status">{notices[state.notice]}</p>}{state.notice==='verification'&&<button onClick={onAccount}>Account verification</button>}
  {['loading','detail','preparing','saving','applying'].includes(state.phase)&&!proof&&<p role="status">{state.phase==='applying'?'Updating rule…':state.phase==='saving'?'Saving draft…':'Loading approval rules…'}</p>}
  {state.phase==='ready'&&!state.items.length&&<div className="human-review-empty"><p>Create a rule to require independent human decisions for selected actions.</p><button type="button" className="primary" disabled={busy} onClick={e=>newRule(e.currentTarget)}>New rule</button></div>}
  <div className="human-review-panes"><section className="human-review-list" aria-label="Approval rule list"><ul>{items.map((row,index)=><li key={row.id}><button type="button" ref={element=>{rows.current[index]=element;}} disabled={busy} aria-pressed={row.id===state.selectedId} onClick={()=>void controller.open(row.id)} onContextMenu={e=>menu.at(e,[{label:'Review rule',icon:'shield',run:()=>void controller.open(row.id),disabled:busy}])} onKeyDown={e=>{if(e.key==='ContextMenu'||e.shiftKey&&e.key==='F10'){menu.at(e,[{label:'Review rule',icon:'shield',run:()=>void controller.open(row.id),disabled:busy}]);return;}const next=e.key==='ArrowDown'?(index+1)%items.length:e.key==='ArrowUp'?(index-1+items.length)%items.length:e.key==='Home'?0:e.key==='End'?items.length-1:undefined;if(next!==undefined){e.preventDefault();rows.current[next]?.focus();}}}><UiIcon name="shield" size={18}/><span><strong>{row.name??(row.id===state.selectedId&&policy?policy.name:'Rule name unavailable')}</strong><small>{row.status==='active'?(row.draftPending?'Active · draft changes':'Active'):row.status==='revoked'?(row.draftPending?'Withdrawn · saved draft':'Withdrawn'):'Draft'}</small></span></button></li>)}</ul>{state.phase==='ready'&&!items.length&&<p className="human-review-empty">No approval rules in this view.</p>}{state.nextCursor&&<button disabled={busy} onClick={()=>void controller.load(state.nextCursor!)}>Next rules</button>}</section>
  <section className="human-review-detail" aria-label="Selected approval rule">{state.selectedId?<>
   <button className="tool human-review-back" title="Back to rules" aria-label="Back to rules" disabled={busy} onClick={()=>void controller.load()}><UiIcon name="arrow-left" size={16}/></button>
   <h4>{policy?.name??'Rule details unavailable'}</h4>{state.draft&&changed&&<p className="fine-print">Showing a saved draft. {state.runtime?.status==='active'?'The current rule remains active until these changes are verified and activated.':'This draft is not currently enforced.'}</p>}{changed&&state.runtime?.status==='active'&&state.runtime.policy&&<details><summary>Current active rule</summary><p>{state.runtime.policy.name}</p><p>{state.runtime.policy.requiredVotes} independent decisions · expires {new Date(state.runtime.policy.expiresAt).toLocaleString()}</p></details>}{state.runtime?.unavailable&&<p role="alert">The saved rule cannot be displayed. An active rule can still be withdrawn after verification.</p>}
   {policy&&<dl className="settings-facts"><dt>People required</dt><dd>{policy.requiredVotes} different people</dd><dt>Assigned people</dt><dd>{policy.reviewerIds.map(id=><span className="rule-person" key={id}><UiIcon name="avatar" size={16}/>{people[id]??'Person unavailable'}</span>)}</dd><dt>Agents</dt><dd>{policy.scope.agentIds.map(id=><span className="rule-person" key={id}><UiIcon name="avatar" size={16}/>{agents[id]??'Agent unavailable'}</span>)}</dd><dt>Requester may vote</dt><dd>{policy.allowInitiatorVote?'Yes':'No'}</dd><dt>Actions covered</dt><dd>{policy.scope.toolNames.map(name=>name.replaceAll('_',' ')).join(', ')}</dd><dt>Expires</dt><dd>{new Date(policy.expiresAt).toLocaleString()}</dd></dl>}
   {policy&&<button type="button" disabled={busy||state.locked} onClick={e=>editRule(e.currentTarget)}><UiIcon name="pencil" size={15}/> Edit draft</button>}
   {changed&&<><p className="fine-print">Activating this draft replaces the current rule and requires fresh verification for outstanding decisions.</p>{!identitiesReady&&<p role="status">Named people and agents must be available before activation. Reload after checking their account verification.</p>}<label className="check"><input type="checkbox" checked={reviewed} disabled={busy||state.locked||!identitiesReady} onChange={e=>setReviewed(e.target.checked)}/>I reviewed this rule and the people it requires.</label><button type="button" ref={actionButton} className="primary" disabled={busy||state.locked||!reviewed||!identitiesReady} onClick={()=>void prepare('activate')}>Verify and activate</button></>}
   {state.runtime?.status==='active'&&<details><summary>Rule actions</summary><button type="button" disabled={busy||state.locked} onClick={()=>void prepare('revoke')}>Verify and withdraw</button></details>}
   {!changed&&state.runtime?.status==='active'&&!state.runtime.unavailable&&<p className="fine-print">This rule is enforced for matching actions.</p>}
  </>:<p className="human-review-empty">Select a rule to review its details.</p>}</section></div>
  {menu.menu&&<ContextMenu menu={menu.menu} onClose={menu.close}/>}
  {editor&&<RuleDraftEditor key={editor.id} client={client} id={editor.id} initial={editor.policy} saving={state.phase==='saving'} locked={!!state.locked&&state.phase==='error'} notice={editorNotice} onAccount={()=>{closeEditor();onAccount();}} onClose={closeEditor} onSave={async value=>{await controller.save(editor.id,editor.revision,value);const current=controller.getSnapshot();if(current.notice==='saved')closeEditor();else setEditorNotice(current.notice?notices[current.notice]:'The draft could not be saved.');}}/>}
  {proof&&<ReviewerVerificationSheet client={client} target={proof} subject={(proof.kind==='policy'&&proof.action==='revoke'?'Withdraw · '+(state.runtime?.policy?.name??'current rule'):'Activate · '+(policy?.name??'this draft'))} finalLabel={proof.kind==='policy'&&proof.action==='revoke'?'Withdraw rule':'Activate rule'} onClose={()=>closeProof()} onConfirm={receipt=>{const target=proof;closeProof(true);void controller.apply(target,receipt);}}/>}
 </section>;
}
