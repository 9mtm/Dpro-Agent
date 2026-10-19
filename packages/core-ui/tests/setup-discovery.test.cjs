require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const http = require('node:http');
const { SessionClient, createSameOriginTransport, allowedRequest } = require('../src/session.ts');
const { createLoginMock } = require('../src/session-mock.ts');
const { AuthBoundary } = require('../src/AuthBoundary.tsx');
const { setupStatus } = require('../src/setup-status.js');
const { createApplicationServer, allowed } = require('../scripts/application-server.cjs');
const path = '/api/setup/status';
const complete = { setupComplete: true, setupRequired: false, message: 'Setup already completed' };
const required = { setupComplete: false, setupRequired: true, message: 'Setup required' };
const ok = body => ({ status: 200, body });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { resolve, promise }; };
const render = client => renderToStaticMarkup(React.createElement(AuthBoundary, { client, initialPage: 'account' }, 'fictional workspace'));
function clientFor(transport, mode = 'mock') {
  const calls = [];
  const client = new SessionClient({ [mode]: async r => { calls.push(r); return transport(r); } });
  return { client, calls, mode };
}

for (const scenario of ['first-run', 'existing-owner', 'error']) test(`offline discovery ${scenario}: exact anonymous call, honest UI, no implicit auth`, async () => {
  const s = clientFor(createLoginMock(undefined, scenario));
  await s.client.discoverSetup(); render(s.client); assert.equal(s.calls.length, 0);
  s.client.selectMode(s.mode); render(s.client); assert.equal(s.calls.length, 0);
  assert.doesNotMatch(render(s.client), /type="password"/);
  await s.client.discoverSetup();
  assert.equal(s.calls.length, 1); const r = s.calls[0];
  assert.equal(r.method, 'GET'); assert.equal(r.path, path); assert.deepEqual(r.headers, {}); assert.equal(r.body, undefined);
  const state = s.client.getSnapshot(); assert.equal(state.phase, 'signed-out'); assert.equal(state.user, undefined);
  assert.equal(state.setup, scenario === 'first-run' ? 'required' : scenario === 'error' ? 'unavailable' : 'login');
  await assert.rejects(s.client.request({ method: 'GET', path: '/api/auth/me' }), /blocked/);
  await assert.rejects(s.client.request({ method: 'GET', path: '/api/memory/proposals' }), /blocked/);
  const html = render(s.client); assert.doesNotMatch(html, /Signed in as|aria-label="Memory review"/);
  if (scenario === 'existing-owner') {
    assert.match(html, /Setup reports complete/); assert.match(html, /type="password"/);
    await s.client.login('wrong', 'wrong'); assert.equal(s.client.getSnapshot().setup, 'login'); assert.match(render(s.client), /Check your credentials/);
    await s.client.login('demo@example.invalid', 'mock-only'); assert.equal(s.client.getSnapshot().phase, 'authenticated');
    assert.deepEqual(s.calls.slice(-2).map(r => r.path), ['/api/auth/login', '/api/auth/me']);
  } else if (scenario === 'first-run') {
    // INSTALLER-07: first run shows the owner form (needs the setup code); still no sign-in.
    assert.match(html, /Create the owner account/); assert.match(html, /agent-player setup/);
    assert.doesNotMatch(html, /Check your credentials/);
    await s.client.login('demo@example.invalid', 'mock-only'); assert.equal(s.calls.length, 1);
  } else {
    assert.match(html, /Setup status unavailable/);
    assert.doesNotMatch(html, /type="password"|Check your credentials/);
    await s.client.login('demo@example.invalid', 'mock-only'); assert.equal(s.calls.length, 1);
  }
});

const malformed = [null, [], {}, { ...complete, extra: true }, { ...complete, token: 'fictional-secret' },
  { ...complete, code: 'made_up' }, { ...complete, setupComplete: 1 }, { ...complete, setupRequired: 'false' },
  { ...complete, setupRequired: true }, { ...required, setupRequired: false },
  { setupComplete: true, setupRequired: false }, { ...complete, message: 'fictional-secret' },
  { ...required, message: 'Setup already completed' }, { ...complete, message: 'Setup required' }];
