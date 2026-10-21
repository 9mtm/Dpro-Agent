// MEM-FINISH-01 (board M14 + M4): waiting links with their source text, bulk approve (one call per
// link), clusters by project, topic preview -> make topic with the preview hash, not a topic,
// rebuild map; the map as one agent sees it.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { MemoryMapController } = require('../src/memory-map.ts');
const { KnowledgeMap } = require('../src/MemoryMap.tsx');

const H1 = 'a'.repeat(64);
const C1 = '1'.repeat(32), C2 = '2'.repeat(32);
const ent = (id, name, kind) => ({ id, name, kind, aliases: [], memories: 2, links: 1, updatedAt: '2026-10-21 10:00:00' });
const link = (id, a, rel, b, status, mem) => ({ id, type: rel, status, from: { id: a[0], name: a[1], kind: a[2] }, to: { id: b[0], name: b[1], kind: b[2] }, memoryIds: [mem], createdAt: '2026-10-21 10:00:00' });
function backend({ stale = false } = {}) {
  const calls = [];
  let pending = [link('l1', ['e1', 'Ahmed', 'person'], 'works_on', ['e2', 'Tel-Agent', 'project'], 'pending', 'm1'), link('l2', ['e3', 'Sara', 'person'], 'decided', ['e4', 'Print shop in Berlin', 'decision'], 'pending', 'm2')];
  let clusters = [{ id: C1, drawer: 'project:flowxtra', name: 'Tuesday launch posts', suggestedTopicKey: 'flowxtra.launch-posts', entities: [{ id: 'e1', name: 'Ahmed', kind: 'person', memories: 3 }, { id: 'e5', name: 'Short videos', kind: 'topic', memories: 2 }], memoryIds: ['m1', 'm3', 'm4'] },
    { id: C2, drawer: 'project:tel-agent', name: 'Print shop', suggestedTopicKey: 'tel-agent.print-shop', entities: [{ id: 'e3', name: 'Sara', kind: 'person', memories: 2 }], memoryIds: ['m2', 'm5'] }];
  let hash = H1;
  const client = { request: async r => {
    calls.push(r); assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`); assert.ok(allowed(r.method, r.path, r.body), `bridge ${r.method} ${r.path}`);
    const out = (body, status = 200) => ({ status, body: memoryPagesRoute(r.path) ? memoryPagesResponse(r.path, status, memoryPagesResponse(r.path, status, body)) : body });
    const path = r.path.split('?')[0];
    if (path === '/api/memory/graph/entities') return out({ entities: [ent('e1', 'Ahmed', 'person'), ent('e2', 'Tel-Agent', 'project'), ent('e3', 'Sara', 'person'), ent('e4', 'Print shop in Berlin', 'decision')] });
    if (path === '/api/memory/graph/links') return out({ links: r.path.includes('pending') ? pending : [] });
    if (path.startsWith('/api/memory/graph/links/')) { const id = path.split('/')[5]; pending = pending.filter(l => l.id !== id); return out({ link: { id, status: path.endsWith('approve') ? 'active' : 'rejected' } }); }
    if (path === '/api/memory/scopes/memories/m1') return out({ memory: { id: 'm1', type: 'fact', content: 'Ahmed will also help with the Tel-Agent launch.', drawerId: 'project:tel-agent', usage: {}, graph: {}, readers: {} } });
    if (path === '/api/memory/scopes/memories/m2') return out({ memory: { id: 'm2', type: 'fact', content: 'Sara picked the Berlin print shop.', drawerId: 'project:tel-agent', usage: {}, graph: {}, readers: {} } });
    if (path === '/api/memory/graph/clusters') return out({ clusters });
    if (path === `/api/memory/graph/clusters/${C1}/topic-preview`) return out({ preview: { cluster: clusters[0], topicKey: r.body.topicKey ?? 'flowxtra.launch-posts', target: { memoryId: 'm3', preview: 'Posts go out on Tuesdays at 09:30.' }, keepKey: [{ memoryId: 'm4', topicKey: 'flowxtra.hooks' }], related: ['m1'], blocked: null, previewHash: hash } });
    if (path === `/api/memory/graph/clusters/${C1}/topic`) { if (stale) return out({ error: 'x', code: 'stale' }, 409); assert.equal(r.body.expectedPreviewHash, hash); clusters = clusters.slice(1); return out({ result: { topicKey: r.body.topicKey, memoryId: 'm3', drawer: 'project:flowxtra' } }); }
    if (path === `/api/memory/graph/clusters/${C2}/dismiss`) { clusters = clusters.filter(c => c.id !== C2); return out({ id: C2, dismissed: true }); }
    if (path === '/api/memory/graph/sync') return out({ indexed: 4, unchanged: 20, pruned: { links: 1, entities: 1 } });
    if (path === '/api/memory/graph/agent-view/writer') return out({ agentId: 'writer', agentName: 'Writer', project: null, readable: ['owner', 'project'], drawers: ['owner', 'project:flowxtra'], entities: [ent('e1', 'Ahmed', 'person')], links: [] });
    return { status: 404, body: null };
  } };
  return { client, calls };
}

test('waiting links show where they came from; selected ones are approved one call each (board M14)', async () => {
  const { client, calls } = backend();
  const c = new MemoryMapController(client);
  await c.load();
  c.setView('links');
  await c.loadReview();
  const html = renderToStaticMarkup(React.createElement(KnowledgeMap, { c, onOpenMemories: () => {}, agents: { writer: 'Writer' } }));
  for (const words of ['Map', 'Waiting links · 2', 'Clusters', 'Rebuild map', 'Links waiting · 2', 'Approve selected', 'A link waits when it came from text an agent wrote', 'Ahmed', '— works on →', 'Tel-Agent',
    'From: “Ahmed will also help with the Tel-Agent launch.”', 'Show on map', 'Projects · flowxtra · 2 things', 'Clusters: by project', 'Max 150 shown', 'Groups that could become topics', 'Tuesday launch posts', '3 memories', 'Ahmed · Short videos',
    'flowxtra.launch-posts', 'Preview topic', 'Not a topic', 'nothing is merged on its own'])
    assert.ok(html.includes(words), words);
  c.toggleLink('l1'); c.toggleLink('l2');
  await c.decideSelected('approve');
  assert.deepEqual(calls.filter(r => r.path.startsWith('/api/memory/graph/links/')).map(r => r.path), ['/api/memory/graph/links/l1/approve', '/api/memory/graph/links/l2/approve']);
  assert.equal(c.getSnapshot().result, '2 links approved.');
  assert.equal(c.pending().length, 0);
});

test('a group becomes a topic only after its preview, with the preview hash; "not a topic" removes it', async () => {
  const { client, calls } = backend();
  const c = new MemoryMapController(client);
  await c.load(); c.setView('clusters'); await c.loadReview();
  c.setKey(C1, 'flowxtra.tuesday-posts');
  await c.previewTopic(C1);
  const html = renderToStaticMarkup(React.createElement(KnowledgeMap, { c, onOpenMemories: () => {} }));
  assert.ok(html.includes('gets the key') && html.includes('1 keep their own key (never renamed).') && html.includes('Make topic'));
  await c.makeTopic();
  assert.deepEqual(calls.find(r => r.path.endsWith('/topic')).body, { topicKey: 'flowxtra.tuesday-posts', expectedPreviewHash: H1, confirm: true });
  assert.match(c.getSnapshot().result, /is now a topic/);
  await c.dismiss(C2);
  assert.equal(c.getSnapshot().clusters.length, 0);
  await c.rebuild();
  assert.match(c.getSnapshot().result, /Map rebuilt: 4 memories read, 2 leftovers removed/);
});

test('a changed group stops "Make topic"; the map can be seen as one agent sees it (board M4)', async () => {
  const { client } = backend({ stale: true });
  const c = new MemoryMapController(client);
  await c.load(); c.setView('clusters'); await c.loadReview();
  await c.previewTopic(C1);
  await c.makeTopic();
  assert.match(c.getSnapshot().notice, /changed since the preview/);
  c.setView('map');
  c.setAgent('writer');
  await c.load();
  assert.deepEqual(c.getSnapshot().entities.map(e => e.name), ['Ahmed']);
  const html = renderToStaticMarkup(React.createElement(KnowledgeMap, { c, onOpenMemories: () => {}, agents: { writer: 'Writer' } }));
  assert.ok(html.includes('The map as Writer sees it: About you, Projects.'));
});
