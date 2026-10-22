import {ProjectFolderPicker} from './ProjectFolderPicker';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ConversationsController, Conversation } from './conversations';
import type { ChatSearchController, ChatSearchState } from './chat-search';
import { validQuery } from './chat-search-contract.js';
import { SearchResults } from './ChatSearch';
import { UiIcon } from './ui-icons';

/** Today / Yesterday / Previous 7 days / Older, by last activity (newest first). */
export function dateGroups<T extends { updatedAt: string }>(items: readonly T[], now: Date = new Date()): [string, T[]][] {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = day(now);
  const groups = new Map<string, T[]>();
  for (const c of items) {
    const raw = c.updatedAt.includes('T') ? c.updatedAt : `${c.updatedAt.replace(' ', 'T')}Z`;
    const t = new Date(raw); const d = Number.isNaN(t.getTime()) ? today : day(t);
    const label = d >= today ? 'Today' : d >= today - 86_400_000 ? 'Yesterday' : d >= today - 7 * 86_400_000 ? 'Previous 7 days' : 'Older';
    groups.set(label, [...(groups.get(label) ?? []), c]);
  }
  return ['Today', 'Yesterday', 'Previous 7 days', 'Older'].filter(l => groups.has(l)).map(l => [l, groups.get(l)!]);
}

const noSearch = () => () => {};
const idleSearch = (): ChatSearchState => ({ query: '', phase: 'idle', results: [], truncated: false });

/**
 * Saved conversations in the sidebar: pinned first, then recent. Each row
 * opens its conversation; hover shows pin and a small menu (rename,
 * delete with a confirm step). The running conversation carries a dot.
 */
export function ConversationList({ controller, onOpen, search }: { controller: ConversationsController; onOpen: () => void; search?: ChatSearchController }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const found = useSyncExternalStore(search ? search.subscribe : noSearch, search ? search.getSnapshot : idleSearch, search ? search.getSnapshot : idleSearch);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  // CHAT-PRO-02 D: 2+ characters search inside the chats (titles, your messages, agent replies) on the server.
  const searching = !!search && validQuery(query.trim());
  const type = (text: string) => { setQuery(text); search?.setQuery(text, s.projectFilter || null); };
  useEffect(() => { if (search && validQuery(query.trim())) search.setQuery(query, s.projectFilter || null); }, [s.projectFilter]);
  const openHit = (id: string, messageId: string | null) => { void controller.openAt(id, messageId); onOpen(); };
  const projectName = (id: string | null) => (id && !s.projectFilter ? s.projects.find(p => p.id === id)?.name ?? null : null);
  const inProject = s.projectFilter ? s.conversations.filter(c => c.projectId === s.projectFilter) : s.conversations;
  const rows = q ? inProject.filter(c => (c.title ?? '').toLowerCase().includes(q) || c.preview.toLowerCase().includes(q)) : inProject;
  const pinned = rows.filter(c => c.pinned), recent = rows.filter(c => !c.pinned);
  const picker = <ProjectPicker controller={controller}/>;
  if (s.listPhase === 'loading' && !s.conversations.length) return <p className="session-empty">Loading conversations…</p>;
  if (s.listPhase === 'error' && !s.conversations.length) return <p className="session-empty">Conversations could not be loaded. <button type="button" className="link-button" onClick={() => void controller.load()}>Try again</button></p>;
  if (!s.conversations.length) return <div className="conversations">{picker}<p className="session-empty">No conversations yet. Your chats are saved here.</p></div>;
  const row = (c: Conversation) => <Row key={c.id} c={c} active={c.id === s.activeId} running={c.id === s.activeId && !!s.runId}
    onOpen={() => { void controller.open(c.id); onOpen(); }} controller={controller}/>;
  return <div className="conversations">
    <div className="conversation-controls">{picker}
    <label className="conversation-search"><UiIcon name="search" size={13}/><input className="conversation-filter" type="search" placeholder={search ? 'Search chats' : 'Filter conversations'} aria-label={search ? 'Search chats' : 'Filter conversations'} value={query}
      maxLength={400} onChange={e => type(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && query) { e.preventDefault(); type(''); } }}/></label></div>
    {searching ? <SearchResults state={found} projectName={projectName} onOpen={openHit}/> : <>
      {pinned.length > 0 && <><p className="conversation-group">Pinned</p>{pinned.map(row)}</>}
      {dateGroups(recent).map(([label, items]) => <details key={label} className="chat-date-group" open><summary><UiIcon name="chevron" size={11}/>{label}</summary>{items.map(row)}</details>)}
      {rows.length === 0 && <p className="session-empty">{q ? 'No match.' : 'No conversations in this project yet.'}</p>}
    </>}
  </div>;
}

