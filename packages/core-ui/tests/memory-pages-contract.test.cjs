require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { memoryPagesResponse, memoryPagesPath, queryString } = require('../src/memory-pages-contract.js');
const { memoryResponse } = require('../scripts/memory-response.cjs');
const { parseProposal } = require('../src/memory.ts');

const H = 'a'.repeat(64);
const both = (method, path, body) => { const a = allowedRequest(method, path, body), b = allowed(method, path, body); assert.equal(a, b, `${method} ${path} same at both boundaries`); return a; };

test('every memory page read passes both boundaries; odd queries do not', () => {
  for (const path of [
    '/api/memory/scopes/tree', '/api/memory/scopes/tree?fresh=1', '/api/memory/scopes/search?q=flow&limit=10',
    '/api/memory/scopes/memories' + queryString({ scope: 'project:flowxtra', q: 'tea', limit: 50 }),
    '/api/memory/scopes/memories' + queryString({ scope: 'agent:writer', type: 'fact', topic: 'has', cursor: 'abc_-=' }),
    '/api/memory/scopes/pinned' + queryString({ scope: 'department:marketing' }), '/api/memory/scopes/projects/flowxtra/export',
    '/api/memory/access', '/api/memory/access/effective/writer' + queryString({ project: 'flowxtra' }), '/api/memory/doctor',
    '/api/memory/graph/entities?kind=person&limit=150', '/api/memory/graph/entities/ent-1', '/api/memory/graph/links?status=pending',
    '/api/handoffs?agentId=_main&limit=20', '/api/handoffs/conversation/conv12345678?agentId=_main',
  ]) assert.equal(both('GET', path), true, path);
  for (const path of [
    '/api/memory/scopes/tree?fresh=2', '/api/memory/scopes/memories?scope=project:flowxtra', '/api/memory/scopes/memories?scope=project%3AFlow',
    '/api/memory/scopes/memories?limit=50&limit=10', '/api/memory/scopes/memories?owner=other', '/api/memory/scopes/pinned',
    '/api/memory/scopes/projects/Flow/export', '/api/memory/access/effective/..%2Fx', '/api/memory/graph/links?status=all',
    '/api/handoffs/chat/x?agentId=a', '/api/handoffs/conversation/conv12345678', '/api/memory/doctor?x=1',
  ]) assert.equal(both('GET', path), false, path);
});

