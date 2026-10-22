// Settings › Memory (boards M25–M27, M29, M31 J6, M32 K4): the advanced
// memory options moved out of the Memory window. Rules · Folders and drives ·
// Sources · Projects · Access · Health and backup · Schedule. Each pane reuses
// the controller the old Memory tabs used, so nothing is lost on the way.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SessionClient } from './session';
import { MemoryHealthController } from './memory-health';
import { HealthView } from './MemoryHealth';
import { MemoryAccessController } from './memory-access';
import { AccessView } from './MemoryAccess';
import { MemoryBridgeController } from './memory-bridge';
import { BridgeView } from './MemoryBridge';
import { MemoryScopesController } from './memory-scopes';
import { MemoryDesktopController } from './memory-desktop';
import { DiscoveryController } from './discovery-controller';
import { DiscoveryView, FolderTree } from './Discovery';
import { LocalImport } from './LocalImport';
import { FilesView } from './MemoryPlaces';
import { UiIcon } from './ui-icons';
import { Tile, useMenu, ContextMenu } from './desktop-ui';
import type { ProjectGroup } from './memory-desktop-contract.js';
import type { ScopeRules } from './memory-pages-contract.js';

export type MemorySettingsPane = 'rules' | 'folders' | 'sources' | 'projects' | 'access' | 'health' | 'schedule';
export const MEMORY_PANES: ReadonlyArray<{ key: MemorySettingsPane; label: string }> = [
  { key: 'rules', label: 'Rules' }, { key: 'folders', label: 'Folders and drives' }, { key: 'sources', label: 'Sources' }, { key: 'projects', label: 'Projects' },
  { key: 'access', label: 'Access' }, { key: 'health', label: 'Health and backup' }, { key: 'schedule', label: 'Schedule' },
];

function useOnce<T extends { dispose(): void }>(make: () => T, deps: unknown[]): T | undefined {
  const [x, setX] = useState<T>();
  useEffect(() => { const v = make(); setX(v); return () => v.dispose(); }, deps);
  return x;
}
const use = <S,>(c: { subscribe: (f: () => void) => () => void; getSnapshot: () => S } | undefined) =>
  useSyncExternalStore(c?.subscribe ?? (() => () => {}), c?.getSnapshot ?? (() => undefined as S | undefined), c?.getSnapshot ?? (() => undefined as S | undefined));

export function MemorySettings({ client, pane, onOpenMemory }: { client: SessionClient; pane: MemorySettingsPane; onOpenMemory?: () => void }) {
  const health = useOnce(() => new MemoryHealthController(client), [client]);
  const scopes = useOnce(() => new MemoryScopesController(client), [client]);
  const disc = useOnce(() => new DiscoveryController(client), [client]);
  const ss = use(scopes);
  useEffect(() => { if (scopes && !ss?.tree) void scopes.load(); }, [scopes]);
  useEffect(() => { if (disc && (pane === 'folders' || pane === 'projects' || pane === 'schedule' || pane === 'sources')) { if (disc.getSnapshot().phase === 'idle') void disc.load(); if (pane === 'folders' && !disc.getSnapshot().places.top) void disc.loadPlaces(); } }, [disc, pane]);
  const [files, setFiles] = useState(false);
  const title = MEMORY_PANES.find(p => p.key === pane)?.label ?? 'Memory';
  return <section className="mem-settings" aria-label={`Memory: ${title}`}>
    <h3>{title}</h3>
    {pane === 'rules' && health && <RulesPane client={client} health={health} scopes={scopes}/>}
    {pane === 'folders' && disc && <><p className="fine-print">Tick folders, drives or partitions (several at once). Everything inside is read, also new folders. Dpro only reads; your files never change. On Windows: C:, D:, E: and USB drives show here the same way.</p><FolderTree c={disc}/></>}
    {pane === 'sources' && <SourcesPane client={client} disc={disc}/>}
    {pane === 'projects' && scopes && disc && <ProjectsPane client={client} scopes={scopes} disc={disc}/>}
    {pane === 'access' && <AccessPane client={client} tree={ss?.tree ?? null}/>}
    {pane === 'health' && health && <>{files ? <><button type="button" className="link-button" onClick={() => setFiles(false)}>Back to Health and backup</button><FilesView client={client} agents={ss?.agents ?? {}} drawers={[{ id: 'owner', name: 'About you' }, { id: 'experience', name: 'Lessons' }, ...(ss?.tree?.projects ?? []).filter(p => !p.archived && !p.mergedInto && !p.trashedAt).map(p => ({ id: `project:${p.slug}`, name: p.name }))]}/></>
      : <HealthLoader c={health} part="health" onReview={onOpenMemory} onFiles={() => setFiles(true)}/>}</>}
    {pane === 'schedule' && disc && health && <SchedulePane client={client} disc={disc} health={health}/>}
  </section>;
}

