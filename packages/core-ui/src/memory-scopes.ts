// MEM-UI-01 P1 (boards M1 + M8): the memory scope rail and the scope
// overview. Everything = the memory home (stats, drawers, recently learned,
// what waits, health, import); a project = its pinned facts, topics, who
// uses it, its rules and the project actions (each previewed, then applied
// with the preview's hash and confirm: true).
import { Store, codeOf } from './memory-store';
import type { Requester } from './memory-store';
import { queryString } from './memory-pages-contract.js';
import type { AccessOverview, AccessRule, DoctorReport, EffectiveAccess, ExplorerItem, ExplorerPage, PinnedFact, ProjectAction, ProjectApplied, ProjectExport, ProjectPreview, ScopeTree, TreeProject, WeeklySummary } from './memory-pages-contract.js';
import type { CacheMetrics } from './memory-recall-contract.js';

export type Waiting = { total: number; important: number; conflicts: number; links: number; imported: number; files: number };
export type ImportStatus = { enabled: boolean; intervalMinutes: number; lastRun: number | null; status: string };
export type Usage = { agentId: string; name: string; read: boolean; write: boolean; why: string };
export type ScopeState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'error'; notice?: string;
  tree: ScopeTree | null;
  /** company (Everything), department:<id> or project:<slug>. */
  scope: string;
  find: string; open: readonly string[];
  agents: Readonly<Record<string, string>>;
  // Everything (M1)
  recent: readonly ExplorerItem[]; weekCount: number | null; weekMore: boolean; topics: number | null;
  mapEntities: number | null; mapLinks: number | null;
  waiting: Waiting | null; weekly: WeeklySummary | null; doctor: DoctorReport | null; cacheHit: number | null; importStatus: ImportStatus | null;
  readers: Readonly<Record<string, number>>;
  // A department or a project (M8)
  facts: readonly PinnedFact[]; factsBusy: boolean; topicKeys: readonly string[]; scopeWeek: number | null;
  usage: readonly Usage[] | null; usageChecked: number; rules: readonly AccessRule[];
  // Project actions
  action: ProjectAction | null; preview: ProjectPreview | null; previewBusy: boolean; previewNotice?: string; applied?: ProjectApplied;
}>;

const WEEK = 7 * 86_400_000;
const recentIn = (items: readonly { createdAt: string }[], now: number) => items.filter(i => now - Date.parse(`${i.createdAt}Z`) < WEEK).length;
const record = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);

export class MemoryScopesController extends Store<ScopeState> {
  #ticket = 0;
  constructor(client: Requester, private readonly now = () => Date.now()) {
    super({ phase: 'idle', tree: null, scope: 'company', find: '', open: [], agents: {}, recent: [], weekCount: null, weekMore: false, topics: null, mapEntities: null, mapLinks: null,
      waiting: null, weekly: null, doctor: null, cacheHit: null, importStatus: null, readers: {}, facts: [], factsBusy: false, topicKeys: [], scopeWeek: null, usage: null, usageChecked: 0, rules: [],
      action: null, preview: null, previewBusy: false }, client);
  }

  /** The tree and the open scope's data. `fresh` skips the server's 15 s cache. */
  async load(fresh = false) {
    const first = this.getSnapshot().phase !== 'ready';
    if (first) this.publish({ phase: 'loading', notice: undefined });
    try {
      const r = await this.req('GET', '/api/memory/scopes/tree' + (fresh ? '?fresh=1' : ''));
      if (r.status !== 200) { this.publish({ phase: 'error', notice: r.status === 401 || r.status === 403 ? 'Only the owner can open the memory here.' : 'Memory could not be loaded.' }); return; }
      const tree = r.body as ScopeTree;
      const open = first ? tree.departments.filter(d => d.projects > 0).slice(0, 1).map(d => d.id) : [...this.getSnapshot().open];
      this.publish({ phase: 'ready', tree, open });
      if (!Object.keys(this.getSnapshot().agents).length) void this.loadAgents();
      await this.loadScope();
    } catch { this.publish({ phase: 'error', notice: 'Memory could not be loaded (no connection).' }); }
  }

  async loadAgents() {
    const a = await this.read<{ agents: Array<{ id: string; name?: string }> }>('/api/agents');
    if (!a) return;
    this.publish({ agents: Object.fromEntries(a.agents.map(x => [x.id, x.name ?? x.id])) });
  }

