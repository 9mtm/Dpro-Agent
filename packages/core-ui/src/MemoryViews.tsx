import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { SessionClient } from './session';
import { MemoryItemsController, drawerId } from './memory-items';
import { drawerKinds, memoryTypes } from './agent-card-contract.js';
import type { Drawer, MemoryItem, MemoryType } from './agent-card-contract.js';
import { MemoryPanel } from './SessionPanels';
import { UiIcon } from './ui-icons';
import { ViewTabs } from './ViewTabs';
import { LocalImport } from './LocalImport';
import { MemoryScopesController } from './memory-scopes';
import { ActionDialog, HomeView, OverviewView, ScopeHeader, ScopeRail } from './MemoryHome';
import { MemoryReviewController } from './memory-review';
import { ReviewInbox } from './MemoryReviewInbox';
import { MemoryExplorerController } from './memory-explorer';
import { Explorer } from './MemoryExplorer';
import { MemoryMapController } from './memory-map';
import { KnowledgeMap } from './MemoryMap';
import { MemoryHealthController } from './memory-health';
import { HealthView } from './MemoryHealth';
import { MemoryAccessController } from './memory-access';
import { AccessView } from './MemoryAccess';
import { MemoryHandoffsController } from './memory-handoffs';
import { HandoffsView } from './MemoryHandoffs';
import { MemoryBridgeController } from './memory-bridge';
import { BridgeView } from './MemoryBridge';

const KIND_LABEL: Record<string, string> = { owner: 'About you', experience: 'Lessons', project: 'Project', task: 'Task', people: 'Person' };
const KIND_PLURAL: Record<string, string> = { project: 'Projects', task: 'Tasks', people: 'People' };
const KIND_HINT: Record<string, string> = {
  owner: 'Facts and preferences about you and the company.', experience: 'What the team learned from its work.',
  project: 'Context for one project.', task: 'Notes for one task.', people: 'What to know about one person.',
};
const TYPE_LABEL: Record<MemoryType, string> = { fact: 'Fact', event: 'Event', context: 'Context', insight: 'Insight', preference: 'Preference', skill: 'Skill', relationship: 'Relationship', task: 'Task' };

/** "About you", "Project: launch", … */
export function drawerLabel(d: Pick<Drawer, 'kind'> & { key?: string }): string {
  return d.key ? `${KIND_LABEL[d.kind] ?? d.kind}: ${d.key}` : KIND_LABEL[d.kind] ?? d.kind;
}

/** Importance as five short bars (1-10 → 0-5 filled). */
function Importance({ value }: { value: number }) {
  const filled = Math.round(value / 2);
  return <span className="imp" role="img" aria-label={`Importance ${value} of 10`}>{[0, 1, 2, 3, 4].map(i => <i key={i} data-on={i < filled || undefined}/>)}</span>;
}

/** One memory, read-only or with actions. */
export function MemoryCard({ item, actions, children, focused }: { item: MemoryItem; actions?: ReactNode; children?: ReactNode; focused?: boolean }) {
  return <article className="memory-card" data-type={item.type} id={`memory-${item.id}`} data-focus={focused || undefined}>
    <header className="memory-card-head">
      <span className="chip">{TYPE_LABEL[item.type] ?? item.type}</span>
      <Importance value={item.importance}/>
      <span className="memory-drawer">{drawerLabel(item.drawer)}</span>
      <span className="memory-date">{item.createdAt.slice(0, 10)}</span>
      {actions && <span className="memory-actions">{actions}</span>}
    </header>
    <p className="memory-text" dir="auto">{item.content}</p>
    {children}
  </article>;
}

/**
 * The Memory page (boards M1 + M8): the scope rail on the left (Everything,
 * what waits, pinned, company → departments → projects, people, agents,
 * archived) and the open scope on the right with its views: Overview (the
 * memory home for Everything), Review, Explorer and Import.
 */
