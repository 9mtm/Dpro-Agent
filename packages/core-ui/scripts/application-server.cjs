const {approvalRoute,allowedApproval,approvalResponse}=require('../src/approvals-contract.js');
const { allowedConnections, connectionsRoute, connectionsResponse } = require('../src/connections-contract.js');
const {allowedTemplates,templatePath,templatesResponse}=require('../src/specialty-contract.js');
const { allowedMcpImport, mcpImportPath, mcpImportResponse } = require('../src/mcp-import-contract.js');
const { allowedSkillLibrary, skillLibraryPath, skillLibraryResponse } = require('../src/skill-library-contract.js');
const { createGenVRAssets } = require('./genvr-assets.cjs');
const { createStudioHost } = require('./genvr-studio-host.cjs');
const { allowedGenVR, genvrRoute, genvrResponse, GENVR_BYTES, STUDIO_TICKET_PATH } = require('../src/genvr-contract.js');
const { allowedChannel, channelRoute, channelResponse } = require('../src/agent-connect-contract.js');
const { allowedPersonality, personalityRoute, personalityResponse } = require('../src/personality-contract.js');
const { allowedHire, hireRoute, hireResponse } = require('../src/hire-contract.js');
const { allowedBoard, boardRoute, boardResponse } = require('../src/board-contract.js');
const { allowedAgentCard, cardRoute, agentCardResponse } = require('../src/agent-card-contract.js');
const { allowedConnector, connectorRoute, connectorResponse } = require('../src/connectors-contract.js');
const { allowedLocalImport, localImportRoute, localImportResponse } = require('../src/local-import-contract.js');
const { allowedChatBoard, chatBoardRoute, chatBoardResponse } = require('../src/chat-board-contract.js');
const { allowedChatMemory, chatMemoryRoute, chatMemoryResponse } = require('../src/chat-memory-contract.js');
const { allowedChatSearch, chatSearchRoute, chatSearchResponse } = require('../src/chat-search-contract.js');
const { allowedChatExport, chatExportRoute, chatExportResponse } = require('../src/chat-export-contract.js');
const { allowedChatSecrets, chatSecretsRoute, chatSecretsResponse } = require('../src/chat-secrets-contract.js');
const { allowedTerminal, terminalPath, terminalRoute, terminalResponse, TerminalEventParser, TERMINAL_STREAM_MS } = require('../src/terminal-contract.js');
const { allowedConversation, conversationPath, conversationRoute, conversationResponse, RunEventParser, RUN_STREAM_MS, RUN_IDLE_MS } = require('../src/conversation-contract.js');
const { validDeviceToken, validLoginBody } = require('../src/login-contract.js');
const { setupStatus } = require('../src/setup-status.js');
const { OWNER_SETUP_PATH, validOwnerSetupBody, ownerSetupResponse } = require('../src/owner-setup-contract.js');
const { memoryResponse } = require('./memory-response.cjs');
const { allowedMemoryPages, memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { allowedMemoryRecall, memoryRecallRoute, memoryRecallResponse } = require('../src/memory-recall-contract.js');
const { validChatBody, validKey, validId, chatError, SSEParser, CHAT_BYTES, CHAT_DEADLINE_MS, CHAT_IDLE_MS } = require('../src/chat-protocol.js');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const KEEPALIVE_MS = 3000;
const { root, readCurrent } = require('./build-artifacts.cjs');
const { HEADERS, requestPath } = require('./preview.cjs');
const HOST = '127.0.0.1';
const LIMIT = 128 * 1024;
/** A microphone clip (base64 JSON) may be larger than an ordinary request; it also takes longer. */
const AUDIO_LIMIT = 9 * 1024 * 1024;
const AUDIO_TIMEOUT_MS = 200_000;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const languages = ['en', 'ar', 'de', 'fr', 'es', 'zh', 'ja', 'ko', 'pt-BR', 'ru', 'tr', 'hi'];
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const { validAgentId: agentId } = require('../src/agent-id.js');
const { retryAfterSeconds } = require('../src/retry-after.js');
const version = x => Number.isSafeInteger(x) && x > 0;
const name = x => typeof x === 'string' && x.length > 0 && [...x].length <= 60 && x.normalize('NFKC').replace(/\s+/g, ' ').trim() === x && !/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/u.test(x);
const ROLES = ['main', 'manager', 'specialist', 'evaluator'];
const profile = x => ({
  ...(x.role === null || ROLES.includes(x.role) ? { role: x.role } : {}),
  ...(x.department === null || (typeof x.department === 'string' && /^[a-z0-9][a-z0-9 _-]{0,63}$/.test(x.department)) ? { department: x.department } : {}),
  ...(typeof x.description === 'string' ? { description: x.description.slice(0, 1000) } : {}),
  ...(typeof x.emoji === 'string' && [...x.emoji].length <= 4 ? { emoji: x.emoji } : {}),
  ...(typeof x.isPrimary === 'boolean' ? { isPrimary: x.isPrimary } : {}),
  ...(typeof x.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,99}$/.test(x.model) ? { model: x.model } : {}),
  ...(typeof x.provider === 'string' && /^[a-z][a-z-]{0,19}$/.test(x.provider) ? { provider: x.provider } : {}),
});
const agent = x => {
  if (!record(x) || !agentId(x.id) || !version(x.version)) throw Error();
  return name(x.name) && x.nameUnavailable !== true
    ? { id: x.id, name: x.name, version: x.version, ...profile(x) }
    : { id: x.id, version: x.version, nameUnavailable: true, ...profile(x) };
};
function allowed(method, target, body) {
  if (approvalRoute(target)) return allowedApproval(method,target,body);
  if (connectionsRoute(target)) return allowedConnections(method,target,body);
  if (mcpImportPath(target)) return allowedMcpImport(method,target,body);
  if (templatePath(target)) return allowedTemplates(method,target,body);
  if (skillLibraryPath(target)) return allowedSkillLibrary(method,target,body);
  if (memoryPagesRoute(target)) return allowedMemoryPages(method, target, body);
  if (memoryRecallRoute(target)) return allowedMemoryRecall(method, target, body);
  if (allowedGenVR(method, target, body) || allowedChannel(method, target, body) || allowedPersonality(method, target, body) || allowedHire(method, target, body) || allowedBoard(method, target, body) || allowedConversation(method, target, body) || allowedAgentCard(method, target, body) || allowedTerminal(method, target, body) || allowedConnector(method, target, body) || allowedLocalImport(method, target, body) || allowedChatBoard(method, target, body) || allowedChatMemory(method, target, body) || allowedChatSearch(method, target, body) || allowedChatExport(method, target, body) || allowedChatSecrets(method, target, body)) return true;
  const id = /^\/api\/agents\/([^/?#]+)$/.exec(target)?.[1];
  if (method === 'PUT') return agentId(id) && record(body) && Object.keys(body).length === 2 && Object.keys(body).every(k => k === 'name' || k === 'expectedVersion') && name(body.name) && version(body.expectedVersion);
  if (method === 'GET' && body === undefined && (target === '/api/agents' || agentId(id))) return true;
  if (method === 'POST') {
    if (target === '/api/chat') return validChatBody(body);
    if (/^\/api\/memory\/proposals\/[A-Za-z0-9-]{1,64}\/(approve|reject)$/.test(target)) return record(body) && Object.keys(body).length === 1 && /^[a-f0-9]{64}$/.test(body.expectedReviewHash) && typeof body.expectedReviewHash === 'string';
    if (target === '/api/auth/logout') return body === undefined;
    if (target === '/api/auth/login') return validLoginBody(body);
    if (target === OWNER_SETUP_PATH) return validOwnerSetupBody(body);
    return target === '/api/agents/name-suggestion' && record(body) && Object.keys(body).length === 2 && languages.includes(body.language) && Array.isArray(body.exclude) && body.exclude.length <= 100 && body.exclude.every(x => typeof x === 'string' && x.length <= 200);
  }
  if (method !== 'GET' || body !== undefined) return false;
  if (['/api/setup/status', '/api/auth/me', '/api/memory/proposals', '/api/memory/proposals?status=pending'].includes(target)) return true;
  if (/^\/api\/memory\/proposals\/[A-Za-z0-9-]{1,64}$/.test(target)) return true;
  const m = /^\/api\/memory\/files\/([^/?#]+)\?agentId=([^&#]+)$/.exec(target);
  if (!m) return false;
  try {
    const d = decodeURIComponent(m[1]), a = decodeURIComponent(m[2]);
    const drawer = d === 'owner' || d === 'experience' || /^project:[a-z0-9][a-z0-9_-]{0,63}$/.test(d) || (/^(task|people):[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(d) && !d.includes('..'));
    return drawer && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(a) && !a.includes('..') && encodeURIComponent(d) === m[1] && encodeURIComponent(a) === m[2];
  } catch { return false; }
}
// Stage 1 is an explicit route-identity subset, not permission for arbitrary GETs.
// Keep this list fixed when expanding the ordinary bridge. Static agent names
// must be reviewed against backend route registration before widening this gate.
function stage1Route(method, target) {
  if (method === 'POST') return target === '/api/auth/login' || target === '/api/auth/logout';
  if (method !== 'GET') return false;
  const id = /^\/api\/agents\/([^/?#]+)/.exec(target)?.[1];
  if (id && ['status', 'name-suggestion'].includes(id.toLowerCase())) return false;
  const read = ['/api/setup/status', '/api/auth/me', '/api/agents', '/api/memory/proposals', '/api/memory/proposals?status=pending'].includes(target)
    || /^\/api\/agents\/[^/?#]+$/.test(target)
    || /^\/api\/agents\/[^/?#]+\/personality\/proposals(?:\/[^/?#]+)?$/.test(target)
    || /^\/api\/memory\/proposals\/[A-Za-z0-9-]{1,64}$/.test(target)
    || /^\/api\/memory\/files\/[^/?#]+\?agentId=[^&#]+$/.test(target);
  return read && allowed('GET', target, undefined);
}
function project(target, status, body) {
  if (target === '/api/setup/status') return setupStatus(status, body);
  // INSTALLER-07: fixed codes only; a reply outside the contract fails closed.
  if (target === OWNER_SETUP_PATH) { const r = ownerSetupResponse(status, body); if (!r) throw Error(); return r; }
  if (target === '/api/chat') return chatError(status, body);
  if ((status === 403 && ['inactive_user', 'forbidden'].includes(body?.code)) || (status === 401 && body?.code === 'unauthenticated')) return { code: body.code };
  const boundaryCode = body?.code;
  if ((status === 403 && ['published_password', 'account_inactive', 'origin_not_allowed', 'read_only_stage'].includes(boundaryCode)) || (status === 429 && boundaryCode === 'rate_limited') || (status === 421 && boundaryCode === 'host_not_allowed')) return { code: boundaryCode };
  if (personalityRoute(target)) return personalityResponse(target, status, body);
  if (hireRoute(target, status)) return hireResponse(target, status, body);
  if (boardRoute(target)) return boardResponse(target, status, body);
  if (conversationRoute(target)) return conversationResponse(target, status, body);
  if (cardRoute(target)) return agentCardResponse(target, status, body);
  if (terminalRoute(target)) return terminalResponse(target, status, body);
  if (approvalRoute(target)) return approvalResponse(target,status,body);
  if (connectionsRoute(target)) return connectionsResponse(target,status,body);
  if (mcpImportPath(target)) return mcpImportResponse(target,status,body);
  if (templatePath(target)) return templatesResponse(target,status,body);
  if (skillLibraryPath(target)) return skillLibraryResponse(target,status,body);
  if (genvrRoute(target)) return genvrResponse(target, status, body);
  if (channelRoute(target)) return channelResponse(target, status, body);
  if (connectorRoute(target)) return connectorResponse(target, status, body);
  if (localImportRoute(target)) return localImportResponse(target, status, body);
  if (chatBoardRoute(target)) return chatBoardResponse(target, status, body);
  if (chatMemoryRoute(target)) return chatMemoryResponse(target, status, body);
  if (chatSearchRoute(target)) return chatSearchResponse(target, status, body);
  if (chatExportRoute(target)) return chatExportResponse(target, status, body);
  if (chatSecretsRoute(target)) return chatSecretsResponse(target, status, body);
  if (memoryPagesRoute(target)) return memoryPagesResponse(target, status, body);
  if (memoryRecallRoute(target)) return memoryRecallResponse(target, status, body);
  if (target === '/api/agents' || (target.startsWith('/api/agents/') && target !== '/api/agents/name-suggestion')) {
    if (status === 200 && target === '/api/agents') {
      if (!Array.isArray(body?.agents) || body.agents.length > 10000) throw Error();
      const agents = body.agents.map(agent); if (new Set(agents.map(a => a.id)).size !== agents.length) throw Error();
      return { agents };
    }
    if (status === 200 || (status === 409 && body?.code === 'version_conflict')) {
      const a = agent(body?.agent); if (a.id !== target.slice('/api/agents/'.length)) throw Error();
      if (status === 200) return { agent: a };
      if (body.currentVersion !== a.version) throw Error();
      return { code: 'version_conflict', currentVersion: a.version, agent: a };
    }
    const code = body?.code;
    return (status === 409 && code === 'name_taken') || (status === 400 && code === 'invalid_version') || (status === 403 && code === 'reserved_agent') ? { code } : null;
  }
  if (status !== 200) {
    const decision = /^\/api\/memory\/proposals\/[A-Za-z0-9-]{1,64}\/(approve|reject)$/.test(target);
    const code = body?.code;
    return decision && ((status === 409 && ['already_decided', 'stale', 'review_changed'].includes(code)) || (status === 400 && code === 'review_hash_required')) ? { code } : null;
  }
  if (target === '/api/auth/login' || target === '/api/auth/me') {
    const u = body?.user;
    if (!record(u) || !['id', 'email', 'username', 'role'].every(k => typeof u[k] === 'string')) throw Error();
    const user = Object.fromEntries(['id', 'email', 'username', 'role'].map(k => [k, u[k]]));
    // The name the owner typed at setup (display only); dropped when missing or odd.
    const fullName = typeof u.full_name === 'string' ? u.full_name.trim() : '';
    if (fullName && fullName.length <= 200) user.full_name = fullName;
    if (target.endsWith('/me')) return { user };
    if (typeof body.token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(body.token)) throw Error();
    if (!validDeviceToken(body.deviceToken)) throw Error();
    return { user, token: body.token, deviceToken: body.deviceToken };
  }
  if (target === '/api/auth/logout') { if (body?.success !== true) throw Error(); return { success: true }; }
  if (target === '/api/agents/name-suggestion') return { name: body?.name, language: body?.language, exhausted: body?.exhausted };
  return memoryResponse(target, body);
}
const passiveHeaders = new Set(['host', 'origin', 'authorization', 'accept', 'content-type', 'content-length', 'connection', 'user-agent', 'accept-encoding', 'accept-language', 'cache-control', 'pragma', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'cookie']);
// Internal factory accepts only numeric loopback ports for ephemeral mock tests.
// The executable below exposes no destination, host, port or environment overrides.
const LAUNCH_HEADER = 'X-Agent-Player-Launch';
const launchTokenShape = /^[A-Za-z0-9_-]{43}$/;
/**
 * upstreamPort is a fixed port, or (desktop app) a function that returns the
 * backend's current port, or null while the backend is not up (503).
 * launchToken (desktop app) is the per-launch secret the backend requires on
 * every request; it is added here and never reaches the page.
 */
function createApplicationServer({ packageRoot = root, channel, stage1ReadOnly = false, upstreamPort = 42521, launchToken = null, timeoutMs = 10000, streamTimeoutMs = CHAT_DEADLINE_MS, streamIdleMs = CHAT_IDLE_MS, runStreamMs = RUN_STREAM_MS, runIdleMs = RUN_IDLE_MS } = {}) {
  if (typeof stage1ReadOnly !== 'boolean') throw Error('Invalid stage1 configuration');
  const validPort = x => Number.isInteger(x) && x >= 1 && x <= 65535;
  if (launchToken !== null && !(typeof launchToken === 'string' && launchTokenShape.test(launchToken))) throw Error('Invalid launch configuration');
  if (!['candidate', 'current'].includes(channel) || !(typeof upstreamPort === 'function' || validPort(upstreamPort)) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw Error('Invalid launch configuration');
  if (!Number.isInteger(streamTimeoutMs) || streamTimeoutMs < 1 || streamTimeoutMs > CHAT_DEADLINE_MS || !Number.isInteger(streamIdleMs) || streamIdleMs < 1 || streamIdleMs > CHAT_IDLE_MS) throw Error('Invalid stream limits');
  if (!Number.isInteger(runStreamMs) || runStreamMs < 1 || runStreamMs > RUN_STREAM_MS || !Number.isInteger(runIdleMs) || runIdleMs < 1 || runIdleMs > RUN_IDLE_MS) throw Error('Invalid run stream limits');
  // Live bridge (MCP + local voice) and the owner's private library for the GenVR frame.
  const studio = createStudioHost({ packageRoot });
  let studioToken = null;
  void studio.token().then(t => { studioToken = t; }, () => {});
  const serveGenVR = createGenVRAssets(packageRoot, () => studioToken);
  const assets = readCurrent(packageRoot, channel); // Pin validated bytes for this server lifetime.
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 10000, headersTimeout: 10000 }, async (req, res) => {
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    const send = (status, body = null, type = 'application/json; charset=utf-8') => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length }); res.end(req.method === 'HEAD' ? undefined : data);
    };
    let upstream;
    let idle;
    let timer = setTimeout(() => { send(504); upstream?.destroy(); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); clearTimeout(idle); upstream?.destroy(); };
    res.once('close', cleanup); res.once('finish', cleanup);
    req.once('aborted', cleanup);
    req.on('error', () => { cleanup(); res.destroy(); });
    const host = `${HOST}:${req.socket.localPort}`, origin = `http://${host}`;
    const raw = req.url || '';
    if (req.headers.host !== host) return send(421);
    const duplicates = new Set();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i].toLowerCase();
      if (duplicates.has(key)) return send(400);
      duplicates.add(key);
    }
    if ((req.headers.origin && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return send(403);
    if (stage1ReadOnly && raw.startsWith('/api/') && !stage1Route(req.method, raw)) return send(403, { code: 'stage1_read_only' });
    if (requestPath(raw) === null || raw.length > 2048) return send(400);
    const studioPath = requestPath(raw);
    if (studioPath.startsWith('/studio-bridge/') || studioPath.startsWith('/studio-library/')) {
      // Long polls, voice generation and library files outlive the API deadline.
      clearTimeout(timer);
      try { if (await studio.handle(req, res, studioPath)) return; } catch { return send(500); }
    }
    if (!raw.startsWith('/api/') && serveGenVR(req, res, requestPath(raw))) return;
    if (!raw.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(req.method)) return send(405);
      if (raw.includes('?') || req.headers.authorization || req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0)) return send(400);
      const name = ['/', '/chat', '/agents', '/memory', '/tasks', '/settings', '/channels'].includes(raw) ? 'index.html' : raw.slice(1);
      const data = assets.files.get(name);
      if (!data) return send(404);
      return send(200, data, name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/plain; charset=utf-8');
    }
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return send(405);
    const chat = raw === '/api/chat' && req.method === 'POST';
    const runEvents = req.method === 'GET' && conversationPath(raw)?.kind === 'events';
    const termStream = req.method === 'GET' && terminalPath(raw)?.kind === 'stream';
    if (Object.keys(req.headers).some(k => !passiveHeaders.has(k) && !(chat && k === 'idempotency-key')) || (req.headers.connection && !/^(close|keep-alive)$/i.test(req.headers.connection)) || (req.headers['sec-fetch-mode'] && req.headers['sec-fetch-mode'] !== 'same-origin') || (req.headers['sec-fetch-dest'] && req.headers['sec-fetch-dest'] !== 'empty')) return send(400);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin !== origin) return send(403);
    if (chat && !validKey(req.headers['idempotency-key'])) return send(400);
    const login = raw === '/api/auth/login' || (raw === OWNER_SETUP_PATH && req.method === 'POST');
    const discovery = raw === '/api/setup/status' && req.method === 'GET';
    let auth = req.headers.authorization;
    if (auth === 'Bearer dpro-remembered-session') {
      const values = (req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith('dpro_session='));
      const token = values.length === 1 ? values[0].slice('dpro_session='.length) : '';
      auth = /^[A-Za-z0-9._~-]{1,8192}$/.test(token) ? `Bearer ${token}` : undefined;
    }
    if ((login || discovery) ? auth !== undefined : typeof auth !== 'string' || auth.length > 8200 || !/^Bearer [A-Za-z0-9._~-]+$/.test(auth)) return send(401);
    const length = Number(req.headers['content-length'] || 0);
    const audio = req.method === 'POST' && raw === '/api/chat/transcribe';
    const limit = genvrRoute(raw) ? GENVR_BYTES + 65536 : audio ? AUDIO_LIMIT : LIMIT;
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) return send(413);
    if (req.headers['content-type'] && !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) return send(415);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > limit) return send(413); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks);
      if (bytes.length && req.headers['content-type'] === undefined) return send(415);
      const body = bytes.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : undefined;
      if (!allowed(req.method, raw, body)) return send(400);
      if (res.destroyed || res.writableEnded) return;
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const port = typeof upstreamPort === 'function' ? upstreamPort() : upstreamPort;
      if (!validPort(port)) return send(503);
      if (raw === STUDIO_TICKET_PATH) {
        // Answered here, not by the backend: the backend confirms the caller is the owner first.
        const me = await new Promise(resolve => {
          const check = http.request({ hostname: HOST, port, path: '/api/auth/me', method: 'GET', agent: false, headers: { ...(launchToken ? { [LAUNCH_HEADER]: launchToken } : {}), Host: `${HOST}:${port}`, Accept: 'application/json', Authorization: auth, ...(req.headers.origin ? { Origin: origin } : {}) } }, response => {
            const parts = []; let n = 0;
            response.on('data', c => { n += c.length; if (n <= 65536) parts.push(c); });
            response.on('end', () => { try { resolve(response.statusCode === 200 && n <= 65536 ? JSON.parse(Buffer.concat(parts).toString('utf8')) : null); } catch { resolve(null); } });
          });
          check.on('error', () => resolve(null)); check.setTimeout(5000, () => { check.destroy(); resolve(null); }); check.end();
        });
        const user = me && typeof me === 'object' ? me.user : null;
        if (!user || user.role !== 'owner' || typeof user.id !== 'string') return send(403, { code: 'forbidden' });
        return send(200, studio.issueTicket(user.id));
      }
      const headers = { ...(launchToken ? { [LAUNCH_HEADER]: launchToken } : {}), Host: `${HOST}:${port}`, Accept: chat || runEvents || termStream ? 'text/event-stream' : 'application/json', ...(chat ? { 'Idempotency-Key': req.headers['idempotency-key'] } : {}), ...(auth ? { Authorization: auth } : {}), ...(req.headers.origin ? { Origin: origin } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) };
      // Request-body intake keeps its ordinary bound. Chat header wait and body
      // share one absolute stream deadline, including upstream model startup.
      if (chat) {
        clearTimeout(timer);
        timer = setTimeout(() => { send(504); upstream?.destroy(); }, streamTimeoutMs);
      }
      // A run reader ends cleanly after RUN_STREAM_MS; the page re-attaches with after=<seq>.
      if (runEvents || termStream) clearTimeout(timer);
      if (audio) { clearTimeout(timer); timer = setTimeout(() => { send(504); upstream?.destroy(); }, AUDIO_TIMEOUT_MS); }
      upstream = http.request({ hostname: HOST, port, path: raw, method: req.method, headers, agent: false, maxHeaderSize: 16384 }, response => {
        const fail = () => { response.destroy(); send(502); };
        const status = response.statusCode;
        if ((runEvents || termStream) && status === 200) {
          if (response.headers.location || response.headers['set-cookie'] || response.headers['content-encoding']
            || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers['content-type'] || '')) return fail();
          const parser = runEvents ? new RunEventParser(conversationPath(raw).after) : new TerminalEventParser(terminalPath(raw).after);
          // End our response first; its 'finish' cleanup then closes the upstream reader.
          const finish = () => { clearTimeout(idle); clearTimeout(timer); if (!res.writableEnded) res.end(); };
          const touch = () => { clearTimeout(idle); idle = setTimeout(finish, runIdleMs); };
          timer = setTimeout(finish, runEvents ? runStreamMs : TERMINAL_STREAM_MS);
          touch();
          // Only projected, numbered frames and fixed heartbeats leave the bridge.
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
          res.flushHeaders();
          let lastKeepalive = -Infinity;
          response.on('data', chunk => {
            touch();
            try {
              const frames = parser.push(chunk);
              for (const frame of frames) if (!res.write(`data: ${JSON.stringify(frame)}\n\n`)) response.pause();
              const now = performance.now();
              if (!frames.length && now - lastKeepalive >= KEEPALIVE_MS) { res.write(': keepalive\n\n'); lastKeepalive = now; }
              if (parser.ended) finish();
            } catch { res.destroy(); response.destroy(); }
          });
          res.on('drain', () => response.resume());
          response.on('error', () => { if (!res.writableEnded) res.destroy(); });
          response.on('aborted', () => { if (!res.writableEnded) res.destroy(); });
          response.on('end', () => { try { parser.finish(); } catch { /* the client re-attaches */ } finish(); });
          return;
        }
        if (chat && status === 200) {
          const runId = response.headers['x-run-id'], messageId = response.headers['x-message-id'];
          if (response.headers.location || response.headers['set-cookie'] || response.headers['content-encoding']
            || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers['content-type'] || '')
            || !validId(runId) || !validId(messageId) || Number(response.headers['content-length'] || 0) > CHAT_BYTES) return fail();
          const parser = new SSEParser({ runId, messageId });
          const expire = () => { send(504); response.destroy(); upstream.destroy(); };
          const touch = () => { clearTimeout(idle); idle = setTimeout(expire, streamIdleMs); };
          touch();
          let lastKeepalive = -Infinity;
          let outputBytes = 0;
          const write = text => {
            outputBytes += Buffer.byteLength(text);
            if (outputBytes > CHAT_BYTES) throw Error('limit');
            if (!res.write(text)) response.pause();
          };
          // Only projected frames, fixed heartbeats and validated identifiers leave the bridge.
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Run-Id': runId, 'X-Message-Id': messageId });
          res.flushHeaders();
          response.on('data', chunk => {
            touch();
            try {
              const frames = parser.push(chunk);
              for (const frame of frames) write(`data: ${JSON.stringify(frame)}\n\n`);
              const now = performance.now();
              if (!frames.length && now - lastKeepalive >= KEEPALIVE_MS) {
                write(': keepalive\n\n'); lastKeepalive = now;
              }
            } catch { fail(); }
          });
          res.on('drain', () => response.resume());
          response.on('error', () => { res.destroy(); });
          response.on('aborted', () => { res.destroy(); });
          response.on('end', () => { try { parser.finish(); res.end(); } catch { res.destroy(); } });
          return;
        }
        // The terminal answers input, resize and close with 204: a fixed { ok: true } leaves the bridge.
        if (status === 204 && terminalRoute(raw) && req.method !== 'GET') { response.resume(); return send(200, { ok: true }); }
        const responseLimit = genvrRoute(raw) ? GENVR_BYTES + 65536 : chat ? 16384 : RESPONSE_LIMIT;
        if (status >= 300 && status < 400 || response.headers.location || response.headers['set-cookie'] || response.headers['content-encoding'] || !/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '') || Number(response.headers['content-length'] || 0) > responseLimit) return fail();
        const parts = []; let count = 0;
        response.on('data', chunk => { count += chunk.length; if (count > responseLimit) fail(); else parts.push(chunk); });
        response.on('error', () => send(502));
        response.on('end', () => {
          try {
            const projected = project(raw, status, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))));
            // Fetch may automatically retry 421 POSTs. Do not expose a retry-triggering
            // status for any non-GET; preserve the reviewed code with a bridge 502.
            const delayHeaders = response.rawHeaders.filter((value, i) => i % 2 === 0 && value.toLowerCase() === 'retry-after').length;
            const delay = status === 429 && delayHeaders === 1 ? retryAfterSeconds(response.headers['retry-after']) : undefined;
            if (delay !== undefined && !res.headersSent) res.setHeader('Retry-After', String(delay));
            if (raw === '/api/auth/login' && status === 200 && typeof projected?.token === 'string') {
              res.setHeader('Set-Cookie', `dpro_session=${projected.token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=604800`);
            } else if ((raw === '/api/auth/logout' && status === 200) || (raw === '/api/auth/me' && status === 401 && req.headers.authorization === 'Bearer dpro-remembered-session')) {
              res.setHeader('Set-Cookie', 'dpro_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0');
            }
            send(req.method !== 'GET' && status === 421 ? 502 : status, projected);
          }
          catch { send(502); }
        });
      });
      upstream.on('error', () => send(502));
      upstream.on('upgrade', (_response, socket) => { socket.destroy(); send(502); });
      upstream.end(payload);
    } catch { send(400); }
  });
  server.on('checkContinue', (_req, res) => { res.writeHead(417); res.end(); });
  server.on('listening', () => { const a = server.address(); if (a && typeof a === 'object') void studio.listening(`http://${HOST}:${a.port}`).catch(() => {}); });
  server.on('close', () => { void studio.close(); });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}
