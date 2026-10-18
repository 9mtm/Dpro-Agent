require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { SessionClient, allowedRequest, createSameOriginTransport } = require('../src/session.ts');
const { CompanyController, sharesTotal } = require('../src/company.ts');
const { CompanyWizard } = require('../src/CompanyWizard.tsx');
const { rolesFor, rolesSummary } = require('../src/team-split.ts');
const { batchPath, hireResponse, validBatchBody, validDistributionBody, validRunBody } = require('../src/hire-contract.js');
const { createLoginMock } = require('../src/session-mock.ts');
const { allowed, createApplicationServer } = require('../scripts/application-server.cjs');

async function fixture(t, wrap = x => x, base = createLoginMock()) {
  const calls = []; const transport = wrap(base);
  const client = new SessionClient({ mock: async r => { calls.push(r); return transport(r); } });
  client.selectMode('mock'); await client.login('demo@example.invalid', 'mock-only');
  const w = new CompanyController(client); t.after(() => w.dispose());
  return { client, w, calls, base };
}
const markup = w => renderToStaticMarkup(React.createElement(CompanyWizard, { controller: w, onClose: () => {} }));
const runs = calls => calls.filter(c => c.method === 'POST' && /\/api\/onboarding\/team-batches\/[^/]+\/run$/.test(c.path));
const batchCreates = calls => calls.filter(c => c.method === 'POST' && c.path === '/api/onboarding/team-batches');
const agentCount = async client => (await client.request({ method: 'GET', path: '/api/agents' })).body.agents.length;

test('role split matches the server rule', () => {
  assert.deepEqual(rolesFor(1), { manager: 1, specialist: 0, evaluator: 0 });
  assert.deepEqual(rolesFor(4), { manager: 1, specialist: 2, evaluator: 1 });
  assert.deepEqual(rolesFor(100), { manager: 5, specialist: 85, evaluator: 10 });
  assert.equal(rolesSummary(rolesFor(100)), '5 leads · 85 specialists · 10 reviewers');
  assert.equal(rolesSummary(rolesFor(1)), '1 lead');
});

test('distribution, batch and run bodies: contract and boundaries (browser and bridge)', () => {
  assert.equal(validDistributionBody({ departments: ['sales', 'legal'], total: 400 }), true);
  assert.equal(validDistributionBody({ departments: ['sales', 'legal'], counts: { sales: 300, legal: 100 } }), true);
  for (const bad of [{ departments: ['sales'] }, { departments: ['sales'], total: 0 }, { departments: ['sales'], total: 1001 }, { departments: ['sales'], total: 2.5 },
    { departments: ['sales', 'legal'], counts: { sales: 3 } }, { departments: ['sales'], counts: { legal: 3 } }, { departments: ['sales', 'legal'], counts: { sales: 999, legal: 2 } },
    { departments: ['Sales'], total: 3 }, { departments: ['sales'], total: 3, extra: 1 }])
    assert.equal(validDistributionBody(bad), false, JSON.stringify(bad));
  const batch = { id: '0f6f7a2e-1b7c-4c55-9a43-5b0f0f3c9e11', departments: [{ department: 'sales', count: 30, presets: { manager: 'bold-creative' } }, { department: 'legal', count: 2 }] };
  assert.equal(validBatchBody(batch), true);
  assert.equal(validBatchBody({ ...batch, language: 'de' }), true);
  for (const bad of [{ ...batch, id: 'short' }, { ...batch, id: 'has spaces in it' }, { ...batch, language: 'xx' }, { ...batch, extra: 1 },
    { ...batch, departments: [{ department: 'sales', count: 1 }, { department: 'sales', count: 2 }] },
    { ...batch, departments: [{ department: 'sales', count: 1, presets: { main: 'balanced-assistant' } }] },
    { ...batch, departments: [{ department: 'sales', count: 1, presets: { manager: 'evil' } }] },
    { ...batch, departments: [{ department: 'sales', count: 1001 }] }, { ...batch, departments: [] }])
    assert.equal(validBatchBody(bad), false, JSON.stringify(bad));
  assert.equal(validRunBody({}), true); assert.equal(validRunBody({ max: 50, retryFailed: true }), true);
  for (const bad of [{ max: 0 }, { max: 51 }, { retryFailed: 'yes' }, { other: 1 }, null]) assert.equal(validRunBody(bad), false);
  assert.deepEqual(batchPath('/api/onboarding/team-batches/abcdefgh-1/run'), { id: 'abcdefgh-1', run: true });
  for (const bad of ['/api/onboarding/team-batches/abc/run', '/api/onboarding/team-batches/abcdefgh/run?x=1', '/api/onboarding/team-batches/abcdefgh/other', '/api/onboarding/team-batches/a%2fbcdefgh'])
    assert.equal(batchPath(bad), null, bad);
  for (const allow of [allowedRequest, allowed]) {
    assert.equal(allow('POST', '/api/onboarding/team-distribution', { departments: ['sales'], total: 5 }), true);
    assert.equal(allow('POST', '/api/onboarding/team-batches', batch), true);
    assert.equal(allow('GET', '/api/onboarding/team-batches', undefined), true);
    assert.equal(allow('GET', '/api/onboarding/team-batches/abcdefgh-1', undefined), true);
    assert.equal(allow('POST', '/api/onboarding/team-batches/abcdefgh-1/run', { max: 25 }), true);
    assert.equal(allow('POST', '/api/onboarding/team-batches/abcdefgh-1/run?x=1', { max: 25 }), false);
    assert.equal(allow('DELETE', '/api/onboarding/team-batches/abcdefgh-1', undefined), false);
    assert.equal(allow('GET', '/api/onboarding/team-batches/abcdefgh-1/run', undefined), false);
    assert.equal(allow('POST', '/api/onboarding/team-batches', { ...batch, departments: [] }), false);
  }
});