function HealthLoader({ c, part, onReview, onFiles }: { c: MemoryHealthController; part: 'health' | 'rules'; onReview?: () => void; onFiles?: () => void }) {
  const s = use(c);
  useEffect(() => { if (s?.phase === 'idle') void c.load('company'); }, [c]);
  return <HealthView c={c} part={part} conflicts={null} onReview={onReview ?? (() => {})} onFiles={onFiles ?? (() => {})}/>;
}

// ---------------------------------------------------------------- Rules
const STANDING = [
  ['Reads the project’s memory and DESIGN.md before it starts', 'colours, logos, fonts, rules, decisions'],
  ['Keeps DESIGN.md in the project up to date', 'written only between Dpro’s markers, your text stays'],
  ['Keeps the project’s documents in Dpro’s order', 'README for people, DESIGN.md, decisions and handoff notes'],
  ['Saves what it learns in the right project on its own', 'routine facts saved; important or conflicting ones wait in Needs you'],
  ['Follows the design it found', 'never invents colours or logos when the project has them'],
  ['Leaves a handoff note when it stops', 'done, left, next'],
] as const;
function RulesPane({ client, health, scopes }: { client: SessionClient; health: MemoryHealthController; scopes?: MemoryScopesController }) {
  const s = use(health); const ss = use(scopes);
  const [scope, setScope] = useState('company');
  // How long Trash keeps things: the company's rules (MEM-TRASH-01).
  const [trashDays, setTrashDays] = useState<number | null>(null);
  useEffect(() => { void health.load(scope); }, [health, scope]);
  useEffect(() => { void (async () => { try { const r = await client.request({ method: 'GET', path: '/api/memory/scopes/rules?scope=company' } as never); if (r.status === 200) setTrashDays((r.body as ScopeRules).effective.trashDays); } catch { /* shown as 30 */ } })(); }, [client]);
  const [saved, setSaved] = useState<string | null>(null);
  async function setTrash(days: number) {
    const before = trashDays; setTrashDays(days);
    try {
      const r = await client.request({ method: 'PUT', path: '/api/memory/scopes/rules', body: { scope: 'company', trashDays: days } } as never);
      if (r.status === 200) setSaved('Saved.'); else { setTrashDays(before); setSaved('Not saved.'); }
    } catch { setTrashDays(before); setSaved('Not saved (no connection).'); }
  }
  const projects = (ss?.tree?.projects ?? []).filter(p => !p.archived && !p.mergedInto);
  return <div className="mem-settings-body">
    <label className="settings-row"><span>Rules for<span className="fine-print">Each project or department can use other rules; the rest use the company's.</span></span>
      <select value={scope} onChange={e => setScope(e.target.value)}><option value="company">The whole company</option>
        {(ss?.tree?.departments ?? []).map(d => <option key={d.id} value={`department:${d.id}`}>Department · {d.name}</option>)}
        {projects.map(p => <option key={p.slug} value={`project:${p.slug}`}>Project · {p.name}</option>)}</select></label>
    {s?.phase === 'ready' ? <HealthView c={health} part="rules" conflicts={null} onReview={() => {}} onFiles={() => {}}/> : <p className="fine-print" role="status">Reading the rules…</p>}
    <h4>Archive or Trash?</h4>
    <div className="mem-two"><div><b><UiIcon name="archive" size={13}/> Archived</b><p className="fine-print">Kept for good, not loaded into replies. For old projects you may need again. Bring back any time.</p></div>
      <div><b><UiIcon name="trash" size={13}/> Trash</b><p className="fine-print">Deleted. Agents no longer read it. Restore within the time below, then it is forgotten for good. Empty Trash forgets now.</p></div></div>
    <label className="settings-row"><span>Forget what is in Trash after<span className="fine-print">Empty Trash is the only action in Memory that asks first, because it cannot be undone.</span></span>
      <select value={trashDays ?? 30} disabled={trashDays === null} onChange={e => void setTrash(Number(e.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={0}>Never on its own</option></select></label>
    {saved && <p className="fine-print" role="status">{saved}</p>}
    <details className="preference-help"><summary>Default project behaviour</summary><h4>What every agent does in a project, without being told</h4>
    <p className="fine-print">This comes with Dpro’s skill for every agent and coding app. It is on for all projects; you never have to remind it.</p>
    <ul className="mem-standing">{STANDING.map(([a, b]) => <li key={a}><UiIcon name="check" size={13}/><span><b>{a}</b><span className="fine-print">{b}</span></span></li>)}</ul>
    <p className="fine-print">DESIGN.md is written into each project folder (only between Dpro's markers). Switch it off per project in Memory › the project › Design.</p></details>
  </div>;
}

// ---------------------------------------------------------------- Sources
function SourcesPane({ client, disc }: { client: SessionClient; disc?: DiscoveryController }) {
  const [tab, setTab] = useState<'computer' | 'conversations' | 'apps'>('computer');
  const bridge = useOnce(() => new MemoryBridgeController(client), [client]);
  useEffect(() => { if (tab === 'apps' && bridge) void bridge.load(); }, [tab, bridge]);
  return <div className="mem-settings-body">
    <p className="fine-print">Where memory comes from. New things wait in Needs you; nothing is imported without you (unless the schedule says so).</p>
    <div className="dk-segmented" role="group" aria-label="Sources">{([['computer', 'On this computer'], ['conversations', 'Conversations'], ['apps', 'Coding apps']] as const).map(([v, l]) => <button key={v} type="button" aria-pressed={tab === v} onClick={() => setTab(v)}>{l}</button>)}</div>
    {tab === 'computer' && disc && <><DiscoveryView c={disc} active kinds={['memory', 'note', 'tool', 'design', 'database']} noFolders/>
      <p className="fine-print">Skills, MCP servers and SSH hosts found by the same scan go to their own sections (Skills, MCP connections, Terminal), not here. Folders: Settings › Memory › Folders and drives.</p></>}
    {tab === 'conversations' && <LocalImport client={client} active onReview={() => {}}/>}
    {tab === 'apps' && bridge && <><p className="fine-print">When you allow memory from this computer, Dpro connects the coding apps it finds. They read the memory of the project they work in and can only suggest new memories. Per project: right-click a project in Settings › Projects.</p><BridgeView c={bridge}/></>}
  </div>;
}

// ---------------------------------------------------------------- Projects
function ProjectsPane({ client, scopes, disc }: { client: SessionClient; scopes: MemoryScopesController; disc: DiscoveryController }) {
  const ss = use(scopes); const ds = use(disc);
  const desk = useOnce(() => new MemoryDesktopController(client), [client]);
  const dk = use(desk);
  const menu = useMenu();
  useEffect(() => { if (desk) void desk.loadGroups(); }, [desk]);
  const projects = (ss?.tree?.projects ?? []).filter(p => !p.archived && !p.mergedInto);
  const groups: readonly ProjectGroup[] = Array.isArray(dk?.groups) ? dk!.groups as readonly ProjectGroup[] : [];
  const roots = ds?.view?.roots ?? [];
  const foldersOf = (slug: string, name: string) => roots.filter(r => (r.project ?? '').toLowerCase() === slug || r.name.toLowerCase() === name.toLowerCase());
  const row = (p: typeof projects[number]) => {
    const rs = foldersOf(p.slug, p.name);
    return <li key={p.slug} className="mem-project" onContextMenu={e => menu.at(e, [
      ...groups.filter(g => !g.projects.includes(p.slug)).map(g => ({ label: `Move to ${g.name}`, icon: 'group' as const, run: () => void desk?.moveToGroup(p.slug, g.id) })),
      ...(rs.some(r => r.group) ? [{ label: 'Separate…', icon: 'diff' as const, run: () => { const r = rs.find(x => x.group); if (r) void disc.separate(r.id); } }] : []),
      ...(rs.length ? [{ label: 'Merge with another folder…', icon: 'folder' as const, run: () => disc.startMerge([rs[0].id], p.name) }] : []),
    ])}>
      <Tile name={p.name}/><span className="mem-project-name"><b>{p.name}</b><span className="fine-print">{p.memories} memories</span></span>
      <span className="mem-project-folders">{rs.length ? rs.flatMap(r => r.group ? r.group.members.map(m => <span key={m.id} className="fine-print dk-path" title={m.path}>{m.path} · joined by you</span>) : [<span key={r.id} className="fine-print dk-path" title={r.path ?? ''}>{r.path ?? r.name} · {r.path ? 'this computer' : 'older computer · no folder here'}</span>]) : <span className="fine-print">no folder found yet</span>}</span>
    </li>;
  };
  const grouped = new Set(groups.flatMap(g => g.projects));
  const sugg = ds?.view?.suggestions ?? [];
  return <div className="mem-settings-body">
    <p className="fine-print">Groups of projects (a client, a team) and which folders make one project. Dpro joins folders by git or the same name, or you join them; it asks when not sure. Drag projects between groups in the Memory sidebar.</p>
    {sugg.map(s => <div key={s.key} className="dk-ask"><p>Same project? <b>{s.a.name}</b> and <b>{s.b.name}</b>{s.reason ? <span className="fine-print"> · {s.reason}</span> : null}</p>
      <div className="actions"><button type="button" className="primary" onClick={() => disc.startMerge([s.a.id, s.b.id], s.a.name)}>Join</button><button type="button" onClick={() => void disc.dismissSuggestion(s)}>Not the same</button></div></div>)}
    {ds?.merge && <div className="dk-ask"><label className="dk-field">One project named<input value={ds.merge.name} onChange={e => disc.setMerge({ name: e.target.value })}/></label>
      <label className="dk-field">With folder<select value="" onChange={e => { if (e.target.value) disc.setMerge({ ids: [...ds.merge!.ids, e.target.value] }); }}><option value="">Add a folder…</option>{roots.filter(r => r.id !== 'computer' && !ds.merge!.ids.includes(r.id)).map(r => <option key={r.id} value={r.id}>{r.name}{r.path ? ` · ${r.path}` : ''}</option>)}</select></label>
      <p className="fine-print">{ds.merge.ids.length} folders. The folders stay where they are; their memory is kept together.</p>
      <div className="actions"><button type="button" onClick={() => disc.cancelMerge()}>Cancel</button><button type="button" className="primary" disabled={ds.merge.ids.length < 2 || !ds.merge.name.trim()} onClick={() => void disc.merge()}>Join</button></div></div>}
    {ds?.result && <p className="fine-print" role="status">{ds.result}</p>}
    {groups.map(g => <section key={g.id} className="mem-group"><h4><Tile name={g.name}/>{g.name}{g.label ? <span className="fine-print"> · {g.label}</span> : null}</h4><ul className="mem-projects">{projects.filter(p => g.projects.includes(p.slug)).map(row)}</ul></section>)}
    <section className="mem-group">{groups.length > 0 && <h4>Not in a group</h4>}<ul className="mem-projects">{projects.filter(p => !grouped.has(p.slug)).map(row)}</ul></section>
    {dk?.groups === 'missing' && <p className="fine-print">Groups of projects arrive with the next backend update.</p>}
    <p className="fine-print">Right-click a project: Move to group · Merge with another folder · Separate.</p>
    <ContextMenu menu={menu.menu} onClose={menu.close}/>
  </div>;
}

// ---------------------------------------------------------------- Access
function AccessPane({ client, tree }: { client: SessionClient; tree: import('./memory-pages-contract.js').ScopeTree | null }) {
  const access = useOnce(() => new MemoryAccessController(client), [client]);
  const [scope, setScope] = useState('company');
  useEffect(() => { if (access) void access.load(scope); }, [access, scope]);
  return <div className="mem-settings-body">
    <p className="fine-print">Which agents may read and change memory. Agents inherit their department's rules; exceptions are listed here. Changes show a preview before they apply. Always true: outside senders never read private memory; an agent never gets more than the agent that gave it the task.</p>
    <label className="settings-row"><span>For</span><select value={scope} onChange={e => setScope(e.target.value)}><option value="company">The whole company</option>
      {(tree?.departments ?? []).map(d => <option key={d.id} value={`department:${d.id}`}>Department · {d.name}</option>)}
      {(tree?.projects ?? []).filter(p => !p.archived).map(p => <option key={p.slug} value={`project:${p.slug}`}>Project · {p.name}</option>)}</select></label>
    {access && <AccessView c={access} scope={scope} tree={tree}/>}
  </div>;
}

// ---------------------------------------------------------------- Schedule
function SchedulePane({ client, disc, health }: { client: SessionClient; disc: DiscoveryController; health: MemoryHealthController }) {
  const ds = use(disc); const hs = use(health);
  const [auto, setAuto] = useState<{ enabled: boolean; intervalMinutes: 15 | 30 | 60 } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (hs?.phase === 'idle') void health.load('company'); }, [health]);
  useEffect(() => { void (async () => { try { const r = await client.request({ method: 'GET', path: '/api/memory/import/local/automatic' } as never); if (r.status === 200) { const s = (r.body as { settings: { enabled: boolean; intervalMinutes: 15 | 30 | 60 } }).settings; setAuto({ enabled: s.enabled, intervalMinutes: s.intervalMinutes }); } } catch { /* shown as unknown */ } })(); }, [client]);
  async function saveAuto(next: { enabled: boolean; intervalMinutes: 15 | 30 | 60 }) {
    setAuto(next);
    try { const r = await client.request({ method: 'PUT', path: '/api/memory/import/local/automatic', body: next } as never); setNote(r.status === 200 ? 'Saved.' : 'Not saved.'); } catch { setNote('Not saved (no connection).'); }
  }
  const v = ds?.view; const id = hs?.importDraft;
  return <div className="mem-settings-body">
    <p className="fine-print">One place for everything Dpro does on its own. (Was set in three places before: Health, Project files, Found on this computer.)</p>
    <label className="settings-row"><span>Read this computer again<span className="fine-print">finds new and changed files; imports nothing on its own</span></span>
      <select value={v ? (v.settings.watch ? v.settings.intervalMinutes : 0) : 0} disabled={!v} onChange={e => { const n = Number(e.target.value); void disc.setWatch(n > 0, (n || v!.settings.intervalMinutes) as 15 | 30 | 60); }}>
        <option value={0}>Only when I scan</option><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option><option value={60}>Every 60 minutes</option></select></label>
    <label className="settings-row"><span>Import new project notes<span className="fine-print">the local model reads them; important facts still ask you</span></span>
      <select value={auto ? (auto.enabled ? auto.intervalMinutes : 0) : 0} disabled={!auto} onChange={e => { const n = Number(e.target.value); void saveAuto({ enabled: n > 0, intervalMinutes: (n || auto!.intervalMinutes) as 15 | 30 | 60 }); }}>
        <option value={0}>Ask me</option><option value={15}>Save on their own, every 15 minutes</option><option value={30}>Save on their own, every 30 minutes</option><option value={60}>Save on their own, every 60 minutes</option></select></label>
    <label className="settings-row"><span>Import from other agents' conversations</span>
      <select value={id ? (id.enabled ? id.intervalMinutes : 0) : 0} disabled={!id} onChange={e => { const n = Number(e.target.value); health.editImport(n ? { enabled: true, intervalMinutes: n as 15 | 30 | 60 } : { enabled: false }); void health.saveRules().then(() => setNote('Saved.')); }}>
        <option value={0}>Off</option><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option><option value={60}>Every 60 minutes</option></select></label>
    <p className="fine-print">The weekly summary time is in Rules.</p>
    {(note || ds?.result) && <p className="fine-print" role="status">{note ?? ds?.result}</p>}
  </div>;
}
