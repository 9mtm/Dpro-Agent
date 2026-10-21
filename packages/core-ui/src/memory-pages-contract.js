// MEM-UI-01 wire contract: the memory pages (boards M1–M9). Owner only.
// Shared by the browser boundary and the local bridge: a strict allow-list of
// requests (exact keys, bounded values, canonical query strings) and a
// projection of every response to the reviewed fields (never error text).
// Every change that touches many memories or agents goes preview -> apply
// with the preview's hash and confirm: true; the server re-checks both.
//
//   Scopes (MEM-SCALE-01)
//   GET    /api/memory/scopes/tree[?fresh=1]
//   GET    /api/memory/scopes/search?q=&kinds=&limit=
//   GET    /api/memory/scopes/agents?q=&cursor=&limit=
//   GET    /api/memory/scopes/memories?scope=&q=&type=&layer=&topic=&source=&agent=&importance=&from=&to=&cursor=&limit=
//   GET    /api/memory/scopes/pinned?scope=
//   POST   /api/memory/scopes/pinned                     { scope, text }
//   PATCH  /api/memory/scopes/pinned/:id                 { text?, position? }
//   DELETE /api/memory/scopes/pinned/:id
//   POST   /api/memory/scopes/projects/:slug/preview     { action, target?, departmentId? }
//   POST   /api/memory/scopes/projects/:slug/apply       { action, target?, departmentId?, expectedPreviewHash, confirm: true }
//   GET    /api/memory/scopes/projects/:slug/export
//   Access by inheritance
//   GET    /api/memory/access
//   POST   /api/memory/access/preview                    { changes }
//   POST   /api/memory/access/apply                      { changes, expectedPreviewHash, confirm: true }
//   GET    /api/memory/access/effective/:agentId[?project=]
//   Doctor (CORE-MEM-DOCTOR)
//   GET    /api/memory/doctor
//   POST   /api/memory/doctor/fix                        { confirm: true, expectedReportHash, kinds? }
//   Knowledge map (CORE-MEM-GRAPH)
//   GET    /api/memory/graph/entities?q=&kind=&limit=
//   GET    /api/memory/graph/entities/:id
//   GET    /api/memory/graph/links?status=&limit=
//   POST   /api/memory/graph/links/:id/approve | reject
//   Handoffs (CORE-MEM-HANDOFF)
//   GET    /api/handoffs?agentId=&kind=&projectId=&limit=
//   GET    /api/handoffs/:kind/:scopeId?agentId=
//   PUT    /api/handoffs/:kind/:scopeId                  { agentId, done?, left?, next?, questions? }
//   Conflicts (CORE-MEM-CONFLICT)
//   POST   /api/memory/proposals/:id/decide              { decision, expectedReviewHash, note? }
//   Built on MEM-GAPS-02 / MEM-FINISH-01 (boards M2, M3, M4, M7, M9, M12–M14)
//   GET    /api/memory/scopes/memories/:id               one memory: used in N replies, entities, readers
//   GET    /api/memory/scopes/rules?scope=               review rules of one scope (own + effective)
//   PUT    /api/memory/scopes/rules                      { scope, routine?, important?, contradiction?, reviewerAgentId?, weeklyDay?, weeklyHour? }
//   GET    /api/memory/access/agents?scope=&column=&mode=&q=&cursor=&limit=
//   GET    /api/memory/access/counts?column=&mode=
//   GET    /api/memory/access/templates/:id?cursor=&limit=
//   GET    /api/memory/proposals/groups?by=
//   POST   /api/memory/proposals/accept-routine/preview  { scope?, agent? }
//   POST   /api/memory/proposals/accept-routine          { scope?, agent?, expectedPreviewHash, confirm: true }
//   GET    /api/memory/graph/agent-view/:agentId?project=&q=&kind=&limit=
//   GET    /api/memory/graph/clusters?limit=&drawers=
//   POST   /api/memory/graph/clusters/:id/topic-preview  { topicKey? }
//   POST   /api/memory/graph/clusters/:id/topic          { topicKey?, expectedPreviewHash, confirm: true }
//   POST   /api/memory/graph/clusters/:id/dismiss
//   POST   /api/memory/graph/sync                        { limit? }
//   GET    /api/handoffs/coding-apps?projectId=&client=&limit=
//   Rules and speed (CORE-05/07, MEM-CACHE-01)
//   GET    /api/memory/weekly-summary
//   GET    /api/memory/retention
//   PUT    /api/memory/retention                         { enabled?, taskTtlDays?, experienceAfterDays?, experienceMinGroup? }
//   POST   /api/memory/cache/clear                       { confirm: true }

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (x, keys) => Object.keys(x).every(k => keys.includes(k));
// eslint-disable-next-line no-control-regex
const badChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/u;
const text = (x, max) => typeof x === 'string' && !!x.trim() && x.length <= max && !badChars.test(x);
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);

export const DRAWER_KINDS = ['owner', 'project', 'experience', 'task', 'people'];
/** Columns of the access grid: the drawer kinds, then company / department pinned facts (MEM-GAPS-02). */
export const SCOPE_COLUMNS = ['company', 'department'];
export const ACCESS_COLUMNS = [...DRAWER_KINDS, ...SCOPE_COLUMNS];
/** metadata.source values the explorer filters on. */
export const MEMORY_SOURCES = ['owner', 'agent', 'outsider', 'chat', 'conversation', 'learning', 'import', 'memory_file', 'retention'];
export const PROJECT_ACTIONS = ['pin', 'unpin', 'archive', 'unarchive', 'move', 'merge', 'forget'];
export const ACCESS_MODES = ['allow', 'deny', 'inherit'];
export const DOCTOR_KINDS = ['duplicate', 'expired', 'embedding-missing', 'embedding-stale', 'orphan-versions', 'broken-drawer', 'topic-key-invalid', 'graph-orphan'];
export const ENTITY_KINDS = ['person', 'project', 'place', 'topic', 'agent', 'task', 'decision'];
export const LINK_STATUSES = ['active', 'pending', 'rejected'];
export const HANDOFF_KINDS = ['conversation', 'task'];
export const CONFLICT_DECISIONS = ['keep_new', 'keep_old', 'keep_both'];
export const MAX_PINNED_TEXT = 1000;
export const MAX_HANDOFF_ITEMS = 8;
export const MAX_HANDOFF_ITEM = 300;
export const ROUTINE_RULES = ['save', 'ask'];
export const IMPORTANT_RULES = ['ask', 'save'];
export const CONTRADICTION_RULES = ['ask', 'keep_new', 'keep_both'];
export const REVIEW_GROUP_BY = ['scope', 'department', 'agent'];
export const BRIDGE_CLIENTS = ['claude-code', 'codex', 'gemini-cli', 'antigravity'];

