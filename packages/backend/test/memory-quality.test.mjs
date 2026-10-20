// CORE-MEM-TOPIC / CORE-MEM-CONFLICT / CORE-MEM-DOCTOR: stable topic keys,
// conflict surfacing with keep new / keep old / keep both, memory doctor.
// Run: node --import tsx --test test/memory-quality.test.mjs
// Throwaway DB + cwd, random test-only secrets, offline hash embeddings, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-memquality-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.MEMORY_EMBEDDINGS = 'hash';
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
addUser('mq-owner', 'owner');
addUser('mq-user', 'user');
db.prepare('UPDATE agents_config SET is_primary = 0').run();
db.prepare(`INSERT INTO agents_config (id, name, is_primary) VALUES ('mq-agent', 'Mq Agent', 1)`).run();

const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { memoryRoutes } = await import(join(backendDir, 'src/api/routes/memory.ts'));
const { memoryFilesRoutes } = await import(join(backendDir, 'src/api/routes/memory-files.ts'));
const { memoryDoctorRoutes } = await import(join(backendDir, 'src/api/routes/memory-doctor.ts'));
const T = await import(join(backendDir, 'src/memory/topic-key.ts'));
const C = await import(join(backendDir, 'src/memory/contradiction.ts'));
const D = await import(join(backendDir, 'src/memory/drawers.ts'));
const { memorySaveTool } = await import(join(backendDir, 'src/tools/memory/save.ts'));
const { memoryEditTool } = await import(join(backendDir, 'src/tools/memory/edit.ts'));
const { memoryDoctorTool, memoryDoctorFixTool } = await import(join(backendDir, 'src/tools/memory/doctor.ts'));
const { approvalCategory } = await import(join(backendDir, 'src/tools/approvals.ts'));
const { DEFAULT_AGENT_TOOLS } = await import(join(backendDir, 'src/tools/grants.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');

const app = Fastify();
registerAuthGate(app);
await app.register(memoryRoutes);
await app.register(memoryFilesRoutes);
await app.register(memoryDoctorRoutes);
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
const call = (method, url, who = 'mq-owner', payload) => quietly(() => app.inject({ method, url, headers: auth(who), payload }));
const reviewHashOf = async (id) => (await call('GET', `/api/memory/proposals/${id}`)).json().reviewHash;
const mem = (id) => db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
const byTopic = (key, kind = 'owner', dkey = '') => db.prepare('SELECT * FROM memories WHERE user_id = ? AND drawer_kind = ? AND drawer_key = ? AND topic_key = ?').all('mq-owner', kind, dkey, key);
const versions = (id) => db.prepare('SELECT version, change, content, reason FROM memory_versions WHERE memory_id = ? ORDER BY version').all(id).map((r) => ({ ...r }));
const run = (tool, params, ctx) => quietly(() => tool.execute(params, ctx));
const ownerCtx = { workspaceDir: dir, userId: 'mq-owner', agentId: 'mq-agent', memoryDrawers: D.selectDrawers({ audience: 'owner', project: 'alpha' }) };
const memberCtx = { ...ownerCtx, userId: 'mq-user' };
const outsiderCtx = { ...ownerCtx, toolPolicy: { channel: 'telegram', allowedTools: [] } };

/** Hash of every memory/version/proposal row: proves a call wrote nothing. */
const snapshot = () => createHash('sha256').update(JSON.stringify([
  db.prepare('SELECT * FROM memories ORDER BY id').all(),
  db.prepare('SELECT * FROM memory_versions ORDER BY id').all(),
  db.prepare('SELECT * FROM memory_file_proposals ORDER BY id').all(),
])).digest('hex');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('topic keys: suggestion from a title and normalization (pure)', () => {
  assert.equal(T.suggestTopicKey('Favorite Editor!'), 'favorite-editor');
  assert.equal(T.suggestTopicKey('  Project Alpha / Status  '), 'project-alpha-status');
  assert.equal(T.suggestTopicKey('Größe & Café'), 'große-cafe');
  assert.equal(T.suggestTopicKey('اللغة المفضلة'), 'اللغه-المفضله');
  assert.equal(T.suggestTopicKey('***'), null);
  assert.equal(T.suggestTopicKey(42), null);
  assert.equal(T.suggestTopicKey('x'.repeat(300)).length, T.MAX_TOPIC_KEY);
  assert.equal(T.normalizeTopicKey('Favorite-Editor'), 'favorite-editor');
  assert.equal(T.normalizeTopicKey(''), null);
  assert.equal(T.normalizeTopicKey(null), null);
  assert.throws(() => T.normalizeTopicKey('---'), T.TopicKeyError);
  assert.throws(() => T.normalizeTopicKey({}), T.TopicKeyError);
  assert.equal(T.isTopicKey('favorite-editor'), true);
  assert.equal(T.isTopicKey('Favorite Editor'), false);
});

test('contradiction: negation and opposite words on the same subject (pure)', () => {
  const c = C.detectContradiction;
  assert.equal(c('User likes tea', 'User does not like tea'), 'negation');
  assert.equal(c("User likes tea", "User doesn't like tea"), 'negation');
  assert.equal(c('User likes tea', 'User dislikes tea'), 'opposite');
  assert.equal(c('Dark mode is enabled', 'Dark mode is disabled'), 'opposite');
  assert.equal(c('المستخدم يحب الشاي', 'المستخدم لا يحب الشاي'), 'negation');
  assert.equal(c('Mohamed mag Kaffee', 'Mohamed mag keinen Kaffee'), 'negation');
  // A negated opposite agrees; detail and other subjects are no contradiction.
  assert.equal(c('User likes tea', 'User does not dislike tea'), null);
  assert.equal(c('User likes tea', 'User likes green tea a lot'), null);
  assert.equal(c('Favorite color is blue', 'Favorite color is green'), null);
  assert.equal(c('The server runs on port 4000', 'We should not deploy on Friday'), null);
});

// ---------------------------------------------------------------------------
// CORE-MEM-TOPIC
// ---------------------------------------------------------------------------

test('memory_save with a topic key: same topic twice -> one memory, two versions; other topic/drawer -> separate', async () => {
  const r1 = await run(memorySaveTool, { content: 'Main editor is VS Code', type: 'fact', topic_key: 'Main Editor' }, ownerCtx);
  assert.ok(r1.data?.memoryId, r1.content?.[0]?.text);
  assert.equal(r1.data.topicKey, 'main-editor');
  const r2 = await run(memorySaveTool, { content: 'Main editor is Zed', type: 'fact', topic_key: 'main-editor' }, ownerCtx);
  assert.equal(r2.data.updatedExisting, true, r2.content[0].text);
  assert.equal(r2.data.memoryId, r1.data.memoryId);
  const rows = byTopic('main-editor');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'Main editor is Zed');
  assert.deepEqual(versions(r1.data.memoryId).map((v) => [v.change, v.content, v.reason]), [
    ['create', 'Main editor is VS Code', 'learning:routine'],
    ['update', 'Main editor is Zed', 'learning:topic'],
  ]);
  // The same text again: nothing new.
  const r3 = await run(memorySaveTool, { content: 'Main editor is Zed', type: 'fact', topic_key: 'main-editor' }, ownerCtx);
  assert.equal(r3.data.duplicate, true);
  assert.equal(versions(r1.data.memoryId).length, 2);

  // A different topic is a separate memory; the same topic in another drawer too.
  const other = await run(memorySaveTool, { content: 'Terminal is Ghostty', type: 'fact', topic_key: 'main-terminal' }, ownerCtx);
  assert.notEqual(other.data.memoryId, r1.data.memoryId);
  const proj = await run(memorySaveTool, { content: 'Alpha editor is Vim', type: 'fact', topic_key: 'main-editor', drawer: 'project:alpha' }, ownerCtx);
  assert.ok(proj.data.memoryId && proj.data.memoryId !== r1.data.memoryId, proj.content[0].text);
  assert.equal(byTopic('main-editor', 'project', 'alpha').length, 1);
  assert.equal(mem(r1.data.memoryId).content, 'Main editor is Zed', 'owner drawer untouched by the project save');

  // Drawer rules unchanged: a closed drawer is refused, an invalid key is skipped.
  const closed = await run(memorySaveTool, { content: 'Beta editor is Emacs', type: 'fact', topic_key: 'main-editor', drawer: 'project:beta' }, ownerCtx);
  assert.match(closed.error, /not open/);
  const bad = await run(memorySaveTool, { content: 'Something', type: 'fact', topic_key: '***' }, ownerCtx);
  assert.match(bad.error, /invalid topic key/);
});

