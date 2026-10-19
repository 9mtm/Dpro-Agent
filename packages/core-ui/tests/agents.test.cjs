require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { SessionClient, allowedRequest, createSameOriginTransport } = require('../src/session.ts');
const { AgentsController, publicAgent, agentResponse } = require('../src/agents.ts');
const { AgentsReview } = require('../src/AgentsDestination.tsx');
const { AuthBoundary } = require('../src/AuthBoundary.tsx');
const { createAgentsMock } = require('../src/agents-mock.ts');
const { createLoginMock } = require('../src/session-mock.ts');
const { allowed, createApplicationServer } = require('../scripts/application-server.cjs');
const http = require('node:http');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, wrap = x => x) {
  const mock = createAgentsMock(); const calls = []; const base = wrap(createLoginMock(mock));
  const client = new SessionClient({ mock: async r => { calls.push(r); return base(r); } });
  client.selectMode('mock'); await client.login('demo@example.invalid', 'mock-only');
  const c = new AgentsController(client); t.after(() => c.dispose());
  await c.list(); await c.select('sample-main');
  return { client, c, mock, calls };
}
const writes = s => s.calls.filter(r => r.method === 'PUT');
const markup = c => renderToStaticMarkup(React.createElement(AgentsReview, { controller: c }));

test('complete offline login → list/select → generate → explicit CAS Save → conflict/review → cancel → logout', async t => {
  const s = await fixture(t); const { c, client, mock } = s;
  assert.equal(client.getSnapshot().phase, 'authenticated');
  assert.deepEqual(c.getSnapshot().agents.map(a => a.id), ['sample-main', 'sample-helper']);
  const ui = renderToStaticMarkup(React.createElement(AuthBoundary, { client }, 'fixture'));
  assert.match(ui, /aria-label="Agents"/); assert.doesNotMatch(ui, /rename Save are unavailable/);
  c.edit('My draft'); await c.generate('ar');
  assert.deepEqual(s.calls.at(-1).body, { language: 'ar', exclude: ['My draft'] });
  assert.equal(writes(s).length, 0); const draft = c.getSnapshot().draft;
  await c.save(); assert.equal(c.getSnapshot().phase, 'saved');
  assert.deepEqual(writes(s)[0].body, { name: draft, expectedVersion: 1 });
  assert.equal(c.getSnapshot().selected.id, 'sample-main');
  mock.update('sample-main', 'Another writer', 2); c.edit('My second draft'); await c.save();
  assert.equal(c.getSnapshot().phase, 'review'); assert.equal(c.getSnapshot().selected.name, 'Another writer');
  assert.equal(c.getSnapshot().draft, 'My second draft'); assert.equal(c.getSnapshot().selected.version, 3);
  assert.match(markup(c), /disabled="">Save name/);
  await c.save(); assert.equal(writes(s).length, 2);
  c.review(); await c.save(); assert.equal(c.getSnapshot().selected.version, 4);
  c.edit('Discard me'); await c.generate(); c.cancel(); assert.equal(c.getSnapshot().draft, 'My second draft');
  assert.equal(writes(s).length, 3); assert.equal(c.getSnapshot().selected.id, 'sample-main');
  await client.logoutAllDevices(); assert.equal(client.getSnapshot().notice, 'logout-confirmed');
  assert.equal(c.getSnapshot().selected, undefined); assert.equal(c.getSnapshot().draft, '');
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(AuthBoundary, { client }, 'fixture')), /My second draft/);
});

