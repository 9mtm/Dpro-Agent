// MEM-UI-01 P3 (board M3): search + filter chips, the memory table (server
// paged), and the topic history side panel with Edit, Move drawer, Forget.
import { useSyncExternalStore } from 'react';
import { MemoryExplorerController } from './memory-explorer';
import { ago, agentLabel, drawerName, oneLine } from './memory-store';
import { drawerKinds, memoryTypes } from './agent-card-contract.js';
import type { Drawer, MemoryType } from './agent-card-contract.js';
import { UiIcon } from './ui-icons';

const KIND_LABEL: Record<string, string> = { owner: 'About you', experience: 'Lessons', project: 'Project', task: 'Task', people: 'Person' };
const Bars = ({ n }: { n: number }) => { const on = Math.round(n / 2); return <span className="imp" role="img" aria-label={`Importance ${n} of 10`}>{[0, 1, 2, 3, 4].map(i => <i key={i} data-on={i < on || undefined}/>)}</span>; };
const CHANGE: Record<string, string> = { create: 'created', update: 'changed', move: 'moved', delete: 'deleted', forget: 'forgotten', restore: 'restored' };
function byLine(by: string | undefined, agents: Readonly<Record<string, string>>): string {
  if (!by) return '';
  if (by === 'you') return 'by you';
  if (by.startsWith('agent:')) return agentLabel(by, agents);
  return by;
}

/** Drawers a memory can move to: the fixed ones plus every project / person drawer seen in this scope. */
function drawerChoices(facets: Readonly<Record<string, number>>, extra: string[]): string[] {
  return [...new Set(['owner', 'experience', ...Object.keys(facets), ...extra])].filter(d => d && d !== '?');
}

const SOURCE: Record<string, string> = { owner: 'You', agent: 'An agent', outsider: 'Outside sender', chat: 'Chat', conversation: 'Chat', learning: 'Learned', import: 'Import', memory_file: 'Memory file', retention: 'Retention' };

