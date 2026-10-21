// MEM-CACHE-01: reply recall trace, context-pack cache, embedding cache,
// long conversations (rolling summaries) and memory moves.
//  - the second turn is served from the pack cache; edit / forget / a direct
//    database write give a fresh pack (never stale memory);
//  - the trace names what each reply used (pinned, topic, keyword, graph,
//    handoff) and how its context was built; Correct opens a review proposal,
//    Forget removes the memory; owner only;
//  - a turn that answers an outsider stores no trace;
//  - a 200-turn conversation answers about turn 3 through its summaries;
//  - move: owner only, versioned, gated like an edit; agent tool needs approval.
// Throwaway DB/keys; a dead OLLAMA_URL and a stubbed fetch (no real model).
// Run: node --import tsx --test test/memory-recall-cache.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-recall-cache-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
const DEAD = 'http://127.0.0.1:9'; // nothing listens here; fetch is stubbed anyway
process.env.OLLAMA_URL = DEAD;
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['AGENT_EXEC_TOOLS', 'OLLAMA_THINK', 'DEFAULT_MODEL', 'CHAT_NUM_CTX', 'CHAT_CONTEXT_TOKENS', 'CHAT_SUMMARY_TOKENS', 'OLLAMA_KEEP_ALIVE', 'CHAT_SUMMARY_MODEL', 'OUTSIDER_AGENT_MEMORY']) delete process.env[k];