test('own retired normalized/Arabic names reclaim; other agent names refuse without destroying draft', async t => {
  const s = await fixture(t); const { c } = s;
  c.edit('أَمَل'); await c.save(); c.edit('Next'); await c.save(); c.edit('امل'); await c.save();
  assert.equal(c.getSnapshot().phase, 'saved'); assert.equal(c.getSnapshot().selected.name, 'امل');
  c.edit('Offline helper'); await c.save(); assert.equal(c.getSnapshot().unknown, false);
  assert.equal(c.getSnapshot().refreshRequired, true); assert.equal(c.getSnapshot().draft, 'Offline helper');
  c.review(); await c.save(); assert.equal(writes(s).length, 4);
  await c.reconcile(); assert.equal(c.getSnapshot().needsReview, true); c.edit('New available'); c.review(); await c.save();
  assert.equal(c.getSnapshot().phase, 'saved');
});
for (const mode of ['network-before', 'network-after', '500-after', 'malformed-200', 'wrong-agent', 'wrong-name', 'same-version']) {
  test(`unknown ${mode}: never retry or infer success; explicit GET then review`, async t => {
    let intercept = true;
    const s = await fixture(t, base => async r => {
      if (r.method !== 'PUT' || !intercept) return base(r);
      intercept = false;
      if (mode === 'network-before') throw Error('private error');
      const result = await base(r);
      if (mode === 'network-after') throw Error('private error');
      if (mode === '500-after') return { status: 500, body: { error: 'private error' } };
      if (mode === 'malformed-200') return { status: 200, body: { agent: { api_key: 'private error' } } };
      const agent = { ...result.body.agent };
      if (mode === 'wrong-agent') agent.id = 'sample-helper';
      if (mode === 'wrong-name') agent.name = 'Other';
      if (mode === 'same-version') agent.version = 1;
      return { status: 200, body: { agent } };
    });
    s.c.edit('Attempt'); await s.c.save(); assert.equal(s.c.getSnapshot().phase, 'unknown');
    assert.doesNotMatch(JSON.stringify(s.c.getSnapshot()), /private error/);
    await s.c.save(); await s.c.generate(); s.c.cancel(); assert.equal(writes(s).length, 1);
    await s.c.reconcile(); const current = s.c.getSnapshot();
    assert.equal(current.phase, 'review'); assert.equal(current.needsReview, true); assert.equal(current.draft, 'Attempt');
    assert.match(current.notice, mode === 'network-before' ? /differs/ : /does not prove the same operation/);
    await s.c.save(); assert.equal(writes(s).length, 1);
    s.c.review(); s.c.edit('Deliberate new name'); await s.c.save(); assert.equal(writes(s).length, 2);
    assert.equal(s.c.getSnapshot().phase, 'saved');
  });
}

test('unknown ledger survives agent switch and destination remount and same-client relogin', async t => {
  const s = await fixture(t, base => async r => { if (r.method === 'PUT') { await base(r); throw Error(); } return base(r); });
  s.c.edit('Unconfirmed'); await s.c.save(); await s.c.select('sample-helper'); await s.c.select('sample-main');
  assert.equal(s.c.getSnapshot().unknown, true); assert.equal(s.c.getSnapshot().draft, 'Unconfirmed');
  s.c.dispose(); await s.client.logoutAllDevices(); await s.client.login('demo@example.invalid', 'mock-only');
  const next = new AgentsController(s.client); t.after(() => next.dispose()); await next.select('sample-main');
  assert.equal(next.getSnapshot().unknown, true); await next.reconcile(); assert.equal(next.getSnapshot().needsReview, true);
});
for (const action of ['list', 'select', 'generate', 'save', 'reconcile']) {
  for (const transition of ['logout', 'mode', 'relogin', '401']) test(`pending ${action} discarded synchronously after ${transition}`, async t => {
    const gate = deferred(); let hold = false;
    const s = await fixture(t, base => async r => {
      if (r.path === '/api/auth/me' && transition === '401' && hold) return { status: 401, body: null };
      if (hold && r.path.startsWith('/api/agents')) { const result = await base(r); await gate.promise; return result; }
      return base(r);
    });
    if (action === 'reconcile') {
      s.c.edit('Other reserved'); s.mock.update('sample-helper', 'Other reserved', 1); await s.c.save();
    }
    s.c.edit('Pending name'); hold = true;
    const pending = action === 'select' ? s.c.select('sample-helper') : s.c[action]();
    if (transition === 'logout') await s.client.logoutAllDevices();
    if (transition === 'mode') s.client.selectMode('fixture');
    if (transition === 'relogin') await s.client.login('demo@example.invalid', 'mock-only');
    if (transition === '401') await s.client.request({ method: 'GET', path: '/api/auth/me' });
    assert.equal(s.c.getSnapshot().selected, undefined); assert.deepEqual(s.c.getSnapshot().agents, []);
    gate.resolve(); await pending;
    assert.equal(s.c.getSnapshot().selected, undefined); assert.equal(s.c.getSnapshot().draft, '');
  });
}

