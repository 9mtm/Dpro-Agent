// "Found on this computer" (DISCOVER-01, board M17): what coding agents left on
// this computer, by project folder and kind; import / update / ignore / remove / keep.
import type { SessionClient } from './session';
import { DISCOVERY_PATH, MAX_DISCOVERY_IMPORT } from './discovery-contract.js';
import type { DiscoveryItem, DiscoveryKind, DiscoveryPreview, DiscoveryResult, DiscoveryState, DiscoveryView } from './discovery-contract.js';

export type DiscoveryUiState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'error';
  view: DiscoveryView | null;
  rootId: string | null;
  kind: 'all' | DiscoveryKind;
  state: 'all' | DiscoveryState;
  selected: readonly string[];
  preview: DiscoveryPreview | null;
  previewLoading: string | null;
  secret: 'credentials' | 'leave';
  busy: boolean;
  scanning: boolean;
  notice: string | null;
  result: string | null;
}>;
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
export const KIND_LABEL: Record<DiscoveryKind, string> = { memory: 'Memory files', note: 'Project notes', skill: 'Skills', mcp: 'MCP servers', ssh: 'SSH hosts' };
export const KIND_SHORT: Record<DiscoveryKind, string> = { memory: 'Memory', note: 'Note', skill: 'Skill', mcp: 'MCP', ssh: 'SSH' };
export const STATE_LABEL: Record<DiscoveryState, string> = { new: 'New', changed: 'Changed', decision: 'Needs your decision', imported: 'Imported', ignored: 'Ignored', gone: 'Gone from this computer' };
const CODE_TEXT: Record<string, string> = {
  preview_changed: 'the file changed since you opened it', import_running: 'another import is not finished yet', name_conflict: 'an MCP server with this name exists',
  version_conflict: 'the skill changed in Dpro', skill_in_use: 'an agent still uses this skill', not_removable: 'project notes cannot be taken out one by one',
  inline_secret_requires_manual_setup: 'it has a secret in its command; add it by hand', memory_refused: 'memory refused the change',
  not_imported: 'it was already in Dpro before this page; change it on its own page', skill_name_taken: 'Dpro already has another skill with this name',
};
export const codeText = (code?: string) => (code ? CODE_TEXT[code] ?? code.replace(/_/g, ' ') : 'it could not be done');

