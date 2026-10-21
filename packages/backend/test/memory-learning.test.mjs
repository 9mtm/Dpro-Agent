// CORE-05: mixed learning approval (routine saved, important -> proposal),
// versioning of every API/tool change, weekly summary.
// Run: node --import tsx --test test/memory-learning.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network: the local model
// (Ollama extraction) is stubbed through fetch; the summary model is a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-memlearn-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
delete process.env.MEMORY_SUMMARY_MODEL;
delete process.env.OUTSIDER_AGENT_MEMORY;

// The extraction model is stubbed: only the local Ollama generate URL answers.
let extraction = [];
const outbound = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  outbound.push(String(url));
  if (String(url).startsWith('http://127.0.0.1:11434/api/generate')) {
    return new Response(JSON.stringify({ response: JSON.stringify(extraction) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected network call in test: ${url}`);
};

const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('ml-owner', 'owner');
addUser('ml-user', 'user');
db.prepare('UPDATE agents_config SET is_primary = 0').run();
db.prepare(`INSERT INTO agents_config (id, name, is_primary) VALUES ('ml-agent', 'Ml Agent', 1)`).run();

const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { memoryRoutes } = await import(join(backendDir, 'src/api/routes/memory.ts'));
const { memoryFilesRoutes } = await import(join(backendDir, 'src/api/routes/memory-files.ts'));
const { memoryLearningRoutes } = await import(join(backendDir, 'src/api/routes/memory-learning.ts'));
const L = await import(join(backendDir, 'src/memory/learning.ts'));
const W = await import(join(backendDir, 'src/memory/weekly-summary.ts'));
const J = await import(join(backendDir, 'src/memory/jobs.ts'));
const D = await import(join(backendDir, 'src/memory/drawers.ts'));
const { memorySaveTool } = await import(join(backendDir, 'src/tools/memory/save.ts'));
const { memoryEditTool, memoryDeleteTool } = await import(join(backendDir, 'src/tools/memory/edit.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');

const app = Fastify();
registerAuthGate(app);
await app.register(memoryRoutes);
await app.register(memoryFilesRoutes);
await app.register(memoryLearningRoutes);
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
const call = (method, url, who = 'ml-owner', payload) => quietly(() => app.inject({ method, url, headers: auth(who), payload }));

// UI-IP-04: approve/reject send back the reviewHash of the proposal as reviewed.
const reviewHashOf = async (id, who = 'ml-owner') => { const r = await call('GET', `/api/memory/proposals/${id}`, who); return r.statusCode === 200 ? r.json().reviewHash : undefined; };
const decide = async (id, action, who = 'ml-owner', payload = {}) => call('POST', `/api/memory/proposals/${id}/${action}`, who, { expectedReviewHash: await reviewHashOf(id, who), ...payload });
const mem = (id) => db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
const memByContent = (content, userId = 'ml-owner') => db.prepare('SELECT * FROM memories WHERE content = ? AND user_id = ?').get(content, userId);
const versions = (id) => db.prepare('SELECT version, change, content, created_by, reason FROM memory_versions WHERE memory_id = ? ORDER BY version').all(id).map((r) => ({ ...r }));
const run = (tool, params, ctx) => quietly(() => tool.execute(params, ctx));
const ownerCtx = { workspaceDir: dir, userId: 'ml-owner', agentId: 'ml-agent', memoryDrawers: D.selectDrawers({ audience: 'owner', project: 'alpha' }) };

test('classifyLearning: routine vs important rules (pure)', () => {
  const c = (content, extra = {}) => L.classifyLearning({ content, origin: 'agent', ...extra });
  assert.equal(c('The deploy script is scripts/deploy.sh').kind, 'routine');
  assert.equal(c('Release notes are written on Fridays', { drawer: { kind: 'project', key: 'alpha' } }).kind, 'routine');
  const cases = [
    ['User prefers short answers', { type: 'preference' }, 'owner-preference'],
    ['My name is Mohamed', {}, 'owner-identity'],
    ['اسمي محمد وعمري ٣٥', {}, 'owner-identity'],
    ['Ali handles the supplier calls', { drawer: { kind: 'people', key: 'ali' } }, 'people'],
    ['Sara is his sister', { type: 'relationship' }, 'people'],
    ['The monthly salary is paid on the 25th', {}, 'money'],
    ['الراتب ينزل يوم ٢٥', {}, 'money'],
    ['Die Rechnung kommt per Post', {}, 'money'],
    ['The router password is on the sticker', {}, 'credentials'],
    ['Has a doctor appointment next week', {}, 'health'],
    ['The contract with the landlord ends in May', {}, 'legal'],
    ['Give the intern admin rights on the server', {}, 'permissions'],
    ['From now on deploy only after tests pass', {}, 'decision'],
    ['قررت نوقف المشروع القديم', {}, 'decision'],
    ['Maybe likes jazz', { confidence: 0.3 }, 'low-confidence'],
    ['The deploy script is in scripts', { origin: 'outsider' }, 'outsider'],
    ['GitHub token saved', { credentialRef: true }, 'credentials'],
  ];
  for (const [content, extra, reason] of cases) {
    const r = c(content, extra);
    assert.equal(r.kind, 'important', content);
    assert.ok(r.reasons.includes(reason), `${content}: ${r.reasons}`);
  }
  // Contradiction vs refinement vs duplicate (neighbours come from search).
  const near = [{ id: 'm1', content: 'Coffee machine is on floor two', similarity: 0.85 }];
  assert.equal(L.classifyLearning({ content: 'Coffee machine is on floor three', origin: 'agent' }, { similar: near }).kind, 'important');
  assert.deepEqual(L.classifyLearning({ content: 'Coffee machine is on floor three', origin: 'agent' }, { similar: near }).conflictsWith, ['m1']);
  assert.equal(L.classifyLearning({ content: 'Coffee machine is on floor two near the lift', origin: 'agent' }, { similar: near }).kind, 'routine');
  assert.equal(L.classifyLearning({ content: 'coffee machine is on floor two!', origin: 'agent' }, { similar: near }).kind, 'duplicate');
  // Editing an important memory is itself important.
  assert.equal(c('Prefers tea', { replaces: { id: 'x', content: 'Prefers coffee', type: 'preference' } }).reasons.includes('overwrite'), true);
});

let pendingPref;
test('extraction: routine facts saved automatically, important ones wait for approval', async () => {
  extraction = [
    { type: 'fact', content: 'Uses a standing desk at work', importance: 5 },
    { type: 'preference', content: 'Prefers replies in Iraqi dialect', importance: 8 },
    { type: 'fact', content: 'Pays rent of 900 dollars monthly', importance: 6 },
    { type: 'fact', content: 'Might switch laptops', importance: 4, confidence: 0.4 },
  ];
  const res = await call('POST', '/api/memory/extract', 'ml-owner', { text: 'chat text' });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.deepEqual(body.memories.map((m) => m.content), ['Uses a standing desk at work']);
  assert.equal(body.proposals.length, 3);
  assert.ok(outbound.every((u) => u.startsWith('http://127.0.0.1:11434/')), 'local model only');

  const routine = memByContent('Uses a standing desk at work');
  assert.ok(routine, 'routine fact saved');
  assert.deepEqual(versions(routine.id).map((v) => [v.change, v.created_by, v.reason]), [['create', 'extraction', 'learning:routine']]);
  for (const content of ['Prefers replies in Iraqi dialect', 'Pays rent of 900 dollars monthly', 'Might switch laptops']) {
    assert.equal(memByContent(content), undefined, `${content} not saved before approval`);
  }
  const list = (await call('GET', '/api/memory/proposals?status=pending')).json().proposals;
  const byReason = (r) => list.find((p) => p.reasons.includes(r));
  assert.equal(byReason('owner-preference').source, 'learning');
  assert.ok(byReason('money') && byReason('low-confidence'));
  pendingPref = byReason('owner-preference').id;

  // Approve -> saved as a new version; reject -> nothing.
  const ok = await decide(pendingPref, 'approve');
  assert.equal(ok.statusCode, 200, ok.body);
  const saved = memByContent('Prefers replies in Iraqi dialect');
  assert.ok(saved);
  assert.equal(saved.drawer_kind, 'owner');
  assert.deepEqual(versions(saved.id).map((v) => [v.change, v.created_by, v.reason]), [['create', 'ml-owner', 'proposal:learning']]);
  const money = byReason('money').id;
  assert.equal((await decide(money, 'reject')).statusCode, 200);
  assert.equal(memByContent('Pays rent of 900 dollars monthly'), undefined);

  // The same fact again is a duplicate: nothing saved twice.
  extraction = [{ type: 'fact', content: 'Uses a standing desk at work', importance: 5 }];
  const again = (await call('POST', '/api/memory/extract', 'ml-owner', { text: 'chat text' })).json();
  assert.equal(again.memories.length, 0);
  assert.equal(again.skipped[0].reason, 'already known');
});

test('non-owner account: important items are not saved (owner reviews proposals only)', async () => {
  extraction = [
    { type: 'fact', content: 'Member keeps notes in a notebook', importance: 5 },
    { type: 'preference', content: 'Member prefers dark mode', importance: 7 },
  ];
  const body = (await call('POST', '/api/memory/extract', 'ml-user', { text: 'x' })).json();
  assert.deepEqual(body.memories.map((m) => m.content), ['Member keeps notes in a notebook']);
  assert.equal(body.proposals.length, 0);
  assert.equal(body.skipped[0].reason, 'needs owner approval');
  assert.equal(memByContent('Member prefers dark mode', 'ml-user'), undefined);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memory_file_proposals WHERE user_id = 'ml-user'`).get().n, 0);
  // Proposal review stays owner-only.
  assert.equal((await call('GET', '/api/memory/proposals', 'ml-user')).statusCode, 403);
});