const slug = x => typeof x === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(x);
const departmentId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(x);
const agentId = x => typeof x === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(x) && !x.includes('..');
const handoffAgent = x => typeof x === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(x) && !x.includes('..');
const scopeId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const plainId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const proposalId = x => typeof x === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(x);
const cursor = x => typeof x === 'string' && /^[A-Za-z0-9_=-]{1,1024}$/.test(x);
const limit = max => x => /^[1-9][0-9]{0,3}$/.test(x) && Number(x) <= max;
const word = x => typeof x === 'string' && /^[a-z][a-z_-]{0,31}$/.test(x);
const queryText = max => x => typeof x === 'string' && x.length <= max && !badChars.test(x);
const day = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(`${x}T00:00:00Z`));
export function validDrawerId(x) {
  return typeof x === 'string' && (x === 'owner' || x === 'experience' || /^project:[a-z0-9][a-z0-9_-]{0,63}$/.test(x)
    || (/^(task|people):[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(x) && !x.includes('..')));
}
/** A scope of the explorer: company, department:<id>, agent:<id>, kind:<drawer kind> or a drawer id. */
export function validScope(x) {
  return x === 'company' || validDrawerId(x) || (typeof x === 'string' && ((x.startsWith('department:') && departmentId(x.slice(11))) || (x.startsWith('agent:') && agentId(x.slice(6)))
    || (x.startsWith('kind:') && DRAWER_KINDS.includes(x.slice(5)))));
}
/** A scope that holds pinned facts or access rules. */
export const validRuleScope = x => x === 'company' || (typeof x === 'string' && ((x.startsWith('department:') && departmentId(x.slice(11))) || (x.startsWith('project:') && slug(x.slice(8)))));

/** Query strings: only the listed keys, each at most once, values checked, written in canonical form. */
function query(raw, rules) {
  if (raw === '') return {};
  const out = {};
  for (const part of raw.split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) return null;
    const key = part.slice(0, i);
    let value;
    try { value = decodeURIComponent(part.slice(i + 1)); } catch { return null; }
    if (!rules[key] || key in out || encodeURIComponent(value) !== part.slice(i + 1) || !rules[key](value)) return null;
    out[key] = value;
  }
  return out;
}
/** Builds a canonical query string (skips empty values). */
export function queryString(params) {
  const parts = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

const QUERIES = {
  tree: { fresh: x => x === '1' },
  search: { q: queryText(200), kinds: x => /^[a-z]+(,[a-z]+){0,3}$/.test(x), limit: limit(50) },
  agents: { q: queryText(200), cursor, limit: limit(200) },
  memories: {
    scope: validScope, q: queryText(200), type: word, layer: word, topic: x => x === 'has' || x === 'none', cursor, limit: limit(200),
    source: x => MEMORY_SOURCES.includes(x), agent: agentId, importance: x => /^(10|[1-9])(-(10|[1-9]))?$/.test(x), from: day, to: day,
  },
  pinned: { scope: validRuleScope },
  effective: { project: slug },
  entities: { q: queryText(200), kind: x => ENTITY_KINDS.includes(x), limit: limit(500) },
  links: { status: x => LINK_STATUSES.includes(x), limit: limit(500) },
  handoffs: { agentId: handoffAgent, kind: x => HANDOFF_KINDS.includes(x), projectId: plainId, limit: limit(200) },
  handoff: { agentId: handoffAgent },
  rules: { scope: validRuleScope },
  accessAgents: { scope: validRuleScope, column: x => ACCESS_COLUMNS.includes(x), mode: x => x === 'read' || x === 'write', q: queryText(200), cursor, limit: limit(500) },
  accessCounts: { column: x => ACCESS_COLUMNS.includes(x), mode: x => x === 'read' || x === 'write' },
  template: { cursor, limit: limit(500) },
  groups: { by: x => REVIEW_GROUP_BY.includes(x) },
  agentView: { project: slug, q: queryText(200), kind: x => ENTITY_KINDS.includes(x), limit: limit(500) },
  clusters: { limit: limit(150), drawers: x => x.length <= 2000 && x.split(',').every(validDrawerId) },
  codingHandoffs: { projectId: plainId, client: x => BRIDGE_CLIENTS.includes(x), limit: limit(200) },
};

/** Which memory-page route a path is, with its ids and query, or null. */
export function memoryPagesPath(path) {
  if (typeof path !== 'string' || path.length > 2048) return null;
  const q = path.indexOf('?');
  const base = q < 0 ? path : path.slice(0, q);
  const raw = q < 0 ? '' : path.slice(q + 1);
  const with_ = (route, rules, extra = {}) => { const params = rules ? query(raw, rules) : (raw === '' ? {} : null); return params ? { route, params, ...extra } : null; };
  let m;
  switch (base) {
    case '/api/memory/scopes/tree': return with_('tree', QUERIES.tree);
    case '/api/memory/scopes/search': return with_('search', QUERIES.search);
    case '/api/memory/scopes/agents': return with_('agents', QUERIES.agents);
    case '/api/memory/scopes/memories': return with_('memories', QUERIES.memories);
    case '/api/memory/scopes/pinned': return with_('pinned', QUERIES.pinned);
    case '/api/memory/access': return with_('access', null);
    case '/api/memory/access/preview': return with_('access-preview', null);
    case '/api/memory/access/apply': return with_('access-apply', null);
    case '/api/memory/doctor': return with_('doctor', null);
    case '/api/memory/doctor/fix': return with_('doctor-fix', null);
    case '/api/memory/graph/entities': return with_('entities', QUERIES.entities);
    case '/api/memory/graph/links': return with_('links', QUERIES.links);
    case '/api/handoffs': return with_('handoffs', QUERIES.handoffs);
    case '/api/memory/weekly-summary': return with_('weekly', null);
    case '/api/memory/retention': return with_('retention', null);
    case '/api/memory/cache/clear': return with_('cache-clear', null);
    case '/api/memory/scopes/rules': return with_('rules', QUERIES.rules);
    case '/api/memory/access/agents': return with_('access-agents', QUERIES.accessAgents);
    case '/api/memory/access/counts': return with_('access-counts', QUERIES.accessCounts);
    case '/api/memory/proposals/groups': return with_('review-groups', QUERIES.groups);
    case '/api/memory/proposals/accept-routine/preview': return with_('routine-preview', null);
    case '/api/memory/proposals/accept-routine': return with_('routine-accept', null);
    case '/api/memory/graph/clusters': return with_('clusters', QUERIES.clusters);
    case '/api/memory/graph/sync': return with_('graph-sync', null);
    case '/api/handoffs/coding-apps': return with_('coding-handoffs', QUERIES.codingHandoffs);
  }
  if ((m = /^\/api\/memory\/scopes\/pinned\/([^/]+)$/.exec(base)) && plainId(m[1])) return with_('pinned-fact', null, { id: m[1] });
  if ((m = /^\/api\/memory\/scopes\/projects\/([^/]+)\/(preview|apply|export)$/.exec(base)) && slug(m[1])) return with_(`project-${m[2]}`, null, { id: m[1] });
  if ((m = /^\/api\/memory\/access\/effective\/([^/]+)$/.exec(base)) && agentId(m[1])) return with_('effective', QUERIES.effective, { id: m[1] });
  if ((m = /^\/api\/memory\/graph\/entities\/([^/]+)$/.exec(base)) && plainId(m[1])) return with_('entity', null, { id: m[1] });
  if ((m = /^\/api\/memory\/graph\/links\/([^/]+)\/(approve|reject)$/.exec(base)) && plainId(m[1])) return with_(`link-${m[2]}`, null, { id: m[1] });
  if ((m = /^\/api\/handoffs\/(conversation|task)\/([^/]+)$/.exec(base)) && scopeId(m[2])) return with_('handoff', QUERIES.handoff, { id: m[2], kind: m[1] });
  if ((m = /^\/api\/memory\/proposals\/([^/]+)\/decide$/.exec(base)) && proposalId(m[1])) return with_('decide', null, { id: m[1] });
  if ((m = /^\/api\/memory\/scopes\/memories\/([^/]+)$/.exec(base)) && plainId(m[1])) return with_('memory-detail', null, { id: m[1] });
  if ((m = /^\/api\/memory\/access\/templates\/([^/]+)$/.exec(base)) && /^[A-Za-z0-9_-]{1,64}$/.test(m[1])) return with_('template', QUERIES.template, { id: m[1] });
  if ((m = /^\/api\/memory\/graph\/agent-view\/([^/]+)$/.exec(base)) && agentId(m[1])) return with_('agent-view', QUERIES.agentView, { id: m[1] });
  if ((m = /^\/api\/memory\/graph\/clusters\/([^/]+)\/(topic-preview|topic|dismiss)$/.exec(base)) && plainId(m[1])) return with_(`cluster-${m[2]}`, null, { id: m[1] });
  return null;
}

export function memoryPagesRoute(path) { return memoryPagesPath(path) !== null; }

const kinds = x => Array.isArray(x) && x.length <= DRAWER_KINDS.length && x.every(k => DRAWER_KINDS.includes(k)) && new Set(x).size === x.length;
const scopeCols = x => Array.isArray(x) && x.length <= SCOPE_COLUMNS.length && x.every(k => SCOPE_COLUMNS.includes(k)) && new Set(x).size === x.length;
function accessChange(c) {
  if (!record(c)) return false;
  const agent = c.agentId === undefined || c.agentId === null || agentId(c.agentId);
  switch (c.op) {
    case 'set_rule':
      return onlyKeys(c, ['op', 'scope', 'agentId', 'drawerKind', 'read', 'write', 'endsAt', 'reason']) && agent && validRuleScope(c.scope) && ACCESS_COLUMNS.includes(c.drawerKind)
        && (c.read === undefined || ACCESS_MODES.includes(c.read)) && (c.write === undefined || ACCESS_MODES.includes(c.write))
        && (c.endsAt === undefined || c.endsAt === null || (typeof c.endsAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(c.endsAt) && !!c.agentId))
        && (c.reason === undefined || c.reason === null || text(c.reason, 200));
    case 'clear_rule': return onlyKeys(c, ['op', 'scope', 'agentId', 'drawerKind']) && agent && validRuleScope(c.scope) && ACCESS_COLUMNS.includes(c.drawerKind);
    case 'save_template':
      return onlyKeys(c, ['op', 'id', 'name', 'memoryRead', 'memoryWrite', 'scopeRead', 'scopeWrite']) && (c.id === undefined || c.id === null || (typeof c.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.id)))
        && text(c.name, 80) && kinds(c.memoryRead) && kinds(c.memoryWrite) && c.memoryWrite.every(k => c.memoryRead.includes(k))
        // Scope columns: left out = keep; null = no limit; a list caps them (scopeWrite only with scopeRead, within it).
        && (c.scopeRead === undefined ? c.scopeWrite === undefined
          : c.scopeRead === null ? (c.scopeWrite === undefined || c.scopeWrite === null || (Array.isArray(c.scopeWrite) && c.scopeWrite.length === 0))
            : scopeCols(c.scopeRead) && (c.scopeWrite === undefined || c.scopeWrite === null || (scopeCols(c.scopeWrite) && c.scopeWrite.every(k => c.scopeRead.includes(k)))));
    case 'delete_template': return onlyKeys(c, ['op', 'id']) && typeof c.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.id);
    case 'assign_template':
      return onlyKeys(c, ['op', 'template', 'agentIds']) && (c.template === null || text(c.template, 80))
        && Array.isArray(c.agentIds) && c.agentIds.length > 0 && c.agentIds.length <= 5000 && c.agentIds.every(agentId);
  }
  return false;
}
const changes = x => Array.isArray(x) && x.length > 0 && x.length <= 100 && x.every(accessChange);
function projectAction(b, apply) {
  const keys = ['action', 'target', 'departmentId', ...(apply ? ['expectedPreviewHash', 'confirm'] : [])];
  if (!record(b) || !onlyKeys(b, keys) || !PROJECT_ACTIONS.includes(b.action)) return false;
  if (apply && (b.confirm !== true || !hash(b.expectedPreviewHash))) return false;
  if (b.action === 'merge') { if (!slug(b.target)) return false; } else if (b.target !== undefined) return false;
  if (b.action === 'move') { if (!departmentId(b.departmentId)) return false; } else if (b.departmentId !== undefined) return false;
  return true;
}
const handoffList = x => x === undefined || (Array.isArray(x) && x.length <= MAX_HANDOFF_ITEMS && x.every(i => text(i, MAX_HANDOFF_ITEM) && !/\n/.test(i)));

