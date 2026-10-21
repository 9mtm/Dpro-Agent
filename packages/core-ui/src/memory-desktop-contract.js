// Wire contract for the desktop Memory window (boards M21–M36): Trash and
// restore, groups of projects, a project's design and databases. Owner only.
// Requests are checked before they leave; responses keep reviewed fields only
// and are stable when applied twice. A 404 means "not available yet".

const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const onlyKeys = (o, keys) => Object.keys(o).every(k => keys.includes(k));
const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : null);
const n = x => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
const memoryId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const slug = x => typeof x === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(x);
const groupId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(x);
const name = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x);
const filePath = x => typeof x === 'string' && x.length > 0 && x.length <= 1024 && !x.includes('\0') && !x.split(/[\\/]/).includes('..');

export const TRASH_DAYS = [0, 7, 30, 90];
export const DATABASE_LEVELS = ['exists', 'tables', 'data'];
export const DATABASE_KINDS = ['sqlite', 'mysql', 'postgres', 'other'];
export const MAX_GROUP_PROJECTS = 200;
export const MAX_TRASH_IDS = 500;

/** Which route a path is, with its id, or null. */
export function memoryDesktopPath(path) {
  if (typeof path !== 'string' || path.length > 512 || path.includes('?') || path.includes('#')) return null;
  let m;
  if (path === '/api/memory/trash') return { route: 'trash' };
  if (path === '/api/memory/trash/empty') return { route: 'trash-empty' };
  if (path === '/api/memory/groups') return { route: 'groups' };
  if ((m = /^\/api\/memory\/([^/]+)\/restore$/.exec(path)) && memoryId(m[1])) return { route: 'restore', id: m[1] };
  if ((m = /^\/api\/memory\/groups\/([^/]+)$/.exec(path)) && groupId(m[1])) return { route: 'group', id: m[1] };
  if ((m = /^\/api\/memory\/groups\/([^/]+)\/projects$/.exec(path)) && groupId(m[1])) return { route: 'group-projects', id: m[1] };
  if ((m = /^\/api\/memory\/projects\/([^/]+)\/(design|databases)$/.exec(path)) && slug(m[1])) return { route: m[2], id: m[1] };
  if ((m = /^\/api\/memory\/scopes\/projects\/([^/]+)\/(trash|restore)$/.exec(path)) && slug(m[1])) return { route: `project-${m[2]}`, id: m[1] };
  return null;
}
export function memoryDesktopRoute(path) { return memoryDesktopPath(path) !== null; }

const trashId = x => memoryId(x) || (typeof x === 'string' && x.startsWith('project:') && slug(x.slice(8)));
export function allowedMemoryDesktop(method, path, body) {
  const p = memoryDesktopPath(path);
  if (!p) return false;
  const get = method === 'GET' && body === undefined;
  switch (p.route) {
    case 'trash': return get;
    case 'trash-empty':
      return method === 'POST' && record(body) && onlyKeys(body, ['confirm', 'ids']) && body.confirm === 'EMPTY'
        && (body.ids === undefined || (Array.isArray(body.ids) && body.ids.length > 0 && body.ids.length <= MAX_TRASH_IDS && body.ids.every(trashId) && new Set(body.ids).size === body.ids.length));
    case 'restore': case 'project-trash': case 'project-restore': return method === 'POST' && body === undefined;
    case 'groups':
      return get || (method === 'POST' && record(body) && onlyKeys(body, ['name', 'label', 'shareWithin', 'projects']) && name(body.name, 80)
        && (body.label === undefined || body.label === null || name(body.label, 40)) && (body.shareWithin === undefined || typeof body.shareWithin === 'boolean')
        && (body.projects === undefined || (Array.isArray(body.projects) && body.projects.length <= MAX_GROUP_PROJECTS && body.projects.every(slug) && new Set(body.projects).size === body.projects.length)));
    case 'group':
      return (method === 'DELETE' && body === undefined) || (method === 'PATCH' && record(body) && Object.keys(body).length > 0 && onlyKeys(body, ['name', 'label', 'shareWithin'])
        && (body.name === undefined || name(body.name, 80)) && (body.label === undefined || body.label === null || name(body.label, 40)) && (body.shareWithin === undefined || typeof body.shareWithin === 'boolean'));
    case 'group-projects':
      return method === 'PUT' && record(body) && onlyKeys(body, ['projects']) && Array.isArray(body.projects) && body.projects.length <= MAX_GROUP_PROJECTS && body.projects.every(slug) && new Set(body.projects).size === body.projects.length;
    case 'design':
      return get || (method === 'PATCH' && record(body) && Object.keys(body).length > 0 && onlyKeys(body, ['mainLogo', 'notLogo'])
        && (body.mainLogo === undefined || body.mainLogo === null || filePath(body.mainLogo)) && (body.notLogo === undefined || filePath(body.notLogo)));
    case 'databases':
      return get || (method === 'PATCH' && record(body) && Object.keys(body).sort().join(',') === 'databaseId,level' && groupId(body.databaseId) && DATABASE_LEVELS.includes(body.level));
  }
  return false;
}