test('responses are projected to the reviewed fields; inconsistent ones are refused', () => {
  const share = { department: 'sales', departmentLabel: 'Sales', count: 4, roles: { manager: 1, specialist: 2, evaluator: 1 }, presets: { manager: 'balanced-assistant', specialist: 'balanced-assistant', evaluator: 'strict-evaluator' }, titles: { manager: 'Sales lead', specialist: 'Rep', evaluator: 'Deal reviewer' }, secret: 'x' };
  const ok = hireResponse('/api/onboarding/team-distribution', 200, { total: 4, departments: [share], internal: 1 });
  assert.equal(ok.internal, undefined); assert.equal(ok.departments[0].secret, undefined);
  assert.throws(() => hireResponse('/api/onboarding/team-distribution', 200, { total: 5, departments: [share] }), 'total must match');
  assert.throws(() => hireResponse('/api/onboarding/team-distribution', 200, { total: 4, departments: [{ ...share, roles: { manager: 1, specialist: 1, evaluator: 1 } }] }), 'roles must sum to count');
  assert.deepEqual(hireResponse('/api/onboarding/team-distribution', 400, { error: 'x', code: 'invalid_plan' }), { code: 'invalid_plan' });
  const progress = { id: 'abcdefgh-1', total: 3, created: 1, failed: 1, pending: 1, done: false, createdAt: '2026-10-15 10:00:00', owner_id: 'x', departments: [{ department: 'sales', total: 3, created: 1, failed: 1, extra: 1 }] };
  const created = hireResponse('/api/onboarding/team-batches', 201, { created: true, batch: progress });
  assert.deepEqual(Object.keys(created.batch).sort(), ['created', 'departments', 'done', 'failed', 'id', 'pending', 'total']);
  assert.deepEqual(Object.keys(created.batch.departments[0]).sort(), ['created', 'department', 'failed', 'total']);
  assert.throws(() => hireResponse('/api/onboarding/team-batches', 201, { created: true, batch: { ...progress, pending: 5 } }), 'counts must add up');
  assert.deepEqual(hireResponse('/api/onboarding/team-batches', 409, { error: 'A different batch…', code: 'batch_conflict' }), { code: 'batch_conflict' });
  const run = hireResponse('/api/onboarding/team-batches/abcdefgh-1/run', 200, { results: [{ seq: 1, status: 'created', agentId: 'agent-1', name: 'Nora', x: 1 }, { seq: 2, status: 'failed', code: 'create_failed', detail: 'stack' }], batch: progress });
  assert.deepEqual(run.results, [{ seq: 1, status: 'created', name: 'Nora' }, { seq: 2, status: 'failed', code: 'create_failed' }]);
  assert.deepEqual(hireResponse('/api/onboarding/team-batches/abcdefgh-1/run', 409, { code: 'batch_running', error: 'x' }), { code: 'batch_running' });
  assert.deepEqual(hireResponse('/api/onboarding/team-batches/abcdefgh-1', 404, { code: 'batch_not_found' }), { code: 'batch_not_found' });
});

