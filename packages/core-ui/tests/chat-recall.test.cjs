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
const { MemoryMoveController } = require('../src/memory-move.ts');

const MSG = 'msg12345678';
const CONV = 'conv12345678';
const MID = '0b9c1d2e-0000-4000-8000-000000000007';
const trace = { runId: 'run-0b9c1d2e-0000-4000-8000-000000000001', messageId: MSG, agentId: '_main', createdAt: '2026-10-21T08:00:00.000Z',
  items: [
    { kind: 'memory', id: MID, drawer: 'owner', why: 'topic', state: 'active', preview: 'صار ما يشرب شاي، بس قهوة بدون سكر.' },
    { kind: 'memory', id: 'm-2', drawer: 'project:flowxtra', why: 'graph', state: 'active', preview: 'Ahmed works on Flowxtra and approves posts before 10:00.' },
    { kind: 'memory', id: 'm-3', drawer: 'project:flowxtra', why: 'meaning', state: 'changed', score: 0.82, preview: 'Tuesday posts go out at 09:30.' },
    { kind: 'memory', id: 'm-4', drawer: 'people:sara', why: 'keyword', state: 'forgotten' },
    { kind: 'handoff', id: 'h-1', drawer: `conversation:${CONV}`, why: 'handoff', state: 'active' },
    { kind: 'fact', id: 'pf-1', drawer: 'project:flowxtra', why: 'pinned', state: 'active', preview: 'Never name a competitor.' },
  ],
  context: { keptTurns: 12, summarisedTurns: 40, droppedTurns: 0, summaries: [{ id: 's1', turns: 24, source: 'model' }, { id: 's2', turns: 16, source: 'model' }], fromCache: { pack: true, recall: false }, budgetTokens: 8192, numCtx: 32768, packChars: 9000, promptTokens: 3120, ttftMs: 1200, drawers: { loaded: ['owner', 'project:flowxtra'], noAccess: [] } },
  notLoaded: { drawers: [{ drawer: 'people:sara', why: 'not_open' }, { drawer: 'project:tel-agent', why: 'not_open' }], more: 0 } };
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
    if (r.path === `/api/memory/recall/conversations/${CONV}/summaries`) return twice(200, { summaries: [{ id: 's1', level: 1, firstTurn: 1, lastTurn: 24, turns: 24, text: 'Planned the week: Tuesday posts for Flowxtra.', source: 'model', createdAt: '2026-10-21T07:00:00.000Z' }] });
    if (r.path === '/api/memory/cache/metrics') return twice(200, { process: { since: '2026-10-21T07:00:00.000Z', caches: { pack: { hits: 8, misses: 2, hitRate: 0.8 }, recall: { hits: 5, misses: 5, hitRate: 0.47 }, embedding: { hits: 90, misses: 9, hitRate: 0.91 } }, packChars: { last: 12000, avg: 12400, samples: 10 }, ttftMs: { last: 1200, p50: 1400, p90: 3200, samples: 10 } }, recent: { turns: 50, packHitRate: 0.82, avgPackChars: 12400, avgPromptTokens: 3100, ttftMs: { p50: 1400, p90: 3200 } }, budget: { numCtx: 32768, promptTokens: 8192, summaryTokens: 1500, keepAlive: '30m' } });
    if (r.path.startsWith('/api/memory/access/agents')) return twice(200, { scope: 'company', column: 'project', mode: 'read', count: 5, total: 9, agents: [], nextCursor: null });
    if (r.path.startsWith('/api/memory/scopes/search')) return twice(200, { hits: [] });
    if (r.path === '/api/memory/m-2/move') return twice(200, { memory: { id: 'm-2' }, from: 'project:flowxtra', to: r.body.drawer });
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
  assert.match(renderToStaticMarkup(React.createElement(RecallChip, { c, turn })), /Remembered 6 ⌄/);
  c.toggle(MSG);
  const html = renderToStaticMarkup(React.createElement(RecallPanel, { c, turnKey: MSG, onWrongPlace: () => {} }));
  for (const words of ['What this reply used', 'In the order it was loaded', '>Topic<', 'صار ما يشرب شاي، بس قهوة بدون سكر.', 'About you', '>Map<', 'Projects · flowxtra', '>Handoff<', 'Handoff · this chat', '>Pinned<', 'Projects · flowxtra · pinned fact', 'Never name a competitor.',
    '>Meaning<', 'score 0.82', '>changed<', '(forgotten since this reply)', 'was in People · sara', '>forgotten<', 'Correct', 'Wrong place', 'Forget',
    'Drawers open for this reply: About you, Projects · flowxtra. Not loaded: People · sara, Projects · tel-agent.'])
    assert.ok(html.includes(words), words);
  c.startCorrect(MSG, MID, 'Coffee without sugar.');
  const fix = renderToStaticMarkup(React.createElement(RecallPanel, { c, turnKey: MSG }));
  assert.ok(fix.includes('Correct: “صار ما يشرب شاي، بس قهوة بدون سكر.”') && fix.includes('Send to Review') && fix.includes('The fix waits in Review with this reply as the reason.'));
  await c.correct();
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
  const ctx = renderToStaticMarkup(React.createElement(ContextCard, { trace: c.latest([MSG]), c }));
  for (const words of ['How this reply’s context was built', 'Turns kept in full', '12', 'Older turns as summaries', '1–40 (2 summaries)', 'Turns dropped', 'Context pack from cache', 'yes', 'Recall from cache', 'no', 'Prompt size', '3,120 tokens', 'Budget · model window', '8k · 32k', 'Time to first word', '1.2 s', 'Read the 2 summaries of turns 1–40'])
    assert.ok(ctx.includes(words), words);
  await c.toggleSummaries();
  const sums = renderToStaticMarkup(React.createElement(ContextCard, { trace: c.latest([MSG]), c }));
  assert.ok(sums.includes('Summary 1 of 1 · turns 1–24 · local model') && sums.includes('Planned the week'));
  await c.loadMetrics();
  assert.equal(c.getSnapshot().metrics.recent.packHitRate, 0.82);
  c.dispose();
});

