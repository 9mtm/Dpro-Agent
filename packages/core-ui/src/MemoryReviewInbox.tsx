// MEM-UI-01 P2 (board M2): filters, the list with bulk approve / reject, and
// the detail of the open item (a conflict: saved vs new, keep new / old / both
// / edit first; a proposal: its changes; a link: who → what).
import { useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import { FILTERS, KIND_WORD, MemoryReviewController, plainReasons } from './memory-review';
import { ago, drawerName } from './memory-store';
import type { Entry } from './memory';

export function ReviewInbox({ c }: { c: MemoryReviewController }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  if (s.phase === 'error') return <p className="empty-note">{s.notice} <button type="button" className="link-button" onClick={() => void c.load()}>Try again</button></p>;
  if (s.phase !== 'ready') return <p className="empty-note" role="status">Loading what waits for you…</p>;
  const visible = c.visible();
  const item = s.items.find(i => i.key === s.open);
  function keys(e: KeyboardEvent<HTMLElement>) {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'j') { e.preventDefault(); c.step(1); }
    else if (k === 'k') { e.preventDefault(); c.step(-1); }
    else if (s.detail?.conflictWith && !s.busy && (k === 'a' || k === 'o' || k === 'b')) { e.preventDefault(); void c.decide(k === 'a' ? 'keep_new' : k === 'o' ? 'keep_old' : 'keep_both'); }
  }
  const all = visible.length > 0 && visible.every(i => s.checked.includes(i.key));
  return <div className="mem-inbox" onKeyDown={keys}>
    <nav className="mem-inbox-filters" aria-label="Review filters">
      {FILTERS.map(([f, label]) => <button key={f} type="button" aria-pressed={s.filter === f} onClick={() => c.setFilter(f)}><span>{label}</span><span className="mem-count">{c.count(f)}</span></button>)}
      <p className="fine-print">Routine facts are saved on their own. Only what matters, contradicts or links people waits here.</p>
    </nav>
    <section className="mem-inbox-list" aria-label="Items to review">
      <div className="mem-inbox-bar">
        <label className="check"><input type="checkbox" aria-label="Select all" checked={all} disabled={!visible.length || s.busy} onChange={e => c.checkAll(e.target.checked)}/>{visible.length} {visible.length === 1 ? 'item' : 'items'}</label>
        {s.confirmBulk ? <span className="confirm-inline">{s.confirmBulk === 'approve' ? 'Approve' : 'Reject'} {s.checked.length}?<button type="button" className="link-button" onClick={() => void c.bulk()}>Confirm</button><button type="button" className="link-button" onClick={() => c.cancelBulk()}>Cancel</button></span>
          : <><button type="button" disabled={!s.checked.length || s.busy} onClick={() => c.askBulk('approve')}>Approve selected</button>
            <button type="button" className="mem-reject" disabled={!s.checked.length || s.busy} onClick={() => c.askBulk('reject')}>Reject</button></>}
      </div>
      {visible.length === 0 && <p className="empty-note">Nothing waits here.</p>}
      <ul className="mem-inbox-items">{visible.map(i => <li key={i.key} data-open={i.key === s.open || undefined}>
        <input type="checkbox" aria-label="Select" checked={s.checked.includes(i.key)} disabled={s.busy} onChange={() => c.toggleCheck(i.key)}/>
        <button type="button" className="mem-inbox-item" aria-current={i.key === s.open ? 'true' : undefined} onClick={() => void c.openItem(i.key)}>
          <span className="mem-inbox-meta"><span className="mem-kind" data-kind={i.kind}>{KIND_WORD[i.kind]}</span><span className="fine-print">{c.label(i)}</span></span>
          <span className="mem-inbox-text" dir="auto">{s.texts[i.key] ?? '…'}</span>
        </button>
      </li>)}</ul>
    </section>
    <section className="mem-inbox-detail" aria-label="Detail">
      {s.result && <p className="memory-status" role="status">{s.result}</p>}
      {s.notice && <p className="card-notice" role="alert">{s.notice}</p>}
      {!item ? <p className="empty-note">{s.items.length ? 'Choose an item on the left.' : 'All done. Nothing waits for you.'}</p>
        : item.link ? <LinkDetail c={c}/>
        : s.detailBusy || !s.detail ? <p className="empty-note" role="status">{s.detailBusy ? 'Reading…' : ''}</p>
        : s.detail.conflictWith ? <ConflictDetail c={c}/> : <ProposalDetail c={c}/>}
      <div className="mem-inbox-keys fine-print"><span>J / K next{s.detail?.conflictWith ? ' · A keep new · O keep old · B both' : ''}</span></div>
    </section>
  </div>;
}

