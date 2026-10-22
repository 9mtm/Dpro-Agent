// S0-A.1 / S0-A.2 / S0-A.11: global deny-by-default auth gate.
// Builds the real app (buildServer(), same as server.ts, without listening),
// enumerates EVERY registered route and checks who may reach it.
// Run: node --import tsx --test test/route-auth-gate.test.mjs
// Throwaway DB + cwd, random test-only secrets, fetch stubbed (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-route-gate-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

const quiet = { log: console.log, warn: console.warn, info: console.info };
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role, status = 'active') =>
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, ?, 1)`)
    .run(id, `${id}@example.test`, id, role, status);
addUser('g-owner', 'owner');
addUser('g-admin', 'admin');
addUser('g-member', 'user');
addUser('g-guest', 'guest');
addUser('g-off', 'owner', 'inactive');
addUser('g-susp', 'user', 'suspended');

const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { inboxRoutes } = await import(join(backendDir, 'src/api/routes/inbox.ts'));
const { createExtensionRouteGuard } = await import(join(backendDir, 'src/plugins/extension-route-access.ts'));
const gate = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { beginChannelTurn, CHANNEL_TURN_HEADER } = await import(join(backendDir, 'src/tools/channel-policy.ts'));

const { createInboxSystem } = await import(join(backendDir, 'src/inbox/index.ts'));
const app = await buildServer({ logger: false });
// Registered in server.ts start() after the inbox system initializes.
const inbox = createInboxSystem(db);
app.decorate('inboxGateway', inbox.inboxGateway);
app.decorate('messageStore', inbox.messageStore);
app.decorate('riskAnalyzer', inbox.riskAnalyzer);
app.decorate('approvalEngine', inbox.approvalEngine);
await app.register(inboxRoutes);
// An extension scope exactly as extension-runner.ts mounts one.
await app.register(async (scope) => {
  scope.addHook('onRequest', createExtensionRouteGuard({ id: 'demo' }, '/api/ext/demo'));
  scope.get('/status', async () => ({ ok: true }));
}, { prefix: '/api/ext/demo' });
await app.ready();

console.log = quiet.log;
console.info = quiet.info;
console.warn = quiet.warn;

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const bearer = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const concrete = (pattern) => pattern.replace(/:[A-Za-z0-9_]+/g, 'test-param').replace(/\*/g, 'x');
const routes = app.routeAccessTable.filter((r) => r.method !== 'HEAD' && r.method !== 'OPTIONS');
const send = (r, headers = {}) => app.inject({ method: r.method, url: concrete(r.url), headers });
const GATE_401 = 'Authentication required';
const byGate = (res) => res.statusCode === 401 && res.json().error === GATE_401;
const label = (r) => `${r.method} ${r.url}`;

test('route table: every route has a known access level and the app is not tiny', () => {
  assert.ok(routes.length > 500, `only ${routes.length} routes collected`);
  for (const r of routes) {
    assert.ok(['public', 'optional', 'service', 'user', 'admin', 'owner', 'extension'].includes(r.access), label(r));
  }
  // Only the allow-list can be public / optional (S0-A.11).
  for (const r of routes.filter((x) => x.access === 'public')) {
    const k = `${r.method} ${r.url}`;
    assert.ok(gate.PUBLIC_ROUTES.has(k), `unexpected public route ${k}`);
  }
  for (const r of routes.filter((x) => x.access === 'optional')) {
    assert.ok(gate.OPTIONAL_ROUTES.has(`${r.method} ${r.url}`), `unexpected optional route ${label(r)}`);
  }
});

test('anonymous: every non-allow-listed route answers 401', async () => {
  const guarded = routes.filter((r) => !['public', 'optional', 'extension'].includes(r.access));
  const leaks = [];
  for (const r of guarded) {
    const res = await send(r);
    if (res.statusCode !== 401) leaks.push(`${label(r)} -> ${res.statusCode}`);
  }
  assert.deepEqual(leaks, []);
  assert.ok(guarded.length > 480, `guarded ${guarded.length}`);
  console.log(`[route-auth-gate] routes: ${routes.length} total, ${guarded.length} need a token, ` +
    `${routes.filter((r) => r.access === 'public').length} public, ${routes.filter((r) => r.access === 'optional').length} optional, ` +
    `${routes.filter((r) => r.access === 'extension').length} extension-guarded`);
});

test('bad, disabled and suspended tokens get 401 on every guarded route; guests get 403', async () => {
  const guarded = routes.filter((r) => !['public', 'optional', 'extension'].includes(r.access));
  const wrong = [];
  for (const r of guarded) {
    for (const [who, headers, want] of [
      ['bad', { authorization: 'Bearer not.a.jwt' }, 401],
      ['inactive owner', bearer('g-off'), 401],
      ['suspended user', bearer('g-susp'), 401],
    ]) {
      const res = await send(r, headers);
      if (res.statusCode !== want) wrong.push(`${who}: ${label(r)} -> ${res.statusCode}`);
    }
    const isGuestRoute = gate.guestMayUse(r.method, r.url);
    if (!isGuestRoute) {
      const res = await send(r, bearer('g-guest'));
      if (res.statusCode !== 403) wrong.push(`guest: ${label(r)} -> ${res.statusCode}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('CL-06: guest tokens get 403 on every optional route outside the public-room set', async () => {
  const wrong = [];
  for (const r of routes.filter((x) => x.access === 'optional' && !gate.guestMayUse(x.method, x.url))) {
    const res = await send(r, bearer('g-guest'));
    if (res.statusCode !== 403) wrong.push(`guest: ${label(r)} -> ${res.statusCode}`);
  }
  assert.deepEqual(wrong, []);
  const pw = await app.inject({ method: 'POST', url: '/api/auth/change-password', headers: bearer('g-guest'), payload: {} });
  assert.equal(pw.statusCode, 403, 'guests: only who-am-I, logout and public rooms');
});

