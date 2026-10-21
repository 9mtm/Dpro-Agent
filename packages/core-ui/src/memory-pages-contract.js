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
//   GET    /api/memory/scopes/memories?scope=&q=&type=&layer=&topic=&cursor=&limit=
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
//   GET    /api/handoffs?agentId=&kind=&limit=
//   GET    /api/handoffs/:kind/:scopeId?agentId=
//   PUT    /api/handoffs/:kind/:scopeId                  { agentId, done?, left?, next?, questions? }
//   Conflicts (CORE-MEM-CONFLICT)
//   POST   /api/memory/proposals/:id/decide              { decision, expectedReviewHash, note? }

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (x, keys) => Object.keys(x).every(k => keys.includes(k));
// eslint-disable-next-line no-control-regex
const badChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/u;
const text = (x, max) => typeof x === 'string' && !!x.trim() && x.length <= max && !badChars.test(x);
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);

export const DRAWER_KINDS = ['owner', 'project', 'experience', 'task', 'people'];
export const PROJECT_ACTIONS = ['pin', 'unpin', 'archive', 'unarchive', 'move', 'merge', 'forget'];
export const ACCESS_MODES = ['allow', 'deny', 'inherit'];
export const DOCTOR_KINDS = ['duplicate', 'expired', 'embedding-missing', 'embedding-stale', 'orphan-versions', 'broken-drawer', 'topic-key-invalid'];
export const ENTITY_KINDS = ['person', 'project', 'place', 'topic', 'agent', 'task', 'decision'];
export const LINK_STATUSES = ['active', 'pending', 'rejected'];
export const HANDOFF_KINDS = ['conversation', 'task'];
export const CONFLICT_DECISIONS = ['keep_new', 'keep_old', 'keep_both'];
export const MAX_PINNED_TEXT = 1000;
export const MAX_HANDOFF_ITEMS = 8;
export const MAX_HANDOFF_ITEM = 300;

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
export function validDrawerId(x) {
  return typeof x === 'string' && (x === 'owner' || x === 'experience' || /^project:[a-z0-9][a-z0-9_-]{0,63}$/.test(x)
    || (/^(task|people):[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(x) && !x.includes('..')));
}
/** A scope of the explorer: company, department:<id>, agent:<id> or a drawer id. */
export function validScope(x) {
  return x === 'company' || validDrawerId(x) || (typeof x === 'string' && ((x.startsWith('department:') && departmentId(x.slice(11))) || (x.startsWith('agent:') && agentId(x.slice(6)))));
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
  memories: { scope: validScope, q: queryText(200), type: word, layer: word, topic: x => x === 'has' || x === 'none', cursor, limit: limit(200) },
  pinned: { scope: validRuleScope },
  effective: { project: slug },
  entities: { q: queryText(200), kind: x => ENTITY_KINDS.includes(x), limit: limit(500) },
  links: { status: x => LINK_STATUSES.includes(x), limit: limit(500) },
  handoffs: { agentId: handoffAgent, kind: x => HANDOFF_KINDS.includes(x), limit: limit(200) },
  handoff: { agentId: handoffAgent },
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
  }
  if ((m = /^\/api\/memory\/scopes\/pinned\/([^/]+)$/.exec(base)) && plainId(m[1])) return with_('pinned-fact', null, { id: m[1] });
  if ((m = /^\/api\/memory\/scopes\/projects\/([^/]+)\/(preview|apply|export)$/.exec(base)) && slug(m[1])) return with_(`project-${m[2]}`, null, { id: m[1] });
  if ((m = /^\/api\/memory\/access\/effective\/([^/]+)$/.exec(base)) && agentId(m[1])) return with_('effective', QUERIES.effective, { id: m[1] });
  if ((m = /^\/api\/memory\/graph\/entities\/([^/]+)$/.exec(base)) && plainId(m[1])) return with_('entity', null, { id: m[1] });
  if ((m = /^\/api\/memory\/graph\/links\/([^/]+)\/(approve|reject)$/.exec(base)) && plainId(m[1])) return with_(`link-${m[2]}`, null, { id: m[1] });
  if ((m = /^\/api\/handoffs\/(conversation|task)\/([^/]+)$/.exec(base)) && scopeId(m[2])) return with_('handoff', QUERIES.handoff, { id: m[2], kind: m[1] });
  if ((m = /^\/api\/memory\/proposals\/([^/]+)\/decide$/.exec(base)) && proposalId(m[1])) return with_('decide', null, { id: m[1] });
  return null;
}

export function memoryPagesRoute(path) { return memoryPagesPath(path) !== null; }

