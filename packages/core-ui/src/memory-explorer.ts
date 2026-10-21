// MEM-UI-01 P3 (board M3, v2 in M10): the explorer. One scope at a time
// (everything, a drawer, a project, a person or an agent); the server
// searches, filters, counts and pages. Enter searches by meaning. The side
// panel shows the open memory's topic history with Edit, Move drawer and
// Forget (asks first). Many memories can be selected across pages for a
// bulk move or forget (each confirmed once).
import { Store, codeOf, drawerName } from './memory-store';
import type { Requester } from './memory-store';
import { queryString } from './memory-pages-contract.js';
import type { ExplorerItem, ExplorerPage } from './memory-pages-contract.js';
import type { Drawer, MemoryItem, MemoryType, MemoryVersion } from './agent-card-contract.js';

export type NewMemory = { type: MemoryType; content: string; importance: number; drawer: Drawer; topicKey: string };
export type ExplorerState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'error'; notice?: string; busy: boolean;
  scope: string; query: string; meaning: boolean; type: string; topic: '' | 'has' | 'none';
  items: readonly ExplorerItem[]; total: number; nextCursor: string | null; facets: ExplorerPage['facets'];
  open: string | null; versions: readonly MemoryVersion[] | null; full: string | null;
  editing: boolean; draft: string; draftImportance: number;
  moving: boolean; moveTo: string;
  confirmForget: boolean;
  checked: readonly string[]; bulk: 'move' | 'forget' | null; bulkTo: string; result?: string;
  adding: NewMemory | null;
}>;

const asItem = (m: MemoryItem): ExplorerItem => ({
  id: m.id, type: m.type, preview: m.content.slice(0, 400), drawerId: m.drawer.key ? `${m.drawer.kind}:${m.drawer.key}` : m.drawer.kind, topicKey: m.topicKey ?? null,
  importance: m.importance, layer: m.layer ?? 'factual', createdAt: m.createdAt.slice(0, 19), sourceAgentId: null,
});
const EMPTY_FACETS = { type: {}, layer: {}, drawer: {} };

export class MemoryExplorerController extends Store<ExplorerState> {
  #ticket = 0;
  constructor(client: Requester) {
    super({ phase: 'idle', busy: false, scope: 'company', query: '', meaning: false, type: '', topic: '', items: [], total: 0, nextCursor: null, facets: EMPTY_FACETS,
      open: null, versions: null, full: null, editing: false, draft: '', draftImportance: 5, moving: false, moveTo: '', confirmForget: false,
      checked: [], bulk: null, bulkTo: '', adding: null }, client);
  }

  private path(cursor?: string | null) {
    const s = this.getSnapshot();
    return '/api/memory/scopes/memories' + queryString({ scope: s.scope, q: s.query.trim().slice(0, 200), type: s.type, topic: s.topic, cursor: cursor ?? undefined, limit: 50 });
  }

