// MCP-01: small-agent runs (owner-only API used by the Agent Player MCP server).
// Owner-only, tools = requested ∩ safe set ∩ grants (never exec/approval tools),
// drawers subset, low budget, concurrency refusal, result card.
// Throwaway DB/keys; the local Ollama model is stubbed (no network, no port).
// Run: node --import tsx --test test/small-agent-runs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-small-agent-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
for (const k of ['AGENT_EXEC_TOOLS', 'SMALL_AGENT_MAX_STEPS', 'SMALL_AGENT_MAX_DURATION_MS', 'SMALL_AGENT_MAX_CONCURRENT', 'SMALL_AGENT_MODEL', 'DEFAULT_MODEL', 'LOCAL_MODEL_NAME', 'OLLAMA_THINK']) delete process.env[k];

// --- stubbed local model ------------------------------------------------------
// The first user message carries "SCENARIO:<name>"; the reply depends on the
// scenario and on how many tool results the conversation already has.
const modelCalls = [];
const gates = new Map(); // scenario -> { promise, release }
function gate(name) {
  let release;
  const promise = new Promise((r) => { release = r; });
  gates.set(name, { promise, release });
}
const call = (name, args) => ({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } });
const say = (text) => ({ message: { role: 'assistant', content: text } });
function script(sc, toolTurns) {
  switch (sc) {
    case 'lookup': return toolTurns === 0 ? call('memory_search', { query: 'release date' }) : say('Release is on Friday.\nFound in the project notes.');
    case 'draft': return say('Draft: Hello team,\nthe release moves to Friday.');
    case 'escalate': return toolTurns === 0 ? call('exec', { command: 'id' }) : toolTurns === 1 ? call('read', { path: 'package.json' }) : say('Could not do it.');
    case 'loop': return call('memory_search', { query: `q${toolTurns}` });
    default: return say(`ok ${sc}`);
  }
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== 'http://127.0.0.1:11434/api/chat') throw new Error(`unexpected network call in test: ${url}`);
  const body = JSON.parse(init.body);
  const user = body.messages.find((m) => m.role === 'user');
  const sc = /SCENARIO:(\w+)/.exec(user?.content ?? '')?.[1] ?? '?';
  const toolTurns = body.messages.filter((m) => m.role === 'tool').length;
  modelCalls.push({ sc, toolTurns, body });
  const g = gates.get(sc);
  if (g) await g.promise;
  return new Response(JSON.stringify({ model: body.model, ...script(sc, toolTurns) }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const quiet = { log: console.log, warn: console.warn, info: console.info };
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`)
  .run(id, `${id}@example.test`, id, role);
addUser('sa-owner', 'owner');
addUser('sa-admin', 'admin');
addUser('sa-member', 'user');
addUser('sa-guest', 'guest');

const tools = await import(join(backendDir, 'src/tools/index.ts'));
// An exec-class tool and an approval-gated tool, both "safe-looking" names.
tools.registerExtensionTool({ name: 'sa_exec', description: 'exec-class stub', extensionId: 'sa-test', execClass: true,
  input_schema: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'ran' }] }) });
tools.registerExtensionTool({ name: 'sa_needs_ok', description: 'approval stub', extensionId: 'sa-test', requiresApproval: true,
  input_schema: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'ran' }] }) });

const grants = await import(join(backendDir, 'src/tools/grants.ts'));
const small = await import(join(backendDir, 'src/services/small-agent.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const bearer = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });

console.log = quiet.log;
console.info = quiet.info;
console.warn = quiet.warn;

test.after(async () => {
  for (const g of gates.values()) g.release();
  globalThis.fetch = realFetch;
  try { await app.close(); } catch { /* ignore */ }
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

// --- helpers -----------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spawn = (payload, who = 'sa-owner') => app.inject({ method: 'POST', url: '/api/small-agent/runs', headers: bearer(who), payload });
const card = async (id) => (await app.inject({ method: 'GET', url: `/api/small-agent/runs/${id}`, headers: bearer('sa-owner') })).json().card;
async function finalCard(id, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const c = await card(id);
    if (['completed', 'failed', 'cancelled', 'waiting_approval'].includes(c.status)) return c;
    await sleep(20);
  }
  throw new Error(`run ${id} did not finish`);
}
const available = () => tools.createToolsRegistry({ workspaceDir: dir }).listRegistered();

// --- tests ---------------------------------------------------------------------

test('only the owner can spawn, list or read small-agent runs', async () => {
  const urls = [
    ['POST', '/api/small-agent/runs', { task: 'SCENARIO:x' }],
    ['GET', '/api/small-agent/runs'],
    ['GET', '/api/small-agent/runs/00000000-0000-0000-0000-000000000000'],
  ];
  for (const [method, url, payload] of urls) {
    const anon = await app.inject({ method, url, payload });
    assert.equal(anon.statusCode, 401, `${method} ${url} anonymous`);
    for (const who of ['sa-admin', 'sa-member', 'sa-guest']) {
      const res = await app.inject({ method, url, headers: bearer(who), payload });
      assert.equal(res.statusCode, 403, `${method} ${url} as ${who}`);
    }
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM small_agent_runs').get().n, 0, 'nothing was created');
});

test('input is validated', async () => {
  for (const payload of [{}, { task: '' }, { task: 'x'.repeat(8001) }, { task: 'SCENARIO:x', tools: 'read' }, { task: 'SCENARIO:x', tools: ['bad name'] },
    { task: 'SCENARIO:x', kind: 'payment' }, { task: 'SCENARIO:x', max_steps: 0 }, { task: 'SCENARIO:x', drawers: ['nope:1'] }, { task: 'SCENARIO:x', drawers: ['project:Bad Key'] }]) {
    const res = await spawn(payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload).slice(0, 80));
  }
});

test('a lookup run: local model, safe default tools, low budget, clean informational card', async () => {
  const res = await spawn({ task: 'SCENARIO:lookup When is the release?', kind: 'lookup' });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.deepEqual(body.granted_tools, ['memory_search', 'storage_search'], 'nothing requested -> memory_search + storage_search, no read');
  assert.deepEqual(body.drawers, [], 'nothing requested -> no drawers');
  assert.deepEqual(body.budget, { max_steps: 15, max_duration_ms: 300_000 });
  assert.equal(body.model, 'qwen3.5:9b');

  const agent = db.prepare('SELECT provider, model FROM agents_config WHERE id = ?').get(small.SMALL_AGENT_ID);
  assert.deepEqual({ ...agent }, { provider: 'ollama', model: 'qwen3.5:9b' });

  const c = await finalCard(body.run_id);
  assert.equal(c.status, 'completed', JSON.stringify(c));
  assert.equal(c.summary, 'Release is on Friday.');
  assert.match(c.outputs[0].text, /project notes/);
  assert.equal(c.steps_used, 3, 'model, tool, model');
  assert.deepEqual(c.tools_used, ['memory_search']);
  assert.equal(c.model, 'qwen3.5:9b');
  assert.equal(c.needs_review, false);
  assert.deepEqual(c.warnings, []);
  assert.ok(c.duration_ms >= 0);

  // The model was offered only the granted tools.
  const first = modelCalls.find((m) => m.sc === 'lookup');
  assert.deepEqual(first.body.tools.map((t) => t.function.name).sort(), ['memory_search', 'storage_search']);
  assert.equal(first.body.stream, false);
  // The task text is not in the orchestrator task (only in the encrypted run input).
  const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(body.run_id);
  const task = getOrchestrator().getTask(run.task_id);
  assert.ok(!JSON.stringify({ t: task.title, d: task.description }).includes('When is the release'));
  assert.equal(run.user_id, 'sa-owner');
});

test('a draft always needs review', async () => {
  const res = await spawn({ task: 'SCENARIO:draft write a note', kind: 'draft' });
  const c = await finalCard(res.json().run_id);
  assert.equal(c.status, 'completed');
  assert.equal(c.needs_review, true);
  assert.match(c.review_reason, /not purely informational/);
  const other = await finalCard((await spawn({ task: 'SCENARIO:plain' })).json().run_id);
  assert.equal(other.kind, 'other');
  assert.equal(other.needs_review, true, 'kind defaults to other -> review');
});

test('granted tools = requested ∩ safe set ∩ grants; never exec or approval-gated tools', async () => {
  const res = await spawn({ task: 'SCENARIO:plain', tools: ['memory_search', 'read', 'exec', 'write', 'memory_save', 'memory_forget', 'telegram_send', 'sa_exec', 'sa_needs_ok', 'web_fetch'] });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.deepEqual(body.granted_tools, ['memory_search', 'read']);
  for (const t of ['exec', 'write', 'memory_save', 'memory_forget', 'telegram_send', 'sa_exec', 'sa_needs_ok', 'web_fetch']) {
    assert.ok(body.warnings.some((w) => w.includes(`"${t}"`)), `warning for ${t}`);
  }
  await finalCard(body.run_id);

  // Even if the owner granted exec/approval tools to the small agent, they are never delegated.
  const reg = tools.createToolsRegistry({ workspaceDir: dir });
  const ownGrants = grants.staticGrants(['memory_search', 'read', 'sa_exec', 'sa_needs_ok', 'exec', 'telegram_send']);
  const r = small.resolveSmallAgentTools(['sa_exec', 'sa_needs_ok', 'exec', 'telegram_send', 'read'], reg.listRegistered(), ownGrants);
  assert.deepEqual(r.granted, ['read']);
  // A safe-set name that is exec-class or approval-gated on this server is dropped too.
  const fake = [{ name: 'memory_search', execClass: true }, { name: 'storage_search', requiresApproval: true }, { name: 'read' }];
  const r2 = small.resolveSmallAgentTools(['memory_search', 'storage_search', 'read'], fake, grants.staticGrants(['memory_search', 'storage_search', 'read']));
  assert.deepEqual(r2.granted, ['read']);
});

test('the owner narrowing the small agent\'s grants narrows every run (also already created ones)', async () => {
  await grants.setAgentGrants(small.SMALL_AGENT_ID, { grants: ['memory_search'] }, 'sa-owner', available());
  try {
    const res = await spawn({ task: 'SCENARIO:plain', tools: ['memory_search', 'read'] });
    assert.deepEqual(res.json().granted_tools, ['memory_search']);
    assert.ok(res.json().warnings.some((w) => /"read".*not granted/.test(w)));
    // A stored grant that the agent no longer has is not used at run time.
    const scope = await small.smallAgentRunScope({ id: res.json().run_id, user_id: 'sa-owner' }, grants.staticGrants(['storage_search']), available());
    assert.deepEqual([...scope.grants.tools.keys()], []);
    await finalCard(res.json().run_id);
  } finally {
    await grants.setAgentGrants(small.SMALL_AGENT_ID, { grants: [...small.SMALL_AGENT_SAFE_TOOLS] }, 'sa-owner', available());
  }
});

test('delegation never expands permissions at run time: tools the model asks for but was not given are refused', async () => {
  const res = await spawn({ task: 'SCENARIO:escalate', tools: ['memory_search'] });
  const c = await finalCard(res.json().run_id);
  assert.equal(c.status, 'completed');
  assert.deepEqual(c.tools_granted, ['memory_search']);
  assert.deepEqual(c.tools_used.sort(), ['exec', 'read'], 'the steps are recorded');
  assert.ok(c.warnings.some((w) => /not given \(refused\): exec, read/.test(w)), JSON.stringify(c.warnings));
  assert.equal(c.needs_review, true);
  const calls = modelCalls.filter((m) => m.sc === 'escalate');
  const toolMsgs = calls.at(-1).body.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  for (const m of toolMsgs) assert.match(m.content, /not permitted|not allowed|disabled|refused/i, m.content);
  // The model was never offered exec or read.
  assert.deepEqual(calls[0].body.tools.map((t) => t.function.name), ['memory_search']);
});

test('drawers: only the requested ones an owner turn may open; none requested -> none', async () => {
  const res = await spawn({ task: 'SCENARIO:plain', drawers: ['project:alpha', 'project:beta', { kind: 'people', key: 'p-1' }, 'experience', 'task:t1', 'task:t2'] });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.deepEqual(body.drawers.sort(), ['experience', 'people:p-1', 'project:alpha', 'task:t1']);
  assert.ok(body.warnings.some((w) => w.includes('"project:beta"')));
  assert.ok(body.warnings.some((w) => w.includes('"task:t2"')));
  assert.ok(!body.drawers.includes('owner'), 'the owner drawer only when asked for');
  const scope = await small.smallAgentRunScope({ id: body.run_id, user_id: 'sa-owner' }, grants.staticGrants(small.SMALL_AGENT_SAFE_TOOLS), available());
  assert.deepEqual(scope.memoryDrawers.map((d) => (d.key ? `${d.kind}:${d.key}` : d.kind)).sort(), body.drawers.sort());
  assert.equal(scope.userId, 'sa-owner');
  await finalCard(body.run_id);

  const none = await spawn({ task: 'SCENARIO:plain' });
  const s2 = await small.smallAgentRunScope({ id: none.json().run_id, user_id: 'sa-owner' }, grants.staticGrants(small.SMALL_AGENT_SAFE_TOOLS), available());
  assert.deepEqual(s2.memoryDrawers, [], 'no drawers at all (not the owner default)');
  await finalCard(none.json().run_id);

  // Unknown run id -> nothing (fail closed).
  const s3 = await small.smallAgentRunScope({ id: 'nope', user_id: 'sa-owner' }, grants.staticGrants(small.SMALL_AGENT_SAFE_TOOLS), available());
  assert.equal(s3.grants.tools.size, 0);
  assert.deepEqual(s3.memoryDrawers, []);
});

test('budget: lower defaults, larger requests are clamped down, the step budget stops a looping run', async () => {
  const big = await spawn({ task: 'SCENARIO:plain', max_steps: 500 });
  assert.equal(big.json().budget.max_steps, 15);
  assert.ok(big.json().warnings.some((w) => /lowered/.test(w)));
  await finalCard(big.json().run_id);

  const res = await spawn({ task: 'SCENARIO:loop', max_steps: 3, kind: 'lookup' });
  assert.equal(res.json().budget.max_steps, 3);
  const c = await finalCard(res.json().run_id);
  assert.equal(c.status, 'failed');
  assert.equal(c.steps_used, 3);
  assert.match(c.summary, /budget/);
  assert.equal(c.needs_review, true);
  assert.deepEqual(c.outputs, []);
});

test('capacity: above SMALL_AGENT_MAX_CONCURRENT active runs new spawns are refused; list shows the queue', async () => {
  gate('hold');
  const a = await spawn({ task: 'SCENARIO:hold one' });
  const b = await spawn({ task: 'SCENARIO:hold two' });
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  const refused = await spawn({ task: 'SCENARIO:plain three' });
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(refused.json().capacity.limit, 2);
  assert.equal(refused.json().capacity.active, 2);

  const list = await app.inject({ method: 'GET', url: '/api/small-agent/runs?limit=5', headers: bearer('sa-owner') });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().capacity.active, 2);
  assert.equal(list.json().capacity.available, 0);
  assert.ok(list.json().runs.length <= 5);
  assert.ok(list.json().runs.some((r) => r.run_id === a.json().run_id));
  const unfinished = await card(a.json().run_id);
  assert.equal(unfinished.needs_review, true);
  assert.equal(unfinished.review_reason, 'the run has not finished');

  const bad = await app.inject({ method: 'GET', url: '/api/small-agent/runs?status=bogus', headers: bearer('sa-owner') });
  assert.equal(bad.statusCode, 400);

  gates.get('hold').release();
  await finalCard(a.json().run_id);
  await finalCard(b.json().run_id);
  const again = await spawn({ task: 'SCENARIO:plain four' });
  assert.equal(again.statusCode, 201, 'capacity frees up when runs finish');
  await finalCard(again.json().run_id);

  process.env.SMALL_AGENT_MAX_CONCURRENT = '1';
  try {
    gate('hold2');
    const one = await spawn({ task: 'SCENARIO:hold2' });
    assert.equal(one.statusCode, 201);
    assert.equal((await spawn({ task: 'SCENARIO:plain' })).statusCode, 429, 'the limit is configurable');
    gates.get('hold2').release();
    await finalCard(one.json().run_id);
  } finally {
    delete process.env.SMALL_AGENT_MAX_CONCURRENT;
  }
});

test('a run that is not a small-agent run has no card', async () => {
  const runs = await import(join(backendDir, 'src/services/task-runs.ts'));
  const t = getOrchestrator().createTask({ title: 'other', description: 'other', origin: 'owner' });
  const r = await runs.createRun({ taskId: t.id, agentId: 'main-agent', userId: 'sa-owner', prompt: 'x' });
  const res = await app.inject({ method: 'GET', url: `/api/small-agent/runs/${r.id}`, headers: bearer('sa-owner') });
  assert.equal(res.statusCode, 404);
  const list = (await app.inject({ method: 'GET', url: '/api/small-agent/runs?limit=100', headers: bearer('sa-owner') })).json();
  assert.ok(!list.runs.some((x) => x.run_id === r.id));
});
