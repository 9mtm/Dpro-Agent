// MEM-UI-01 P1 (boards M1 + M8): the scope rail, the scope header and the
// overview of Everything (the memory home) or of one department / project.
import { useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { MemoryScopesController, effectLines } from './memory-scopes';
import { ago, agentLabel, drawerName, oneLine } from './memory-store';
import type { Health, ProjectAction, TreeProject } from './memory-pages-contract.js';
import { UiIcon } from './ui-icons';

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '…' : n.toLocaleString('en-US'));
const Dot = ({ health }: { health: Health | 'none' }) => <span className="mem-dot" data-health={health} aria-hidden="true"/>;
const HEALTH_WORD: Record<Health, string> = { ok: 'healthy', attention: 'needs a look', problem: 'has conflicts' };

/** Left rail: Everything, what waits, pinned, company → departments → projects, people, agents, archived. */
export function ScopeRail({ c, onWaiting, onScope }: { c: MemoryScopesController; onWaiting: () => void; onScope: (scope: string) => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const t = s.tree;
  const q = s.find.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);
  const active = (p: TreeProject) => !p.archived && !p.mergedInto;
  const row = (scope: string, label: ReactNode, count: ReactNode, opts: { health?: Health; depth?: number; caret?: string; onCaret?: () => void; tone?: string } = {}) =>
    <div key={scope + (opts.depth ?? '')} className="mem-rail-row" data-depth={opts.depth || undefined} data-tone={opts.tone}>
      {opts.caret !== undefined && <button type="button" className="mem-caret" aria-label={opts.caret === '▾' ? 'Close' : 'Open'} aria-expanded={opts.caret === '▾'} onClick={opts.onCaret}>{opts.caret}</button>}
      <button type="button" className="mem-rail-pick" aria-current={s.scope === scope ? 'true' : undefined} onClick={() => onScope(scope)}>
        {opts.health && <Dot health={opts.health}/>}<span className="mem-rail-name">{label}</span><span className="mem-count">{count}</span>
      </button>
    </div>;
  const projects = (t?.projects ?? []).filter(active);
  const pinned = projects.filter(p => p.pinned && match(p.name));
  const archived = (t?.projects ?? []).filter(p => p.archived && match(p.name));
  return <aside className="mem-rail" aria-label="Memory scopes">
    <div className="mem-rail-top">
      <span className="mem-rail-title">Memory</span>
      <label className="mem-find"><UiIcon name="search" size={13}/><input aria-label="Find a scope" placeholder="Project, person, department…" value={s.find} onChange={e => c.setFind(e.target.value)}/></label>
    </div>
    <div className="mem-rail-list">
      {row('company', 'Everything', fmt(t?.company.memories))}
      <div className="mem-rail-row" data-tone="warn"><button type="button" className="mem-rail-pick" onClick={onWaiting}><span className="mem-rail-name">Waiting for me</span><span className="mem-count">{fmt(t ? t.company.pendingReviews : null)}</span></button></div>
      {pinned.length > 0 && <p className="mem-rail-label">PINNED</p>}
      {pinned.map(p => row(`project:${p.slug}`, p.name, fmt(p.memories), { health: p.health }))}
      <p className="mem-rail-label">COMPANY</p>
      {(t?.departments ?? []).map(d => {
        const inside = projects.filter(p => p.departmentId === d.id && match(p.name));
        if (q && !inside.length && !match(d.name)) return null;
        const open = s.open.includes(d.id) || !!q;
        return [row(`department:${d.id}`, d.name, `${d.projects} ${d.projects === 1 ? 'project' : 'projects'}`, { health: d.health, caret: inside.length ? (open ? '▾' : '▸') : '', onCaret: () => c.toggle(d.id) }),
          ...(open ? inside.map(p => row(`project:${p.slug}`, p.name, fmt(p.memories), { health: p.health, depth: 1 })) : [])];
      })}
      <p className="mem-rail-label">ALSO</p>
      {(() => {
        const people = (t?.people ?? []).filter(p => match(p.key));
        const open = s.open.includes('_people') || (!!q && people.length > 0);
        return [row('_people', 'People', fmt(people.reduce((n, p) => n + p.memories, 0)), { caret: people.length ? (open ? '▾' : '▸') : '', onCaret: () => c.toggle('_people') }),
          ...(open ? people.slice(0, 200).map(p => row(`people:${p.key}`, p.key, fmt(p.memories), { health: p.health, depth: 1 })) : [])];
      })()}
      {(() => {
        const agents = Object.entries(s.agents).filter(([, name]) => match(name)).sort((a, b) => a[1].localeCompare(b[1]));
        const open = s.open.includes('_agents') || (!!q && agents.length > 0);
        return [row('_agents', 'Agents', fmt(t?.agents.total), { caret: agents.length ? (open ? '▾' : '▸') : '', onCaret: () => c.toggle('_agents') }),
          ...(open ? agents.slice(0, 200).map(([id, name]) => row(`agent:${id}`, name, '', { depth: 1 })) : [])];
      })()}
      {(() => {
        const open = s.open.includes('_archived') || (!!q && archived.length > 0);
        return [row('_archived', 'Archived projects', fmt(t ? t.company.archivedProjects : null), { tone: 'muted', caret: archived.length ? (open ? '▾' : '▸') : '', onCaret: () => c.toggle('_archived') }),
          ...(open ? archived.map(p => row(`project:${p.slug}`, p.name, fmt(p.memories), { depth: 1, tone: 'muted' })) : [])];
      })()}
    </div>
  </aside>;
}