test('memory_save tool: routine saved + versioned by the agent; important -> proposal; outsider never auto-saved', async () => {
  const r1 = await run(memorySaveTool, { content: 'Alpha uses pnpm workspaces', type: 'fact', drawer: 'project:alpha' }, ownerCtx);
  assert.ok(r1.data?.memoryId, r1.content?.[0]?.text);
  assert.deepEqual(versions(r1.data.memoryId).map((v) => [v.change, v.created_by]), [['create', 'agent:ml-agent']]);

  const r2 = await run(memorySaveTool, { content: 'Ali from the supplier wants weekly calls', type: 'fact', drawer: 'project:alpha' }, ownerCtx);
  assert.equal(r2.data?.pendingApproval, undefined, 'no people/money topic: routine');
  const r3 = await run(memorySaveTool, { content: 'The client budget for alpha is 20000 euros', type: 'fact', drawer: 'project:alpha' }, ownerCtx);
  assert.equal(r3.data.pendingApproval, true);
  assert.match(r3.content[0].text, /Waiting for owner approval/);
  assert.equal(memByContent('The client budget for alpha is 20000 euros'), undefined);
  const p = db.prepare('SELECT source, created_by, drawer_kind, drawer_key FROM memory_file_proposals WHERE id = ?').get(r3.data.proposalId);
  assert.deepEqual({ ...p }, { source: 'agent', created_by: 'agent:ml-agent', drawer_kind: 'project', drawer_key: 'alpha' });

  // Outsider turn: by default no drawer is open at all ...
  const channel = { workspaceDir: dir, userId: 'ml-owner', agentId: 'ml-agent', toolPolicy: { channel: 'telegram', allowedTools: new Set(['memory_save']) } };
  const r4 = await run(memorySaveTool, { content: 'Visitor says the office moved', type: 'fact' }, channel);
  assert.ok(r4.error);
  // ... and with the server opt-in, it still only becomes a proposal.
  process.env.OUTSIDER_AGENT_MEMORY = 'true';
  try {
    const r5 = await run(memorySaveTool, { content: 'Visitor says the office moved', type: 'fact' }, channel);
    assert.equal(r5.data.pendingApproval, true);
    assert.ok(r5.data.reasons.includes('outsider'));
  } finally {
    delete process.env.OUTSIDER_AGENT_MEMORY;
  }
  assert.equal(memByContent('Visitor says the office moved'), undefined, 'never auto-saved into owner drawers');
});