for (const [i, body] of malformed.entries()) test(`discovery strict schema rejects malformed shape ${i}`, async () => {
  assert.throws(() => setupStatus(200, body));
  const s = clientFor(async () => ok(body)); s.client.selectMode('mock'); await s.client.discoverSetup();
  assert.equal(s.client.getSnapshot().setup, 'unavailable'); assert.equal(s.client.getSnapshot().user, undefined);
  assert.doesNotMatch(render(s.client), /fictional-secret|made_up|type="password"/);
  await s.client.login('demo@example.invalid', 'mock-only'); assert.equal(s.calls.length, 1);
});
for (const status of [201, 204, 301, 400, 401, 403, 404, 409, 421, 429, 500, 503, 999]) test(`discovery status ${status} never grants login or relays codes`, async () => {
  const s = clientFor(async () => ({ status, body: { ...complete, code: 'published_password', message: 'fictional-secret' } }));
  s.client.selectMode('mock'); await s.client.discoverSetup();
  assert.equal(s.client.getSnapshot().setup, 'unavailable'); assert.equal(s.client.getSnapshot().notice, undefined);
  assert.doesNotMatch(render(s.client), /fictional-secret|published default|type="password"/); assert.equal(s.calls.length, 1);
});
test('network failure has no fallback; only explicit recheck can replace unavailable with login', async () => {
  let fail = true; const s = clientFor(async () => { if (fail) throw Error('fictional-secret'); return ok(complete); }, 'live');
  s.client.selectMode('live'); await s.client.discoverSetup(); assert.equal(s.client.getSnapshot().setup, 'unavailable');
  assert.equal(s.calls.length, 1); assert.equal(s.client.getSnapshot().mode, 'live');
  fail = false; await s.client.discoverSetup(); assert.equal(s.client.getSnapshot().setup, 'login'); assert.equal(s.calls.length, 2);
});
for (const action of ['cancel', 'fixture', 'mock', 'live']) test(`late discovery after ${action} cannot restore old state`, async () => {
  const d = deferred(); let request;
  const transport = async r => { request = r; return d.promise; };
  const client = new SessionClient({ mock: transport, live: transport }); client.selectMode('mock');
  const check = client.discoverSetup(); assert.equal(client.getSnapshot().setup, 'checking');
  await client.discoverSetup(); await client.login('demo@example.invalid', 'mock-only');
  assert.match(render(client), /Cancel setup check/); assert.doesNotMatch(render(client), /type="password"/);
  if (action === 'cancel') client.cancel(); else client.selectMode(action);
  const snapshot = client.getSnapshot(); assert.equal(request.signal.aborted, true);
  d.resolve(ok(complete)); await check; assert.equal(client.getSnapshot(), snapshot);
});
test('older discovery cannot replace a newer explicit check', async () => {
  const d = deferred(); let count = 0;
  const s = clientFor(async () => ++count === 1 ? d.promise : ok(required)); s.client.selectMode('mock');
  const old = s.client.discoverSetup(); s.client.cancel(); await s.client.discoverSetup();
  const snapshot = s.client.getSnapshot(); d.resolve(ok(complete)); await old;
  assert.equal(s.client.getSnapshot(), snapshot); assert.equal(snapshot.setup, 'required');
});
test('late discovery cannot erase newer authentication; no checks during auth/logout', async () => {
  const discovery = deferred(), logout = deferred(); const base = createLoginMock();
  const s = clientFor(r => r.path === path ? discovery.promise : r.path === '/api/auth/logout' ? logout.promise : base(r));
  s.client.selectMode('mock'); const old = s.client.discoverSetup(); s.client.cancel();
  await s.client.login('demo@example.invalid', 'mock-only'); const authenticated = s.client.getSnapshot();
  discovery.resolve(ok(required)); await old; assert.equal(s.client.getSnapshot(), authenticated);
  const n = s.calls.length; await s.client.discoverSetup(); assert.equal(s.calls.length, n);
  await assert.rejects(s.client.request({ method: 'GET', path }), /blocked/);
  const out = s.client.logoutAllDevices(); await s.client.discoverSetup(); assert.equal(s.calls.length, n + 1);
  assert.equal(s.client.getSnapshot().phase, 'signing-out'); logout.resolve(ok({ success: true })); await out;
  assert.equal(s.client.getSnapshot().notice, 'logout-confirmed'); assert.equal(s.client.getSnapshot().setup, undefined);
});
test('discovery during pending login is a no-op and cannot cancel its me verification', async () => {
  const d = deferred(); const base = createLoginMock();
  const s = clientFor(async r => { const response = await base(r); if (r.path === '/api/auth/me') await d.promise; return response; });
  s.client.selectMode('mock'); await s.client.discoverSetup(); const login = s.client.login('demo@example.invalid', 'mock-only');
  await new Promise(r => setImmediate(r)); const count = s.calls.length; await s.client.discoverSetup(); assert.equal(s.calls.length, count);
  d.resolve(); await login; assert.equal(s.client.getSnapshot().phase, 'authenticated');
});

