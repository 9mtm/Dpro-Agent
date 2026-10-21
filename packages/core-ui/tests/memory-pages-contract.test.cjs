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
    company: { memories: 9, pendingReviews: 1, conflicts: 1, pinnedFacts: 2, lastMemoryAt: null, health: 'problem', reasons: ['conflicts', 'Bad Reason!'], drawers: { owner: 3, project: 6, '../x': 1 }, departments: 2, projects: 1, archivedProjects: 0 },
    departments: [{ id: 'general', name: 'General', isDefault: true, projects: 1, archivedProjects: 0, memories: 6, pendingReviews: 0, conflicts: 0, pinnedFacts: 0, lastMemoryAt: null, health: 'ok', reasons: [] }],
    projects: [{ slug: 'flowxtra', name: 'Flowxtra', departmentId: 'general', pinned: true, archived: false, archivedAt: null, mergedInto: null, chatProjectId: 'internal', memories: 6, pendingReviews: 0, conflicts: 0, pinnedFacts: 1, lastMemoryAt: '2026-10-20T08:00:00.000Z', health: 'ok', reasons: [] }],
    people: [{ key: 'ahmed', memories: 2, pendingReviews: 0, conflicts: 0, pinnedFacts: 0, lastMemoryAt: null, health: 'ok', reasons: [] }],
    agents: { total: 3, withTemplate: 1, withExceptions: 0 },
  });
  assert.equal(tree.secret, undefined); assert.deepEqual(tree.company.reasons, ['conflicts']); assert.deepEqual(Object.keys(tree.company.drawers), ['owner', 'project']);
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

