require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { MemoryMapController, layout, MAX_NODES } = require('../src/memory-map.ts');
const { KnowledgeMap } = require('../src/MemoryMap.tsx');

const ent = (id, name, kind) => ({ id, kind, name, aliases: id === 'ahmed' ? ['أحمد'] : [], memories: 2, links: 1, updatedAt: '2026-10-21T08:00:00.000Z' });
const lk = (id, from, to, type, status = 'active') => ({ id, type, status, from: { id: from, name: from, kind: 'person' }, to: { id: to, name: to, kind: 'project' }, memoryIds: ['m1'], createdAt: '2026-10-20T08:00:00.000Z' });
const entities = [ent('ahmed', 'Ahmed', 'person'), ent('flowxtra', 'Flowxtra', 'project'), ent('dpro', 'Dpro', 'project'), ent('genvr', 'GenVR', 'project'), ent('videos', 'Short videos', 'topic'), ent('far', 'Far away', 'place')];
const links = { active: [lk('l1', 'ahmed', 'flowxtra', 'works_on'), lk('l2', 'genvr', 'dpro', 'part_of'), lk('l4', 'flowxtra', 'dpro', 'depends_on')], pending: [lk('l3', 'ahmed', 'videos', 'prefers', 'pending')] };

function backend() {
  const calls = [];
  const client = { request: async r => {
    calls.push(r); assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`);
    const out = (body) => ({ status: 200, body: memoryPagesResponse(r.path, 200, memoryPagesResponse(r.path, 200, body)) });
    if (r.path.startsWith('/api/memory/graph/entities?')) return out({ entities });
    if (r.path === '/api/memory/graph/entities/ahmed') return out({ entity: entities[0], links: [links.active[0], links.pending[0]], timeline: [{ memoryId: 'm1', createdAt: '2026-10-20T08:00:00.000Z', drawer: 'people:ahmed', type: 'fact', preview: 'Runs Flowxtra marketing since June.' }] });
    if (r.path.startsWith('/api/memory/graph/links?status=active')) return out({ links: links.active });
    if (r.path.startsWith('/api/memory/graph/links?status=pending')) return out({ links: links.pending });
    if (r.path === '/api/memory/graph/links/l3/approve') { links.active.push({ ...links.pending.pop(), status: 'active' }); return out({ link: { id: 'l3', status: 'active' } }); }
    return { status: 404, body: null };
  } };
  return { client, calls };
}

test('the map loads at most 150 nodes, filters by kind and shows 1–2 links around a node (board M4)', async () => {
  const { client, calls } = backend();
  const c = new MemoryMapController(client);
  await c.load();
  assert.match(calls[0].path, new RegExp(`limit=${MAX_NODES}`));
  assert.equal(c.visible().nodes.length, 6); assert.equal(c.visible().links.length, 4);
  c.toggleKind('place'); assert.equal(c.visible().nodes.some(n => n.id === 'far'), false);
  await c.select('ahmed');
  c.setDepth(1); assert.deepEqual(c.visible().nodes.map(n => n.id).sort(), ['ahmed', 'flowxtra', 'videos']);
  c.setDepth(2); assert.ok(c.visible().nodes.some(n => n.id === 'dpro'), 'two links deep reaches Dpro');
  const html = renderToStaticMarkup(React.createElement(KnowledgeMap, { c, onOpenMemories: () => {} }));
  for (const words of ['People', 'Projects', 'Topics', 'prefers (review)', 'Ahmed', 'Also: أحمد', 'waiting for your review', 'Runs Flowxtra marketing since June.', 'Open all 2 memories about Ahmed', 'Zoom in'])
    assert.ok(html.includes(words), words);
  assert.match(html, /data-pending="true"/);
  await c.decideLink('l3', 'approve');
  assert.ok(calls.some(r => r.method === 'POST' && r.path === '/api/memory/graph/links/l3/approve'));
  assert.equal(c.getSnapshot().links.filter(l => l.status === 'pending').length, 0);
  c.dispose();
});

test('the layout is deterministic and stays inside the canvas', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const one = layout(ids, [['a', 'b'], ['b', 'c']]); const two = layout(ids, [['a', 'b'], ['b', 'c']]);
  assert.deepEqual(one, two);
  for (const [x, y] of Object.values(one)) { assert.ok(x >= 10 && x <= 880); assert.ok(y >= 10 && y <= 600); }
});
