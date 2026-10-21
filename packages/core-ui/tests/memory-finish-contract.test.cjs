// MEM-FINISH-01: the routes boards M2–M4, M7, M9, M11–M14 use, at both boundaries
// (browser session and the local application server), and their projections.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { memoryPagesResponse, queryString } = require('../src/memory-pages-contract.js');
const { memoryBridgeResponse } = require('../src/memory-bridge-contract.js');

const H = 'a'.repeat(64);
const C = 'b'.repeat(32);
const both = (method, path, body) => { const a = allowedRequest(method, path, body), b = allowed(method, path, body); assert.equal(a, b, `${method} ${path} same at both boundaries`); return a; };
const twice = (fn, path, status, body) => { const once = fn(path, status, body); assert.deepEqual(fn(path, status, once), once, `${path} projects the same twice`); return once; };

test('MEM-GAPS-02 reads: memory detail, rules, who can read, counts, template, groups, agent view, clusters, coding-app notes', () => {
  for (const path of [
    '/api/memory/scopes/memories/mem-1', '/api/memory/scopes/rules?scope=company', '/api/memory/scopes/rules?scope=department%3Amarketing',
    '/api/memory/access/agents' + queryString({ scope: 'project:flowxtra', column: 'project', mode: 'read', limit: 50 }),
    '/api/memory/access/counts?column=project&mode=read', '/api/memory/access/templates/tpl_1?limit=20',
    '/api/memory/proposals/groups?by=agent', '/api/memory/graph/agent-view/writer?project=flowxtra&limit=150',
    '/api/memory/graph/clusters?limit=50', '/api/memory/graph/clusters' + queryString({ drawers: 'project:flowxtra,owner' }),
    '/api/handoffs/coding-apps?client=codex&limit=20', '/api/handoffs/coding-apps?projectId=proj-1',
  ]) assert.equal(both('GET', path), true, path);
  for (const path of [
    '/api/memory/scopes/rules', '/api/memory/scopes/rules?scope=people%3Aahmed', '/api/memory/access/agents?column=secret',
    '/api/memory/access/counts?mode=admin', '/api/memory/proposals/groups?by=user', '/api/memory/graph/agent-view/..%2Fx',
    '/api/memory/graph/clusters?limit=151', '/api/memory/graph/clusters?drawers=..', '/api/handoffs/coding-apps?client=vim',
    '/api/memory/scopes/memories/mem-1?x=1',
  ]) assert.equal(both('GET', path), false, path);
});

test('MEM-GAPS-02 writes: rules (null = inherit), accept-all-routine with the preview hash, clusters, rebuild', () => {
  assert.equal(both('PUT', '/api/memory/scopes/rules', { scope: 'project:flowxtra', routine: 'ask', contradiction: null }), true);
  assert.equal(both('PUT', '/api/memory/scopes/rules', { scope: 'department:marketing', reviewerAgentId: 'writer' }), true);
  assert.equal(both('PUT', '/api/memory/scopes/rules', { scope: 'company', weeklyDay: 1, weeklyHour: 9 }), true);
  assert.equal(both('PUT', '/api/memory/scopes/rules', { scope: 'company', weeklyDay: 1 }), false, 'day and hour together');
  assert.equal(both('PUT', '/api/memory/scopes/rules', { scope: 'project:flowxtra', weeklyDay: 1, weeklyHour: 9 }), false, 'weekly time is a company rule');
  assert.equal(both('PUT', '/api/memory/scopes/rules', { scope: 'project:flowxtra', reviewerAgentId: 'writer' }), false, 'a reviewer is per department');
  assert.equal(both('PUT', '/api/memory/scopes/rules', { scope: 'company', routine: 'never' }), false);
  assert.equal(both('PUT', '/api/memory/scopes/rules', { scope: 'company' }), false, 'nothing to change');
  assert.equal(both('PUT', '/api/memory/scopes/rules?scope=company', { scope: 'company', routine: 'ask' }), false);
  assert.equal(both('POST', '/api/memory/proposals/accept-routine/preview', {}), true);
  assert.equal(both('POST', '/api/memory/proposals/accept-routine/preview', { scope: 'project:flowxtra', agent: 'writer' }), true);
  assert.equal(both('POST', '/api/memory/proposals/accept-routine', { scope: 'company', expectedPreviewHash: H, confirm: true }), true);
  assert.equal(both('POST', '/api/memory/proposals/accept-routine', { expectedPreviewHash: H }), false, 'confirm required');
  assert.equal(both('POST', `/api/memory/graph/clusters/${C}/topic-preview`, { topicKey: 'flowxtra.launch-posts' }), true);
  assert.equal(both('POST', `/api/memory/graph/clusters/${C}/topic-preview`, { topicKey: 'Bad Key' }), false);
  assert.equal(both('POST', `/api/memory/graph/clusters/${C}/topic`, { topicKey: 'flowxtra.launch-posts', expectedPreviewHash: H, confirm: true }), true);
  assert.equal(both('POST', `/api/memory/graph/clusters/${C}/topic`, { expectedPreviewHash: H }), false);
  assert.equal(both('POST', `/api/memory/graph/clusters/${C}/dismiss`), true);
  assert.equal(both('POST', '/api/memory/graph/clusters/not-hex/dismiss'), false);
  assert.equal(both('POST', '/api/memory/graph/sync', {}), true);
  assert.equal(both('POST', '/api/memory/graph/sync', { limit: 5000 }), false);
});