test('only exact GET and empty headers/body are allowed; all setup mutations remain blocked', async () => {
  assert.equal(allowedRequest('GET', path), true); assert.equal(allowed('GET', path), true);
  const calls = []; const transport = createSameOriginTransport('http://127.0.0.1:42522', async (...args) => { calls.push(args); return new Response(JSON.stringify(complete), { headers: { 'Content-Type': 'application/json' } }); });
  const request = { method: 'GET', path, headers: {}, signal: new AbortController().signal };
  assert.deepEqual(await transport(request), ok(complete)); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'http://127.0.0.1:42522' + path);
  assert.deepEqual(calls[0][1].headers, { Accept: 'application/json' });
  for (const [key, value] of Object.entries({ credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'same-origin', referrerPolicy: 'no-referrer' })) assert.equal(calls[0][1][key], value);
  for (const change of [{ method: 'POST' }, { method: 'HEAD' }, { method: 'PUT' }, { body: {} }, { headers: { Authorization: 'Bearer fictional' } }, { headers: { Cookie: 'fictional' } },
    ...['/api/setup/admin', '/api/setup/check', '/api/setup/complete', '/api/setup/database', '/api/setup/python', '/api/onboarding', '/api/instance', path + '?x=1', path + '/', '/api/setup/%73tatus', path + '#x'].map(path => ({ path }))]) {
    await assert.rejects(transport({ ...request, ...change }));
  }
  assert.equal(calls.length, 1);
});
for (const scenario of ['bad-schema', 'error', 'html', 'redirect', 'wrong-url']) test(`same-origin discovery ${scenario} fails closed`, async () => {
  const response = new Response(JSON.stringify(scenario === 'bad-schema' ? { ...complete, extra: true } : complete), { status: scenario === 'error' ? 503 : 200, headers: { 'Content-Type': scenario === 'html' ? 'text/html' : 'application/json' } });
  if (scenario === 'redirect') Object.defineProperty(response, 'redirected', { value: true });
  if (scenario === 'wrong-url') Object.defineProperty(response, 'url', { value: 'https://fictional.invalid/' });
  const s = clientFor(createSameOriginTransport('http://127.0.0.1:42522', async () => response), 'live'); s.client.selectMode('live'); await s.client.discoverSetup();
  assert.equal(s.client.getSnapshot().setup, 'unavailable'); assert.equal(s.calls.length, 1);
});

