require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { createApplicationServer, allowed, LIMIT, RESPONSE_LIMIT } = require('../scripts/application-server.cjs');
const { allowedRequest, SessionClient, createSameOriginTransport } = require('../src/session.ts');
const { HEADERS } = require('../scripts/preview.cjs');
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const token = 'fiction-only-token';
const user = { id: 'owner-test', email: 'fiction@example.invalid', username: 'Fiction', role: 'owner', api_key: 'private-fixture-key' };
const hash = 'a'.repeat(64);
const { fixtureProposal, fixtureContext } = require('../src/memory-fixture.ts');
const memoryProposal = () => ({ ...fixtureProposal(fixtureContext), id: 'p1' });
const memoryDrawer = () => ({ drawer: { kind: 'owner' }, drawerId: 'owner', agentId: 'main', revision: 3, hash, count: 1, content: 'Fictional text', path: 'private/server/path' });
const memorySummary = () => { const { changes, ...rest } = memoryProposal(); return { ...rest, counts: { add: 1, update: 1, delete: 1 } }; };
test('memory display pages cross the HTTP bridge with exact cursors and reviewed fields only', async t => {
  const row = { id: '00000000-0000-4000-8000-000000000001', type: 'fact', content: 'Fictional display memory', createdAt: '2026-01-01T00:00:00.000Z', embedding: [1, 2], userId: 'private-owner', metadata: { internal: true } };
  const s = await setup(t, (req, res) => res.end(JSON.stringify({ memories: [row], nextCursor: req.url.includes('?') ? null : 'opaque_next', total: 2 })));
  for (const target of ['/api/memory/page', '/api/memory/page?cursor=opaque_next']) {
    const r = await s.request(target); assert.equal(r.status, 200);
    const b = JSON.parse(r.text); assert.equal(b.memories.length, 1); assert.equal(b.total, 2);
    assert.doesNotMatch(r.text, /embedding|userId|metadata|private-owner/);
  }
  assert.deepEqual(s.calls.map(c => c.path), ['/api/memory/page', '/api/memory/page?cursor=opaque_next']);
  assert.ok((await s.request('/api/memory/page?cursor=opaque_next&user=other')).status >= 400);
  assert.equal(s.calls.length, 2);
});
async function setup(t, handler, options = {}) {
  const calls = [];
  const backend = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const call = { path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }; calls.push(call);
    res.setHeader('Content-Type', 'application/json');
    if (handler) return handler(req, res, call);
    res.end(JSON.stringify(req.url === '/api/auth/login' ? { user, token, deviceToken: 'd'.repeat(43) } : req.url === '/api/auth/me' ? { user } : req.url === '/api/auth/logout' ? { success: true } : { proposals: [] }));
  });
  const backendPort = await listen(backend);
  const app = createApplicationServer({ channel: 'candidate', upstreamPort: backendPort, ...options });
  const port = await listen(app);
  t.after(async () => { await close(app); await close(backend); });
  const origin = `http://127.0.0.1:${port}`;
  const request = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { Origin: origin, Accept: 'application/json', ...(path === '/api/auth/login' ? {} : { Authorization: `Bearer ${token}` }), ...(bytes === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) }), ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(bytes);
  });
  return { app, backend, backendPort, port, origin, calls, request };
}
test('mocked HTTP client wiring: fixture → explicit live login → me → read/decision/name → all-device logout', async t => {
  const s = await setup(t, (req, res) => {
    const value = req.url === '/api/auth/login' ? { user, token, deviceToken: 'd'.repeat(43) } : req.url === '/api/auth/me' ? { user } : req.url === '/api/auth/logout' ? { success: true } : req.url.endsWith('/approve') ? { proposal: { ...memoryProposal(), status: 'approved' }, revision: 2, applied: { added: [], updated: [], deleted: [] } } : req.url.includes('/files/') ? memoryDrawer() : /\/p1(?:\/reject)?$/.test(req.url) ? memoryProposal() : { proposals: [] };
    res.end(JSON.stringify(value));
  });
  // Test-only origin substitution; production transport's fixed-origin gate stays intact.
  const fetcher = async (url, init) => {
    const response = await fetch(s.origin + new URL(url).pathname + new URL(url).search, { ...init, headers: { ...init.headers, Origin: s.origin } });
    return { status: response.status, headers: response.headers, redirected: response.redirected, url, json: () => response.json() };
  };
  const client = new SessionClient({ live: createSameOriginTransport('http://127.0.0.1:42522', fetcher) });
  assert.equal(client.getSnapshot().mode, 'fixture'); assert.equal(s.calls.length, 0);
  client.selectMode('live'); await client.login('fiction@example.invalid', 'fiction-only');
  assert.equal(client.getSnapshot().phase, 'authenticated');
  for (const path of ['/api/memory/files/owner?agentId=main', '/api/memory/proposals?status=pending', '/api/memory/proposals/p1']) assert.equal((await client.request({ method: 'GET', path })).status, 200);
  await client.request({ method: 'POST', path: '/api/memory/proposals/p1/approve', body: { expectedReviewHash: hash } });
  await client.request({ method: 'POST', path: '/api/memory/proposals/p1/reject', body: { expectedReviewHash: hash } });
  await client.request({ method: 'POST', path: '/api/agents/name-suggestion', body: { language: 'en', exclude: [] } });
  await client.logoutAllDevices(); assert.equal(client.getSnapshot().notice, 'logout-confirmed');
  assert.ok(!JSON.stringify(client.getSnapshot()).includes(token));
  assert.equal(s.calls.length, 9);
  for (const call of s.calls) { assert.equal(call.headers.host, `127.0.0.1:${s.backendPort}`); assert.equal(call.headers.origin, s.origin); assert.equal(call.headers.cookie, undefined); }
});
test('auth responses project user fields and never relay cookie or error secrets', async t => {
  const s = await setup(t);
  const login = await s.request('/api/auth/login', { method: 'POST', body: { email: 'a', password: 'b' }, headers: { Cookie: 'ignored=private', 'User-Agent': 'not-forwarded' } });
  assert.equal(login.status, 200); assert.ok(!login.text.includes('api_key')); assert.equal(s.calls[0].headers.cookie, undefined); assert.equal(s.calls[0].headers['user-agent'], undefined);
  const me = await s.request('/api/auth/me'); assert.ok(!me.text.includes(token));
  for (const [k,v] of Object.entries(HEADERS)) assert.equal(login.headers[k.toLowerCase()], v);
});
for (const status of [401, 403, 409]) test(`status ${status} retained, only reviewed decision code survives`, async t => {
  const s = await setup(t, (_req, res) => { res.statusCode = status; res.end(JSON.stringify({ error: token, code: 'review_changed', api_key: 'private' })); });
  const result = await s.request('/api/memory/proposals/p1/approve', { method: 'POST', body: { expectedReviewHash: hash } });
  assert.equal(result.status, status); assert.equal(result.text, status === 409 ? '{"code":"review_changed"}' : 'null');
});
const invalid = [
 ['/api/setup/status', {}], ['/api/auth/register', {method:'POST',body:{}}], ['/api/agents/main', {method:'PUT',body:{name:'x'}}],
 ['/api/memory/proposals?status=approved', {}], ['/api/memory/proposals?status=pending&url=http://evil.invalid', {}],
 ['/api/memory/files/owner?agentId=../x', {}], ['/api/memory/files/%6fwner?agentId=main', {}], ['/api/memory/proposals/../auth/me', {}],
 ['/api/memory/proposals/%2fme', {}], ['http://evil.invalid/api/auth/me', {}], ['//evil.invalid/api/auth/me', {}],
 ['/api/auth/me', {method:'DELETE'}], ['/api/auth/me', {headers:{Host:'evil.invalid'}}], ['/api/auth/me',{headers:{Origin:'http://evil.invalid'}}],
 ['/api/auth/me',{headers:{'Sec-Fetch-Site':'same-site'}}], ['/api/auth/me',{headers:{Authorization:'Basic bad'}}],
 ['/api/auth/me',{headers:{'X-Forwarded-Host':'evil.invalid'}}], ['/api/auth/me',{headers:{Connection:'authorization'}}],
 ['/api/auth/me',{headers:{'X-HTTP-Method-Override':'POST'}}], ['/api/auth/me',{body:{}}],
 ['/api/auth/login',{method:'POST',body:'{'}], ['/api/auth/login',{method:'POST',body:{email:'a',password:'b',extra:true}}],
 ['/api/auth/login',{method:'POST',body:{email:'a',password:'b'},headers:{Origin:''}}],
 ['/api/auth/login',{method:'POST',body:{email:'a',password:'b'},headers:{'Content-Type':'text/plain'}}],
 ['/api/auth/logout',{method:'POST',body:{}}], ['/api/memory/proposals/p1/approve',{method:'POST',body:{expectedReviewHash:hash,note:'extra'}}],
 ['/api/auth/login',{method:'POST',body:'x'.repeat(LIMIT+1)}],
];
for (const [index, [path, options]] of invalid.entries()) test(`reject boundary ${index + 1} before any upstream I/O`, async t => {
  const s = await setup(t); const result = await s.request(path, options); assert.ok(result.status >= 400); assert.equal(s.calls.length, 0); assert.ok(!result.text.includes(token));
});
for (const mode of ['redirect', 'cookie', 'html', 'json', 'oversize', 'compressed', 'disconnect']) test(`upstream ${mode} fails closed`, async t => {
  let sinkCalls = 0; const sink = http.createServer((_req, res) => { sinkCalls++; res.end(); }); const sinkPort = await listen(sink); t.after(() => close(sink));
  const s = await setup(t, (_req, res) => {
    if (mode === 'redirect') { res.statusCode = 302; res.setHeader('Location', `http://127.0.0.1:${sinkPort}/`); }
    if (mode === 'cookie') res.setHeader('Set-Cookie', `token=${token}`);
    if (mode === 'html') res.setHeader('Content-Type', 'text/html');
    if (mode === 'compressed') res.setHeader('Content-Encoding', 'gzip');
    if (mode === 'disconnect') return res.destroy();
    res.end(mode === 'json' ? '{' : mode === 'oversize' ? 'x'.repeat(RESPONSE_LIMIT + 1) : '{}');
  });
  const result = await s.request('/api/auth/me'); assert.equal(result.status, 502); assert.equal(result.headers.location, undefined); assert.equal(result.headers['set-cookie'], undefined); assert.equal(sinkCalls, 0); assert.ok(!result.text.includes(token));
});
test('absolute timeout aborts upstream and does not retry', async t => {
  let aborted; const ended = new Promise(resolve => { aborted = resolve; });
  const s = await setup(t, (_req, res) => { res.on('close', aborted); }, { timeoutMs: 100 });
  const response = await s.request('/api/auth/me'); assert.equal(response.status, 504); await ended; assert.equal(s.calls.length, 1);
});
test('client disconnect cancels in-flight upstream', async t => {
  let seen, stopped; const entered = new Promise(r => { seen = r; }); const closed = new Promise(r => { stopped = r; });
  const s = await setup(t, (_req, res) => { res.on('close', stopped); seen(); });
  const req = http.get({ host:'127.0.0.1', port:s.port, path:'/api/auth/me', headers:{Authorization:`Bearer ${token}`} }); req.on('error',()=>{});
  await entered; req.destroy(); await closed; assert.equal(s.calls.length,1);
});
test('validated static candidate has same CSP; fixture entry unchanged; no query live toggle', async t => {
  const before = fs.readFileSync(require('node:path').join(__dirname,'../dist/current.json'));
  const s = await setup(t);
  // Native fetch adds no Authorization to static requests.
  const response = await fetch(s.origin); assert.equal(response.status,200); assert.equal(response.headers.get('content-security-policy'),HEADERS['Content-Security-Policy']);
  assert.equal((await fetch(s.origin+'/?live=true')).status,400);
  assert.match(fs.readFileSync(require('node:path').join(__dirname,'../src/main.tsx'),'utf8'),/<App\/>/);
  assert.deepEqual(fs.readFileSync(require('node:path').join(__dirname,'../dist/current.json')),before);
  assert.equal(s.calls.length,0);
});
test('strict listener conflict leaves original owned listener functioning', async t => {
  const s = await setup(t); const other = createApplicationServer({channel:'candidate',upstreamPort:s.backendPort});
  await assert.rejects(new Promise((resolve,reject)=>{other.once('error',reject);other.listen({host:'127.0.0.1',port:s.port,exclusive:true},resolve);}),{code:'EADDRINUSE'});
  assert.equal((await s.request('/api/auth/me')).status,200);
});
test('server/client allowlist parity for approved and hostile vectors', () => {
  const good = [['/api/auth/me',{}],['/api/memory/proposals?status=pending',{}],['/api/memory/files/project%3Aone?agentId=main',{}],['/api/memory/files/people%3Aa%40b?agentId=main',{}],['/api/auth/login',{method:'POST',body:{email:'a',password:'b'}}],['/api/memory/proposals/p1/reject',{method:'POST',body:{expectedReviewHash:hash}}],['/api/agents/name-suggestion',{method:'POST',body:{language:'en',exclude:[]}}]];
  for(const [path,o] of [...invalid,...good]) assert.equal(allowed(o.method||'GET',path,o.body),allowedRequest(o.method||'GET',path,o.body),path);
  assert.throws(()=>createApplicationServer({channel:'unsafe'}));
  assert.throws(()=>createApplicationServer({channel:'candidate',upstreamPort:'http://evil.invalid'}));
});
test('duplicate sensitive headers and transfer encoding rejected without upstream', async t => {
  const s = await setup(t);
  for (const extra of [`Authorization: Bearer ${token}\r\nAuthorization: Bearer other`, 'Transfer-Encoding: chunked']) {
    const net = require('node:net');
    const result = await new Promise((resolve,reject)=> {
      let output=''; const socket=net.connect(s.port,'127.0.0.1',()=>socket.end(`GET /api/auth/me HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nConnection: close\r\n${extra}\r\n\r\n${extra.startsWith('Transfer')?'0\r\n\r\n':''}`));
      socket.on('data',chunk=>output+=chunk);socket.on('end',()=>resolve(output));socket.on('error',reject);
    });
    assert.ok(!result.includes('200 OK')); assert.equal(s.calls.length,0);
  }
});
test('streamed oversize response is bounded without Content-Length', async t => {
  const s=await setup(t,(_req,res)=>{res.write('"');res.end('x'.repeat(RESPONSE_LIMIT+1));});
  assert.equal((await s.request('/api/auth/me')).status,502);
});
test('slow incoming body deadline closes connection without contacting backend', async t => {
  const s=await setup(t,undefined,{timeoutMs:100});
  const status=await new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:s.port,path:'/api/auth/login',method:'POST',headers:{Origin:s.origin,'Content-Type':'application/json','Content-Length':100}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject);req.write('{');
  });
  assert.equal(status,504); assert.equal(s.calls.length,0);
});
test('malformed UTF-8 body fails closed', async t => {
  const s=await setup(t);
  const status=await new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:s.port,path:'/api/auth/login',method:'POST',headers:{Origin:s.origin,'Content-Type':'application/json','Content-Length':2}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject);req.end(Buffer.from([0xc3,0x28]));
  });
  assert.equal(status,400);assert.equal(s.calls.length,0);
});
test('unknown hashed memory fields fail closed instead of being stripped', async t=>{
  const s=await setup(t,(_req,res)=>res.end(JSON.stringify({content:'exact reviewed content',changes:[{content:'text',api_key:token,password:'private'}]})));
  const response=await s.request('/api/memory/proposals/p1'); assert.equal(response.status,502); assert.equal(response.text,'null');
});

