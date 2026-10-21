// MEM-FINISH-01 (board M12): Memory › Handoffs — see and edit what each agent
// left for its next session, per chat or board task, with versions.
import { useSyncExternalStore } from 'react';
import { MemoryHandoffsController } from './memory-handoffs';
import type { HandoffDraft, HandoffFilter } from './memory-handoffs';
import { agentLabel, ago } from './memory-store';
import type { CodingHandoff, Handoff } from './memory-pages-contract.js';

const APP: Record<string, { mark: string; name: string }> = { 'claude-code': { mark: 'CC', name: 'Claude Code' }, codex: { mark: 'CX', name: 'Codex' }, 'gemini-cli': { mark: 'GE', name: 'Gemini CLI' }, antigravity: { mark: 'AG', name: 'Antigravity' } };
const KINDS: Array<{ value: HandoffFilter; label: string }> = [{ value: 'all', label: 'All' }, { value: 'conversation', label: 'Chats' }, { value: 'task', label: 'Board tasks' }, { value: 'coding', label: 'Coding apps' }];
const FIELDS: Array<{ key: keyof HandoffDraft; label: string; tone: string }> = [
  { key: 'done', label: 'Done', tone: 'ok' }, { key: 'left', label: 'Left', tone: 'warn' }, { key: 'next', label: 'Next', tone: 'link' }, { key: 'questions', label: 'Questions for you', tone: 'bad' },
];
const SOURCE: Record<Handoff['source'], string> = { agent: 'session end', model: 'summarised', fallback: 'kept automatically', owner: 'you' };

/** The first line worth showing: "Left: …", "Next: …" or "Done: …". */
function lineOf(h: Pick<Handoff, 'done' | 'left' | 'next' | 'questions'>): string {
  if (h.left.length) return `Left: ${h.left.join('; ')}`;
  if (h.next.length) return `Next: ${h.next.join('; ')}`;
  if (h.questions.length) return `Questions: ${h.questions.join('; ')}`;
  return h.done.length ? `Done: ${h.done.join('; ')}` : '';
}
const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

