// MEM-UI-01 P4 (board M4, v2 in M10): the knowledge map. People, projects,
// topics, decisions, agents and places with their links; at most 150 nodes
// on screen; starts from a search or everything, 1–2 links deep around the
// chosen node. Pending links (waiting for the owner) are dashed and can be
// approved or rejected from the side panel.
// MEM-FINISH-01 (board M14): the waiting links (one or selected, with the
// text they came from), the map clustered by project, groups that could
// become topics (preview -> make topic with the preview's hash, or "not a
// topic"), Rebuild map; and (board M4) the map as one agent sees it.
import { Store, codeOf } from './memory-store';
import type { Requester } from './memory-store';
import { ENTITY_KINDS, queryString } from './memory-pages-contract.js';
import type { AgentView, EntityDetail, EntityKind, GraphCluster, GraphEntity, GraphLink, GraphSync, MemoryDetail, TopicPreview } from './memory-pages-contract.js';

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
  view: 'map' | 'links' | 'clusters';
  /** '' = the owner's whole map; else the map limited to what this agent may read. */
  asAgent: string; agentView: AgentView | null;
  linkText: Readonly<Record<string, string>>; checkedLinks: readonly string[];
  clusters: readonly GraphCluster[] | null; keys: Readonly<Record<string, string>>; topic: TopicPreview | null; result?: string;
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
    super({ phase: 'idle', busy: false, entities: [], links: [], kinds: [...ENTITY_KINDS], query: '', depth: 2, zoom: 1, selected: null, detail: null, positions: {}, size: [1000, 640],
      view: 'map', asAgent: '', agentView: null, linkText: {}, checkedLinks: [], clusters: null, keys: {}, topic: null }, client);
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
      let entities = (e.body as { entities: GraphEntity[] }).entities.slice(0, MAX_NODES);
      let links = [...(active?.links ?? []), ...(pending?.links ?? [])];
      let agentView: AgentView | null = null;
      if (s.asAgent) {
        agentView = await this.read<AgentView>(`/api/memory/graph/agent-view/${encodeURIComponent(s.asAgent)}` + queryString({ q: s.query.trim(), limit: MAX_NODES }));
        if (t !== this.#ticket) return;
        if (agentView) { entities = agentView.entities.slice(0, MAX_NODES); links = [...agentView.links, ...(pending?.links ?? []).filter(l => agentView!.entities.some(x => x.id === l.from.id) && agentView!.entities.some(x => x.id === l.to.id))]; }
      }
      this.publish({ phase: 'ready', entities, links, agentView });
      if (s.view !== 'map') await this.loadReview();
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

  // ---- board M14: waiting links, clusters → topics, rebuild; board M4: as one agent sees it ----
  setView(view: MapState['view']) { this.publish({ view, result: undefined, notice: undefined }); if (view !== 'map') void this.loadReview(); }
  setAgent(asAgent: string) { this.publish({ asAgent, selected: null, detail: null }); void this.load(); }
  pending(): GraphLink[] { return this.getSnapshot().links.filter(l => l.status === 'pending'); }

  /** The waiting links' source text and the topic suggestions. */
  async loadReview() {
    const s = this.getSnapshot();
    const need = [...new Set(this.pending().map(l => l.memoryIds[0]).filter((id): id is string => !!id && !(id in s.linkText)))].slice(0, 30);
    const [clusters, ...texts] = await Promise.all([
      this.read<{ clusters: GraphCluster[] }>('/api/memory/graph/clusters?limit=50'),
      ...need.map(id => this.read<{ memory: MemoryDetail }>(`/api/memory/scopes/memories/${encodeURIComponent(id)}`)),
    ]);
    const linkText = { ...this.getSnapshot().linkText };
    need.forEach((id, i) => { const m = texts[i]?.memory; if (m) linkText[id] = m.content; });
    const keys = { ...this.getSnapshot().keys };
    for (const c of clusters?.clusters ?? []) if (!(c.id in keys)) keys[c.id] = c.suggestedTopicKey ?? '';
    this.publish({ linkText, clusters: clusters?.clusters ?? [], keys });
  }
  toggleLink(id: string) { const x = this.getSnapshot().checkedLinks; this.publish({ checkedLinks: x.includes(id) ? x.filter(y => y !== id) : [...x, id] }); }
  /** Approves or rejects every selected waiting link (one call each). */
  async decideSelected(action: 'approve' | 'reject') {
    const ids = this.getSnapshot().checkedLinks.filter(id => this.pending().some(l => l.id === id));
    if (!ids.length) return;
    this.publish({ busy: true, notice: undefined, result: undefined });
    let done = 0;
    for (const id of ids) {
      try { const r = await this.req('POST', `/api/memory/graph/links/${encodeURIComponent(id)}/${action}`); if (r.status === 200) done++; } catch { /* counted below */ }
    }
    this.publish({ busy: false, checkedLinks: [], result: `${done} ${done === 1 ? 'link' : 'links'} ${action === 'approve' ? 'approved' : 'rejected'}${done < ids.length ? `; ${ids.length - done} could not be changed` : ''}.` });
    await this.load();
  }
  showOnMap(entityId: string) { this.publish({ view: 'map' }); void this.select(entityId); }

  setKey(clusterId: string, key: string) { this.publish({ keys: { ...this.getSnapshot().keys, [clusterId]: key }, topic: this.getSnapshot().topic?.cluster.id === clusterId ? null : this.getSnapshot().topic }); }
  /** What making the group a topic would do (changes nothing). */
  async previewTopic(clusterId: string) {
    const key = this.getSnapshot().keys[clusterId]?.trim();
    this.publish({ busy: true, notice: undefined, result: undefined, topic: null });
    try {
      const r = await this.req('POST', `/api/memory/graph/clusters/${clusterId}/topic-preview`, key ? { topicKey: key } : {});
      this.publish({ busy: false, ...(r.status === 200 ? { topic: (r.body as { preview: TopicPreview }).preview } : { notice: codeOf(r) === 'not_found' ? 'This group changed; it is no longer suggested.' : 'Use a topic key of small letters, digits, dots or dashes.' }) });
    } catch { this.publish({ busy: false, notice: 'The preview could not be made (no connection).' }); }
  }
  /** Gives the previewed memory the topic key (a new version); stops when anything changed since the preview. */
  async makeTopic() {
    const p = this.getSnapshot().topic;
    if (!p || p.blocked || !p.target) return;
    this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.req('POST', `/api/memory/graph/clusters/${p.cluster.id}/topic`, { topicKey: p.topicKey, expectedPreviewHash: p.previewHash, confirm: true });
      if (r.status !== 200) { const code = codeOf(r); this.publish({ busy: false, topic: null, notice: code === 'stale' ? 'The group changed since the preview. Preview it again.' : code === 'key_taken' ? 'Another memory of this drawer already has that key.' : 'The topic was not made.' }); return; }
      this.publish({ busy: false, topic: null, result: `“${p.topicKey}” is now a topic: later saves on it update one memory with its history.` });
      await this.loadReview();
    } catch { this.publish({ busy: false, notice: 'The topic was not made (no connection).' }); }
  }
  cancelTopic() { this.publish({ topic: null }); }
  async dismiss(clusterId: string) {
    this.publish({ busy: true, notice: undefined, result: undefined });
    try {
      const r = await this.req('POST', `/api/memory/graph/clusters/${clusterId}/dismiss`);
      if (r.status !== 200) { this.publish({ busy: false, notice: 'That did not work.' }); return; }
      this.publish({ busy: false, clusters: (this.getSnapshot().clusters ?? []).filter(c => c.id !== clusterId), topic: null, result: 'Not a topic: it is not suggested again until it changes.' });
    } catch { this.publish({ busy: false, notice: 'That did not work (no connection).' }); }
  }
  /** Rebuild map: index memories without a current map entry and remove leftovers. */
  async rebuild() {
    this.publish({ busy: true, notice: undefined, result: undefined });
    try {
      const r = await this.req('POST', '/api/memory/graph/sync', {});
      if (r.status !== 200) { this.publish({ busy: false, notice: 'The map was not rebuilt.' }); return; }
      const x = r.body as GraphSync;
      this.publish({ busy: false, result: `Map rebuilt: ${x.indexed} memories read, ${x.pruned.links + x.pruned.entities} leftovers removed.` });
      await this.load();
    } catch { this.publish({ busy: false, notice: 'The map was not rebuilt (no connection).' }); }
  }
}

