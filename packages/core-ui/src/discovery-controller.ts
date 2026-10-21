// "Found on this computer" (DISCOVER-01, board M17): what coding agents left on
// this computer, by project folder and kind; import / update / ignore / remove / keep.
import type { SessionClient } from './session';
import { DISCOVERY_PATH, MAX_DISCOVERY_IMPORT } from './discovery-contract.js';
import type { DiscoveryItem, DiscoveryKind, DiscoveryPlace, DiscoveryPreview, DiscoveryResult, DiscoveryState, DiscoveryView, FileKind, MergeSuggestion } from './discovery-contract.js';

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
  /** DISCOVER-02: the folder tree, the owner's pending ticks (id → wanted), counts, and the merge panel. */
  places: { top: readonly DiscoveryPlace[] | null; children: Readonly<Record<string, readonly DiscoveryPlace[]>>; open: readonly string[]; ticks: Readonly<Record<string, boolean>>; counts: Readonly<Record<string, string>> };
  merge: { ids: readonly string[]; name: string } | null;
}>;
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
export const KIND_LABEL: Record<DiscoveryKind, string> = { memory: 'Memory files', note: 'Project notes', tool: 'Commands & sub-agents', skill: 'Skills', mcp: 'MCP servers', ssh: 'SSH hosts' };
export const FILE_KIND_LABEL: Record<FileKind, string> = { notes: 'Agent notes (.md)', tools: 'Agent commands and sub-agents', skills: 'Skills', mcp: 'MCP servers', ssh: 'SSH hosts' };
export const KIND_SHORT: Record<DiscoveryKind, string> = { memory: 'Memory', note: 'Note', tool: 'Tool', skill: 'Skill', mcp: 'MCP', ssh: 'SSH' };
export const STATE_LABEL: Record<DiscoveryState, string> = { new: 'New', changed: 'Changed', decision: 'Needs your decision', imported: 'Imported', ignored: 'Ignored', gone: 'Gone from this computer' };
const CODE_TEXT: Record<string, string> = {
  preview_changed: 'the file changed since you opened it', import_running: 'another import is not finished yet', name_conflict: 'an MCP server with this name exists',
  version_conflict: 'the skill changed in Dpro', skill_in_use: 'an agent still uses this skill', not_removable: 'project notes cannot be taken out one by one',
  inline_secret_requires_manual_setup: 'it has a secret in its command; add it by hand', memory_refused: 'memory refused the change',
  not_imported: 'it was already in Dpro before this page; change it on its own page', skill_name_taken: 'Dpro already has another skill with this name',
  system_folder: 'system folders are never read', not_found: 'that folder is not there',
};
export const codeText = (code?: string) => (code ? CODE_TEXT[code] ?? code.replace(/_/g, ' ') : 'it could not be done');