export function HandoffsView({ c, onOpenChat }: { c: MemoryHandoffsController; onOpenChat?: (conversationId: string) => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  if (s.phase === 'error') return <p className="empty-note">{s.notice} <button type="button" className="link-button" onClick={() => void c.load()}>Try again</button></p>;
  if (s.phase !== 'ready') return <p className="empty-note" role="status">Loading handoff notes…</p>;
  const counts = c.counts();
  const items = c.visible();
  const name = (id: string) => agentLabel(id, s.agents);
  const open = s.open;
  const coding = open && 'coding' in open ? s.coding.find(x => x.id === open.coding) ?? null : null;
  return <div className="mem-handoffs">
    <nav className="mem-handoffs-filters" aria-label="Handoff filters">
      <label className="field"><span>Agent</span><select value={s.agent} onChange={e => c.setAgent(e.target.value)}><option value="">All agents</option>{Object.entries(s.agents).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></label>
      <label className="field"><span>Project</span><select value={s.project} onChange={e => c.setProject(e.target.value)}><option value="">All projects</option>{s.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <div className="mem-handoffs-kinds">{KINDS.map(k => <button key={k.value} type="button" aria-pressed={s.kind === k.value} onClick={() => c.setKind(k.value)}><span>{k.label}</span><span className="count">{counts[k.value]}</span></button>)}</div>
      <p className="fine-print">An agent writes a note when a session ends or goes quiet for 30 min. The next session of the same chat or task starts from the newest note.</p>
    </nav>
    <section className="mem-handoffs-list" aria-label="Newest note per chat or task">
      <div className="mem-handoffs-list-head">Newest note per chat or task · {items.length}</div>
      {items.length === 0 && <p className="empty-note">No handoff notes yet. Agents write one when a larger piece of work ends.</p>}
      {items.map(it => {
        const n = it.note, a = it.coding;
        const title = n ? n.title || (n.kind === 'task' ? 'Board task' : 'Chat') : `${s.projects.find(p => p.id === a!.projectId)?.name ?? 'Project'} folder`;
        const kind = n ? (n.kind === 'task' ? 'Task' : 'Chat') : APP[a!.client].name;
        const meta = n ? `${name(n.agentId)} · v${n.version} · ${ago(n.createdAt)}${n.source === 'owner' ? ' · edited by you' : ''}` : `${APP[a!.client].name} · read only · ${ago(a!.createdAt)}`;
        return <button key={'coding' in it.ref ? it.ref.coding : `${it.ref.kind}:${it.ref.scopeId}:${it.ref.agentId}`} type="button" className="mem-handoff-row" aria-current={c.isOpen(it.ref) || undefined} onClick={() => void c.openNote(it)}>
          <span className="mem-handoff-mark">{n ? initial(name(n.agentId)) : APP[a!.client].mark}</span>
          <span className="mem-handoff-main">
            <span className="mem-handoff-title"><span dir="auto">{title}</span><span className="mem-handoff-kind" data-kind={n ? n.kind : 'coding'}>{kind}</span></span>
            <span className="mem-handoff-line" dir="auto">{lineOf(n ?? a!)}</span>
            <span className="fine-print">{meta}</span>
          </span>
        </button>;
      })}
    </section>
    <section className="mem-handoff-edit" aria-label="Edit handoff">
      {coding ? <CodingNote h={coding} project={s.projects.find(p => p.id === coding.projectId)?.name ?? 'Project'}/>
        : !open || !s.draft ? <p className="empty-note">{s.busy ? 'Opening…' : 'Pick a note on the left.'}</p>
        : <>
          {(() => {
            const o = open as { kind: 'conversation' | 'task'; scopeId: string; agentId: string };
            const listed = s.notes.find(x => x.kind === o.kind && x.scopeId === o.scopeId && x.agentId === o.agentId);
            const h = s.current;
            return <div className="mem-handoff-edit-head">
              <div>
                <span className="fine-print">{o.kind === 'task' ? 'Board task' : 'Chat'} · {name(o.agentId)}{listed?.projectId ? ` · ${s.projects.find(p => p.id === listed.projectId)?.name ?? 'project'}` : ''}</span>
                <h3 dir="auto">{listed?.title || (o.kind === 'task' ? 'Board task' : 'Chat')}</h3>
                {h && <span className="fine-print">Version {h.version} · written by {h.source === 'owner' ? 'you' : name(h.agentId)} · {ago(h.createdAt)}</span>}
              </div>
              {o.kind === 'conversation' && onOpenChat && <button type="button" className="link-button" onClick={() => onOpenChat(o.scopeId)}>Open the chat</button>}
            </div>;
          })()}
          <div className="mem-handoff-fields">{FIELDS.map(f => <label key={f.key} className="mem-handoff-field">
            <span data-tone={f.tone === 'link' ? undefined : f.tone} className={f.tone === 'link' ? 'mem-link-text' : undefined}>{f.label}</span>
            <textarea rows={4} dir="auto" value={s.draft![f.key]} placeholder="One item per line" onChange={e => c.edit({ [f.key]: e.target.value })}/>
          </label>)}</div>
          <div className="actions">
            <button type="button" className="primary" disabled={s.busy || !c.changed()} onClick={() => void c.save()}>Save as version {(s.current?.version ?? 0) + 1}</button>
            <button type="button" disabled={s.busy || !c.changed()} onClick={() => c.discard()}>Discard changes</button>
            <span className="fine-print">Keys, passwords and tokens are removed before saving.</span>
          </div>
          {s.notice && <p className="card-notice" role="alert">{s.notice}</p>}
          {s.saved && <p className="memory-status" role="status">{s.saved}</p>}
          <h4 className="mem-handoff-history-head">History (last 20 kept)</h4>
          <ol className="mem-handoff-history">{s.history.map((h, i) => <li key={h.version}>
            <span className="mem-dot" data-health={i === 0 ? 'link' : undefined}/>
            <span><span className="fine-print">v{h.version} · {ago(h.createdAt)} · {h.source === 'owner' ? 'you' : `${name(h.agentId)} (${SOURCE[h.source]})`}</span><span dir="auto">{lineOf(h)}</span></span>
            <button type="button" className="link-button" onClick={() => c.copyIntoEditor(h.version)}>Copy into editor</button>
          </li>)}</ol>
        </>}
      <p className="mem-handoff-foot fine-print">Coding-app notes (Claude Code, Codex …) are shown read-only with their app mark; they are written through the memory bridge.</p>
    </section>
  </div>;
}

function CodingNote({ h, project }: { h: CodingHandoff; project: string }) {
  return <>
    <div className="mem-handoff-edit-head"><div><span className="fine-print">Coding app · {APP[h.client].name} · {project}</span><h3>{project} folder</h3><span className="fine-print">Read only · {ago(h.createdAt)}</span></div></div>
    <div className="mem-handoff-fields">{FIELDS.map(f => <div key={f.key} className="mem-handoff-field"><span data-tone={f.tone === 'link' ? undefined : f.tone} className={f.tone === 'link' ? 'mem-link-text' : undefined}>{f.label}</span>
      <p dir="auto">{h[f.key].length ? h[f.key].join('\n') : '—'}</p></div>)}</div>
  </>;
}
