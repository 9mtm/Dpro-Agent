// MEM-UX-02 backend: memory Trash (MEM-TRASH-01) and groups of projects.
// Delete moves a memory to the Trash (never recalled), Restore brings it back
// whole, Empty forgets, the daily job forgets after trashDays; a project can
// go to the Trash and come back; groups share memory within when asked.
// Run: node --import tsx --test test/memory-desktop.test.mjs
// Throwaway DB + cwd + HOME, random test-only secrets, no network (fetch refused).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-memdesk-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };

const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const OWNER = 'md-owner';
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser(OWNER, 'owner');
addUser('md-user', 'user');
db.prepare('UPDATE agents_config SET is_primary = 0').run();
db.prepare(`INSERT INTO agents_config (id, name, is_primary) VALUES ('md-agent', 'Md Agent', 1)`).run();

const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { memoryRoutes } = await import(join(backendDir, 'src/api/routes/memory.ts'));
const { memoryScopeRoutes } = await import(join(backendDir, 'src/api/routes/memory-scopes.ts'));
const { memoryDesktopRoutes } = await import(join(backendDir, 'src/api/routes/memory-desktop.ts'));
const { getMemoryIndexer } = await import(join(backendDir, 'src/memory/indexer.ts'));
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
const Trash = await import(join(backendDir, 'src/memory/trash.ts'));
const J = await import(join(backendDir, 'src/memory/jobs.ts'));
const G = await import(join(backendDir, 'src/memory/scopes/groups.ts'));
const T = await import(join(backendDir, 'src/tools/memory/desktop.ts'));
const { approvalCategory } = await import(join(backendDir, 'src/tools/approvals.ts'));
const { DEFAULT_AGENT_TOOLS } = await import(join(backendDir, 'src/tools/grants.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');

const app = Fastify();
registerAuthGate(app);
await app.register(memoryRoutes);
await app.register(memoryScopeRoutes);
await app.register(memoryDesktopRoutes);
await app.ready();
console.log = quiet.log;
console.warn = quiet.warn;

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  try { getMemoryIndexer().close(); } catch { /* not opened */ }
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const quietly = async (fn) => { const l = console.log; const w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
const call = (method, url, who = OWNER, payload) => quietly(() => app.inject({ method, url, headers: auth(who), payload }));
const remember = async (content, drawer, extra = {}) => {
  const r = await call('POST', '/api/memory', OWNER, { type: 'fact', content, importance: 7, ...(drawer ? { drawer } : {}), ...extra });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().memory.id;
};
const search = async (query) => (await call('POST', '/api/memory/search', OWNER, { query, limit: 20 })).json();
const found = (res, id) => JSON.stringify(res).includes(id);
const ctx = { workspaceDir: dir, userId: OWNER, agentId: 'md-agent', memoryDrawers: [{ kind: 'owner' }] };

test('delete moves a memory to the Trash; it is never recalled; restore brings it back whole', async () => {
  const id = await remember('The staging server runs on port 7788 (trash test).', { kind: 'project', key: 'shop' }, { topicKey: 'staging-port', metadata: { from: 'test' } });
  assert.ok(found(await search('staging server port 7788'), id), 'found before delete');
  assert.equal((await call('DELETE', `/api/memory/${id}`)).statusCode, 200);
  assert.ok(!found(await search('staging server port 7788'), id), 'a trashed memory is never recalled');

  const list = await call('GET', '/api/memory/trash');
  assert.equal(list.statusCode, 200, list.body);
  const item = list.json().items.find((i) => i.id === id);
  assert.ok(item, 'listed in the Trash');
  assert.equal(item.drawer, 'project:shop');
  assert.equal(item.project, 'shop');
  assert.match(item.text, /port 7788/);
  assert.equal(item.deletedBy, OWNER);
  assert.equal(list.json().trashDays, 30);
  assert.equal(Date.parse(item.forgetAt) - Date.parse(item.deletedAt), 30 * 86400_000);

  // Only the owner sees or changes the Trash.
  assert.equal((await call('GET', '/api/memory/trash', 'md-user')).statusCode, 403);
  assert.equal((await call('POST', `/api/memory/${id}/restore`, 'md-user')).statusCode, 403);

  const r = await call('POST', `/api/memory/${id}/restore`);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().restored, { id, drawer: 'project:shop', topicKeyDropped: false });
  const back = await getMemoryStorage().getOwned(OWNER, id);
  assert.equal(back.content, 'The staging server runs on port 7788 (trash test).');
  assert.equal(back.topicKey, 'staging-port');
  assert.deepEqual(back.metadata, { from: 'test' });
  assert.ok(found(await search('staging server port 7788'), id), 'recalled again');
  assert.ok(!(await call('GET', '/api/memory/trash')).json().items.some((i) => i.id === id));
  assert.equal((await call('POST', `/api/memory/${id}/restore`)).statusCode, 409, 'a live memory is not in the Trash');
  assert.equal((await call('POST', '/api/memory/nope-unknown/restore')).statusCode, 404);
  const versions = (await call('GET', `/api/memory/${id}/versions`)).json().versions.map((v) => v.change);
  assert.deepEqual(versions.slice(-2), ['delete', 'create']);
});

test('restore without the topic key when another memory took it meanwhile', async () => {
  const a = await remember('Deploys go out on Fridays (old).', null, { topicKey: 'deploy-day' });
  await call('DELETE', `/api/memory/${a}`);
  await remember('Deploys go out on Tuesdays.', null, { topicKey: 'deploy-day' });
  const r = await call('POST', `/api/memory/${a}/restore`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().restored.topicKeyDropped, true);
  assert.equal((await getMemoryStorage().getOwned(OWNER, a)).topicKey ?? null, null);
});

test('empty the Trash: confirm needed, only trashed ids are forgotten, a live memory never', async () => {
  const live = await remember('Live memory that must stay (empty test).');
  const gone = await remember('Trashed memory to forget (empty test).');
  await call('DELETE', `/api/memory/${gone}`);
  assert.equal((await call('POST', '/api/memory/trash/empty', OWNER, { ids: [gone] })).statusCode, 400, 'confirm required');
  const r = await call('POST', '/api/memory/trash/empty', OWNER, { confirm: 'EMPTY', ids: [gone, live] });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().forgotten, [gone]);
  assert.deepEqual(r.json().skipped, [live]);
  assert.ok(await getMemoryStorage().getOwned(OWNER, live), 'the live memory stays');
  const tomb = db.prepare(`SELECT change, content, snapshot FROM memory_versions WHERE memory_id = ?`).all(gone);
  assert.deepEqual(tomb.map((t) => t.change), ['forget'], 'only a tombstone stays');
  assert.equal(tomb[0].content, null);
  assert.equal(tomb[0].snapshot, null);
  assert.equal((await call('POST', `/api/memory/${gone}/restore`)).statusCode, 404);
});