// The stub model: a chat turn answers with the locker code when it is anywhere
// in the prompt; a summary request keeps the sentences that hold a code.
const bodies = [];
const summaryCalls = [];
let embedCalls = 0;
let embedOn = false;
const realFetch = globalThis.fetch;
const stubFetch = async (url, init = {}) => {
  const u = String(url);
  if (u === `${DEAD}/api/embed` && embedOn) {
    embedCalls++;
    const { input } = JSON.parse(init.body);
    return new Response(JSON.stringify({ embeddings: input.map((t) => Array.from({ length: 16 }, (_, i) => ((t.length + i) % 7) / 7 + 0.01)) }), { status: 200 });
  }
  if (u !== `${DEAD}/api/chat`) throw new Error(`unexpected network call in test: ${u}`);
  const body = JSON.parse(init.body);
  if (body.messages?.[0]?.content?.startsWith('Summarise this part of a conversation')) {
    summaryCalls.push(body);
    const text = body.messages.at(-1).content;
    const facts = text.match(/[^.\n]*locker code[^.\n]*\./g) ?? [];
    return new Response(JSON.stringify({ message: { content: `Model summary. ${facts.join(' ')}`.trim() }, done: true }), { status: 200 });
  }
  bodies.push(body);
  const all = body.messages.map((m) => m.content).join('\n');
  const answer = /PINEAPPLE-4242/.test(all) ? 'Your locker code is PINEAPPLE-4242.' : 'ok';
  if (body.stream === false) return new Response(JSON.stringify({ message: { role: 'assistant', content: answer }, done: true }), { status: 200 });
  const lines = [{ message: { content: answer } }, { done: true }];
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + '\n')); c.close(); } }), { status: 200 });
};
globalThis.fetch = stubFetch;
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
for (const [id, role] of [['rc-owner', 'owner'], ['rc-user', 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, role);
}
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('rc-main', 'Main', 'ollama', 'qwen-test', 1)`).run();

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { chatRuns } = await import(join(backendDir, 'src/services/chat-runs.ts'));
const { addUserMessage, addAssistantMessage } = await import(join(backendDir, 'src/repositories/chat-conversations.ts'));
const { saveHandoff } = await import(join(backendDir, 'src/memory/handoff/store.ts'));
const { handoffAgentId } = await import(join(backendDir, 'src/memory/handoff/scope.ts'));
const G = await import(join(backendDir, 'src/memory/graph/index.ts'));
const policy = await import(join(backendDir, 'src/tools/channel-policy.ts'));
const { EmbeddingService } = await import(join(backendDir, 'src/memory/embedding.ts'));
const { memoryMoveTool } = await import(join(backendDir, 'src/tools/memory/move.ts'));
const { approvalCategory } = await import(join(backendDir, 'src/tools/approvals.ts'));
const { DEFAULT_AGENT_TOOLS } = await import(join(backendDir, 'src/tools/grants.ts'));
const { contextBudget } = await import(join(backendDir, 'src/memory/context/budget.ts'));
const app = await buildServer({ logger: false });
await app.ready();

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const as = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const call = (user, method, url, payload) => app.inject({ method, url, headers: as(user), ...(payload ? { payload } : {}) });
const ended = (runId) => new Promise((r) => { const run = chatRuns.get(runId); if (run.status !== 'running') r(); else run.emitter.once('end', r); });
const remember = async (body) => {
  const r = await call('rc-owner', 'POST', '/api/memory', { type: 'fact', importance: 6, ...body });
  assert.equal(r.statusCode, 200, r.body);
  await G.graphIdle();
  return r.json().memory;
};
/** One saved-conversation turn: returns the model request, the reply message and its trace. */
const turn = async (conversationId, message) => {
  const runId = `run-${randomBytes(6).toString('hex')}`;
  const before = bodies.length;
  const r = await call('rc-owner', 'POST', `/api/chat/conversations/${conversationId}/runs`, { runId, message });
  assert.equal(r.statusCode, 202, r.body);
  await ended(runId);
  assert.equal(bodies.length, before + 1, 'one model call');
  const msg = db.prepare("SELECT id, content FROM chat_messages WHERE run_id = ? AND role = 'assistant'").get(runId);
  const tr = await call('rc-owner', 'GET', `/api/memory/recall/messages/${msg.id}`);
  assert.equal(tr.statusCode, 200, tr.body);
  return { body: bodies.at(-1), message: msg, trace: tr.json().trace, runId };
};
const system = (body) => body.messages[0].content;
const why = (trace, id) => trace.items.find((i) => i.id === id)?.why;

const conv = (await call('rc-owner', 'POST', '/api/chat/conversations', { title: 'Daily' })).json().conversation;
let pinned, topic, falconWho, falconWhen, first;

test('pack + recall: the trace names pinned, topic, keyword, graph and handoff items; the model gets a fixed window', async () => {
  pinned = await remember({ content: 'The owner is called Mohamed and likes short answers.', importance: 10 });
  topic = await remember({ type: 'preference', content: 'Editor of choice: Zed', topicKey: 'favorite-editor' });
  falconWho = await remember({ content: 'Sara Lindqvist works on Project Falcon.' });
  falconWhen = await remember({ content: 'Project Falcon ships the mobile beta in March.' });
  await saveHandoff({ ownerId: 'rc-owner', agentId: await handoffAgentId(), kind: 'conversation', scopeId: conv.id, projectId: null },
    { done: ['Set up the repository'], left: [], next: ['Write the release notes'], questions: [] }, 'agent');

  first = await turn(conv.id, 'What is Sara Lindqvist busy with lately?');
  const sys = system(first.body);
  assert.match(sys, /Mohamed and likes short answers/);
  assert.match(sys, /\(favorite-editor\) Editor of choice: Zed/);
  assert.match(sys, /Write the release notes/, 'handoff note in the pack');
  const userMsg = first.body.messages.at(-1).content;
  assert.match(userMsg, /Memory recalled for this message[\s\S]*Sara Lindqvist works on Project Falcon[\s\S]*mobile beta in March[\s\S]*What is Sara Lindqvist busy with lately\?$/);
  assert.doesNotMatch(sys, /Sara Lindqvist/, 'per-message recall stays out of the stable system text');

  const t = first.trace;
  assert.equal(why(t, pinned.id), 'pinned');
  assert.equal(why(t, topic.id), 'topic');
  assert.equal(why(t, falconWho.id), 'keyword');
  assert.equal(why(t, falconWhen.id), 'graph');
  assert.equal(t.items.find((i) => i.kind === 'handoff')?.why, 'handoff');
  assert.equal(t.items.find((i) => i.id === pinned.id).drawer, 'owner');
  assert.equal(t.items.find((i) => i.id === pinned.id).state, 'active');
  assert.match(t.items.find((i) => i.id === pinned.id).preview, /Mohamed/);
  assert.equal(t.messageId, first.message.id);
  assert.equal(t.context.fromCache.pack, false);
  assert.equal(t.context.summarisedTurns, 0);
  assert.equal(t.context.keptTurns, 1);
  assert.ok(t.context.packChars > 0 && t.context.promptTokens > 0);
  assert.equal(typeof t.context.ttftMs, 'number', 'time to first word stored');

  const b = contextBudget();
  assert.equal(first.body.options.num_ctx, b.numCtx);
  assert.equal(first.body.options.num_ctx, 32768);
  assert.equal(first.body.keep_alive, '30m');
  // The same trace by run id (while a reply is running the page only knows the run).
  const byRun = await call('rc-owner', 'GET', `/api/memory/recall/runs/${first.runId}`);
  assert.equal(byRun.json().trace.messageId, first.message.id);
});

test('the second turn is served from the pack cache with the same system text (stable prefix)', async () => {
  const second = await turn(conv.id, 'And what about tomorrow?');
  assert.equal(second.trace.context.fromCache.pack, true);
  assert.equal(system(second.body), system(first.body), 'same system prefix for the model cache');
  // The earlier turns are sent as stored (the recalled block is not repeated in history).
  assert.equal(second.body.messages[1].content, 'What is Sara Lindqvist busy with lately?');
  const m = (await call('rc-owner', 'GET', '/api/memory/cache/metrics')).json();
  assert.ok(m.process.caches.pack.hits >= 1);
  assert.ok(m.process.caches.pack.hitRate > 0);
  assert.ok(m.recent.turns >= 2 && m.recent.packHitRate > 0);
  assert.equal(typeof m.process.ttftMs.p50, 'number');
  assert.equal(m.budget.numCtx, 32768);
  assert.equal(m.budget.promptTokens, 24576);
  assert.equal((await call('rc-user', 'GET', '/api/memory/cache/metrics')).statusCode, 403);
});

test('no stale memory: an edit, a direct database write and a forget each give a fresh pack', async () => {
  assert.equal((await call('rc-owner', 'PUT', `/api/memory/${pinned.id}`, { content: 'The owner is called Mohamed and likes detailed answers.' })).statusCode, 200);
  const edited = await turn(conv.id, 'Hello again');
  assert.equal(edited.trace.context.fromCache.pack, false);
  assert.match(system(edited.body), /likes detailed answers/);
  assert.doesNotMatch(system(edited.body), /likes short answers/);

  // Any write path counts (database triggers), not only the API.
  db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('Editor of choice: Helix', topic.id);
  const direct = await turn(conv.id, 'Which editor?');
  assert.equal(direct.trace.context.fromCache.pack, false);
  assert.match(system(direct.body), /Editor of choice: Helix/);
  assert.doesNotMatch(system(direct.body), /Zed/);

  // Forget from the reply's trace.
  const f = await call('rc-owner', 'POST', `/api/memory/recall/messages/${edited.message.id}/forget`, { memoryId: pinned.id });
  assert.equal(f.statusCode, 200, f.body);
  const after = await turn(conv.id, 'Who am I?');
  assert.doesNotMatch(system(after.body), /Mohamed/);
  assert.equal(after.trace.items.some((i) => i.id === pinned.id), false);
  const old = (await call('rc-owner', 'GET', `/api/memory/recall/messages/${edited.message.id}`)).json().trace;
  const gone = old.items.find((i) => i.id === pinned.id);
  assert.equal(gone.state, 'forgotten');
  assert.equal(gone.preview, undefined, 'no text of a forgotten memory');
  assert.equal(old.items.find((i) => i.id === topic.id).state, 'active');
  // Nothing of the forgotten memory is stored in a trace row.
  for (const r of db.prepare('SELECT items, context FROM memory_recall_traces').all()) assert.doesNotMatch(r.items + r.context, /Mohamed/);
});

test('Correct opens a review proposal; only memories the reply used; owner only', async () => {
  const url = `/api/memory/recall/messages/${first.message.id}/correct`;
  const r = await call('rc-owner', 'POST', url, { memoryId: falconWhen.id, content: 'Project Falcon ships the mobile beta in April.', note: 'moved' });
  assert.equal(r.statusCode, 201, r.body);
  const p = r.json().proposal;
  assert.equal(p.status, 'pending');
  assert.equal(p.source, 'file');
  assert.deepEqual(p.changes.map((c) => [c.op, c.id, c.after.content]), [['update', falconWhen.id, 'Project Falcon ships the mobile beta in April.']]);
  assert.ok(p.reasons.includes('owner-correction'));
  assert.equal(db.prepare('SELECT content FROM memories WHERE id = ?').get(falconWhen.id).content, 'Project Falcon ships the mobile beta in March.', 'nothing changes before approval');
  assert.equal((await call('rc-owner', 'POST', url, { memoryId: 'not-used', content: 'x' })).statusCode, 404);
  assert.equal((await call('rc-owner', 'POST', url, { memoryId: falconWhen.id, content: '' })).statusCode, 400);
  assert.equal((await call('rc-owner', 'POST', url, { memoryId: falconWhen.id, content: 'Project Falcon ships the mobile beta in March.' })).statusCode, 400, 'nothing to change');
  assert.equal((await call('rc-user', 'POST', url, { memoryId: falconWhen.id, content: 'x' })).statusCode, 403);
  assert.equal((await call('rc-user', 'GET', `/api/memory/recall/messages/${first.message.id}`)).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/api/memory/recall/messages/${first.message.id}` })).statusCode, 401);
  assert.equal((await call('rc-owner', 'GET', '/api/memory/recall/messages/no-such-message')).statusCode, 404);
});