export function Explorer({ c, agents, onMove }: { c: MemoryExplorerController; agents: Readonly<Record<string, string>>; onMove?: (m: { id: string; text: string; drawerId: string; topicKey: string | null }) => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const open = c.item(s.open);
  const choices = drawerChoices(s.facets.drawer, open ? [open.drawerId] : []);
  const shownAll = s.items.length > 0 && s.items.every(i => s.checked.includes(i.id));
  return <div className="mem-explorer">
    <div className="mem-explorer-bar">
      <form className="memory-search mem-explorer-search" role="search" onSubmit={e => { e.preventDefault(); void c.searchMeaning(); }}>
        <UiIcon name="search" size={13}/>
        <input type="search" aria-label="Search memories" placeholder="Search (Enter searches by meaning)" value={s.query} onChange={e => c.setQuery(e.target.value)} onBlur={() => { if (!s.meaning) void c.load(); }} onKeyUp={e => { if (e.key !== 'Enter' && !s.query) void c.load(); }}/>
      </form>
      {s.meaning ? <span className="fine-print">by meaning · <button type="button" className="link-button" onClick={() => void c.load()}>show word matches</button></span> : <button type="button" className="link-button" onClick={() => void c.load()}>Find words</button>}
      <label className="mem-chip-select">Drawer<select value={s.scope.startsWith('agent:') || s.scope.startsWith('department:') ? '' : s.scope} onChange={e => c.setScope(e.target.value || 'company')}>
        <option value="company">All drawers</option>
        {drawerChoices(s.facets.drawer, s.scope.includes(':') && !s.scope.startsWith('agent:') ? [s.scope] : ['owner', 'experience']).map(d => <option key={d} value={d}>{drawerName(d)}{s.facets.drawer[d] !== undefined ? ` · ${s.facets.drawer[d]}` : ''}</option>)}
      </select></label>
      <label className="mem-chip-select">Agent<select value={s.scope.startsWith('agent:') ? s.scope : ''} onChange={e => c.setScope(e.target.value || 'company')}>
        <option value="">Any agent</option>
        {Object.entries(agents).sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => <option key={id} value={`agent:${id}`}>{name}</option>)}
      </select></label>
      <label className="mem-chip-select">Type<select value={s.type} onChange={e => c.setType(e.target.value)}>
        <option value="">Any type</option>
        {[...new Set([...Object.keys(s.facets.type), ...(s.type ? [s.type] : [])])].map(t => <option key={t} value={t}>{t}{s.facets.type[t] !== undefined ? ` · ${s.facets.type[t]}` : ''}</option>)}
      </select></label>
      <label className="mem-chip-select">Topic<select value={s.topic} onChange={e => c.setTopic(e.target.value as '' | 'has' | 'none')}>
        <option value="">Any</option><option value="has">Has a topic</option><option value="none">No topic</option>
      </select></label>
      <label className="mem-chip-select">Source<select value={s.source} onChange={e => c.setSource(e.target.value)}>
        <option value="">Anyone</option>
        {[...new Set([...Object.keys(s.facets.source ?? {}), ...(s.source ? [s.source] : [])])].map(x => <option key={x} value={x}>{SOURCE[x] ?? x}{s.facets.source?.[x] !== undefined ? ` · ${s.facets.source[x]}` : ''}</option>)}
      </select></label>
      <label className="mem-chip-select">Importance<select value={s.importance} onChange={e => c.setImportance(e.target.value as typeof s.importance)}>
        <option value="">Any</option><option value="8-10">High (8–10)</option><option value="5-7">Medium (5–7)</option><option value="1-4">Low (1–4)</option>
      </select></label>
      <label className="mem-chip-select">Date<select value={s.since} onChange={e => c.setSince(e.target.value as typeof s.since)}>
        <option value="">Any time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
      </select></label>
    </div>
    {s.notice && <p className="card-notice" role="alert">{s.notice}</p>}
    {s.result && <p className="memory-status" role="status">{s.result}</p>}
    {s.adding && <AddMemory c={c}/>}
    {s.checked.length > 0 && <div className="mem-bulk-bar">
      <span>{s.checked.length} selected</span>
      {s.bulk === null ? <><button type="button" onClick={() => c.askBulk('move')} disabled={s.busy}>Move…</button><button type="button" className="mem-reject" onClick={() => c.askBulk('forget')} disabled={s.busy}>Forget…</button><button type="button" className="link-button" onClick={() => c.checkAllShown(false)}>Clear</button></>
        : s.bulk === 'move' ? <><label className="mem-chip-select">To<select value={s.bulkTo} onChange={e => c.setBulkTo(e.target.value)}><option value="">Choose a drawer…</option>{choices.map(d => <option key={d} value={d}>{drawerName(d)}</option>)}</select></label>
          <button type="button" className="primary" disabled={!s.bulkTo || s.busy} onClick={() => void c.runBulk()}>Move {s.checked.length}</button><button type="button" onClick={() => c.cancelBulk()}>Cancel</button></>
        : <><span className="mem-warn-text">Forget {s.checked.length} for good? Their history goes too.</span><button type="button" className="danger-solid" disabled={s.busy} onClick={() => void c.runBulk()}>Forget {s.checked.length}</button><button type="button" onClick={() => c.cancelBulk()}>Keep</button></>}
    </div>}
    <div className="mem-explorer-body" data-open={open ? 'true' : undefined}>
      <section className="mem-table" aria-label="Memories">
        <div className="mem-table-head"><input type="checkbox" aria-label="Select all shown" checked={shownAll} onChange={e => c.checkAllShown(e.target.checked)}/><span>Memory</span><span>Topic</span><span>Drawer</span><span>Importance</span><span>Updated</span></div>
        {s.phase === 'loading' && <p className="empty-note" role="status">Loading memory…</p>}
        {s.phase === 'error' && <p className="empty-note">{s.notice} <button type="button" className="link-button" onClick={() => void c.load()}>Try again</button></p>}
        {s.phase === 'ready' && s.items.length === 0 && <p className="empty-note">{s.query ? 'No memory matches.' : 'This scope has no memories yet.'}</p>}
        {s.items.map(i => <div key={i.id} className="mem-table-row" data-open={i.id === s.open || undefined} id={`memory-${i.id}`}>
          <input type="checkbox" aria-label="Select" checked={s.checked.includes(i.id)} onChange={() => c.toggleCheck(i.id)}/>
          <button type="button" className="mem-table-text" dir="auto" onClick={() => void c.openMemory(i.id)}>{oneLine(i.preview)}</button>
          <span className="mem-topic">{i.topicKey ?? ''}</span>
          <span className="fine-print">{drawerName(i.drawerId)}</span>
          <Bars n={i.importance}/>
          <span className="fine-print">{ago(i.createdAt)}</span>
        </div>)}
        <div className="mem-table-foot fine-print" role="status">
          {s.meaning ? `${s.items.length} found by meaning` : `Showing ${s.items.length} of ${s.total}`}
          {s.nextCursor && !s.meaning && <button type="button" onClick={() => void c.more()} disabled={s.busy}>Load more</button>}
        </div>
      </section>
      {open && <aside className="mem-history" aria-label="Topic history">
        <div className="mem-history-head"><span className="fine-print">{open.topicKey ? `Topic · ${open.topicKey} · ` : ''}{drawerName(open.drawerId)}</span><button type="button" className="link-button" aria-label="Close" onClick={() => c.close()}>×</button></div>
        <h3 dir="auto">{oneLine(s.full ?? open.preview)}</h3>
        <div className="mem-chips"><span className="mem-chip">{open.type}</span><span className="mem-chip">importance {open.importance}</span>{open.sourceAgentId && <span className="mem-chip">from {agentLabel(open.sourceAgentId, agents)}</span>}</div>
        {s.detail && s.detail.id === open.id && <div className="mem-detail-facts">
          <span className="fine-print">Used in {s.detail.usage.usedIn} {s.detail.usage.usedIn === 1 ? 'reply' : 'replies'}{s.detail.usage.lastUsedAt ? ` · last ${ago(s.detail.usage.lastUsedAt)}` : ''} · {s.detail.readers.all ? 'read by every agent' : `read by ${s.detail.readers.count} of ${s.detail.readers.total} agents`}{s.detail.readers.archived ? ' · archived project (never loaded)' : ''}</span>
          {s.detail.graph.entities.length > 0 && <span className="mem-chips">On the map: {s.detail.graph.entities.map(e => <span key={e.id} className="mem-chip" data-kind={e.kind}>{e.name}</span>)}</span>}
        </div>}
        {s.editing ? <div className="mem-edit">
          <textarea aria-label="Memory text" dir="auto" rows={6} value={s.draft} maxLength={50000} onChange={e => c.editDraft(e.target.value)}/>
          <label className="field inline"><span>Importance</span><input type="range" min={1} max={10} value={s.draftImportance} onChange={e => c.editImportance(Number(e.target.value))}/><span>{s.draftImportance}</span></label>
          <div className="actions"><button type="button" className="primary" disabled={s.busy || !s.draft.trim()} onClick={() => void c.saveEdit()}>Save as a new version</button><button type="button" onClick={() => c.cancelEdit()}>Cancel</button></div>
        </div> : <>
          <h4>History</h4>
          {s.versions === null ? <p className="fine-print" role="status">Reading the history…</p> : s.versions.length === 0 ? <p className="fine-print">No history recorded.</p>
            : <ol className="mem-timeline">{s.versions.map((v, n) => <li key={v.version} data-current={n === 0 || undefined}>
              <span className="fine-print">v{v.version} · {ago(v.createdAt)} · {CHANGE[v.change] ?? v.change}{v.by ? ` ${byLine(v.by, agents)}` : ''}{v.proposal ? ' · approved by you' : ''}</span>
              <span dir="auto">{v.content ? oneLine(v.content) : '—'}</span>
            </li>)}</ol>}
        </>}
        {s.moving && <div className="mem-move">
          <label className="mem-chip-select">Move to<select value={s.moveTo} onChange={e => c.setMoveTo(e.target.value)}><option value="">Choose a drawer…</option>{choices.filter(d => d !== open.drawerId).map(d => <option key={d} value={d}>{drawerName(d)}</option>)}</select></label>
          <div className="actions"><button type="button" className="primary" disabled={!s.moveTo || s.busy} onClick={() => void c.move()}>Move</button><button type="button" onClick={() => c.cancelMove()}>Cancel</button></div>
          <p className="fine-print">The memory keeps its history; agents that cannot read the new drawer stop seeing it.</p>
        </div>}
        {s.confirmForget && <div className="mem-move"><p className="mem-warn-text">Forget this memory for good? Its text, history and copies are removed. This cannot be undone.</p>
          <div className="actions"><button type="button" className="danger-solid" disabled={s.busy} onClick={() => void c.forget()}>Forget for good</button><button type="button" onClick={() => c.cancelForget()}>Keep</button></div></div>}
        {!s.editing && !s.moving && !s.confirmForget && <div className="mem-history-actions">
          <button type="button" onClick={() => c.startEdit()}>Edit</button>
          <button type="button" onClick={() => (onMove ? onMove({ id: open.id, text: s.full ?? open.preview, drawerId: open.drawerId, topicKey: open.topicKey }) : c.startMove())}>Move drawer</button>
          <button type="button" className="mem-reject mem-push" onClick={() => c.askForget()}>Forget…</button>
        </div>}
      </aside>}
    </div>
  </div>;
}

