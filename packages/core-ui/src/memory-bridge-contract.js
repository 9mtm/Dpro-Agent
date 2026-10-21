// MEM-FINISH-01 wire contract: the memory bridge for coding apps (board M11).
// Owner only. A strict allow-list of requests and a projection of every
// response to the reviewed fields (never error text). Writing a coding app's
// config or a project's managed files always goes preview -> confirm with the
// preview's hash; the server re-checks it (409 preview_stale).
//
//   GET   /api/memory-bridge                                     apps, project folders, registrations
//   PUT   /api/memory-bridge/clients/:client                     { enabled } (kill switch)
//   GET   /api/memory-bridge/clients/:client/registration        dry run of the app's config change
//   POST  /api/memory-bridge/clients/:client/registration        { previewHash, confirm: true }
//   POST  /api/memory-bridge/registrations/:id/undo
//   GET   /api/memory-bridge/projects/:projectId/files           dry run of AGENTS.md / CLAUDE.md / GEMINI.md
//   POST  /api/memory-bridge/projects/:projectId/files           { previewHash, confirm: true }
//   PATCH /api/memory-bridge/projects/:projectId                 { filesEnabled: false?, backflowEnabled?, gitExclude? }
//   POST  /api/memory-bridge/projects/:projectId/backflow        bring the apps' own notes back as reviews now
//   GET   /api/memory-bridge/audit?limit=&client=&projectId=     activity, newest first

const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (x, keys) => Object.keys(x).every(k => keys.includes(k));
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const projectId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x);
const registrationId = x => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x);

export const BRIDGE_CLIENTS = ['claude-code', 'codex', 'gemini-cli', 'antigravity'];
export const PLAN_ACTIONS = ['create', 'update', 'unchanged', 'conflict'];
export const BRIDGE_PATH = '/api/memory-bridge';
export const bridgeClientPath = c => `/api/memory-bridge/clients/${c}`;
export const bridgeRegistrationPath = c => `/api/memory-bridge/clients/${c}/registration`;
export const bridgeUndoPath = id => `/api/memory-bridge/registrations/${id}/undo`;
export const bridgeFilesPath = id => `/api/memory-bridge/projects/${encodeURIComponent(id)}/files`;
export const bridgeProjectPath = id => `/api/memory-bridge/projects/${encodeURIComponent(id)}`;
export const bridgeBackflowPath = id => `/api/memory-bridge/projects/${encodeURIComponent(id)}/backflow`;

/** Which bridge route a path is, with its id and query, or null. */
export function memoryBridgePath(path) {
  if (typeof path !== 'string' || path.length > 1024) return null;
  const q = path.indexOf('?');
  const base = q < 0 ? path : path.slice(0, q);
  const raw = q < 0 ? '' : path.slice(q + 1);
  if (base === BRIDGE_PATH) return raw === '' ? { route: 'status' } : null;
  if (base === '/api/memory-bridge/audit') {
    const params = {};
    if (raw !== '') for (const part of raw.split('&')) {
      const i = part.indexOf('=');
      if (i <= 0) return null;
      const k = part.slice(0, i); let v;
      try { v = decodeURIComponent(part.slice(i + 1)); } catch { return null; }
      if (k in params || encodeURIComponent(v) !== part.slice(i + 1)) return null;
      if (k === 'limit' ? !/^[1-9][0-9]{0,2}$/.test(v) || Number(v) > 500 : k === 'client' ? !BRIDGE_CLIENTS.includes(v) : k === 'projectId' ? !projectId(v) : true) return null;
      params[k] = v;
    }
    return { route: 'audit', params };
  }
  if (raw !== '') return null;
  let m;
  if ((m = /^\/api\/memory-bridge\/clients\/([^/]+)(\/registration)?$/.exec(base)) && BRIDGE_CLIENTS.includes(m[1])) return { route: m[2] ? 'registration' : 'client', id: m[1] };
  if ((m = /^\/api\/memory-bridge\/registrations\/([^/]+)\/undo$/.exec(base)) && registrationId(m[1])) return { route: 'undo', id: m[1] };
  if ((m = /^\/api\/memory-bridge\/projects\/([^/]+)(\/files|\/backflow)?$/.exec(base))) {
    let id; try { id = decodeURIComponent(m[1]); } catch { return null; }
    if (!projectId(id) || encodeURIComponent(id) !== m[1]) return null;
    return { route: m[2] === '/files' ? 'files' : m[2] === '/backflow' ? 'backflow' : 'project', id };
  }
  return null;
}
export function memoryBridgeRoute(path) { return memoryBridgePath(path) !== null; }

const confirmed = b => record(b) && onlyKeys(b, ['previewHash', 'confirm']) && Object.keys(b).length === 2 && b.confirm === true && hash(b.previewHash);

