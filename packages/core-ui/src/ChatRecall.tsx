// MEM-UI-01 P5 (board M5): "Remembered N" under a reply with what it used
// (Correct / Forget), and the Details cards "Where we left off" and "Context".
import { useEffect, useSyncExternalStore } from 'react';
import { ChatRecallController } from './chat-recall';
import { ago, drawerName, oneLine } from './memory-store';
import type { RecallItem, RecallTrace } from './memory-recall-contract.js';

const WHY: Record<string, string> = { pinned: 'pinned', topic: 'topic', graph: 'map', meaning: 'meaning', keyword: 'words', handoff: 'handoff' };
const fromLabel = (i: RecallItem) => (i.kind === 'handoff' ? 'Handoff' : `${i.drawer ? drawerName(i.drawer) : 'Memory'} · ${WHY[i.why] ?? i.why}`);

/** The chip under a finished reply; opens the list of what it used. */
export function RecallChip({ c, turn }: { c: ChatRecallController; turn: { key: string; role: string; runId: string | null; pending?: boolean; status?: string } }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  useEffect(() => { void c.ensure(turn); }, [c, turn.key, turn.status]);
  const t = c.trace(turn.key);
  if (!t || t.items.length === 0) return null;
  const open = s.open === turn.key;
  return <button type="button" className="recall-chip" aria-expanded={open} onClick={() => c.toggle(turn.key)}>Remembered {t.items.length} {open ? '⌃' : '⌄'}</button>;
}

/** "What this reply used": each memory with Correct (a review proposal) and Forget (asks first). */
export function RecallPanel({ c, turnKey }: { c: ChatRecallController; turnKey: string }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const t = c.trace(turnKey);
  if (s.open !== turnKey || !t) return null;
  const drawers = [...new Set(t.items.filter(i => i.kind === 'memory' && i.drawer).map(i => drawerName(i.drawer!)))];
  return <section className="recall-panel" aria-label="What it remembered">
    <span className="recall-head">What this reply used</span>
    {t.items.map(i => <div key={`${i.kind}:${i.id}`} className="recall-row" data-state={i.state}>
      <span className="fine-print">{fromLabel(i)}</span>
      {s.correcting?.key === turnKey && s.correcting.memoryId === i.id
        ? <form className="recall-correct" onSubmit={e => { e.preventDefault(); void c.correct(); }}>
          <textarea aria-label="Corrected fact" dir="auto" rows={2} value={s.correcting.text} maxLength={50000} onChange={e => c.editCorrect(e.target.value)}/>
          <span className="recall-actions"><button type="submit" className="primary" disabled={s.busy || !s.correcting.text.trim()}>Send for review</button><button type="button" onClick={() => c.cancel()}>Cancel</button></span>
        </form>
        : <span dir="auto" className="recall-text">{i.preview ? oneLine(i.preview) : i.state === 'forgotten' ? 'Forgotten.' : i.state === 'deleted' ? 'Deleted since.' : i.kind === 'handoff' ? 'The note from the last session.' : '—'}{i.state === 'changed' ? ' (changed since)' : i.state === 'moved' && i.nowIn ? ` (now in ${drawerName(i.nowIn)})` : ''}</span>}
      {i.kind === 'memory' && ['active', 'changed', 'moved'].includes(i.state) && !(s.correcting?.key === turnKey && s.correcting.memoryId === i.id) && <span className="recall-actions">
        {s.confirmForget?.key === turnKey && s.confirmForget.memoryId === i.id
          ? <><span className="mem-warn-text">Forget for good?</span><button type="button" className="danger-text" disabled={s.busy} onClick={() => void c.forget()}>Forget</button><button type="button" onClick={() => c.cancel()}>Keep</button></>
          : <><button type="button" onClick={() => c.startCorrect(turnKey, i.id, i.preview ?? '')}>Correct</button><button type="button" className="danger-text" onClick={() => c.askForget(turnKey, i.id)}>Forget</button></>}
      </span>}
    </div>)}
    {s.notes[turnKey] && <span className="fine-print" role="status">{s.notes[turnKey]}</span>}
    <span className="fine-print">{drawers.length ? `Drawers open for this reply: ${drawers.join(', ')}.` : 'No drawer was opened for this reply.'}{t.context.fromCache.pack ? ' Context from cache.' : ''}</span>
  </section>;
}

