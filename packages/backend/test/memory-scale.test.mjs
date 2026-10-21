// MEM-SCALE-01: memory at scale. Scope tree (company -> department ->
// project, people, agents) with counts and health; pinned facts loaded first;
// project lifecycle with preview + confirm (archive = never recalled, merge,
// move, forget); access by inheritance with role templates, temporary
// exceptions, previews and "why"; server-side explorer paging; agent tools
// with the same owner gates; a seeded 100-project / 3,000-agent company.
// Run: node --import tsx --test test/memory-scale.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network, no local model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-memscale-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.OLLAMA_URL = 'http://127.0.0.1:9'; // never a real local model
process.env.MEMORY_GRAPH_MODEL = 'off';

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };

const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('ms-owner', 'owner');
addUser('ms-user', 'user');
const addAgent = (id, name = id) => db.prepare('INSERT INTO agents_config (id, name) VALUES (?, ?)').run(id, name);
addAgent('agent-a', 'Alpha Writer');
addAgent('agent-b', 'Beta Reader');

const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { memoryScopeRoutes } = await import(join(backendDir, 'src/api/routes/memory-scopes.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { newMemory, saveVersioned } = await import(join(backendDir, 'src/memory/learning.ts'));
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
const { memoryRecall } = await import(join(backendDir, 'src/repositories/memory-recall.ts'));
const { userActor } = await import(join(backendDir, 'src/repositories/actor.ts'));
const S = await import(join(backendDir, 'src/memory/scopes/index.ts'));
const P = await import(join(backendDir, 'src/tools/agent-permissions.ts'));
const { memorySearchTool } = await import(join(backendDir, 'src/tools/memory/search.ts'));
const T = await import(join(backendDir, 'src/tools/memory/scopes.ts'));
const G = await import(join(backendDir, 'src/memory/graph/index.ts'));
const { DEFAULT_AGENT_TOOLS } = await import(join(backendDir, 'src/tools/grants.ts'));
const { APPROVAL_REQUIRED_TOOLS } = await import(join(backendDir, 'src/tools/approvals.ts'));
const { default: Fastify } = await import('fastify');

const app = Fastify();
registerAuthGate(app);
await app.register(memoryScopeRoutes);
await app.ready();
console.log = quiet.log;
console.warn = quiet.warn;

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const OWNER = 'ms-owner';
const owner = userActor({ id: OWNER, role: 'owner' });
const auth = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const quietly = async (fn) => { const l = console.log; const w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
const call = (method, url, payload, who = OWNER) => quietly(() => app.inject({ method, url, headers: auth(who), payload }));
const ok = async (method, url, payload, status = 200) => {
  const res = await call(method, url, payload);
  assert.equal(res.statusCode, status, `${method} ${url}: ${res.body}`);
  return res.json();
};
const save = (content, drawer, topicKey = null, userId = OWNER) =>
  quietly(() => saveVersioned(newMemory(userId, drawer, { type: 'fact', importance: 5, content }, {}, topicKey), 'test', 'test'));
const project = (key) => ({ kind: 'project', key });
const chatProject = (id, slug, name) => db.prepare('INSERT INTO chat_projects (id, user_id, name, slug) VALUES (?, ?, ?, ?)').run(id, OWNER, name, slug);
const searchIds = async (query, drawers) => (await quietly(() => memoryRecall.search(owner, { query, limit: 20, ...(drawers ? { drawers } : {}) }))).map((r) => r.memory.id);
const lifecycle = async (slug, body) => {
  const preview = await ok('POST', `/api/memory/scopes/projects/${slug}/preview`, body);
  return ok('POST', `/api/memory/scopes/projects/${slug}/apply`, { ...body, expectedPreviewHash: preview.previewHash, confirm: true });
};
const accessApply = async (changes) => {
  const preview = await ok('POST', '/api/memory/access/preview', { changes });
  const out = await ok('POST', '/api/memory/access/apply', { changes, expectedPreviewHash: preview.previewHash, confirm: true });
  return { preview, out };
};

// ---------------------------------------------------------------------------

test('owner only: members and anonymous callers are refused', async () => {
  for (const url of ['/api/memory/scopes/tree', '/api/memory/access', '/api/memory/scopes/memories?scope=company']) {
    const member = await call('GET', url, undefined, 'ms-user');
    assert.equal(member.statusCode, 403, url);
    const anon = await quietly(() => app.inject({ method: 'GET', url }));
    assert.equal(anon.statusCode, 401, url);
  }
  assert.equal((await call('GET', '/api/memory/scopes/tree')).statusCode, 200);
});

test('tree: departments, General default, counts and health per scope', async () => {
  chatProject('cp-alpha', 'alpha', 'Alpha App');
  await save('alpha uses postgres', project('alpha'));
  await save('alpha ships friday', project('alpha'));
  await save('beta is a game', project('beta'));
  await save('Sara likes tea', { kind: 'people', key: 'sara' });
  await save('owner prefers short answers', { kind: 'owner' });
  const { department } = await ok('POST', '/api/memory/scopes/departments', { name: 'Engineering' }, 201);
  assert.equal((await call('POST', '/api/memory/scopes/departments', { name: 'engineering ' })).statusCode, 409);
  await lifecycle('alpha', { action: 'move', departmentId: department.id });

  const tree = await ok('GET', '/api/memory/scopes/tree?fresh=1');
  assert.equal(tree.company.memories, 5);
  assert.equal(tree.company.projects, 2);
  const general = tree.departments.find((d) => d.isDefault);
  const eng = tree.departments.find((d) => d.id === department.id);
  assert.equal(general.name, 'General');
  assert.equal(general.projects, 1);
  assert.equal(general.memories, 1);
  assert.equal(eng.projects, 1);
  assert.equal(eng.memories, 2);
  const alpha = tree.projects.find((p) => p.slug === 'alpha');
  assert.equal(alpha.name, 'Alpha App');
  assert.equal(alpha.chatProjectId, 'cp-alpha');
  assert.equal(alpha.departmentId, department.id);
  assert.equal(alpha.memories, 2);
  assert.equal(alpha.health, 'ok');
  assert.deepEqual(tree.people.map((p) => p.key), ['sara']);
  assert.ok(tree.agents.total >= 2);

  // A conflict review in a drawer flags it as a problem; the cached tree is dropped by ?fresh.
  db.prepare(`INSERT INTO memory_file_proposals (id, user_id, agent_id, drawer_kind, drawer_key, base_hash, base_revision, changes, status, source, created_by, reasons, conflict_with)
    VALUES ('prop-c1', ?, '(none)', 'project', 'beta', 'x', 0, '[]', 'pending', 'learning', 'test', '[]', 'm-x')`).run(OWNER);
  const t2 = await ok('GET', '/api/memory/scopes/tree?fresh=1');
  const beta = t2.projects.find((p) => p.slug === 'beta');
  assert.equal(beta.health, 'problem');
  assert.deepEqual(beta.reasons, ['conflicts', 'reviews_waiting']);
  assert.equal(t2.departments.find((d) => d.isDefault).health, 'problem');
  db.prepare("DELETE FROM memory_file_proposals WHERE id = 'prop-c1'").run();
  assert.equal((await ok('GET', '/api/memory/scopes/tree')).cached, true);

  const { hits } = await ok('GET', '/api/memory/scopes/search?q=alp');
  assert.ok(hits.some((h) => h.kind === 'project' && h.id === 'alpha'));
  assert.ok(hits.some((h) => h.kind === 'agent' && h.id === 'agent-a'));
  const people = await ok('GET', '/api/memory/scopes/search?q=sar&kinds=people');
  assert.deepEqual(people.hits.map((h) => `${h.kind}:${h.id}`), ['people:sara']);
});

test('pinned facts: company, department and project load first, size-limited, redacted', async () => {
  const tree = await ok('GET', '/api/memory/scopes/tree?fresh=1');
  const eng = tree.departments.find((d) => d.name === 'Engineering');
  await ok('POST', '/api/memory/scopes/pinned', { scope: 'company', text: 'We are Dpro.' }, 201);
  await ok('POST', '/api/memory/scopes/pinned', { scope: `department:${eng.id}`, text: 'Engineering ships on Fridays.' }, 201);
  const { fact } = await ok('POST', '/api/memory/scopes/pinned', { scope: 'project:alpha', text: 'Alpha key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 201);
  assert.ok(!fact.text.includes('AAAAAAAAAAAAAAAA'), 'a secret is never pinned');
  await ok('PATCH', `/api/memory/scopes/pinned/${fact.id}`, { text: 'Alpha runs on PostgreSQL 16.' });
  assert.equal((await call('POST', '/api/memory/scopes/pinned', { scope: 'project:nope', text: 'x' })).statusCode, 404);
  assert.equal((await ok('GET', '/api/memory/scopes/pinned?scope=project:alpha')).facts.length, 1);

  const block = await S.pinnedFactsBlock(OWNER, 'alpha');
  assert.match(block, /^## Pinned facts/);
  const iCompany = block.indexOf('We are Dpro.');
  const iDept = block.indexOf('Engineering ships on Fridays.');
  const iProject = block.indexOf('Alpha runs on PostgreSQL 16.');
  assert.ok(iCompany > 0 && iDept > iCompany && iProject > iDept, block);
  assert.equal(await S.pinnedFactsBlock(OWNER, 'beta'), '## Pinned facts\nThe owner pinned these facts. They hold unless the owner changes them.\nCompany:\n- We are Dpro.');
  assert.equal(await S.pinnedFactsBlock('ms-user', 'alpha'), '', 'never across owners');

  // Size limit: the most specific facts keep their place.
  for (let i = 0; i < 6; i++) await S.addPinnedFact(OWNER, { kind: 'company', id: '' }, `Company filler ${i} `.padEnd(400, 'x'), OWNER);
  const big = await S.pinnedFactsBlock(OWNER, 'alpha');
  assert.ok(big.length <= S.MAX_PINNED_BLOCK_CHARS + 200, String(big.length));
  assert.ok(big.includes('Alpha runs on PostgreSQL 16.'));
  for (const f of (await S.listPinnedFacts(OWNER, { kind: 'company', id: '' })).filter((f) => f.text.startsWith('Company filler'))) await S.removePinnedFact(OWNER, f.id);
});

test('archive: kept, never recalled or loaded; unarchive brings it back', async () => {
  const m = await save('the gamma launch code word is bluebird', project('gamma'));
  assert.ok((await searchIds('bluebird')).includes(m.id));
  await ok('POST', '/api/memory/scopes/pinned', { scope: 'project:gamma', text: 'Gamma is secret.' }, 201);

  const preview = await ok('POST', '/api/memory/scopes/projects/gamma/preview', { action: 'archive' });
  assert.equal(preview.effects.memories, 1);
  assert.equal(preview.effects.keptButNotLoaded, true);
  assert.equal((await call('POST', '/api/memory/scopes/projects/gamma/apply', { action: 'archive', expectedPreviewHash: preview.previewHash })).statusCode, 400, 'confirm is required');
  assert.equal((await call('POST', '/api/memory/scopes/projects/gamma/apply', { action: 'archive', expectedPreviewHash: 'stale', confirm: true })).statusCode, 409);
  await ok('POST', '/api/memory/scopes/projects/gamma/apply', { action: 'archive', expectedPreviewHash: preview.previewHash, confirm: true });

  // Recall: not with all drawers, not with the archived drawer asked for, not via the agent tool.
  assert.ok(!(await searchIds('bluebird')).includes(m.id));
  assert.ok(!(await searchIds('bluebird', [project('gamma')])).includes(m.id));
  const tool = await quietly(() => memorySearchTool.execute({ query: 'bluebird', limit: 10 }, { workspaceDir: dir, userId: OWNER, memoryDrawers: [{ kind: 'owner' }, project('gamma')] }));
  assert.ok(!(tool.data?.memories || []).some((x) => x.id === m.id));
  assert.ok(!(await memoryRecall.reachable(owner)).some((x) => x.id === m.id));
  // A reply in that project: its drawer is dropped and its pinned facts are not loaded.
  assert.deepEqual(await S.withoutArchivedDrawers(OWNER, [{ kind: 'owner' }, project('gamma')]), [{ kind: 'owner' }]);
  assert.ok(!(await S.pinnedFactsBlock(OWNER, 'gamma')).includes('Gamma is secret.'));
  // Kept: still in the store and browsable by the owner.
  assert.ok(await getMemoryStorage().getOwned(OWNER, m.id));
  const page = await ok('GET', '/api/memory/scopes/memories?scope=project:gamma');
  assert.deepEqual(page.items.map((i) => i.id), [m.id]);
  const tree = await ok('GET', '/api/memory/scopes/tree?fresh=1');
  assert.equal(tree.projects.find((p) => p.slug === 'gamma').archived, true);
  assert.equal(tree.departments.find((d) => d.isDefault).archivedProjects, 1);

  await lifecycle('gamma', { action: 'unarchive' });
  assert.ok((await searchIds('bluebird')).includes(m.id));
});

test('merge: memories, topics (conflicts as reviews), graph, pinned facts, conversations and handoffs move', async () => {
  chatProject('cp-src', 'src-app', 'Source App');
  chatProject('cp-dst', 'dst-app', 'Target App');
  const a = await save('src: deploy with docker', project('src-app'));
  const b = await save('src: database is mysql', project('src-app'), 'database');
  const keep = await save('dst: database is postgres', project('dst-app'), 'database');
  await S.addPinnedFact(OWNER, { kind: 'project', id: 'src-app' }, 'Source pinned fact.', OWNER);
  db.prepare("INSERT INTO chat_sessions (id, user_id, title, model, project_id) VALUES ('conv-src-1', ?, 'c', 'default', 'cp-src')").run(OWNER);
  db.prepare("INSERT INTO agent_handoffs (id, owner_id, agent_id, scope_kind, scope_id, project_id, version, source) VALUES ('h1', ?, 'agent-a', 'conversation', 'conv-src-1', 'cp-src', 1, 'agent')").run(OWNER);
  // The graph indexer (deterministic fallback) already made the project entities from the drawers.
  await G.graphIdle();
  const ent = (name) => {
    db.prepare("INSERT OR IGNORE INTO memory_graph_entities (id, user_id, kind, name, norm_name) VALUES (?, ?, 'project', ?, ?)").run(`e-${name}`, OWNER, name, name.replace('-', ' '));
    return db.prepare('SELECT id FROM memory_graph_entities WHERE user_id = ? AND norm_name = ?').get(OWNER, name.replace('-', ' ')).id;
  };
  const eSrc = ent('src-app');
  const eDst = ent('dst-app');
  db.prepare("INSERT OR IGNORE INTO memory_graph_entities (id, user_id, kind, name, norm_name) VALUES ('e-sara', ?, 'person', 'Sara', 'sara')").run(OWNER);
  const eSara = db.prepare("SELECT id FROM memory_graph_entities WHERE user_id = ? AND norm_name = 'sara'").get(OWNER).id;
  db.prepare("INSERT INTO memory_graph_links (id, user_id, src_id, type, dst_id) VALUES ('l1', ?, ?, 'works_on', ?)").run(OWNER, eSara, eSrc);
  db.prepare("INSERT INTO memory_graph_link_sources (link_id, memory_id, user_id) VALUES ('l1', ?, ?)").run(a.id, OWNER);
  db.prepare("INSERT OR IGNORE INTO memory_graph_mentions (memory_id, entity_id, user_id) VALUES (?, ?, ?)").run(a.id, eSrc, OWNER);

  const preview = await ok('POST', '/api/memory/scopes/projects/src-app/preview', { action: 'merge', target: 'dst-app' });
  assert.equal(preview.effects.memories, 2);
  assert.equal(preview.effects.moved, 1);
  assert.equal(preview.effects.topicConflicts, 1);
  assert.equal(preview.effects.conversations, 1);
  assert.equal(preview.effects.handoffs, 1);
  assert.equal(preview.effects.graphEntity, true);
  assert.equal((await call('POST', '/api/memory/scopes/projects/src-app/preview', { action: 'merge', target: 'src-app' })).statusCode, 400);

  // Something changes after the preview: the apply is refused.
  const late = await save('src: late memory', project('src-app'));
  assert.equal((await call('POST', '/api/memory/scopes/projects/src-app/apply', { action: 'merge', target: 'dst-app', expectedPreviewHash: preview.previewHash, confirm: true })).statusCode, 409);
  const out = await lifecycle('src-app', { action: 'merge', target: 'dst-app' });
  assert.equal(out.result.moved, 2);
  assert.equal(out.result.conflictReviews.length, 1);

  const moved = await getMemoryStorage().getOwned(OWNER, a.id);
  assert.deepEqual(moved.drawer, project('dst-app'));
  assert.equal((await getMemoryStorage().getOwned(OWNER, late.id)).drawer.key, 'dst-app');
  assert.equal(await getMemoryStorage().getOwned(OWNER, b.id), null, 'the conflicting memory waits as a review, never written over');
  assert.equal((await getMemoryStorage().getOwned(OWNER, keep.id)).content, 'dst: database is postgres');
  const review = db.prepare('SELECT * FROM memory_file_proposals WHERE id = ?').get(out.result.conflictReviews[0]);
  assert.equal(review.conflict_with, keep.id);
  assert.equal(review.drawer_key, 'dst-app');
  assert.match(review.changes, /database is mysql/);
  assert.equal(db.prepare("SELECT change FROM memory_versions WHERE memory_id = ? ORDER BY version DESC LIMIT 1").get(a.id).change, 'update');
  // Graph: one project entity, link and mention re-pointed.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_graph_entities WHERE id = ?').get(eSrc).n, 0);
  assert.equal(db.prepare("SELECT dst_id FROM memory_graph_links WHERE id = 'l1'").get().dst_id, eDst);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_graph_mentions WHERE entity_id = ? AND memory_id = ?').get(eDst, a.id).n, 1);
  // Pinned facts, conversations, handoffs.
  assert.deepEqual((await S.listPinnedFacts(OWNER, { kind: 'project', id: 'dst-app' })).map((f) => f.text), ['Source pinned fact.']);
  assert.equal(db.prepare("SELECT project_id FROM chat_sessions WHERE id = 'conv-src-1'").get().project_id, 'cp-dst');
  assert.equal(db.prepare("SELECT project_id FROM agent_handoffs WHERE id = 'h1'").get().project_id, 'cp-dst');
  // The source is archived as merged.
  const src = await S.getProject(OWNER, 'src-app');
  assert.equal(src.archived, true);
  assert.equal(src.mergedInto, 'dst-app');
});

test('export and forget all (CORE-07 tombstones, pinned facts, rules, handoffs)', async () => {
  chatProject('cp-old', 'old-app', 'Old App');
  const m1 = await save('old app note one', project('old-app'));
  await save('old app note two', project('old-app'));
  await S.addPinnedFact(OWNER, { kind: 'project', id: 'old-app' }, 'Old pinned.', OWNER);
  db.prepare("INSERT INTO agent_handoffs (id, owner_id, agent_id, scope_kind, scope_id, project_id, version, source, done) VALUES ('h-old', ?, 'agent-a', 'conversation', 'conv-old', 'cp-old', 1, 'agent', '[\"wrote tests\"]')").run(OWNER);

  const exp = await ok('GET', '/api/memory/scopes/projects/old-app/export');
  assert.deepEqual(exp.files.map((f) => f.name), ['project-old-app-memory.md', 'project-old-app-pinned-facts.md', 'project-old-app-handoffs.md']);
  assert.match(exp.files[0].content, /old app note one/);
  assert.match(exp.files[1].content, /Old pinned\./);
  assert.match(exp.files[2].content, /wrote tests/);

  const preview = await ok('POST', '/api/memory/scopes/projects/old-app/preview', { action: 'forget' });
  assert.equal(preview.effects.memories, 2);
  assert.equal(preview.effects.irreversible, true);
  const out = await ok('POST', '/api/memory/scopes/projects/old-app/apply', { action: 'forget', expectedPreviewHash: preview.previewHash, confirm: true });
  assert.equal(out.result.forgotten, 2);
  assert.equal(out.result.handoffsRemoved, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE drawer_kind = 'project' AND drawer_key = 'old-app'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ? AND change = 'forget'").get(m1.id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ? AND content IS NOT NULL").get(m1.id).n, 0);
  assert.equal((await S.listPinnedFacts(OWNER, { kind: 'project', id: 'old-app' })).length, 0);
});

test('access by inheritance: company -> department -> project -> agent exception, capped by the agent', async () => {
  const tree = await ok('GET', '/api/memory/scopes/tree?fresh=1');
  const eng = tree.departments.find((d) => d.name === 'Engineering');
  const before = await ok('GET', '/api/memory/access/effective/agent-a?project=alpha');
  assert.deepEqual(before.effective.memoryRead, ['owner', 'project', 'experience', 'task', 'people'], 'no rules = unchanged');

  // Company: nobody writes the owner drawer. Engineering: no reading people. Project alpha: people allowed again.
  const { preview } = await accessApply([
    { op: 'set_rule', scope: 'company', drawerKind: 'owner', read: 'inherit', write: 'deny' },
    { op: 'set_rule', scope: `department:${eng.id}`, drawerKind: 'people', read: 'deny', write: 'deny' },
  ]);
  assert.ok(preview.agentsAffected >= 2);
  assert.equal(preview.noProjectAffected, true);
  const run = (project) => P.loadRunPermissions('agent-a', [], { userId: OWNER, project });
  assert.ok(!(await run('alpha')).memoryWrite.includes('owner'));
  assert.ok(!(await run('alpha')).memoryRead.includes('people'));
  assert.ok((await run('beta')).memoryRead.includes('people'), 'other departments keep it');
  assert.ok((await run(null)).memoryRead.includes('people'));
  await accessApply([{ op: 'set_rule', scope: 'project:alpha', drawerKind: 'people', read: 'allow', write: 'inherit' }]);
  assert.ok((await run('alpha')).memoryRead.includes('people'));
  assert.ok(!(await run('alpha')).memoryWrite.includes('people'));

  // Temporary agent exception: agent-a may write the owner drawer until tomorrow.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  const ex = await accessApply([{ op: 'set_rule', scope: 'company', agentId: 'agent-a', drawerKind: 'owner', read: 'inherit', write: 'allow', endsAt: tomorrow, reason: 'migration week' }]);
  assert.equal(ex.preview.agentsAffected, 1);
  assert.ok((await run('alpha')).memoryWrite.includes('owner'));
  assert.ok(!(await P.loadRunPermissions('agent-b', [], { userId: OWNER, project: 'alpha' })).memoryWrite.includes('owner'));
  // Ended exceptions are ignored.
  const later = Date.now() + 2 * 86_400_000;
  assert.ok(!S.narrowPermissions(await P.loadAgentPermissions('agent-a'), await S.accessSnapshot(OWNER), 'alpha', later).memoryWrite.includes('owner'));
  // Why: every layer that decided.
  const why = await ok('GET', '/api/memory/access/effective/agent-a?project=alpha');
  assert.deepEqual(why.kinds.owner.writeWhy.map((w) => `${w.layer}:${w.value}`), ['default:allow', 'company:deny', 'agent-company:allow', 'agent-permissions:allow']);
  assert.deepEqual(why.kinds.people.readWhy.map((w) => `${w.layer}:${w.value}`), ['default:allow', 'department:deny', 'project:allow', 'agent-permissions:allow']);
  assert.equal(why.exceptions.length, 1);

  // The agent's own permissions (CORE-PERMS-01) stay the cap: an exception never widens past them.
  db.prepare(`INSERT INTO agent_permissions (agent_id, memory_read, memory_write, shared_memory, modes, version) VALUES ('agent-a', '["owner","project"]', '["project"]', 0, '{}', 1)`).run();
  const capped = await run('alpha');
  assert.deepEqual(capped.memoryRead, ['owner', 'project']);
  assert.deepEqual(capped.memoryWrite, ['project']);
  // Delegated run: strictest of the chain, as before.
  const delegated = await P.loadRunPermissions('agent-b', ['agent-a'], { userId: OWNER, project: 'alpha' });
  assert.deepEqual(delegated.memoryWrite, ['project']);
  // Sync path (createToolsRegistry) agrees.
  assert.deepEqual(P.loadRunPermissionsSync('agent-a', [], { userId: OWNER, project: 'alpha' }).memoryRead, ['owner', 'project']);
  // Another user's run is not touched by this owner's policies.
  assert.ok((await P.loadRunPermissions('agent-b', [], { userId: 'ms-user', project: 'alpha' })).memoryWrite.includes('owner'));
  db.prepare("DELETE FROM agent_permissions WHERE agent_id = 'agent-a'").run();

  // Role template: assignable to many agents, caps them.
  const tpl = await accessApply([
    { op: 'save_template', name: 'Researcher', memoryRead: ['project', 'experience'], memoryWrite: ['experience'] },
    { op: 'assign_template', template: 'Researcher', agentIds: ['agent-a', 'agent-b'] },
  ]);
  assert.equal(tpl.preview.agentsAffected, 2);
  const b = await P.loadRunPermissions('agent-b', [], { userId: OWNER, project: 'beta' });
  assert.deepEqual(b.memoryRead, ['project', 'experience']);
  assert.deepEqual(b.memoryWrite, ['experience']);
  const overview = await ok('GET', '/api/memory/access');
  assert.equal(overview.templates.find((t) => t.name === 'Researcher').agents, 2);
  await accessApply([{ op: 'assign_template', template: null, agentIds: ['agent-a', 'agent-b'] }]);

  // A stale preview is refused; bad input is a 400.
  const p1 = await ok('POST', '/api/memory/access/preview', { changes: [{ op: 'clear_rule', scope: 'project:alpha', drawerKind: 'people' }] });
  await accessApply([{ op: 'set_rule', scope: 'company', drawerKind: 'task', read: 'inherit', write: 'deny' }]);
  const stale = await call('POST', '/api/memory/access/apply', { changes: [{ op: 'clear_rule', scope: 'project:alpha', drawerKind: 'people' }], expectedPreviewHash: p1.previewHash, confirm: true });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'preview_changed');
  assert.equal((await call('POST', '/api/memory/access/preview', { changes: [{ op: 'set_rule', scope: 'company', drawerKind: 'owner', read: 'maybe' }] })).statusCode, 400);
  assert.equal((await call('POST', '/api/memory/access/preview', { changes: [{ op: 'set_rule', scope: 'company', drawerKind: 'owner', read: 'deny', endsAt: tomorrow }] })).statusCode, 400, 'endsAt is for agent exceptions');
  assert.equal((await call('POST', '/api/memory/access/preview', { changes: [{ op: 'set_rule', scope: 'company', agentId: 'ghost', drawerKind: 'owner', read: 'deny' }] })).statusCode, 404);
  // Audited.
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'memory_access.apply'").get().n >= 5);

  // Moving a project changes inherited access; the preview says who.
  const move = await ok('POST', '/api/memory/scopes/projects/alpha/preview', { action: 'move', departmentId: 'general' });
  assert.ok(move.effects.agentsAffected >= 2);
});

test('explorer: server-side filters, facets and cursor paging', async () => {
  for (let i = 0; i < 25; i++) await save(`explorer item ${String(i).padStart(2, '0')} ${i % 2 ? 'odd' : 'even'}`, project('explore'));
  db.prepare("UPDATE memories SET type = 'event' WHERE drawer_key = 'explore' AND content LIKE '%odd%'").run();
  const seen = [];
  let cursor = '';
  for (;;) {
    const page = await ok('GET', `/api/memory/scopes/memories?scope=project:explore&limit=10${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(page.total, 25);
    seen.push(...page.items.map((i) => i.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25);
  const odd = await ok('GET', '/api/memory/scopes/memories?scope=project:explore&type=event');
  assert.equal(odd.total, 12);
  assert.deepEqual(odd.facets.type, { fact: 13, event: 12 });
  const q = await ok('GET', '/api/memory/scopes/memories?scope=project:explore&q=item%2007');
  assert.equal(q.total, 1);
  const eng = (await ok('GET', '/api/memory/scopes/tree?fresh=1')).departments.find((d) => d.name === 'Engineering');
  const dept = await ok('GET', `/api/memory/scopes/memories?scope=department:${eng.id}`);
  assert.ok(dept.items.every((i) => i.drawerId === 'project:alpha'));
  assert.equal((await call('GET', '/api/memory/scopes/memories?scope=project:explore&cursor=bad')).statusCode, 400);
});

test('agent tools: same actions and owner gates; changes need the preview hash', async () => {
  assert.ok(['memory_scopes', 'memory_scope_apply', 'memory_access_apply', 'memory_scope_forget'].every((t) => DEFAULT_AGENT_TOOLS.includes(t)));
  assert.equal(APPROVAL_REQUIRED_TOOLS.memory_scope_apply, 'settings');
  assert.equal(APPROVAL_REQUIRED_TOOLS.memory_access_apply, 'settings');
  assert.equal(APPROVAL_REQUIRED_TOOLS.memory_scope_forget, 'delete');
  const ctx = { workspaceDir: dir, userId: OWNER, agentId: 'agent-a', memoryDrawers: [{ kind: 'owner' }, project('alpha')] };

  const tree = await quietly(() => T.memoryScopesTool.execute({ action: 'tree' }, ctx));
  assert.ok(tree.data.success, tree.error);
  assert.ok((await T.memoryScopesTool.execute({ action: 'tree' }, { ...ctx, userId: 'ms-user' })).error);
  assert.ok((await T.memoryScopesTool.execute({ action: 'tree' }, { ...ctx, toolPolicy: { channel: 'telegram' } })).error);
  // Memory text only from drawers open for the run.
  assert.ok((await T.memoryScopesTool.execute({ action: 'memories', scope: 'project:beta' }, ctx)).error);
  assert.ok((await T.memoryScopesTool.execute({ action: 'memories', scope: 'project:alpha' }, ctx)).data.success);

  const pv = await T.memoryScopesTool.execute({ action: 'preview_project', project: 'beta', project_action: 'pin' }, ctx);
  assert.ok(pv.data.previewHash);
  assert.ok((await T.memoryScopeApplyTool.execute({ action: 'project', project: 'beta', project_action: 'pin', preview_hash: 'wrong' }, ctx)).error);
  const pinned = await T.memoryScopeApplyTool.execute({ action: 'project', project: 'beta', project_action: 'pin', preview_hash: pv.data.previewHash }, ctx);
  assert.ok(pinned.data.success, pinned.error);
  assert.equal((await S.getProject(OWNER, 'beta')).pinned, true);
  assert.ok((await T.memoryScopeApplyTool.execute({ action: 'project', project: 'beta', project_action: 'forget', preview_hash: 'x' }, ctx)).error, 'forget has its own tool');

  const changes = [{ op: 'set_rule', scope: 'project:beta', drawerKind: 'task', read: 'deny', write: 'deny' }];
  const ap = await T.memoryScopesTool.execute({ action: 'preview_access', changes }, ctx);
  const applied = await T.memoryAccessApplyTool.execute({ changes, preview_hash: ap.data.previewHash }, ctx);
  assert.ok(applied.data.success, applied.error);
  assert.ok(!(await P.loadRunPermissions('agent-b', [], { userId: OWNER, project: 'beta' })).memoryRead.includes('task'));

  const fact = await T.memoryScopeApplyTool.execute({ action: 'pinned_add', scope: 'company', text: 'Added by an agent with approval.' }, ctx);
  assert.ok(fact.data.success, fact.error);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'memory_scope.pinned_add' AND metadata LIKE '%agent_tool%'").get().n >= 1);
});

test('scale: 100 projects in 10 departments, 3,000 agents: tree, scope switch and access preview', async (t) => {
  const OWNER2 = 'ms-big';
  addUser(OWNER2, 'owner');
  const big = userActor({ id: OWNER2, role: 'owner' });
  const insertDept = db.prepare('INSERT INTO memory_departments (id, owner_id, name, norm_name) VALUES (?, ?, ?, ?)');
  const insertScope = db.prepare('INSERT INTO memory_project_scopes (owner_id, slug, department_id) VALUES (?, ?, ?)');
  const insertMem = db.prepare(`INSERT INTO memories (id, user_id, type, content, created_at, drawer_kind, drawer_key, memory_layer, importance_score)
    VALUES (?, ?, 'fact', ?, ?, 'project', ?, 'factual', 0.5)`);
  const insertAgent = db.prepare('INSERT INTO agents_config (id, name) VALUES (?, ?)');
  const insertPerm = db.prepare(`INSERT INTO agent_permissions (agent_id, memory_read, memory_write, shared_memory, modes, version) VALUES (?, ?, ?, 0, '{}', 1)`);
  db.exec('BEGIN');
  {
    for (let d = 0; d < 10; d++) insertDept.run(`d${d}`, OWNER2, `Dept ${d}`, `dept ${d}`);
    for (let p = 0; p < 100; p++) {
      insertScope.run(OWNER2, `proj-${p}`, `d${p % 10}`);
      for (let m = 0; m < 30; m++) insertMem.run(`big-${p}-${m}`, OWNER2, `project ${p} memory ${m}`, new Date(Date.UTC(2026, 9, 1, 0, p, m)).toISOString(), `proj-${p}`);
    }
    for (let a = 0; a < 3000; a++) {
      insertAgent.run(`emp-${a}`, `Employee ${a}`);
      // Every 10th employee may not read project drawers at all (CORE-PERMS-01 row).
      if (a % 10 === 0) insertPerm.run(`emp-${a}`, '["owner","experience"]', '["experience"]');
    }
  }
  db.exec('COMMIT');
  const agentsTotal = db.prepare('SELECT COUNT(*) AS n FROM agents_config').get().n;
  const fixedCapped = 300 + (db.prepare("SELECT COUNT(*) AS n FROM agent_permissions WHERE agent_id NOT LIKE 'emp-%' AND memory_read NOT LIKE '%project%'").get().n);

  const time = async (fn) => { const t = performance.now(); const r = await fn(); return { r, ms: performance.now() - t }; };
  const tree = await time(() => S.scopeTree(OWNER2, { fresh: true }));
  assert.equal(tree.r.company.projects, 100);
  assert.equal(tree.r.company.memories, 3000);
  assert.equal(tree.r.departments.length, 11);
  assert.equal(tree.r.departments.find((d) => d.id === 'd3').projects, 10);
  assert.equal(tree.r.departments.find((d) => d.id === 'd3').memories, 300);
  assert.ok(tree.ms < 300, `tree took ${tree.ms.toFixed(0)} ms`);

  // Scope switch: one department, one project page, one search.
  const sw = await time(async () => {
    await S.exploreScope(OWNER2, { scope: 'department:d4', limit: 50 });
    await S.exploreScope(OWNER2, { scope: 'project:proj-42', limit: 50 });
    return S.searchScopes(OWNER2, 'proj-4');
  });
  assert.ok(sw.ms < 300, `scope switch took ${sw.ms.toFixed(0)} ms`);
  assert.equal(sw.r.filter((h) => h.kind === 'project').length, 11);
  const agents = await time(() => S.listAgentScopes(OWNER2, { q: 'Employee 299', limit: 100 }));
  assert.ok(agents.ms < 300, `agent page took ${agents.ms.toFixed(0)} ms`);
  assert.equal(agents.r.agents.length, 11);

  // Preview counts: department d2 may not read project drawers.
  const changes = [{ op: 'set_rule', scope: 'department:d2', drawerKind: 'project', read: 'deny', write: 'deny' }];
  const pv = await time(() => S.previewAccessChanges(OWNER2, changes, OWNER2));
  assert.equal(pv.r.agentsTotal, agentsTotal);
  assert.equal(pv.r.projectsTotal, 100);
  assert.equal(pv.r.agentsAffected, agentsTotal - fixedCapped, 'agents that could read project drawers');
  assert.equal(pv.r.projectsAffected, 10);
  assert.equal(pv.r.noProjectAffected, false);
  assert.equal(pv.r.pairsChanged, (agentsTotal - fixedCapped) * 10);
  assert.equal(pv.r.narrowed, pv.r.pairsChanged);
  assert.equal(pv.r.widened, 0);
  assert.ok(pv.ms < 1000, `access preview took ${pv.ms.toFixed(0)} ms`);
  t.diagnostic(`tree ${tree.ms.toFixed(1)} ms, scope switch ${sw.ms.toFixed(1)} ms, agent page ${agents.ms.toFixed(1)} ms, access preview ${pv.ms.toFixed(1)} ms`);
  const applied = await S.applyAccessChanges(OWNER2, changes, pv.r.previewHash, OWNER2);
  assert.equal(applied.version, 1);
  // A template on 1,000 agents: preview counts only those whose access really changes.
  const ids = Array.from({ length: 1000 }, (_, i) => `emp-${i}`);
  const tpl = await S.previewAccessChanges(OWNER2, [
    { op: 'save_template', name: 'Support', memoryRead: ['owner', 'project', 'experience'], memoryWrite: ['experience'] },
    { op: 'assign_template', template: 'Support', agentIds: ids },
  ], OWNER2);
  // Every one of them loses task/people reading, except the 100 whose own permissions are already narrower.
  assert.equal(tpl.agentsAffected, 900);
  assert.equal(tpl.projectsAffected, 100);

  // Switching scope in a reply: an archived project of 30 memories never comes back.
  await S.applyProjectAction(OWNER2, 'proj-7', { action: 'archive', target: null, departmentId: null },
    (await S.previewProjectAction(OWNER2, 'proj-7', { action: 'archive', target: null, departmentId: null })).previewHash, OWNER2);
  const res = await quietly(() => memoryRecall.search(big, { query: 'project 7 memory', limit: 50 }));
  assert.ok(res.length > 0);
  assert.ok(res.every((r) => r.memory.drawer.key !== 'proj-7'));
});