test('a turn that answers an outsider stores no trace and loads no memory; an owner /api/chat turn does', async () => {
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM memory_recall_traces').get().n;
  const n = count();
  const t = policy.beginChannelTurn({ channel: 'telegram', conversationId: 'chat-1' }, 'rc-owner');
  try {
    const r = await app.inject({ method: 'POST', url: '/api/chat', headers: { [policy.CHANNEL_TURN_HEADER]: t.token }, payload: { stream: false, messages: [{ role: 'user', content: 'Which editor does the owner use?' }] } });
    assert.equal(r.statusCode, 200, r.body);
  } finally { t.end(); }
  assert.equal(count(), n, 'no trace for a channel turn');
  const all = bodies.at(-1).messages.map((m) => m.content).join('\n');
  assert.doesNotMatch(all, /Helix|Falcon|release notes/, 'no owner memory reaches an outsider');

  const own = await call('rc-owner', 'POST', '/api/chat', { stream: false, messages: [{ role: 'user', content: 'Which editor do I use?' }] });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(count(), n + 1);
  const runId = db.prepare('SELECT run_id FROM memory_recall_traces ORDER BY created_at DESC LIMIT 1').get().run_id;
  const tr = (await call('rc-owner', 'GET', `/api/memory/recall/runs/${runId}`)).json().trace;
  assert.equal(why(tr, topic.id), 'topic');
});

