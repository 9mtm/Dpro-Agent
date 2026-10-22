import type { WireRequest, WireResponse } from './session';

type Card = { id: string; columnId: string; title: string; description: string; priority: string; position: number; dueDate: string | null; archived: boolean; version: number; agents: string[]; departments: string[]; comments: number; updatedAt: string; type: string; startDate: string | null; cover: string | null; labels: string[]; conversationId: string | null };
type Board = { id: string; name: string; description: string; template: string; color: string; departments: string[]; archived: boolean; version: number; columns: { id: string; name: string; position: number }[]; labels: { id: string; name: string; color: string }[] };

const TEMPLATES = [
  { id: 'kanban', name: 'Team workflow', description: 'Fictional: ideas to done.', columns: ['Ideas', 'Backlog', 'To do', 'In progress', 'Review', 'Done'] },
  { id: 'content', name: 'Content calendar', description: 'Fictional: posts from idea to published.', columns: ['Ideas', 'Writing', 'Editing', 'Scheduled', 'Published'] },
  { id: 'simple', name: 'Simple list', description: 'Fictional: to do and done.', columns: ['To do', 'Doing', 'Done'] },
];
const COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'pink', 'teal', 'gray'];

/** Fictional in-memory boards for offline practice and tests (same rules as the server, simplified). */
export function createBoardMock() {
  let n = 0; const nextId = (p: string) => `${p}-${++n}`;
  const boards: Board[] = [];
  const cards = new Map<string, Card[]>();
  const comments = new Map<string, { id: string; authorKind: 'user'; authorId: string; body: string; createdAt: string }[]>();
  const checklists = new Map<string, { id: string; text: string; done: boolean }[]>();
  const check = (id: string) => { const l = checklists.get(id) ?? []; return { done: l.filter(i => i.done).length, total: l.length }; };
  const now = () => '2026-10-15 12:00:00';
  const kind = (b: Board) => (b.departments.length === 0 ? 'company' : b.departments.length === 1 ? 'department' : 'shared');
  const meta = (b: Board) => ({ id: b.id, name: b.name, description: b.description, template: b.template, color: b.color, departments: [...b.departments], kind: kind(b), archived: b.archived, version: b.version });
  const create = (name: string, template: string, color: string, departments: string[], description = '') => {
    const tpl = TEMPLATES.find(t => t.id === template) ?? TEMPLATES[0];
    const b: Board = { id: nextId('board'), name, description, template: tpl.id, color, departments: [...departments].sort(), archived: false, version: 1, columns: tpl.columns.map((c, i) => ({ id: nextId('col'), name: c, position: (i + 1) * 1000 })),
      labels: [['Important', 'red'], ['Waiting', 'orange'], ['Quick win', 'green'], ['Needs owner', 'purple']].map(([name, color]) => ({ id: nextId('label'), name, color })) };
    boards.push(b); cards.set(b.id, []); return b;
  };
  const view = (b: Board, archived = false) => ({ ...meta(b), columns: b.columns.map(c => ({ ...c })), labels: b.labels.map(l => ({ ...l })), cards: cards.get(b.id)!.filter(c => archived || !c.archived).map(c => ({ ...c, comments: comments.get(c.id)?.length ?? 0, checklist: check(c.id) })) });
  const endOf = (b: Board, columnId: string) => Math.max(0, ...cards.get(b.id)!.filter(c => c.columnId === columnId).map(c => c.position)) + 1000;
  const activity = new Map<string, { id: string; kind: string; actorKind: 'user'; actorId: string; detail: string; createdAt: string }[]>();
  const log = (cardId: string, kind: string, detail = '') => { const l = activity.get(cardId) ?? []; l.push({ id: nextId('act'), kind, actorKind: 'user', actorId: 'owner', detail: detail.slice(0, 200), createdAt: now() }); activity.set(cardId, l); };
  const columnName = (b: Board, id: string) => b.columns.find(c => c.id === id)?.name ?? '';
  const isLast = (b: Board, id: string) => b.columns[b.columns.length - 1]?.id === id;
  const progress = (agents: string[]) => ({ running: false, agents: agents.map(agentId => ({ agentId, replies: 0, lastAt: null, running: false, plan: null })) });
  return function transport(request: WireRequest): WireResponse {
    const p = request.path; const body = request.body as Record<string, any>;
    // CHAT-PRO-02 I step 2: fictional cards made from a chat.
    const chat = /^\/api\/chat\/conversations\/([^/?]+)\/cards$/.exec(p);
    if (chat) {
      if (request.method === 'POST') {
        const b = boards.find(x => x.id === body.boardId && !x.archived);
        if (!b) return { status: 404, body: { code: 'not_found' } };
        const columnId = body.columnId ?? (b.columns.find(c => c.name.toLowerCase() === 'to do') ?? b.columns[0]).id;
        if (!b.columns.some(c => c.id === columnId)) return { status: 404, body: { code: 'not_found' } };
        const card: Card = { id: nextId('card'), columnId, title: body.title, description: body.description ?? '', priority: body.priority ?? 'normal', position: endOf(b, columnId), dueDate: null,
          archived: false, version: 1, agents: body.agents ?? [], departments: [], comments: 0, updatedAt: now(), type: body.type ?? 'task', startDate: null, cover: null, labels: [], conversationId: chat[1] };
        cards.get(b.id)!.push(card); log(card.id, 'created', columnName(b, columnId));
        return { status: 201, body: { card: { ...card, checklist: check(card.id) } } };
      }
      const out = boards.flatMap(b => cards.get(b.id)!.filter(c => c.conversationId === chat[1]).map(c => ({ id: c.id, boardId: b.id, boardName: b.name, title: c.title, column: columnName(b, c.columnId), columnId: c.columnId,
        done: isLast(b, c.columnId), archived: c.archived, priority: c.priority, type: c.type, agents: [...c.agents], comments: comments.get(c.id)?.length ?? 0, checklist: check(c.id), createdAt: now(), updatedAt: c.updatedAt, activity: (activity.get(c.id) ?? []).slice(-8) })));
      return { status: 200, body: { cards: out, progress: progress([...new Set(out.filter(c => !c.archived).flatMap(c => c.agents))]) } };
    }
    const cardChat = /^\/api\/boards\/([^/?]+)\/cards\/([^/?]+)\/chat$/.exec(p);
    if (cardChat) {
      const c = cards.get(cardChat[1])?.find(x => x.id === cardChat[2]);
      if (!c) return { status: 404, body: { code: 'not_found' } };
      return { status: 200, body: { conversation: c.conversationId ? { id: c.conversationId, title: 'Fictional chat' } : null, progress: progress(c.agents) } };
    }
    if(p==='/api/boards/sync-departments')return {status:200,body:{created:0,departments:0}};
    if(/^\/api\/boards\/[^/?]+\/overview$/.test(p))return {status:200,body:{tasks:[],total:0,limited:false}};
    if (p === '/api/boards' || p === '/api/boards?archived=1') {
      if (request.method === 'POST') return { status: 201, body: view(create(body.name, body.template ?? 'kanban', body.color ?? 'blue', body.departments ?? [], body.description)) };
      if (!boards.length) create('Company board', 'kanban', 'blue', []);
      const list = boards.filter(b => p.endsWith('=1') || !b.archived).map(b => ({ ...meta(b), cards: cards.get(b.id)!.filter(c => !c.archived).length, open: 0 }));
      return { status: 200, body: { boards: list, templates: TEMPLATES, colors: COLORS } };
    }
    const m = /^\/api\/boards\/([^/?]+)(?:\?archived=1)?(?:\/(columns|cards|labels)(?:\/([^/]+)(?:\/(comments|checklist)(?:\/([^/]+))?)?)?)?$/.exec(p);
    const b = m && boards.find(x => x.id === m[1]);
    if (!m || !b) return { status: 404, body: { code: 'not_found' } };
    const [, , part, sub, tail, item] = m;
    if (!part) {
      if (request.method === 'GET') return { status: 200, body: view(b, p.includes('archived=1')) };
      if (body.expectedVersion !== b.version) return { status: 409, body: { code: 'version_conflict', board: meta(b) } };
      for (const k of ['name', 'description', 'color', 'archived'] as const) if (body[k] !== undefined) (b as any)[k] = body[k];
      if (body.departments) b.departments = [...body.departments].sort();
      b.version++;
      return { status: 200, body: view(b) };
    }
    const list = cards.get(b.id)!;
    if (part === 'labels' && !sub) { b.labels.push({ id: nextId('label'), name: body.name, color: body.color }); return { status: 201, body: view(b) }; }
    if (part === 'labels') { const l = b.labels.find(x => x.id === sub); if (!l) return { status: 404, body: { code: 'not_found' } }; Object.assign(l, body); return { status: 200, body: view(b) }; }
    if (part === 'columns' && !sub) { b.columns.push({ id: nextId('col'), name: body.name, position: (b.columns.length + 1) * 1000 }); return { status: 201, body: view(b) }; }
    if (part === 'columns') { const c = b.columns.find(x => x.id === sub); if (!c) return { status: 404, body: { code: 'not_found' } }; c.name = body.name; return { status: 200, body: view(b) }; }
    if (part === 'cards' && !sub) {
      if (!b.columns.some(c => c.id === body.columnId)) return { status: 404, body: { code: 'not_found' } };
      const card: Card = { id: nextId('card'), columnId: body.columnId, title: body.title, description: body.description ?? '', priority: body.priority ?? 'normal', position: endOf(b, body.columnId), dueDate: body.dueDate ?? null,
        archived: false, version: 1, agents: body.agents ?? [], departments: body.departments ?? [], comments: 0, updatedAt: now(),
        type: body.type ?? 'task', startDate: body.startDate ?? null, cover: body.cover ?? null, labels: body.labels ?? [], conversationId: null };
      list.push(card); log(card.id, 'created', columnName(b, card.columnId)); return { status: 201, body: { ...card, checklist: check(card.id) } };
    }
    const card = list.find(c => c.id === sub);
    if (!card) return { status: 404, body: { code: 'not_found' } };
    if (tail === 'checklist') {
      const l = checklists.get(card.id) ?? []; checklists.set(card.id, l);
      if (request.method === 'POST') l.push({ id: nextId('item'), text: body.text, done: false });
      else if (item) { const i = l.find(x => x.id === item); if (!i) return { status: 404, body: { code: 'not_found' } }; if (body.remove) l.splice(l.indexOf(i), 1); else Object.assign(i, { ...(body.text !== undefined ? { text: body.text } : {}), ...(body.done !== undefined ? { done: body.done } : {}) }); }
      return { status: request.method === 'POST' ? 201 : 200, body: { items: l.map(i => ({ ...i })) } };
    }
    if (tail === 'comments') {
      const cs = comments.get(card.id) ?? [];
      if (request.method === 'POST') { cs.push({ id: nextId('cm'), authorKind: 'user', authorId: 'owner', body: body.body, createdAt: now() }); comments.set(card.id, cs); log(card.id, 'comment', body.body); return { status: 201, body: { comments: cs.map(c => ({ ...c })) } }; }
      return { status: 200, body: { comments: cs.map(c => ({ ...c })) } };
    }
    if (body.expectedVersion !== card.version) return { status: 409, body: { code: 'version_conflict', card: { ...card, checklist: check(card.id) } } };
    for (const k of ['title', 'description', 'priority', 'dueDate', 'agents', 'departments', 'archived', 'type', 'startDate', 'cover', 'labels'] as const) if (body[k] !== undefined) (card as any)[k] = body[k];
    if (body.columnId !== undefined) {
      const before = body.beforeCardId ? list.find(c => c.id === body.beforeCardId) : undefined;
      if (card.columnId !== body.columnId) log(card.id, isLast(b, body.columnId) ? 'done' : 'moved', columnName(b, body.columnId));
      card.columnId = body.columnId;
      if (before) { const at = before.position; list.filter(c => c.columnId === body.columnId && c.position >= at && c.id !== card.id).forEach(c => { c.position += 1000; }); card.position = at; }
      else card.position = endOf(b, body.columnId);
    }
    card.version++; card.updatedAt = now();
    return { status: 200, body: { ...card, comments: comments.get(card.id)?.length ?? 0, checklist: check(card.id) } };
  };
}