export type MemoryTab = 'home' | 'review' | 'explorer' | 'map' | 'handoffs' | 'access' | 'health' | 'bridge' | 'import';
export function MemoryPage({ client, active = false, focus, onOpenChat, onOpenProjects }: { client: SessionClient; active?: boolean; focus?: MemoryFocus | null; onOpenChat?: (conversationId: string) => void; onOpenProjects?: () => void }) {
  const [tab, setTab] = useState<MemoryTab>('home');
  const owner = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).user?.role === 'owner';
  const [c, setC] = useState<MemoryExplorerController>();
  const [scopes, setScopes] = useState<MemoryScopesController>();
  useEffect(() => { const x = new MemoryExplorerController(client); setC(x); return () => x.dispose(); }, [client]);
  useEffect(() => { const x = new MemoryScopesController(client); setScopes(x); return () => x.dispose(); }, [client]);
  const [review, setReview] = useState<MemoryReviewController>();
  const [map, setMap] = useState<MemoryMapController>();
  const [access, setAccess] = useState<MemoryAccessController>();
  useEffect(() => { const x = new MemoryAccessController(client); setAccess(x); return () => x.dispose(); }, [client]);
  useEffect(() => { if (active && access && owner && tab === 'access') void access.load(); }, [active, access, owner, tab]);
  const [health, setHealth] = useState<MemoryHealthController>();
  useEffect(() => { const x = new MemoryHealthController(client); setHealth(x); return () => x.dispose(); }, [client]);
  useEffect(() => { if (active && health && owner && tab === 'health') void health.load(); }, [active, health, owner, tab]);
  useEffect(() => { const x = new MemoryMapController(client); setMap(x); return () => x.dispose(); }, [client]);
  useEffect(() => { if (active && map && owner && tab === 'map') void map.load(); }, [active, map, owner, tab]);
  const [handoffs, setHandoffs] = useState<MemoryHandoffsController>();
  useEffect(() => { const x = new MemoryHandoffsController(client); setHandoffs(x); return () => x.dispose(); }, [client]);
  useEffect(() => { if (active && handoffs && owner && tab === 'handoffs') void handoffs.load(); }, [active, handoffs, owner, tab]);
  const [bridge, setBridge] = useState<MemoryBridgeController>();
  useEffect(() => { const x = new MemoryBridgeController(client); setBridge(x); return () => x.dispose(); }, [client]);
  useEffect(() => { if (active && bridge && owner && tab === 'bridge') void bridge.load(); }, [active, bridge, owner, tab]);
  const [explorerView, setExplorerView] = useState<'table' | 'files'>('table');
  useEffect(() => { if (!scopes) return; const x = new MemoryReviewController(client, () => void scopes.load(true)); setReview(x); return () => x.dispose(); }, [client, scopes]);
  useEffect(() => { if (active && scopes && owner) void scopes.load(); }, [active, scopes, owner]);
  useEffect(() => { if (active && review && owner && tab === 'review') void review.load(); }, [active, review, owner, tab]);
  // Opening the explorer reads the current scope again (agents may have learned meanwhile).
  useEffect(() => { if (active && c && owner && tab === 'explorer') void c.load(); }, [active, c, owner, tab]);
  // CHAT-PRO-02 E: "Open in Memory" from a chat opens the memory's drawer and the memory itself.
  useEffect(() => {
    if (!focus || !c) return;
    setTab('explorer'); setExplorerView('table');
    if ('scope' in focus) { c.setScope(focus.scope); return; }
    c.setScope(focus.drawerId); void c.openMemory(focus.memoryId);
  }, [focus?.n, c]);
  const s = useSyncExternalStore(scopes?.subscribe ?? noop, scopes?.getSnapshot ?? none, scopes?.getSnapshot ?? none);
  function pickScope(scope: string) {
    if (!scopes) return;
    if (scope.startsWith('_')) { scopes.toggle(scope); return; }
    if (scope.startsWith('people:') || scope.startsWith('agent:')) { setTab('explorer'); setExplorerView('table'); c?.setScope(scope); return; }
    scopes.select(scope);
    // The explorer and Access follow the scope; the other views stay where they are.
    if (tab === 'explorer') c?.setScope(scope);
  }
  function go(next: 'review' | 'explorer' | 'health' | 'import' | 'map' | 'access', drawer?: string) {
    if (next === 'review' || next === 'explorer' || next === 'import' || next === 'map' || next === 'health' || next === 'access') setTab(next);
    if (next === 'explorer' && c) { setExplorerView('table'); c.setQuery(''); c.setScope(drawer === 'owner' || drawer === 'experience' ? drawer : s?.scope ?? 'company'); }
  }
  const waiting = s?.tree?.company.pendingReviews;
  const tabs: { value: MemoryTab; label: string }[] = [
    { value: 'home', label: s && s.scope !== 'company' ? 'Overview' : 'Home' }, { value: 'review', label: waiting ? `Review · ${waiting}` : 'Review' }, { value: 'explorer', label: 'Explorer' }, { value: 'map', label: 'Map' }, { value: 'handoffs', label: 'Handoffs' }, { value: 'access', label: 'Access' }, { value: 'health', label: 'Health & rules' }, { value: 'bridge', label: 'Coding apps' },
    ...(owner ? [{ value: 'import' as const, label: 'Import' }] : []),
  ];
  return <section className="mem" aria-label="Memory">
    {scopes && owner && <ScopeRail c={scopes} onWaiting={() => setTab('review')} onScope={pickScope}/>}
    <div className="mem-main">
      {(() => {
        const row = <div className="mem-tabs-row">
          <ViewTabs id="memory-view" label="Memory views" value={tab} onChange={setTab} tabs={tabs}/>
          {owner && <form className="memory-search mem-head-search" role="search" onSubmit={e => { e.preventDefault(); const q = (e.currentTarget.elements.namedItem('q') as HTMLInputElement).value; if (c) { setTab('explorer'); setExplorerView('table'); c.setQuery(q); void c.searchMeaning(); } }}>
            <UiIcon name="search" size={13}/><input name="q" type="search" placeholder="Search all memory (Enter = by meaning)" aria-label="Search memories"/>
          </form>}
          {owner && <button type="button" className="primary" onClick={() => { setTab('explorer'); setExplorerView('table'); c?.startAdd(); }}><UiIcon name="plus" size={12}/>Add memory</button>}
        </div>;
        return scopes && owner ? <ScopeHeader c={scopes}>{row}</ScopeHeader>
          : <div className="mem-head"><div className="mem-head-row"><h2>Memory</h2>{!owner && <span className="mem-meta">Only the owner manages the memory here.</span>}</div>{row}</div>;
      })()}
      {s?.notice && <p className="card-notice" role="status">{s.notice}</p>}
      {scopes && <ActionDialog c={scopes}/>}
      <div id="memory-view-panel" role="tabpanel" aria-labelledby={`memory-view-${tab}`} className="mem-panel">
        {tab === 'home' && scopes && (s?.phase === 'error' ? <p className="empty-note">{s.notice} <button type="button" className="link-button" onClick={() => void scopes.load()}>Try again</button></p>
          : s?.phase !== 'ready' ? <p className="empty-note" role="status">Loading memory…</p>
          : s.scope === 'company' ? <HomeView c={scopes} go={go}/> : <OverviewView c={scopes} go={go}/>)}
        {tab === 'explorer' && <>
          <div className="mem-view-toggle" role="group" aria-label="Explorer view"><button type="button" aria-pressed={explorerView === 'table'} onClick={() => setExplorerView('table')}>Table</button><button type="button" aria-pressed={explorerView === 'files'} onClick={() => setExplorerView('files')}>Files</button></div>
          {explorerView === 'files' ? <><p className="fine-print">Agent files and reviews: each agent's readable memory files (MEMORY.md). Edits you make there come back as reviews.</p><MemoryPanel client={client} active={active && tab === 'explorer'}/></>
            : c ? <Explorer c={c} agents={s?.agents ?? {}}/> : null}
        </>}
        {tab === 'map' && map && <KnowledgeMap c={map} onOpenMemories={name => { if (!c) return; setTab('explorer'); setExplorerView('table'); c.setQuery(name); c.setScope('company'); }}/>}
        {tab === 'access' && access && <AccessView c={access} scope={s?.scope.startsWith('project:') || s?.scope.startsWith('department:') ? s.scope : 'company'} tree={s?.tree ?? null}/>}
        {tab === 'health' && health && <HealthView c={health} conflicts={s?.tree ? s.tree.company.conflicts : null} onReview={() => setTab('review')} onFiles={() => { setTab('explorer'); setExplorerView('files'); }}/>}
        {tab === 'handoffs' && handoffs && <HandoffsView c={handoffs} onOpenChat={onOpenChat}/>}
        {tab === 'bridge' && bridge && <BridgeView c={bridge} onChangeFolder={onOpenProjects ? () => onOpenProjects() : undefined}/>}
        {tab === 'import' && <LocalImport client={client} active={active} onReview={() => setTab('review')}/>}
        {tab === 'review' && review && <ReviewInbox c={review}/>}
      </div>
    </div>
  </section>;
}
const noop = () => () => {};
const none = () => undefined;

