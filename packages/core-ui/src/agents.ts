import { SessionFailure } from './session-failure';
import { createSuggestionAdapter, validatedDisplayName } from './naming';
import type { NamingLanguage } from './naming';
import type { SessionClient, WireResponse } from './session';

export type AgentProfile = { role?: 'main' | 'manager' | 'specialist' | 'evaluator' | null; department?: string | null; description?: string; emoji?: string; isPrimary?: boolean; model?: string; provider?: string };
export type PublicAgent = Readonly<{ id: string; version: number } & AgentProfile & ({ name: string; nameUnavailable?: never } | { name?: never; nameUnavailable: true })>;
const ROLES = ['main', 'manager', 'specialist', 'evaluator'];
/** Profile fields shown on the team page and the agent card (all optional, bounded). */
export function agentProfile(x: Record<string, unknown>): AgentProfile {
  return {
    ...(x.role === null || ROLES.includes(x.role as string) ? { role: x.role as AgentProfile['role'] } : {}),
    ...(x.department === null || (typeof x.department === 'string' && /^[a-z0-9][a-z0-9 _-]{0,63}$/.test(x.department)) ? { department: x.department as string | null } : {}),
    ...(typeof x.description === 'string' ? { description: x.description.slice(0, 1000) } : {}),
    ...(typeof x.emoji === 'string' && [...x.emoji].length <= 4 ? { emoji: x.emoji } : {}),
    ...(typeof x.isPrimary === 'boolean' ? { isPrimary: x.isPrimary } : {}),
    ...(typeof x.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,99}$/.test(x.model) ? { model: x.model } : {}),
    ...(typeof x.provider === 'string' && /^[a-z][a-z-]{0,19}$/.test(x.provider) ? { provider: x.provider } : {}),
  };
}
export type AgentRequest = { method: 'GET'; path: string } | { method: 'PUT'; path: string; body: { name: string; expectedVersion: number } | { expectedVersion: number; role?: string | null; department?: string | null; description?: string } };
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
import { validAgentId } from './agent-id.js';
export { validAgentId } from './agent-id.js';
export const validVersion = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
export function publicAgent(x: unknown): PublicAgent {
  if (!record(x) || !validAgentId(x.id) || !validVersion(x.version)) throw Error('Invalid agent response');
  const profile = agentProfile(x);
  return Object.freeze(typeof x.name === 'string' && validatedDisplayName(x.name) === x.name && x.nameUnavailable !== true
    ? { id: x.id, name: x.name, version: x.version, ...profile }
    : { id: x.id, version: x.version, nameUnavailable: true as const, ...profile });
}
export function agentResponse(path: string, response: WireResponse): WireResponse {
  if (path !== '/api/agents' && !/^\/api\/agents\/[^/]+$/.test(path) || path === '/api/agents/name-suggestion') return response;
  const b = response.body;
  if (response.status === 200) {
    if (!record(b)) throw Error('Invalid agent response');
    if (path === '/api/agents') {
      if (!Array.isArray(b.agents) || b.agents.length > 10000) throw Error('Invalid agent list');
      const agents = b.agents.map(publicAgent);
      if (new Set(agents.map(a => a.id)).size !== agents.length) throw Error('Duplicate agent');
      return { status: 200, body: { agents } };
    }
    const agent = publicAgent(b.agent);
    if (agent.id !== path.slice('/api/agents/'.length)) throw Error('Agent mismatch');
    return { status: 200, body: { agent } };
  }
  const code = record(b) ? b.code : undefined;
  if (response.status === 409 && code === 'version_conflict') {
    const agent = publicAgent((b as Record<string, unknown>).agent);
    if (agent.id !== path.slice('/api/agents/'.length) || (b as Record<string, unknown>).currentVersion !== agent.version) throw Error('Invalid conflict');
    return { status: 409, body: { code, currentVersion: agent.version, agent } };
  }
  return { status: response.status, body: (response.status === 409 && code === 'name_taken') || (response.status === 400 && code === 'invalid_version') || (response.status === 403 && code === 'reserved_agent') ? { code } : null };
}
export type AgentsState = Readonly<{
  agents: readonly PublicAgent[]; selected?: PublicAgent; draft: string;
  phase: 'idle' | 'listing' | 'reading' | 'ready' | 'generating' | 'saving' | 'saved' | 'review' | 'unknown' | 'reconciling' | 'error' | 'denied';
  notice?: string; needsReview: boolean; unknown: boolean; refreshRequired: boolean; owner: boolean;
}>;
type Attempt = { name: string };
// Per injected client/account, retained across destination remounts; never persisted.
const ledgers = new WeakMap<SessionClient, Map<string, Attempt>>();
export class AgentsController {
  #state: AgentsState = Object.freeze({ agents: [], draft: '', phase: 'idle', needsReview: false, unknown: false, refreshRequired: false, owner: false });
  #listeners = new Set<() => void>();
  #disposed = false; #ticket = 0; #abort?: AbortController; #identity = ''; #unsubscribe: () => void;
  #ledger: Map<string, Attempt>;
  constructor(readonly client: SessionClient) {
    this.#ledger = ledgers.get(client) ?? new Map(); ledgers.set(client, this.#ledger);
    this.#unsubscribe = client.subscribe(this.#sync); this.#sync();
  }
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  #publish(patch: Partial<AgentsState>) { this.#state = Object.freeze({ ...this.#state, ...patch }); this.#listeners.forEach(fn => fn()); }
  #sync = () => {
    const s = this.client.getSnapshot(); const identity = `${s.mode}:${s.epoch}:${s.phase}:${s.user?.id ?? ''}:${s.user?.role ?? ''}`;
    if (identity === this.#identity) return;
    this.#identity = identity; this.#invalidate();
    this.#publish({ agents: [], selected: undefined, draft: '', phase: s.phase === 'authenticated' ? 'idle' : 'denied', needsReview: false, unknown: false, refreshRequired: false, notice: undefined, owner: s.phase === 'authenticated' && s.user?.role === 'owner' });
  };
  #invalidate() { this.#ticket++; this.#abort?.abort(); }
  #begin(phase: AgentsState['phase']) { this.#invalidate(); this.#abort = new AbortController(); this.#publish({ phase, notice: undefined }); return this.#ticket; }
  #key(id: string) { return `${this.client.getSnapshot().mode}:${this.client.getSnapshot().user?.id ?? ''}:${id}`; }
  #active() { return !this.#disposed && this.client.getSnapshot().phase === 'authenticated'; }
  #busy() { return ['listing', 'reading', 'saving', 'reconciling'].includes(this.#state.phase); }
  #fail(status?: number) {
    if (status === 401 || status === 403) this.#publish({ agents: [], selected: undefined, draft: '', phase: 'denied', needsReview: false, unknown: false, refreshRequired: false, notice: 'Access denied. Read again after access is restored.' });
    else this.#publish({ phase: 'error', notice: 'Read unavailable. No retry sent.' });
  }
  dispose() { this.#disposed = true; this.#invalidate(); this.#unsubscribe(); this.#publish({ agents: [], selected: undefined, draft: '', owner: false, phase: 'denied', notice: undefined, needsReview: false, unknown: false, refreshRequired: false }); }
  async list() {
    if (!this.#active() || this.#busy()) return;
    const ticket = this.#begin('listing'); this.#publish({ agents: [], selected: undefined, draft: '', unknown: false, refreshRequired: false, needsReview: false });
    try {
      const r = await this.client.request({ method: 'GET', path: '/api/agents' }, this.#abort!.signal);
      if (ticket !== this.#ticket) return;
      if (r.status !== 200) return this.#fail(r.status);
      const b = agentResponse('/api/agents', r).body as { agents: PublicAgent[] };
      this.#publish({ agents: Object.freeze(b.agents), phase: 'ready' });
    } catch { if (ticket === this.#ticket) this.#fail(); }
  }
  async select(id: string) {
    if (!this.#active() || !validAgentId(id)) return;
    const ticket = this.#begin('reading'); this.#publish({ selected: undefined, draft: '', unknown: false, refreshRequired: false, needsReview: false });
    try {
      const r = await this.client.request({ method: 'GET', path: `/api/agents/${id}` }, this.#abort!.signal);
      if (ticket !== this.#ticket) return;
      if (r.status !== 200) return this.#fail(r.status);
      const a = publicAgent((r.body as { agent: unknown }).agent); if (a.id !== id) throw Error();
      const pending = this.#ledger.get(this.#key(id));
      this.#publish({ selected: a, draft: pending?.name ?? a.name ?? '', phase: pending ? 'unknown' : 'ready', unknown: !!pending,
        notice: pending ? 'An earlier Save is unconfirmed. Explicitly reconcile before reviewing another Save.' : a.nameUnavailable ? 'Name unavailable. Rename and generation are disabled for this agent.' : undefined });
    } catch { if (ticket === this.#ticket) this.#fail(); }
  }
  edit(draft: string) {
    if (!this.#state.owner || !this.#state.selected || this.#state.selected.nameUnavailable || this.#busy() || this.#state.unknown) return;
    this.#invalidate(); this.#publish({ draft, phase: this.#state.needsReview ? 'review' : 'ready' });
  }
  cancel() {
    if (!this.#state.selected || this.#state.selected.nameUnavailable || this.#busy() || this.#state.unknown) return;
    this.#invalidate(); this.#publish({ draft: this.#state.selected.name, phase: this.#state.needsReview ? 'review' : 'ready', notice: 'Draft cancelled. Cancel sent no write.' });
  }
  async generate(language: NamingLanguage = 'en') {
    if (!this.#state.owner || !this.#state.selected || this.#state.selected.nameUnavailable || this.#busy() || this.#state.unknown) return;
    const ticket = this.#begin('generating');
    const suggest = createSuggestionAdapter(r => this.client.request(r, this.#abort!.signal));
    const result = await suggest(language, this.#state.draft);
    if (ticket !== this.#ticket) return;
    if (!result.ok && (result.error === 'forbidden' || result.error === 'unauthenticated')) return this.#fail(result.error === 'forbidden' ? 403 : 401);
    this.#publish(result.ok ? { draft: result.value.name, phase: this.#state.needsReview ? 'review' : 'ready', notice: 'Generated draft only; not reserved or saved.' } : { phase: 'error', notice: 'Suggestion unavailable. Nothing saved.' });
  }
  review() {
    if (!this.#state.selected || !this.#state.needsReview || this.#state.unknown || this.#state.refreshRequired || this.#busy()) return;
    this.#publish({ needsReview: false, phase: 'ready', notice: 'Latest name and version reviewed. Save is a new deliberate request.' });
  }
  async save() {
    const a = this.#state.selected; const name = validatedDisplayName(this.#state.draft);
    if (!a || a.nameUnavailable || !name || !this.#state.owner || this.#busy() || this.#state.phase === 'generating' || this.#state.unknown || this.#state.needsReview || this.#state.refreshRequired || name === a.name) return;
    const ticket = this.#begin('saving'); const key = this.#key(a.id);
    const attempt = { name }; this.#ledger.set(key, attempt);
    try {
      const path = `/api/agents/${a.id}`;
      const r = agentResponse(path, await this.client.request({ method: 'PUT', path, body: { name, expectedVersion: a.version } }, this.#abort!.signal));
      if (ticket !== this.#ticket) return;
      const b = r.body as { agent?: unknown; code?: string } | null;
      if (r.status === 200) {
        const current = publicAgent(b?.agent);
        if (current.id !== a.id || current.name !== name || current.version <= a.version) throw Error();
        this.#ledger.delete(key); this.#ack(current);
        this.#publish({ draft: current.name ?? '', phase: 'saved', notice: 'Save response confirmed.', unknown: false }); return;
      }
      if (r.status === 409 && b?.code === 'version_conflict') {
        const current = publicAgent(b.agent); if (current.version <= a.version) throw Error();
        this.#ledger.delete(key); this.#ack(current);
        this.#publish({ phase: 'review', needsReview: true, notice: 'Version conflict. Your draft is preserved. Review the latest acknowledged name and version before Save.' }); return;
      }
      if ([400, 401, 403, 404, 409, 421, 429].includes(r.status)) {
        this.#ledger.delete(key);
        if (r.status === 401 || r.status === 403) { this.#fail(r.status); if (b?.code === 'reserved_agent') this.#publish({ notice: 'Reserved agent access refused.' }); return; }
        this.#publish({ phase: 'review', needsReview: true, notice: b?.code === 'name_taken' ? 'Name unavailable. Draft preserved. Read latest state before reviewing.' : b?.code === 'invalid_version' ? 'Version rejected. Read the latest state before reviewing again.' : 'Save refused. Draft preserved. Read latest state before reviewing.', unknown: false });
        // An explicit reconciliation read is required even when the error has no current agent.
        this.#publish({ refreshRequired: true }); return;
      }
      throw Error();
    } catch (error) {
      if (error instanceof SessionFailure && error.code === 'blocked') {
        if (this.#ledger.get(key) === attempt) this.#ledger.delete(key);
        if (ticket === this.#ticket) this.#publish({ phase: 'ready', unknown: false, needsReview: false, refreshRequired: false, notice: 'Save refused before sending. Nothing was sent.' });
        return;
      }
      if (ticket === this.#ticket) this.#publish({ phase: 'unknown', unknown: true, needsReview: true, notice: 'Save outcome unknown. No retry sent. Reconcile explicitly.' });
    }
  }
  #ack(a: PublicAgent) { this.#publish({ selected: a, agents: Object.freeze(this.#state.agents.map(x => x.id === a.id ? a : x)) }); }
  async reconcile() {
    const a = this.#state.selected;
    if (!a || !this.#active() || (!this.#state.unknown && !this.#state.refreshRequired) || this.#busy()) return;
    const ticket = this.#begin('reconciling'); const key = this.#key(a.id); const attempt = this.#ledger.get(key);
    try {
      const r = await this.client.request({ method: 'GET', path: `/api/agents/${a.id}` }, this.#abort!.signal);
      if (ticket !== this.#ticket) return;
      if (r.status === 404) {
        this.#ledger.delete(key);
        this.#publish({ agents: Object.freeze(this.#state.agents.filter(x => x.id !== a.id)), selected: undefined, draft: '', phase: 'idle', unknown: false, refreshRequired: false, needsReview: false, notice: 'Agent no longer exists. GET cannot establish the earlier Save outcome.' });
        return;
      }
      if (r.status !== 200) { if (r.status === 401 || r.status === 403) this.#fail(r.status); else throw Error(); return; }
      const current = publicAgent((r.body as { agent: unknown }).agent); if (current.id !== a.id || current.version < a.version) throw Error();
      this.#ack(current); this.#ledger.delete(key);
      this.#publish({ phase: 'review', unknown: false, refreshRequired: false, needsReview: true, notice: attempt
        ? (current.name === attempt.name ? 'Current name matches the attempted name. GET does not prove the same operation committed. Review the fresh version; no retry sent.' : 'Current name differs. The request may not have committed or may have been overwritten. Review the fresh version; no retry sent.')
        : 'Latest state read after refusal. Review the name, version and draft before another Save.' });
    } catch { if (ticket === this.#ticket) this.#publish({ phase: this.#state.unknown ? 'unknown' : 'review', notice: 'Reconciliation unavailable. No write retried.' }); }
  }
}