test('trashDays rule (company only, 7/30/90/0) and the daily expiry job', async () => {
  const bad = await call('PUT', '/api/memory/scopes/rules', OWNER, { scope: 'company', trashDays: 3 });
  assert.equal(bad.statusCode, 400);
  const notCompany = await call('PUT', '/api/memory/scopes/rules', OWNER, { scope: 'project:shop', trashDays: 7 });
  assert.equal(notCompany.statusCode, 400);
  const ok = await call('PUT', '/api/memory/scopes/rules', OWNER, { scope: 'company', trashDays: 7 });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().effective.trashDays, 7);

  const old = await remember('Old trashed memory (expiry test).');
  const fresh = await remember('Fresh trashed memory (expiry test).');
  await call('DELETE', `/api/memory/${old}`);
  await call('DELETE', `/api/memory/${fresh}`);
  db.prepare(`UPDATE memory_versions SET created_at = ? WHERE memory_id = ? AND change = 'delete'`).run(new Date(Date.now() - 8 * 86400_000).toISOString(), old);

  const created = await J.ensureMemoryJobs();
  assert.ok(created.some((j) => j.name === `memory-trash-${OWNER}`), 'the trash job exists');
  const out = await J.runMemoryJob({ job: 'trash', userId: OWNER });
  assert.equal(out.trashDays, 7);
  assert.ok(out.forgotten >= 1);
  const items = (await call('GET', '/api/memory/trash')).json().items.map((i) => i.id);
  assert.ok(!items.includes(old), 'expired one forgotten');
  assert.ok(items.includes(fresh), 'fresh one kept');
  await assert.rejects(() => J.runMemoryJob({ job: 'trash', userId: 'md-user' }), /owner/);

  // 0 = never forgotten by itself.
  await call('PUT', '/api/memory/scopes/rules', OWNER, { scope: 'company', trashDays: 0 });
  db.prepare(`UPDATE memory_versions SET created_at = ? WHERE memory_id = ? AND change = 'delete'`).run(new Date(Date.now() - 400 * 86400_000).toISOString(), fresh);
  assert.deepEqual(await Trash.expireTrash(OWNER), { trashDays: 0, forgotten: 0, projects: 0 });
  assert.equal((await call('GET', '/api/memory/trash')).json().items.find((i) => i.id === fresh).forgetAt, null);
  await call('PUT', '/api/memory/scopes/rules', OWNER, { scope: 'company', trashDays: null });
});

