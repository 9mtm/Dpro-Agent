// MEM-FINISH-01 (board M12): Memory › Handoffs — filters, newest note per chat / task,
// edit as a new version, history "Copy into editor", coding-app notes read only.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { conversationRoute, conversationResponse } = require('../src/conversation-contract.js');
const { MemoryHandoffsController } = require('../src/memory-handoffs.ts');
const { HandoffsView } = require('../src/MemoryHandoffs.tsx');

const PROJECT = '11111111-2222-4333-8444-555555555555';
const note = (o) => ({ id: `h-${o.scopeId}-${o.version}`, agentId: 'writer', kind: 'conversation', projectId: null, source: 'agent', done: [], left: [], next: [], questions: [], ...o });
function backend() {
  const calls = [];
  let history = [note({ scopeId: 'conv12345678', version: 4, createdAt: '2026-10-20 18:40:00', done: ['Three Tuesday posts drafted.'], left: ['Ahmed’s approval before 10:00.', 'Image for post 2.'], next: ['Publish after approval.'], questions: ['Arabic version for post 3?'], title: 'Tuesday posts', projectId: PROJECT }),
    note({ scopeId: 'conv12345678', version: 3, createdAt: '2026-10-20 14:05:00', source: 'owner', next: ['Publish after approval'] })];
  const list = () => [history[0], note({ scopeId: 'task-launch', kind: 'task', agentId: 'coder', version: 7, createdAt: '2026-10-21 11:02:00', done: ['schedule'], next: ['newsletter draft'], title: 'Launch week' })];
  const client = { request: async r => {
    calls.push(r); assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`); assert.ok(allowed(r.method, r.path, r.body), `bridge ${r.method} ${r.path}`);
    const f = (status, x) => memoryPagesRoute(r.path) ? memoryPagesResponse(r.path, status, x) : conversationRoute(r.path) ? conversationResponse(r.path, status, x) : x;
    const out = (body, status = 200) => ({ status, body: f(status, f(status, body)) });
    const path = r.path.split('?')[0];
    if (path === '/api/handoffs') return out({ handoffs: r.path.includes('projectId=') ? [history[0]] : list() });
    if (path === '/api/handoffs/coding-apps') return out({ handoffs: [{ id: 'b1', projectId: PROJECT, client: 'codex', done: ['recall trace tests'], left: [], next: ['UI wiring'], questions: [], createdAt: '2026-10-21 12:00:00' }] });
    if (path === '/api/agents') return { status: 200, body: { agents: [{ id: 'writer', name: 'Writer' }, { id: 'coder', name: 'Coder' }] } };
    if (path === '/api/chat/projects') return out({ projects: [{ id: PROJECT, name: 'Flowxtra', slug: 'flowxtra', folder: null }] });
    if (path === '/api/handoffs/conversation/conv12345678') {
      if (r.method === 'PUT') { const h = note({ scopeId: 'conv12345678', version: history[0].version + 1, createdAt: '2026-10-21 13:00:00', source: 'owner', ...r.body }); delete h.agentId; h.agentId = r.body.agentId; history = [{ ...h, title: 'Tuesday posts' }, ...history]; return out({ handoff: h }); }
      return out({ handoff: history[0], history });
    }
    return { status: 404, body: null };
  } };
  return { client, calls };
}

test('the page lists the newest note per chat and task with its title, counts per kind, and opens the newest (board M12)', async () => {
  const { client } = backend();
  const c = new MemoryHandoffsController(client);
  await c.load();
  const s = c.getSnapshot();
  assert.deepEqual(c.counts(), { all: 3, conversation: 1, task: 1, coding: 1 });
  assert.ok(c.isOpen({ coding: 'b1' }), 'the newest note opens first (the Codex note)');
  await c.openNote({ ref: { kind: 'conversation', scopeId: 'conv12345678', agentId: 'writer' } });
  const html = renderToStaticMarkup(React.createElement(HandoffsView, { c, onOpenChat: () => {} }));
  for (const words of ['All agents', 'All projects', 'Board tasks', 'Coding apps', 'Newest note per chat or task · 3', 'Tuesday posts', 'Launch week', 'Left: Ahmed’s approval before 10:00.; Image for post 2.', 'Writer · v4',
    'Codex · read only', 'Chat · Writer · Flowxtra', 'Version 4 · written by Writer', 'Open the chat', 'Done', 'Left', 'Next', 'Questions for you', 'Save as version 5', 'Discard changes',
    'Keys, passwords and tokens are removed before saving.', 'History (last 20 kept)', 'v3', 'Copy into editor', 'read-only with their app mark'])
    assert.ok(html.includes(words), words);
  assert.equal(s.agents.writer, 'Writer');
});

test('an edit is saved as the next version with one short line per item; Discard and Copy into editor fill the editor', async () => {
  const { client, calls } = backend();
  const c = new MemoryHandoffsController(client);
  await c.load();
  await c.openNote({ ref: { kind: 'conversation', scopeId: 'conv12345678', agentId: 'writer' } });
  assert.equal(c.changed(), false);
  c.edit({ next: 'Publish after approval.\n\n  Ask Sara about the print shop.  ' });
  assert.equal(c.changed(), true);
  c.discard();
  assert.equal(c.changed(), false);
  c.copyIntoEditor(3);
  assert.equal(c.getSnapshot().draft.next, 'Publish after approval');
  c.discard();
  c.edit({ next: 'Publish after approval.\n\n  Ask Sara about the print shop.  ' });
  await c.save();
  const put = calls.find(r => r.method === 'PUT');
  assert.deepEqual(put.body, { agentId: 'writer', done: ['Three Tuesday posts drafted.'], left: ['Ahmed’s approval before 10:00.', 'Image for post 2.'], next: ['Publish after approval.', 'Ask Sara about the print shop.'], questions: ['Arabic version for post 3?'] });
  assert.equal(c.getSnapshot().saved, 'Saved as version 5.');
  assert.equal(c.getSnapshot().current.version, 5);
  assert.equal(c.getSnapshot().history.length, 3);
});

test('filters: project narrows both lists through the API; kind and agent filter the list', async () => {
  const { client, calls } = backend();
  const c = new MemoryHandoffsController(client);
  await c.load();
  c.setKind('task');
  assert.deepEqual(c.visible().map(v => v.note?.title), ['Launch week']);
  c.setKind('coding');
  assert.equal(c.visible().length, 1);
  c.setKind('all');
  c.setProject(PROJECT);
  await new Promise(r => setTimeout(r, 0));
  await c.load();
  assert.ok(calls.some(r => r.path === `/api/handoffs?projectId=${PROJECT}&limit=200`));
  assert.ok(calls.some(r => r.path === `/api/handoffs/coding-apps?projectId=${PROJECT}&limit=200`));
  c.setAgent('writer');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(c.counts().coding, 0, 'coding-app notes have no agent');
});
