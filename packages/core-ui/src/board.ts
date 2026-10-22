import { SessionFailure } from './session-failure';
import { BOARDS_PATH, MAX_COMMENT, MAX_DESCRIPTION, MAX_TITLE, validBoardEdit, validCardEdit, validNewBoard, validNewCard } from './board-contract.js';
import type { SessionClient } from './session';
import { cardChatPath } from './chat-board-contract.js';
import type { ChatProgress } from './chat-board-contract.js';

export type RelatedTask={cardId:string;boardId:string;boardName:string;title:string;status:string;priority:string;dueDate:string|null};
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
/** Board writes (checked against board-contract.js before sending). */
export type BoardRequest = { method: 'POST' | 'PUT'; path: string; body: Record<string, unknown> };
export type Column = Readonly<{ id: string; name: string; position: number }>;
export type Card = Readonly<{
  id: string; columnId: string; title: string; description: string; priority: Priority; position: number; dueDate: string | null;
  archived: boolean; version: number; agents: readonly string[]; departments: readonly string[]; comments: number; updatedAt: string;
  type: CardType; startDate: string | null; cover: BoardColor | null; labels: readonly string[]; checklist: Readonly<{ done: number; total: number }>;
  /** CHAT-PRO-02 I step 2: the conversation this card was made from (null = made on the board). */
  conversationId?: string | null;
}>;
export type CardType = 'task' | 'idea' | 'bug' | 'milestone' | 'request';
export type Label = Readonly<{ id: string; name: string; color: BoardColor }>;
export type CheckItem = Readonly<{ id: string; text: string; done: boolean }>;
export const cardTypeLabel: Record<CardType, string> = { task: 'Task', idea: 'Idea', bug: 'Bug', milestone: 'Milestone', request: 'Request' };
export const allCardTypes: readonly CardType[] = ['task', 'idea', 'bug', 'milestone', 'request'];
export type Comment = Readonly<{ id: string; authorKind: 'user' | 'agent'; authorId: string; body: string; createdAt: string }>;
export type AgentOption = Readonly<{ id: string; name: string }>;
export type BoardColor = 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'pink' | 'teal' | 'gray';
export type BoardMeta = Readonly<{ id: string; name: string; description: string; template: string; color: BoardColor; departments: readonly string[]; kind: 'company' | 'department' | 'shared'; managedDepartment?:boolean; departmentActive?:boolean; archived: boolean; version: number }>;
export type BoardSummary = BoardMeta & Readonly<{ cards: number; open: number }>;
export type Template = Readonly<{ id: string; name: string; description: string; columns: readonly string[] }>;
export type NewBoard = { name: string; description?: string; template: string; color: BoardColor; departments: string[] };
export type CardDraft = Readonly<{ title: string; description: string; priority: Priority; dueDate: string; agents: readonly string[]; departments: readonly string[];
  type: CardType; startDate: string; cover: BoardColor | null; labels: readonly string[] }>;
export type BoardState = Readonly<{
  owner: boolean;
  phase: 'idle' | 'loading' | 'ready' | 'saving' | 'error' | 'denied';
  boardId?: string; name?: string; columns: readonly Column[]; cards: readonly Card[]; agents: readonly AgentOption[];
  /** BOARD-03: every board, the open board's header, the templates and colours to create new ones. */
  boards: readonly BoardSummary[]; meta?: BoardMeta; templates: readonly Template[]; colors: readonly BoardColor[];
  /** BOARD-03 step B: the open board's labels and the open card's checklist. */
  labels: readonly Label[]; checklist: readonly CheckItem[];
  /** The open card (detail panel) and its editable copy and comments. */
  open?: string; draft?: CardDraft; comments: readonly Comment[]; commentsPhase: 'idle' | 'loading' | 'ready' | 'error';
  /** CHAT-PRO-02 I step 2: the open card's conversation and the progress of the agents on it. */
  chat?: Readonly<{ conversation: { id: string; title: string | null } | null; progress: ChatProgress }>;
  /** Filters: text search, one agent, one department. */
  filter: Readonly<{ text: string; agent: string; department: string }>;
  overview?:Readonly<{tasks:RelatedTask[];total:number;limited:boolean}>; overviewError?:boolean;
  notice?: string;
}>;