test('a project moves to the Trash and comes back with its memories', async () => {
  const a = await remember('Kiosk app uses a blue theme (project trash).', { kind: 'project', key: 'kiosk' });
  const b = await remember('Kiosk app ships on Mondays (project trash).', { kind: 'project', key: 'kiosk' });
  const r = await call('POST', '/api/memory/trash/projects/kiosk');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().memories, 2);
  assert.equal((await call('POST', '/api/memory/trash/projects/kiosk')).statusCode, 409);
  const t = (await call('GET', '/api/memory/trash')).json();
  const p = t.projects.find((x) => x.slug === 'kiosk');
  assert.ok(p, 'project listed');
  assert.equal(p.memories, 2);
  assert.ok(t.items.filter((i) => i.project === 'kiosk').every((i) => i.withProject));
  const tree = db.prepare(`SELECT archived_at, trashed_at FROM memory_project_scopes WHERE owner_id = ? AND slug = 'kiosk'`).get(OWNER);
  assert.equal(tree.archived_at, tree.trashed_at, 'archived while in the Trash');

  const back = await call('POST', '/api/memory/trash/projects/kiosk/restore');
  assert.equal(back.statusCode, 200, back.body);
  assert.equal(back.json().restored, 2);
  assert.ok(await getMemoryStorage().getOwned(OWNER, a));
  assert.ok(await getMemoryStorage().getOwned(OWNER, b));
  const row = db.prepare(`SELECT archived_at, trashed_at FROM memory_project_scopes WHERE owner_id = ? AND slug = 'kiosk'`).get(OWNER);
  assert.deepEqual(row, { archived_at: null, trashed_at: null });
  assert.equal((await call('POST', '/api/memory/trash/projects/kiosk/restore')).statusCode, 409);

  // Empty Trash for a project forgets it and everything on it.
  await call('POST', '/api/memory/trash/projects/kiosk');
  const e = await call('POST', '/api/memory/trash/empty', OWNER, { confirm: 'EMPTY', projects: ['kiosk'] });
  assert.equal(e.statusCode, 200, e.body);
  assert.deepEqual(e.json().projects, ['kiosk']);
  assert.ok(!db.prepare(`SELECT 1 FROM memory_project_scopes WHERE owner_id = ? AND slug = 'kiosk'`).get(OWNER));
  assert.ok(!(await call('GET', '/api/memory/trash')).json().items.some((i) => i.project === 'kiosk'));
});

test('groups of projects: create, rename, one group per project, share within opens siblings', async () => {
  await remember('Client A web shop fact.', { kind: 'project', key: 'a-web' });
  await remember('Client A mobile app fact.', { kind: 'project', key: 'a-app' });
  await remember('Client A admin fact.', { kind: 'project', key: 'a-admin' });
  const c = await call('POST', '/api/memory/groups', OWNER, { name: 'Client A', label: 'client', projects: ['a-web', 'a-app'] });
  assert.equal(c.statusCode, 201, c.body);
  const g = c.json().group;
  assert.equal(g.shareWithin, false);
  assert.deepEqual(g.projects.sort(), ['a-app', 'a-web']);
  assert.equal((await call('POST', '/api/memory/groups', OWNER, { name: 'client a' })).statusCode, 409, 'name taken');
  assert.equal((await call('POST', '/api/memory/groups', OWNER, { name: 'Bad', projects: ['no-such-project'] })).statusCode, 404);
  assert.equal((await call('GET', '/api/memory/groups', 'md-user')).statusCode, 403);

  // Not shared yet: the turn keeps its own project only.
  assert.deepEqual((await G.withGroupDrawers(OWNER, [{ kind: 'owner' }, { kind: 'project', key: 'a-web' }])).added, []);
  const p = await call('PATCH', `/api/memory/groups/${g.id}`, OWNER, { shareWithin: true, name: 'Client A GmbH' });
  assert.equal(p.statusCode, 200, p.body);
  assert.equal(p.json().group.name, 'Client A GmbH');
  const w = await G.withGroupDrawers(OWNER, [{ kind: 'owner' }, { kind: 'project', key: 'a-web' }]);
  assert.deepEqual(w.added, [{ kind: 'project', key: 'a-app' }]);
  assert.equal(w.groupId, g.id);

  // A second group takes a-app: it leaves Client A.
  const c2 = await call('POST', '/api/memory/groups', OWNER, { name: 'Team B', projects: ['a-app', 'a-admin'] });
  assert.equal(c2.statusCode, 201, c2.body);
  const list = (await call('GET', '/api/memory/groups')).json().groups;
  assert.deepEqual(list.find((x) => x.id === g.id).projects, ['a-web']);
  const put = await call('PUT', `/api/memory/groups/${g.id}/projects`, OWNER, { projects: ['a-web', 'a-admin'] });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(put.json().group.projects, ['a-admin', 'a-web']);
  assert.deepEqual((await call('GET', '/api/memory/groups')).json().groups.find((x) => x.name === 'Team B').projects, ['a-app']);

  // An archived project is never opened through its group.
  await call('POST', '/api/memory/trash/projects/a-admin');
  assert.deepEqual((await G.withGroupDrawers(OWNER, [{ kind: 'project', key: 'a-web' }])).added, []);
  await call('POST', '/api/memory/trash/projects/a-admin/restore');

  const d = await call('DELETE', `/api/memory/groups/${g.id}`);
  assert.equal(d.statusCode, 200, d.body);
  assert.deepEqual((await G.withGroupDrawers(OWNER, [{ kind: 'project', key: 'a-web' }])).added, []);
  assert.ok(db.prepare(`SELECT 1 FROM memories WHERE drawer_key = 'a-web'`).get(), 'projects stay');
});

