// The Memory window as a desktop program (boards M21–M24, M32, M34): the
// section's own sidebar (places, groups of projects, Also), a quiet list and
// an inspector for the selected memory, one main button (Remember), a ⋯ menu
// and right-click menus for everything else, sheets for short tasks, and Undo
// (⌘Z and the notice) for every reversible change.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SessionClient } from './session';
import { UiIcon } from './ui-icons';
import type { UiIconName } from './ui-icons';
import { MemoryDesktopController, placeScope } from './memory-desktop';
import type { Place } from './memory-desktop';
import { MemoryExplorerController } from './memory-explorer';
import { MemoryScopesController, effectLines } from './memory-scopes';
import { MemoryReviewController } from './memory-review';
import { MemoryMoveController } from './memory-move';
import { MemoryMapController } from './memory-map';
import { MemoryHandoffsController } from './memory-handoffs';
import { DiscoveryController } from './discovery-controller';
import { KnowledgeMap } from './MemoryMap';
import { HandoffsView } from './MemoryHandoffs';
import { ago, drawerName, oneLine } from './memory-store';
import type { ExplorerItem, PinnedFact, ProjectAction, TreeProject, WeeklySummary } from './memory-pages-contract.js';
import { memoryTypes } from './agent-card-contract.js';
import type { MemoryType } from './agent-card-contract.js';
import { Avatar, ContextMenu, IconButton, Notice, Popover, Sheet, Tile, WithSwatches, useMenu } from './desktop-ui';
import type { MenuItem } from './desktop-ui';
import type { ProjectGroup } from './memory-desktop-contract.js';
import { NeedsYou } from './MemoryNeeds';
import { DatabasesView, DesignView, FilesView, GroupView, TrashView } from './MemoryPlaces';

/** Where a memory came from, as a kind icon and a short word (board rule 13: show things, not codes). */
export function kindOf(i: Pick<ExplorerItem, 'type' | 'source' | 'drawerId' | 'sourceAgentId'>): { icon: UiIconName; word: string } {
  if (i.drawerId === 'experience' || i.source === 'learning' || i.type === 'insight' || i.type === 'skill') return { icon: 'bulb', word: 'Lesson' };
  if (i.source === 'chat' || i.source === 'conversation') return { icon: 'message', word: 'From a chat' };
  if (i.source === 'memory_file') return { icon: 'file', word: 'From project notes' };
  if (i.source === 'import') return { icon: 'download', word: 'Imported' };
  if (i.source === 'owner') return { icon: 'avatar', word: 'Saved by you' };
  if (i.source === 'agent' || i.sourceAgentId) return { icon: 'sparkle', word: 'Learned' };
  if (i.type === 'event') return { icon: 'calendar', word: 'Event' };
  if (i.type === 'relationship') return { icon: 'link', word: 'Who works with whom' };
  return { icon: 'sparkle', word: 'Remembered' };
}
const PLACE_NAME: Record<string, string> = { needs: 'Needs you', all: 'All memories', owner: 'About you', experience: 'Lessons', tasks: 'Tasks', people: 'People', agents: 'Agents', archived: 'Archived', trash: 'Trash' };
const TYPE_LABEL: Record<string, string> = { fact: 'Fact', event: 'Event', context: 'Context', insight: 'Lesson', preference: 'Preference', skill: 'Skill', relationship: 'Relationship', task: 'Task' };
const SOURCE_LABEL: Record<string, string> = { owner: 'You', agent: 'An agent', chat: 'A chat', conversation: 'An imported chat', learning: 'Learning', import: 'Import', memory_file: 'Project notes', outsider: 'Outside sender', retention: 'Summary' };
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent ?? '');
const mod = isMac ? '⌘' : 'Ctrl+';

export type MemoryFocus = { drawerId: string; memoryId: string; n: number } | { scope: string; n: number };
export type SettingsTarget = 'rules' | 'folders' | 'sources' | 'projects' | 'access' | 'health' | 'schedule';

/** Controllers of the window, made once per client. */
function useControllers(client: SessionClient) {
  const [c, setC] = useState<{ d: MemoryDesktopController; x: MemoryExplorerController; sc: MemoryScopesController; rv: MemoryReviewController; mv: MemoryMoveController; map: MemoryMapController; ho: MemoryHandoffsController; disc: DiscoveryController }>();
  useEffect(() => {
    const d = new MemoryDesktopController(client), x = new MemoryExplorerController(client), sc = new MemoryScopesController(client);
    sc.light = true;
    const rv = new MemoryReviewController(client, () => void sc.load(true));
    const mv = new MemoryMoveController(client, (id, drawer) => x.moved(id, drawer));
    const map = new MemoryMapController(client), ho = new MemoryHandoffsController(client), disc = new DiscoveryController(client);
    setC({ d, x, sc, rv, mv, map, ho, disc });
    return () => { d.dispose(); x.dispose(); sc.dispose(); rv.dispose(); mv.dispose(); map.dispose(); ho.dispose(); disc.dispose(); };
  }, [client]);
  return c;
}
const noop = () => () => {};
function useStore<S>(store: { subscribe: (fn: () => void) => () => void; getSnapshot: () => S } | undefined): S | undefined {
  return useSyncExternalStore(store?.subscribe ?? noop, store?.getSnapshot ?? (() => undefined), store?.getSnapshot ?? (() => undefined)) as S | undefined;
}