test('"Wrong place" moves the memory with the M13 dialog; the reply then shows it moved (boards M15 + M13)', async () => {
  const { client, calls } = backend();
  const c = new ChatRecallController(client);
  c.setConversation(CONV); await c.ensure(turn);
  const m = new MemoryMoveController(client, (id, drawer) => c.moved(id, drawer));
  await m.open({ id: 'm-2', text: 'Ahmed works on Flowxtra and approves posts before 10:00.', drawerId: 'project:flowxtra' });
  await m.pick('owner');
  assert.equal(await m.move(), true);
  assert.deepEqual(calls.find(r => r.path === '/api/memory/m-2/move').body, { drawer: 'owner' });
  const it = c.trace(MSG).items.find(i => i.id === 'm-2');
  assert.deepEqual([it.state, it.nowIn], ['moved', 'owner']);
  c.toggle(MSG);
  const html = renderToStaticMarkup(React.createElement(RecallPanel, { c, turnKey: MSG }));
  assert.ok(html.includes('Projects · flowxtra → now in About you') && html.includes('>moved<'));
});

test('a reply that used nothing still shows its chip when a drawer was closed to the agent ("no access")', async () => {
  const blocked = { ...trace, items: [], context: { ...trace.context, drawers: { loaded: ['experience'], noAccess: ['owner'] } }, notLoaded: { drawers: [], more: 0 } };
  const client = { request: async r => ({ status: 200, body: memoryRecallResponse(r.path, 200, { trace: blocked }) }) };
  const c = new ChatRecallController(client);
  c.setConversation(CONV); await c.ensure(turn);
  assert.match(renderToStaticMarkup(React.createElement(RecallChip, { c, turn })), /Remembered 0/);
  c.toggle(MSG);
  assert.ok(renderToStaticMarkup(React.createElement(RecallPanel, { c, turnKey: MSG })).includes('Drawers open for this reply: Lessons. Not loaded: About you (no access).'));
});
