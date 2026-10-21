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
const colourValue = x => typeof x === 'string' && /^#[0-9a-fA-F]{3,8}$|^(rgb|hsl)a?\([0-9., %]{1,40}\)$/.test(x);
const agentId = x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(x);

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
  if (path === '/api/memory/projects/design-conflicts') return { route: 'design-conflicts' };
  if ((m = /^\/api\/memory\/projects\/([^/]+)\/(design|databases)$/.exec(path)) && slug(m[1])) return { route: m[2], id: m[1] };
  if ((m = /^\/api\/memory\/projects\/([^/]+)\/design\/undo$/.exec(path)) && slug(m[1])) return { route: 'design-undo', id: m[1] };
  if ((m = /^\/api\/memory\/trash\/projects\/([^/]+)$/.exec(path)) && slug(m[1])) return { route: 'project-trash', id: m[1] };
  if ((m = /^\/api\/memory\/trash\/projects\/([^/]+)\/restore$/.exec(path)) && slug(m[1])) return { route: 'project-restore', id: m[1] };
  return null;
}
export function memoryDesktopRoute(path) { return memoryDesktopPath(path) !== null; }

const list = (x, ok) => Array.isArray(x) && x.length > 0 && x.length <= MAX_TRASH_IDS && x.every(ok) && new Set(x).size === x.length;
export function allowedMemoryDesktop(method, path, body) {
  const p = memoryDesktopPath(path);
  if (!p) return false;
  const get = method === 'GET' && body === undefined;
  switch (p.route) {
    case 'trash': return get;
    case 'trash-empty':
      // Neither ids nor projects = everything in the Trash.
      return method === 'POST' && record(body) && onlyKeys(body, ['confirm', 'ids', 'projects']) && body.confirm === 'EMPTY'
        && (body.ids === undefined || list(body.ids, memoryId)) && (body.projects === undefined || list(body.projects, slug));
    case 'restore': case 'project-trash': case 'project-restore': case 'design-undo': return method === 'POST' && body === undefined;
    case 'design-conflicts': return get;
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
      // A logo is named by its id or its shown path; mainLogo null = Dpro picks; mainColour = one of the found colours.
      return get || (method === 'PATCH' && record(body) && Object.keys(body).length > 0 && onlyKeys(body, ['mainLogo', 'notLogo', 'mainColour', 'writeFile'])
        && (body.mainLogo === undefined || body.mainLogo === null || filePath(body.mainLogo)) && (body.notLogo === undefined || filePath(body.notLogo))
        && (body.mainColour === undefined || colourValue(body.mainColour)) && (body.writeFile === undefined || typeof body.writeFile === 'boolean'));
    case 'databases':
      // What one agent may do with this project's databases (null = back to the default, exists).
      return get || (method === 'PATCH' && record(body) && Object.keys(body).sort().join(',') === 'agentId,level' && agentId(body.agentId) && (body.level === null || DATABASE_LEVELS.includes(body.level)));
  }
  return false;
}

const CODES = { 400: ['invalid_input', 'confirm_required'], 403: ['forbidden'], 404: ['not_found'], 409: ['name_taken', 'not_in_trash', 'nothing_to_restore', 'no_change', 'too_many', 'in_other_group'] };
const when = x => str(x, 40);
function trashItem(x) {
  if (!record(x) || !memoryId(x.id) || x.withProject === true) return null; // memories trashed with their project show as the project's row
  return { id: x.id, kind: 'memory', text: str(x.text, 2000) ?? '', drawer: str(x.drawer, 200) ?? '', project: slug(x.project) ? x.project : null, deletedAt: when(x.deletedAt) ?? '', deletedBy: str(x.deletedBy, 120) ?? '', forgetAt: when(x.forgetAt), count: 0 };
}
function trashProjectRow(x) {
  if (!record(x) || !slug(x.slug)) return null;
  return { id: `project:${x.slug}`, kind: 'project', text: str(x.name, 120) || x.slug, drawer: `project:${x.slug}`, project: x.slug, deletedAt: when(x.trashedAt) ?? '', deletedBy: '', forgetAt: when(x.forgetAt), count: n(x.memories) };
}
function group(x) {
  if (!record(x) || !groupId(x.id)) return null;
  return { id: x.id, name: str(x.name, 80) ?? '', label: str(x.label, 40), shareWithin: x.shareWithin === true, projects: Array.isArray(x.projects) ? x.projects.filter(slug).slice(0, MAX_GROUP_PROJECTS) : [] };
}
const colour = x => (record(x) && colourValue(x.value) ? { name: str(x.name, 80) ?? '', value: x.value, source: str(x.source, 300) ?? '', main: x.main === true } : null);
const logo = x => (record(x) && filePath(x.path) && typeof x.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x.id) ? { id: x.id, path: x.path, kind: str(x.kind, 20) ?? 'image', main: x.main === true, bytes: n(x.bytes) } : null);
const conflict = x => (record(x) && x.kind === 'main-colour' && Array.isArray(x.options) ? { kind: 'main-colour', question: str(x.question, 300) ?? '', options: x.options.slice(0, 6).map(colour).filter(Boolean) } : null);
function design(b) {
  const file = record(b.file) ? b.file : {};
  return {
    colours: (Array.isArray(b.colours) ? b.colours : []).slice(0, 60).map(colour).filter(Boolean),
    fonts: (Array.isArray(b.fonts) ? b.fonts : []).slice(0, 20).filter(record).map(f => ({ name: str(f.name, 80) ?? '', source: str(f.source, 300) ?? '' })),
    logos: (Array.isArray(b.logos) ? b.logos : []).slice(0, 40).map(logo).filter(Boolean),
    rules: (Array.isArray(b.rules) ? b.rules : []).slice(0, 40).filter(record).map(r => ({ text: str(r.text, 300) ?? '', source: str(r.source, 300) ?? '' })),
    sources: (Array.isArray(b.sources) ? b.sources : []).slice(0, 40).filter(x => record(x) && filePath(x.path)).map(x => ({ path: x.path, kind: str(x.kind, 40) ?? '' })),
    conflicts: (Array.isArray(b.conflicts) ? b.conflicts : []).slice(0, 10).map(conflict).filter(Boolean),
    hiddenLogos: n(b.hiddenLogos), writeFile: b.writeFile !== false,
    file: { path: str(file.path, 1024), writtenAt: when(file.writtenAt), problem: str(file.problem, 300) },
    canUndo: b.canUndo === true,
  };
}
function database(x) {
  if (!record(x) || !groupId(x.id)) return null;
  return { id: x.id, kind: str(x.kind, 20) ?? 'other', engine: str(x.engine, 40) ?? '', name: str(x.name, 120) ?? '', path: str(x.path, 1024) ?? '',
    host: str(x.host, 200), port: str(x.port == null ? null : String(x.port), 10), database: str(x.database, 120), service: str(x.service, 120), image: str(x.image, 200),
    tables: Array.isArray(x.tables) ? x.tables.filter(t => typeof t === 'string').slice(0, 200).map(t => t.slice(0, 120)) : [], tableCount: n(x.tableCount), tablesNote: str(x.tablesNote, 200), bytes: n(x.bytes) };
}
const level = x => (DATABASE_LEVELS.includes(x) ? x : 'exists');

