// MEM-FINISH-01 (board M13): the "Review safe fixes" dialog (memory doctor)
// and the "Move to another drawer" dialog.
import { useState, useSyncExternalStore } from 'react';
import { MemoryMoveController } from './memory-move';
import { MemoryHealthController, CHECKS } from './memory-health';
import { ago, drawerName, oneLine } from './memory-store';

const agentsWord = (n: number | null) => (n === null ? '…' : String(n));

export function MoveDialog({ c, from }: { c: MemoryMoveController; from?: string }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  if (!s.memory) return null;
  const m = s.memory;
  const toName = s.to ? s.targets.find(t => t.drawer === s.to)?.name ?? drawerName(s.to) : null;
  return <section className="mem-modal" role="dialog" aria-modal="false" aria-labelledby="mem-move-title">
    <div className="mem-modal-head"><span className="fine-print">{from ?? 'From Explorer › Move drawer · or a reply’s “wrong place”'}</span><h3 id="mem-move-title">Move to another drawer</h3></div>
    <div className="mem-modal-quote">
      <span dir="auto">{oneLine(m.text)}</span>
      <span className="fine-print">Now in {drawerName(m.drawerId)}{m.topicKey ? ` · topic ${m.topicKey}` : ''}{s.usedIn !== null ? ` · used in ${s.usedIn} ${s.usedIn === 1 ? 'reply' : 'replies'}` : ''}</span>
    </div>
    <label className="mem-modal-field">Move to<input type="search" placeholder="Search drawers and projects" value={s.query} onChange={e => void c.search(e.target.value)}/></label>
    <div className="mem-modal-list" role="listbox" aria-label="Drawers">
      {s.targets.length === 0 && <p className="fine-print">No drawer or project matches.</p>}
      {s.targets.map(t => <button key={t.drawer} type="button" role="option" aria-selected={s.to === t.drawer} onClick={() => void c.pick(t.drawer)}><span>{t.name}</span><span className="fine-print">{t.note}</span></button>)}
    </div>
    <label className="mem-modal-field">Why (optional, kept in its history)<input placeholder="Saved in the wrong project" value={s.reason} maxLength={200} onChange={e => c.setReason(e.target.value)}/></label>
    <div className="mem-modal-quote">
      {toName ? <span>After the move it is read by the agents of {toName} ({agentsWord(s.readersAfter)}) instead of {drawerName(m.drawerId)} ({agentsWord(s.readersNow)}).</span> : <span>Pick where it belongs.</span>}
      <span className="fine-print">The move is a new version: History shows where it was. Replies that used it show “moved”.</span>
    </div>
    {s.notice && <p className="card-notice" role="alert">{s.notice}</p>}
    <div className="actions mem-push-down"><button type="button" className="primary" disabled={!s.to || s.busy} onClick={() => void c.move()}>Move</button><button type="button" onClick={() => c.close()}>Cancel</button></div>
  </section>;
}

/** The doctor's kinds as the dialog names them (board M13). */
export const FIX_TEXT: Record<string, string> = {
  duplicate: 'Keep the one with a topic key (else the oldest); delete the extra copies',
  expired: 'Delete working / experience items past their expiry',
  'embedding-missing': 'Index with the current model',
  'embedding-stale': 'Re-index (skipped while the model does not answer)',
  'orphan-versions': 'Close the history of a memory that no longer exists',
  'broken-drawer': 'Move to the default drawer of its type',
  'topic-key-invalid': 'Normalise, or clear when the standard key is taken',
  'graph-orphan': 'Remove map links and entities that no memory mentions',
};

export function SafeFixDialog({ c }: { c: MemoryHealthController }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const [groups, setGroups] = useState(false);
  if (!s.fixing || !s.report) return null;
  const r = s.report;
  const kinds = CHECKS.flatMap(ch => ch.kinds.map(k => ({ kind: k, label: ch.kinds.length > 1 ? (k === 'embedding-missing' ? 'Missing meaning index' : 'Old meaning index') : ch.label })));
  const dupGroups = r.issues.filter(i => i.kind === 'duplicate');
  const items = c.count(s.kinds);
  return <section className="mem-modal" role="dialog" aria-modal="false" aria-labelledby="mem-fix-title">
    <div className="mem-modal-head"><span className="fine-print">From Health check · checked {ago(r.checkedAt) === 'now' ? 'just now' : `${ago(r.checkedAt)} ago`}</span><h3 id="mem-fix-title">Review safe fixes</h3><span className="fine-print">Pick what to fix. Deleted copies keep their history and can be brought back.</span></div>
    <div className="mem-modal-kinds">{kinds.map(k => { const n = r.counts[k.kind] ?? 0; return <label key={k.kind}>
      <input type="checkbox" checked={s.kinds.includes(k.kind)} disabled={n === 0} aria-label={k.label} onChange={() => c.toggleKind(k.kind)}/>
      <span><b>{k.label}</b><span className="fine-print">{FIX_TEXT[k.kind]}</span></span>
      <span className="mem-modal-count" data-tone={n === 0 ? 'ok' : s.kinds.includes(k.kind) ? 'warn' : undefined}>{n}</span>
    </label>; })}</div>
    {dupGroups.length > 0 && <button type="button" className="link-button" aria-expanded={groups} onClick={() => setGroups(!groups)}>{groups ? 'Hide' : 'Show'} the {dupGroups.length} duplicate {dupGroups.length === 1 ? 'group' : 'groups'} ›</button>}
    {groups && <ul className="mem-modal-groups">{dupGroups.map((g, i) => <li key={i}>{drawerName(g.drawerId)} · {g.memoryIds.length} copies{g.detail ? ` · ${g.detail}` : ''}</li>)}</ul>}
    {s.stale && <div className="mem-bridge-warn mem-modal-stale"><span>Memory changed since this check. Nothing was fixed.</span><button type="button" disabled={s.busy} onClick={() => void c.check(true)}>Check again</button></div>}
    {s.notice && !s.stale && <p className="card-notice" role="alert">{s.notice}</p>}
    <div className="actions mem-push-down">
      <button type="button" className="primary" disabled={s.busy || !s.kinds.length || s.stale} onClick={() => void c.fix()}>Fix {s.kinds.length} {s.kinds.length === 1 ? 'kind' : 'kinds'} · {items} {items === 1 ? 'item' : 'items'}</button>
      <button type="button" onClick={() => c.cancelFix()}>Cancel</button>
    </div>
  </section>;
}
