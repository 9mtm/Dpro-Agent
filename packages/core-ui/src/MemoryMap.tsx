// MEM-UI-01 P4 (board M4): the map canvas with kind chips, depth and zoom,
// and the selected node's links, facts and timeline.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { KIND_COLOR, KIND_PLURAL, MemoryMapController } from './memory-map';
import { ENTITY_KINDS } from './memory-pages-contract.js';
import { ago, drawerName, oneLine } from './memory-store';
import { UiIcon } from './ui-icons';

const KIND_WORD: Record<string, string> = { person: 'Person', project: 'Project', topic: 'Topic', agent: 'Agent', decision: 'Decision', place: 'Place', task: 'Task' };
const linkWord = (t: string) => t.replace(/_/g, ' ');

export function KnowledgeMap({ c, onOpenMemories }: { c: MemoryMapController; onOpenMemories: (name: string) => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const canvas = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => c.fit(el.clientWidth - 24, el.clientHeight - 70));
    ro.observe(el);
    return () => ro.disconnect();
  }, [c, s.phase, !!s.detail]);
  if (s.phase === 'error') return <p className="empty-note">{s.notice} <button type="button" className="link-button" onClick={() => void c.load()}>Try again</button></p>;
  if (s.phase !== 'ready') return <p className="empty-note" role="status">Drawing the map…</p>;
  const { nodes, links } = c.visible();
  const pos = s.positions;
  const d = s.detail;
  return <div className="mem-map">
    <div className="mem-map-bar">
      <form className="memory-search mem-map-search" role="search" onSubmit={e => { e.preventDefault(); c.clearSelection(); void c.load(); }}>
        <UiIcon name="search" size={13}/><input type="search" aria-label="Find in the map" placeholder="Start from a person, project or topic" value={s.query} onChange={e => c.setQuery(e.target.value)}/>
      </form>
      <div className="mem-map-kinds" role="group" aria-label="Show">{ENTITY_KINDS.filter(k => k !== 'task').map(k => <button key={k} type="button" aria-pressed={s.kinds.includes(k)} onClick={() => c.toggleKind(k)}><span className="mem-dot" style={{ background: KIND_COLOR[k] }}/>{KIND_PLURAL[k]}</button>)}</div>
    </div>
    {s.notice && <p className="card-notice" role="alert">{s.notice}</p>}
    <div className="mem-map-body" data-open={d ? 'true' : undefined}>
      <section className="mem-map-canvas" aria-label="Map" ref={canvas}>
        {nodes.length === 0 ? <p className="empty-note">{s.entities.length ? 'Nothing of these kinds. Turn on more chips above.' : 'The map is empty. Agents add people, projects and decisions as they learn.'}</p> : <>
          <div className="mem-map-stage" style={{ transform: `scale(${s.zoom})`, inlineSize: s.size[0] + 80, blockSize: s.size[1] + 40 }}>
            <svg className="mem-map-lines" width={s.size[0] + 80} height={s.size[1] + 40} aria-hidden="true">
              {links.map(l => { const a = pos[l.from.id], b = pos[l.to.id]; if (!a || !b) return null; const pending = l.status === 'pending';
                return <g key={l.id}><line x1={a[0] + 50} y1={a[1] + 16} x2={b[0] + 50} y2={b[1] + 16} className="mem-map-line" data-pending={pending || undefined}/>
                  <text x={(a[0] + b[0]) / 2 + 50} y={(a[1] + b[1]) / 2 + 12} className="mem-map-label" data-pending={pending || undefined}>{pending ? `${linkWord(l.type)} (review)` : linkWord(l.type)}</text></g>; })}
            </svg>
            {nodes.map(n => { const p = pos[n.id]; if (!p) return null;
              return <button key={n.id} type="button" className="mem-node" aria-pressed={s.selected === n.id} style={{ left: p[0], top: p[1] }} onClick={() => void c.select(n.id)}><span className="mem-dot" style={{ background: KIND_COLOR[n.kind] }}/>{n.name}</button>; })}
          </div>
          <div className="mem-map-foot">
            <label className="mem-chip-select">Depth<select value={s.depth} onChange={e => c.setDepth(Number(e.target.value) as 1 | 2)}><option value={1}>1 link</option><option value={2}>2 links</option></select></label>
            <span className="fine-print">{nodes.length} of {s.entities.length} shown{s.entities.length >= 150 ? ' (the first 150; search to start elsewhere)' : ''}</span>
            {s.selected && <button type="button" className="link-button" onClick={() => c.clearSelection()}>Show everything</button>}
          </div>
          <div className="mem-map-zoom"><button type="button" aria-label="Zoom in" onClick={() => c.zoomBy(1.2)}>+</button><button type="button" aria-label="Zoom out" onClick={() => c.zoomBy(1 / 1.2)}>−</button></div>
        </>}
      </section>
      {d && <aside className="mem-map-side" aria-label="Selected">
        <div><span className="fine-print">{KIND_WORD[d.entity.kind] ?? d.entity.kind}</span><h3>{d.entity.name}</h3>{d.entity.aliases.length > 0 && <span className="fine-print">Also: {d.entity.aliases.join(', ')}</span>}</div>
        <h4>Links</h4>
        {d.links.length === 0 ? <p className="fine-print">No links yet.</p> : <ul className="mem-map-links">{d.links.map(l => {
          const other = l.from.id === d.entity.id ? l.to : l.from; const out = l.from.id === d.entity.id;
          return <li key={l.id} data-pending={l.status === 'pending' || undefined}>
            <span>{out ? '' : `${l.from.name} `}{linkWord(l.type)} → <button type="button" className="link-button" onClick={() => void c.select(other.id)}>{out ? other.name : d.entity.name}</button>{l.status === 'pending' ? ' · waiting for your review' : ''}</span>
            {l.status === 'pending' && <span className="mem-row-actions"><button type="button" className="link-button" disabled={s.busy} onClick={() => void c.decideLink(l.id, 'approve')}>Approve</button><button type="button" className="link-button danger" disabled={s.busy} onClick={() => void c.decideLink(l.id, 'reject')}>Reject</button></span>}
          </li>; })}</ul>}
        <h4>Facts about {d.entity.name}</h4>
        <ul className="mem-map-facts">{d.timeline.slice(-6).reverse().map(t => <li key={t.memoryId} dir="auto">{oneLine(t.preview)}</li>)}</ul>
        <h4>Timeline</h4>
        <ul className="mem-map-time fine-print">{[...d.timeline].reverse().slice(0, 8).map(t => <li key={t.memoryId}>{ago(t.createdAt)} · {t.type} · {drawerName(t.drawer)}</li>)}</ul>
        <button type="button" className="link-button mem-push-down" onClick={() => onOpenMemories(d.entity.name)}>Open all {d.entity.memories} {d.entity.memories === 1 ? 'memory' : 'memories'} about {d.entity.name}</button>
      </aside>}
    </div>
  </div>;
}