const kinds = x => Array.isArray(x) && x.length <= DRAWER_KINDS.length && x.every(k => DRAWER_KINDS.includes(k)) && new Set(x).size === x.length;
function accessChange(c) {
  if (!record(c)) return false;
  const agent = c.agentId === undefined || c.agentId === null || agentId(c.agentId);
  switch (c.op) {
    case 'set_rule':
      return onlyKeys(c, ['op', 'scope', 'agentId', 'drawerKind', 'read', 'write', 'endsAt', 'reason']) && agent && validRuleScope(c.scope) && DRAWER_KINDS.includes(c.drawerKind)
        && (c.read === undefined || ACCESS_MODES.includes(c.read)) && (c.write === undefined || ACCESS_MODES.includes(c.write))
        && (c.endsAt === undefined || c.endsAt === null || (typeof c.endsAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(c.endsAt) && !!c.agentId))
        && (c.reason === undefined || c.reason === null || text(c.reason, 200));
    case 'clear_rule': return onlyKeys(c, ['op', 'scope', 'agentId', 'drawerKind']) && agent && validRuleScope(c.scope) && DRAWER_KINDS.includes(c.drawerKind);
    case 'save_template':
      return onlyKeys(c, ['op', 'id', 'name', 'memoryRead', 'memoryWrite']) && (c.id === undefined || c.id === null || (typeof c.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.id)))
        && text(c.name, 80) && kinds(c.memoryRead) && kinds(c.memoryWrite) && c.memoryWrite.every(k => c.memoryRead.includes(k));
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
    case 'tree': case 'search': case 'agents': case 'memories': case 'access': case 'effective': case 'doctor': case 'entities': case 'entity': case 'links': case 'handoffs': case 'project-export':
      return get;
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
  }
  return false;
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
    before: { read: kindList(s.before?.read), write: kindList(s.before?.write) }, after: { read: kindList(s.after?.read), write: kindList(s.after?.write) },
  }));
}
function rule(r) {
  if (!record(r) || !plainId(r.id)) fail();
  return {
    id: r.id, scope: idOr(r.scope, validRuleScope, 'company'), agentId: idOr(r.agentId, agentId), drawerKind: DRAWER_KINDS.includes(r.drawerKind) ? r.drawerKind : 'owner',
    read: ACCESS_MODES.includes(r.read) ? r.read : 'inherit', write: ACCESS_MODES.includes(r.write) ? r.write : 'inherit', endsAt: whenOrNull(r.endsAt), expired: r.expired === true, reason: typeof r.reason === 'string' ? clip(r.reason, 200) : null, createdAt: when(r.createdAt),
  };
}
function template(t) {
  if (!record(t) || typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(t.id)) fail();
  return { id: t.id, name: clip(t.name, 80) || t.id, memoryRead: kindList(t.memoryRead), memoryWrite: kindList(t.memoryWrite), agents: count(t.agents) };
}
const WHY_LAYERS = ['default', 'company', 'department', 'project', 'agent-company', 'agent-department', 'agent-project', 'agent-permissions', 'role-template'];
const why = x => list(x, 20).filter(w => record(w) && WHY_LAYERS.includes(w.layer) && ['allow', 'deny'].includes(w.value)).map(w => ({ layer: w.layer, value: w.value, ...(w.endsAt ? { endsAt: when(w.endsAt) } : {}), ...(typeof w.name === 'string' ? { name: clip(w.name, 80) } : {}) }));
function effective(b, id) {
  if (b.agentId !== id || !record(b.kinds)) fail();
  const k = {};
  for (const d of DRAWER_KINDS) { const x = record(b.kinds[d]) ? b.kinds[d] : {}; k[d] = { read: x.read === true, write: x.write === true, readWhy: why(x.readWhy), writeWhy: why(x.writeWhy) }; }
  return {
    agentId: id, agentName: clip(b.agentName, 120) || id, project: idOr(b.project, slug), department: idOr(b.department, departmentId), version: count(b.version),
    template: record(b.template) && typeof b.template.id === 'string' ? { id: clip(b.template.id, 64), name: clip(b.template.name, 80) } : null,
    exceptions: list(b.exceptions, 200).map(rule),
    effective: { memoryRead: kindList(b.effective?.memoryRead), memoryWrite: kindList(b.effective?.memoryWrite) }, kinds: k,
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
  };
}
function exported(b, id) {
  return {
    project: id,
    files: list(b.files, 100).filter(f => record(f) && typeof f.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(f.name) && typeof f.content === 'string')
      .map(f => ({ name: f.name, content: f.content.slice(0, 2_000_000) })),
  };
}

const CODES = {
  scopes: ['invalid_scope', 'not_found', 'preview_hash_required', 'confirm_required', 'preview_changed', 'name_taken', 'no_change', 'too_many', 'target_archived'],
  doctor: ['confirm_required', 'report_hash_required', 'report_changed', 'invalid_kinds'],
  handoff: ['invalid_handoff', 'not_found'],
  decide: ['already_decided', 'stale', 'review_changed', 'review_hash_required'],
};
const family = route => (['doctor', 'doctor-fix'].includes(route) ? 'doctor' : ['handoffs', 'handoff'].includes(route) ? 'handoff' : route === 'decide' ? 'decide' : 'scopes');

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
      return { scope: idOr(body.scope, validScope, 'company'), items: body.items.map(explorerItem), nextCursor: cursor(body.nextCursor) ? body.nextCursor : null, total: count(body.total), facets: { type: facet(f.type), layer: facet(f.layer), drawer: facet(f.drawer) } };
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
    case 'decide': {
      if (!CONFLICT_DECISIONS.includes(body.decision) || !record(body.proposal) || !proposalId(body.proposal.id)) fail();
      return { decision: body.decision, proposal: { id: body.proposal.id, status: clip(body.proposal.status, 20) }, applied: record(body.applied) };
    }
  }
  return fail();
}
