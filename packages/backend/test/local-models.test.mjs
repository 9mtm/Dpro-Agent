// CORE-MODEL-01: only local models that can chat are offered and used.
//  - GET /api/models leaves out embedding models (Ollama capabilities, or the
//    name when /api/show fails);
//  - a wanted model that is installed is kept, also under a longer tag
//    (qwen3.5:9b → qwen3.5:9b-q4_K_M); a missing one falls back to the default,
//    then to the first installed chat model;
//  - a chat run for an agent that still names a deleted model answers with an
//    installed chat model; with only an embedding model installed the run ends
//    with local_model_missing; Ollama down = the wanted name is kept;
//  - the agent is told which model answers (CORE-MODEL-02).
// Throwaway DB/keys; Ollama is a stub HTTP server on 127.0.0.1.
// Run: node --import tsx --test test/local-models.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// --- stub Ollama: /api/tags, /api/show, streamed /api/chat -------------------
const MODELS = {
  'qwen3.5:9b-q4_K_M': ['completion', 'vision', 'tools', 'thinking'],
  'qwen3-embedding:0.6b': ['tools', 'thinking', 'embedding'],
  'nomic-embed-text:latest': null, // /api/show fails: decided by the name
  'llama3.2:3b': ['completion', 'tools'],
};
let installed = Object.keys(MODELS);
let ollamaDown = false;
const chatBodies = [];
const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (ollamaDown) { res.writeHead(503); res.end(); return; }
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: installed.map((name, i) => ({ name, model: name, size: 1e9 + i, digest: `d${i}`, modified_at: '2026-10-20T00:00:00Z' })) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/show') {
      const caps = MODELS[JSON.parse(raw).model];
      if (!caps) { res.writeHead(500); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ capabilities: caps }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      const body = JSON.parse(raw);
      chatBodies.push(body);
      if (!installed.includes(body.model) || !MODELS[body.model]?.includes('completion')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `model "${body.model}" not found` }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: `answer from ${body.model}` } }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
      return;
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-local-models-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.LMSTUDIO_API_URL = 'http://127.0.0.1:9/v1'; // nothing listens
for (const k of ['AGENT_EXEC_TOOLS', 'OLLAMA_THINK', 'DEFAULT_MODEL', 'LOCAL_MODEL_NAME']) delete process.env[k];
const capture = () => {};
console.log = capture; console.info = capture; console.warn = capture;