function AddMemory({ c }: { c: MemoryExplorerController }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const a = s.adding!;
  const keyed = a.drawer.kind === 'project' || a.drawer.kind === 'task' || a.drawer.kind === 'people';
  return <form className="mem-card mem-add" aria-label="New memory" onSubmit={e => { e.preventDefault(); void c.saveAdd(); }}>
    <div className="mem-add-row">
      <label>Drawer<select value={a.drawer.kind} onChange={e => c.editAdd({ drawer: { kind: e.target.value as Drawer['kind'] } })}>{drawerKinds.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
      {keyed && <label>{KIND_LABEL[a.drawer.kind]} name<input value={a.drawer.key ?? ''} maxLength={64} placeholder={a.drawer.kind === 'project' ? 'e.g. flowxtra' : 'e.g. ahmed'} onChange={e => c.editAdd({ drawer: { kind: a.drawer.kind, key: e.target.value } })}/></label>}
      <label>Type<select value={a.type} onChange={e => c.editAdd({ type: e.target.value as MemoryType })}>{memoryTypes.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
      <label>Topic key<input value={a.topicKey} maxLength={80} placeholder="e.g. owner-drinks" onChange={e => c.editAdd({ topicKey: e.target.value })}/></label>
    </div>
    <label>What to remember<textarea rows={3} autoFocus dir="auto" value={a.content} maxLength={50000} onChange={e => c.editAdd({ content: e.target.value })}/></label>
    <div className="actions">
      <label className="field inline"><span>Importance</span><input type="range" min={1} max={10} value={a.importance} onChange={e => c.editAdd({ importance: Number(e.target.value) })}/><span>{a.importance}</span></label>
      <button type="submit" className="primary" disabled={s.busy || !a.content.trim()}>Save memory</button>
      <button type="button" onClick={() => c.cancelAdd()}>Cancel</button>
    </div>
    <p className="fine-print">With a topic key, a later fact on the same topic becomes a new version instead of a second memory.</p>
  </form>;
}