test('agent tools: owner gates, approvals, same actions', async () => {
  for (const name of ['memory_trash', 'memory_restore', 'memory_trash_empty', 'memory_project_trash', 'memory_groups', 'memory_group_apply']) {
    assert.ok(DEFAULT_AGENT_TOOLS.includes(name), `${name} granted by default`);
  }
  assert.equal(approvalCategory({ name: 'memory_trash_empty' }), 'delete');
  assert.equal(approvalCategory({ name: 'memory_project_trash' }), 'delete');
  assert.equal(approvalCategory({ name: 'memory_group_apply' }), 'settings');
  assert.equal(approvalCategory({ name: 'memory_trash' }), null);
  assert.equal(approvalCategory({ name: 'memory_restore' }), null);

  const id = await remember('Tool trash test memory.');
  await call('DELETE', `/api/memory/${id}`);
  assert.ok((await T.memoryTrashTool.execute({}, { ...ctx, userId: 'md-user' })).error, 'not the owner');
  assert.ok((await T.memoryTrashTool.execute({}, { ...ctx, toolPolicy: { channel: 'telegram' } })).error, 'outsider turn');
  assert.ok((await T.memoryTrashTool.execute({}, { ...ctx, accessOwnerId: OWNER, userId: 'md-agent' })).error, 'board task run');
  const list = await quietly(() => T.memoryTrashTool.execute({}, ctx));
  assert.ok(!list.error, list.error);
  assert.ok(list.data.items.some((i) => i.id === id));
  const back = await quietly(() => T.memoryRestoreTool.execute({ id }, ctx));
  assert.ok(!back.error, back.error);
  assert.ok(await getMemoryStorage().getOwned(OWNER, id));
  await call('DELETE', `/api/memory/${id}`);
  const empty = await quietly(() => T.memoryTrashEmptyTool.execute({ ids: [id] }, ctx));
  assert.deepEqual(empty.data.forgotten, [id]);

  const made = await quietly(() => T.memoryGroupApplyTool.execute({ op: 'create', name: 'Tool group', projects: ['a-web'], shareWithin: true }, ctx));
  assert.ok(!made.error, made.error);
  const groups = await quietly(() => T.memoryGroupsTool.execute({}, ctx));
  assert.ok(groups.data.groups.some((x) => x.name === 'Tool group' && x.shareWithin));
  assert.ok((await T.memoryGroupApplyTool.execute({ op: 'explode' }, ctx)).error);
  const del = await quietly(() => T.memoryGroupApplyTool.execute({ op: 'delete', id: made.data.group.id }, ctx));
  assert.ok(!del.error, del.error);
  const pt = await quietly(() => T.memoryProjectTrashTool.execute({ project: 'a-web' }, ctx));
  assert.ok(!pt.error, pt.error);
  const pr = await quietly(() => T.memoryRestoreTool.execute({ project: 'a-web' }, ctx));
  assert.equal(pr.data.restored, 1);
});
