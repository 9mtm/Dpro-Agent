import {approvalRoute,allowedApproval,approvalResponse} from './approvals-contract.js';
import {allowedTemplates,templatePath,templatesResponse} from './specialty-contract.js';
import { allowedMcpImport, mcpImportPath, mcpImportResponse } from './mcp-import-contract.js';
import { allowedSkillLibrary, skillLibraryPath, skillLibraryResponse } from './skill-library-contract.js';
import { allowedGenVR, genvrRoute, genvrResponse, GENVR_BYTES } from './genvr-contract.js';
import { allowedChannel, channelRoute, channelResponse } from './agent-connect-contract.js';
import { allowedPersonality, personalityRoute, personalityResponse } from './personality-contract.js';
import { allowedBoard, boardRoute, boardResponse, BOARDS_PATH } from './board-contract.js';
import { allowedAgentCard, cardRoute, agentCardResponse } from './agent-card-contract.js';
import { allowedConnector, connectorRoute, connectorResponse } from './connectors-contract.js';
import { allowedLocalImport, localImportRoute, localImportResponse } from './local-import-contract.js';
import { allowedChatBoard, chatBoardRoute, chatBoardResponse } from './chat-board-contract.js';
import { allowedChatMemory, chatMemoryRoute, chatMemoryResponse } from './chat-memory-contract.js';
import { allowedChatSearch, chatSearchRoute, chatSearchResponse } from './chat-search-contract.js';
import { allowedChatExport, chatExportRoute, chatExportResponse } from './chat-export-contract.js';
import { allowedChatSecrets, chatSecretsRoute, chatSecretsResponse, CLEANUP_PATH } from './chat-secrets-contract.js';
import { allowedTerminal, terminalPath, terminalRoute, terminalResponse, TerminalEventParser, TERMINAL_STREAM_MS } from './terminal-contract.js';
import type { TerminalFrame } from './terminal-contract.js';
import { allowedConversation, conversationPath, conversationRoute, conversationResponse, RunEventParser, RUN_IDLE_MS, RUN_STREAM_MS } from './conversation-contract.js';
import type { RunEvent } from './conversation-contract.js';
import { allowedHire, batchPath, grantsAgentId, permissionsAgentId, hireResponse, hireRoute, BATCHES_PATH, CATALOGUE_PATH, DISTRIBUTION_PATH, PLAN_PATH } from './hire-contract.js';
import type { HireRequest } from './hire';
import type { BoardRequest } from './board';
import { validDeviceToken, validLoginBody } from './login-contract.js';
import { setupStatus } from './setup-status.js';
import { OWNER_SETUP_PATH, validOwnerSetupBody, ownerSetupResponse } from './owner-setup-contract.js';
import type { OwnerSetupBody, OwnerSetupCode } from './owner-setup-contract.js';
import { validChatBody, validKey, validId, chatError, SSEParser, CHAT_DEADLINE_MS, CHAT_IDLE_MS } from './chat-protocol.js';
import type { ChatBody, ChatFrame, ChatIds } from './chat-protocol.js';
import { agentResponse, validAgentId, validVersion } from './agents';
import type { AgentRequest } from './agents';
import { validatedDisplayName } from './naming';
import { namingLanguages } from './naming';
import type { SuggestionRequest } from './naming';
import { validDrawer } from './memory';
import type { MemoryRequest, MemoryController } from './memory';

import { retryAfterSeconds } from './retry-after.js';