export function MemoryWindow({ client, active = false, focus, sidebarSlot, onOpenChat, onOpenSettings }: {
  client: SessionClient; active?: boolean; focus?: MemoryFocus | null; sidebarSlot?: HTMLElement | null;
  onOpenChat?: (conversationId: string) => void; onOpenSettings?: (target: SettingsTarget) => void;
}) {
  const owner = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).user?.role === 'owner';
  const k = useControllers(client);
  const ds = useStore(k?.d), xs = useStore(k?.x), ss = useStore(k?.sc), rs = useStore(k?.rv), ms = useStore(k?.mv);
  const menu = useMenu();
  const [sheet, setSheet] = useState<null | { kind: 'remember' } | { kind: 'history' } | { kind: 'weekly' } | { kind: 'group'; projects: string[] } | { kind: 'rename-group'; id: string } | { kind: 'project'; action: ProjectAction; slug: string } | { kind: 'forget'; ids?: string[] } | { kind: 'trash-project'; slug: string } | { kind: 'edit-pinned'; fact: PinnedFact }>(null);
  const [filters, setFilters] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // First open: the tree, groups, what waits, the list.
  useEffect(() => {
    if (!active || !owner || !k) return;
    void k.sc.load(); void k.d.loadGroups(); void k.rv.load();
    if (k.x.getSnapshot().phase === 'idle') k.x.setScope('company');
  }, [active, owner, k]);
  // The list follows the place.
  useEffect(() => {
    if (!k || !ds) return;
    const scope = placeScope(ds.place);
    if (scope && k.x.getSnapshot().scope !== scope) k.x.setScope(scope);
    if (ds.place.startsWith('project:')) k.sc.select(ds.place);
    if (ds.place === 'needs' && k.rv.getSnapshot().phase !== 'ready') void k.rv.load();
  }, [ds?.place, k]);
  useEffect(() => { if (k && ds?.extra === 'map') void k.map.load(); if (k && ds?.extra === 'handoffs') void k.ho.load(); }, [ds?.extra, k]);
  // "Open in Memory" from a chat or an agent.
  useEffect(() => {
    if (!focus || !k) return;
    if ('scope' in focus) { k.d.open(focus.scope.startsWith('agent:') || focus.scope.startsWith('project:') ? focus.scope as Place : 'all'); return; }
    const place: Place = focus.drawerId === 'owner' || focus.drawerId === 'experience' ? focus.drawerId : focus.drawerId.startsWith('project:') ? focus.drawerId as Place : focus.drawerId.startsWith('people:') ? 'people' : focus.drawerId.startsWith('task:') ? 'tasks' : 'all';
    k.d.open(place); void k.x.openMemory(focus.memoryId);
  }, [focus?.n, k]);

  const project = ss?.tree && ds?.place.startsWith('project:') ? ss.tree.projects.find(p => p.slug === ds.place.slice(8)) ?? null : null;
  const open = xs?.open ? xs.items.find(i => i.id === xs.open) ?? null : null;
  const selection = xs?.checked ?? [];

  // Window keys: ⌘N Remember, ⌘F search, ⌘Z undo, ⌘⇧M map, ⌘M move, Delete → Trash, Enter edit, Esc closes.
  useEffect(() => {
    if (!active || !owner || !k) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = !!t.closest?.('input, textarea, select, [contenteditable="true"]');
      const cmd = e.metaKey || e.ctrlKey; const key = e.key.toLowerCase();
      if (document.querySelector('.dk-sheet-scrim, .dk-menu')) return;
      if (cmd && key === 'n' && !e.shiftKey) { e.preventDefault(); k.x.startAdd(); setSheet({ kind: 'remember' }); }
      else if (cmd && key === 'f') { e.preventDefault(); searchRef.current?.focus(); }
      else if (cmd && key === 'z' && !e.shiftKey && !typing) { e.preventDefault(); void k.d.undo().then(() => { void k.x.load(); void k.sc.load(true); }); }
      else if (cmd && e.shiftKey && key === 'm') { e.preventDefault(); k.d.setExtra('map'); }
      else if (cmd && key === 'm' && !typing) { const i = k.x.item(k.x.getSnapshot().open); if (i) { e.preventDefault(); void k.mv.open({ id: i.id, text: i.preview, drawerId: i.drawerId, topicKey: i.topicKey }); } }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
        const xs2 = k.x.getSnapshot(); const ids = xs2.checked.length ? [...xs2.checked] : xs2.open ? [xs2.open] : [];
        if (ids.length) { e.preventDefault(); void trashIds(ids); }
      }
      else if (e.key === 'Escape' && !typing) { if (k.x.getSnapshot().checked.length) k.x.checkAllShown(false); else k.x.close(); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [active, owner, k]);

  async function trashIds(ids: readonly string[]) {
    if (!k) return;
    const items = ids.map(id => ({ id, text: k.x.item(id)?.preview ?? 'memory' }));
    if (await k.d.trash(items)) { k.x.removed(ids); void k.sc.load(true); }
  }

  if (!owner) return <section className="dk-mem" aria-label="Memory"><div className="dk-empty"><p>Only the owner manages the memory here.</p></div></section>;
  if (!k || !ds || !xs || !ss || !rs) return <section className="dk-mem" aria-label="Memory"><p className="dk-empty" role="status">Opening memory…</p></section>;
  const { d, x, sc, rv, mv } = k;

  const waiting = rs.phase === 'ready' ? rs.items.length : ss.tree?.company.pendingReviews ?? 0;
  const memoryMenu = (i: ExplorerItem): MenuItem[] => [
    { label: 'Edit', icon: 'pencil', shortcut: '↩', run: () => { void x.openMemory(i.id).then(() => x.startEdit()); } },
    { label: 'Pin for every agent', icon: 'pin', run: () => void d.pin(i.preview, i.drawerId) },
    { label: 'Move…', icon: 'move', shortcut: `${mod}M`, run: () => void mv.open({ id: i.id, text: i.preview, drawerId: i.drawerId, topicKey: i.topicKey }) },
    { label: 'History', icon: 'history', run: () => { void x.openMemory(i.id); setSheet({ kind: 'history' }); } },
    'sep',
    { label: 'Move to Trash', icon: 'trash', shortcut: '⌫', run: () => void trashIds(xs.checked.includes(i.id) ? xs.checked : [i.id]) },
  ];
  const projectMenu = (p: TreeProject): MenuItem[] => {
    const groups = Array.isArray(ds.groups) ? (ds.groups as readonly ProjectGroup[]) : [];
    const inGroup = d.groupOf(p.slug);
    return [
      { label: 'Open', icon: 'folder', run: () => d.open(`project:${p.slug}`) },
      { label: p.pinned ? 'Unpin project' : 'Pin project', icon: 'pin', run: () => projectAction(p.slug, p.pinned ? 'unpin' : 'pin') },
      'sep',
      ...groups.filter(g => g.id !== inGroup?.id).slice(0, 8).map(g => ({ label: `Move to ${g.name}`, icon: 'group' as const, run: () => void d.moveToGroup(p.slug, g.id) })),
      ...(inGroup ? [{ label: `Take out of ${inGroup.name}`, icon: 'arrow-left' as const, run: () => void d.moveToGroup(p.slug, null) }] : []),
      { label: 'New group with this project…', icon: 'plus', run: () => setSheet({ kind: 'group', projects: [p.slug] }) },
      'sep',
      { label: 'Add a folder…', icon: 'folder', run: () => onOpenSettings?.('projects') },
      { label: 'Separate…', icon: 'diff', run: () => onOpenSettings?.('projects') },
      { label: 'Rules for this project…', icon: 'sliders', run: () => onOpenSettings?.('rules') },
      { label: 'Coding apps for this project…', icon: 'code', run: () => onOpenSettings?.('sources') },
      'sep',
      { label: 'Archive (kept, not loaded)', icon: 'archive', run: () => projectAction(p.slug, 'archive') },
      { label: 'Move the whole project to Trash…', icon: 'trash', danger: true, run: () => setSheet({ kind: 'trash-project', slug: p.slug }) },
    ];
  };
  function projectAction(slug: string, action: ProjectAction) {
    if (d.getSnapshot().place !== `project:${slug}`) d.open(`project:${slug}`);
    sc.select(`project:${slug}`);
    if (action === 'merge' || action === 'move') { sc.startAction(action); setSheet({ kind: 'project', action, slug }); return; }
    sc.startAction(action); void sc.previewAction(action); setSheet({ kind: 'project', action, slug });
  }
  const moreMenu: MenuItem[] = [
    { label: 'Show the map', icon: 'map', shortcut: `${mod}⇧M`, run: () => d.setExtra('map') },
    { label: 'Handoff notes', icon: 'note', run: () => d.setExtra('handoffs') },
    { label: 'Open as files', icon: 'file', run: () => d.setExtra('files') },
    { label: 'Weekly summary', icon: 'calendar', run: () => setSheet({ kind: 'weekly' }) },
    'sep',
    ...(project ? [
      { label: project.pinned ? 'Unpin project' : 'Pin project', icon: 'pin' as const, run: () => projectAction(project.slug, project.pinned ? 'unpin' : 'pin') },
      { label: 'Add a folder…', icon: 'folder' as const, run: () => onOpenSettings?.('projects') },
      { label: 'Move to group…', icon: 'group' as const, run: () => setSheet({ kind: 'group', projects: [project.slug] }) },
      { label: 'Merge with another project…', icon: 'diff' as const, run: () => projectAction(project.slug, 'merge') },
      { label: 'Move to another department…', icon: 'users' as const, run: () => projectAction(project.slug, 'move') },
      { label: 'Archive (kept, not loaded)', icon: 'archive' as const, run: () => projectAction(project.slug, 'archive') },
      { label: 'Export as files', icon: 'download' as const, run: () => void exportProject() },
      'sep' as const,
      { label: 'Move the whole project to Trash…', icon: 'trash' as const, danger: true, run: () => setSheet({ kind: 'trash-project', slug: project.slug }) },
    ] : [
      { label: 'Memory settings…', icon: 'gear' as const, shortcut: `${mod},`, run: () => onOpenSettings?.('rules') },
      { label: 'Move all to Trash…', icon: 'trash' as const, danger: true, disabled: !xs.items.length, run: () => { x.checkAllShown(true); } },
    ]),
  ];
  async function exportProject() {
    const e = await sc.exportProject();
    if (!e) { d.say('The project was not exported.'); return; }
    const text = e.files.map(f => `<!-- ${f.name} -->\n${f.content}`).join('\n\n');
    try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' })); a.download = `${e.project}-memory.md`; a.click(); URL.revokeObjectURL(a.href); d.say(`Exported ${e.files.length} files.`); } catch { d.say('The export could not be saved.'); }
  }

  const sidebar = <MemorySidebar k={k} waiting={waiting} searchRef={searchRef} onRemember={() => { x.startAdd(); setSheet({ kind: 'remember' }); }} menu={menu} projectMenu={projectMenu}
    onNewGroup={projects => setSheet({ kind: 'group', projects })} onRenameGroup={id => setSheet({ kind: 'rename-group', id })}/>;

  // ---- the content of the open place ----
  const place = ds.place;
  const title = ds.extra === 'map' ? 'Map' : ds.extra === 'handoffs' ? 'Handoff notes' : ds.extra === 'files' ? 'Open as files'
    : project ? project.name : place.startsWith('group:') ? (Array.isArray(ds.groups) ? (ds.groups as readonly ProjectGroup[]).find(g => g.id === place.slice(6))?.name ?? 'Group' : 'Group')
    : place.startsWith('agent:') ? ss.agents[place.slice(6)] ?? 'Agent' : xs.query && !place.startsWith('project:') && placeScope(place) ? 'Search' : PLACE_NAME[place] ?? 'Memory';
  const sub = ds.extra === 'map' ? 'people, projects and topics in memory' : ds.extra === 'handoffs' ? 'what agents left for the next session' : ds.extra === 'files' ? 'read-only view of the memory files per agent'
    : place === 'needs' ? `${waiting} ${waiting === 1 ? 'question' : 'questions'}` : place === 'trash' ? `kept ${ds.trash && ds.trash !== 'missing' ? (ds.trash.trashDays ? `${ds.trash.trashDays} days` : 'until you empty it') : '30 days'}, then forgotten`
    : project ? `${project.memories} ${project.memories === 1 ? 'memory' : 'memories'}${project.archived ? ' · archived' : ''}` : placeScope(place) && xs.phase === 'ready' ? `${xs.total} ${xs.total === 1 ? 'memory' : 'memories'}` : '';
  const listPlace = !ds.extra && !!placeScope(place) && (!project || ds.projectView === 'memories');
  const filterCount = [xs.type, xs.topic, xs.source, xs.agent, xs.importance, xs.since].filter(Boolean).length;

  const content = ds.extra === 'map' ? <KnowledgeMap c={k.map} agents={ss.agents} onOpenMemories={name => { d.setExtra(null); d.open('all'); x.setQuery(name); void x.load(); }}/>
    : ds.extra === 'handoffs' ? <HandoffsView c={k.ho} onOpenChat={onOpenChat}/>
    : ds.extra === 'files' ? <FilesView client={client} agents={ss.agents} drawers={[{ id: 'owner', name: 'About you' }, { id: 'experience', name: 'Lessons' }, ...(ss.tree?.projects ?? []).filter(p => !p.archived && !p.mergedInto && !p.trashedAt).map(p => ({ id: `project:${p.slug}`, name: p.name }))]}/>
    : place === 'needs' ? <NeedsYou c={rv} mode={ds.needsMode} onOpenChat={onOpenChat} design={d}/>
    : place === 'trash' ? <TrashView d={d} me={client.getSnapshot().user?.id} onAsk={ids => setSheet({ kind: 'forget', ids })}/>
    : place.startsWith('group:') ? <GroupView d={d} sc={sc} groupId={place.slice(6)}/>
    : place === 'agents' ? <AgentsPlace names={ss.agents} onOpen={id => d.open(`agent:${id}`)}/>
    : place === 'archived' ? <ArchivedPlace projects={(ss.tree?.projects ?? []).filter(p => p.archived)} onOpen={slug => d.open(`project:${slug}`)} onBack={slug => projectAction(slug, 'unarchive')}/>
    : project && ds.projectView === 'design' ? <DesignView d={d} slug={project.slug}/>
    : project && ds.projectView === 'databases' ? <DatabasesView d={d} slug={project.slug} agents={ss.agents}/>
    : project && ds.projectView === 'files' ? <FilesView client={client} agents={ss.agents} drawers={[{ id: `project:${project.slug}`, name: project.name }]}/>
    : <MemoryList k={k} pinned={ds.pinned} showPinned={place === 'all' || !!project} onMenu={(e, i) => menu.at(e, memoryMenu(i))} onPinnedMenu={(e, f) => menu.at(e, [{ label: 'Edit…', icon: 'pencil', run: () => setSheet({ kind: 'edit-pinned', fact: f }) }, { label: 'Unpin', icon: 'pin', run: () => void d.unpin(f) }])}
      empty={project ? <><p>Nothing remembered here yet. Dpro remembers on its own while you chat. You can add something yourself too.</p><button type="button" className="primary" onClick={() => { x.startAdd(); setSheet({ kind: 'remember' }); }}>Remember</button></>
        : xs.query ? <p>No memory matches. Put words in "quotes" for exact words.</p> : <p>Nothing here yet. Dpro remembers on its own while you chat.</p>}/>;

  const inspector = ds.extra ? null
    : xs.open && open && listPlace ? <MemoryInspector k={k} item={open} onHistory={() => setSheet({ kind: 'history' })} onTrash={() => void trashIds([open.id])}/>
    : project && ds.details === 'project' ? <ProjectInspector k={k} project={project} onSettings={onOpenSettings} onGroup={() => setSheet({ kind: 'group', projects: [project.slug] })}/>
    : null;

  return <section className="dk-mem" aria-label="Memory" data-inspector={inspector ? 'open' : undefined} data-inline-sidebar={sidebarSlot ? undefined : 'true'}>
    {sidebarSlot ? (active ? createPortal(sidebar, sidebarSlot) : null) : sidebar}
    <div className="dk-content">
      <header className="dk-toolbar">
        {ds.extra && <IconButton icon="arrow-left" label="Back to the list" onClick={() => d.setExtra(null)}/>}
        <div className="dk-title">
          {project && !ds.extra ? <button type="button" className="dk-title-button" title="Project details" onClick={() => d.showDetails(ds.details === 'project' ? null : 'project')}><Tile name={project.name}/><h2>{title}</h2></button> : <h2>{title}</h2>}
          {sub && <span className="dk-sub">{sub}</span>}
        </div>
        <ImportStatus client={client} active={active} onReview={() => d.open('needs')}/>
        {project && !ds.extra && <div className="dk-segmented" role="group" aria-label="Project views">
          {([['memories', 'layers'], ['design', 'palette'], ['databases', 'database'], ['files', 'file']] as const).map(([v, icon]) => <button key={v} type="button" aria-pressed={ds.projectView === v} title={`${v[0].toUpperCase() + v.slice(1)} of this project`} onClick={() => d.setView(v)}><UiIcon name={icon} size={13}/>{v[0].toUpperCase() + v.slice(1)}</button>)}
        </div>}
        <span className="dk-toolbar-gap"/>
        {listPlace && <span className="dk-anchor" data-popover-anchor><IconButton icon="filter" label="Filter" pressed={filters || filterCount > 0} badge={filterCount || undefined} onClick={() => setFilters(v => !v)}/>
          <Popover open={filters} onClose={() => setFilters(false)} label="Filter"><FilterPopover k={k} tree={ss.tree} agents={ss.agents}/></Popover></span>}
        {place === 'needs' && <IconButton icon={ds.needsMode === 'one' ? 'list' : 'inbox'} label={ds.needsMode === 'one' ? 'Show as a list' : 'One at a time'} onClick={() => d.setNeedsMode(ds.needsMode === 'one' ? 'list' : 'one')}/>}
        {ds.undoDepth > 0 && <IconButton icon="undo" label="Undo" shortcut={`${mod}Z`} disabled={ds.busy} onClick={() => void d.undo().then(() => { void x.load(); void sc.load(true); })}/>}
        <IconButton icon="more" label="More" onClick={e => menu.at(e, moreMenu)}/>
      </header>
      {selection.length > 0 && listPlace && <div className="dk-bulk" role="toolbar" aria-label="Selected memories">
        <span>{selection.length} selected</span>
        <IconButton icon="move" label="Move…" shortcut={`${mod}M`} onClick={() => { const i = x.item(selection[0]); if (i) void mv.open({ id: i.id, text: i.preview, drawerId: i.drawerId, topicKey: i.topicKey }); }}/>
        <IconButton icon="pin" label="Pin for every agent" onClick={() => { for (const id of selection) { const i = x.item(id); if (i) void d.pin(i.preview, i.drawerId); } }}/>
        <IconButton icon="trash" label="Move to Trash" shortcut="⌫" onClick={() => void trashIds(selection)}/>
        <IconButton icon="close" label="Clear the selection" shortcut="Esc" onClick={() => x.checkAllShown(false)}/>
      </div>}
      {(xs.notice || ss.notice) && listPlace && <p className="dk-inline-notice" role="alert">{xs.notice ?? ss.notice}</p>}
      <div className="dk-body">{content}</div>
    </div>
    {inspector && <aside className="dk-inspector" aria-label="Details">{inspector}</aside>}
    <ContextMenu menu={menu.menu} onClose={menu.close}/>
    {sheet?.kind === 'remember' && xs.adding && <RememberSheet k={k} onClose={() => { x.cancelAdd(); setSheet(null); }} onSaved={() => { setSheet(null); d.say(xs.adding?.drawer.kind === 'project' ? `Remembered in ${xs.adding.drawer.key}.` : 'Remembered.'); void sc.load(true); }}/>}
    {sheet?.kind === 'history' && <HistorySheet k={k} onClose={() => setSheet(null)}/>}
    {sheet?.kind === 'weekly' && <WeeklySheet k={k} onClose={() => setSheet(null)} onOpen={() => { setSheet(null); d.open('all'); x.setSince('7'); }} onSettings={() => { setSheet(null); onOpenSettings?.('rules'); }}/>}
    {sheet?.kind === 'group' && <GroupSheet k={k} projects={sheet.projects} onClose={() => setSheet(null)}/>}
    {sheet?.kind === 'rename-group' && <RenameGroupSheet k={k} id={sheet.id} onClose={() => setSheet(null)}/>}
    {sheet?.kind === 'project' && <ProjectActionSheet k={k} onClose={() => { sc.cancelAction(); setSheet(null); }} onDone={() => { setSheet(null); void sc.load(true); }}/>}
    {sheet?.kind === 'trash-project' && <Sheet title="Move the whole project to Trash?" onClose={() => setSheet(null)}
      actions={<><button type="button" onClick={() => setSheet(null)}>Cancel</button><button type="button" className="primary" onClick={() => { const slug = sheet.slug; setSheet(null); void d.trashProject(slug, ss.tree?.projects.find(p => p.slug === slug)?.name ?? slug).then(ok => { if (ok) void sc.load(true); }); }}>Move to Trash</button></>}>
      <p>All memories of <b>{ss.tree?.projects.find(p => p.slug === sheet.slug)?.name ?? sheet.slug}</b> go to Trash. No agent reads them there. Restore within the Trash time, or undo with {mod}Z.</p>
    </Sheet>}
    {sheet?.kind === 'forget' && <ForgetSheet k={k} ids={sheet.ids} onClose={() => setSheet(null)}/>}
    {ms?.memory && <MoveSheet k={k} several={selection.length > 1 ? [...selection] : null} onClose={() => mv.close()}/>}
    {sheet?.kind === 'edit-pinned' && <EditPinnedSheet k={k} fact={sheet.fact} onClose={() => setSheet(null)}/>}
    <Notice toast={ds.toast} onUndo={() => void d.undo().then(() => { void x.load(); void sc.load(true); })} onShow={ds.toast?.show ? () => d.open(ds.toast!.show!) : undefined} onDone={id => d.dismiss(id)}/>
  </section>;
}

