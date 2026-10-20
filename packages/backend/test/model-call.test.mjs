// R2.2: every background model call goes through one choke point
// (src/llm/model-call.ts) and the cost budget gate; background work prefers
// the free local model; interactive owner chat is not gated but its paid
// usage is recorded for GET /api/budget.
// Throwaway DB/keys; every model call is stubbed (no network, nothing paid).
// Run: node --import tsx --test test/model-call.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-model-call-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
for (const k of ['DAILY_PAID_CAP_CENTS', 'MODEL_PRICES_JSON', 'BACKGROUND_PAID_PURPOSES', 'MEMORY_SUMMARY_MODEL', 'OLLAMA_THINK', 'DEFAULT_MODEL', 'LOCAL_MODEL_NAME']) delete process.env[k];

// --- stubbed models ------------------------------------------------------------------
const calls = { paid: [], local: [] };
const WORLD = { name: 'Test World', description: 'stub', objects: [], lighting: {}, ground: { size: 10, color: '#00ff00' } };
let extraction = [{ type: 'fact', content: 'Keeps a plant on the desk', importance: 5 }];
const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const body = JSON.parse(init.body || '{}');
  if (target === 'http://127.0.0.1:11434/api/chat') { // public rooms (streamed)
    calls.local.push({ model: body.model, messages: body.messages, chat: true });
    return new Response(JSON.stringify({ message: { content: 'local room reply' }, done: true }) + '\n', { status: 200 });
  }
  if (target === 'http://127.0.0.1:11434/api/generate') {
    calls.local.push({ model: body.model, prompt: body.prompt, system: body.system });
    const response = /3D world JSON/.test(body.prompt) ? JSON.stringify(WORLD)
      : /HEARTBEAT/.test(body.prompt) ? 'HEARTBEAT_OK'
      : /weekly memory digest/.test(body.prompt) ? 'A calm week.'
      : JSON.stringify(extraction);
    return json({ model: body.model, response, prompt_eval_count: 30, eval_count: 5 });
  }
  if (target.startsWith('https://api.anthropic.com/')) {
    const first = body.messages?.[0]?.content;
    calls.paid.push({ model: body.model, first: typeof first === 'string' ? first : JSON.stringify(first) });
    const textOut = /3D world JSON/.test(String(first)) ? JSON.stringify(WORLD) : /HEARTBEAT/.test(String(first)) ? 'HEARTBEAT_OK' : /Analyze this conversation/.test(String(first)) ? JSON.stringify(extraction) : 'chat reply';
    return json({ content: [{ type: 'text', text: textOut }], stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 1000 } });
  }
  throw new Error(`unexpected network call in test: ${target}`);
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
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES ('mc-owner', 'mc-owner@example.test', 'mc-owner', 'x', 'owner', 'active', 1)`).run();

// A paid key is configured for memory extraction (legacy agent_settings row)
// and for the heartbeat agent; the primary agent answers interactive chat.
const testKey = () => 'sk-ant-test-' + randomBytes(12).toString('hex');
db.prepare(`INSERT OR REPLACE INTO settings (key, value, category) VALUES ('agent_settings', ?, 'agent')`).run(JSON.stringify({ claude: { apiKey: testKey(), model: 'claude-haiku-test' } }));
const AGENT = 'mc-agent';
db.prepare(`INSERT INTO agents_config (id, name, provider, model) VALUES (?, ?, 'claude', 'claude-sonnet-test')`).run(AGENT, AGENT);
const { setAgentApiKey } = await import(join(backendDir, 'src/credentials/authority.ts'));
await setAgentApiKey(AGENT, testKey());
db.prepare(`UPDATE agents_config SET provider = 'claude', api_key = ? WHERE is_primary = 1`).run('test-key-' + randomBytes(4).toString('hex'));

const MC = await import(join(backendDir, 'src/llm/model-call.ts'));
const budget = await import(join(backendDir, 'src/services/cost-budget.ts'));
const cron = await import(join(backendDir, 'src/services/agent-cron.ts'));
const { getMemoryRetrieval } = await import(join(backendDir, 'src/memory/retrieval.ts'));
const W = await import(join(backendDir, 'src/memory/weekly-summary.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const bearer = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });

console.log = quiet.log;
console.info = quiet.info;
console.warn = quiet.warn;

test.after(async () => {
  globalThis.fetch = realFetch;
  try { await app.close(); } catch { /* ignore */ }
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const ledger = () => db.prepare('SELECT * FROM paid_usage ORDER BY id').all();
const interactiveRows = () => db.prepare('SELECT * FROM interactive_usage ORDER BY id').all();
const reset = () => { calls.paid.length = 0; calls.local.length = 0; };
const heartbeatAgent = { id: AGENT, name: AGENT, model: 'claude-sonnet-test', provider: 'claude', system_prompt: null, temperature: 0, max_tokens: 100, cron_schedule: '', cron_enabled: 1 };
const silent = async (fn) => {
  const keep = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = keep.log; console.warn = keep.warn; }
};

// --- static allow-list ------------------------------------------------------------------

function sourceFiles(root) {
  const out = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|js|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

test('static: no file outside the choke point calls a paid model provider from a background path', () => {
  const src = join(backendDir, 'src');
  const PAID = /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.groq\.com|openrouter\.ai|api\.deepseek\.com|api\.x\.ai|new ClaudeClient\(|from ['"]openai['"]|from ['"]@anthropic-ai\/sdk['"]|new OpenAI\(/;
  // Each allowed file with the reason it may reach a paid provider directly.
  const ALLOWED = {
    'llm/model-call.ts': 'the choke point (gated background calls; interactive usage recorded)',
    'llm/claude-client.ts': 'the provider client itself',
    'services/task-run-executor.ts': 'builds the agent driver; every step call goes through gatedModelCall',
    'api/routes/agentic-chat.ts': 'interactive owner chat (not gated, usage recorded)',
    'api/routes/settings.ts': 'owner tests an API key',
    'api/routes/agents-status.ts': 'owner checks provider status',
    'services/audio-service.ts': 'interactive transcription / speech requested by a user',
  };
  const hits = [];
  for (const file of sourceFiles(src)) {
    const rel = relative(src, file).split('\\').join('/');
    const text = readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    if (PAID.test(text) && !ALLOWED[rel]) hits.push(rel);
  }
  assert.deepEqual(hits, [], `paid model provider used outside the allow-list: ${hits.join(', ')}`);

  // Only cost-budget.ts and the choke point touch the reservation ledger.
  const ledgerUsers = sourceFiles(src)
    .filter((f) => /\b(reservePaidCall|recordPaidCall|releasePaidCall)\(/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(src, f).split('\\').join('/')).sort();
  assert.deepEqual(ledgerUsers, ['llm/model-call.ts', 'services/cost-budget.ts']);

  // Background paths use the choke point.
  for (const rel of ['memory/retrieval.ts', 'memory/weekly-summary.ts', 'services/agent-cron.ts', 'services/task-run-executor.ts']) {
    assert.match(readFileSync(join(src, rel), 'utf8'), /from '\.\.\/llm\/model-call\.js'/, rel);
  }
  // Evolution is rule-based: no model client at all.
  for (const rel of ['services/agent-evolution-orchestrator.js', 'services/agent-evolution-scheduler.js', 'services/agent-learning-engine.js', 'services/agent-performance-analyzer.js']) {
    assert.doesNotMatch(readFileSync(join(src, rel), 'utf8'), /fetch\(|ClaudeClient|llm\//, rel);
  }
});

// --- background calls ----------------------------------------------------------------------

test('default: background memory extraction uses the local model even with a paid key and a cap', async () => {
  process.env.DAILY_PAID_CAP_CENTS = '1000';
  try {
    reset();
    const out = await silent(() => getMemoryRetrieval().extractCandidates('I keep a plant on my desk', 'mc-owner'));
    assert.deepEqual(out.map((c) => c.content), ['Keeps a plant on the desk']);
    assert.equal(calls.paid.length, 0, 'no paid call');
    assert.equal(calls.local.length, 1);
    assert.equal(calls.local[0].model, 'qwen3.5:9b');
    assert.equal(ledger().length, 0);
  } finally {
    delete process.env.DAILY_PAID_CAP_CENTS;
  }
});

test('cap 0: an opted-in background paid call is refused before it is made; the local model is used', async () => {
  process.env.BACKGROUND_PAID_PURPOSES = 'memory_extraction,heartbeat';
  try {
    assert.equal(budget.dailyCapCents(), 0);
    reset();
    const out = await silent(() => getMemoryRetrieval().extractCandidates('I keep a plant on my desk', 'mc-owner'));
    assert.deepEqual(out.map((c) => c.content), ['Keeps a plant on the desk']);
    assert.equal(calls.paid.length, 0, 'refused before the paid call');
    assert.equal(calls.local.length, 1, 'local model used');
    assert.equal(ledger().length, 0, 'nothing reserved');

    const direct = await MC.modelCall({ actor: 'test' }, { purpose: 'memory_extraction', prompt: 'x', paid: { provider: 'claude', model: 'claude-haiku-test', apiKey: testKey() } });
    assert.equal(direct.provider, 'ollama');
    assert.equal(direct.paid, false);
    assert.match(direct.refused, /daily paid cap is 0/);

    reset();
    await silent(() => cron.runHeartbeat(heartbeatAgent, '- check the inbox'));
    assert.equal(calls.paid.length, 0);
    assert.equal(calls.local.length, 1, 'heartbeat ran on the local model');
    assert.match(calls.local[0].system, /You are mc-agent/);
  } finally {
    delete process.env.BACKGROUND_PAID_PURPOSES;
  }
});

test('cap > 0 and opted in: the paid call is reserved first and its usage recorded', async () => {
  process.env.BACKGROUND_PAID_PURPOSES = 'memory_extraction,heartbeat';
  process.env.DAILY_PAID_CAP_CENTS = '1000';
  process.env.MODEL_PRICES_JSON = JSON.stringify({ claude: { default: { input: 1, output: 1 } } });
  try {
    reset();
    const out = await silent(() => getMemoryRetrieval().extractCandidates('I keep a plant on my desk', 'mc-owner'));
    assert.equal(out.length, 1);
    assert.equal(calls.paid.length, 1);
    assert.equal(calls.paid[0].model, 'claude-haiku-test');
    assert.equal(calls.local.length, 0);
    await silent(() => cron.runHeartbeat(heartbeatAgent, '- check the inbox'));
    assert.equal(calls.paid.length, 2);
    assert.equal(calls.paid[1].model, 'claude-sonnet-test');
    assert.deepEqual(ledger().map((u) => [u.purpose, u.status, u.cost_cents, u.input_tokens, u.output_tokens, u.usage_source]), [
      ['memory_extraction', 'recorded', 3, 2000, 1000, 'provider'],
      ['heartbeat', 'recorded', 3, 2000, 1000, 'provider'],
    ]);
    assert.ok(ledger().every((u) => u.estimated_cents > 0), 'worst case reserved before the call');
    assert.equal((await budget.spentCents()), 6);

    // The cap reached: the next one is refused, the local model answers.
    process.env.DAILY_PAID_CAP_CENTS = '7';
    reset();
    const r = await MC.modelCall({}, { purpose: 'heartbeat', prompt: 'HEARTBEAT', maxOutputTokens: 1024, paid: { provider: 'claude', model: 'claude-sonnet-test', apiKey: testKey() } });
    assert.equal(calls.paid.length, 0);
    assert.equal(r.provider, 'ollama');
    assert.match(r.refused, /daily paid cap 7 cents would be exceeded/);
    assert.equal(ledger().length, 2);

    // A purpose that is not opted in never uses the paid provider.
    process.env.DAILY_PAID_CAP_CENTS = '1000';
    const w = await MC.modelCall({}, { purpose: 'weekly_summary', prompt: 'weekly memory digest', paid: { provider: 'claude', model: 'm', apiKey: testKey() } });
    assert.equal(w.provider, 'ollama');
    assert.equal(w.refused, undefined);
    assert.equal(calls.paid.length, 0);
  } finally {
    delete process.env.BACKGROUND_PAID_PURPOSES;
    delete process.env.DAILY_PAID_CAP_CENTS;
    delete process.env.MODEL_PRICES_JSON;
  }
});

test('a failed paid call releases its reservation', async () => {
  process.env.BACKGROUND_PAID_PURPOSES = 'heartbeat';
  process.env.DAILY_PAID_CAP_CENTS = '1000';
  const keep = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).startsWith('https://api.anthropic.com/') ? new Response('boom', { status: 500 }) : keep(url, init);
  try {
    const before = ledger().length;
    const r = await MC.modelCall({}, { purpose: 'heartbeat', prompt: 'HEARTBEAT', paid: { provider: 'claude', model: 'claude-sonnet-test', apiKey: testKey() } });
    assert.equal(r.ok, false);
    const rows = ledger().slice(before);
    assert.deepEqual(rows.map((u) => u.status), ['released']);
  } finally {
    globalThis.fetch = keep;
    delete process.env.BACKGROUND_PAID_PURPOSES;
    delete process.env.DAILY_PAID_CAP_CENTS;
  }
});

test('weekly-summary rewrite goes through the choke point on the local model', async () => {
  reset();
  const r = await W.ollamaSummarizer('digest');
  assert.deepEqual(r, { text: 'A calm week.', model: 'ollama:qwen3.5:9b' });
  assert.equal(calls.local.length, 1);
  assert.equal(calls.paid.length, 0);
});

test('scheduled api_call jobs cannot reach a paid model provider', () => {
  assert.equal(MC.isPaidProviderUrl('https://api.anthropic.com/v1/messages'), true);
  assert.equal(MC.isPaidProviderUrl('https://api.openai.com/v1/chat/completions'), true);
  assert.equal(MC.isPaidProviderUrl('http://127.0.0.1:11434/api/generate'), false);
  assert.equal(MC.isPaidProviderUrl('not a url'), false);
});

// --- interactive ------------------------------------------------------------------------------

test('interactive owner chat is not gated (cap 0) but its paid usage is recorded for GET /api/budget', async () => {
  process.env.MODEL_PRICES_JSON = JSON.stringify({ claude: { default: { input: 1, output: 1 } } });
  try {
    assert.equal(budget.dailyCapCents(), 0);
    reset();
    const autonomousBefore = ledger().length;
    const res = await silent(() => app.inject({ method: 'POST', url: '/api/chat', headers: bearer('mc-owner'),
      payload: { stream: false, messages: [{ role: 'user', content: 'hi' }] } }));
    assert.equal(res.statusCode, 200, res.body.slice(0, 500));
    assert.equal(calls.paid.length, 1, 'the paid model answered the owner');
    assert.equal(ledger().length, autonomousBefore, 'not in the autonomous ledger');
    const rows = interactiveRows();
    assert.deepEqual(rows.map((u) => [u.provider, u.purpose, u.cost_cents, u.input_tokens, u.output_tokens]), [['claude', 'interactive_chat', 3, 2000, 1000]]);

    const b = (await app.inject({ method: 'GET', url: '/api/budget', headers: bearer('mc-owner') })).json().budget;
    assert.equal(b.interactive.calls, 1);
    assert.equal(b.interactive.cents, 3);
    assert.equal(b.spentTodayCents, (await budget.spentCents()), 'interactive spend is not part of the cap');
    assert.match(b.scope, /Interactive chat .* not blocked/);
    assert.ok(!JSON.stringify(b).includes('sk-ant-'), 'no keys in the budget view');
  } finally {
    delete process.env.MODEL_PRICES_JSON;
  }
});

// --- public rooms and world generator (R2.3, Q-32d) ---------------------------------------------

const { default: Fastify } = await import('fastify');
const { registerPublicChatRoutes } = await import(join(backendDir, 'src/api/routes/public-chat.ts'));
const { worldGeneratorRoutes } = await import(join(backendDir, 'src/api/routes/world-generator.ts'));
const { getSettingsManager } = await import(join(backendDir, 'src/settings/index.ts'));
const roomsApp = Fastify();
await roomsApp.register(registerPublicChatRoutes);
await roomsApp.register(worldGeneratorRoutes);
await roomsApp.ready();
test.after(async () => { try { await roomsApp.close(); } catch { /* ignore */ } });

db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES ('mc-member', 'mc-member@example.test', 'mc-member', 'x', 'user', 'active', 1)`).run();
db.prepare(`INSERT INTO public_chat_rooms (id, name, owner_user_id, model, is_public, require_auth) VALUES ('mc-room', 'Lobby', 'mc-owner', 'claude-haiku-test', 1, 0)`).run();
// B2.2d-10: the generator reads the agent's model from agents_config.
db.prepare(`INSERT INTO agents_config (id, name, model) VALUES ('mc-world-agent', 'World Agent', 'claude-sonnet-test')`).run();

