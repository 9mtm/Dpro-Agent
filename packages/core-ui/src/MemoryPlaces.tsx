// Places of the Memory window that are not a list of memories: Trash (M32),
// a group of projects (M21 A3), a project's Design (M31) and Databases (M33).
// Each shows a quiet list and the selected thing beside it.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { SessionClient } from './session';
import { Markdown } from './markdown';
import { readableDrawer } from './SessionPanels';
import { UiIcon } from './ui-icons';
import type { UiIconName } from './ui-icons';
import { MemoryDesktopController } from './memory-desktop';
import { MemoryScopesController } from './memory-scopes';
import { ago, drawerName, oneLine } from './memory-store';
import { Avatar, IconButton, Swatch, Tile, WithSwatches } from './desktop-ui';
import type { ProjectGroup, TrashItem } from './memory-desktop-contract.js';

const NOT_YET = (what: string) => <div className="dk-empty"><UiIcon name="clock" size={20}/><p>{what} arrives with the next backend update. Everything else in Memory works now.</p></div>;
const daysLeft = (iso: string | null) => (iso ? Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000)) : null);
const kb = (n: number) => (n >= 1_048_576 ? `${Math.round(n / 1_048_576)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

// ---------------------------------------------------------------- Trash
export function TrashView({ d, onAsk, me }: { d: MemoryDesktopController; onAsk: (ids?: string[]) => void; me?: string }) {
  const by = (x: string) => (!x || x === me ? 'you' : x);
  const s = useSyncExternalStore(d.subscribe, d.getSnapshot, d.getSnapshot);
  useEffect(() => { if (s.trash === null) void d.loadTrash(); }, [d]);
  if (s.trash === 'missing') return NOT_YET('Trash');
  if (s.trash === null) return <p className="dk-empty" role="status">Reading Trash…</p>;
  const items = s.trash.items;
  if (!items.length) return <div className="dk-empty"><UiIcon name="trash" size={20}/><p>Trash is empty. Memories you delete wait here {s.trash.trashDays ? `${s.trash.trashDays} days` : 'until you empty it'}; no agent reads them.</p></div>;
  const now = Date.now();
  const bucket = (i: TrashItem) => { const age = now - Date.parse(i.deletedAt); return age < 86_400_000 ? 'Today' : age < 7 * 86_400_000 ? 'This week' : 'Earlier'; };
  const open = items.find(i => i.id === s.trashOpen) ?? null;
  return <div className="dk-split">
    <div className="dk-list" role="listbox" aria-label="Trash" tabIndex={0} onKeyDown={e => {
      const at = items.findIndex(i => i.id === s.trashOpen);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]; if (n) d.openTrashItem(n.id); }
    }}>
      <div className="dk-list-bar"><span className="fine-print">While something is in Trash no agent reads it.</span><span className="dk-toolbar-gap"/><button type="button" onClick={() => onAsk()}>Empty Trash…</button></div>
      {(['Today', 'This week', 'Earlier'] as const).map(b => { const list = items.filter(i => bucket(i) === b); return list.length ? <section key={b} className="dk-list-group"><h3>{b}</h3>
        {list.map(i => { const left = daysLeft(i.forgetAt); return <div key={i.id} className="dk-row" role="option" aria-selected={s.trashOpen === i.id} onClick={() => d.openTrashItem(i.id)}>
          <span className="dk-row-icon"><UiIcon name={i.kind === 'project' ? 'folder' : 'trash'} size={14}/></span>
          <span className="dk-row-text"><span className="dk-row-main" dir="auto">{i.kind === 'project' ? `Whole project: ${i.text || i.id.slice(8)} (${i.count} memories)` : <WithSwatches text={oneLine(i.text)}/>}</span>
            <span className="dk-row-sub">{i.kind === 'project' ? 'project' : drawerName(i.drawer)} · by {by(i.deletedBy)}{left !== null ? ` · ${left} ${left === 1 ? 'day' : 'days'} left` : ''}</span></span>
        </div>; })}
      </section> : null; })}
    </div>
    <aside className="dk-split-detail" aria-label="Selected in Trash">
      {!open ? <p className="dk-empty">Select something to restore it.</p> : <div className="dk-insp">
        <p className="dk-insp-text" dir="auto"><WithSwatches text={open.kind === 'project' ? `Whole project: ${open.text || open.id.slice(8)}` : open.text}/></p>
        <dl className="dk-facts">
          <dt>Was in</dt><dd>{open.kind === 'project' ? <><Tile name={open.id.slice(8)}/>{open.id.slice(8)}</> : drawerName(open.drawer)}</dd>
          <dt>Moved by</dt><dd><Avatar name={by(open.deletedBy)}/>{by(open.deletedBy)}, {ago(open.deletedAt)}</dd>
          <dt>Forgotten</dt><dd>{open.forgetAt ? `in ${daysLeft(open.forgetAt)} days` : 'only when you empty Trash'}</dd>
          {open.kind === 'project' && <><dt>Memories</dt><dd>{open.count}</dd></>}
        </dl>
        <div className="actions"><button type="button" onClick={() => onAsk([open.id])}>Forget now…</button><button type="button" className="primary" disabled={s.busy} onClick={() => void d.restore(open)}>Restore</button></div>
        <p className="fine-print">Restore puts it back where it was, with its history.</p>
      </div>}
    </aside>
  </div>;
}

// ---------------------------------------------------------------- a group of projects
export function GroupView({ d, sc, groupId }: { d: MemoryDesktopController; sc: MemoryScopesController; groupId: string }) {
  const s = useSyncExternalStore(d.subscribe, d.getSnapshot, d.getSnapshot);
  const ss = useSyncExternalStore(sc.subscribe, sc.getSnapshot, sc.getSnapshot);
  const g = Array.isArray(s.groups) ? (s.groups as readonly ProjectGroup[]).find(x => x.id === groupId) : null;
  if (!g) return <p className="dk-empty">This group is gone.</p>;
  const name = (slug: string) => ss.tree?.projects.find(p => p.slug === slug)?.name ?? slug;
  return <div className="dk-split">
    <div className="dk-list" aria-label={`Projects of ${g.name}`}>
      {!g.projects.length && <div className="dk-empty"><p>Drag a project from the sidebar onto this group to add it.</p></div>}
      {g.projects.map(slug => <section key={slug} className="dk-list-group"><h3><button type="button" className="link-button dk-h-link" onClick={() => d.open(`project:${slug}`)}><Tile name={name(slug)}/>{name(slug)}</button></h3>
        {(s.groupItems[slug] ?? []).length === 0 ? <p className="dk-row-sub dk-pad">{s.groupItems[slug] ? 'Nothing remembered yet.' : '…'}</p>
          : (s.groupItems[slug] ?? []).map(i => <div key={i.id} className="dk-row" onClick={() => d.open(`project:${slug}`)}><span className="dk-row-icon"><UiIcon name="sparkle" size={14}/></span>
            <span className="dk-row-text"><span className="dk-row-main" dir="auto"><WithSwatches text={oneLine(i.preview)}/></span><span className="dk-row-sub">{ago(i.createdAt)}</span></span></div>)}
      </section>)}
    </div>
    <aside className="dk-split-detail" aria-label="Group details"><div className="dk-insp">
      <div className="dk-insp-head"><Tile name={g.name} size={28}/><div><h3>{g.name}</h3><p className="fine-print">{g.label ? `A group of projects for one ${g.label}.` : 'A group of projects.'} Drag a project here to add it, drag it out to take it out.</p></div></div>
      <ul className="dk-folders">{g.projects.map(slug => <li key={slug}><Tile name={name(slug)}/><span>{name(slug)}</span><span className="fine-print">{ss.tree?.projects.find(p => p.slug === slug)?.memories ?? 0} memories</span></li>)}</ul>
      <label className="dk-switch"><input type="checkbox" role="switch" checked={g.shareWithin} onChange={e => void d.updateGroup(g.id, { shareWithin: e.target.checked })}/>
        <span><b>Agents of one project may read the other projects in this group</b><span className="fine-print">{g.shareWithin ? 'On: every read is written to the audit log.' : 'Off: each project keeps its memory to itself.'}</span></span></label>
      <p className="fine-print">Right-click any project: Move to group · New group with this project. Undo with ⌘Z.</p>
    </div></aside>
  </div>;
}

// ---------------------------------------------------------------- Design
export function DesignView({ d, slug }: { d: MemoryDesktopController; slug: string }) {
  const s = useSyncExternalStore(d.subscribe, d.getSnapshot, d.getSnapshot);
  useEffect(() => { if (s.design === null) void d.loadDesign(slug); }, [slug]);
  if (s.design === 'missing') return NOT_YET('Design and brand found on their own');
  if (s.design === null) return <p className="dk-empty" role="status">Looking at the design…</p>;
  const x = s.design;
  const writeSwitch = <label className="dk-switch dk-pad"><input type="checkbox" role="switch" checked={x.writeFile} onChange={e => void d.setWriteFile(slug, e.target.checked)}/>
    <span><b>Keep DESIGN.md in the project folder</b><span className="fine-print">{x.writeFile ? (x.file.problem ? `Not written: ${x.file.problem}` : x.file.writtenAt ? `Written ${ago(x.file.writtenAt)}, only between Dpro's markers; your text stays.` : 'Written between Dpro\'s markers; your text stays.') : 'Off: kept only inside Dpro.'}</span></span></label>;
  if (!x.colours.length && !x.logos.length && !x.fonts.length && !x.rules.length) return <div className="dk-list"><div className="dk-empty"><UiIcon name="palette" size={20}/><p>No design found in this project yet. Dpro looks for design tokens, Tailwind and CSS colours, brand kits and logo files, and adds them here on its own.</p></div>{writeSwitch}</div>;
  const logo = x.logos.find(l => l.id === s.logoOpen) ?? null;
  return <div className="dk-split">
    <div className="dk-list dk-design">
      {x.conflicts.map((c, i) => <div key={i} className="dk-ask dk-pad-x"><p>{c.question || 'Two main colours were found. Which one is the main colour?'}</p>
        <div className="actions">{c.options.map(o => <button key={o.value} type="button" onClick={() => void d.setMainColour(slug, o.value)}><span className="dk-swatch" style={{ background: o.value }} aria-hidden="true"/>Use {o.value}<span className="fine-print">{o.source}</span></button>)}</div></div>)}
      {x.colours.length > 0 && <section className="dk-list-group"><h3>Colours</h3><div className="dk-swatches">{x.colours.map(c => <button type="button" key={c.value + c.name} className="dk-colour" title={`Found in ${c.source}. Click to make it the main colour.`} onClick={() => { if (!c.main) void d.setMainColour(slug, c.value); }}>
        <span className="dk-swatch dk-swatch-big" style={{ background: c.value }} aria-hidden="true"/><span>{c.name || c.value}{c.main ? ' (main)' : ''}</span><span className="fine-print">{c.value}</span></button>)}</div></section>}
      {x.logos.length > 0 && <section className="dk-list-group"><h3>Logos</h3><div className="dk-logos" role="listbox" aria-label="Logos">{x.logos.map(l => <button key={l.id} type="button" role="option" aria-selected={s.logoOpen === l.id} className="dk-logo" onClick={() => d.openLogo(l.id)}>
        <span className="dk-logo-art"><UiIcon name="image" size={22}/></span><span>{l.path.split('/').pop()}{l.main ? ' · main' : ''}</span></button>)}</div>{x.hiddenLogos > 0 && <p className="fine-print dk-pad">{x.hiddenLogos} marked "not a logo".</p>}</section>}
      {x.fonts.length > 0 && <section className="dk-list-group"><h3>Type</h3>{x.fonts.map(f => <div key={f.name + f.source} className="dk-row"><span className="dk-row-icon"><UiIcon name="type" size={14}/></span><span className="dk-row-text"><span className="dk-row-main" style={{ fontFamily: f.name }}>{f.name}</span><span className="dk-row-sub">{f.source}</span></span></div>)}</section>}
      {x.rules.length > 0 && <section className="dk-list-group"><h3>Rules</h3>{x.rules.map((r, i) => <div key={i} className="dk-row"><span className="dk-row-icon"><UiIcon name="shield" size={14}/></span><span className="dk-row-text"><span className="dk-row-main" dir="auto"><WithSwatches text={r.text}/></span><span className="dk-row-sub">{r.source}</span></span></div>)}</section>}
      <p className="fine-print dk-pad">Found in: {x.sources.map(src => src.path).join(', ') || 'the project files'}. Agents read this before any design work.{x.canUndo ? ' ' : ''}{x.canUndo && <button type="button" className="link-button" onClick={() => void d.undoDesign(slug)}>Undo the last automatic change</button>}</p>
      {writeSwitch}
    </div>
    <aside className="dk-split-detail" aria-label="Selected logo">{!logo ? <p className="dk-empty">Select a logo to see it.</p> : <div className="dk-insp">
      <div className="dk-logo-preview"><UiIcon name="image" size={40}/></div>
      <dl className="dk-facts"><dt>File</dt><dd className="dk-path" title={logo.path}>{logo.path}</dd><dt>Size</dt><dd>{logo.kind.toUpperCase()}{logo.bytes ? ` · ${kb(logo.bytes)}` : ''}</dd>{x.colours[0] && <><dt>Colours</dt><dd>{x.colours.filter(c => c.main).concat(x.colours.filter(c => !c.main)).slice(0, 2).map(c => <Swatch key={c.value} value={c.value}/>)}</dd></>}</dl>
      <div className="dk-insp-icons">
        <IconButton icon="check" label={logo.main ? 'The main logo (click: let Dpro pick)' : 'Set as the main logo'} pressed={logo.main} onClick={() => void d.setMainLogo(slug, logo.main ? null : logo.id)}/>
        <IconButton icon="close" label="Not a logo" onClick={() => void d.notLogo(slug, logo.id)}/>
      </div>
      <p className="fine-print">Dpro keeps a link and a small preview. Your file is never moved or changed.</p>
    </div>}</aside>
  </div>;
}