/** Breadcrumb, title, health, Pin and Project actions of the open scope. */
export function ScopeHeader({ c, children }: { c: MemoryScopesController; children?: ReactNode }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const p = c.project();
  const dept = s.tree?.departments.find(d => d.id === (p ? p.departmentId : s.scope.startsWith('department:') ? s.scope.slice(11) : ''));
  const title = p ? p.name : dept && s.scope.startsWith('department:') ? dept.name : 'Everything';
  const health = p ? p.health : dept && s.scope.startsWith('department:') ? dept.health : s.tree?.company.health;
  const crumbs = p ? ['Company', dept?.name ?? 'General'] : s.scope.startsWith('department:') ? ['Company'] : [];
  const [menu, setMenu] = useState(false);
  return <div className="mem-head">
    {crumbs.length > 0 && <span className="mem-crumbs">{crumbs.join(' › ')} › </span>}
    <div className="mem-head-row">
      <h2>{title}</h2>
      {health && <span className="mem-pill" data-health={health}>{HEALTH_WORD[health]}</span>}
      {p && <span className="mem-meta">memory key: project/{p.slug} · {fmt(p.memories)} memories{p.archived ? ' · archived (kept, not loaded)' : ''}</span>}
      {p && <div className="mem-head-actions">
        <button type="button" onClick={() => void c.previewAction(p.pinned ? 'unpin' : 'pin')} disabled={s.previewBusy || p.archived}>{p.pinned ? 'Unpin' : 'Pin'}</button>
        <div className="mem-menu-wrap">
          <button type="button" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(m => !m)}>Project actions ⌄</button>
          {menu && <ProjectMenu c={c} onClose={() => setMenu(false)}/>}
        </div>
      </div>}
    </div>
    {children}
  </div>;
}

function ProjectMenu({ c, onClose }: { c: MemoryScopesController; onClose: () => void }) {
  const p = c.project()!;
  const pick = (a: ProjectAction) => { onClose(); c.startAction(a); };
  return <div className="mem-menu" role="menu" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
    {p.archived
      ? <button type="button" role="menuitem" onClick={() => pick('unarchive')}>Unarchive (load again)</button>
      : <button type="button" role="menuitem" onClick={() => pick('archive')}>Archive memory (kept, not loaded)</button>}
    <button type="button" role="menuitem" onClick={() => pick('merge')} disabled={p.archived}>Merge into another project</button>
    <button type="button" role="menuitem" onClick={() => pick('move')}>Move to another department</button>
    <button type="button" role="menuitem" onClick={() => { onClose(); void downloadExport(c); }}>Export as files</button>
    <button type="button" role="menuitem" className="danger" onClick={() => pick('forget')}>Forget the whole project…</button>
  </div>;
}