test('memory_edit / memory_delete: versioned; important memories go through proposals', async () => {
  const routine = memByContent('Alpha uses pnpm workspaces');
  const e1 = await run(memoryEditTool, { id: routine.id, content: 'Alpha uses pnpm workspaces and turbo', reason: 'more detail' }, ownerCtx);
  assert.equal(e1.data?.op, 'update', e1.content?.[0]?.text);
  assert.equal(mem(routine.id).content, 'Alpha uses pnpm workspaces and turbo');
  assert.deepEqual(versions(routine.id).map((v) => [v.version, v.change, v.created_by]), [[1, 'create', 'agent:ml-agent'], [2, 'update', 'agent:ml-agent']]);
  assert.match(versions(routine.id)[1].reason, /more detail/);

  // Important memory (owner preference): edit -> proposal, nothing changes yet.
  const pref = memByContent('Prefers replies in Iraqi dialect');
  const e2 = await run(memoryEditTool, { id: pref.id, content: 'Prefers replies in English' }, ownerCtx);
  assert.equal(e2.data.pendingApproval, true);
  assert.equal(mem(pref.id).content, 'Prefers replies in Iraqi dialect');
  // A second edit proposal of the same memory goes stale once the first is approved.
  const e3 = await run(memoryEditTool, { id: pref.id, content: 'Prefers replies in German' }, ownerCtx);
  assert.equal((await decide(e2.data.proposalId, 'approve')).statusCode, 200);
  assert.equal(mem(pref.id).content, 'Prefers replies in English');
  assert.deepEqual(versions(pref.id).map((v) => v.change), ['create', 'update']);
  assert.equal((await decide(e3.data.proposalId, 'approve')).statusCode, 409);
  assert.equal(mem(pref.id).content, 'Prefers replies in English');

  // Delete: important -> proposal; routine -> deleted, history kept.
  const d1 = await run(memoryDeleteTool, { id: pref.id }, ownerCtx);
  assert.equal(d1.data.pendingApproval, true);
  assert.ok(mem(pref.id));
  const d2 = await run(memoryDeleteTool, { id: routine.id, reason: 'obsolete' }, ownerCtx);
  assert.equal(d2.data.op, 'delete');
  assert.equal(mem(routine.id), undefined);
  assert.deepEqual(versions(routine.id).map((v) => v.change), ['create', 'update', 'delete']);
  assert.equal(versions(routine.id)[1].content, 'Alpha uses pnpm workspaces and turbo', 'history keeps the old text (reversible)');

  // Only open drawers and own memories.
  const beta = (await call('POST', '/api/memory', 'ml-owner', { type: 'fact', content: 'Beta runs on port 9000', drawer: { kind: 'project', key: 'beta' } })).json().memory;
  assert.ok((await run(memoryEditTool, { id: beta.id, content: 'changed' }, ownerCtx)).error);
  assert.ok((await run(memoryDeleteTool, { id: beta.id }, ownerCtx)).error);
  const other = (await call('POST', '/api/memory', 'ml-user', { type: 'fact', content: 'User note' })).json().memory;
  assert.ok((await run(memoryDeleteTool, { id: other.id }, ownerCtx)).error);
  assert.ok(mem(beta.id) && mem(other.id));
  assert.ok((await run(memoryEditTool, { id: beta.id, content: 'x' }, { workspaceDir: dir })).error, 'no run user');
});

