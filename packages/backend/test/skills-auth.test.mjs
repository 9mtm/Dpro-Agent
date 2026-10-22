// S0-Q.19: every /api/skills* route needs a verified token of an active user.
// Listing is open to any such user; install, enable/disable, delete,
// settings, execute and marketplace changes need owner/admin. Skill names and
// marketplace paths cannot escape the skills directory. No network: the
// GitHub fetch is stubbed.
// Run: node --import tsx --test test/skills-auth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'ap-skills-auth-'));
const backendDir = process.cwd();
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
delete process.env.GITHUB_TOKEN;

const skillsDir = join(dir, 'skills');
mkdirSync(join(skillsDir, 'hello-world'), { recursive: true });
copyFileSync(join(backendDir, 'skills', 'hello-world', 'SKILL.md'), join(skillsDir, 'hello-world', 'SKILL.md'));

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { getSkillsRegistry } = await import(join(backendDir, 'src/skills/registry.ts'));
const { anthropicSkillsService } = await import(join(backendDir, 'src/services/anthropic-skills-service.ts'));
const { skillsRoutes } = await import(join(backendDir, 'src/api/routes/skills.ts'));
const { default: Fastify } = await import('fastify');

// No GitHub access: record what would be fetched and answer with a fixed SKILL.md.
const fetched = [];
anthropicSkillsService.fetchSkillContent = async (skillPath) => {
  fetched.push(skillPath);
  return '---\nname: pdf\ndescription: test skill\n---\nbody';
};
anthropicSkillsService.fetchAvailableSkills = async () => {
  throw new Error('secret internal detail /etc/should-not-leak');
};

const db = getDatabase();
await db.initialize();
const addUser = (id, role, status = 'active') => db.prepare(
  `INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, ?)`
).run(id, `${id}@example.test`, id, role, status);
addUser('u-owner', 'owner');
addUser('u-admin', 'admin');
addUser('u-user', 'user');
addUser('u-suspended', 'admin', 'suspended');
const token = id => `Bearer ${generateToken(id, 1)}`;

const registry = getSkillsRegistry();
await registry.load([skillsDir]);

const app = Fastify();
await app.register(skillsRoutes);
await app.ready();