/** Saves the project's readable memory files as one Markdown file. */
async function downloadExport(c: MemoryScopesController) {
  const out = await c.exportProject();
  if (!out || typeof document === 'undefined') { c.note(out ? '' : 'The export could not be made.'); return; }
  const text = out.files.map(f => `<!-- ${f.name} -->\n${f.content}`).join('\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a'); a.href = url; a.download = `${out.project}-memory.md`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  c.note(`Exported ${out.files.length} ${out.files.length === 1 ? 'file' : 'files'}.`);
}

/** Preview → confirm for a project action (owner OK; nothing changes before Confirm). */
export function ActionDialog({ c }: { c: MemoryScopesController }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const p = c.project();
  const [target, setTarget] = useState('');
  const [dept, setDept] = useState('');
  const [typed, setTyped] = useState('');
  if (!s.action || !p) return null;
  const a = s.action;
  const needsChoice = (a === 'merge' || a === 'move') && !s.preview;
  const verb: Record<ProjectAction, string> = { pin: 'Pin', unpin: 'Unpin', archive: 'Archive', unarchive: 'Unarchive', move: 'Move', merge: 'Merge', forget: 'Forget for good' };
  const forget = a === 'forget';
  return <div className="mem-dialog" role="dialog" aria-modal="false" aria-labelledby="mem-action-title">
    <h3 id="mem-action-title">{verb[a]} “{p.name}”</h3>
    {a === 'merge' && <label>Merge into<select value={target} onChange={e => setTarget(e.target.value)}><option value="">Choose a project…</option>
      {(s.tree?.projects ?? []).filter(x => x.slug !== p.slug && !x.archived && !x.mergedInto).map(x => <option key={x.slug} value={x.slug}>{x.name}</option>)}</select></label>}
    {a === 'move' && <label>Move to<select value={dept} onChange={e => setDept(e.target.value)}><option value="">Choose a department…</option>
      {(s.tree?.departments ?? []).filter(d => d.id !== p.departmentId).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
    {needsChoice && <div className="actions"><button type="button" className="primary" disabled={s.previewBusy || (a === 'merge' ? !target : !dept)} onClick={() => void c.previewAction(a, a === 'merge' ? { target } : { departmentId: dept })}>Preview</button><button type="button" onClick={() => c.cancelAction()}>Cancel</button></div>}
    {s.previewBusy && !s.preview && <p role="status">Checking what changes…</p>}
    {s.preview && <>
      <ul className="mem-effects">{effectLines(s.preview).map((l, i) => <li key={i}>{l}</li>)}</ul>
      {s.preview.effects.sample && s.preview.effects.sample.length > 0 && <details><summary>See the agents</summary><ul>{s.preview.effects.sample.map(x => <li key={x.agentId + x.project}>{x.agentName}: {x.before.read.join(', ') || 'nothing'} → {x.after.read.join(', ') || 'nothing'}</li>)}</ul></details>}
      {forget && <label>Type the project name to confirm<input value={typed} onChange={e => setTyped(e.target.value)} placeholder={p.name}/></label>}
      <div className="actions">
        <button type="button" className={forget ? 'danger-solid' : 'primary'} disabled={s.previewBusy || (forget && typed.trim() !== p.name)} onClick={() => void c.applyAction()}>Confirm: {verb[a].toLowerCase()}</button>
        <button type="button" onClick={() => c.cancelAction()} disabled={s.previewBusy}>Cancel</button>
      </div>
      <p className="fine-print">Nothing changes until you confirm. If the project changes meanwhile, Dpro asks you to look again.</p>
    </>}
    {s.previewNotice && <p className="card-notice" role="alert">{s.previewNotice}</p>}
  </div>;
}

/** Everything (board M1): stats, drawers, recently learned; what waits, this week, health, import. */
export function HomeView({ c, go }: { c: MemoryScopesController; go: (tab: 'review' | 'explorer' | 'health' | 'import' | 'map', drawer?: string) => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const t = s.tree;
  if (!t) return null;
  const drawers = t.company.drawers;
  const sum = (kind: string) => drawers[kind] ?? 0;
  const total = s.readers._total ?? 0;
  const readBy = (k: string) => (s.readers._total === undefined ? '…' : !s.readers[k] ? 'no agent' : s.readers[k] === total ? 'all agents' : `${s.readers[k]} agents`);
  const d = s.doctor;
  return <div className="mem-home">
    <div className="mem-col">
      <div className="mem-stats">
        <Stat label="Memories" value={fmt(t.company.memories)} note={s.weekCount === null ? '' : `+${s.weekCount}${s.weekMore ? '+' : ''} this week`}/>
        <Stat label="Kept by topic" value={fmt(s.topics)} note="a new fact on a topic becomes a new version"/>
        <Stat label="People · projects in the map" value={fmt(s.mapEntities)} note={s.mapLinks === null ? '' : `${fmt(s.mapLinks)} links`} onClick={() => go('map')}/>
        <Stat label="Waiting for review" value={fmt(s.waiting?.total)} note={s.waiting ? `${s.waiting.conflicts} ${s.waiting.conflicts === 1 ? 'conflict' : 'conflicts'}` : ''} warn={!!s.waiting?.total} onClick={() => go('review')}/>
      </div>
      <section className="mem-card">
        <div className="mem-card-head"><h3>Drawers</h3><span className="fine-print">Only the drawers a reply needs are loaded</span></div>
        <div className="mem-drawers">{[['owner', 'About you'], ['project', 'Projects'], ['experience', 'Lessons'], ['task', 'Tasks'], ['people', 'People']].map(([k, label]) =>
          <button key={k} type="button" className="mem-drawer" onClick={() => go('explorer', k)}><span className="mem-drawer-name">{label}</span><span className="mem-drawer-count">{fmt(sum(k))}</span><span className="fine-print">Read by {readBy(k)}</span></button>)}</div>
      </section>
      <section className="mem-card mem-grow">
        <div className="mem-card-head"><h3>Recently learned</h3><button type="button" className="link-button" onClick={() => go('explorer')}>Open explorer</button></div>
        {s.recent.length === 0 ? <p className="fine-print">Nothing learned yet. Agents add memories while they work, or add one yourself.</p>
          : s.recent.map(r => <div key={r.id} className="mem-recent"><span className="fine-print">{drawerName(r.drawerId)}</span><span className="mem-recent-text" dir="auto" title={oneLine(r.preview)}>{oneLine(r.preview)}</span><span className="fine-print">{agentLabel(r.sourceAgentId, s.agents) || 'You'}</span><span className="fine-print mem-end">{ago(r.createdAt)}</span></div>)}
      </section>
    </div>
    <aside className="mem-side">
      <button type="button" className="mem-card mem-waiting" onClick={() => go('review')}>
        <span className="mem-warn-label">Waiting for you</span>
        <span className="mem-big">{s.waiting ? `${s.waiting.total} to review` : '…'}</span>
        {s.waiting && <span className="fine-print">{[`${s.waiting.important} important`, `${s.waiting.conflicts} conflicts`, `${s.waiting.links} new links`, ...(s.waiting.imported ? [`${s.waiting.imported} imported`] : []), ...(s.waiting.files ? [`${s.waiting.files} file edits`] : [])].join(' · ')}</span>}
      </button>
      <section className="mem-card">
        <h3>This week</h3>
        {s.weekly ? <p>Learned {s.weekly.totals.created}, updated {s.weekly.totals.updated}, forgot {s.weekly.totals.forgotten}{s.weekly.totals.pending ? `; ${s.weekly.totals.pending} wait for you` : ''}.</p>
          : <p>{s.weekCount === null ? '…' : `Learned ${s.weekCount}${s.weekMore ? '+' : ''} ${s.weekCount === 1 ? 'memory' : 'memories'} in the last 7 days.`}</p>}
        {s.weekly?.text && <details className="mem-weekly"><summary>Read the weekly summary</summary><p className="mem-weekly-text">{s.weekly.text}</p></details>}
      </section>
      <button type="button" className="mem-card mem-health-card" onClick={() => go('health')}>
        <h3>Health</h3>
        <span className="mem-line"><span>Duplicates</span><span data-tone={d?.counts.duplicate ? 'warn' : 'ok'}>{fmt(d?.counts.duplicate)}</span></span>
        <span className="mem-line"><span>Missing meaning index</span><span data-tone={d && d.counts['embedding-missing'] + d.counts['embedding-stale'] ? 'warn' : 'ok'}>{fmt(d ? d.counts['embedding-missing'] + d.counts['embedding-stale'] : null)}</span></span>
        <span className="mem-line"><span>Past retention</span><span data-tone={d?.counts.expired ? 'warn' : 'ok'}>{fmt(d?.counts.expired)}</span></span>
        <span className="mem-line"><span>Cache hit rate</span><span>{s.cacheHit === null ? '—' : `${Math.round(s.cacheHit * 100)}%`}</span></span>
      </button>
      <section className="mem-card">
        <h3>Import</h3>
        <p>{!s.importStatus ? '…' : s.importStatus.enabled ? `Automatic: every ${s.importStatus.intervalMinutes} minutes${s.importStatus.lastRun ? ` · last run ${ago(new Date(s.importStatus.lastRun).toISOString())} ago` : ''}` : 'Automatic import is off.'}</p>
        <button type="button" className="link-button" onClick={() => go('import')}>Import settings</button>
      </section>
    </aside>
  </div>;
}

function Stat({ label, value, note, warn, onClick }: { label: string; value: string; note: string; warn?: boolean; onClick?: () => void }) {
  const body = <><span className="fine-print">{label}</span><span className="mem-stat-value">{value}</span><span className="fine-print" data-tone={warn ? 'warn' : undefined}>{note}</span></>;
  return onClick ? <button type="button" className="mem-stat" onClick={onClick}>{body}</button> : <div className="mem-stat">{body}</div>;
}

/** A department or a project (board M8): stats, pinned facts, topics; who uses it, actions, rules. */
export function OverviewView({ c, go }: { c: MemoryScopesController; go: (tab: 'review' | 'explorer' | 'access') => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const p = c.project();
  const dept = s.scope.startsWith('department:') ? s.tree?.departments.find(d => d.id === s.scope.slice(11)) : undefined;
  const counts = p ?? dept;
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  if (!counts) return <p className="empty-note">This scope no longer exists. Choose another on the left.</p>;
  const inherits = p ? s.tree?.departments.find(d => d.id === p.departmentId)?.name ?? 'General' : 'Company';
  const own = s.rules.filter(r => r.scope === s.scope && !r.agentId);
  const exceptions = s.rules.filter(r => r.scope === s.scope && r.agentId);
  return <div className="mem-home">
    <div className="mem-col">
      <div className="mem-stats">
        <Stat label="Memories" value={fmt(counts.memories)} note=""/>
        <Stat label="Topics" value={fmt(s.topicKeys.length)} note=""/>
        <Stat label="Learned this week" value={s.scopeWeek === null ? '…' : `+${s.scopeWeek}`} note=""/>
        <Stat label="Waiting for review" value={fmt(counts.pendingReviews)} note={counts.conflicts ? `${counts.conflicts} conflicts` : ''} warn={!!counts.pendingReviews} onClick={() => go('review')}/>
      </div>
      <section className="mem-card" aria-label="Pinned facts">
        <h3>Pinned facts — every agent {p ? 'in this project' : 'here'} gets these first</h3>
        {s.facts.length === 0 && <p className="fine-print">No pinned facts yet. Add the few things every agent must always know here.</p>}
        {s.facts.map(f => <div key={f.id} className="mem-fact">
          {editing?.id === f.id
            ? <form className="mem-fact-edit" onSubmit={e => { e.preventDefault(); void c.editFact(f.id, editing.text).then(ok => { if (ok) setEditing(null); }); }}>
              <input aria-label="Pinned fact" value={editing.text} maxLength={1000} dir="auto" onChange={e => setEditing({ id: f.id, text: e.target.value })}/>
              <button type="submit" className="primary" disabled={s.factsBusy || !editing.text.trim()}>Save</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></form>
            : <><span dir="auto" className="mem-fact-text">{f.text}</span>
              {confirmRemove === f.id
                ? <span className="confirm-inline">Remove?<button type="button" className="link-button danger" onClick={() => { setConfirmRemove(null); void c.removeFact(f.id); }}>Remove</button><button type="button" className="link-button" onClick={() => setConfirmRemove(null)}>Keep</button></span>
                : <span className="mem-row-actions"><button type="button" className="link-button" onClick={() => setEditing({ id: f.id, text: f.text })}>Edit</button><button type="button" className="link-button" onClick={() => setConfirmRemove(f.id)}>Remove</button></span>}</>}
        </div>)}
        <form className="mem-fact-add" onSubmit={e => { e.preventDefault(); void c.addFact(draft).then(ok => { if (ok) setDraft(''); }); }}>
          <input aria-label="New pinned fact" placeholder="Add a pinned fact…" value={draft} maxLength={1000} dir="auto" onChange={e => setDraft(e.target.value)}/>
          <button type="submit" disabled={s.factsBusy || !draft.trim()}>Pin fact</button>
        </form>
      </section>
      <section className="mem-card mem-grow" aria-label="Topics">
        <h3>Topics {p ? 'in this project' : 'here'}</h3>
        {s.topicKeys.length === 0 ? <p className="fine-print">No topics yet.</p>
          : <div className="mem-chips">{s.topicKeys.map(k => <button key={k} type="button" className="mem-chip" onClick={() => go('explorer')}>{k}</button>)}</div>}
      </section>
    </div>
    <aside className="mem-side">
      {p && <section className="mem-card" aria-label="Who uses it">
        <h3>Who uses it</h3>
        {s.usage === null ? <p className="fine-print">Checking…</p> : s.usage.length === 0 ? <p className="fine-print">No agent may read this project's memory.</p>
          : s.usage.slice(0, 6).map(u => <span key={u.agentId} className="mem-line"><span>{u.name}</span><span className="fine-print">{u.write ? 'read + write' : 'read'} · {u.why}</span></span>)}
        {s.usage && <button type="button" className="link-button" onClick={() => go('access')}>{s.usage.length > 6 ? `+ ${s.usage.length - 6} more · ` : ''}Access settings ({s.usageChecked} agents checked)</button>}
      </section>}
      {p && <section className="mem-card" aria-label="Project actions">
        <h3>Project actions</h3>
        <ProjectActionsList c={c} project={p}/>
      </section>}
      <section className="mem-card" aria-label="Rules here">
        <h3>Rules here</h3>
        <p>Inherits {inherits}{own.length ? '' : ' with no changes here'}.</p>
        {own.map(r => <span key={r.id} className="mem-line" data-tone="warn"><span>Override: {r.drawerKind}</span><span>read {r.read} · write {r.write}</span></span>)}
        {exceptions.length > 0 && <span className="fine-print">{exceptions.length} agent {exceptions.length === 1 ? 'exception' : 'exceptions'}</span>}
        <button type="button" className="link-button" onClick={() => go('access')}>Change access</button>
      </section>
    </aside>
  </div>;
}

function ProjectActionsList({ c, project: p }: { c: MemoryScopesController; project: TreeProject }) {
  return <div className="mem-action-list">
    {p.archived ? <button type="button" className="link-button" onClick={() => c.startAction('unarchive')}>Unarchive (load again)</button>
      : <button type="button" className="link-button" onClick={() => c.startAction('archive')}>Archive memory (kept, not loaded)</button>}
    <button type="button" className="link-button" disabled={p.archived} onClick={() => c.startAction('merge')}>Merge into another project</button>
    <button type="button" className="link-button" onClick={() => c.startAction('move')}>Move to another department</button>
    <button type="button" className="link-button" onClick={() => void downloadExport(c)}>Export as files</button>
    <button type="button" className="link-button danger" onClick={() => c.startAction('forget')}>Forget the whole project…</button>
  </div>;
}
