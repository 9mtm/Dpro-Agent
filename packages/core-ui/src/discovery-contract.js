// Wire contract for "Found on this computer" (DISCOVER-01, board M17), shared by
// the browser client and the local bridge. Owner only, this computer only.
// Responses keep reviewed fields only and are stable when applied twice.

const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : null);
const n = x => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
export const DISCOVERY_PATH = '/api/memory/import/discovery';
export const DISCOVERY_KINDS = ['memory', 'note', 'tool', 'skill', 'mcp', 'ssh', 'design', 'database'];
export const FILE_KINDS = ['notes', 'tools', 'skills', 'mcp', 'ssh'];
export const DISCOVERY_STATES = ['new', 'changed', 'decision', 'imported', 'ignored', 'gone'];
export const MAX_DISCOVERY_IMPORT = 100;

export function discoveryPath(full) {
  const [path, query = ''] = String(full).split('?');
  if (path === DISCOVERY_PATH + '/places') {
    if (!query) return { kind: 'places' };
    const m = /^parent=([a-f0-9]{32})$/.exec(query);
    return m ? { kind: 'places', id: m[1] } : null;
  }
  if (query) return null;
  if (path === DISCOVERY_PATH + '/kinds') return { kind: 'kinds' };
  if (path === DISCOVERY_PATH + '/groups') return { kind: 'groups' };
  const count = /^\/api\/memory\/import\/discovery\/places\/([a-f0-9]{32})\/count$/.exec(path);
  if (count) return { kind: 'count', id: count[1] };
  const hidden = /^\/api\/memory\/import\/discovery\/roots\/([a-f0-9]{32}|computer)\/hidden$/.exec(path);
  if (hidden) return { kind: 'hidden', id: hidden[1] };
  const group = /^\/api\/memory\/import\/discovery\/groups\/([a-f0-9]{32})$/.exec(path);
  if (group) return { kind: 'group', id: group[1] };
  const dismiss = /^\/api\/memory\/import\/discovery\/suggestions\/([a-f0-9]{32})\/dismiss$/.exec(path);
  if (dismiss) return { kind: 'dismiss', id: dismiss[1] };
  if (path === DISCOVERY_PATH) return { kind: 'list' };
  if (path === DISCOVERY_PATH + '/scan') return { kind: 'scan' };
  if (path === DISCOVERY_PATH + '/settings') return { kind: 'settings' };
  if (path === DISCOVERY_PATH + '/import') return { kind: 'import' };
  const root = /^\/api\/memory\/import\/discovery\/roots\/([^/?#]+)$/.exec(path);
  if (root) return ID.test(root[1]) || root[1] === 'computer' ? { kind: 'root', id: root[1] } : null;
  const item = /^\/api\/memory\/import\/discovery\/items\/([^/?#]+)(?:\/(ignore|remove|keep))?$/.exec(path);
  if (item) return ID.test(item[1]) ? { kind: item[2] ?? 'item', id: item[1] } : null;
  return null;
}
export function discoveryRoute(path) { return discoveryPath(path) !== null; }

export function allowedDiscovery(method, path, body) {
  const p = discoveryPath(path);
  if (!p) return false;
  const ids = x => Array.isArray(x) && x.length <= 200 && x.every(i => typeof i === 'string' && ID.test(i));
  if (p.kind === 'places') {
    if (method === 'GET') return body === undefined;
    if (p.id) return false;
    if (method === 'PUT') return record(body) && Object.keys(body).length > 0 && Object.keys(body).every(k => ['allow', 'deny', 'exclude'].includes(k)) && Object.values(body).every(ids);
    return method === 'POST' && record(body) && Object.keys(body).join(',') === 'path' && typeof body.path === 'string' && body.path.length <= 2048 && !body.path.includes('\0');
  }
  if (p.kind === 'count' || p.kind === 'dismiss') return method === 'POST' && body === undefined;
  if (p.kind === 'kinds') return method === 'PUT' && record(body) && Object.keys(body).length > 0 && Object.keys(body).every(k => FILE_KINDS.includes(k)) && Object.values(body).every(v => typeof v === 'boolean');
  if (p.kind === 'hidden') return method === 'PUT' && record(body) && Object.keys(body).sort().join(',') === 'kind,on' && DISCOVERY_KINDS.includes(body.kind) && typeof body.on === 'boolean';
  if (p.kind === 'groups') return method === 'POST' && record(body) && Object.keys(body).sort().join(',') === 'name,roots' && typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 80 && Array.isArray(body.roots) && body.roots.length >= 2 && body.roots.length <= 20 && body.roots.every(i => typeof i === 'string' && ID.test(i));
  if (p.kind === 'group') return method === 'DELETE' && body === undefined;
  if (p.kind === 'list' || p.kind === 'item') return method === 'GET' && body === undefined;
  if (p.kind === 'scan' || p.kind === 'remove' || p.kind === 'keep') return method === 'POST' && body === undefined;
  if (p.kind === 'settings') return method === 'PUT' && record(body) && Object.keys(body).sort().join(',') === 'intervalMinutes,watch' && typeof body.watch === 'boolean' && [15, 30, 60].includes(body.intervalMinutes);
  if (p.kind === 'root') return method === 'PUT' && record(body) && Object.keys(body).join(',') === 'watch' && typeof body.watch === 'boolean';
  if (p.kind === 'ignore') return method === 'POST' && record(body) && Object.keys(body).join(',') === 'on' && typeof body.on === 'boolean';
  return method === 'POST' && record(body) && Object.keys(body).join(',') === 'items' && Array.isArray(body.items) && body.items.length >= 1 && body.items.length <= MAX_DISCOVERY_IMPORT
    && body.items.every(i => record(i) && Object.keys(i).every(k => ['id', 'previewHash', 'secret'].includes(k)) && ID.test(i.id) && HASH.test(i.previewHash) && (i.secret === undefined || i.secret === 'credentials' || i.secret === 'leave'))
    && new Set(body.items.map(i => i.id)).size === body.items.length;
}

const CODES = { 400: ['invalid_input', 'system_folder'], 403: ['not_loopback', 'forbidden'], 404: ['not_found'], 409: ['preview_changed', 'not_imported', 'not_removable', 'skill_in_use', 'skill_name_taken'] };
const kinds = k => (record(k) ? Object.fromEntries(FILE_KINDS.map(n => [n, k[n] !== false])) : Object.fromEntries(FILE_KINDS.map(n => [n, true])));
const settings = s => (record(s) && typeof s.watch === 'boolean' && [15, 30, 60].includes(s.intervalMinutes) ? { watch: s.watch, intervalMinutes: s.intervalMinutes, kinds: kinds(s.kinds) } : null);
const PLACE_STATES = ['allow', 'exclude'];
function place(x) {
  if (!record(x) || typeof x.id !== 'string' || !ID.test(x.id)) return null;
  return { id: x.id, name: str(x.name, 200) ?? '', path: str(x.path, 2048) ?? '', kind: ['home', 'drive', 'folder', 'added'].includes(x.kind) ? x.kind : 'folder', state: PLACE_STATES.includes(x.state) ? x.state : null, inherited: PLACE_STATES.includes(x.inherited) ? x.inherited : null, hasChildren: x.hasChildren === true };
}
const named = x => (record(x) && typeof x.id === 'string' && (ID.test(x.id) || x.id === 'computer') ? { id: x.id, name: str(x.name, 200) ?? '' } : null);
function item(x) {
  if (!record(x) || !ID.test(x.id) || !DISCOVERY_KINDS.includes(x.kind) || !DISCOVERY_STATES.includes(x.state)) return null;
  return { id: x.id, kind: x.kind, name: str(x.name, 200) ?? '', from: str(x.from, 300) ?? '', rootId: typeof x.rootId === 'string' && (ID.test(x.rootId) || x.rootId === 'computer') ? x.rootId : null, to: str(x.to, 200) ?? '', state: x.state, updatedAt: str(x.updatedAt, 40) ?? '' };
}
function root(x) {
  if (!record(x) || typeof x.id !== 'string' || !(ID.test(x.id) || x.id === 'computer')) return null;
  const members = record(x.group) && Array.isArray(x.group.members) ? x.group.members.slice(0, 20).filter(m => record(m) && typeof m.id === 'string' && ID.test(m.id)).map(m => ({ id: m.id, name: str(m.name, 200) ?? '', path: str(m.path, 1024) ?? '' })) : null;
  return { id: x.id, name: str(x.name, 200) ?? '', path: str(x.path, 2048), project: str(x.project, 200), count: n(x.count), fresh: n(x.fresh), watch: x.watch !== false,
    ...(members ? { group: { members } } : {}), ...(Array.isArray(x.hidden) ? { hidden: x.hidden.filter(k => DISCOVERY_KINDS.includes(k)) } : {}) };
}
const view = b => {
  const s = settings(b.settings);
  if (!s || !Array.isArray(b.items) || !Array.isArray(b.roots)) throw Error('protocol');
  const suggestions = Array.isArray(b.suggestions) ? b.suggestions.slice(0, 20).filter(x => record(x) && typeof x.key === 'string' && ID.test(x.key) && named(x.a) && named(x.b)).map(x => ({ key: x.key, a: named(x.a), b: named(x.b), reason: str(x.reason, 100) ?? '' })) : [];
  return { scannedAt: str(b.scannedAt, 40), ms: n(b.ms), leftOut: n(b.leftOut), allowedFolders: n(b.allowedFolders), suggestions, settings: s, roots: b.roots.slice(0, 1000).map(root).filter(Boolean), items: b.items.slice(0, 5000).map(item).filter(Boolean) };
};

export function discoveryResponse(path, status, body) {
  const p = discoveryPath(path);
  if (!p) throw Error('protocol');
  if (status !== 200) { const code = record(body) ? body.code : undefined; return (CODES[status] ?? []).includes(code) ? { code } : null; }
  if (!record(body)) throw Error('protocol');
  if (p.kind === 'list' || p.kind === 'scan') return view(body);
  if (p.kind === 'places') {
    if (Array.isArray(body.places)) return { places: body.places.slice(0, 1000).map(place).filter(Boolean) };
    if (record(body.place)) { const x = place(body.place); if (!x) throw Error('protocol'); return { place: x }; }
    return { allowed: n(body.allowed), removed: n(body.removed), excluded: n(body.excluded) };
  }
  if (p.kind === 'count') { if (body.id !== p.id) throw Error('protocol'); return { id: p.id, files: n(body.files), bytes: n(body.bytes), capped: body.capped === true }; }
  if (p.kind === 'kinds') return { kinds: kinds(body.kinds) };
  if (p.kind === 'hidden') { if (body.id !== p.id || !DISCOVERY_KINDS.includes(body.kind) || typeof body.hidden !== 'boolean') throw Error('protocol'); return { id: p.id, kind: body.kind, hidden: body.hidden }; }
  if (p.kind === 'groups') { const g = body.group; if (!record(g) || typeof g.id !== 'string' || !ID.test(g.id)) throw Error('protocol'); return { group: { id: g.id, name: str(g.name, 80) ?? '', slug: str(g.slug, 60) ?? '', folders: n(g.folders) } }; }
  if (p.kind === 'group') { if (body.id !== p.id) throw Error('protocol'); return { id: p.id, separated: body.separated === true }; }
  if (p.kind === 'dismiss') { if (body.key !== p.id) throw Error('protocol'); return { key: p.id, dismissed: body.dismissed === true }; }
  if (p.kind === 'settings') { const s = settings(body.settings); if (!s) throw Error('protocol'); return { settings: s }; }
  if (p.kind === 'root') { if (body.id !== p.id || typeof body.watch !== 'boolean') throw Error('protocol'); return { id: p.id, watch: body.watch }; }
  if (p.kind === 'ignore') { if (body.id !== p.id || typeof body.ignored !== 'boolean') throw Error('protocol'); return { id: p.id, ignored: body.ignored }; }
  if (p.kind === 'remove') { if (body.id !== p.id) throw Error('protocol'); return { id: p.id, removed: body.removed === true }; }
  if (p.kind === 'keep') { if (body.id !== p.id) throw Error('protocol'); return { id: p.id, kept: body.kept === true }; }
  if (p.kind === 'item') {
    const i = body.item;
    if (!record(i) || i.id !== p.id || !DISCOVERY_KINDS.includes(i.kind) || !DISCOVERY_STATES.includes(i.state) || typeof i.previewHash !== 'string' || !HASH.test(i.previewHash) || typeof i.text !== 'string' || i.text.length > 20000) throw Error('protocol');
    return { item: { id: p.id, kind: i.kind, name: str(i.name, 200) ?? '', from: str(i.from, 300) ?? '', to: str(i.to, 200) ?? '', state: i.state, text: i.text, truncated: i.truncated === true,
      secrets: Array.isArray(i.secrets) ? i.secrets.filter(s => typeof s === 'string').slice(0, 50).map(s => s.slice(0, 100)) : [], blocked: str(i.blocked, 100), previewHash: i.previewHash } };
  }
  if (!Array.isArray(body.results) || body.results.length > MAX_DISCOVERY_IMPORT) throw Error('protocol');
  return { results: body.results.filter(r => record(r) && ID.test(r.id)).map(r => ({ id: r.id, ok: r.ok === true, ...(DISCOVERY_STATES.includes(r.state) ? { state: r.state } : {}), ...(typeof r.code === 'string' ? { code: r.code.slice(0, 60) } : {}), ...(typeof r.jobId === 'string' ? { jobId: r.jobId.slice(0, 40) } : {}) })) };
}