  /** First page of the current scope, search and filters (words; the server counts). */
  async load() {
    const t = ++this.#ticket;
    this.publish({ phase: this.getSnapshot().phase === 'ready' ? 'ready' : 'loading', busy: true, notice: undefined, meaning: false });
    try {
      const r = await this.req('GET', this.path());
      if (t !== this.#ticket) return;
      if (r.status !== 200) { this.publish({ phase: 'error', busy: false, notice: r.status === 401 || r.status === 403 ? 'Only the owner can open the memory here.' : 'Memory could not be loaded.' }); return; }
      const page = r.body as ExplorerPage;
      this.publish({ phase: 'ready', busy: false, items: page.items, total: page.total, nextCursor: page.nextCursor, facets: page.facets });
    } catch { if (t === this.#ticket) this.publish({ phase: 'error', busy: false, notice: 'Memory could not be loaded (no connection).' }); }
  }
  async more() {
    const s = this.getSnapshot();
    if (!s.nextCursor || s.busy || s.meaning) return;
    const t = this.#ticket;
    this.publish({ busy: true });
    try {
      const r = await this.req('GET', this.path(s.nextCursor));
      if (t !== this.#ticket) return;
      if (r.status !== 200) { this.publish({ busy: false, notice: 'More memories could not be loaded.' }); return; }
      const page = r.body as ExplorerPage;
      const seen = new Set(s.items.map(i => i.id));
      this.publish({ busy: false, items: [...s.items, ...page.items.filter(i => !seen.has(i.id))], nextCursor: page.nextCursor });
    } catch { this.publish({ busy: false, notice: 'More memories could not be loaded (no connection).' }); }
  }
  /** Enter: search all memory by meaning (the server's meaning index). */
  async searchMeaning() {
    const q = this.getSnapshot().query.trim();
    if (q.length < 2) return;
    const t = ++this.#ticket;
    this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.req('POST', '/api/memory/search', { query: q.slice(0, 500), limit: 50 });
      if (t !== this.#ticket) return;
      if (r.status !== 200) { this.publish({ busy: false, notice: 'The meaning search did not answer.' }); return; }
      const found = ((r.body as { memories: MemoryItem[] }).memories ?? []).map(asItem);
      this.publish({ phase: 'ready', busy: false, meaning: true, items: found, total: found.length, nextCursor: null });
    } catch { this.publish({ busy: false, notice: 'The meaning search did not answer (no connection).' }); }
  }

  setScope(scope: string) { this.publish({ scope, open: null, versions: null, checked: [], bulk: null, result: undefined }); void this.load(); }
  setQuery(query: string) { this.publish({ query }); }
  setType(type: string) { this.publish({ type }); void this.load(); }
  setTopic(topic: '' | 'has' | 'none') { this.publish({ topic }); void this.load(); }

  /** Opens a memory in the side panel with its topic history. */
  async openMemory(id: string) {
    this.publish({ open: id, versions: null, full: null, editing: false, moving: false, confirmForget: false, result: undefined });
    try {
      const r = await this.req('GET', `/api/memory/${id}/versions`);
      if (this.getSnapshot().open !== id) return;
      const versions = r.status === 200 ? [...(r.body as { versions: MemoryVersion[] }).versions].sort((a, b) => b.version - a.version) : [];
      const live = versions.find(v => v.change !== 'delete' && v.change !== 'forget');
      this.publish({ versions, full: live?.content ?? this.item(id)?.preview ?? null });
    } catch { if (this.getSnapshot().open === id) this.publish({ versions: [] }); }
  }
  close() { this.publish({ open: null, versions: null, full: null, editing: false, moving: false, confirmForget: false }); }
  item(id: string | null) { return id ? this.getSnapshot().items.find(i => i.id === id) ?? null : null; }

  startEdit() { const s = this.getSnapshot(); const i = this.item(s.open); if (i) this.publish({ editing: true, moving: false, confirmForget: false, draft: s.full ?? i.preview, draftImportance: Math.max(1, i.importance) }); }
  editDraft(draft: string) { this.publish({ draft }); }
  editImportance(n: number) { this.publish({ draftImportance: Math.max(1, Math.min(10, n)) }); }
  cancelEdit() { this.publish({ editing: false }); }
  async saveEdit() {
    const s = this.getSnapshot(); const i = this.item(s.open);
    if (!i || !s.draft.trim()) return;
    const body: Record<string, unknown> = {};
    if (s.draft !== s.full) body.content = s.draft;
    if (s.draftImportance !== i.importance) body.importance = s.draftImportance;
    if (!Object.keys(body).length) { this.publish({ editing: false }); return; }
    this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.req('PUT', `/api/memory/${i.id}`, body);
      if (r.status !== 200) { this.publish({ busy: false, notice: 'The change was not saved.' }); return; }
      const m = (r.body as { memory: MemoryItem }).memory;
      this.publish({ busy: false, editing: false, items: s.items.map(x => (x.id === i.id ? { ...x, preview: m.content.slice(0, 400), importance: m.importance } : x)) });
      await this.openMemory(i.id);
    } catch { this.publish({ busy: false, notice: 'The change was not saved (no connection).' }); }
  }

  startMove() { this.publish({ moving: true, editing: false, confirmForget: false, moveTo: '' }); }
  setMoveTo(moveTo: string) { this.publish({ moveTo }); }
  cancelMove() { this.publish({ moving: false }); }
  async move() {
    const s = this.getSnapshot(); const i = this.item(s.open);
    if (!i || !s.moveTo) return;
    this.publish({ busy: true, notice: undefined });
    const r = await this.moveOne(i.id, s.moveTo);
    if (r !== true) { this.publish({ busy: false, notice: r }); return; }
    this.publish({ busy: false, moving: false, result: `Moved to ${drawerName(s.moveTo)}.`, items: s.items.map(x => (x.id === i.id ? { ...x, drawerId: s.moveTo } : x)) });
  }
  private async moveOne(id: string, drawer: string): Promise<true | string> {
    try {
      const r = await this.req('POST', `/api/memory/${id}/move`, { drawer });
      if (r.status === 200) return true;
      const code = codeOf(r);
      return code === 'same_drawer' ? 'It is already in that drawer.' : code === 'topic_key_taken' ? 'That drawer already has a memory on the same topic. Merge them by editing one.' : code === 'invalid_drawer' ? 'That drawer name is not valid.' : 'The memory was not moved.';
    } catch { return 'The memory was not moved (no connection).'; }
  }

  askForget() { this.publish({ confirmForget: true, editing: false, moving: false }); }
  cancelForget() { this.publish({ confirmForget: false }); }
  /** Forgets the open memory completely (text, history, copies). Cannot be undone. */
  async forget() {
    const s = this.getSnapshot(); const i = this.item(s.open);
    if (!i || !s.confirmForget) return;
    this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.req('POST', `/api/memory/${i.id}/forget`);
      if (r.status !== 200) { this.publish({ busy: false, notice: 'The memory was not forgotten.' }); return; }
      this.publish({ busy: false, confirmForget: false, open: null, versions: null, full: null, items: s.items.filter(x => x.id !== i.id), total: Math.max(0, s.total - 1), result: 'Forgotten for good.' });
    } catch { this.publish({ busy: false, notice: 'The memory was not forgotten (no connection).' }); }
  }

  // ---- bulk across pages ----
  toggleCheck(id: string) { const c = this.getSnapshot().checked; this.publish({ checked: c.includes(id) ? c.filter(x => x !== id) : [...c, id], bulk: null }); }
  checkAllShown(on: boolean) { const s = this.getSnapshot(); const shown = s.items.map(i => i.id); this.publish({ checked: on ? [...new Set([...s.checked, ...shown])] : s.checked.filter(x => !shown.includes(x)), bulk: null }); }
  askBulk(bulk: 'move' | 'forget') { this.publish({ bulk, bulkTo: '' }); }
  setBulkTo(bulkTo: string) { this.publish({ bulkTo }); }
  cancelBulk() { this.publish({ bulk: null }); }
  async runBulk() {
    const s = this.getSnapshot();
    if (!s.bulk || !s.checked.length || (s.bulk === 'move' && !s.bulkTo)) return;
    this.publish({ busy: true, notice: undefined });
    let done = 0, failed = 0;
    for (const id of s.checked) {
      const ok = s.bulk === 'move' ? (await this.moveOne(id, s.bulkTo)) === true
        : await this.req('POST', `/api/memory/${id}/forget`).then(r => r.status === 200, () => false);
      if (ok) done++; else failed++;
    }
    this.publish({ busy: false, bulk: null, checked: [], result: `${done} ${s.bulk === 'move' ? `moved to ${drawerName(s.bulkTo)}` : 'forgotten'}.${failed ? ` ${failed} could not be changed.` : ''}` });
    await this.load();
  }

  // ---- add ----
  startAdd() {
    const scope = this.getSnapshot().scope;
    const i = scope.indexOf(':');
    const kind = (i < 0 ? scope : scope.slice(0, i));
    const drawer: Drawer = ['owner', 'experience'].includes(kind) ? { kind: kind as Drawer['kind'] } : ['project', 'task', 'people'].includes(kind) ? { kind: kind as Drawer['kind'], key: scope.slice(i + 1) } : { kind: 'owner' };
    this.publish({ adding: { type: 'fact', content: '', importance: 6, drawer, topicKey: '' }, open: null });
  }
  editAdd(p: Partial<NewMemory>) { const a = this.getSnapshot().adding; if (a) this.publish({ adding: { ...a, ...p } }); }
  cancelAdd() { this.publish({ adding: null }); }
  async saveAdd() {
    const a = this.getSnapshot().adding;
    if (!a || !a.content.trim()) return;
    const keyed = a.drawer.kind === 'project' || a.drawer.kind === 'task' || a.drawer.kind === 'people';
    const key = a.drawer.kind === 'project' ? a.drawer.key?.trim().toLowerCase().replace(/\s+/g, '-') : a.drawer.key?.trim().replace(/\s+/g, '-');
    if (keyed && !key) { this.publish({ notice: 'Give the project, task or person a short name.' }); return; }
    const topic = a.topicKey.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
    this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.req('POST', '/api/memory', { type: a.type, content: a.content.trim(), importance: a.importance, drawer: keyed ? { kind: a.drawer.kind, key } : { kind: a.drawer.kind }, ...(topic ? { topicKey: topic } : {}) });
      if (r.status !== 200) { this.publish({ busy: false, notice: r.status === 400 ? 'Check the drawer name and the topic: letters, numbers and - only.' : 'The memory was not saved.' }); return; }
      this.publish({ busy: false, adding: null, result: topic ? `Saved under the topic “${topic}”.` : 'Saved.' });
      await this.load();
    } catch { this.publish({ busy: false, notice: 'The memory was not saved (no connection).' }); }
  }
}
