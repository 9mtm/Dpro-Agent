require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { memoryRecallRoute, memoryRecallResponse } = require('../src/memory-recall-contract.js');
const { ChatRecallController } = require('../src/chat-recall.ts');
const { RecallChip, RecallPanel, HandoffCard, ContextCard } = require('../src/ChatRecall.tsx');

const MSG = 'msg12345678';
const CONV = 'conv12345678';
const MID = '0b9c1d2e-0000-4000-8000-000000000007';
const trace = { runId: 'run-0b9c1d2e-0000-4000-8000-000000000001', messageId: MSG, agentId: '_main', createdAt: '2026-10-21T08:00:00.000Z',
  items: [
    { kind: 'memory', id: MID, drawer: 'owner', why: 'topic', state: 'active', preview: 'صار ما يشرب شاي، بس قهوة بدون سكر.' },
    { kind: 'memory', id: 'm-2', drawer: 'project:flowxtra', why: 'graph', state: 'active', preview: 'Ahmed works on Flowxtra and approves posts before 10:00.' },
    { kind: 'handoff', id: 'h-1', drawer: `conversation:${CONV}`, why: 'handoff', state: 'active' },
  ],
  context: { keptTurns: 12, summarisedTurns: 40, droppedTurns: 0, summaries: [], fromCache: { pack: true, recall: false }, budgetTokens: 3100, numCtx: 32768, packChars: 9000, promptTokens: 3000, ttftMs: 1400 } };
const handoff = { id: 'h-1', agentId: '_main', kind: 'conversation', scopeId: CONV, projectId: null, version: 3, source: 'agent', createdAt: '2026-10-20T18:40:00.000Z', done: ['Tuesday posts drafted (3).'], left: ['Ahmed’s approval', 'image for post 2'], next: ['publish after approval'], questions: [] };

function backend() {
  const calls = [];
  const client = { request: async r => {
    calls.push(r);
    assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`); assert.ok(allowed(r.method, r.path, r.body), `bridge ${r.method} ${r.path}`);
    const twice = (status, body) => { const f = x => memoryPagesRoute(r.path) ? memoryPagesResponse(r.path, status, x) : memoryRecallRoute(r.path) ? memoryRecallResponse(r.path, status, x) : x; return { status, body: f(f(body)) }; };
    if (r.path === `/api/memory/recall/messages/${MSG}`) return twice(200, { trace });
    if (r.path === `/api/memory/recall/messages/${MSG}/correct`) return twice(201, { proposal: { id: 'p-9', status: 'pending', reviewHash: 'c'.repeat(64), drawerId: 'owner', createdAt: '2026-10-21T09:00:00.000Z' } });
    if (r.path === `/api/memory/recall/messages/${MSG}/forget`) return twice(200, { forgotten: { memoryId: r.body.memoryId, drawerId: 'owner', forgottenAt: '2026-10-21T09:00:00.000Z' } });
    if (r.path.startsWith('/api/handoffs?')) return twice(200, { handoffs: [handoff] });
    if (r.path === `/api/handoffs/conversation/${CONV}` && r.method === 'PUT') return twice(200, { handoff: { ...handoff, ...r.body, version: 4, source: 'owner', createdAt: '2026-10-21T09:00:00.000Z' } });
    return { status: 404, body: null };
  } };
  return { client, calls };
}
const turn = { key: MSG, role: 'assistant', runId: null, status: 'complete' };

test('a reply shows "Remembered N" and what it used; Correct goes to review, Forget asks first (board M5)', async () => {
  const { client, calls } = backend();
  const c = new ChatRecallController(client);
  c.setConversation(CONV);
  await c.ensure(turn); await c.ensure(turn);
  assert.equal(calls.filter(r => r.path.endsWith(MSG)).length, 1, 'each trace is read once');
  assert.match(renderToStaticMarkup(React.createElement(RecallChip, { c, turn })), /Remembered 3 ⌄/);
  c.toggle(MSG);
  const html = renderToStaticMarkup(React.createElement(RecallPanel, { c, turnKey: MSG }));
  for (const words of ['What this reply used', 'About you · topic', 'صار ما يشرب شاي، بس قهوة بدون سكر.', 'Projects · flowxtra · map', 'Handoff', 'Correct', 'Forget', 'Drawers open for this reply: About you, Projects · flowxtra.'])
    assert.ok(html.includes(words), words);
  c.startCorrect(MSG, MID, 'Coffee without sugar.'); await c.correct();
  assert.deepEqual(calls.find(r => r.path.endsWith('/correct')).body, { memoryId: MID, content: 'Coffee without sugar.' });
  assert.match(c.getSnapshot().notes[MSG], /Memory › Review/);
  await c.forget(); assert.ok(!calls.some(r => r.path.endsWith('/forget')), 'forget needs its confirm');
  c.askForget(MSG, MID); await c.forget();
  assert.deepEqual(calls.find(r => r.path.endsWith('/forget')).body, { memoryId: MID });
  assert.equal(c.trace(MSG).items[0].state, 'forgotten'); assert.equal(c.trace(MSG).items[0].preview, undefined);
  c.dispose();
});

test('Details: where we left off (edited as a new version) and how the context was built', async () => {
  const { client, calls } = backend();
  const c = new ChatRecallController(client);
  c.setConversation(CONV); await c.loadHandoff(); await c.ensure(turn);
  const card = renderToStaticMarkup(React.createElement(HandoffCard, { c, agentId: '_main', agentName: 'Main Agent' }));
  for (const words of ['Where we left off', 'Main Agent', 'Done', 'Tuesday posts drafted (3).', 'Left', 'Ahmed’s approval; image for post 2', 'Next', 'The agent reads this at the start of the next session.']) assert.ok(card.includes(words), words);
  c.startEdit(); c.editDraft({ next: 'publish after approval\nask Sara about the print shop' }); await c.saveHandoff('_main');
  const put = calls.find(r => r.method === 'PUT');
  assert.deepEqual(put.body, { agentId: '_main', done: ['Tuesday posts drafted (3).'], left: ['Ahmed’s approval', 'image for post 2'], next: ['publish after approval', 'ask Sara about the print shop'], questions: [] });
  assert.equal(c.getSnapshot().handoff.version, 4);
  const ctx = renderToStaticMarkup(React.createElement(ContextCard, { trace: c.latest([MSG]) }));
  for (const words of ['Kept in full', 'last 12 turns', 'Summarised', 'turns 1–40', 'From cache', 'persona, pinned facts', '1.4 s']) assert.ok(ctx.includes(words), words);
  c.dispose();
});