export function allowedMemoryPages(method, path, body) {
  const p = memoryPagesPath(path);
  if (!p) return false;
  const get = method === 'GET' && body === undefined;
  switch (p.route) {
    case 'tree': case 'search': case 'agents': case 'memories': case 'access': case 'effective': case 'doctor': case 'entities': case 'entity': case 'links': case 'handoffs': case 'project-export': case 'weekly':
      return get;
    case 'retention':
      if (method === 'GET') return body === undefined;
      return method === 'PUT' && record(body) && onlyKeys(body, ['enabled', 'taskTtlDays', 'experienceAfterDays', 'experienceMinGroup']) && Object.keys(body).length > 0
        && (body.enabled === undefined || typeof body.enabled === 'boolean')
        && ['taskTtlDays', 'experienceAfterDays', 'experienceMinGroup'].every(k => body[k] === undefined || (Number.isInteger(body[k]) && body[k] >= 1 && body[k] <= 3650));
    case 'cache-clear': return method === 'POST' && record(body) && Object.keys(body).length === 1 && body.confirm === true;
    case 'pinned':
      if (method === 'GET') return body === undefined && p.params.scope !== undefined;
      return method === 'POST' && raw(p) && record(body) && onlyKeys(body, ['scope', 'text']) && validRuleScope(body.scope) && text(body.text, MAX_PINNED_TEXT);
    case 'pinned-fact':
      if (method === 'DELETE') return body === undefined;
      return method === 'PATCH' && record(body) && onlyKeys(body, ['text', 'position']) && Object.keys(body).length > 0
        && (body.text === undefined || text(body.text, MAX_PINNED_TEXT)) && (body.position === undefined || (Number.isInteger(body.position) && body.position >= 0 && body.position <= 1000));
    case 'project-preview': return method === 'POST' && projectAction(body, false);
    case 'project-apply': return method === 'POST' && projectAction(body, true);
    case 'access-preview': return method === 'POST' && record(body) && onlyKeys(body, ['changes']) && changes(body.changes);
    case 'access-apply': return method === 'POST' && record(body) && onlyKeys(body, ['changes', 'expectedPreviewHash', 'confirm']) && changes(body.changes) && hash(body.expectedPreviewHash) && body.confirm === true;
    case 'doctor-fix':
      return method === 'POST' && record(body) && onlyKeys(body, ['confirm', 'expectedReportHash', 'kinds']) && body.confirm === true && hash(body.expectedReportHash)
        && (body.kinds === undefined || (Array.isArray(body.kinds) && body.kinds.length > 0 && body.kinds.length <= DOCTOR_KINDS.length && body.kinds.every(k => DOCTOR_KINDS.includes(k))));
    case 'link-approve': case 'link-reject': return method === 'POST' && body === undefined;
    case 'handoff':
      if (method === 'GET') return body === undefined && p.params.agentId !== undefined;
      return method === 'PUT' && raw(p) && record(body) && onlyKeys(body, ['agentId', 'done', 'left', 'next', 'questions']) && handoffAgent(body.agentId)
        && handoffList(body.done) && handoffList(body.left) && handoffList(body.next) && handoffList(body.questions);
    case 'decide':
      return method === 'POST' && record(body) && onlyKeys(body, ['decision', 'expectedReviewHash', 'note']) && CONFLICT_DECISIONS.includes(body.decision)
        && hash(body.expectedReviewHash) && (body.note === undefined || text(body.note, 500));
    case 'memory-detail': case 'access-agents': case 'access-counts': case 'template': case 'review-groups': case 'agent-view': case 'clusters': case 'coding-handoffs':
      return get;
    case 'rules':
      if (method === 'GET') return body === undefined && p.params.scope !== undefined;
      return method === 'PUT' && raw(p) && rulesBody(body);
    case 'routine-preview': return method === 'POST' && routineFilter(body, []);
    case 'routine-accept': return method === 'POST' && routineFilter(body, ['expectedPreviewHash', 'confirm']) && body.confirm === true && hash(body.expectedPreviewHash);
    case 'cluster-topic-preview': return method === 'POST' && /^[0-9a-f]{32}$/.test(p.id) && record(body) && onlyKeys(body, ['topicKey']) && (body.topicKey === undefined || topicKey(body.topicKey));
    case 'cluster-topic':
      return method === 'POST' && /^[0-9a-f]{32}$/.test(p.id) && record(body) && onlyKeys(body, ['topicKey', 'expectedPreviewHash', 'confirm']) && body.confirm === true && hash(body.expectedPreviewHash)
        && (body.topicKey === undefined || topicKey(body.topicKey));
    case 'cluster-dismiss': return method === 'POST' && /^[0-9a-f]{32}$/.test(p.id) && body === undefined;
    case 'graph-sync': return method === 'POST' && record(body) && onlyKeys(body, ['limit']) && (body.limit === undefined || (Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 1000));
  }
  return false;
}
const topicKey = x => typeof x === 'string' && /^[a-z0-9][a-z0-9._-]{0,119}$/.test(x);
const ruleScopeOrDrawer = x => validRuleScope(x) || validDrawerId(x);
function routineFilter(b, extra) {
  return record(b) && onlyKeys(b, ['scope', 'agent', ...extra]) && (b.scope === undefined || ruleScopeOrDrawer(b.scope)) && (b.agent === undefined || agentId(b.agent));
}
function rulesBody(b) {
  if (!record(b) || !onlyKeys(b, ['scope', 'routine', 'important', 'contradiction', 'reviewerAgentId', 'weeklyDay', 'weeklyHour']) || !validRuleScope(b.scope) || Object.keys(b).length < 2) return false;
  const pick = (k, list) => b[k] === undefined || b[k] === null || list.includes(b[k]);
  const hour = (k, max) => b[k] === undefined || b[k] === null || (Number.isInteger(b[k]) && b[k] >= 0 && b[k] <= max);
  return pick('routine', ROUTINE_RULES) && pick('important', IMPORTANT_RULES) && pick('contradiction', CONTRADICTION_RULES)
    && (b.reviewerAgentId === undefined || b.reviewerAgentId === null || (b.scope.startsWith('department:') && agentId(b.reviewerAgentId)))
    && hour('weeklyDay', 6) && hour('weeklyHour', 23) && ((b.weeklyDay === undefined) === (b.weeklyHour === undefined))
    && (b.weeklyDay === undefined || b.scope === 'company');
}
/** Writes never carry a query string. */
function raw(p) { return Object.keys(p.params).length === 0; }

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const fail = () => { throw Error('Invalid memory page response'); };
const clip = (x, max) => (typeof x === 'string' ? (x.length > max ? x.slice(0, max) : x) : '');
const when = x => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(x) ? x.slice(0, 19) : '');
const whenOrNull = x => (when(x) || null);
const count = x => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
const list = (x, max) => (Array.isArray(x) ? x.slice(0, max) : []);
const health = x => (['ok', 'attention', 'problem'].includes(x) ? x : 'ok');
const reasons = x => list(x, 8).filter(r => typeof r === 'string' && /^[a-z_]{1,32}$/.test(r));
const kindList = x => list(x, 5).filter(k => DRAWER_KINDS.includes(k));
const columnList = x => list(x, ACCESS_COLUMNS.length).filter(k => ACCESS_COLUMNS.includes(k));
const scopeList = x => (x === null || x === undefined ? null : list(x, 2).filter(k => SCOPE_COLUMNS.includes(k)));
const idOr = (x, ok, fallback = null) => (ok(x) ? x : fallback);