test('topic key update of an important memory goes through a proposal; non-owner is not saved', async () => {
  const r1 = await run(memorySaveTool, { content: 'Office floor is two', type: 'fact', importance: 9, topic_key: 'office-floor' }, ownerCtx);
  assert.ok(r1.data.memoryId);
  const r2 = await run(memorySaveTool, { content: 'Office floor is three', type: 'fact', topic_key: 'office-floor' }, ownerCtx);
  assert.equal(r2.data.pendingApproval, true, r2.content[0].text);
  assert.equal(mem(r1.data.memoryId).content, 'Office floor is two', 'nothing changes before approval');
  const p = db.prepare('SELECT changes, conflict_with FROM memory_file_proposals WHERE id = ?').get(r2.data.proposalId);
  assert.equal(JSON.parse(p.changes)[0].op, 'update');
  assert.equal(p.conflict_with, null, 'an important update, not a contradiction');
  const ok = await call('POST', `/api/memory/proposals/${r2.data.proposalId}/approve`, 'mq-owner', { expectedReviewHash: await reviewHashOf(r2.data.proposalId) });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(mem(r1.data.memoryId).content, 'Office floor is three');
  assert.equal(mem(r1.data.memoryId).topic_key, 'office-floor', 'the key stays with the memory');

  // A member account: a routine topic update applies, a contradiction is not saved.
  const m1 = await run(memorySaveTool, { content: 'Member likes tea', type: 'fact', topic_key: 'drink' }, memberCtx);
  const m2 = await run(memorySaveTool, { content: 'Member does not like tea', type: 'fact', topic_key: 'drink' }, memberCtx);
  assert.match(m2.error, /owner approval/);
  assert.equal(mem(m1.data.memoryId).content, 'Member likes tea');
});

