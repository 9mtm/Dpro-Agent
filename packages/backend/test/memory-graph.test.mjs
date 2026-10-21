// CORE-MEM-GRAPH: memory knowledge graph. Entities + typed links are built on
// every memory save (local model, deterministic fallback); recall follows
// links from the names in a request; drawers apply at every step; forgetting
// leaves no link; important new links wait for the owner; owner-only API and
// a read-only agent tool.
// Run: node --import tsx --test test/memory-graph.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network (fetch refused
// unless a test stubs the local model).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-memgraph-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
delete process.env.MEMORY_GRAPH_MODEL;

const realFetch = globalThis.fetch;
const refuse = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
globalThis.fetch = refuse;

const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('gr-owner', 'owner');
addUser('gr-user', 'user');

const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { memoryRoutes } = await import(join(backendDir, 'src/api/routes/memory.ts'));
const { memoryGraphRoutes } = await import(join(backendDir, 'src/api/routes/memory-graph.ts'));
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
const { forgetMemory } = await import(join(backendDir, 'src/memory/forget.ts'));
const G = await import(join(backendDir, 'src/memory/graph/index.ts'));
const { memorySearchTool } = await import(join(backendDir, 'src/tools/memory/search.ts'));
const { memorySaveTool } = await import(join(backendDir, 'src/tools/memory/save.ts'));
const { memoryGraphTool } = await import(join(backendDir, 'src/tools/memory/graph.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');

const app = Fastify();
registerAuthGate(app);
await app.register(memoryRoutes);
await app.register(memoryGraphRoutes);
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
const call = (method, url, who = 'gr-owner', payload) => quietly(() => app.inject({ method, url, headers: auth(who), payload }));
const create = async (content, drawer, who = 'gr-owner') => {
  const res = await call('POST', '/api/memory', who, { type: 'fact', content, importance: 7, ...(drawer ? { drawer } : {}) });
  assert.equal(res.statusCode, 200, res.body);
  await G.graphIdle();
  return res.json().memory;
};
const drawers = (...ids) => ids.map((id) => { const i = id.indexOf(':'); return i < 0 ? { kind: id } : { kind: id.slice(0, i), key: id.slice(i + 1) }; });
const ctx = (...ids) => ({ workspaceDir: dir, userId: 'gr-owner', memoryDrawers: drawers(...ids) });
const searchIds = async (query, context) => {
  const r = await quietly(() => memorySearchTool.execute({ query, limit: 10 }, context));
  return (r.data?.memories || []).map((m) => m.id);
};
const graphRows = (memoryId) => ({
  mentions: db.prepare('SELECT COUNT(*) AS n FROM memory_graph_mentions WHERE memory_id = ?').get(memoryId).n,
  sources: db.prepare('SELECT COUNT(*) AS n FROM memory_graph_link_sources WHERE memory_id = ?').get(memoryId).n,
  state: db.prepare('SELECT COUNT(*) AS n FROM memory_graph_state WHERE memory_id = ?').get(memoryId).n,
});
const linkBetween = (from, type, to) => db.prepare(`
  SELECT l.* FROM memory_graph_links l JOIN memory_graph_entities a ON a.id = l.src_id JOIN memory_graph_entities b ON b.id = l.dst_id
   WHERE l.user_id = 'gr-owner' AND a.name = ? AND l.type = ? AND b.name = ?`).get(from, type, to);

const SARA_QUESTION = 'What is Sara Lindqvist busy with these days?';
let worksOn, falconFact, heronLink, heronFact;

test('setup: saves build entities, links and attachments (deterministic fallback, no model)', async () => {
  worksOn = await create('Sara Lindqvist works on Project Falcon.', { kind: 'project', key: 'falcon' });
  falconFact = await create('Project Falcon ships the mobile beta in March.', { kind: 'project', key: 'falcon' });
  heronLink = await create('Sara Lindqvist works on Project Heron.', { kind: 'project', key: 'heron' });
  heronFact = await create('Project Heron demo runs on Thursday afternoon.', { kind: 'owner' });

  const sara = db.prepare(`SELECT * FROM memory_graph_entities WHERE user_id = 'gr-owner' AND name = 'Sara Lindqvist'`).get();
  assert.equal(sara.kind, 'person');
  const falcon = db.prepare(`SELECT * FROM memory_graph_entities WHERE user_id = 'gr-owner' AND name = 'Project Falcon'`).get();
  assert.equal(falcon.kind, 'project');
  assert.ok(JSON.parse(falcon.aliases).includes(G.normalizeName('falcon')), 'the project drawer key is an alias');
  const link = linkBetween('Sara Lindqvist', 'works_on', 'Project Falcon');
  assert.equal(link?.status, 'active', 'works_on from an owner-written memory is active');
  assert.equal(graphRows(falconFact.id).mentions, 1);
  assert.equal(db.prepare('SELECT method FROM memory_graph_state WHERE memory_id = ?').get(worksOn.id).method, 'fallback');
});

test('a question naming a person returns that person\'s project facts via links, with no shared words', async () => {
  // Plain keyword + meaning search does not find the project fact.
  const plain = await quietly(() => getMemoryStorage().search({ query: SARA_QUESTION, userId: 'gr-owner', drawers: drawers('project:falcon'), limit: 10 }));
  assert.ok(!plain.some((r) => r.memory.id === falconFact.id), 'no shared words with the plain search');
  // The chat path (memory_search tool) follows Sara -> works_on -> Project Falcon.
  const ids = await searchIds(SARA_QUESTION, ctx('owner', 'experience', 'project:falcon'));
  assert.ok(ids.includes(worksOn.id));
  assert.ok(ids.includes(falconFact.id), 'the project fact comes through the link');
  // Same through the account route.
  const res = await call('GET', `/api/memory/relevant?query=${encodeURIComponent(SARA_QUESTION)}&limit=10&project=falcon`);
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(res.json().memories.some((m) => m.id === falconFact.id));
  const noProject = await call('GET', `/api/memory/relevant?query=${encodeURIComponent(SARA_QUESTION)}&limit=10`);
  assert.ok(!noProject.json().memories.some((m) => m.id === falconFact.id), 'project drawer not asked for: not loaded');
});

test('another project\'s drawer is never loaded, and its links do not steer recall', async () => {
  const falconTurn = await searchIds(SARA_QUESTION, ctx('owner', 'project:falcon'));
  assert.ok(!falconTurn.includes(heronLink.id), 'heron drawer memory not loaded');
  // Heron's demo (owner drawer) is reachable only through a link learned in the heron drawer.
  assert.ok(!falconTurn.includes(heronFact.id), 'a link from a closed drawer is not followed');
  const heronTurn = await searchIds(SARA_QUESTION, ctx('owner', 'project:heron'));
  assert.ok(heronTurn.includes(heronFact.id), 'with the heron drawer open the link is followed');
  assert.ok(!heronTurn.includes(falconFact.id), 'falcon drawer not loaded in a heron turn');
  // No drawers at all: nothing.
  assert.deepEqual(await G.graphRecall({ userId: 'gr-owner', drawers: [] }, SARA_QUESTION), []);
  // Another user never reaches this graph.
  assert.deepEqual(await G.graphRecall({ userId: 'gr-user' }, SARA_QUESTION), []);
});

test('two links away: Sara -> Falcon -> Billing API facts', async () => {
  const dep = await create('Project Falcon depends on the Billing Gateway.', { kind: 'project', key: 'falcon' });
  const gw = await create('Billing Gateway runs on port 8443.', { kind: 'owner' });
  const ids = await searchIds(SARA_QUESTION, ctx('owner', 'project:falcon'));
  assert.ok(ids.includes(dep.id));
  assert.ok(ids.includes(gw.id), 'second hop reached');
  const hits = await G.graphRecall({ userId: 'gr-owner', drawers: drawers('owner', 'project:falcon') }, SARA_QUESTION);
  const score = (id) => hits.find((h) => h.memory.id === id)?.similarity ?? 0;
  assert.ok(score(worksOn.id) > score(falconFact.id) && score(falconFact.id) > score(gw.id), 'closer entities score higher');
});

test('forgetting a memory leaves no attachment and no orphan link', async () => {
  const temp = await create('Omar Haddad works on Project Kestrel.', { kind: 'project', key: 'kestrel' });
  assert.ok(linkBetween('Omar Haddad', 'works_on', 'Project Kestrel'));
  const r = await quietly(() => forgetMemory('gr-owner', temp.id, 'gr-owner'));
  assert.ok(r);
  assert.deepEqual(graphRows(temp.id), { mentions: 0, sources: 0, state: 0 });
  assert.equal(linkBetween('Omar Haddad', 'works_on', 'Project Kestrel'), undefined, 'orphan link removed');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memory_graph_entities WHERE user_id = 'gr-owner' AND name IN ('Omar Haddad', 'Project Kestrel')`).get().n, 0, 'orphan entities removed');

  // Forget the memory that taught Sara -> Falcon: the link goes, Sara stays (heron memory names her).
  await quietly(() => forgetMemory('gr-owner', worksOn.id, 'gr-owner'));
  assert.deepEqual(graphRows(worksOn.id), { mentions: 0, sources: 0, state: 0 });
  assert.equal(linkBetween('Sara Lindqvist', 'works_on', 'Project Falcon'), undefined);
  assert.ok(db.prepare(`SELECT 1 FROM memory_graph_entities WHERE user_id = 'gr-owner' AND name = 'Sara Lindqvist'`).get());
  const ids = await searchIds(SARA_QUESTION, ctx('project:falcon'));
  assert.ok(!ids.includes(falconFact.id), 'no link left to reach the project fact');
  // No graph table mentions the forgotten ids.
  for (const t of ['memory_graph_mentions', 'memory_graph_link_sources', 'memory_graph_state']) {
    assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()).includes(worksOn.id), t);
  }
});

test('a plain delete and an edit keep the graph in step (prune + re-index)', async () => {
  const m = await create('Lina Saleh works on Project Osprey.', { kind: 'project', key: 'osprey' });
  assert.ok(linkBetween('Lina Saleh', 'works_on', 'Project Osprey'));
  const edit = await call('PUT', `/api/memory/${m.id}`, 'gr-owner', { content: 'Lina Saleh works on Project Condor.' });
  assert.equal(edit.statusCode, 200, edit.body);
  await G.graphIdle();
  assert.equal(linkBetween('Lina Saleh', 'works_on', 'Project Osprey'), undefined, 'the old link went with the old text');
  assert.ok(linkBetween('Lina Saleh', 'works_on', 'Project Condor'));
  const del = await call('DELETE', `/api/memory/${m.id}`);
  assert.equal(del.statusCode, 200, del.body);
  await G.graphIdle();
  const sync = await G.syncMemoryGraph('gr-owner');
  assert.ok(sync.pruned.links >= 1);
  assert.equal(linkBetween('Lina Saleh', 'works_on', 'Project Condor'), undefined);
});

let pendingId, portFact;

test('an important new link from an agent-learned memory waits for the owner', async () => {
  const agentCtx = { workspaceDir: dir, userId: 'gr-owner', agentId: 'gr-agent', memoryDrawers: drawers('owner', 'project:falcon') };
  const saved = await quietly(() => memorySaveTool.execute({ content: 'The Ledger Service replaces the Legacy Router.', type: 'fact', importance: 5, drawer: 'project:falcon' }, agentCtx));
  assert.ok(!saved.error, saved.error);
  await G.graphIdle();
  const link = linkBetween('The Ledger Service', 'replaces', 'the Legacy Router') ?? linkBetween('Ledger Service', 'replaces', 'Legacy Router');
  assert.ok(link, JSON.stringify(db.prepare('SELECT name FROM memory_graph_entities').all()));
  assert.equal(link.status, 'pending');
  pendingId = link.id;
  portFact = await create('Legacy Router keeps port 9000 open for audits.', { kind: 'project', key: 'falcon' });
  const ledger = await create('Ledger Service stores invoices for seven years.', { kind: 'project', key: 'falcon' });

  // Recall does not follow the pending link.
  const before = await G.graphRecall({ userId: 'gr-owner', drawers: drawers('project:falcon') }, 'Tell me about the Ledger Service');
  assert.ok(before.some((h) => h.memory.id === ledger.id));
  assert.ok(!before.some((h) => h.memory.id === portFact.id));

  // Owner review: listed as pending; a member account cannot see or decide it.
  assert.equal((await call('GET', '/api/memory/graph/links?status=pending', 'gr-user')).statusCode, 403);
  assert.equal((await call('POST', `/api/memory/graph/links/${pendingId}/approve`, 'gr-user')).statusCode, 403);
  const pending = (await call('GET', '/api/memory/graph/links?status=pending')).json().links;
  assert.deepEqual(pending.map((l) => l.id), [pendingId]);
  const ok = await call('POST', `/api/memory/graph/links/${pendingId}/approve`);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().link.status, 'active');
  assert.equal((await call('POST', `/api/memory/graph/links/${pendingId}/approve`)).statusCode, 404, 'decided once');
  const after = await G.graphRecall({ userId: 'gr-owner', drawers: drawers('project:falcon') }, 'Tell me about the Ledger Service');
  assert.ok(after.some((h) => h.memory.id === portFact.id), 'approved link is followed');
});

test('only the owner\'s own write or an approved proposal counts as reviewed; metadata is not trusted', async () => {
  // A derived save (no version row) claiming an owner source still waits for review.
  const forged = { id: 'gr-forged', userId: 'gr-owner', type: 'fact', content: 'Quartz Engine replaces Basalt Engine.', importance: 5, importanceScore: 0.5,
    metadata: { source: 'owner', proposalId: 'fake' }, createdAt: new Date(), drawer: { kind: 'owner' } };
  await quietly(() => getMemoryStorage().save(forged));
  await G.graphIdle();
  assert.equal(linkBetween('Quartz Engine', 'replaces', 'Basalt Engine')?.status, 'pending');
  // A row whose newest version is an older owner text (version not written yet) is not reviewed.
  const owned = await create('Cobalt Engine powers the lab.', { kind: 'owner' });
  db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('Iron Engine replaces Copper Engine.', owned.id);
  await G.indexMemoryGraph(await getMemoryStorage().getOwned('gr-owner', owned.id));
  assert.equal(linkBetween('Iron Engine', 'replaces', 'Copper Engine')?.status, 'pending');
  // The owner's own direct write of an important link is active at once.
  await create('Granite Engine replaces Slate Engine.', { kind: 'owner' });
  assert.equal(linkBetween('Granite Engine', 'replaces', 'Slate Engine')?.status, 'active');
});

test('a member account\'s important new link is not stored', async () => {
  const res = await call('POST', '/api/memory', 'gr-user', { type: 'fact', content: 'Nadia Karim works on Project Wren.' });
  assert.equal(res.statusCode, 200, res.body);
  await G.graphIdle();
  assert.ok(db.prepare(`SELECT 1 FROM memory_graph_entities WHERE user_id = 'gr-user' AND name = 'Nadia Karim'`).get(), 'per-user graph');
  const ex = G.fallbackExtraction('The Ledger Service replaces the Legacy Router.');
  const m = { id: 'gr-user-mem', userId: 'gr-user', content: 'The Ledger Service replaces the Legacy Router.', type: 'fact', metadata: { source: 'agent', learned: 'routine' }, drawer: { kind: 'owner' } };
  db.prepare(`INSERT INTO memories (id, user_id, type, content, created_at) VALUES (?, 'gr-user', 'fact', ?, ?)`).run(m.id, m.content, new Date().toISOString());
  const { sql } = await import(join(backendDir, 'src/repositories/sql-steps.ts'));
  const { writeMemoryGraphStep, contentHash } = await import(join(backendDir, 'src/memory/graph/store.ts'));
  const r = await sql().tx(() => writeMemoryGraphStep(m, contentHash(m.content), ex, false));
  assert.equal(r.links, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memory_graph_links WHERE user_id = 'gr-user' AND type = 'replaces'`).get().n, 0);
});

