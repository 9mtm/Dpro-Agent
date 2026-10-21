// MEM-FINISH-01 (board M12): handoff notes, see and edit. Filters agent /
// project / kind; the newest note per chat or board task; the open note's
// done / left / next / questions saved as a new version (the agent's next
// session starts from it); the last 20 versions with "Copy into editor".
// Notes coding apps wrote through the memory bridge are listed read only.
import { Store, codeOf } from './memory-store';
import type { Requester } from './memory-store';
import { queryString } from './memory-pages-contract.js';
import type { CodingHandoff, Handoff, HandoffKind } from './memory-pages-contract.js';
import { PROJECTS_PATH } from './conversation-contract.js';

export type HandoffFilter = 'all' | HandoffKind | 'coding';
export type NoteRef = { kind: HandoffKind; scopeId: string; agentId: string } | { coding: string };
export type HandoffDraft = { done: string; left: string; next: string; questions: string };
export type HandoffsState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'error'; notice?: string; busy: boolean;
  agent: string; project: string; kind: HandoffFilter;
  notes: readonly Handoff[]; coding: readonly CodingHandoff[];
  agents: Readonly<Record<string, string>>; projects: ReadonlyArray<{ id: string; name: string }>;
  open: NoteRef | null; current: Handoff | null; history: readonly Handoff[]; draft: HandoffDraft | null; saved?: string;
}>;

const lines = (x: string) => x.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 8).map(l => l.slice(0, 300));
const toDraft = (h: Pick<Handoff, 'done' | 'left' | 'next' | 'questions'> | null): HandoffDraft => ({ done: (h?.done ?? []).join('\n'), left: (h?.left ?? []).join('\n'), next: (h?.next ?? []).join('\n'), questions: (h?.questions ?? []).join('\n') });

export class MemoryHandoffsController extends Store<HandoffsState> {
  #t = 0;
  constructor(client: Requester) {
    super({ phase: 'idle', busy: false, agent: '', project: '', kind: 'all', notes: [], coding: [], agents: {}, projects: [], open: null, current: null, history: [], draft: null }, client);
  }