const memoryRoutes = [
  ['/api/memory/files/owner?agentId=main', memoryDrawer],
  ['/api/memory/proposals?status=pending', () => ({ proposals: [memorySummary()] })],
  ['/api/memory/proposals', () => ({ proposals: [memorySummary()] })],
  ['/api/memory/proposals/p1', memoryProposal],
  ['/api/memory/proposals/p1/reject', () => ({ ...memoryProposal(), status: 'rejected' })],
  ['/api/memory/proposals/p1/approve', () => ({ proposal: { ...memoryProposal(), status: 'approved' }, revision: 4, applied: { added: ['a'], updated: ['b'], deleted: ['c'] } })],
];
const routeOptions = path => /\/(approve|reject)$/.test(path) ? { method: 'POST', body: { expectedReviewHash: hash } } : {};
for (const [path, make] of memoryRoutes) test(`exact response projection ${path}: unknown metadata never leaves bridge`, async t => {
  const input = make(); input.secret = token; input.access_token = token; input.privateKey = token;
  const proposal = input.proposal ?? input.proposals?.[0] ?? (input.changes ? input : undefined);
  if (proposal) { proposal.refresh_token = token; proposal.drawer.secret = token; }
  if (input.applied) input.applied.secret = token;
  if (input.proposals) input.proposals[0].counts.secret = token;
  const s = await setup(t, (_req, res) => res.end(JSON.stringify(input)));
  const response = await s.request(path, routeOptions(path));
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.text, /private\/server\/path|privateKey|access_token|refresh_token|secret/);
  const expected = make(); if (expected.path) delete expected.path;
  assert.deepEqual(JSON.parse(response.text), expected);
});
for (const [path, make] of memoryRoutes) test(`missing/wrong schema ${path} returns 502`, async t => {
  let payload; const s = await setup(t, (_req, res) => res.end(JSON.stringify(payload)));
  const original = make();
  for (const key of Object.keys(original).filter(k => k !== 'path')) {
    for (const value of (Array.isArray(original[key]) ? [undefined, {}] : [undefined, [], {}])) {
      payload = { ...make(), [key]: value };
      assert.equal((await s.request(path, routeOptions(path))).status, 502, `${key}: ${JSON.stringify(value)}`);
    }
  }
});
for (const op of ['add', 'update', 'delete']) for (const location of ['change', 'before', 'after']) {
  if (op === 'add' && location === 'before' || op === 'delete' && location === 'after') continue;
  test(`hashed ${op}/${location} unknown keys rejected by every detail/decision route`, async t => {
    let payload; const s = await setup(t, (_req, res) => res.end(JSON.stringify(payload)));
    const entry = { type: 'fact', importance: 5, content: 'exact text' };
    for (const extra of ['metadata', 'tags', 'secret', 'access_token', 'refresh_token', 'api-key', 'privateKey', '__proto__']) {
      const c = { op, ...(op === 'add' ? {} : { id: 'm1', before: { ...entry } }), ...(op === 'delete' ? {} : { after: { ...entry } }) };
      Object.defineProperty(location === 'change' ? c : c[location], extra, { value: token, enumerable: true });
      for (const path of ['/api/memory/proposals/p1', '/api/memory/proposals/p1/approve', '/api/memory/proposals/p1/reject']) {
        const p = { ...memoryProposal(), changes: [c] };
        payload = path.endsWith('/approve') ? { proposal: p, revision: 4, applied: { added: [], updated: [], deleted: [] } } : p;
        const result = await s.request(path, routeOptions(path)); assert.equal(result.status, 502); assert.equal(result.text, 'null');
      }
    }
  });
}
for (const char of ['ع', '漢', '😀', '\u0001']) test(`Unicode drawer wire byte boundary ${JSON.stringify(char)}`, async t => {
  let payload; const s = await setup(t, (_req, res) => res.end(payload));
  const path = '/api/memory/files/owner?agentId=main';
  const empty = { ...memoryDrawer(), content: '' }; delete empty.path;
  const overhead = Buffer.byteLength(JSON.stringify(empty));
  const unit = Buffer.byteLength(JSON.stringify(char)) - 2;
  const units = Math.floor((RESPONSE_LIMIT - overhead) / unit);
  // Arabic cannot reach 4 MiB within the independent 2M UTF-16 code-unit cap.
  const count = Math.min(units, Math.floor(2000000 / char.length));
  const content = char.repeat(count);
  payload = JSON.stringify({ ...empty, content });
  assert.equal((await s.request(path)).status, 200);
  if (count === units) {
    const fill = RESPONSE_LIMIT - Buffer.byteLength(payload);
    payload = JSON.stringify({ ...empty, content: content + 'x'.repeat(fill) });
    assert.equal(Buffer.byteLength(payload), RESPONSE_LIMIT);
    const at = await s.request(path); assert.equal(at.status, 200); assert.equal(JSON.parse(at.text).content, content + 'x'.repeat(fill));
    payload = JSON.stringify({ ...empty, content: content + 'x'.repeat(fill + 1) });
    assert.equal(Buffer.byteLength(payload), RESPONSE_LIMIT + 1); assert.equal((await s.request(path)).status, 502);
  } else {
    payload = JSON.stringify({ ...empty, content: content + 'x' }); assert.equal((await s.request(path)).status, 502);
  }
});
test('entry Unicode code-unit cap: exact text retained at 50000, 50001 refused over HTTP', async t => {
  let payload; const s = await setup(t, (_req, res) => res.end(JSON.stringify(payload)));
  for (const content of ['ع'.repeat(50000), '漢'.repeat(50000), '😀'.repeat(25000)]) {
    payload = { ...memoryProposal(), changes: [{ op: 'add', after: { type: 'fact', importance: 5, content } }] };
    const result = await s.request('/api/memory/proposals/p1'); assert.equal(result.status, 200); assert.equal(JSON.parse(result.text).changes[0].after.content, content);
    payload.changes[0].after.content += 'x'; assert.equal((await s.request('/api/memory/proposals/p1')).status, 502);
  }
});
for (const [status, code] of [[401,'unauthenticated'],[403,'forbidden'],[403,'inactive_user'],[403,'origin_not_allowed'],[403,'published_password'],[403,'account_inactive'],[429,'rate_limited'],[429,'account_locked'],[421,'host_not_allowed']]) test(`reviewed auth projection ${status}/${code}`, async t => {
  const s = await setup(t, (_req, res) => { res.statusCode = status; res.end(JSON.stringify({ code, error: token, message: token, secret: token })); });
  const result = await s.request('/api/auth/me'); assert.equal(result.status, status); assert.deepEqual(JSON.parse(result.text), code === 'account_locked' ? null : { code });
});

