// CORE-MEM-HANDOFF: an agent leaves "done / left / next / open questions" for its next session.
//  - the agent writes it with handoff_save in a saved chat (secrets never stored, versioned);
//  - the next turn of the same agent in the same conversation (or project) gets it in its prompt;
//  - another agent, another user and a channel (outside) turn never see it or get the tools;
//  - an idle conversation / ended board task run without a note gets one generated note
//    (local model JSON, or a plain fallback when no model answers), once;
//  - owner-only read/edit API (an edit is a new version the next session starts from).
// Throwaway DB/keys; the local model is stubbed (no network).
// Run: node --import tsx --test test/agent-handoff.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-handoff-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
for (const k of ['AGENT_EXEC_TOOLS', 'OLLAMA_THINK', 'DEFAULT_MODEL', 'HANDOFF_IDLE_MINUTES']) delete process.env[k];

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const script = [];
const bodies = [];
/** What the stubbed local model answers to a background summary (null = no model answers). */
let summaryAnswer = null;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === 'http://127.0.0.1:11434/api/chat') {
    bodies.push(JSON.parse(init.body));
    const lines = script.shift() ?? [{ message: { content: 'ok' }, done: true }];
    const enc = new TextEncoder();
    return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + '\n')); c.close(); } }), { status: 200 });
  }
  if (u === 'http://127.0.0.1:11434/api/generate' && summaryAnswer !== null) {
    return new Response(JSON.stringify({ response: summaryAnswer }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`unexpected network call in test: ${u}`);
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
for (const [id, role] of [['ho-owner', 'owner'], ['ho-user', 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, role);
}
for (const [id, name, primary] of [['ho-main', 'Main', 1], ['ho-writer', 'Writer', 0], ['ho-coder', 'Coder', 0]]) {
  db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES (?, ?, 'ollama', 'qwen-test', ?)`).run(id, name, primary);
}

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { chatRuns } = await import(join(backendDir, 'src/services/chat-runs.ts'));
const { createProject } = await import(join(backendDir, 'src/repositories/chat-conversations.ts'));
const { createAgentToolsRegistry } = await import(join(backendDir, 'src/tools/index.ts'));
const store = await import(join(backendDir, 'src/memory/handoff/store.ts'));
const scopes = await import(join(backendDir, 'src/memory/handoff/scope.ts'));
const gen = await import(join(backendDir, 'src/memory/handoff/generate.ts'));
const app = await buildServer({ logger: false });
await app.ready();

const as = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const call = (user, method, url, payload) => app.inject({ method, url, headers: as(user), ...(payload ? { payload } : {}) });
const ended = (runId) => new Promise((r) => { const run = chatRuns.get(runId); if (run.status !== 'running') r(); else run.emitter.once('end', r); });
const newConv = async (user, body = {}) => (await call(user, 'POST', '/api/chat/conversations', body)).json().conversation;
/** One chat turn; returns the system prompt the model got and the tools it was offered. */
async function turn(user, conv, message, { agentId, lines = [] } = {}) {
  script.push(...lines);
  const from = bodies.length;
  const runId = `run-${randomBytes(6).toString('hex')}`;
  const r = await call(user, 'POST', `/api/chat/conversations/${conv.id}/runs`, { runId, message, ...(agentId ? { agentId } : {}) });
  assert.equal(r.statusCode, 202, r.body);
  await ended(runId);
  const first = bodies[from];
  return { runId, system: String(first?.messages?.find((m) => m.role === 'system')?.content ?? ''), tools: (first?.tools ?? []).map((t) => t.function?.name ?? t.name) };
}
const toolCall = (name, args) => [{ message: { content: '', tool_calls: [{ function: { name, arguments: args } }] } }, { done: true }];
const say = (text) => [{ message: { content: text } }, { done: true }];
const rows = (where = '1 = 1', ...args) => db.prepare(`SELECT * FROM agent_handoffs WHERE ${where} ORDER BY created_at, version`).all(...args);
const BLOCK = '## Handoff from your last session';

const conv = await newConv('ho-owner', { title: 'Launch', agentId: 'ho-writer' });

test('an agent saves its handoff in a chat; secrets are never stored; the next turn starts from it', async () => {
  const first = await turn('ho-owner', conv, 'Plan the launch page', {
    lines: [toolCall('handoff_save', { done: ['Drafted the launch plan'], left: ['Pricing section'], next: ['Write the pricing copy'], questions: [`Which currency? key ${SECRET}`] }), say('Saved my notes.')],
  });
  assert.ok(first.tools.includes('handoff_save') && first.tools.includes('handoff_read'), 'offered in the owner\'s own chat');
  assert.doesNotMatch(first.system, new RegExp(BLOCK), 'no note before the first one');
  const saved = rows('scope_id = ?', conv.id);
  assert.equal(saved.length, 1);
  assert.deepEqual([saved[0].owner_id, saved[0].agent_id, saved[0].scope_kind, saved[0].source, saved[0].version, saved[0].run_id], ['ho-owner', 'ho-writer', 'conversation', 'agent', 1, first.runId]);
  assert.doesNotMatch(JSON.stringify(saved[0]), /ghp_/, 'the secret is never stored');
  assert.match(saved[0].open_questions, /\[REDACTED:github_token\]/);

  const next = await turn('ho-owner', conv, 'Go on');
  assert.match(next.system, new RegExp(BLOCK));
  assert.match(next.system, /written by you/);
  assert.match(next.system, /Next:\n- Write the pricing copy/);
  assert.match(next.system, /Left:\n- Pricing section/);
  assert.doesNotMatch(next.system, /ghp_/);
  const full = store.cleanHandoff({ done: Array(8).fill('x'.repeat(400)), left: Array(8).fill('y'.repeat(400)), next: Array(8).fill('z'.repeat(400)) });
  assert.ok(full.done.every((i) => i.length <= store.MAX_ITEM_CHARS), 'items are cut');
  const big = store.handoffBlock({ ...saved[0], ...full, questions: [], source: 'agent', createdAt: saved[0].created_at });
  assert.ok(big.length <= store.MAX_BLOCK_CHARS && big.endsWith('[…shortened]'), 'the prompt block is size-limited');

  // A second save is a new version; handoff_read shows the newest.
  const third = await turn('ho-owner', conv, 'Update your notes', {
    lines: [toolCall('handoff_save', { done: ['Pricing copy written'], next: ['Ask for review'] }), toolCall('handoff_read', {}), say('Done.')],
  });
  assert.deepEqual(rows('scope_id = ?', conv.id).map((r) => r.version), [1, 2]);
  const readBack = bodies.slice(-1)[0].messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
  assert.match(readBack, /Pricing copy written/);
  assert.equal(third.runId.length > 0, true);
});

test('another agent, another user and another conversation never see it; a project conversation continues from it', async () => {
  const coder = await turn('ho-owner', conv, 'Coder, look at this', { agentId: 'ho-coder' });
  assert.doesNotMatch(coder.system, new RegExp(BLOCK), 'another agent in the same conversation');
  assert.equal(await scopes.conversationHandoffText('ho-user', conv.id, 'ho-writer'), '', 'another user, even with the conversation id');

  const mine = await newConv('ho-user', { agentId: 'ho-writer' });
  const userTurn = await turn('ho-user', mine, 'Hello');
  assert.doesNotMatch(userTurn.system, new RegExp(BLOCK), "another user's conversation with the same agent");

  const other = await newConv('ho-owner', { agentId: 'ho-writer' });
  assert.doesNotMatch((await turn('ho-owner', other, 'Hi')).system, new RegExp(BLOCK), 'a conversation outside any project starts fresh');

  const project = await createProject('ho-owner', { name: 'Shop' });
  const p1 = await newConv('ho-owner', { agentId: 'ho-writer', projectId: project.id });
  await turn('ho-owner', p1, 'Start the shop', { lines: [toolCall('handoff_save', { done: ['Chose the theme'], next: ['Add products'] }), say('ok')] });
  const p2 = await newConv('ho-owner', { agentId: 'ho-writer', projectId: project.id });
  const cont = await turn('ho-owner', p2, 'Continue the shop');
  assert.match(cont.system, /from an earlier conversation in this project/);
  assert.match(cont.system, /Add products/);
  const p3 = await newConv('ho-owner', { agentId: 'ho-coder', projectId: project.id });
  assert.doesNotMatch((await turn('ho-owner', p3, 'Hi')).system, new RegExp(BLOCK), 'another agent in the same project');
});

test('channel (outside) turns never get the tools or a note', async () => {
  const toolPolicy = { kind: 'channel', channel: 'telegram', conversationId: 'tg-1', allowedDestinations: [], allowedTools: new Set(['handoff_save', 'handoff_read']) };
  const registry = await createAgentToolsRegistry({ userId: 'ho-owner', sessionId: conv.id, agentId: 'ho-writer', workspaceDir: dir, toolPolicy, chatPlan: false });
  assert.deepEqual(registry.getAll().map((t) => t.name).filter((n) => n.startsWith('handoff_')), [], 'not offered, even when the owner opted the names in');
  const before = rows().length;
  const r = await registry.execute('handoff_save', { done: ['from a stranger'] });
  assert.ok(r.error, 'refused');
  assert.equal(rows().length, before, 'nothing saved');
  assert.equal(typeof await scopes.toolHandoffScope({ userId: 'ho-owner', sessionId: conv.id, agentId: 'ho-writer', chatPlan: true, toolPolicy, workspaceDir: dir }), 'string');
  // A plain chat run without a saved conversation (legacy /api/chat session ids) keeps no note either.
  const legacy = await createAgentToolsRegistry({ userId: 'ho-owner', sessionId: 'not-a-saved-conversation', agentId: 'ho-writer', workspaceDir: dir, chatPlan: true });
  assert.ok((await legacy.execute('handoff_save', { done: ['x'] })).error);
  // Only the saved-conversation route and the task-run executor put a note into a prompt.
  const users = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts') && /HandoffText\(/.test(readFileSync(p, 'utf8'))) users.push(p.slice(backendDir.length + 1)); } };
  walk(join(backendDir, 'src'));
  assert.deepEqual(users.sort(), ['src/api/routes/chat-conversations.ts', 'src/memory/handoff/scope.ts', 'src/services/task-run-executor.ts']);
});

test('an idle conversation without a note gets one generated note, once; the agent\'s own note is kept', async () => {
  const idle = await newConv('ho-owner', { agentId: 'ho-coder' });
  const t = await turn('ho-owner', idle, `Fix the login bug, the key is ${SECRET}`, { lines: [say('I found the cause in session.ts; the fix is not written yet.')] });
  const later = Date.now() + 2 * 60 * 60_000;
  const seen = [];
  const summarize = async (input) => { seen.push(input); return { body: store.cleanHandoff({ done: ['Found the cause in session.ts'], left: ['Write the fix'], next: ['Patch session.ts'] }), source: 'model' }; };

  assert.deepEqual(await gen.sweepHandoffs({ now: Date.now(), summarize, limit: 50 }), { conversations: 0, tasks: 0 }, 'not idle yet');
  const first = await gen.sweepHandoffs({ now: later, summarize, limit: 50 });
  assert.ok(first.conversations >= 1);
  const note = rows('scope_id = ? AND agent_id = ?', idle.id, 'ho-coder');
  assert.equal(note.length, 1);
  assert.deepEqual([note[0].source, note[0].run_id, note[0].owner_id], ['model', t.runId, 'ho-owner']);
  const input = seen.find((s) => s.transcript.includes('Fix the login bug'));
  assert.ok(input, 'the summary sees the conversation');
  assert.doesNotMatch(input.transcript, /ghp_/, 'secrets are redacted before the model sees them');
  assert.deepEqual(await gen.sweepHandoffs({ now: later, summarize, limit: 50 }), { conversations: 0, tasks: 0 }, 'once per run');

  // The conversation whose last turn saved the agent's own note gets nothing generated.
  const own = await newConv('ho-owner', { agentId: 'ho-writer' });
  await turn('ho-owner', own, 'Note it', { lines: [toolCall('handoff_save', { next: ['Send the invoice'] }), say('ok')] });
  await gen.sweepHandoffs({ now: later + 1, summarize, limit: 50 });
  assert.deepEqual(rows('scope_id = ?', own.id).map((r) => r.source), ['agent']);

  // The next turn starts from the generated note.
  assert.match((await turn('ho-owner', idle, 'Continue')).system, /summarized automatically[\s\S]*Patch session\.ts/);
});

test('the local model writes the summary as JSON; when no model answers a plain fallback is kept', async () => {
  const fallback = { done: ['Last reply: x'], left: [], next: ['y'], questions: [] };
  summaryAnswer = `Sure! {"done": ["Built the form"], "remaining": ["Validation"], "next": ["Add tests ${SECRET}"], "questions": []}`;
  const ok = await gen.localModelSummarizer({ kind: 'conversation', transcript: 'Owner: build the form', fallback });
  assert.equal(ok.source, 'model');
  assert.deepEqual(ok.body.left, ['Validation']);
  assert.doesNotMatch(JSON.stringify(ok.body), /ghp_/);
  summaryAnswer = 'not json at all';
  assert.deepEqual(await gen.localModelSummarizer({ kind: 'conversation', transcript: 't', fallback }), { body: fallback, source: 'fallback' });
  summaryAnswer = null; // no model answers (connection refused)
  assert.deepEqual(await gen.localModelSummarizer({ kind: 'conversation', transcript: 't', fallback }), { body: fallback, source: 'fallback' });

  const quietConv = await newConv('ho-owner', { agentId: 'ho-main' });
  await turn('ho-owner', quietConv, 'Book the venue for Friday', { lines: [say('I will look at three venues.')] });
  await gen.sweepHandoffs({ now: Date.now() + 3 * 60 * 60_000, limit: 50 });
  const note = rows('scope_id = ?', quietConv.id);
  assert.equal(note.length, 1);
  assert.equal(note[0].source, 'fallback');
  assert.match(note[0].next_steps, /Book the venue for Friday/);
  assert.match(note[0].done, /three venues/);
});

test('a board task run that ends without a note gets one; the next run of that task starts from it', async () => {
  const insertRun = (id, taskId, agentId, status, extra = {}) => db.prepare(`INSERT INTO task_runs (id, task_id, agent_id, user_id, status, status_reason, max_steps, max_duration_ms, output_preview, finished_at)
    VALUES (?, ?, ?, NULL, ?, ?, 10, 60000, ?, datetime('now'))`).run(id, taskId, agentId, status, extra.reason ?? null, extra.output ?? null);
  insertRun('tr-done-1', 'task-report', 'ho-writer', 'completed', { output: 'Weekly report sent to the team' });
  insertRun('tr-fail-1', 'task-sync', 'ho-coder', 'failed', { reason: `API refused ${SECRET}` });
  insertRun('tr-small-1', 'task-lookup', 'small-local-agent', 'completed', { output: 'x' });
  summaryAnswer = null;
  const n = await gen.sweepHandoffs({ now: Date.now(), limit: 50 });
  assert.equal(n.tasks, 2, 'one note per ended run; none for the small agent');
  const report = rows("scope_kind = 'task' AND scope_id = 'task-report'");
  assert.deepEqual([report[0].owner_id, report[0].agent_id, report[0].source, report[0].run_id], ['ho-owner', 'ho-writer', 'fallback', 'tr-done-1'], 'board runs belong to the instance owner');
  assert.match(report[0].done, /Weekly report sent/);
  const sync = rows("scope_id = 'task-sync'")[0];
  assert.match(sync.remaining, /API refused \[REDACTED:github_token\]/);
  assert.equal(rows("scope_id = 'task-lookup'").length, 0);
  assert.equal((await gen.sweepHandoffs({ now: Date.now(), limit: 50 })).tasks, 0, 'once');

  const block = await scopes.taskHandoffText({ task_id: 'task-report', agent_id: 'ho-writer', user_id: null });
  assert.match(block, /Weekly report sent/);
  assert.equal(await scopes.taskHandoffText({ task_id: 'task-report', agent_id: 'ho-coder', user_id: null }), '', 'another agent');
  assert.equal(await scopes.taskHandoffText({ task_id: 'task-report', agent_id: 'ho-writer', user_id: 'ho-user' }), '', 'another owner');

  // Inside a task run the agent has the tools and writes to the task's note.
  insertRun('tr-live-1', 'task-report', 'ho-writer', 'running');
  const registry = await createAgentToolsRegistry({ userId: 'ho-writer', sessionId: 'cron-task-report', agentId: 'ho-writer', taskId: 'task-report', workspaceDir: dir });
  assert.ok(registry.getAll().some((t) => t.name === 'handoff_save'));
  registry.updateContext({ taskRun: { runId: 'tr-live-1', stepIndex: 3, idempotencyKey: 'k' } });
  const saved = await registry.execute('handoff_save', { next: ['Send next week\'s report on Monday'] });
  assert.ok(!saved.error, saved.content?.[0]?.text);
  assert.match(await scopes.taskHandoffText({ task_id: 'task-report', agent_id: 'ho-writer', user_id: null }), /written by you[\s\S]*Monday/);
  const small = await createAgentToolsRegistry({ userId: 'small-local-agent', sessionId: 'cron-x', agentId: 'small-local-agent', taskId: 'task-lookup', workspaceDir: dir });
  assert.ok(!small.getAll().some((t) => t.name.startsWith('handoff_')), 'the small agent keeps no note');
});

test('owner-only API: list, read with history, edit as a new version', async () => {
  const path = `/api/handoffs/conversation/${conv.id}`;
  assert.equal((await app.inject({ method: 'GET', url: '/api/handoffs' })).statusCode, 401);
  assert.equal((await call('ho-user', 'GET', '/api/handoffs')).statusCode, 403);
  assert.equal((await call('ho-user', 'GET', `${path}?agentId=ho-writer`)).statusCode, 403);
  assert.equal((await call('ho-user', 'PUT', path, { agentId: 'ho-writer', done: ['x'] })).statusCode, 403);

  const list = (await call('ho-owner', 'GET', '/api/handoffs?agentId=ho-writer')).json().handoffs;
  assert.ok(list.some((h) => h.scopeId === conv.id && h.version === 2), 'newest version per scope');
  assert.ok(list.every((h) => h.agentId === 'ho-writer'));
  const one = (await call('ho-owner', 'GET', `${path}?agentId=ho-writer`)).json();
  assert.equal(one.handoff.version, 2);
  assert.deepEqual(one.history.map((h) => h.version), [2, 1]);

  const r = await call('ho-owner', 'PUT', path, { agentId: 'ho-writer', done: ['Pricing approved'], next: [`Publish on Monday ${SECRET}`] });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().handoff.version, r.json().handoff.source], [3, 'owner']);
  assert.doesNotMatch(r.body, /ghp_/);
  assert.match((await turn('ho-owner', conv, 'Next?')).system, /edited by the owner[\s\S]*Publish on Monday/);

  for (const [body, why] of [[{ agentId: 'ho-writer' }, 'empty'], [{ done: ['x'] }, 'no agent'], [{ agentId: 'ho-writer', done: 'x'.repeat(10) , extra: 1 }, 'unknown field'],
    [{ agentId: 'ho-writer', done: Array(9).fill('x') }, 'too many items'], [{ agentId: 'ho-writer', done: [1] }, 'not text']]) {
    assert.equal((await call('ho-owner', 'PUT', path, body)).statusCode, 400, why);
  }
  assert.equal((await call('ho-owner', 'GET', '/api/handoffs/other/x?agentId=ho-writer')).statusCode, 400);
  const theirs = (await call('ho-user', 'POST', '/api/chat/conversations', {})).json().conversation;
  assert.equal((await call('ho-owner', 'GET', `/api/handoffs/conversation/${theirs.id}?agentId=ho-writer`)).statusCode, 404, "another user's conversation looks missing");
  assert.equal((await call('ho-owner', 'PUT', `/api/handoffs/conversation/${theirs.id}`, { agentId: 'ho-writer', done: ['x'] })).statusCode, 404);
  assert.equal((await call('ho-owner', 'GET', '/api/handoffs/task/no-such-task?agentId=ho-writer')).statusCode, 404);
  assert.equal((await call('ho-owner', 'GET', '/api/handoffs/task/task-report?agentId=ho-writer')).json().handoff.scopeId, 'task-report');
});