test('offline: 400 agents → departments → editable split → one batch, hired in chunks with progress', async t => {
  const { client, w, calls } = await fixture(t);
  const before = await agentCount(client);
  await w.loadCatalogue();
  assert.equal(w.chooseTotal(0), false); assert.match(w.getSnapshot().notice, /1 to 1000/);
  assert.equal(w.chooseTotal(400), true);
  assert.equal(w.getSnapshot().step, 'departments');
  w.toggleDepartment('marketing'); w.toggleDepartment('finance'); w.toggleDepartment('support');
  assert.match(markup(w), /Split 400 agents over 3 departments/);
  await w.propose();
  let s = w.getSnapshot();
  assert.equal(s.step, 'review'); assert.equal(sharesTotal(s.shares), 400);
  assert.deepEqual(calls.find(c => c.path === '/api/onboarding/team-distribution').body, { departments: ['marketing', 'finance', 'support'], total: 400 });
  assert.equal(batchCreates(calls).length, 0, 'nothing hired before confirm');
  w.editShare('support', { count: 10 });
  w.editShare('marketing', { role: 'specialist', preset: 'precise-developer' });
  w.editShare('finance', { count: 0 }); assert.match(w.getSnapshot().notice, /1 to 1000/);
  s = w.getSnapshot();
  const total = sharesTotal(s.shares);
  assert.equal(total, 400 - 133 + 10);
  const html = markup(w);
  assert.match(html, new RegExp(`Hire ${total} agents`));
  assert.match(html, /Show the 10 agents/);
  assert.match(html, /1 lead · 8 specialists · 1 reviewer/);
  await w.hireBatch();
  s = w.getSnapshot();
  assert.equal(s.phase, 'done'); assert.equal(s.step, 'done');
  assert.deepEqual([s.batch.created, s.batch.failed, s.batch.pending], [total, 0, 0]);
  const [create] = batchCreates(calls);
  assert.match(create.body.id, /^[A-Za-z0-9_-]{8,64}$/);
  assert.deepEqual(create.body.departments.map(d => [d.department, d.count]), [['marketing', 134], ['finance', 133], ['support', 10]]);
  assert.equal(create.body.departments[0].presets.specialist, 'precise-developer');
  assert.equal(runs(calls).length, Math.ceil(total / 25));
  assert.equal(await agentCount(client) - before, total, 'exactly the reviewed number of agents');
  assert.match(markup(w), new RegExp(`${total} new agents have joined your team`));
});