export class DiscoveryController {
  #state: DiscoveryUiState = Object.freeze({ phase: 'idle', view: null, rootId: null, kind: 'all', state: 'all', selected: [], preview: null, previewLoading: null, secret: 'credentials', busy: false, scanning: false, notice: null, result: null, places: { top: null, children: {}, open: [], ticks: {}, counts: {} }, merge: null });
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
    try {
      // The first read after a start can take longer than one request waits: the server keeps reading, so ask again.
      for (let attempt = 0; attempt < 6 && !this.#disposed; attempt++) {
        const r = await this.request('GET', DISCOVERY_PATH);
        if (r.status === 200 && this.take(r.body)) return;
        if (r.status !== 504 && r.status !== 503) { this.publish({ phase: 'error', notice: r.status === 403 ? 'Only the owner can read this computer, on this computer.' : 'This computer could not be read. Try again.' }); return; }
        await new Promise(res => setTimeout(res, 1500));
      }
      this.publish({ phase: 'error', notice: 'Reading this computer is taking long. Try again in a minute.' });
    } catch { this.publish({ phase: 'error', notice: 'This computer could not be read (no connection).' }); }
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
  private async act(path: string, body: unknown, done: string, method?: string) {
    if (this.#state.busy) return false;
    this.publish({ busy: true, notice: null, result: null });
    try {
      const r = await this.request(method ?? (body === undefined ? 'POST' : path.endsWith('/settings') || path.includes('/roots/') ? 'PUT' : 'POST'), path, body);
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
  // ---- DISCOVER-02: folders you allow ----
  private setPlaces(p: Partial<DiscoveryUiState['places']>) { this.publish({ places: { ...this.#state.places, ...p } }); }
  async loadPlaces() {
    try { const r = await this.request('GET', `${DISCOVERY_PATH}/places`); if (r.status === 200 && record(r.body) && Array.isArray(r.body.places)) this.setPlaces({ top: r.body.places as DiscoveryPlace[] }); }
    catch { /* the tree stays as it was */ }
  }
  async openPlace(id: string) {
    const open = this.#state.places.open;
    if (open.includes(id)) { this.setPlaces({ open: open.filter(x => x !== id) }); return; }
    this.setPlaces({ open: [...open, id] });
    try { const r = await this.request('GET', `${DISCOVERY_PATH}/places?parent=${id}`); if (r.status === 200 && record(r.body) && Array.isArray(r.body.places)) this.setPlaces({ children: { ...this.#state.places.children, [id]: r.body.places as DiscoveryPlace[] } }); }
    catch { /* stays closed in effect */ }
  }
  /** Ticked now: the owner's pending choice, else what is saved (an allowed folder above counts, unless left out). */
  ticked(p: DiscoveryPlace) { const t = this.#state.places.ticks[p.id]; return t ?? (p.state === 'allow' || (p.inherited === 'allow' && p.state !== 'exclude')); }
  tick(p: DiscoveryPlace, on: boolean) {
    const saved = p.state === 'allow' || (p.inherited === 'allow' && p.state !== 'exclude');
    const ticks = { ...this.#state.places.ticks }; if (on === saved) delete ticks[p.id]; else ticks[p.id] = on;
    this.setPlaces({ ticks });
  }
  private allPlaces(): DiscoveryPlace[] { return [...(this.#state.places.top ?? []), ...Object.values(this.#state.places.children).flat()]; }
  /** What "Allow N folders" sends: new folders allowed, allowed ones taken back, subfolders left out or brought back. */
  pendingPlaces() {
    const allow: string[] = [], deny: string[] = [], exclude: string[] = [];
    for (const p of this.allPlaces()) {
      const want = this.#state.places.ticks[p.id]; if (want === undefined) continue;
      if (want) { if (p.state === 'exclude') deny.push(p.id); else if (p.inherited !== 'allow') allow.push(p.id); }
      else if (p.state === 'allow') deny.push(p.id); else if (p.inherited === 'allow') exclude.push(p.id);
    }
    return { allow: [...new Set(allow)], deny: [...new Set(deny)], exclude: [...new Set(exclude)] };
  }
  async applyPlaces() {
    const p = this.pendingPlaces(); const body = Object.fromEntries(Object.entries(p).filter(([, v]) => v.length));
    if (!Object.keys(body).length) return;
    const ok = await this.act(`${DISCOVERY_PATH}/places`, body, `${p.allow.length ? `${p.allow.length} folder${p.allow.length === 1 ? '' : 's'} allowed. ` : ''}${p.deny.length ? `${p.deny.length} changed back. ` : ''}${p.exclude.length ? `${p.exclude.length} left out.` : ''}`.trim(), 'PUT');
    if (ok) { this.setPlaces({ ticks: {} }); await this.refreshPlaces(); }
  }
  private async refreshPlaces() {
    await this.loadPlaces();
    for (const id of this.#state.places.open) { try { const r = await this.request('GET', `${DISCOVERY_PATH}/places?parent=${id}`); if (r.status === 200 && record(r.body) && Array.isArray(r.body.places)) this.setPlaces({ children: { ...this.#state.places.children, [id]: r.body.places as DiscoveryPlace[] } }); } catch { /* keep */ } }
  }
  async addPlace(folder: string) {
    const f = folder.trim(); if (!f) return;
    const ok = await this.act(`${DISCOVERY_PATH}/places`, { path: f }, 'Folder allowed.', 'POST');
    if (ok) await this.refreshPlaces();
  }
  async count(id: string) {
    this.setPlaces({ counts: { ...this.#state.places.counts, [id]: 'counting…' } });
    try {
      const r = await this.request('POST', `${DISCOVERY_PATH}/places/${id}/count`);
      const b = r.body as { files?: number; bytes?: number; capped?: boolean };
      const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
      this.setPlaces({ counts: { ...this.#state.places.counts, [id]: r.status === 200 ? `${b.capped ? 'over ' : ''}${(b.files ?? 0).toLocaleString('en')} files · ${size(b.bytes ?? 0)}` : 'could not count' } });
    } catch { this.setPlaces({ counts: { ...this.#state.places.counts, [id]: 'could not count' } }); }
  }
  setFileKind(kind: FileKind, on: boolean) { return this.act(`${DISCOVERY_PATH}/kinds`, { [kind]: on }, on ? 'Read from the next scan.' : 'No longer read.', 'PUT'); }
  hideKind(rootId: string, kind: DiscoveryKind, on: boolean) { return this.act(`${DISCOVERY_PATH}/roots/${rootId}/hidden`, { kind, on }, on ? `${KIND_LABEL[kind]} from this project are no longer shown.` : 'Shown again.', 'PUT'); }
  async ignoreMany(ids: readonly string[]) {
    let n = 0; for (const id of ids) { try { const r = await this.request('POST', `${DISCOVERY_PATH}/items/${id}/ignore`, { on: true }); if (r.status === 200) n++; } catch { /* counted */ } }
    this.publish({ selected: [], result: `${n} not shown again.` }); await this.reload();
  }
  // ---- merged projects ----
  startMerge(ids: readonly string[], name = '') { this.close(); this.publish({ merge: { ids: [...new Set(ids)], name } }); }
  setMerge(p: Partial<{ ids: string[]; name: string }>) { if (this.#state.merge) this.publish({ merge: { ...this.#state.merge, ...p } }); }
  cancelMerge() { this.publish({ merge: null }); }
  async merge() {
    const m = this.#state.merge; if (!m || m.ids.length < 2 || !m.name.trim()) return;
    const ok = await this.act(`${DISCOVERY_PATH}/groups`, { name: m.name.trim(), roots: [...m.ids] }, `Shown as one project: ${m.name.trim()}. The folders stay where they are.`, 'POST');
    if (ok) { const g = this.#state.view?.roots.find(r => r.name === m.name.trim() && r.group); this.publish({ merge: null, ...(g ? { rootId: g.id } : {}) }); }
  }
  separate(groupId: string) { return this.act(`${DISCOVERY_PATH}/groups/${groupId}`, undefined, 'Shown apart again.', 'DELETE'); }
  dismissSuggestion(s: MergeSuggestion) { return this.act(`${DISCOVERY_PATH}/suggestions/${s.key}/dismiss`, undefined, 'Not suggested again.', 'POST'); }
  dispose() { this.#disposed = true; this.#ticket++; this.#listeners.clear(); }
}
