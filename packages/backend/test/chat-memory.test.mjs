// CHAT-PRO-02 E: chat memory.
//  - owner only; "Remember this" saves an edited message into the project, owner or
//    experience drawer, secrets removed, versioned, linked to the conversation and message;
//  - in a saved conversation an agent's memory_save becomes a proposal shown in the chat;
//    the owner accepts or rejects it with the review hash; nothing is saved by itself;
//  - the list shows each memory's state (saved, removed, waiting, rejected).
// Throwaway DB/keys; the local model is stubbed (no network).
// Run: node --import tsx --test test/chat-memory.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-chat-memory-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
for (const k of ['AGENT_EXEC_TOOLS', 'OLLAMA_THINK', 'DEFAULT_MODEL']) delete process.env[k];

const script = [];
const bodies = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== 'http://127.0.0.1:11434/api/chat') throw new Error(`unexpected network call in test: ${url}`);
  bodies.push(JSON.parse(init.body));
  const lines = script.shift() ?? [{ message: { content: 'ok' }, done: true }];
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + '\n')); c.close(); } }), { status: 200 });
};
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
for (const [id, role] of [['cm-owner', 'owner'], ['cm-admin', 'admin'], ['cm-user', 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, role);
}
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('cm-main', 'Main', 'ollama', 'qwen-test', 1)`).run();
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('cm-writer', 'Writer', 'ollama', 'qwen-test', 0)`).run();
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('cm-coder', 'Coder', 'ollama', 'qwen-test', 0)`).run();

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { chatRuns } = await import(join(backendDir, 'src/services/chat-runs.ts'));
const { addAssistantMessage, createProject } = await import(join(backendDir, 'src/repositories/chat-conversations.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const as = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const call = (user, method, url, payload) => app.inject({ method, url, headers: as(user), ...(payload ? { payload } : {}) });
const ended = (runId) => new Promise((r) => { const run = chatRuns.get(runId); if (run.status !== 'running') r(); else run.emitter.once('end', r); });


const conv = (await call('cm-owner', 'POST', '/api/chat/conversations', { title: 'Plans' })).json().conversation;
const url = `/api/chat/conversations/${conv.id}/memories`;
const reply = await addAssistantMessage(conv.id, { runId: 'run-cm-0001', content: 'We ship on Fridays; the token is ghp_abcdefghijklmnopqrstuvwxyz0123456789.', parts: [], status: 'complete', durationMs: 5 });
const memories = () => db.prepare("SELECT id, content, drawer_kind, drawer_key FROM memories WHERE user_id = 'cm-owner'").all();

test('only the owner uses chat memory', async () => {
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  for (const who of ['cm-admin', 'cm-user']) {
    assert.equal((await call(who, 'GET', url)).statusCode, 403, who);
    assert.equal((await call(who, 'POST', url, { messageId: reply.id, content: 'x', drawer: 'owner' })).statusCode, 403, who);
  }
});

test('"Remember this" saves an edited message into the chosen drawer, secrets removed, linked to the message', async () => {
  const r = await call('cm-owner', 'POST', url, { messageId: reply.id, content: '  We ship on Fridays; the token is ghp_abcdefghijklmnopqrstuvwxyz0123456789.  ', drawer: 'experience' });
  assert.equal(r.statusCode, 201, r.body);
  const out = r.json();
  assert.equal(out.redacted, 1);
  assert.equal(out.duplicate, false);
  assert.equal(out.memory.kind, 'remembered');
  assert.equal(out.memory.status, 'saved');
  assert.equal(out.memory.drawerId, 'experience');
  assert.equal(out.memory.messageId, reply.id);
  assert.doesNotMatch(out.memory.text, /ghp_/);
  const row = memories().find((m) => m.id === out.memory.memoryId);
  assert.equal(row.drawer_kind, 'experience');
  assert.match(row.content, /^We ship on Fridays; the token is \[REDACTED:github_token\]\.$/);
  const meta = JSON.parse(db.prepare('SELECT metadata FROM memories WHERE id = ?').get(row.id).metadata);
  assert.deepEqual([meta.source, meta.conversationId, meta.messageId], ['chat', conv.id, reply.id]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = ? AND change = 'create'").get(row.id).n, 1, 'versioned');
  // Saving the same text again links the memory once, no second copy.
  const again = (await call('cm-owner', 'POST', url, { messageId: reply.id, content: 'We ship on Fridays; the token is ghp_abcdefghijklmnopqrstuvwxyz0123456789.', drawer: 'experience' })).json();
  assert.equal(again.duplicate, true);
  assert.equal(again.memory.id, out.memory.id);
  assert.equal(memories().length, 1);
  // A reply can also be named by its run (the page knows a fresh reply only by its run).
  const byRun = (await call('cm-owner', 'POST', url, { runId: 'run-cm-0001', content: 'Releases go out on Fridays.', drawer: 'owner' })).json();
  assert.equal(byRun.memory.messageId, reply.id);
  db.prepare('DELETE FROM chat_memory_links WHERE id = ?').run(byRun.memory.id);
  db.prepare('DELETE FROM memories WHERE id = ?').run(byRun.memory.memoryId);
  const list = (await call('cm-owner', 'GET', url)).json().memories;
  assert.equal(list.length, 1);
});

test('the project drawer only for a project conversation; bad requests are refused', async () => {
  const owner = (body) => call('cm-owner', 'POST', url, { messageId: reply.id, content: 'x', drawer: 'owner', ...body });
  for (const [body, why] of [
    [{ drawer: 'project' }, 'no project'], [{ drawer: 'people' }, 'drawer not offered'], [{ content: '' }, 'empty'], [{ content: 'x'.repeat(4001) }, 'too long'],
    [{ messageId: 'nope' }, 'unknown message'], [{ type: 'secret' }, 'bad type'], [{ importance: 11 }, 'bad importance'], [{ userId: 'cm-user' }, 'extra field'],
    [{ content: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, 'only a secret'], [{ runId: 'run-cm-0001' }, 'both ids'], [{ messageId: undefined }, 'no id'],
  ]) assert.equal((await owner(body)).statusCode, 400, why);
  assert.equal((await call('cm-owner', 'GET', '/api/chat/conversations/no-such-conversation/memories')).statusCode, 404);
  const other = (await call('cm-user', 'POST', '/api/chat/conversations', {})).json().conversation;
  assert.equal((await call('cm-owner', 'GET', `/api/chat/conversations/${other.id}/memories`)).statusCode, 404, "another user's conversation looks missing");
  // A message of another conversation is refused.
  const msg = await addAssistantMessage(other.id, { runId: 'run-cm-0002', content: 'hi', parts: [], status: 'complete', durationMs: 1 });
  assert.equal((await owner({ messageId: msg.id })).statusCode, 400);

  const project = await createProject('cm-owner', { name: 'Launch site' });
  const pc = (await call('cm-owner', 'POST', '/api/chat/conversations', { projectId: project.id })).json().conversation;
  const pm = await addAssistantMessage(pc.id, { runId: 'run-cm-0003', content: 'Use the blue logo.', parts: [], status: 'complete', durationMs: 1 });
  const r = await call('cm-owner', 'POST', `/api/chat/conversations/${pc.id}/memories`, { messageId: pm.id, content: 'Use the blue logo.', drawer: 'project', type: 'preference', importance: 9 });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().memory.drawerId, `project:${project.slug}`);
});

test('an agent proposes a memory in the chat; nothing is saved until the owner accepts (review hash)', async () => {
  const before = memories().length;
  script.push(
    [{ message: { content: '', tool_calls: [{ function: { name: 'memory_save', arguments: { content: 'The team meets every Monday at 9', type: 'fact', drawer: 'experience' } } }] } }, { done: true }],
    [{ message: { content: 'Noted, I proposed it.' } }, { done: true }],
  );
  const runId = `run-${randomBytes(6).toString('hex')}`;
  assert.equal((await call('cm-owner', 'POST', `/api/chat/conversations/${conv.id}/runs`, { runId, message: 'Remember: we meet every Monday at 9' })).statusCode, 202);
  await ended(runId);
  const m = (await call('cm-owner', 'GET', `/api/chat/conversations/${conv.id}/messages`)).json().messages.at(-1);
  assert.match(m.parts.find((p) => p.kind === 'tools').calls[0].output, /Proposed to the owner/);
  assert.equal(memories().length, before, 'a routine memory is not saved by itself in a chat');
  let list = (await call('cm-owner', 'GET', url)).json().memories;
  const p = list.find((x) => x.kind === 'proposed');
  assert.equal(p.status, 'pending');
  assert.equal(p.text, 'The team meets every Monday at 9');
  const userMsg = (await call('cm-owner', 'GET', `/api/chat/conversations/${conv.id}/messages`)).json().messages.find((x) => x.role === 'user' && x.runId === runId);
  assert.equal(p.messageId, userMsg.id, 'linked to the owner message that led to it');
  const full = (await call('cm-owner', 'GET', `/api/memory/proposals/${p.proposalId}`)).json();
  assert.ok(full.reasons.includes('chat'));
  assert.equal((await call('cm-owner', 'POST', `/api/memory/proposals/${p.proposalId}/approve`, { expectedReviewHash: '0'.repeat(64) })).statusCode, 409, 'stale review hash');
  assert.equal((await call('cm-owner', 'POST', `/api/memory/proposals/${p.proposalId}/approve`, { expectedReviewHash: full.reviewHash })).statusCode, 200);
  list = (await call('cm-owner', 'GET', url)).json().memories;
  const saved = list.find((x) => x.id === p.id);
  assert.equal(saved.status, 'saved');
  assert.ok(memories().some((x) => x.id === saved.memoryId && x.content === 'The team meets every Monday at 9'));

  // A second proposal is rejected: nothing saved, shown as rejected.
  script.push(
    [{ message: { content: '', tool_calls: [{ function: { name: 'memory_save', arguments: { content: 'Lunch is at noon', drawer: 'experience' } } }] } }, { done: true }],
    [{ message: { content: 'ok' } }, { done: true }],
  );
  const run2 = `run-${randomBytes(6).toString('hex')}`;
  await call('cm-owner', 'POST', `/api/chat/conversations/${conv.id}/runs`, { runId: run2, message: 'lunch at noon' });
  await ended(run2);
  const p2 = (await call('cm-owner', 'GET', url)).json().memories.find((x) => x.kind === 'proposed' && x.status === 'pending');
  const h2 = (await call('cm-owner', 'GET', `/api/memory/proposals/${p2.proposalId}`)).json().reviewHash;
  assert.equal((await call('cm-owner', 'POST', `/api/memory/proposals/${p2.proposalId}/reject`, { expectedReviewHash: h2 })).statusCode, 200);
  assert.equal((await call('cm-owner', 'GET', url)).json().memories.find((x) => x.id === p2.id).status, 'rejected');
  assert.ok(!memories().some((x) => x.content === 'Lunch is at noon'));
});

test('a conflict proposed in the chat and kept new shows as saved with the new text (not removed)', async () => {
  script.push(
    [{ message: { content: '', tool_calls: [{ function: { name: 'memory_save', arguments: { content: 'The team does not meet every Monday at 9', type: 'fact', drawer: 'experience' } } }] } }, { done: true }],
    [{ message: { content: 'Proposed.' } }, { done: true }],
  );
  const runId = `run-${randomBytes(6).toString('hex')}`;
  assert.equal((await call('cm-owner', 'POST', `/api/chat/conversations/${conv.id}/runs`, { runId, message: 'We no longer meet on Mondays' })).statusCode, 202);
  await ended(runId);
  const p = (await call('cm-owner', 'GET', url)).json().memories.find((x) => x.kind === 'proposed' && x.status === 'pending');
  assert.ok(p, 'the change waits for the owner');
  const full = (await call('cm-owner', 'GET', `/api/memory/proposals/${p.proposalId}`)).json();
  assert.ok(full.conflictWith, 'it is a conflict with the saved memory');
  const d = await call('cm-owner', 'POST', `/api/memory/proposals/${p.proposalId}/decide`, { decision: 'keep_new', expectedReviewHash: full.reviewHash });
  assert.equal(d.statusCode, 200, d.body);
  const after = (await call('cm-owner', 'GET', url)).json().memories.find((x) => x.id === p.id);
  assert.equal(after.status, 'saved');
  assert.equal(after.memoryId, full.conflictWith);
  assert.equal(after.text, 'The team does not meet every Monday at 9');
});

test('a forgotten memory shows as removed; deleting the conversation removes its links', async () => {
  const first = (await call('cm-owner', 'GET', url)).json().memories.find((x) => x.kind === 'remembered');
  db.prepare('DELETE FROM memories WHERE id = ?').run(first.memoryId);
  const now = (await call('cm-owner', 'GET', url)).json().memories.find((x) => x.id === first.id);
  assert.deepEqual([now.status, now.memoryId], ['removed', null]);
  assert.equal((await call('cm-owner', 'DELETE', `/api/chat/conversations/${conv.id}`)).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_memory_links WHERE conversation_id = ?').get(conv.id).n, 0);
});
