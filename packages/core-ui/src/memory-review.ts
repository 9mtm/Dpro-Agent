// MEM-UI-01 P2 (board M2): the review inbox. Everything that waits for the
// owner in one list — conflicts, important facts, agent changes, imports,
// file edits and new links in the knowledge map. A conflict is decided keep
// new / keep old / keep both (POST …/decide with the review hash of what was
// shown); other proposals are approved or rejected with their review hash;
// links are approved or rejected. Bulk actions skip conflicts (one by one).
import { Store, codeOf, drawerName, oneLine, agentLabel } from './memory-store';
import type { Requester } from './memory-store';
import { parseProposal } from './memory';
import type { Proposal, ProposalSummary } from './memory';
import type { DecideResult, GraphLink } from './memory-pages-contract.js';

export type ReviewKind = 'conflict' | 'important' | 'agent' | 'imported' | 'file' | 'link';
export type ReviewFilter = 'all' | ReviewKind;
export type ReviewItem = { key: string; kind: ReviewKind; id: string; drawerId: string; agent: string; createdAt: string; summary?: ProposalSummary & { counts?: { add: number; update: number; delete: number } }; link?: GraphLink };
export type ReviewState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'error'; notice?: string;
  items: readonly ReviewItem[]; texts: Readonly<Record<string, string>>;
  filter: ReviewFilter; open: string | null; checked: readonly string[];
  detail: Proposal | null; detailBusy: boolean; busy: boolean;
  editing: string | null; confirmBulk: 'approve' | 'reject' | null; result?: string;
  agents: Readonly<Record<string, string>>;
}>;

export const FILTERS: ReadonlyArray<[ReviewFilter, string]> = [['all', 'All'], ['important', 'Important'], ['conflict', 'Conflicts'], ['link', 'New links'], ['imported', 'Imported'], ['file', 'File edits'], ['agent', 'Agent changes']];
export const KIND_WORD: Record<ReviewKind, string> = { conflict: 'Conflict', important: 'Important', agent: 'Agent change', imported: 'Imported', file: 'File edit', link: 'Link' };
const ORDER: ReviewKind[] = ['conflict', 'important', 'agent', 'link', 'file', 'imported'];

/** Conflicts; important new facts (learned, or saved by an agent); agent edits and forgets; imports; file edits. */
export function kindOf(p: ProposalSummary & { counts?: { add: number; update: number; delete: number } }): ReviewKind {
  if (p.conflictWith) return 'conflict';
  if (p.source === 'import') return 'imported';
  if (p.source === 'file' || p.source === 'upload') return 'file';
  if (p.source === 'agent' && (!p.counts || p.counts.update + p.counts.delete > 0)) return 'agent';
  return 'important';
}
/** Reasons in plain words (machine details such as ids are left out). */
export const plainReasons = (reasons: readonly string[]) => reasons.filter(r => /^[a-z][a-z _-]{0,40}$/i.test(r));
/** The proposal's text for the list: what it adds or changes to. */
export function proposalText(p: Proposal): string {
  const c = p.changes[0];
  if (!c) return p.note ?? '';
  const text = 'after' in c ? c.after.content : c.before.content;
  return (c.op === 'delete' ? 'Forget: ' : '') + oneLine(text) + (p.changes.length > 1 ? ` (+${p.changes.length - 1} more)` : '');
}
const linkText = (l: GraphLink) => `${l.from.name} — ${l.type.replace(/_/g, ' ')} → ${l.to.name}`;

export class MemoryReviewController extends Store<ReviewState> {
  #ticket = 0;
  constructor(client: Requester, private readonly onChanged: () => void = () => {}) {
    super({ phase: 'idle', items: [], texts: {}, filter: 'all', open: null, checked: [], detail: null, detailBusy: false, busy: false, editing: null, confirmBulk: null, agents: {} }, client);
  }

  visible(): ReviewItem[] {
    const s = this.getSnapshot();
    return s.filter === 'all' ? [...s.items] : s.items.filter(i => i.kind === s.filter);
  }
  count(f: ReviewFilter) { const s = this.getSnapshot(); return f === 'all' ? s.items.length : s.items.filter(i => i.kind === f).length; }

