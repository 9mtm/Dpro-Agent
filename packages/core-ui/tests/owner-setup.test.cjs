// INSTALLER-07: first-run owner creation in core-ui with the one-time setup
// code. Exact body, no Authorization, fixed reply codes (never backend text),
// bridge forwards only the exact contract, client signs in afterwards.
// Fictional data only; the HTTP backend is a local fixture.
const CODE = 'Fictional_setup_code_for_tests_only_000000a';
globalThis.window = { location: { hash: `#setup=${CODE}`, pathname: '/', search: '', hostname: '127.0.0.1' }, history: { replaceState() { globalThis.window.location.hash = ''; } } };
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { SessionClient, createSameOriginTransport, allowedRequest } = require('../src/session.ts');
const { createLoginMock } = require('../src/session-mock.ts');
const { AuthBoundary } = require('../src/AuthBoundary.tsx');
const { OWNER_SETUP_PATH, validOwnerSetupBody, ownerSetupResponse, setupCodeFromFragment } = require('../src/owner-setup-contract.js');
const { createApplicationServer, allowed } = require('../scripts/application-server.cjs');

const owner = { name: 'Fictional Owner', email: 'owner@example.invalid', password: 'fictional-pass-1234', setupToken: CODE };
const required = { setupComplete: false, setupRequired: true, message: 'Setup required' };
function clientFor(transport, mode = 'mock') {
  const calls = [];
  const client = new SessionClient({ [mode]: async r => { calls.push(r); return transport(r); } });
  return { client, calls };
}
const render = client => renderToStaticMarkup(React.createElement(AuthBoundary, { client, initialPage: 'account' }, 'fictional workspace'));

test('contract: exact body; replies keep only reviewed codes at their status; fragment code', () => {
  assert.equal(CODE.length, 43);
  assert.equal(validOwnerSetupBody(owner), true);
  for (const bad of [null, [], {}, { ...owner, extra: 1 }, { ...owner, setupToken: CODE + 'x' }, { ...owner, setupToken: undefined },
    { ...owner, password: 'short' }, { ...owner, email: 'no-at' }, { ...owner, name: ' padded ' }, { ...owner, name: '' }, { ...owner, role: 'owner' }]) {
    assert.equal(validOwnerSetupBody(bad), false, JSON.stringify(bad));
  }
  assert.deepEqual(ownerSetupResponse(200, { success: true, message: 'x', user: { id: '1' } }), { success: true });
  assert.equal(ownerSetupResponse(200, { success: false }), null);
  assert.deepEqual(ownerSetupResponse(403, { code: 'setup_token_invalid', error: 'Forbidden', message: 'backend text' }), { code: 'setup_token_invalid' });
  assert.equal(ownerSetupResponse(400, { code: 'setup_token_invalid' }), null, 'code at the wrong status');
  assert.equal(ownerSetupResponse(403, { code: 'made_up' }), null);
  assert.equal(ownerSetupResponse(500, null), null);
  assert.equal(setupCodeFromFragment(`#setup=${CODE}`), CODE);
  for (const h of ['', '#', `#setup=${CODE}x`, `#other=${CODE}`, `?setup=${CODE}`, null]) assert.equal(setupCodeFromFragment(h), null);
});

test('allowlists: only POST with the exact body; GET, extra fields and authenticated adapter refused', async () => {
  assert.equal(allowedRequest('POST', OWNER_SETUP_PATH, owner), true);
  assert.equal(allowed('POST', OWNER_SETUP_PATH, owner), true);
  for (const [m, b] of [['GET', undefined], ['PUT', owner], ['POST', { ...owner, extra: true }], ['POST', undefined]]) {
    assert.equal(allowedRequest(m, OWNER_SETUP_PATH, b), false); assert.equal(allowed(m, OWNER_SETUP_PATH, b), false);
  }
  const s = clientFor(createLoginMock()); s.client.selectMode('mock');
  await s.client.login('demo@example.invalid', 'mock-only');
  await assert.rejects(s.client.request({ method: 'POST', path: OWNER_SETUP_PATH, body: owner }), /blocked/);
});

test('offline first run: no call before discovery; then create owner -> signed in as that owner', async () => {
  const s = clientFor(createLoginMock(undefined, 'first-run')); s.client.selectMode('mock');
  assert.deepEqual(await s.client.createOwner(owner), { ok: false, code: 'unavailable' }); assert.equal(s.calls.length, 0);
  await s.client.discoverSetup(); assert.equal(s.client.getSnapshot().setup, 'required');
  assert.deepEqual(await s.client.createOwner({ ...owner, setupToken: 'bad' }), { ok: false, code: 'missing_fields' }); assert.equal(s.calls.length, 1);
  assert.deepEqual(await s.client.createOwner(owner), { ok: true });
  const state = s.client.getSnapshot();
  assert.equal(state.phase, 'authenticated'); assert.equal(state.user.email, owner.email); assert.equal(state.user.role, 'owner');
  assert.deepEqual(s.calls.map(r => [r.method, r.path]), [['GET', '/api/setup/status'], ['POST', OWNER_SETUP_PATH], ['POST', '/api/auth/login'], ['GET', '/api/auth/me']]);
  assert.deepEqual(s.calls[1].headers, {}, 'no Authorization on owner creation');
  assert.deepEqual(await s.client.createOwner(owner), { ok: false, code: 'unavailable' }, 'not again once signed in');
});

