// BOARD-01 wire contract: the company task board. Shared by the browser
// boundary and the local bridge: a strict allow-list of requests and a
// projection of every response to the reviewed fields (never error text).
import { validAgentId } from './agent-id.js';
import { department } from './hire-contract.js';

export const BOARDS_PATH = '/api/boards';
export const priorities = ['low', 'normal', 'high', 'urgent'];
export const boardColors = ['blue', 'green', 'orange', 'red', 'purple', 'pink', 'teal', 'gray'];
export const cardTypes = ['task', 'idea', 'bug', 'milestone', 'request'];
const kinds = ['company', 'department', 'shared'];
const templateId = x => typeof x === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(x);
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 5000;
export const MAX_COMMENT = 4000;
const MAX_CARDS = 5000;

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (x, keys) => Object.keys(x).every(k => keys.includes(k));
const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x);
const version = x => Number.isSafeInteger(x) && x > 0;
// eslint-disable-next-line no-control-regex
const badChars = /[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/u;
const textOk = (x, max, required) => typeof x === 'string' && x.length <= max * 2 && [...x].length <= max && !badChars.test(x) && (!required || x.trim().length > 0);
const lineOk = (x, max) => textOk(x, max, true) && !/\n/.test(x);
const date = x => x === null || (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x));
const agents = x => Array.isArray(x) && x.length <= 50 && x.every(validAgentId) && new Set(x).size === x.length;
const departments = x => Array.isArray(x) && x.length <= 12 && x.every(department) && new Set(x).size === x.length;
const labelIds = x => Array.isArray(x) && x.length <= 10 && x.every(id) && new Set(x).size === x.length;
const coverOk = x => x === null || boardColors.includes(x);

