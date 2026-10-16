require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { conversationResponse } = require('../src/conversation-contract.js');
const { fromWire } = require('../src/turns.ts');
const { SessionClient } = require('../src/session.ts');
const { createLoginMock } = require('../src/session-mock.ts');
const { ConversationsController } = require('../src/conversations.ts');
const { ChatView } = require('../src/ChatView.tsx');
const CID = '3f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b';
const recovered = { id: 'reply', role: 'assistant', content: 'Saved checkpoints available.', parts: null, status: 'error', runId: 'run-recovered-0001', durationMs: 10, createdAt: '2026-10-16', code: 'run_interrupted' };

test('interrupted is an allowlisted persisted message code through both projections and transcript', () => {
  const path = `/api/chat/conversations/${CID}/messages`;
  const body = { conversation: { id: CID, title: 'Task', agentId: null, projectId: null, pinned: false, preview: '', createdAt: '', updatedAt: '' }, messages: [recovered], activeRunId: null };
  const once = conversationResponse(path, 200, body);
  assert.equal(once.messages[0].code, 'run_interrupted');
  assert.deepEqual(conversationResponse(path, 200, once), once);
  assert.equal(fromWire(once.messages[0]).code, 'run_interrupted');
  assert.equal(conversationResponse(path, 200, { ...body, messages: [{ ...recovered, code: 'private backend error' }] }).messages[0].code, undefined);
});

test('recovered chat displays safe continuation instead of blind retry', async t => {
  const base = createLoginMock();
  const client = new SessionClient({ mock: async request => {
    const response = await base(request);
    if (request.path.endsWith('/messages') && response.status === 200) return { ...response, body: { ...response.body,
      messages: [{ ...recovered, id: 'request', role: 'user', content: 'Original task', status: 'complete', code: undefined }, recovered], activeRunId: null } };
    return response;
  } });
  client.selectMode('mock'); await client.login('demo@example.invalid', 'mock-only');
  const controller = new ConversationsController(client); t.after(() => controller.dispose());
  await client.request({ method: 'POST', path: '/api/chat/conversations', body: { title: 'Recovered task' } });
  await controller.load();
  const id = controller.getSnapshot().conversations[0].id;
  await controller.open(id);
  const html = renderToStaticMarkup(React.createElement(ChatView, { controller, mode: 'mock', client }));
  assert.match(html, /Work interrupted by restart/);
  assert.match(html, /Continue safely/);
  assert.doesNotMatch(html, />Try again<\/button>/);
});

test('an open chat reconciles a missing SSE run after restart without sending the request twice', async t => {
  const base = createLoginMock(); let reads = 0; const calls = [];
  const client = new SessionClient({ mock: async request => {
    calls.push(request);
    if (/\/api\/chat\/runs\/[^/]+\/events/.test(request.path)) return { status: 404, body: { code: 'not_found' } };
    const response = await base(request);
    if (request.path.endsWith('/messages') && response.status === 200) {
      reads++;
      const user = { ...recovered, id: 'request', role: 'user', content: 'Original task', status: 'complete', code: undefined };
      return { ...response, body: { ...response.body, messages: reads === 1 ? [user] : [user, recovered], activeRunId: reads === 1 ? recovered.runId : null } };
    }
    return response;
  } });
  client.selectMode('mock'); await client.login('demo@example.invalid', 'mock-only');
  await client.request({ method: 'POST', path: '/api/chat/conversations', body: { title: 'Restarted task' } });
  const controller = new ConversationsController(client); t.after(() => controller.dispose());
  await controller.load(); await controller.open(controller.getSnapshot().conversations[0].id);
  const deadline = Date.now() + 2000;
  while (controller.getSnapshot().runId && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  assert.equal(controller.getSnapshot().runId, null);
  assert.equal(controller.getSnapshot().turns.at(-1).code, 'run_interrupted');
  assert.ok(reads >= 2);
  assert.equal(calls.filter(r => r.method === 'POST' && r.path.endsWith('/runs')).length, 0);
});

const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { approvalResponse } = require('../src/recovery-approvals-contract.js');
const { RecoveryApprovals } = require('../src/RecoveryApprovals.tsx');
const AID = '12345678-1234-4234-8234-123456789abc';
test('owner approvals share the strict browser and bridge contract without changing the bridge', () => {
  for (const allow of [allowedRequest, allowed]) {
    assert.equal(allow('GET', '/api/approvals?status=pending'), true);
    assert.equal(allow('GET', '/api/approvals?status=pending&limit=500'), false);
    assert.equal(allow('GET', `/api/approvals/${AID}`), true);
    assert.equal(allow('POST', `/api/approvals/${AID}/approve`, { paramsHash: 'a'.repeat(64) }), true);
    assert.equal(allow('POST', `/api/approvals/${AID}/approve`, {}), false);
    assert.equal(allow('POST', `/api/approvals/${AID}/approve`, { paramsHash: 'a'.repeat(64), unsafe: true }), false);
    assert.equal(allow('POST', `/api/approvals/${AID}/deny`), true);
    assert.equal(allow('DELETE', `/api/approvals/${AID}`), false);
  }
  const body = { approval: { id: AID, status: 'pending', sessionId: CID, toolName: 'write', params: { path: 'notes.txt' }, paramsHash: 'a'.repeat(64), maskedFields: [], internal: 'private' } };
  const path = `/api/approvals/${AID}`;
  const safe = approvalResponse(path, 200, body);
  assert.equal(safe.approval.internal, undefined);
  assert.deepEqual(approvalResponse(path, 200, safe), safe);
  assert.throws(() => approvalResponse(path, 200, { approval: { ...body.approval, params: { text: 'x'.repeat(32001) } } }));
  assert.equal(approvalResponse(path, 500, { error: 'sensitive backend text' }), null);
});

test('approval component performs no reads before an explicit click, and hides controls for non-owners', async () => {
  const base = createLoginMock(), calls = [];
  const client = new SessionClient({ mock: r => { calls.push(r); return base(r); } });
  client.selectMode('mock'); await client.login('demo@example.invalid', 'mock-only');
  const count = calls.length;
  const html = renderToStaticMarkup(React.createElement(RecoveryApprovals, { client, conversationId: CID }));
  assert.match(html, /Load pending tools/); assert.equal(calls.length, count);
  const denied = { getSnapshot: () => ({ user: { role: 'user' } }) };
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(RecoveryApprovals, { client: denied, conversationId: CID })), /Load pending tools/);
});

test('non-owner sessions cannot dispatch approval reads or mutations', async () => {
  const base = createLoginMock(); let sent = 0;
  const client = new SessionClient({ mock: async r => {
    if (r.path.startsWith('/api/approvals')) sent++;
    const response = await base(r);
    if (response.body?.user) return { ...response, body: { ...response.body, user: { ...response.body.user, role: 'user' } } };
    return response;
  } });
  client.selectMode('mock'); await client.login('demo@example.invalid', 'mock-only');
  assert.equal(client.getSnapshot().user.role, 'user');
  await assert.rejects(client.request({ method: 'GET', path: '/api/approvals?status=pending' }));
  await assert.rejects(client.request({ method: 'POST', path: `/api/approvals/${AID}/approve`, body: { paramsHash: 'a'.repeat(64) } }));
  assert.equal(sent, 0);
});