test('API: topicKey on create updates the existing memory; suggestion route; PUT sets/clears; taken key -> 409', async () => {
  const sug = await call('GET', `/api/memory/topic-key?title=${encodeURIComponent('Weekly Report Day')}`);
  assert.equal(sug.statusCode, 200);
  assert.equal(sug.json().key, 'weekly-report-day');
  assert.equal((await call('GET', '/api/memory/topic-key')).statusCode, 400);

  const a = await call('POST', '/api/memory', 'mq-owner', { type: 'fact', content: 'Report goes out on Monday', topicKey: 'Weekly Report Day' });
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(a.json().updatedExisting, false);
  const id = a.json().memory.id;
  const b = await call('POST', '/api/memory', 'mq-owner', { type: 'fact', content: 'Report goes out on Tuesday', topicKey: 'weekly-report-day' });
  assert.equal(b.json().updatedExisting, true);
  assert.equal(b.json().memory.id, id);
  assert.equal(mem(id).content, 'Report goes out on Tuesday');
  assert.deepEqual(versions(id).map((v) => [v.change, v.reason]), [['create', 'api'], ['update', 'api:topic']]);
  assert.equal((await call('POST', '/api/memory', 'mq-owner', { type: 'fact', content: 'x', topicKey: '!!!' })).statusCode, 400);

  const c = (await call('POST', '/api/memory', 'mq-owner', { type: 'fact', content: 'Standup at nine' })).json().memory.id;
  const set = await call('PUT', `/api/memory/${c}`, 'mq-owner', { topicKey: 'Standup Time' });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(mem(c).topic_key, 'standup-time');
  assert.ok(versions(c).some((v) => v.reason === 'topic-key:standup-time'));
  const taken = await call('PUT', `/api/memory/${c}`, 'mq-owner', { topicKey: 'weekly-report-day' });
  assert.equal(taken.statusCode, 409);
  assert.equal(taken.json().code, 'topic_key_taken');
  assert.equal(mem(c).topic_key, 'standup-time');
  const clear = await call('PUT', `/api/memory/${c}`, 'mq-owner', { topicKey: null });
  assert.equal(clear.statusCode, 200);
  assert.equal(mem(c).topic_key, null);
  // Another user's memory is never reached through its topic key.
  const other = await call('POST', '/api/memory', 'mq-user', { type: 'fact', content: 'Member report on Friday', topicKey: 'weekly-report-day' });
  assert.equal(other.json().updatedExisting, false);
  assert.notEqual(other.json().memory.id, id);
});