function counts(c) {
  return { memories: count(c.memories), pendingReviews: count(c.pendingReviews), conflicts: count(c.conflicts), pinnedFacts: count(c.pinnedFacts), lastMemoryAt: whenOrNull(c.lastMemoryAt), health: health(c.health), reasons: reasons(c.reasons) };
}
function project(p) {
  if (!record(p) || !slug(p.slug)) fail();
  return {
    slug: p.slug, name: clip(p.name, 120) || p.slug, departmentId: idOr(p.departmentId, departmentId, 'general'), pinned: p.pinned === true, archived: p.archived === true,
    archivedAt: whenOrNull(p.archivedAt), mergedInto: idOr(p.mergedInto, slug), ...(record(p) && 'memories' in p ? counts(p) : {}),
  };
}
function tree(b) {
  const c = record(b.company) ? b.company : {};
  const drawers = {};
  // Counts per drawer kind (owner, project, …).
  if (record(c.drawers)) for (const [k, v] of Object.entries(c.drawers).slice(0, 20)) if (DRAWER_KINDS.includes(k)) drawers[k] = count(v);
  const a = record(b.agents) ? b.agents : {};
  return {
    generatedAt: when(b.generatedAt), cached: b.cached === true,
    company: { ...counts(c), drawers, departments: count(c.departments), projects: count(c.projects), archivedProjects: count(c.archivedProjects) },
    departments: list(b.departments, 500).filter(d => record(d) && departmentId(d.id)).map(d => ({ id: d.id, name: clip(d.name, 120) || d.id, isDefault: d.isDefault === true, projects: count(d.projects), archivedProjects: count(d.archivedProjects), ...counts(d) })),
    projects: list(b.projects, 5000).filter(p => record(p) && slug(p.slug)).map(project),
    people: list(b.people, 5000).filter(p => record(p) && validDrawerId(`people:${p.key}`)).map(p => ({ key: p.key, ...counts(p) })),
    agents: { total: count(a.total), withTemplate: count(a.withTemplate), withExceptions: count(a.withExceptions) },
  };
}
function facet(x) {
  const out = {};
  if (record(x)) for (const [k, v] of Object.entries(x).slice(0, 50)) if (k.length <= 160) out[k] = count(v);
  return out;
}
function explorerItem(i) {
  if (!record(i) || !plainId(i.id)) fail();
  return {
    id: i.id, type: clip(i.type, 32), preview: clip(i.preview, 400), drawerId: idOr(i.drawerId, validDrawerId, 'owner'), topicKey: typeof i.topicKey === 'string' ? clip(i.topicKey, 120) : null,
    importance: Math.min(10, Math.max(0, count(i.importance))), layer: clip(i.layer, 20), createdAt: when(i.createdAt), sourceAgentId: idOr(i.sourceAgentId, agentId),
    source: typeof i.source === 'string' && /^[a-z_-]{1,32}$/.test(i.source) ? i.source : null, usedIn: count(i.usedIn),
  };
}
function fact(f) {
  if (!record(f) || !plainId(f.id)) fail();
  return { id: f.id, scope: idOr(f.scope, validRuleScope, 'company'), text: clip(f.text, MAX_PINNED_TEXT), position: count(f.position), createdAt: when(f.createdAt), updatedAt: when(f.updatedAt) };
}
/** Preview effects and apply results: numbers, booleans and short ids only; a sample of agent changes. */
function effects(e) {
  const out = {};
  if (!record(e)) return out;
  for (const [k, v] of Object.entries(e).slice(0, 40)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 80 && !badChars.test(v)) out[k] = v;
    else if (v === null) out[k] = null;
  }
  if (Array.isArray(e.sample)) out.sample = sample(e.sample);
  return out;
}
function sample(x) {
  return list(x, 20).filter(s => record(s) && agentId(s.agentId)).map(s => ({
    agentId: s.agentId, agentName: clip(s.agentName, 120), project: idOr(s.project, slug),
    before: { read: columnList(s.before?.read), write: columnList(s.before?.write) }, after: { read: columnList(s.after?.read), write: columnList(s.after?.write) },
  }));
}
function rule(r) {
  if (!record(r) || !plainId(r.id)) fail();
  return {
    id: r.id, scope: idOr(r.scope, validRuleScope, 'company'), agentId: idOr(r.agentId, agentId), drawerKind: ACCESS_COLUMNS.includes(r.drawerKind) ? r.drawerKind : 'owner',
    read: ACCESS_MODES.includes(r.read) ? r.read : 'inherit', write: ACCESS_MODES.includes(r.write) ? r.write : 'inherit', endsAt: whenOrNull(r.endsAt), expired: r.expired === true, reason: typeof r.reason === 'string' ? clip(r.reason, 200) : null, createdAt: when(r.createdAt),
  };
}
function template(t) {
  if (!record(t) || typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(t.id)) fail();
  return { id: t.id, name: clip(t.name, 80) || t.id, memoryRead: kindList(t.memoryRead), memoryWrite: kindList(t.memoryWrite), scopeRead: scopeList(t.scopeRead), scopeWrite: scopeList(t.scopeWrite), agents: count(t.agents) };
}
const WHY_LAYERS = ['default', 'company', 'department', 'project', 'agent-company', 'agent-department', 'agent-project', 'agent-permissions', 'role-template'];
const why = x => list(x, 20).filter(w => record(w) && WHY_LAYERS.includes(w.layer) && ['allow', 'deny'].includes(w.value)).map(w => ({ layer: w.layer, value: w.value, ...(w.endsAt ? { endsAt: when(w.endsAt) } : {}), ...(typeof w.name === 'string' ? { name: clip(w.name, 80) } : {}) }));
function effective(b, id) {
  if (b.agentId !== id || !record(b.kinds)) fail();
  const k = {};
  for (const d of ACCESS_COLUMNS) { const x = record(b.kinds[d]) ? b.kinds[d] : {}; k[d] = { read: x.read === true, write: x.write === true, readWhy: why(x.readWhy), writeWhy: why(x.writeWhy) }; }
  return {
    agentId: id, agentName: clip(b.agentName, 120) || id, project: idOr(b.project, slug), department: idOr(b.department, departmentId), version: count(b.version),
    template: record(b.template) && typeof b.template.id === 'string' ? { id: clip(b.template.id, 64), name: clip(b.template.name, 80) } : null,
    exceptions: list(b.exceptions, 200).map(rule),
    effective: {
      memoryRead: kindList(b.effective?.memoryRead), memoryWrite: kindList(b.effective?.memoryWrite),
      // Older servers send no scope columns: every agent read them then.
      scopeRead: Array.isArray(b.effective?.scopeRead) ? list(b.effective.scopeRead, 2).filter(x => SCOPE_COLUMNS.includes(x)) : [...SCOPE_COLUMNS],
      scopeWrite: Array.isArray(b.effective?.scopeWrite) ? list(b.effective.scopeWrite, 2).filter(x => SCOPE_COLUMNS.includes(x)) : [...SCOPE_COLUMNS],
    },
    kinds: k,
  };
}
function accessPreview(b) {
  if (!hash(b.previewHash)) fail();
  return {
    previewHash: b.previewHash, version: count(b.version), changes: count(b.changes), agentsAffected: count(b.agentsAffected), projectsAffected: count(b.projectsAffected),
    noProjectAffected: b.noProjectAffected === true, pairsChanged: count(b.pairsChanged), widened: count(b.widened), narrowed: count(b.narrowed),
    agentsTotal: count(b.agentsTotal), projectsTotal: count(b.projectsTotal), sample: sample(b.sample),
  };
}
function doctorCounts(x) { const out = {}; for (const k of DOCTOR_KINDS) out[k] = count(record(x) ? x[k] : 0); return out; }
function doctor(b) {
  if (!hash(b.reportHash)) fail();
  return {
    checkedAt: when(b.checkedAt), embeddingModel: clip(b.embeddingModel, 80), total: count(b.total), counts: doctorCounts(b.counts), reportHash: b.reportHash,
    issues: list(b.issues, 1500).filter(i => record(i) && DOCTOR_KINDS.includes(i.kind)).map(i => ({ kind: i.kind, drawerId: validDrawerId(i.drawerId) ? i.drawerId : '?', memoryIds: list(i.memoryIds, 50).filter(plainId), ...(typeof i.detail === 'string' ? { detail: clip(i.detail, 120) } : {}) })),
  };
}
const ends = e => (record(e) && plainId(e.id) ? { id: e.id, name: clip(e.name, 80), kind: ENTITY_KINDS.includes(e.kind) ? e.kind : 'topic' } : fail());
function entity(e) {
  if (!record(e) || !plainId(e.id)) fail();
  return { id: e.id, kind: ENTITY_KINDS.includes(e.kind) ? e.kind : 'topic', name: clip(e.name, 80), aliases: list(e.aliases, 8).filter(a => typeof a === 'string').map(a => clip(a, 80)), memories: count(e.memories), links: count(e.links), updatedAt: when(e.updatedAt) };
}
function link(l) {
  if (!record(l) || !plainId(l.id) || !LINK_STATUSES.includes(l.status)) fail();
  return { id: l.id, type: clip(l.type, 32), status: l.status, from: ends(l.from), to: ends(l.to), memoryIds: list(l.memoryIds, 50).filter(plainId), createdAt: when(l.createdAt) };
}
const items = x => list(x, MAX_HANDOFF_ITEMS).filter(i => typeof i === 'string').map(i => clip(i, MAX_HANDOFF_ITEM));
function handoff(h) {
  if (!record(h) || !plainId(h.id) || !HANDOFF_KINDS.includes(h.kind)) fail();
  return {
    id: h.id, agentId: idOr(h.agentId, handoffAgent, ''), kind: h.kind, scopeId: idOr(h.scopeId, scopeId, ''), projectId: typeof h.projectId === 'string' ? clip(h.projectId, 128) : null,
    version: count(h.version), source: ['agent', 'model', 'fallback', 'owner'].includes(h.source) ? h.source : 'agent', createdAt: when(h.createdAt),
    done: items(h.done), left: items(h.left), next: items(h.next), questions: items(h.questions),
    ...('title' in h ? { title: typeof h.title === 'string' && h.title.trim() ? clip(h.title, 200) : null } : {}),
  };
}
function exported(b, id) {
  return {
    project: id,
    files: list(b.files, 100).filter(f => record(f) && typeof f.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(f.name) && typeof f.content === 'string')
      .map(f => ({ name: f.name, content: f.content.slice(0, 2_000_000) })),
  };
}