test('malformed nested non-hashed memory values reject; metadata extras are projected only', async t => {
  let payload; const s = await setup(t, (_req, res) => res.end(JSON.stringify(payload)));
  const patches = [{ drawer: { kind: 'owner', key: 'unexpected' } }, { reasons: [{ secret: 'hidden' }] }, { createdAt: 'not-time' }, { importance: 11 }];
  for (const patch of patches.slice(0, 3)) {
    payload = { ...memoryProposal(), ...patch }; assert.equal((await s.request('/api/memory/proposals/p1')).status, 502);
  }
  for (const counts of [{ add: -1, update: 0, delete: 0 }, { add: 0, update: '1', delete: 0 }, { add: 0, update: 0 }]) {
    payload = { proposals: [{ ...memorySummary(), counts }] }; assert.equal((await s.request('/api/memory/proposals?status=pending')).status, 502);
  }
  for (const value of [0, 11, 1.5, '5']) {
    payload = { ...memoryProposal(), changes: [{ op: 'add', after: { type: 'fact', importance: value, content: 'text' } }] };
    assert.equal((await s.request('/api/memory/proposals/p1')).status, 502);
  }
});
test('chunked Unicode memory response obeys aggregate UTF-8 cap without Content-Length', async t => {
  const content = '漢'.repeat(1400000); const bytes = Buffer.from(JSON.stringify({ ...memoryDrawer(), content }));
  assert.ok(content.length < 2000000); assert.ok(bytes.length > RESPONSE_LIMIT);
  const s = await setup(t, (_req, res) => { res.write(bytes.subarray(0, 100)); res.end(bytes.subarray(100)); });
  const result = await s.request('/api/memory/files/owner?agentId=main'); assert.equal(result.status, 502); assert.equal(result.text, 'null');
});
test('malformed upstream UTF-8 memory text cannot become replacement characters', async t => {
  const s = await setup(t, (_req, res) => res.end(Buffer.concat([Buffer.from('{"content":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')])));
  assert.equal((await s.request('/api/memory/files/owner?agentId=main')).status, 502);
});
test('HTTP decision timeout remains unknown and is never retried', async t => {
  const mock = require('../src/memory-mock.ts').createMemoryMock();
  const s = await setup(t, async (req, res) => {
    if (req.method === 'POST') return;
    const reply = await mock.transport({ method: 'GET', path: req.url, signal: new AbortController().signal, headers: {} });
    res.end(JSON.stringify(reply.body));
  }, { timeoutMs: 1000 });
  const { createMemoryAdapter, MemoryController } = require('../src/memory.ts');
  const transport = async r => { const reply = await s.request(r.path, r); return { status: reply.status, body: JSON.parse(reply.text) }; };
  const ctrl = new MemoryController(createMemoryAdapter(transport, () => true), mock.context);
  await ctrl.load(); await ctrl.open(ctrl.getSnapshot().proposals[0].id); await ctrl.decide('approve', ctrl.getSnapshot().review);
  assert.equal(ctrl.getSnapshot().phase, 'unknown'); assert.equal(ctrl.adapter.uncertainDecisions.size, 1);
  await ctrl.load(); await ctrl.open(ctrl.getSnapshot().proposals[0].id); await ctrl.decide('approve', ctrl.getSnapshot().review);
  assert.equal(s.calls.filter(c => c.method === 'POST').length, 1);
});

