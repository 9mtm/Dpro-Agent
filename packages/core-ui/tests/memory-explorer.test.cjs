require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { memoryRecallRoute, memoryRecallResponse } = require('../src/memory-recall-contract.js');
const { agentCardResponse, cardRoute } = require('../src/agent-card-contract.js');
const { MemoryExplorerController } = require('../src/memory-explorer.ts');
const { Explorer } = require('../src/MemoryExplorer.tsx');

const id = n => `0b9c1d2e-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n, text, drawerId = 'owner', topicKey = null) => ({ id: id(n), type: 'fact', preview: text, drawerId, topicKey, importance: 8, layer: 'factual', createdAt: '2026-10-21T08:00:00.000Z', sourceAgentId: '_main' });

function backend() {
  const calls = [];
  const all = [row(1, 'صار ما يشرب شاي، بس قهوة بدون سكر.', 'owner', 'owner-drinks'), row(2, 'Green tea for guests at the office.', 'project:office'), row(3, 'Sara prefers tea meetings, not calls.', 'people:sara')];
  const client = { request: async r => {
    calls.push(r);
    assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`); assert.ok(allowed(r.method, r.path, r.body), `bridge ${r.method} ${r.path}`);
    // Projected twice, as on the live path (the bridge, then the browser).
    const once = (status, body) => memoryPagesRoute(r.path) ? memoryPagesResponse(r.path, status, body) : memoryRecallRoute(r.path) ? memoryRecallResponse(r.path, status, body) : cardRoute(r.path) ? agentCardResponse(r.path, status, body) : body;
    const project = (status, body) => ({ status, body: once(status, once(status, body)) });
    if (r.path.startsWith('/api/memory/scopes/memories')) {
      const u = new URLSearchParams(r.path.split('?')[1]);
      const scope = u.get('scope');
      let items = all.filter(i => scope === 'company' || i.drawerId === scope);
      if (u.get('q')) items = items.filter(i => i.preview.includes(u.get('q')));
      const page = u.get('cursor') ? items.slice(2) : items.slice(0, 2);
      return project(200, { scope, items: page, total: items.length, nextCursor: !u.get('cursor') && items.length > 2 ? 'c2' : null, facets: { type: { fact: items.length }, layer: {}, drawer: Object.fromEntries(items.map(i => [i.drawerId, 1])) } });
    }
    if (r.path === `/api/memory/${id(1)}/versions`) return project(200, { memoryId: id(1), versions: [
      { version: 1, change: 'create', type: 'fact', content: 'Likes tea.', createdAt: '2026-07-30T08:00:00.000Z', createdBy: 'import', reason: null, proposalId: null },
      { version: 2, change: 'update', type: 'fact', content: 'Mohamed drinks tea every morning.', createdAt: '2026-08-12T08:00:00.000Z', createdBy: 'f3a1-owner-uuid', reason: null, proposalId: null },
      { version: 3, change: 'update', type: 'fact', content: 'صار ما يشرب شاي، بس قهوة بدون سكر.', createdAt: '2026-10-21T08:00:00.000Z', createdBy: 'f3a1-owner-uuid', reason: null, proposalId: 'p-1' }] });
    if (r.path === `/api/memory/${id(1)}` && r.method === 'PUT') return project(200, { memory: { id: id(1), type: 'fact', content: r.body.content, importance: 8, drawer: { kind: 'owner' }, createdAt: '2026-10-21T09:00:00.000Z' } });
    if (r.path === `/api/memory/${id(1)}/move`) return project(200, { memory: { id: id(1) }, from: 'owner', to: r.body.drawer });
    if (r.path.endsWith('/forget')) return project(200, { success: true });
    if (r.path === '/api/memory/search') return project(200, { memories: [{ id: id(1), type: 'fact', content: 'صار ما يشرب شاي', importance: 8, drawer: { kind: 'owner' }, createdAt: '2026-10-21T08:00:00.000Z', topicKey: 'owner-drinks' }] });
    if (r.path === '/api/memory' && r.method === 'POST') return project(200, { memory: { id: id(9), type: r.body.type, content: r.body.content, drawer: r.body.drawer, createdAt: '2026-10-21T09:00:00.000Z' } });
    return { status: 404, body: null };
  } };
  return { client, calls };
}

