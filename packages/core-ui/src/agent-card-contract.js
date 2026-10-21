// AGENT-CARD-01 / MEMORY-PAGE-02 wire contract: an agent's profile and
// versioned persona, and the owner's memory items. Shared by the browser
// boundary and the local bridge: a strict allow-list of requests and a
// projection of every response to the reviewed fields (never error text,
// never embeddings or internal owner ids).
import { validAgentId } from './agent-id.js';

export const roles = ['main', 'manager', 'specialist', 'evaluator'];
export const providers = ['ollama', 'claude'];
export const MODELS_PATH = '/api/models';
const modelId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@\/-]{0,99}$/.test(x);
export const memoryTypes = ['fact', 'event', 'context', 'insight', 'preference', 'skill', 'relationship', 'task'];
export const drawerKinds = ['owner', 'experience', 'project', 'task', 'people'];
export const traitNames = ['doubt', 'caution', 'creativity', 'thoroughness', 'independence', 'verbosity', 'warmth', 'curiosity', 'persistence'];
export const MAX_MEMORY = 50000;

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (x, keys) => Object.keys(x).every(k => keys.includes(k));
const version = x => Number.isSafeInteger(x) && x > 0;
// eslint-disable-next-line no-control-regex
const badChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/u;
const text = (x, max, required = false) => typeof x === 'string' && x.length <= max && !badChars.test(x) && (!required || x.trim().length > 0);
const line = (x, max) => text(x, max, true) && !/\n/.test(x);
const memoryId = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const department = x => typeof x === 'string' && /^[a-z0-9][a-z0-9 _-]{0,63}$/.test(x);
const drawerKey = (kind, key) => kind === 'project' ? /^[a-z0-9][a-z0-9_-]{0,63}$/.test(key) : /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(key) && !key.includes('..');
export function validDrawer(d) {
  if (!record(d) || !onlyKeys(d, ['kind', 'key']) || !drawerKinds.includes(d.kind)) return false;
  const keyed = d.kind === 'project' || d.kind === 'task' || d.kind === 'people';
  return keyed ? typeof d.key === 'string' && drawerKey(d.kind, d.key) : d.key === undefined;
}
const importance = x => Number.isInteger(x) && x >= 1 && x <= 10;
/** CORE-MEM-TOPIC: a stable topic key, e.g. "owner-drinks". */
export const topicKey = x => typeof x === 'string' && x.length <= 80 && /^[\p{L}\p{N}]+(-[\p{L}\p{N}]+)*$/u.test(x);
const traits = x => record(x) && Object.keys(x).length === traitNames.length && traitNames.every(n => Number.isInteger(x[n]) && x[n] >= 0 && x[n] <= 100);