test('MEM-GAPS-02 projections keep reviewed fields and project the same twice', () => {
  const detail = twice(memoryPagesResponse, '/api/memory/scopes/memories/mem-1', 200, { memory: {
    id: 'mem-1', type: 'fact', content: 'Tel-Agent price is 49 € per month.', drawerId: 'project:flowxtra', topicKey: 'tel-agent.price', importance: 7, layer: 'factual', createdAt: '2026-10-20T10:00:00.000Z',
    sourceAgentId: 'writer', source: 'agent', secret: 'x', usage: { usedIn: 3, lastUsedAt: '2026-10-21 09:00:00', recent: [{ runId: 'r1', sessionId: 's1', agentId: 'writer', at: '2026-10-21 09:00:00' }] },
    graph: { entities: [{ id: 'e1', kind: 'project', name: 'Tel-Agent' }], links: [] }, readers: { scope: 'project:flowxtra', count: 12, total: 30, all: false, archived: false } } });
  assert.equal(detail.memory.usage.usedIn, 3);
  assert.equal(detail.memory.readers.count, 12);
  assert.ok(!('secret' in detail.memory));
  const rules = twice(memoryPagesResponse, '/api/memory/scopes/rules?scope=company', 200, { scope: 'company', own: { routine: 'ask', important: null, contradiction: 'keep_both', reviewerAgentId: null, weeklyDay: 1, weeklyHour: 9, updatedBy: 'owner-id' },
    effective: { routine: 'ask', important: 'ask', contradiction: 'keep_both', from: { routine: 'company', important: 'default', contradiction: 'company' }, reviewerAgentId: null, weekly: { day: 1, hour: 9 } } });
  assert.equal(rules.own.routine, 'ask');
  assert.ok(!('updatedBy' in rules.own), 'the owner id is not shown');
  twice(memoryPagesResponse, '/api/memory/access/agents?scope=company&column=owner', 200, { scope: 'company', column: 'owner', mode: 'read', count: 2, total: 5, agents: [{ id: 'writer', name: 'Writer', read: true, write: false, template: 'Writers', exception: false }], nextCursor: null });
  twice(memoryPagesResponse, '/api/memory/access/counts?column=project', 200, { column: 'project', mode: 'read', total: 5, company: 5, departments: { general: 5 }, projects: { flowxtra: 3, 'Bad Slug': 1 } });
  const groups = twice(memoryPagesResponse, '/api/memory/proposals/groups?by=scope', 200, { by: 'scope', total: 3, groups: [{ key: 'project:flowxtra', count: 3, conflicts: 1, routine: 2, reviewerAgentId: null, proposalIds: ['p-1', 'p-2', 'p-3'] }] });
  assert.equal(groups.groups[0].routine, 2);
  twice(memoryPagesResponse, '/api/memory/proposals/accept-routine/preview', 200, { filter: { scope: 'project:flowxtra', agent: null }, count: 1, items: [{ id: 'p-1', drawerId: 'project:flowxtra', reviewHash: H }], previewHash: H });
  twice(memoryPagesResponse, '/api/memory/proposals/accept-routine', 200, { approved: ['p-1'], skipped: [{ id: 'p-2', code: 'stale' }] });
  const cl = twice(memoryPagesResponse, '/api/memory/graph/clusters', 200, { clusters: [{ id: C, drawer: 'project:flowxtra', name: 'Ahmed', suggestedTopicKey: 'ahmed', entities: [{ id: 'e1', name: 'Ahmed', kind: 'person', memories: 3 }], memoryIds: ['m1', 'm2'] }] });
  assert.equal(cl.clusters[0].entities[0].memories, 3);
  twice(memoryPagesResponse, `/api/memory/graph/clusters/${C}/topic-preview`, 200, { preview: { cluster: cl.clusters[0], topicKey: 'ahmed', target: { memoryId: 'm1', preview: 'Ahmed approves posts' }, keepKey: [], related: ['m2'], blocked: null, previewHash: H } });
  twice(memoryPagesResponse, '/api/memory/graph/sync', 200, { indexed: 2, unchanged: 5, pruned: { links: 1, entities: 0 } });
  twice(memoryPagesResponse, '/api/memory/graph/agent-view/writer', 200, { agentId: 'writer', agentName: 'Writer', project: null, readable: ['owner'], drawers: ['owner'], entities: [], links: [] });
  const list = twice(memoryPagesResponse, '/api/handoffs?limit=50', 200, { handoffs: [{ id: 'h1', agentId: 'writer', kind: 'conversation', scopeId: 'conv12345678', projectId: null, version: 4, source: 'agent', createdAt: '2026-10-20 18:40:00', done: ['a'], left: [], next: [], questions: [], title: 'Tuesday posts' }] });
  assert.equal(list.handoffs[0].title, 'Tuesday posts');
  twice(memoryPagesResponse, '/api/handoffs/coding-apps', 200, { handoffs: [{ id: 'b1', projectId: 'proj-1', client: 'codex', done: ['tests'], left: [], next: ['UI'], questions: [], createdAt: '2026-10-21 11:00:00', ownerId: 'x' }] });
  assert.deepEqual(memoryPagesResponse('/api/memory/scopes/rules', 409, { code: 'no_change', error: 'Nothing to change' }), { code: 'no_change' });
  assert.deepEqual(memoryPagesResponse(`/api/memory/graph/clusters/${C}/topic`, 409, { code: 'stale', error: 'x' }), { code: 'stale' });
  assert.deepEqual(memoryPagesResponse('/api/memory/proposals/accept-routine', 409, { code: 'preview_changed' }), { code: 'preview_changed' });
});

