// MEM-UI-01 P8 (board M9): the inheritance grid, role templates, "check one
// agent", the preview before saving and the rules that are always true.
import { useSyncExternalStore } from 'react';
import { KIND_COLUMNS, MemoryAccessController, cellText, chain, whyText } from './memory-access';
import type { Level } from './memory-access';
import type { DrawerKind, ScopeTree } from './memory-pages-contract.js';

export function AccessView({ c, scope, tree }: { c: MemoryAccessController; scope: string; tree: ScopeTree | null }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  if (s.phase === 'error') return <p className="empty-note">{s.notice} <button type="button" className="link-button" onClick={() => void c.load()}>Try again</button></p>;
  if (s.phase !== 'ready' || !s.overview) return <p className="empty-note" role="status">Reading access…</p>;
  const departmentOf = (slug: string) => tree?.projects.find(p => p.slug === slug)?.departmentId ?? 'general';
  const scopes = chain(scope, departmentOf);
  const nameOf = (x: string) => x === 'company' ? 'Company default' : x.startsWith('department:') ? tree?.departments.find(d => d.id === x.slice(11))?.name ?? x.slice(11) : tree?.projects.find(p => p.slug === x.slice(8))?.name ?? x.slice(8);
  const agentName = (id: string) => s.agents.find(a => a.id === id)?.name ?? id;
  const noteOf = (x: string) => x === 'company' ? `all ${tree?.agents.total ?? ''} agents`.replace('  ', ' ') : x.startsWith('department:') ? `${tree?.departments.find(d => d.id === x.slice(11))?.projects ?? 0} projects` : 'this project';
  const levels: Level[] = [
    ...scopes.map(x => ({ key: x, scope: x, agentId: null, label: nameOf(x), note: noteOf(x) })),
    ...c.exceptionAgents(scope).map(a => { const end = c.endsAt(scope, a); return { key: `${scope}|${a}`, scope, agentId: a, label: `Exception: ${agentName(a)}`, note: end ? `temporary · ends ${end.slice(0, 10)}` : `only in ${nameOf(scope)}` }; }),
  ];
  const project = scope.startsWith('project:') ? scope.slice(8) : null;
  const e = s.effective;
  return <div className="mem-access">
    <div className="mem-access-head">
      <div><h3>Who may read and write this memory</h3><p className="fine-print">Set once per level; lower levels inherit and only store their exceptions.</p></div>
      <button type="button" className="primary" onClick={() => c.startException()} disabled={!!s.exception}>Add exception</button>
    </div>
    {s.notice && <p className="card-notice" role="alert">{s.notice}</p>}
    {s.result && <p className="memory-status" role="status">{s.result}</p>}
    {s.exception && <form className="mem-card mem-exception" aria-label="New exception" onSubmit={ev => { ev.preventDefault(); c.addException(scope); }}>
      <div className="mem-add-row">
        <label>Agent<select value={s.exception.agentId} onChange={ev => c.editException({ agentId: ev.target.value })}><option value="">Choose an agent…</option>{s.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>Drawer<select value={s.exception.kind} onChange={ev => c.editException({ kind: ev.target.value as DrawerKind })}>{KIND_COLUMNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Access<select value={s.exception.access} onChange={ev => c.editException({ access: ev.target.value as 'read' | 'write' | 'none' })}><option value="read">Read</option><option value="write">Read + write</option><option value="none">No access</option></select></label>
        <label>Until (optional)<input type="date" value={s.exception.until} onChange={ev => c.editException({ until: ev.target.value })}/></label>
        <label>Why<input value={s.exception.reason} maxLength={200} placeholder="e.g. legal review" onChange={ev => c.editException({ reason: ev.target.value })}/></label>
      </div>
      <div className="actions"><button type="submit" className="primary" disabled={!s.exception.agentId}>Add to the preview</button><button type="button" onClick={() => c.cancelException()}>Cancel</button></div>
      <p className="fine-print">An exception applies in {nameOf(scope)}{scope === 'company' ? ' (everywhere)' : ''}. A date makes it temporary.</p>
    </form>}
    <div className="mem-access-body">
      <section className="mem-access-main" aria-label="Inheritance">
        <div className="mem-grid" role="table" aria-label="Access by level">
          <div className="mem-grid-row mem-grid-head" role="row"><span role="columnheader">Level</span>{KIND_COLUMNS.map(([k, l]) => <span key={k} role="columnheader">{l}</span>)}</div>
          {levels.map((l, i) => <div key={l.key} className="mem-grid-row" role="row" data-own={i > 0 || undefined}>
            <span role="rowheader" className="mem-grid-level"><b>{l.label}</b><small className="fine-print">{l.note}</small></span>
            {KIND_COLUMNS.map(([k]) => { const cell = c.cell(levels, i, k);
              return <button key={k} type="button" role="cell" className="mem-grid-cell" data-own={cell.own || undefined} title="Change at this level" disabled={s.busy} onClick={() => c.cycle(l, k, cell)}>{cellText(cell)}</button>; })}
          </div>)}
        </div>
        <p className="fine-print">R = read · W = write · — = no access · faded = inherited · bold = set at this level. Click a cell to change it at that level (read → read + write → none → inherited).</p>
        <section className="mem-card" aria-label="Role templates">
          <h3>Role templates</h3>
          {s.overview.templates.length === 0 ? <p className="fine-print">No role templates yet.</p>
            : <div className="mem-templates">{s.overview.templates.map(t => <div key={t.id} className="mem-template"><b>{t.name}</b><span className="fine-print">used by {t.agents} {t.agents === 1 ? 'agent' : 'agents'} · reads {t.memoryRead.length}, writes {t.memoryWrite.length}</span></div>)}</div>}
        </section>
      </section>
      <aside className="mem-side">
        <section className="mem-card mem-check-agent" aria-label="Check one agent">
          <h3>Check one agent</h3>
          <select aria-label="Agent" value={s.checkAgent} onChange={ev => void c.check(ev.target.value, project)}><option value="">Choose an agent…</option>{s.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          {e && <>
            <span>Effective here: <b>{KIND_COLUMNS.map(([k, l]) => `${l} ${e.kinds[k]?.write ? 'R+W' : e.kinds[k]?.read ? 'R' : '—'}`).join(' · ')}</b></span>
            <span className="fine-print">{e.template ? `Template: ${e.template.name}. ` : ''}Why (projects): {whyText(e, 'project') || 'company default'}</span>
          </>}
        </section>
        {s.changes.length > 0 && <section className="mem-card mem-preview" aria-label="Preview before saving">
          <h3>Preview before saving</h3>
          {!s.preview ? <p className="fine-print" role="status">{s.busy ? 'Counting who changes…' : 'No preview yet.'}</p> : <>
            <span>{s.changes.length === 1 ? 'This change' : `These ${s.changes.length} changes`} {s.preview.agentsAffected ? <>{s.changes.length === 1 ? 'changes' : 'change'} access for <b>{s.preview.agentsAffected} {s.preview.agentsAffected === 1 ? 'agent' : 'agents'}</b> in <b>{s.preview.projectsAffected} {s.preview.projectsAffected === 1 ? 'project' : 'projects'}</b></> : `${s.changes.length === 1 ? 'changes' : 'change'} nobody’s access today`}{s.preview.widened ? ` (${s.preview.widened} get more)` : ''}{s.preview.narrowed ? ` (${s.preview.narrowed} get less)` : ''}.</span>
            <div className="actions"><button type="button" className="primary" disabled={s.busy} onClick={() => void c.apply()}>Apply{s.preview.agentsAffected ? ` to ${s.preview.agentsAffected}` : ''}</button><button type="button" onClick={() => c.toggleSample()} disabled={!s.preview.sample.length}>{s.showSample ? 'Hide the list' : 'See the list'}</button><button type="button" onClick={() => c.discard()}>Discard</button></div>
            {s.showSample && <ul className="mem-sample">{s.preview.sample.map(x => <li key={x.agentId + x.project}>{x.agentName}{x.project ? ` · ${x.project}` : ''}: reads {x.before.read.length} → {x.after.read.length}, writes {x.before.write.length} → {x.after.write.length}</li>)}</ul>}
          </>}
        </section>}
        <section className="mem-card" aria-label="Always true">
          <h3>Always true</h3>
          <span className="fine-print">Outside senders (channels) never read private memory.</span>
          <span className="fine-print">An agent never gets more than the agent that delegated to it.</span>
          <span className="fine-print">An agent never gets more than its own permissions and role template.</span>
          <span className="fine-print">Every change is in the audit log.</span>
        </section>
      </aside>
    </div>
  </div>;
}
