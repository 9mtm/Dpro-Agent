require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('../node_modules/typescript');
const { SessionClient, createSameOriginTransport, allowedRequest } = require('../src/session.ts');
const { ChatController } = require('../src/chat.ts');
const { AuthBoundary } = require('../src/AuthBoundary.tsx');
const { createApplicationServer, allowed } = require('../scripts/application-server.cjs');
const { validAgentId } = require('../src/agents.ts');
const { personalityAgentId, personalityRoute } = require('../src/personality-contract.js');
const { projectFrame, SSEParser, CHAT_DEADLINE_MS } = require('../src/chat-protocol.js');
const { retryAfterSeconds } = require('../src/retry-after.js');
const origin = 'http://127.0.0.1:42522';
const ids = { runId: 'fiction-run', messageId: 'fiction-message' };
const owner = { id: 'fiction-owner', email: 'fiction@example.invalid', username: 'Fiction', role: 'owner' };
const login = { status: 200, body: { user: owner, token: 'fiction-token', deviceToken: 'd'.repeat(43) } };
const body = { stream: true, sessionId: 'fiction-session', messages: [{ role: 'user', content: 'Hi' }] };
const frame = value => `data: ${JSON.stringify({ ...ids, ...value })}\n\n`;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const stream = text => new ReadableStream({ start(c) { c.enqueue(Buffer.from(text)); c.close(); } });
async function setup(handler) {
  const calls = [];
  const client = new SessionClient({ mock: async request => {
    calls.push(request);
    if (request.path.endsWith('/login')) return login;
    if (request.path.endsWith('/me')) return { status: 200, body: { user: owner } };
    return handler(request);
  } });
  client.selectMode('mock'); await client.login('fiction@example.invalid', 'fictional');
  const chat = new ChatController(client, () => 'fiction-key');
  return { client, chat, calls };
}
function render(client) { return renderToStaticMarkup(React.createElement(AuthBoundary, { client, initialPage: 'account' }, 'Fixture')); }
test('AuthBoundary constructs mock only without injection, including injected live failure', async () => {
  let constructions = 0;
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(require.resolve('../src/AuthBoundary.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(source, { exports, require(name) {
    if (name === './session-mock') return { createLoginMock() { constructions++; return async () => { throw Error('fiction'); }; } };
    return require(name.startsWith('./') ? '../src/' + name.slice(2) : name);
  } });
  const live = new SessionClient({ live: async () => { throw Error('fictional refusal'); } });
  const output = () => renderToStaticMarkup(React.createElement(exports.AuthBoundary, { client: live }, 'Fixture'));
  // Owner decision 2026-10-15: a live-only build shows no fictional workspace or practice controls.
  assert.doesNotMatch(output(), /Use live sign-in|Fixture workspace|Open offline login mock/); assert.equal(constructions, 0);
  live.selectMode('live'); await live.login('fiction@example.invalid', 'fictional'); output();
  assert.equal(constructions, 0); assert.equal(live.canUse('mock'), false);
  renderToStaticMarkup(React.createElement(exports.AuthBoundary, {}, 'Fixture'));
  assert.equal(constructions, 1);
});
for (const code of ['model_unavailable', 'private_exception', undefined, { private: true }]) test(`typed error allowlist ${JSON.stringify(code)}`, async () => {
  const raw = { ...ids, type: 'error', error: 'private backend text', code, token: 'private', details: 'private' };
  const projected = projectFrame(raw);
  assert.deepEqual(projected, { ...ids, type: 'error', error: 'Chat request failed', ...(code === 'model_unavailable' ? { code } : {}) });
  const p = new SSEParser(ids); const values = p.push(Buffer.from(frame(raw))); p.finish();
  assert.deepEqual(projectFrame(values[0]), projected);
  const s = await setup(() => ({ status: 200, body: null, stream: stream(frame(raw)), streamIds: ids }));
  s.chat.edit('Hi'); await s.chat.send();
  assert.equal(s.chat.getSnapshot().phase, 'unknown');
  assert.match(s.chat.getSnapshot().notice, code === 'model_unavailable' ? /Model unavailable or not reachable/ : /Chat request failed/);
  assert.doesNotMatch(s.chat.getSnapshot().notice, /private/);
  await s.chat.send(); assert.equal(s.calls.filter(c => c.path === '/api/chat').length, 1);
  s.chat.dispose();
});
test('absolute 120-second deadline wins despite heartbeats; explicit unknown notice and no retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(CHAT_DEADLINE_MS, 120000);
  let writer, cancelled = 0;
  const s = await setup(() => ({ status: 200, body: null, streamIds: ids, stream: new ReadableStream({ start(c) { writer = c; }, cancel() { cancelled++; } }) }));
  s.chat.edit('Hi'); const pending = s.chat.send();
  await Promise.resolve(); await Promise.resolve();
  for (let elapsed = 12000; elapsed < 120000; elapsed += 12000) {
    t.mock.timers.tick(12000); writer.enqueue(Buffer.from(': keepalive\n\n'));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(s.chat.getSnapshot().phase, 'sending');
  }
  t.mock.timers.tick(12000); await pending;
  assert.equal(s.chat.getSnapshot().phase, 'unknown');
  assert.match(s.chat.getSnapshot().notice, /time limit reached.*120 seconds.*Outcome unknown/);
  assert.equal(cancelled, 1); await s.chat.send();
  assert.equal(s.calls.filter(c => c.path === '/api/chat').length, 1); s.chat.dispose();
});
test('HTTP gateway timeout states time limit and unknown outcome without resending', async () => {
  const s = await setup(() => ({ status: 504, body: null }));
  s.chat.edit('Hi'); await s.chat.send();
  assert.match(s.chat.getSnapshot().notice, /time limit reached.*120 seconds.*Outcome unknown/);
  assert.equal(s.chat.getSnapshot().phase, 'unknown'); await s.chat.send();
  assert.equal(s.calls.filter(c => c.path === '/api/chat').length, 1); s.chat.dispose();
});
for (const [value, expected] of [['1',1], ['3600',3600], ['0',undefined], ['3601',undefined], ['-1',undefined], ['1.5',undefined], ['01',undefined], [' 1 ',undefined], ['1, 2',undefined], ['Wed, 21 Oct 2015 07:28:00 GMT',undefined], [null,undefined], [['1','2'],undefined]]) test(`bounded delay ${JSON.stringify(value)}`, async () => {
  assert.equal(retryAfterSeconds(value), expected);
  const transport = createSameOriginTransport(origin, async () => new Response(JSON.stringify({ code: 'rate_limited', error: 'private' }), {
    status: 429, headers: { 'Content-Type': 'application/json', ...(typeof value === 'string' && value.trim() === value ? { 'Retry-After': value } : {}) },
  }));
  const result = await transport({ method: 'POST', path: '/api/auth/login', body: { email: 'fiction@example.invalid', password: 'fictional' }, headers: {}, signal: new AbortController().signal });
  assert.equal(result.retryAfterSeconds, expected); assert.deepEqual(result.body, { code: 'rate_limited' });
});
test('login 429 advisory displays and clears on new epoch; late rate limit cannot restore it', async () => {
  let calls = 0, reply = { status: 429, body: { code: 'rate_limited' }, retryAfterSeconds: 23 };
  const client = new SessionClient({ mock: async () => { calls++; return reply; } });
  client.selectMode('mock'); await client.login('fiction@example.invalid', 'fictional');
  assert.match(render(client), /Try again in 23 s/); assert.equal(calls, 1);
  client.cancel(); assert.doesNotMatch(render(client), /Try again in 23 s/);
  const late = deferred(); reply = late.promise;
  const pending = client.login('fiction@example.invalid', 'fictional'); client.cancel();
  late.resolve({ status: 429, body: { code: 'rate_limited' }, retryAfterSeconds: 99 }); await pending;
  assert.equal(client.getSnapshot().retryAfterSeconds, undefined); assert.equal(client.getSnapshot().notice, undefined); assert.equal(calls, 2);
});
for (const kind of ['request', 'chat']) test(`${kind} displays bounded delay and rejects late response after mode round trip`, async () => {
  let reply = { status: 429, body: { code: 'rate_limited' }, retryAfterSeconds: 41 };
  const s = await setup(() => reply);
  const send = () => kind === 'request' ? s.client.request({ method: 'GET', path: '/api/agents' }) : s.client.chat(body, 'fiction-key', () => {}, new AbortController().signal);
  const result = await send(); assert.equal(result.retryAfterSeconds, 41); assert.match(render(s.client), /Try again in 41 s/);
  const late = deferred(); reply = late.promise; const pending = send();
  s.client.selectMode('fixture'); s.client.selectMode('mock'); await s.client.login('fiction@example.invalid', 'fictional');
  late.resolve({ status: 429, body: { code: 'rate_limited' }, retryAfterSeconds: 77 }); await assert.rejects(pending);
  assert.equal(s.client.getSnapshot().phase, 'authenticated'); assert.equal(s.client.getSnapshot().retryAfterSeconds, undefined);
  assert.doesNotMatch(render(s.client), /Try again in/); s.chat.dispose();
});
test('chat 429 notice includes advisory only and remains blocked against retries', async () => {
  const s = await setup(() => ({ status: 429, body: { code: 'rate_limited' }, retryAfterSeconds: 3 }));
  s.chat.edit('Hi'); await s.chat.send(); assert.match(s.chat.getSnapshot().notice, /Try again in 3 s/);
  assert.equal(s.chat.getSnapshot().phase, 'unknown'); await s.chat.send();
  assert.equal(s.calls.filter(c => c.path === '/api/chat').length, 1); s.chat.dispose();
});
for (const id of ['agent', 'a_1.b-2', 'a'.repeat(128), 'bad:agent', '-agent', '.agent', '_agent', 'a..b', 'name-suggestion', 'NAME-SUGGESTION', 'status', 'Status', 'STATUS', 'a'.repeat(129), 'a%3Ab']) test(`shared strict agent id ${id.slice(0,20)}`, () => {
  assert.equal(personalityAgentId, validAgentId);
  const good = ['agent','a_1.b-2','a'.repeat(128)].includes(id);
  assert.equal(validAgentId(id), good);
  for (const path of [`/api/agents/${id}`, `/api/agents/${id}/personality/proposals`]) {
    assert.equal(allowedRequest('GET',path),good); assert.equal(allowed('GET',path),good);
  }
  assert.equal(!!personalityRoute(`/api/agents/${id}/personality/proposals`),good);
});
const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve(s.address().port)));
const close = s => new Promise(resolve => { s.close(resolve); s.closeAllConnections(); });
async function bridge(t, handler) {
  let calls = 0;
  const upstream = http.createServer(async (req,res) => { for await (const chunk of req) {} calls++; handler(req,res); });
  const upstreamPort = await listen(upstream); t.after(() => close(upstream));
  const app = createApplicationServer({ channel:'candidate', upstreamPort });
  const port = await listen(app); t.after(() => close(app));
  const url = `http://127.0.0.1:${port}`;
  return { calls: () => calls, request: (path, payload) => fetch(url + path, { method:'POST', mode:'same-origin', headers:{ Origin:url, 'Content-Type':'application/json', ...(path === '/api/chat' ? {Authorization:'Bearer fictional','Idempotency-Key':'fiction-key'} : {}) }, body: JSON.stringify(payload) }) };
}
test('fictional bridge forwards only bounded Retry-After on 429 and strips other upstream headers', async t => {
  let value = '1', status = 429;
  const s = await bridge(t, (_req,res) => { res.writeHead(status, { 'Content-Type':'application/json', 'Retry-After':value, 'X-Private':'hidden' }); res.end(JSON.stringify({code:'rate_limited',error:'private'})); });
  const values = ['1','3600','0','3601','-1','1.5','01','1, 2','Wed, 21 Oct 2015 07:28:00 GMT', ['1','2']];
  for (value of values) {
    const response = await s.request('/api/auth/login', {email:'fiction@example.invalid',password:'fictional'});
    assert.equal(response.headers.get('retry-after'), ['1','3600'].includes(value) ? value : null);
    assert.equal(response.headers.get('x-private'),null); assert.deepEqual(await response.json(), {code:'rate_limited'});
  }
  value = '2'; status = 403;
  const response = await s.request('/api/auth/login', {email:'fiction@example.invalid',password:'fictional'});
  assert.equal(response.headers.get('retry-after'),null); await response.text(); assert.equal(s.calls(),values.length+1);
});
test('fictional bridge preserves typed model code across second browser projection without raw error text', async t => {
  const s = await bridge(t, (_req,res) => { res.writeHead(200, {'Content-Type':'text/event-stream','X-Run-Id':ids.runId,'X-Message-Id':ids.messageId}); res.end(frame({type:'error',code:'model_unavailable',error:'private backend text',details:'private'})); });
  const response = await s.request('/api/chat',body); const text = await response.text();
  assert.doesNotMatch(text,/private/); const parser = new SSEParser(ids); const frames = parser.push(Buffer.from(text)); parser.finish();
  assert.equal(frames[0].code,'model_unavailable'); assert.equal(s.calls(),1);
});