test('device contract HTTP: exact login body/response, rotation, no token on other routes or headers', async t => {
  const device = n => `fictional-http-${n}`.padEnd(43, '_'); let serial = 0;
  const s = await setup(t, (req, res) => {
    const value = req.url.endsWith('/login') ? { user, token, deviceToken: device(++serial), extra: 'private' }
      : req.url.endsWith('/me') ? { user, deviceToken: device(99), extra: 'private' } : { success: true, deviceToken: device(99) };
    res.end(JSON.stringify(value));
  });
  const fetcher = async (url, init) => {
    const r = await fetch(s.origin + new URL(url).pathname, { ...init, headers: { ...init.headers, Origin: s.origin } });
    if(new URL(url).pathname.endsWith('/login')) assert.match(r.headers.get('set-cookie'), /HttpOnly/); assert.equal(r.headers.get('deviceToken'), null);
    return { status: r.status, headers: r.headers, url, json: () => r.json() };
  };
  const client = new SessionClient({ live: createSameOriginTransport('http://127.0.0.1:42522', fetcher) }); client.selectMode('live');
  await client.login(user.email, 'fictional'); await client.logoutAllDevices(); await client.login(user.email, 'fictional'); await client.login(user.email, 'fictional');
  assert.equal(client.getSnapshot().phase, 'authenticated');
  const logins = s.calls.filter(c => c.path.endsWith('/login')).map(c => JSON.parse(c.body));
  assert.deepEqual(logins, [{ email: user.email, password: 'fictional' }, { email: user.email, password: 'fictional', deviceToken: device(1) }, { email: user.email, password: 'fictional', deviceToken: device(2) }]);
  for (const c of s.calls) { assert.ok(!JSON.stringify(c.headers).includes('fictional-http')); assert.ok(!c.path.includes('fictional-http')); if (!c.path.endsWith('/login')) assert.equal(c.body, ''); }
  assert.ok(!JSON.stringify(client.getSnapshot()).includes('fictional-http'));
});
for (const [index, value] of [null, '', {}, 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '=', 'a'.repeat(42) + '\n', 'a'.repeat(43) + '\n'].entries()) {
  test(`device HTTP malformed input blocked before upstream: case ${index}`, async t => {
    const s = await setup(t); const r = await s.request('/api/auth/login', { method: 'POST', body: { email: 'a', password: 'b', deviceToken: value } });
    assert.equal(r.status, 400); assert.equal(s.calls.length, 0); assert.equal(r.text, 'null');
  });
  test(`device HTTP malformed success redacted: case ${index}`, async t => {
    const s = await setup(t, (_req, res) => res.end(JSON.stringify({ user, token, deviceToken: value, message: 'private' })));
    const r = await s.request('/api/auth/login', { method: 'POST', body: { email: 'a', password: 'b' } });
    assert.equal(r.status, 502); assert.equal(r.text, 'null'); assert.equal(s.calls.length, 1);
  });
}
test('device HTTP rate limit and Retry-After never schedule a second request', async t => {
  const s = await setup(t, (_req, res) => { res.writeHead(429, { 'Retry-After': '0' }); res.end(JSON.stringify({ code: 'rate_limited', deviceToken: 'd'.repeat(43), message: 'private' })); });
  const client = new SessionClient({ live: createSameOriginTransport('http://127.0.0.1:42522', async (url, init) => {
    const r = await fetch(s.origin + new URL(url).pathname, { ...init, headers: { ...init.headers, Origin: s.origin } });
    return { status: r.status, headers: r.headers, url, json: () => r.json() };
  }) });
  client.selectMode('live'); await client.login('a', 'b'); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(client.getSnapshot().notice, 'rate_limited'); assert.equal(client.getSnapshot().phase, 'signed-out'); assert.equal(s.calls.length, 1);
});
test('auth responses keep the setup name (trimmed, bounded) and nothing else extra', async t => {
  for (const [fullName, kept] of [['  Fiction Owner ', 'Fiction Owner'], ['x'.repeat(201), undefined], [7, undefined], ['', undefined]]) {
    const s = await setup(t, (req, res) => res.end(JSON.stringify(req.url === '/api/auth/login' ? { user: { ...user, full_name: fullName }, token, deviceToken: 'd'.repeat(43) } : { user: { ...user, full_name: fullName } })));
    const me = JSON.parse((await s.request('/api/auth/me')).text);
    assert.equal(me.user.full_name, kept);
    assert.deepEqual(Object.keys(me.user).sort(), ['email', 'id', 'role', 'username', ...(kept ? ['full_name'] : [])].sort());
  }
});