test('API add/edit/delete are versioned with actor and reason; history is per user', async () => {
  const created = (await call('POST', '/api/memory', 'ml-owner', { type: 'fact', content: 'Office opens at 9', importance: 6 })).json().memory;
  assert.equal((await call('PUT', `/api/memory/${created.id}`, 'ml-owner', { content: 'Office opens at 8' })).statusCode, 200);
  assert.equal((await call('DELETE', `/api/memory/${created.id}`, 'ml-owner')).statusCode, 200);
  assert.deepEqual(versions(created.id).map((v) => [v.change, v.created_by, v.reason, v.content]), [
    ['create', 'ml-owner', 'api', 'Office opens at 9'],
    ['update', 'ml-owner', 'api', 'Office opens at 8'],
    ['delete', 'ml-owner', 'api', null],
  ]);
  const h = await call('GET', `/api/memory/${created.id}/versions`);
  assert.equal(h.statusCode, 200);
  assert.equal(h.json().versions.length, 3);
  assert.equal((await call('GET', `/api/memory/${created.id}/versions`, 'ml-user')).statusCode, 404);
});

test('weekly summary: deterministic digest per drawer, stubbed model, owner only', async () => {
  // Owner-only route (gate + handler).
  assert.equal((await quietly(() => app.inject({ method: 'GET', url: '/api/memory/weekly-summary' }))).statusCode, 401);
  assert.equal((await call('GET', '/api/memory/weekly-summary', 'ml-user')).statusCode, 403);
  assert.equal((await call('POST', '/api/memory/weekly-summary/run', 'ml-user')).statusCode, 403);

  const fresh = (await call('GET', '/api/memory/weekly-summary')).json();
  assert.equal(fresh.stored, false);

  let seen = null;
  const stub = async (text) => { seen = text; return { text: 'Stub summary: a good week.', model: 'stub' }; };
  const rec = await W.runWeeklySummary('ml-owner', { summarizer: stub, actor: 'test' });
  assert.equal(rec.modelText, 'Stub summary: a good week.');
  assert.equal(rec.model, 'stub');
  assert.equal(seen, rec.text, 'the model only sees the deterministic digest');
  const owner = rec.digest.drawers.find((d) => d.drawerId === 'owner');
  const alpha = rec.digest.drawers.find((d) => d.drawerId === 'project:alpha');
  assert.ok(owner.created >= 2 && owner.updated >= 2 && owner.deleted >= 1, JSON.stringify(owner));
  assert.ok(alpha.pending >= 1 && alpha.deleted === 1);
  assert.ok(rec.digest.totals.pending >= 3);
  assert.match(rec.text, /What I learned this week/);
  assert.match(rec.text, /## project:alpha: /);
  assert.ok(rec.text.includes('new: Uses a standing desk at work'));
  assert.ok(!rec.text.includes('Office opens at 8'), 'deleted items show no text');
  assert.ok(!rec.text.includes('User note') && !rec.text.includes('Member'), 'only this user');

  const got = (await call('GET', '/api/memory/weekly-summary')).json();
  assert.equal(got.stored, true);
  assert.equal(got.summary.id, rec.id);

  // The route never calls a model unless configured (no network here).
  const before = outbound.length;
  const ran = await call('POST', '/api/memory/weekly-summary/run');
  assert.equal(ran.statusCode, 201, ran.body);
  assert.equal(ran.json().summary.model, null);
  assert.equal(outbound.length, before);
  assert.ok(db.prepare(`SELECT 1 FROM audit_logs WHERE action = 'memory_summary.run' AND user_id = 'ml-owner'`).get());
});

test('weekly summary job: in-process, owner-scoped, created once per owner', async () => {
  const created = await J.ensureMemoryJobs();
  assert.deepEqual(created.map((j) => j.name), ['memory-weekly-summary-ml-owner', 'memory-retention-ml-owner', 'memory-trash-ml-owner']);
  assert.deepEqual(await J.ensureMemoryJobs(), [], 'idempotent');
  const row = db.prepare(`SELECT action_type, action_data, cron_expression FROM cron_jobs WHERE name = 'memory-weekly-summary-ml-owner'`).get();
  assert.equal(row.action_type, 'memory-job');
  assert.deepEqual(JSON.parse(row.action_data), { job: 'weekly-summary', userId: 'ml-owner' });
  await assert.rejects(() => J.runMemoryJob({ job: 'weekly-summary', userId: 'ml-user' }), /owner/);
  await assert.rejects(() => J.runMemoryJob({ job: 'drop-tables', userId: 'ml-owner' }), /Unknown/);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM memory_weekly_summaries WHERE user_id = 'ml-owner'`).get().n;
  const out = await J.runMemoryJob({ job: 'weekly-summary', userId: 'ml-owner' });
  assert.ok(out.summaryId);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memory_weekly_summaries WHERE user_id = 'ml-owner'`).get().n, n + 1);
});

