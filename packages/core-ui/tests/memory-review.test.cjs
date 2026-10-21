require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { memoryResponse } = require('../scripts/memory-response.cjs');
const { MemoryReviewController, kindOf } = require('../src/memory-review.ts');
const { ReviewInbox } = require('../src/MemoryReviewInbox.tsx');

const H = n => String(n).repeat(64).slice(0, 64);
const MID = '0b9c1d2e-0000-4000-8000-000000000007';
const base = (id, extra) => ({ id, userId: 'u1', agentId: 'main', drawerId: 'owner', drawer: { kind: 'owner' }, reviewHash: H(id.length % 9 + 1), baseHash: H(9), baseRevision: 3, status: 'pending', source: 'learning', note: null, createdBy: 'agent:main', createdAt: '2026-10-21T10:00:00.000Z', decidedBy: null, decidedAt: null, appliedRevision: null, reasons: [], importBatchId: null, conflictWith: null, decision: null, ...extra });
const proposals = {
  'p-conflict': base('p-conflict', { conflictWith: MID, note: 'Same topic, opposite meaning.', changes: [{ op: 'update', id: MID, before: { type: 'fact', importance: 6, content: 'Mohamed drinks tea every morning.' }, after: { type: 'fact', importance: 6, content: 'صار ما يشرب شاي، بس قهوة بدون سكر.' } }] }),
  'p-birthday': base('p-birthday', { reasons: ['family'], createdAt: '2026-10-21T09:00:00.000Z', changes: [{ op: 'add', after: { type: 'fact', importance: 8, content: '### Birthday\nDaughter’s birthday is 14 March.' } }] }),
  'p-import': base('p-import', { source: 'import', changes: [{ op: 'add', after: { type: 'fact', importance: 5, content: 'Imported fact.' } }] }),
};
const link = { id: 'l-1', type: 'works_on', status: 'pending', from: { id: 'e1', name: 'Ahmed', kind: 'person' }, to: { id: 'e2', name: 'Flowxtra', kind: 'project' }, memoryIds: ['m1'], createdAt: '2026-10-20T08:00:00.000Z' };

