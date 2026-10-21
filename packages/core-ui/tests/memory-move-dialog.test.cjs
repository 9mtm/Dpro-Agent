// MEM-FINISH-01 (board M13): "Move to another drawer" — search targets, readers before / after,
// optional reason kept in history; and the explorer's M3 detail (used in N replies, map, readers).
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { memoryRecallRoute, memoryRecallResponse } = require('../src/memory-recall-contract.js');
const { MemoryMoveController } = require('../src/memory-move.ts');
const { MoveDialog } = require('../src/MemoryDialogs.tsx');
const { MemoryExplorerController } = require('../src/memory-explorer.ts');
const { Explorer } = require('../src/MemoryExplorer.tsx');

const detail = { id: 'mem-1', type: 'fact', content: 'Tel-Agent price is 49 € per month.', drawerId: 'project:flowxtra', topicKey: 'tel-agent.price', importance: 7, layer: 'factual', createdAt: '2026-10-20 10:00:00', sourceAgentId: 'writer', source: 'agent',
  usage: { usedIn: 3, lastUsedAt: '2026-10-21 09:00:00', recent: [] }, graph: { entities: [{ id: 'e1', kind: 'project', name: 'Tel-Agent' }], links: [] }, readers: { scope: 'project:flowxtra', count: 12, total: 30, all: false, archived: false } };
function backend({ taken = false } = {}) {
  const calls = [];
  const client = { request: async r => {
    calls.push(r); assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`); assert.ok(allowed(r.method, r.path, r.body), `bridge ${r.method} ${r.path}`);
    const f = (status, x) => memoryPagesRoute(r.path) ? memoryPagesResponse(r.path, status, x) : memoryRecallRoute(r.path) ? memoryRecallResponse(r.path, status, x) : x;
    const out = (body, status = 200) => ({ status, body: f(status, f(status, body)) });
    const [path, q = ''] = r.path.split('?');
    const p = new URLSearchParams(q);
    if (path === '/api/memory/scopes/memories/mem-1') return out({ memory: detail });
    if (path === '/api/memory/scopes/memories') return out({ scope: 'company', items: [{ id: 'mem-1', type: 'fact', preview: detail.content, drawerId: 'project:flowxtra', topicKey: 'tel-agent.price', importance: 7, layer: 'factual', createdAt: '2026-10-20 10:00:00', sourceAgentId: 'writer', source: 'agent', usedIn: 3 }], nextCursor: null, total: 1, facets: { type: { fact: 1 }, layer: {}, drawer: { 'project:flowxtra': 1 }, source: { agent: 1, owner: 4 } } });
    if (path === '/api/memory/access/agents') return out({ scope: p.get('scope'), column: p.get('column'), mode: 'read', count: p.get('scope') === 'project:tel-agent' ? 5 : 12, total: 30, agents: [], nextCursor: null });
    if (path === '/api/memory/scopes/search') return out({ hits: [{ kind: 'project', id: 'tel-agent', name: 'Tel-Agent', departmentId: 'marketing', archived: false, memories: 1120 }, { kind: 'project', id: 'old', name: 'Old', archived: true, memories: 3 }] });
    if (path === '/api/memory/mem-1/move') return taken ? out({ error: 'x', code: 'topic_key_taken' }, 409) : out({ memory: { id: 'mem-1' }, from: 'project:flowxtra', to: r.body.drawer });
    if (path === '/api/memory/mem-1/versions') return { status: 200, body: { versions: [] } };
    return { status: 404, body: null };
  } };
  return { client, calls };
}

test('the dialog shows the memory, its use, targets (archived left out) and the readers before / after (board M13)', async () => {
  const { client, calls } = backend();
  const moved = [];
  const c = new MemoryMoveController(client, (id, drawer) => moved.push([id, drawer]));
  await c.open({ id: 'mem-1', text: detail.content, drawerId: 'project:flowxtra' });
  await c.search('Tel');
  await c.pick('project:tel-agent');
  c.setReason('Saved in the wrong project');
  const html = renderToStaticMarkup(React.createElement(MoveDialog, { c }));
  for (const words of ['Move to another drawer', 'Tel-Agent price is 49 € per month.', 'Now in Projects · flowxtra · topic tel-agent.price · used in 3 replies', 'Projects · Tel-Agent', '1120 memories', 'Lessons',
    'Why (optional, kept in its history)', 'After the move it is read by the agents of Projects · Tel-Agent (5) instead of Projects · flowxtra (12).', 'The move is a new version'])
    assert.ok(html.includes(words), words);
  assert.ok(!html.includes('Projects · Old'), 'archived projects are not targets');
  assert.equal(await c.move(), true);
  assert.deepEqual(calls.find(r => r.path === '/api/memory/mem-1/move').body, { drawer: 'project:tel-agent', reason: 'Saved in the wrong project' });
  assert.deepEqual(moved, [['mem-1', 'project:tel-agent']]);
  assert.equal(c.getSnapshot().memory, null, 'closed after the move');
});

test('a refused move keeps the dialog open with a plain reason', async () => {
  const { client } = backend({ taken: true });
  const c = new MemoryMoveController(client);
  await c.open({ id: 'mem-1', text: detail.content, drawerId: 'project:flowxtra' });
  await c.pick('owner');
  assert.equal(await c.move(), false);
  assert.match(c.getSnapshot().notice, /same topic/);
  assert.ok(c.getSnapshot().memory);
});

test('explorer: source / importance / date filters reach the server; the open memory shows its use, map and readers (board M3)', async () => {
  const { client, calls } = backend();
  const c = new MemoryExplorerController(client);
  await c.load();
  c.setSource('agent'); c.setImportance('8-10'); c.setSince('30');
  await c.load();
  const last = calls.filter(r => r.path.startsWith('/api/memory/scopes/memories?')).pop().path;
  assert.match(last, /source=agent&importance=8-10&from=\d{4}-\d{2}-\d{2}/);
  await c.openMemory('mem-1');
  await new Promise(r => setTimeout(r, 0));
  const html = renderToStaticMarkup(React.createElement(Explorer, { c, agents: { writer: 'Writer' }, onMove: () => {} }));
  for (const words of ['Source', 'An agent · 1', 'High (8–10)', 'Last 30 days', 'Used in 3 replies', 'read by 12 of 30 agents', 'On the map:', 'Tel-Agent', 'Move drawer'])
    assert.ok(html.includes(words), words);
  c.moved('mem-1', 'project:tel-agent');
  assert.equal(c.getSnapshot().items[0].drawerId, 'project:tel-agent');
});