test('remembered session uses HttpOnly cookie, validates bearer upstream and clears on logout', async t => {
 const s=await setup(t);
 const login=await s.request('/api/auth/login',{method:'POST',body:{email:'fiction@example.invalid',password:'fiction-only'}});
 assert.equal(login.status,200);const cookie=login.headers['set-cookie'][0];assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,/Max-Age=604800/);
 const resumed=await s.request('/api/auth/me',{headers:{Authorization:'Bearer dpro-remembered-session',Cookie:cookie.split(';')[0]}});assert.equal(resumed.status,200);assert.equal(s.calls.at(-1).headers.authorization,`Bearer ${token}`);
 assert.equal((await s.request('/api/auth/me',{headers:{Authorization:'Bearer dpro-remembered-session'}})).status,401);
 assert.equal((await s.request('/api/auth/me',{headers:{Authorization:'Bearer dpro-remembered-session',Cookie:cookie.split(';')[0],Origin:'http://other.invalid'}})).status,403);
 const logout=await s.request('/api/auth/logout',{method:'POST',headers:{Authorization:'Bearer dpro-remembered-session',Cookie:cookie.split(';')[0]}});assert.equal(logout.status,200);assert.match(logout.headers['set-cookie'][0],/Max-Age=0/);
});
test('verification challenges cross local bridge without cookies; recovery clears remembered session',async t=>{
 let value={verificationRequired:true,challenge:'a'.repeat(43),nonce:'b'.repeat(43),expiresAt:1800000000000,verificationMethod:'totp',secret:'strip-me'};
 const s=await setup(t,(_req,res)=>res.end(JSON.stringify(value)));
 const body={email:'fixture@example.invalid',password:'fiction-only'};
 const challenge=await s.request('/api/auth/login',{method:'POST',body});assert.equal(challenge.status,200);
 assert.equal(challenge.headers['set-cookie'],undefined);assert.equal(JSON.parse(challenge.text).verificationRequired,true);assert.doesNotMatch(challenge.text,/strip-me/);
 value={recovered:true,requiresSignIn:true};
 const recovered=await s.request('/api/auth/login',{method:'POST',body:{...body,recovery:true,verification:{challenge:'a'.repeat(43),nonce:'b'.repeat(43),code:'c'.repeat(32)}}});assert.equal(recovered.status,200);assert.match(recovered.headers['set-cookie'][0],/Max-Age=0/);assert.equal(JSON.parse(recovered.text).token,undefined);
 value={verificationRequired:true,challenge:'a'.repeat(43),nonce:'b'.repeat(43),expiresAt:1800000000000,verificationMethod:'totp',token:'forbidden'};
 const invalid=await s.request('/api/auth/login',{method:'POST',body});assert.equal(invalid.status,502);assert.equal(invalid.headers['set-cookie'],undefined);
 value={user,token,deviceToken:'d'.repeat(43)};
 const forbidden=await s.request('/api/auth/login',{method:'POST',body:{...body,recovery:true}});assert.equal(forbidden.status,502);assert.equal(forbidden.headers['set-cookie'],undefined);
});

