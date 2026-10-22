// ONBOARD-TEAM-01: company size -> departments -> proposed team. Owner only,
// reads only (names proposed, never reserved; no agent created).
// Run: node --import tsx --test test/team-plan.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-team-plan-'));
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
addUser('tp-owner', 'owner');
addUser('tp-admin', 'admin');
addUser('tp-user', 'user');

const plan = await import(join(backendDir, 'src/services/company-plan.ts'));
const names = await import(join(backendDir, 'src/services/agent-names.ts'));
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
const post = (payload, who = 'tp-owner') => app.inject({ method: 'POST', url: '/api/onboarding/team-plan', headers: auth(who), payload });
const agentCount = () => db.prepare('SELECT COUNT(*) AS n FROM agents_config').get().n;

test('headcount grows with company size; titles and personas follow the department', () => {
  const count = (size) => plan.planRoles(size, ['finance']).length;
  assert.deepEqual(['solo', 'small', 'medium', 'large'].map(count), [1, 2, 4, 5]);
  const medium = plan.planRoles('medium', ['finance', 'marketing']);
  assert.deepEqual(medium.filter((h) => h.department === 'finance').map((h) => h.role), ['manager', 'specialist', 'specialist', 'evaluator']);
  assert.equal(medium.find((h) => h.department === 'finance' && h.role === 'specialist').title, 'Accountant');
  assert.equal(medium.find((h) => h.department === 'finance' && h.role === 'specialist').preset, 'careful-auditor');
  assert.equal(medium.find((h) => h.department === 'marketing' && h.role === 'specialist').preset, 'bold-creative');
  assert.equal(medium.find((h) => h.department === 'finance' && h.role === 'manager').preset, 'careful-auditor', 'a lead has the department persona');
  const custom = plan.planRoles('small', ['podcast studio']);
  assert.equal(custom[0].departmentLabel, 'Podcast Studio');
  assert.equal(custom[0].title, 'Podcast Studio team lead');
});

test('input is validated: size, departments, custom limits, language', () => {
  assert.throws(() => plan.parseSize('huge'), plan.CompanyPlanInputError);
  assert.throws(() => plan.parseDepartments([]), /at least one/);
  assert.throws(() => plan.parseDepartments('finance'), /at least one/);
  assert.throws(() => plan.parseDepartments(['a<b>']), /letters, numbers/);
  assert.throws(() => plan.parseDepartments(['x'.repeat(65)]), /64/);
  assert.throws(() => plan.parseDepartments(['c1', 'c2', 'c3', 'c4', 'c5']), /custom/);
  assert.deepEqual(plan.parseDepartments([' Finance ', 'finance', 'Marketing']), ['finance', 'marketing']);
  assert.throws(() => plan.parseDepartments(Array.from({ length: 73 }, (_, i) => plan.DEPARTMENTS[i % 11].id + i)), /At most 72/);
});

test('only the owner may read the catalogue or ask for a plan', async () => {
  for (const [method, url] of [['GET', '/api/onboarding/team-catalogue'], ['POST', '/api/onboarding/team-plan']]) {
    assert.equal((await app.inject({ method, url, payload: method === 'POST' ? { size: 'small', departments: ['sales'] } : undefined })).statusCode, 401);
    for (const who of ['tp-admin', 'tp-user']) {
      const res = await app.inject({ method, url, headers: auth(who), payload: method === 'POST' ? { size: 'small', departments: ['sales'] } : undefined });
      assert.equal(res.statusCode, 403, `${method} ${url} as ${who}`);
    }
  }
  const cat = await app.inject({ method: 'GET', url: '/api/onboarding/team-catalogue', headers: auth('tp-owner') });
  assert.equal(cat.statusCode, 200);
  assert.deepEqual(cat.json().sizes.map((s) => s.id), ['solo', 'small', 'medium', 'large']);
  assert.ok(cat.json().departments.some((d) => d.id === 'development' && d.summary));
});

test('the plan proposes distinct unused names and creates nothing', async () => {
  db.prepare(`INSERT INTO agents_config (id, name) VALUES ('existing', 'Layla')`).run();
  await names.syncExistingAgentNames();
  const before = agentCount();
  const res = await post({ size: 'medium', departments: ['finance', 'marketing', 'support'], language: 'en' });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.hires.length, 12);
  const list = body.hires.map((h) => h.name);
  assert.equal(new Set(list.map((n) => n.toLowerCase())).size, list.length, 'names are distinct');
  assert.ok(!list.includes('Layla'), 'a used name is never proposed');
  for (const h of body.hires) assert.deepEqual(Object.keys(h).sort(), ['department', 'departmentLabel', 'description', 'name', 'preset', 'role', 'title']);
  assert.equal(agentCount(), before, 'no agent created');
  const reserved = db.prepare(`SELECT COUNT(*) AS n FROM used_agent_names WHERE reason != 'existing'`).get().n;
  assert.equal(reserved, 0, 'no name reserved');
});

test('bad plans get 400 invalid_plan with no backend detail beyond the message', async () => {
  for (const payload of [{ size: 'huge', departments: ['sales'] }, { size: 'small', departments: [] }, { size: 'small', departments: ['sales'], extra: 1 }, { size: 'small', departments: ['sales'], language: 'xx' }, []]) {
    const res = await post(payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().code, 'invalid_plan');
  }
});

 test('all 72 catalogue departments can be reviewed without creating staff', async () => {
  assert.equal(plan.DEPARTMENTS.length,72);
  const before=agentCount();
  const response=await app.inject({method:'POST',url:'/api/onboarding/team-resources',headers:auth('tp-owner'),payload:{departments:['education','finance'],roles:[]}});
  assert.equal(response.statusCode,200,response.body);
  const body=response.json();assert.equal(body.departments.length,2);
  assert.ok(body.departments.every(d=>d.board.columns.length>0&&Array.isArray(d.pendingRoles)));
  assert.equal(agentCount(),before);
  const denied=await app.inject({method:'POST',url:'/api/onboarding/team-resources',headers:auth('tp-user'),payload:{departments:['education']}});
  assert.equal(denied.statusCode,403);
  const invalid=await app.inject({method:'POST',url:'/api/onboarding/team-resources',headers:auth('tp-owner'),payload:{departments:['education'],roles:[{department:'finance',name:'Analyst'}]}});
  assert.equal(invalid.statusCode,400);
 });