const CODES = { 400: ['invalid_input', 'confirm_required'], 403: ['forbidden'], 404: ['not_found'], 409: ['name_taken', 'not_in_trash', 'restore_conflict', 'in_other_group'] };
const when = x => str(x, 40);
function trashItem(x) {
  if (!record(x) || !trashId(x.id)) return null;
  const kind = x.kind === 'project' ? 'project' : 'memory';
  return { id: x.id, kind, text: str(x.text, 2000) ?? '', drawer: str(x.drawer, 200) ?? '', project: str(x.project, 64), deletedAt: when(x.deletedAt) ?? '', deletedBy: str(x.deletedBy, 120) ?? '',
    forgetAt: when(x.forgetAt), versions: n(x.versions), count: n(x.count) };
}
function group(x) {
  if (!record(x) || !groupId(x.id)) return null;
  return { id: x.id, name: str(x.name, 80) ?? '', label: str(x.label, 40), shareWithin: x.shareWithin === true, projects: Array.isArray(x.projects) ? x.projects.filter(slug).slice(0, MAX_GROUP_PROJECTS) : [] };
}
const colour = x => (record(x) && typeof x.value === 'string' && /^#[0-9a-fA-F]{3,8}$|^(rgb|hsl)a?\([0-9., %]{1,40}\)$/.test(x.value) ? { name: str(x.name, 80) ?? '', value: x.value, role: str(x.role, 40) } : null);
const logo = x => (record(x) && filePath(x.path) ? { path: x.path, kind: str(x.kind, 20) ?? 'image', main: x.main === true, size: n(x.size) } : null);
function design(b) {
  return {
    colours: (Array.isArray(b.colours) ? b.colours : []).slice(0, 60).map(colour).filter(Boolean),
    fonts: (Array.isArray(b.fonts) ? b.fonts : []).slice(0, 20).filter(record).map(f => ({ name: str(f.name, 80) ?? '', use: str(f.use, 80) ?? '' })),
    logos: (Array.isArray(b.logos) ? b.logos : []).slice(0, 40).map(logo).filter(Boolean),
    rules: (Array.isArray(b.rules) ? b.rules : []).slice(0, 40).filter(r => typeof r === 'string').map(r => r.slice(0, 300)),
    sources: (Array.isArray(b.sources) ? b.sources : []).slice(0, 40).filter(filePath),
    designFile: b.designFile === true,
  };
}
function database(x) {
  if (!record(x) || !groupId(x.id)) return null;
  return { id: x.id, name: str(x.name, 120) ?? '', kind: DATABASE_KINDS.includes(x.kind) ? x.kind : 'other', from: str(x.from, 300) ?? '', where: str(x.where, 1024) ?? '', size: n(x.size),
    tables: Array.isArray(x.tables) ? x.tables.filter(t => typeof t === 'string').slice(0, 200).map(t => t.slice(0, 120)) : [], tableCount: n(x.tableCount), level: DATABASE_LEVELS.includes(x.level) ? x.level : 'exists' };
}
const also = x => (record(x) ? { mcp: n(x.mcp), skills: n(x.skills), ssh: n(x.ssh) } : { mcp: 0, skills: 0, ssh: 0 });

export function memoryDesktopResponse(path, status, body) {
  const p = memoryDesktopPath(path);
  if (!p) throw Error('protocol');
  if (status !== 200 && status !== 201) { const code = record(body) ? body.code : undefined; return (CODES[status] ?? []).includes(code) ? { code } : null; }
  if (!record(body)) throw Error('protocol');
  switch (p.route) {
    case 'trash':
      if (!Array.isArray(body.items)) throw Error('protocol');
      return { items: body.items.slice(0, 5000).map(trashItem).filter(Boolean), trashDays: TRASH_DAYS.includes(body.trashDays) ? body.trashDays : 30 };
    case 'trash-empty': return { forgotten: n(body.forgotten) };
    case 'restore': return { id: p.id, restored: body.restored !== false, drawer: str(body.drawer, 200) };
    case 'project-trash': return { project: p.id, moved: n(body.moved) };
    case 'project-restore': return { project: p.id, restored: n(body.restored) };
    case 'groups':
      if (record(body.group)) { const g = group(body.group); if (!g) throw Error('protocol'); return { group: g }; }
      if (!Array.isArray(body.groups)) throw Error('protocol');
      return { groups: body.groups.slice(0, 500).map(group).filter(Boolean) };
    case 'group': case 'group-projects': {
      if (body.deleted === true) return { id: p.id, deleted: true };
      const g = group(body.group); if (!g || g.id !== p.id) throw Error('protocol'); return { group: g };
    }
    case 'design': return { project: p.id, ...design(body) };
    case 'databases':
      if (record(body.database)) { const d = database(body.database); if (!d) throw Error('protocol'); return { database: d }; }
      return { project: p.id, databases: (Array.isArray(body.databases) ? body.databases : []).slice(0, 100).map(database).filter(Boolean), also: also(body.also) };
  }
  throw Error('protocol');
}
