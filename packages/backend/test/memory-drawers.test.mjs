// CORE-03: memory drawers, scoped reads.
// Run: node --import tsx --test test/memory-drawers.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network (local word-count
// embedding; fetch is refused).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-drawers-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
delete process.env.OUTSIDER_AGENT_MEMORY;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };

const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('dr-owner', 'owner');
addUser('dr-other', 'user');

// Rows saved before drawers existed (drawer columns NULL).
const legacy = db.prepare(`INSERT INTO memories (id, user_id, type, content, created_at) VALUES (?, 'dr-owner', ?, ?, datetime('now'))`);
legacy.run('legacy-fact', 'fact', 'legacy fact row');
legacy.run('legacy-pref', 'preference', 'legacy preference row');
legacy.run('legacy-skill', 'skill', 'legacy skill row');
legacy.run('legacy-insight', 'insight', 'legacy insight row');

const D = await import(join(backendDir, 'src/memory/drawers.ts'));
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { memoryRoutes } = await import(join(backendDir, 'src/api/routes/memory.ts'));
const { chatRoutes } = await import(join(backendDir, 'src/api/routes/chat.ts'));
const { memorySearchTool } = await import(join(backendDir, 'src/tools/memory/search.ts'));
const { memorySaveTool } = await import(join(backendDir, 'src/tools/memory/save.ts'));
const { memoryReflectTool } = await import(join(backendDir, 'src/tools/memory/memory-reflect.tool.ts'));
const { memoryStatsTool } = await import(join(backendDir, 'src/tools/memory/memory-stats.tool.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');

// Memory routes initialize storage (which runs the drawer backfill once).
const logged = [];
console.log = (...a) => logged.push(a.join(' '));
const app = Fastify();
registerAuthGate(app);
await app.register(memoryRoutes);
await app.register(chatRoutes);
await app.ready();
console.log = quiet.log;
console.warn = quiet.warn;

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const quietly = async (fn) => { const l = console.log; const w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
const create = (who, payload) => quietly(() => app.inject({ method: 'POST', url: '/api/memory', headers: auth(who), payload }));
const TEXT = 'release plan server deploy';
const ids = {};
async function seed(who, name, drawer, type = 'fact') {
  const res = await create(who, { type, content: `${TEXT} ${name}`, importance: 8, ...(drawer ? { drawer } : {}) });
  assert.equal(res.statusCode, 200, res.body);
  ids[`${who}:${name}`] = res.json().memory.id;
}
const relevant = async (who, qs = '') => {
  const res = await quietly(() => app.inject({ method: 'GET', url: `/api/memory/relevant?query=${encodeURIComponent(TEXT)}&limit=50${qs}`, headers: auth(who) }));
  return res;
};
const names = (res) => res.json().memories.map((m) => m.content.slice(TEXT.length + 1)).sort();

test('migration: existing rows get the default drawer for their type, counts logged only', async () => {
  const rows = Object.fromEntries(db.prepare(`SELECT id, drawer_kind, drawer_key FROM memories WHERE id LIKE 'legacy-%'`).all().map((r) => [r.id, `${r.drawer_kind}|${r.drawer_key}`]));
  assert.deepEqual(rows, {
    'legacy-fact': 'owner|', 'legacy-pref': 'owner|', 'legacy-skill': 'experience|', 'legacy-insight': 'experience|',
  });
  const line = logged.find((l) => l.includes('Drawers assigned'));
  assert.ok(line, 'backfill logged');
  assert.match(line, /owner 2, experience 2/);
  assert.ok(!/legacy (fact|skill) row/.test(logged.join('\n')), 'no memory content in the log');
  // Idempotent: a second run changes nothing.
  assert.deepEqual(await quietly(() => D.backfillMemoryDrawers(db)), { owner: 0, experience: 0 });
  // Index exists.
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memories_drawer'`).get());
});

test('create: drawer validated, default by type', async () => {
  for (const drawer of [
    { kind: 'secret' }, { kind: 'project' }, { kind: 'project', key: 'Alpha!' }, { kind: 'project', key: '../x' },
    { kind: 'owner', key: 'x' }, { kind: 'people', key: '..' }, 'project:alpha', [1],
  ]) {
    const res = await create('dr-owner', { type: 'fact', content: 'x', drawer });
    assert.equal(res.statusCode, 400, JSON.stringify(drawer));
  }
  await seed('dr-owner', 'owner-fact');                                   // default -> owner
  await seed('dr-owner', 'exp-skill', undefined, 'skill');                // default -> experience
  await seed('dr-owner', 'alpha', { kind: 'project', key: 'alpha' });
  await seed('dr-owner', 'beta', { kind: 'project', key: 'beta' });
  await seed('dr-owner', 'task-t1', { kind: 'task', key: 't1' });
  await seed('dr-owner', 'task-t2', { kind: 'task', key: 't2' });
  await seed('dr-owner', 'person-p1', { kind: 'people', key: 'p1' });
  await seed('dr-owner', 'person-p2', { kind: 'people', key: 'p2' });
  await seed('dr-other', 'other-alpha', { kind: 'project', key: 'alpha' });
  await seed('dr-other', 'other-owner');
  const stored = db.prepare('SELECT drawer_kind, drawer_key FROM memories WHERE id = ?');
  assert.deepEqual({ ...stored.get(ids['dr-owner:owner-fact']) }, { drawer_kind: 'owner', drawer_key: '' });
  assert.deepEqual({ ...stored.get(ids['dr-owner:exp-skill']) }, { drawer_kind: 'experience', drawer_key: '' });
  assert.deepEqual({ ...stored.get(ids['dr-owner:alpha']) }, { drawer_kind: 'project', drawer_key: 'alpha' });

  const list = (await app.inject({ method: 'GET', url: '/api/memory/drawers', headers: auth('dr-owner') })).json().drawers;
  assert.deepEqual(list.map((d) => `${D.drawerId(d)}=${d.count}`), [
    'experience=3', 'owner=3', 'people:p1=1', 'people:p2=1', 'project:alpha=1', 'project:beta=1', 'task:t1=1', 'task:t2=1',
  ]);
});

test('scoped reads: a project A turn never sees project B (nor other tasks/people/users)', async () => {
  // No scope: owner + experience drawers only.
  const plain = await relevant('dr-owner');
  assert.equal(plain.statusCode, 200, plain.body);
  assert.deepEqual(names(plain), ['exp-skill', 'owner-fact']);

  const alpha = await relevant('dr-owner', '&project=alpha');
  assert.deepEqual(names(alpha), ['alpha', 'exp-skill', 'owner-fact']);
  assert.ok(!names(alpha).includes('beta'));
  assert.ok(!names(alpha).includes('other-alpha'), 'another user\'s project alpha stays out');

  const beta = await relevant('dr-owner', '&project=beta&task=t1&people=p1');
  assert.deepEqual(names(beta), ['beta', 'exp-skill', 'owner-fact', 'person-p1', 'task-t1']);

  const noExp = await relevant('dr-owner', '&project=alpha&experience=false');
  assert.deepEqual(names(noExp), ['alpha', 'owner-fact']);

  const other = await relevant('dr-other', '&project=alpha');
  assert.deepEqual(names(other), ['other-alpha', 'other-owner']);

  for (const qs of ['&project=Alpha', '&project=../beta', '&task=a/b', `&people=${Array.from({ length: 11 }, (_, i) => `p${i}`).join(',')}`]) {
    assert.equal((await relevant('dr-owner', qs)).statusCode, 400, qs);
  }

  // Browsing one's own memory still searches every drawer; scope narrows it.
  const search = async (payload) => (await quietly(() => app.inject({ method: 'POST', url: '/api/memory/search', headers: auth('dr-owner'), payload: { query: TEXT, limit: 50, ...payload } }))).json().results.map((r) => r.memory.content.slice(TEXT.length + 1)).sort();
  assert.deepEqual(await search({}), ['alpha', 'beta', 'exp-skill', 'owner-fact', 'person-p1', 'person-p2', 'task-t1', 'task-t2']);
  assert.deepEqual(await search({ project: 'alpha' }), ['alpha', 'exp-skill', 'owner-fact']);
});

test('selectDrawers: owner selection, outsider none, sub-agent only a subset of the parent', () => {
  assert.deepEqual(D.selectDrawers({ audience: 'outsider', project: 'alpha' }), []);
  assert.deepEqual(D.selectDrawers({ audience: 'owner' }).map(D.drawerId), ['owner', 'experience']);
  const parent = D.selectDrawers({ audience: 'owner', project: 'alpha', task: 'run-1', people: ['p1', 'p1', 'bad/id'] });
  assert.deepEqual(parent.map(D.drawerId), ['owner', 'experience', 'project:alpha', 'task:run-1', 'people:p1']);
  // A parent passes a subset; anything it does not hold is dropped.
  const passed = D.subagentDrawers(parent, ['project:alpha', 'project:beta', 'people:p2', { kind: 'task', key: 'run-1' }, 'nonsense', 'project:alpha']);
  assert.deepEqual(passed.map(D.drawerId), ['project:alpha', 'task:run-1']);
  assert.deepEqual(D.subagentDrawers(parent, undefined), []);
  const sub = D.selectDrawers({ audience: 'subagent', passed, project: 'beta' });
  assert.deepEqual(sub.map(D.drawerId), ['project:alpha', 'task:run-1'], 'a sub-agent cannot add drawers itself');
  assert.deepEqual(D.selectDrawers({ audience: 'subagent' }), []);
  assert.deepEqual(D.chatTurnDrawers(false, { project: 'alpha' }), [], 'channel turn: none');
  assert.deepEqual(D.chatTurnDrawers(true, { project: 'alpha' }).map(D.drawerId), ['owner', 'experience', 'project:alpha']);
  assert.throws(() => D.chatTurnDrawers(true, { project: 'x/y' }), D.DrawerInputError);
});

test('memory tools: run user from context, only the turn\'s drawers; channel turn none', async () => {
  const run = (tool, params, context) => quietly(() => tool.execute(params, context));
  const found = (r) => (r.data?.memories || []).map((m) => m.content.slice(TEXT.length + 1)).sort();

  const ctxAlpha = { workspaceDir: dir, userId: 'dr-owner', memoryDrawers: D.selectDrawers({ audience: 'owner', project: 'alpha' }) };
  // A model-supplied userId is ignored.
  const r1 = await run(memorySearchTool, { query: TEXT, limit: 20, userId: 'dr-other' }, ctxAlpha);
  assert.deepEqual(found(r1), ['alpha', 'exp-skill', 'owner-fact']);

  const sub = { workspaceDir: dir, userId: 'dr-owner', memoryDrawers: D.selectDrawers({ audience: 'subagent', passed: [{ kind: 'project', key: 'beta' }] }) };
  assert.deepEqual(found(await run(memorySearchTool, { query: TEXT, limit: 20 }, sub)), ['beta']);

  const channel = { workspaceDir: dir, userId: 'dr-owner', toolPolicy: { channel: 'telegram', allowedTools: new Set(['memory_search']) } };
  assert.deepEqual(found(await run(memorySearchTool, { query: TEXT, limit: 20 }, channel)), []);

  // memory_save writes only into a drawer open for the turn.
  const bad = await run(memorySaveTool, { content: `${TEXT} sneaky`, drawer: 'project:beta', userId: 'dr-owner' }, ctxAlpha);
  assert.ok(bad.error, 'beta drawer is not open in an alpha turn');
  const ok = await run(memorySaveTool, { content: `${TEXT} alpha-note`, type: 'fact', importance: 9, drawer: 'project:alpha', userId: 'dr-other' }, ctxAlpha);
  assert.ok(!ok.error, ok.error);
  const row = db.prepare('SELECT user_id, drawer_kind, drawer_key FROM memories WHERE id = ?').get(ok.data.memoryId);
  assert.deepEqual({ ...row }, { user_id: 'dr-owner', drawer_kind: 'project', drawer_key: 'alpha' });
  db.prepare('DELETE FROM memories WHERE id = ?').run(ok.data.memoryId);
});

test('memory tools fail closed without a run user; no userId in any schema', async () => {
  for (const tool of [memorySearchTool, memorySaveTool, memoryReflectTool, memoryStatsTool]) {
    assert.ok(!('userId' in (tool.input_schema.properties || {})), `${tool.name} schema has no userId`);
    assert.ok(!(tool.input_schema.required || []).includes('userId'), `${tool.name} does not require userId`);
    assert.ok(!JSON.stringify(tool.input_schema.examples || []).includes('userId'), `${tool.name} examples`);
  }
  const before = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
  const noUser = { workspaceDir: dir };
  const r1 = await quietly(() => memorySearchTool.execute({ query: TEXT, userId: 'dr-owner' }, noUser));
  assert.ok(r1.error && !(r1.data?.memories?.length), 'search without a run user');
  const r2 = await quietly(() => memorySaveTool.execute({ content: `${TEXT} x`, userId: 'dr-owner' }, noUser));
  assert.ok(r2.error, 'save without a run user');
  const r3 = await quietly(() => memoryReflectTool.execute({ userId: 'dr-owner' }, noUser));
  assert.ok(!r3.data, 'reflect without a run user');
  const r4 = await quietly(() => memoryStatsTool.execute({ userId: 'dr-owner' }, noUser));
  assert.ok(!r4.data, 'stats without a run user');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, before, 'nothing written');
});

test('memory_reflect / memory_stats: open drawers only, reflection saved in the narrowest source drawer', async () => {
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
  const before = count();
  // Outsider (channel turn): nothing read, nothing written.
  const channel = { workspaceDir: dir, userId: 'dr-owner', toolPolicy: { channel: 'telegram', allowedTools: new Set() } };
  assert.ok(!(await quietly(() => memoryReflectTool.execute({}, channel))).data);
  assert.ok(!(await quietly(() => memoryStatsTool.execute({}, channel))).data);
  assert.equal(count(), before);

  const alphaCtx = { workspaceDir: dir, userId: 'dr-owner', memoryDrawers: D.selectDrawers({ audience: 'owner', project: 'alpha' }) };
  const stats = await quietly(() => memoryStatsTool.execute({ userId: 'dr-other' }, alphaCtx));
  assert.equal(stats.data.total, 7, 'owner 3 + experience 3 + project alpha 1 (not beta/tasks/people/other user)');
  const sub = { workspaceDir: dir, userId: 'dr-owner', memoryDrawers: [{ kind: 'project', key: 'beta' }] };
  assert.equal((await quietly(() => memoryStatsTool.execute({}, sub))).data.total, 1);

  const refl = await quietly(() => memoryReflectTool.execute({ userId: 'dr-other', lookbackCount: 50 }, alphaCtx));
  assert.ok(refl.data, refl.content?.[0]?.text);
  assert.equal(refl.data.analyzedCount, 7);
  const text = refl.content[0].text;
  assert.ok(!/beta|person-p|task-t|other-/.test(text), 'closed drawers never appear in the reflection');
  const row = db.prepare('SELECT user_id, drawer_kind, drawer_key FROM memories WHERE id = ?').get(refl.data.reflectionId);
  assert.deepEqual({ ...row }, { user_id: 'dr-owner', drawer_kind: 'project', drawer_key: 'alpha' });
  db.prepare('DELETE FROM memories WHERE id = ?').run(refl.data.reflectionId);

  const subRefl = await quietly(() => memoryReflectTool.execute({}, sub));
  const subRow = db.prepare('SELECT drawer_kind, drawer_key FROM memories WHERE id = ?').get(subRefl.data.reflectionId);
  assert.deepEqual({ ...subRow }, { drawer_kind: 'project', drawer_key: 'beta' });
  db.prepare('DELETE FROM memories WHERE id = ?').run(subRefl.data.reflectionId);
});

test('chat: memoryScope is validated (drawers chosen server side)', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/chat', headers: auth('dr-owner'),
    payload: { messages: [{ role: 'user', content: 'hi' }], memoryScope: { project: 'Not A Slug' } },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, 'Invalid memoryScope');
});