test('memory_edit sets a topic key; a later memory_save with it updates that memory', async () => {
  const r = await run(memorySaveTool, { content: 'Build runs on node 22', type: 'fact' }, ownerCtx);
  const e = await run(memoryEditTool, { id: r.data.memoryId, topic_key: 'Node Version' }, ownerCtx);
  assert.equal(e.data?.success, true, e.content[0].text);
  assert.equal(mem(r.data.memoryId).topic_key, 'node-version');
  const s = await run(memorySaveTool, { content: 'Build runs on node 24', type: 'fact', topic_key: 'node-version' }, ownerCtx);
  assert.equal(s.data.memoryId, r.data.memoryId);
  assert.equal(mem(r.data.memoryId).content, 'Build runs on node 24');
  const taken = await run(memoryEditTool, { id: (await run(memorySaveTool, { content: 'Lint with biome', type: 'fact' }, ownerCtx)).data.memoryId, topic_key: 'node-version' }, ownerCtx);
  assert.match(taken.error, /already used/);
});

// ---------------------------------------------------------------------------
// CORE-MEM-CONFLICT
// ---------------------------------------------------------------------------

async function conflictPair(oldText, newText, extra = {}) {
  const a = await run(memorySaveTool, { content: oldText, type: 'fact', ...extra }, ownerCtx);
  assert.ok(a.data?.memoryId, a.content?.[0]?.text);
  const b = await run(memorySaveTool, { content: newText, type: 'fact', ...extra }, ownerCtx);
  assert.equal(b.data?.conflict, true, b.content?.[0]?.text);
  assert.equal(b.data.conflictWith, a.data.memoryId);
  assert.match(b.content[0].text, /Nothing was overwritten/);
  assert.equal(mem(a.data.memoryId).content, oldText, 'nothing overwritten without a decision');
  return { oldId: a.data.memoryId, proposalId: b.data.proposalId };
}
const decideConflict = async (id, decision, who = 'mq-owner', hash) =>
  call('POST', `/api/memory/proposals/${id}/decide`, who, { decision, expectedReviewHash: hash ?? await reviewHashOf(id) });

test('conflict: contradicting memory -> flagged proposal; keep old changes nothing', async () => {
  const { oldId, proposalId } = await conflictPair('Kitchen light switch is near the door', 'Kitchen light switch is not near the door');
  const p = (await call('GET', `/api/memory/proposals/${proposalId}`)).json();
  assert.equal(p.conflictWith, oldId);
  assert.ok(p.reasons.includes('conflict'));
  assert.equal(p.changes[0].op, 'update');
  const before = snapshot();
  const r = await decideConflict(proposalId, 'keep_old');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().proposal.status, 'rejected');
  assert.equal(r.json().proposal.decision, 'keep_old');
  assert.equal(mem(oldId).content, 'Kitchen light switch is near the door');
  assert.equal(versions(oldId).length, 1);
  assert.notEqual(snapshot(), before, 'only the proposal row changed');
  assert.equal((await decideConflict(proposalId, 'keep_new')).json().code, 'already_decided');
});

test('conflict: keep new -> the existing memory gets the new text as a new version', async () => {
  const { oldId, proposalId } = await conflictPair('Garage door is open', 'Garage door is closed');
  const r = await decideConflict(proposalId, 'keep_new');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().proposal.decision, 'keep_new');
  assert.deepEqual(r.json().applied.updated, [oldId]);
  assert.equal(mem(oldId).content, 'Garage door is closed');
  assert.deepEqual(versions(oldId).map((v) => v.change), ['create', 'update']);
});

test('conflict: keep both -> the new text is its own memory, the old one stays', async () => {
  const { oldId, proposalId } = await conflictPair('Backups run on Sunday', 'Backups never run on Sunday');
  const r = await decideConflict(proposalId, 'keep_both');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().proposal.decision, 'keep_both');
  const [added] = r.json().applied.added;
  assert.ok(added && added !== oldId);
  assert.equal(mem(oldId).content, 'Backups run on Sunday');
  assert.equal(mem(added).content, 'Backups never run on Sunday');
});