test('public routes answer without a token', async () => {
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/setup/status' })).statusCode, 200);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@example.test', password: 'wrong-password-123' } });
  assert.ok(!byGate(login), `login rejected by the gate: ${login.statusCode} ${login.body}`);
  const i18n = await app.inject({ method: 'GET', url: '/api/extensions/demo/i18n/en' });
  assert.ok(!byGate(i18n), `i18n: ${i18n.statusCode}`);
  const stat = await app.inject({ method: 'GET', url: '/no-such-static-file.txt' });
  assert.equal(stat.statusCode, 404);
  // GET only: the public POST routes are login and the setup wizard (whose
  // handlers would act); their level is checked in the route-table test.
  for (const r of routes.filter((x) => x.access === 'public' && x.method === 'GET')) {
    const res = await send(r);
    assert.ok(!byGate(res), `${label(r)} rejected by the gate`);
  }
});

test('optional routes: anonymous passes the gate, a bad token is refused', async () => {
  for (const r of routes.filter((x) => x.access === 'optional')) {
    const anon = await send(r);
    assert.ok(!byGate(anon), `${label(r)} anonymous -> ${anon.statusCode}`);
    assert.equal((await send(r, { authorization: 'Bearer not.a.jwt' })).statusCode, 401, `${label(r)} bad token`);
    assert.equal((await send(r, bearer('g-off'))).statusCode, 401, `${label(r)} inactive`);
  }
});

test('unknown routes still answer 404, CORS preflight is not blocked', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/does-not-exist' })).statusCode, 404);
  const pre = await app.inject({
    method: 'OPTIONS', url: '/api/agents',
    headers: { origin: 'http://localhost:41521', 'access-control-request-method': 'GET' },
  });
  assert.equal(pre.statusCode, 204);
});

test('extension routes are skipped by the gate but their own guard still denies', async () => {
  assert.ok(routes.some((r) => r.access === 'extension' && r.url === '/api/ext/demo/status'));
  assert.equal((await app.inject({ method: 'GET', url: '/api/ext/demo/status' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/ext/demo/status', headers: bearer('g-member') })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/ext/demo/status', headers: bearer('g-owner') })).statusCode, 200);
});

test('signed-in active users reach ordinary routes; the gate attaches nothing from the body', async () => {
  for (const id of ['g-owner', 'g-admin', 'g-member']) {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(id) });
    assert.equal(res.statusCode, 200, id);
  }
  const guestMe = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer('g-guest') });
  assert.equal(guestMe.statusCode, 200, 'guest may see who they are');
});

