// ONBOARD-TEAM-02: total headcount split over departments + batch hire.
// Owner only. Run: node --import tsx --test test/team-batch.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { teamBatchScenario, SIX } from './fixtures/team-batch-scenario.mjs';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-team-batch-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only

const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('tb-owner', 'owner');
addUser('tb-admin', 'admin');
addUser('tb-user', 'user');

const plan = await import(join(backendDir, 'src/services/company-plan.ts'));
const batch = await import(join(backendDir, 'src/services/team-batch.ts'));
const { q } = await import(join(backendDir, 'src/repositories/sql-steps.ts'));
const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { teamPlanRoutes } = await import(join(backendDir, 'src/api/routes/team-plan.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');

const app = Fastify();
registerAuthGate(app);
await app.register(teamPlanRoutes);
await app.ready();

console.log = quiet.log;
console.warn = quiet.warn;

test.after(async () => {
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const call = (method, url, payload, who = 'tb-owner') => app.inject({ method, url, headers: auth(who), payload });

test('a total is split by weight, sums exactly, and every department has a lead', () => {
  const d = plan.distributeHeadcount(400, SIX);
  assert.equal(Object.values(d).reduce((a, b) => a + b, 0), 400);
  assert.ok(d.development > d.support && d.support > d.sales && d.sales > d.finance, JSON.stringify(d));
  for (const total of [6, 7, 13, 99, 400, 1000]) {
    const split = plan.distributeHeadcount(total, SIX);
    assert.equal(Object.values(split).reduce((a, b) => a + b, 0), total, `total ${total}`);
    assert.ok(Object.values(split).every((n) => n >= 1));
  }
  assert.throws(() => plan.distributeHeadcount(5, SIX), /cannot give each/);
  const dist = plan.planDistribution({ total: 400, departments: SIX });
  assert.equal(dist.total, 400);
  for (const s of dist.departments) {
    assert.equal(s.roles.manager + s.roles.specialist + s.roles.evaluator, s.count);
    assert.ok(s.roles.manager >= 1);
  }
  assert.deepEqual(plan.departmentRoles(1), { manager: 1, specialist: 0, evaluator: 0 });
  assert.deepEqual(plan.departmentRoles(4), { manager: 1, specialist: 2, evaluator: 1 });
  assert.deepEqual(plan.departmentRoles(100), { manager: 5, specialist: 85, evaluator: 10 });
  // Leads get the department persona; the size-based plan follows the same rule.
  assert.equal(dist.departments.find((s) => s.department === 'marketing').presets.manager, 'bold-creative');
  assert.equal(dist.departments.find((s) => s.department === 'support').presets.manager, 'balanced-assistant');
  assert.equal(plan.planRoles('small', ['finance'])[0].preset, 'careful-auditor');
});

test('owner counts override the split; bad input is refused', () => {
  const edited = plan.planDistribution({ departments: ['sales', 'legal'], counts: { sales: 30, Legal: 2 } });
  assert.equal(edited.total, 32);
  assert.deepEqual(edited.departments.map((s) => s.count), [30, 2]);
  for (const input of [
    { departments: SIX, total: 0 }, { departments: SIX, total: 1001 }, { departments: SIX, total: 3.5 },
    { departments: ['sales'], counts: { sales: 0 } }, { departments: ['sales'], counts: { finance: 3 } },
    { departments: ['sales', 'legal'], counts: { sales: 3 } }, { departments: ['sales'], counts: { sales: 3 }, total: 4 },
    { departments: ['sales', 'legal'], counts: { sales: 999, legal: 2 } },
  ]) assert.throws(() => plan.planDistribution(input), plan.CompanyPlanInputError, JSON.stringify(input));
  assert.throws(() => batch.expandBatch([{ department: 'sales', count: 2, presets: { manager: 'evil' } }]), /Unknown persona/);
  assert.throws(() => batch.expandBatch([{ department: 'sales', count: 2, presets: { main: 'balanced-assistant' } }]), /manager, specialist/);
  assert.throws(() => batch.expandBatch([{ department: 'sales', count: 2 }, { department: 'Sales', count: 1 }]), /only once/);
  assert.throws(() => batch.expandBatch([{ department: 'sales', count: 2, extra: 1 }]), /Unknown field/);
});

test('only the owner may use the distribution and batch routes', async () => {
  const routes = [
    ['POST', '/api/onboarding/team-distribution', { total: 10, departments: ['sales'] }],
    ['POST', '/api/onboarding/team-batches', { id: 'gate-check-1', language: 'en', departments: [{ department: 'sales', count: 1 }] }],
    ['GET', '/api/onboarding/team-batches'],
    ['GET', '/api/onboarding/team-batches/gate-check-1'],
    ['POST', '/api/onboarding/team-batches/gate-check-1/run', {}],
  ];
  for (const [method, url, payload] of routes) {
    assert.equal((await app.inject({ method, url, payload })).statusCode, 401, `${method} ${url} anonymous`);
    for (const who of ['tb-admin', 'tb-user']) assert.equal((await call(method, url, payload, who)).statusCode, 403, `${method} ${url} as ${who}`);
  }
  assert.equal(Number((await q.one('SELECT COUNT(*) AS n FROM team_hire_batches')).n), 0, 'nothing stored by refused calls');
});

test('the routes: distribution, idempotent create, run with progress, 404 / 409 / 400 codes', async () => {
  const cat = await call('GET', '/api/onboarding/team-catalogue');
  assert.equal(cat.json().maxTotal, 1000);
  assert.ok(cat.json().personas.some((p) => p.id === 'careful-auditor' && p.label));
  const dist = await call('POST', '/api/onboarding/team-distribution', { total: 12, departments: ['sales', 'finance'] });
  assert.equal(dist.statusCode, 200, dist.body);
  assert.equal(dist.json().departments.reduce((a, s) => a + s.count, 0), 12);
  const body = { id: 'route-batch-1', language: 'en', departments: dist.json().departments.map((s) => ({ department: s.department, count: s.count })) };
  const created = await call('POST', '/api/onboarding/team-batches', body);
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().batch.total, 12);
  assert.equal((await call('POST', '/api/onboarding/team-batches', body)).statusCode, 200);
  assert.equal((await call('POST', '/api/onboarding/team-batches', { ...body, language: 'de' })).json().code, 'batch_conflict');
  // Without a language the owner's onboarding language is used (English here) and fixed in the batch.
  const { language: _l, ...noLanguage } = body;
  assert.equal((await call('POST', '/api/onboarding/team-batches', noLanguage)).statusCode, 200, 'same plan, same resolved language');
  const run = await call('POST', '/api/onboarding/team-batches/route-batch-1/run', { max: 5 });
  assert.equal(run.statusCode, 200, run.body);
  assert.equal(run.json().results.length, 5);
  for (const r of run.json().results) assert.deepEqual(Object.keys(r).sort(), ['agentId', 'name', 'seq', 'status']);
  assert.equal(run.json().batch.created, 5);
  const status = await call('GET', '/api/onboarding/team-batches/route-batch-1');
  assert.equal(status.json().batch.pending, 7);
  assert.equal((await call('GET', '/api/onboarding/team-batches')).json().batches[0].id, 'route-batch-1');
  const rest = await call('POST', '/api/onboarding/team-batches/route-batch-1/run');
  assert.equal(rest.statusCode, 200, rest.body);
  assert.equal(rest.json().batch.done, true);
  assert.equal((await call('GET', '/api/onboarding/team-batches/nope-nope-1')).statusCode, 404);
  for (const [url, payload] of [
    ['/api/onboarding/team-batches/route-batch-1/run', { max: 51 }],
    ['/api/onboarding/team-batches/route-batch-1/run', { other: 1 }],
    ['/api/onboarding/team-batches', { ...body, id: 'x' }],
    ['/api/onboarding/team-batches', { ...body, id: 'route-batch-2', language: 'xx' }],
    ['/api/onboarding/team-batches', { ...body, id: 'route-batch-2', departments: [] }],
    ['/api/onboarding/team-distribution', { total: 5, departments: SIX }],
  ]) {
    const res = await call('POST', url, payload);
    assert.equal(res.statusCode, 400, `${url} ${JSON.stringify(payload)} -> ${res.body}`);
    assert.equal(res.json().code, 'invalid_plan');
  }
});

teamBatchScenario(test, () => ({ q, batch }), { tag: randomBytes(4).toString('hex'), owner: 'tb-owner' });


test('specialty counts, descriptions and identity survive partial batch execution without changing existing agents',async()=>{
 const existing=db.prepare('select * from agents_config order by id').all();
 const input={id:'specialties-acceptance-01',departments:[{department:'infrastructure',count:2,specialties:[{name:'Server administrator',count:1,description:'Maintain fictional Linux servers.'},{name:'Custom data guardian',count:1,description:'Review fictional data access.'}]}]};
 const saved=await batch.createBatch('tb-owner',input);assert.equal(saved.progress.total,2);assert.equal((await batch.createBatch('tb-owner',input)).created,false);
 await batch.runBatch('tb-owner',input.id,{max:1});assert.equal((await batch.batchStatus(input.id,'tb-owner')).created,1);await batch.runBatch('tb-owner',input.id);assert.equal((await batch.runBatch('tb-owner',input.id)).results.length,0);
 const rows=db.prepare("select a.* from agents_config a join team_hire_batch_items i on i.agent_id=a.id where i.batch_id=? order by i.seq").all(input.id);assert.equal(rows.length,2);assert.equal(rows[0].specialty,'Server administrator');assert.match(rows[0].description,/fictional Linux/);assert.match(rows[1].system_prompt,/Custom data guardian/);assert.match(rows[1].system_prompt,/grants no tools/);
 for(const row of existing)assert.deepEqual(db.prepare('select * from agents_config where id=?').get(row.id),row);
 const changed=structuredClone(input);changed.departments[0].specialties[0].description='Changed';await assert.rejects(()=>batch.createBatch('tb-owner',changed),/different batch/i);
 for(const specialties of [[{name:'Missing allocation',count:1,description:''}],[{name:'Repeat',count:1,description:''},{name:'repeat',count:1,description:''}],[{name:'Overflow',count:3,description:''}],[{name:'Bad',count:2,description:'',grantAll:true}]])assert.throws(()=>batch.expandBatch([{department:'data',count:2,specialties}]));
 const zero=batch.expandBatch([{department:'data',count:1,specialties:[{name:'Unused',count:0,description:''},{name:'Data analyst',count:1,description:'Analyze fictional data.'}]}]);assert.equal(zero.length,1);assert.equal(zero[0].specialty,'Data analyst');
});
