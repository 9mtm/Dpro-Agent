// The desktop Memory window (boards M21–M36): which place is open in the
// sidebar, groups of projects, Trash, a project's Design and Databases views,
// and one undo list for every reversible change (Move to Trash, Move, Edit,
// Pin, groups). Routes that the backend has not shipped yet answer 404; the
// window then says "not available yet" instead of an error.
import { Store, codeOf, drawerName } from './memory-store';
import type { Requester } from './memory-store';
import { queryString } from './memory-pages-contract.js';
import type { ExplorerItem, ExplorerPage, PinnedFact, WeeklySummary } from './memory-pages-contract.js';
import type { DatabaseLevel, ProjectDatabases, ProjectDesign, ProjectGroup, TrashItem, TrashList } from './memory-desktop-contract.js';

/** A sidebar place: Needs you, All memories, a drawer kind, a project, a group, an agent, Archived or Trash. */
export type Place = 'needs' | 'all' | 'owner' | 'experience' | 'tasks' | 'people' | 'agents' | 'archived' | 'trash' | `project:${string}` | `group:${string}` | `agent:${string}`;
export type ProjectView = 'memories' | 'design' | 'databases' | 'files';
/** Views that fill the content area from the ⋯ menu. */
export type Extra = 'map' | 'handoffs' | 'files' | null;
export type Toast = { id: number; text: string; undo: boolean; show?: Place };
export type Missing = 'missing';

export type DesktopState = Readonly<{
  place: Place; projectView: ProjectView; extra: Extra;
  groups: readonly ProjectGroup[] | null | Missing;
  trash: TrashList | null | Missing; trashOpen: string | null;
  design: ProjectDesign | null | Missing; logoOpen: string | null;
  databases: ProjectDatabases | null | Missing; databaseOpen: string | null;
  /** A group's projects with their newest memories. */
  groupItems: Readonly<Record<string, readonly ExplorerItem[]>>;
  /** Pinned facts of the open project (or the company for All memories). */
  pinned: readonly PinnedFact[];
  toast: Toast | null; undoDepth: number; busy: boolean;
  needsMode: 'one' | 'list';
  collapsed: readonly string[];
  /** Projects you joined to a group while groups wait for the backend (shown, never sent). */
  details: 'memory' | 'project' | 'group' | null;
}>;

type Undo = { label: string; run: () => Promise<boolean> };
const placeScope = (p: Place): string | null => p === 'all' ? 'company' : p === 'owner' || p === 'experience' ? p : p === 'tasks' ? 'kind:task' : p === 'people' ? 'kind:people'
  : p.startsWith('project:') || p.startsWith('agent:') ? p : null;
export { placeScope };

/** "flowxtra" → a stable tile colour for a project (or an agent avatar). */
export function tileColour(key: string): string {
  const colours = ['#2F6FED', '#0E9F8E', '#C2410C', '#7C3AED', '#B45309', '#0891B2', '#BE185D', '#4D7C0F', '#6D28D9', '#0F766E'];
  let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return colours[h % colours.length];
}
export const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

export class MemoryDesktopController extends Store<DesktopState> {
  #undo: Undo[] = [];
  #toastId = 0;
  #ticket = 0;
  constructor(client: Requester) {
    super({ place: 'all', projectView: 'memories', extra: null, groups: null, trash: null, trashOpen: null, design: null, logoOpen: null, databases: null, databaseOpen: null,
      groupItems: {}, pinned: [], toast: null, undoDepth: 0, busy: false, needsMode: 'one', collapsed: [], details: null }, client);
  }

  // ---- places ----
  open(place: Place) {
    const s = this.getSnapshot();
    if (place === s.place && !s.extra) return;
    ++this.#ticket;
    this.publish({ place, extra: null, projectView: 'memories', design: null, databases: null, logoOpen: null, databaseOpen: null, trashOpen: null, details: null, pinned: [] });
    if (place === 'trash') void this.loadTrash();
    if (place.startsWith('group:')) void this.loadGroupItems(place.slice(6));
    if (place.startsWith('project:') || place === 'all') void this.loadPinned();
  }
  setView(projectView: ProjectView) {
    this.publish({ projectView, extra: null });
    const slug = this.project();
    if (!slug) return;
    if (projectView === 'design' && this.getSnapshot().design === null) void this.loadDesign(slug);
    if (projectView === 'databases' && this.getSnapshot().databases === null) void this.loadDatabases(slug);
  }
  setExtra(extra: Extra) { this.publish({ extra }); }
  setNeedsMode(needsMode: 'one' | 'list') { this.publish({ needsMode }); }
  showDetails(details: DesktopState['details']) { this.publish({ details }); }
  toggleCollapsed(key: string) { const c = this.getSnapshot().collapsed; this.publish({ collapsed: c.includes(key) ? c.filter(x => x !== key) : [...c, key] }); }
  project(): string | null { const p = this.getSnapshot().place; return p.startsWith('project:') ? p.slice(8) : null; }