test('owner-only read API: entities, entity timeline, drawer filter', async () => {
  assert.equal((await call('GET', '/api/memory/graph/entities', 'gr-user')).statusCode, 403);
  const list = await call('GET', '/api/memory/graph/entities');
  assert.equal(list.statusCode, 200, list.body);
  const sara = list.json().entities.find((e) => e.name === 'Sara Lindqvist');
  assert.ok(sara && sara.kind === 'person');
  const falconOnly = (await call('GET', '/api/memory/graph/entities?drawers=project:falcon')).json().entities;
  assert.ok(!falconOnly.some((e) => e.name === 'Project Heron'), 'drawer filter applies to entities');
  assert.equal((await call('GET', '/api/memory/graph/entities?drawers=bad:/x')).statusCode, 400);

  const falcon = list.json().entities.find((e) => e.name === 'Project Falcon');
  const detail = await call('GET', `/api/memory/graph/entities/${falcon.id}`);
  assert.equal(detail.statusCode, 200, detail.body);
  const times = detail.json().timeline.map((t) => t.createdAt);
  assert.deepEqual(times, [...times].sort(), 'timeline oldest first');
  assert.ok(detail.json().timeline.some((t) => t.memoryId === falconFact.id && t.drawer === 'project:falcon'));
  assert.ok(detail.json().links.some((l) => l.type === 'depends_on'));
  assert.equal((await call('GET', '/api/memory/graph/entities/nope')).statusCode, 404);
  assert.equal((await call('GET', `/api/memory/graph/entities/${falcon.id}`, 'gr-user')).statusCode, 403);
  const sync = await call('POST', '/api/memory/graph/sync', 'gr-owner', {});
  assert.equal(sync.statusCode, 200, sync.body);
});

