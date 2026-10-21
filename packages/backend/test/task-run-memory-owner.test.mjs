// MEM-OWNER-01: memories an agent saves during a board task run belong to the
// run's owner (user_id = owner); the agent is recorded as source_agent_id, as
// in the owner's chats. Every access check stays: open drawers, write kinds,
// review rules (important facts wait for the owner as proposals); owner-only
// memory tools stay refused in a board run (no owner turn).
// In process: a stubbed Claude API (no network), throwaway DB/keys/HOME, a
// dead OLLAMA_URL (no local model is ever reached).
// Run: node --import tsx --test test/task-run-memory-owner.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-task-mem-owner-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9'; // nothing listens here
process.env.MEMORY_GRAPH_MODEL = 'off';
// The stubbed model is a paid provider: autonomous paid calls need a cap above 0. Throwaway, no real spend.
process.env.DAILY_PAID_CAP_CENTS = '1000000';
for (const k of ['AGENT_EXEC_TOOLS', 'TASK_RUN_MAX_STEPS', 'TASK_RUN_MAX_DURATION_MS', 'MODEL_PRICES_JSON', 'OUTSIDER_AGENT_MEMORY']) delete process.env[k];

const toolUse = (t, name, input) => ({ content: [{ type: 'tool_use', id: `tu-${t}-${name}`, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } });
const text = (s) => ({ content: [{ type: 'text', text: s }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
/** Scripted model per scenario; t = completed tool turns so far. */
const SCRIPTS = {
  SAVE: [
    ['memory_save', { content: 'The weekly report goes out on Fridays', type: 'fact', importance: 4 }],
    ['memory_save', { content: 'The ad budget is 500 euros per month', type: 'fact' }],
  ],
  READONLY: [['memory_save', { content: 'Read-only agent tries to save this', type: 'fact', importance: 3 }]],
  GATED: [['memory_doctor', {}], ['memory_review', { action: 'list' }]],
};
const toolResults = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('https://api.anthropic.com/')) throw new Error(`unexpected network call in test: ${url}`);
  const body = JSON.parse(init.body);
  const sc = /SCENARIO:(\w+)/.exec(String(body.messages[0].content))?.[1] ?? '?';
  const last = body.messages.at(-1);
  if (Array.isArray(last.content)) for (const c of last.content) if (c.type === 'tool_result') toolResults.push({ sc, content: JSON.stringify(c.content) });
  const t = (body.messages.length - 1) / 2;
  const step = SCRIPTS[sc]?.[t];
  return new Response(JSON.stringify(step ? toolUse(t, ...step) : text(`done ${sc}`)), { status: 200, headers: { 'content-type': 'application/json' } });
};
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
const orchestrator = getOrchestrator();
await orchestrator.initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));