// ---------------------------------------------------------------- sidebar
type K = NonNullable<ReturnType<typeof useControllers>>;

function MemorySidebar({ k, waiting, searchRef, onRemember, menu, projectMenu, onNewGroup, onRenameGroup }: {
  k: K; waiting: number; searchRef: React.RefObject<HTMLInputElement | null>; onRemember: () => void; menu: ReturnType<typeof useMenu>;
  projectMenu: (p: TreeProject) => MenuItem[]; onNewGroup: (projects: string[]) => void; onRenameGroup: (id: string) => void;
}) {
  const { d, x, sc } = k;
  const ds = useStore(d)!, xs = useStore(x)!, ss = useStore(sc)!;
  const [drop, setDrop] = useState<string | null>(null);
  const [query, setQuery] = useState(xs.query);
  const tree = ss.tree;
  const projects = (tree?.projects ?? []).filter(p => !p.archived && !p.mergedInto && !p.trashedAt).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
  const groups = Array.isArray(ds.groups) ? (ds.groups as readonly ProjectGroup[]) : [];
  const grouped = new Set(groups.flatMap(g => g.projects));
  const trashCount = ds.trash && ds.trash !== 'missing' ? ds.trash.items.length : null;
  const go = (p: Place) => { if (xs.query) { setQuery(''); x.setQuery(''); } d.open(p); };
  function search(q: string) {
    setQuery(q); x.setQuery(q);
    if (!placeScope(d.getSnapshot().place)) d.open('all');
  }
  function submit() {
    const q = query.trim();
    if (/^".*"$/.test(q)) { x.setQuery(q.slice(1, -1)); void x.load(); } else if (q.length >= 2) void x.searchMeaning(); else void x.load();
  }
  const row = (p: Place, icon: UiIconName, label: string, count?: number | null, badge?: boolean) =>
    <button key={p} type="button" className="nav-item dk-place" aria-current={ds.place === p && !ds.extra ? 'page' : undefined} onClick={() => go(p)}>
      <UiIcon name={icon} size={15}/><span className="dk-place-name">{label}</span>{count ? <span className={badge ? 'dk-badge-pill' : 'dk-count'}>{count}</span> : null}
    </button>;
  const dragStart = (e: DragEvent, slug: string) => { e.dataTransfer.setData('text/x-dpro-project', slug); e.dataTransfer.effectAllowed = 'move'; };
  const dragOver = (e: DragEvent, key: string) => { if ([...e.dataTransfer.types].includes('text/x-dpro-project')) { e.preventDefault(); setDrop(key); } };
  const dropOn = (e: DragEvent, target: { project?: string; group?: string | null }) => {
    const slug = e.dataTransfer.getData('text/x-dpro-project'); setDrop(null);
    if (!slug) return; e.preventDefault();
    if (target.project && target.project !== slug) {
      const g = d.groupOf(target.project);
      if (g) void d.moveToGroup(slug, g.id); else onNewGroup([target.project, slug]);
    } else if (target.group !== undefined) void d.moveToGroup(slug, target.group);
  };
  const projectRow = (p: TreeProject, nested: boolean) => <button key={p.slug} type="button" className="nav-item dk-place" data-nested={nested || undefined} data-drop={drop === `p:${p.slug}` || undefined}
    aria-current={ds.place === `project:${p.slug}` && !ds.extra ? 'page' : undefined} draggable onDragStart={e => dragStart(e, p.slug)} onDragOver={e => dragOver(e, `p:${p.slug}`)} onDragLeave={() => setDrop(null)} onDrop={e => dropOn(e, { project: p.slug })}
    onClick={() => go(`project:${p.slug}`)} onContextMenu={e => menu.at(e, projectMenu(p))} title={drop === `p:${p.slug}` ? `Drop on ${p.name}: make a group` : undefined}>
    <Tile name={p.name}/><span className="dk-place-name">{p.name}</span>{p.pinned && <UiIcon name="pin" size={11}/>}{p.pendingReviews ? <span className="dk-count">{p.pendingReviews}</span> : null}
  </button>;
  return <nav className="dk-sidebar" aria-label="Memory places">
    <div className="dk-side-top">
      <label className="dk-search"><UiIcon name="search" size={13}/><input ref={searchRef} type="search" placeholder="Search memory" aria-label="Search memory" value={query}
        onChange={e => search(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}/></label>
      <button type="button" className="primary dk-main" title={`Remember (${mod}N)`} onClick={onRemember}><UiIcon name="plus" size={12}/>Remember</button>
    </div>
    {row('needs', 'inbox', 'Needs you', waiting, true)}
    {row('all', 'layers', 'All memories')}
    {row('owner', 'avatar', 'About you', tree?.company.drawers.owner)}
    {row('experience', 'bulb', 'Lessons', tree?.company.drawers.experience)}
    {row('tasks', 'check', 'Tasks', tree?.company.drawers.task)}
    <p className="section-label dk-label" onDragOver={e => dragOver(e, 'out')} onDragLeave={() => setDrop(null)} onDrop={e => dropOn(e, { group: null })} data-drop={drop === 'out' || undefined}>
      <span>Projects</span><button type="button" className="dk-label-add" aria-label="New group" title="New group of projects" onClick={() => onNewGroup([])}><UiIcon name="plus" size={11}/></button>
    </p>
    {ss.phase === 'loading' && !tree && <p className="dk-side-note" role="status">Loading…</p>}
    {groups.map(g => {
      const closed = ds.collapsed.includes(g.id);
      const members = projects.filter(p => g.projects.includes(p.slug));
      return <div key={g.id} className="dk-group">
        <button type="button" className="nav-item dk-place" data-drop={drop === `g:${g.id}` || undefined} aria-current={ds.place === `group:${g.id}` && !ds.extra ? 'page' : undefined} aria-expanded={!closed}
          onDragOver={e => dragOver(e, `g:${g.id}`)} onDragLeave={() => setDrop(null)} onDrop={e => dropOn(e, { group: g.id })}
          onClick={() => go(`group:${g.id}`)} onContextMenu={e => menu.at(e, [
            { label: 'Rename…', icon: 'pencil', run: () => onRenameGroup(g.id) },
            { label: g.shareWithin ? 'Keep each project to itself' : 'Let its projects read each other', icon: 'link', run: () => void d.updateGroup(g.id, { shareWithin: !g.shareWithin }) },
            'sep', { label: 'Ungroup (projects stay)', icon: 'layers', run: () => void d.ungroup(g.id) },
          ])}>
          <span className="dk-chevron" role="presentation" data-open={!closed || undefined} onClick={e => { e.stopPropagation(); d.toggleCollapsed(g.id); }}><UiIcon name="chevron" size={11}/></span>
          <Tile name={g.name}/><span className="dk-place-name">{g.name}</span><span className="dk-muted">{g.label ?? `${members.length} ${members.length === 1 ? 'project' : 'projects'}`}</span>
        </button>
        {!closed && members.map(p => projectRow(p, true))}
      </div>;
    })}
    {projects.filter(p => !grouped.has(p.slug)).map(p => projectRow(p, false))}
    {tree && !projects.length && <p className="dk-side-note">Projects appear here when Dpro finds them or you remember something for one.</p>}
    {ds.groups === 'missing' && projects.length > 1 && <p className="dk-side-note">Groups of projects arrive with the next update.</p>}
    <p className="section-label dk-label"><span>Also</span></p>
    {row('people', 'users', 'People', tree?.company.drawers.people)}
    {row('agents', 'sparkle', 'Agents')}
    {row('archived', 'archive', 'Archived', tree?.company.archivedProjects)}
    {row('trash', 'trash', 'Trash', trashCount)}
  </nav>;
}

// ---------------------------------------------------------------- list
function MemoryList({ k, pinned, showPinned, onMenu, onPinnedMenu, empty }: { k: K; pinned: readonly PinnedFact[]; showPinned: boolean; onMenu: (e: React.MouseEvent, i: ExplorerItem) => void; onPinnedMenu: (e: React.MouseEvent, f: PinnedFact) => void; empty: ReactNode }) {
  const { x } = k;
  const s = useStore(x)!;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const groups = useMemo(() => {
    const by = new Map<string, ExplorerItem[]>();
    for (const i of s.items) { const key = i.topicKey ?? ''; by.set(key, [...(by.get(key) ?? []), i]); }
    const named = [...by.entries()].filter(([key]) => key).sort((a, b) => b[1].length - a[1].length);
    return [...named, ...(by.has('') ? [['', by.get('')!] as [string, ExplorerItem[]]] : [])];
  }, [s.items]);
  const flat = groups.flatMap(([, items]) => items);
  // The list loads more by itself near the end.
  useEffect(() => {
    const el = bodyRef.current; if (!el) return;
    const on = () => { if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) void x.more(); };
    el.addEventListener('scroll', on); return () => el.removeEventListener('scroll', on);
  }, [x]);
  useEffect(() => { if (s.open) bodyRef.current?.querySelector(`[data-id="${CSS.escape(s.open)}"]`)?.scrollIntoView?.({ block: 'nearest' }); }, [s.open]);
  if (s.phase === 'error') return <div className="dk-empty"><p>{s.notice}</p><button type="button" onClick={() => void x.load()}>Try again</button></div>;
  if (s.phase !== 'ready') return <p className="dk-empty" role="status">Loading memories…</p>;
  function click(e: React.MouseEvent, i: ExplorerItem) {
    if (e.metaKey || e.ctrlKey) { x.toggleCheck(i.id); setAnchor(i.id); return; }
    if (e.shiftKey && (anchor ?? s.open)) {
      const a = flat.findIndex(f => f.id === (anchor ?? s.open)); const b = flat.findIndex(f => f.id === i.id);
      for (const f of flat.slice(Math.min(a, b), Math.max(a, b) + 1)) if (!s.checked.includes(f.id)) x.toggleCheck(f.id);
      return;
    }
    if (s.checked.length) x.checkAllShown(false);
    setAnchor(i.id); void x.openMemory(i.id);
  }
  function keys(e: ReactKeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const at = flat.findIndex(f => f.id === s.open);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = flat[Math.max(0, Math.min(flat.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { void x.openMemory(next.id); setAnchor(next.id); }
    } else if (e.key === 'Enter' && s.open) { e.preventDefault(); x.startEdit(); }
  }
  const count = s.items.length + (showPinned ? pinned.length : 0);
  return <div className="dk-list" ref={bodyRef} tabIndex={0} role="listbox" aria-label="Memories" aria-multiselectable="true" onKeyDown={keys}>
    {s.result && <p className="dk-inline-ok" role="status">{s.result}</p>}
    {s.meaning && <p className="dk-inline-ok">Found by meaning. <button type="button" className="link-button" onClick={() => void x.load()}>Show word matches</button></p>}
    {showPinned && pinned.length > 0 && !s.query && <section className="dk-list-group"><h3>Pinned for every agent</h3>
      {pinned.map(f => <div key={f.id} className="dk-row" role="option" aria-selected={false} onContextMenu={e => onPinnedMenu(e, f)}>
        <span className="dk-row-icon"><UiIcon name="pin" size={14}/></span><span className="dk-row-text"><span className="dk-row-main" dir="auto"><WithSwatches text={oneLine(f.text)}/></span><span className="dk-row-sub">Pinned · {f.scope === 'company' ? 'company rule' : 'for this project'}</span></span>
      </div>)}
    </section>}
    {groups.map(([topic, items]) => <section key={topic || '_'} className="dk-list-group">{(topic || groups.length > 1) && <h3>{topic ? topic.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase()) : 'Other'}</h3>}
      {items.map(i => { const kind = kindOf(i); const checked = s.checked.includes(i.id); return <div key={i.id} data-id={i.id} className="dk-row" role="option" aria-selected={s.open === i.id || checked} data-checked={checked || undefined}
        onClick={e => click(e, i)} onDoubleClick={() => { void x.openMemory(i.id).then(() => x.startEdit()); }} onContextMenu={e => { if (!checked && s.open !== i.id) void x.openMemory(i.id); onMenu(e, i); }}>
        <span className="dk-row-icon" title={kind.word}><UiIcon name={kind.icon} size={14}/></span>
        <span className="dk-row-text"><span className="dk-row-main" dir="auto"><WithSwatches text={oneLine(i.preview)}/></span>
          <span className="dk-row-sub">{kind.word} · {ago(i.createdAt)}{!i.drawerId.startsWith('project:') || placeScope(k.d.getSnapshot().place) === 'company' ? ` · ${drawerName(i.drawerId)}` : ''}</span></span>
      </div>; })}
    </section>)}
    {count === 0 && <div className="dk-empty">{empty}</div>}
    {s.nextCursor && <p className="dk-more-row" role="status">{s.busy ? 'Loading more…' : <button type="button" className="link-button" onClick={() => void x.more()}>Load more</button>}</p>}
  </div>;
}

// ---------------------------------------------------------------- inspector
function MemoryInspector({ k, item, onHistory, onTrash }: { k: K; item: ExplorerItem; onHistory: () => void; onTrash: () => void }) {
  const { x, d, mv, sc } = k;
  const s = useStore(x)!; const ss = useStore(sc)!;
  const det = s.detail; const kind = kindOf(item);
  const by = item.sourceAgentId ? ss.agents[item.sourceAgentId] ?? 'An agent' : SOURCE_LABEL[item.source ?? ''] ?? kind.word;
  const before = { content: s.full ?? item.preview, importance: item.importance };
  return <div className="dk-insp">
    {s.editing ? <form className="dk-edit" onSubmit={e => { e.preventDefault(); void x.saveEdit().then(() => d.edited(item.id, before)); }}>
      <textarea aria-label="Memory text" dir="auto" rows={6} value={s.draft} maxLength={50000} autoFocus onChange={e => x.editDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void x.saveEdit().then(() => d.edited(item.id, before)); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); x.cancelEdit(); } }}/>
      <label className="dk-field-inline">Importance<input type="range" min={1} max={10} value={s.draftImportance} onChange={e => x.editImportance(Number(e.target.value))}/><span>{s.draftImportance}</span></label>
      <div className="actions"><button type="button" onClick={() => x.cancelEdit()}>Cancel</button><button type="submit" className="primary" disabled={s.busy || !s.draft.trim()}>Save</button></div>
      <p className="fine-print">Saved as a new version; History keeps the old one. {mod}↩ saves.</p>
    </form> : <p className="dk-insp-text" dir="auto"><WithSwatches text={s.full ?? item.preview}/></p>}
    {!s.editing && <div className="dk-insp-icons">
      <IconButton icon="pencil" label="Edit" shortcut="↩" onClick={() => x.startEdit()}/>
      <IconButton icon="pin" label="Pin for every agent" onClick={() => void d.pin(s.full ?? item.preview, item.drawerId)}/>
      <IconButton icon="move" label="Move…" shortcut={`${mod}M`} onClick={() => void mv.open({ id: item.id, text: item.preview, drawerId: item.drawerId, topicKey: item.topicKey })}/>
      <IconButton icon="trash" label="Move to Trash" shortcut="⌫" onClick={onTrash}/>
    </div>}
    <dl className="dk-facts">
      <dt>From</dt><dd><Avatar name={by}/>{by}, {new Date(`${item.createdAt}Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</dd>
      <dt>Where</dt><dd>{drawerName(item.drawerId)}</dd>
      <dt>Kind</dt><dd><UiIcon name={kind.icon} size={13}/>{TYPE_LABEL[item.type] ?? item.type} · importance {item.importance}</dd>
      <dt>Used</dt><dd>{det ? (det.usage.usedIn ? `in ${det.usage.usedIn} ${det.usage.usedIn === 1 ? 'reply' : 'replies'}${det.usage.lastUsedAt ? `, last ${ago(det.usage.lastUsedAt)}` : ''}` : 'not used in a reply yet') : '…'}</dd>
      <dt>Read by</dt><dd>{det ? (det.readers.all ? 'every agent' : `${det.readers.count} of ${det.readers.total} agents`) : '…'}</dd>
      {det && det.graph.entities.length > 0 && <><dt>On the map</dt><dd className="dk-chips">{det.graph.entities.slice(0, 6).map(e => <span key={e.id} className="dk-chip">{e.name}</span>)}</dd></>}
      {item.topicKey && <><dt>Topic</dt><dd>{item.topicKey.replace(/-/g, ' ')}</dd></>}
      <dt>History</dt><dd><button type="button" className="link-button" onClick={onHistory}>{s.versions ? `${s.versions.length} ${s.versions.length === 1 ? 'version' : 'versions'}` : 'versions'}</button></dd>
    </dl>
    <p className="fine-print">Right-click a memory for the same actions. Move to Trash and Move undo with {mod}Z.</p>
  </div>;
}

function ProjectInspector({ k, project, onSettings, onGroup }: { k: K; project: TreeProject; onSettings?: (t: SettingsTarget) => void; onGroup: () => void }) {
  const { d, sc, disc } = k;
  const ss = useStore(sc)!; const ds = useStore(d)!; const dv = useStore(disc);
  useEffect(() => { if (!dv?.view) void disc.load(); }, [disc]);
  const roots = (dv?.view?.roots ?? []).filter(r => (r.project ?? '').toLowerCase() === project.slug || r.name.toLowerCase() === project.name.toLowerCase());
  const folders = roots.flatMap(r => r.group ? r.group.members.map(m => ({ path: m.path, how: 'joined by you' })) : [{ path: r.path ?? r.name, how: r.path?.startsWith('/') ? 'this computer' : 'older computer · joined by name' }]);
  const suggestion = (dv?.view?.suggestions ?? []).find(s => roots.some(r => r.id === s.a.id || r.id === s.b.id));
  const group = d.groupOf(project.slug);
  const dept = ss.tree?.departments.find(x => x.id === project.departmentId);
  const [allReaders, setAllReaders] = useState(false);
  return <div className="dk-insp">
    <div className="dk-insp-head"><Tile name={project.name} size={28}/><div><h3>{project.name}</h3><p className="fine-print">{folders.length > 1 ? `One project made of ${folders.length} folders. Their memory is kept together.` : 'Its memory, design and databases.'}</p></div></div>
    {folders.length > 0 && <ul className="dk-folders">{folders.map(f => <li key={f.path}><UiIcon name="folder" size={13}/><span className="dk-path" title={f.path}>{f.path}</span><span className="fine-print">{f.how}</span></li>)}</ul>}
    <div className="actions"><button type="button" onClick={() => onSettings?.('projects')}>Add a folder…</button>{folders.length > 1 && <button type="button" onClick={() => onSettings?.('projects')}>Separate…</button>}</div>
    {suggestion && <div className="dk-ask"><p>Looks like the same project: <b>{suggestion.a.name}</b> and <b>{suggestion.b.name}</b></p>
      <div className="actions"><button type="button" className="primary" onClick={() => disc.startMerge([suggestion.a.id, suggestion.b.id], project.name)}>Join</button><button type="button" onClick={() => void disc.dismissSuggestion(suggestion)}>Not the same</button></div></div>}
    <dl className="dk-facts">
      <dt>Group</dt><dd>{group ? group.name : <button type="button" className="link-button" onClick={onGroup}>{ds.groups === 'missing' ? 'none' : 'Add to a group…'}</button>}</dd>
      <dt>Department</dt><dd>{dept?.name ?? '—'}</dd>
      <dt>Memories</dt><dd>{project.memories}</dd>
      <dt>Read by</dt><dd>{ss.usage === null ? '…' : ss.usage.length ? <span className="dk-avatars">{ss.usage.slice(0, 5).map(u => <Avatar key={u.agentId} name={u.name}/>)}{ss.usage.length > 5 && <span className="dk-more">+{ss.usage.length - 5}</span>}</span> : 'no agent yet'}</dd>
      <dt>Rules</dt><dd>{ss.rules.length ? 'its own' : `same as ${dept?.name ?? 'the company'}`} · <button type="button" className="link-button" onClick={() => onSettings?.('rules')}>change</button></dd>
    </dl>
    {ss.usage && ss.usage.length > 0 && <section className="dk-who"><h4>Who reads {project.name}</h4><ul>{(allReaders ? ss.usage : ss.usage.slice(0, 6)).map(u => <li key={u.agentId}><Avatar name={u.name}/><span>{u.name}</span><span className="fine-print">{u.write ? 'reads, saves' : 'reads'} · {u.why}</span></li>)}</ul>
      <div className="actions">{ss.usage.length > 6 && <button type="button" className="link-button" onClick={() => setAllReaders(v => !v)}>{allReaders ? 'Show fewer' : `See all ${ss.usage.length}`}</button>}<button type="button" onClick={() => onSettings?.('access')}>Add an agent…</button></div>
      <p className="fine-print">Add or take one out with an exception in Settings › Memory › Access; each change shows who reads it after.</p></section>}
  </div>;
}

// ---------------------------------------------------------------- other places
function AgentsPlace({ names, onOpen }: { names: Readonly<Record<string, string>>; onOpen: (id: string) => void }) {
  const list = Object.entries(names).sort((a, b) => a[1].localeCompare(b[1]));
  if (!list.length) return <div className="dk-empty"><p>No agents yet. Each agent's lessons and what it reads show here.</p></div>;
  return <div className="dk-list" role="listbox" aria-label="Agents">{list.map(([id, name]) => <div key={id} className="dk-row" role="option" aria-selected={false} onClick={() => onOpen(id)}>
    <span className="dk-row-icon"><Avatar name={name}/></span><span className="dk-row-text"><span className="dk-row-main">{name}</span><span className="dk-row-sub">What it knows: its lessons and what it reads</span></span></div>)}</div>;
}
function ArchivedPlace({ projects, onOpen, onBack }: { projects: TreeProject[]; onOpen: (slug: string) => void; onBack: (slug: string) => void }) {
  if (!projects.length) return <div className="dk-empty"><p>Archived projects are kept for good but not loaded into replies. Archive one from its ⋯ menu.</p></div>;
  return <div className="dk-list" role="listbox" aria-label="Archived projects">{projects.map(p => <div key={p.slug} className="dk-row" role="option" aria-selected={false} onClick={() => onOpen(p.slug)}>
    <span className="dk-row-icon"><Tile name={p.name}/></span><span className="dk-row-text"><span className="dk-row-main">{p.name}</span><span className="dk-row-sub">{p.memories} memories · archived {p.archivedAt ? ago(p.archivedAt) : ''}</span></span>
    <button type="button" onClick={e => { e.stopPropagation(); onBack(p.slug); }}>Bring back</button></div>)}</div>;
}

// ---------------------------------------------------------------- toolbar bits
function FilterPopover({ k, tree, agents }: { k: K; tree: import('./memory-pages-contract.js').ScopeTree | null; agents: Readonly<Record<string, string>> }) {
  const { x, d } = k; const s = useStore(x)!; const ds = useStore(d)!;
  const projects = (tree?.projects ?? []).filter(p => !p.archived && !p.mergedInto);
  const types = Object.keys(s.facets.type).length ? Object.keys(s.facets.type) : [...memoryTypes];
  return <div className="dk-filter">
    <h4>Filter</h4>
    <label>Where<select value={placeScope(ds.place) ?? 'company'} onChange={e => d.open((e.target.value === 'company' ? 'all' : e.target.value === 'kind:task' ? 'tasks' : e.target.value === 'kind:people' ? 'people' : e.target.value) as Place)}>
      <option value="company">All memories</option><option value="owner">About you</option><option value="experience">Lessons</option><option value="kind:task">Tasks</option><option value="kind:people">People</option>
      {projects.map(p => <option key={p.slug} value={`project:${p.slug}`}>{p.name}</option>)}</select></label>
    <label>Kind<select value={s.type} onChange={e => x.setType(e.target.value)}><option value="">any</option>{types.map(t => <option key={t} value={t}>{TYPE_LABEL[t] ?? t}{s.facets.type[t] ? ` (${s.facets.type[t]})` : ''}</option>)}</select></label>
    <label>Agent<select value={s.agent} onChange={e => x.setAgent(e.target.value)}><option value="">any</option>{Object.entries(agents).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></label>
    <label>Topic<select value={s.topic} onChange={e => x.setTopic(e.target.value as '' | 'has' | 'none')}><option value="">any</option><option value="has">has a topic</option><option value="none">no topic</option></select></label>
    <label>From<select value={s.source} onChange={e => x.setSource(e.target.value)}><option value="">any</option>{Object.entries(SOURCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
    <label>Importance<select value={s.importance} onChange={e => x.setImportance(e.target.value as typeof s.importance)}><option value="">any</option><option value="8-10">high (8–10)</option><option value="5-7">medium (5–7)</option><option value="1-4">low (1–4)</option></select></label>
    <label>Date<select value={s.since} onChange={e => x.setSince(e.target.value as typeof s.since)}><option value="">any time</option><option value="7">last 7 days</option><option value="30">last 30 days</option><option value="90">last 90 days</option></select></label>
    <p className="fine-print">Search finds by meaning; put words in "quotes" for exact words.</p>
    <div className="actions"><button type="button" onClick={() => x.clearFilters()}>Clear</button></div>
  </div>;
}

/** An import runs quietly in the toolbar: progress, Pause/Resume, Review them now (board M34 N5). */
function ImportStatus({ client, active, onReview }: { client: SessionClient; active: boolean; onReview: () => void }) {
  const [auto, setAuto] = useState<{ status: string; lastProposed: number } | null>(null);
  const [job, setJob] = useState<{ id: string; status: string; done: number; total: number; proposed: number } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!active) return;
    let stop = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await client.request({ method: 'GET', path: '/api/memory/import/local/automatic' } as never);
        const st = r.status === 200 ? (r.body as { settings: { status: string; lastProposed: number } }).settings : null;
        if (!stop) setAuto(st ? { status: st.status, lastProposed: st.lastProposed } : null);
      } catch { /* quiet: the toolbar shows nothing */ }
      if (!stop) timer = setTimeout(tick, 15000);
    };
    void tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [active, client]);
  // The running job (for its progress and Pause / Resume) is read when the popover opens.
  useEffect(() => {
    if (!open) return;
    void (async () => { try {
      const r = await client.request({ method: 'GET', path: '/api/memory/import/local' } as never);
      const j = r.status === 200 ? (r.body as { job?: { id: string; status: string; done: number; total: number; proposed: number } }).job : undefined;
      setJob(j && j.status !== 'done' ? j : null);
    } catch { setJob(null); } })();
  }, [open, client]);
  const running = auto && (auto.status === 'importing' || auto.status === 'scanning');
  if (!running && !job) return null;
  const act = async (verb: 'pause' | 'resume') => { if (!job) return; try { const r = await client.request({ method: 'POST', path: `/api/memory/import/local/jobs/${job.id}/${verb}` } as never); if (r.status === 200) setJob((r.body as { job: typeof job }).job); } catch { /* shown next time */ } };
  return <span className="dk-anchor" data-popover-anchor>
    <button type="button" className="dk-status" onClick={() => setOpen(v => !v)}><span className="dk-spinner" data-paused={job?.status === 'paused' || undefined}/>{job?.status === 'paused' ? 'Import paused' : auto?.status === 'scanning' ? 'Reading this computer' : 'Importing'}{job ? ` · ${job.done} of ${job.total}` : ''}</button>
    <Popover open={open} onClose={() => setOpen(false)} label="Import">
      <div className="dk-filter"><h4>Importing</h4><p>{job ? `${job.done} of ${job.total} read by the local model. ` : ''}{(job?.proposed ?? auto?.lastProposed) ? `${job?.proposed ?? auto?.lastProposed} facts wait for you; routine ones are saved.` : 'Routine facts are saved on their own.'}</p>
        <div className="actions">{job && (job.status === 'paused' ? <button type="button" onClick={() => void act('resume')}>Resume</button> : <button type="button" onClick={() => void act('pause')}>Pause</button>)}<button type="button" className="primary" onClick={() => { setOpen(false); onReview(); }}>Review them now</button></div></div>
    </Popover>
  </span>;
}

// ---------------------------------------------------------------- sheets
function RememberSheet({ k, onClose, onSaved }: { k: K; onClose: () => void; onSaved: () => void }) {
  const { x, sc } = k; const s = useStore(x)!; const ss = useStore(sc)!;
  const [more, setMore] = useState(false);
  const a = s.adding!;
  const where = a.drawer.kind === 'project' || a.drawer.kind === 'task' || a.drawer.kind === 'people' ? `${a.drawer.kind}:${a.drawer.key ?? ''}` : a.drawer.kind;
  const projects = (ss.tree?.projects ?? []).filter(p => !p.archived && !p.mergedInto);
  function setWhere(v: string) {
    const i = v.indexOf(':');
    x.editAdd({ drawer: i < 0 ? { kind: v as 'owner' } : { kind: v.slice(0, i) as 'project', key: v.slice(i + 1) } });
  }
  const save = async () => { const before = x.getSnapshot().result; await x.saveAdd(); const after = x.getSnapshot(); if (!after.adding && after.result !== before) onSaved(); };
  return <Sheet title="Remember" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={s.busy || !a.content.trim()} onClick={() => void save()}>Remember</button></>}>
    <label className="dk-field">What to remember<textarea autoFocus rows={3} dir="auto" value={a.content} maxLength={50000} onChange={e => x.editAdd({ content: e.target.value })}
      onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } }}/></label>
    <label className="dk-field">Where<select value={where.endsWith(':') ? `${a.drawer.kind}:` : where} onChange={e => setWhere(e.target.value)}>
      <option value="owner">About you</option><option value="experience">Lessons</option>
      {projects.map(p => <option key={p.slug} value={`project:${p.slug}`}>{p.name}</option>)}
      {where.startsWith('project:') && !projects.some(p => `project:${p.slug}` === where) && <option value={where}>{where.slice(8) || 'New project…'}</option>}
      <option value="project:">New project…</option><option value="task:">A task…</option><option value="people:">A person…</option></select></label>
    {(where === 'project:' || where.startsWith('task:') || where.startsWith('people:') || (where.startsWith('project:') && !projects.some(p => `project:${p.slug}` === where))) &&
      <label className="dk-field">Name<input value={a.drawer.key ?? ''} placeholder={a.drawer.kind === 'people' ? 'e.g. mona' : a.drawer.kind === 'task' ? 'e.g. logo' : 'e.g. new-shop'} maxLength={64} onChange={e => x.editAdd({ drawer: { kind: a.drawer.kind, key: e.target.value } })}/></label>}
    <button type="button" className="link-button dk-disclose" aria-expanded={more} onClick={() => setMore(v => !v)}><UiIcon name="chevron" size={11}/>More (kind, importance, topic)</button>
    {more && <div className="dk-more-fields">
      <label className="dk-field">Kind<select value={a.type} onChange={e => x.editAdd({ type: e.target.value as MemoryType })}>{memoryTypes.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></label>
      <label className="dk-field">Importance {a.importance}<input type="range" min={1} max={10} value={a.importance} onChange={e => x.editAdd({ importance: Number(e.target.value) })}/></label>
      <label className="dk-field">Topic<input value={a.topicKey} placeholder="e.g. posting schedule" maxLength={80} onChange={e => x.editAdd({ topicKey: e.target.value })}/></label>
      <p className="fine-print">Importance 8 or more is kept for good; lower ones may fade over time. A topic keeps one current answer with its history.</p>
    </div>}
    {s.notice && <p className="dk-inline-notice" role="alert">{s.notice}</p>}
  </Sheet>;
}

function MoveSheet({ k, several, onClose }: { k: K; several: string[] | null; onClose: () => void }) {
  const { mv, d, x } = k; const s = useStore(mv)!;
  const m = s.memory!;
  const toName = s.to ? s.targets.find(t => t.drawer === s.to)?.name ?? drawerName(s.to) : null;
  const move = async () => {
    const to = s.to; if (!to) return;
    if (several) {
      // Several at once: each keeps where it was, so Undo moves each one back.
      const from = several.map(id => ({ id, drawer: x.item(id)?.drawerId ?? '' })).filter(f => f.drawer && f.drawer !== to);
      x.askBulk('move'); x.setBulkTo(to); await x.runBulk(); mv.close();
      d.movedMany(from, to);
      return;
    }
    const from = m.drawerId; if (await mv.move()) d.moved(m.id, from, to, m.text);
  };
  return <Sheet title={several ? `Move ${several.length} memories` : 'Move to another place'} onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!s.to || s.busy} onClick={() => void move()}>Move</button></>}>
    <p className="dk-quote" dir="auto">{several ? `${several.length} memories, the first: ` : ''}<WithSwatches text={oneLine(m.text)}/></p>
    <label className="dk-field">To<input type="search" autoFocus placeholder="Search projects and places…" value={s.query} onChange={e => void mv.search(e.target.value)}/></label>
    <div className="dk-pick" role="listbox" aria-label="Places">
      {s.targets.length === 0 && <p className="fine-print">No place matches.</p>}
      {s.targets.map(t => <button key={t.drawer} type="button" role="option" aria-selected={s.to === t.drawer} onClick={() => void mv.pick(t.drawer)}>
        {t.drawer.startsWith('project:') ? <Tile name={t.name}/> : <UiIcon name={t.drawer === 'owner' ? 'avatar' : t.drawer === 'experience' ? 'bulb' : 'users'} size={14}/>}<span>{t.name}</span><span className="fine-print">{t.note}</span></button>)}
    </div>
    <label className="dk-field">Why (optional, kept in its history)<input placeholder="Saved in the wrong project" value={s.reason} maxLength={200} onChange={e => mv.setReason(e.target.value)}/></label>
    <p className="fine-print">{toName ? `Read by the agents of ${toName} (${s.readersAfter ?? '…'}) instead of ${s.readersNow ?? '…'} now.` : 'Pick where it belongs.'} Undo with {mod}Z.</p>
    {s.notice && <p className="dk-inline-notice" role="alert">{s.notice}</p>}
  </Sheet>;
}

function HistorySheet({ k, onClose }: { k: K; onClose: () => void }) {
  const { x, d } = k; const s = useStore(x)!;
  const [pick, setPick] = useState<number | null>(null);
  const versions = (s.versions ?? []).filter(v => v.change !== 'forget');
  const current = s.full ?? '';
  const chosen = versions.find(v => v.version === pick) ?? null;
  return <Sheet title="History" onClose={onClose} wide actions={<><button type="button" onClick={onClose}>Close</button>
    <button type="button" className="primary" disabled={!chosen || chosen.content === current || !s.open} onClick={() => { if (chosen && s.open) void d.bringBack(s.open, current, chosen.content).then(ok => { if (ok) { void x.openMemory(s.open!); void x.load(); onClose(); } }); }}>Bring back</button></>}>
    {s.versions === null ? <p role="status">Reading the history…</p> : !versions.length ? <p>No earlier versions.</p>
      : <ol className="dk-history" role="listbox" aria-label="Versions">{versions.map((v, i) => <li key={v.version}><button type="button" role="option" aria-selected={pick === v.version} onClick={() => setPick(v.version)}>
        <span dir="auto"><WithSwatches text={oneLine(v.content)}/></span><span className="fine-print">{i === 0 ? 'now' : ago(v.createdAt)} · {v.change === 'move' ? 'moved' : v.change === 'delete' ? 'moved to Trash' : v.change === 'create' ? 'first saved' : 'changed'}</span>
      </button></li>)}</ol>}
    <p className="fine-print">Select a version to see it; Bring back makes it current again (undo {mod}Z).</p>
  </Sheet>;
}

function WeeklySheet({ k, onClose, onOpen, onSettings }: { k: K; onClose: () => void; onOpen: () => void; onSettings: () => void }) {
  const { d } = k;
  const [w, setW] = useState<WeeklySummary | null | 'error'>(null);
  useEffect(() => { void d.weekly().then(x => setW(x ?? 'error')); }, [d]);
  const week = w && w !== 'error' ? w : null;
  const range = week ? `${new Date(week.periodStart).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}–${new Date(week.periodEnd).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '';
  return <Sheet title={`Weekly summary${range ? ` · ${range}` : ''}`} onClose={onClose} actions={<><button type="button" onClick={onClose}>Close</button><button type="button" className="primary" disabled={!week?.totals.created} onClick={onOpen}>Open the {week?.totals.created ?? ''} memories</button></>}>
    {w === null ? <p role="status">Reading the week…</p> : w === 'error' ? <p>The weekly summary could not be read.</p> : <>
      <p className="fine-print">Learned {w.totals.created} · updated {w.totals.updated} · moved to Trash {w.totals.deleted} · waiting {w.totals.pending}</p>
      <p dir="auto">{w.text || 'A quiet week: nothing new was learned.'}</p>
    </>}
    <p className="fine-print">Made every week at the time in <button type="button" className="link-button" onClick={onSettings}>Settings › Memory › Rules</button>.</p>
  </Sheet>;
}
function GroupSheet({ k, projects, onClose }: { k: K; projects: string[]; onClose: () => void }) {
  const { d, sc } = k; const ds = useStore(d)!; const ss = useStore(sc)!;
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>(projects);
  const groups = Array.isArray(ds.groups) ? (ds.groups as readonly ProjectGroup[]) : [];
  const all = (ss.tree?.projects ?? []).filter(p => !p.archived && !p.mergedInto);
  const names = chosen.map(s => all.find(p => p.slug === s)?.name ?? s);
  const make = async () => { if (await d.createGroup(name, chosen)) onClose(); };
  return <Sheet title="New group" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!name.trim() || ds.groups === 'missing'} onClick={() => void make()}>Make group</button></>}>
    <label className="dk-field">Name<input autoFocus value={name} maxLength={80} placeholder="e.g. a client or a team" onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && name.trim()) { e.preventDefault(); void make(); } }}/></label>
    <p className="fine-print">{names.length ? `${names.join(' and ')}. ` : ''}Call it after a client, a team or anything you like. Drag projects in and out later.</p>
    {projects.length === 1 && groups.length > 0 && <div className="dk-pick" role="listbox" aria-label="Or move to a group">{groups.map(g => <button key={g.id} type="button" role="option" aria-selected={false} onClick={() => { void d.moveToGroup(projects[0], g.id); onClose(); }}><Tile name={g.name}/><span>Move to {g.name}</span></button>)}</div>}
    <details><summary>More projects</summary><div className="dk-checks">{all.map(p => <label key={p.slug}><input type="checkbox" checked={chosen.includes(p.slug)} onChange={e => setChosen(c => e.target.checked ? [...c, p.slug] : c.filter(x => x !== p.slug))}/><Tile name={p.name}/>{p.name}</label>)}</div></details>
    {ds.groups === 'missing' && <p className="dk-inline-notice">Groups of projects arrive with the next backend update.</p>}
  </Sheet>;
}
function RenameGroupSheet({ k, id, onClose }: { k: K; id: string; onClose: () => void }) {
  const { d } = k; const ds = useStore(d)!;
  const g = Array.isArray(ds.groups) ? (ds.groups as readonly ProjectGroup[]).find(x => x.id === id) : undefined;
  const [name, setName] = useState(g?.name ?? '');
  const save = async () => { if (await d.updateGroup(id, { name: name.trim() })) onClose(); };
  return <Sheet title="Rename group" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!name.trim() || name.trim() === g?.name} onClick={() => void save()}>Rename</button></>}>
    <label className="dk-field">Name<input autoFocus value={name} maxLength={80} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }}/></label>
  </Sheet>;
}

