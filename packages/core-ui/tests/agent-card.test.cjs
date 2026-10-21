// AGENT-CARD-01 / MEMORY-PAGE-02: contract, controllers and views (offline mock).
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { SessionClient, allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { createLoginMock } = require('../src/session-mock.ts');
const { AgentCardController } = require('../src/agent-card.ts');
const { CardView } = require('../src/AgentCard.tsx');
const { MemoryItemsController } = require('../src/memory-items.ts');
const { MemoryPage } = require('../src/MemoryViews.tsx');
const { memoryItem, agentCardResponse } = require('../src/agent-card-contract.js');

const MID = '00000000-0000-4000-8000-000000000001';
async function client() {
  const c = new SessionClient({ mock: createLoginMock() });
  c.selectMode('mock'); await c.login('demo@example.invalid', 'mock-only');
  return c;
}

test('contract (browser and bridge): profile, persona and memory requests are exact', () => {
  for (const allow of [allowedRequest, allowed]) {
    assert.equal(allow('PUT', '/api/agents/sample-main', { expectedVersion: 1, role: 'manager', department: 'sales', description: 'x' }), true);
    assert.equal(allow('PUT', '/api/agents/sample-main', { expectedVersion: 1, role: 'boss' }), false);
    assert.equal(allow('PUT', '/api/agents/sample-main', { expectedVersion: 1, department: 'Sales!' }), false);
    assert.equal(allow('PUT', '/api/agents/sample-main', { expectedVersion: 1, model: 'x' }), false);
    assert.equal(allow('PUT', '/api/agents/sample-main', { expectedVersion: 1 }), false);
    assert.equal(allow('GET', '/api/agents/sample-main/personality/current'), true);
    assert.equal(allow('POST', '/api/agents/sample-main/personality/versions', { preset: 'careful-auditor', note: 'why' }), true);
    assert.equal(allow('POST', '/api/agents/sample-main/personality/versions', { preset: 'careful-auditor', traits: {} }), false);
    assert.equal(allow('POST', '/api/agents/sample-main/personality/lock'), true);
    assert.equal(allow('POST', '/api/agents/sample-main/personality/lock', {}), false);
    assert.equal(allow('POST', '/api/agents/sample-main/personality/rollback', { version: 2 }), true);
    assert.equal(allow('POST', '/api/agents/../x/personality/rollback', { version: 2 }), false);
    assert.equal(allow('GET', '/api/memory'), true);
    assert.equal(allow('GET', '/api/memory?userId=x'), false);
    assert.equal(allow('POST', '/api/memory', { type: 'fact', content: 'x', importance: 7, drawer: { kind: 'project', key: 'launch' } }), true);
    assert.equal(allow('POST', '/api/memory', { type: 'fact', content: 'x', drawer: { kind: 'project' } }), false);
    assert.equal(allow('POST', '/api/memory', { type: 'secret', content: 'x' }), false);
    assert.equal(allow('PUT', `/api/memory/${MID}`, { content: 'y' }), true);
    assert.equal(allow('PUT', '/api/memory/not-a-uuid', { content: 'y' }), false);
    assert.equal(allow('DELETE', `/api/memory/${MID}`), true);
    assert.equal(allow('POST', `/api/memory/${MID}/forget`), true);
    assert.equal(allow('POST', '/api/memory/consolidate', {}), false);
    // Existing routes are unchanged.
    assert.equal(allow('GET', '/api/memory/files/owner?agentId=main'), true);
  }
});

test('memory projection drops embeddings and owner ids; errors never pass text', () => {
  const m = memoryItem({ id: MID, type: 'fact', content: 'x', importanceScore: 0.8, embedding: [1, 2], userId: 'u1', drawer: { kind: 'owner' }, createdAt: 'c', memoryLayer: 'factual' });
  assert.deepEqual(m, { id: MID, type: 'fact', content: 'x', importance: 8, drawer: { kind: 'owner' }, layer: 'factual', createdAt: 'c', tags: [] });
  assert.equal(agentCardResponse('/api/memory', 500, { error: 'stack /Users/x' }), null);
  assert.deepEqual(agentCardResponse('/api/agents/a/personality/versions', 409, { code: 'personality_locked', error: 'x' }), { code: 'personality_locked' });
});

test('agent card: profile, persona versions, lock, rollback and permissions', async t => {
  const c = new AgentCardController(await client(), 'sample-main'); t.after(() => c.dispose());
  await c.load();
  assert.equal(c.getSnapshot().phase, 'ready');
  assert.equal(c.getSnapshot().agent.name, 'Offline main');
  c.editProfile({ role: 'manager', department: ' Sales ', description: 'Runs sales.' });
  assert.equal(c.profileChanged(), true);
  await c.saveProfile();
  assert.equal(c.getSnapshot().agent.role, 'manager');
  assert.equal(c.getSnapshot().agent.department, 'sales');
  assert.equal(c.getSnapshot().saved, 'Profile saved.');

  await c.openTab('persona');
  c.applyPreset('careful-auditor');
  assert.equal(c.personaChanged(), true);
  await c.savePersona('More careful');
  assert.equal(c.getSnapshot().persona.version, 2);
  assert.equal(c.getSnapshot().persona.preset, 'careful-auditor');
  assert.equal(c.getSnapshot().versions.length, 2);
  c.setTrait('warmth', 90);
  assert.equal(c.getSnapshot().personaDraft.preset, null, 'a moved slider makes it custom');
  await c.lock(true);
  assert.equal(c.getSnapshot().persona.locked, true);
  let html = renderToStaticMarkup(React.createElement(CardView, { card: c, onBack: () => {} }));
  assert.match(html, /Unlock persona/);
  await c.lock(false);
  await c.rollback(1);
  assert.equal(c.getSnapshot().persona.preset, 'balanced-assistant');

  await c.openTab('permissions');
  c.toggleDrawer('people', 'read');
  c.toggleTool('web_fetch');
  assert.equal(c.permissionsChanged(), true);
  await c.savePermissions();
  assert.equal(c.getSnapshot().saved, 'Permissions saved.');

  await c.openTab('memory');
  html = renderToStaticMarkup(React.createElement(CardView, { card: c, onBack: () => {} }));
  // Board M6: drawer access, its own notes, handoffs, skills and tools at a glance.
  for (const words of [/may remember/, /Share what it learns with the team/, /Save memory access/, /Its own notes/, /Handoffs/, /Skills/, /Tools &amp; MCP/, /Memory \d+ of \d+ on|of \d+ on/])
    assert.match(html, words);
});

test('memory page: drawers, add to a project, edit, history and forget', async t => {
  const cl = await client();
  const m = new MemoryItemsController(cl); t.after(() => m.dispose());
  await m.load();
  assert.equal(m.getSnapshot().phase, 'ready');
  const before = m.getSnapshot().items.length;
  assert.ok(m.getSnapshot().drawers.some(d => d.kind === 'project' && d.key === 'launch'));
  m.openDrawer('project:launch');
  assert.equal(m.visible().length, 1);
  m.startAdd();
  assert.deepEqual(m.getSnapshot().adding.drawer, { kind: 'project', key: 'launch' });
  m.editAdd({ content: 'Fictional: the launch page needs a pricing table.', type: 'context', importance: 8 });
  await m.saveAdd();
  assert.equal(m.getSnapshot().items.length, before + 1);
  assert.equal(m.visible().length, 2);
  const id = m.visible()[0].id;
  m.startEdit(id); m.editDraft('Fictional: the launch page needs a pricing table and FAQ.'); await m.saveEdit();
  assert.match(m.getSnapshot().items.find(x => x.id === id).content, /FAQ/);
  await m.toggleHistory(id);
  assert.equal(m.getSnapshot().history[id].length, 2);
  m.setQuery('pricing'); assert.equal(m.visible().length, 1);
  await m.forget(id);
  assert.equal(m.getSnapshot().items.length, before);
  const html = renderToStaticMarkup(React.createElement(MemoryPage, { client: cl }));
  assert.match(html, /aria-label="Memory views"/, 'the memory page opens with its views (files and reviews moved into Review, board M0)');
});

test('tools are grouped by kind; a group turns on or off together (server-off tools stay off)', async t => {
  const { toolGroup } = require('../src/agent-card.ts');
  assert.equal(toolGroup('memory_save'), 'Memory');
  assert.equal(toolGroup('board_move'), 'Board');
  assert.equal(toolGroup('read'), 'Files');
  assert.equal(toolGroup('web_fetch'), 'Internet and browser');
  assert.equal(toolGroup('browser_navigate'), 'Internet and browser');
  assert.equal(toolGroup('telegram_send'), 'Messages and reminders');
  assert.equal(toolGroup('exec'), 'System');
  assert.equal(toolGroup('something_new'), 'Other');
  const c = new AgentCardController(await client(), 'sample-main'); t.after(() => c.dispose());
  await c.load(); await c.openTab('mcp'); // board M6: tools live under Tools & MCP
  c.setTools(['web_fetch', 'telegram_send', 'exec'], true);
  const d = c.getSnapshot().grantDraft;
  assert.ok(d.includes('web_fetch') && d.includes('telegram_send'));
  assert.ok(!d.includes('exec'), 'a tool the server keeps off is never turned on');
  c.setTools(['memory_search', 'memory_save'], false);
  assert.ok(!c.getSnapshot().grantDraft.includes('memory_search'));
  const html = renderToStaticMarkup(React.createElement(CardView, { card: c, onBack: () => {} }));
  assert.match(html, /<span class="tool-group-name">Memory<\/span>/);
  assert.match(html, /Turn all/);
});

test('model choice: chat picks a model for the next reply; the card saves a default model', async t => {
  const { ConversationsController } = require('../src/conversations.ts');
  const cl = await client();
  const calls = [];
  const conv = new ConversationsController(cl); t.after(() => conv.dispose());
  await conv.load();
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(conv.getSnapshot().models.map(m => [m.id, m.provider]), [['qwen-fiction:7b', 'ollama'], ['llama-fiction:3b', 'ollama'], ['lmstudio:fiction/mistral-7b', 'lmstudio']]);
  conv.selectModel('not-installed'); assert.equal(conv.getSnapshot().model, '', 'only listed models can be picked');
  conv.selectModel('llama-fiction:3b'); assert.equal(conv.getSnapshot().model, 'llama-fiction:3b');
  for (const allow of [allowedRequest, allowed]) {
    assert.equal(allow('POST', '/api/chat/conversations/3f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b/runs', { runId: 'run-0123456789ab', message: 'hi', model: 'qwen3.8:27b' }), true);
    assert.equal(allow('POST', '/api/chat/conversations/3f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b/runs', { runId: 'run-0123456789ab', message: 'hi', model: '../x' }), false);
    assert.equal(allow('PUT', '/api/agents/sample-main', { expectedVersion: 1, model: 'qwen3.8:27b', provider: 'ollama' }), true);
    assert.equal(allow('PUT', '/api/agents/sample-main', { expectedVersion: 1, model: 'qwen3.8:27b' }), false, 'model and provider go together');
    assert.equal(allow('PUT', '/api/agents/sample-main', { expectedVersion: 1, model: 'x', provider: 'openai' }), false);
    assert.equal(allow('GET', '/api/models'), true);
  }
  const c = new AgentCardController(cl, 'sample-main'); t.after(() => c.dispose());
  await c.load(); await new Promise(r => setTimeout(r, 50));
  assert.equal(c.getSnapshot().models.length, 2);
  c.editProfile({ model: 'qwen-fiction:7b' });
  await c.saveProfile();
  assert.equal(c.getSnapshot().agent.model, 'qwen-fiction:7b');
  assert.equal(c.getSnapshot().agent.provider, 'ollama');
  const html = renderToStaticMarkup(React.createElement(CardView, { card: c, onBack: () => {} }));
  assert.match(html, /On this computer/);
});

test('chat agent panel shows tool groups, permissions and memory, and saves a group switch', async t => {
  const { AgentPanelBody } = require('../src/AgentPanel.tsx');
  const c = new AgentCardController(await client(), 'sample-main', 'memory'); t.after(() => c.dispose());
  await c.load();
  const html = renderToStaticMarkup(React.createElement(AgentPanelBody, { card: c }));
  assert.match(html, /Skills and tools/);
  assert.match(html, /\d+ of \d+ on/);
  assert.match(html, /Connectors/);
  assert.match(html, /Spend money/);
  assert.match(html, /it can read/);
  const before = c.getSnapshot().grants.granted.length;
  c.setTools(['web_fetch'], true); await c.savePermissions();
  assert.ok(c.getSnapshot().grants.granted.includes('web_fetch'));
  assert.ok(c.getSnapshot().grants.granted.length >= before);
  assert.equal(require('../src/agent-card.ts').toolGroup('mcp:files:read'), 'Connectors');
});

test('the model list survives both projections on the live path (bridge, then browser)', () => {
  const { agentCardResponse } = require('../src/agent-card-contract.js');
  const raw = { models: [{ id: 'qwen3.8:27b', name: '🏠 qwen3.8:27b', provider: 'local', size: '16.9GB' }, { id: 'claude-x-1', name: '🧠 Claude X', provider: 'claude', size: 'API' }, { id: 'gpt-4', provider: 'openai' }] };
  const once = agentCardResponse('/api/models', 200, raw);
  const twice = agentCardResponse('/api/models', 200, once);
  assert.deepEqual(twice, once);
  assert.deepEqual(once.models.map(m => [m.id, m.provider, m.label]), [['qwen3.8:27b', 'ollama', 'qwen3.8:27b'], ['claude-x-1', 'claude', 'Claude X']]);
});