/** Details › Where we left off: the agent's handoff for this chat (done / left / next), editable by the owner. */
export function HandoffCard({ c, agentId, agentName }: { c: ChatRecallController; agentId: string; agentName: string }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  useEffect(() => { if (s.conversationId && s.handoffPhase === 'idle') void c.loadHandoff(); }, [c, s.conversationId, s.handoffPhase]);
  const h = s.handoff; const d = s.draft;
  return <section className="panel-card handoff-card" aria-label="Where we left off">
    <h3>Where we left off {!d && <button type="button" className="link-button panel-head-tool" onClick={() => c.startEdit()}>Edit</button>}</h3>
    {d ? <form className="handoff-form" onSubmit={e => { e.preventDefault(); void c.saveHandoff(agentId); }}>
      {(['done', 'left', 'next', 'questions'] as const).map(k => <label key={k}><span>{k === 'done' ? 'Done' : k === 'left' ? 'Left' : k === 'next' ? 'Next' : 'Open questions'}</span>
        <textarea rows={2} dir="auto" value={d[k]} placeholder="One item per line" onChange={e => c.editDraft({ [k]: e.target.value })}/></label>)}
      <div className="actions"><button type="submit" className="primary" disabled={s.busy}>Save note</button><button type="button" onClick={() => c.cancelEdit()}>Cancel</button></div>
      {s.handoffNotice && <p className="card-notice" role="alert">{s.handoffNotice}</p>}
    </form>
      : s.handoffPhase === 'loading' ? <p className="muted">Reading…</p>
      : !h ? <p className="muted">No note yet. {agentName} writes one when a larger piece of work ends; you can write it yourself.</p>
      : <>
        <span className="fine-print">{h.source === 'owner' ? 'You' : agentName} · {ago(h.createdAt)} · version {h.version}</span>
        {h.done.length > 0 && <p><b className="handoff-done">Done</b> — {h.done.join('; ')}</p>}
        {h.left.length > 0 && <p><b className="handoff-left">Left</b> — {h.left.join('; ')}</p>}
        {h.next.length > 0 && <p><b className="handoff-next">Next</b> — {h.next.join('; ')}</p>}
        {h.questions.length > 0 && <p><b>Questions</b> — {h.questions.join('; ')}</p>}
      </>}
    <p className="fine-print">The agent reads this at the start of the next session.</p>
  </section>;
}

/** Details › Context: how the last reply's context was built. */
export function ContextCard({ trace }: { trace: RecallTrace | null }) {
  if (!trace) return null;
  const x = trace.context;
  const cached = [x.fromCache.pack && 'persona, pinned facts', x.fromCache.recall && 'recalled memories'].filter(Boolean).join(', ');
  return <section className="panel-card" aria-label="Context">
    <h3>Context</h3>
    <div className="context-rows">
      <span><span>Kept in full</span><span>last {x.keptTurns} {x.keptTurns === 1 ? 'turn' : 'turns'}</span></span>
      {x.summarisedTurns > 0 && <span><span>Summarised</span><span>turns 1–{x.summarisedTurns}</span></span>}
      {x.droppedTurns > 0 && <span><span>Left out</span><span>{x.droppedTurns} turns</span></span>}
      <span><span>From cache</span><span>{cached || 'nothing (built fresh)'}</span></span>
      {x.ttftMs !== null && <span><span>First word</span><span>{(x.ttftMs / 1000).toFixed(1)} s</span></span>}
    </div>
  </section>;
}