const roomPost = (headers = {}) => roomsApp.inject({ method: 'POST', url: '/api/public-chat/rooms/mc-room/messages', headers, payload: { content: 'hello', username: 'visitor' } });
const sseText = (body) => body.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
  .filter((e) => e.type === 'content').map((e) => e.content).join('');
const generateWorld = () => roomsApp.inject({ method: 'POST', url: '/api/world-generator/ai', headers: bearer('mc-owner'), payload: { prompt: 'a meadow', agent_id: 'mc-world-agent' } });
const withEnv = async (env, fn) => {
  const keep = {};
  for (const [k, v] of Object.entries(env)) { keep[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally { for (const k of Object.keys(env)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
};

test('public room, cap 0: no sender (owner, member, anonymous) triggers a paid call; the local model answers', async () => {
  await getSettingsManager().updateSettings({ publicRooms: { allowAnonymous: true } });
  await withEnv({ ANTHROPIC_API_KEY: testKey(), BACKGROUND_PAID_PURPOSES: 'public_room' }, async () => {
    assert.equal(budget.dailyCapCents(), 0);
    const before = ledger().length;
    for (const headers of [bearer('mc-owner'), bearer('mc-member'), {}]) {
      reset();
      const res = await silent(() => roomPost(headers));
      assert.equal(res.statusCode, 200, res.body.slice(0, 300));
      assert.equal(sseText(res.body), 'local room reply');
      assert.equal(calls.paid.length, 0, 'no paid call');
      assert.equal(calls.local.length, 1);
      assert.equal(calls.local[0].model, 'qwen3.5:9b', 'a paid room model is answered by the default local model');
    }
    assert.equal(ledger().length, before, 'nothing reserved');
  });
});

test('public room, cap > 0 but not opted in: anonymous visitors and members never trigger a paid call', async () => {
  await withEnv({ ANTHROPIC_API_KEY: testKey(), DAILY_PAID_CAP_CENTS: '1000' }, async () => {
    const before = ledger().length;
    for (const headers of [{}, bearer('mc-member'), bearer('mc-owner')]) {
      reset();
      const res = await silent(() => roomPost(headers));
      assert.equal(sseText(res.body), 'local room reply');
      assert.equal(calls.paid.length, 0);
    }
    assert.equal(ledger().length, before);
  });
});

test('public room, opted in and cap > 0: the paid reply is reserved first and recorded under public_room', async () => {
  await withEnv({ ANTHROPIC_API_KEY: testKey(), BACKGROUND_PAID_PURPOSES: 'public_room', DAILY_PAID_CAP_CENTS: '1000',
    MODEL_PRICES_JSON: JSON.stringify({ claude: { default: { input: 1, output: 1 } } }) }, async () => {
    const before = ledger().length;
    reset();
    const res = await silent(() => roomPost());
    assert.equal(sseText(res.body), 'chat reply');
    assert.equal(calls.paid.length, 1);
    assert.equal(calls.paid[0].model, 'claude-haiku-test');
    assert.equal(calls.local.length, 0);
    const rows = ledger().slice(before);
    assert.deepEqual(rows.map((u) => [u.purpose, u.status, u.cost_cents]), [['public_room', 'recorded', 3]]);
    assert.ok(rows[0].estimated_cents > 0, 'worst case reserved before the call');

    // Cap reached: the next reply is refused before the call and falls back to local.
    process.env.DAILY_PAID_CAP_CENTS = String(Math.ceil((await budget.spentCents())));
    reset();
    const again = await silent(() => roomPost(bearer('mc-member')));
    assert.equal(sseText(again.body), 'local room reply');
    assert.equal(calls.paid.length, 0);
    assert.equal(ledger().length, before + 1);
  });
});

test('world generator: local by default (cap 0, key set); paid only when opted in and the cap allows', async () => {
  await withEnv({ ANTHROPIC_API_KEY: testKey(), MODEL_PRICES_JSON: JSON.stringify({ claude: { default: { input: 1, output: 1 } } }) }, async () => {
    const before = ledger().length;
    reset();
    // The parked world feature fails later on its own storage schema
    // (D-WORLDS-LATER, not fixed here); only the model routing is checked.
    let res = await silent(() => generateWorld());
    assert.notEqual(res.statusCode, 503, res.body.slice(0, 300));
    assert.equal(calls.paid.length, 0);
    assert.equal(calls.local.length, 1);

    process.env.BACKGROUND_PAID_PURPOSES = 'world_generator';
    reset();
    res = await silent(() => generateWorld()); // opted in, cap still 0 -> refused, local
    assert.notEqual(res.statusCode, 503);
    assert.equal(calls.paid.length, 0);
    assert.equal(calls.local.length, 1);
    assert.equal(ledger().length, before);

    process.env.DAILY_PAID_CAP_CENTS = '1000';
    reset();
    res = await silent(() => generateWorld());
    assert.notEqual(res.statusCode, 503);
    assert.equal(calls.paid.length, 1);
    assert.equal(calls.paid[0].model, 'claude-sonnet-test');
    assert.deepEqual(ledger().slice(before).map((u) => [u.purpose, u.status]), [['world_generator', 'recorded']]);
  });
  delete process.env.BACKGROUND_PAID_PURPOSES;
  delete process.env.DAILY_PAID_CAP_CENTS;
});

test('world generator: a clear refusal when neither the local model nor an allowed paid model answers', async () => {
  const keep = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).includes('11434') ? new Response('down', { status: 500 }) : keep(url, init);
  try {
    reset();
    const res = await silent(() => generateWorld());
    assert.equal(res.statusCode, 503);
    assert.match(res.json().error, /BACKGROUND_PAID_PURPOSES/);
    assert.equal(calls.paid.length, 0);
  } finally {
    globalThis.fetch = keep;
  }
});