const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
async function httpFixture(t, handler, options = {}) {
  const calls = [];
  const backend = http.createServer(async (req, res) => {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    calls.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(parts).toString() });
    res.setHeader('Content-Type', 'application/json'); handler(req, res);
  });
  const upstreamPort = await listen(backend); t.after(() => close(backend));
  const app = createApplicationServer({ channel: 'candidate', upstreamPort, ...options });
  const port = await listen(app); t.after(() => close(app)); const origin = `http://127.0.0.1:${port}`;
  const request = (target = path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: target, method, headers: { Origin: origin, ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) } : {}), ...headers } }, res => {
      const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString(), headers: res.headers }));
    }); req.on('error', reject); req.end(bytes);
  });
  return { calls, request, origin, upstreamPort };
}
for (const value of [required, complete]) test(`HTTP discovery exact actual shape: ${value.setupComplete}`, async t => {
  const s = await httpFixture(t, (_req, res) => res.end(JSON.stringify(value)));
  const response = await s.request(path, { headers: { Cookie: 'fictional=not-forwarded' } });
  assert.equal(response.status, 200); assert.deepEqual(JSON.parse(response.body), value);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(s.calls.length, 1); assert.deepEqual([s.calls[0].method, s.calls[0].path, s.calls[0].body], ['GET', path, '']);
  assert.equal(s.calls[0].headers.authorization, undefined); assert.equal(s.calls[0].headers.cookie, undefined);
  assert.equal(s.calls[0].headers.host, `127.0.0.1:${s.upstreamPort}`); assert.equal(s.calls[0].headers.origin, s.origin);
});
test('HTTP anonymous GET permits absent Origin, refuses foreign Origin/Host and credential/header/path/method expansion before upstream', async t => {
  const s = await httpFixture(t, (_req, res) => res.end(JSON.stringify(complete)));
  assert.equal((await s.request(path, { headers: { Origin: '' } })).status, 200);
  for (const options of [{ headers: { Host: 'fictional.invalid' } }, { headers: { Origin: 'https://fictional.invalid' } }, { headers: { 'Sec-Fetch-Site': 'same-site' } },
    { headers: { Authorization: 'Bearer fictional' } }, { headers: { 'X-Forwarded-Host': 'fictional.invalid' } }, { headers: { 'Idempotency-Key': 'fictional-key' } },
    { method: 'POST' }, { method: 'PUT' }, { method: 'HEAD' }, { body: {} }]) {
    assert.ok((await s.request(path, options)).status >= 400);
  }
  for (const target of [path + '?x=1', path + '/', '/api/setup/%73tatus', '/api/setup/admin', '/api/setup/complete', '/api/setup/check', '/api/instance', '/api/onboarding', '/api/auth/me', '/api/memory/proposals']) assert.ok((await s.request(target)).status >= 400);
  assert.equal(s.calls.length, 1);
});
test('HTTP rejects every malformed discovery shape without relaying unknown fields', async t => {
  let body; const s = await httpFixture(t, (_req, res) => res.end(JSON.stringify(body)));
  for (body of malformed) { const response = await s.request(); assert.equal(response.status, 502); assert.equal(response.body, 'null'); }
  assert.equal(s.calls.length, malformed.length);
});
test('HTTP unexpected statuses, codes and text fail closed even with otherwise valid body', async t => {
  let status; const s = await httpFixture(t, (_req, res) => { res.statusCode = status; res.end(JSON.stringify(complete)); });
  for (status of [201, 202, 204, 301, 401, 403, 421, 429, 500, 503]) { const response = await s.request(); assert.equal(response.status, 502); assert.equal(response.body, 'null'); }
  assert.equal(s.calls.length, 10);
});
for (const scenario of ['cookie', 'redirect', 'html', 'invalid-json', 'timeout', 'disconnect']) test(`HTTP discovery ${scenario} unavailable without retry`, async t => {
  const s = await httpFixture(t, (_req, res) => {
    if (scenario === 'timeout') return;
    if (scenario === 'disconnect') return res.destroy();
    if (scenario === 'cookie') res.setHeader('Set-Cookie', 'fictional-secret');
    if (scenario === 'redirect') { res.statusCode = 302; res.setHeader('Location', 'http://127.0.0.1:1/not-contacted'); }
    if (scenario === 'html') res.setHeader('Content-Type', 'text/html');
    res.end(scenario === 'invalid-json' ? '{' : JSON.stringify(complete));
  }, { timeoutMs: scenario === 'timeout' ? 100 : 1000 });
  const response = await s.request(); assert.equal(response.status, scenario === 'timeout' ? 504 : 502); assert.equal(response.body, 'null'); assert.equal(s.calls.length, 1);
});
test('fictional HTTP end-to-end explicit discovery precedes login + me and does not authenticate by status', async t => {
  let firstRun = true;
  const user = { id: 'fictional-owner', username: 'Fictional', email: 'demo@example.invalid', role: 'owner' };
  const s = await httpFixture(t, (req, res) => res.end(JSON.stringify(req.url === path ? (firstRun ? required : complete) : req.url === '/api/auth/login' ? { user, token: 'fictional-only', deviceToken: 'd'.repeat(43) } : { user })));
  const transport = createSameOriginTransport('http://127.0.0.1:42522', async (url, init) => {
    const response = await fetch(s.origin + new URL(url).pathname, { ...init, headers: { ...init.headers, Origin: s.origin } });
    return { status: response.status, url, redirected: response.redirected, headers: response.headers, json: () => response.json() };
  });
  const client = new SessionClient({ live: transport }); client.selectMode('live'); render(client); assert.equal(s.calls.length, 0);
  await client.discoverSetup(); assert.equal(client.getSnapshot().setup, 'required'); await client.login('demo@example.invalid', 'fictional-only'); assert.equal(s.calls.length, 1);
  firstRun = false; await client.discoverSetup(); assert.equal(client.getSnapshot().setup, 'login'); assert.equal(client.getSnapshot().phase, 'signed-out');
  await assert.rejects(client.request({ method: 'GET', path: '/api/auth/me' }), /blocked/);
  await client.login('demo@example.invalid', 'fictional-only'); assert.equal(client.getSnapshot().phase, 'authenticated');
  assert.deepEqual(s.calls.map(r => r.path), [path, path, '/api/auth/login', '/api/auth/me']);
  assert.equal(s.calls[0].headers.authorization, undefined); assert.equal(s.calls[3].headers.authorization, 'Bearer fictional-only');
});
test('discovery clears stale credential refusal but preserves explicit logout uncertainty', async () => {
  const mock = createLoginMock(undefined, 'first-run');
  const s = clientFor(mock); s.client.selectMode('mock'); await s.client.login('wrong', 'wrong');
  assert.equal(s.client.getSnapshot().notice, 'invalid'); await s.client.discoverSetup();
  assert.equal(s.client.getSnapshot().setup, 'required'); assert.equal(s.client.getSnapshot().notice, undefined);
  assert.doesNotMatch(render(s.client), /Check your credentials/);
  const base = createLoginMock(); const q = clientFor(r => r.path === '/api/auth/logout' ? Promise.resolve({ status: 503, body: null }) : base(r));
  q.client.selectMode('mock'); await q.client.login('demo@example.invalid', 'mock-only'); await q.client.logoutAllDevices();
  await q.client.discoverSetup(); assert.equal(q.client.getSnapshot().notice, 'logout-unknown'); assert.equal(q.client.getSnapshot().setup, 'login');
});
