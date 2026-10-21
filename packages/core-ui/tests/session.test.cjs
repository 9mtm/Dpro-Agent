require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { SessionClient, createSameOriginTransport, allowedRequest, bindMemorySession } = require('../src/session.ts');
const { createLoginMock } = require('../src/session-mock.ts');
const { createSuggestionAdapter } = require('../src/naming.ts');
const { createMemoryAdapter, MemoryController } = require('../src/memory.ts');
const { App } = require('../src/App.tsx');
const owner = { id: 'owner-test', email: 'fiction@example.invalid', username: 'Fiction', role: 'owner', api_key: 'must-not-escape' };
const token = 'fictional-token';
const ok = body => ({ status: 200, body });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(handler = () => ok({})) {
  const calls = [];
  const transport = async r => { calls.push(r); if (r.path === '/api/auth/login') return ok({ user: owner, token, deviceToken: 'd'.repeat(43) }); if (r.path === '/api/auth/me') return ok({ user: owner }); return handler(r); };
  const client = new SessionClient({ mock: transport, live: transport });
  return { client, calls, async login(mode = 'mock') { client.selectMode(mode); await client.login('fiction@example.invalid', 'fictional-password'); assert.equal(client.getSnapshot().phase, 'authenticated'); } };
}

test('default fixture and absent auth make zero private requests; live requires supplied transport', async () => {
  const { client, calls } = setup();
  await client.login('x', 'y'); await assert.rejects(client.request({ method: 'GET', path: '/api/memory/proposals' }));
  assert.equal(calls.length, 0);
  const absent = new SessionClient(); absent.selectMode('live'); assert.equal(absent.getSnapshot().mode, 'fixture');
});
test('login exact body, Bearer me validation, safe user projection and memory-only token', async () => {
  const s = setup(); await s.login();
  assert.deepEqual(s.calls.map(r => [r.method, r.path]), [['POST', '/api/auth/login'], ['GET', '/api/auth/me']]);
  assert.deepEqual(s.calls[0].body, { email: 'fiction@example.invalid', password: 'fictional-password' });
  assert.deepEqual(s.calls[0].headers, {}); assert.deepEqual(s.calls[1].headers, { Authorization: `Bearer ${token}` });
  assert.equal(s.client.getSnapshot().user.api_key, undefined);
  assert.ok(!JSON.stringify(s.client).includes(token)); assert.ok(!JSON.stringify(s.client.getSnapshot()).includes(token));
});
for (const status of [400, 401, 403, 429, 500]) test(`login ${status} never succeeds or echoes server text`, async () => {
  const client = new SessionClient({ mock: async () => ({ status, body: { error: 'private-api-key' } }) }); client.selectMode('mock'); await client.login('x', 'y');
  assert.equal(client.getSnapshot().phase, 'signed-out'); assert.ok(!JSON.stringify(client.getSnapshot()).includes('private-api-key'));
});
for (const body of [{}, { token, user: owner, deviceToken: 'd'.repeat(43) }, { token: 'bad\r\nheader', user: owner }]) test(`malformed or unconfirmed login remains closed ${JSON.stringify(body).length}`, async () => {
  const client = new SessionClient({ mock: async r => r.path.endsWith('/login') ? ok(body) : ok({ user: { ...owner, id: 'other' } }) });
  client.selectMode('mock'); await client.login('x', 'y'); assert.equal(client.getSnapshot().phase, 'signed-out');
});
test('late login and pending me cannot resurrect fixture session', async () => {
  for (const path of ['/api/auth/login', '/api/auth/me']) {
    const pending = defer(); let request;
    const client = new SessionClient({ mock: async r => { if (r.path === path) { request = r; return pending.promise; } return ok({ token, user: owner, deviceToken: 'd'.repeat(43) }); } });
    client.selectMode('mock'); const login = client.login('x', 'y'); await Promise.resolve(); await Promise.resolve();
    client.selectMode('fixture'); assert.equal(request.signal.aborted, true); pending.resolve(ok({ token, user: owner, deviceToken: 'd'.repeat(43) })); await login;
    assert.equal(client.getSnapshot().mode, 'fixture'); assert.equal(client.getSnapshot().phase, 'signed-out');
  }
});
test('401 revocation clears user, invalidates pending read and blocks further private calls', async () => {
  const pending = defer(); let blocked;
  const s = setup(r => { if (r.path.endsWith('/p1')) { blocked = r; return pending.promise; } return { status: 401, body: { error: token } }; }); await s.login();
  const old = s.client.request({ method: 'GET', path: '/api/memory/proposals/p1' });
  const result = await s.client.request({ method: 'GET', path: '/api/memory/proposals' });
  assert.equal(result.body, null); assert.equal(s.client.getSnapshot().user, undefined); assert.ok(blocked.signal.aborted);
  pending.resolve(ok({ private: 'old' })); await assert.rejects(old, /cancelled/);
  await assert.rejects(s.client.request({ method: 'GET', path: '/api/memory/proposals' }), /blocked/);
});
test('403 clears scoped memory but does not log out the account', async () => {
  const s = setup(() => ({ status: 403, body: { error: 'secret' } })); await s.login();
  const c = new MemoryController(createMemoryAdapter(s.client.request), { userId: owner.id, agentId: 'agent1', drawerId: 'owner', access: 'owner', session: 'test' });
  await c.load(); assert.equal(c.getSnapshot().phase, 'denied'); assert.equal(c.getSnapshot().drawer, undefined); assert.deepEqual(c.getSnapshot().proposals, []);
  assert.equal(s.client.getSnapshot().phase, 'authenticated'); assert.ok(!c.adapter.decide);
});
test('request cancellation also rejects transports ignoring AbortSignal without logging out', async () => {
  const pending = defer(); const s = setup(() => pending.promise); await s.login();
  const abort = new AbortController(); const call = s.client.request({ method: 'GET', path: '/api/memory/proposals' }, abort.signal); abort.abort(); pending.resolve(ok({ secret: 'old' }));
  await assert.rejects(call, /cancelled/); assert.equal(s.client.getSnapshot().phase, 'authenticated');
});
test('logout clears protected session immediately, exact all-device request, no retry', async () => {
  const pending = defer(); const s = setup(() => pending.promise); await s.login();
  const logout = s.client.logoutAllDevices(); assert.equal(s.client.getSnapshot().user, undefined); assert.equal(s.client.getSnapshot().phase, 'signing-out');
  s.client.selectMode('live'); assert.equal(s.client.getSnapshot().mode, 'mock');
  const r = s.calls.at(-1); assert.equal(r.method, 'POST'); assert.equal(r.path, '/api/auth/logout'); assert.equal(r.body, undefined); assert.equal(r.headers.Authorization, `Bearer ${token}`);
  pending.resolve(ok({ success: true })); await logout; assert.equal(s.client.getSnapshot().notice, 'logout-confirmed'); assert.equal(s.calls.length, 3);
});
for (const response of [{ status: 401 }, { status: 403 }, { status: 500 }, ok({ success: false })]) test(`logout unknown stays local-only ${response.status} ${JSON.stringify(response.body)}`, async () => {
  const s = setup(() => response); await s.login(); await s.client.logoutAllDevices(); assert.equal(s.client.getSnapshot().notice, 'logout-unknown'); assert.equal(s.calls.length, 3);
});
test('network exception is sanitised, not retried, logout outcome unknown', async () => {
  const s = setup(() => { throw new Error('password-or-token'); }); await s.login(); await s.client.logoutAllDevices(); assert.equal(s.client.getSnapshot().notice, 'logout-unknown'); assert.equal(s.calls.length, 3);
});
test('live/fixture/mock switching drops pending protected results and no fallback auth', async () => {
  const pending = defer(); const s = setup(() => pending.promise); await s.login('live');
  const call = s.client.request({ method: 'GET', path: '/api/memory/proposals' }); s.client.selectMode('fixture'); s.client.selectMode('mock'); pending.resolve(ok({ private: true }));
  await assert.rejects(call, /cancelled/); assert.equal(s.client.getSnapshot().user, undefined); assert.equal(s.calls.length, 3);
});
test('URL/method/body allowlist rejects unsafe routes before transport', async () => {
  const s = setup(); await s.login();
  for (const path of ['https://evil.invalid/api/auth/me', '//evil.invalid/api/auth/me', '/api/auth/me?token=x', '/api/auth/me#x', '/api/auth/../auth/me', '/api//auth/me', '/api/memory/proposals/%2e%2e', '/api/memory/files/owner?agentId=a&url=x', '/api/memory/files/owner?agentId=a%2Fb', '/api/memory/files/project%253Aa?agentId=a', '/api/memory/files/owner?agentId=..', '/api/memory/proposals/p/approve', '/api/credentials']) {
    await assert.rejects(s.client.request({ method: 'GET', path }));
  }
  for (const request of [{ method: 'POST', path: '/api/memory/proposals/p/approve' }, { method: 'POST', path: '/api/auth/logout' }, { method: 'POST', path: '/api/agents/name-suggestion', body: { language: 'en', exclude: [], api_key: 'no' } }, { method: 'GET', path: '/api/auth/me', headers: { Authorization: 'override' } }]) await assert.rejects(s.client.request(request));
  assert.equal(s.calls.length, 2);
  assert.ok(allowedRequest('GET', '/api/memory/files/project%3Aalpha?agentId=agent-1'));
});
test('naming adapter uses authenticated exact contract without api_key', async () => {
  const s = setup(() => ok({ name: 'New draft', language: 'en', exhausted: false, api_key: 'hidden' })); await s.login();
  const result = await createSuggestionAdapter(s.client.request)('en', 'Old draft'); assert.deepEqual(result, { ok: true, value: { name: 'New draft', language: 'en', exhausted: false } });
  assert.deepEqual(s.calls.at(-1).body, { language: 'en', exclude: ['Old draft'] });
});
test('same-origin transport pins URL and request security flags', async () => {
  let call; const transport = createSameOriginTransport('http://127.0.0.1:42522', async (...args) => { call = args; return new Response(JSON.stringify({ user: owner }), { headers: { 'Content-Type': 'application/json' } }); });
  await transport({ method: 'GET', path: '/api/auth/me', headers: { Authorization: `Bearer ${token}` }, signal: new AbortController().signal });
  assert.equal(call[0], 'http://127.0.0.1:42522/api/auth/me');
  for (const [key, value] of Object.entries({ redirect: 'error', credentials: 'omit', mode: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' })) assert.equal(call[1][key], value);
  for (const origin of ['https://evil.invalid', 'http://localhost:42522', 'http://127.0.0.2:42522', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:42522/', 'http://user:pass@127.0.0.1:42522']) assert.throws(() => createSameOriginTransport(origin, async () => {}));
  // The desktop app's bridge listens on a random loopback port.
  assert.equal(typeof createSameOriginTransport('http://127.0.0.1:50550', async () => {}), 'function');
});
test('redirects, mismatched response URL, HTML, errors and unsafe headers fail closed', async () => {
  const r = { method: 'GET', path: '/api/auth/me', headers: { Authorization: `Bearer ${token}` }, signal: new AbortController().signal };
  for (const response of [new Response('', { status: 302, headers: { Location: 'https://evil.invalid' } }), { status: 200, redirected: true }, { status: 200, url: 'https://evil.invalid' }, new Response('<html>secret</html>')]) {
    const t = createSameOriginTransport('http://127.0.0.1:42522', async () => response); await assert.rejects(t(r), /unavailable/);
  }
  let count = 0; const t = createSameOriginTransport('http://127.0.0.1:42522', async () => { count++; return new Response('secret', { status: 403 }); });
  assert.deepEqual(await t(r), { status: 403, body: null });
  await assert.rejects(t({ ...r, headers: { Host: 'evil.invalid' } })); await assert.rejects(t({ ...r, headers: { Authorization: 'Bearer bad\r\n' } })); await assert.rejects(t({ ...r, headers: {} })); assert.equal(count, 1);
});
test('mock login is explicitly fictional and rejects wrong credentials', async () => {
  const client = new SessionClient({ mock: createLoginMock() }); client.selectMode('mock'); await client.login('wrong', 'wrong'); assert.equal(client.getSnapshot().phase, 'signed-out');
  await client.login('demo@example.invalid', 'mock-only'); assert.equal(client.getSnapshot().phase, 'authenticated'); await client.logoutAllDevices(); assert.equal(client.getSnapshot().notice, 'logout-confirmed');
});
test('shell renders fixture by default, login has no protected content, logout needs explicit confirmation', async () => {
  let html = renderToStaticMarkup(React.createElement(App)); assert.match(html, /Open offline login mock/); assert.doesNotMatch(html, /Use live sign-in/);
  const s = setup(() => ok({ setupComplete: true, setupRequired: false, message: 'Setup already completed' })); s.client.selectMode('mock'); await s.client.discoverSetup(); html = renderToStaticMarkup(React.createElement(App, { client: s.client })); assert.match(html, /Welcome to Dpro/); assert.doesNotMatch(html, /type="password"|Memory review/);
  await s.login(); html = renderToStaticMarkup(React.createElement(App, { client: s.client })); assert.match(html, /disabled="">Sign out on all devices/); assert.match(html, /class="dk-mem" aria-label="Memory"/); assert.doesNotMatch(html, /must-not-escape|fictional-token|Mira/);
});

test('late old 401 cannot revoke a newer authenticated session', async () => {
  const pending = defer(); const s = setup(() => pending.promise); await s.login();
  const old = s.client.request({ method: 'GET', path: '/api/memory/proposals' });
  await s.client.login('fiction@example.invalid', 'new-fictional-password'); const current = s.client.getSnapshot();
  pending.resolve({ status: 401, body: null }); await assert.rejects(old, /cancelled/);
  assert.equal(s.client.getSnapshot(), current); assert.equal(current.phase, 'authenticated');
});
test('cancelled logout cannot erase a later mock session; uncertainty is explicit', async () => {
  const pending = defer(); const s = setup(() => pending.promise); await s.login();
  const logout = s.client.logoutAllDevices(); s.client.cancel(); assert.equal(s.client.getSnapshot().notice, 'logout-unknown');
  await s.client.login('fiction@example.invalid', 'new-fictional-password'); const current = s.client.getSnapshot();
  pending.resolve(ok({ success: true })); await logout; assert.equal(s.client.getSnapshot(), current);
});
test('real fetch refuses fictional loopback redirect; sink receives neither request nor bearer', async t => {
  const http = require('node:http'); const { once } = require('node:events');
  let sinkHits = 0;
  const sink = http.createServer((req, res) => { sinkHits++; res.end('never'); });
  const source = http.createServer((req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${sink.address().port}/sink` }); res.end(); });
  for (const server of [sink, source]) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })); }
  // Test-only injected fetch reroutes exclusively to a fictional port-0 server, never to 42522.
  const transport = createSameOriginTransport('http://127.0.0.1:42522', (_url, init) => fetch(`http://127.0.0.1:${source.address().port}/redirect`, init));
  await assert.rejects(transport({ method: 'GET', path: '/api/auth/me', headers: { Authorization: 'Bearer fictional-only' }, signal: new AbortController().signal }), /unavailable/);
  assert.equal(sinkHits, 0);
});

for (const transition of ['fixture', 'logout', '401', 'relogin']) test(`memory session binding clears loaded data synchronously without unmount: ${transition}`, async () => {
  const s = setup(r => r.path === '/api/memory/proposals/revoked' ? { status: 401, body: null } : ok({ success: true })); await s.login();
  const drawer = { drawerId: 'owner', agentId: 'agent1', revision: 1, hash: 'a'.repeat(64), count: 1, path: 'fictional', content: 'private fictional content' };
  const controller = new MemoryController({ mode: 'contract', drawer: async () => drawer, list: async () => [], detail: async () => { throw new Error('unused'); } }, { userId: owner.id, agentId: 'agent1', drawerId: 'owner', access: 'owner', session: 'old' });
  const stop = bindMemorySession(s.client, controller); await controller.load(); assert.equal(controller.getSnapshot().drawer.content, drawer.content);
  const oldEpoch = s.client.getSnapshot().epoch;
  if (transition === 'fixture') s.client.selectMode('fixture');
  if (transition === 'logout') await s.client.logoutAllDevices();
  if (transition === '401') await s.client.request({ method: 'GET', path: '/api/memory/proposals/revoked' });
  if (transition === 'relogin') await s.client.login('fiction@example.invalid', 'another-fictional-password');
  assert.ok(s.client.getSnapshot().epoch > oldEpoch);
  const memory = controller.getSnapshot(); assert.equal(memory.drawer, undefined); assert.equal(memory.detail, undefined); assert.equal(memory.review, undefined); assert.deepEqual(memory.proposals, []);
  assert.equal(memory.context.session, String(s.client.getSnapshot().epoch)); stop();
});
test('memory-originated 401 resets session and bound controller; pending read cannot repopulate it', async () => {
  const pending = defer(); let delay = true;
  const s = setup(() => delay ? pending.promise : { status: 401, body: null }); await s.login();
  const controller = new MemoryController(createMemoryAdapter(s.client.request), { userId: owner.id, agentId: 'agent1', drawerId: 'owner', access: 'owner', session: 'old' });
  const stop = bindMemorySession(s.client, controller); const old = controller.load();
  delay = false; await controller.load();
  assert.equal(s.client.getSnapshot().phase, 'signed-out'); assert.equal(controller.getSnapshot().phase, 'denied');
  pending.resolve(ok({ drawerId: 'owner', agentId: 'agent1', drawer: { kind: 'owner' }, revision: 1, hash: 'a'.repeat(64), count: 0, path: 'fictional', content: 'stale secret' })); await old;
  assert.equal(controller.getSnapshot().drawer, undefined); assert.equal(controller.getSnapshot().context.userId, ''); stop();
});
test('the name typed at setup is shown; missing or odd names fall back to the user name', async () => {
  const { displayName } = require('../src/session.ts');
  const cases = [['  Mohamed Alarade  ', 'Mohamed Alarade'], ['', 'Fiction'], ['   ', 'Fiction'], [42, 'Fiction'], ['x'.repeat(201), 'Fiction'], [undefined, 'Fiction']];
  for (const [fullName, shown] of cases) {
    const named = { ...owner, ...(fullName === undefined ? {} : { full_name: fullName }) };
    const transport = async r => ok(r.path === '/api/auth/login' ? { user: named, token, deviceToken: 'd'.repeat(43) } : { user: named });
    const client = new SessionClient({ mock: transport, live: transport }); client.selectMode('mock');
    await client.login('fiction@example.invalid', 'fictional-password');
    const user = client.getSnapshot().user;
    assert.equal(displayName(user), shown);
    assert.equal(user.api_key, undefined);
    assert.ok(Object.isFrozen(user));
  }
});