function Row({ c, active, running, onOpen, controller }: { c: Conversation; active: boolean; running: boolean; onOpen: () => void; controller: ConversationsController }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState(c.title ?? '');
  const title = c.title || c.preview || 'New chat';
  if (renaming) return <form className="session-row editing" onSubmit={e => { e.preventDefault(); void controller.rename(c.id, name); setRenaming(false); }}>
    <input autoFocus aria-label="Conversation name" value={name} maxLength={120} onChange={e => setName(e.target.value)}
      onBlur={() => setRenaming(false)} onKeyDown={e => { if (e.key === 'Escape') setRenaming(false); }}/>
  </form>;
  return <div className="session-row" aria-current={active ? 'true' : undefined} data-menu={menu || confirm || undefined}>
    <button type="button" className="session-open" onClick={onOpen} title={title}>
      <span className="session-kind" data-running={running||undefined}><UiIcon name="message" size={13}/></span>
      <span className="session-title" dir="auto">{title}</span>
    </button>
    {confirm
      ? <span className="session-confirm">Delete?
        <button type="button" className="link-button danger" onClick={() => { setConfirm(false); void controller.remove(c.id); }}>Yes</button>
        <button type="button" className="link-button" onClick={() => setConfirm(false)}>No</button></span>
      : <span className="session-actions">
        <button type="button" className="row-tool" aria-label={c.pinned ? 'Unpin' : 'Pin'} aria-pressed={c.pinned} onClick={() => void controller.pin(c.id, !c.pinned)}><UiIcon name="pin" size={12}/></button>
        <button type="button" className="row-tool" aria-label="More" aria-expanded={menu} onClick={() => setMenu(v => !v)}><UiIcon name="more" size={12}/></button>
      </span>}
    {menu && <div className="row-menu" role="menu" onMouseLeave={() => setMenu(false)}>
      <button type="button" role="menuitem" onClick={() => { setMenu(false); setName(c.title ?? ''); setRenaming(true); }}>Rename</button>
      {controller.getSnapshot().projects.length > 0 && <label className="row-menu-select"><span>Project</span>
        <select value={c.projectId ?? ''} onChange={e => { setMenu(false); void controller.moveToProject(c.id, e.target.value); }}>
          <option value="">No project</option>
          {controller.getSnapshot().projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>}
      <button type="button" role="menuitem" onClick={() => { setMenu(false); void controller.exportMarkdown(c.id); }}>Export as Markdown</button>
      <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(false); setConfirm(true); }}>Delete</button>
    </div>}
  </div>;
}

/** Project switcher above the conversations, with a small form for a new project. */
function ProjectPicker({ controller }: { controller: ConversationsController }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [adding, setAdding] = useState(false);
  const [picking,setPicking]=useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState({ name: '', folder: '', repoUrl: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (s.access === 'denied') return null;
  const close = () => { setAdding(false); setEditing(null); setConfirmDelete(false); setError(null); setForm({ name: '', folder: '', repoUrl: '' }); };
  if (adding || editing) return <form className="project-form" aria-label={editing ? 'Edit project' : 'New project'} onSubmit={async e => {
    e.preventDefault(); setBusy(true); const err = editing ? await controller.editProject(editing, form) : await controller.createProject(form); setBusy(false);
    if (err) setError(err); else close();
  }}>
    <input autoFocus placeholder="Project name" aria-label="Project name" value={form.name} maxLength={80} onChange={e => setForm({ ...form, name: e.target.value })}/>
    <input readOnly placeholder="Choose a working folder" aria-label="Project folder" value={form.folder} onChange={e => setForm({ ...form, folder: e.target.value })} dir="ltr"/>
    <button type="button" className="link-button" disabled={busy} onClick={()=>setPicking(true)}>{form.folder?'Change folder…':'Choose folder…'}</button>
    {picking&&<ProjectFolderPicker controller={controller} onClose={()=>setPicking(false)} onSelect={folder=>{setForm({...form,folder});setPicking(false);}}/>}
    <p className="fine-print">Choose the folder this project works in. For a conversation without a folder, use General chat.</p>
    <input placeholder="Git repo (optional)" aria-label="Git repository" value={form.repoUrl} onChange={e => setForm({ ...form, repoUrl: e.target.value })} dir="ltr"/>
    {error && <p className="project-error" role="alert">{error}</p>}
    <div className="project-form-actions">
      <button type="submit" className="link-button" disabled={busy || !form.name.trim() || (!editing && !form.folder.trim())}>{editing ? 'Save' : 'Create'}</button>
      <button type="button" className="link-button" onClick={close}>Cancel</button>
      {editing && (confirmDelete
        ? <span className="project-delete">Delete the project? Its chats stay. <button type="button" className="link-button danger" disabled={busy} onClick={async () => { setBusy(true); await controller.removeProject(editing); setBusy(false); close(); }}>Yes, delete</button></span>
        : <button type="button" className="link-button danger" onClick={() => setConfirmDelete(true)}>Delete</button>)}
    </div>
  </form>;
  const current = s.projects.find(p => p.id === s.projectFilter);
  return <div className="project-picker">
    <select aria-label="Project" value={s.projectFilter} onChange={e => { if (e.target.value === '__new') setAdding(true); else { controller.filterProject(e.target.value); controller.newChat(); } }}>
      <option value="">All chats</option>
      {s.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      <option value="__new">+ New project…</option>
    </select>
    <button type="button" className="link-button project-general" title="Start a general chat without a project folder" aria-label="New general chat" onClick={()=>{ controller.filterProject(''); controller.newChat(); }}><UiIcon name="message" size={12}/>General chat</button>
    {current && <button type="button" className="row-tool" aria-label={`Edit project ${current.name}`} title="Rename, change folder or repo, or delete"
      onClick={() => { setForm({ name: current.name, folder: current.folder ?? '', repoUrl: current.repoUrl ?? '' }); setEditing(current.id); }}><UiIcon name="pencil" size={12}/></button>}
  </div>;
}
