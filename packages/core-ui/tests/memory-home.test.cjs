require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { memoryRecallRoute, memoryRecallResponse } = require('../src/memory-recall-contract.js');
const { MemoryScopesController, effectLines } = require('../src/memory-scopes.ts');
const { HomeView, OverviewView, ScopeRail, ScopeHeader, ActionDialog } = require('../src/MemoryHome.tsx');

const H = 'b'.repeat(64);
const NOW = Date.parse('2026-10-21T12:00:00Z');
const counts = (memories, extra = {}) => ({ memories, pendingReviews: 0, conflicts: 0, pinnedFacts: 0, lastMemoryAt: '2026-10-20T08:00:00.000Z', health: 'ok', reasons: [], ...extra });
const tree = () => ({
  generatedAt: '2026-10-21T11:59:00.000Z', cached: false,
  company: { ...counts(12, { pendingReviews: 3, conflicts: 1, health: 'problem', reasons: ['conflicts'] }), drawers: { owner: 4, project: 7, experience: 1 }, departments: 2, projects: 2, archivedProjects: 1 },
  departments: [{ id: 'general', name: 'General', isDefault: true, projects: 1, archivedProjects: 0, ...counts(2) }, { id: 'marketing', name: 'Marketing', isDefault: false, projects: 1, archivedProjects: 1, ...counts(5) }],
  projects: [
    { slug: 'flowxtra', name: 'Flowxtra', departmentId: 'marketing', pinned: true, archived: false, archivedAt: null, mergedInto: null, ...counts(5, { pendingReviews: 1 }) },
    { slug: 'tel-agent', name: 'Tel-Agent', departmentId: 'general', pinned: false, archived: false, archivedAt: null, mergedInto: null, ...counts(2, { health: 'attention', reasons: ['reviews_waiting'] }) },
    { slug: 'old-site', name: 'Old site', departmentId: 'marketing', pinned: false, archived: true, archivedAt: '2026-09-01T00:00:00.000Z', mergedInto: null, ...counts(9) },
  ],
  people: [{ key: 'ahmed', ...counts(2) }], agents: { total: 2, withTemplate: 0, withExceptions: 0 },
});
const item = (id, text, drawerId, createdAt, topicKey = null) => ({ id, type: 'fact', preview: text, drawerId, topicKey, importance: 6, layer: 'factual', createdAt, sourceAgentId: 'writer' });