test('a lost answer stops the run; Continue and a reload resume it without duplicates', async t => {
  let breakRun = 3; let breakStore = true;
  const { client, w, calls, base } = await fixture(t, b => async r => {
    if (r.method === 'POST' && r.path === '/api/onboarding/team-batches' && breakStore) { breakStore = false; await b(r); throw Error('network'); }
    if (r.method === 'POST' && r.path.endsWith('/run') && --breakRun === 0) { await b(r); throw Error('network'); }
    return b(r);
  });
  const before = await agentCount(client);
  await w.loadCatalogue(); w.chooseTotal(120); w.toggleDepartment('finance'); w.toggleDepartment('support'); await w.propose();
  await w.hireBatch();
  let s = w.getSnapshot();
  assert.equal(s.phase, 'stopped'); assert.match(s.notice, /before the hire started/);
  assert.match(markup(w), /Continue/);
  await w.continueBatch();
  const creates = batchCreates(calls);
  assert.equal(creates.length, 2); assert.equal(creates[0].body.id, creates[1].body.id, 'the same batch is sent again');
  s = w.getSnapshot();
  assert.equal(s.phase, 'stopped'); assert.match(s.notice, /Continue to go on/);
  assert.equal(s.batch.created, 50, 'the answer of the third run was lost');

  // A reload: a new controller on the same server finds the unfinished batch on Start.
  const again = new CompanyController(client); t.after(() => again.dispose());
  await again.loadCatalogue();
  assert.equal(again.getSnapshot().open.length, 1);
  const open = again.getSnapshot().open[0];
  assert.equal(open.created, 75, 'the lost run had created its agents');
  assert.match(markup(again), /75 of 120 hired/);
  await again.resume(open.id);
  s = again.getSnapshot();
  assert.equal(s.phase, 'done'); assert.equal(s.batch.created, 120);
  assert.equal(await agentCount(client) - before, 120, 'no duplicates');
  void base;
});

test('busy elsewhere and failed agents: clear notices, retry only the failed', async t => {
  let busy = true; let fail = 2;
  const { w, calls } = await fixture(t, b => async r => {
    if (r.method === 'POST' && r.path.endsWith('/run') && busy) { busy = false; return { status: 409, body: { code: 'batch_running' } }; }
    const res = await b(r);
    if (r.method === 'POST' && r.path.endsWith('/run') && fail > 0 && res.body.results?.length) {
      fail = 0; res.body.results[0] = { seq: res.body.results[0].seq, status: 'failed', code: 'create_failed' };
      res.body.batch = { ...res.body.batch, created: res.body.batch.created - 1, failed: 1, departments: res.body.batch.departments.map((d, i) => i ? d : { ...d, created: d.created - 1, failed: 1 }) };
    }
    return res;
  });
  await w.loadCatalogue(); w.chooseTotal(4); w.toggleDepartment('finance'); await w.propose();
  await w.hireBatch();
  assert.equal(w.getSnapshot().phase, 'stopped'); assert.match(w.getSnapshot().notice, /another window/);
  await w.continueBatch();
  const s = w.getSnapshot();
  assert.equal(s.phase, 'stopped'); assert.match(s.notice, /3 hired; 1 could not be created/);
  assert.match(markup(w), /Try the 1 again/);
  await w.retryFailed();
  assert.deepEqual(runs(calls).at(-1).body, { max: 25, retryFailed: true });
});