export function allowedMemoryBridge(method, path, body) {
  const p = memoryBridgePath(path);
  if (!p) return false;
  const get = method === 'GET' && body === undefined;
  switch (p.route) {
    case 'status': case 'audit': return get;
    case 'client': return method === 'PUT' && record(body) && Object.keys(body).length === 1 && typeof body.enabled === 'boolean';
    case 'registration': case 'files': return get || (method === 'POST' && confirmed(body));
    case 'undo': case 'backflow': return method === 'POST' && body === undefined;
    case 'project':
      return method === 'PATCH' && record(body) && Object.keys(body).length > 0 && onlyKeys(body, ['filesEnabled', 'backflowEnabled', 'gitExclude'])
        && (body.filesEnabled === undefined || body.filesEnabled === false)
        && ['backflowEnabled', 'gitExclude'].every(k => body[k] === undefined || typeof body[k] === 'boolean');
  }
  return false;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const fail = () => { throw Error('Invalid memory bridge response'); };
// eslint-disable-next-line no-control-regex
const badChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/gu;
const clip = (x, max) => (typeof x === 'string' ? x.replace(badChars, '').slice(0, max) : '');
const when = x => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(x) ? x.slice(0, 19) : '');
const whenOrNull = x => (when(x) || null);
const count = x => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
const list = (x, max) => (Array.isArray(x) ? x.slice(0, max) : []);
const client = x => (BRIDGE_CLIENTS.includes(x) ? x : null);
const action = x => (PLAN_ACTIONS.includes(x) ? x : 'conflict');
const sha = x => (hash(x) ? x : null);

function folder(f) {
  if (!record(f) || !projectId(f.projectId)) fail();
  return {
    projectId: f.projectId, ...('name' in f ? { name: clip(f.name, 120) || f.projectId, folder: clip(f.folder, 1024) } : {}),
    filesEnabled: f.filesEnabled === true, backflowEnabled: f.backflowEnabled === true, gitExclude: f.gitExclude !== false,
    writtenAt: whenOrNull(f.writtenAt), confirmedAt: whenOrNull(f.confirmedAt),
  };
}
function registration(r) {
  if (!record(r) || !registrationId(r.id) || !client(r.client)) fail();
  return { id: r.id, client: r.client, configPath: clip(r.configPath, 1024), existed: r.existed === true, status: r.status === 'undone' ? 'undone' : 'applied', createdAt: when(r.createdAt), undoneAt: whenOrNull(r.undoneAt) };
}
function regPreview(p) {
  if (!record(p) || !client(p.client) || !hash(p.previewHash)) fail();
  return {
    client: p.client, name: clip(p.name, 60), configPath: clip(p.configPath, 1024), action: action(p.action), ...(typeof p.reason === 'string' ? { reason: clip(p.reason, 300) } : {}),
    diff: clip(p.diff, 20000), beforeSha256: sha(p.beforeSha256), afterSha256: sha(p.afterSha256), previewHash: p.previewHash,
    warnings: list(p.warnings, 10).filter(w => typeof w === 'string').map(w => clip(w, 300)),
  };
}
function filesPreview(p) {
  if (!record(p) || !projectId(p.projectId) || !hash(p.previewHash)) fail();
  return {
    projectId: p.projectId, folder: clip(p.folder, 1024), previewHash: p.previewHash, conflicts: count(p.conflicts), changes: count(p.changes),
    files: list(p.files, 10).filter(record).map(f => ({ name: clip(f.name, 60), relative: clip(f.relative, 300), action: action(f.action), ...(typeof f.reason === 'string' ? { reason: clip(f.reason, 300) } : {}), diff: clip(f.diff, 40000) })),
  };
}
function entry(e) {
  if (!record(e) || typeof e.id !== 'string') fail();
  return { id: clip(e.id, 64), client: client(e.client), projectId: projectId(e.projectId) ? e.projectId : null, action: clip(e.action, 64), detail: typeof e.detail === 'string' ? clip(e.detail, 300) : null, createdAt: when(e.createdAt) };
}

const CODES = ['confirm_required', 'preview_stale', 'conflict', 'not_found', 'no_folder', 'folder_missing', 'markers_broken', 'config_unparsable', 'already_undone', 'backup_missing'];

export function memoryBridgeResponse(path, status, body) {
  const p = memoryBridgePath(path);
  if (!p) fail();
  if (status !== 200 && status !== 201) return record(body) && CODES.includes(body.code) ? { code: body.code } : null;
  if (!record(body)) fail();
  switch (p.route) {
    case 'status':
      return {
        clients: list(body.clients, 8).filter(c => record(c) && client(c.client)).map(c => ({
          client: c.client, name: clip(c.name, 60), enabled: c.enabled === true, configPath: clip(c.configPath, 1024),
          registrationId: registrationId(c.registrationId) ? c.registrationId : null, registeredAt: whenOrNull(c.registeredAt),
          lastCallAt: whenOrNull(c.lastCallAt), lastTool: typeof c.lastTool === 'string' && /^[a-z_]{1,40}$/.test(c.lastTool) ? c.lastTool : null,
        })),
        projects: list(body.projects, 500).map(folder),
        registrations: list(body.registrations, 200).map(registration),
        serverReady: body.serverReady === true,
      };
    case 'client': return { client: client(body.client) ?? fail(), enabled: body.enabled === true };
    case 'registration':
      if ('registration' in body) return { registration: body.registration === null ? null : registration(body.registration), preview: regPreview(body.preview) };
      return { preview: regPreview(body.preview) };
    case 'undo': return { registration: registration(body.registration), mode: ['restored', 'entry-removed', 'already-gone'].includes(body.mode) ? body.mode : 'restored' };
    case 'files': return 'result' in body ? { result: filesPreview(body.result) } : { preview: filesPreview(body.preview) };
    case 'project': return { folder: folder(body.folder) };
    case 'backflow': { const r = record(body.result) ? body.result : fail(); return { result: { files: count(r.files), proposed: count(r.proposed), known: count(r.known), skipped: count(r.skipped) } }; }
    case 'audit': return { entries: list(body.entries, 500).map(entry) };
  }
  return fail();
}