function ownRules(o) {
  const r = record(o) ? o : {};
  return {
    routine: ROUTINE_RULES.includes(r.routine) ? r.routine : null, important: IMPORTANT_RULES.includes(r.important) ? r.important : null,
    contradiction: CONTRADICTION_RULES.includes(r.contradiction) ? r.contradiction : null, reviewerAgentId: idOr(r.reviewerAgentId, agentId),
    weeklyDay: Number.isInteger(r.weeklyDay) && r.weeklyDay >= 0 && r.weeklyDay <= 6 ? r.weeklyDay : null,
    weeklyHour: Number.isInteger(r.weeklyHour) && r.weeklyHour >= 0 && r.weeklyHour <= 23 ? r.weeklyHour : null,
    updatedAt: whenOrNull(r.updatedAt),
  };
}
const fromScope = x => (x === 'default' || validRuleScope(x) ? x : 'default');
function rulesView(b) {
  const e = record(b.effective) ? b.effective : {};
  const f = record(e.from) ? e.from : {};
  const w = record(e.weekly) ? e.weekly : {};
  return {
    scope: idOr(b.scope, validRuleScope, 'company'), own: ownRules(b.own),
    effective: {
      routine: ROUTINE_RULES.includes(e.routine) ? e.routine : 'save', important: IMPORTANT_RULES.includes(e.important) ? e.important : 'ask',
      contradiction: CONTRADICTION_RULES.includes(e.contradiction) ? e.contradiction : 'ask',
      from: { routine: fromScope(f.routine), important: fromScope(f.important), contradiction: fromScope(f.contradiction) },
      reviewerAgentId: idOr(e.reviewerAgentId, agentId),
      weekly: { day: Number.isInteger(w.day) && w.day >= 0 && w.day <= 6 ? w.day : 0, hour: Number.isInteger(w.hour) && w.hour >= 0 && w.hour <= 23 ? w.hour : 9 },
    },
  };
}
const shortEntity = e => ({ id: e.id, kind: ENTITY_KINDS.includes(e.kind) ? e.kind : 'topic', name: clip(e.name, 80) });
function memoryDetail(m) {
  if (!record(m) || !plainId(m.id)) fail();
  const u = record(m.usage) ? m.usage : {};
  const g = record(m.graph) ? m.graph : {};
  const r = record(m.readers) ? m.readers : {};
  return {
    id: m.id, type: clip(m.type, 32), content: clip(m.content, 50000), drawerId: idOr(m.drawerId, validDrawerId, 'owner'), topicKey: typeof m.topicKey === 'string' ? clip(m.topicKey, 120) : null,
    importance: Math.min(10, Math.max(0, count(m.importance))), layer: clip(m.layer, 20), createdAt: when(m.createdAt), sourceAgentId: idOr(m.sourceAgentId, agentId),
    source: typeof m.source === 'string' && /^[a-z_-]{1,32}$/.test(m.source) ? m.source : null,
    usage: { usedIn: count(u.usedIn), lastUsedAt: whenOrNull(u.lastUsedAt), recent: list(u.recent, 20).filter(x => record(x)).map(x => ({ runId: clip(x.runId, 128), sessionId: typeof x.sessionId === 'string' ? clip(x.sessionId, 128) : null, agentId: idOr(x.agentId, agentId), at: when(x.at) })) },
    graph: { entities: list(g.entities, 100).filter(e => record(e) && plainId(e.id)).map(shortEntity), links: list(g.links, 200).map(link) },
    readers: { scope: clip(r.scope, 140), count: count(r.count), total: count(r.total), all: r.all === true, archived: r.archived === true },
  };
}
function cluster(c) {
  if (!record(c) || typeof c.id !== 'string' || !/^[0-9a-f]{32}$/.test(c.id)) fail();
  return {
    id: c.id, drawer: idOr(c.drawer, validDrawerId, 'owner'), name: clip(c.name, 80), suggestedTopicKey: typeof c.suggestedTopicKey === 'string' && topicKey(c.suggestedTopicKey) ? c.suggestedTopicKey : null,
    entities: list(c.entities, 150).filter(e => record(e) && plainId(e.id)).map(e => ({ ...shortEntity(e), memories: count(e.memories) })), memoryIds: list(c.memoryIds, 500).filter(plainId),
  };
}
function topicPreviewView(p) {
  if (!record(p) || !hash(p.previewHash)) fail();
  const b = record(p.blocked) && ['key_taken', 'already_topic', 'nothing_to_change'].includes(p.blocked.code) ? { code: p.blocked.code, ...(plainId(p.blocked.memoryId) ? { memoryId: p.blocked.memoryId } : {}) } : null;
  return {
    cluster: cluster(p.cluster), topicKey: topicKey(p.topicKey) ? p.topicKey : '', target: record(p.target) && plainId(p.target.memoryId) ? { memoryId: p.target.memoryId, preview: clip(p.target.preview, 400) } : null,
    keepKey: list(p.keepKey, 200).filter(k => record(k) && plainId(k.memoryId)).map(k => ({ memoryId: k.memoryId, topicKey: clip(k.topicKey, 120) })),
    related: list(p.related, 500).filter(plainId), blocked: b, previewHash: p.previewHash,
  };
}
function reviewGroup(g) {
  return { key: clip(g.key, 160), count: count(g.count), conflicts: count(g.conflicts), routine: count(g.routine), reviewerAgentId: idOr(g.reviewerAgentId, agentId), proposalIds: list(g.proposalIds, 200).filter(proposalId) };
}
function codingHandoff(h) {
  if (!record(h) || !plainId(h.id)) fail();
  return { id: h.id, projectId: clip(h.projectId, 128), client: BRIDGE_CLIENTS.includes(h.client) ? h.client : 'claude-code', done: items(h.done), left: items(h.left), next: items(h.next), questions: items(h.questions), createdAt: when(h.createdAt) };
}