test('POST /api/chat: live channel-turn token passes the gate, unknown token is refused', async () => {
  const forged = await app.inject({ method: 'POST', url: '/api/chat', headers: { [CHANNEL_TURN_HEADER]: 'f'.repeat(64) }, payload: {} });
  assert.equal(forged.statusCode, 401);
  const turn = beginChannelTurn({ channel: 'telegram', conversationId: 'c1' }, 'g-owner');
  try {
    // Empty messages: the route answers 400 after the gate let it through.
    const live = await app.inject({ method: 'POST', url: '/api/chat', headers: { [CHANNEL_TURN_HEADER]: turn.token }, payload: { messages: [] } });
    assert.equal(live.statusCode, 400, live.body);
  } finally {
    turn.end();
  }
  const ended = await app.inject({ method: 'POST', url: '/api/chat', headers: { [CHANNEL_TURN_HEADER]: turn.token }, payload: {} });
  assert.equal(ended.statusCode, 401);
});

// --- S0-A.2: role tiers -----------------------------------------------------

const OWNER_ONLY = [
  // S1.3: held agent tool calls
  ['GET', '/api/approvals'], ['GET', '/api/approvals/:id'], ['POST', '/api/approvals/:id/approve'], ['POST', '/api/approvals/:id/deny'],
  // S1.4: agent permissions
  ['GET', '/api/agents/:id/tool-grants'], ['PUT', '/api/agents/:id/tool-grants'],
  // CORE-PERMS-01: memory scope + off/ask/allow per agent
  ['GET', '/api/agents/:id/permissions'], ['PUT', '/api/agents/:id/permissions'],
  // BOARD-01: the company task board
  ['GET', '/api/boards'], ['GET', '/api/boards/:id'], ['POST', '/api/boards/:id/cards'], ['PUT', '/api/boards/:id/cards/:cardId'],
  ['POST', '/api/boards/:id/cards/:cardId/comments'],
  // CORE-01: versioned personality
  ['GET', '/api/agents/:id/personality/current'], ['GET', '/api/agents/:id/personality/versions'],
  ['POST', '/api/agents/:id/personality/versions'], ['POST', '/api/agents/:id/personality/lock'],
  ['POST', '/api/agents/:id/personality/unlock'], ['POST', '/api/agents/:id/personality/rollback'],
  // CORE-01c: drift proposals are reviewed and decided by the owner only
  ['GET', '/api/agents/:id/personality/proposals'], ['GET', '/api/agents/:id/personality/proposals/:pid'],
  ['POST', '/api/agents/:id/personality/proposals/:pid/approve'], ['POST', '/api/agents/:id/personality/proposals/:pid/reject'],
  ['POST', '/api/evolution/:agentId/personality-proposal'], // CORE-01d: run the Evolution drift rule on demand
  // S0-Q.23: every Evolution route that changes state is owner-only
  ['POST', '/api/evolution/:agentId/evolve'], ['POST', '/api/evolution/evolve-all'], ['POST', '/api/evolution/:agentId/analyze'],
  ['POST', '/api/evolution/:agentId/rollback/:evolutionId'], ['PUT', '/api/evolution/:agentId/config'],
  ['POST', '/api/evolution/:agentId/measure/:evolutionId'],
  ['POST', '/api/evolution/:agentId/proposals/:proposalId/approve'], ['POST', '/api/evolution/:agentId/proposals/:proposalId/reject'],
  ['POST', '/api/evolution/:agentId/proposals/:proposalId/cancel'],
  // CORE-04: memory files + reviewed proposals
  ['GET', '/api/memory/files'], ['GET', '/api/memory/files/:drawer'], ['GET', '/api/memory/files/:drawer/versions'],
  ['POST', '/api/memory/files/:drawer/export'], ['POST', '/api/memory/files/:drawer/proposal'],
  ['GET', '/api/memory/proposals'], ['GET', '/api/memory/proposals/:id'],
  ['POST', '/api/memory/proposals/:id/approve'], ['POST', '/api/memory/proposals/:id/reject'],
  // CORE-05: weekly learning summary
  ['GET', '/api/memory/weekly-summary'], ['POST', '/api/memory/weekly-summary/run'],
  // CORE-07: forget-all + retention rules
  ['POST', '/api/memory/forget-all'], ['GET', '/api/memory/retention'], ['PUT', '/api/memory/retention'], ['POST', '/api/memory/retention/run'],
  // CORE-06: embedding model status + re-embed job
  ['GET', '/api/memory/embeddings'], ['POST', '/api/memory/embeddings/reembed'],
  // CLI-02: safe import pipeline
  ['GET', '/api/memory/import/settings'], ['PUT', '/api/memory/import/settings'], ['POST', '/api/memory/import/preview'],
  ['GET', '/api/memory/import'], ['GET', '/api/memory/import/:id'], ['POST', '/api/memory/import/:id/revise'],
  ['POST', '/api/memory/import/:id/commit'], ['POST', '/api/memory/import/:id/cancel'],
  // M1: MCP client server registry (starts processes / reaches URLs for agents)
  ['GET', '/api/mcp/servers'], ['POST', '/api/mcp/servers'], ['GET', '/api/mcp/servers/:id'], ['PUT', '/api/mcp/servers/:id'],
  ['DELETE', '/api/mcp/servers/:id'], ['POST', '/api/mcp/servers/:id/enable'], ['POST', '/api/mcp/servers/:id/disable'],
  ['POST', '/api/mcp/servers/:id/refresh'], ['PUT', '/api/mcp/servers/:id/tools/:tool'],
  // CORE-08: owner decides an interrupted step's outcome
  ['POST', '/api/task-runs/:id/steps/:index/resolve'],
  ['POST', '/api/database/query'], ['POST', '/api/database/restore'], ['GET', '/api/database/stats'],
  ['POST', '/api/sandbox/execute'], ['PUT', '/api/sandbox/config'],
  ['POST', '/api/system/restart'],
  ['POST', '/api/browser/sessions'], ['POST', '/api/browser/sessions/:id/evaluate'],
  ['GET', '/api/claude-local/sessions'],
  ['POST', '/api/encryption/keys/rotate'], ['POST', '/api/vault/credentials'],
  ['POST', '/api/gateway/message'], ['GET', '/api/gateway/sessions/:userId'],
  ['POST', '/api/ai-tools/:id/install'],
  ['POST', '/api/scheduler/jobs'], ['POST', '/api/scheduler/jobs/:id/run'],
  ['POST', '/api/workflows'], ['POST', '/api/workflows/:id/execute'],
  ['PUT', '/api/audit/config'], ['POST', '/api/audit/cleanup'],
];
const OWNER_OR_ADMIN = [
  ['POST', '/api/marketplace/install'], ['POST', '/api/marketplace/uninstall'], ['POST', '/api/marketplace/process-update/:id'],
  ['POST', '/api/webhooks'], ['POST', '/api/webhooks/:id/test'], ['POST', '/api/webhooks/trigger'], ['GET', '/api/webhooks'],
  ['POST', '/api/telephony/numbers/purchase'], ['POST', '/api/telephony/calls/make'], ['GET', '/api/telephony/sessions'],
  ['GET', '/api/audit/events'], ['GET', '/api/scheduler/jobs'], ['GET', '/api/workflows'],
  ['POST', '/api/channels/:id/send'], ['GET', '/api/channels/whatsapp/qr'],
  ['POST', '/api/plugins/:id/enable'],
  ['POST', '/api/agents'], ['PUT', '/api/agents/:id'], ['POST', '/api/agents/:id/set-primary'],
  ['POST', '/api/agents/name-suggestion'], // CORE-02
  ['POST', '/api/agents/:id/personality/proposals'], // CORE-01c: propose drift (owner decides)
  ['POST', '/api/agents/:id/personality/proposals/:pid/cancel'], // CORE-01d: owner, or the owner/admin who proposed it
  ['PUT', '/api/agents/:id/personality'], ['PUT', '/api/agents/:id/memory'], ['GET', '/api/agents/:id/memory'],
  ['GET', '/api/evolution/:agentId/status'], ['GET', '/api/evolution/:agentId/history'], // S0-Q.23: reads stay admin
  ['GET', '/api/evolution/:agentId/proposals'], ['GET', '/api/evolution/:agentId/proposals/:proposalId'],
  ['POST', '/api/multi-agent/agents'],
  ['PUT', '/api/heartbeat/config'], ['POST', '/api/cost-analytics/cleanup'], ['POST', '/api/inbox/cleanup'],
  ['GET', '/api/dashboard/widgets/team-members'], ['GET', '/api/ai-tools'],
];

