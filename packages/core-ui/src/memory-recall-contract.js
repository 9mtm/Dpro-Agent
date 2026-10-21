// MEM-CACHE-01 wire contract: what a reply used, cache metrics, memory moves.
// Owner only. A strict allow-list of requests and a projection of every
// response to the reviewed fields (never error text). "Correct" opens a review
// proposal (decided with the existing memory proposal routes and its review
// hash); "Forget" is the complete removal (CORE-07).
//
//   GET  /api/memory/recall/messages/:messageId           the reply's trace
//   GET  /api/memory/recall/runs/:runId                   the same while the reply runs
//   POST /api/memory/recall/messages/:messageId/correct   { memoryId, content, note? }
//   POST /api/memory/recall/messages/:messageId/forget    { memoryId }
//   GET  /api/memory/recall/conversations/:id/summaries   stored summaries of older turns
//   GET  /api/memory/cache/metrics                        hit rates, pack size, time to first word, budget
//   POST /api/memory/:id/move                             { drawer, reason? }
import { validRunId } from './conversation-contract.js';

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const messageId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(x);
const conversationId = messageId;
const memoryId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(x);
const drawerId = x => typeof x === 'string' && /^(owner|experience|(project|task|people):[A-Za-z0-9][A-Za-z0-9_.@-]{0,127})$/.test(x);
const handoffScope = x => typeof x === 'string' && /^(conversation|task):[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
// eslint-disable-next-line no-control-regex
const badChars = /[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/u;
export const MAX_CORRECTION = 50000;
export const RECALL_REASONS = ['pinned', 'topic', 'graph', 'meaning', 'keyword', 'handoff'];
export const RECALL_STATES = ['active', 'changed', 'moved', 'deleted', 'forgotten'];
export const SUMMARY_SOURCES = ['model', 'fallback', 'inline'];
export const CACHE_METRICS_PATH = '/api/memory/cache/metrics';

export const recallMessagePath = id => `/api/memory/recall/messages/${id}`;
export const recallRunPath = id => `/api/memory/recall/runs/${id}`;
export const recallCorrectPath = id => `/api/memory/recall/messages/${id}/correct`;
export const recallForgetPath = id => `/api/memory/recall/messages/${id}/forget`;
export const conversationSummariesPath = id => `/api/memory/recall/conversations/${id}/summaries`;
export const memoryMovePath = id => `/api/memory/${id}/move`;

/** Which route a path is, with its id, or null. */
export function memoryRecallPath(path) {
  if (path === CACHE_METRICS_PATH) return { route: 'metrics' };
  let m = /^\/api\/memory\/recall\/messages\/([^/?#]+)(?:\/(correct|forget))?$/.exec(path);
  if (m && messageId(m[1])) return { route: m[2] ?? 'message', id: m[1] };
  m = /^\/api\/memory\/recall\/runs\/([^/?#]+)$/.exec(path);
  if (m && validRunId(m[1])) return { route: 'run', id: m[1] };
  m = /^\/api\/memory\/recall\/conversations\/([^/?#]+)\/summaries$/.exec(path);
  if (m && conversationId(m[1])) return { route: 'summaries', id: m[1] };
  m = /^\/api\/memory\/([^/?#]+)\/move$/.exec(path);
  if (m && memoryId(m[1])) return { route: 'move', id: m[1] };
  return null;
}

export function memoryRecallRoute(path) { return memoryRecallPath(path) !== null; }

const text = (x, max) => typeof x === 'string' && !!x.trim() && x.length <= max && !badChars.test(x);

export function allowedMemoryRecall(method, path, body) {
  const p = memoryRecallPath(path);
  if (!p) return false;
  if (['message', 'run', 'summaries', 'metrics'].includes(p.route)) return method === 'GET' && body === undefined;
  if (method !== 'POST' || !record(body)) return false;
  const keys = Object.keys(body);
  if (p.route === 'correct') {
    return keys.every(k => ['memoryId', 'content', 'note'].includes(k)) && memoryId(body.memoryId) && text(body.content, MAX_CORRECTION)
      && (body.note === undefined || text(body.note, 500));
  }
  if (p.route === 'forget') return keys.length === 1 && memoryId(body.memoryId);
  return keys.every(k => ['drawer', 'reason'].includes(k)) && drawerId(body.drawer) && (body.reason === undefined || text(body.reason, 200));
}

const fail = () => { throw Error('Invalid memory recall response'); };
const clip = (x, max) => (typeof x === 'string' ? (x.length > max ? x.slice(0, max) : x) : '');
const when = x => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(x) ? x.slice(0, 19) : '');
const count = x => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
const num = x => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
const rate = x => (typeof x === 'number' && x >= 0 && x <= 1 ? x : null);

function item(i) {
  if (!record(i) || !['memory', 'handoff'].includes(i.kind) || !memoryId(i.id) || !RECALL_REASONS.includes(i.why) || !RECALL_STATES.includes(i.state)) fail();
  const drawer = i.kind === 'handoff' ? (handoffScope(i.drawer) ? i.drawer : null) : (drawerId(i.drawer) ? i.drawer : null);
  return {
    kind: i.kind, id: i.id, drawer, why: i.why, state: i.state,
    ...(rate(i.score) !== null ? { score: i.score } : {}),
    ...(typeof i.type === 'string' ? { type: clip(i.type, 20) } : {}),
    // A forgotten or deleted memory never shows text.
    ...(i.kind === 'memory' && ['active', 'changed', 'moved'].includes(i.state) && typeof i.preview === 'string' ? { preview: clip(i.preview, 300) } : {}),
    ...(i.state === 'moved' && drawerId(i.nowIn) ? { nowIn: i.nowIn } : {}),
  };
}

function trace(t) {
  if (!record(t) || !validRunId(t.runId) || !Array.isArray(t.items) || t.items.length > 64 || !record(t.context)) fail();
  const c = t.context;
  const summaries = Array.isArray(c.summaries) ? c.summaries.slice(0, 64).filter(s => record(s) && SUMMARY_SOURCES.includes(s.source)).map(s => ({ id: clip(s.id, 80), turns: count(s.turns), source: s.source })) : [];
  return {
    runId: t.runId, messageId: messageId(t.messageId) ? t.messageId : null, agentId: typeof t.agentId === 'string' ? clip(t.agentId, 128) : null,
    createdAt: when(t.createdAt), items: t.items.map(item),
    context: {
      keptTurns: count(c.keptTurns), summarisedTurns: count(c.summarisedTurns), droppedTurns: count(c.droppedTurns), summaries,
      fromCache: { pack: record(c.fromCache) && c.fromCache.pack === true, recall: record(c.fromCache) && c.fromCache.recall === true },
      budgetTokens: count(c.budgetTokens), numCtx: count(c.numCtx), packChars: count(c.packChars), promptTokens: count(c.promptTokens), ttftMs: num(c.ttftMs),
    },
  };
}

function cacheEntry(c) { return record(c) ? { hits: count(c.hits), misses: count(c.misses), hitRate: rate(c.hitRate) } : { hits: 0, misses: 0, hitRate: null }; }

function metrics(b) {
  const p = record(b.process) ? b.process : {};
  const r = record(b.recent) ? b.recent : {};
  const g = record(b.budget) ? b.budget : {};
  const caches = record(p.caches) ? p.caches : {};
  const ttft = record(p.ttftMs) ? p.ttftMs : {};
  const pack = record(p.packChars) ? p.packChars : {};
  return {
    process: {
      since: when(p.since),
      caches: { pack: cacheEntry(caches.pack), recall: cacheEntry(caches.recall), embedding: cacheEntry(caches.embedding) },
      packChars: { last: num(pack.last), avg: num(pack.avg), samples: count(pack.samples) },
      ttftMs: { last: num(ttft.last), p50: num(ttft.p50), p90: num(ttft.p90), samples: count(ttft.samples) },
    },
    recent: {
      turns: count(r.turns), packHitRate: rate(r.packHitRate), avgPackChars: num(r.avgPackChars), avgPromptTokens: num(r.avgPromptTokens),
      ttftMs: { p50: num(record(r.ttftMs) ? r.ttftMs.p50 : null), p90: num(record(r.ttftMs) ? r.ttftMs.p90 : null) },
    },
    budget: { numCtx: count(g.numCtx), promptTokens: count(g.promptTokens), summaryTokens: count(g.summaryTokens), keepAlive: clip(g.keepAlive, 12) },
  };
}

const codes = ['not_found', 'not_in_trace', 'invalid_content', 'invalid_note', 'invalid_drawer', 'invalid_reason', 'same_drawer', 'topic_key_taken', 'forbidden'];

export function memoryRecallResponse(path, status, body) {
  const p = memoryRecallPath(path);
  if (!p) fail();
  if (status !== 200 && status !== 201) { const code = record(body) ? body.code : undefined; return codes.includes(code) ? { code } : null; }
  if (!record(body)) fail();
  switch (p.route) {
    case 'message': case 'run': return { trace: trace(body.trace) };
    case 'correct': {
      const pr = body.proposal;
      if (status !== 201 || !record(pr) || !memoryId(pr.id) || typeof pr.reviewHash !== 'string') fail();
      return { proposal: { id: pr.id, status: clip(pr.status, 20), reviewHash: clip(pr.reviewHash, 64), drawerId: drawerId(pr.drawerId) ? pr.drawerId : null, createdAt: when(pr.createdAt) } };
    }
    case 'forget': {
      const f = body.forgotten;
      if (!record(f) || !memoryId(f.memoryId)) fail();
      return { forgotten: { memoryId: f.memoryId, drawerId: drawerId(f.drawerId) ? f.drawerId : null, forgottenAt: when(f.forgottenAt) } };
    }
    case 'summaries': {
      if (!Array.isArray(body.summaries) || body.summaries.length > 500) fail();
      return {
        summaries: body.summaries.map(s => {
          if (!record(s) || !SUMMARY_SOURCES.includes(s.source)) fail();
          return { id: clip(s.id, 80), level: count(s.level), firstTurn: count(s.firstTurn), lastTurn: count(s.lastTurn), turns: count(s.turns), text: clip(s.text, 1200), source: s.source, createdAt: when(s.createdAt) };
        }),
      };
    }
    case 'metrics': return metrics(body);
    case 'move': {
      if (!record(body.memory) || !memoryId(body.memory.id) || !drawerId(body.from) || !drawerId(body.to)) fail();
      return { memoryId: body.memory.id, from: body.from, to: body.to };
    }
    default: return fail();
  }
}
