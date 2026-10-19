// MEMORY-PAGE-02: the owner's memory items. Drawers with counts, the items
// of the open drawer, search, add, edit, history and forget, and which
// agents may read each drawer (from their permissions).
import type { SessionClient } from './session';
import type { Drawer, MemoryItem, MemoryType, MemoryVersion } from './agent-card-contract.js';

export type DrawerCount = Drawer & { count: number };
export type NewMemory = { type: MemoryType; content: string; importance: number; drawer: Drawer };
export type MemoryState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'error'; busy: boolean;
  items: readonly MemoryItem[]; drawers: readonly DrawerCount[];
  open: string; query: string; found: readonly string[] | null;
  editing: string | null; draft: string; draftImportance: number;
  adding: NewMemory | null;
  history: Readonly<Record<string, readonly MemoryVersion[]>>;
  readers: Readonly<Record<string, readonly string[]>>;
  notice?: string;
  loaded?: number; total?: number; offset: number;
}>;

const record = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
/** A drawer's stable key: "owner", "project:launch", … ("all" lists every item). */
export const drawerId = (d: Drawer) => (d.key ? `${d.kind}:${d.key}` : d.kind);

export class MemoryItemsController {
  #state: MemoryState = Object.freeze({ phase: 'idle', busy: false, offset: 0, items: [], drawers: [], open: 'all', query: '', found: null, editing: null, draft: '', draftImportance: 5, adding: null, history: {}, readers: {} });
  #listeners = new Set<() => void>();
  #disposed = false;
  #loading = false;
  constructor(private readonly client: SessionClient) {}
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  private publish(p: Partial<MemoryState>) { if (this.#disposed) return; this.#state = Object.freeze({ ...this.#state, ...p }); this.#listeners.forEach(fn => fn()); }
  dispose() { this.#disposed = true; this.#listeners.clear(); }
  private req(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) { return this.client.request((body === undefined ? { method, path } : { method, path, body }) as never); }

  /** The items shown: the open drawer, narrowed by the search. */
  visible(source: readonly MemoryItem[] = this.#state.items): MemoryItem[] {
    const s = this.#state;
    let items = s.open === 'all' ? [...source] : source.filter(m => drawerId(m.drawer) === s.open);
    if (s.found) items = items.filter(m => s.found!.includes(m.id));
    else if (s.query.trim()) { const q = s.query.trim().toLowerCase(); items = items.filter(m => m.content.toLowerCase().includes(q) || m.type.includes(q)); }
    return items.sort((a, b) => b.importance - a.importance || b.createdAt.localeCompare(a.createdAt));
  }

  async load(background = false) {
    if (this.#disposed || this.#loading) return;
    if (background && (this.#state.busy || this.#state.editing || this.#state.adding)) return;
    const quiet = background && this.#state.phase === 'ready';
    this.#loading = true;
    if (!quiet) this.publish({ phase: 'loading', notice: undefined, loaded: 0, total: undefined });
    try {
      const items = new Map<string, MemoryItem>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        if (this.#disposed) return;
        const m = await this.req('GET', '/api/memory/page' + (cursor ? `?cursor=${cursor}` : ''));
        if (this.#disposed) return;
        if (m.status !== 200 || !record(m.body) || !Array.isArray(m.body.memories)) { if (!quiet) this.publish({ phase: 'error', notice: m.status === 401 || m.status === 403 ? 'Only the owner can open the memory here.' : 'Memory could not be loaded.' }); return; }
        for (const item of m.body.memories as MemoryItem[]) items.set(item.id, item);
        cursor = m.body.nextCursor;
        if (!quiet) this.publish({ loaded: items.size, total: m.body.total });
        if (cursor) { if (cursors.has(cursor)) throw Error('Repeated memory cursor'); cursors.add(cursor); }
      } while (cursor);
      const d = await this.req('GET', '/api/memory/drawers');
      if (this.#disposed) return;
      if (quiet && (this.#state.busy || this.#state.editing || this.#state.adding)) return;
      const anchor = quiet && this.#state.offset > 0 ? this.visible()[this.#state.offset]?.id : undefined;
      const nextItems = [...items.values()];
      const matches = this.visible(nextItems);
      const anchored = anchor ? matches.findIndex(m => m.id === anchor) : -1;
      const offset = anchored >= 0 ? anchored : Math.min(this.#state.offset, Math.max(0, Math.floor((matches.length - 1) / 50) * 50));
      this.publish({ phase: 'ready', offset, items: nextItems, drawers: d.status === 200 && record(d.body) ? d.body.drawers as DrawerCount[] : [] });
      if (!quiet) void this.loadReaders();
    } catch { if (!quiet) this.publish({ phase: 'error', notice: 'Memory could not be loaded.' }); }
    finally { this.#loading = false; }
  }

  /** Which agents may read each drawer kind (owner view of the team's permissions). */
  async loadReaders() {
    try {
      const a = await this.req('GET', '/api/agents');
      if (a.status !== 200 || !record(a.body) || !Array.isArray(a.body.agents)) return;
      const agents = (a.body.agents as { id: string; name?: string }[]).slice(0, 60);
      const readers: Record<string, string[]> = {};
      await Promise.all(agents.map(async ag => {
        try {
          const p = await this.req('GET', `/api/agents/${ag.id}/permissions`);
          if (p.status === 200 && record(p.body)) for (const k of p.body.memoryRead as string[]) (readers[k] ??= []).push(ag.name ?? ag.id);
        } catch { /* that agent is skipped */ }
      }));
      for (const k of Object.keys(readers)) readers[k].sort((x, y) => x.localeCompare(y));
      this.publish({ readers });
    } catch { /* readers stay unknown */ }
  }

  movePage(direction: -1 | 1) {
    if (this.#state.busy || this.#state.editing || this.#state.adding) return;
    const last = Math.max(0, Math.floor((this.visible().length - 1) / 50) * 50);
    this.publish({ offset: Math.max(0, Math.min(last, this.#state.offset + direction * 50)) });
  }
  reveal(id: string) {
    const index = this.visible().findIndex(m => m.id === id);
    if (index >= 0) this.publish({ offset: Math.floor(index / 50) * 50 });
  }
  openDrawer(id: string) { this.publish({ open: id, editing: null, offset: 0 }); }
  setQuery(query: string) { this.publish({ query, found: null, offset: 0 }); }
  /** Searches by meaning on the server (the box filters by words as you type). */
  async searchServer() {
    const q = this.#state.query.trim();
    if (q.length < 2) return;
    this.publish({ busy: true });
    try {
      const r = await this.req('POST', '/api/memory/search', { query: q.slice(0, 500), limit: 50 });
      this.publish({ busy: false, offset: 0, found: r.status === 200 && record(r.body) ? (r.body.memories as MemoryItem[]).map(m => m.id) : null });
    } catch { this.publish({ busy: false }); }
  }

  startAdd() {
    const open = this.#state.open;
    const [kind, key] = open === 'all' ? ['owner', undefined] : open.split(/:(.*)/s);
    this.publish({ adding: { type: 'fact', content: '', importance: 6, drawer: key ? { kind: kind as Drawer['kind'], key } : { kind: kind as Drawer['kind'] } }, editing: null });
  }
  editAdd(p: Partial<NewMemory>) { const a = this.#state.adding; if (a) this.publish({ adding: { ...a, ...p } }); }
  cancelAdd() { this.publish({ adding: null }); }
  async saveAdd() {
    const a = this.#state.adding;
    if (!a || !a.content.trim()) return;
    const keyed = a.drawer.kind === 'project' || a.drawer.kind === 'task' || a.drawer.kind === 'people';
    const key = a.drawer.kind === 'project' ? a.drawer.key?.trim().toLowerCase().replace(/\s+/g, '-') : a.drawer.key?.trim().replace(/\s+/g, '-');
    if (keyed && !key) { this.publish({ notice: 'Give the project, task or person a short name.' }); return; }
    this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.req('POST', '/api/memory', { type: a.type, content: a.content.trim(), importance: a.importance, drawer: keyed ? { kind: a.drawer.kind, key } : { kind: a.drawer.kind } });
      if (r.status !== 200 || !record(r.body)) { this.publish({ busy: false, notice: r.status === 400 ? 'Check the drawer name: letters, numbers, - or _ only.' : 'The memory was not saved.' }); return; }
      this.publish({ busy: false, adding: null });
      await this.load();
    } catch { this.publish({ busy: false, notice: 'The memory was not saved (no connection).' }); }
  }

  startEdit(id: string) { const m = this.#state.items.find(x => x.id === id); if (m) this.publish({ editing: id, draft: m.content, draftImportance: m.importance, adding: null }); }
  editDraft(draft: string) { this.publish({ draft }); }
  editImportance(n: number) { this.publish({ draftImportance: Math.max(1, Math.min(10, n)) }); }
  cancelEdit() { this.publish({ editing: null }); }
  async saveEdit() {
    const id = this.#state.editing; const m = this.#state.items.find(x => x.id === id);
    if (!id || !m) return;
    const body: Record<string, unknown> = {};
    if (this.#state.draft.trim() && this.#state.draft !== m.content) body.content = this.#state.draft;
    if (this.#state.draftImportance !== m.importance) body.importance = this.#state.draftImportance;
    if (!Object.keys(body).length) { this.publish({ editing: null }); return; }
    this.publish({ busy: true });
    try {
      const r = await this.req('PUT', `/api/memory/${id}`, body);
      if (r.status !== 200 || !record(r.body)) { this.publish({ busy: false, notice: 'The change was not saved.' }); return; }
      const updated = r.body.memory as MemoryItem;
      const history = { ...this.#state.history }; delete history[id];
      this.publish({ busy: false, editing: null, items: this.#state.items.map(x => (x.id === id ? updated : x)), history });
    } catch { this.publish({ busy: false, notice: 'The change was not saved (no connection).' }); }
  }

  async toggleHistory(id: string) {
    if (this.#state.history[id]) { const h = { ...this.#state.history }; delete h[id]; this.publish({ history: h }); return; }
    try {
      const r = await this.req('GET', `/api/memory/${id}/versions`);
      if (r.status === 200 && record(r.body)) this.publish({ history: { ...this.#state.history, [id]: r.body.versions as MemoryVersion[] } });
    } catch { /* history stays closed */ }
  }

  /** Forgets one memory completely (its text and history); cannot be undone. */
  async forget(id: string) {
    this.publish({ busy: true });
    try {
      const r = await this.req('POST', `/api/memory/${id}/forget`);
      if (r.status !== 200) { this.publish({ busy: false, notice: 'The memory was not forgotten.' }); return; }
      this.publish({ busy: false, editing: null });
      await this.load();
    } catch { this.publish({ busy: false, notice: 'The memory was not forgotten (no connection).' }); }
  }
}
