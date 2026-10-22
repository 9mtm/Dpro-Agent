require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { SessionClient, allowedRequest, createSameOriginTransport } = require('../src/session.ts');
const { CompanyController, hireBody } = require('../src/company.ts');
const { CompanyWizard } = require('../src/CompanyWizard.tsx');
const { hireResponse, validPlanBody } = require('../src/hire-contract.js');
const { createLoginMock } = require('../src/session-mock.ts');
const { allowed, createApplicationServer } = require('../scripts/application-server.cjs');

async function fixture(t, wrap = x => x) {
  const calls = []; const base = wrap(createLoginMock());
  const client = new SessionClient({ mock: async r => { calls.push(r); return base(r); } });
  client.selectMode('mock'); await client.login('demo@example.invalid', 'mock-only');
  const w = new CompanyController(client); t.after(() => w.dispose());
  return { client, w, calls };
}
const markup = w => renderToStaticMarkup(React.createElement(CompanyWizard, { controller: w, onClose: () => {} }));
const creates = calls => calls.filter(c => c.method === 'POST' && c.path === '/api/agents');

test('plan body contract and boundaries', () => {
  assert.equal(validPlanBody({ size: 'small', departments: ['finance', 'podcast studio'] }), true);
  for (const bad of [{ size: 'huge', departments: ['x'] }, { size: 'small', departments: [] }, { size: 'small', departments: ['Finance'] }, { size: 'small', departments: ['a', 'a'] },
    { size: 'small', departments: ['x'], extra: 1 }, { size: 'small', departments: Array.from({ length: 73 }, (_, i) => `d${i}`) }, { size: 'small', departments: ['x'], language: 'xx' }])
    assert.equal(validPlanBody(bad), false, JSON.stringify(bad));
  for (const allow of [allowedRequest, allowed]) {
    assert.equal(allow('GET', '/api/onboarding/team-catalogue', undefined), true);
    assert.equal(allow('POST', '/api/onboarding/team-plan', { size: 'medium', departments: ['sales'] }), true);
    assert.equal(allow('POST', '/api/onboarding/team-plan?x=1', { size: 'medium', departments: ['sales'] }), false);
    assert.equal(allow('POST', '/api/onboarding', { step: 'profile' }), false);
    assert.equal(allow('GET', '/api/onboarding/team-catalogue', {}), false);
  }
});

test('plan responses are projected; anything malformed is refused', () => {
  const ok = hireResponse('/api/onboarding/team-plan', 200, { size: 'small', language: 'en', extra: 'x', hires: [{ department: 'finance', departmentLabel: 'Finance', role: 'manager', title: 'Finance lead', description: 'Finance lead in Finance.', preset: 'careful-auditor', name: 'Nora', secret: 'x' }] });
  assert.deepEqual(Object.keys(ok.hires[0]).sort(), ['department', 'departmentLabel', 'description', 'name', 'preset', 'role', 'title']);
  assert.equal(ok.extra, undefined);
  assert.throws(() => hireResponse('/api/onboarding/team-plan', 200, { size: 'small', hires: [{ department: 'finance', role: 'boss', preset: 'careful-auditor', name: 'N', description: '' }] }));
  assert.deepEqual(hireResponse('/api/onboarding/team-plan', 400, { error: 'size must be…', code: 'invalid_plan' }), { code: 'invalid_plan' });
  const cat = hireResponse('/api/onboarding/team-catalogue', 200, { sizes: [{ id: 'solo', label: 'Just me' }, { id: 'bad' }], departments: [{ id: 'sales', label: 'Sales', summary: 's'.repeat(300) }, { id: 'Bad Id' }] });
  assert.equal(cat.sizes.length, 1); assert.equal(cat.departments.length, 1); assert.equal(cat.departments[0].summary.length, 200);
});