const OWNER = 'mo-owner';
const OTHER = 'mo-owner2';
const addUser = (id, role, at) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified, created_at) VALUES (?, ?, ?, 'x', ?, 'active', 1, ?)`)
  .run(id, `${id}@example.test`, id, role, at);
addUser(OWNER, 'owner', '2026-01-01T00:00:00.000Z');
addUser(OTHER, 'owner', '2026-06-01T00:00:00.000Z'); // a later account: never the run's owner

const WRITER = 'mo-writer';
const READER = 'mo-reader';
const tools = await import(join(backendDir, 'src/tools/index.ts'));
const grants = await import(join(backendDir, 'src/tools/grants.ts'));
const { setAgentApiKey } = await import(join(backendDir, 'src/credentials/authority.ts'));
const avail = tools.createToolsRegistry({ workspaceDir: dir }).listRegistered();
for (const id of [WRITER, READER]) {
  db.prepare(`INSERT INTO agents_config (id, name, provider, model) VALUES (?, ?, 'claude', 'claude-test')`).run(id, id);
  await grants.setAgentGrants(id, { grants: ['memory_save', 'memory_search', 'memory_doctor', 'memory_review'] }, OWNER, avail);
  await setAgentApiKey(id, 'sk-ant-test-' + randomBytes(12).toString('hex'));
  if (!orchestrator.getAgent?.(id)) orchestrator.registerAgent({ id, name: id, role: 'worker', capabilities: [], maxConcurrentTasks: 10 });
}
// The reader may read the owner + experience drawers but write none.
db.prepare(`INSERT INTO agent_permissions (agent_id, memory_read, memory_write, shared_memory, modes, version) VALUES (?, ?, '[]', 0, '{}', 1)`)
  .run(READER, JSON.stringify(['owner', 'experience']));

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const get = async (user, url) => {
  const r = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${generateToken(user, 1)}` } });
  assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
  return r.json();
};

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const cron = await import(join(backendDir, 'src/services/agent-cron.ts'));
async function boardRun(agentId, scenario) {
  const task = orchestrator.createTask({ title: `SCENARIO:${scenario}`, description: 'board task memory test', origin: 'owner' });
  orchestrator.assignTask(task.id, agentId);
  const output = await cron.runAgentTask({ id: agentId, name: agentId, model: 'claude-test', provider: 'claude',
    system_prompt: null, temperature: 0, max_tokens: 100, cron_schedule: '', cron_enabled: 0 }, task.id, `SCENARIO:${scenario}`);
  return { task, output, results: toolResults.filter((r) => r.sc === scenario).map((r) => r.content) };
}

test('a board task run saves memory for the owner; the agent is the source', async () => {
  const { results } = await boardRun(WRITER, 'SAVE');
  const row = db.prepare('SELECT * FROM memories WHERE content = ?').get('The weekly report goes out on Fridays');
  assert.ok(row, `routine fact saved: ${results.join(' | ')}`);
  assert.equal(row.user_id, OWNER, 'owned by the run owner, not the agent');
  assert.equal(row.source_agent_id, WRITER, 'the saving agent is recorded');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?').get(WRITER).n, 0, 'nothing under the agent id');

  // The owner sees it in the explorer, with the agent as source.
  const mine = await get(OWNER, '/api/memory/scopes/memories?scope=company');
  const item = mine.items.find((i) => i.id === row.id);
  assert.ok(item, 'owner explorer lists it');
  assert.deepEqual([item.source, item.sourceAgentId], ['agent', WRITER]);
  assert.ok((await get(OWNER, `/api/memory/scopes/memories?scope=agent:${WRITER}`)).items.some((i) => i.id === row.id));

  // The important fact waits for the owner as a proposal; nothing is saved by itself.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE content = ?').get('The ad budget is 500 euros per month').n, 0);
  assert.match(results[1], /Waiting for owner approval|proposal/i, results[1]);
  const pending = (await get(OWNER, '/api/memory/proposals?status=pending')).proposals;
  assert.equal(pending.length, 1, JSON.stringify(pending));

  // Another owner account never sees either.
  const theirs = await get(OTHER, '/api/memory/scopes/memories?scope=company');
  assert.ok(!theirs.items.some((i) => i.id === row.id), 'other owner explorer');
  assert.equal((await get(OTHER, '/api/memory/proposals?status=pending')).proposals.length, 0, 'other owner proposals');
});

test('an agent without write access is refused in a board run', async () => {
  const { results } = await boardRun(READER, 'READONLY');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE content = ?').get('Read-only agent tries to save this').n, 0);
  assert.match(results[0], /may not write to that memory drawer/, results[0]);
});

test('owner-only memory tools stay refused in a board run (no owner turn)', async () => {
  const { results } = await boardRun(WRITER, 'GATED');
  assert.equal(results.length, 2, results.join(' | '));
  for (const r of results) assert.match(r, /refused|only for the owner|owner/i, r);
  assert.doesNotMatch(results[0], /"ok"|issues/i, results[0]);
});