test('a 200-turn conversation answers about turn 3 through its summaries, within the budget', async () => {
  const long = (await call('rc-owner', 'POST', '/api/chat/conversations', { title: 'Long' })).json().conversation;
  const filler = 'We talked about the garden, the weather, the shopping list and the plans for the weekend in some detail. '.repeat(6);
  for (let i = 1; i <= 200; i++) {
    const runId = `run-long-${String(i).padStart(4, '0')}`;
    await addUserMessage(long.id, i === 3 ? `Turn ${i}: My locker code is PINEAPPLE-4242. ${filler}` : `Turn ${i}: ${filler}`, runId);
    await addAssistantMessage(long.id, { runId, content: `Reply ${i}: noted. ${filler}`, parts: [], status: 'complete', durationMs: 1 });
  }
  const before = summaryCalls.length;
  const asked = await turn(long.id, 'What is my locker code?');
  assert.equal(asked.message.content, 'Your locker code is PINEAPPLE-4242.');
  const msgs = asked.body.messages;
  assert.ok(msgs.length < 100, `only the newest turns in full (${msgs.length})`);
  assert.match(system(asked.body), /## Earlier in this conversation[\s\S]*PINEAPPLE-4242/, 'turn 3 reaches the model through a summary');
  assert.equal(msgs.slice(1).some((m) => m.content.includes('PINEAPPLE-4242')), false, 'turn 3 itself is not sent in full');
  const chars = msgs.reduce((n, m) => n + m.content.length, 0);
  assert.ok(chars / 3 <= contextBudget().promptTokens, `prompt within the budget (${Math.round(chars / 3)} tokens)`);
  const ctx = asked.trace.context;
  assert.ok(ctx.summarisedTurns > 300 && ctx.keptTurns > 2, JSON.stringify(ctx));
  assert.equal(ctx.summarisedTurns + ctx.keptTurns + ctx.droppedTurns, 401);
  assert.ok(ctx.summaries.length > 1 && ctx.summaries.every((s) => s.source === 'fallback' || s.source === 'inline'));

  // After the turn the local model rewrites a few fallback summaries (at most 3 per turn).
  for (let i = 0; i < 100 && db.prepare("SELECT COUNT(*) AS n FROM chat_turn_summaries WHERE session_id = ? AND source = 'model'").get(long.id).n < 3; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(summaryCalls.length - before, 3);
  assert.equal(summaryCalls.at(-1).keep_alive, '30m');
  assert.equal(summaryCalls.at(-1).think, false);
  const rows = db.prepare('SELECT level, first_index, source, summary FROM chat_turn_summaries WHERE session_id = ? ORDER BY level, first_index').all(long.id);
  assert.equal(rows.filter((r) => r.source === 'model').length, 3);
  assert.match(rows.find((r) => r.level === 0 && r.first_index === 0).summary, /^Model summary\. .*PINEAPPLE-4242/);

  const again = await turn(long.id, 'Remind me of the locker code, please.');
  assert.equal(again.message.content, 'Your locker code is PINEAPPLE-4242.');
  const view = (await call('rc-owner', 'GET', `/api/memory/recall/conversations/${long.id}/summaries`)).json().summaries;
  assert.ok(view.length >= 3 && view.some((s) => s.source === 'model'));
  assert.equal(view[0].firstTurn, 1);
  assert.equal((await call('rc-user', 'GET', `/api/memory/recall/conversations/${long.id}/summaries`)).statusCode, 403);

  // Deleting the conversation removes its summaries and traces.
  assert.equal((await call('rc-owner', 'DELETE', `/api/chat/conversations/${long.id}`)).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_turn_summaries WHERE session_id = ?').get(long.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_recall_traces WHERE session_id = ?').get(long.id).n, 0);
});

test('embedding cache: one model call per text and model; keys are hashes', async () => {
  embedOn = true;
  try {
    const svc = new EmbeddingService({ mode: 'auto', baseUrl: DEAD, model: 'emb-test' });
    const a = await svc.embedDetailed('cache me');
    const b = await svc.embedDetailed('cache me');
    assert.equal(embedCalls, 1);
    assert.deepEqual(a.vector, b.vector);
    assert.equal(b.model, 'ollama:emb-test');
    assert.notEqual(a.vector, b.vector, 'a copy, never the cached array');
    await svc.embedManyDetailed(['cache me', 'and me', 'and me']);
    assert.equal(embedCalls, 2, 'only the new text is sent');
    const other = new EmbeddingService({ mode: 'auto', baseUrl: DEAD, model: 'emb-other' });
    await other.embedDetailed('cache me');
    assert.equal(embedCalls, 3, 'another model is another key');
    assert.equal(svc.cache.entries, 2);
    svc.cache.clear();
    await svc.embedDetailed('cache me');
    assert.equal(embedCalls, 4);
  } finally { embedOn = false; }
});

test('move: owner only, versioned, same gates (topic key, closed drawers); the agent tool needs approval', async () => {
  const m = await remember({ content: 'The staging server is called birch.' });
  const move = (who, id, body) => call(who, 'POST', `/api/memory/${id}/move`, body);
  const r = await move('rc-owner', m.id, { drawer: 'project:alpha', reason: 'belongs to alpha' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().from, r.json().to, r.json().memory.drawer], ['owner', 'project:alpha', { kind: 'project', key: 'alpha' }]);
  assert.equal(r.json().memory.embedding, undefined);
  const versions = (await call('rc-owner', 'GET', `/api/memory/${m.id}/versions`)).json().versions;
  assert.match(versions.at(-1).reason, /^move:owner->project:alpha: belongs to alpha$/);
  assert.equal(versions.at(-1).drawerKind, 'project');
  assert.equal((await move('rc-owner', m.id, { drawer: 'project:alpha' })).json().code, 'same_drawer');
  assert.equal((await move('rc-owner', m.id, { drawer: 'Project Alpha' })).statusCode, 400);
  assert.equal((await move('rc-owner', 'no-such-memory', { drawer: 'owner' })).statusCode, 404);
  assert.equal((await move('rc-user', m.id, { drawer: 'owner' })).statusCode, 403);
  // The topic key goes with the memory and must be free in the new drawer.
  await remember({ type: 'preference', content: 'Alpha editor: Vim', topicKey: 'favorite-editor', drawer: { kind: 'project', key: 'alpha' } });
  const clash = await move('rc-owner', topic.id, { drawer: 'project:alpha' });
  assert.equal(clash.statusCode, 409);
  assert.equal(clash.json().code, 'topic_key_taken');

  // A moved memory leaves the owner drawer's pack at once.
  await remember({ content: 'Coffee is on the third floor.', importance: 9 });
  const shown = await turn(conv.id, 'Anything else?');
  assert.match(system(shown.body), /Coffee is on the third floor/);
  const coffee = db.prepare("SELECT id FROM memories WHERE content = 'Coffee is on the third floor.'").get().id;
  assert.equal((await move('rc-owner', coffee, { drawer: 'project:beta' })).statusCode, 200);
  const moved = await turn(conv.id, 'Anything more?');
  assert.doesNotMatch(system(moved.body), /Coffee is on the third floor/);
  assert.equal(moved.trace.context.fromCache.pack, false);
  // The old trace shows where it went.
  const old = (await call('rc-owner', 'GET', `/api/memory/recall/messages/${shown.message.id}`)).json().trace.items.find((i) => i.id === coffee);
  assert.deepEqual([old.state, old.nowIn], ['moved', 'project:beta']);

  // Agent tool: needs a one-time owner approval, is offered by default, and keeps the gates.
  assert.equal(approvalCategory({ name: 'memory_move' }), 'other');
  assert.ok(DEFAULT_AGENT_TOOLS.includes('memory_move'));
  const ctx = (drawers, extra = {}) => ({ workspaceDir: dir, userId: 'rc-owner', agentId: 'rc-main', memoryDrawers: drawers, ...extra });
  const closed = await memoryMoveTool.execute({ id: coffee, drawer: 'owner' }, ctx([{ kind: 'owner' }]));
  assert.match(closed.error, /not open/);
  const outsider = await memoryMoveTool.execute({ id: coffee, drawer: 'owner' }, ctx([{ kind: 'owner' }, { kind: 'project', key: 'beta' }], { toolPolicy: policy.createChannelToolPolicy({ channel: 'telegram' }) }));
  assert.match(outsider.error, /someone else/);
  const bad = await memoryMoveTool.execute({ id: coffee, drawer: '../x' }, ctx([{ kind: 'owner' }]));
  assert.match(bad.error, /drawer must be/);
  const ok = await memoryMoveTool.execute({ id: coffee, drawer: 'owner', reason: 'shared fact' }, ctx([{ kind: 'owner' }, { kind: 'project', key: 'beta' }]));
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.deepEqual([ok.data.from, ok.data.to], ['project:beta', 'owner']);
  const last = (await call('rc-owner', 'GET', `/api/memory/${coffee}/versions`)).json().versions.at(-1);
  assert.equal(last.createdBy, 'agent:rc-main');
  const member = await memoryMoveTool.execute({ id: coffee, drawer: 'experience' }, { workspaceDir: dir, userId: 'rc-user', agentId: 'rc-main', memoryDrawers: [{ kind: 'owner' }, { kind: 'experience' }] });
  assert.ok(member.error, 'only the owner moves memory');
});

test('chat: an invalid memoryScope is refused with 400 before the stream opens', async () => {
  const r = await call('rc-owner', 'POST', '/api/chat', { messages: [{ role: 'user', content: 'hi' }], memoryScope: { project: 'Not A Slug' } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'Invalid memoryScope');
});

test('wire contract: the UI allow-list and projections match the real responses', async () => {
  const C = await import(join(backendDir, '../core-ui/src/memory-recall-contract.js'));
  const path = C.recallMessagePath(first.message.id);
  assert.ok(C.allowedMemoryRecall('GET', path));
  assert.equal(C.allowedMemoryRecall('GET', path, {}), false);
  assert.equal(C.allowedMemoryRecall('DELETE', path), false);
  const res = await call('rc-owner', 'GET', path);
  const view = C.memoryRecallResponse(path, res.statusCode, res.json());
  assert.equal(view.trace.messageId, first.message.id);
  assert.deepEqual(view.trace.items.map((i) => i.why).sort(), first.trace.items.map((i) => i.why).sort());
  assert.equal(view.trace.context.numCtx, 32768);
  const forgotten = (await call('rc-owner', 'GET', C.recallMessagePath(first.message.id))).json();
  assert.equal(C.memoryRecallResponse(path, 200, forgotten).trace.items.find((i) => i.id === pinned.id).preview, undefined);

  const correct = C.recallCorrectPath(first.message.id);
  assert.ok(C.allowedMemoryRecall('POST', correct, { memoryId: falconWho.id, content: 'Sara Lindqvist leads Project Falcon.' }));
  for (const bad of [{ memoryId: falconWho.id }, { memoryId: falconWho.id, content: 'x', extra: 1 }, { memoryId: '../x', content: 'x' }, { memoryId: falconWho.id, content: 'a\u0007b' }]) {
    assert.equal(C.allowedMemoryRecall('POST', correct, bad), false, JSON.stringify(bad));
  }
  const pr = await call('rc-owner', 'POST', correct, { memoryId: falconWho.id, content: 'Sara Lindqvist leads Project Falcon.' });
  const pv = C.memoryRecallResponse(correct, pr.statusCode, pr.json());
  assert.equal(pv.proposal.status, 'pending');
  assert.match(pv.proposal.reviewHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(C.memoryRecallResponse(correct, 404, { error: 'This reply did not use that memory', code: 'not_in_trace' }), { code: 'not_in_trace' });

  const metrics = await call('rc-owner', 'GET', C.CACHE_METRICS_PATH);
  const mv = C.memoryRecallResponse(C.CACHE_METRICS_PATH, 200, metrics.json());
  assert.ok(mv.process.caches.pack.hits >= 1);
  assert.equal(mv.budget.keepAlive, '30m');

  const m = await remember({ content: 'The printer is next to the kitchen.' });
  const move = C.memoryMovePath(m.id);
  assert.ok(C.allowedMemoryRecall('POST', move, { drawer: 'experience' }));
  assert.equal(C.allowedMemoryRecall('POST', move, { drawer: 'Not A Drawer' }), false);
  const moved = await call('rc-owner', 'POST', move, { drawer: 'experience' });
  assert.deepEqual(C.memoryRecallResponse(move, 200, moved.json()), { memoryId: m.id, from: 'owner', to: 'experience' });
  assert.equal(C.memoryRecallPath('/api/memory/recall/messages/x'), null, 'short ids are not ours');
});
