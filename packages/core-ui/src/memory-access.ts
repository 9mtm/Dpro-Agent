// MEM-UI-01 P8 (board M9): who may read and write memory, set once per level
// (company → department → project) with agent exceptions (optionally until a
// date). Changes collect in a draft; the server previews how many agents and
// projects change; "Apply" sends exactly the previewed changes with the
// preview's hash and confirm: true. "Check one agent" explains its access.
import { Store, codeOf } from './memory-store';
import type { Requester } from './memory-store';
import { DRAWER_KINDS, queryString } from './memory-pages-contract.js';
import type { AccessChange, AccessMode, AccessOverview, AccessPreview, AccessRule, DrawerKind, EffectiveAccess } from './memory-pages-contract.js';

export type Cell = { read: boolean; write: boolean; own: boolean };
export type Level = { key: string; scope: string; agentId: string | null; label: string; note: string };
export type ExceptionDraft = { agentId: string; kind: DrawerKind; access: 'read' | 'write' | 'none'; until: string; reason: string };
export type AccessState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'error'; notice?: string; busy: boolean;
  overview: AccessOverview | null; agents: ReadonlyArray<{ id: string; name: string }>;
  changes: readonly AccessChange[]; preview: AccessPreview | null; showSample: boolean; result?: string;
  checkAgent: string; effective: EffectiveAccess | null;
  exception: ExceptionDraft | null;
}>;

const ruleKey = (scope: string, agentId: string | null | undefined, kind: string) => `${scope}|${agentId ?? ''}|${kind}`;
/** The chain of scopes above (and including) a scope: company, its department, the project. */
export function chain(scope: string, departmentOf: (slug: string) => string): string[] {
  if (scope === 'company') return ['company'];
  if (scope.startsWith('department:')) return ['company', scope];
  const d = departmentOf(scope.slice(8));
  return ['company', ...(d && d !== 'general' ? [`department:${d}`] : []), scope];
}

export class MemoryAccessController extends Store<AccessState> {
  constructor(client: Requester) {
    super({ phase: 'idle', busy: false, overview: null, agents: [], changes: [], preview: null, showSample: false, checkAgent: '', effective: null, exception: null }, client);
  }

  async load() {
    if (this.getSnapshot().phase !== 'ready') this.publish({ phase: 'loading', notice: undefined });
    const [o, a] = await Promise.all([this.read<AccessOverview>('/api/memory/access'), this.read<{ agents: Array<{ id: string; name?: string }> }>('/api/agents')]);
    if (!o) { this.publish({ phase: 'error', notice: 'Access could not be loaded.' }); return; }
    this.publish({ phase: 'ready', overview: o, agents: (a?.agents ?? []).map(x => ({ id: x.id, name: x.name ?? x.id })).sort((x, y) => x.name.localeCompare(y.name)) });
  }

  /** Rules as they would be after the draft (the saved rules with the pending changes on top). */
  private rules(): Map<string, { read: AccessMode; write: AccessMode; endsAt: string | null }> {
    const s = this.getSnapshot();
    const out = new Map<string, { read: AccessMode; write: AccessMode; endsAt: string | null }>();
    for (const r of s.overview?.rules ?? []) if (!r.expired) out.set(ruleKey(r.scope, r.agentId, r.drawerKind), { read: r.read, write: r.write, endsAt: r.endsAt });
    for (const c of s.changes) {
      if (c.op === 'set_rule') out.set(ruleKey(c.scope, c.agentId, c.drawerKind), { read: c.read ?? 'inherit', write: c.write ?? 'inherit', endsAt: c.endsAt ?? null });
      if (c.op === 'clear_rule') out.delete(ruleKey(c.scope, c.agentId, c.drawerKind));
    }
    return out;
  }