test('M11 bridge: reads, kill switch, preview -> confirm with the hash, folder settings; nothing else', () => {
  for (const path of ['/api/memory-bridge', '/api/memory-bridge/audit', '/api/memory-bridge/audit?limit=20&client=codex', '/api/memory-bridge/clients/codex/registration', '/api/memory-bridge/projects/proj-1/files'])
    assert.equal(both('GET', path), true, path);
  for (const path of ['/api/memory-bridge?x=1', '/api/memory-bridge/audit?limit=900', '/api/memory-bridge/clients/vim/registration', '/api/memory-bridge/projects/..%2Fx/files', '/api/memory-bridge/mcp/call'])
    assert.equal(both('GET', path), false, path);
  assert.equal(both('PUT', '/api/memory-bridge/clients/codex', { enabled: false }), true);
  assert.equal(both('PUT', '/api/memory-bridge/clients/codex', { enabled: 'yes' }), false);
  assert.equal(both('POST', '/api/memory-bridge/clients/codex/registration', { previewHash: H, confirm: true }), true);
  assert.equal(both('POST', '/api/memory-bridge/clients/codex/registration', { previewHash: H }), false, 'confirm required');
  assert.equal(both('POST', '/api/memory-bridge/registrations/0123abcd-0000-4000-8000-000000000000/undo'), true);
  assert.equal(both('POST', '/api/memory-bridge/projects/proj-1/files', { previewHash: H, confirm: true }), true);
  assert.equal(both('PATCH', '/api/memory-bridge/projects/proj-1', { gitExclude: false }), true);
  assert.equal(both('PATCH', '/api/memory-bridge/projects/proj-1', { filesEnabled: true }), false, 'turning files on goes through the preview');
  assert.equal(both('POST', '/api/memory-bridge/projects/proj-1/backflow'), true);
  assert.equal(both('POST', '/api/memory-bridge/mcp/session', { client: 'codex' }), false, 'the coding-app side is never reachable from the page');
});

