// MEM-UI-01 P4 (board M4, v2 in M10): the knowledge map. People, projects,
// topics, decisions, agents and places with their links; at most 150 nodes
// on screen; starts from a search or everything, 1–2 links deep around the
// chosen node. Pending links (waiting for the owner) are dashed and can be
// approved or rejected from the side panel.
import { Store } from './memory-store';
import type { Requester } from './memory-store';
import { ENTITY_KINDS, queryString } from './memory-pages-contract.js';
import type { EntityDetail, EntityKind, GraphEntity, GraphLink } from './memory-pages-contract.js';

export const MAX_NODES = 150;
export const KIND_COLOR: Record<EntityKind, string> = { person: '#F0C27A', project: '#4A84FE', topic: '#8FD6B0', agent: '#C79BFF', decision: '#F29BB0', place: '#7FD3E6', task: '#B8C2D6' };
export const KIND_PLURAL: Record<EntityKind, string> = { person: 'People', project: 'Projects', topic: 'Topics', decision: 'Decisions', agent: 'Agents', place: 'Places', task: 'Tasks' };
export type MapState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'error'; notice?: string; busy: boolean;
  entities: readonly GraphEntity[]; links: readonly GraphLink[];
  kinds: readonly EntityKind[]; query: string; depth: 1 | 2; zoom: number;
  selected: string | null; detail: EntityDetail | null;
  positions: Readonly<Record<string, readonly [number, number]>>;
  size: readonly [number, number];
}>;

/** A small force layout (repel all pairs, pull along links, gentle pull to the middle); deterministic. */
export function layout(ids: readonly string[], links: ReadonlyArray<readonly [string, string]>, width = 1000, height = 640): Record<string, [number, number]> {
  const n = ids.length;
  const pos = new Map<string, [number, number]>();
  ids.forEach((id, i) => { const a = (i / Math.max(1, n)) * Math.PI * 2; const r = 0.35 + 0.1 * ((i * 7) % 5) / 5; pos.set(id, [width / 2 + Math.cos(a) * width * r, height / 2 + Math.sin(a) * height * r]); });
  const edges = links.filter(([a, b]) => pos.has(a) && pos.has(b) && a !== b);
  const k = Math.sqrt((width * height) / Math.max(1, n)) * 0.6;
  for (let step = 0; step < 220; step++) {
    const t = 30 * (1 - step / 220) + 1;
    const move = new Map<string, [number, number]>(ids.map(id => [id, [0, 0]]));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const p = pos.get(ids[i])!, q = pos.get(ids[j])!;
      let dx = p[0] - q[0], dy = p[1] - q[1]; const d = Math.max(1, Math.hypot(dx, dy)); dx /= d; dy /= d;
      const f = (k * k) / d;
      const mi = move.get(ids[i])!, mj = move.get(ids[j])!; mi[0] += dx * f; mi[1] += dy * f; mj[0] -= dx * f; mj[1] -= dy * f;
    }
    for (const [a, b] of edges) {
      const p = pos.get(a)!, q = pos.get(b)!;
      let dx = p[0] - q[0], dy = p[1] - q[1]; const d = Math.max(1, Math.hypot(dx, dy)); dx /= d; dy /= d;
      const f = (d * d) / k;
      const ma = move.get(a)!, mb = move.get(b)!; ma[0] -= dx * f; ma[1] -= dy * f; mb[0] += dx * f; mb[1] += dy * f;
    }
    for (const id of ids) {
      const p = pos.get(id)!, m = move.get(id)!;
      m[0] += (width / 2 - p[0]) * 0.02; m[1] += (height / 2 - p[1]) * 0.02;
      const d = Math.max(1, Math.hypot(m[0], m[1]));
      p[0] = Math.min(width - 120, Math.max(10, p[0] + (m[0] / d) * Math.min(d, t)));
      p[1] = Math.min(height - 40, Math.max(10, p[1] + (m[1] / d) * Math.min(d, t)));
    }
  }
  return Object.fromEntries([...pos].map(([id, [x, y]]) => [id, [Math.round(x), Math.round(y)]]));
}

export class MemoryMapController extends Store<MapState> {
  #ticket = 0;
  constructor(client: Requester) {
    super({ phase: 'idle', busy: false, entities: [], links: [], kinds: [...ENTITY_KINDS], query: '', depth: 2, zoom: 1, selected: null, detail: null, positions: {}, size: [1000, 640] }, client);
  }