  /** One cell of the grid: the access at this level (inherited from above unless set here). */
  cell(levels: readonly Level[], index: number, kind: DrawerKind): Cell {
    const rules = this.rules();
    let read = true, write = true, own = false;
    const lvl = levels[index];
    // Base levels from the top down to this one; an agent row also starts from all base levels.
    const base = lvl.agentId ? levels.filter(l => !l.agentId) : levels.slice(0, index + 1);
    for (const l of base) {
      const r = rules.get(ruleKey(l.scope, null, kind));
      if (r) { if (r.read !== 'inherit') read = r.read === 'allow'; if (r.write !== 'inherit') write = r.write === 'allow'; if (l === lvl) own = true; }
    }
    if (lvl.agentId) {
      for (const l of levels.filter(x => !x.agentId)) {
        const r = rules.get(ruleKey(l.scope, lvl.agentId, kind));
        if (r) { if (r.read !== 'inherit') read = r.read === 'allow'; if (r.write !== 'inherit') write = r.write === 'allow'; if (l.scope === lvl.scope) own = true; }
      }
    }
    return { read, write: read && write, own };
  }
  /** Agent exception rows at a scope (saved or drafted). */
  exceptionAgents(scope: string): string[] {
    return [...new Set([...this.rules().keys()].filter(k => k.startsWith(`${scope}|`) && k.split('|')[1]).map(k => k.split('|')[1]))];
  }
  endsAt(scope: string, agentId: string): string | null {
    for (const [k, r] of this.rules()) if (k.startsWith(`${scope}|${agentId}|`) && r.endsAt) return r.endsAt;
    return null;
  }

  /** Cycles a cell set at its own level: read only → read + write → none → inherited. */
  cycle(level: Level, kind: DrawerKind, current: Cell) {
    const next: AccessChange = !current.own ? { op: 'set_rule', scope: level.scope, agentId: level.agentId, drawerKind: kind, read: 'allow', write: 'deny' }
      : current.read && !current.write ? { op: 'set_rule', scope: level.scope, agentId: level.agentId, drawerKind: kind, read: 'allow', write: 'allow' }
      : current.read && current.write ? { op: 'set_rule', scope: level.scope, agentId: level.agentId, drawerKind: kind, read: 'deny', write: 'deny' }
      : { op: 'clear_rule', scope: level.scope, agentId: level.agentId, drawerKind: kind };
    this.addChange(next);
  }
  private addChange(c: AccessChange) {
    if (c.op !== 'set_rule' && c.op !== 'clear_rule') return;
    const key = ruleKey(c.scope, c.agentId, c.drawerKind);
    const rest = this.getSnapshot().changes.filter(x => !((x.op === 'set_rule' || x.op === 'clear_rule') && ruleKey(x.scope, x.agentId, x.drawerKind) === key));
    // Clearing a rule that was never saved just drops the draft.
    const saved = (this.getSnapshot().overview?.rules ?? []).some(r => ruleKey(r.scope, r.agentId, r.drawerKind) === key);
    const changes = c.op === 'clear_rule' && !saved ? rest : [...rest, c];
    this.publish({ changes, preview: null, result: undefined });
    void this.previewChanges();
  }
  discard() { this.publish({ changes: [], preview: null, showSample: false }); }
  toggleSample() { this.publish({ showSample: !this.getSnapshot().showSample }); }

