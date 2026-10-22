import { useEffect, useRef, useState } from 'react';
import {ApprovalVerificationSheet} from './ApprovalVerificationSheet';
import type { SessionClient } from './session';
import type { RecoveryApproval } from './recovery-approvals-contract.js';

/** Explicit reads and per-call decisions. Never retries a mutation. */
export function RecoveryApprovals({ client, conversationId }: { client: SessionClient; conversationId: string }) {
  const [items, setItems] = useState<RecoveryApproval[]>([]);
  const [detail, setDetail] = useState<RecoveryApproval>();
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verificationOpen,setVerificationOpen]=useState(false);
  const approvalButton=useRef<HTMLButtonElement>(null),wasVerificationOpen=useRef(false);
  const [notice, setNotice] = useState('');
  const epoch = client.getSnapshot().epoch;
  const serial = useRef(0);
  const busyRef = useRef(false);
  useEffect(() => { serial.current++; busyRef.current = false; setItems([]); setDetail(undefined); setReviewed(false); setNotice(''); setBusy(false); setVerificationOpen(false); return () => { serial.current++; }; }, [client, conversationId, epoch]);
  useEffect(()=>{if(wasVerificationOpen.current&&!verificationOpen&&!approvalButton.current?.disabled)approvalButton.current?.focus();wasVerificationOpen.current=verificationOpen;},[verificationOpen]);
  if (client.getSnapshot().user?.role !== 'owner') return <p>Only the owner can review tools.</p>;
  const send = async (path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const attempt = ++serial.current;
    const current = () => attempt === serial.current && client.getSnapshot().epoch === epoch && client.getSnapshot().phase === 'authenticated';
    setBusy(true); setNotice(''); setReviewed(false);
    try {
      const response = await client.request(method === 'GET' ? { method: 'GET', path } : { method: 'POST', path, ...(body === undefined ? {} : { body }) });
      if (!current()) return;
      const refusal=(response.body as {code?:string})?.code;
      if(response.status===403&&refusal&&['reviewer_quorum_required','reviewer_denied','reviewer_policy_unavailable'].includes(refusal)){setNotice(refusal==='reviewer_denied'?'A human reviewer rejected this call. Nothing was run.':refusal==='reviewer_quorum_required'?'Waiting for the required human reviews. Nothing was run.':'The required review policy is unavailable. Nothing was run. Ask the owner to review the policy.');return;}
      if(response.status===403&&(response.body as {code?:string})?.code==='verification_required'){if(detail)setDetail({...detail,verificationRequired:true});setNotice('Verification is required. Review this call and verify before approving.');return;}
      if (response.status !== 200 || !response.body) { setDetail(undefined); setNotice(method === 'POST' ? 'Decision not confirmed. Reload pending tools and review before deciding again.' : 'Tools could not be loaded. Try again.'); return; }
      const result = response.body as { approvals?: RecoveryApproval[]; approval?: RecoveryApproval };
      if (result.approvals) { setItems(result.approvals.filter(a => a.sessionId === conversationId)); setDetail(undefined); }
      if (result.approval) {
        if (result.approval.sessionId !== conversationId) { setDetail(undefined); setNotice('This tool belongs to another conversation.'); return; }
        if (method === 'GET') setDetail(result.approval);
        else { setItems(items.filter(a => a.id !== result.approval!.id)); setDetail(undefined); setNotice(result.approval.status === 'executed' ? 'Tool executed. Continue the chat to use its saved result.' : `Tool decision: ${result.approval.status}.`); }
      }
    } catch {
      if (current()) { setDetail(undefined); setNotice(method === 'POST' ? 'Outcome unknown. Reload pending tools before another decision; nothing was retried.' : 'Tools could not be loaded.'); }
    } finally { if (current()) { busyRef.current = false; setBusy(false); } }
  };
  return <section className="panel" aria-label="Review tools after restart">
    <h4>Review tools before continuing</h4>
    <p>Check earlier actions and unknown outcomes before approving another call. Secret values stay hidden.</p>
    <button type="button" disabled={busy || verificationOpen} onClick={() => void send('/api/approvals?status=pending')}>Load pending tools</button>
    <ul>{items.map(a => <li key={a.id}><button type="button" disabled={busy || verificationOpen} onClick={() => void send(`/api/approvals/${a.id}`)}>Review {a.toolName}</button></li>)}</ul>
    {detail && <div>
      <p><bdi>{detail.toolName}</bdi> · {detail.status}</p>
      <pre dir="auto">{JSON.stringify(detail.params, null, 2)}</pre>
      {!!detail.maskedFields?.length && <p>Some values are masked. Approval applies to the exact saved values.</p>}
      <label className="check"><input type="checkbox" checked={reviewed} disabled={busy || verificationOpen || detail.status !== 'pending'} onChange={e => setReviewed(e.target.checked)}/>I reviewed this call and checked that it is safe to run after the interruption.</label>
      <button ref={approvalButton} type="button" disabled={busy || verificationOpen || !reviewed || !detail.paramsHash || detail.params === null || detail.status !== 'pending'} onClick={() => detail.verificationRequired?setVerificationOpen(true):void send(`/api/approvals/${detail.id}/approve`, 'POST', { paramsHash: detail.paramsHash })}>{detail.verificationRequired?'Verify and approve':'Approve this call'}</button>
      <button type="button" disabled={busy || verificationOpen || detail.status !== 'pending'} onClick={() => void send(`/api/approvals/${detail.id}/deny`, 'POST')}>Deny</button>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {verificationOpen&&detail?.paramsHash&&<ApprovalVerificationSheet key={detail.id+detail.paramsHash} client={client} id={detail.id} paramsHash={detail.paramsHash} toolName={detail.toolName} onClose={()=>setVerificationOpen(false)} onApprove={receipt=>{setVerificationOpen(false);void send(`/api/approvals/${detail.id}/approve`,'POST',{paramsHash:detail.paramsHash,verificationReceipt:receipt});}}/>}
  </section>;
}
