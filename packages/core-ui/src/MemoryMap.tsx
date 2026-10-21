// MEM-UI-01 P4 (board M4): the map canvas with kind chips, depth and zoom,
// and the selected node's links, facts and timeline.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { KIND_COLOR, KIND_PLURAL, MemoryMapController } from './memory-map';
import type { GraphCluster } from './memory-pages-contract.js';
import { ENTITY_KINDS } from './memory-pages-contract.js';
import { ago, drawerName, oneLine } from './memory-store';
import { UiIcon } from './ui-icons';

const KIND_WORD: Record<string, string> = { person: 'Person', project: 'Project', topic: 'Topic', agent: 'Agent', decision: 'Decision', place: 'Place', task: 'Task' };
const linkWord = (t: string) => t.replace(/_/g, ' ');

export function KnowledgeMap({ c, onOpenMemories, agents = {} }: { c: MemoryMapController; onOpenMemories: (name: string) => void; agents?: Readonly<Record<string, string>> }) {
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
  const waiting = c.pending().length;
  const views = <div className="mem-map-views" role="group" aria-label="Map views">
    <button type="button" aria-pressed={s.view === 'map'} onClick={() => c.setView('map')}>Map</button>
    <button type="button" aria-pressed={s.view === 'links'} onClick={() => c.setView('links')}>Waiting links · {waiting}</button>
    <button type="button" aria-pressed={s.view === 'clusters'} onClick={() => c.setView('clusters')}>Clusters</button>
    <label className="mem-chip-select">As<select value={s.asAgent} onChange={e => c.setAgent(e.target.value)}><option value="">You (everything)</option>{Object.entries(agents).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></label>
    <button type="button" disabled={s.busy} onClick={() => void c.rebuild()}>Rebuild map</button>
  </div>;
  if (s.view !== 'map') return <div className="mem-map">{views}{s.notice && <p className="card-notice" role="alert">{s.notice}</p>}{s.result && <p className="memory-status" role="status">{s.result}</p>}<MapReview c={c}/></div>;
  const { nodes, links } = c.visible();
  const pos = s.positions;
  const d = s.detail;
  return <div className="mem-map">
    {views}
    {s.result && <p className="memory-status" role="status">{s.result}</p>}
    {s.agentView && <p className="fine-print mem-map-as">The map as {s.agentView.agentName} sees it: {s.agentView.readable.length ? s.agentView.readable.map(k => drawerName(k)).join(', ') : 'no drawer'}{s.agentView.project ? ` in ${s.agentView.project}` : ''}.</p>}
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

const RING = ['#4A84FE', '#3FB37F', '#F0C27A', '#C79BFF', '#F29BB0', '#7FD3E6'];
/** Clusters drawn in rings, one ring per drawer (project), at most 150 entities (board M14). */
function ClusterCanvas({ clusters }: { clusters: readonly GraphCluster[] }) {
  const byDrawer = new Map<string, GraphCluster[]>();
  for (const c of clusters) byDrawer.set(c.drawer, [...(byDrawer.get(c.drawer) ?? []), c]);
  const groups = [...byDrawer].slice(0, 6);
  let shown = 0;
  return <section className="mem-cluster-canvas" aria-label="Map, clustered by project">
    {groups.length === 0 && <p className="empty-note">No groups yet. They appear when the map keeps seeing the same things together.</p>}
    {groups.map(([drawer, cs], gi) => {
      const ents = [...new Map(cs.flatMap(c => c.entities).map(e => [e.id, e])).values()].slice(0, Math.max(0, 150 - shown));
      shown += ents.length;
      const color = RING[gi % RING.length];
      return <div key={drawer} className="mem-cluster-ring" style={{ boxShadow: `inset 0 0 0 1.5px ${color}55`, background: `${color}0F` }}>
        <span className="mem-cluster-label" style={{ color }}>{drawerName(drawer)} · {ents.length} things</span>
        <div className="mem-cluster-nodes">{ents.map(e => <span key={e.id} className="mem-node mem-node-static"><span className="mem-dot" style={{ background: KIND_COLOR[e.kind] }}/>{e.name}</span>)}</div>
      </div>;
    })}
    <div className="mem-map-foot"><span className="mem-chip-select">Clusters: by project</span><span className="fine-print">Max 150 shown</span></div>
  </section>;
}

/** Board M14: links waiting for review | the clustered map | groups that could become topics. */
function MapReview({ c }: { c: MemoryMapController }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const waiting = c.pending();
  const t = s.topic;
  return <div className="mem-map-review" data-focus={s.view}>
    <section className="mem-links-waiting" aria-label="Links waiting for review">
      <div className="mem-links-head"><b>Links waiting · {waiting.length}</b>
        <button type="button" disabled={s.busy || !s.checkedLinks.length} onClick={() => void c.decideSelected('approve')}>Approve selected</button>
        <button type="button" className="mem-reject" disabled={s.busy || !s.checkedLinks.length} onClick={() => void c.decideSelected('reject')}>Reject</button></div>
      <p className="fine-print mem-links-why">A link waits when it came from text an agent wrote (not from you) and it touches a person or a decision.</p>
      {waiting.length === 0 && <p className="empty-note">No link waits for you.</p>}
      {waiting.map(l => { const from = l.memoryIds[0] ? s.linkText[l.memoryIds[0]] : undefined;
        return <div key={l.id} className="mem-link-row" data-checked={s.checkedLinks.includes(l.id) || undefined}>
          <input type="checkbox" aria-label="Select link" checked={s.checkedLinks.includes(l.id)} onChange={() => c.toggleLink(l.id)}/>
          <div>
            <span className="mem-link-text-row"><b>{l.from.name}</b> <span data-tone="warn">— {linkWord(l.type)} →</span> <b>{l.to.name}</b></span>
            {from && <span className="fine-print mem-link-from" dir="auto">From: “{oneLine(from)}”</span>}
            <span className="actions"><button type="button" className="primary" disabled={s.busy} onClick={() => void c.decideLink(l.id, 'approve')}>Approve</button><button type="button" disabled={s.busy} onClick={() => void c.decideLink(l.id, 'reject')}>Reject</button><button type="button" className="link-button" onClick={() => c.showOnMap(l.from.id)}>Show on map</button></span>
          </div>
        </div>; })}
    </section>
    <ClusterCanvas clusters={s.clusters ?? []}/>
    <aside className="mem-topics" aria-label="Clusters to topics">
      <div><h3>Groups that could become topics</h3><span className="fine-print">Things the map keeps seeing together. A topic keeps one current answer with its history.</span></div>
      {s.clusters === null && <p className="fine-print" role="status">Looking for groups…</p>}
      {s.clusters?.length === 0 && <p className="fine-print">No group to suggest.</p>}
      {(s.clusters ?? []).slice(0, 8).map(g => <div key={g.id} className="mem-topic-card">
        <span className="mem-line"><b>{g.name}</b><span className="fine-print">{g.memoryIds.length} memories</span></span>
        <span className="fine-print">{g.entities.map(e => e.name).join(' · ')}</span>
        <label className="mem-topic-key">Topic key<input value={s.keys[g.id] ?? ''} onChange={e => c.setKey(g.id, e.target.value)}/></label>
        {t?.cluster.id === g.id ? <div className="mem-topic-preview">
          {t.blocked ? <span data-tone="warn">{t.blocked.code === 'key_taken' ? 'Another memory of this drawer already has that key; pick another.' : t.blocked.code === 'already_topic' ? 'A memory already holds this topic.' : 'Every memory here already has its own key.'}</span>
            : <span>“{oneLine(t.target!.preview)}” gets the key <code>{t.topicKey}</code>.</span>}
          {t.keepKey.length > 0 && <span className="fine-print">{t.keepKey.length} keep their own key (never renamed).</span>}
          {t.related.length > 0 && <span className="fine-print">{t.related.length} related stay as they are.</span>}
          <span className="actions"><button type="button" className="primary" disabled={s.busy || !!t.blocked} onClick={() => void c.makeTopic()}>Make topic</button><button type="button" onClick={() => c.cancelTopic()}>Cancel</button></span>
        </div> : <span className="actions"><button type="button" className="primary" disabled={s.busy} onClick={() => void c.previewTopic(g.id)}>Preview topic</button><button type="button" disabled={s.busy} onClick={() => void c.dismiss(g.id)}>Not a topic</button></span>}
      </div>)}
      <p className="mem-bridge-warn mem-push-down">Preview lists the memories that get the topic key and any that would conflict; nothing is merged on its own.</p>
    </aside>
  </div>;
}