test('memory_graph tool: owner runs only, open drawers only, never for an outsider', async () => {
  const run = (params, context) => quietly(() => memoryGraphTool.execute(params, context));
  const related = await run({ op: 'related', query: 'Who is Sara Lindqvist?' }, ctx('owner', 'project:heron'));
  assert.ok(!related.error, related.error);
  const ids = related.data.memories.map((m) => m.id);
  assert.ok(ids.includes(heronFact.id) && ids.includes(heronLink.id));
  assert.ok(!ids.includes(falconFact.id), 'falcon drawer closed');

  const ent = await run({ op: 'entity', name: 'Project Falcon' }, ctx('project:falcon'));
  assert.ok(!ent.error, ent.error);
  assert.ok(ent.data.timeline.some((t) => t.memoryId === falconFact.id));
  assert.ok((await run({ op: 'entity', name: 'Project Falcon' }, ctx('project:heron'))).error, 'not visible from another drawer');
  const ents = await run({ op: 'entities' }, ctx('project:heron'));
  assert.ok(!ents.data.entities.some((e) => e.name === 'Billing Gateway'));

  const outsider = { workspaceDir: dir, userId: 'gr-owner', toolPolicy: { channel: 'telegram', allowedTools: new Set(['memory_graph']) } };
  assert.ok((await run({ op: 'entities' }, outsider)).error);
  assert.ok((await run({ op: 'entities' }, { workspaceDir: dir, userId: 'gr-user', memoryDrawers: drawers('owner') })).error, 'member account run refused');
  assert.ok((await run({ op: 'entities' }, { workspaceDir: dir })).error, 'no user');
  assert.ok((await run({ op: 'nope' }, ctx('owner'))).error);
});

