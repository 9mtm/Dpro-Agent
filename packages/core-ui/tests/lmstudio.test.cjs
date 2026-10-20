// CHAT-PRO-02 G: LM Studio models in the chat — the model list keeps them (prefixed ids,
// both projections), the picker shows one "On this computer" list, a picked LM Studio
// model goes with the run, and "LM Studio is not running" reaches the reply.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { SessionClient, allowedRequest } = require('../src/session.ts');
const { createLoginMock } = require('../src/session-mock.ts');
const { ConversationsController } = require('../src/conversations.ts');
const { ChatView } = require('../src/ChatView.tsx');
const { agentCardResponse } = require('../src/agent-card-contract.js');
const { projectRunEvent } = require('../src/conversation-contract.js');
const { allowed } = require('../scripts/application-server.cjs');

const CID = '3f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b';

test('the model list keeps LM Studio models through both projections; the prefix must match the provider', () => {
  const raw = { models: [
    { id: 'qwen3.8:27b', name: '🏠 qwen3.8:27b', provider: 'local', size: '16.9GB' },
    { id: 'lmstudio:qwen/qwen3-8b', name: 'qwen/qwen3-8b', provider: 'lmstudio', size: '' },
    { id: 'lmstudio:llama-3.2-3b-instruct@q4_k_m', name: 'llama-3.2-3b-instruct@q4_k_m', provider: 'lmstudio' },
    { id: 'qwen/qwen3-8b', provider: 'lmstudio' },            // no prefix: dropped
    { id: 'lmstudio:sneaky', provider: 'local' },             // prefix on another provider: dropped
    { id: 'lmstudio:bad id', provider: 'lmstudio' },          // not a model id: dropped
  ] };
  const once = agentCardResponse('/api/models', 200, raw);
  assert.deepEqual(agentCardResponse('/api/models', 200, once), once);
  assert.deepEqual(once.models.map(m => [m.id, m.provider, m.label]), [
    ['qwen3.8:27b', 'ollama', 'qwen3.8:27b'], ['lmstudio:qwen/qwen3-8b', 'lmstudio', 'qwen/qwen3-8b'],
    ['lmstudio:llama-3.2-3b-instruct@q4_k_m', 'lmstudio', 'llama-3.2-3b-instruct@q4_k_m'],
  ]);
});

test('a run may carry an LM Studio model id (browser and bridge)', () => {
  for (const allow of [allowedRequest, allowed]) {
    assert.equal(allow('POST', `/api/chat/conversations/${CID}/runs`, { runId: 'run-0123456789ab', message: 'hi', model: 'lmstudio:qwen/qwen3-8b' }), true);
    assert.equal(allow('POST', `/api/chat/conversations/${CID}/runs`, { runId: 'run-0123456789ab', message: 'hi', model: 'lmstudio:llama-3.2-3b@q4_k_m' }), true);
    assert.equal(allow('POST', `/api/chat/conversations/${CID}/runs`, { runId: 'run-0123456789ab', message: 'hi', model: 'lmstudio:a b' }), false);
  }
});

test('"LM Studio is not running" is a typed end of a run; other codes stay hidden', () => {
  assert.deepEqual(projectRunEvent({ seq: 3, type: 'end', status: 'error', ms: 4, code: 'lmstudio_not_running', error: 'private' }), { seq: 3, type: 'end', status: 'error', ms: 4, code: 'lmstudio_not_running' });
  assert.deepEqual(projectRunEvent({ seq: 3, type: 'end', status: 'error', ms: 4, code: 'local_model_missing' }), { seq: 3, type: 'end', status: 'error', ms: 4, code: 'local_model_missing' });
  assert.deepEqual(projectRunEvent({ seq: 3, type: 'end', status: 'error', ms: 4, code: 'something_else' }), { seq: 3, type: 'end', status: 'error', ms: 4 });
});

test('the chat picker: one "On this computer" list with Ollama and LM Studio models; the pick goes with the run', async t => {
  const calls = []; const base = createLoginMock();
  const client = new SessionClient({ mock: async r => { calls.push({ method: r.method, path: r.path, body: r.body }); return base(r); } });
  client.selectMode('mock'); await client.login('demo@example.invalid', 'mock-only');
  let n = 0;
  const c = new ConversationsController(client, () => `id${String(++n).padStart(10, '0')}`);
  t.after(() => c.dispose());
  await c.load();
  const end = Date.now() + 3000; while (!c.getSnapshot().models.length && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  assert.ok(c.getSnapshot().models.some(m => m.id === 'lmstudio:fiction/mistral-7b' && m.provider === 'lmstudio'));
  const html = renderToStaticMarkup(React.createElement(ChatView, { controller: c, mode: 'mock', client }));
  const group = /<optgroup label="On this computer">(.*?)<\/optgroup>/.exec(html);
  assert.ok(group, 'one local group');
  assert.match(group[1], /qwen-fiction:7b/);
  assert.match(group[1], /fiction\/mistral-7b/);
  assert.equal((html.match(/<optgroup/g) || []).length, 1, 'no separate LM Studio group (no Claude key in the mock)');
  // Opening the picker asks again, but not more than every 5 s (the list was just read).
  const before = calls.filter(x => x.path === '/api/models').length;
  await c.loadModels(true); await c.loadModels(true);
  assert.equal(calls.filter(x => x.path === '/api/models').length, before);
  c.selectModel('lmstudio:fiction/mistral-7b');
  assert.equal(c.getSnapshot().model, 'lmstudio:fiction/mistral-7b');
});

test('the reply says LM Studio is not running and what to do', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/ChatView.tsx'), 'utf8');
  assert.match(src, /turn\.code === 'lmstudio_not_running' \? 'LM Studio is not running'/);
  assert.match(src, /start its local server/);
});
