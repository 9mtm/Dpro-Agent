// A board task run of an agent without a Claude key runs on the local model
// (like a chat turn), instead of failing: an agent set to Claude uses the
// default local model (or another installed one); an agent set to the local
// model uses its own. Memory it saves still belongs to the run's owner.
// In process: a stubbed local model server (no network), throwaway DB/keys/HOME.
// Run: node --import tsx --test test/task-run-local-fallback.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-task-local-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9'; // stubbed below; nothing real is reached
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['AGENT_EXEC_TOOLS', 'TASK_RUN_MAX_STEPS', 'TASK_RUN_MAX_DURATION_MS', 'MODEL_PRICES_JSON', 'OLLAMA_MODEL', 'DEFAULT_MODEL']) delete process.env[k];

const INSTALLED = ['qwen-local:9b', 'llama-own:3b'];
const calls = [];
/** Scripted local model: first a memory_save, then a final answer. */
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === 'http://127.0.0.1:9/api/tags') return Response.json({ models: INSTALLED.map((name) => ({ name, size: 1, modified_at: '2026-10-21T00:00:00Z', digest: name })) });
  if (u === 'http://127.0.0.1:9/api/show') return Response.json({ capabilities: ['completion', 'tools'] });
  if (u === 'http://127.0.0.1:9/api/chat') {
    const body = JSON.parse(init.body);
    calls.push(body);
    const tool = body.messages.some((m) => m.role === 'tool');
    const sc = /SCENARIO:(\w+)/.exec(JSON.stringify(body.messages))?.[1];
    return Response.json(tool
      ? { model: body.model, message: { role: 'assistant', content: `done ${sc}` }, prompt_eval_count: 1, eval_count: 1 }
      : { model: body.model, message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'memory_save', arguments: { content: `Launch posts go out on Tuesdays (${sc})`, type: 'fact', importance: 4 } } }] }, prompt_eval_count: 1, eval_count: 1 });
  }
  throw new Error(`unexpected network call in test: ${u}`);
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

const OWNER = 'lf-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified, created_at) VALUES (?, ?, ?, 'x', 'owner', 'active', 1, '2026-01-01T00:00:00.000Z')`).run(OWNER, `${OWNER}@example.test`, OWNER);
const tools = await import(join(backendDir, 'src/tools/index.ts'));
const grants = await import(join(backendDir, 'src/tools/grants.ts'));
const avail = tools.createToolsRegistry({ workspaceDir: dir }).listRegistered();
const agents = [['lf-claude', 'claude', 'claude-sonnet-4-5'], ['lf-local', 'ollama', 'llama-own:3b']];
for (const [id, provider, model] of agents) {
  db.prepare('INSERT INTO agents_config (id, name, provider, model) VALUES (?, ?, ?, ?)').run(id, id, provider, model);
  await grants.setAgentGrants(id, { grants: ['memory_save', 'memory_search'] }, OWNER, avail);
  if (!orchestrator.getAgent?.(id)) orchestrator.registerAgent({ id, name: id, role: 'worker', capabilities: [], maxConcurrentTasks: 10 });
}

test.after(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });

const cron = await import(join(backendDir, 'src/services/agent-cron.ts'));
async function boardRun(agentId, provider, model, scenario) {
  const task = orchestrator.createTask({ title: `SCENARIO:${scenario}`, description: 'local fallback test', origin: 'owner' });
  orchestrator.assignTask(task.id, agentId);
  return cron.runAgentTask({ id: agentId, name: agentId, model, provider, system_prompt: null, temperature: 0, max_tokens: 200, cron_schedule: '', cron_enabled: 0 }, task.id, `SCENARIO:${scenario}`);
}

test('an agent set to Claude with no key runs its board task on the default local model and saves for the owner', async () => {
  const out = await boardRun('lf-claude', 'claude', 'claude-sonnet-4-5', 'CLAUDE');
  assert.match(out, /done CLAUDE/, out);
  const models = calls.filter((c) => /SCENARIO:CLAUDE/.test(JSON.stringify(c.messages))).map((c) => c.model);
  assert.ok(models.length >= 2 && models.every((m) => INSTALLED.includes(m)), `a local model answered, never the Claude name: ${models}`);
  const row = db.prepare('SELECT user_id, source_agent_id FROM memories WHERE content = ?').get('Launch posts go out on Tuesdays (CLAUDE)');
  assert.deepEqual(row, { user_id: OWNER, source_agent_id: 'lf-claude' }, 'saved for the owner, the agent as source');
});

test('an agent set to the local model runs its board task on its own installed model', async () => {
  const out = await boardRun('lf-local', 'ollama', 'llama-own:3b', 'LOCAL');
  assert.match(out, /done LOCAL/, out);
  assert.ok(calls.filter((c) => /SCENARIO:LOCAL/.test(JSON.stringify(c.messages))).every((c) => c.model === 'llama-own:3b'));
});
