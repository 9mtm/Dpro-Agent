require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { SessionClient, allowedRequest, createSameOriginTransport } = require('../src/session.ts');
const { createLoginMock } = require('../src/session-mock.ts');
const { allowed } = require('../scripts/application-server.cjs');
const user = { id: 'fiction-owner', email: 'a@example.invalid', username: 'Fiction', role: 'owner' };
const device = n => `fictional-device-${n}`.padEnd(43, '_');
const success = n => ({ status: 200, body: { user, token: 'fictional-auth', deviceToken: device(n) } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(handler) {
  const calls = []; let count = 0;
  const transport = async r => { calls.push(r); count++; return handler?.(r, count) ?? (r.path.endsWith('/login') ? success(count) : { status: 200, body: r.path.endsWith('/me') ? { user } : { success: true } }); };
  const client = new SessionClient({ mock: transport, live: transport }); client.selectMode('mock');
  return { client, calls, login: (email = user.email) => client.login(email, 'fictional-password') };
}
test('device rotation is separate from Bearer and survives logout only in this client', async () => {
  const s = fixture(); await s.login(); await s.client.logoutAllDevices(); await s.login(); await s.login();
  const logins = s.calls.filter(r => r.path.endsWith('/login'));
  assert.equal(logins[0].body.deviceToken, undefined);
  assert.equal(logins[1].body.deviceToken, device(1)); assert.equal(logins[2].body.deviceToken, device(4));
  for (const r of s.calls) {
    if (r.path.endsWith('/login')) assert.deepEqual(r.headers, {});
    else { assert.equal(r.body, undefined); assert.equal(r.headers.Authorization, 'Bearer fictional-auth'); }
  }
  assert.ok(!JSON.stringify(s.client.getSnapshot()).includes('fictional-device'));
  assert.ok(!JSON.stringify(s.client).includes('fictional-device'));
  const second = fixture(); await second.login(); assert.equal(second.calls[0].body.deviceToken, undefined);
});
test('email normalization matches backend throttle; switching account discards prior binding', async () => {
  const s = fixture(); await s.login(); await s.login(' A@EXAMPLE.INVALID '); await s.login('b@example.invalid'); await s.login();
  const bodies = s.calls.filter(r => r.path.endsWith('/login')).map(r => r.body);
  assert.equal(bodies[1].deviceToken, device(1));
  assert.equal(bodies[1].email, ' A@EXAMPLE.INVALID ');
  assert.equal(bodies[2].deviceToken, undefined); assert.equal(bodies[3].deviceToken, undefined);
});
for (const mode of ['fixture', 'live', 'mock']) test(`explicit mode selection discards device binding: ${mode}`, async () => {
  const s = fixture(); await s.login(); s.client.selectMode(mode); if (mode === 'fixture') s.client.selectMode('mock'); await s.login();
  assert.equal(s.calls.filter(r => r.path.endsWith('/login')).at(-1).body.deviceToken, undefined);
});
for (const phase of ['login', 'me']) test(`stale ${phase} response cannot overwrite latest rotation`, async () => {
  const pending = deferred(); let hold = false;
  const s = fixture(r => hold && r.path.endsWith('/' + phase) ? (hold = false, pending.promise) : undefined);
  await s.login(); hold = true; const old = s.login();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await s.login(); const latestLogin = s.calls.findLastIndex(r => r.path.endsWith('/login'));
  const current = s.client.getSnapshot(); pending.resolve(phase === 'login' ? success(99) : { status: 200, body: { user } }); await old;
  assert.equal(s.client.getSnapshot(), current); await s.login();
  assert.equal(s.calls.filter(r => r.path.endsWith('/login')).at(-1).body.deviceToken, device(latestLogin + 1));
});
for (const action of ['cancel', 'mode']) test(`late success after ${action} retains only the permitted advisory rotation`, async () => {
  const pending = deferred(); let hold = true;
  const s = fixture(r => r.path.endsWith('/login') && hold ? (hold = false, pending.promise) : undefined);
  const old = s.login(); if (action === 'cancel') s.client.cancel(); else s.client.selectMode('live');
  pending.resolve(success(99)); await old;
  assert.equal(s.client.getSnapshot().phase, 'signed-out'); assert.equal(s.client.getSnapshot().user, undefined);
  assert.equal(s.calls.length, 1);
  await assert.rejects(s.client.request({ method: 'GET', path: '/api/auth/me' }));
  await s.login();
  assert.equal(s.calls.filter(r => r.path.endsWith('/login')).at(-1).body.deviceToken, action === 'cancel' ? device(99) : undefined);
});
test('rotation is kept after me failure without establishing authentication', async () => {
  const s = fixture(r => r.path.endsWith('/me') ? { status: 401, body: null } : undefined);
  await s.login(); assert.equal(s.client.getSnapshot().phase, 'signed-out');
  await assert.rejects(s.client.request({ method: 'GET', path: '/api/auth/me' }));
  await s.login(); assert.equal(s.calls.filter(r => r.path.endsWith('/login'))[1].body.deviceToken, device(1));
});
const malformed = [undefined, null, '', 42, {}, [], 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '=', 'a'.repeat(42) + '+', 'a'.repeat(42) + '/', 'a'.repeat(42) + '\n', 'a'.repeat(43) + '\n'];
for (const [index, value] of malformed.entries()) test(`malformed success device token fails closed and never escapes: case ${index}`, async () => {
  const s = fixture(r => r.path.endsWith('/login') ? { ...success(1), body: { ...success(1).body, deviceToken: value } } : undefined);
  await s.login(); assert.equal(s.calls.length, 1); assert.equal(s.client.getSnapshot().notice, 'unavailable');
  assert.equal(s.client.getSnapshot().user, undefined); assert.ok(!JSON.stringify(s.client.getSnapshot()).includes('deviceToken'));
});
test('missing or expired device cannot confer authentication; refusal never retries', async () => {
  let refuse = false;
  const s = fixture(r => refuse && r.path.endsWith('/login') ? { status: 429, body: { code: 'rate_limited', deviceToken: device(99), message: device(99) } } : undefined);
  await s.login(); refuse = true; const before = s.calls.length; await s.login();
  await new Promise(r => setTimeout(r, 10)); assert.equal(s.calls.length, before + 1);
  assert.equal(s.client.getSnapshot().notice, 'rate_limited'); assert.equal(s.client.getSnapshot().phase, 'signed-out');
  assert.ok(!JSON.stringify(s.client.getSnapshot()).includes('fictional-device'));
  await assert.rejects(s.client.request({ method: 'GET', path: '/api/auth/me' }));
});
test('client and bridge accept only exact optional token login body', () => {
  for (const allow of [allowedRequest, allowed]) {
    const body = { email: user.email, password: 'fictional' };
    assert.equal(allow('POST', '/api/auth/login', body), true);
    assert.equal(allow('POST', '/api/auth/login', { ...body, deviceToken: device(1) }), true);
    for (const value of malformed) assert.equal(allow('POST', '/api/auth/login', { ...body, deviceToken: value }), false);
    assert.equal(allow('POST', '/api/auth/login', { ...body, deviceToken: device(1), extra: true }), false);
    for (const [method, path, extra] of [['GET', '/api/auth/me', {}], ['GET', '/api/setup/status', {}], ['POST', '/api/auth/logout', {}], ['POST', '/api/agents/name-suggestion', { language: 'en', exclude: [] }], ['POST', '/api/memory/proposals/p/approve', { expectedReviewHash: 'a'.repeat(64) }], ['PUT', '/api/agents/main', { name: 'Name', expectedVersion: 1 }]])
      assert.equal(allow(method, path, { ...extra, deviceToken: device(1) }), false);
  }
});
test('mock rotates with exact emitted shape but still requires the fictional password', async () => {
  const mock = createLoginMock(); const calls = [];
  const client = new SessionClient({ mock: async r => { calls.push(r); return mock(r); } }); client.selectMode('mock');
  await client.login('demo@example.invalid', 'mock-only'); await client.logoutAllDevices(); await client.login('demo@example.invalid', 'mock-only');
  const first = calls.filter(r => r.path.endsWith('/login'))[1].body.deviceToken;
  await client.login('demo@example.invalid', 'wrong'); assert.equal(client.getSnapshot().phase, 'signed-out');
  const second = calls.filter(r => r.path.endsWith('/login'))[2].body.deviceToken;
  assert.equal(first.length, 43); assert.equal(second.length, 43); assert.notEqual(first, second);
});
test('browser transport projects login and me and omits ambient credentials', async () => {
  const calls = [];
  const transport = createSameOriginTransport('http://127.0.0.1:42522', async (url, init) => {
    calls.push({ url, init }); return new Response(JSON.stringify({ ...success(1).body, extra: 'private' }), { headers: { 'Content-Type': 'application/json' } });
  });
  const signal = new AbortController().signal;
  const response = await transport({ method: 'POST', path: '/api/auth/login', body: { email: user.email, password: 'fictional', deviceToken: device(0) }, headers: {}, signal });
  assert.deepEqual(Object.keys(response.body).sort(), ['deviceToken', 'token', 'user']);
  const me = await transport({ method: 'GET', path: '/api/auth/me', headers: { Authorization: 'Bearer fictional-auth' }, signal });
  assert.deepEqual(me.body, { user });
  assert.equal(calls[0].init.credentials, 'same-origin'); assert.equal(calls[0].init.cache, 'no-store');
  assert.ok(!JSON.stringify(calls[0].init.headers).includes('fictional-device')); assert.ok(!calls[0].url.includes('fictional-device'));
});
test('no device persistence or logging sinks in auth sources; private slot absent from own properties', async () => {
  for (const file of ['src/session.ts', 'src/session-mock.ts', 'src/login-contract.js', 'src/AuthBoundary.tsx']) {
    const source = fs.readFileSync(require('node:path').join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|indexedDB|console\.|sendBeacon/);
  }
  const s = fixture(); const snapshots = []; const stop = s.client.subscribe(() => snapshots.push(s.client.getSnapshot()));
  await s.login(); s.client.cancel(); stop();
  assert.ok(!JSON.stringify(snapshots).includes('fictional-device'));
  assert.ok(!Object.keys(s.client).some(key => /device|token/i.test(key)));
});
test('constructor fixes transport binding against caller configuration mutation', async () => {
  const calls = []; const transports = { mock: async r => { calls.push(r); return r.path.endsWith('/login') ? success(1) : { status: 200, body: { user } }; } };
  const client = new SessionClient(transports); client.selectMode('mock'); await client.login(user.email, 'fictional');
  let replacedCalls = 0; transports.mock = async () => { replacedCalls++; return success(2); };
  await client.login(user.email, 'fictional'); assert.equal(replacedCalls, 0); assert.equal(calls.length, 4);
});
test('malformed rotation clears old slot in direct transport without leaking error text', async () => {
  let broken = false; const s = fixture(r => broken && r.path.endsWith('/login') ? { status: 200, body: { ...success(99).body, deviceToken: 'bad' } } : undefined);
  await s.login(); broken = true; await s.login(); broken = false; await s.login();
  assert.equal(s.calls.filter(r => r.path.endsWith('/login')).at(-1).body.deviceToken, undefined);
});