test('the explorer pages on the server and filters by scope, words and meaning (board M3)', async () => {
  const { client, calls } = backend();
  const c = new MemoryExplorerController(client);
  await c.load();
  assert.equal(c.getSnapshot().items.length, 2); assert.equal(c.getSnapshot().total, 3);
  await c.more(); assert.equal(c.getSnapshot().items.length, 3, 'load more appends the next page');
  c.setScope('people:sara'); await new Promise(r => setTimeout(r, 0));
  assert.match(calls.at(-1).path, /scope=people%3Asara/); assert.equal(c.getSnapshot().items.length, 1);
  c.setScope('company'); await new Promise(r => setTimeout(r, 0));
  c.setQuery('tea'); await c.load(); assert.match(calls.at(-1).path, /q=tea/);
  await c.searchMeaning();
  assert.equal(c.getSnapshot().meaning, true); assert.equal(c.getSnapshot().items[0].topicKey, 'owner-drinks');
  const html = renderToStaticMarkup(React.createElement(Explorer, { c, agents: { _main: 'Main Agent' } }));
  for (const words of ['Search memories', 'by meaning', 'Drawer', 'Agent', 'Type', 'Topic', 'Memory', 'Importance', 'Updated', 'owner-drinks']) assert.ok(html.includes(words), words);
  c.dispose();
});

test('the side panel shows the topic history; edit saves a new version, move and forget ask first', async () => {
  const { client, calls } = backend();
  const c = new MemoryExplorerController(client);
  await c.load(); await c.openMemory(id(1));
  const s = c.getSnapshot();
  assert.deepEqual(s.versions.map(v => [v.version, v.by]), [[3, 'you'], [2, 'you'], [1, 'import']]);
  assert.equal(s.full, 'صار ما يشرب شاي، بس قهوة بدون سكر.');
  const html = renderToStaticMarkup(React.createElement(Explorer, { c, agents: {} }));
  for (const words of ['Topic · owner-drinks · About you', 'History', 'v3', 'changed by you · approved by you', 'Likes tea.', 'Edit', 'Move drawer', 'Forget…']) assert.ok(html.includes(words), words);
  c.startEdit(); c.editDraft('Coffee, no sugar.'); await c.saveEdit();
  assert.deepEqual(calls.find(r => r.method === 'PUT').body, { content: 'Coffee, no sugar.' });
  c.startMove(); c.setMoveTo('people:mohamed'); await c.move();
  assert.deepEqual(calls.find(r => r.path.endsWith('/move')).body, { drawer: 'people:mohamed' });
  await c.forget(); assert.ok(!calls.some(r => r.path.endsWith('/forget')), 'forget needs the confirm step');
  c.askForget(); await c.forget();
  assert.ok(calls.some(r => r.path === `/api/memory/${id(1)}/forget`)); assert.equal(c.getSnapshot().open, null);
  c.dispose();
});

test('bulk forget across pages asks once; add saves the topic key', async () => {
  const { client, calls } = backend();
  const c = new MemoryExplorerController(client);
  await c.load(); c.checkAllShown(true); await c.more(); c.toggleCheck(id(3));
  assert.equal(c.getSnapshot().checked.length, 3);
  c.askBulk('forget');
  assert.ok(renderToStaticMarkup(React.createElement(Explorer, { c, agents: {} })).includes('Forget 3 for good?'));
  await c.runBulk();
  assert.equal(calls.filter(r => r.path.endsWith('/forget')).length, 3);
  c.startAdd(); c.editAdd({ content: 'Coffee without sugar.', topicKey: 'Owner Drinks' }); await c.saveAdd();
  assert.deepEqual(calls.find(r => r.path === '/api/memory' && r.method === 'POST').body, { type: 'fact', content: 'Coffee without sugar.', importance: 6, drawer: { kind: 'owner' }, topicKey: 'owner-drinks' });
  c.dispose();
});