test('approval proof HTTP projection never creates a session or forwards unreviewed fields', async t => {
 const path='/api/approvals/12345678-1234-1234-1234-123456789012';
 let value={challenge:'c'.repeat(43),expiresAt:1800000000000,privateMetadata:'strip-me'};
 const s=await setup(t,(_req,res)=>res.end(JSON.stringify(value)));
 const issued=await s.request(path+'/verification',{method:'POST',body:{paramsHash:hash}});
 assert.equal(issued.status,200);assert.deepEqual(JSON.parse(issued.text),{challenge:'c'.repeat(43),expiresAt:1800000000000});assert.equal(issued.headers['set-cookie'],undefined);
 value={receipt:'r'.repeat(43),expiresAt:1800000000000,privateMetadata:'strip-me'};
 const completed=await s.request(path+'/verification/complete',{method:'POST',body:{paramsHash:hash,challenge:'c'.repeat(43),code:'012345'}});
 assert.equal(completed.status,200);assert.deepEqual(JSON.parse(completed.text),{receipt:'r'.repeat(43),expiresAt:1800000000000});assert.equal(completed.headers['set-cookie'],undefined);
 value={...value,token:'forbidden'};
 const mixed=await s.request(path+'/verification/complete',{method:'POST',body:{paramsHash:hash,challenge:'c'.repeat(43),code:'012345'}});
 assert.equal(mixed.status,502);assert.equal(mixed.text,'null');assert.equal(mixed.headers['set-cookie'],undefined);
 const count=s.calls.length;
 const spoofed=await s.request(path+'/verification',{method:'POST',body:{paramsHash:hash,userId:'other'}});
 assert.equal(spoofed.status,400);assert.equal(s.calls.length,count);
 assert.deepEqual(s.calls.map(call=>call.path),[path+'/verification',path+'/verification/complete',path+'/verification/complete']);
});