const CODES = {
  scopes: ['invalid_scope', 'not_found', 'preview_hash_required', 'confirm_required', 'preview_changed', 'name_taken', 'no_change', 'too_many', 'target_archived'],
  doctor: ['confirm_required', 'report_hash_required', 'report_changed', 'invalid_kinds'],
  handoff: ['invalid_handoff', 'not_found'],
  decide: ['already_decided', 'stale', 'review_changed', 'review_hash_required'],
  rules: ['confirm_required', 'invalid_scope', 'not_found', 'no_change'],
  review: ['confirm_required', 'preview_changed', 'invalid_scope'],
  graph: ['not_found', 'confirm_required', 'stale', 'key_taken', 'already_topic', 'nothing_to_change', 'invalid_topic_key'],
};
const family = route => (['doctor', 'doctor-fix'].includes(route) ? 'doctor' : ['handoffs', 'handoff', 'coding-handoffs'].includes(route) ? 'handoff' : route === 'decide' ? 'decide'
  : ['weekly', 'retention', 'cache-clear', 'rules'].includes(route) ? 'rules' : ['review-groups', 'routine-preview', 'routine-accept'].includes(route) ? 'review'
    : route.startsWith('cluster') || route === 'graph-sync' || route === 'agent-view' ? 'graph' : 'scopes');