  async load() {
    const t = ++this.#t;
    if (this.getSnapshot().phase !== 'ready') this.publish({ phase: 'loading', notice: undefined });
    const s = this.getSnapshot();
    const [notes, coding, agents, projects] = await Promise.all([
      this.read<{ handoffs: Handoff[] }>('/api/handoffs' + queryString({ agentId: s.agent || undefined, projectId: s.project || undefined, limit: 200 })),
      this.read<{ handoffs: CodingHandoff[] }>('/api/handoffs/coding-apps' + queryString({ projectId: s.project || undefined, limit: 200 })),
      Object.keys(s.agents).length ? Promise.resolve(null) : this.read<{ agents: Array<{ id: string; name?: string }> }>('/api/agents'),
      s.projects.length ? Promise.resolve(null) : this.read<{ projects: Array<{ id: string; name: string }> }>(PROJECTS_PATH),
    ]);
    if (t !== this.#t) return;
    if (!notes) { this.publish({ phase: 'error', notice: 'The handoff notes could not be loaded.' }); return; }
    this.publish({
      phase: 'ready', notes: notes.handoffs, coding: coding?.handoffs ?? [],
      ...(agents ? { agents: Object.fromEntries(agents.agents.map(a => [a.id, a.name ?? a.id])) } : {}),
      ...(projects ? { projects: projects.projects.map(p => ({ id: p.id, name: p.name })) } : {}),
    });
    const s2 = this.getSnapshot();
    if (!s2.open) { const first = this.visible()[0]; if (first) await this.openNote(first); }
  }

  setAgent(agent: string) { this.publish({ agent, open: null, current: null, history: [], draft: null }); void this.load(); }
  setProject(project: string) { this.publish({ project, open: null, current: null, history: [], draft: null }); void this.load(); }
  setKind(kind: HandoffFilter) { this.publish({ kind }); }

  /** Counts per kind as the filter list shows them. */
  counts(): Record<HandoffFilter, number> {
    const s = this.getSnapshot();
    const chats = s.notes.filter(n => n.kind === 'conversation').length, tasks = s.notes.filter(n => n.kind === 'task').length;
    const coding = s.agent ? 0 : s.coding.length;
    return { all: chats + tasks + coding, conversation: chats, task: tasks, coding };
  }

  /** The notes the list shows, newest first: agent notes and (without an agent filter) coding-app notes. */
  visible(): Array<{ ref: NoteRef; at: string; note: Handoff | null; coding: CodingHandoff | null }> {
    const s = this.getSnapshot();
    const own = s.kind === 'coding' ? [] : s.notes.filter(n => s.kind === 'all' || n.kind === s.kind).map(n => ({ ref: { kind: n.kind, scopeId: n.scopeId, agentId: n.agentId } as NoteRef, at: n.createdAt, note: n, coding: null }));
    const apps = s.agent || (s.kind !== 'all' && s.kind !== 'coding') ? [] : s.coding.map(c => ({ ref: { coding: c.id } as NoteRef, at: c.createdAt, note: null, coding: c }));
    return [...own, ...apps].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }

  isOpen(ref: NoteRef): boolean {
    const o = this.getSnapshot().open;
    if (!o) return false;
    if ('coding' in o || 'coding' in ref) return 'coding' in o && 'coding' in ref && o.coding === ref.coding;
    return o.kind === ref.kind && o.scopeId === ref.scopeId && o.agentId === ref.agentId;
  }

  async openNote(item: { ref: NoteRef }) {
    const ref = item.ref;
    if ('coding' in ref) { this.publish({ open: ref, current: null, history: [], draft: null, saved: undefined, notice: undefined }); return; }
    this.publish({ open: ref, busy: true, saved: undefined, notice: undefined });
    const r = await this.read<{ handoff: Handoff | null; history: Handoff[] }>(`/api/handoffs/${ref.kind}/${encodeURIComponent(ref.scopeId)}` + queryString({ agentId: ref.agentId }));
    if (!this.isOpen(ref)) return;
    if (!r) { this.publish({ busy: false, notice: 'This note could not be opened.' }); return; }
    this.publish({ busy: false, current: r.handoff, history: r.history, draft: toDraft(r.handoff) });
  }

  edit(p: Partial<HandoffDraft>) { const d = this.getSnapshot().draft; if (d) this.publish({ draft: { ...d, ...p }, saved: undefined }); }
  changed(): boolean { const s = this.getSnapshot(); if (!s.draft) return false; const c = toDraft(s.current); return (Object.keys(c) as (keyof HandoffDraft)[]).some(k => lines(c[k]).join('\n') !== lines(s.draft![k]).join('\n')); }
  discard() { this.publish({ draft: toDraft(this.getSnapshot().current), saved: undefined, notice: undefined }); }
  copyIntoEditor(version: number) { const h = this.getSnapshot().history.find(x => x.version === version); if (h) this.publish({ draft: toDraft(h), saved: undefined }); }

  /** Saves the editor as the next version; the agent's next session starts from it. Keys and passwords are removed by the server. */
  async save() {
    const s = this.getSnapshot();
    const o = s.open; const d = s.draft;
    if (!o || 'coding' in o || !d) return;
    this.publish({ busy: true, notice: undefined, saved: undefined });
    try {
      const r = await this.req('PUT', `/api/handoffs/${o.kind}/${encodeURIComponent(o.scopeId)}`, { agentId: o.agentId, done: lines(d.done), left: lines(d.left), next: lines(d.next), questions: lines(d.questions) });
      if (r.status !== 200) { this.publish({ busy: false, notice: codeOf(r) === 'invalid_handoff' ? 'Keep each item one short line (at most 8 per list), and write at least one.' : codeOf(r) === 'not_found' ? 'This chat or task no longer exists.' : 'The note was not saved.' }); return; }
      const h = (r.body as { handoff: Handoff }).handoff;
      this.publish({ busy: false, saved: `Saved as version ${h.version}.` });
      await this.load();
      if (this.isOpen(o)) await this.openNote({ ref: o });
      this.publish({ saved: `Saved as version ${h.version}.` });
    } catch { this.publish({ busy: false, notice: 'The note was not saved (no connection).' }); }
  }
}