export function memoryDesktopResponse(path, status, body) {
  const p = memoryDesktopPath(path);
  if (!p) throw Error('protocol');
  if (status !== 200 && status !== 201) { const code = record(body) ? body.code : undefined; return (CODES[status] ?? []).includes(code) ? { code } : null; }
  if (!record(body)) throw Error('protocol');
  switch (p.route) {
    case 'trash': {
      // Applied twice: the projected list already holds both kinds in `items`.
      if (!Array.isArray(body.items)) throw Error('protocol');
      const items = body.items.slice(0, 5000).map(x => (record(x) && x.kind === 'project' && typeof x.id === 'string' && x.id.startsWith('project:') ? { ...x, project: x.id.slice(8) } : x));
      const projects = (Array.isArray(body.projects) ? body.projects : []).slice(0, 500).map(trashProjectRow).filter(Boolean);
      const again = items.filter(x => record(x) && x.kind === 'project').map(x => trashProjectRow({ slug: x.project, name: x.text, trashedAt: x.deletedAt, forgetAt: x.forgetAt, memories: x.count })).filter(Boolean);
      return { items: [...projects, ...again, ...items.filter(x => !(record(x) && x.kind === 'project')).map(trashItem).filter(Boolean)], trashDays: TRASH_DAYS.includes(body.trashDays) ? body.trashDays : 30 };
    }
    case 'trash-empty': {
      const count = x => (Array.isArray(x) ? x.length : n(x));
      return { forgotten: count(body.forgotten), projects: count(body.projects), skipped: count(body.skipped) };
    }
    case 'restore': { const r = record(body.restored) ? body.restored : body; return { id: p.id, drawer: str(r.drawer, 200), topicKeyDropped: r.topicKeyDropped === true }; }
    case 'project-trash': return { project: p.id, memories: n(body.memories), trashedAt: when(body.trashedAt) };
    case 'project-restore': return { project: p.id, restored: n(body.restored) };
    case 'groups':
      if (record(body.group)) { const g = group(body.group); if (!g) throw Error('protocol'); return { group: g }; }
      if (!Array.isArray(body.groups)) throw Error('protocol');
      return { groups: body.groups.slice(0, 500).map(group).filter(Boolean) };
    case 'group': case 'group-projects': {
      if (!record(body.group)) { if (body.id !== p.id) throw Error('protocol'); return { id: p.id, deleted: true }; }
      const g = group(body.group); if (!g || g.id !== p.id) throw Error('protocol'); return { group: g };
    }
    case 'design': case 'design-undo': return { project: p.id, ...design(body) };
    case 'design-conflicts':
      return { conflicts: (Array.isArray(body.conflicts) ? body.conflicts : []).slice(0, 100).filter(x => record(x) && slug(x.project)).map(x => ({ project: x.project, ...conflict(x) })).filter(x => x.kind) };
    case 'databases':
      if ('agentId' in body) { if (!agentId(body.agentId)) throw Error('protocol'); return { project: p.id, agentId: body.agentId, level: level(body.level) }; }
      return { project: p.id, databases: (Array.isArray(body.databases) ? body.databases : []).slice(0, 100).map(database).filter(Boolean),
        access: (Array.isArray(body.access) ? body.access : []).slice(0, 1000).filter(a => record(a) && agentId(a.agentId)).map(a => ({ agentId: a.agentId, level: level(a.level) })), defaultLevel: level(body.defaultLevel) };
  }
  throw Error('protocol');
}