function retention(c) {
  const n = (x, d) => (Number.isSafeInteger(x) && x > 0 ? x : d);
  return record(c) ? { enabled: c.enabled === true, taskTtlDays: n(c.taskTtlDays, 90), experienceAfterDays: n(c.experienceAfterDays, 180), experienceMinGroup: n(c.experienceMinGroup, 3) } : fail();
}

export function memoryPagesResponse(path, status, body) {
  const p = memoryPagesPath(path);
  if (!p) fail();
  if (status !== 200 && status !== 201) {
    const code = record(body) ? body.code : undefined;
    return CODES[family(p.route)].includes(code) ? { code } : null;
  }
  if (!record(body)) fail();
  switch (p.route) {
    case 'tree': return tree(body);
    case 'search': return { hits: list(body.hits, 50).filter(h => record(h) && ['department', 'project', 'people', 'agent'].includes(h.kind) && plainId(String(h.id ?? '').replace('@', '.'))).map(h => ({ kind: h.kind, id: clip(h.id, 128), name: clip(h.name, 120), ...(h.departmentId ? { departmentId: clip(h.departmentId, 64) } : {}), archived: h.archived === true, memories: count(h.memories) })) };
    case 'agents': return { agents: list(body.agents, 200).filter(a => record(a) && agentId(a.id)).map(a => ({ id: a.id, name: clip(a.name, 120) || a.id, department: typeof a.department === 'string' ? clip(a.department, 64) : null, template: record(a.template) ? { id: clip(a.template.id, 64), name: clip(a.template.name, 80) } : null, exceptions: count(a.exceptions) })), nextCursor: cursor(body.nextCursor) ? body.nextCursor : null };
    case 'memories': {
      if (!Array.isArray(body.items) || body.items.length > 200) fail();
      const f = record(body.facets) ? body.facets : {};
      return { scope: idOr(body.scope, validScope, 'company'), items: body.items.map(explorerItem), nextCursor: cursor(body.nextCursor) ? body.nextCursor : null, total: count(body.total), facets: { type: facet(f.type), layer: facet(f.layer), drawer: facet(f.drawer), source: facet(f.source) } };
    }
    case 'pinned':
      if (status === 201) return { fact: fact(body.fact) };
      return { scope: idOr(body.scope, validRuleScope, 'company'), facts: list(body.facts, 200).map(fact) };
    case 'pinned-fact': return 'fact' in body ? { fact: fact(body.fact) } : { ok: body.ok === true };
    case 'project-preview': case 'project-apply':
      if (!PROJECT_ACTIONS.includes(body.action)) fail();
      return {
        action: body.action, project: project(body.project), ...(record(body.target) ? { target: project(body.target) } : {}),
        ...(record(body.department) && departmentId(body.department.id) ? { department: { id: body.department.id, name: clip(body.department.name, 120) } } : {}),
        effects: effects(body.effects), ...(p.route === 'project-preview' ? (hash(body.previewHash) ? { previewHash: body.previewHash } : fail()) : { result: effects(body.result) }),
      };
    case 'project-export': return exported(body, p.id);
    case 'access': return { version: count(body.version), rules: list(body.rules, 5000).map(rule), templates: list(body.templates, 200).map(template) };
    case 'access-preview': return accessPreview(body);
    case 'access-apply': return { version: count(body.version), preview: accessPreview(record(body.preview) ? body.preview : fail()) };
    case 'effective': return effective(body, p.id);
    case 'doctor': return doctor(body);
    case 'doctor-fix': return { fixed: doctorCounts(body.fixed), skipped: list(body.skipped, 500).filter(s => record(s) && DOCTOR_KINDS.includes(s.kind)).map(s => ({ kind: s.kind, memoryId: idOr(s.memoryId, plainId, ''), reason: clip(s.reason, 80) })), report: doctor(record(body.report) ? body.report : fail()) };
    case 'entities': return { entities: list(body.entities, 500).map(entity) };
    case 'entity': return { entity: entity(body.entity), links: list(body.links, 500).map(link), timeline: list(body.timeline, 1000).filter(t => record(t) && plainId(t.memoryId)).map(t => ({ memoryId: t.memoryId, createdAt: when(t.createdAt), drawer: idOr(t.drawer, validDrawerId, 'owner'), type: clip(t.type, 32), preview: clip(t.preview, 200) })) };
    case 'links': return { links: list(body.links, 500).map(link) };
    case 'link-approve': case 'link-reject': return { link: record(body.link) && plainId(body.link.id) ? { id: body.link.id, status: LINK_STATUSES.includes(body.link.status) ? body.link.status : 'pending' } : fail() };
    case 'handoffs': return { handoffs: list(body.handoffs, 200).map(handoff) };
    case 'handoff':
      if ('history' in body) return { handoff: body.handoff === null ? null : handoff(body.handoff), history: list(body.history, 20).map(handoff) };
      return { handoff: handoff(body.handoff) };
    case 'weekly': {
      // Already projected (the bridge, then the browser): keep it as it is.
      if (record(body.totals) && !('summary' in body)) return { stored: body.stored === true, periodStart: when(body.periodStart), periodEnd: when(body.periodEnd), text: clip(body.text, 4000), totals: { total: count(body.totals.total), created: count(body.totals.created), updated: count(body.totals.updated), deleted: count(body.totals.deleted), forgotten: count(body.totals.forgotten), pending: count(body.totals.pending) } };
      const w = record(body.summary) ? body.summary : {};
      const d = record(w.digest) ? w.digest : {};
      const t = record(d.totals) ? d.totals : {};
      return {
        stored: body.stored === true, periodStart: when(d.periodStart ?? w.periodStart), periodEnd: when(d.periodEnd ?? w.periodEnd),
        text: clip(typeof w.modelText === 'string' && w.modelText ? w.modelText : w.text, 4000),
        totals: { total: count(t.total), created: count(t.created), updated: count(t.updated), deleted: count(t.deleted), forgotten: count(t.forgotten), pending: count(t.pending) },
      };
    }
    case 'retention': // the read carries recent runs; the PUT answers the config only
      return 'runs' in body ? { config: retention(body.config), runs: list(body.runs, 20).filter(record).map(r => ({ at: when(r.createdAt ?? r.at), forgotten: count(r.forgotten), dryRun: r.dryRun === true })) } : { config: retention(body.config) };
    case 'cache-clear': return { cleared: count(body.cleared) };
    case 'decide': {
      if (!CONFLICT_DECISIONS.includes(body.decision) || !record(body.proposal) || !proposalId(body.proposal.id)) fail();
      return { decision: body.decision, proposal: { id: body.proposal.id, status: clip(body.proposal.status, 20) }, applied: body.applied === true || record(body.applied) };
    }    case 'memory-detail': return { memory: memoryDetail(body.memory) };
    case 'rules': return rulesView(body);
    case 'access-agents':
      return {
        scope: idOr(body.scope, validRuleScope, 'company'), column: ACCESS_COLUMNS.includes(body.column) ? body.column : 'owner', mode: body.mode === 'write' ? 'write' : 'read', count: count(body.count), total: count(body.total),
        agents: list(body.agents, 500).filter(a => record(a) && agentId(a.id)).map(a => ({ id: a.id, name: clip(a.name, 120) || a.id, read: a.read === true, write: a.write === true, template: typeof a.template === 'string' ? clip(a.template, 80) : null, exception: a.exception === true })),
        nextCursor: cursor(body.nextCursor) ? body.nextCursor : null,
      };
    case 'access-counts': {
      const map = (x, ok) => { const out = {}; if (record(x)) for (const [k, v] of Object.entries(x).slice(0, 5000)) if (ok(k)) out[k] = count(v); return out; };
      return { column: ACCESS_COLUMNS.includes(body.column) ? body.column : 'project', mode: body.mode === 'write' ? 'write' : 'read', total: count(body.total), company: count(body.company), departments: map(body.departments, departmentId), projects: map(body.projects, slug) };
    }
    case 'template': return { template: template(body.template), agents: list(body.agents, 500).filter(a => record(a) && agentId(a.id)).map(a => ({ id: a.id, name: clip(a.name, 120) || a.id })), nextCursor: cursor(body.nextCursor) ? body.nextCursor : null };
    case 'review-groups': return { by: REVIEW_GROUP_BY.includes(body.by) ? body.by : 'scope', total: count(body.total), groups: list(body.groups, 500).filter(record).map(reviewGroup) };
    case 'routine-preview': {
      if (!hash(body.previewHash)) fail();
      const f = record(body.filter) ? body.filter : {};
      return { filter: { scope: ruleScopeOrDrawer(f.scope) ? f.scope : null, agent: idOr(f.agent, agentId) }, count: count(body.count), items: list(body.items, 1000).filter(i => record(i) && proposalId(i.id)).map(i => ({ id: i.id, drawerId: idOr(i.drawerId, validDrawerId, 'owner'), reviewHash: hash(i.reviewHash) ? i.reviewHash : '' })), previewHash: body.previewHash };
    }
    case 'routine-accept': return { approved: list(body.approved, 1000).filter(proposalId), skipped: list(body.skipped, 1000).filter(s => record(s) && proposalId(s.id)).map(s => ({ id: s.id, code: clip(s.code, 40) })) };
    case 'agent-view':
      if (body.agentId !== p.id) fail();
      return {
        agentId: p.id, agentName: clip(body.agentName, 120) || p.id, project: idOr(body.project, slug), readable: list(body.readable, 10).filter(k => DRAWER_KINDS.includes(k)),
        drawers: list(body.drawers, 200).filter(validDrawerId), entities: list(body.entities, 500).map(entity), links: list(body.links, 500).map(link),
      };
    case 'clusters': return { clusters: list(body.clusters, 150).map(cluster) };
    case 'cluster-topic-preview': return { preview: topicPreviewView(body.preview) };
    case 'cluster-topic': {
      const r = record(body.result) ? body.result : fail();
      return { result: { topicKey: clip(r.topicKey, 120), memoryId: idOr(r.memoryId, plainId, ''), drawer: idOr(r.drawer, validDrawerId, 'owner') } };
    }
    case 'cluster-dismiss': return { id: /^[0-9a-f]{32}$/.test(body.id) ? body.id : p.id, dismissed: body.dismissed === true };
    case 'graph-sync': { const pr = record(body.pruned) ? body.pruned : {}; return { indexed: count(body.indexed), unchanged: count(body.unchanged), pruned: { links: count(pr.links), entities: count(pr.entities) } }; }
    case 'coding-handoffs': return { handoffs: list(body.handoffs, 200).map(codingHandoff) };
  }
  return fail();
}