test('tier table: owner-only and owner/admin routes resolve as designed', () => {
  for (const [m, u] of OWNER_ONLY) {
    assert.ok(routes.some((r) => r.method === m && r.url === u), `route exists: ${m} ${u}`);
    assert.equal(gate.resolveRouteAccess(m, u), 'owner', `${m} ${u}`);
  }
  for (const [m, u] of OWNER_OR_ADMIN) {
    assert.ok(routes.some((r) => r.method === m && r.url === u), `route exists: ${m} ${u}`);
    assert.equal(gate.resolveRouteAccess(m, u), 'admin', `${m} ${u}`);
  }
  // A route's own config can raise but never lower the level.
  assert.equal(gate.resolveRouteAccess('GET', '/api/profile', 'owner'), 'owner');
  assert.equal(gate.resolveRouteAccess('POST', '/api/database/query', 'public'), 'owner');
  assert.equal(gate.resolveRouteAccess('GET', '/api/profile', 'public'), 'user');
  assert.equal(gate.resolveRouteAccess('GET', '/api/profile', 'nonsense'), 'owner');
});

test('tiers enforced: user/admin tokens get 403 where the tier is higher (handlers never run)', async () => {
  const wrong = [];
  for (const [m, u] of OWNER_ONLY) {
    for (const id of ['g-member', 'g-admin']) {
      const res = await app.inject({ method: m, url: concrete(u), headers: bearer(id), payload: {} });
      if (res.statusCode !== 403) wrong.push(`${id} ${m} ${u} -> ${res.statusCode}`);
    }
  }
  for (const [m, u] of OWNER_OR_ADMIN) {
    const res = await app.inject({ method: m, url: concrete(u), headers: bearer('g-member'), payload: {} });
    if (res.statusCode !== 403) wrong.push(`member ${m} ${u} -> ${res.statusCode}`);
  }
  assert.deepEqual(wrong, []);
});