/** The card or memory path this request names, or null. */
export function cardPath(path) {
  if (/^\/api\/memory\/page(?:\?cursor=[A-Za-z0-9_-]{1,1024})?$/.test(path)) return { kind: 'memory-page' };
  let m = /^\/api\/agents\/([^/?#]+)\/personality\/(current|versions|lock|unlock|rollback)$/.exec(path);
  if (m) return validAgentId(m[1]) ? { kind: `persona-${m[2]}`, agent: m[1] } : null;
  if (path === MODELS_PATH) return { kind: 'models' };
  if (path === '/api/memory') return { kind: 'memories' };
  if (path === '/api/memory/drawers') return { kind: 'drawers' };
  if (path === '/api/memory/search') return { kind: 'search' };
  m = /^\/api\/memory\/([^/?#]+)$/.exec(path);
  if (m) return memoryId(m[1]) ? { kind: 'memory', id: m[1] } : null;
  m = /^\/api\/memory\/([^/?#]+)\/(forget|versions)$/.exec(path);
  if (m) return memoryId(m[1]) ? { kind: `memory-${m[2]}`, id: m[1] } : null;
  return null;
}
export function cardRoute(path) { return cardPath(path) !== null; }

/** PUT /api/agents/:id from the card: the version plus at least one profile field. */
export function validProfileEdit(b) {
  if (!record(b) || !onlyKeys(b, ['expectedVersion', 'role', 'department', 'description', 'model', 'provider']) || !version(b.expectedVersion) || Object.keys(b).length < 2) return false;
  if ((b.model === undefined) !== (b.provider === undefined)) return false;
  return (b.role === undefined || b.role === null || roles.includes(b.role))
    && (b.model === undefined || modelId(b.model)) && (b.provider === undefined || providers.includes(b.provider))
    && (b.department === undefined || b.department === null || department(b.department))
    && (b.description === undefined || text(b.description, 1000));
}

export function allowedAgentCard(method, path, body) {
  const agentPut = /^\/api\/agents\/([^/?#]+)$/.exec(path);
  if (agentPut && method === 'PUT') return validAgentId(agentPut[1]) && validProfileEdit(body);
  const p = cardPath(path);
  if (!p) return false;
  switch (p.kind) {
    case 'memory-page': return method === 'GET' && body === undefined;
    case 'models': return method === 'GET' && body === undefined;
    case 'persona-current': return method === 'GET' && body === undefined;
    case 'persona-versions':
      if (method === 'GET') return body === undefined;
      return method === 'POST' && record(body) && onlyKeys(body, ['preset', 'traits', 'dialect', 'note']) && Object.keys(body).length > 0
        && (body.preset === undefined || (typeof body.preset === 'string' && /^[a-z][a-z-]{0,39}$/.test(body.preset)))
        && (body.traits === undefined || traits(body.traits)) && !(body.preset !== undefined && body.traits !== undefined)
        && (body.dialect === undefined || (typeof body.dialect === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(body.dialect)))
        && (body.note === undefined || text(body.note, 500));
    case 'persona-lock': case 'persona-unlock': return method === 'POST' && body === undefined;
    case 'persona-rollback': return method === 'POST' && record(body) && Object.keys(body).length === 1 && version(body.version);
    case 'memories': return (method === 'GET' && body === undefined)
      || (method === 'POST' && record(body) && onlyKeys(body, ['type', 'content', 'importance', 'drawer', 'topicKey']) && memoryTypes.includes(body.type) && (body.topicKey === undefined || topicKey(body.topicKey))
        && text(body.content, MAX_MEMORY, true) && (body.importance === undefined || importance(body.importance)) && (body.drawer === undefined || validDrawer(body.drawer)));
    case 'drawers': return method === 'GET' && body === undefined;
    case 'search': return method === 'POST' && record(body) && onlyKeys(body, ['query', 'limit']) && line(body.query, 500) && (body.limit === undefined || (Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 50));
    case 'memory': return (method === 'DELETE' && body === undefined)
      || (method === 'PUT' && record(body) && onlyKeys(body, ['content', 'importance', 'type']) && Object.keys(body).length > 0
        && (body.content === undefined || text(body.content, MAX_MEMORY, true)) && (body.importance === undefined || importance(body.importance)) && (body.type === undefined || memoryTypes.includes(body.type)));
    case 'memory-forget': return method === 'POST' && body === undefined;
    case 'memory-versions': return method === 'GET' && body === undefined;
  }
  return false;
}

const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '');
const fail = () => { throw Error('Invalid agent card response'); };
/** Who wrote a memory version: an agent id, a short system word, or the owner ("you"; the owner id is never shown). */
function versionBy(x) {
  if (typeof x !== 'string' || !x) return '';
  if (/^agent:[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(x)) return x;
  if (/^[a-z][a-z_-]{0,19}$/.test(x)) return x;
  return 'you';
}

function persona(x) {
  if (!record(x) || !version(x.version) || !traits(x.traits)) fail();
  return { version: x.version, traits: { ...x.traits }, preset: typeof x.preset === 'string' ? str(x.preset, 40) : null, dialect: str(x.dialect, 8),
    locked: x.locked === true, note: typeof x.note === 'string' ? str(x.note, 500) : null, source: str(x.source, 20), createdAt: typeof x.createdAt === 'string' ? str(x.createdAt, 40) : null };
}

export function memoryItem(x) {
  if (!record(x) || !memoryId(x.id) || !memoryTypes.includes(x.type) || typeof x.content !== 'string') fail();
  const imp = Number.isInteger(x.importance) ? x.importance : Number.isFinite(x.importanceScore) ? Math.round(x.importanceScore * 10) : 5;
  const d = record(x.drawer) && drawerKinds.includes(x.drawer.kind) ? { kind: x.drawer.kind, ...(typeof x.drawer.key === 'string' ? { key: str(x.drawer.key, 128) } : {}) } : { kind: 'owner' };
  return { id: x.id, type: x.type, content: x.content.slice(0, MAX_MEMORY), importance: Math.min(10, Math.max(1, imp)), drawer: d,
    layer: typeof x.memoryLayer === 'string' ? str(x.memoryLayer, 20) : null, createdAt: str(x.createdAt, 40),
    tags: Array.isArray(x.tags) ? x.tags.filter(t => typeof t === 'string').slice(0, 20).map(t => t.slice(0, 60)) : [],
    ...(topicKey(x.topicKey) ? { topicKey: x.topicKey } : {}) };
}

const ERRORS = { 400: ['invalid_role', 'invalid_version', 'no_change'], 403: ['reserved_agent'], 404: [], 409: ['version_conflict', 'personality_locked'] };

/** Reviewed fields only. Throws on a malformed success body. */
export function agentCardResponse(path, status, body) {
  const p = cardPath(path);
  if (!p) fail();
  if (status !== 200 && status !== 201) {
    const code = record(body) ? body.code : undefined;
    return (ERRORS[status] ?? []).includes(code) ? { code } : null;
  }
  if (!record(body)) fail();
  switch (p.kind) {
    case 'memory-page': {
      if (!Array.isArray(body.memories) || body.memories.length > 100 || !Number.isSafeInteger(body.total) || body.total < 0 || !(body.nextCursor === null || (typeof body.nextCursor === 'string' && /^[A-Za-z0-9_-]{1,1024}$/.test(body.nextCursor)))) fail();
      return { memories: body.memories.map(memoryItem), nextCursor: body.nextCursor, total: body.total };
    }
    case 'models': {
      if (!Array.isArray(body.models)) fail();
      // Runs twice on the live path (bridge, then browser): already-projected rows ("ollama", "label") pass unchanged.
      // CHAT-PRO-02 G: LM Studio models keep their own provider and must carry the `lmstudio:` id prefix.
      const list = body.models.filter(m => record(m) && modelId(m.id) && ['local', 'ollama', 'claude', 'lmstudio','subscription'].includes(m.provider) && (m.provider==='subscription') === /^subscription:(claude|codex)(?::[a-f0-9]{32})?$/.test(m.id) && (m.provider === 'lmstudio') === m.id.startsWith('lmstudio:')).slice(0, 200)
        .map(m => ({ id: m.id, provider: m.provider === 'claude' || m.provider === 'lmstudio' || m.provider==='subscription' ? m.provider : 'ollama', label: str(String(m.label ?? m.name ?? m.id).replace(/^[^A-Za-z0-9]+/u, ''), 80), size: str(m.size, 20),
          // CORE-PICKER-02: a coding app's own models (Claude Code aliases, the Codex account's list).
          ...(m.provider === 'subscription' && Array.isArray(m.variants) ? { variants: m.variants.filter(v => record(v) && typeof v.id === 'string' && /^[a-z0-9][a-z0-9.-]{0,40}$/.test(v.id)).slice(0, 20).map(v => ({ id: v.id, label: str(v.label ?? v.id, 40) })) } : {}) }));
      return { models: list };
    }
    case 'persona-current': {
      const v = persona(body);
      return { ...v, traitNames: [...traitNames],
        dialects: Array.isArray(body.dialects) ? body.dialects.filter(d => typeof d === 'string').slice(0, 40).map(d => d.slice(0, 8)) : [],
        presets: Array.isArray(body.presets) ? body.presets.filter(x => record(x) && typeof x.id === 'string' && traits(x.traits)).slice(0, 30).map(x => ({ id: str(x.id, 40), label: str(x.label, 60), traits: { ...x.traits } })) : [] };
    }
    case 'persona-versions':
      if (Array.isArray(body.versions)) return { versions: body.versions.slice(0, 500).map(persona) };
      return persona(body);
    case 'persona-lock': case 'persona-unlock': case 'persona-rollback': return persona(body);
    case 'memories':
      if (Array.isArray(body.memories)) return { memories: body.memories.slice(0, 5000).map(memoryItem) };
      return { memory: memoryItem(body.memory) };
    case 'drawers':
      if (!Array.isArray(body.drawers)) fail();
      return { drawers: body.drawers.filter(d => record(d) && drawerKinds.includes(d.kind)).slice(0, 1000).map(d => ({ kind: d.kind, ...(typeof d.key === 'string' ? { key: str(d.key, 128) } : {}), count: Number.isSafeInteger(d.count) ? d.count : 0 })) };
    case 'search': return { memories: (Array.isArray(body.memories) ? body.memories : Array.isArray(body.results) ? body.results.map(r => r.memory ?? r) : []).slice(0, 50).map(memoryItem) };
    case 'memory': return record(body.memory) ? { memory: memoryItem(body.memory) } : { ok: body.success === true };
    case 'memory-forget': return { ok: body.success === true };
    case 'memory-versions':
      if (!Array.isArray(body.versions)) fail();
      return { versions: body.versions.slice(0, 200).map(v => ({ version: Number.isSafeInteger(v?.version) ? v.version : 0, change: str(v?.change, 20), type: str(v?.type, 20),
        content: typeof v?.content === 'string' ? v.content.slice(0, MAX_MEMORY) : '', createdAt: str(v?.createdAt, 40), reason: str(v?.reason, 40), by: versionBy(v?.createdBy ?? v?.by), proposal: v?.proposal === true || (typeof v?.proposalId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v.proposalId)) })) };
  }
  fail();
}
