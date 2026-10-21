import { SessionFailure } from './session-failure';
export const proposalStatuses = ['pending', 'approved', 'rejected', 'stale', 'cancelled'] as const;
export type ProposalStatus = typeof proposalStatuses[number];
export type MemoryPhase = 'idle' | 'loading' | 'ready' | 'pending' | 'accepted' | 'rejected' | 'stale' | 'expired' | 'denied' | 'error' | 'unavailable' | 'deciding' | 'unknown';
export interface MemoryContext { userId: string; agentId: string; drawerId: string; access: 'owner' | 'denied'; session: string }
export interface Entry { type: string; importance: number; content: string }
export type Change = { op: 'add'; after: Entry } | { op: 'update'; id: string; before: Entry; after: Entry } | { op: 'delete'; id: string; before: Entry };
export interface ProposalSummary {
  id: string; userId: string; agentId: string; drawerId: string; drawer: { kind: string; key?: string };
  reviewHash: string; baseHash: string; baseRevision: number; status: ProposalStatus; source: 'file' | 'upload' | 'learning' | 'agent' | 'import';
  note: string | null; createdBy: string; createdAt: string; decidedBy: string | null; decidedAt: string | null;
  appliedRevision: number | null; reasons: string[]; importBatchId: string | null;
  /** CORE-MEM-CONFLICT: the memory a conflict proposal contradicts, and how it was decided. */
  conflictWith?: string; decision?: 'keep_new' | 'keep_old' | 'keep_both';
}
export interface Proposal extends ProposalSummary { changes: Change[] }
export interface DrawerView { drawerId: string; agentId: string; revision: number; hash: string; count: number; path?: string; content: string }
export interface MemoryRequest { method: 'GET' | 'POST'; path: string; body?: { expectedReviewHash: string } }
export interface MemoryResponse { status: number; body: unknown }
export type MemoryTransport = (request: MemoryRequest, signal?: AbortSignal) => Promise<MemoryResponse>;
export interface Decision { expectedReviewHash: string; id: string; baseRevision: number; baseHash: string; review: string; action: 'approve' | 'reject' }
export interface MemoryAdapter {
  mode: 'fixture' | 'contract';
  uncertainDecisions?: Set<string>;
  drawer(context: MemoryContext, signal?: AbortSignal): Promise<DrawerView>;
  list(context: MemoryContext, signal?: AbortSignal): Promise<ProposalSummary[]>;
  detail(context: MemoryContext, id: string, signal?: AbortSignal): Promise<Proposal>;
  // Contract writes require an injected authenticated owner authorization check.
  decide?: (context: MemoryContext, decision: Decision, signal?: AbortSignal) => Promise<Proposal>;
}
export class MemoryFailure extends Error {
  constructor(readonly phase: 'stale' | 'expired' | 'denied' | 'error' | 'unavailable' | 'unknown', readonly code?: 'already_decided' | 'stale' | 'review_changed' | 'review_hash_required') { super(phase); }
}
const bad = (): never => { throw new MemoryFailure('error'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 50000): string { if (typeof value !== 'string' || value.length > max) return bad(); return value; }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) return bad(); return value as number; }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function timestamp(value: unknown): string {
  const s = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s) || !Number.isFinite(Date.parse(s))) return bad();
  return s;
}
function hash(value: unknown): string { const s = text(value, 64); if (!/^[a-f0-9]{64}$/.test(s)) return bad(); return s; }
export function proposalId(value: unknown): string { const s = text(value, 64); if (!/^[A-Za-z0-9-]{1,64}$/.test(s)) return bad(); return s; }
function identifier(value: unknown): string { const s = text(value, 200); if (!/^[A-Za-z0-9_.@-]+$/.test(s) || s.includes('..')) return bad(); return s; }
export function validDrawer(value: unknown): value is string {
  if (value === 'owner' || value === 'experience') return true;
  if (typeof value !== 'string') return false;
  if (/^project:[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) return true;
  return /^(task|people):[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(value) && !value.includes('..');
}
function drawerRef(value: unknown, id: string) {
  const d = object(value); const kind = text(d.kind, 20); const key = d.key === undefined ? undefined : text(d.key, 128);
  if (!validDrawer(id) || (key === undefined ? kind : `${kind}:${key}`) !== id) return bad();
  return { kind, ...(key === undefined ? {} : { key }) };
}
function contextCheck(c: MemoryContext) {
  if (c.access !== 'owner') throw new MemoryFailure('denied');
  identifier(c.userId); identifier(c.agentId);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(c.agentId) || !validDrawer(c.drawerId) || !c.session) bad();
}
function summary(value: unknown): ProposalSummary {
  const p = object(value); const drawerId = text(p.drawerId, 150);
  if (!proposalStatuses.includes(p.status as ProposalStatus) || !['file', 'upload', 'learning', 'agent', 'import'].includes(p.source as string)) return bad();
  if (!Array.isArray(p.reasons) || p.reasons.length > 500) return bad();
  return {
    id: proposalId(p.id), userId: identifier(p.userId), agentId: identifier(p.agentId), drawerId, drawer: drawerRef(p.drawer, drawerId),
    reviewHash: hash(p.reviewHash), baseHash: hash(p.baseHash), baseRevision: integer(p.baseRevision), status: p.status as ProposalStatus, source: p.source as ProposalSummary['source'],
    note: nullableText(p.note), createdBy: text(p.createdBy), createdAt: timestamp(p.createdAt), decidedBy: nullableText(p.decidedBy),
    decidedAt: p.decidedAt === null ? null : timestamp(p.decidedAt), appliedRevision: p.appliedRevision === null ? null : integer(p.appliedRevision),
    reasons: p.reasons.map(x => text(x)), importBatchId: nullableText(p.importBatchId),
    ...(p.conflictWith ? { conflictWith: identifier(p.conflictWith) } : {}),
    ...(p.decision ? { decision: ['keep_new', 'keep_old', 'keep_both'].includes(p.decision as string) ? p.decision as 'keep_new' | 'keep_old' | 'keep_both' : bad() } : {}),
  };
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some(k => !Object.prototype.hasOwnProperty.call(value, k))) bad();
}
function entry(value: unknown): Entry {
  const e = object(value); exactKeys(e, ['type', 'importance', 'content']); const type = text(e.type, 32); const importance = integer(e.importance);
  if (!/^[a-z][a-z_-]{0,31}$/.test(type) || importance < 1 || importance > 10) return bad();
  return { type, importance, content: text(e.content) };
}
export function parseProposal(value: unknown): Proposal {
  const p = object(value); const s = summary(p);
  if (!Array.isArray(p.changes) || p.changes.length > 500) return bad();
  const changes: Change[] = p.changes.map(value => {
    const c = object(value);
    const keys = c.op === 'add' ? ['op', 'after'] : c.op === 'update' ? ['op', 'id', 'before', 'after'] : c.op === 'delete' ? ['op', 'id', 'before'] : [];
    exactKeys(c, keys);
    if (c.op === 'add') return { op: 'add', after: entry(c.after) };
    if (c.op === 'update') return { op: 'update', id: identifier(c.id), before: entry(c.before), after: entry(c.after) };
    if (c.op === 'delete') return { op: 'delete', id: identifier(c.id), before: entry(c.before) };
    return bad();
  });
  if (s.status === 'pending' && !changes.length) return bad();
  return { ...s, changes };
}
function inScope(p: ProposalSummary, c: MemoryContext) { return p.userId === c.userId && p.agentId === c.agentId && p.drawerId === c.drawerId; }
export function reviewVersion(p: Proposal): string {
  // Exact local snapshot, not a cryptographic hash and never a server parameter.
  return JSON.stringify(parseProposal(p));
}
const uncertaintyByTransport = new WeakMap<MemoryTransport, Set<string>>();
export function createMemoryAdapter(transport: MemoryTransport, authorizeDecision?: (context: MemoryContext) => boolean): MemoryAdapter {
  let uncertainDecisions = uncertaintyByTransport.get(transport);
  if (!uncertainDecisions) { uncertainDecisions = new Set(); uncertaintyByTransport.set(transport, uncertainDecisions); }
  async function get(path: string, signal?: AbortSignal) {
    const response = await transport({ method: 'GET', path }, signal);
    if (response.status === 401 || response.status === 403) throw new MemoryFailure('denied');
    if (response.status === 409) throw new MemoryFailure('stale');
    if (response.status === 404) throw new MemoryFailure('unavailable');
    if (response.status !== 200) return bad();
    return response.body;
  }
  return {
    mode: 'contract', uncertainDecisions,
    async drawer(c, signal) {
      contextCheck(c);
      const d = object(await get(`/api/memory/files/${encodeURIComponent(c.drawerId)}?agentId=${encodeURIComponent(c.agentId)}`, signal));
      drawerRef(d.drawer, text(d.drawerId));
      if (d.drawerId !== c.drawerId || d.agentId !== c.agentId) return bad();
      return { drawerId: c.drawerId, agentId: c.agentId, revision: integer(d.revision), hash: hash(d.hash), count: integer(d.count), content: text(d.content, 2_000_000) };
    },
    async list(c, signal) {
      contextCheck(c);
      // The route has only an optional status filter: it lists up to 200 owner proposals, not an agent-scoped queue.
      const body = object(await get('/api/memory/proposals?status=pending', signal));
      if (!Array.isArray(body.proposals) || body.proposals.length > 200) return bad();
      const all = body.proposals.map(summary);
      if (all.some(p => p.userId !== c.userId || p.status !== 'pending')) return bad();
      return all.filter(p => inScope(p, c));
    },
    async detail(c, id, signal) {
      contextCheck(c); proposalId(id);
      const p = parseProposal(await get(`/api/memory/proposals/${encodeURIComponent(id)}`, signal));
      if (p.id !== id || !inScope(p, c)) return bad();
      return p;
    },
    ...(authorizeDecision ? { async decide(c: MemoryContext, d: Decision, signal?: AbortSignal) {
      contextCheck(c); proposalId(d.id); hash(d.expectedReviewHash);
      if (!authorizeDecision(c) || !['approve', 'reject'].includes(d.action)) throw new MemoryFailure('denied');
      let response: MemoryResponse;
      try { response = await transport({ method: 'POST', path: `/api/memory/proposals/${d.id}/${d.action}`, body: { expectedReviewHash: d.expectedReviewHash } }, signal); }
      catch (error) { throw new MemoryFailure(error instanceof SessionFailure && error.code === 'blocked' ? 'denied' : 'unknown'); }
      if (response.status === 401 || response.status === 403) throw new MemoryFailure('denied');
      if (response.status === 404) throw new MemoryFailure('unavailable');
      const code = response.body && typeof response.body === 'object' ? (response.body as Record<string, unknown>).code : undefined;
      if (response.status === 409 && (code === 'already_decided' || code === 'stale' || code === 'review_changed')) throw new MemoryFailure('stale', code);
      if (response.status === 400 && code === 'review_hash_required') throw new MemoryFailure('error', code);
      if (response.status !== 200) throw new MemoryFailure('unknown');
      try {
        const body = object(response.body);
        const p = parseProposal(d.action === 'approve' ? body.proposal : body);
        if (!p.decidedAt || p.decidedBy !== c.userId || (d.action === 'reject' && p.appliedRevision !== null)) bad();
        if (d.action === 'approve') {
          const applied = object(body.applied);
          if (integer(body.revision) !== p.appliedRevision) bad();
          for (const key of ['added', 'updated', 'deleted']) {
            if (!Array.isArray(applied[key]) || (applied[key] as unknown[]).length > 500) bad();
            const ids = (applied[key] as unknown[]).map(identifier);
            const op = key === 'added' ? 'add' : key === 'updated' ? 'update' : 'delete';
            const changes = p.changes.filter(c => c.op === op);
            if (ids.length !== changes.length || new Set(ids).size !== ids.length || (op !== 'add' && changes.some(c => 'id' in c && !ids.includes(c.id)))) bad();
          }
        }
        if (!inScope(p, c) || p.id !== d.id || p.reviewHash !== d.expectedReviewHash || p.status !== (d.action === 'approve' ? 'approved' : 'rejected')) bad();
        return p;
      } catch { throw new MemoryFailure('unknown'); }
    } } : {}),
  };
}
export interface MemoryState { context: MemoryContext; phase: MemoryPhase; proposals: ProposalSummary[]; drawer?: DrawerView; detail?: Proposal; review?: string; decisionNotice?: string; unknownOutcome?: boolean }
export class MemoryController {
  private generation = 0;
  private abort = new AbortController();
  private reviewedSnapshot?: string;
  private unknown = new Set<string>();
  private key(c: MemoryContext, id: string) { return JSON.stringify([c.userId, id]); }
  private next() { this.abort.abort(); this.abort = new AbortController(); this.reviewedSnapshot = undefined; return ++this.generation; }
  private listeners = new Set<() => void>();
  private state: MemoryState;
  constructor(readonly adapter: MemoryAdapter, context: MemoryContext) { this.unknown = adapter.uncertainDecisions ?? new Set(); this.state = { context: { ...context }, phase: 'idle', proposals: [] }; }
  getSnapshot = (): MemoryState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: MemoryState) { this.state = state; this.listeners.forEach(fn => fn()); }
  setContext(context: MemoryContext) {
    this.next();
    this.publish({ context: { ...context }, phase: context.access === 'owner' ? 'idle' : 'denied', proposals: [] });
  }
  invalidate() { this.setContext(this.state.context); }
  private fail(error: unknown, ticket: number) {
    if (ticket !== this.generation) return;
    const phase = error instanceof MemoryFailure ? error.phase : 'error';
    this.publish({ context: this.state.context, phase, proposals: [] });
  }
  async load() {
    if (this.state.phase === 'deciding') return;
    const ticket = this.next(); const context = this.state.context;
    const unknownOutcome = [...this.unknown].some(key => JSON.parse(key)[0] === context.userId);
    this.publish({ context, phase: 'loading', proposals: [], unknownOutcome });
    try {
      contextCheck(context);
      const drawer = await this.adapter.drawer(context, this.abort.signal);
      if (ticket !== this.generation) return;
      const proposals = await this.adapter.list(context, this.abort.signal);
      if (ticket === this.generation) this.publish({ context, phase: 'ready', drawer, proposals, unknownOutcome });
    } catch (e) { this.fail(e, ticket); }
  }
  async open(id: string) {
    if (this.state.phase === 'deciding' || !this.state.drawer || !this.state.proposals.some(p => p.id === id)) return;
    const previous = this.state; const ticket = this.next();
    this.publish({ ...previous, detail: undefined, review: undefined, phase: 'loading' });
    try {
      const detail = await this.adapter.detail(previous.context, id, this.abort.signal);
      if (ticket !== this.generation) return;
      const phase = detail.status === 'approved' ? 'accepted' : detail.status === 'cancelled' ? 'unavailable' : detail.status;
      this.reviewedSnapshot = reviewVersion(detail);
      const unknownOutcome = this.unknown.has(this.key(previous.context, id));
      this.publish({ ...previous, detail, review: unknownOutcome ? undefined : JSON.stringify([ticket, this.reviewedSnapshot]), phase: unknownOutcome ? 'unknown' : phase, unknownOutcome });
    } catch (e) { this.fail(e, ticket); }
  }
  async decide(action: Decision['action'], reviewed: string) {
    const previous = this.state; const p = previous.detail;
    if ((action !== 'approve' && action !== 'reject') || !p || previous.phase !== 'pending' || !this.adapter.decide) return;
    let snapshot: string;
    try { snapshot = reviewVersion(p); } catch (e) { this.fail(e, this.next()); return; }
    if (reviewed !== previous.review || this.reviewedSnapshot !== snapshot || !previous.drawer || (action === 'approve' && (p.source === 'file' || p.source === 'upload') && p.baseHash !== previous.drawer.hash)) {
      this.fail(new MemoryFailure('stale'), this.next()); return;
    }
    if (this.unknown.has(this.key(previous.context, p.id))) return;
    if (this.adapter.mode === 'contract') this.unknown.add(this.key(previous.context, p.id));
    const ticket = this.next();
    this.publish({ ...previous, phase: 'deciding', review: undefined });
    try {
      const detail = parseProposal(await this.adapter.decide(previous.context, { id: p.id, baseRevision: p.baseRevision, baseHash: p.baseHash, review: snapshot, expectedReviewHash: p.reviewHash, action }, this.abort.signal));
      if (ticket !== this.generation) return;
      if (!inScope(detail, previous.context) || detail.id !== p.id || detail.source !== p.source || detail.reviewHash !== p.reviewHash || detail.baseHash !== p.baseHash || detail.baseRevision !== p.baseRevision || JSON.stringify(detail.changes) !== JSON.stringify(p.changes) || detail.status !== (action === 'approve' ? 'approved' : 'rejected')) return bad();
      this.unknown.delete(this.key(previous.context, p.id));
      this.publish({ ...previous, detail, review: undefined, phase: action === 'approve' ? 'accepted' : 'rejected', proposals: previous.proposals.map(x => x.id === detail.id ? detail : x) });
    } catch (e) {
      // Settle only this attempt's ledger key even when session publication cleared the UI.
      if (e instanceof MemoryFailure && (e.code || e.phase === 'denied' || e.phase === 'unavailable')) this.unknown.delete(this.key(previous.context, p.id));
      if (ticket !== this.generation) return;
      if (e instanceof MemoryFailure && (e.phase === 'denied' || e.phase === 'unavailable')) { this.fail(e, ticket); return; }
      if (this.adapter.mode === 'fixture') { this.fail(e, ticket); return; }
      const code = e instanceof MemoryFailure ? e.code : undefined;
      const unknownOutcome = !code;
      if (unknownOutcome) this.unknown.add(this.key(previous.context, p.id));
      this.publish({ context: previous.context, phase: unknownOutcome ? 'unknown' : 'stale', proposals: [], decisionNotice: code, unknownOutcome });
      // Read-only reconciliation observes current state; it never proves this POST executed.
      try {
        const drawer = await this.adapter.drawer(previous.context, this.abort.signal);
        if (ticket !== this.generation) return;
        const detail = await this.adapter.detail(previous.context, p.id, this.abort.signal);
        if (ticket !== this.generation) return;
        this.publish({ ...this.state, drawer, detail, proposals: [detail], review: undefined });
      } catch (readError) {
        if (ticket !== this.generation) return;
        if (readError instanceof MemoryFailure && readError.phase === 'denied') this.fail(readError, ticket);
      }
    }
  }
}

