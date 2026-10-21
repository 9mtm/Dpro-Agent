require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowedRequest } = require('../src/session.ts');
const { memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { AgentMemoryController, handoffLine } = require('../src/agent-memory.ts');

test('the agent card reads its effective access, its own notes, handoffs and skills (board M6)', async () => {
  const calls = [];
  const client = { request: async r => {
    calls.push(r.path); assert.ok(allowedRequest(r.method, r.path, r.body), r.path);
    const twice = b => ({ status: 200, body: memoryPagesRoute(r.path) ? memoryPagesResponse(r.path, 200, memoryPagesResponse(r.path, 200, b)) : b });
    if (r.path === '/api/memory/access/effective/writer') return twice({ agentId: 'writer', agentName: 'Writer', project: null, department: null, version: 1, template: { id: 't1', name: 'Marketing writer' }, exceptions: [], effective: { memoryRead: ['owner', 'project'], memoryWrite: ['project'] }, kinds: {} });
    if (r.path.startsWith('/api/memory/scopes/memories?scope=agent%3Awriter')) return twice({ scope: 'agent:writer', items: [{ id: 'm1', type: 'fact', preview: 'Posts go out Tuesday 09:30.', drawerId: 'project:flowxtra', topicKey: null, importance: 6, layer: 'factual', createdAt: '2026-10-21T08:00:00.000Z', sourceAgentId: 'writer' }], nextCursor: null, total: 18, facets: {} });
    if (r.path.startsWith('/api/handoffs?agentId=writer')) return twice({ handoffs: [{ id: 'h1', agentId: 'writer', kind: 'conversation', scopeId: 'conv12345678', projectId: null, version: 1, source: 'agent', createdAt: '2026-10-21T08:00:00.000Z', done: ['3 drafts'], left: ['Ahmed’s OK'], next: [], questions: [] }] });
    if (r.path === '/api/skill-library/agents/writer') return { status: 200, body: { selected: ['post-writer', 'hook-generator'], revision: 2 } };
    return { status: 404, body: null };
  } };
  const c = new AgentMemoryController(client, 'writer');
  await c.load();
  const s = c.getSnapshot();
  assert.equal(s.access.template.name, 'Marketing writer'); assert.equal(s.notes.total, 18); assert.deepEqual(s.skills, ['post-writer', 'hook-generator']);
  assert.equal(handoffLine(s.handoffs[0]), 'Done: 3 drafts. Left: Ahmed’s OK.');
  assert.equal(calls.length, 4);
  c.dispose();
});