// UI-IP-04 review (CORE-04b): an add-only learning/agent proposal approved twice at once
// (both requests past the first checks, waiting on the embedding) adds exactly one memory.
test('concurrent double approve of an add-only learning proposal: one memory, one 409 already_decided', async () => {
  const MF = await import(join(backendDir, 'src/memory/memory-files.ts'));
  const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
  const content = 'Prefers the quarterly report in Arabic and English';
  for (const source of ['learning', 'agent']) {
    const text = `${content} (${source})`;
    const p = await MF.createChangeProposal({
      userId: 'ml-owner', agentId: 'ml-agent', drawer: { kind: 'owner' }, source, reasons: ['owner-preference'], createdBy: 'test',
      changes: [{ op: 'add', after: { type: 'preference', importance: 8, content: text } }],
    });
    const storage = getMemoryStorage();
    const orig = storage.embed;
    let release; let entered = 0;
    const gate = new Promise((r) => { release = r; });
    storage.embed = async (t) => { entered++; await gate; return orig.call(storage, t); };
    let results;
    try {
      const send = () => call('POST', `/api/memory/proposals/${p.id}/approve`, 'ml-owner', { expectedReviewHash: p.reviewHash });
      const both = [send(), send()];
      while (entered < 2) await new Promise((r) => setImmediate(r));
      release();
      results = await Promise.all(both);
    } finally { storage.embed = orig; }
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409], source);
    assert.equal(results.find((r) => r.statusCode === 409).json().code, 'already_decided');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE content = ? AND user_id = ?').get(text, 'ml-owner').n, 1, `${source}: exactly one memory`);
    assert.equal(db.prepare(`SELECT status FROM memory_file_proposals WHERE id = ?`).get(p.id).status, 'approved');
  }
});