/**
 * Bulk review of import proposals (MEM-IMPORT-02): the owner reads many short
 * imported memories in one list and approves or rejects the selected ones.
 * Each decision is still its own request carrying that proposal's reviewHash
 * from the detail shown here, so a proposal that changed since it was read is
 * refused (409) and counted as "changed", never applied blindly.
 */
export const MAX_BULK = 100;
export interface BulkState { phase: 'idle' | 'loading' | 'ready' | 'deciding' | 'done' | 'error'; items: Proposal[]; selected: string[]; result?: { done: number; changed: number; failed: number; unknown: number; action: Decision['action'] } }
export class BulkReviewController {
  private state: BulkState = { phase: 'idle', items: [], selected: [] };
  private listeners = new Set<() => void>();
  private abort = new AbortController();
  private readonly unknown: Set<string>;
  constructor(readonly adapter: MemoryAdapter, readonly context: MemoryContext) { this.unknown = adapter.uncertainDecisions ?? new Set(); }
  getSnapshot = (): BulkState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<BulkState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  private key(id: string) { return JSON.stringify([this.context.userId, id]); }
  /** Pending import proposals that only add memories (nothing to compare against), read in full. */
  static eligible(list: ProposalSummary[]): ProposalSummary[] { return list.filter(p => p.status === 'pending' && p.source === 'import').slice(0, MAX_BULK); }
  async load(list: ProposalSummary[]) {
    this.publish({ phase: 'loading', items: [], selected: [], result: undefined });
    try {
      const items: Proposal[] = [];
      for (const s of BulkReviewController.eligible(list)) {
        if (this.unknown.has(this.key(s.id))) continue;
        const p = await this.adapter.detail(this.context, s.id, this.abort.signal);
        if (p.status === 'pending' && p.changes.length > 0 && p.changes.every(c => c.op === 'add')) items.push(p);
      }
      this.publish({ phase: 'ready', items, selected: items.map(p => p.id) });
    } catch { this.publish({ phase: 'error' }); }
  }
  toggle(id: string) { if (this.state.phase !== 'ready') return; const s = this.state.selected; this.publish({ selected: s.includes(id) ? s.filter(x => x !== id) : [...s, id] }); }
  selectAll(on: boolean) { if (this.state.phase === 'ready') this.publish({ selected: on ? this.state.items.map(p => p.id) : [] }); }
  async decide(action: Decision['action']) {
    if (this.state.phase !== 'ready' || !this.adapter.decide || (action !== 'approve' && action !== 'reject')) return;
    const chosen = this.state.items.filter(p => this.state.selected.includes(p.id));
    if (!chosen.length) return;
    this.publish({ phase: 'deciding' });
    const result = { done: 0, changed: 0, failed: 0, unknown: 0, action };
    for (const p of chosen) {
      if (this.adapter.mode === 'contract') this.unknown.add(this.key(p.id));
      try {
        const d = await this.adapter.decide(this.context, { id: p.id, baseRevision: p.baseRevision, baseHash: p.baseHash, review: reviewVersion(p), expectedReviewHash: p.reviewHash, action }, this.abort.signal);
        if (d.id !== p.id || d.reviewHash !== p.reviewHash || d.status !== (action === 'approve' ? 'approved' : 'rejected')) throw new MemoryFailure('unknown');
        this.unknown.delete(this.key(p.id)); result.done++;
      } catch (e) {
        const f = e instanceof MemoryFailure ? e : undefined;
        if (f && (f.code || f.phase === 'denied' || f.phase === 'unavailable')) this.unknown.delete(this.key(p.id));
        if (f?.code) result.changed++; else if (f?.phase === 'unknown') result.unknown++; else result.failed++;
        if (f?.phase === 'denied') break;
      }
    }
    this.publish({ phase: 'done', result });
  }
  dispose() { this.abort.abort(); this.listeners.clear(); }
}