export class DiscoveryController {
  #state: DiscoveryUiState = Object.freeze({ phase: 'idle', view: null, rootId: null, kind: 'all', state: 'all', selected: [], preview: null, previewLoading: null, secret: 'credentials', busy: false, scanning: false, notice: null, result: null });
  #listeners = new Set<() => void>(); #disposed = false; #ticket = 0;
  constructor(private readonly client: SessionClient) {}
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  private publish(p: Partial<DiscoveryUiState>) { if (!this.#disposed) { this.#state = Object.freeze({ ...this.#state, ...p }); this.#listeners.forEach(fn => fn()); } }
  private async request(method: string, path: string, body?: unknown) { return this.client.request({ method, path, ...(body === undefined ? {} : { body }) } as never); }
  private take(view: unknown) {
    if (!record(view) || !Array.isArray(view.items)) return false;
    const v = view as DiscoveryView;
    const ids = new Set(v.items.map(i => i.id));
    const rootId = this.#state.rootId && v.roots.some(r => r.id === this.#state.rootId) ? this.#state.rootId : v.roots.find(r => r.id !== 'computer' && r.fresh > 0)?.id ?? v.roots[0]?.id ?? null;
    this.publish({ phase: 'ready', view: v, rootId, selected: this.#state.selected.filter(id => ids.has(id)) });
    return true;
  }
  async load() {
    if (this.#disposed) return; this.publish({ phase: this.#state.view ? 'ready' : 'loading', notice: null });
    try { const r = await this.request('GET', DISCOVERY_PATH); if (r.status !== 200 || !this.take(r.body)) this.publish({ phase: 'error', notice: r.status === 403 ? 'Only the owner can read this computer, on this computer.' : 'This computer could not be read. Try again.' }); }
    catch { this.publish({ phase: 'error', notice: 'This computer could not be read (no connection).' }); }
  }
  async scan() {
    if (this.#state.scanning) return; this.publish({ scanning: true, notice: null, result: null });
    try { const r = await this.request('POST', `${DISCOVERY_PATH}/scan`); if (r.status !== 200 || !this.take(r.body)) this.publish({ notice: 'The scan did not finish. Try again.' }); }
    catch { this.publish({ notice: 'The scan did not finish (no connection).' }); }
    finally { this.publish({ scanning: false }); }
  }
  setRoot(id: string) { this.publish({ rootId: id, selected: [] }); }
  setKind(kind: 'all' | DiscoveryKind) { this.publish({ kind }); }
  setState(state: 'all' | DiscoveryState) { this.publish({ state }); }
  setSecret(secret: 'credentials' | 'leave') { this.publish({ secret }); }
  /** Items of the chosen project folder with the chosen kind and state. */
  shown(): DiscoveryItem[] {
    const s = this.#state; if (!s.view) return [];
    return s.view.items.filter(i => (i.rootId ?? 'computer') === s.rootId && (s.kind === 'all' || i.kind === s.kind) && (s.state === 'all' || i.state === s.state));
  }
  /** Counts for the chips, within the chosen project folder. */
  counts() {
    const items = (this.#state.view?.items ?? []).filter(i => (i.rootId ?? 'computer') === this.#state.rootId);
    const kind: Record<string, number> = { all: items.length }, state: Record<string, number> = {};
    for (const i of items) { kind[i.kind] = (kind[i.kind] ?? 0) + 1; if (this.#state.kind === 'all' || i.kind === this.#state.kind) state[i.state] = (state[i.state] ?? 0) + 1; }
    return { kind, state };
  }
  toggle(id: string) {
    const s = this.#state.selected;
    if (s.includes(id)) this.publish({ selected: s.filter(x => x !== id) });
    else if (s.length < MAX_DISCOVERY_IMPORT) this.publish({ selected: [...s, id] });
  }
  clear() { this.publish({ selected: [] }); }
  async open(id: string) {
    const ticket = ++this.#ticket; this.publish({ previewLoading: id, preview: null, notice: null, secret: 'credentials' });
    try {
      const r = await this.request('GET', `${DISCOVERY_PATH}/items/${id}`);
      if (ticket !== this.#ticket) return;
      if (r.status === 200 && record(r.body) && record(r.body.item)) this.publish({ preview: r.body.item as DiscoveryPreview, previewLoading: null });
      else this.publish({ previewLoading: null, notice: 'This item could not be opened. Scan again.' });
    } catch { if (ticket === this.#ticket) this.publish({ previewLoading: null, notice: 'This item could not be opened (no connection).' }); }
  }
  close() { this.#ticket++; this.publish({ preview: null, previewLoading: null }); }
  private summary(results: DiscoveryResult[]) {
    const ok = results.filter(r => r.ok).length, bad = results.filter(r => !r.ok);
    const notes = results.some(r => r.ok && r.jobId);
    return `${ok} imported.${notes ? ' The local model reads the project notes now (see Conversations › import progress).' : ''}${bad.length ? ` ${bad.length} not: ${[...new Set(bad.map(b => codeText(b.code)))].join('; ')}.` : ''}`;
  }
  /** Import the opened item (with the owner's choice for an MCP secret). */
  async importOpen() {
    const p = this.#state.preview; if (!p || this.#state.busy) return;
    await this.importWith([{ id: p.id, previewHash: p.previewHash, ...(p.kind === 'mcp' && p.secrets.length ? { secret: this.#state.secret } : {}) }]);
  }
  /** Import the given items: each is previewed first (an MCP secret is left out unless chosen in its preview). */
  async importIds(ids: readonly string[]) {
    if (!ids.length || this.#state.busy) return;
    this.publish({ busy: true, notice: null, result: null });
    const items: { id: string; previewHash: string; secret?: 'leave' }[] = [];
    try {
      for (const id of ids.slice(0, MAX_DISCOVERY_IMPORT)) {
        const r = await this.request('GET', `${DISCOVERY_PATH}/items/${id}`);
        if (r.status === 200 && record(r.body) && record(r.body.item)) { const p = r.body.item as DiscoveryPreview; items.push({ id, previewHash: p.previewHash, ...(p.kind === 'mcp' && p.secrets.length ? { secret: 'leave' as const } : {}) }); }
      }
    } catch { /* counted below */ }
    this.publish({ busy: false });
    if (!items.length) { this.publish({ notice: 'Nothing could be imported. Scan again.' }); return; }
    await this.importWith(items);
  }
  private async importWith(items: { id: string; previewHash: string; secret?: 'credentials' | 'leave' }[]) {
    this.publish({ busy: true, notice: null, result: null });
    try {
      const r = await this.request('POST', `${DISCOVERY_PATH}/import`, { items });
      if (r.status === 200 && record(r.body) && Array.isArray(r.body.results)) {
        this.publish({ result: this.summary(r.body.results as DiscoveryResult[]), selected: [] });
        if (this.#state.preview && items.some(i => i.id === this.#state.preview!.id)) this.publish({ preview: null });
        await this.reload();
      } else this.publish({ notice: 'The import was refused. Open the item again and retry.' });
    } catch { this.publish({ notice: 'Connection lost. Scan again to see what was imported.' }); }
    finally { this.publish({ busy: false }); }
  }
  private async reload() { try { const r = await this.request('GET', DISCOVERY_PATH); if (r.status === 200) this.take(r.body); } catch { /* the next load shows it */ } }
  private async act(path: string, body: unknown, done: string) {
    if (this.#state.busy) return false;
    this.publish({ busy: true, notice: null, result: null });
    try {
      const r = await this.request(body === undefined ? 'POST' : path.endsWith('/settings') || path.includes('/roots/') ? 'PUT' : 'POST', path, body);
      if (r.status === 200) { this.publish({ result: done }); await this.reload(); return true; }
      this.publish({ notice: `Not done: ${codeText(record(r.body) ? String(r.body.code ?? '') : '')}.` }); return false;
    } catch { this.publish({ notice: 'Connection lost. Try again.' }); return false; }
    finally { this.publish({ busy: false }); }
  }
  ignore(id: string, on: boolean) { return this.act(`${DISCOVERY_PATH}/items/${id}/ignore`, { on }, on ? 'Ignored. It is not offered again.' : 'No longer ignored.'); }
  async remove(id: string) { const ok = await this.act(`${DISCOVERY_PATH}/items/${id}/remove`, undefined, 'Taken out of Dpro. The file on this computer is unchanged.'); if (ok) this.close(); }
  keep(id: string) { return this.act(`${DISCOVERY_PATH}/items/${id}/keep`, undefined, 'Kept in Dpro.'); }
  setWatch(watch: boolean, intervalMinutes: 15 | 30 | 60) { return this.act(`${DISCOVERY_PATH}/settings`, { watch, intervalMinutes }, watch ? `Watching: a fresh read every ${intervalMinutes} min (nothing is imported on its own).` : 'Watching is off.'); }
  setRootWatch(id: string, watch: boolean) { return this.act(`${DISCOVERY_PATH}/roots/${id}`, { watch }, watch ? 'Watching this folder again.' : 'This folder is no longer watched.'); }
  dispose() { this.#disposed = true; this.#ticket++; this.#listeners.clear(); }
}