  async load() {
    const t = ++this.#ticket;
    const s = this.getSnapshot();
    if (s.phase !== 'ready') this.publish({ phase: 'loading', notice: undefined });
    try {
      const [e, active, pending] = await Promise.all([
        this.req('GET', '/api/memory/graph/entities' + queryString({ q: s.query.trim(), limit: MAX_NODES })),
        this.read<{ links: GraphLink[] }>('/api/memory/graph/links?status=active&limit=500'),
        this.read<{ links: GraphLink[] }>('/api/memory/graph/links?status=pending&limit=500'),
      ]);
      if (t !== this.#ticket) return;
      if (e.status !== 200) { this.publish({ phase: 'error', notice: e.status === 401 || e.status === 403 ? 'Only the owner can open the map.' : 'The map could not be loaded.' }); return; }
      const entities = (e.body as { entities: GraphEntity[] }).entities.slice(0, MAX_NODES);
      const links = [...(active?.links ?? []), ...(pending?.links ?? [])];
      this.publish({ phase: 'ready', entities, links });
      this.relayout();
      const sel = this.getSnapshot().selected;
      if (sel && entities.some(x => x.id === sel)) void this.select(sel);
    } catch { this.publish({ phase: 'error', notice: 'The map could not be loaded (no connection).' }); }
  }

  /** The nodes on screen: the chosen kinds; around the selected node only its 1–2 links deep. */
  visible(): { nodes: GraphEntity[]; links: GraphLink[] } {
    const s = this.getSnapshot();
    let nodes = s.entities.filter(e => s.kinds.includes(e.kind));
    const ids = new Set(nodes.map(e => e.id));
    let links = s.links.filter(l => ids.has(l.from.id) && ids.has(l.to.id));
    if (s.selected && ids.has(s.selected)) {
      const near = new Set([s.selected]);
      for (let d = 0; d < s.depth; d++) {
        const level = new Set(near);
        for (const l of links) if (level.has(l.from.id) || level.has(l.to.id)) { near.add(l.from.id); near.add(l.to.id); }
      }
      if (near.size > 1) { nodes = nodes.filter(e => near.has(e.id)); links = links.filter(l => near.has(l.from.id) && near.has(l.to.id)); }
    }
    return { nodes, links };
  }
  private relayout() {
    const { nodes, links } = this.visible();
    const [w, h] = this.getSnapshot().size;
    this.publish({ positions: layout(nodes.map(n => n.id), links.map(l => [l.from.id, l.to.id] as const), w, h) });
  }

  toggleKind(k: EntityKind) { const ks = this.getSnapshot().kinds; this.publish({ kinds: ks.includes(k) ? ks.filter(x => x !== k) : [...ks, k] }); this.relayout(); }
  setQuery(query: string) { this.publish({ query }); }
  setDepth(depth: 1 | 2) { this.publish({ depth }); this.relayout(); }
  /** The canvas size on screen: the layout fills it (at least 360 × 300). */
  fit(width: number, height: number) {
    const size = [Math.max(360, Math.round(width)), Math.max(300, Math.round(height))] as const;
    const [w, h] = this.getSnapshot().size;
    if (Math.abs(size[0] - w) < 24 && Math.abs(size[1] - h) < 24) return;
    this.publish({ size }); this.relayout();
  }
  zoomBy(f: number) { this.publish({ zoom: Math.min(2.5, Math.max(0.4, Math.round(this.getSnapshot().zoom * f * 100) / 100)) }); }
  clearSelection() { this.publish({ selected: null, detail: null }); this.relayout(); }

  async select(id: string) {
    const changed = this.getSnapshot().selected !== id;
    this.publish({ selected: id, ...(changed ? { detail: null } : {}) });
    if (changed) this.relayout();
    try {
      const r = await this.req('GET', `/api/memory/graph/entities/${encodeURIComponent(id)}`);
      if (this.getSnapshot().selected !== id) return;
      this.publish(r.status === 200 ? { detail: r.body as EntityDetail } : { detail: null, notice: 'This node is no longer in the map.' });
    } catch { /* the panel stays empty */ }
  }

  /** Approves or rejects a pending link (owner review). */
  async decideLink(id: string, action: 'approve' | 'reject') {
    this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.req('POST', `/api/memory/graph/links/${encodeURIComponent(id)}/${action}`);
      this.publish({ busy: false, ...(r.status === 200 ? {} : { notice: 'The link was not changed.' }) });
      if (r.status === 200) await this.load();
    } catch { this.publish({ busy: false, notice: 'The link was not changed (no connection).' }); }
  }
}
