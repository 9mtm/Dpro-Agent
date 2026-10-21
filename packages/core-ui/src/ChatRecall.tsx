// MEM-UI-01 P5 (board M5, v3 in M15): "Remembered N" under a reply with what
// it used, in the order it was loaded and why (Correct → Review, Wrong place →
// the M13 move, Forget), the drawers open and not loaded; the Details cards
// "Where we left off", how the context was built (summaries) and speed.
import { useEffect, useSyncExternalStore } from 'react';
import { ChatRecallController } from './chat-recall';
import { ago, drawerName, oneLine } from './memory-store';
import { SpeedCard } from './MemoryHealth';
import type { RecallItem, RecallTrace } from './memory-recall-contract.js';

const WHY: Record<string, string> = { pinned: 'Pinned', topic: 'Topic', graph: 'Map', meaning: 'Meaning', keyword: 'Words', handoff: 'Handoff' };
const scopeWord = (d: string | null) => (!d || d === 'company' ? 'Company' : d.startsWith('department:') ? `Department · ${d.slice(11)}` : drawerName(d));
/** Where a used item came from: a pinned scope fact, a handoff, or a memory drawer (with its score for a search hit). */
function whereOf(i: RecallItem): string {
  if (i.kind === 'handoff') return 'Handoff · this chat';
  if (i.kind === 'fact') return `${scopeWord(i.drawer)} · pinned fact`;
  if (i.state === 'forgotten' || i.state === 'deleted') return i.drawer ? `was in ${drawerName(i.drawer)}` : 'gone';
  const where = i.drawer ? drawerName(i.drawer) : 'Memory';
  return i.state === 'moved' && i.nowIn ? `${where} → now in ${drawerName(i.nowIn)}` : `${where}${typeof i.score === 'number' && (i.why === 'meaning' || i.why === 'keyword') ? ` · score ${i.score.toFixed(2)}` : ''}`;
}
const textOf = (i: RecallItem) => (i.preview ? oneLine(i.preview) : i.state === 'forgotten' ? '(forgotten since this reply)' : i.state === 'deleted' ? '(deleted since this reply)' : i.kind === 'handoff' ? 'The note from the last session.' : '—');

/** The chip under a finished reply; opens the list of what it used. */
export function RecallChip({ c, turn }: { c: ChatRecallController; turn: { key: string; role: string; runId: string | null; pending?: boolean; status?: string } }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  useEffect(() => { void c.ensure(turn); }, [c, turn.key, turn.status]);
  const t = c.trace(turn.key);
  // A reply that used nothing still shows the chip when a drawer was closed to it (board M15: "not loaded").
  if (!t || (t.items.length === 0 && !t.notLoaded?.drawers.length && !t.context.drawers?.noAccess.length)) return null;
  const open = s.open === turn.key;
  return <button type="button" className="recall-chip" aria-expanded={open} onClick={() => c.toggle(turn.key)}>Remembered {t.items.length} {open ? '⌃' : '⌄'}</button>;
}