// ---------------------------------------------------------------- Databases
const DB_ICON: Record<string, UiIconName> = { sqlite: 'database', env: 'key', compose: 'server' };
const LEVEL: Record<string, string> = { exists: 'Know it exists', tables: 'See its tables', data: 'Read its data (asks each time)' };
export function DatabasesView({ d, slug, agents }: { d: MemoryDesktopController; slug: string; agents: Readonly<Record<string, string>> }) {
  const s = useSyncExternalStore(d.subscribe, d.getSnapshot, d.getSnapshot);
  useEffect(() => { if (s.databases === null) void d.loadDatabases(slug); }, [slug]);
  if (s.databases === 'missing') return NOT_YET('Databases found in a project');
  if (s.databases === null) return <p className="dk-empty" role="status">Looking for databases…</p>;
  const x = s.databases;
  const open = x.databases.find(db => db.id === s.databaseOpen) ?? null;
  const where = (db: typeof x.databases[number]) => [db.engine || db.kind, db.kind === 'env' ? 'from .env' : db.kind === 'compose' ? 'from docker-compose' : db.path.split('/').slice(-2).join('/'),
    db.host ? `${db.host}${db.port ? `:${db.port}` : ''}` : '', db.bytes ? kb(db.bytes) : '', db.tableCount ? `${db.tableCount} tables` : ''].filter(Boolean).join(' · ');
  const others = Object.entries(agents).filter(([id]) => !x.access.some(a => a.agentId === id));
  return <div className="dk-split">
    <div className="dk-list" role="listbox" aria-label="Databases">
      {!x.databases.length && <div className="dk-empty"><UiIcon name="database" size={20}/><p>No local database found in this project's folders.</p></div>}
      {x.databases.map(db => <div key={db.id} className="dk-row" role="option" aria-selected={s.databaseOpen === db.id} onClick={() => d.openDatabase(db.id)}>
        <span className="dk-row-icon"><UiIcon name={DB_ICON[db.kind] ?? 'database'} size={14}/></span>
        <span className="dk-row-text"><span className="dk-row-main">{db.name}</span><span className="dk-row-sub">{where(db)}</span></span>
      </div>)}
      <p className="fine-print dk-pad">MCP servers, skills and SSH hosts found in this project live in their own sections (MCP connections, Skills, Terminal).</p>
    </div>
    <aside className="dk-split-detail" aria-label="Selected database">{!open ? <p className="dk-empty">Select a database to see its tables and what agents may do.</p> : <div className="dk-insp">
      <div className="dk-insp-head"><UiIcon name={DB_ICON[open.kind] ?? 'database'} size={22}/><h3>{open.name}</h3></div>
      <dl className="dk-facts"><dt>Kind</dt><dd>{open.engine || open.kind}</dd><dt>Where</dt><dd className="dk-path" title={open.path}>{open.path || '—'}</dd>
        {open.service && <><dt>Service</dt><dd>{open.service}{open.image ? ` · ${open.image}` : ''}</dd></>}
        {open.bytes > 0 && <><dt>Size</dt><dd>{kb(open.bytes)}</dd></>}
        {open.tables.length > 0 ? <><dt>Tables</dt><dd>{open.tables.slice(0, 6).join(', ')}{open.tables.length > 6 ? ` +${open.tables.length - 6}` : ''}</dd></> : open.tablesNote ? <><dt>Tables</dt><dd>{open.tablesNote}</dd></> : null}</dl>
      <h4>Agents may</h4>
      <p className="fine-print">Every agent: {LEVEL[x.defaultLevel]}.</p>
      <ul className="dk-who-after">{x.access.map(a => <li key={a.agentId}><Avatar name={agents[a.agentId] ?? a.agentId}/><span>{agents[a.agentId] ?? a.agentId}</span>
        <select aria-label={`What ${agents[a.agentId] ?? a.agentId} may do`} value={a.level} onChange={e => void d.setLevel(slug, a.agentId, e.target.value as 'exists')}>{Object.entries(LEVEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <IconButton icon="close" label="Back to the default" onClick={() => void d.setLevel(slug, a.agentId, null)}/></li>)}</ul>
      {others.length > 0 && <label className="dk-field">Let an agent see more<select value="" onChange={e => { if (e.target.value) void d.setLevel(slug, e.target.value, 'tables'); }}><option value="">Choose an agent…</option>{others.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></label>}
      <p className="fine-print">These levels hold for all of this project's databases. Dpro reads only the table names, from a copy, never the rows. Passwords and connection keys are never shown or saved.</p>
    </div>}</aside>
  </div>;
}

// ---------------------------------------------------------------- memory files (read-only)
/** The readable memory file of one place as one agent sees it (board M24 D3): two small pickers, the file, nothing else. */
export function FilesView({ client, drawers, agents }: { client: SessionClient; drawers: ReadonlyArray<{ id: string; name: string }>; agents: Readonly<Record<string, string>> }) {
  const ids = Object.keys(agents);
  const [drawer, setDrawer] = useState(drawers[0]?.id ?? 'owner');
  const [agent, setAgent] = useState(ids.find(i => /main/i.test(i)) ?? ids[0] ?? '');
  const [file, setFile] = useState<{ count: number; content: string } | null | 'none' | 'error'>(null);
  useEffect(() => { if (!drawers.some(d => d.id === drawer) && drawers[0]) setDrawer(drawers[0].id); }, [drawers]);
  useEffect(() => { if (!agent && ids[0]) setAgent(ids.find(i => /main/i.test(i)) ?? ids[0]); }, [ids.length]);
  useEffect(() => {
    if (!agent) return;
    let live = true; setFile(null);
    void (async () => {
      try {
        const r = await client.request({ method: 'GET', path: `/api/memory/files/${encodeURIComponent(drawer)}?agentId=${encodeURIComponent(agent)}` } as never);
        if (!live) return;
        const b = r.body as { count?: number; content?: string } | null;
        setFile(r.status === 200 && b && typeof b.content === 'string' ? { count: b.count ?? 0, content: b.content } : r.status === 404 || r.status === 403 ? 'none' : 'error');
      } catch { if (live) setFile('error'); }
    })();
    return () => { live = false; };
  }, [client, drawer, agent]);
  return <div className="dk-files">
    <div className="dk-list-bar dk-files-bar">
      {drawers.length > 1 && <label className="dk-field-inline">File<select value={drawer} onChange={e => setDrawer(e.target.value)}>{drawers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
      <label className="dk-field-inline">As read by<select value={agent} onChange={e => setAgent(e.target.value)}>{Object.entries(agents).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></label>
      <span className="dk-toolbar-gap"/>{file && typeof file === 'object' && <span className="fine-print">{file.count} {file.count === 1 ? 'entry' : 'entries'}</span>}
    </div>
    {file === null ? <p className="dk-empty" role="status">Reading the file…</p>
      : file === 'none' ? <div className="dk-empty"><UiIcon name="file" size={20}/><p>{agents[agent] ?? 'This agent'} does not read this place, so it has no file here. Pick another agent.</p></div>
      : file === 'error' ? <p className="dk-empty">The file could not be read.</p>
      : <div className="dk-file-text" dir="auto"><Markdown text={readableDrawer(file.content)}/></div>}
    <p className="fine-print">Read-only. Edits made in these files come back as questions in Needs you.</p>
  </div>;
}