test('refusals keep the user signed out with a fixed code; setup_complete moves to sign-in', async () => {
  let reply = { status: 403, body: { code: 'setup_token_invalid' } };
  const s = clientFor(async r => r.path === '/api/setup/status' ? { status: 200, body: required } : reply);
  s.client.selectMode('mock'); await s.client.discoverSetup();
  assert.deepEqual(await s.client.createOwner(owner), { ok: false, code: 'setup_token_invalid' });
  assert.equal(s.client.getSnapshot().phase, 'signed-out'); assert.equal(s.client.getSnapshot().setup, 'required');
  reply = { status: 403, body: { code: 'setup_not_local' } };
  assert.deepEqual(await s.client.createOwner(owner), { ok: false, code: 'setup_not_local' });
  reply = { status: 500, body: { error: 'secret backend text' } };
  assert.deepEqual(await s.client.createOwner(owner), { ok: false, code: 'unavailable' });
  reply = { status: 403, body: { code: 'setup_complete' } };
  assert.deepEqual(await s.client.createOwner(owner), { ok: false, code: 'setup_complete' });
  assert.equal(s.client.getSnapshot().setup, 'login');
});

test('screen: first run shows the owner form; a code from the link is used but never put in the page', async () => {
  const s = clientFor(createLoginMock(undefined, 'first-run')); s.client.selectMode('mock'); await s.client.discoverSetup();
  const html = render(s.client);
  assert.match(html, /Create the owner account/);
  assert.match(html, /Setup code received from the local link/);
  assert.ok(!html.includes(CODE), 'code not rendered');
  assert.equal(globalThis.window.location.hash, '', 'fragment removed from the address bar');
  assert.doesNotMatch(html, /finish it from the CLI/);
});

const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
async function bridge(t, handler) {
  const calls = [];
  const backend = http.createServer(async (req, res) => {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    calls.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(parts).toString() });
    res.setHeader('Content-Type', 'application/json'); handler(req, res);
  });
  const upstreamPort = await listen(backend); t.after(() => close(backend));
  const app = createApplicationServer({ channel: 'candidate', upstreamPort });
  const port = await listen(app); t.after(() => close(app)); const origin = `http://127.0.0.1:${port}`;
  const request = (target, { method = 'POST', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: target, method, headers: { Origin: origin, ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) } : {}), ...headers } }, res => {
      const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString() }));
    }); req.on('error', reject); req.end(bytes);
  });
  return { calls, request, origin };
}

test('bridge: forwards the exact body without credentials; projects replies to fixed codes', async t => {
  let status = 200, reply = { success: true, message: 'Owner account created successfully', user: { id: '1', name: 'x', email: owner.email } };
  const b = await bridge(t, (_req, res) => { res.statusCode = status; res.end(JSON.stringify(reply)); });
  const created = await b.request(OWNER_SETUP_PATH, { body: owner });
  assert.equal(created.status, 200); assert.deepEqual(JSON.parse(created.body), { success: true });
  assert.equal(b.calls.length, 1);
  assert.deepEqual(JSON.parse(b.calls[0].body), owner);
  assert.equal(b.calls[0].headers.authorization, undefined); assert.equal(b.calls[0].headers.cookie, undefined); assert.equal(b.calls[0].headers.origin, b.origin);

  status = 403; reply = { error: 'Forbidden', code: 'setup_not_local', message: 'backend text' };
  const refused = await b.request(OWNER_SETUP_PATH, { body: owner });
  assert.equal(refused.status, 403); assert.deepEqual(JSON.parse(refused.body), { code: 'setup_not_local' });
  reply = { code: 'made_up', message: 'backend text' };
  const unknown = await b.request(OWNER_SETUP_PATH, { body: owner });
  assert.equal(unknown.status, 502); assert.doesNotMatch(unknown.body, /backend text|made_up/);
  const calls = b.calls.length;

  // Refused before the backend: credentials, extra fields, wrong method, foreign origin, query.
  assert.equal((await b.request(OWNER_SETUP_PATH, { body: owner, headers: { Authorization: 'Bearer fictional' } })).status, 401);
  assert.equal((await b.request(OWNER_SETUP_PATH, { body: { ...owner, role: 'owner' } })).status, 400);
  assert.equal((await b.request(OWNER_SETUP_PATH, { body: { ...owner, setupToken: 'short' } })).status, 400);
  assert.ok((await b.request(OWNER_SETUP_PATH, { method: 'PUT', body: owner })).status >= 400);
  assert.ok((await b.request(OWNER_SETUP_PATH, { body: owner, headers: { Origin: 'https://fictional.invalid' } })).status >= 400);
  assert.ok((await b.request(OWNER_SETUP_PATH + '?x=1', { body: owner })).status >= 400);
  assert.ok((await b.request('/api/setup/complete', { body: {} })).status >= 400);
  assert.equal(b.calls.length, calls, 'nothing else reached the backend');
});

test('live transport: same-origin POST with no Authorization and fixed projection', async () => {
  const seen = [];
  const transport = createSameOriginTransport('http://127.0.0.1:42522', async (url, init) => {
    seen.push([url, init]);
    return new Response(JSON.stringify({ error: 'Forbidden', code: 'setup_token_expired', message: 'backend text' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  });
  const response = await transport({ method: 'POST', path: OWNER_SETUP_PATH, body: owner, headers: {}, signal: new AbortController().signal });
  assert.deepEqual(response, { status: 403, body: { code: 'setup_token_expired' } });
  assert.equal(seen[0][0], 'http://127.0.0.1:42522/api/setup/admin');
  assert.equal(seen[0][1].headers.Authorization, undefined);
  assert.equal(seen[0][1].credentials, 'omit');
  await assert.rejects(transport({ method: 'POST', path: OWNER_SETUP_PATH, body: owner, headers: { Authorization: 'Bearer fictional' }, signal: new AbortController().signal }));
});