  // ---- notices and undo ----
  say(text: string, undo = false, show?: Place) { this.publish({ toast: { id: ++this.#toastId, text, undo, show } }); }
  dismiss(id: number) { if (this.getSnapshot().toast?.id === id) this.publish({ toast: null }); }
  /** Records a reversible change: the notice offers Undo and ⌘Z runs it. */
  remember(label: string, run: () => Promise<boolean>, show?: Place) {
    this.#undo.push({ label, run }); if (this.#undo.length > 30) this.#undo.shift();
    this.publish({ undoDepth: this.#undo.length });
    this.say(label, true, show);
  }
  async undo(): Promise<boolean> {
    const u = this.#undo.pop();
    this.publish({ undoDepth: this.#undo.length });
    if (!u) { this.say('Nothing to undo.'); return false; }
    this.publish({ busy: true });
    const ok = await u.run().catch(() => false);
    this.publish({ busy: false });
    this.say(ok ? `Undone: ${u.label.replace(/\.$/, '')}.` : 'This could not be undone.');
    return ok;
  }

  // ---- Move to Trash (one or several memories) ----
  async trash(items: ReadonlyArray<{ id: string; text: string }>): Promise<boolean> {
    if (!items.length) return false;
    this.publish({ busy: true });
    const done: string[] = [];
    for (const i of items) {
      try { const r = await this.req('DELETE', `/api/memory/${encodeURIComponent(i.id)}`); if (r.status === 200) done.push(i.id); } catch { /* counted below */ }
    }
    this.publish({ busy: false });
    if (!done.length) { this.say('Nothing was moved to Trash.'); return false; }
    const first = items.find(i => i.id === done[0])!;
    this.remember(done.length === 1 ? `Moved to Trash: “${first.text.slice(0, 60)}”.` : `Moved ${done.length} memories to Trash.`, () => this.restoreMany(done), 'trash');
    if (this.getSnapshot().place === 'trash') void this.loadTrash();
    return true;
  }
  private async restoreMany(ids: readonly string[]): Promise<boolean> {
    let ok = 0;
    for (const id of ids) {
      try {
        const r = await this.req('POST', `/api/memory/${encodeURIComponent(id)}/restore`);
        if (r.status === 200) ok++;
        else if (r.status === 404 && codeOf(r) !== 'not_in_trash') { this.say('Restore arrives with the next backend update; the memory stays in its history.'); return false; }
      } catch { /* counted */ }
    }
    if (this.getSnapshot().place === 'trash') void this.loadTrash();
    return ok === ids.length;
  }

  // ---- Trash ----
  async loadTrash() {
    const t = this.#ticket;
    try {
      const r = await this.req('GET', '/api/memory/trash');
      if (t !== this.#ticket && this.getSnapshot().place !== 'trash') return;
      this.publish({ trash: r.status === 200 ? r.body as TrashList : r.status === 404 ? 'missing' : null });
      if (r.status !== 200 && r.status !== 404) this.say('Trash could not be read.');
    } catch { this.publish({ trash: null }); this.say('Trash could not be read (no connection).'); }
  }
  openTrashItem(id: string | null) { this.publish({ trashOpen: id }); }
  async restore(item: TrashItem): Promise<boolean> {
    this.publish({ busy: true });
    let ok = false;
    try {
      const r = item.kind === 'project'
        ? await this.req('POST', `/api/memory/scopes/projects/${encodeURIComponent(item.id.slice(8))}/restore`)
        : await this.req('POST', `/api/memory/${encodeURIComponent(item.id)}/restore`);
      ok = r.status === 200;
    } catch { /* below */ }
    this.publish({ busy: false });
    if (!ok) { this.say('It could not be restored.'); return false; }
    this.say(item.kind === 'project' ? 'The project is back with all its memories.' : `Restored to ${drawerName(item.drawer)}.`);
    this.publish({ trashOpen: null });
    await this.loadTrash();
    return true;
  }
  /** Forget now (one) or Empty Trash (all): the only memory actions that ask first. */
  async forgetForGood(ids?: readonly string[]): Promise<boolean> {
    this.publish({ busy: true });
    try {
      const r = await this.req('POST', '/api/memory/trash/empty', ids ? { confirm: 'EMPTY', ids: [...ids] } : { confirm: 'EMPTY' });
      this.publish({ busy: false });
      if (r.status !== 200) { this.say('Nothing was forgotten.'); return false; }
      const n = (r.body as { forgotten: number }).forgotten;
      this.say(`Forgot ${n} ${n === 1 ? 'memory' : 'memories'} for good.`);
      this.publish({ trashOpen: null });
      await this.loadTrash();
      return true;
    } catch { this.publish({ busy: false }); this.say('Nothing was forgotten (no connection).'); return false; }
  }
  /** ⋯ › Move the whole project to Trash (undo restores it). */
  async trashProject(slug: string, name: string): Promise<boolean> {
    try {
      const r = await this.req('POST', `/api/memory/scopes/projects/${encodeURIComponent(slug)}/trash`);
      if (r.status === 404) { this.say('Moving a whole project to Trash arrives with the next backend update.'); return false; }
      if (r.status !== 200) { this.say('The project was not moved to Trash.'); return false; }
      this.remember(`Moved the project ${name} to Trash.`, async () => (await this.req('POST', `/api/memory/scopes/projects/${encodeURIComponent(slug)}/restore`)).status === 200, 'trash');
      this.open('all');
      return true;
    } catch { this.say('The project was not moved to Trash (no connection).'); return false; }
  }

  // ---- Move, edit, pin: done elsewhere, undone here ----
  moved(id: string, from: string, to: string, text: string) {
    this.remember(`Moved “${text.slice(0, 50)}” to ${drawerName(to)}.`, async () => (await this.req('POST', `/api/memory/${encodeURIComponent(id)}/move`, { drawer: from })).status === 200);
  }
  edited(id: string, before: { content: string; importance: number }) {
    this.remember('Saved the change.', async () => (await this.req('PUT', `/api/memory/${encodeURIComponent(id)}`, before)).status === 200);
  }
  /** History › Bring back: an older text becomes current again (a new version; undo goes back). */
  async bringBack(id: string, now: string, older: string): Promise<boolean> {
    try {
      const r = await this.req('PUT', `/api/memory/${encodeURIComponent(id)}`, { content: older });
      if (r.status !== 200) { this.say('That version was not brought back.'); return false; }
      this.remember('Brought back the older version.', async () => (await this.req('PUT', `/api/memory/${encodeURIComponent(id)}`, { content: now })).status === 200);
      return true;
    } catch { this.say('That version was not brought back (no connection).'); return false; }
  }
  /** Pin a memory for every agent of its project (or the company). */
  async pin(text: string, drawerId: string): Promise<boolean> {
    const scope = drawerId.startsWith('project:') ? drawerId : 'company';
    try {
      const r = await this.req('POST', '/api/memory/scopes/pinned', { scope, text: text.slice(0, 1000) });
      if (r.status !== 200 && r.status !== 201) { this.say('It was not pinned.'); return false; }
      const fact = (r.body as { fact: PinnedFact }).fact;
      this.remember(`Pinned for every agent${scope === 'company' ? '' : ` of ${drawerName(scope)}`}.`, async () => (await this.req('DELETE', `/api/memory/scopes/pinned/${encodeURIComponent(fact.id)}`)).status === 200);
      void this.loadPinned();
      return true;
    } catch { this.say('It was not pinned (no connection).'); return false; }
  }
  async unpin(fact: PinnedFact): Promise<boolean> {
    try {
      const r = await this.req('DELETE', `/api/memory/scopes/pinned/${encodeURIComponent(fact.id)}`);
      if (r.status !== 200) { this.say('It was not unpinned.'); return false; }
      this.remember('Unpinned.', async () => { const b = await this.req('POST', '/api/memory/scopes/pinned', { scope: fact.scope, text: fact.text }); return b.status === 200 || b.status === 201; });
      void this.loadPinned();
      return true;
    } catch { return false; }
  }
  async loadPinned() {
    const place = this.getSnapshot().place;
    const scope = place === 'all' ? 'company' : place.startsWith('project:') ? place : null;
    if (!scope) return;
    const r = await this.read<{ facts: PinnedFact[] }>('/api/memory/scopes/pinned' + queryString({ scope }));
    if (this.getSnapshot().place === place) this.publish({ pinned: r?.facts ?? [] });
  }

  /** ⋯ › Weekly summary (was on the old Home). */
  weekly() { return this.read<WeeklySummary>('/api/memory/weekly-summary'); }

  // ---- groups of projects ----
  async loadGroups() {
    try {
      const r = await this.req('GET', '/api/memory/groups');
      this.publish({ groups: r.status === 200 ? (r.body as { groups: ProjectGroup[] }).groups : r.status === 404 ? 'missing' : this.getSnapshot().groups });
    } catch { /* keeps what it had */ }
  }
  groupOf(slug: string): ProjectGroup | null { const g = this.getSnapshot().groups; return Array.isArray(g) ? (g as readonly ProjectGroup[]).find(x => x.projects.includes(slug)) ?? null : null; }
  private notYet(): boolean {
    if (this.getSnapshot().groups !== 'missing') return false;
    this.say('Groups of projects arrive with the next backend update.');
    return true;
  }
  async createGroup(name: string, projects: readonly string[]): Promise<boolean> {
    if (this.notYet() || !name.trim()) return false;
    // A project is in at most one group: take it out of its old group first.
    for (const slug of projects) { const old = this.groupOf(slug); if (old) await this.setProjects(old.id, old.projects.filter(p => p !== slug)); }
    try {
      const r = await this.req('POST', '/api/memory/groups', { name: name.trim().slice(0, 80), projects: [...projects] });
      if (r.status !== 200 && r.status !== 201) { this.say(codeOf(r) === 'name_taken' ? 'A group with this name exists.' : 'The group was not made.'); return false; }
      const g = (r.body as { group: ProjectGroup }).group;
      await this.loadGroups();
      this.remember(`Made the group ${g.name}.`, async () => { const d = await this.req('DELETE', `/api/memory/groups/${encodeURIComponent(g.id)}`); await this.loadGroups(); return d.status === 200; }, `group:${g.id}`);
      return true;
    } catch { this.say('The group was not made (no connection).'); return false; }
  }
  private async setProjects(id: string, projects: readonly string[]) {
    const r = await this.req('PUT', `/api/memory/groups/${encodeURIComponent(id)}/projects`, { projects: [...projects] });
    return r.status === 200;
  }
  /** Drag a project onto a group (or out: groupId null). */
  async moveToGroup(slug: string, groupId: string | null): Promise<boolean> {
    if (this.notYet()) return false;
    const groups = this.getSnapshot().groups as ProjectGroup[];
    const old = this.groupOf(slug); const target = groupId ? groups.find(g => g.id === groupId) : null;
    if ((old?.id ?? null) === (groupId ?? null)) return false;
    try {
      if (old && !(await this.setProjects(old.id, old.projects.filter(p => p !== slug)))) { this.say('The project was not moved.'); return false; }
      if (target && !(await this.setProjects(target.id, [...target.projects, slug]))) { this.say('The project was not moved.'); await this.loadGroups(); return false; }
      await this.loadGroups();
      this.remember(target ? `Moved ${slug} to ${target.name}.` : `Took ${slug} out of ${old?.name}.`, async () => {
        const back = old ? await this.moveToGroupQuiet(slug, old.id) : await this.moveToGroupQuiet(slug, null);
        return back;
      });
      return true;
    } catch { this.say('The project was not moved (no connection).'); return false; }
  }
  private async moveToGroupQuiet(slug: string, groupId: string | null): Promise<boolean> {
    await this.loadGroups();
    const all = this.getSnapshot().groups; if (!Array.isArray(all)) return false;
    const groups = all as readonly ProjectGroup[];
    const old = this.groupOf(slug); const target = groupId ? groups.find(g => g.id === groupId) : null;
    if (old) await this.setProjects(old.id, old.projects.filter(p => p !== slug));
    if (target) await this.setProjects(target.id, [...target.projects.filter(p => p !== slug), slug]);
    await this.loadGroups();
    return true;
  }
  async updateGroup(id: string, patch: { name?: string; shareWithin?: boolean }): Promise<boolean> {
    if (this.notYet()) return false;
    const before = (this.getSnapshot().groups as ProjectGroup[]).find(g => g.id === id);
    try {
      const r = await this.req('PATCH', `/api/memory/groups/${encodeURIComponent(id)}`, patch);
      if (r.status !== 200) { this.say(codeOf(r) === 'name_taken' ? 'A group with this name exists.' : 'The group was not changed.'); return false; }
      await this.loadGroups();
      if (before) this.remember(patch.name ? `Renamed the group to ${patch.name}.` : patch.shareWithin ? 'Projects in this group may read each other now.' : 'Each project keeps its memory to itself now.',
        async () => (await this.req('PATCH', `/api/memory/groups/${encodeURIComponent(id)}`, patch.name ? { name: before.name } : { shareWithin: before.shareWithin })).status === 200 && (await this.loadGroups(), true));
      return true;
    } catch { return false; }
  }
  /** Ungroup: the projects stay, only the group goes (undo makes it again). */
  async ungroup(id: string): Promise<boolean> {
    if (this.notYet()) return false;
    const g = (this.getSnapshot().groups as ProjectGroup[]).find(x => x.id === id);
    if (!g) return false;
    try {
      const r = await this.req('DELETE', `/api/memory/groups/${encodeURIComponent(id)}`);
      if (r.status !== 200) { this.say('The group was not removed.'); return false; }
      await this.loadGroups();
      if (this.getSnapshot().place === `group:${id}`) this.open('all');
      this.remember(`Ungrouped ${g.name}; its projects stay.`, async () => {
        const b = await this.req('POST', '/api/memory/groups', { name: g.name, shareWithin: g.shareWithin, projects: g.projects, ...(g.label ? { label: g.label } : {}) });
        await this.loadGroups(); return b.status === 200 || b.status === 201;
      });
      return true;
    } catch { return false; }
  }
  private async loadGroupItems(id: string) {
    const g = Array.isArray(this.getSnapshot().groups) ? (this.getSnapshot().groups as ProjectGroup[]).find(x => x.id === id) : null;
    if (!g) return;
    const pages = await Promise.all(g.projects.slice(0, 20).map(slug => this.read<ExplorerPage>('/api/memory/scopes/memories' + queryString({ scope: `project:${slug}`, limit: 8 }))));
    if (this.getSnapshot().place !== `group:${id}`) return;
    this.publish({ groupItems: Object.fromEntries(g.projects.slice(0, 20).map((slug, i) => [slug, pages[i]?.items ?? []])) });
  }

  // ---- a project's Design and Databases ----
  async loadDesign(slug: string) {
    try {
      const r = await this.req('GET', `/api/memory/projects/${encodeURIComponent(slug)}/design`);
      if (this.project() !== slug) return;
      this.publish({ design: r.status === 200 ? r.body as ProjectDesign : r.status === 404 ? 'missing' : null });
    } catch { this.publish({ design: null }); }
  }
  openLogo(path: string | null) { this.publish({ logoOpen: path }); }
  async setLogo(slug: string, patch: { mainLogo?: string | null; notLogo?: string }): Promise<boolean> {
    const before = this.getSnapshot().design;
    try {
      const r = await this.req('PATCH', `/api/memory/projects/${encodeURIComponent(slug)}/design`, patch);
      if (r.status !== 200) { this.say('The design was not changed.'); return false; }
      this.publish({ design: r.body as ProjectDesign, logoOpen: patch.notLogo ? null : this.getSnapshot().logoOpen });
      const prevMain = before && before !== 'missing' ? before.logos.find(l => l.main)?.path ?? null : null;
      if (patch.mainLogo !== undefined) this.remember('Set as the main logo.', async () => (await this.req('PATCH', `/api/memory/projects/${encodeURIComponent(slug)}/design`, { mainLogo: prevMain })).status === 200 && (await this.loadDesign(slug), true));
      else this.say('Not shown as a logo any more. Your file was not changed.');
      return true;
    } catch { return false; }
  }
  async loadDatabases(slug: string) {
    try {
      const r = await this.req('GET', `/api/memory/projects/${encodeURIComponent(slug)}/databases`);
      if (this.project() !== slug) return;
      this.publish({ databases: r.status === 200 ? r.body as ProjectDatabases : r.status === 404 ? 'missing' : null });
    } catch { this.publish({ databases: null }); }
  }
  openDatabase(id: string | null) { this.publish({ databaseOpen: id }); }
  async setLevel(slug: string, databaseId: string, level: DatabaseLevel): Promise<boolean> {
    const d = this.getSnapshot().databases;
    const before = d && d !== 'missing' ? d.databases.find(x => x.id === databaseId)?.level : undefined;
    try {
      const r = await this.req('PATCH', `/api/memory/projects/${encodeURIComponent(slug)}/databases`, { databaseId, level });
      if (r.status !== 200) { this.say('The permission was not changed.'); return false; }
      await this.loadDatabases(slug);
      if (before) this.remember('Changed what agents may do with this database.', async () => (await this.req('PATCH', `/api/memory/projects/${encodeURIComponent(slug)}/databases`, { databaseId, level: before })).status === 200 && (await this.loadDatabases(slug), true));
      return true;
    } catch { return false; }
  }
}
