// Wire contract for connectors (MCP servers), shared by the browser client
// (session.ts) and the local bridge (application-server.cjs). Owner only.
// Secret values (env, headers) go to the server once and never come back:
// responses carry their names only.

const ID = /^[0-9a-f-]{36}$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const onlyKeys = (x, keys) => Object.keys(x).every(k => keys.includes(k));
const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '');
const text = (x, max) => typeof x === 'string' && x.length <= max;
const secretMap = x => record(x) && Object.keys(x).length <= 50 && Object.entries(x).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(k) && text(v, 4000));
export const CONNECTOR_TRANSPORTS = ['stdio', 'http', 'sse'];
export const CONNECTORS_PATH = '/api/mcp/servers';

export function connectorPath(path) {
  if (path === CONNECTORS_PATH) return { kind: 'list' };
  let m = /^\/api\/mcp\/servers\/([^/?#]+)$/.exec(path);
  if (m) return ID.test(m[1]) ? { kind: 'one', id: m[1] } : null;
  m = /^\/api\/mcp\/servers\/([^/?#]+)\/(enable|disable|refresh|reconnect)$/.exec(path);
  if (m) return ID.test(m[1]) ? { kind: m[2], id: m[1] } : null;
  m = /^\/api\/mcp\/servers\/([^/?#]+)\/tools\/([^/?#]+)$/.exec(path);
  if (m) return ID.test(m[1]) && /^[A-Za-z0-9_.-]{1,128}$/.test(m[2]) ? { kind: 'tool', id: m[1], tool: m[2] } : null;
  return null;
}
export function connectorRoute(path) { return connectorPath(path) !== null; }

export function allowedConnector(method, path, body) {
  const p = connectorPath(path);
  if (!p) return false;
  switch (p.kind) {
    case 'list':
      if (method === 'GET') return body === undefined;
      return method === 'POST' && record(body) && onlyKeys(body, ['name', 'description', 'transport', 'command', 'args', 'url', 'allowRemote', 'env', 'headers', 'timeoutMs'])
        && typeof body.name === 'string' && NAME.test(body.name) && CONNECTOR_TRANSPORTS.includes(body.transport)
        && (body.description === undefined || text(body.description, 500))
        && (body.command === undefined || (text(body.command, 500) && body.command.trim().length > 0))
        && (body.args === undefined || (Array.isArray(body.args) && body.args.length <= 50 && body.args.every(a => text(a, 1000))))
        && (body.url === undefined || text(body.url, 2000)) && (body.allowRemote === undefined || typeof body.allowRemote === 'boolean')
        && (body.env === undefined || secretMap(body.env)) && (body.headers === undefined || secretMap(body.headers))
        && (body.timeoutMs === undefined || (Number.isInteger(body.timeoutMs) && body.timeoutMs >= 1000 && body.timeoutMs <= 300000));
    case 'one':
      if(method === 'GET' || method === 'DELETE')return body === undefined;
      return method === 'PUT' && record(body) && Object.keys(body).length>0 && onlyKeys(body,['description','command','args','url','allowRemote','env','headers'])
        && (body.description===undefined||text(body.description,500)) && (body.command===undefined||text(body.command,500)&&!!body.command.trim())
        && (body.args===undefined||Array.isArray(body.args)&&body.args.length<=50&&body.args.every(a=>text(a,1000)))
        && (body.url===undefined||text(body.url,2000)) && (body.allowRemote===undefined||typeof body.allowRemote==='boolean')
        && (body.env===undefined||secretMap(body.env)) && (body.headers===undefined||secretMap(body.headers));
    case 'enable': return method === 'POST' && (body === undefined || (record(body) && onlyKeys(body, ['launchHash']) && typeof body.launchHash === 'string' && /^[A-Za-z0-9:_-]{8,200}$/.test(body.launchHash)));
    case 'disable': case 'refresh': case 'reconnect': return method === 'POST' && body === undefined;
    case 'tool': return method === 'PUT' && record(body) && onlyKeys(body, ['requiresApproval']) && (body.requiresApproval === null || typeof body.requiresApproval === 'boolean');
  }
  return false;
}

function tool(t) {
  return { name: str(t.name, 128), title: typeof t.title === 'string' ? t.title.slice(0, 160) : null, description: typeof t.description === 'string' ? t.description.slice(0, 500) : null,
    requiresApproval: t.requiresApproval === true, requiresApprovalOverride: t.requiresApprovalOverride === true ? true : t.requiresApprovalOverride === false ? false : null };
}
const names = x => (Array.isArray(x) ? x : record(x) ? Object.keys(x) : []).filter(n => typeof n === 'string').slice(0, 50).map(n => n.slice(0, 128));
function server(x) {
  if (!record(x) || typeof x.id !== 'string' || !ID.test(x.id)) throw Error('protocol');
  return { id: x.id, name: str(x.name, 24), description: typeof x.description === 'string' ? x.description.slice(0, 500) : null,
    transport: CONNECTOR_TRANSPORTS.includes(x.transport) ? x.transport : 'http', command: typeof x.command === 'string' ? x.command.slice(0, 500) : null,
    args: Array.isArray(x.args) ? x.args.filter(a => typeof a === 'string').slice(0, 50).map(a => a.slice(0, 1000)) : [],
    url: typeof x.url === 'string' ? x.url.slice(0, 2000) : null, allowRemote: x.allowRemote === true,
    envNames: names(x.envNames ?? x.env), headerNames: names(x.headerNames ?? x.headers),
    connectionState:['connected','connecting','disconnected'].includes(x.connectionState)?x.connectionState:'unknown', enabled: x.enabled === true, active: x.active === true, launchApproved: x.launchApproved === true,
    status: str(x.status, 40), lastError: typeof x.lastError === 'string' ? x.lastError.slice(0, 500) : null,
    lastDiscoveredAt: typeof x.lastDiscoveredAt === 'string' ? x.lastDiscoveredAt.slice(0, 40) : null,
    tools: Array.isArray(x.tools) ? x.tools.filter(record).slice(0, 200).map(tool) : [] };
}

const CODES = { 400: ['invalid_input'], 403: ['exec_tools_disabled', 'forbidden'], 404: ['not_found', 'tool_not_found'], 409: ['launch_approval_required', 'name_taken', 'disabled', 'conflict'] };
/** Reviewed fields only (stable when applied twice). */
export function connectorResponse(path, status, body) {
  const p = connectorPath(path);
  if (!p) throw Error('protocol');
  if (status !== 200 && status !== 201) {
    const code = record(body) ? body.code : undefined;
    if (!(CODES[status] ?? []).includes(code) && !(status === 502 && typeof code === 'string' && /^mcp_[a-z_]{1,40}$/.test(code))) return null;
    const out = { code, error: str(body.error, 300) };
    if (code === 'launch_approval_required' && record(body.launch) && typeof body.launchHash === 'string') {
      out.launch = { command: str(body.launch.command, 500), args: Array.isArray(body.launch.args) ? body.launch.args.filter(a => typeof a === 'string').slice(0, 50).map(a => a.slice(0, 1000)) : [], envNames: names(body.launch.envNames) };
      out.launchHash = body.launchHash.slice(0, 200);
    }
    return out;
  }
  if (!record(body)) throw Error('protocol');
  if (p.kind === 'list' && Array.isArray(body.servers)) return { servers: body.servers.slice(0, 100).map(server) };
  if (p.kind === 'one' && (body.ok === true || body.deleted === true)) return { ok: true };
  if (p.kind === 'tool' && !record(body.server) && !ID.test(body.id ?? '')) return record(body.tool) ? { tool: tool(body.tool) } : { ok: true };
  if (record(body.server)) return { server: server(body.server), ...(Number.isSafeInteger(body.discovered) ? { discovered: body.discovered } : {}) };
  return { server: server(body), ...(typeof body.disabledByChange==='boolean'?{disabledByChange:body.disabledByChange}:{}) };
}