test('M11 bridge projections: no secret, last call, previews and the activity log project the same twice', () => {
  const s = twice(memoryBridgeResponse, '/api/memory-bridge', 200, {
    clients: [{ client: 'claude-code', name: 'Claude Code', enabled: true, configPath: '/tmp/h/.claude.json', registrationId: '0123abcd-0000-4000-8000-000000000000', registeredAt: '2026-10-18 10:00:00', lastCallAt: '2026-10-21 12:00:00', lastTool: 'memory_search', token: 'x' }],
    projects: [{ projectId: 'proj-1', name: 'Dpro', folder: '/tmp/dpro', filesEnabled: true, backflowEnabled: false, gitExclude: true, writtenAt: null, confirmedAt: null }],
    registrations: [{ id: '0123abcd-0000-4000-8000-000000000000', client: 'claude-code', configPath: '/tmp/h/.claude.json', backupPath: '/tmp/b', existed: true, beforeSha256: H, afterSha256: H, status: 'applied', createdAt: '2026-10-18 10:00:00', undoneAt: null }],
    serverReady: true,
  });
  assert.equal(s.clients[0].lastTool, 'memory_search');
  assert.ok(!JSON.stringify(s).includes('token') && !JSON.stringify(s).includes('backupPath'));
  twice(memoryBridgeResponse, '/api/memory-bridge/clients/codex/registration', 200, { preview: { client: 'codex', name: 'Codex', configPath: '/tmp/h/.codex/config.toml', action: 'create', entry: { command: 'node' }, diff: '+ [mcp_servers.dpro-memory]', beforeSha256: null, afterSha256: H, previewHash: H, warnings: [] } });
  twice(memoryBridgeResponse, '/api/memory-bridge/projects/proj-1/files', 200, { preview: { projectId: 'proj-1', folder: '/tmp/dpro', files: [{ name: 'AGENTS.md', relative: 'AGENTS.md', action: 'create', diff: '+ x', beforeSha256: null, afterSha256: H }], previewHash: H, conflicts: 0, changes: 1 } });
  twice(memoryBridgeResponse, '/api/memory-bridge/audit', 200, { entries: [{ id: 'a1', client: 'claude-code', projectId: 'proj-1', action: 'mcp-read', detail: 'project_brief', createdAt: '2026-10-21 12:00:00' }] });
  twice(memoryBridgeResponse, '/api/memory-bridge/projects/proj-1', 200, { folder: { projectId: 'proj-1', filesEnabled: false, backflowEnabled: true, gitExclude: true, briefHash: H, confirmedAt: null, writtenAt: null } });
  assert.deepEqual(memoryBridgeResponse('/api/memory-bridge/clients/codex/registration', 409, { code: 'preview_stale', error: 'changed' }), { code: 'preview_stale' });
  assert.equal(memoryBridgeResponse('/api/memory-bridge', 500, { error: 'boom' }), null);
});