test('not the owner: the batch routes are blocked in the browser boundary', async () => {
  const client = new SessionClient({ mock: createLoginMock() });
  const w = new CompanyController(client);
  assert.equal(w.chooseTotal(10), false);
  await w.hireBatch(); await w.continueBatch();
  assert.equal(w.getSnapshot().batch, undefined);
  w.dispose();
});

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
test('ephemeral fictional HTTP bridge: distribution and batch hire end to end with redaction', async t => {
  const base = createLoginMock(); const upstream = [];
  const backend = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const text = Buffer.concat(parts).toString(); const body = text ? JSON.parse(text) : undefined;
    upstream.push({ path: req.url, method: req.method });
    const result = await base({ path: req.url, method: req.method, body, headers: req.headers.authorization ? { Authorization: req.headers.authorization } : {}, signal: new AbortController().signal });
    if (result.body?.batch) result.body.batch = { ...result.body.batch, internal: 'private-fixture' };
    if (Array.isArray(result.body?.results)) result.body.results = result.body.results.map(x => ({ ...x, internal: 'private-fixture' }));
    res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result.body));
  });
  const upstreamPort = await listen(backend); const app = createApplicationServer({ channel: 'candidate', upstreamPort }); const port = await listen(app);
  t.after(async () => { await close(app); await close(backend); }); const origin = `http://127.0.0.1:${port}`;
  const seen = [];
  const transportFn = async (target, init) => {
    const r = await globalThis.fetch(origin + new URL(target).pathname, { ...init, headers: { ...init.headers, Origin: origin } });
    const body = await r.json(); seen.push(body);
    return { status: r.status, headers: r.headers, url: target, redirected: r.redirected, json: async () => body };
  };
  const client = new SessionClient({ live: createSameOriginTransport('http://127.0.0.1:42522', transportFn) });
  client.selectMode('live'); await client.login('demo@example.invalid', 'mock-only');
  const w = new CompanyController(client); t.after(() => w.dispose());
  await w.loadCatalogue(); w.chooseTotal(30); w.toggleDepartment('marketing'); w.toggleDepartment('finance'); await w.propose();
  await w.hireBatch();
  assert.equal(w.getSnapshot().phase, 'done'); assert.equal(w.getSnapshot().batch.created, 30);
  assert.doesNotMatch(JSON.stringify(seen), /private-fixture/);
  const paths = upstream.filter(u => u.path.startsWith('/api/onboarding')).map(u => `${u.method} ${u.path.replace(/team-batches\/[^/]+/, 'team-batches/:id')}`);
  assert.deepEqual(paths, ['GET /api/onboarding/team-catalogue', 'GET /api/onboarding/team-batches', 'POST /api/onboarding/team-distribution', 'POST /api/onboarding/team-batches', 'POST /api/onboarding/team-batches/:id/run', 'POST /api/onboarding/team-batches/:id/run']);
});

test('the first step offers agent numbers up to 500 or a custom number, never "people"', async t => {
  const { w } = await fixture(t);
  await w.loadCatalogue();
  const html = markup(w);
  for (const n of [5, 10, 25, 50, 100, 250, 500]) assert.match(html, new RegExp(`<strong>${n}</strong><small>agents</small>`));
  assert.match(html, /Custom number of agents/);
  assert.match(html, /Number of agents/);
  assert.doesNotMatch(html, /people|person|Company size|Just me/i);
  assert.equal(w.chooseTotal(500), true);
  assert.equal(w.getSnapshot().step, 'departments');
  assert.doesNotMatch(markup(w), /people|person/i);
});


test('specialty editing blocks unbalanced allocations and sends reviewed names/counts/descriptions',async t=>{
 const {w,calls}=await fixture(t);await w.loadCatalogue();w.chooseTotal(2);w.toggleDepartment('development');await w.propose();
 w.editSpecialties('development',[{name:'Server administrator',count:1,description:'Operate fictional servers.'}]);assert.match(markup(w),/1 of 2 allocated/);await w.hireBatch();assert.equal(batchCreates(calls).length,0);assert.match(w.getSnapshot().notice,/Specialty counts/);
 const rows=[{name:'Server administrator',count:1,description:'Operate fictional servers.'},{name:'Custom data guardian',count:1,description:'Review fictional access.'}];w.editSpecialties('development',rows);assert.match(markup(w),/Add custom specialty/);assert.match(markup(w),/Custom data guardian/);await w.hireBatch();assert.deepEqual(batchCreates(calls)[0].body.departments[0].specialties,rows);
});

test('specialty contract rejects privilege injection, duplicate names and mismatched totals',()=>{
 const make=specialties=>({id:'specialty-test-id',departments:[{department:'data',count:2,specialties}]});
 const valid=[{name:'Data engineer',count:1,description:'Build pipelines.'},{name:'Data security specialist',count:1,description:'Review access.'}];
 for(const allow of [allowedRequest,allowed]){assert.equal(allow('POST','/api/onboarding/team-batches',make(valid)),true);for(const rows of [[valid[0]],[{...valid[0],count:3}],[valid[0],{...valid[1],name:'data engineer'}],[{...valid[0],count:2,tools:['all']}]] )assert.equal(allow('POST','/api/onboarding/team-batches',make(rows)),false);}
});