async function startApplication(channel, { stage1ReadOnly = false } = {}) {
  const server = createApplicationServer({ channel, stage1ReadOnly });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: HOST, port: 42522, exclusive: true }, resolve); });
  return server;
}
function parseLaunchArgs(args) {
  if (![2, 3].includes(args.length) || (args.length === 3 && args[2] !== '--stage1-read-only') || args[0] !== '--enable-isolated-api' || !['--candidate', '--current'].includes(args[1])) return null;
  return { channel: args[1].slice(2), stage1ReadOnly: args[2] === '--stage1-read-only' };
}
if (require.main === module) {
  const options = parseLaunchArgs(process.argv.slice(2));
  if (!options) {
    console.error('Required: --enable-isolated-api --candidate|--current [--stage1-read-only]'); process.exitCode = 1;
  } else startApplication(options.channel, options).then(server => {
    console.log('Isolated application server on http://127.0.0.1:42522; explicit client injection required.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
  }).catch(error => { console.error(error.code === 'EADDRINUSE' ? 'Port 42522 occupied; no fallback or termination attempted.' : 'Application server unavailable.'); process.exitCode = 1; });
}
module.exports = { createApplicationServer, startApplication, allowed, stage1Route, parseLaunchArgs, LIMIT, RESPONSE_LIMIT, LAUNCH_HEADER };