  async load() {
    const t = ++this.#ticket;
    if (this.getSnapshot().phase !== 'ready') this.publish({ phase: 'loading', notice: undefined });
    try {
      const [p, l, a] = await Promise.all([
        this.req('GET', '/api/memory/proposals?status=pending'),
        this.read<{ links: GraphLink[] }>('/api/memory/graph/links?status=pending&limit=500'),
        this.read<{ agents: Array<{ id: string; name?: string }> }>('/api/agents'),
      ]);
      if (t !== this.#ticket) return;
      if (p.status !== 200) { this.publish({ phase: 'error', notice: p.status === 401 || p.status === 403 ? 'Only the owner reviews memory.' : 'The review list could not be loaded.' }); return; }
      const proposals = (p.body as { proposals: ReviewItem['summary'][] }).proposals.filter((x): x is NonNullable<ReviewItem['summary']> => !!x && x.status === 'pending');
      const items: ReviewItem[] = [
        ...proposals.map(x => ({ key: `p:${x.id}`, kind: kindOf(x), id: x.id, drawerId: x.drawerId, agent: x.agentId, createdAt: x.createdAt, summary: x })),
        ...(l?.links ?? []).map(x => ({ key: `l:${x.id}`, kind: 'link' as const, id: x.id, drawerId: '', agent: '', createdAt: x.createdAt, link: x })),
      ].sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind) || x.createdAt.localeCompare(y.createdAt));
      const texts: Record<string, string> = { ...this.getSnapshot().texts };
      for (const i of items) if (i.link) texts[i.key] = linkText(i.link);
      const keys = new Set(items.map(i => i.key));
      const s = this.getSnapshot();
      const open = s.open && keys.has(s.open) ? s.open : items[0]?.key ?? null;
      this.publish({ phase: 'ready', items, texts, open, checked: s.checked.filter(k => keys.has(k)), agents: a ? Object.fromEntries(a.agents.map(x => [x.id, x.name ?? x.id])) : s.agents });
      if (open && open !== s.open) void this.openItem(open);
      else if (open && !this.getSnapshot().detail) void this.openItem(open);
      void this.loadTexts(t, items.filter(i => i.summary && !texts[i.key]));
    } catch { this.publish({ phase: 'error', notice: 'The review list could not be loaded (no connection).' }); }
  }

  /** Each proposal's text, six at a time (the list shows "…" until then). */
  private async loadTexts(t: number, items: ReviewItem[]) {
    const queue = [...items];
    const worker = async () => {
      for (let i = queue.shift(); i; i = queue.shift()) {
        const p = await this.proposal(i.id);
        if (t !== this.#ticket) return;
        if (p) this.publish({ texts: { ...this.getSnapshot().texts, [i.key]: proposalText(p) } });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  private async proposal(id: string): Promise<Proposal | null> {
    try {
      const r = await this.req('GET', `/api/memory/proposals/${encodeURIComponent(id)}`);
      return r.status === 200 ? parseProposal(r.body) : null;
    } catch { return null; }
  }

  setFilter(filter: ReviewFilter) {
    this.publish({ filter, confirmBulk: null });
    const first = this.visible()[0];
    if (first && !this.visible().some(i => i.key === this.getSnapshot().open)) void this.openItem(first.key);
  }

  async openItem(key: string, keepResult = false) {
    this.publish({ open: key, editing: null, notice: undefined, ...(keepResult ? {} : { result: undefined }) });
    const item = this.getSnapshot().items.find(i => i.key === key);
    if (!item?.summary) { this.publish({ detail: null }); return; }
    this.publish({ detailBusy: true, detail: null });
    const p = await this.proposal(item.id);
    if (this.getSnapshot().open !== key) return;
    this.publish({ detailBusy: false, detail: p, ...(p ? { texts: { ...this.getSnapshot().texts, [key]: proposalText(p) } } : { notice: 'This item could not be read. It may have been decided elsewhere.' }) });
  }
  /** J / K: next or previous item in the shown list. */
  step(delta: 1 | -1) {
    const v = this.visible(); const i = v.findIndex(x => x.key === this.getSnapshot().open);
    const next = v[Math.max(0, Math.min(v.length - 1, i + delta))];
    if (next) void this.openItem(next.key);
  }
  toggleCheck(key: string) { const c = this.getSnapshot().checked; this.publish({ checked: c.includes(key) ? c.filter(k => k !== key) : [...c, key], confirmBulk: null }); }
  checkAll(on: boolean) { this.publish({ checked: on ? this.visible().map(i => i.key) : [], confirmBulk: null }); }
  startEdit() { const d = this.getSnapshot().detail; const c = d?.changes[0]; if (c && 'after' in c) this.publish({ editing: c.after.content }); }
  editText(editing: string) { this.publish({ editing }); }
  cancelEdit() { this.publish({ editing: null }); }

  private done(key: string, result: string) {
    const s = this.getSnapshot();
    const v = this.visible(); const i = v.findIndex(x => x.key === key);
    const items = s.items.filter(x => x.key !== key);
    const next = v[i + 1] ?? v[i - 1];
    this.publish({ items, checked: s.checked.filter(k => k !== key), result, editing: null, detail: null, open: next && next.key !== key ? next.key : null });
    if (next && next.key !== key) void this.openItem(next.key, true);
    this.onChanged();
  }

  /** A conflict: keep new, keep old or keep both (decided on what was shown). */
  async decide(decision: 'keep_new' | 'keep_old' | 'keep_both') {
    const s = this.getSnapshot(); const d = s.detail;
    if (!d || !d.conflictWith || s.busy || !s.open) return;
    const key = s.open; const edited = decision === 'keep_new' && s.editing !== null ? s.editing.trim() : null;
    this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.req('POST', `/api/memory/proposals/${encodeURIComponent(d.id)}/decide`, { decision, expectedReviewHash: d.reviewHash });
      if (r.status !== 200) { this.publish({ busy: false, notice: decisionNotice(codeOf(r)) }); if (codeOf(r) === 'already_decided') void this.load(); return; }
      const res = r.body as DecideResult;
      // "Edit first": the kept new text is then corrected (a new version of the same memory).
      const c = d.changes[0];
      if (edited && c && c.op === 'update' && edited !== c.after.content) {
        const e = await this.req('PUT', `/api/memory/${c.id}`, { content: edited });
        if (e.status !== 200) { this.publish({ busy: false }); this.done(key, 'Kept the new fact, but your edit was not saved. Edit it in the explorer.'); return; }
      }
      this.publish({ busy: false });
      this.done(key, res.decision === 'keep_new' ? (edited ? 'Kept the new fact with your edit.' : 'Kept the new fact; the old one stays in the topic history.') : res.decision === 'keep_old' ? 'Kept the old fact.' : 'Kept both.');
    } catch { this.publish({ busy: false, notice: 'The decision has an unknown outcome (no connection). Load the list again.' }); }
  }

  /** Approve or reject the open proposal or link. */
  async approve(action: 'approve' | 'reject') {
    const s = this.getSnapshot();
    const item = s.items.find(i => i.key === s.open);
    if (!item || s.busy) return;
    this.publish({ busy: true, notice: undefined });
    const ok = await this.decideOne(item, action, item.summary ? s.detail?.reviewHash : undefined);
    this.publish({ busy: false });
    if (ok === true) this.done(item.key, action === 'approve' ? 'Approved and saved.' : 'Rejected; nothing changed.');
    else this.publish({ notice: ok });
  }

  private async decideOne(item: ReviewItem, action: 'approve' | 'reject', reviewHash?: string): Promise<true | string> {
    try {
      if (item.link) {
        const r = await this.req('POST', `/api/memory/graph/links/${encodeURIComponent(item.id)}/${action}`);
        return r.status === 200 ? true : 'The link was not changed.';
      }
      const hash = reviewHash ?? item.summary?.reviewHash;
      if (!hash) return 'Open the item first.';
      const r = await this.req('POST', `/api/memory/proposals/${encodeURIComponent(item.id)}/${action}`, { expectedReviewHash: hash });
      return r.status === 200 ? true : decisionNotice(codeOf(r));
    } catch { return 'No connection: the outcome is unknown.'; }
  }

  askBulk(action: 'approve' | 'reject') { this.publish({ confirmBulk: action }); }
  cancelBulk() { this.publish({ confirmBulk: null }); }
  /** Approve or reject the checked items (conflicts are skipped: each needs its own decision). */
  async bulk() {
    const s = this.getSnapshot(); const action = s.confirmBulk;
    if (!action || s.busy) return;
    const chosen = s.items.filter(i => s.checked.includes(i.key));
    const doable = chosen.filter(i => i.kind !== 'conflict');
    this.publish({ busy: true, confirmBulk: null, notice: undefined });
    let done = 0, failed = 0;
    for (const i of doable) { if ((await this.decideOne(i, action)) === true) done++; else failed++; }
    const skipped = chosen.length - doable.length;
    this.publish({ busy: false, checked: [], result: `${done} ${action === 'approve' ? 'approved' : 'rejected'}.${failed ? ` ${failed} could not be decided (changed since you opened them?).` : ''}${skipped ? ` ${skipped} conflicts skipped: decide each one.` : ''}` });
    await this.load();
    this.onChanged();
  }
  label(i: ReviewItem): string {
    if (i.link) return 'Map';
    return `${drawerName(i.drawerId)} · ${agentLabel(i.agent, this.getSnapshot().agents)}`;
  }
}

export function decisionNotice(code: string | undefined): string {
  switch (code) {
    case 'already_decided': return 'Already decided (maybe in another window).';
    case 'stale': return 'The memory changed since this was proposed. It can no longer be applied as shown.';
    case 'review_changed': return 'The item changed since you opened it. Read it again.';
    case 'review_hash_required': return 'Open the item first.';
    default: return 'The decision was not saved.';
  }
}
