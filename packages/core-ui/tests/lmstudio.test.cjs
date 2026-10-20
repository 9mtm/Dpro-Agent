// CHAT-PRO-02 G: LM Studio models — the model list keeps them (prefixed ids, both
// projections), a run may carry an LM Studio model, and "LM Studio is not running"
// reaches the reply. Since CORE-PICKER-01 the chat picker chooses who answers (the
// agent or a coding app in the terminal); local models are chosen in Settings.
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

test('the chat picker chooses who answers: no local model list; the coding apps only when the backend lists them (CORE-PICKER-01)', async t => {
  const calls = []; const base = createLoginMock();
  let withApps = false;
  const client = new SessionClient({ mock: async r => {
    calls.push({ method: r.method, path: r.path, body: r.body });
    const res = await base(r);
    if (withApps && r.path === '/api/models' && res.status === 200) return { ...res, body: { models: [...res.body.models,
      { id: 'subscription:claude', provider: 'subscription', label: 'Claude Code · existing account', size: '', variants: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: '--bad', label: 'x' }] },
      { id: 'subscription:codex', provider: 'subscription', label: 'Codex · existing ChatGPT account', size: '' }] } };
    return res;
  } });
  client.selectMode('mock'); await client.login('demo@example.invalid', 'mock-only');
  let n = 0;
  const c = new ConversationsController(client, () => `id${String(++n).padStart(10, '0')}`);
  t.after(() => c.dispose());
  await c.load();
  const end = Date.now() + 3000; while (!c.getSnapshot().models.length && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  assert.ok(c.getSnapshot().models.some(m => m.id === 'lmstudio:fiction/mistral-7b'), 'the list itself still has the local models (Settings uses it)');
  // Who answers lives at the top of the Details panel; the composer keeps only the agent list.
  const panel = (html) => /<section class="panel-card who-answers">(.*?)<\/section>/.exec(html)?.[1] ?? '';
  let html = renderToStaticMarkup(React.createElement(ChatView, { controller: c, mode: 'mock', client }));
  assert.equal((html.match(/<select/g) || []).length, 1, 'the composer has only the agent list');
  assert.match(panel(html), /<h3>Who answers<\/h3>/);
  assert.match(panel(html), /role="radio" aria-checked="true"><span class="who-icon">.*?Main agent<small>Own model · set in Settings<\/small>/);
  assert.match(panel(html), /disabled="".*?Claude Code<small>Desktop app only<\/small>/);
  assert.match(panel(html), /disabled="".*?Codex<small>Desktop app only<\/small>/);
  assert.doesNotMatch(html, /qwen-fiction:7b|fiction\/mistral-7b|On this computer/);
  // Desktop backend: the apps are listed with their own models; picking one shows its model list and the composer chip.
  withApps = true; await new Promise(r => setTimeout(r, 5100)); await c.loadModels(true);
  assert.deepEqual(c.getSnapshot().models.find(m => m.id === 'subscription:claude').variants.map(v => v.id), ['opus', 'sonnet']);
  html = renderToStaticMarkup(React.createElement(ChatView, { controller: c, mode: 'mock', client }));
  assert.match(panel(html), /Claude Code<small>Choose a project folder<\/small>/);
  c.selectModel('subscription:claude/opus');
  html = renderToStaticMarkup(React.createElement(ChatView, { controller: c, mode: 'mock', client }));
  assert.match(panel(html), /<label class="who-model"><span>Model<\/span><select><option value="">Default<\/option><option value="opus" selected="">Opus<\/option><option value="sonnet">Sonnet<\/option><\/select>/);
  assert.match(html, /<button type="button" class="composer-who"[^>]*>.*?<span>Claude Code · Opus<\/span><\/button>/);
});

test('the reply says LM Studio is not running and what to do', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/ChatView.tsx'), 'utf8');
  assert.match(src, /turn\.code === 'lmstudio_not_running' \? 'LM Studio is not running'/);
  assert.match(src, /start its local server/);
});