export type Mode = 'fixture' | 'mock' | 'live';
export type User = Readonly<{ id: string; email: string; username: string; role: 'owner' | 'admin' | 'user' | 'guest'; name?: string }>;
/** What the UI calls the account: the name typed at setup, else the user name. */
export const displayName = (u: User): string => u.name ?? u.username;
type BoundaryNotice = 'published_password' | 'account_inactive' | 'rate_limited' | 'origin_not_allowed' | 'host_not_allowed';
export type SessionState = Readonly<{ mode: Mode; epoch: number; retryAfterSeconds?: number; setup?: 'checking' | 'required' | 'login' | 'unavailable'; phase: 'signed-out' | 'signing-in' | 'authenticated' | 'signing-out'; user?: User; notice?: BoundaryNotice | 'invalid' | 'denied' | 'limited' | 'unavailable' | 'expired' | 'logout-confirmed' | 'logout-unknown' }>;
import { SessionFailure } from './session-failure';
export { SessionFailure } from './session-failure';
export interface WireRequest { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; body?: unknown; headers: Readonly<Record<string, string>>; signal: AbortSignal }
export interface WireResponse { status: number; body: unknown; retryAfterSeconds?: number; stream?: ReadableStream<Uint8Array>; streamIds?: ChatIds }
export type WireTransport = (request: WireRequest) => Promise<WireResponse>;
export type ConversationRequest = { method: 'GET' | 'DELETE'; path: string } | { method: 'POST' | 'PUT'; path: string; body?: unknown };
type Request = AgentRequest | HireRequest | MemoryRequest | SuggestionRequest | BoardRequest | ConversationRequest | { method: 'GET'; path: '/api/auth/me' };
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const id = (x: string) => /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,199}$/.test(x) && !x.includes('..');
function user(value: unknown): User {
  if (!record(value) || !['owner', 'admin', 'user', 'guest'].includes(value.role as string)
    || !['id', 'email', 'username'].every(k => typeof value[k] === 'string' && (value[k] as string).length > 0 && (value[k] as string).length <= 320)
    || !id(value.id as string)) throw new SessionFailure('unavailable');
  const name = typeof value.full_name === 'string' ? value.full_name.trim() : '';
  return Object.freeze({ id: value.id as string, email: value.email as string, username: value.username as string, role: value.role as User['role'], ...(name && name.length <= 200 ? { name } : {}) });
}
// Reject before URL normalization. No generic URL, header, key or mutation escape hatch.
export function allowedRequest(method: string, path: string, body?: unknown): boolean {
  if (approvalRoute(path)) return allowedApproval(method,path,body);
  if (mcpImportPath(path)) return allowedMcpImport(method,path,body);
  if (templatePath(path)) return allowedTemplates(method,path,body);
  if (skillLibraryPath(path)) return allowedSkillLibrary(method,path,body);
  if (allowedGenVR(method, path, body) || allowedChannel(method, path, body) || allowedPersonality(method, path, body) || allowedHire(method, path, body) || allowedBoard(method, path, body) || allowedConversation(method, path, body) || allowedAgentCard(method, path, body) || allowedTerminal(method, path, body) || allowedConnector(method, path, body) || allowedLocalImport(method, path, body) || allowedChatBoard(method, path, body) || allowedChatMemory(method, path, body) || allowedChatSearch(method, path, body) || allowedChatExport(method, path, body) || allowedChatSecrets(method, path, body)) return true;
  const agentId = /^\/api\/agents\/([^/?#]+)$/.exec(path)?.[1];
  if (method === 'PUT') return validAgentId(agentId) && record(body) && Object.keys(body).length === 2 && Object.keys(body).every(k => k === 'name' || k === 'expectedVersion') && typeof body.name === 'string' && validatedDisplayName(body.name) === body.name && validVersion(body.expectedVersion);
  if (method === 'GET' && body === undefined && (path === '/api/agents' || validAgentId(agentId))) return true;
  if (method === 'POST') {
    if (path === '/api/chat') return validChatBody(body);
    const decision = /^\/api\/memory\/proposals\/([A-Za-z0-9-]{1,64})\/(approve|reject)$/.exec(path);
    if (decision) return record(body) && Object.keys(body).length === 1 && typeof body.expectedReviewHash === 'string' && /^[a-f0-9]{64}$/.test(body.expectedReviewHash);
    if (path === '/api/auth/logout') return body === undefined;
    if (path === '/api/auth/login') return validLoginBody(body);
    if (path === OWNER_SETUP_PATH) return validOwnerSetupBody(body);
    return path === '/api/agents/name-suggestion' && record(body) && Object.keys(body).length === 2
      && namingLanguages.includes(body.language as never) && Array.isArray(body.exclude) && body.exclude.length <= 100
      && body.exclude.every(x => typeof x === 'string' && x.length <= 200);
  }
  if (method !== 'GET' || body !== undefined) return false;
  if (path === '/api/setup/status' || path === '/api/auth/me' || path === '/api/memory/proposals' || path === '/api/memory/proposals?status=pending') return true;
  const proposal = /^\/api\/memory\/proposals\/([^/?#]+)$/.exec(path);
  if (proposal) return /^[A-Za-z0-9-]{1,64}$/.test(proposal[1]);
  const drawer = /^\/api\/memory\/files\/([^/?#]+)\?agentId=([^&#]+)$/.exec(path);
  if (!drawer) return false;
  try {
    const d = decodeURIComponent(drawer[1]); const a = decodeURIComponent(drawer[2]);
    return validDrawer(d) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(a) && !a.includes('..')
      && encodeURIComponent(d) === drawer[1] && encodeURIComponent(a) === drawer[2];
  } catch { return false; }
}


function boundaryNotice(response: WireResponse): BoundaryNotice | undefined {
  const code = record(response.body) ? response.body.code : undefined;
  if ((response.status === 403 && ['published_password', 'account_inactive', 'origin_not_allowed'].includes(code as string))
    || (response.status === 429 && code === 'rate_limited')
    || ([421, 502].includes(response.status) && code === 'host_not_allowed')) return code as BoundaryNotice;
  return undefined;
}

// Preserve only reviewed machine codes at the decision endpoint, never error text.
function safeResponse(path: string, response: WireResponse): WireResponse {
  const projected = projectResponse(path, response);
  const delay = response.status === 429 ? retryAfterSeconds(response.retryAfterSeconds) : undefined;
  return delay === undefined ? projected : { ...projected, retryAfterSeconds: delay };
}
function projectResponse(path: string, response: WireResponse): WireResponse {
  if (path === '/api/setup/status') return { status: response.status, body: setupStatus(response.status, response.body) };
  if (path === OWNER_SETUP_PATH) return { status: response.status, body: ownerSetupResponse(response.status, response.body) };
  if (path === '/api/chat') return { status: response.status, body: chatError(response.status, response.body) };
  if (record(response.body) && ((response.status === 403 && ['inactive_user', 'forbidden'].includes(response.body.code as string)) || (response.status === 401 && response.body.code === 'unauthenticated'))) return { status: response.status, body: { code: response.body.code } };
  const notice = boundaryNotice(response); if (notice) return { status: response.status, body: { code: notice } };
  if (personalityRoute(path)) return { status: response.status, body: personalityResponse(path, response.status, response.body) };
  if (hireRoute(path, response.status)) return { status: response.status, body: hireResponse(path, response.status, response.body) };
  if (boardRoute(path)) return { status: response.status, body: boardResponse(path, response.status, response.body) };
  if (conversationRoute(path)) return { status: response.status, body: conversationResponse(path, response.status, response.body) };
  if (cardRoute(path)) return { status: response.status, body: agentCardResponse(path, response.status, response.body) };
  if (terminalRoute(path)) return { status: response.status, body: terminalResponse(path, response.status, response.body) };
  if (approvalRoute(path)) return {status:response.status,body:approvalResponse(path,response.status,response.body)};
  if (mcpImportPath(path)) return { status: response.status, body: mcpImportResponse(path,response.status,response.body) };
  if (templatePath(path)) return {status:response.status,body:templatesResponse(path,response.status,response.body)};
  if (skillLibraryPath(path)) return { status: response.status, body: skillLibraryResponse(path,response.status,response.body) };
  if (genvrRoute(path)) return { status: response.status, body: genvrResponse(path, response.status, response.body) };
  if (channelRoute(path)) return { status: response.status, body: channelResponse(path, response.status, response.body) };
  if (connectorRoute(path)) return { status: response.status, body: connectorResponse(path, response.status, response.body) };
  if (localImportRoute(path)) return { status: response.status, body: localImportResponse(path, response.status, response.body) };
  if (chatBoardRoute(path)) return { status: response.status, body: chatBoardResponse(path, response.status, response.body) };
  if (chatMemoryRoute(path)) return { status: response.status, body: chatMemoryResponse(path, response.status, response.body) };
  if (chatSearchRoute(path)) return { status: response.status, body: chatSearchResponse(path, response.status, response.body) };
  if (chatExportRoute(path)) return { status: response.status, body: chatExportResponse(path, response.status, response.body) };
  if (chatSecretsRoute(path)) return { status: response.status, body: chatSecretsResponse(path, response.status, response.body) };
  if (path === '/api/agents' || (path.startsWith('/api/agents/') && path !== '/api/agents/name-suggestion')) return agentResponse(path, response);
  if (response.status === 200 && (path === '/api/auth/login' || path === '/api/auth/me')) {
    if (!record(response.body)) throw new SessionFailure('unavailable');
    const projectedUser = user(response.body.user);
    if (path === '/api/auth/me') return { status: 200, body: { user: projectedUser } };
    if (typeof response.body.token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(response.body.token) || !validDeviceToken(response.body.deviceToken)) throw new SessionFailure('unavailable');
    return { status: 200, body: { user: projectedUser, token: response.body.token, deviceToken: response.body.deviceToken } };
  }
  if (response.status === 200) return response;
  const code = record(response.body) ? response.body.code : undefined;
  const decision = /^\/api\/memory\/proposals\/[A-Za-z0-9-]{1,64}\/(approve|reject)$/.test(path);
  const allowed = decision && ((response.status === 409 && ['already_decided', 'stale', 'review_changed'].includes(code as string)) || (response.status === 400 && code === 'review_hash_required'));
  return { status: response.status, body: allowed ? { code } : null };
}

/** The app's own origin: plain http on 127.0.0.1 with an explicit port
 * (42522 from the CLI, a random port inside the desktop app). */
export function isAppOrigin(origin: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(origin);
  return match !== null && Number(match[1]) <= 65535;
}

/** Deployment must serve these routes on this exact origin from the reviewed backend.
 * This is a client boundary, not a proxy. Static fixture preview does not implement it. */
export function createSameOriginTransport(origin: string, fetcher: typeof fetch): WireTransport {
  if (!isAppOrigin(origin)) throw new SessionFailure('blocked');
  return async request => {
    if (!allowedRequest(request.method, request.path, request.body)) throw new SessionFailure('blocked');
    const keys = Object.keys(request.headers);
    const chat = request.path === '/api/chat';
    const runEvents = request.method === 'GET' && (conversationPath(request.path)?.kind === 'events' || terminalPath(request.path)?.kind === 'stream');
    const expected = ['/api/auth/login', '/api/setup/status', OWNER_SETUP_PATH].includes(request.path) ? [] : chat ? ['Authorization', 'Idempotency-Key'] : ['Authorization'];
    if (keys.length !== expected.length || keys.some(k => !expected.includes(k)) || expected.some(k => !Object.prototype.hasOwnProperty.call(request.headers, k))
      || (expected.includes('Authorization') && (request.headers.Authorization.length > 8200 || !/^Bearer [A-Za-z0-9._~-]+$/.test(request.headers.Authorization)))
      || (chat && !validKey(request.headers['Idempotency-Key']))) throw new SessionFailure('blocked');
    try {
      const response = await fetcher(origin + request.path, {
        method: request.method, body: request.body === undefined ? undefined : JSON.stringify(request.body),
        headers: { Accept: chat || runEvents ? 'text/event-stream' : 'application/json', ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...request.headers },
        signal: request.signal, credentials: request.path === '/api/auth/login' || request.headers.Authorization === 'Bearer dpro-remembered-session' ? 'same-origin' : 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      if (response.redirected || response.type === 'opaqueredirect' || (response.url && response.url !== origin + request.path) || (response.status >= 300 && response.status < 400)) throw new SessionFailure('blocked');
      if (runEvents && response.status === 200) {
        if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) { await response.body?.cancel(); throw new SessionFailure('unavailable'); }
        return { status: 200, body: null, stream: response.body };
      }
      if (chat && response.status === 200) {
        const runId = response.headers.get('x-run-id'), messageId = response.headers.get('x-message-id');
        if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body || !validId(runId) || !validId(messageId)) {
          await response.body?.cancel(); throw new SessionFailure('unavailable');
        }
        return { status: 200, body: null, stream: response.body, streamIds: { runId, messageId } };
      }
      // Never return backend error text, headers or exception messages to the UI.
      if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
        let body: unknown = null;
        if ((chat || response.status === 502 || response.status === 401 || response.status === 400 || response.status === 422 || response.status === 409 || response.status === 403 || response.status === 421 || response.status === 429) && /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
          try {
            if (chat && response.body) {
              const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
              try {
                while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 16384) throw Error(); parts.push(part.value); }
                const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
                body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
              } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            } else body = await response.json();
          } catch { /* An unparseable write failure has unknown outcome. */ }
        }
        return safeResponse(request.path, { status: response.status, body, retryAfterSeconds: response.status === 429 ? retryAfterSeconds(response.headers.get('retry-after')) : undefined });
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new SessionFailure('unavailable');
      return safeResponse(request.path, { status: response.status, body: await response.json() });
    } catch { throw new SessionFailure(request.signal.aborted ? 'cancelled' : 'unavailable'); }
  };
}

/** Where a local test build keeps its sign-in across a refresh (dev-session-keep.ts). */
export type TokenKeep = { load(): string | null; save(token: string | null): void };

export class SessionClient {
  #token: string | undefined;
  #keep: TokenKeep | undefined;
  /** Set by resume(): a later sign-in in this tab is kept too. */
  #nextKeep: TokenKeep | undefined;
  // One private slot per client; changing account or mode discards the prior binding.
  // Logout clears authentication, but retains this advisory credential for next login.
  #device: { email: string; token: string } | undefined;
  #deviceBinding: { email: string } | undefined;
  #loginAttempt = 0;
  #state: SessionState = Object.freeze({ mode: 'fixture', phase: 'signed-out', epoch: 0 });
  #pending = new Set<AbortController>();
  #listeners = new Set<() => void>();
  constructor(private readonly transports: { mock?: WireTransport; live?: WireTransport } = {}) {
    this.transports = Object.freeze({ ...transports });
  }
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  canUse(mode: Mode) { return mode === 'fixture' || !!this.transports[mode]; }
  #publish(state: SessionState) { this.#state = Object.freeze(state); this.#listeners.forEach(fn => fn()); }
  #reset(mode: Mode, phase: SessionState['phase'], notice?: SessionState['notice'], setup?: SessionState['setup'], delay?: number) {
    for (const controller of this.#pending) controller.abort();
    this.#pending.clear(); this.#token = undefined;
    this.#keep?.save(null); this.#keep = undefined;
    this.#publish({ mode, phase, epoch: this.#state.epoch + 1, ...(notice ? { notice } : {}), ...(setup ? { setup } : {}), ...(retryAfterSeconds(delay) !== undefined ? { retryAfterSeconds: delay } : {}) });
  }
  selectMode(mode: Mode) {
    if (!this.canUse(mode) || this.#state.phase === 'signing-out') return;
    this.#device = undefined; this.#deviceBinding = undefined; this.#nextKeep = undefined;
    this.#reset(mode, 'signed-out');
  }
  cancel() { this.#reset(this.#state.mode, 'signed-out', this.#state.phase === 'signing-out' ? 'logout-unknown' : undefined); }
  async #send(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, token: string | undefined, epoch: number, signal?: AbortSignal, observeResponse?: (response: WireResponse) => void): Promise<WireResponse> {
    const mode = this.#state.mode;
    if (mode === 'fixture' || !allowedRequest(method, path, body)) throw new SessionFailure('blocked');
    const transport = this.transports[mode];
    if (!transport) throw new SessionFailure('blocked');
    const controller = new AbortController(); this.#pending.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { this.#pending.delete(controller); signal.removeEventListener('abort', abort); throw new SessionFailure('blocked'); }
    try {
      const response = await transport({ method, path, ...(body === undefined ? {} : { body }), headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal });
      // The login observer may retain only an advisory rotation before cancellation.
      observeResponse?.(response);
      // A gate refusal settles this memory attempt even after its UI epoch changed.
      if (method === 'POST' && /^\/api\/memory\/proposals\/[^/]+\/(approve|reject)$/.test(path) && (response?.status === 401 || response?.status === 403)) return response;
      if (epoch !== this.#state.epoch || controller.signal.aborted) throw new SessionFailure('cancelled');
      if (!response || !Number.isInteger(response.status)) throw new SessionFailure('unavailable');
      return response;
    } catch (error) {
      if (error instanceof SessionFailure && error.code === 'blocked') throw error;
      throw new SessionFailure(epoch !== this.#state.epoch || controller.signal.aborted ? 'cancelled' : 'unavailable');
    }
    finally { this.#pending.delete(controller); signal?.removeEventListener('abort', abort); }
  }
  /** Explicit advisory GET only; never runs from mount, mode selection or login. */
  async discoverSetup() {
    if (this.#state.mode === 'fixture' || this.#state.phase !== 'signed-out' || this.#state.setup === 'checking') return;
    const mode = this.#state.mode;
    const notice = this.#state.notice?.startsWith('logout-') ? this.#state.notice : undefined;
    this.#reset(mode, 'signed-out', notice, 'checking');
    const epoch = this.#state.epoch;
    try {
      const response = await this.#send('GET', '/api/setup/status', undefined, undefined, epoch);
      if (epoch !== this.#state.epoch) return;
      const status = setupStatus(response.status, response.body);
      this.#publish({ ...this.#state, setup: status.setupRequired ? 'required' : 'login' });
    } catch {
      if (epoch === this.#state.epoch) this.#publish({ ...this.#state, setup: 'unavailable' });
    }
  }
  /**
   * INSTALLER-07: create the first owner with the one-time setup code from
   * the installation computer, then sign in with the same credentials.
   * Only after discovery reported "setup required"; never automatic.
   */
  async createOwner(input: OwnerSetupBody): Promise<{ ok: true } | { ok: false; code: OwnerSetupCode | 'unavailable' }> {
    if (this.#state.mode === 'fixture' || this.#state.phase !== 'signed-out' || this.#state.setup !== 'required') return { ok: false, code: 'unavailable' };
    if (!validOwnerSetupBody(input)) return { ok: false, code: 'missing_fields' };
    const epoch = this.#state.epoch;
    let result: ReturnType<typeof ownerSetupResponse>;
    try {
      const response = await this.#send('POST', OWNER_SETUP_PATH, { name: input.name, email: input.email, password: input.password, setupToken: input.setupToken }, undefined, epoch);
      result = ownerSetupResponse(response.status, response.body);
    } catch { return { ok: false, code: 'unavailable' }; }
    if (!result) return { ok: false, code: 'unavailable' };
    if ('code' in result) {
      // Someone finished setup meanwhile: go to sign-in.
      if (result.code === 'setup_complete' && epoch === this.#state.epoch) this.#publish({ ...this.#state, setup: 'login' });
      return { ok: false, code: result.code };
    }
    if (epoch === this.#state.epoch && this.#state.phase === 'signed-out') {
      this.#publish({ ...this.#state, setup: 'login' });
      await this.login(input.email, input.password);
    }
    return { ok: true };
  }
  async login(email: string, password: string) {
    const keep = this.#nextKeep;
    if (this.#state.mode === 'fixture' || this.#state.phase === 'signing-out') return;
    // Discovery is advisory; explicit low-level login still authenticates through login + me.
    // Once checked, unavailable/incomplete discovery cannot fall through to a login.
    const setup = this.#state.setup;
    if (setup && setup !== 'login') return;
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (this.#deviceBinding?.email !== normalizedEmail) {
      this.#device = undefined; this.#deviceBinding = { email: normalizedEmail };
    }
    const binding = this.#deviceBinding, mode = this.#state.mode;
    const attempt = ++this.#loginAttempt;
    const deviceToken = this.#device?.token;
    this.#reset(this.#state.mode, 'signing-in', undefined, setup); const epoch = this.#state.epoch;
    try {
      const response = await this.#send('POST', '/api/auth/login', { email, password, ...(deviceToken ? { deviceToken } : {}) }, undefined, epoch, undefined, result => {
        // Epoch changes may cancel auth after the server rotated this credential.
        // A mode/account round trip or newer login attempt invalidates this binding.
        if (binding !== this.#deviceBinding || mode !== this.#state.mode || attempt !== this.#loginAttempt || result?.status !== 200) return;
        this.#device = undefined;
        if (record(result.body) && validDeviceToken(result.body.deviceToken)) this.#device = { email: normalizedEmail, token: result.body.deviceToken };
      });
      if (epoch !== this.#state.epoch) return;
      if (response.status !== 200) {
        this.#reset(this.#state.mode, 'signed-out', boundaryNotice(response) ?? (response.status === 401 || response.status === 400 ? 'invalid' : response.status === 403 ? 'denied' : response.status === 429 ? 'limited' : 'unavailable'), setup, response.status === 429 ? retryAfterSeconds(response.retryAfterSeconds) : undefined); return;
      }
      // A success rotates at the server even if /me later fails. Never reuse its predecessor.
      this.#device = undefined;
      if (!record(response.body) || !validDeviceToken(response.body.deviceToken) || typeof response.body.token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(response.body.token)) throw new SessionFailure('unavailable');
      const loginUser = user(response.body.user); const token = response.body.token;
      this.#device = { email: normalizedEmail, token: response.body.deviceToken };
      const me = await this.#send('GET', '/api/auth/me', undefined, token, epoch);
      if (epoch !== this.#state.epoch) return;
      if (me.status !== 200 || !record(me.body)) throw new SessionFailure('unavailable');
      const current = user(me.body.user);
      if (current.id !== loginUser.id) throw new SessionFailure('unavailable');
      this.#token = token; this.#keep = keep; keep?.save(token); this.#publish({ mode: this.#state.mode, phase: 'authenticated', epoch, user: current });
    } catch { if (epoch === this.#state.epoch) this.#reset(this.#state.mode, 'signed-out', 'unavailable', setup); }
  }
  /**
   * Local test build only: signs back in with a kept token after a refresh
   * (checked with /api/auth/me). Returns false when there was nothing to
   * resume or the token no longer works; the kept copy is then dropped.
   */
  async resume(keep: TokenKeep): Promise<boolean> {
    if (this.#state.mode !== 'live' || this.#state.phase !== 'signed-out') return false;
    const token = keep.load();
    if (!token) { this.#nextKeep = keep; return false; }
    this.#reset('live', 'signing-in'); const epoch = this.#state.epoch;
    this.#nextKeep = keep;
    try {
      const me = await this.#send('GET', '/api/auth/me', undefined, token, epoch);
      if (epoch !== this.#state.epoch) return false;
      if (me.status !== 200 || !record(me.body)) { keep.save(null); this.#reset('live', 'signed-out'); return false; }
      this.#token = token; this.#keep = keep; keep.save(token);
      this.#publish({ mode: 'live', phase: 'authenticated', epoch, user: user(me.body.user) });
      return true;
    } catch { if (epoch === this.#state.epoch) { keep.save(null); this.#reset('live', 'signed-out'); } return false; }
  }
  request = async (request: Request, signal?: AbortSignal): Promise<WireResponse> => {
    if (!this.#token || this.#state.phase !== 'authenticated') throw new SessionFailure('blocked');
    // The public adapter transport cannot call login/logout or add arbitrary request fields.
    if (request.path === '/api/setup/status' || request.path === OWNER_SETUP_PATH || request.path === '/api/chat' || request.path === '/api/auth/login' || request.path === '/api/auth/logout' || Object.keys(request).some(k => !['method', 'path', 'body'].includes(k))) throw new SessionFailure('blocked');
    if ((conversationRoute(request.path) || chatSearchRoute(request.path) || chatExportRoute(request.path) || chatSecretsRoute(request.path)) && this.#state.user?.role === 'guest') throw new SessionFailure('blocked');
    if (request.path === CLEANUP_PATH && this.#state.user?.role !== 'owner') throw new SessionFailure('blocked');
    if ((request.path === '/api/chat/project-folders' || approvalRoute(request.path) || templatePath(request.path) || mcpImportPath(request.path) || channelRoute(request.path) || connectorRoute(request.path) || localImportRoute(request.path) || chatBoardRoute(request.path) || chatMemoryRoute(request.path)) && this.#state.user?.role !== 'owner') throw new SessionFailure('blocked');
    if (terminalRoute(request.path) && (this.#state.user?.role !== 'owner' || terminalPath(request.path)?.kind === 'stream')) throw new SessionFailure('blocked');
    if (request.method === 'PUT' && !conversationRoute(request.path) && this.#state.user?.role !== 'owner') throw new SessionFailure('blocked');
    if (request.method === 'POST' && request.path.startsWith('/api/memory/') && this.#state.user?.role !== 'owner') throw new SessionFailure('blocked');
    if ((personalityRoute(request.path) || cardRoute(request.path) || (request.method === 'DELETE' && !conversationRoute(request.path) && !chatSecretsRoute(request.path))) && this.#state.user?.role !== 'owner') throw new SessionFailure('blocked');
    if (((request.method === 'POST' && request.path === '/api/agents') || grantsAgentId(request.path) || request.path === CATALOGUE_PATH || request.path === PLAN_PATH || request.path === DISTRIBUTION_PATH || request.path === BATCHES_PATH || batchPath(request.path) || permissionsAgentId(request.path) || request.path === BOARDS_PATH || request.path.startsWith(`${BOARDS_PATH}/`)) && this.#state.user?.role !== 'owner') throw new SessionFailure('blocked');
    const epoch = this.#state.epoch;
    const result = await this.#send(request.method, request.path, 'body' in request ? request.body : undefined, this.#token, epoch, signal);
    if (epoch !== this.#state.epoch) return safeResponse(request.path, result);
    if (result.status === 403 && record(result.body) && result.body.code === 'inactive_user') this.#reset(this.#state.mode, 'signed-out', 'denied');
    if (result.status === 401) this.#reset(this.#state.mode, 'signed-out', 'expired');
    const notice = boundaryNotice(result);
    if (notice || result.status === 429 || result.status === 421) this.#publish({ ...this.#state, notice: notice ?? (result.status === 429 ? 'limited' : 'unavailable'), retryAfterSeconds: result.status === 429 ? retryAfterSeconds(result.retryAfterSeconds) : undefined });
    return safeResponse(request.path, result);
  };
  /** One explicit POST, scoped to the authenticated epoch until the reader closes. */
  chat = async (body: ChatBody, key: string, onFrame: (frame: ChatFrame) => void, signal: AbortSignal): Promise<WireResponse> => {
    if (!this.#token || this.#state.phase !== 'authenticated' || this.#state.user?.role === 'guest' || !validChatBody(body) || !validKey(key)) throw new SessionFailure('blocked');
    const { mode, epoch } = this.#state;
    const transport = mode === 'fixture' ? undefined : this.transports[mode];
    if (!transport) throw new SessionFailure('blocked');
    const controller = new AbortController(); this.#pending.add(controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}); };
    let deadlineReached = false;
    const timer = setTimeout(() => { deadlineReached = true; abort(); }, CHAT_DEADLINE_MS);
    let idle = setTimeout(abort, CHAT_IDLE_MS);
    signal.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener('abort', () => { void reader?.cancel().catch(() => {}); }, { once: true });
    const active = () => { if (controller.signal.aborted || epoch !== this.#state.epoch) throw new SessionFailure('cancelled'); };
    try {
      if (signal.aborted) abort(); active();
      const response = await transport({ method: 'POST', path: '/api/chat', body: JSON.parse(JSON.stringify(body)),
        headers: { Authorization: `Bearer ${this.#token}`, 'Idempotency-Key': key }, signal: controller.signal });
      if (controller.signal.aborted || epoch !== this.#state.epoch) { await response.stream?.cancel(); active(); }
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new SessionFailure('unavailable');
      if (response.status !== 200) {
        const safe = safeResponse('/api/chat', response);
        if (safe.status === 401) this.#reset(mode, 'signed-out', 'expired');
        else if (safe.status === 403 && record(safe.body) && safe.body.code === 'inactive_user') this.#reset(mode, 'signed-out', 'denied');
        else { const notice = boundaryNotice(safe); if (notice || safe.status === 429) this.#publish({ ...this.#state, notice: notice ?? 'limited', retryAfterSeconds: safe.status === 429 ? retryAfterSeconds(safe.retryAfterSeconds) : undefined }); }
        return safe;
      }
      if (!response.stream) throw new SessionFailure('unavailable');
      reader = response.stream.getReader();
      const parser = new SSEParser(response.streamIds);
      while (true) {
        const part = await reader.read(); active();
        clearTimeout(idle); idle = setTimeout(abort, CHAT_IDLE_MS);
        if (part.done) { parser.finish(); break; }
        for (const frame of parser.push(part.value)) { active(); onFrame(frame); }
      }
      return { status: 200, body: null };
    } catch { throw new SessionFailure(epoch !== this.#state.epoch || signal.aborted ? 'cancelled' : deadlineReached ? 'deadline' : controller.signal.aborted ? 'cancelled' : 'unavailable'); }
    finally { clearTimeout(timer); clearTimeout(idle); await reader?.cancel().catch(() => {}); reader?.releaseLock(); this.#pending.delete(controller); signal.removeEventListener('abort', abort); }
  };
  /**
   * Reads a chat run's events after `after` until the run ends, the reader's
   * time cap passes or the signal aborts. Resolves with the last sequence
   * number seen and whether the run's end event arrived; the caller
   * re-attaches with that number when it did not.
   */
  runEvents = async (runId: string, after: number, onEvent: (event: RunEvent) => void, signal: AbortSignal): Promise<{ last: number; ended: boolean }> => {
    const path = `/api/chat/runs/${runId}/events${after > 0 ? `?after=${after}` : ''}`;
    if (!this.#token || this.#state.phase !== 'authenticated' || this.#state.user?.role === 'guest' || conversationPath(path)?.kind !== 'events') throw new SessionFailure('blocked');
    const { mode, epoch } = this.#state;
    const transport = mode === 'fixture' ? undefined : this.transports[mode];
    if (!transport) throw new SessionFailure('blocked');
    const controller = new AbortController(); this.#pending.add(controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}); };
    const cap = setTimeout(abort, RUN_STREAM_MS + 5000);
    let idle = setTimeout(abort, RUN_IDLE_MS + 5000);
    signal.addEventListener('abort', abort, { once: true });
    const parser = new RunEventParser(after);
    try {
      if (signal.aborted) throw new SessionFailure('cancelled');
      const response = await transport({ method: 'GET', path, headers: { Authorization: `Bearer ${this.#token}` }, signal: controller.signal });
      if (epoch !== this.#state.epoch) { await response.stream?.cancel(); throw new SessionFailure('cancelled'); }
      if (response.status === 401) { this.#reset(mode, 'signed-out', 'expired'); throw new SessionFailure('cancelled'); }
      if (response.status === 404) throw new SessionFailure('unavailable');
      if (response.status !== 200 || !response.stream) throw new SessionFailure('unavailable');
      reader = response.stream.getReader();
      while (true) {
        const part = await reader.read();
        if (epoch !== this.#state.epoch) throw new SessionFailure('cancelled');
        clearTimeout(idle); idle = setTimeout(abort, RUN_IDLE_MS + 5000);
        if (part.done) { parser.finish(); break; }
        for (const event of parser.push(part.value)) onEvent(event);
        if (parser.ended) break;
      }
      return { last: parser.last, ended: parser.ended };
    } catch (error) {
      if (error instanceof SessionFailure && error.code !== 'unavailable') throw error;
      // A dropped or capped connection is not a failed run: report how far we got.
      if (controller.signal.aborted && !signal.aborted && epoch === this.#state.epoch) return { last: parser.last, ended: parser.ended };
      throw new SessionFailure(signal.aborted || epoch !== this.#state.epoch ? 'cancelled' : 'unavailable');
    } finally {
      clearTimeout(cap); clearTimeout(idle); await reader?.cancel().catch(() => {}); reader?.releaseLock();
      this.#pending.delete(controller); signal.removeEventListener('abort', abort);
    }
  };
  /**
   * Reads a terminal's output after `after` until it exits, the reader's cap
   * passes or the signal aborts (owner only). Resolves with the last sequence
   * number and whether the shell exited; the caller re-attaches otherwise.
   */
  terminalStream = async (id: string, after: number, onFrame: (frame: TerminalFrame) => void, signal: AbortSignal): Promise<{ last: number; ended: boolean }> => {
    const path = `/api/terminal/sessions/${id}/stream${after > 0 ? `?after=${after}` : ''}`;
    if (!this.#token || this.#state.phase !== 'authenticated' || this.#state.user?.role !== 'owner' || terminalPath(path)?.kind !== 'stream') throw new SessionFailure('blocked');
    const { mode, epoch } = this.#state;
    const transport = mode === 'fixture' ? undefined : this.transports[mode];
    if (!transport) throw new SessionFailure('blocked');
    const controller = new AbortController(); this.#pending.add(controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}); };
    const cap = setTimeout(abort, TERMINAL_STREAM_MS + 5000);
    let idle = setTimeout(abort, RUN_IDLE_MS + 5000);
    signal.addEventListener('abort', abort, { once: true });
    const parser = new TerminalEventParser(after);
    try {
      if (signal.aborted) throw new SessionFailure('cancelled');
      const response = await transport({ method: 'GET', path, headers: { Authorization: `Bearer ${this.#token}` }, signal: controller.signal });
      if (epoch !== this.#state.epoch) { await response.stream?.cancel(); throw new SessionFailure('cancelled'); }
      if (response.status === 401) { this.#reset(mode, 'signed-out', 'expired'); throw new SessionFailure('cancelled'); }
      if (response.status === 404) return { last: parser.last, ended: true };
      if (response.status !== 200 || !response.stream) throw new SessionFailure('unavailable');
      reader = response.stream.getReader();
      while (true) {
        const part = await reader.read();
        if (epoch !== this.#state.epoch) throw new SessionFailure('cancelled');
        clearTimeout(idle); idle = setTimeout(abort, RUN_IDLE_MS + 5000);
        if (part.done) { parser.finish(); break; }
        for (const frame of parser.push(part.value)) onFrame(frame);
        if (parser.ended) break;
      }
      return { last: parser.last, ended: parser.ended };
    } catch (error) {
      if (error instanceof SessionFailure && error.code !== 'unavailable') throw error;
      if (controller.signal.aborted && !signal.aborted && epoch === this.#state.epoch) return { last: parser.last, ended: parser.ended };
      throw new SessionFailure(signal.aborted || epoch !== this.#state.epoch ? 'cancelled' : 'unavailable');
    } finally {
      clearTimeout(cap); clearTimeout(idle); await reader?.cancel().catch(() => {}); reader?.releaseLock();
      this.#pending.delete(controller); signal.removeEventListener('abort', abort);
    }
  };
  async logoutAllDevices() {
    if (!this.#token || this.#state.phase !== 'authenticated') return;
    const token = this.#token; const mode = this.#state.mode;
    this.#reset(mode, 'signing-out'); const epoch = this.#state.epoch;
    try {
      const result = await this.#send('POST', '/api/auth/logout', undefined, token, epoch);
      const confirmed = result.status === 200 && record(result.body) && result.body.success === true;
      this.#reset(mode, 'signed-out', confirmed ? 'logout-confirmed' : 'logout-unknown');
    } catch { if (epoch === this.#state.epoch) this.#reset(mode, 'signed-out', 'logout-unknown'); }
  }
}

/** Synchronous session subscription clears private memory before any React unmount. */
export function bindMemorySession(client: SessionClient, controller: MemoryController): () => void {
  const sync = () => {
    const state = client.getSnapshot();
    controller.setContext({ ...controller.getSnapshot().context,
      userId: state.user?.id ?? '', session: String(state.epoch),
      access: state.phase === 'authenticated' && state.user?.role === 'owner' ? 'owner' : 'denied',
    });
  };
  sync();
  const unsubscribe = client.subscribe(sync);
  return () => { unsubscribe(); controller.invalidate(); };
}