function backend(over = {}) {
  const calls = []; const pending = new Set(Object.keys(proposals)); let links = [link];
  const routes = {
    'GET /api/memory/proposals': () => ({ proposals: [...pending].map(id => { const { changes, ...rest } = proposals[id]; return { ...rest, counts: { add: 1, update: 0, delete: 0 } }; }) }),
    'GET /api/memory/graph/links': () => ({ links }),
    'GET /api/agents': () => ({ agents: [{ id: 'main', name: 'Main Agent' }] }),
    'POST /api/memory/graph/links/l-1/approve': () => { links = []; return { link: { id: 'l-1', status: 'active' } }; },
    ...over,
  };
  const client = { request: async r => {
    calls.push(r);
    assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`); assert.ok(allowed(r.method, r.path, r.body), `bridge ${r.method} ${r.path}`);
    let m;
    if (r.method === 'GET' && (m = /^\/api\/memory\/proposals\/([^/?]+)$/.exec(r.path)) && m[1] !== 'groups') return pending.has(m[1]) ? { status: 200, body: memoryResponse(r.path, proposals[m[1]]) } : { status: 404, body: null };
    if (r.method === 'POST' && (m = /^\/api\/memory\/proposals\/([^/]+)\/(decide|approve|reject)$/.exec(r.path))) {
      if (over[`${r.method} ${r.path}`]) { const [status, body] = over[`${r.method} ${r.path}`](r.body); return { status, body: memoryPagesRoute(r.path) ? memoryPagesResponse(r.path, status, body) : body }; }
      assert.equal(r.body.expectedReviewHash, proposals[m[1]].reviewHash, 'the decision carries the review hash of what was shown');
      pending.delete(m[1]);
      if (m[2] === 'decide') return { status: 200, body: memoryPagesResponse(r.path, 200, { decision: r.body.decision, proposal: { id: m[1], status: 'approved' }, applied: { added: [], updated: [MID] } }) };
      return { status: 200, body: {} };
    }
    if (r.method === 'PUT' && r.path === `/api/memory/${MID}`) return { status: 200, body: { memory: {} } };
    const fn = routes[`${r.method} ${r.path.split('?')[0]}`];
    if (!fn) return { status: 404, body: null };
    const out = fn(r.body);
    return { status: 200, body: memoryPagesRoute(r.path) ? memoryPagesResponse(r.path, 200, out) : out };
  } };
  return { client, calls, pending };
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

test('one inbox: conflicts first, then important, links and imports, each with its filter count (board M2)', async () => {
  const { client } = backend();
  const c = new MemoryReviewController(client);
  await c.load(); await settle();
  const s = c.getSnapshot();
  assert.deepEqual(s.items.map(i => i.kind), ['conflict', 'important', 'link', 'imported']);
  assert.equal(c.count('conflict'), 1); assert.equal(c.count('link'), 1); assert.equal(c.count('all'), 4);
  assert.equal(s.texts['p:p-birthday'], 'Birthday — Daughter’s birthday is 14 March.');
  assert.equal(s.texts['l:l-1'], 'Ahmed — works on → Flowxtra');
  assert.equal(s.detail.conflictWith, MID, 'the first item (the conflict) is open');
  const html = renderToStaticMarkup(React.createElement(ReviewInbox, { c }));
  for (const words of ['Review filters', 'Conflicts', 'New links', 'Approve selected', 'A new fact contradicts one you approved before', 'Mohamed drinks tea every morning.', 'صار ما يشرب شاي، بس قهوة بدون سكر.', 'Keep new', 'Keep old', 'Keep both (different times)', 'Edit first', 'A keep new · O keep old · B both'])
    assert.ok(html.includes(words), words);
  assert.equal(kindOf({ source: 'agent', counts: { add: 0, update: 1, delete: 0 } }), 'agent'); assert.equal(kindOf({ source: 'agent', counts: { add: 1, update: 0, delete: 0 } }), 'important'); assert.equal(kindOf({ source: 'upload' }), 'file');
  c.dispose();
});

test('keep new / old / both decide the conflict with its review hash; "Edit first" saves the edited text as the next version', async () => {
  const { client, calls } = backend();
  const c = new MemoryReviewController(client);
  await c.load(); await settle();
  c.startEdit(); c.editText('Coffee without sugar, no tea any more.');
  await c.decide('keep_new'); await settle();
  const decide = calls.find(r => r.path.endsWith('/decide'));
  assert.deepEqual(decide.body, { decision: 'keep_new', expectedReviewHash: proposals['p-conflict'].reviewHash });
  const put = calls.find(r => r.method === 'PUT');
  assert.deepEqual(put.body, { content: 'Coffee without sugar, no tea any more.' });
  assert.match(c.getSnapshot().result, /with your edit/);
  assert.equal(c.getSnapshot().items.some(i => i.kind === 'conflict'), false);
  assert.equal(c.getSnapshot().open, 'p:p-birthday', 'the next item opens');
  c.dispose();
});

test('a stale conflict is not applied and says why', async () => {
  const { client } = backend({ 'POST /api/memory/proposals/p-conflict/decide': () => [409, { error: 'x', code: 'stale' }] });
  const c = new MemoryReviewController(client);
  await c.load(); await settle();
  await c.decide('keep_old');
  assert.match(c.getSnapshot().notice, /changed since this was proposed/);
  assert.equal(c.getSnapshot().items.length, 4);
  c.dispose();
});

test('bulk approve needs a confirm, skips conflicts and approves links and proposals with their hashes', async () => {
  const { client, calls, pending } = backend();
  let changed = 0;
  const c = new MemoryReviewController(client, () => changed++);
  await c.load(); await settle();
  c.checkAll(true); c.askBulk('approve');
  assert.ok(renderToStaticMarkup(React.createElement(ReviewInbox, { c })).includes('Approve 4?'));
  assert.ok(!calls.some(r => r.path.endsWith('/approve')), 'nothing before Confirm');
  await c.bulk(); await settle();
  assert.deepEqual([...pending], ['p-conflict']);
  assert.match(c.getSnapshot().result, /3 approved\. 1 conflicts skipped/);
  assert.ok(calls.some(r => r.path === '/api/memory/graph/links/l-1/approve'));
  assert.ok(changed >= 1);
  c.dispose();
});

test('MEM-GAPS-02: group by scope / department / agent; accept all routine only after its preview, with the hash (board M2)', async () => {
  const P = 'e'.repeat(64);
  let accepted = null;
  const { client, calls, pending } = backend({
    'GET /api/memory/proposals/groups': () => ({ by: 'agent', total: 3, groups: [{ key: 'agent:main', count: 2, conflicts: 1, routine: 1, reviewerAgentId: null, proposalIds: ['p-conflict', 'p-birthday'] }, { key: 'owner', count: 1, conflicts: 0, routine: 0, reviewerAgentId: null, proposalIds: ['p-import'] }] }),
    'POST /api/memory/proposals/accept-routine/preview': body => ({ filter: { scope: null, agent: body.agent ?? null }, count: 1, items: [{ id: 'p-birthday', drawerId: 'owner', reviewHash: H(1) }], previewHash: P }),
    'POST /api/memory/proposals/accept-routine': body => { accepted = body; pending.delete('p-birthday'); return { approved: ['p-birthday'], skipped: [] }; },
  });
  const c = new MemoryReviewController(client);
  await c.load(); await settle();
  await c.setGroupBy('agent');
  c.setGroup('agent:main');
  assert.deepEqual(c.visible().map(i => i.id), ['p-conflict', 'p-birthday']);
  const html = renderToStaticMarkup(React.createElement(ReviewInbox, { c }));
  for (const words of ['Group by', 'Main Agent · 1 conflict', 'Accept all routine…']) assert.ok(html.includes(words), words);
  await c.previewRoutine();
  assert.deepEqual(calls.find(r => r.path === '/api/memory/proposals/accept-routine/preview').body, { agent: 'main' });
  const confirm = renderToStaticMarkup(React.createElement(ReviewInbox, { c }));
  assert.ok(confirm.includes('Accept 1 routine fact in Main Agent? Conflicts and important facts stay here.'));
  await c.acceptRoutine();
  assert.deepEqual(accepted, { agent: 'main', expectedPreviewHash: P, confirm: true });
  assert.match(c.getSnapshot().result, /1 routine fact accepted/);
  assert.ok(!c.getSnapshot().items.some(i => i.id === 'p-birthday'));
});
