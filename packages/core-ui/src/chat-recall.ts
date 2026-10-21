// MEM-UI-01 P5 (board M5): what a reply remembered, and where the work was
// left. Per reply: the recall trace (memories and handoffs it used, why, and
// how the context was built); "Correct" opens a review proposal (decided in
// the review inbox), "Forget" removes the memory completely (asks first).
// The Details panel shows the conversation's handoff (done / left / next)
// that the agent reads at the start of the next session; the owner edits it.
import { Store, codeOf } from './memory-store';
import type { Requester } from './memory-store';
import { messageRef } from './chat-memory';
import { CACHE_METRICS_PATH, conversationSummariesPath, recallCorrectPath, recallForgetPath, recallMessagePath, recallRunPath } from './memory-recall-contract.js';
import type { CacheMetrics, RecallTrace, TurnSummary } from './memory-recall-contract.js';
import { queryString } from './memory-pages-contract.js';
import type { Handoff } from './memory-pages-contract.js';

export type TraceEntry = { state: 'loading' } | { state: 'none' } | { state: 'ready'; trace: RecallTrace };
export type HandoffDraft = { done: string; left: string; next: string; questions: string };
export type RecallState = Readonly<{
  conversationId: string | null;
  traces: Readonly<Record<string, TraceEntry>>;
  open: string | null; correcting: { key: string; memoryId: string; text: string } | null; confirmForget: { key: string; memoryId: string } | null; trashed: { key: string; memoryId: string } | null;
  busy: boolean; notes: Readonly<Record<string, string>>;
  handoff: Handoff | null; handoffPhase: 'idle' | 'loading' | 'ready' | 'error'; draft: HandoffDraft | null; handoffNotice?: string;
  /** Board M15: the stored summaries of older turns (read on request) and the speed numbers. */
  summaries: readonly TurnSummary[] | null; showSummaries: boolean; metrics: CacheMetrics | null;
}>;

const lines = (x: string) => x.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 8).map(l => l.slice(0, 300));

export class ChatRecallController extends Store<RecallState> {
  #pending = new Set<string>();
  constructor(client: Requester) {
    super({ conversationId: null, traces: {}, open: null, correcting: null, confirmForget: null, trashed: null, busy: false, notes: {}, handoff: null, handoffPhase: 'idle', draft: null, summaries: null, showSummaries: false, metrics: null }, client);
  }

  setConversation(id: string | null) {
    if (id === this.getSnapshot().conversationId) return;
    this.#pending.clear();
    this.publish({ conversationId: id, traces: {}, open: null, correcting: null, confirmForget: null, trashed: null, notes: {}, handoff: null, handoffPhase: 'idle', draft: null, handoffNotice: undefined, summaries: null, showSummaries: false });
  }

  /** "Read the summaries of turns 1–N": the stored summaries of the older turns of this conversation. */
  async toggleSummaries() {
    const s = this.getSnapshot();
    if (s.showSummaries) { this.publish({ showSummaries: false }); return; }
    this.publish({ showSummaries: true });
    if (s.summaries || !s.conversationId) return;
    const conv = s.conversationId;
    const r = await this.read<{ summaries: TurnSummary[] }>(conversationSummariesPath(conv));
    if (this.getSnapshot().conversationId === conv) this.publish({ summaries: r?.summaries ?? [] });
  }
  /** Speed (Health › cache): hit rates, pack size, time to first word. */
  async loadMetrics() { const m = await this.read<CacheMetrics>(CACHE_METRICS_PATH); if (m) this.publish({ metrics: m }); }
  /** After "Wrong place" moved a memory: the replies that used it show "moved" and where it is now. */
  moved(memoryId: string, drawer: string) {
    const traces = { ...this.getSnapshot().traces };
    for (const [k, e] of Object.entries(traces)) if (e.state === 'ready' && e.trace.items.some(i => i.id === memoryId)) traces[k] = { state: 'ready', trace: { ...e.trace, items: e.trace.items.map(i => (i.id === memoryId && i.kind === 'memory' ? { ...i, state: 'moved' as const, nowIn: drawer } : i)) } };
    this.publish({ traces });
  }