/** A memory to show when the page opens from elsewhere (n changes on every request). */
export type MemoryFocus = { drawerId: string; memoryId: string; n: number } | { scope: string; n: number };

export function ItemsView({ c, focused }: { c: MemoryItemsController; focused?: string }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  useEffect(() => { if (focused && s.phase === 'ready') document.getElementById(`memory-${focused}`)?.scrollIntoView?.({ block: 'center' }); }, [focused, s.phase, s.open]);
  const [confirm, setConfirm] = useState<string | null>(null);
  if (s.phase === 'error') return <p className="empty-note">{s.notice} <button type="button" className="link-button" onClick={() => void c.load()}>Try again</button></p>;
  if (s.phase !== 'ready') return <p className="empty-note" role="status">Loading memory…{s.loaded !== undefined && ` ${s.loaded} of ${s.total ?? '…'}`}</p>;
  const total = s.items.length;
  const kinds = drawerKinds.map(k => ({ kind: k, drawers: s.drawers.filter(d => d.kind === k) }));
  const matches = c.visible();
  const items = matches.slice(s.offset, s.offset + 50);
  const openDrawer = s.open === 'all' ? null : s.drawers.find(d => drawerId(d) === s.open) ?? null;
  const openKind = openDrawer?.kind ?? (s.open === 'all' ? null : s.open.split(':')[0]);
  const readers = openKind ? s.readers[openKind] ?? [] : [];
  return <div className="memory-layout">
    <nav className="drawer-nav" aria-label="Drawers">
      <button type="button" className="drawer-row" aria-current={s.open === 'all' || undefined} onClick={() => c.openDrawer('all')}><span>All memories</span><span className="count">{total}</span></button>
      {kinds.map(({ kind, drawers }) => {
        const single = kind === 'owner' || kind === 'experience';
        const count = drawers.reduce((n, d) => n + d.count, 0);
        return <div key={kind} className="drawer-group">
          {single
            ? <button type="button" className="drawer-row" aria-current={s.open === kind || undefined} onClick={() => c.openDrawer(kind)}><span>{KIND_LABEL[kind]}</span><span className="count">{count}</span></button>
            : <><p className="drawer-kind">{KIND_PLURAL[kind]}</p>
              {drawers.length === 0 && <p className="drawer-empty">None yet</p>}
              {drawers.map(d => <button key={drawerId(d)} type="button" className="drawer-row nested" aria-current={s.open === drawerId(d) || undefined} onClick={() => c.openDrawer(drawerId(d))}><span><bdi>{d.key}</bdi></span><span className="count">{d.count}</span></button>)}</>}
        </div>;
      })}
    </nav>
    <div className="memory-main">
      <div className="memory-toolbar">
        <div className="memory-title">
          <h3>{s.open === 'all' ? 'All memories' : drawerLabel(openDrawer ?? { kind: s.open as Drawer['kind'] })}</h3>
          <p className="fine-print">{s.open === 'all' ? `${total} ${total === 1 ? 'memory' : 'memories'} in ${s.drawers.length} ${s.drawers.length === 1 ? 'drawer' : 'drawers'}.` : KIND_HINT[openKind ?? ''] ?? ''}
            {openKind && <> Read by: {readers.length ? readers.map(n => <span key={n} className="chip">{n}</span>) : 'no agent'}.</>}</p>
        </div>
        <form className="memory-search" role="search" onSubmit={e => { e.preventDefault(); void c.searchServer(); }}>
          <UiIcon name="search" size={13}/>
          <input type="search" placeholder="Search memories (Enter searches by meaning)" aria-label="Search memories" value={s.query} onChange={e => c.setQuery(e.target.value)}/>
        </form>
        <button type="button" className="ghost" onClick={() => void c.load()} disabled={s.busy}>Refresh</button>
        <button type="button" className="primary" onClick={() => c.startAdd()} disabled={!!s.adding}><UiIcon name="plus" size={12}/>Add memory</button>
      </div>
      {s.notice && <p className="card-notice" role="alert">{s.notice}</p>}
      {s.found && <p className="fine-print">{matches.length} found by meaning. <button type="button" className="link-button" onClick={() => c.setQuery(s.query)}>Show word matches</button></p>}
      {s.adding && <AddForm c={c}/>}
      {matches.length > 0 && <nav className="memory-pagination" aria-label="Memory pages">
        <span className="fine-print" role="status">Showing {s.offset + 1}–{Math.min(s.offset + 50, matches.length)} of {matches.length} memories</span>
        <button type="button" className="ghost" disabled={s.offset === 0 || s.busy || !!s.editing || !!s.adding} onClick={() => c.movePage(-1)}>Previous</button>
        <button type="button" className="ghost" disabled={s.offset + 50 >= matches.length || s.busy || !!s.editing || !!s.adding} onClick={() => c.movePage(1)}>Next</button>
      </nav>}
      {items.length === 0 && !s.adding ? <div className="empty-note">
        <p>{s.query ? 'No memory matches.' : 'This drawer is empty.'}</p>
        {!s.query && <p className="fine-print">Agents add memories while they work (if their permissions allow it), or add one yourself.</p>}
      </div> : <div className="memory-list">{items.map(m => s.editing === m.id
        ? <MemoryCard key={m.id} item={m}>
          <textarea className="memory-edit" rows={Math.min(10, Math.max(3, s.draft.split('\n').length + 1))} value={s.draft} dir="auto" maxLength={50000} onChange={e => c.editDraft(e.target.value)}/>
          <div className="card-actions">
            <label className="field inline"><span>Importance</span><input type="range" min={1} max={10} value={s.draftImportance} onChange={e => c.editImportance(Number(e.target.value))}/><span>{s.draftImportance}</span></label>
            <button type="button" className="primary" disabled={s.busy || !s.draft.trim()} onClick={() => void c.saveEdit()}>Save</button>
            <button type="button" className="ghost" onClick={() => c.cancelEdit()}>Cancel</button>
          </div>
        </MemoryCard>
        : <MemoryCard key={m.id} item={m} focused={m.id === focused} actions={confirm === m.id
          ? <span className="confirm-inline">Forget for good?<button type="button" className="link-button danger" onClick={() => { setConfirm(null); void c.forget(m.id); }}>Forget</button><button type="button" className="link-button" onClick={() => setConfirm(null)}>Keep</button></span>
          : <>
            <button type="button" className="ghost-action" onClick={() => c.startEdit(m.id)}>Edit</button>
            <button type="button" className="ghost-action" aria-expanded={!!s.history[m.id]} onClick={() => void c.toggleHistory(m.id)}>History</button>
            <button type="button" className="ghost-action" onClick={() => setConfirm(m.id)}>Forget</button>
          </>}>
          {s.history[m.id] && <ol className="memory-history">{[...s.history[m.id]].sort((x, y) => y.version - x.version).map(v => <li key={v.version}>
            <span className="version-n">v{v.version}</span><span className="chip">{v.change}</span><span className="memory-date">{v.createdAt.slice(0, 16).replace('T', ' ')}</span>
            <p dir="auto">{v.content}</p></li>)}</ol>}
        </MemoryCard>)}</div>}
    </div>
  </div>;
}