test('writes need exact bodies; many-memory changes need the preview hash and confirm', () => {
  assert.equal(both('POST', '/api/memory/scopes/pinned', { scope: 'project:flowxtra', text: 'Never name a competitor.' }), true);
  assert.equal(both('POST', '/api/memory/scopes/pinned', { scope: 'project:flowxtra', text: ' ' }), false);
  assert.equal(both('POST', '/api/memory/scopes/pinned', { scope: 'people:ahmed', text: 'x' }), false, 'pinned facts live on company / department / project');
  assert.equal(both('PATCH', '/api/memory/scopes/pinned/pf-1', { text: 'New text' }), true);
  assert.equal(both('PATCH', '/api/memory/scopes/pinned/pf-1', {}), false);
  assert.equal(both('DELETE', '/api/memory/scopes/pinned/pf-1'), true);
  assert.equal(both('POST', '/api/memory/scopes/projects/flowxtra/preview', { action: 'archive' }), true);
  assert.equal(both('POST', '/api/memory/scopes/projects/flowxtra/preview', { action: 'merge', target: 'tel-agent' }), true);
  assert.equal(both('POST', '/api/memory/scopes/projects/flowxtra/preview', { action: 'merge' }), false);
  assert.equal(both('POST', '/api/memory/scopes/projects/flowxtra/preview', { action: 'move', departmentId: 'marketing' }), true);
  assert.equal(both('POST', '/api/memory/scopes/projects/flowxtra/preview', { action: 'archive', target: 'x' }), false);
  assert.equal(both('POST', '/api/memory/scopes/projects/flowxtra/apply', { action: 'forget', expectedPreviewHash: H, confirm: true }), true);
  assert.equal(both('POST', '/api/memory/scopes/projects/flowxtra/apply', { action: 'forget', expectedPreviewHash: H }), false, 'no confirm');
  assert.equal(both('POST', '/api/memory/scopes/projects/flowxtra/apply', { action: 'forget', confirm: true }), false, 'no hash');
  const change = { op: 'set_rule', scope: 'department:marketing', drawerKind: 'people', read: 'allow', write: 'inherit' };
  assert.equal(both('POST', '/api/memory/access/preview', { changes: [change] }), true);
  assert.equal(both('POST', '/api/memory/access/apply', { changes: [change], expectedPreviewHash: H, confirm: true }), true);
  assert.equal(both('POST', '/api/memory/access/apply', { changes: [change], expectedPreviewHash: H }), false);
  assert.equal(both('POST', '/api/memory/access/preview', { changes: [{ ...change, endsAt: '2026-10-30T00:00:00Z' }] }), false, 'an end time is only for an agent exception');
  assert.equal(both('POST', '/api/memory/access/preview', { changes: [{ ...change, agentId: 'legal-1', endsAt: '2026-10-30T00:00:00Z' }] }), true);
  assert.equal(both('POST', '/api/memory/access/preview', { changes: [] }), false);
  assert.equal(both('POST', '/api/memory/doctor/fix', { confirm: true, expectedReportHash: H, kinds: ['duplicate'] }), true);
  assert.equal(both('POST', '/api/memory/doctor/fix', { expectedReportHash: H }), false);
  assert.equal(both('POST', '/api/memory/graph/links/l-1/approve'), true);
  assert.equal(both('POST', '/api/memory/graph/links/l-1/approve', {}), false);
  assert.equal(both('PUT', '/api/handoffs/conversation/conv12345678', { agentId: '_main', done: ['Drafted 3 posts'], next: ['Publish after OK'] }), true);
  assert.equal(both('PUT', '/api/handoffs/conversation/conv12345678', { agentId: '_main', done: ['two\nlines'] }), false);
  assert.equal(both('PUT', '/api/handoffs/conversation/conv12345678', { agentId: '_main', notes: 'x' }), false);
  assert.equal(both('POST', '/api/memory/proposals/p-1/decide', { decision: 'keep_both', expectedReviewHash: H }), true);
  assert.equal(both('POST', '/api/memory/proposals/p-1/decide', { decision: 'merge', expectedReviewHash: H }), false);
  assert.equal(both('POST', '/api/memory/0b9c1d2e-0000-4000-8000-000000000001/move', { drawer: 'project:flowxtra' }), true, 'the move route of the recall contract is wired');
  assert.equal(both('GET', '/api/memory/cache/metrics'), true);
  assert.equal(both('POST', '/api/memory', { type: 'fact', content: 'x', topicKey: 'owner-drinks' }), true);
  assert.equal(both('POST', '/api/memory', { type: 'fact', content: 'x', topicKey: 'owner drinks' }), false);
});