test('local model path: JSON from the model is used, invented names dropped; bad answers fall back', async () => {
  const answer = JSON.stringify({
    entities: [
      { name: 'Rami Aziz', kind: 'person' }, { name: 'Atlas Board', kind: 'project', aliases: ['Atlas'] },
      { name: 'Invented Person', kind: 'person' }, { name: 'X', kind: 'spaceship' },
    ],
    links: [{ from: 'Rami Aziz', type: 'works_on', to: 'Atlas' }, { from: 'Rami Aziz', type: 'flies', to: 'Atlas Board' }, { from: 'Invented Person', type: 'works_on', to: 'Atlas Board' }],
  });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b', details: { family: 'qwen3' } }] }), { status: 200 });
    if (u.endsWith('/api/generate')) {
      assert.ok(JSON.parse(init.body).prompt.includes('Rami Aziz'));
      return new Response(JSON.stringify({ response: '```json\n' + answer + '\n```' }), { status: 200 });
    }
    throw new Error(`unexpected network call in test: ${u}`);
  };
  try {
    const ex = await G.extractGraph('Rami Aziz leads the Atlas Board rollout.', { userId: 'gr-owner' });
    assert.equal(ex.method, 'model');
    assert.deepEqual(ex.entities.map((e) => e.name).sort(), ['Atlas Board', 'Rami Aziz']);
    assert.deepEqual(ex.links, [{ from: 'Rami Aziz', type: 'works_on', to: 'Atlas Board' }]);
    assert.ok(calls.some((u) => u.endsWith('/api/generate')));

    globalThis.fetch = async (url) => String(url).endsWith('/api/generate')
      ? new Response(JSON.stringify({ response: 'not json at all' }), { status: 200 })
      : new Response(JSON.stringify({ models: [] }), { status: 200 });
    const fb = await G.extractGraph('Rami Aziz works on Project Atlas.', { userId: 'gr-owner' });
    assert.equal(fb.method, 'fallback');
    assert.deepEqual(fb.links, [{ from: 'Rami Aziz', type: 'works_on', to: 'Project Atlas' }]);
  } finally {
    globalThis.fetch = refuse;
  }
});

test('fallback rules: owner words, Arabic, German, drawer project, times are not places', () => {
  const a = G.fallbackExtraction('The user prefers dark mode in every editor.');
  assert.deepEqual(a.links, [{ from: G.OWNER_ENTITY, type: 'prefers', to: 'dark mode' }]);
  const ar = G.fallbackExtraction('سارة تعمل على مشروع الصقر');
  assert.equal(ar.links[0]?.type, 'works_on');
  const de = G.fallbackExtraction('Jonas arbeitet an Projekt Adler.');
  assert.equal(de.links[0]?.type, 'works_on');
  const d = G.fallbackExtraction('Ships in March from Lisbon.', { kind: 'project', key: 'falcon' });
  assert.ok(d.entities.some((e) => e.name === 'falcon' && e.kind === 'project'));
  assert.ok(!d.entities.some((e) => e.name === 'March'));
  assert.equal(d.entities.find((e) => e.name === 'Lisbon')?.kind, 'place');
  assert.deepEqual(G.sanitizeExtraction('nothing here', { entities: [{ name: 'Ghost', kind: 'person' }], links: [] }, 'model').entities, []);
});
