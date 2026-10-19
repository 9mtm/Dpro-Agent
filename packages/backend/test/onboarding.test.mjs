// F-05: web onboarding wizard API (owner only, per-user state in the DB).
// Run: node --import tsx --test test/onboarding.test.mjs
// No network: any fetch fails the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'ap-onboarding-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };

// Capture console output: no secret may be logged.
const logged = [];
for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[m];
  console[m] = (...args) => { logged.push(args.map(String).join(' ')); orig.apply(console, args); };
}

const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
const db = getDatabase();
await db.initialize(); // fresh DB: schema + every migration incl. 050

const addUser = (id, role, status = 'active') =>
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, ?, 1)`)
    .run(id, `${id}@example.test`, id, role, status);
addUser('u-owner', 'owner');
addUser('u-admin', 'admin');
addUser('u-member', 'user');
addUser('u-off', 'owner', 'inactive');

const { default: Fastify } = await import('fastify');
const { onboardingWebRoutes } = await import('../src/api/routes/onboarding-web.ts');
const { generateToken } = await import('../src/auth/jwt.ts');
const { getSettingsManager } = await import('../src/settings/index.ts');

const app = Fastify();
await app.register(onboardingWebRoutes);
await app.ready();

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const bearer = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const get = (headers) => app.inject({ method: 'GET', url: '/api/onboarding', headers });
const post = (url, payload, headers) => app.inject({ method: 'POST', url, payload, headers });
const OWNER = bearer('u-owner');

test('fresh DB: migration 050 created onboarding_state', () => {
  const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_state'`).get();
  assert.ok(t);
  assert.ok(db.prepare(`SELECT id FROM migrations WHERE id = '050'`).get());
});

test('anonymous and bad tokens get 401', async () => {
  assert.equal((await get()).statusCode, 401);
  assert.equal((await get({ authorization: 'Bearer not.a.jwt' })).statusCode, 401);
  assert.equal((await post('/api/onboarding', { currentStep: 2 })).statusCode, 401);
  assert.equal((await post('/api/onboarding/complete', {})).statusCode, 401);
  assert.equal((await post('/api/onboarding/reset', {})).statusCode, 401);
});

test('admin, member and inactive owner get 403', async () => {
  for (const id of ['u-admin', 'u-member', 'u-off']) {
    assert.equal((await get(bearer(id))).statusCode, 403, id);
    assert.equal((await post('/api/onboarding', { currentStep: 2 }, bearer(id))).statusCode, 403, id);
    assert.equal((await post('/api/onboarding/complete', {}, bearer(id))).statusCode, 403, id);
    assert.equal((await post('/api/onboarding/reset', {}, bearer(id))).statusCode, 403, id);
  }
});

test('fresh owner: not completed -> save steps -> complete -> completed', async () => {
  let res = await get(OWNER);
  assert.equal(res.statusCode, 200, res.body);
  let state = res.json().state;
  assert.equal(state.completed, false);
  assert.equal(state.currentStep, 1);
  assert.equal(state.totalSteps, 6);

  res = await post('/api/onboarding', { step: 'profile', data: { userName: '  Mohamed  ', language: 'ar' }, currentStep: 3 }, OWNER);
  assert.equal(res.statusCode, 200, res.body);
  state = res.json().state;
  assert.equal(state.data.userName, 'Mohamed');
  assert.equal(state.data.language, 'ar');
  assert.equal(state.currentStep, 3);
  assert.equal(db.prepare('SELECT full_name FROM users WHERE id = ?').get('u-owner').full_name, 'Mohamed');

  // Default local provider (M-03): Ollama qwen3.8:27b at 127.0.0.1.
  res = await post('/api/onboarding', { step: 'provider', data: { aiProvider: 'ollama' }, currentStep: 4 }, OWNER);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().state.data.aiModel, 'qwen3.8:27b');
  assert.equal(res.json().state.data.ollamaUrl, 'http://127.0.0.1:11434');
  const s = (await getSettingsManager().getSettings());
  assert.equal(s.provider, 'local');
  assert.equal(s.local.model, 'qwen3.8:27b');
  assert.equal(s.local.url, 'http://127.0.0.1:11434');

  res = await post('/api/onboarding', { step: 'channels', data: { selectedChannels: ['web', 'telegram', 'web'] }, currentStep: 5 }, OWNER);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().state.data.selectedChannels, ['web', 'telegram']);

  res = await post('/api/onboarding', { step: 'skills', data: { selectedSkills: ['weather', 'web-search'] }, currentStep: 6 }, OWNER);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().state.data.selectedSkills, ['weather', 'web-search']);

  // State survives a reload (stored in the DB).
  state = (await get(OWNER)).json().state;
  assert.equal(state.completed, false);
  assert.equal(state.currentStep, 6);
  assert.equal(state.data.userName, 'Mohamed');

  res = await post('/api/onboarding/complete', {}, OWNER);
  assert.equal(res.statusCode, 200, res.body);
  state = (await get(OWNER)).json().state;
  assert.equal(state.completed, true);
  assert.equal(state.skipped, false);
  assert.ok(db.prepare('SELECT completed_at FROM onboarding_state WHERE user_id = ?').get('u-owner').completed_at);
});

