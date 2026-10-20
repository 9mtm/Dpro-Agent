// CHAT-REBUILD-01: the chat page's state. Saved conversations (list, open,
// rename, pin, delete), sending a message as a run, following the run's
// events (and re-attaching after a dropped connection or a reload), Stop,
// and a queue of messages typed while the agent is still working.
import { SessionFailure } from './session-failure';
import type { SessionClient } from './session';
import { MAX_MESSAGE, validRunId } from './conversation-contract.js';
import type { RunEvent, WireConversation, WireGit, WireMessage, WireProject } from './conversation-contract.js';
import { applyEvent, fromWire, liveTurn, userTurn } from './turns';
import { exportConversation } from './chat-export';
import type { ExportResult } from './chat-export';
import type { Turn } from './turns';

export type Conversation = WireConversation;
export type Project = WireProject;
export type AgentChoice = Readonly<{ id: string; name: string; primary?: boolean }>;
export type ModelOption = Readonly<{ id: string; provider: 'ollama' | 'claude' | 'lmstudio' | 'subscription'; label: string; size: string; variants?: readonly Readonly<{ id: string; label: string }>[] }>;
export type ConversationsState = Readonly<{
  access: 'ready' | 'denied';
  listPhase: 'idle' | 'loading' | 'ready' | 'error';
  conversations: readonly Conversation[];
  activeId: string | null;
  threadPhase: 'empty' | 'loading' | 'ready' | 'error';
  turns: readonly Turn[];
  draft: string;
  agentId: string;
  /** CHAT-PRO-02 I: the agent writing the next reply in an open conversation ('' = the conversation's agent). */
  replyAgent: string;
  agents: readonly AgentChoice[];
  /** Models the owner can pick for the next reply ('' = the agent's own model). */
  models: readonly ModelOption[];
  model: string;
  /** Projects (owner only) and the one the list is filtered to ('' = all chats). */
  projects: readonly Project[];
  projectFilter: string;
  /** Git state of the open conversation's project folder. */
  git: WireGit | null;
  runId: string | null;
  starting: boolean;
  stopping: boolean;
  reconnecting: boolean;
  queue: readonly { key: string; text: string }[];
  /** Text files attached to the next message (read in the browser). */
  attachments: readonly { name: string; text: string }[];
  /** After Stop the queue waits for the owner (Send now) instead of going on its own. */
  queuePaused: boolean;
  /** CHAT-PRO-02 D: a message to scroll to and highlight once (from search); `n` changes per request. */
  focus: Readonly<{ messageId: string; n: number }> | null;
  notice?: string;
}>;

const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const RETRY_MS = [500, 1000, 2000, 4000, 8000];
export const ATTACH_FILE_CHARS = 60_000;
export const ATTACH_TOTAL_CHARS = 90_000;
const LANG: Record<string, string> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', php: 'php', sh: 'bash', zsh: 'bash', sql: 'sql', json: 'json', yml: 'yaml', yaml: 'yaml', md: 'markdown', html: 'html', css: 'css', csv: 'csv', xml: 'xml', toml: 'toml' };
/** The message text with each attached file as a fenced block. */
export function withAttachments(message: string, files: readonly { name: string; text: string }[]): string {
  if (!files.length) return message;
  const blocks = files.map(f => { const ext = f.name.split('.').at(-1)?.toLowerCase() ?? ''; const fence = f.text.includes('```') ? '~~~~' : '```'; return `Attached file \`${f.name}\`:\n${fence}${LANG[ext] ?? ''}\n${f.text}\n${fence}`; });
  return [message || 'Please look at the attached files.', ...blocks].join('\n\n');
}

const emptyState = (): ConversationsState => Object.freeze({
    access: 'ready', listPhase: 'idle', conversations: [], activeId: null, threadPhase: 'empty', turns: [], draft: '', agentId: '', replyAgent: '', agents: [], models: [], model: '', projects: [], projectFilter: '', git: null,
    runId: null, starting: false, stopping: false, reconnecting: false, queue: [], queuePaused: false, attachments: [], focus: null,
});

export class ConversationsController {
  #state: ConversationsState = emptyState();
  #listeners = new Set<() => void>();
  #unsubscribe: () => void;
  #epoch: number;
  #follow?: AbortController;
  #openSeq = 0;
  #disposed = false;
  #history: string[] = [];