test('tiers enforced: the owner passes the gate (safe read-only routes)', async () => {
  for (const url of ['/api/database/tables', '/api/audit/status', '/api/scheduler/jobs', '/api/webhooks/status']) {
    const res = await app.inject({ method: 'GET', url, headers: bearer('g-owner') });
    assert.ok(res.statusCode !== 401 && res.statusCode !== 403, `${url} -> ${res.statusCode} ${res.body.slice(0, 200)}`);
  }
  const admin = await app.inject({ method: 'GET', url: '/api/audit/status', headers: bearer('g-admin') });
  assert.ok(admin.statusCode !== 401 && admin.statusCode !== 403, `admin audit status -> ${admin.statusCode}`);
});

// --- S0-A.9: Swagger only in development ------------------------------------

test('registered paper reads default to demo availability without provisioning a ledger', async () => {
  const res = await app.inject({method:'GET',url:'/api/trading-paper/availability',headers:bearer('g-owner')});
  assert.equal(res.statusCode,200);
  assert.equal(res.headers['cache-control'],'no-store');
  assert.deepEqual(res.json(),{appId:'trading',version:'1.0.0',mode:'paper',state:'demo_only',readAccounts:false,executeOrders:false});
  const detail = await app.inject({method:'GET',url:'/api/trading-paper/accounts/paper-one',headers:bearer('g-owner')});
  assert.equal(detail.statusCode,503);
});

test('Swagger UI and spec are not registered outside development', async () => {
  for (const url of ['/docs', '/docs/json', '/docs/yaml', '/docs/static/index.html']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, `${url} -> ${res.statusCode}`);
  }
  assert.ok(!routes.some((r) => r.url.startsWith('/docs')), 'no /docs routes');
  // If they are registered (development), the gate treats them as public only there.
  const saved = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    assert.equal(gate.resolveRouteAccess('GET', '/docs/json'), 'public');
    process.env.NODE_ENV = 'production';
    assert.equal(gate.resolveRouteAccess('GET', '/docs/json'), 'admin');
  } finally {
    process.env.NODE_ENV = saved;
  }
});