  /** Asks the server what the draft changes (agents, projects); nothing is saved. */
  async previewChanges(keepNotice = false) {
    const changes = this.getSnapshot().changes;
    if (!changes.length) { this.publish({ preview: null }); return; }
    this.publish({ busy: true, ...(keepNotice ? {} : { notice: undefined }) });
    try {
      const r = await this.req('POST', '/api/memory/access/preview', { changes: [...changes] });
      if (this.getSnapshot().changes !== changes) return;
      this.publish({ busy: false, ...(r.status === 200 ? { preview: r.body as AccessPreview } : { preview: null, notice: accessNotice(codeOf(r)) }) });
    } catch { this.publish({ busy: false, notice: 'The preview did not answer (no connection).' }); }
  }
  /** Saves exactly the previewed changes. */
  async apply() {
    const s = this.getSnapshot();
    if (!s.preview || !s.changes.length) return;
    this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.req('POST', '/api/memory/access/apply', { changes: [...s.changes], expectedPreviewHash: s.preview.previewHash, confirm: true });
      if (r.status !== 200) {
        const code = codeOf(r);
        this.publish({ busy: false, notice: accessNotice(code) });
        if (code === 'preview_changed') { await this.load(); await this.previewChanges(true); }
        return;
      }
      const n = s.preview.agentsAffected;
      this.publish({ busy: false, changes: [], preview: null, showSample: false, result: `Saved. Access changed for ${n} ${n === 1 ? 'agent' : 'agents'}.` });
      await this.load();
      if (s.checkAgent) await this.check(s.checkAgent, null);
    } catch { this.publish({ busy: false, notice: 'The change has an unknown outcome (no connection). Load the page again.' }); }
  }

  /** "Check one agent": its effective access here, with every layer that decided it. */
  async check(agentId: string, project: string | null) {
    this.publish({ checkAgent: agentId, effective: null });
    if (!agentId) return;
    const e = await this.read<EffectiveAccess>(`/api/memory/access/effective/${encodeURIComponent(agentId)}` + queryString({ project: project ?? undefined }));
    if (this.getSnapshot().checkAgent === agentId) this.publish({ effective: e });
  }

  startException() { this.publish({ exception: { agentId: '', kind: 'project', access: 'read', until: '', reason: '' } }); }
  editException(p: Partial<ExceptionDraft>) { const e = this.getSnapshot().exception; if (e) this.publish({ exception: { ...e, ...p } }); }
  cancelException() { this.publish({ exception: null }); }
  /** Puts the exception into the draft (previewed like every change). */
  addException(scope: string) {
    const e = this.getSnapshot().exception;
    if (!e || !e.agentId) return;
    const until = e.until ? new Date(`${e.until}T23:59:00`).toISOString() : null;
    this.publish({ exception: null });
    this.addChange({ op: 'set_rule', scope, agentId: e.agentId, drawerKind: e.kind, read: e.access === 'none' ? 'deny' : 'allow', write: e.access === 'write' ? 'allow' : 'deny', endsAt: until, reason: e.reason.trim() || null });
  }
}

export const KIND_COLUMNS: ReadonlyArray<[DrawerKind, string]> = [['owner', 'About you'], ['project', 'Projects'], ['experience', 'Lessons'], ['task', 'Tasks'], ['people', 'People']];
export const cellText = (c: Cell) => (c.write ? 'R+W' : c.read ? 'R' : '—');
export function accessNotice(code: string | undefined): string {
  switch (code) {
    case 'preview_changed': return 'Access changed meanwhile (maybe in another window). Here is the new preview; look at it before you apply.';
    case 'not_found': return 'An agent, project or department in the change no longer exists.';
    case 'too_many': return 'Too many changes at once. Apply a few, then the rest.';
    default: return 'The change was not accepted. Check it and try again.';
  }
}
/** "Marketing writer template → exception here adds write" from the layers that decided. */
export function whyText(e: EffectiveAccess, kind: DrawerKind): string {
  const k = e.kinds[kind];
  if (!k) return '';
  const word: Record<string, string> = { default: 'default', company: 'company rule', department: 'department rule', project: 'project rule', 'agent-company': 'agent exception (company)', 'agent-department': 'agent exception (department)', 'agent-project': 'agent exception (project)', 'agent-permissions': 'its own permissions', 'role-template': 'template' };
  const steps = [...k.readWhy.filter(w => w.layer !== 'default').map(w => `${w.name ? `${w.name} ` : ''}${word[w.layer]} ${w.value === 'allow' ? 'allows' : 'denies'} read`),
    ...k.writeWhy.filter(w => w.layer !== 'default' && k.read).map(w => `${w.name ? `${w.name} ` : ''}${word[w.layer]} ${w.value === 'allow' ? 'allows' : 'denies'} write${w.endsAt ? ` until ${w.endsAt.slice(0, 10)}` : ''}`)];
  return steps.join(' → ');
}
export const ALL_KINDS = DRAWER_KINDS;
export type { AccessRule };