test.after(async () => {
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const call = (method, url, who, payload) => app.inject({
  method, url, payload,
  headers: who ? { authorization: who.startsWith('Bearer') ? who : token(who) } : {},
});

const READ_ROUTES = [
  ['GET', '/api/skills'],
  ['GET', '/api/skills/hello-world'],
  ['GET', '/api/skills/match?message=hello'],
  ['GET', '/api/skills/marketplace/sources'],
  ['GET', '/api/skills/marketplace/installed'],
  ['GET', '/api/skills/marketplace/search?q=pdf'],
  ['GET', '/api/skills/marketplace/stats'],
];
const ADMIN_ROUTES = [
  ['POST', '/api/skills/install', { name: 'x', source: 'managed', content: 'x' }],
  ['PUT', '/api/skills/hello-world/settings', { settings: {} }],
  ['POST', '/api/skills/hello-world/enable'],
  ['POST', '/api/skills/hello-world/disable'],
  ['DELETE', '/api/skills/hello-world'],
  ['POST', '/api/skills/hello-world/execute', { message: 'hello' }],
  ['POST', '/api/skills/marketplace/install', { skillName: 'pdf', skillPath: 'skills/document/pdf' }],
  ['DELETE', `/api/skills/marketplace/skill_${'a'.repeat(32)}`],
  ['PUT', `/api/skills/marketplace/skill_${'a'.repeat(32)}/toggle`],
  ['POST', '/api/skills/reload'],
];

test('every skills route rejects anonymous and forged tokens with 401', async () => {
  for (const [method, url, payload] of [...READ_ROUTES, ['GET', '/api/skills/marketplace/available'], ...ADMIN_ROUTES]) {
    assert.equal((await call(method, url, null, payload)).statusCode, 401, `${method} ${url}`);
    assert.equal((await call(method, url, 'Bearer not-a-jwt', payload)).statusCode, 401, `${method} ${url}`);
  }
});

test('read-only listing is open to any active user, not to a suspended one', async () => {
  for (const [method, url] of READ_ROUTES) {
    const res = await call(method, url, 'u-user');
    assert.equal(res.statusCode, 200, `${method} ${url}: ${res.body}`);
    assert.equal((await call(method, url, 'u-suspended')).statusCode, 401, `${method} ${url}`);
  }
});

test('state-changing and code-running routes refuse members and suspended admins (403)', async () => {
  for (const [method, url, payload] of ADMIN_ROUTES) {
    assert.equal((await call(method, url, 'u-user', payload)).statusCode, 403, `${method} ${url}`);
    assert.equal((await call(method, url, 'u-suspended', payload)).statusCode, 403, `${method} ${url}`);
  }
  assert.equal(registry.get('hello-world').enabled, true);
  assert.equal(fetched.length, 0);
});

test('owner/admin can disable, enable and execute; execute runs as the caller', async () => {
  assert.equal((await call('POST', '/api/skills/hello-world/disable', 'u-admin')).statusCode, 200);
  assert.equal(registry.get('hello-world').enabled, false);
  assert.equal((await call('POST', '/api/skills/hello-world/enable', 'u-owner')).statusCode, 200);
  assert.equal(registry.get('hello-world').enabled, true);
  assert.equal((await call('POST', '/api/skills/missing-skill/enable', 'u-owner')).statusCode, 404);
  const run = await call('POST', '/api/skills/hello-world/execute', 'u-owner', { message: 'hello' });
  assert.equal(run.statusCode, 200, run.body);
  assert.equal((await call('POST', '/api/skills/hello-world/execute', 'u-owner', {})).statusCode, 400);
  assert.equal((await call('POST', '/api/skills/reload', 'u-owner')).statusCode, 200);
});

test('skill ids and marketplace paths cannot traverse out of the skills directory', async () => {
  const bad = [
    { skillName: '../../evil', skillPath: 'skills/document/pdf' },
    { skillName: 'evil/x', skillPath: 'skills/document/pdf' },
    { skillName: '..', skillPath: 'skills/document/pdf' },
    { skillName: 'pdf', skillPath: '../../etc' },
    { skillName: 'pdf', skillPath: 'skills/../../x' },
    { skillName: 'pdf', skillPath: '/skills/document' },
    { skillName: 'pdf', skillPath: 'other/document/pdf' },
  ];
  for (const payload of bad) {
    const res = await call('POST', '/api/skills/marketplace/install', 'u-owner', payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal(fetched.length, 0);
  await assert.rejects(anthropicSkillsService.installSkill('../evil', 'skills/a/b'));

  // A bare '..' segment is normalised away by the router (404, handler never runs).
  const refused = (code) => code === 400 || code === 404;
  for (const id of ['..%2F..%2Fetc', '..', 'skill_..%2Fx', 'not-an-id']) {
    const del = (await call('DELETE', `/api/skills/marketplace/${id}`, 'u-owner')).statusCode;
    const tog = (await call('PUT', `/api/skills/marketplace/${id}/toggle`, 'u-owner')).statusCode;
    assert.ok(refused(del) && refused(tog), `${id}: ${del} ${tog}`);
  }
  for (const id of ['..%2F..%2Fetc', '.hidden', 'a%2F..%2F..%2Fb']) {
    assert.equal((await call('DELETE', `/api/skills/${id}`, 'u-owner')).statusCode, 400, id);
    assert.equal((await call('POST', `/api/skills/${id}/enable`, 'u-owner')).statusCode, 400, id);
  }
  const install = await call('POST', '/api/skills/install', 'u-owner', { name: '../x', source: 'managed', content: 'x' });
  assert.equal(install.statusCode, 400);
});

test('legacy marketplace install refuses; uninstall never deletes outside its existing skill directory', async () => {
  const res = await call('POST', '/api/skills/marketplace/install', 'u-admin', { skillName: 'pdf', skillPath: 'skills/document/pdf' });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().code, 'reviewed_install_required');
  assert.deepEqual(fetched, []);
  assert.ok(!existsSync(join(dir, '.data', 'skills', 'pdf.md')));
  assert.equal(db.prepare("SELECT id FROM installed_skills WHERE skill_name = 'pdf'").get(), undefined);
  // Seed historical state explicitly to retain uninstall path-boundary coverage.
  const legacyFile=join(process.cwd(),'.data','skills','pdf.md');mkdirSync(join(process.cwd(),'.data','skills'),{recursive:true});writeFileSync(legacyFile,'Fictional legacy PDF guide');
  const legacySource=db.prepare("SELECT id FROM skill_sources WHERE name='Anthropic Official'").get();
  db.prepare("INSERT INTO installed_skills(source_id,skill_name,file_path) VALUES(?,'pdf',?)").run(legacySource.id,legacyFile);
  const row=db.prepare("SELECT id FROM installed_skills WHERE skill_name='pdf'").get();assert.ok(row);

  // A row whose stored path points outside the skills directory: the file stays.
  const outside = join(dir, 'keep-me.md');
  writeFileSync(outside, 'keep');
  const src = db.prepare(`SELECT id FROM skill_sources WHERE name = 'Anthropic Official'`).get();
  const evilId = `skill_${'b'.repeat(32)}`;
  db.prepare(`INSERT INTO installed_skills (id, source_id, skill_name, file_path) VALUES (?, ?, 'evil', ?)`).run(evilId, src.id, outside);
  assert.equal((await call('DELETE', `/api/skills/marketplace/${evilId}`, 'u-owner')).statusCode, 200);
  assert.equal(readFileSync(outside, 'utf-8'), 'keep');

  assert.equal((await call('DELETE', `/api/skills/marketplace/${row.id}`, 'u-owner')).statusCode, 200);
  assert.ok(!existsSync(join(dir, '.data', 'skills', 'pdf.md')));
});

test('marketplace errors do not echo internal error messages', async () => {
  const res = await call('GET', '/api/skills/marketplace/available', 'u-user');
  assert.equal(res.statusCode, 500);
  assert.ok(!res.body.includes('should-not-leak'), res.body);
});