  /** Reads a finished reply's trace once (kept for the conversation). */
  async ensure(turn: { key: string; role: string; runId: string | null; pending?: boolean; status?: string }) {
    if (turn.role !== 'assistant' || turn.status === 'running' || this.getSnapshot().traces[turn.key] || this.#pending.has(turn.key)) return;
    const ref = messageRef(turn);
    if (!ref) return;
    this.#pending.add(turn.key);
    this.patchTrace(turn.key, { state: 'loading' });
    try {
      const r = await this.req('GET', 'messageId' in ref ? recallMessagePath(ref.messageId) : recallRunPath(ref.runId));
      this.patchTrace(turn.key, r.status === 200 ? { state: 'ready', trace: (r.body as { trace: RecallTrace }).trace } : { state: 'none' });
    } catch { this.patchTrace(turn.key, { state: 'none' }); }
    finally { this.#pending.delete(turn.key); }
  }
  private patchTrace(key: string, e: TraceEntry) { this.publish({ traces: { ...this.getSnapshot().traces, [key]: e } }); }
  trace(key: string): RecallTrace | null { const e = this.getSnapshot().traces[key]; return e?.state === 'ready' ? e.trace : null; }
  /** The newest reply with a trace: its context (kept, summarised, from cache) shows in Details. */
  latest(keys: readonly string[]): RecallTrace | null { for (let i = keys.length - 1; i >= 0; i--) { const t = this.trace(keys[i]); if (t) return t; } return null; }

  toggle(key: string) { const s = this.getSnapshot(); this.publish({ open: s.open === key ? null : key, correcting: null, confirmForget: null }); }
  startCorrect(key: string, memoryId: string, text: string) { this.publish({ correcting: { key, memoryId, text }, confirmForget: null }); }
  editCorrect(text: string) { const c = this.getSnapshot().correcting; if (c) this.publish({ correcting: { ...c, text } }); }
  cancel() { this.publish({ correcting: null, confirmForget: null }); }
  askForget(key: string, memoryId: string) { this.publish({ confirmForget: { key, memoryId }, correcting: null }); }

  private messageIdOf(key: string): string | null { return this.trace(key)?.messageId ?? (/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(key) ? key : null); }
  private note(key: string, text: string) { this.publish({ notes: { ...this.getSnapshot().notes, [key]: text } }); }

  /** "Correct": the corrected text goes to the review inbox as a proposal (nothing changes before the owner approves it there). */
  async correct() {
    const c = this.getSnapshot().correcting;
    const id = c && this.messageIdOf(c.key);
    if (!c || !id || !c.text.trim()) return;
    this.publish({ busy: true });
    try {
      const r = await this.req('POST', recallCorrectPath(id), { memoryId: c.memoryId, content: c.text.trim() });
      this.publish({ busy: false, ...(r.status === 201 ? { correcting: null } : {}) });
      this.note(c.key, r.status === 201 ? 'Correction sent to Memory › Review. It changes after you approve it there.' : recallNotice(codeOf(r)));
    } catch { this.publish({ busy: false }); this.note(c.key, 'The correction was not sent (no connection).'); }
  }
  /** "Move to Trash" (board M28 H1): no agent reads it any more; Undo puts it back while it is in Trash. */
  async trash(key: string, memoryId: string) {
    const t = this.trace(key);
    this.publish({ busy: true, confirmForget: null, correcting: null });
    try {
      const r = await this.req('DELETE', `/api/memory/${encodeURIComponent(memoryId)}`);
      this.publish({ busy: false });
      if (r.status !== 200) { this.note(key, 'It was not moved to Trash.'); return; }
      if (t) this.patchTrace(key, { state: 'ready', trace: { ...t, items: t.items.map(i => (i.id === memoryId ? { ...i, state: 'deleted' as const } : i)) } });
      this.publish({ trashed: { key, memoryId } });
      this.note(key, 'Moved to Trash. No agent reads it now.');
    } catch { this.publish({ busy: false }); this.note(key, 'It was not moved to Trash (no connection).'); }
  }
  async untrash() {
    const x = this.getSnapshot().trashed;
    if (!x) return;
    this.publish({ busy: true });
    try {
      const r = await this.req('POST', `/api/memory/${encodeURIComponent(x.memoryId)}/restore`);
      this.publish({ busy: false });
      if (r.status !== 200) { this.note(x.key, r.status === 404 ? 'Restore arrives with the next backend update; Memory › Trash will have it.' : 'It could not be restored.'); return; }
      const t = this.trace(x.key);
      if (t) this.patchTrace(x.key, { state: 'ready', trace: { ...t, items: t.items.map(i => (i.id === x.memoryId ? { ...i, state: 'active' as const } : i)) } });
      this.publish({ trashed: null });
      this.note(x.key, 'Back where it was.');
    } catch { this.publish({ busy: false }); this.note(x.key, 'It could not be restored (no connection).'); }
  }
  /** "Forget": removes the memory completely (text, history, copies). Kept for agent tools; the window forgets only from Trash. */
  async forget() {
    const f = this.getSnapshot().confirmForget;
    const id = f && this.messageIdOf(f.key);
    if (!f || !id) return;
    this.publish({ busy: true });
    try {
      const r = await this.req('POST', recallForgetPath(id), { memoryId: f.memoryId });
      if (r.status === 200) {
        const t = this.trace(f.key);
        if (t) this.patchTrace(f.key, { state: 'ready', trace: { ...t, items: t.items.map(i => (i.id === f.memoryId ? { ...i, state: 'forgotten' as const, preview: undefined } : i)) } });
      }
      this.publish({ busy: false, confirmForget: null });
      this.note(f.key, r.status === 200 ? 'Forgotten for good.' : recallNotice(codeOf(r)));
    } catch { this.publish({ busy: false }); this.note(f.key, 'The memory was not forgotten (no connection).'); }
  }

  // ---- handoff (Details › Where we left off) ----
  async loadHandoff() {
    const conv = this.getSnapshot().conversationId;
    if (!conv) return;
    this.publish({ handoffPhase: 'loading' });
    const r = await this.read<{ handoffs: Handoff[] }>('/api/handoffs' + queryString({ kind: 'conversation', limit: 200 }));
    if (this.getSnapshot().conversationId !== conv) return;
    if (!r) { this.publish({ handoffPhase: 'error' }); return; }
    this.publish({ handoffPhase: 'ready', handoff: r.handoffs.find(h => h.scopeId === conv) ?? null });
  }
  startEdit() {
    const h = this.getSnapshot().handoff;
    this.publish({ draft: { done: (h?.done ?? []).join('\n'), left: (h?.left ?? []).join('\n'), next: (h?.next ?? []).join('\n'), questions: (h?.questions ?? []).join('\n') }, handoffNotice: undefined });
  }
  editDraft(p: Partial<HandoffDraft>) { const d = this.getSnapshot().draft; if (d) this.publish({ draft: { ...d, ...p } }); }
  cancelEdit() { this.publish({ draft: null }); }
  /** Saves the owner's edit as a new version; the agent's next session starts from it. */
  async saveHandoff(agentId: string) {
    const s = this.getSnapshot(); const d = s.draft; const conv = s.conversationId;
    if (!d || !conv) return;
    const agent = s.handoff?.agentId || agentId;
    this.publish({ busy: true, handoffNotice: undefined });
    try {
      const r = await this.req('PUT', `/api/handoffs/conversation/${encodeURIComponent(conv)}`, { agentId: agent, done: lines(d.done), left: lines(d.left), next: lines(d.next), questions: lines(d.questions) });
      if (r.status !== 200) { this.publish({ busy: false, handoffNotice: codeOf(r) === 'invalid_handoff' ? 'Keep each item one short line (at most 8 per list).' : 'The note was not saved.' }); return; }
      this.publish({ busy: false, draft: null, handoff: (r.body as { handoff: Handoff }).handoff });
    } catch { this.publish({ busy: false, handoffNotice: 'The note was not saved (no connection).' }); }
  }
}

export function recallNotice(code: string | undefined): string {
  switch (code) {
    case 'not_in_trace': return 'That memory was not used in this reply.';
    case 'not_found': return 'The memory or the reply no longer exists.';
    case 'invalid_content': return 'Write the corrected fact first.';
    default: return 'That did not work.';
  }
}