test('conflict on a topic key: negation is flagged, a plain value change is a new version', async () => {
  const a = await run(memorySaveTool, { content: 'User likes oat milk', type: 'fact', topic_key: 'milk' }, ownerCtx);
  const b = await run(memorySaveTool, { content: 'User does not like oat milk', type: 'fact', topic_key: 'milk' }, ownerCtx);
  assert.equal(b.data.conflict, true, b.content[0].text);
  assert.equal(mem(a.data.memoryId).content, 'User likes oat milk');
  const c = await run(memorySaveTool, { content: 'User likes oat milk and soy milk', type: 'fact', topic_key: 'milk' }, ownerCtx);
  assert.equal(c.data.updatedExisting, true, c.content[0].text);
  // The pending conflict was made against the old text: it went stale and cannot overwrite.
  const r = await decideConflict(b.data.proposalId, 'keep_new');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'stale');
  assert.equal(mem(a.data.memoryId).content, 'User likes oat milk and soy milk');
});

test('conflict decisions: owner only, review hash required, valid decision, conflict proposals only, one winner', async () => {
  const { oldId, proposalId } = await conflictPair('Printer is on', 'Printer is off');
  assert.equal((await call('POST', `/api/memory/proposals/${proposalId}/decide`, 'mq-user', { decision: 'keep_new', expectedReviewHash: await reviewHashOf(proposalId) })).statusCode, 403);
  assert.equal((await call('POST', `/api/memory/proposals/${proposalId}/decide`, 'mq-owner', { decision: 'keep_new' })).json().code, 'review_hash_required');
  assert.equal((await decideConflict(proposalId, 'keep_new', 'mq-owner', 'f'.repeat(64))).json().code, 'review_changed');
  assert.equal((await decideConflict(proposalId, 'overwrite')).statusCode, 400);
  assert.equal(mem(oldId).content, 'Printer is on');

  // A non-conflict proposal cannot be decided this way.
  const plain = await run(memorySaveTool, { content: 'The team budget is 500 euros', type: 'fact' }, ownerCtx);
  assert.equal(plain.data.pendingApproval, true);
  assert.equal((await decideConflict(plain.data.proposalId, 'keep_both')).statusCode, 400);

  // Two decisions at once: exactly one applies.
  const hash = await reviewHashOf(proposalId);
  const results = await Promise.all([decideConflict(proposalId, 'keep_new', 'mq-owner', hash), decideConflict(proposalId, 'keep_both', 'mq-owner', hash)]);
  const codes = results.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [200, 409], results.map((r) => r.body).join(' | '));
  const winner = results.find((r) => r.statusCode === 200).json().decision;
  const copies = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE user_id = 'mq-owner' AND content = 'Printer is off'`).get().n;
  assert.equal(copies, 1, `one memory with the new text (${winner})`);
  assert.equal(mem(oldId).content, winner === 'keep_new' ? 'Printer is off' : 'Printer is on');
});

// ---------------------------------------------------------------------------
// CORE-MEM-DOCTOR
// ---------------------------------------------------------------------------

test('doctor: reports seeded problems, writes nothing; fix needs confirm + the reviewed hash', async () => {
  const ins = (id, content, extra = {}) => {
    const r = { type: 'fact', drawer_kind: 'experience', drawer_key: '', embedding: JSON.stringify(Array(256).fill(0.01)), embedding_model: 'hash-v2', embedding_dims: 256, expiry_timestamp: null, topic_key: null, created_at: new Date(Date.now() - 1000).toISOString(), ...extra };
    db.prepare(`INSERT INTO memories (id, user_id, type, content, embedding, memory_layer, status, metadata, importance_score, created_at, access_count, expiry_timestamp, consolidation_status, drawer_kind, drawer_key, embedding_model, embedding_dims, topic_key)
      VALUES (?, 'mq-owner', ?, ?, ?, 'experiential', 'active', '{}', 0.5, ?, 0, ?, 'pending', ?, ?, ?, ?, ?)`)
      .run(id, r.type, content, r.embedding, r.created_at, r.expiry_timestamp, r.drawer_kind, r.drawer_key, r.embedding_model, r.embedding_dims, r.topic_key);
  };
  const baseline = (await call('GET', '/api/memory/doctor')).json();
  ins('doc-dup-1', 'Deploys go through the staging box first');
  ins('doc-dup-2', 'deploys go through the staging box first!', { created_at: new Date().toISOString() });
  ins('doc-expired', 'Temporary note for yesterday', { expiry_timestamp: Date.now() - 60_000 });
  ins('doc-noemb', 'Vector missing here', { embedding: null, embedding_model: null, embedding_dims: null });
  ins('doc-oldemb', 'Vector from the old hash model', { embedding_model: 'hash-v1' });
  ins('doc-badkey', 'Topic key written by hand', { topic_key: 'Not Canonical' });
  ins('doc-baddrawer', 'Drawer key is broken', { drawer_kind: 'project', drawer_key: 'Bad Key!' });
  db.prepare(`INSERT INTO memory_versions (id, memory_id, user_id, drawer_kind, drawer_key, drawer_revision, version, change, type, content, importance_score, created_by, reason)
    VALUES ('doc-orphan-v1', 'doc-gone', 'mq-owner', 'experience', '', 0, 1, 'create', 'fact', 'gone', 0.5, 'test', 'seed')`).run();

  const before = snapshot();
  const res = await call('GET', '/api/memory/doctor');
  assert.equal(res.statusCode, 200, res.body);
  const report = res.json();
  assert.equal(snapshot(), before, 'the check writes nothing');
  const delta = (k) => report.counts[k] - baseline.counts[k];
  assert.equal(delta('duplicate'), 1);
  assert.equal(delta('expired'), 1);
  assert.equal(delta('embedding-missing'), 1);
  assert.equal(delta('embedding-stale'), 1);
  assert.equal(delta('orphan-versions'), 1);
  assert.equal(delta('broken-drawer'), 1);
  assert.equal(delta('topic-key-invalid'), 1);
  const dup = report.issues.find((i) => i.kind === 'duplicate' && i.memoryIds.includes('doc-dup-1'));
  assert.deepEqual(dup.memoryIds, ['doc-dup-1', 'doc-dup-2'], 'the oldest is kept');
  assert.ok(!JSON.stringify(report).includes('staging box'), 'no memory text in a report');
  assert.match(report.reportHash, /^[0-9a-f]{64}$/);

  // Gates: owner only; no change without confirm; wrong hash -> nothing.
  assert.equal((await call('GET', '/api/memory/doctor', 'mq-user')).statusCode, 403);
  assert.equal((await call('POST', '/api/memory/doctor/fix', 'mq-user', { confirm: true, expectedReportHash: report.reportHash })).statusCode, 403);
  const noConfirm = await call('POST', '/api/memory/doctor/fix', 'mq-owner', { expectedReportHash: report.reportHash });
  assert.equal(noConfirm.statusCode, 400);
  assert.equal(noConfirm.json().code, 'confirm_required');
  assert.equal((await call('POST', '/api/memory/doctor/fix', 'mq-owner', { confirm: 'yes', expectedReportHash: report.reportHash })).json().code, 'confirm_required');
  assert.equal((await call('POST', '/api/memory/doctor/fix', 'mq-owner', { confirm: true })).json().code, 'report_hash_required');
  assert.equal((await call('POST', '/api/memory/doctor/fix', 'mq-owner', { confirm: true, expectedReportHash: 'a'.repeat(64) })).json().code, 'report_changed');
  assert.equal((await call('POST', '/api/memory/doctor/fix', 'mq-owner', { confirm: true, expectedReportHash: report.reportHash, kinds: ['bogus'] })).json().code, 'invalid_kinds');
  assert.equal(snapshot(), before, 'refused fixes wrote nothing');

  // Only the chosen kinds are fixed.
  const partial = await call('POST', '/api/memory/doctor/fix', 'mq-owner', { confirm: true, expectedReportHash: report.reportHash, kinds: ['duplicate'] });
  assert.equal(partial.statusCode, 200, partial.body);
  assert.equal(partial.json().fixed.duplicate, report.counts.duplicate);
  assert.equal(mem('doc-dup-2'), undefined);
  assert.ok(mem('doc-dup-1'));
  assert.deepEqual(versions('doc-dup-2').map((v) => [v.change, v.reason]), [['baseline', null], ['delete', 'doctor:duplicate']]);
  assert.ok(mem('doc-expired'), 'other kinds untouched');

  // The rest, with the hash of the new report.
  const next = partial.json().report;
  const all = await call('POST', '/api/memory/doctor/fix', 'mq-owner', { confirm: true, expectedReportHash: next.reportHash });
  assert.equal(all.statusCode, 200, all.body);
  const after = all.json().report;
  for (const k of ['duplicate', 'expired', 'embedding-missing', 'embedding-stale', 'orphan-versions', 'broken-drawer', 'topic-key-invalid']) {
    assert.equal(after.counts[k], 0, `${k} fixed: ${JSON.stringify(after.issues.filter((i) => i.kind === k))}`);
  }
  assert.equal(mem('doc-expired'), undefined);
  assert.equal(mem('doc-noemb').embedding_model, 'hash-v2');
  assert.equal(mem('doc-oldemb').embedding_model, 'hash-v2');
  assert.equal(mem('doc-badkey').topic_key, 'not-canonical');
  assert.deepEqual([mem('doc-baddrawer').drawer_kind, mem('doc-baddrawer').drawer_key], ['owner', '']);
  assert.equal(versions('doc-gone').at(-1).change, 'delete');
  assert.equal(versions('doc-gone').at(-1).reason, 'doctor:orphan-versions');
});

test('doctor tools: owner turn only, never for outsiders or members; fix is approval-gated', async () => {
  assert.equal(approvalCategory({ name: 'memory_doctor_fix' }), 'delete');
  assert.equal(approvalCategory({ name: 'memory_doctor' }), null);
  assert.ok(DEFAULT_AGENT_TOOLS.includes('memory_doctor') && DEFAULT_AGENT_TOOLS.includes('memory_doctor_fix'));

  const ok = await run(memoryDoctorTool, {}, ownerCtx);
  assert.equal(ok.data?.success, true, ok.content?.[0]?.text);
  assert.match(ok.data.reportHash, /^[0-9a-f]{64}$/);
  assert.match((await run(memoryDoctorTool, {}, outsiderCtx)).error, /someone else/);
  assert.match((await run(memoryDoctorTool, {}, memberCtx)).error, /only for the owner/);
  assert.match((await run(memoryDoctorFixTool, { report_hash: ok.data.reportHash }, memberCtx)).error, /only for the owner/);
  assert.match((await run(memoryDoctorFixTool, { report_hash: ok.data.reportHash }, outsiderCtx)).error, /someone else/);

  // An agent run sees only its open drawers: seed a duplicate in a closed drawer.
  for (const [id, at] of [['doc-closed-1', 1], ['doc-closed-2', 2]]) {
    db.prepare(`INSERT INTO memories (id, user_id, type, content, embedding, memory_layer, status, metadata, importance_score, created_at, access_count, consolidation_status, drawer_kind, drawer_key, embedding_model, embedding_dims)
      VALUES (?, 'mq-owner', 'fact', 'Closed drawer copy', ?, 'factual', 'active', '{}', 0.5, ?, 0, 'pending', 'project', 'secret', 'hash-v2', 256)`)
      .run(id, JSON.stringify(Array(256).fill(0.01)), new Date(Date.now() + at).toISOString());
  }
  const agentView = await run(memoryDoctorTool, {}, ownerCtx);
  assert.ok(!JSON.stringify(agentView.data.issues).includes('doc-closed-1'), 'closed drawer not checked by the agent');
  const ownerView = (await call('GET', '/api/memory/doctor')).json();
  assert.ok(ownerView.issues.some((i) => i.memoryIds.includes('doc-closed-2')));

  const fixed = await run(memoryDoctorFixTool, { report_hash: agentView.data.reportHash }, ownerCtx);
  assert.equal(fixed.data?.success, true, fixed.content?.[0]?.text);
  assert.ok(mem('doc-closed-2'), 'the agent fix never reaches a closed drawer');
  assert.match((await run(memoryDoctorFixTool, { report_hash: 'b'.repeat(64) }, ownerCtx)).error, /changed since the check/);
});