  constructor(private readonly client: SessionClient, private readonly newId: () => string = () => crypto.randomUUID(), private readonly now: () => number = Date.now) {
    this.#epoch = client.getSnapshot().epoch;
    if (!this.allowed()) this.#state = Object.freeze({ ...this.#state, access: 'denied' });
    this.#unsubscribe = client.subscribe(() => { if (this.#epoch !== client.getSnapshot().epoch || !this.allowed()) this.clear(); });
  }
  private allowed() { const s = this.client.getSnapshot(); return s.phase === 'authenticated' && s.user?.role !== 'guest'; }
  private live() { return !this.#disposed && this.allowed() && this.#epoch === this.client.getSnapshot().epoch; }
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  private publish(patch: Partial<ConversationsState>) { if (this.#disposed) return; this.#state = Object.freeze({ ...this.#state, ...patch }); this.#listeners.forEach(fn => fn()); }
  private clear() {
    this.#follow?.abort();
    this.#openSeq++;
    this.#history = [];
    this.#modelsAt = 0;
    this.#modelSaveFailures.clear();
    this.publish({ ...emptyState(), access: 'denied', notice: undefined });
  }
  dispose() { this.#follow?.abort(); this.#unsubscribe(); this.#disposed = true; this.#listeners.clear(); }

  edit(draft: string) { this.publish({ draft: draft.slice(0, MAX_MESSAGE) }); }
  selectAgent(agentId: string) { if (!this.#state.activeId) this.publish({ agentId }); }
  /** In an open conversation: which agent writes the next replies ('' = the conversation's own agent). */
  setReplyAgent(agentId: string) { if (agentId === '' || this.#state.agents.some(a => a.id === agentId)) this.publish({ replyAgent: agentId }); }
  /** The agent an "@Name" in the text points to (longest name wins), if any. */
  mentioned(text: string): AgentChoice | undefined {
    const lower = text.toLowerCase();
    return [...this.#state.agents].sort((a, b) => b.name.length - a.name.length)
      .find(a => { const i = lower.indexOf(`@${a.name.toLowerCase()}`); const next = lower[i + a.name.length + 1]; return i >= 0 && (i === 0 || /\s/.test(lower[i - 1])) && (next === undefined || !/[\p{L}\p{N}_]/u.test(next)); });
  }
  /** Adds text files to the next message; refuses files that are too big or not text. */
  attach(files: readonly { name: string; text: string }[]): string | null {
    const next = [...this.#state.attachments];
    for (const f of files) {
      if (f.text.length > ATTACH_FILE_CHARS) return `${f.name} is too big (more than ${ATTACH_FILE_CHARS / 1000}k characters).`;
      if (/\u0000/.test(f.text)) return `${f.name} is not a text file.`;
      next.push({ name: f.name.slice(0, 120), text: f.text });
    }
    if (next.reduce((n, f) => n + f.text.length, 0) > ATTACH_TOTAL_CHARS) return 'Attached files are too big together.';
    this.publish({ attachments: next });
    return null;
  }
  detach(name: string) { this.publish({ attachments: this.#state.attachments.filter(f => f.name !== name) }); }

  /** The last sent message (↑ in an empty composer). */
  recall(): string | undefined { return this.#history.at(-1); }

  private async call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    if (!this.live()) return { status: 403, body: null };
    const r = await this.client.request(body === undefined ? { method, path } as never : { method, path, body } as never);
    return this.live() ? r : { status: 403, body: null };
  }

  async load() {
    if (!this.live() || this.#state.listPhase === 'loading') return;
    this.publish({ listPhase: 'loading' });
    try {
      const r = await this.call('GET', '/api/chat/conversations');
      if (!this.live()) return;
      if (r.status !== 200 || !record(r.body) || !Array.isArray(r.body.conversations)) { this.publish({ listPhase: 'error' }); return; }
      this.publish({ listPhase: 'ready', conversations: r.body.conversations as Conversation[] });
    } catch { if (this.live()) this.publish({ listPhase: 'error' }); }
    void this.loadAgents();
    void this.loadModels();
    void this.loadProjects();
  }

  /** The team for the agent picker (owner only; others talk to the primary agent). */
  #modelsAt = 0;
  /**
   * Installed models for the picker (owner only; others use the agent's model):
   * whatever runs on this computer right now (Ollama, LM Studio) plus Claude
   * with a key. `refresh` asks again (at most every 5 s), so a local server
   * started later shows up when the picker is opened.
   */
  async loadModels(refresh = false) {
    if (!this.live() || this.client.getSnapshot().user?.role !== 'owner' || (this.#state.models.length && !refresh)) return;
    if (refresh && Date.now() - this.#modelsAt < 5000) return;
    this.#modelsAt = Date.now();
    try {
      const r = await this.client.request({ method: 'GET', path: '/api/models' } as never);
      if (!this.live() || r.status !== 200 || !record(r.body) || !Array.isArray(r.body.models)) return;
      const models = r.body.models as ModelOption[];
      // A picked model that is gone (its server stopped) stays picked: the reply then says why it failed.
      this.publish({ models: this.#state.model && !models.some(m => m.id === this.#state.model) ? [...models, ...this.#state.models.filter(m => m.id === this.#state.model)] : models });
    } catch { /* the picker stays as it was */ }
  }
  async loadProjects() {
    if (!this.live() || this.client.getSnapshot().user?.role !== 'owner') return;
    try {
      const r = await this.call('GET', '/api/chat/projects');
      if (this.live() && r.status === 200 && record(r.body) && Array.isArray(r.body.projects)) this.publish({ projects: r.body.projects as Project[] });
    } catch { /* projects stay hidden */ }
  }
  /** Shows only one project's conversations ('' = all); a new chat goes into it. */
  filterProject(id: string) { if (id === '' || this.#state.projects.some(p => p.id === id)) this.publish({ projectFilter: id }); }
  async browseProjectFolders(path?:string):Promise<{path:string;parent:string|null;selectable:boolean;truncated:boolean;entries:{name:string;path:string}[]}>{
    const r=await this.call('POST','/api/chat/project-folders',path?{path}:{});
    if(r.status!==200)throw Error('Folder unavailable');return r.body as never;
  }
  /** Creates a project; resolves with an error message for the form, or null on success. */
  async createProject(input: { name: string; folder: string; repoUrl: string }): Promise<string | null> {
    const body: Record<string, string> = { name: input.name.trim() };
    if (input.folder.trim()) body.folder = input.folder.trim();
    if (input.repoUrl.trim()) body.repoUrl = input.repoUrl.trim();
    if (!body.name) return 'Give the project a name.';
    if (!body.folder) return 'Choose a working folder for this project, or use General chat.';
    try {
      const r = await this.call('POST', '/api/chat/projects', body);
      if ((r.status === 201 || r.status === 200) && record(r.body) && record(r.body.project)) {
        const p = r.body.project as Project;
        this.publish({ projects: [...this.#state.projects, p].sort((a, b) => a.name.localeCompare(b.name)), projectFilter: p.id });
        this.newChat();
        return null;
      }
      return r.status === 400 ? 'Check the folder: it must be a full path to an existing folder (not the whole disk or your home folder). The repo must be an https or git@ address.' : 'The project was not created.';
    } catch { return 'The project was not created (no connection).'; }
  }
  /** Renames a project or changes its folder or repo (empty folder/repo clears it). */
  async editProject(id: string, input: { name: string; folder: string; repoUrl: string }): Promise<string | null> {
    const name = input.name.trim();
    if (!name) return 'Give the project a name.';
    try {
      const r = await this.call('PUT', `/api/chat/projects/${id}`, { name, folder: input.folder.trim() || null, repoUrl: input.repoUrl.trim() || null });
      if (r.status === 200 && record(r.body) && record(r.body.project)) {
        const p = r.body.project as Project;
        this.publish({ projects: this.#state.projects.map(x => (x.id === id ? p : x)).sort((a, b) => a.name.localeCompare(b.name)) });
        void this.loadGit();
        return null;
      }
      return r.status === 400 ? 'Check the folder: it must be a full path to an existing folder (not the whole disk or your home folder). The repo must be an https or git@ address.' : 'The project was not saved.';
    } catch { return 'The project was not saved (no connection).'; }
  }
  async removeProject(id: string) {
    const r = await this.call('DELETE', `/api/chat/projects/${id}`);
    if (!this.live() || r.status !== 200) return;
    this.publish({ projects: this.#state.projects.filter(p => p.id !== id), projectFilter: this.#state.projectFilter === id ? '' : this.#state.projectFilter,
      conversations: this.#state.conversations.map(c => (c.projectId === id ? { ...c, projectId: null } : c)) });
  }
  /** Moves a conversation into a project (or out with ''). */
  async moveToProject(conversationId: string, projectId: string) {
    const r = await this.call('PUT', `/api/chat/conversations/${conversationId}`, { projectId: projectId || null });
    if (this.live() && r.status === 200 && record(r.body) && record(r.body.conversation)) { this.replace(r.body.conversation as Conversation); if (conversationId === this.#state.activeId) void this.loadGit(); }
  }
  /** The open conversation's project (if any). */
  activeProject(): Project | undefined {
    const c = this.#state.conversations.find(x => x.id === this.#state.activeId);
    const id = c?.projectId ?? (this.#state.activeId ? null : this.#state.projectFilter || null);
    return id ? this.#state.projects.find(p => p.id === id) : undefined;
  }
  /** Reloads the project's git state (branch, changes, ahead/behind). */
  refreshGit() { return this.loadGit(); }
  private async loadGit() {
    const p = this.activeProject();
    if (!p?.folder) { this.publish({ git: null }); return; }
    try {
      const r = await this.call('GET', `/api/chat/projects/${p.id}/git`);
      if (this.live() && r.status === 200 && record(r.body)) this.publish({ git: r.body.git as WireGit });
    } catch { this.publish({ git: null }); }
  }

  resumeCodingSession(id:string,source:'claude-code'|'codex'){
    const project=this.activeProject();if(!this.live()||!project?.folder||!/^[a-f0-9]{32}$/.test(id))return;
    const model='subscription:'+(source==='claude-code'?'claude':'codex')+':'+id;this.filterProject(project.id);this.newChat();
    this.publish({model,models:[...this.#state.models.filter(m=>m.id!==model),{id:model,provider:'subscription',label:(source==='codex'?'Codex':'Claude Code')+' · previous session',size:''}]});
  }
  #modelWrites: Promise<void> = Promise.resolve();
  #pendingModelWrites = 0;
  #modelSaveFailures = new Set<string>();
  /** CORE-PICKER-02: a listed coding app (or this chat's previous session of it) with one of the app's own models. */
  #appModel(model:string):boolean{
    const m=/^(subscription:(claude|codex))(:[a-f0-9]{32})?(?:\/([a-z0-9][a-z0-9.-]{0,40}))?$/.exec(model);if(!m)return false;
    const app=this.#state.models.find(x=>x.id===m[1]&&x.provider==='subscription');if(!app)return false;
    if(m[3]&&!this.#state.model.startsWith(m[1]+m[3]))return false;
    return !m[4]||!!app.variants?.some(v=>v.id===m[4]);
  }
  selectModel(model: string) {
    if(!this.live() || !(model===''||this.#state.models.some(m=>m.id===model)||this.#appModel(model)))return;
    this.publish({model});const id=this.#state.activeId;if(!id)return;
    this.#pendingModelWrites++;
    this.#modelWrites=this.#modelWrites.then(async()=>{
      if(!this.live())return;
      try{const r=await this.call('PUT',`/api/chat/conversations/${id}`,{model});
        if(r.status!==200||!record(r.body)||!record(r.body.conversation))throw Error();
        this.#modelSaveFailures.delete(id);if(this.live())this.replace(r.body.conversation as Conversation);
      }catch{if(!this.live())return;this.#modelSaveFailures.add(id);if(this.live()&&this.#state.activeId===id)this.publish({notice:'The model choice was not saved. Choose it again before sending.'});}
    }).finally(()=>{this.#pendingModelWrites--;});
  }

  async loadAgents() {
    if (!this.live() || this.client.getSnapshot().user?.role !== 'owner' || this.#state.agents.length) return;
    try {
      const r = await this.client.request({ method: 'GET', path: '/api/agents' });
      if (!this.live() || r.status !== 200 || !record(r.body) || !Array.isArray(r.body.agents)) return;
      this.publish({ agents: (r.body.agents as { id: string; name?: string; isPrimary?: boolean }[]).map(a => ({ id: a.id, name: a.name ?? a.id, ...(a.isPrimary ? { primary: true } : {}) })) });
    } catch { /* the picker stays on the primary agent */ }
  }

  /** A blank conversation (created on the first message). */
  newChat() {
    this.#follow?.abort(); this.#openSeq++;
    this.publish({ activeId: null, model: '', turns: [], threadPhase: 'empty', runId: null, starting: false, stopping: false, reconnecting: false, queue: [], queuePaused: false, notice: undefined, agentId: '', replyAgent: '', git: null, focus: null });
    void this.loadGit();
  }

  async open(id: string) {
    if (!this.live()) return;
    this.#follow?.abort();
    const seq = ++this.#openSeq;
    const known = this.#state.conversations.find(c => c.id === id);
    this.publish({ activeId: id, turns: [], threadPhase: 'loading', runId: null, starting: false, stopping: false, reconnecting: false, queue: [], queuePaused: false, notice: undefined, agentId: known?.agentId ?? '', model: known?.model ?? '', replyAgent: '', focus: null });
    try {
      await this.#modelWrites;if(!this.live()||seq!==this.#openSeq)return;
      const r = await this.call('GET', `/api/chat/conversations/${id}/messages`);
      if (!this.live() || seq !== this.#openSeq) return;
      if (r.status === 404) { this.publish({ threadPhase: 'error', notice: 'This conversation no longer exists.', conversations: this.#state.conversations.filter(c => c.id !== id) }); return; }
      if (r.status !== 200 || !record(r.body)) { this.publish({ threadPhase: 'error', notice: 'The conversation could not be loaded.' }); return; }
      const messages = r.body.messages as WireMessage[];
      const active = r.body.activeRunId as string | null;
      // A running turn is rebuilt from its events, not from a stored row.
      const turns = messages.map(fromWire);
      if (active) turns.push(liveTurn(active, this.now()));
      const conversation=r.body.conversation as Conversation;this.replace(conversation);
      this.publish({ turns, threadPhase: 'ready', runId: active, model: conversation.model ?? '' });
      void this.loadGit();
      if (active) void this.follow(active, seq);
    } catch { if (this.live() && seq === this.#openSeq) this.publish({ threadPhase: 'error', notice: 'The conversation could not be loaded.' }); }
  }

  /** Opens a conversation (if it is not open yet) and asks the view to show one message (search hit). */
  async openAt(id: string, messageId: string | null) {
    if (!this.live()) return;
    if (this.#state.activeId !== id || this.#state.threadPhase === 'error') await this.open(id);
    if (!this.live() || this.#state.activeId !== id || !messageId) return;
    this.publish({ focus: { messageId, n: (this.#state.focus?.n ?? 0) + 1 } });
  }
  clearFocus() { if (this.#state.focus) this.publish({ focus: null }); }

  /** Sends the draft (or `text`); while the agent works, the message waits in the queue. */
  async send(text?: string) {
    const files = text === undefined ? this.#state.attachments : [];
    const message = withAttachments((text ?? this.#state.draft).trim(), files);
    if (!this.live() || !message || message.length > MAX_MESSAGE) return;
    if(this.#pendingModelWrites)await this.#modelWrites;if(!this.live())return;
    if(this.#state.activeId&&this.#modelSaveFailures.has(this.#state.activeId)){this.publish({notice:'The model choice was not saved. Choose it again before sending.'});return;}
    if (this.#state.runId || this.#state.starting) {
      this.publish({ queue: [...this.#state.queue, { key: this.newId(), text: message }], ...(text === undefined ? { draft: '' } : {}) });
      return;
    }
    const seq = this.#openSeq;
    this.#history.push(message);
    let runId: string;
    try { runId = `run-${this.newId()}`; } catch { this.publish({ notice: 'A secure id is not available here. Nothing was sent.' }); return; }
    if (!validRunId(runId)) return;
    const optimistic = userTurn(`pending:${runId}`, message, runId, true);
    this.publish({ starting: true, notice: undefined, turns: [...this.#state.turns, optimistic], threadPhase: 'ready', ...(text === undefined ? { draft: '', attachments: [] } : {}) });
    try {
      let id = this.#state.activeId;
      const named = this.mentioned(message)?.id;
      if (!id) {
        const c = await this.call('POST', '/api/chat/conversations', { ...(this.#state.model?{model:this.#state.model}:{}), ...((named ?? this.#state.agentId) ? { agentId: named ?? this.#state.agentId } : {}), ...(this.#state.projectFilter ? { projectId: this.#state.projectFilter } : {}) });
        if (!this.live() || seq !== this.#openSeq) return;
        if ((c.status !== 201 && c.status !== 200) || !record(c.body) || !record(c.body.conversation)) throw new SessionFailure('unavailable');
        const conv = c.body.conversation as Conversation;
        id = conv.id;
        this.publish({ activeId: id, conversations: [conv, ...this.#state.conversations.filter(x => x.id !== id)] });
      }
      // CHAT-PRO-02 I: "@Name" or the reply picker chooses who writes this reply.
      const convAgent = this.#state.conversations.find(x => x.id === id)?.agentId ?? (this.#state.agentId || null);
      const writer = named ?? (this.#state.replyAgent || undefined);
      const agentForRun = writer && writer !== convAgent ? writer : undefined;
      if (named && named !== this.#state.replyAgent && this.#state.activeId) this.publish({ replyAgent: named === convAgent ? '' : named });
      const r = await this.call('POST', `/api/chat/conversations/${id}/runs`, { runId, message, ...(this.#state.model ? { model: this.#state.model } : {}), ...(agentForRun ? { agentId: agentForRun } : {}) });
      if (!this.live() || seq !== this.#openSeq) return;
      if (r.status === 409 && record(r.body) && r.body.code === 'conversation_busy' && typeof r.body.runId === 'string') {
        // Another tab is still answering here: wait in the queue and follow that run.
        this.publish({ starting: false, turns: this.#state.turns.filter(t => t !== optimistic), queue: [{ key: runId, text: message }, ...this.#state.queue], runId: r.body.runId, notice: undefined });
        this.publish({ turns: [...this.#state.turns, liveTurn(r.body.runId, this.now())] });
        void this.follow(r.body.runId, seq);
        return;
      }
      if (r.status !== 202 || !record(r.body)) {
        const code = record(r.body) ? r.body.code : undefined;
        this.publish({ starting: false, turns: this.#state.turns.filter(t => t !== optimistic), draft: this.#state.draft || message,
          notice: code === 'rate_limited' ? 'Too many conversations are answering right now. Your message is back in the box; send it again in a moment.' : 'The message was not sent. It is back in the box.' });
        return;
      }
      const stored = record(r.body.userMessage) ? fromWire(r.body.userMessage as WireMessage) : userTurn(`user:${runId}`, message, runId);
      this.publish({ starting: false, runId, turns: [...this.#state.turns.filter(t => t !== optimistic), stored, liveTurn(runId, this.now(), agentForRun)] });
      void this.follow(runId, seq);
      void this.refreshList(); // the first message names the conversation
    } catch {
      if (this.live() && seq === this.#openSeq) this.publish({ starting: false, turns: this.#state.turns.filter(t => t !== optimistic), draft: this.#state.draft || message, notice: 'The message was not sent (no connection). It is back in the box.' });
    }
  }

  /** Follows a run until its end event, re-attaching after drops with the last sequence number. */
  private async follow(runId: string, openSeq: number) {
    this.#follow?.abort();
    const controller = new AbortController(); this.#follow = controller;
    let after = this.#state.turns.find(t => t.runId === runId && t.role === 'assistant')?.lastSeq ?? 0;
    let failures = 0;
    const current = () => !controller.signal.aborted && this.live() && openSeq === this.#openSeq;
    while (current()) {
      const began = Date.now();
      try {
        const { last, ended } = await this.client.runEvents(runId, after, e => this.onEvent(runId, e), controller.signal);
        if (!current()) return;
        const progressed = last > after;
        if (progressed) failures = 0;
        after = last;
        if (this.#state.reconnecting) this.publish({ reconnecting: false });
        if (ended) { this.finished(); return; }
        // A reader that closed with nothing new waits a moment before re-attaching (never a tight loop).
        if (!progressed && Date.now() - began < 2000) { if (++failures > RETRY_MS.length * 4) throw new SessionFailure('unavailable'); await new Promise(r => setTimeout(r, 400)); }
      } catch (error) {
        if (!current()) return;
        if (error instanceof SessionFailure && error.code === 'cancelled') return;
        // A restarted backend no longer has this in-memory SSE run. Read the
        // saved turn before retrying the stream; never resend the user message.
        const id = this.#state.activeId;
        if (id) {
          try {
            const saved = await this.call('GET', `/api/chat/conversations/${id}/messages`);
            if (!current()) return;
            if (saved.status === 200 && record(saved.body) && Array.isArray(saved.body.messages)
              && !saved.body.activeRunId && saved.body.messages.some((m: WireMessage) => m.role === 'assistant' && m.runId === runId)) {
              const turns = (saved.body.messages as WireMessage[]).map(fromWire);
              this.publish({ turns, runId: null, stopping: false, reconnecting: false, queuePaused: this.#state.queue.length > 0,
                notice: turns.some(t => t.runId === runId && t.code === 'run_interrupted') ? 'Work interrupted by restart. Review the saved checkpoints, then continue safely.' : undefined });
              return;
            }
          } catch { /* A transient outage keeps the bounded reconnect path. */ }
        }
        if (failures >= RETRY_MS.length) {
          this.publish({ reconnecting: false, runId: null, notice: 'Lost the connection to this reply. Reopen the conversation to check its saved state before retrying.' });
          this.finishLive('error');
          return;
        }
        this.publish({ reconnecting: true });
        await new Promise(r => setTimeout(r, RETRY_MS[failures++]));
      }
    }
  }

  private onEvent(runId: string, e: RunEvent) {
    const turns = this.#state.turns.map(t => (t.role === 'assistant' && t.runId === runId ? applyEvent(t, e, this.now()) : t));
    this.publish({ turns });
  }

  private finishLive(status: 'error') {
    this.publish({ turns: this.#state.turns.map(t => (t.status === 'running' ? { ...t, status } : t)) });
  }

  private finished() {
    const stopped = this.#state.turns.at(-1)?.status === 'stopped';
    this.publish({ runId: null, stopping: false, reconnecting: false, queuePaused: stopped && this.#state.queue.length > 0 });
    void this.refreshList();
    if (stopped) return;
    const [next, ...rest] = this.#state.queue;
    if (next) { this.publish({ queue: rest }); void this.send(next.text); }
  }

  /** Sends a waiting message now (after a Stop paused the queue). */
  sendQueued(key: string) {
    const item = this.#state.queue.find(q => q.key === key);
    if (!item || this.#state.runId || this.#state.starting) return;
    this.publish({ queue: this.#state.queue.filter(q => q.key !== key), queuePaused: false });
    void this.send(item.text);
  }

  private async refreshList() {
    try {
      const r = await this.call('GET', '/api/chat/conversations');
      if (this.live() && r.status === 200 && record(r.body) && Array.isArray(r.body.conversations)) this.publish({ conversations: r.body.conversations as Conversation[] });
    } catch { /* the list refreshes on the next load */ }
  }

  /** Stops the running reply; what it wrote so far is kept. Queued messages stay queued until sent. */
  async stop() {
    const runId = this.#state.runId;
    if (!runId || this.#state.stopping || !this.live()) return;
    this.publish({ stopping: true });
    try { await this.call('POST', `/api/chat/runs/${runId}/stop`); } catch { this.publish({ stopping: false, notice: 'Stop did not reach the server. Try again.' }); }
  }

  removeQueued(key: string) { const queue = this.#state.queue.filter(q => q.key !== key); this.publish({ queue, queuePaused: this.#state.queuePaused && queue.length > 0 }); }
  editQueued(key: string) {
    const item = this.#state.queue.find(q => q.key === key);
    if (item) this.publish({ queue: this.#state.queue.filter(q => q.key !== key), draft: this.#state.draft ? `${this.#state.draft}\n${item.text}` : item.text });
  }

  async rename(id: string, title: string) {
    const t = title.trim().slice(0, 120);
    const r = await this.call('PUT', `/api/chat/conversations/${id}`, { title: t || null });
    if (this.live() && r.status === 200 && record(r.body) && record(r.body.conversation)) this.replace(r.body.conversation as Conversation);
  }

  async pin(id: string, pinned: boolean) {
    const r = await this.call('PUT', `/api/chat/conversations/${id}`, { pinned });
    if (this.live() && r.status === 200 && record(r.body) && record(r.body.conversation)) { this.replace(r.body.conversation as Conversation); void this.refreshList(); }
  }

  /** CHAT-PRO-02 F: saves the conversation as a Markdown file (a failure shows as the notice). */
  async exportMarkdown(id: string, tools = false): Promise<ExportResult> {
    if (!this.live()) return { ok: false, message: 'Sign in again to export this conversation.' };
    const r = await exportConversation(this.client, id, tools);
    if (!r.ok && this.live()) this.publish({ notice: r.message });
    return r;
  }

  async remove(id: string) {
    const r = await this.call('DELETE', `/api/chat/conversations/${id}`);
    if (!this.live() || (r.status !== 200 && r.status !== 404)) return;
    this.publish({ conversations: this.#state.conversations.filter(c => c.id !== id) });
    if (this.#state.activeId === id) this.newChat();
  }

  private replace(c: Conversation) { this.publish({ conversations: this.#state.conversations.map(x => (x.id === c.id ? c : x)) }); }
}