test('approval metadata and decision survive client plus bridge conversation-route overlap',async t=>{
 const id='12345678-1234-1234-1234-123456789012',path='/api/approvals/'+id,paramsHash='a'.repeat(64),receipt='r'.repeat(43);
 const row={id,status:'pending',agentId:'fixture-agent',toolName:'fixture_action',category:'other',paramsPreview:{text:'fixture'},truncated:false,requestedAt:'2026-10-22T09:00:00Z',expiresAt:'2026-10-23T09:00:00Z',decidedAt:null,executedAt:null,resultPreview:null,error:null,params:{text:'fixture'},paramsHash,maskedFields:[],runScope:null,verificationRequired:true};
 const s=await setup(t,(req,res)=>res.end(JSON.stringify(req.url==='/api/auth/login'?{user,token,deviceToken:'d'.repeat(43)}:req.url==='/api/auth/me'?{user}:req.url.endsWith('/approve')?{approval:{...row,status:'executed'},result:{ok:true}}:{approval:row})));
 const client=new SessionClient({live:createSameOriginTransport('http://127.0.0.1:42522',async(url,init)=>{const response=await fetch(s.origin+new URL(url).pathname,{...init,headers:{...init.headers,Origin:s.origin}});return {status:response.status,headers:response.headers,url,json:()=>response.json()};})});
 client.selectMode('live');await client.login(user.email,'fiction-only');
 const detail=await client.request({method:'GET',path});assert.equal(detail.body.approval.verificationRequired,true);assert.equal(detail.body.approval.agentId,'fixture-agent');assert.equal(detail.body.approval.requestedAt,row.requestedAt);assert.equal(detail.body.approval.paramsHash,paramsHash);
 const decided=await client.request({method:'POST',path:path+'/approve',body:{paramsHash,verificationReceipt:receipt}});assert.deepEqual(decided.body.result,{ok:true});assert.equal(decided.body.approval.status,'executed');assert.deepEqual(JSON.parse(s.calls.at(-1).body),{paramsHash,verificationReceipt:receipt});
});
test('reviewer proof bridge preserves only opaque proof, creates no cookies and refuses identity injection',async t=>{
 const ref={policyId:'12345678-1234-1234-1234-123456789012',policyRevision:1,approvalId:'12345678-1234-1234-1234-123456789013',paramsHash:hash,requestHash:'b'.repeat(64),policyHash:'c'.repeat(64),decision:'approve'};
 let value={challenge:'d'.repeat(43),expiresAt:1800000000000,private:'strip'};const s=await setup(t,(_req,res)=>res.end(JSON.stringify(value)));
 const issued=await s.request('/api/reviewer-votes/challenge',{method:'POST',body:ref});assert.equal(issued.status,200);assert.deepEqual(JSON.parse(issued.text),{challenge:value.challenge,expiresAt:value.expiresAt});assert.equal(issued.headers['set-cookie'],undefined);
 value={receipt:'e'.repeat(43),expiresAt:1800000000000};const payload={...ref,challenge:'d'.repeat(43),code:'012345'};
 const proof=await s.request('/api/reviewer-votes/complete',{method:'POST',body:payload});assert.equal(proof.status,200);assert.equal(proof.headers['set-cookie'],undefined);assert.deepEqual(JSON.parse(proof.text),value);
 value={...value,token:'forbidden'};const mixed=await s.request('/api/reviewer-votes/complete',{method:'POST',body:payload});assert.equal(mixed.status,502);assert.equal(mixed.text,'null');assert.equal(mixed.headers['set-cookie'],undefined);
 const count=s.calls.length;assert.equal((await s.request('/api/reviewer-votes/challenge',{method:'POST',body:{...ref,userId:'owner'}})).status,400);assert.equal(s.calls.length,count);
});
test('owner eligible-human projection survives actual client and HTTP bridge without private fields',async t=>{
 const s=await setup(t,(req,res)=>res.end(JSON.stringify(req.url==='/api/auth/login'?{user,token,deviceToken:'d'.repeat(43)}:req.url==='/api/auth/me'?{user}:{items:[{id:'human-a',name:'Human A',role:'user',sealed_secret:'private'}],nextCursor:null})));
 const client=new SessionClient({live:createSameOriginTransport('http://127.0.0.1:42522',async(url,init)=>{const u=new URL(url),response=await fetch(s.origin+u.pathname+u.search,{...init,headers:{...init.headers,Origin:s.origin}});return {status:response.status,headers:response.headers,url,json:()=>response.json()};})});client.selectMode('live');await client.login(user.email,'fiction-only');
 const result=await client.request({method:'GET',path:'/api/reviewer-policies/eligible-humans?cursor=human-0'});assert.deepEqual(result.body,{items:[{id:'human-a',name:'Human A',role:'user'}],nextCursor:null});assert.equal(s.calls.at(-1).path,'/api/reviewer-policies/eligible-humans?cursor=human-0');
});
test('schedule consent bridge projects proof without cookies and rejects identity and mixed authentication',async t=>{
 const id='12345678-1234-1234-1234-123456789012',base='/api/scheduler/jobs/'+id+'/authorization',expiresAt=1800000000000,operation={kind:'schedule_authorization',jobId:id,jobRevision:1,authorizationRevision:0,definitionHash:'c'.repeat(64),authorizationExpiresAt:expiresAt,policyVersion:1};let value={challenge:'a'.repeat(43),expiresAt};
 const s=await setup(t,(req,res)=>res.end(JSON.stringify(value)));
 const issued=await s.request(base+'/challenge',{method:'POST',body:{operation}});assert.equal(issued.status,200);assert.deepEqual(JSON.parse(issued.text),value);assert.equal(issued.headers['set-cookie'],undefined);
 value={receipt:'b'.repeat(43),expiresAt};const payload={operation,challenge:'a'.repeat(43),code:'012345'},proof=await s.request(base+'/complete',{method:'POST',body:payload});assert.equal(proof.status,200);assert.deepEqual(JSON.parse(proof.text),value);assert.equal(proof.headers['set-cookie'],undefined);
 value={...value,token:'must-not-become-session'};const mixed=await s.request(base+'/complete',{method:'POST',body:payload});assert.equal(mixed.status,502);assert.equal(mixed.text,'null');assert.equal(mixed.headers['set-cookie'],undefined);
 const calls=s.calls.length;assert.equal((await s.request(base+'/challenge',{method:'POST',body:{operation,userId:'owner'}})).status,400);assert.equal(s.calls.length,calls);
});
test('schedule definition bridge returns only masked readback and paused save metadata without cookies',async t=>{
 const id='12345678-1234-1234-1234-123456789012',path='/api/scheduler/definitions/'+id,definitionHash='c'.repeat(64),review={definitionHash,name:'Daily update',description:null,cronExpression:'0 9 * * *',timeZone:'UTC',actionType:'api-call',action:{method:'POST',url:'https://example.test/update',headers:{Authorization:{hidden:true}}},maskedFields:['action.headers.Authorization']};let value={jobId:id,revision:1,enabled:false,review,edited_by:'private-editor'};
 const s=await setup(t,(req,res)=>res.end(JSON.stringify(value))),read=await s.request(path);assert.equal(read.status,200);assert.equal(read.headers['set-cookie'],undefined);assert.ok(!read.text.includes('private-editor'));assert.deepEqual(JSON.parse(read.text).review.action.headers.Authorization,{hidden:true});
 value={jobId:id,revision:2,enabled:false,definitionHash};const write=await s.request(path,{method:'PUT',body:{expectedRevision:1,changes:{name:'Renamed'}}});assert.equal(write.status,200);assert.equal(write.headers['set-cookie'],undefined);assert.deepEqual(JSON.parse(write.text),value);
 const count=s.calls.length;assert.equal((await s.request(path,{method:'PUT',body:{expectedRevision:1,changes:{enabled:true}}})).status,400);assert.equal(s.calls.length,count);
 value={...value,token:'must-not-become-auth'};assert.equal((await s.request(path,{method:'PUT',body:{expectedRevision:1,changes:{name:'Renamed'}}})).status,502);
});