/** "What this reply used" (board M15): why · what · where, with Correct / Wrong place / Forget for memories it used. */
export function RecallPanel({ c, turnKey, onWrongPlace }: { c: ChatRecallController; turnKey: string; onWrongPlace?: (m: { id: string; text: string; drawerId: string }) => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const t = c.trace(turnKey);
  if (s.open !== turnKey || !t) return null;
  const loaded = t.context.drawers?.loaded ?? [...new Set(t.items.filter(i => i.kind === 'memory' && i.drawer).map(i => i.drawer!))];
  // Not loaded: the owner's drawers this reply did not open (closed to this agent = "no access").
  const blocked = (t.context.drawers?.noAccess ?? []).filter(d => !t.notLoaded?.drawers.some(x => x.drawer === d)).map(d => ({ drawer: d, why: 'no_access' as const }));
  const notLoaded = [...(t.notLoaded?.drawers ?? []), ...blocked].map(d => `${drawerName(d.drawer)}${d.why === 'no_access' ? ' (no access)' : d.why === 'archived' ? ' (archived)' : ''}`)
    .concat(t.notLoaded?.more ? [`${t.notLoaded.more} more`] : []);
  const correcting = s.correcting?.key === turnKey ? s.correcting : null;
  const fixing = correcting ? t.items.find(i => i.id === correcting.memoryId) : undefined;
  return <>
    <section className="recall-panel" aria-label="What this reply used">
      <div className="recall-head"><b>What this reply used</b><span className="fine-print">In the order it was loaded</span></div>
      {t.items.map(i => <div key={`${i.kind}:${i.id}`} className="recall-row" data-state={i.state}>
        <span className="recall-why" data-why={i.why}>{WHY[i.why] ?? i.why}</span>
        <span className="recall-what"><span dir="auto" className="recall-text">{textOf(i)}</span><span className="fine-print">{whereOf(i)}</span></span>
        <span className="recall-actions">
          {['changed', 'moved', 'forgotten'].includes(i.state) && <span className="recall-state" data-state={i.state}>{i.state}</span>}
          {i.kind === 'memory' && ['active', 'changed', 'moved'].includes(i.state) && (s.confirmForget?.key === turnKey && s.confirmForget.memoryId === i.id
            ? <><span className="mem-warn-text">Forget for good?</span><button type="button" className="danger-text" disabled={s.busy} onClick={() => void c.forget()}>Forget</button><button type="button" onClick={() => c.cancel()}>Keep</button></>
            : <><button type="button" onClick={() => c.startCorrect(turnKey, i.id, i.preview ?? '')}>Correct</button>
              {onWrongPlace && i.drawer && <button type="button" onClick={() => onWrongPlace({ id: i.id, text: i.preview ?? '', drawerId: i.nowIn ?? i.drawer! })}>Wrong place</button>}
              <button type="button" className="danger-text" onClick={() => c.askForget(turnKey, i.id)}>Forget</button></>)}
        </span>
      </div>)}
      {s.notes[turnKey] && <span className="fine-print" role="status">{s.notes[turnKey]}</span>}
      <span className="fine-print">{loaded.length ? `Drawers open for this reply: ${loaded.map(d => drawerName(d)).join(', ')}.` : 'No drawer was opened for this reply.'}{notLoaded.length ? ` Not loaded: ${notLoaded.join(', ')}.` : ''}{t.context.fromCache.pack ? ' Context from cache.' : ''}</span>
    </section>
    {correcting && <form className="recall-correct" aria-label="Correct a memory" onSubmit={e => { e.preventDefault(); void c.correct(); }}>
      <h3>Correct: “{oneLine(fixing?.preview ?? '')}”</h3>
      <input aria-label="Corrected fact" dir="auto" value={correcting.text} maxLength={50000} onChange={e => c.editCorrect(e.target.value)}/>
      <span className="actions"><button type="submit" className="primary" disabled={s.busy || !correcting.text.trim()}>Send to Review</button><button type="button" onClick={() => c.cancel()}>Cancel</button><span className="fine-print">The fix waits in Review with this reply as the reason.</span></span>
    </form>}
  </>;
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

/** Details › How this reply's context was built (board M15): kept / summarised / dropped turns, cache, size, time; the stored summaries on request. */
export function ContextCard({ trace, c }: { trace: RecallTrace | null; c?: ChatRecallController }) {
  const s = useSyncExternalStore(c?.subscribe ?? noop, c?.getSnapshot ?? none, c?.getSnapshot ?? none);
  if (!trace) return null;
  const x = trace.context;
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1024)}k` : String(n));
  const rows: Array<[string, string, string?]> = [
    ['Turns kept in full', String(x.keptTurns)],
    ['Older turns as summaries', x.summarisedTurns > 0 ? `1–${x.summarisedTurns} (${x.summaries.length} ${x.summaries.length === 1 ? 'summary' : 'summaries'})` : 'none'],
    ['Turns dropped', String(x.droppedTurns)],
    ['Context pack from cache', x.fromCache.pack ? 'yes' : 'no', x.fromCache.pack ? 'ok' : undefined],
    ['Recall from cache', x.fromCache.recall ? 'yes' : 'no', x.fromCache.recall ? 'ok' : undefined],
    ['Prompt size', x.promptTokens ? `${x.promptTokens.toLocaleString('en')} tokens` : '—'],
    ['Budget · model window', x.budgetTokens || x.numCtx ? `${k(x.budgetTokens)} · ${k(x.numCtx)}` : '—'],
    ['Time to first word', x.ttftMs !== null ? `${(x.ttftMs / 1000).toFixed(1)} s` : '—'],
  ];
  return <>
    <section className="panel-card" aria-label="Context">
      <h3>How this reply’s context was built</h3>
      <div className="context-rows">{rows.map(([label, value, tone]) => <span key={label}><span>{label}</span><span data-tone={tone}>{value}</span></span>)}</div>
      {c && x.summaries.length > 0 && <button type="button" className="link-button" aria-expanded={s?.showSummaries} onClick={() => void c.toggleSummaries()}>{s?.showSummaries ? 'Hide' : 'Read'} the {x.summaries.length} {x.summaries.length === 1 ? 'summary' : 'summaries'} of turns 1–{x.summarisedTurns} ›</button>}
    </section>
    {s?.showSummaries && (s.summaries === null ? <p className="fine-print" role="status">Reading the summaries…</p> : s.summaries.map((m, n) => <section key={m.id} className="panel-card" aria-label="Summary">
      <span className="fine-print">Summary {n + 1} of {s.summaries!.length} · turns {m.firstTurn}–{m.lastTurn} · {m.source === 'model' ? 'local model' : m.source === 'fallback' ? 'kept automatically' : 'inline'}</span>
      <p dir="auto">{m.text}</p>
    </section>))}
  </>;
}

/** Details › Speed (Health › cache). */
export function SpeedDetails({ c }: { c: ChatRecallController }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  useEffect(() => { void c.loadMetrics(); }, [c]);
  return s.metrics ? <SpeedCard m={s.metrics} title="Speed (Health › cache)"/> : null;
}
const noop = () => () => {};
const none = () => undefined;