test('every projection gives the same result twice (the bridge projects, then the browser)', () => {
  const p = { slug: 'flowxtra', name: 'Flowxtra', departmentId: 'general', pinned: false, archived: false, archivedAt: null, mergedInto: null };
  const c = { memories: 1, pendingReviews: 0, conflicts: 0, pinnedFacts: 0, lastMemoryAt: null, health: 'ok', reasons: [] };
  const rule = { id: 'r1', scope: 'project:flowxtra', agentId: 'writer', drawerKind: 'people', read: 'allow', write: 'deny', endsAt: '2026-10-30T00:00:00.000Z', expired: false, reason: 'launch', createdAt: '2026-10-20T00:00:00.000Z' };
  const sample = [{ agentId: 'writer', agentName: 'Writer', project: 'flowxtra', before: { read: ['owner'], write: [] }, after: { read: ['owner', 'people'], write: [] } }];
  const preview = { previewHash: H, version: 2, changes: 1, agentsAffected: 4, projectsAffected: 2, noProjectAffected: false, pairsChanged: 5, widened: 4, narrowed: 0, agentsTotal: 9, projectsTotal: 3, sample };
  const link = { id: 'l-1', type: 'works_on', status: 'pending', from: { id: 'e1', name: 'Ahmed', kind: 'person' }, to: { id: 'e2', name: 'Flowxtra', kind: 'project' }, memoryIds: ['m1'], createdAt: '2026-10-20T08:00:00.000Z' };
  const handoff = { id: 'h1', agentId: '_main', kind: 'conversation', scopeId: 'conv12345678', projectId: null, version: 2, source: 'owner', createdAt: '2026-10-20T18:40:00.000Z', done: ['Drafted 3 posts'], left: ['Ahmed’s OK'], next: ['Publish'], questions: [] };
  const cases = [
    ['/api/memory/scopes/tree', 200, { generatedAt: '2026-10-21T10:00:00.000Z', cached: true, company: { ...c, drawers: { owner: 1 }, departments: 1, projects: 1, archivedProjects: 0 }, departments: [{ id: 'general', name: 'General', isDefault: true, projects: 1, archivedProjects: 0, ...c }], projects: [{ ...p, ...c }], people: [{ key: 'ahmed', ...c }], agents: { total: 1, withTemplate: 0, withExceptions: 0 } }],
    ['/api/memory/scopes/memories?scope=company', 200, { scope: 'company', items: [{ id: 'm1', type: 'fact', preview: 'x', drawerId: 'owner', topicKey: 'a-b', importance: 6, layer: 'factual', createdAt: '2026-10-21T10:00:00.000Z', sourceAgentId: '_main' }], nextCursor: 'abc', total: 1, facets: { type: { fact: 1 }, layer: {}, drawer: { owner: 1 } } }],
    ['/api/memory/scopes/search?q=fl', 200, { hits: [{ kind: 'project', id: 'flowxtra', name: 'Flowxtra', departmentId: 'general', archived: false, memories: 4 }] }],
    ['/api/memory/scopes/agents', 200, { agents: [{ id: 'writer', name: 'Writer', department: null, template: { id: 't1', name: 'Writer' }, exceptions: 1 }], nextCursor: null }],
    ['/api/memory/scopes/pinned?scope=company', 200, { scope: 'company', facts: [{ id: 'pf-1', scope: 'company', text: 'x', position: 0, createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z' }] }],
    ['/api/memory/scopes/projects/flowxtra/preview', 200, { action: 'move', project: p, department: { id: 'marketing', name: 'Marketing' }, effects: { memories: 6, agentsAffected: 4, sample }, previewHash: H }],
    ['/api/memory/scopes/projects/flowxtra/apply', 200, { action: 'archive', project: p, effects: { memories: 6 }, result: { archived: true } }],
    ['/api/memory/scopes/projects/flowxtra/export', 200, { project: 'flowxtra', files: [{ name: 'project-flowxtra.md', content: '# x' }] }],
    ['/api/memory/access', 200, { version: 1, rules: [rule], templates: [{ id: 't1', name: 'Writer', memoryRead: ['owner'], memoryWrite: [], agents: 3 }] }],
    ['/api/memory/access/preview', 200, preview],
    ['/api/memory/access/apply', 200, { version: 3, preview }],
    ['/api/memory/access/effective/writer', 200, { agentId: 'writer', agentName: 'Writer', project: 'flowxtra', department: 'general', version: 1, template: null, exceptions: [rule], effective: { memoryRead: ['owner'], memoryWrite: [] }, kinds: { owner: { read: true, write: false, readWhy: [{ layer: 'default', value: 'allow' }, { layer: 'role-template', value: 'allow', name: 'Writer' }], writeWhy: [{ layer: 'agent-project', value: 'deny', endsAt: '2026-10-30T00:00:00.000Z' }] } } }],
    ['/api/memory/doctor', 200, { checkedAt: '2026-10-21T10:00:00.000Z', embeddingModel: 'm', total: 2, counts: { duplicate: 1 }, issues: [{ kind: 'duplicate', drawerId: 'owner', memoryIds: ['m1', 'm2'], detail: '2' }], reportHash: H }],
    ['/api/memory/doctor/fix', 200, { fixed: { duplicate: 1 }, skipped: [{ kind: 'expired', memoryId: 'm3', reason: 'changed' }], report: { checkedAt: '2026-10-21T10:00:00.000Z', embeddingModel: 'm', total: 1, counts: {}, issues: [], reportHash: H } }],
    ['/api/memory/graph/entities', 200, { entities: [{ id: 'e1', kind: 'person', name: 'Ahmed', aliases: ['أحمد'], memories: 2, links: 1, updatedAt: '2026-10-21T10:00:00.000Z' }] }],
    ['/api/memory/graph/entities/e1', 200, { entity: { id: 'e1', kind: 'person', name: 'Ahmed', aliases: [], memories: 2, links: 1, updatedAt: '2026-10-21T10:00:00.000Z' }, links: [link], timeline: [{ memoryId: 'm1', createdAt: '2026-10-21T10:00:00.000Z', drawer: 'people:ahmed', type: 'fact', preview: 'Runs Flowxtra marketing.' }] }],
    ['/api/memory/graph/links?status=pending', 200, { links: [link] }],
    ['/api/memory/graph/links/l-1/approve', 200, { link: { id: 'l-1', status: 'active' } }],
    ['/api/handoffs', 200, { handoffs: [handoff] }],
    ['/api/handoffs/conversation/conv12345678?agentId=_main', 200, { handoff, history: [handoff] }],
    ['/api/memory/proposals/p-1/decide', 200, { decision: 'keep_both', proposal: { id: 'p-1', status: 'approved' }, applied: { added: ['m9'] } }],
    ['/api/memory/weekly-summary', 200, { stored: true, summary: { digest: { periodStart: '2026-10-14T00:00:00.000Z', periodEnd: '2026-10-21T00:00:00.000Z', totals: { total: 9, created: 4, updated: 2, deleted: 0, forgotten: 1, pending: 2 } }, text: 'Learned 4.', modelText: null } }],
    ['/api/memory/retention', 200, { config: { enabled: true, taskTtlDays: 30, experienceAfterDays: 180, experienceMinGroup: 3 }, runs: [{ createdAt: '2026-10-20T00:00:00.000Z', forgotten: 2, dryRun: false }] }],
    ['/api/memory/cache/clear', 200, { cleared: 3 }],
    ['/api/memory/scopes/projects/flowxtra/apply', 409, { error: 'x', code: 'preview_changed' }],
  ];
  for (const [path, status, body] of cases) {
    const once = memoryPagesResponse(path, status, body);
    assert.deepEqual(memoryPagesResponse(path, status, once), once, path);
  }
});

test('memory version authors survive both projections; the owner id is never shown', () => {
  const { agentCardResponse } = require('../src/agent-card-contract.js');
  const path = '/api/memory/0b9c1d2e-0000-4000-8000-000000000001/versions';
  const body = { versions: [{ version: 2, change: 'update', type: 'fact', content: 'x', createdAt: '2026-10-21T10:00:00.000Z', createdBy: '3f0c1b8e-owner-uuid', proposalId: 'p-1' }, { version: 1, change: 'create', type: 'fact', content: 'y', createdAt: '2026-10-20T10:00:00.000Z', createdBy: 'agent:writer', proposalId: null }] };
  const once = agentCardResponse(path, 200, body);
  assert.deepEqual(once.versions.map(v => [v.by, v.proposal]), [['you', true], ['agent:writer', false]]);
  assert.deepEqual(agentCardResponse(path, 200, once), once);
  assert.ok(!JSON.stringify(once).includes('owner-uuid'));
});

test('the reply-trace contract also projects the same twice (move answered through the bridge)', () => {
  const { memoryRecallResponse } = require('../src/memory-recall-contract.js');
  const path = '/api/memory/0b9c1d2e-0000-4000-8000-000000000001/move';
  const once = memoryRecallResponse(path, 200, { memory: { id: '0b9c1d2e-0000-4000-8000-000000000001', content: 'x' }, from: 'owner', to: 'project:dpro' });
  assert.deepEqual(once, { memoryId: '0b9c1d2e-0000-4000-8000-000000000001', from: 'owner', to: 'project:dpro' });
  assert.deepEqual(memoryRecallResponse(path, 200, once), once);
  const metrics = memoryRecallResponse('/api/memory/cache/metrics', 200, { process: { since: '2026-10-21T08:00:00Z', caches: { pack: { hits: 8, misses: 2, hitRate: 0.8 } } }, recent: { turns: 3, packHitRate: 0.82 }, budget: { numCtx: 32768 } });
  assert.deepEqual(memoryRecallResponse('/api/memory/cache/metrics', 200, metrics), metrics);
});