function AddForm({ c }: { c: MemoryItemsController }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const a = s.adding!;
  const keyed = a.drawer.kind === 'project' || a.drawer.kind === 'task' || a.drawer.kind === 'people';
  return <form className="memory-card adding" onSubmit={e => { e.preventDefault(); void c.saveAdd(); }} aria-label="New memory">
    <div className="field-grid three">
      <label className="field"><span>Drawer</span>
        <select value={a.drawer.kind} onChange={e => c.editAdd({ drawer: { kind: e.target.value as Drawer['kind'] } })}>
          {drawerKinds.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
      {keyed && <label className="field"><span>{KIND_LABEL[a.drawer.kind]} name</span>
        <input value={a.drawer.key ?? ''} placeholder={a.drawer.kind === 'project' ? 'e.g. launch' : a.drawer.kind === 'people' ? 'e.g. mona' : 'e.g. logo'} maxLength={64} onChange={e => c.editAdd({ drawer: { kind: a.drawer.kind, key: e.target.value } })}/></label>}
      <label className="field"><span>Type</span>
        <select value={a.type} onChange={e => c.editAdd({ type: e.target.value as MemoryType })}>{memoryTypes.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></label>
    </div>
    <label className="field"><span>What to remember</span>
      <textarea rows={3} autoFocus value={a.content} dir="auto" maxLength={50000} onChange={e => c.editAdd({ content: e.target.value })}/></label>
    <div className="card-actions">
      <label className="field inline"><span>Importance</span><input type="range" min={1} max={10} value={a.importance} onChange={e => c.editAdd({ importance: Number(e.target.value) })}/><span>{a.importance}</span></label>
      <button type="submit" className="primary" disabled={s.busy || !a.content.trim()}>Save memory</button>
      <button type="button" className="ghost" onClick={() => c.cancelAdd()}>Cancel</button>
    </div>
    <p className="fine-print">Importance 8 or more is kept for good; lower ones may fade over time.</p>
  </form>;
}