test('input is validated per step', async () => {
  const bad = [
    { step: 'nope', data: {} },
    { step: 'profile', data: { userName: '' } },
    { step: 'profile', data: { userName: 'A', language: 'xx' } },
    { step: 'profile', data: { userName: 'A', role: 'owner' } },
    { step: 'provider', data: { aiProvider: 'google' } },
    { step: 'provider', data: { aiProvider: 'ollama', ollamaUrl: 'http://10.0.0.5:11434' } },
    { step: 'provider', data: { aiProvider: 'ollama', ollamaUrl: 'http://evil.example:11434' } },
    { step: 'provider', data: { aiProvider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434/' + '../'.repeat(1000) } },
    { step: 'provider', data: { aiProvider: 'ollama', apiKey: 'sk-should-not-be-here' } },
    { step: 'provider', data: { aiProvider: 'anthropic', aiModel: 'claude-x' } },
    { step: 'provider', data: { aiProvider: 'openai', apiKey: 'has space in it' } },
    { step: 'channels', data: { selectedChannels: ['web', 'sms'] } },
    { step: 'channels', data: { selectedChannels: 'web' } },
    { step: 'skills', data: { selectedSkills: ['../etc'] } },
    { currentStep: 0 },
    { currentStep: 7 },
    {},
    { userId: 'u-admin', currentStep: 2 },
  ];
  for (const payload of bad) {
    const res = await post('/api/onboarding', payload, OWNER);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.ok(!res.body.includes('sk-should-not-be-here'));
  }
  assert.equal((await post('/api/onboarding/complete', { skipped: 'yes' }, OWNER)).statusCode, 400);
});

test('provider step: API key stored encrypted, returned masked, never logged', async () => {
  const KEY = 'sk-ant-test-' + randomBytes(16).toString('hex');
  let res = await post('/api/onboarding', { step: 'provider', data: { aiProvider: 'anthropic', apiKey: KEY } }, OWNER);
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(!res.body.includes(KEY));
  const data = res.json().state.data;
  assert.equal(data.aiProvider, 'anthropic');
  assert.equal(data.aiModel, 'claude-sonnet-4-5-20250929');
  assert.equal(data.apiKeySet, true);
  assert.equal(data.apiKeyMasked, '••••' + KEY.slice(-4));
  assert.equal(data.ollamaUrl, undefined);

  // At rest: settings row holds ciphertext, onboarding answers hold no key.
  const settingsRow = db.prepare(`SELECT value FROM app_settings WHERE key = 'agent_settings'`).get().value;
  assert.ok(!settingsRow.includes(KEY));
  const answers = db.prepare('SELECT answers FROM onboarding_state WHERE user_id = ?').get('u-owner').answers;
  assert.ok(!answers.includes(KEY));
  assert.equal((await getSettingsManager().getSettings()).claude.apiKey, KEY); // decryptable by the app
  assert.equal((await getSettingsManager().getSettings()).provider, 'claude');

  // Sending the masked value back keeps the stored key.
  res = await post('/api/onboarding', { step: 'provider', data: { aiProvider: 'anthropic', apiKey: data.apiKeyMasked } }, OWNER);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await getSettingsManager().getSettings()).claude.apiKey, KEY);

  res = await get(OWNER);
  assert.ok(!res.body.includes(KEY));
  assert.ok(!logged.some(l => l.includes(KEY)), 'API key must never be logged');
});

test('skip marks complete; reset starts over', async () => {
  let res = await post('/api/onboarding/reset', {}, OWNER);
  assert.equal(res.statusCode, 200, res.body);
  let state = res.json().state;
  assert.equal(state.completed, false);
  assert.equal(state.currentStep, 1);
  assert.deepEqual(Object.keys(state.data).filter(k => k !== 'apiKeySet' && k !== 'apiKeyMasked'), []);

  res = await post('/api/onboarding/complete', { skipped: true }, OWNER);
  assert.equal(res.statusCode, 200, res.body);
  state = (await get(OWNER)).json().state;
  assert.equal(state.completed, true);
  assert.equal(state.skipped, true);

  // State is per user: another owner starts fresh.
  addUser('u-owner2', 'owner');
  assert.equal((await get(bearer('u-owner2'))).json().state.completed, false);
});