test('full offline flow: start → size → departments (+ custom) → reviewed team → one hire each', async t => {
  const { w, calls } = await fixture(t);
  assert.equal(w.getSnapshot().phase, 'idle');
  assert.equal(calls.filter(c => c.path.startsWith('/api/onboarding')).length, 0, 'nothing read before Start');
  await w.loadCatalogue();
  w.chooseSize('small'); assert.equal(w.getSnapshot().step, 'departments');
  w.toggleDepartment('finance'); w.toggleDepartment('marketing'); w.toggleDepartment('marketing');
  assert.equal(w.addCustom('Podcast   Studio'), true);
  assert.equal(w.addCustom('bad<name>'), false);
  assert.deepEqual(w.getSnapshot().departments, ['finance', 'podcast studio']);
  await w.propose();
  const plan = calls.find(c => c.path === '/api/onboarding/team-plan');
  assert.deepEqual(plan.body, { size: 'small', departments: ['finance', 'podcast studio'] });
  let s = w.getSnapshot();
  assert.equal(s.step, 'review'); assert.equal(s.hires.length, 4);
  assert.equal(creates(calls).length, 0, 'nothing hired before confirm');
  w.edit('h0', { name: 'Layla Finance' }); w.edit('h1', { include: false }); w.edit('h2', { preset: 'strict-evaluator', role: 'evaluator' });
  assert.match(markup(w), /Hire 3 agents/);
  await w.hireAll();
  s = w.getSnapshot();
  assert.equal(s.step, 'done'); assert.equal(s.phase, 'done');
  const bodies = creates(calls).map(c => c.body);
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[0], { name: 'Layla Finance', role: 'manager', department: 'finance', description: 'Offline manager in finance.', personality: { preset: 'careful-auditor' } });
  assert.equal(bodies[1].role, 'evaluator'); assert.equal(bodies[1].personality.preset, 'strict-evaluator'); assert.equal(bodies[1].department, 'podcast studio');
  assert.deepEqual(s.hires.map(h => h.status), ['created', 'planned', 'created', 'created']);
  assert.match(markup(w), /3 new agents have joined your team/);
  w.edit('h0', { name: 'Changed' }); assert.equal(w.getSnapshot().hires[0].name, 'Layla Finance', 'a hired agent cannot be edited');
});

test('a refused hire is marked and the others continue; retrying sends only the failed one', async t => {
  let refuse = true;
  const { w, calls } = await fixture(t, base => async r => (r.method === 'POST' && r.path === '/api/agents' && r.body.name === 'Offline plan 2' && refuse ? { status: 409, body: { code: 'name_taken' } } : base(r)));
  await w.loadCatalogue(); w.chooseSize('small'); w.toggleDepartment('support'); await w.propose();
  await w.hireAll();
  let s = w.getSnapshot();
  assert.equal(s.phase, 'stopped'); assert.equal(s.step, 'review');
  assert.deepEqual(s.hires.map(h => [h.status, h.note ?? '']), [['created', ''], ['failed', 'Name already used']]);
  refuse = false; w.edit('h1', { name: 'Offline plan 2b' });
  await w.hireAll();
  assert.equal(creates(calls).length, 3, 'only the failed hire is sent again');
  assert.equal(w.getSnapshot().step, 'done');
});

test('an unknown outcome stops the run and nothing more is sent', async t => {
  const { w, calls } = await fixture(t, base => async r => { if (r.method === 'POST' && r.path === '/api/agents') throw Error('network'); return base(r); });
  await w.loadCatalogue(); w.chooseSize('medium'); w.toggleDepartment('finance'); await w.propose();
  await w.hireAll();
  const s = w.getSnapshot();
  assert.equal(s.phase, 'stopped'); assert.match(s.notice, /unknown result/);
  assert.equal(creates(calls).length, 1);
  assert.deepEqual(s.hires.map(h => h.status), ['unknown', 'planned', 'planned', 'planned']);
});

test('not the owner: nothing to do and nothing sent', async t => {
  const client = new SessionClient({ mock: createLoginMock() });
  const w = new CompanyController(client); t.after(() => w.dispose());
  assert.equal(w.getSnapshot().owner, false);
  await w.loadCatalogue(); await w.propose();
  assert.equal(w.getSnapshot().catalogue, undefined);
  assert.equal(hireBody({ name: 'x', role: 'boss', department: 'a', description: '', preset: 'balanced-assistant' }), null);
});

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
test('ephemeral fictional HTTP bridge: catalogue, plan and hires end to end with redaction', async t => {
  const base = createLoginMock(); const upstream = [];
  const backend = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const text = Buffer.concat(parts).toString(); const body = text ? JSON.parse(text) : undefined;
    upstream.push({ path: req.url, method: req.method });
    const result = await base({ path: req.url, method: req.method, body, headers: req.headers.authorization ? { Authorization: req.headers.authorization } : {}, signal: new AbortController().signal });
    if (Array.isArray(result.body?.hires)) result.body.hires = result.body.hires.map(h => ({ ...h, internal: 'private-fixture' }));
    if (result.body?.agent) result.body.agent = { ...result.body.agent, api_key: 'private-fixture' };
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
  await w.loadCatalogue(); w.chooseSize('solo'); w.toggleDepartment('marketing'); await w.propose();
  assert.equal(w.getSnapshot().hires.length, 1);
  await w.hireAll(); assert.equal(w.getSnapshot().step, 'done');
  assert.doesNotMatch(JSON.stringify(seen), /private-fixture/);
  assert.deepEqual(upstream.filter(u => u.path.startsWith('/api/onboarding') || u.path === '/api/agents').map(u => `${u.method} ${u.path}`),
    ['GET /api/onboarding/team-catalogue', 'GET /api/onboarding/team-batches', 'POST /api/onboarding/team-plan', 'POST /api/agents']);
});