const lm = await import(join(backendDir, 'src/llm/local-models.ts'));
const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES ('m-owner', 'm-owner@example.test', 'm-owner', 'x', 'owner', 'active', 1)`).run();
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('m-agent', 'Main', 'ollama', 'qwen3.8:27b', 1)`).run();
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { chatRuns } = await import(join(backendDir, 'src/services/chat-runs.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const call = (method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken('m-owner', 1)}` }, ...(payload ? { payload } : {}) });
const frames = (body) => body.split('\n\n').filter((b) => b.includes('data:')).map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data:')).slice(5)));
const ended = (runId) => new Promise((r) => { const run = chatRuns.get(runId); if (run.status !== 'running') r(); else run.emitter.once('end', r); });
const rid = () => `run-${randomBytes(6).toString('hex')}`;
const setInstalled = (names) => { installed = names; lm.clearLocalModelCache(); };

test('the default local model is qwen3.5:9b', async () => {
  const { DEFAULT_OLLAMA_MODEL } = await import(join(backendDir, 'src/llm/ollama.ts'));
  assert.equal(DEFAULT_OLLAMA_MODEL, 'qwen3.5:9b');
});

test('chat models: capabilities decide; the name decides when /api/show fails', () => {
  assert.equal(lm.isChatModel('a', ['completion', 'tools']), true);
  assert.equal(lm.isChatModel('qwen3-embedding:0.6b', ['tools', 'thinking', 'embedding']), false);
  assert.equal(lm.isChatModel('nomic-embed-text', null), false);
  assert.equal(lm.isChatModel('llama3.2:3b', null), true);
});

test('matchInstalled: exact, longer tag, implied latest, none', () => {
  const names = ['qwen3.5:9b-q4_K_M', 'llama3.2:latest'];
  assert.equal(lm.matchInstalled('qwen3.5:9b-q4_K_M', names), 'qwen3.5:9b-q4_K_M');
  assert.equal(lm.matchInstalled('qwen3.5:9b', names), 'qwen3.5:9b-q4_K_M');
  assert.equal(lm.matchInstalled('llama3.2', names), 'llama3.2:latest');
  assert.equal(lm.matchInstalled('qwen3.8:27b', names), null);
  assert.equal(lm.matchInstalled('qwen3.5:9', names), null, 'a shorter size is not the same model');
});

test('GET /api/models lists chat models only', async () => {
  setInstalled(Object.keys(MODELS));
  const r = await call('GET', '/api/models');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().models.filter((m) => m.provider === 'local').map((m) => m.id), ['qwen3.5:9b-q4_K_M', 'llama3.2:3b']);
});

test('resolveLocalModel: keep installed, else default, else first chat model; Ollama down keeps the name', async () => {
  setInstalled(Object.keys(MODELS));
  assert.equal(await lm.resolveLocalModel('llama3.2:3b', 'qwen3.5:9b'), 'llama3.2:3b');
  assert.equal(await lm.resolveLocalModel('qwen3.8:27b', 'qwen3.5:9b'), 'qwen3.5:9b-q4_K_M');
  assert.equal(await lm.resolveLocalModel('qwen3-embedding:0.6b', 'qwen3.5:9b'), 'qwen3.5:9b-q4_K_M', 'an embedding model never answers a chat');
  setInstalled(['qwen3-embedding:0.6b', 'llama3.2:3b']);
  assert.equal(await lm.resolveLocalModel('qwen3.8:27b', 'qwen3.5:9b'), 'llama3.2:3b');
  setInstalled(['qwen3-embedding:0.6b']);
  assert.equal(await lm.resolveLocalModel('qwen3.8:27b', 'qwen3.5:9b'), 'qwen3.8:27b', 'no chat model: the caller reports it');
  ollamaDown = true; lm.clearLocalModelCache();
  assert.equal(await lm.resolveLocalModel('qwen3.8:27b', 'qwen3.5:9b'), 'qwen3.8:27b', 'Ollama down: the caller reports it');
  ollamaDown = false;
});

test('a run for an agent naming a deleted model answers with the installed chat model', async () => {
  setInstalled(Object.keys(MODELS));
  const c = (await call('POST', '/api/chat/conversations', { agentId: 'm-agent' })).json().conversation;
  chatBodies.length = 0;
  const runId = rid();
  assert.equal((await call('POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'hello' })).statusCode, 202);
  await ended(runId);
  const ev = frames((await call('GET', `/api/chat/runs/${runId}/events`)).body);
  assert.deepEqual([ev.at(-1).type, ev.at(-1).status], ['end', 'complete']);
  assert.equal(chatBodies[0].model, 'qwen3.5:9b-q4_K_M');
  const system = chatBodies[0].messages.find((m) => m.role === 'system')?.content ?? '';
  assert.match(system, /generated by the model "qwen3\.5:9b-q4_K_M" \(Ollama on this computer\)/, 'the agent is told which model answers');
});

test('with only an embedding model installed the run ends with local_model_missing', async () => {
  setInstalled(['qwen3-embedding:0.6b']);
  const c = (await call('POST', '/api/chat/conversations', { agentId: 'm-agent' })).json().conversation;
  const runId = rid();
  await call('POST', `/api/chat/conversations/${c.id}/runs`, { runId, message: 'hello' });
  await ended(runId);
  const ev = frames((await call('GET', `/api/chat/runs/${runId}/events`)).body);
  assert.deepEqual([ev.at(-1).type, ev.at(-1).status, ev.at(-1).code], ['end', 'error', 'local_model_missing']);
});

test.after(async () => { await app.close(); stub.close(); });