function ProjectActionSheet({ k, onClose, onDone }: { k: K; onClose: () => void; onDone: () => void }) {
  const { sc } = k; const s = useStore(sc)!;
  const p = sc.project();
  const [target, setTarget] = useState('');
  const [dept, setDept] = useState('');
  if (!s.action || !p) return null;
  const a = s.action;
  const verb: Record<ProjectAction, string> = { pin: 'Pin project', unpin: 'Unpin project', archive: 'Archive', unarchive: 'Bring back', move: 'Move to another department', merge: 'Merge', forget: 'Forget for good' };
  const needsChoice = (a === 'merge' || a === 'move') && !s.preview;
  const apply = async () => { await sc.applyAction(); if (!sc.getSnapshot().action) onDone(); };
  return <Sheet title={`${verb[a]} · ${p.name}`} onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button>
    {needsChoice ? <button type="button" className="primary" disabled={s.previewBusy || (a === 'merge' ? !target : !dept)} onClick={() => void sc.previewAction(a, a === 'merge' ? { target } : { departmentId: dept })}>Next</button>
      : <button type="button" className="primary" disabled={s.previewBusy || !s.preview} onClick={() => void apply()}>{verb[a]}</button>}</>}>
    {a === 'merge' && <label className="dk-field">Into<select autoFocus value={target} onChange={e => setTarget(e.target.value)}><option value="">Choose a project…</option>
      {(s.tree?.projects ?? []).filter(x => x.slug !== p.slug && !x.archived && !x.mergedInto).map(x => <option key={x.slug} value={x.slug}>{x.name}</option>)}</select></label>}
    {a === 'move' && <label className="dk-field">To<select autoFocus value={dept} onChange={e => setDept(e.target.value)}><option value="">Choose a department…</option>
      {(s.tree?.departments ?? []).filter(x => x.id !== p.departmentId).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
    {s.previewBusy && <p role="status">Checking who reads it after…</p>}
    {s.preview && <><h4>Who reads it after</h4><ul className="dk-effects">{effectLines(s.preview).map((l, i) => <li key={i}>{l}</li>)}</ul>
      {s.preview.effects.sample && s.preview.effects.sample.length > 0 && <ul className="dk-who-after">{s.preview.effects.sample.slice(0, 8).map(x => <li key={x.agentId + x.project}><Avatar name={x.agentName}/>{x.agentName}<span className="fine-print">{x.before.read.length && !x.after.read.length ? 'stops reading' : !x.before.read.length && x.after.read.length ? 'starts reading' : 'as before'}</span></li>)}</ul>}
      <p className="fine-print">Nothing changes until you click {verb[a]}. If the project changes meanwhile, Dpro asks you to look again.</p></>}
    {s.previewNotice && <p className="dk-inline-notice" role="alert">{s.previewNotice}</p>}
  </Sheet>;
}

function ForgetSheet({ k, ids, onClose }: { k: K; ids?: string[]; onClose: () => void }) {
  const { d } = k; const ds = useStore(d)!;
  const items = ds.trash && ds.trash !== 'missing' ? ds.trash.items.filter(i => !ids || ids.includes(i.id)) : [];
  const n = items.reduce((a, i) => a + (i.kind === 'project' ? i.count || 1 : 1), 0);
  const projects = items.filter(i => i.kind === 'project');
  return <Sheet title={ids ? 'Forget for good?' : `Forget ${n} ${n === 1 ? 'memory' : 'memories'} for good?`} onClose={onClose}
    actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="danger-solid" disabled={ds.busy || !items.length} onClick={() => void d.forgetForGood(ids).then(ok => { if (ok) onClose(); })}>Forget for good</button></>}>
    <p>Their text and history are removed from Dpro and from every memory file. This cannot be undone.</p>
    {projects.map(p => <p key={p.id} className="fine-print">Also the {p.count} memories of the project {p.text || p.id.slice(8)}.</p>)}
  </Sheet>;
}

function EditPinnedSheet({ k, fact, onClose }: { k: K; fact: PinnedFact; onClose: () => void }) {
  const { d } = k;
  const [text, setText] = useState(fact.text);
  const save = async () => { if (await d.editPinned(fact, text.trim())) onClose(); };
  return <Sheet title="Edit pinned fact" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!text.trim() || text.trim() === fact.text} onClick={() => void save()}>Save</button></>}>
    <label className="dk-field">Every agent{fact.scope === 'company' ? '' : ` of ${drawerName(fact.scope)}`} reads this first<textarea autoFocus rows={3} dir="auto" maxLength={1000} value={text} onChange={e => setText(e.target.value)}/></label>
  </Sheet>;
}