test('storage: getByDrawers reads only the named drawers', async () => {
  const storage = getMemoryStorage();
  const rows = await storage.getByDrawers('dr-owner', [{ kind: 'project', key: 'alpha' }]);
  assert.deepEqual(rows.map((m) => m.id), [ids['dr-owner:alpha']]);
  assert.deepEqual(rows[0].drawer, { kind: 'project', key: 'alpha' });
  assert.deepEqual(await storage.getByDrawers('dr-owner', []), []);
});

test('shared project drawers remain readable but refuse writes and preserve restrictions through approval replay',async()=>{
 const {drawerWritable,drawerOpen}=await import(join(backendDir,'src/repositories/scope.ts'));
 const {runScopeOf}=await import(join(backendDir,'src/tools/approvals.ts'));
 const {approvalRunDrawers}=await import(join(backendDir,'src/tools/memory/scope.ts'));
 const drawers=[{kind:'project',key:'alpha'},{kind:'project',key:'beta',readOnly:true}];
 const actor={kind:'agent',role:'owner',userId:'dr-owner',drawers,writeKinds:['project']};
 assert.equal(drawerOpen(actor,{kind:'project',key:'beta'}),true);assert.equal(drawerWritable(actor,{kind:'project',key:'beta'}),false);assert.equal(drawerWritable(actor,{kind:'project',key:'alpha'}),true);
 const scope=runScopeOf({userId:'dr-owner',workspaceDir:dir,memoryDrawers:drawers});assert.equal(scope.memoryDrawers[1].readOnly,true);
 const restored=approvalRunDrawers(JSON.parse(JSON.stringify(scope)).memoryDrawers,{});assert.equal(restored[1].readOnly,true);
 const legacy=approvalRunDrawers([{kind:'project',key:'alpha'},{kind:'project',key:'beta'}],{});assert.equal(legacy[1].readOnly,true,'older multi-project approvals cannot regain writes');
 const denied=await quietly(()=>memorySaveTool.execute({content:'Shared write must not persist',drawer:'project:beta'}, {userId:'dr-owner',workspaceDir:dir,memoryDrawers:drawers}));assert.ok(denied.error);
});