  select(scope: string) {
    if (scope === this.getSnapshot().scope) return;
    this.publish({ scope, facts: [], topicKeys: [], usage: null, usageChecked: 0, rules: [], scopeWeek: null, action: null, preview: null, previewNotice: undefined, applied: undefined });
    void this.loadScope();
  }
  setFind(find: string) { this.publish({ find }); }
  toggle(id: string) { const open = this.getSnapshot().open; this.publish({ open: open.includes(id) ? open.filter(x => x !== id) : [...open, id] }); }

  /** The selected project (null for Everything or a department). */
  project(): TreeProject | null {
    const s = this.getSnapshot();
    return s.scope.startsWith('project:') ? s.tree?.projects.find(p => p.slug === s.scope.slice(8)) ?? null : null;
  }

  private async loadScope() {
    const t = ++this.#ticket;
    const scope = this.getSnapshot().scope;
    if (scope === 'company') await this.loadHome(t);
    else await this.loadOverview(t, scope);
  }

  private async loadHome(t: number) {
    const now = this.now();
    const [recent, topics, entities, links, proposals, pending, doctor, metrics, auto, weekly] = await Promise.all([
      this.read<ExplorerPage>('/api/memory/scopes/memories' + queryString({ scope: 'company', limit: 200 })),
      this.read<ExplorerPage>('/api/memory/scopes/memories' + queryString({ scope: 'company', topic: 'has', limit: 1 })),
      this.read<{ entities: unknown[] }>('/api/memory/graph/entities?limit=500'),
      this.read<{ links: unknown[] }>('/api/memory/graph/links?status=active&limit=500'),
      this.read<{ proposals: Array<{ source: string; reasons: string[]; conflictWith?: string }> }>('/api/memory/proposals?status=pending'),
      this.read<{ links: unknown[] }>('/api/memory/graph/links?status=pending&limit=500'),
      this.read<DoctorReport>('/api/memory/doctor'),
      this.read<CacheMetrics>('/api/memory/cache/metrics'),
      this.read<{ settings: ImportStatus }>('/api/memory/import/local/automatic'),
      this.read<WeeklySummary>('/api/memory/weekly-summary'),
    ]);
    if (t !== this.#ticket) return;
    const items = recent?.items ?? [];
    const props = proposals?.proposals ?? [];
    const conflicts = props.filter(p => p.conflictWith).length;
    const linkCount = pending?.links.length ?? 0;
    this.publish({
      recent: items.slice(0, 6), weekCount: recent ? recentIn(items, now) : null, weekMore: items.length === 200 && recentIn(items, now) === 200,
      topics: topics ? topics.total : null, mapEntities: entities ? entities.entities.length : null, mapLinks: links ? links.links.length : null,
      waiting: proposals ? {
        total: props.length + linkCount, conflicts, links: linkCount,
        important: props.filter(p => !p.conflictWith && (p.source === 'learning' || p.source === 'agent')).length,
        imported: props.filter(p => p.source === 'import').length, files: props.filter(p => p.source === 'file' || p.source === 'upload').length,
      } : null,
      doctor, cacheHit: metrics ? metrics.recent.packHitRate ?? metrics.process.caches.pack.hitRate : null,
      importStatus: auto ? auto.settings : null, weekly,
    });
    void this.loadReaders(t);
  }

  /** How many agents may read each drawer kind (the agents' own permissions). */
  private async loadReaders(t: number) {
    const a = await this.read<{ agents: Array<{ id: string }> }>('/api/agents');
    if (!a) return;
    const readers: Record<string, number> = {};
    await Promise.all(a.agents.slice(0, 60).map(async ag => {
      const p = await this.read<{ memoryRead: string[] }>(`/api/agents/${ag.id}/permissions`);
      if (p && Array.isArray(p.memoryRead)) for (const k of p.memoryRead) readers[k] = (readers[k] ?? 0) + 1;
    }));
    if (t === this.#ticket) this.publish({ readers: { ...readers, _total: Math.min(60, a.agents.length) } });
  }

  private async loadOverview(t: number, scope: string) {
    const now = this.now();
    const [facts, page, keyed, access] = await Promise.all([
      this.read<{ facts: PinnedFact[] }>('/api/memory/scopes/pinned' + queryString({ scope })),
      this.read<ExplorerPage>('/api/memory/scopes/memories' + queryString({ scope: scope, limit: 200 })),
      this.read<ExplorerPage>('/api/memory/scopes/memories' + queryString({ scope: scope, topic: 'has', limit: 200 })),
      this.read<AccessOverview>('/api/memory/access'),
    ]);
    if (t !== this.#ticket) return;
    const keys = [...new Set((keyed?.items ?? []).map(i => i.topicKey).filter((k): k is string => !!k))];
    this.publish({
      facts: facts?.facts ?? [], topicKeys: keys, scopeWeek: page ? recentIn(page.items, now) : null,
      rules: (access?.rules ?? []).filter(r => r.scope === scope || (scope.startsWith('project:') && r.scope === `department:${this.project()?.departmentId}`)),
    });
    if (scope.startsWith('project:')) void this.loadUsage(t, scope.slice(8));
  }

  /** Who may read this project's memory: effective access of the first agents (server checks each). */
  private async loadUsage(t: number, slug: string) {
    const a = await this.read<{ agents: Array<{ id: string; name?: string }> }>('/api/agents');
    if (!a || t !== this.#ticket) return;
    const sample = a.agents.slice(0, 30);
    const rows = await Promise.all(sample.map(ag => this.read<EffectiveAccess>(`/api/memory/access/effective/${encodeURIComponent(ag.id)}` + queryString({ project: slug }))));
    if (t !== this.#ticket) return;
    const usage = rows.filter((x): x is EffectiveAccess => !!x && x.kinds.project.read).map(x => ({
      agentId: x.agentId, name: x.agentName, read: x.kinds.project.read, write: x.kinds.project.write,
      why: x.exceptions.some(e => e.scope === `project:${slug}`) ? 'exception here' : x.template ? `${x.template.name} template` : 'inherited',
    }));
    this.publish({ usage, usageChecked: sample.length });
  }

  // ---- pinned facts ----
  async addFact(text: string) {
    const scope = this.getSnapshot().scope;
    if (!text.trim()) return false;
    this.publish({ factsBusy: true, notice: undefined });
    try {
      const r = await this.req('POST', '/api/memory/scopes/pinned', { scope, text: text.trim() });
      if (r.status !== 201) { this.publish({ factsBusy: false, notice: 'The pinned fact was not saved.' }); return false; }
      this.publish({ factsBusy: false, facts: [...this.getSnapshot().facts, (r.body as { fact: PinnedFact }).fact] });
      return true;
    } catch { this.publish({ factsBusy: false, notice: 'The pinned fact was not saved (no connection).' }); return false; }
  }
  async editFact(id: string, text: string) {
    if (!text.trim()) return false;
    this.publish({ factsBusy: true, notice: undefined });
    try {
      const r = await this.req('PATCH', `/api/memory/scopes/pinned/${id}`, { text: text.trim() });
      if (r.status !== 200) { this.publish({ factsBusy: false, notice: 'The change was not saved.' }); return false; }
      const fact = (r.body as { fact: PinnedFact }).fact;
      this.publish({ factsBusy: false, facts: this.getSnapshot().facts.map(f => (f.id === id ? fact : f)) });
      return true;
    } catch { this.publish({ factsBusy: false, notice: 'The change was not saved (no connection).' }); return false; }
  }
  async removeFact(id: string) {
    this.publish({ factsBusy: true, notice: undefined });
    try {
      const r = await this.req('DELETE', `/api/memory/scopes/pinned/${id}`);
      if (r.status !== 200) { this.publish({ factsBusy: false, notice: 'The pinned fact was not removed.' }); return; }
      this.publish({ factsBusy: false, facts: this.getSnapshot().facts.filter(f => f.id !== id) });
    } catch { this.publish({ factsBusy: false, notice: 'The pinned fact was not removed (no connection).' }); }
  }

  // ---- project actions: preview first, then apply what was previewed ----
  async previewAction(action: ProjectAction, extra: { target?: string; departmentId?: string } = {}) {
    const p = this.project();
    if (!p) return;
    this.publish({ action, preview: null, previewBusy: true, previewNotice: undefined, applied: undefined });
    try {
      const r = await this.req('POST', `/api/memory/scopes/projects/${p.slug}/preview`, { action, ...extra });
      if (r.status !== 200) { this.publish({ previewBusy: false, previewNotice: actionNotice(codeOf(r)) }); return; }
      this.publish({ previewBusy: false, preview: r.body as ProjectPreview });
    } catch { this.publish({ previewBusy: false, previewNotice: 'The preview could not be made (no connection).' }); }
  }
  /** Merge and move first ask where to; the others show their preview at once. */
  startAction(action: ProjectAction) {
    if (action === 'merge' || action === 'move') this.publish({ action, preview: null, previewNotice: undefined, applied: undefined });
    else void this.previewAction(action);
  }
  note(text: string) { this.publish({ notice: text || undefined }); }
  cancelAction() { this.publish({ action: null, preview: null, previewNotice: undefined }); }
  async applyAction() {
    const s = this.getSnapshot(); const p = this.project(); const pv = s.preview;
    if (!p || !pv) return;
    this.publish({ previewBusy: true, previewNotice: undefined });
    const body: Record<string, unknown> = { action: pv.action, expectedPreviewHash: pv.previewHash, confirm: true };
    if (pv.action === 'merge' && pv.target) body.target = pv.target.slug;
    if (pv.action === 'move' && pv.department) body.departmentId = pv.department.id;
    try {
      const r = await this.req('POST', `/api/memory/scopes/projects/${p.slug}/apply`, body);
      if (r.status !== 200) { this.publish({ previewBusy: false, previewNotice: actionNotice(codeOf(r)) }); return; }
      const applied = r.body as ProjectApplied;
      const gone = pv.action === 'forget' || pv.action === 'merge';
      this.publish({ previewBusy: false, preview: null, action: null, applied, ...(gone ? { scope: pv.action === 'merge' && pv.target ? `project:${pv.target.slug}` : 'company' } : {}) });
      await this.load(true);
    } catch { this.publish({ previewBusy: false, previewNotice: 'The change has an unknown outcome (no connection). Load the memory again to see its state.' }); }
  }
  async exportProject(): Promise<ProjectExport | null> {
    const p = this.project();
    if (!p) return null;
    return this.read<ProjectExport>(`/api/memory/scopes/projects/${p.slug}/export`);
  }
}

export function actionNotice(code: string | undefined): string {
  switch (code) {
    case 'preview_changed': return 'The project changed since the preview. Look at the new preview before you confirm.';
    case 'no_change': return 'Nothing to change: the project is already like that.';
    case 'target_archived': return 'The other project is archived. Unarchive it first.';
    case 'not_found': return 'That project or department no longer exists.';
    case 'too_many': return 'Too many memories for one step.';
    default: return 'The change was not made.';
  }
}

/** Plain words for a preview's effects. */
export function effectLines(p: ProjectPreview): string[] {
  const e = p.effects; const n = (k: string) => (typeof e[k] === 'number' ? e[k] as number : 0);
  const mem = `${n('memories')} ${n('memories') === 1 ? 'memory' : 'memories'}`;
  switch (p.action) {
    case 'pin': return ['The project moves to Pinned at the top of the list.'];
    case 'unpin': return ['The project leaves Pinned. Nothing else changes.'];
    case 'archive': return [`${mem} and ${n('pinnedFacts')} pinned facts are kept but never loaded into a reply.`, `${n('conversations')} chats keep their history.`, 'You can unarchive it later.'];
    case 'unarchive': return [`${mem} are loaded into replies again.`];
    case 'move': return [`Moves to ${p.department?.name ?? 'the other department'} with its ${mem}.`, `Inherited access changes for ${n('agentsAffected')} agents (${n('widened')} get more, ${n('narrowed')} get less).`];
    case 'merge': return [`${mem} move into ${p.target?.name ?? 'the other project'}.`, ...(n('topicConflicts') ? [`${n('topicConflicts')} topics exist in both: each waits in Review.`] : []), 'This project is then empty and closed.'];
    case 'forget': return [`${mem}, their history and ${n('pinnedFacts')} pinned facts are removed for good.`, 'This cannot be undone. Export first if you may need them.'];
  }
}
export const isRecord = record;