// --- S0-A.10: anonymous public chat is rate limited -------------------------

test('anonymous public-chat post over the limit gets 429 (before any model call)', async () => {
  db.prepare(`INSERT INTO public_chat_rooms (id, name, owner_user_id, is_public, require_auth) VALUES ('room-pub', 'Pub', 'g-owner', 1, 0)`).run();
  // CL-07: anonymous access is off by default; the owner turns it on in Settings.
  const { getSettingsManager } = await import(join(backendDir, 'src/settings/index.ts'));
  const off = await app.inject({ method: 'POST', url: '/api/public-chat/rooms/room-pub/messages', payload: { content: 'hi' } });
  assert.equal(off.statusCode, 404, 'anonymous refused while the setting is off');
  await getSettingsManager().updateSettings({ publicRooms: { allowAnonymous: true } });
  process.env.PUBLIC_CHAT_ANON_PER_IP_PER_MIN = '0';
  try {
    const res = await app.inject({ method: 'POST', url: '/api/public-chat/rooms/room-pub/messages', payload: { content: 'hi' } });
    assert.equal(res.statusCode, 429, res.body);
    assert.ok(Number(res.headers['retry-after']) > 0);
    const empty = await app.inject({ method: 'POST', url: '/api/public-chat/rooms/room-pub/messages', payload: {} });
    assert.equal(empty.statusCode, 400, 'missing content is a 400, not a crash');
  } finally {
    delete process.env.PUBLIC_CHAT_ANON_PER_IP_PER_MIN;
    await getSettingsManager().updateSettings({ publicRooms: { allowAnonymous: false } });
  }
});


test('real application registers every reviewer endpoint with explicit human or owner access',()=>{
 const reviewer=routes.filter(r=>/^\/api\/reviewer-(policies|requests|votes)(?:\/|$)/.test(r.url));
 assert.equal(reviewer.length,19);
 const expected=[['GET','/api/reviewer-policies'],['GET','/api/reviewer-policies/eligible-humans'],['GET','/api/reviewer-policies/:id'],['GET','/api/reviewer-policies/:id/draft'],['PUT','/api/reviewer-policies/:id/draft']];
 for(const action of ['activate','revoke'])for(const phase of ['preview','challenge','complete','apply'])expected.push(['POST','/api/reviewer-policies/:id/'+action+'/'+phase]);
 for(const [method,url]of expected)assert.ok(reviewer.some(r=>r.method===method&&r.url===url&&r.access==='owner'),method+' '+url);
 for(const url of ['/api/reviewer-requests/policies','/api/reviewer-requests/:policyId','/api/reviewer-requests/:policyId/:approvalId'])assert.ok(reviewer.some(r=>r.method==='GET'&&r.url===url&&r.access==='user'),url);
 for(const phase of ['challenge','complete','cast'])assert.ok(reviewer.some(r=>r.method==='POST'&&r.url==='/api/reviewer-votes/'+phase&&r.access==='user'),phase);
});