export const priorityLabel: Record<Priority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export const allPriorities: readonly Priority[] = ['low', 'normal', 'high', 'urgent'];
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const normDep = (x: string) => x.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Cards of a column in board order. */
export const cardsIn = (cards: readonly Card[], columnId: string) => cards.filter(c => c.columnId === columnId).sort((a, b) => a.position - b.position);

/** Does a card pass the current filters? */
export function matches(card: Card, f: BoardState['filter']): boolean {
  const t = f.text.trim().toLowerCase();
  if (t && !card.title.toLowerCase().includes(t) && !card.description.toLowerCase().includes(t)) return false;
  if (f.agent && !card.agents.includes(f.agent)) return false;
  return !f.department || card.departments.includes(f.department);
}

const draftOf = (c: Card): CardDraft => Object.freeze({ title: c.title, description: c.description, priority: c.priority, dueDate: c.dueDate ?? '', agents: [...c.agents], departments: [...c.departments],
  type: c.type, startDate: c.startDate ?? '', cover: c.cover, labels: [...c.labels] });

/**
 * The company task board (BOARD-01): owner only. Nothing is read on mount;
 * "Open the board" reads the board and the team (for assignees). Moves and
 * edits carry the card version; a conflict shows the current card.
 */
export class BoardController {
  #state: BoardState = Object.freeze({ owner: false, phase: 'denied', columns: [], cards: [], agents: [], boards: [], templates: [], colors: [], labels: [], checklist: [], comments: [], commentsPhase: 'idle', filter: { text: '', agent: '', department: '' } });
  #listeners = new Set<() => void>();
  #ticket = 0; #identity = ''; #disposed = false; #unsubscribe: () => void;
  constructor(readonly client: SessionClient) { this.#unsubscribe = client.subscribe(this.#sync); this.#sync(); }
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  #publish(patch: Partial<BoardState>) { this.#state = Object.freeze({ ...this.#state, ...patch }); this.#listeners.forEach(fn => fn()); }
  #sync = () => {
    const s = this.client.getSnapshot(); const identity = `${s.mode}:${s.epoch}:${s.phase}:${s.user?.id ?? ''}:${s.user?.role ?? ''}`;
    if (identity === this.#identity) return;
    this.#identity = identity; this.#ticket++;
    const owner = s.phase === 'authenticated' && s.user?.role === 'owner';
    this.#publish({ owner, phase: owner ? 'idle' : 'denied', boardId: undefined, name: undefined, columns: [], cards: [], agents: [], boards: [], meta: undefined, templates: [], colors: [], labels: [], checklist: [], overview:undefined,overviewError:false,open: undefined, draft: undefined, comments: [], commentsPhase: 'idle',
      notice: s.phase === 'authenticated' && !owner ? 'Only the owner can use the company board.' : undefined });
  };
  dispose() { this.#disposed = true; this.#ticket++; this.#unsubscribe(); this.#publish({ owner: false, phase: 'denied', cards: [], columns: [], comments: [] }); }
  #busy() { return this.#state.phase === 'loading' || this.#state.phase === 'saving'; }
  #refused(status: number, body: unknown): boolean {
    if (status === 403 && record(body) && body.code === 'read_only_stage') { this.#publish({ phase: 'error', notice: 'This test server does not accept board changes. Nothing was saved.' }); return true; }
    if (status === 401 || status === 403) { this.#publish({ phase: 'denied', notice: 'Access denied. Sign in again as the owner.' }); return true; }
    return false;
  }
  #applyBoard(b: BoardMeta & { columns: Column[]; cards: Card[]; labels?: Label[] }) {
    const open = this.#state.open && b.cards.some(c => c.id === this.#state.open) ? this.#state.open : undefined;
    const { columns: _c, cards: _k, labels, ...meta } = b;
    this.#publish({ labels: Object.freeze((labels ?? []).map(l => Object.freeze(l))) });
    this.#publish({ boardId: b.id, name: b.name, meta: Object.freeze({ ...meta }), columns: Object.freeze(b.columns.map(c => Object.freeze(c))), cards: Object.freeze(b.cards.map(c => Object.freeze(c))),
      ...(open ? {} : { open: undefined, draft: undefined, comments: [], commentsPhase: 'idle' as const }) });
  }
  #replaceCard(card: Card) {
    const exists = this.#state.cards.some(c => c.id === card.id);
    const cards = card.archived ? this.#state.cards.filter(c => c.id !== card.id) : exists ? this.#state.cards.map(c => c.id === card.id ? Object.freeze(card) : c) : [...this.#state.cards, Object.freeze(card)];
    const last=Math.max(...this.#state.columns.map(c=>c.position));const done=this.#state.columns.find(c=>c.position===last)?.id;
    const boards=this.#state.boards.map(b=>b.id===this.#state.boardId?Object.freeze({...b,cards:cards.length,open:cards.filter(c=>c.columnId!==done).length}):b);
    this.#publish({cards:Object.freeze(cards),boards:Object.freeze(boards)});
  }

  /** Explicit read: every board (the company board is created on first use), the open board, and the team for assignees. */
  async load(boardId?: string) {
    if (!this.#state.owner || this.#busy() || this.#disposed) return;
    const ticket = ++this.#ticket;
    this.#publish({ phase: 'loading', notice: undefined,overview:undefined,overviewError:false });
    try {
      const provision=await this.client.request({method:'POST',path:BOARDS_PATH+'/sync-departments',body:{}});
      if(ticket!==this.#ticket)return;if(this.#refused(provision.status,provision.body))return;
      const syncNotice=provision.status!==200?'Department boards could not be synchronized. Existing boards are shown; reload to try again.':undefined;
      const list = await this.client.request({ method: 'GET', path: BOARDS_PATH });
      if (ticket !== this.#ticket) return;
      if (this.#refused(list.status, list.body)) return;
      const lb = list.body as { boards?: BoardSummary[]; templates?: Template[]; colors?: BoardColor[] } | null;
      if (list.status !== 200 || !lb?.boards?.length) throw Error();
      this.#publish({ boards: Object.freeze(lb.boards.map(x => Object.freeze(x))), templates: Object.freeze(lb.templates ?? []), colors: Object.freeze(lb.colors ?? []) });
      const want = boardId ?? this.#state.boardId;
      const target = lb.boards.find(x => x.id === want)?.id ?? lb.boards[0].id;
      const r = await this.client.request({ method: 'GET', path: `${BOARDS_PATH}/${target}` });
      if (ticket !== this.#ticket) return;
      if (this.#refused(r.status, r.body)) return;
      if (r.status !== 200 || !record(r.body)) throw Error();
      this.#applyBoard(r.body as never);
      if (!this.#state.agents.length) {
        const team = await this.client.request({ method: 'GET', path: '/api/agents' });
        if (ticket !== this.#ticket) return;
        const agents = team.status === 200 && record(team.body) && Array.isArray(team.body.agents)
          ? (team.body.agents as { id: string; name?: string }[]).map(a => Object.freeze({ id: a.id, name: a.name ?? a.id })) : [];
        this.#publish({ agents: Object.freeze(agents) });
      }
      this.#publish({ phase: 'ready',notice:syncNotice });
      await this.readOverview(target,ticket);
    } catch { if (ticket === this.#ticket) this.#publish({ phase: 'error', notice: 'The board could not be read. Try again.' }); }
  }

  private async readOverview(id:string,ticket=this.#ticket){
    try{const r=await this.client.request({method:'GET',path:`${BOARDS_PATH}/${id}/overview`});if(ticket!==this.#ticket||this.#state.boardId!==id)return;if(r.status!==200)throw Error();this.#publish({overview:r.body as BoardState['overview'],overviewError:false});}catch{if(ticket===this.#ticket&&this.#state.boardId===id)this.#publish({overviewError:true});}
  }
  refreshOverview(){return this.#state.boardId?this.readOverview(this.#state.boardId):Promise.resolve();}
  /** Switch to another board. */
  async openBoard(id: string) {
    if(this.hasUnsavedDraft()){this.#publish({notice:'Save or close the current task draft before switching boards.'});return;}
    if (!this.#state.boards.some(b => b.id === id) || id === this.#state.boardId) return;
    this.closeCard();
    this.#publish({ filter: Object.freeze({ text: '', agent: '', department: '' }) });
    await this.load(id);
  }

  /** A new board from a template; opens it. */
  async createBoard(input: NewBoard) {
    if(this.hasUnsavedDraft()){this.#publish({notice:'Save or close the current task draft before creating a board.'});return false;}
    const body: Record<string, unknown> = { name: input.name.normalize('NFKC').replace(/\s+/g, ' ').trim(), template: input.template, color: input.color, departments: input.departments.map(normDep).filter(Boolean) };
    const description = input.description?.trim(); if (description) body.description = description;
    if (!body.name || !validNewBoard(body)) { this.#publish({ notice: 'A board needs a name (1–80 characters); departments use letters, numbers, spaces, - or _.' }); return false; }
    let created: string | undefined;
    const ok = await this.#write<BoardMeta & { columns: Column[]; cards: Card[]; labels?: Label[] }>(() => this.client.request({ method: 'POST', path: BOARDS_PATH, body }), b => { created = b.id; this.#applyBoard(b); }, 'The board', true);
    if (ok && created) await this.load(created);
    return ok;
  }

  /** Rename, describe, recolour, change departments or archive the open board. */
  async updateBoard(patch: { name?: string; description?: string; color?: BoardColor; departments?: string[]; archived?: boolean }) {
    if(patch.archived&&this.hasUnsavedDraft()){this.#publish({notice:'Save or close the current task draft before archiving this board.'});return false;}
    const m = this.#state.meta; if (!m) return false;
    const body: Record<string, unknown> = { expectedVersion: m.version };
    if (patch.name !== undefined) { const n = patch.name.normalize('NFKC').replace(/\s+/g, ' ').trim(); if (n !== m.name) body.name = n; }
    if (patch.description !== undefined && patch.description.trim() !== m.description) body.description = patch.description.trim();
    if (patch.color !== undefined && patch.color !== m.color) body.color = patch.color;
    if (patch.departments !== undefined) {
      const deps = [...new Set(patch.departments.map(normDep).filter(Boolean))];
      if ([...deps].sort().join() !== [...m.departments].sort().join()) body.departments = deps;
    }
    if (patch.archived !== undefined && patch.archived !== m.archived) body.archived = patch.archived;
    if (Object.keys(body).length === 1) { this.#publish({ notice: 'Nothing changed.' }); return false; }
    if (!validBoardEdit(body)) { this.#publish({ notice: 'Check the board name (1–80 characters) and the departments.' }); return false; }
    const ok = await this.#write<BoardMeta & { columns: Column[]; cards: Card[]; labels?: Label[] }>(() => this.client.request({ method: 'PUT', path: `${BOARDS_PATH}/${m.id}`, body }), b => this.#applyBoard(b), 'The board', true);
    if (ok) await this.load(patch.archived ? undefined : m.id);
    if (ok && patch.archived) this.#publish({ notice: `“${m.name}” was archived.` });
    return ok;
  }

  setFilter(patch: Partial<BoardState['filter']>) { this.#publish({ filter: Object.freeze({ ...this.#state.filter, ...patch }) }); }
  commentAuthor = (kind:'user'|'agent',id:string) => kind==='agent'?this.agentName(id):id===this.client.getSnapshot().user?.id?'You':'Team member';
  agentName = (id: string) => this.#state.agents.find(a => a.id === id)?.name ?? 'Former agent';

  async #write<T>(run: () => Promise<{ status: number; body: unknown }>, onOk: (body: T) => void, what: string, boardLevel = false): Promise<boolean> {
    if (!this.#state.owner || this.#busy() || (!boardLevel && !this.#state.boardId)) return false;
    const ticket = this.#ticket;
    this.#publish({ phase: 'saving', notice: undefined });
    try {
      const r = await run();
      if (ticket !== this.#ticket) return false;
      if (this.#refused(r.status, r.body)) return false;
      const b = r.body as (Record<string, unknown> & { code?: string; card?: Card }) | null;
      if ((r.status === 200 || r.status === 201) && b) { onOk(b as T); this.#publish({ phase: 'ready' }); return true; }
      if (r.status === 409 && b?.code === 'version_conflict' && !b.card) {
        this.#publish({ phase: 'ready', notice: 'This board was changed meanwhile. It was read again; try once more.' });
        void this.load(this.#state.boardId);
        return false;
      }
      if (r.status === 409 && b?.card) {
        this.#replaceCard(b.card);
        if (this.#state.open === b.card.id) this.#publish({ draft: draftOf(b.card) });
        this.#publish({ phase: 'ready', notice: 'This card was changed meanwhile. The latest version is shown; try again.' });
        return false;
      }
      this.#publish({ phase: 'ready', notice: b?.code === 'not_found' ? `${what}: not found. Reload the board.` : `${what} was not saved. Check the fields.` });
    } catch (error) {
      if (ticket !== this.#ticket) return false;
      this.#publish({ phase: 'ready', notice: error instanceof SessionFailure && error.code === 'blocked' ? 'Nothing was sent. Check the fields.' : `${what}: the result is unknown. Reload the board to see what is stored.` });
    }
    return false;
  }

  #adds: Promise<unknown> = Promise.resolve();
  /** A new card at the end of a column (title only; details in the panel). Quick successive adds wait for each other. */
  addCard(columnId: string, title: string): Promise<boolean> {
    const run = this.#adds.then(() => this.#addCardNow(columnId, title));
    this.#adds = run.catch(() => undefined);
    return run;
  }
  async #addCardNow(columnId: string, title: string) {
    const body = { columnId, title: title.normalize('NFKC').replace(/\s+/g, ' ').trim() };
    if (!body.title || [...body.title].length > MAX_TITLE || !validNewCard(body)) { this.#publish({ notice: `A card needs a title of 1 to ${MAX_TITLE} characters.` }); return false; }
    return this.#write<Card>(() => this.client.request({ method: 'POST', path: `${BOARDS_PATH}/${this.#state.boardId}/cards`, body }), c => this.#replaceCard(c), 'The card');
  }

  async addColumn(name: string) {
    const n = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!n || [...n].length > 60) { this.#publish({ notice: 'A column needs a name of 1 to 60 characters.' }); return false; }
    return this.#write<BoardMeta & { columns: Column[]; cards: Card[]; labels?: Label[] }>(() => this.client.request({ method: 'POST', path: `${BOARDS_PATH}/${this.#state.boardId}/columns`, body: { name: n } }), b => this.#applyBoard(b), 'The column');
  }

  async renameColumn(columnId: string, name: string) {
    const n = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!n || [...n].length > 60) { this.#publish({ notice: 'A column needs a name of 1 to 60 characters.' }); return false; }
    return this.#write<BoardMeta & { columns: Column[]; cards: Card[]; labels?: Label[] }>(() => this.client.request({ method: 'PUT', path: `${BOARDS_PATH}/${this.#state.boardId}/columns/${columnId}`, body: { name: n } }), b => this.#applyBoard(b), 'The column');
  }

  /** Move a card to a column, before another card (or to the end). Optimistic in the view, confirmed by the server. */
  async move(cardId: string, columnId: string, beforeCardId: string | null) {
    const card = this.#state.cards.find(c => c.id === cardId);
    if (!card || beforeCardId === cardId) return false;
    if (card.columnId === columnId && beforeCardId === null && cardsIn(this.#state.cards, columnId).at(-1)?.id === cardId) return false;
    const body = { expectedVersion: card.version, columnId, beforeCardId };
    if (!validCardEdit(body)) return false;
    return this.#write<Card>(() => this.client.request({ method: 'PUT', path: `${BOARDS_PATH}/${this.#state.boardId}/cards/${cardId}`, body }), async c => {
      this.#replaceCard(c);
      // Other cards may have been renumbered; read the board again quietly.
      const r = await this.client.request({ method: 'GET', path: `${BOARDS_PATH}/${this.#state.boardId}` }).catch(() => null);
      if (r && r.status === 200 && record(r.body)) this.#applyBoard(r.body as never);
    }, 'The move');
  }

  // ---- Card panel ----

  hasUnsavedDraft(){const card=this.#state.cards.find(c=>c.id===this.#state.open);return !!card&&!!this.#state.draft&&JSON.stringify(this.#state.draft)!==JSON.stringify(draftOf(card));}
  async openCard(cardId: string) {
    if(this.#state.open===cardId)return;
    if(this.hasUnsavedDraft()){this.#publish({notice:'Save or close the current task draft before opening another task.'});return;}
    const card = this.#state.cards.find(c => c.id === cardId);
    if (!card || !this.#state.owner) return;
    this.#publish({ open: cardId, draft: draftOf(card), comments: [], checklist: [], commentsPhase: 'loading', notice: undefined, chat: undefined });
    const ticket = this.#ticket;
    if (card.conversationId || card.agents.length) void this.#loadChat(cardId, ticket);
    try {
      const k = await this.client.request({ method: 'GET', path: `${BOARDS_PATH}/${this.#state.boardId}/cards/${cardId}/checklist` });
      const items = (k.body as { items?: CheckItem[] } | null)?.items;
      if (ticket === this.#ticket && this.#state.open === cardId && k.status === 200 && items) this.#publish({ checklist: Object.freeze(items.map(i => Object.freeze(i))) });
    } catch { /* the checklist stays empty; the comments still load */ }
    try {
      const r = await this.client.request({ method: 'GET', path: `${BOARDS_PATH}/${this.#state.boardId}/cards/${cardId}/comments` });
      if (ticket !== this.#ticket || this.#state.open !== cardId) return;
      const list = (r.body as { comments?: Comment[] } | null)?.comments;
      this.#publish(r.status === 200 && list ? { comments: Object.freeze(list.map(c => Object.freeze(c))), commentsPhase: 'ready' } : { commentsPhase: 'error' });
    } catch { if (this.#state.open === cardId) this.#publish({ commentsPhase: 'error' }); }
  }
  closeCard() { this.#publish({ open: undefined, draft: undefined, comments: [], checklist: [], commentsPhase: 'idle', notice: undefined, chat: undefined }); }
  /** The open card's conversation and who works on it (read again on demand). */
  async #loadChat(cardId: string, ticket = this.#ticket) {
    try {
      const r = await this.client.request({ method: 'GET', path: cardChatPath(this.#state.boardId!, cardId) });
      const b = r.body as { conversation?: { id: string; title: string | null } | null; progress?: ChatProgress } | null;
      if (ticket === this.#ticket && this.#state.open === cardId && r.status === 200 && b?.progress) this.#publish({ chat: Object.freeze({ conversation: b.conversation ?? null, progress: b.progress }) });
    } catch { /* the panel works without it */ }
  }
  refreshChat() { if (this.#state.open) void this.#loadChat(this.#state.open); }
  /** Open a board and one of its cards (from a chat card block). */
  async reveal(boardId: string, cardId: string) {
    if(this.hasUnsavedDraft()){this.#publish({notice:'Save or close the current task draft before opening a related task.'});return;}
    if (!this.#state.owner) return;
    if (this.#state.boardId !== boardId || !this.#state.cards.some(c => c.id === cardId)) { this.closeCard(); await this.load(boardId); }
    if (this.#state.cards.some(c => c.id === cardId)) await this.openCard(cardId);
    else this.#publish({ notice: 'That card is archived or no longer on this board.' });
  }
  toggleLabel(id: string) {
    const d = this.#state.draft; if (!d) return;
    if (!d.labels.includes(id) && d.labels.length >= 10) return this.#publish({ notice: 'At most 10 labels on a card.' });
    this.editDraft({ labels: d.labels.includes(id) ? d.labels.filter(x => x !== id) : [...d.labels, id] });
  }

  /** A new label on the open board. */
  async addLabel(name: string, color: BoardColor) {
    const n = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!n || [...n].length > 40) { this.#publish({ notice: 'A label needs a name of 1 to 40 characters.' }); return false; }
    return this.#write<BoardMeta & { columns: Column[]; cards: Card[]; labels?: Label[] }>(() => this.client.request({ method: 'POST', path: `${BOARDS_PATH}/${this.#state.boardId}/labels`, body: { name: n, color } }), b => this.#applyBoard(b), 'The label');
  }

  #setChecklist(cardId: string, items: CheckItem[]) {
    if (this.#state.open === cardId) this.#publish({ checklist: Object.freeze(items.map(i => Object.freeze(i))) });
    const card = this.#state.cards.find(c => c.id === cardId);
    if (card) this.#replaceCard({ ...card, checklist: { done: items.filter(i => i.done).length, total: items.length } });
  }
  async addCheckItem(text: string) {
    const s = this.#state; const t = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!s.open || !t) return false;
    if ([...t].length > 300) { this.#publish({ notice: 'A checklist item may have at most 300 characters.' }); return false; }
    const cardId = s.open;
    return this.#write<{ items: CheckItem[] }>(() => this.client.request({ method: 'POST', path: `${BOARDS_PATH}/${s.boardId}/cards/${cardId}/checklist`, body: { text: t } }), b => this.#setChecklist(cardId, b.items), 'The checklist item');
  }
  async updateCheckItem(itemId: string, patch: { done?: boolean; text?: string; remove?: true }) {
    const s = this.#state; if (!s.open) return false;
    const cardId = s.open;
    const body: Record<string, unknown> = {};
    if (patch.done !== undefined) body.done = patch.done;
    if (patch.text !== undefined) { const t = patch.text.normalize('NFKC').replace(/\s+/g, ' ').trim(); if (!t) return false; body.text = t; }
    if (patch.remove) body.remove = true;
    return this.#write<{ items: CheckItem[] }>(() => this.client.request({ method: 'PUT', path: `${BOARDS_PATH}/${s.boardId}/cards/${cardId}/checklist/${itemId}`, body }), b => this.#setChecklist(cardId, b.items), 'The checklist item');
  }
  editDraft(patch: Partial<CardDraft>) { if (this.#state.draft) this.#publish({ draft: Object.freeze({ ...this.#state.draft, ...patch }) }); }
  toggleAgent(id: string) {
    const d = this.#state.draft; if (!d) return;
    this.editDraft({ agents: d.agents.includes(id) ? d.agents.filter(x => x !== id) : [...d.agents, id] });
  }
  addDepartment(name: string) {
    const d = this.#state.draft; const dep = normDep(name);
    if (!d || !dep) return false;
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(dep) || dep.length > 64) { this.#publish({ notice: 'Department: up to 64 letters, numbers, spaces, - or _.' }); return false; }
    if (!d.departments.includes(dep) && d.departments.length < 12) this.editDraft({ departments: [...d.departments, dep] });
    return true;
  }
  removeDepartment(dep: string) { const d = this.#state.draft; if (d) this.editDraft({ departments: d.departments.filter(x => x !== dep) }); }

  /** Save the panel's changes (only the fields that changed). */
  async saveCard() {
    const s = this.#state; const card = s.cards.find(c => c.id === s.open); const d = s.draft;
    if (!card || !d) return false;
    const title = d.title.normalize('NFKC').replace(/\s+/g, ' ').trim();
    const description = d.description.replace(/\r\n?/g, '\n').trim();
    if (!title || [...title].length > MAX_TITLE) { this.#publish({ notice: `The title needs 1 to ${MAX_TITLE} characters.` }); return false; }
    if ([...description].length > MAX_DESCRIPTION) { this.#publish({ notice: `The description may have at most ${MAX_DESCRIPTION} characters.` }); return false; }
    const body: Record<string, unknown> = { expectedVersion: card.version };
    if (title !== card.title) body.title = title;
    if (description !== card.description) body.description = description;
    if (d.priority !== card.priority) body.priority = d.priority;
    const due = d.dueDate || null; if (due !== card.dueDate) body.dueDate = due;
    if ([...d.agents].sort().join() !== [...card.agents].sort().join()) body.agents = [...d.agents];
    if ([...d.departments].sort().join() !== [...card.departments].sort().join()) body.departments = [...d.departments];
    if (d.type !== card.type) body.type = d.type;
    const start = d.startDate || null; if (start !== card.startDate) body.startDate = start;
    if (start && due && start > due) { this.#publish({ notice: 'The start date cannot be after the due date.' }); return false; }
    if (d.cover !== card.cover) body.cover = d.cover;
    if ([...d.labels].sort().join() !== [...card.labels].sort().join()) body.labels = [...d.labels];
    if (Object.keys(body).length === 1) { this.#publish({ notice: 'Nothing changed.' }); return false; }
    if (!validCardEdit(body)) { this.#publish({ notice: 'Check the fields: the date is YYYY-MM-DD and the text may not hold hidden characters.' }); return false; }
    return this.#write<Card>(() => this.client.request({ method: 'PUT', path: `${BOARDS_PATH}/${s.boardId}/cards/${card.id}`, body: body as never }), c => {
      this.#replaceCard(c); this.#publish({ draft: draftOf(c), notice: 'Saved.' });
    }, 'The card');
  }

  async archiveCard() {
    const s = this.#state; const card = s.cards.find(c => c.id === s.open);
    if (!card) return false;
    const ok = await this.#write<Card>(() => this.client.request({ method: 'PUT', path: `${BOARDS_PATH}/${s.boardId}/cards/${card.id}`, body: { expectedVersion: card.version, archived: true } }), c => this.#replaceCard(c), 'The card');
    if (ok) this.closeCard();
    return ok;
  }

  async addComment(text: string) {
    const s = this.#state; const body = text.replace(/\r\n?/g, '\n').trim();
    if (!s.open || !body) return false;
    if ([...body].length > MAX_COMMENT) { this.#publish({ notice: `A comment may have at most ${MAX_COMMENT} characters.` }); return false; }
    const cardId = s.open;
    return this.#write<{ comments: Comment[] }>(() => this.client.request({ method: 'POST', path: `${BOARDS_PATH}/${s.boardId}/cards/${cardId}/comments`, body: { body } }), b => {
      if (this.#state.open === cardId) this.#publish({ comments: Object.freeze(b.comments.map(c => Object.freeze(c))), commentsPhase: 'ready' });
      const card = this.#state.cards.find(c => c.id === cardId);
      if (card) this.#replaceCard({ ...card, comments: b.comments.length });
    }, 'The comment');
  }
}