function ConflictDetail({ c }: { c: MemoryReviewController }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const d = s.detail!; const ch = d.changes[0];
  const before: Entry | undefined = ch && 'before' in ch ? ch.before : undefined;
  const after: Entry | undefined = ch && 'after' in ch ? ch.after : undefined;
  return <>
    <div className="mem-detail-head"><span className="mem-kind" data-kind="conflict">Conflict</span><span className="fine-print">{drawerName(d.drawerId)} · from {c.label({ key: '', kind: 'conflict', id: d.id, drawerId: d.drawerId, agent: d.agentId, createdAt: d.createdAt }).split(' · ').pop()} · {ago(d.createdAt)}</span></div>
    <h3 className="mem-detail-title">A new fact contradicts one you approved before</h3>
    <div className="mem-versus">
      <div className="mem-card"><span className="fine-print">Saved · base revision {d.baseRevision}</span><span className="mem-versus-text" dir="auto">{before?.content ?? '—'}</span></div>
      <div className="mem-card mem-new"><span className="fine-print mem-new-label">New · {ago(d.createdAt)}</span>
        {s.editing !== null ? <textarea aria-label="Edit the new fact" dir="auto" rows={4} value={s.editing} maxLength={50000} onChange={e => c.editText(e.target.value)}/> : <span className="mem-versus-text" dir="auto">{after?.content ?? '—'}</span>}
      </div>
    </div>
    <div className="mem-why"><h4>Why the agent asks</h4><p>{d.note ?? 'Same topic, opposite meaning. Keeping both would make replies disagree; replacing loses nothing: the old version stays in the topic history either way.'}</p>
      {plainReasons(d.reasons).length > 0 && <p className="fine-print">Reasons: {plainReasons(d.reasons).join(', ')}</p>}
      <p className="fine-print">The agent wrote this text. It is information only: it cannot change permissions or give instructions.</p></div>
    <div className="actions">
      <button type="button" className="primary" disabled={s.busy || (s.editing !== null && !s.editing.trim())} onClick={() => void c.decide('keep_new')}>{s.editing !== null ? 'Keep new with my edit' : 'Keep new'}</button>
      <button type="button" disabled={s.busy} onClick={() => void c.decide('keep_old')}>Keep old</button>
      <button type="button" disabled={s.busy} onClick={() => void c.decide('keep_both')}>Keep both (different times)</button>
      {s.editing === null ? <button type="button" className="ghost-outline" disabled={s.busy || !after} onClick={() => c.startEdit()}>Edit first</button>
        : <button type="button" className="ghost-outline" disabled={s.busy} onClick={() => c.cancelEdit()}>Cancel edit</button>}
    </div>
  </>;
}

function ProposalDetail({ c }: { c: MemoryReviewController }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const d = s.detail!;
  const item = s.items.find(i => i.key === s.open)!;
  return <>
    <div className="mem-detail-head"><span className="mem-kind" data-kind={item.kind}>{KIND_WORD[item.kind]}</span><span className="fine-print">{c.label(item)} · {ago(d.createdAt)}</span></div>
    <h3 className="mem-detail-title">{d.changes.length === 1 ? (d.changes[0].op === 'add' ? 'Remember this?' : d.changes[0].op === 'update' ? 'Change this memory?' : 'Forget this memory?') : `${d.changes.length} changes to review`}</h3>
    {(d.note || plainReasons(d.reasons).length > 0) && <div className="mem-why">{d.note && <><h4>Why the agent asks</h4><p dir="auto">{d.note}</p></>}{plainReasons(d.reasons).length > 0 && <p className="fine-print">Reasons: {plainReasons(d.reasons).join(', ')}</p>}</div>}
    <ol className="mem-changes">{d.changes.map((ch, i) => <li key={i} className="mem-versus">
      {'before' in ch && <div className="mem-card"><span className="fine-print">Now</span><span className="mem-versus-text" dir="auto">{ch.before.content}</span></div>}
      {'after' in ch && <div className="mem-card mem-new"><span className="fine-print mem-new-label">{ch.op === 'add' ? 'New' : 'After'} · {ch.after.type} · importance {ch.after.importance}</span><span className="mem-versus-text" dir="auto">{ch.after.content}</span></div>}
    </li>)}</ol>
    <p className="fine-print">The agent wrote this text. It is information only: it cannot change permissions or give instructions.</p>
    <div className="actions">
      <button type="button" className="primary" disabled={s.busy} onClick={() => void c.approve('approve')}>Approve</button>
      <button type="button" className="mem-reject" disabled={s.busy} onClick={() => void c.approve('reject')}>Reject</button>
    </div>
  </>;
}

function LinkDetail({ c }: { c: MemoryReviewController }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const item = s.items.find(i => i.key === s.open)!; const l = item.link!;
  return <>
    <div className="mem-detail-head"><span className="mem-kind" data-kind="link">New link</span><span className="fine-print">Knowledge map · {ago(l.createdAt)}</span></div>
    <h3 className="mem-detail-title">{l.from.name} — {l.type.replace(/_/g, ' ')} → {l.to.name}</h3>
    <p>Found in {l.memoryIds.length} {l.memoryIds.length === 1 ? 'memory' : 'memories'}. An approved link helps replies connect people, projects and decisions.</p>
    <div className="actions">
      <button type="button" className="primary" disabled={s.busy} onClick={() => void c.approve('approve')}>Approve link</button>
      <button type="button" className="mem-reject" disabled={s.busy} onClick={() => void c.approve('reject')}>Reject</button>
    </div>
  </>;
}