/** The board path this request names, or null. */
export function boardPath(path) {
  if(path===BOARDS_PATH+'/sync-departments')return {kind:'sync',board:''};
  const overview=/^\/api\/boards\/([^/?#]+)\/overview$/.exec(path);if(overview)return id(overview[1])?{kind:'overview',board:overview[1]}:null;
  let m = /^\/api\/boards\/([^/?#]+)$/.exec(path);
  if (m) return id(m[1]) ? { kind: 'board', board: m[1] } : null;
  m = /^\/api\/boards\/([^/?#]+)\?archived=1$/.exec(path);
  if (m) return id(m[1]) ? { kind: 'board-archived', board: m[1] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/columns$/.exec(path);
  if (m) return id(m[1]) ? { kind: 'columns', board: m[1] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/columns\/([^/?#]+)$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) ? { kind: 'column', board: m[1], column: m[2] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/cards$/.exec(path);
  if (m) return id(m[1]) ? { kind: 'cards', board: m[1] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/cards\/([^/?#]+)$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) ? { kind: 'card', board: m[1], card: m[2] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/cards\/([^/?#]+)\/comments$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) ? { kind: 'comments', board: m[1], card: m[2] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/labels$/.exec(path);
  if (m) return id(m[1]) ? { kind: 'labels', board: m[1] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/labels\/([^/?#]+)$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) ? { kind: 'label', board: m[1], label: m[2] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/cards\/([^/?#]+)\/checklist$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) ? { kind: 'checklist', board: m[1], card: m[2] } : null;
  m = /^\/api\/boards\/([^/?#]+)\/cards\/([^/?#]+)\/checklist\/([^/?#]+)$/.exec(path);
  if (m) return id(m[1]) && id(m[2]) && id(m[3]) ? { kind: 'check', board: m[1], card: m[2], item: m[3] } : null;
  return null;
}

export function validNewCard(b) {
  if (!record(b) || !onlyKeys(b, ['columnId', 'title', 'description', 'priority', 'dueDate', 'agents', 'departments', 'type', 'startDate', 'cover', 'labels']) || !id(b.columnId) || !lineOk(b.title, MAX_TITLE)) return false;
  if (b.type !== undefined && !cardTypes.includes(b.type)) return false;
  if (b.startDate !== undefined && !date(b.startDate)) return false;
  if (b.cover !== undefined && !coverOk(b.cover)) return false;
  if (b.labels !== undefined && !labelIds(b.labels)) return false;
  if (b.description !== undefined && !textOk(b.description, MAX_DESCRIPTION, false)) return false;
  if (b.priority !== undefined && !priorities.includes(b.priority)) return false;
  if (b.dueDate !== undefined && !date(b.dueDate)) return false;
  if (b.agents !== undefined && !agents(b.agents)) return false;
  return b.departments === undefined || departments(b.departments);
}

export function validCardEdit(b) {
  if (!record(b) || !onlyKeys(b, ['expectedVersion', 'title', 'description', 'priority', 'dueDate', 'agents', 'departments', 'columnId', 'beforeCardId', 'archived', 'type', 'startDate', 'cover', 'labels']) || !version(b.expectedVersion)) return false;
  if (b.type !== undefined && !cardTypes.includes(b.type)) return false;
  if (b.startDate !== undefined && !date(b.startDate)) return false;
  if (b.cover !== undefined && !coverOk(b.cover)) return false;
  if (b.labels !== undefined && !labelIds(b.labels)) return false;
  if (Object.keys(b).length < 2) return false;
  if (b.title !== undefined && !lineOk(b.title, MAX_TITLE)) return false;
  if (b.description !== undefined && !textOk(b.description, MAX_DESCRIPTION, false)) return false;
  if (b.priority !== undefined && !priorities.includes(b.priority)) return false;
  if (b.dueDate !== undefined && !date(b.dueDate)) return false;
  if (b.agents !== undefined && !agents(b.agents)) return false;
  if (b.departments !== undefined && !departments(b.departments)) return false;
  if (b.columnId !== undefined && !id(b.columnId)) return false;
  if (b.beforeCardId !== undefined && b.beforeCardId !== null && !id(b.beforeCardId)) return false;
  if (b.beforeCardId !== undefined && b.columnId === undefined) return false;
  return b.archived === undefined || typeof b.archived === 'boolean';
}

const nameBody = b => record(b) && Object.keys(b).length === 1 && lineOk(b.name, 60);

export function validNewBoard(b) {
  if (!record(b) || !onlyKeys(b, ['name', 'description', 'template', 'color', 'departments']) || !lineOk(b.name, 80)) return false;
  if (b.description !== undefined && !textOk(b.description, 500, false)) return false;
  if (b.template !== undefined && !templateId(b.template)) return false;
  if (b.color !== undefined && !boardColors.includes(b.color)) return false;
  return b.departments === undefined || departments(b.departments);
}

export function validBoardEdit(b) {
  if (!record(b) || !onlyKeys(b, ['expectedVersion', 'name', 'description', 'color', 'departments', 'archived']) || !version(b.expectedVersion) || Object.keys(b).length < 2) return false;
  if (b.name !== undefined && !lineOk(b.name, 80)) return false;
  if (b.description !== undefined && !textOk(b.description, 500, false)) return false;
  if (b.color !== undefined && !boardColors.includes(b.color)) return false;
  if (b.departments !== undefined && !departments(b.departments)) return false;
  return b.archived === undefined || typeof b.archived === 'boolean';
}

export function allowedBoard(method, path, body) {
  if (path === BOARDS_PATH) return (method === 'GET' && body === undefined) || (method === 'POST' && validNewBoard(body));
  if (path === `${BOARDS_PATH}?archived=1`) return method === 'GET' && body === undefined;
  const p = boardPath(path);
  if (!p) return false;
  if(p.kind==='sync')return method==='POST'&&record(body)&&Object.keys(body).length===0;
  if(p.kind==='overview')return method==='GET'&&body===undefined;
  if (p.kind === 'board') return (method === 'GET' && body === undefined) || (method === 'PUT' && validBoardEdit(body));
  if (p.kind === 'board-archived') return method === 'GET' && body === undefined;
  if (p.kind === 'columns') return method === 'POST' && nameBody(body);
  if (p.kind === 'column') return method === 'PUT' && nameBody(body);
  if (p.kind === 'cards') return method === 'POST' && validNewCard(body);
  if (p.kind === 'card') return method === 'PUT' && validCardEdit(body);
  if (p.kind === 'labels') return method === 'POST' && record(body) && onlyKeys(body, ['name', 'color']) && lineOk(body.name, 40) && boardColors.includes(body.color);
  if (p.kind === 'label') return method === 'PUT' && record(body) && Object.keys(body).length >= 1 && onlyKeys(body, ['name', 'color']) && (body.name === undefined || lineOk(body.name, 40)) && (body.color === undefined || boardColors.includes(body.color));
  if (p.kind === 'checklist') return (method === 'GET' && body === undefined) || (method === 'POST' && record(body) && Object.keys(body).length === 1 && lineOk(body.text, 300));
  if (p.kind === 'check') return method === 'PUT' && record(body) && Object.keys(body).length >= 1 && onlyKeys(body, ['text', 'done', 'remove'])
    && (body.text === undefined || lineOk(body.text, 300)) && (body.done === undefined || typeof body.done === 'boolean') && (body.remove === undefined || body.remove === true);
  if (p.kind === 'comments') return (method === 'GET' && body === undefined) || (method === 'POST' && record(body) && Object.keys(body).length === 1 && textOk(body.body, MAX_COMMENT, true));
  return false;
}

export function boardRoute(path) {
  return path === BOARDS_PATH || path === `${BOARDS_PATH}?archived=1` || boardPath(path) !== null;
}

const fail = () => { throw Error('Invalid board response'); };
const clip = (x, max) => (typeof x === 'string' ? (x.length > max ? x.slice(0, max) : x) : '');
const when = x => {if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(x))return '';const iso=x.replace(' ','T')+(/(Z|[+-]\d{2}:\d{2})$/.test(x)?'':'Z');const value=new Date(iso);return Number.isNaN(value.getTime())?'':value.toISOString();};

function card(c) {
  if (!record(c) || !id(c.id) || !id(c.columnId) || typeof c.title !== 'string' || !priorities.includes(c.priority) || !version(c.version)
    || !Number.isSafeInteger(c.position) || !Array.isArray(c.agents) || !Array.isArray(c.departments)) fail();
  return {
    id: c.id, columnId: c.columnId, title: clip(c.title, MAX_TITLE * 2), description: clip(c.description, MAX_DESCRIPTION * 2), priority: c.priority,
    position: c.position, dueDate: date(c.dueDate) && c.dueDate ? c.dueDate : null, archived: c.archived === true, version: c.version,
    agents: c.agents.filter(validAgentId).slice(0, 50), departments: c.departments.filter(department).slice(0, 12),
    comments: Number.isSafeInteger(c.comments) && c.comments >= 0 ? c.comments : 0, updatedAt: when(c.updatedAt),
    type: cardTypes.includes(c.type) ? c.type : 'task', startDate: date(c.startDate) && c.startDate ? c.startDate : null, cover: boardColors.includes(c.cover) ? c.cover : null,
    labels: Array.isArray(c.labels) ? c.labels.filter(id).slice(0, 10) : [],
    checklist: record(c.checklist) && Number.isSafeInteger(c.checklist.done) && Number.isSafeInteger(c.checklist.total) && c.checklist.done >= 0 && c.checklist.done <= c.checklist.total ? { done: c.checklist.done, total: c.checklist.total } : { done: 0, total: 0 },

    conversationId: typeof c.conversationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(c.conversationId) ? c.conversationId : null,
  };
}

function meta(b) {
  if (!record(b) || !id(b.id)) fail();
  return {
    id: b.id, name: clip(b.name, 80), description: clip(b.description, 500), template: templateId(b.template) ? b.template : 'custom',
    color: boardColors.includes(b.color) ? b.color : 'blue', departments: Array.isArray(b.departments) ? b.departments.filter(department).slice(0, 12) : [],
    kind: kinds.includes(b.kind) ? b.kind : 'company', managedDepartment:b.managedDepartment===true,departmentActive:b.departmentActive!==false, archived: b.archived === true, version: version(b.version) ? b.version : 1,
  };
}

function board(b) {
  if (!record(b) || !id(b.id) || !Array.isArray(b.columns) || b.columns.length > 20 || !Array.isArray(b.cards) || b.cards.length > MAX_CARDS) fail();
  return {
    ...meta(b),
    columns: b.columns.map(c => { if (!record(c) || !id(c.id) || !Number.isSafeInteger(c.position)) fail(); return { id: c.id, name: clip(c.name, 60), position: c.position }; }),
    cards: b.cards.map(card),
    labels: Array.isArray(b.labels) ? b.labels.filter(l => record(l) && id(l.id) && boardColors.includes(l.color)).slice(0, 30).map(l => ({ id: l.id, name: clip(l.name, 40), color: l.color })) : [],
  };
}

function comment(c) {
  if (!record(c) || !id(c.id) || !['user', 'agent'].includes(c.authorKind) || typeof c.body !== 'string') fail();
  return { id: c.id, authorKind: c.authorKind, authorId: clip(c.authorId, 128), body: clip(c.body, MAX_COMMENT * 2), createdAt: when(c.createdAt) };
}

const codes = ['invalid_board', 'invalid_version', 'not_found', 'version_conflict', 'read_only_stage'];
function error(status, body) {
  const code = record(body) ? body.code : undefined;
  if (!codes.includes(code)) return null;
  if (code === 'version_conflict' && record(body.card)) return { code, card: card(body.card) };
  if (code === 'version_conflict' && record(body.board)) return { code, board: meta(body.board) };
  return { code };
}

export function boardResponse(path, status, body) {
  if (status !== 200 && status !== 201) return error(status, body);
  if (path === BOARDS_PATH || path === `${BOARDS_PATH}?archived=1`) {
    if (status === 201) return board(body);
    if (!record(body) || !Array.isArray(body.boards) || body.boards.length > 200) fail();
    const count = x => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
    return {
      boards: body.boards.map(b => ({ ...meta(b), cards: count(b.cards), open: count(b.open) })),
      templates: Array.isArray(body.templates) ? body.templates.filter(t => record(t) && templateId(t.id) && Array.isArray(t.columns)).slice(0, 30)
        .map(t => ({ id: t.id, name: clip(t.name, 60), description: clip(t.description, 200), columns: t.columns.filter(c => typeof c === 'string').slice(0, 20).map(c => clip(c, 60)) })) : [],
      colors: Array.isArray(body.colors) ? body.colors.filter(c => boardColors.includes(c)) : [],
    };
  }
  const p = boardPath(path);
  if (!p) fail();
  if(p.kind==='sync'){if(!record(body)||!Number.isSafeInteger(body.created)||body.created<0||body.created>200||!Number.isSafeInteger(body.departments)||body.departments<0||body.departments>200)fail();return {created:body.created,departments:body.departments};}
  if(p.kind==='overview'){
    if(!record(body)||!Array.isArray(body.tasks)||body.tasks.length>500||!Number.isSafeInteger(body.total)||body.total<body.tasks.length||body.limited!==(body.total>body.tasks.length))fail();
    const tasks=body.tasks.map(t=>{if(!record(t)||!id(t.cardId)||!id(t.boardId)||typeof t.title!=='string'||!priorities.includes(t.priority)||!date(t.dueDate))fail();return {cardId:t.cardId,boardId:t.boardId,boardName:clip(t.boardName,80),title:clip(t.title,200),status:clip(t.status,60),priority:t.priority,dueDate:t.dueDate};});
    if(new Set(tasks.map(t=>t.cardId)).size!==tasks.length)fail();return {tasks,total:body.total,limited:body.limited};
  }
  if (p.kind === 'card' || p.kind === 'cards') return card(body);
  if (p.kind === 'checklist' || p.kind === 'check') {
    if (!record(body) || !Array.isArray(body.items) || body.items.length > 50) fail();
    return { items: body.items.map(i => { if (!record(i) || !id(i.id) || typeof i.done !== 'boolean') fail(); return { id: i.id, text: clip(i.text, 300), done: i.done }; }) };
  }
  if (p.kind === 'comments') {
    if (!record(body) || !Array.isArray(body.comments) || body.comments.length > 500) fail();
    return { comments: body.comments.map(comment) };
  }
  return board(body);
}