test('selection and edit races reject stale reads/suggestions without overwriting draft', async t => {
  const gate = deferred(); let hold = false;
  const s = await fixture(t, base => async r => { const result = await base(r); if (hold && (r.path === '/api/agents/sample-main' || r.path.endsWith('name-suggestion'))) await gate.promise; return result; });
  hold = true; const oldRead = s.c.select('sample-main'); await s.c.select('sample-helper'); gate.resolve(); await oldRead;
  assert.equal(s.c.getSnapshot().selected.id, 'sample-helper');
  const next = deferred(); let release;
  const s2 = await fixture(t, base => async r => { const result = await base(r); if (r.path.endsWith('name-suggestion')) { release = true; await next.promise; } return result; });
  const generated = s2.c.generate(); s2.c.edit('Typed while generating'); next.resolve(); await generated;
  assert.equal(s2.c.getSnapshot().draft, 'Typed while generating');
});
for (const code of ['invalid_version', 'reserved_agent']) test(`typed ${code} is sanitized and never auto resaved`, async t => {
  const s = await fixture(t, base => async r => r.method === 'PUT' ? { status: code === 'reserved_agent' ? 403 : 400, body: { code, error: 'private' } } : base(r));
  s.c.edit('New name'); await s.c.save(); await s.c.save(); assert.equal(writes(s).length, 1);
  assert.doesNotMatch(JSON.stringify(s.c.getSnapshot()), /private/);
  assert.equal(s.c.getSnapshot().unknown, false);
});
for (const status of [403, 404, 429, 421]) test(`read ${status} does not show stale selected data`, async t => {
  let refuse = false;
  const s = await fixture(t, base => async r => refuse && r.path === '/api/agents/sample-helper' ? { status, body: null } : base(r));
  refuse = true; await s.c.select('sample-helper'); assert.equal(s.c.getSnapshot().selected, undefined);
  assert.equal(s.client.getSnapshot().phase, 'authenticated');
  if (status === 429 || status === 421) assert.equal(s.client.getSnapshot().notice, status === 429 ? 'limited' : 'unavailable');
});
test('admin reads but conservative UI/controller/client refuse Save', async t => {
  const s = await fixture(t, base => async r => { const result = await base(r); if (result.body?.user) return { ...result, body: { ...result.body, user: { ...result.body.user, role: 'admin' } } }; return result; });
  assert.equal(s.c.getSnapshot().owner, false); s.c.edit('No'); await s.c.generate(); await s.c.save(); assert.equal(writes(s).length, 0);
  await assert.rejects(s.client.request({ method: 'PUT', path: '/api/agents/sample-main', body: { name: 'No', expectedVersion: 1 } }));
});
test('projection validates stable IDs/versions and drops every unlisted property; SSR escapes names', async t => {
  const a = publicAgent({ id: 'a', name: '<img src=x>', version: 1, api_key: 'private', system_prompt: 'private', api_key_credential_id: 'private', arbitrary: { secret: true } });
  assert.deepEqual(a, { id: 'a', name: '<img src=x>', version: 1 });
  // AGENT-CARD-01: the reviewed profile fields pass; invalid ones are dropped.
  assert.deepEqual(publicAgent({ id: 'a', name: 'A', version: 1, role: 'manager', department: 'sales', description: 'Leads sales.', isPrimary: false, emoji: '🤖' }),
    { id: 'a', name: 'A', version: 1, role: 'manager', department: 'sales', description: 'Leads sales.', isPrimary: false, emoji: '🤖' });
  assert.deepEqual(publicAgent({ id: 'a', name: 'A', version: 1, role: 'boss', department: 'Sales!', isPrimary: 'yes' }), { id: 'a', name: 'A', version: 1 });
  for (const version of [0, -1, 1.1, '1', Number.MAX_SAFE_INTEGER + 1, null]) assert.throws(() => publicAgent({ ...a, version }));
  for (const id of ['..', 'a/b', '%61', 'name-suggestion', '', 'a?b']) assert.throws(() => publicAgent({ ...a, id }));
  assert.throws(() => agentResponse('/api/agents', { status: 200, body: { agents: [a, a] } }));
  const s = await fixture(t); s.c.edit('<img src=x>'); await s.c.save();
  assert.match(markup(s.c), /&lt;img src=x&gt;/); assert.doesNotMatch(markup(s.c), /<img/);
});
const bodies = [{ name: 'x' }, { name: 'x', expectedVersion: null }, { name: 'x', expectedVersion: 0 }, { name: 'x', expectedVersion: '1' }, { name: 'x', expectedVersion: 1, api_key: '' }, { name: 'x', expectedVersion: 1, id: 'renamed' }, { name: 'x', expectedVersion: 1, model: 'x' }, { name: ' x ', expectedVersion: 1 }, { name: 'x'.repeat(61), expectedVersion: 1 }, { name: '\u200d', expectedVersion: 1 }];
for (const [i, body] of bodies.entries()) test(`client/bridge reject extra or invalid rename body ${i}`, () => {
  assert.equal(allowedRequest('PUT', '/api/agents/main', body), false); assert.equal(allowed('PUT', '/api/agents/main', body), false);
});
for (const path of ['/api/agents/%61', '/api/agents/../main', '/api/agents/main?x=1', '/api/agents/name-suggestion', '/api/agents/main/primary', '/api/agents/main/personality', '/api/agents/main#x', '//evil/api/agents/main']) test(`rename path rejected: ${path}`, () => {
  for (const allow of [allowedRequest, allowed]) assert.equal(allow('PUT', path, { name: 'x', expectedVersion: 1 }), false);
});
test('safe canonical PUT accepted; all alternate header injection rejected before fetch', async () => {
  const body = { name: '🦉'.repeat(60), expectedVersion: 1 };
  assert.equal(allowedRequest('PUT', '/api/agents/main', body), true); assert.equal(allowed('PUT', '/api/agents/main', body), true);
  let sent = 0; const transport = createSameOriginTransport('http://127.0.0.1:42522', async () => { sent++; throw Error(); });
  for (const extra of [{ 'If-Match': '*' }, { 'X-HTTP-Method-Override': 'DELETE' }, { Cookie: 'x' }, { 'X-Forwarded-Host': 'evil' }]) await assert.rejects(transport({ method: 'PUT', path: '/api/agents/main', body, headers: { Authorization: 'Bearer fictional', ...extra }, signal: new AbortController().signal }));
  assert.equal(sent, 0);
});

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
test('complete ephemeral fictional HTTP bridge flow with real client and controller, redaction, CAS conflict/cancel/logout', async t => {
  const mock = createAgentsMock(); const base = createLoginMock(mock); const upstreamCalls = [];
  const backend = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const bytes = Buffer.concat(parts).toString(); const body = bytes ? JSON.parse(bytes) : undefined;
    upstreamCalls.push({ path: req.url, method: req.method, body });
    const result = await base({ path: req.url, method: req.method, body, headers: req.headers.authorization ? { Authorization: req.headers.authorization } : {}, signal: new AbortController().signal });
    if (result.body?.agent) result.body.agent = { ...result.body.agent, api_key: 'private-fixture', arbitrary: 'private-fixture' };
    if (result.body?.agents) result.body.agents = result.body.agents.map(a => ({ ...a, api_key: 'private-fixture', other: 'private-fixture' }));
    res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result.body));
  });
  const upstreamPort = await listen(backend); const app = createApplicationServer({ channel: 'candidate', upstreamPort }); const port = await listen(app);
  t.after(async () => { await close(app); await close(backend); }); const origin = `http://127.0.0.1:${port}`;
  const responses = [];
  const fetcher = async (url, init) => {
    const r = await fetch(origin + new URL(url).pathname, { ...init, headers: { ...init.headers, Origin: origin } });
    const body = await r.json(); responses.push(body);
    return { status: r.status, headers: r.headers, url, redirected: r.redirected, json: async () => body };
  };
  const client = new SessionClient({ live: createSameOriginTransport('http://127.0.0.1:42522', fetcher) });
  assert.equal(upstreamCalls.length, 0); client.selectMode('live'); await client.login('demo@example.invalid', 'mock-only');
  const c = new AgentsController(client); t.after(() => c.dispose());
  await c.list(); await c.select('sample-main'); await c.generate(); assert.equal(upstreamCalls.filter(r => r.method === 'PUT').length, 0);
  await c.save(); assert.equal(c.getSnapshot().phase, 'saved');
  mock.update('sample-main', 'Concurrent', 2); c.edit('Preserved'); await c.save(); assert.equal(c.getSnapshot().phase, 'review');
  assert.equal(c.getSnapshot().draft, 'Preserved'); assert.equal(c.getSnapshot().selected.name, 'Concurrent');
  c.review(); await c.save(); c.edit('Cancelled'); c.cancel(); await client.logoutAllDevices();
  assert.equal(client.getSnapshot().notice, 'logout-confirmed'); assert.equal(c.getSnapshot().selected, undefined);
  assert.doesNotMatch(JSON.stringify(responses), /private-fixture|api_key|arbitrary/);
  for (const r of upstreamCalls.filter(r => r.method === 'PUT')) assert.deepEqual(Object.keys(r.body).sort(), ['expectedVersion', 'name']);
  const before = upstreamCalls.length;
  for (const [path, body, headers] of [
    ['/api/agents/sample-main', { name: 'x', expectedVersion: 1, api_key: '' }, {}],
    ['/api/agents/sample-main', { name: 'x', expectedVersion: 1 }, { Origin: 'http://evil.invalid' }],
    ['/api/agents/sample-main', { name: 'x', expectedVersion: 1 }, { 'If-Match': '*' }],
    ['/api/agents/sample-main/personality', { name: 'x', expectedVersion: 1 }, {}],
  ]) {
    const r = await fetch(origin + path, { method: 'PUT', headers: { Authorization: 'Bearer fictional', Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.ok(r.status >= 400);
  }
  assert.equal(upstreamCalls.length, before);
});

test('Cancel cannot bypass conflict review; dispose prevents new reads/writes', async t => {
  const s = await fixture(t); s.mock.update('sample-main', 'Other', 1); s.c.edit('Draft'); await s.c.save();
  s.c.cancel(); s.c.edit('New draft'); await s.c.save(); assert.equal(writes(s).length, 1);
  assert.equal(s.c.getSnapshot().needsReview, true);
  s.c.dispose(); const count = s.calls.length; await s.c.list(); await s.c.select('sample-main'); await s.c.generate(); await s.c.save();
  assert.equal(s.calls.length, count);
});
test('signed-out live and mock entry keep the account form behind the public shell', async () => {
  for (const mode of ['live', 'mock']) {
    const client = new SessionClient({ [mode]: createLoginMock() }); client.selectMode(mode); await client.discoverSetup();
    const html = renderToStaticMarkup(React.createElement(AuthBoundary, { client }, 'fixture'));
    assert.match(html, /Welcome to Dpro/);
    assert.doesNotMatch(html, /name="password"|name="username"|method="post"/);
  }
});

test('concurrent Save sends exactly once; switching agent never attributes pending acknowledgment to another', async t => {
  const gate = deferred();
  const s = await fixture(t, base => async r => { const result = await base(r); if (r.method === 'PUT') await gate.promise; return result; });
  s.c.edit('Pending'); const pending = s.c.save(); await s.c.save(); assert.equal(writes(s).length, 1);
  await s.c.select('sample-helper'); gate.resolve(); await pending; assert.equal(s.c.getSnapshot().selected.id, 'sample-helper');
  await s.c.select('sample-main'); assert.equal(s.c.getSnapshot().unknown, true);
});
test('reconciliation failure keeps uncertain Save blocked; later overwrite remains unknowable', async t => {
  let failedWrite = false, failRead = false;
  const s = await fixture(t, base => async r => {
    if (failRead && r.method === 'GET' && r.path === '/api/agents/sample-main') return { status: 500, body: null };
    const result = await base(r); if (r.method === 'PUT' && !failedWrite) { failedWrite = true; throw Error(); } return result;
  });
  s.c.edit('Unconfirmed'); await s.c.save(); failRead = true; await s.c.reconcile();
  assert.equal(s.c.getSnapshot().unknown, true); await s.c.save(); assert.equal(writes(s).length, 1);
  failRead = false; s.mock.update('sample-main', 'Overwritten later', 2); await s.c.reconcile();
  assert.match(s.c.getSnapshot().notice, /may have been overwritten/); assert.equal(s.c.getSnapshot().draft, 'Unconfirmed');
  assert.equal(s.c.getSnapshot().selected.version, 3); s.c.review(); await s.c.save();
  assert.deepEqual(writes(s).at(-1).body, { name: 'Unconfirmed', expectedVersion: 3 });
});
for (const body of [
  { code: 'version_conflict', currentVersion: 2, agent: { id: 'sample-main', name: 'x', version: 3 } },
  { code: 'version_conflict', currentVersion: 2, agent: { id: 'sample-helper', name: 'x', version: 2 } },
  { code: 'version_conflict', currentVersion: '2', agent: { id: 'sample-main', name: 'x', version: 2 } },
]) test('inconsistent conflict payload is unknown, never acknowledged or displayed', async t => {
  const s = await fixture(t, base => async r => r.method === 'PUT' ? { status: 409, body } : base(r));
  s.c.edit('Draft'); await s.c.save(); assert.equal(s.c.getSnapshot().unknown, true);
  assert.equal(s.c.getSnapshot().selected.version, 1); assert.equal(s.c.getSnapshot().draft, 'Draft');
});

test('inherited naming values cannot smuggle unlisted own body fields', async t => {
  const body = Object.assign(Object.create({ name: 'Safe', expectedVersion: 1 }), { api_key: 'fictional-secret', model: 'unreviewed' });
  assert.equal(allowedRequest('PUT', '/api/agents/sample-main', body), false);
  assert.equal(allowed('PUT', '/api/agents/sample-main', body), false);
  const s = await fixture(t); await assert.rejects(s.client.request({ method: 'PUT', path: '/api/agents/sample-main', body }));
  assert.equal(writes(s).length, 0);
});
test('inherited authorization header is rejected before any transport fetch', async () => {
  let called = false;
  const transport = createSameOriginTransport('http://127.0.0.1:42522', async () => { called = true; throw Error(); });
  await assert.rejects(transport({ method: 'GET', path: '/api/agents', headers: Object.create({ Authorization: 'Bearer fictional' }), signal: new AbortController().signal }));
  assert.equal(called, false);
});

for (const [status, code] of [[403, 'published_password'], [403, 'account_inactive'], [403, 'origin_not_allowed'], [429, 'account_locked'], [429, 'rate_limited'], [421, 'host_not_allowed']]) {
  test(`reviewed auth refusal ${code} passes through client and HTTP bridge without error text`, async t => {
    const backend = http.createServer((_req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code, error: 'private-detail', message: 'private-detail', api_key: 'private-detail' })); });
    const upstreamPort = await listen(backend); const app = createApplicationServer({ channel: 'candidate', upstreamPort }); const port = await listen(app);
    t.after(async () => { await close(app); await close(backend); }); const origin = `http://127.0.0.1:${port}`;
    const transport = createSameOriginTransport('http://127.0.0.1:42522', async (url, init) => {
      // Raw HTTP preserves 421: Node fetch's connection-retry handling can mask it.
      return new Promise((resolve, reject) => {
        const req = http.request(origin + new URL(url).pathname, { method: init.method, headers: { ...init.headers, Origin: origin }, signal: init.signal }, r => {
          const parts = []; r.on('data', p => parts.push(p)); r.on('end', () => {
            try { const body = JSON.parse(Buffer.concat(parts)); assert.deepEqual(body, code === 'account_locked' ? null : { code });
              resolve({ status: r.statusCode, headers: new Headers(r.headers), url, json: async () => body });
            } catch (error) { reject(error); }
          });
        }); req.on('error', reject); req.end(init.body);
      });
    });
    const client = new SessionClient({ live: transport }); client.selectMode('live'); await client.login('fiction@example.invalid', 'fiction');
    assert.equal(client.getSnapshot().notice, code === 'account_locked' ? 'limited' : code); assert.equal(client.getSnapshot().phase, 'signed-out');
    const html = renderToStaticMarkup(React.createElement(AuthBoundary, { client }, 'fixture'));
    assert.doesNotMatch(html, /private-detail/);
  });
}
test('protected machine-code notices preserve authenticated identity; mismatched status codes never trusted', async t => {
  let code = 'host_not_allowed', status = 421;
  const s = await fixture(t, base => r => r.path === '/api/agents/notice-agent' ? Promise.resolve({ status, body: { code, error: 'private-detail' } }) : base(r));
  const original = s.client.getSnapshot(); await s.client.request({ method: 'GET', path: '/api/agents/notice-agent' });
  assert.equal(s.client.getSnapshot().notice, code); assert.equal(s.client.getSnapshot().user, original.user); assert.equal(s.client.getSnapshot().epoch, original.epoch);
  status = 403; code = 'published_password'; await s.client.request({ method: 'GET', path: '/api/agents/notice-agent' }); assert.equal(s.client.getSnapshot().notice, code);
  status = 429; code = 'published_password'; const r = await s.client.request({ method: 'GET', path: '/api/agents/notice-agent' });
  assert.equal(r.body, null); assert.equal(s.client.getSnapshot().notice, 'limited');
});