/** A fake backend behind the real browser contracts (allow-list + projection). */
function backend(over = {}) {
  const calls = [];
  const facts = [{ id: 'pf-1', scope: 'project:flowxtra', text: 'Never name a competitor.', position: 0, createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z' }];
  const routes = {
    'GET /api/memory/scopes/tree': () => tree(),
    'GET /api/agents': () => ({ agents: [{ id: 'writer', name: 'Writer' }, { id: 'designer', name: 'Designer' }] }),
    'GET /api/agents/writer/permissions': () => ({ memoryRead: ['owner', 'project'] }),
    'GET /api/agents/designer/permissions': () => ({ memoryRead: ['owner'] }),
    'GET /api/memory/graph/entities': () => ({ entities: [{ id: 'e1', kind: 'person', name: 'Ahmed', aliases: [], memories: 2, links: 1, updatedAt: '2026-10-20T08:00:00.000Z' }] }),
    'GET /api/memory/graph/links': () => ({ links: [] }),
    'GET /api/memory/proposals': () => ({ proposals: [{ source: 'learning', reasons: ['people'] }, { source: 'learning', reasons: [], conflictWith: 'm-1' }] }),
    'GET /api/memory/doctor': () => ({ checkedAt: '2026-10-21T11:00:00.000Z', embeddingModel: 'm', total: 12, counts: { duplicate: 4, expired: 11 }, issues: [], reportHash: H }),
    'GET /api/memory/cache/metrics': () => ({ process: {}, recent: { turns: 10, packHitRate: 0.82 }, budget: {} }),
    'GET /api/memory/import/local/automatic': () => ({ settings: { enabled: true, intervalMinutes: 15, nextRun: 0, lastRun: NOW - 4 * 60000, status: 'idle', lastImported: 0, lastProposed: 0, notice: '' } }),
    'GET /api/memory/scopes/memories': path => path.includes('topic=has')
      ? { scope: 'x', items: [item('m2', 'Teal to cyan.', 'project:flowxtra', '2026-10-19T08:00:00.000Z', 'brand-colors'), item('m3', 'Hooks', 'project:flowxtra', '2026-10-01T08:00:00.000Z', 'hooks')], nextCursor: null, total: 2, facets: {} }
      : { scope: 'x', items: [item('m1', 'Default local model is qwen3.5:9b.', 'project:dpro', '2026-10-21T11:50:00.000Z'), item('m4', 'Old fact', 'owner', '2026-09-01T08:00:00.000Z')], nextCursor: null, total: 2, facets: {} },
    'GET /api/memory/scopes/pinned': () => ({ scope: 'project:flowxtra', facts }),
    'GET /api/memory/access': () => ({ version: 1, rules: [{ id: 'r1', scope: 'project:flowxtra', agentId: null, drawerKind: 'task', read: 'allow', write: 'deny', endsAt: null, expired: false, reason: null, createdAt: '2026-10-20T08:00:00.000Z' }], templates: [] }),
    'GET /api/memory/access/effective/writer': () => ({ agentId: 'writer', agentName: 'Writer', project: 'flowxtra', department: 'marketing', version: 1, template: { id: 't1', name: 'Marketing writer' }, exceptions: [], effective: { memoryRead: ['project'], memoryWrite: ['project'] }, kinds: { project: { read: true, write: true, readWhy: [], writeWhy: [] } } }),
    'GET /api/memory/access/effective/designer': () => ({ agentId: 'designer', agentName: 'Designer', project: 'flowxtra', department: 'marketing', version: 1, template: null, exceptions: [], effective: { memoryRead: [], memoryWrite: [] }, kinds: { project: { read: false, write: false, readWhy: [], writeWhy: [] } } }),
    'POST /api/memory/scopes/pinned': (_, b) => [201, { fact: { id: 'pf-2', scope: b.scope, text: b.text, position: 1, createdAt: '2026-10-21T12:00:00.000Z', updatedAt: '2026-10-21T12:00:00.000Z' } }],
    'PATCH /api/memory/scopes/pinned/pf-1': (_, b) => ({ fact: { ...facts[0], text: b.text } }),
    'DELETE /api/memory/scopes/pinned/pf-1': () => ({ ok: true }),
    'POST /api/memory/scopes/projects/flowxtra/preview': (_, b) => ({ action: b.action, project: tree().projects[0], effects: { memories: 5, pinnedFacts: 1, conversations: 3, keptButNotLoaded: true }, previewHash: H }),
    'POST /api/memory/scopes/projects/flowxtra/apply': (_, b) => ({ action: b.action, project: tree().projects[0], effects: { memories: 5 }, result: { archived: true } }),
    ...over,
  };
  const client = { request: async r => {
    calls.push(r);
    assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path} passes the browser allow-list`);
    const base = r.path.split('?')[0];
    const fn = routes[`${r.method} ${base}`];
    if (!fn) return { status: 404, body: null };
    let out = fn(r.path, r.body); let status = 200;
    if (Array.isArray(out)) [status, out] = out;
    const once = x => memoryPagesRoute(r.path) ? memoryPagesResponse(r.path, status, x) : memoryRecallRoute(r.path) ? memoryRecallResponse(r.path, status, x) : x;
    const body = once(once(out)); // the bridge projects, then the browser
    return { status, body };
  } };
  return { client, calls };
}
const settle = () => new Promise(r => setTimeout(r, 0));

test('Everything shows the memory home from the real routes (board M1)', async () => {
  const { client } = backend();
  const c = new MemoryScopesController(client, () => NOW);
  await c.load(); await settle(); await settle();
  const s = c.getSnapshot();
  assert.equal(s.phase, 'ready'); assert.equal(s.scope, 'company');
  assert.equal(s.weekCount, 1); assert.equal(s.topics, 2); assert.equal(s.mapEntities, 1);
  assert.deepEqual(s.waiting, { total: 2, important: 1, conflicts: 1, links: 0, imported: 0, files: 0 });
  assert.equal(s.cacheHit, 0.82); assert.equal(s.doctor.counts.duplicate, 4);
  assert.equal(s.readers.owner, 2); assert.equal(s.readers.project, 1);
  const html = renderToStaticMarkup(React.createElement(HomeView, { c, go: () => {} }));
  for (const words of ['Drawers', 'About you', 'Read by all agents', 'Recently learned', 'Default local model is qwen3.5:9b.', 'Writer', 'Waiting for you', '2 to review', '1 important · 1 conflicts · 0 new links', 'Duplicates', 'Past retention', '82%', 'every 15 minutes'])
    assert.ok(html.includes(words), words);
  const rail = renderToStaticMarkup(React.createElement(ScopeRail, { c, onWaiting: () => {}, onScope: () => {} }));
  for (const words of ['Everything', 'Waiting for me', 'PINNED', 'Flowxtra', 'COMPANY', 'Marketing', 'General', 'People', 'Agents', 'Archived projects']) assert.ok(rail.includes(words), words);
  assert.match(rail, /data-health="attention"/);
  c.setFind('tel'); const found = renderToStaticMarkup(React.createElement(ScopeRail, { c, onWaiting: () => {}, onScope: () => {} }));
  assert.ok(found.includes('Tel-Agent')); assert.ok(!found.includes('>Flowxtra<'), 'the finder narrows the tree');
  c.dispose();
});

test('a project shows pinned facts, topics, who uses it and its rules (board M8); facts are added, edited and removed', async () => {
  const { client, calls } = backend();
  const c = new MemoryScopesController(client, () => NOW);
  await c.load(); c.select('project:flowxtra'); await settle(); await settle(); await settle();
  const s = c.getSnapshot();
  assert.deepEqual(s.topicKeys, ['brand-colors', 'hooks']); assert.equal(s.facts.length, 1); assert.equal(s.rules.length, 1);
  assert.deepEqual(s.usage.map(u => [u.name, u.write, u.why]), [['Writer', true, 'Marketing writer template']]);
  const html = renderToStaticMarkup(React.createElement(OverviewView, { c, go: () => {} }));
  for (const words of ['Pinned facts — every agent in this project gets these first', 'Never name a competitor.', 'brand-colors', 'Who uses it', 'read + write', 'Project actions', 'Archive memory (kept, not loaded)', 'Forget the whole project…', 'Rules here', 'Inherits Marketing', 'Override: task'])
    assert.ok(html.includes(words), words);
  const head = renderToStaticMarkup(React.createElement(ScopeHeader, { c }));
  assert.ok(head.includes('Company › Marketing ›')); assert.ok(head.includes('memory key: project/flowxtra')); assert.ok(head.includes('Unpin'));
  assert.equal(await c.addFact('Ahmed approves every post before 10:00.'), true);
  assert.deepEqual(calls.at(-1).body, { scope: 'project:flowxtra', text: 'Ahmed approves every post before 10:00.' });
  assert.equal(await c.editFact('pf-1', 'Never name a competitor in posts.'), true);
  assert.equal(c.getSnapshot().facts[0].text, 'Never name a competitor in posts.');
  await c.removeFact('pf-1'); assert.deepEqual(c.getSnapshot().facts.map(f => f.id), ['pf-2']);
  c.dispose();
});

test('a project action is previewed, then applied with the preview hash and confirm (owner gate)', async () => {
  const { client, calls } = backend();
  const c = new MemoryScopesController(client, () => NOW);
  await c.load(); c.select('project:flowxtra'); await settle();
  c.startAction('archive'); await settle();
  const s = c.getSnapshot();
  assert.equal(s.preview.previewHash, H);
  assert.deepEqual(effectLines(s.preview), ['5 memories and 1 pinned facts are kept but never loaded into a reply.', '3 chats keep their history.', 'You can unarchive it later.']);
  assert.ok(!calls.some(r => r.path.endsWith('/apply')), 'nothing is applied by the preview');
  const dialog = renderToStaticMarkup(React.createElement(ActionDialog, { c }));
  assert.ok(dialog.includes('Confirm: archive')); assert.ok(dialog.includes('Nothing changes until you confirm'));
  await c.applyAction();
  const apply = calls.find(r => r.path.endsWith('/apply'));
  assert.deepEqual(apply.body, { action: 'archive', expectedPreviewHash: H, confirm: true });
  c.startAction('merge'); assert.equal(c.getSnapshot().preview, null, 'merge first asks for the other project');
  c.dispose();
});

test('a changed project is not applied blindly', async () => {
  const { client } = backend({ 'POST /api/memory/scopes/projects/flowxtra/apply': () => [409, { error: 'changed', code: 'preview_changed' }] });
  const c = new MemoryScopesController(client, () => NOW);
  await c.load(); c.select('project:flowxtra'); await settle();
  c.startAction('forget'); await settle(); await c.applyAction();
  assert.match(c.getSnapshot().previewNotice, /changed since the preview/);
  assert.ok(c.getSnapshot().preview, 'the old preview stays on screen; nothing changed');
  c.dispose();
});