test('responses keep reviewed fields only and never error text', () => {
  const tree = memoryPagesResponse('/api/memory/scopes/tree', 200, {
    generatedAt: '2026-10-21T10:00:00.000Z', cached: false, secret: 'x',
    company: { memories: 9, pendingReviews: 1, conflicts: 1, pinnedFacts: 2, lastMemoryAt: null, health: 'problem', reasons: ['conflicts', 'Bad Reason!'], drawers: { owner: 3, 'project:flowxtra': 6, '../x': 1 }, departments: 2, projects: 1, archivedProjects: 0 },
    departments: [{ id: 'general', name: 'General', isDefault: true, projects: 1, archivedProjects: 0, memories: 6, pendingReviews: 0, conflicts: 0, pinnedFacts: 0, lastMemoryAt: null, health: 'ok', reasons: [] }],
    projects: [{ slug: 'flowxtra', name: 'Flowxtra', departmentId: 'general', pinned: true, archived: false, archivedAt: null, mergedInto: null, chatProjectId: 'internal', memories: 6, pendingReviews: 0, conflicts: 0, pinnedFacts: 1, lastMemoryAt: '2026-10-20T08:00:00.000Z', health: 'ok', reasons: [] }],
    people: [{ key: 'ahmed', memories: 2, pendingReviews: 0, conflicts: 0, pinnedFacts: 0, lastMemoryAt: null, health: 'ok', reasons: [] }],
    agents: { total: 3, withTemplate: 1, withExceptions: 0 },
  });
  assert.equal(tree.secret, undefined); assert.deepEqual(tree.company.reasons, ['conflicts']); assert.deepEqual(Object.keys(tree.company.drawers), ['owner', 'project:flowxtra']);
  assert.equal(tree.projects[0].chatProjectId, undefined, 'internal chat ids stay out'); assert.equal(tree.projects[0].pinned, true);
  assert.deepEqual(memoryPagesResponse('/api/memory/scopes/projects/flowxtra/apply', 409, { error: 'Preview changed: secret detail', code: 'preview_changed' }), { code: 'preview_changed' });
  assert.equal(memoryPagesResponse('/api/memory/doctor/fix', 400, { error: 'boom', code: 'weird' }), null);
  const preview = memoryPagesResponse('/api/memory/scopes/projects/flowxtra/preview', 200, { action: 'move', project: { slug: 'flowxtra', name: 'Flowxtra', departmentId: 'general', pinned: false, archived: false, archivedAt: null, mergedInto: null }, department: { id: 'marketing', name: 'Marketing' }, effects: { from: 'general', to: 'marketing', memories: 6, agentsAffected: 4, nested: { a: 1 }, sample: [{ agentId: 'writer', agentName: 'Writer', project: 'flowxtra', before: { read: ['owner'], write: [] }, after: { read: ['owner', 'people'], write: [] } }] }, previewHash: H });
  assert.equal(preview.effects.agentsAffected, 4); assert.equal(preview.effects.nested, undefined); assert.equal(preview.effects.sample[0].after.read[1], 'people');
  assert.throws(() => memoryPagesResponse('/api/memory/scopes/projects/flowxtra/preview', 200, { action: 'move', project: { slug: 'flowxtra' }, effects: {} }), 'a preview needs its hash');
  const doc = memoryPagesResponse('/api/memory/doctor', 200, { checkedAt: '2026-10-21T10:00:00.000Z', embeddingModel: 'qwen3-embedding:0.6b', total: 5, counts: { duplicate: 2 }, issues: [{ kind: 'duplicate', drawerId: 'owner', memoryIds: ['m1', 'm2'], text: 'never' }], reportHash: H });
  assert.equal(doc.counts.expired, 0); assert.equal(doc.issues[0].text, undefined);
  const decide = memoryPagesResponse('/api/memory/proposals/p-1/decide', 200, { decision: 'keep_new', proposal: { id: 'p-1', status: 'approved', changes: [] }, applied: { added: [], updated: ['m1'] } });
  assert.deepEqual(decide, { decision: 'keep_new', proposal: { id: 'p-1', status: 'approved' }, applied: true });
  assert.equal(memoryPagesPath('/api/handoffs/task/T-1?agentId=writer').kind, 'task');
});

test('a conflict proposal keeps what it contradicts through both projections', () => {
  const p = { id: 'p-1', userId: 'u1', agentId: 'main', drawerId: 'owner', drawer: { kind: 'owner' }, reviewHash: H, baseHash: H, baseRevision: 3, status: 'pending', source: 'learning', note: null, createdBy: 'agent:main', createdAt: '2026-10-21T10:00:00.000Z', decidedBy: null, decidedAt: null, appliedRevision: null, reasons: ['conflict'], importBatchId: null, conflictWith: 'm-7', decision: null,
    changes: [{ op: 'update', id: 'm-7', before: { type: 'fact', importance: 6, content: 'Drinks tea.' }, after: { type: 'fact', importance: 6, content: 'Coffee, no sugar.' } }] };
  const bridged = memoryResponse('/api/memory/proposals/p-1', p);
  assert.equal(bridged.conflictWith, 'm-7'); assert.equal('decision' in bridged, false);
  assert.equal(parseProposal(bridged).conflictWith, 'm-7');
  const plain = memoryResponse('/api/memory/proposals/p-1', { ...p, conflictWith: null });
  assert.equal('conflictWith' in plain, false, 'ordinary proposals look as before');
});
