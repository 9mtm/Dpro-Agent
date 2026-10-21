// MEM-FINISH-01 (board M13): "Move to another drawer" — from Explorer › Move
// drawer or a reply's "Wrong place". Search the drawers and projects, see who
// reads it before and after, give an optional reason (kept in its history).
// The move is a new version; replies that used it show "moved".
import { Store, codeOf, drawerName } from './memory-store';
import type { Requester } from './memory-store';
import { queryString } from './memory-pages-contract.js';
import type { MemoryDetail, ScopeAgents, ScopeHit, ScopeTree } from './memory-pages-contract.js';
import { memoryMovePath } from './memory-recall-contract.js';

export type MoveTarget = { drawer: string; name: string; note: string };
export type MoveState = Readonly<{
  memory: { id: string; text: string; drawerId: string; topicKey: string | null } | null;
  usedIn: number | null; readersNow: number | null;
  query: string; targets: readonly MoveTarget[]; to: string | null; readersAfter: number | null; reason: string;
  busy: boolean; notice?: string;
}>;

const FIXED: MoveTarget[] = [
  { drawer: 'owner', name: 'About you', note: 'facts and preferences about you' }, { drawer: 'experience', name: 'Lessons', note: 'read by all agents' },
];
/** The access scope and column that decide who reads a drawer. */
function readersQuery(drawer: string): { scope: string; column: string } {
  const i = drawer.indexOf(':');
  const kind = i < 0 ? drawer : drawer.slice(0, i);
  return kind === 'project' ? { scope: drawer, column: 'project' } : { scope: 'company', column: kind };
}

/** Projects (most memories first) and people of the scope tree as move targets, at most 20. */
function treeHits(tree: ScopeTree | null): ScopeHit[] {
  if (!tree) return [];
  const projects = tree.projects.filter(p => !p.archived && !p.mergedInto).sort((a, b) => b.memories - a.memories || a.name.localeCompare(b.name))
    .map(p => ({ kind: 'project' as const, id: p.slug, name: p.name, departmentId: p.departmentId, archived: false, memories: p.memories }));
  const people = tree.people.map(p => ({ kind: 'people' as const, id: p.key, name: p.key, archived: false, memories: p.memories }));
  return [...projects, ...people].slice(0, 20);
}

export class MemoryMoveController extends Store<MoveState> {
  #t = 0;
  constructor(client: Requester, private readonly onMoved?: (id: string, drawer: string) => void) {
    super({ memory: null, usedIn: null, readersNow: null, query: '', targets: FIXED, to: null, readersAfter: null, reason: '', busy: false }, client);
  }

  async open(m: { id: string; text: string; drawerId: string; topicKey?: string | null }) {
    const t = ++this.#t;
    this.publish({ memory: { id: m.id, text: m.text, drawerId: m.drawerId, topicKey: m.topicKey ?? null }, usedIn: null, readersNow: null, query: '', targets: FIXED.filter(x => x.drawer !== m.drawerId), to: null, readersAfter: null, reason: '', notice: undefined });
    const [detail, now] = await Promise.all([
      this.read<{ memory: MemoryDetail }>(`/api/memory/scopes/memories/${encodeURIComponent(m.id)}`),
      this.readers(m.drawerId),
    ]);
    if (t !== this.#t) return;
    this.publish({ usedIn: detail?.memory.usage.usedIn ?? null, readersNow: detail ? detail.memory.readers.count : now,
      ...(detail?.memory.topicKey && !m.topicKey ? { memory: { ...this.getSnapshot().memory!, topicKey: detail.memory.topicKey } } : {}) });
    await this.search('');
  }
  close() { ++this.#t; this.publish({ memory: null, to: null, notice: undefined }); }

  private async readers(drawer: string): Promise<number | null> {
    const q = readersQuery(drawer);
    const r = await this.read<ScopeAgents>('/api/memory/access/agents' + queryString({ scope: q.scope, column: q.column, mode: 'read', limit: 1 }));
    return r ? r.count : null;
  }

  /** Drawers and projects by name (the fixed drawers always first). */
  async search(query: string) {
    const t = this.#t;
    this.publish({ query });
    const here = this.getSnapshot().memory?.drawerId;
    // The fixed drawers stay listed under the matches (board M13).
    const fixed = FIXED.filter(x => x.drawer !== here);
    // An empty box lists the projects (most memories first) and people from the scope tree; the search needs a word.
    const hits: ScopeHit[] = query.trim()
      ? (await this.read<{ hits: ScopeHit[] }>('/api/memory/scopes/search' + queryString({ q: query.trim(), kinds: 'project,people', limit: 20 })))?.hits ?? []
      : treeHits(await this.read<ScopeTree>('/api/memory/scopes/tree'));
    if (t !== this.#t || this.getSnapshot().query !== query) return;
    const found = hits.filter(h => !h.archived).map(h => ({ drawer: `${h.kind}:${h.id}`, name: drawerName(`${h.kind}:${h.id}`).replace(` · ${h.id}`, ` · ${h.name}`), note: `${h.memories} ${h.memories === 1 ? 'memory' : 'memories'}` }))
      .filter(x => x.drawer !== here);
    this.publish({ targets: [...found, ...fixed] });
  }

  async pick(drawer: string) {
    const t = this.#t;
    this.publish({ to: drawer, readersAfter: null });
    const n = await this.readers(drawer);
    if (t === this.#t && this.getSnapshot().to === drawer) this.publish({ readersAfter: n });
  }
  setReason(reason: string) { this.publish({ reason: reason.slice(0, 200) }); }

  /** Moves the memory (a new version). */
  async move(): Promise<boolean> {
    const s = this.getSnapshot();
    if (!s.memory || !s.to) return false;
    this.publish({ busy: true, notice: undefined });
    try {
      const body = s.reason.trim() ? { drawer: s.to, reason: s.reason.trim() } : { drawer: s.to };
      const r = await this.req('POST', memoryMovePath(s.memory.id), body);
      if (r.status !== 200) {
        const code = codeOf(r);
        this.publish({ busy: false, notice: code === 'same_drawer' ? 'It is already in that drawer.' : code === 'topic_key_taken' ? 'That drawer already has a memory on the same topic. Merge them by editing one.' : code === 'not_found' ? 'The memory no longer exists.' : 'The memory was not moved.' });
        return false;
      }
      this.publish({ busy: false });
      this.onMoved?.(s.memory.id, s.to);
      this.close();
      return true;
    } catch { this.publish({ busy: false, notice: 'The memory was not moved (no connection).' }); return false; }
  }
}