test('registered application reviewer routes accept enrolled humans and keep owner management private',async()=>{
 const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');
 const {hotp,decodeSecret}=await import('../src/auth/verification/totp.ts');
 for(const [id,role]of [['g-review-owner','owner'],['g-review-human','user']]){
  addUser(id,role);const when=Date.now()-60000,context={userId:id,tokenVersion:1,sessionHash:'f'.repeat(64)},pending=await beginEnrollment(context,when);
  await activateEnrollment(context,hotp(decodeSecret(pending.secret),BigInt(Math.floor(when/30000))),when);
 }
 const owner={authorization:'Bearer '+generateToken('g-review-owner',2)},human={authorization:'Bearer '+generateToken('g-review-human',2)};
 const inventory=await app.inject({method:'GET',url:'/api/reviewer-policies',headers:owner});assert.equal(inventory.statusCode,200,inventory.body);assert.deepEqual(inventory.json(),{items:[],nextCursor:null});assert.equal(inventory.headers['cache-control'],'no-store');
 const assigned=await app.inject({method:'GET',url:'/api/reviewer-requests/policies',headers:human});assert.equal(assigned.statusCode,200,assigned.body);assert.deepEqual(assigned.json(),{policies:[]});assert.equal(assigned.headers['cache-control'],'no-store');
 assert.equal((await app.inject({method:'GET',url:'/api/reviewer-policies',headers:human})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/reviewer-votes/challenge',headers:{...human,origin:'http://untrusted.invalid'},payload:{userId:'g-review-owner'}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/reviewer-votes/challenge',headers:{...human,origin:'http://localhost:41521'},payload:{userId:'g-review-owner'}})).statusCode,400);
});

test('reviewed skill installation routes are owner-only in the registered application',async()=>{
 const base='/api/skills/reviewed-installs';
 const expected=[['GET',base+'/catalogue'],['POST',base+'/stage'],['GET',base+'/:id'],...['challenge','complete','apply'].map(p=>['POST',base+'/:id/'+p])];
 const installed=routes.filter(r=>r.url.startsWith(base));assert.equal(installed.length,6);
 for(const [method,url]of expected)assert.ok(installed.some(r=>r.method===method&&r.url===url&&r.access==='owner'),method+' '+url);
 const {beginEnrollment,activateEnrollment}=await import('../src/auth/verification/enrollment.ts');
 const {hotp,decodeSecret}=await import('../src/auth/verification/totp.ts');
 for(const id of ['g-install-owner','g-install-other']){
  addUser(id,'owner');const when=Date.now()-60000,context={userId:id,tokenVersion:1,sessionHash:'e'.repeat(64)},pending=await beginEnrollment(context,when);
  await activateEnrollment(context,hotp(decodeSecret(pending.secret),BigInt(Math.floor(when/30000))),when);
 }
 const owner={authorization:'Bearer '+generateToken('g-install-owner',2),origin:'http://localhost:41521'};
 const other={authorization:'Bearer '+generateToken('g-install-other',2),origin:'http://localhost:41521'};
 const previousFetch=globalThis.fetch;let contacted=0;globalThis.fetch=async()=>{contacted++;throw new Error('Unexpected source contact');};
 try{
  const badOrigin=await app.inject({method:'POST',url:base+'/stage',headers:{...owner,origin:'http://untrusted.invalid'},payload:{}});assert.equal(badOrigin.statusCode,403);
  const noFactor=await app.inject({method:'POST',url:base+'/stage',headers:{...bearer('g-owner'),origin:owner.origin},payload:{}});assert.equal(noFactor.statusCode,403);
  for(let i=0;i<5;i++){const r=await app.inject({method:'POST',url:base+'/stage',headers:owner,payload:{}});assert.equal(r.statusCode,400,r.body);assert.equal(r.headers['cache-control'],'no-store');}
  const limited=await app.inject({method:'POST',url:base+'/stage',headers:owner,payload:{}});assert.equal(limited.statusCode,429,limited.body);assert.ok(limited.headers['retry-after']);assert.equal(limited.json().code,'rate_limited');assert.equal(limited.body.includes('password'),false);
  const separate=await app.inject({method:'POST',url:base+'/stage',headers:other,payload:{}});assert.equal(separate.statusCode,400,separate.body);
  const read=await app.inject({method:'GET',url:base+'/00000000-0000-4000-8000-000000000000',headers:other});assert.equal(read.statusCode,404,read.body);assert.equal(read.headers['cache-control'],'no-store');
  for(let i=0;i<5;i++){const r=await app.inject({method:'GET',url:base+'/catalogue?extra=1',headers:owner});assert.equal(r.statusCode,400,r.body);}
  const catalogueLimit=await app.inject({method:'GET',url:base+'/catalogue?extra=1',headers:owner});assert.equal(catalogueLimit.statusCode,429,catalogueLimit.body);assert.ok(catalogueLimit.headers['retry-after']);
  assert.equal((await app.inject({method:'GET',url:base+'/catalogue?extra=1',headers:other})).statusCode,400);
  assert.equal(contacted,0);
 }finally{globalThis.fetch=previousFetch;}
});
