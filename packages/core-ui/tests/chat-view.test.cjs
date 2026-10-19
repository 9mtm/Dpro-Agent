// CHAT-REBUILD-01: saved conversations, runs, the transcript model and the chat view (offline mock).
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { SessionClient } = require('../src/session.ts');
const { createLoginMock } = require('../src/session-mock.ts');
const { ConversationsController } = require('../src/conversations.ts');
const { ChatView } = require('../src/ChatView.tsx');
const { ConversationList } = require('../src/ConversationList.tsx');
const { applyEvent, liveTurn, splitWork, toolView, workSummary, duration, fromWire } = require('../src/turns.ts');

async function fixture(t) {
  const calls = []; const base = createLoginMock();
  const client = new SessionClient({ mock: async r => { calls.push({ method: r.method, path: r.path }); return base(r); } });
  client.selectMode('mock'); await client.login('demo@example.invalid', 'mock-only');
  let n = 0;
  const c = new ConversationsController(client, () => `id${String(++n).padStart(10, '0')}`);
  t.after(() => c.dispose());
  return { c, calls, client };
}
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw Error('timeout'); await new Promise(r => setTimeout(r, 20)); } };
const view = c => renderToStaticMarkup(React.createElement(ChatView, { controller: c, mode: 'mock' }));

test('send creates the conversation, follows the run and stores the work; the list gets its title', async t => {
  const { c, calls } = await fixture(t);
  await c.load();
  assert.equal(c.getSnapshot().listPhase, 'ready');
  assert.match(view(c), /chat-suggestion/);
  c.edit('Plan the launch week\nwith details');
  const sending = c.send();
  assert.equal(c.getSnapshot().draft, '', 'the box clears at once');
  await sending;
  const s1 = c.getSnapshot();
  assert.ok(s1.activeId); assert.ok(s1.runId);
  assert.deepEqual(s1.turns.map(x => x.role), ['user', 'assistant']);
  assert.match(view(c), /Thinking|Working/);
  await until(() => !c.getSnapshot().runId);
  const done = c.getSnapshot().turns.at(-1);
  assert.equal(done.status, 'complete');
  assert.deepEqual(done.parts.map(p => p.kind), ['reasoning', 'tools', 'text']);
  assert.equal(done.parts[1].calls[1].output, 'brief.md\nideas.md');
  const html = view(c);
  assert.match(html, /Worked for/);
  assert.match(html, /Read 1 file|ran 1 command/i);
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<span class="md-code-lang">ts<\/span>/);
  await until(() => c.getSnapshot().conversations[0]?.title === 'Plan the launch week with details'.split(' ').slice(0, 7).join(' ').split('\n')[0] || c.getSnapshot().conversations[0]?.title?.startsWith('Plan the launch week'));
  assert.ok(calls.some(x => x.method === 'POST' && x.path === '/api/chat/conversations'));
  assert.ok(calls.some(x => /\/api\/chat\/runs\/run-.+\/events/.test(x.path)));
  // Reopening rebuilds the turn from the stored parts.
  const id = c.getSnapshot().activeId;
  c.newChat(); assert.equal(c.getSnapshot().turns.length, 0);
  await c.open(id);
  assert.equal(c.getSnapshot().turns.length, 2);
  assert.deepEqual(c.getSnapshot().turns[1].parts.map(p => p.kind), ['reasoning', 'tools', 'text']);
  const list = renderToStaticMarkup(React.createElement(ConversationList, { controller: c, onOpen: () => {} }));
  assert.match(list, /aria-current="true"/);
  assert.match(list, /Plan the launch week/);
});

test('a message typed while the agent works waits in the queue and goes after the reply', async t => {
  const { c } = await fixture(t);
  await c.send('First task');
  assert.ok(c.getSnapshot().runId);
  c.edit('Second task');
  await c.send();
  assert.deepEqual(c.getSnapshot().queue.map(q => q.text), ['Second task']);
  assert.match(view(c), /Waiting to send/);
  await until(() => c.getSnapshot().turns.filter(x => x.role === 'user').length === 2 && c.getSnapshot().queue.length === 0);
  await until(() => !c.getSnapshot().runId);
  assert.deepEqual(c.getSnapshot().turns.filter(x => x.role === 'user').map(x => x.content), ['First task', 'Second task']);
});

test('Stop keeps what was written; a failed run shows the error card with Try again', async t => {
  const { c } = await fixture(t);
  await c.send('Long job');
  await until(() => c.getSnapshot().turns.at(-1).parts.length > 0);
  await c.stop();
  await until(() => !c.getSnapshot().runId);
  const stopped = c.getSnapshot().turns.at(-1);
  assert.equal(stopped.status, 'stopped');
  assert.match(view(c), /Stopped/);
  await c.send('please fail now');
  await until(() => !c.getSnapshot().runId);
  const failed = c.getSnapshot().turns.at(-1);
  assert.equal(failed.status, 'error');
  assert.equal(failed.code, 'model_unavailable');
  assert.match(view(c), /The model could not be reached/);
  assert.match(view(c), /Try again/);
});

test('rename, pin and delete', async t => {
  const { c } = await fixture(t);
  await c.send('One'); await until(() => !c.getSnapshot().runId);
  const id = c.getSnapshot().activeId;
  await c.rename(id, 'Renamed chat');
  assert.equal(c.getSnapshot().conversations.find(x => x.id === id).title, 'Renamed chat');
  await c.pin(id, true);
  assert.equal(c.getSnapshot().conversations.find(x => x.id === id).pinned, true);
  await c.remove(id);
  assert.equal(c.getSnapshot().conversations.length, 0);
  assert.equal(c.getSnapshot().activeId, null);
});

test('transcript model: events in order, duplicates ignored, tools named by what they did', () => {
  let t = liveTurn('run-xxxxxxxx', 0);
  t = applyEvent(t, { seq: 1, type: 'reasoning', content: 'hm' }, 100);
  t = applyEvent(t, { seq: 2, type: 'tool_start', step: 1, tools: [{ id: 'a', name: 'exec', input: '{"command":"npm test"}' }] }, 1300);
  t = applyEvent(t, { seq: 2, type: 'text', content: 'dup' }, 1400);
  t = applyEvent(t, { seq: 3, type: 'tool_result', step: 1, results: [{ id: 'a', name: 'exec', output: 'ok', isError: false, ms: 900 }] }, 2000);
  t = applyEvent(t, { seq: 4, type: 'text', content: 'Done' }, 2100);
  t = applyEvent(t, { seq: 5, type: 'end', status: 'complete', ms: 2200 }, 2200);
  assert.equal(t.content, 'Done');
  assert.equal(t.parts[0].endedAt, 1300, 'thinking ends when the tool starts');
  assert.equal(t.parts[1].calls[0].running, false);
  const { work, answer } = splitWork(t.parts);
  assert.deepEqual(work.map(p => p.kind), ['reasoning', 'tools']);
  assert.deepEqual(answer.map(p => p.kind), ['text']);
  assert.deepEqual(toolView({ name: 'exec', input: '{"command":"npm test"}', running: true }).verb, 'Running');
  assert.equal(toolView({ name: 'exec', input: '{"command":"npm test"}', running: false }).target, 'npm test');
  assert.equal(toolView({ name: 'read_file', input: '{"path":"/a/b/config.ts"}', running: false }).target, 'config.ts');
  assert.equal(toolView({ name: 'web_search', input: '{"query":"weather"}', running: false }).target, '“weather”');
  assert.equal(workSummary(t.parts), 'Ran 1 command');
  assert.equal(duration(65000), '1m 05s');
  const stored = fromWire({ id: 'm', role: 'assistant', content: 'plain', parts: null, status: 'complete', runId: null, durationMs: null, createdAt: '' });
  assert.deepEqual(stored.parts, [{ kind: 'text', text: 'plain' }]);
});

test('Stop pauses the queue; Send now sends the waiting message', async t => {
  const { c } = await fixture(t);
  await c.send('Big job');
  c.edit('Follow-up'); await c.send();
  assert.equal(c.getSnapshot().queue.length, 1);
  await until(() => c.getSnapshot().turns.at(-1).parts.length > 0);
  await c.stop();
  await until(() => !c.getSnapshot().runId);
  const s = c.getSnapshot();
  assert.equal(s.queuePaused, true);
  assert.equal(s.queue.length, 1, 'nothing was sent on its own');
  assert.match(view(c), /Send now/);
  c.sendQueued(s.queue[0].key);
  await until(() => c.getSnapshot().turns.filter(x => x.role === 'user').length === 2);
  assert.equal(c.getSnapshot().queuePaused, false);
  await until(() => !c.getSnapshot().runId);
});

test('projects: create one, chats go into it, the chat shows the project bar; moving and removing', async t => {
  const { c } = await fixture(t);
  await c.load(); await new Promise(r => setTimeout(r, 30));
  assert.match(await c.createProject({ name: 'App', folder: '', repoUrl: '' }), /working folder/);
  assert.equal(c.getSnapshot().projects.length, 0);
  assert.match(await c.createProject({ name: 'App', folder: 'relative', repoUrl: '' }), /folder/);
  assert.equal(await c.createProject({ name: 'App', folder: '/fiction/app', repoUrl: 'https://github.com/example/app' }), null);
  const p = c.getSnapshot().projects[0];
  assert.equal(c.getSnapshot().projectFilter, p.id, 'the new project is selected');
  await c.send('Work in the app');
  await until(() => !c.getSnapshot().runId);
  const conv = c.getSnapshot().conversations.find(x => x.id === c.getSnapshot().activeId);
  assert.equal(conv.projectId, p.id);
  await until(() => c.getSnapshot().git?.branch === 'feature/panel');
  const html = view(c);
  assert.match(html, /aria-label="Project"/);
  assert.match(html, /\/fiction\/app/);
  assert.match(html, /⎇ feature\/panel/);
  assert.match(html, /github\.com\/example\/app/);
  const list = renderToStaticMarkup(React.createElement(ConversationList, { controller: c, onOpen: () => {} }));
  assert.match(list, /\+ New project/);
  assert.match(list, /New general chat/);
  await c.moveToProject(conv.id, '');
  assert.equal(c.getSnapshot().conversations.find(x => x.id === conv.id).projectId, null);
  await c.removeProject(p.id);
  assert.equal(c.getSnapshot().projects.length, 0);
  assert.equal(c.getSnapshot().projectFilter, '');
});

test('side panel shows environment, size, outputs and changes; the list groups by date', async t => {
  const { dateGroups } = require('../src/ConversationList.tsx');
  const now = new Date('2026-10-15T12:00:00');
  const g = dateGroups([{ updatedAt: '2026-10-15 09:00:00' }, { updatedAt: '2026-10-14 09:00:00' }, { updatedAt: '2026-10-10 09:00:00' }, { updatedAt: '2026-09-01 09:00:00' }], now);
  assert.deepEqual(g.map(x => x[0]), ['Today', 'Yesterday', 'Previous 7 days', 'Older']);
  const { c } = await fixture(t);
  await c.load(); await new Promise(r => setTimeout(r, 30));
  await c.createProject({ name: 'App', folder: '/fiction/app', repoUrl: '' });
  await c.send('Plan it'); await until(() => !c.getSnapshot().runId);
  await until(() => c.getSnapshot().git?.added === 12);
  const html = renderToStaticMarkup(React.createElement(ChatView, { controller: c, mode: 'mock' }));
  assert.match(html, /aria-label="Conversation details"/);
  assert.match(html, />Environment</);
  assert.match(html, /≈ [\d,]+ tokens/);
  assert.match(html, /\+12/);
  assert.match(html, /in 2 files not committed/);
});

test('panes: changes with an inline diff, the folder tree and a file; paths are checked on both sides', async t => {
  const { PanesController, diffLines } = require('../src/panes.ts');
  const { ChangesPane, FilesPane } = require('../src/ProjectPanes.tsx');
  const { conversationPath, conversationResponse, panePath } = require('../src/conversation-contract.js');
  assert.equal(panePath('00000000-0000-4000-8000-000000000001', 'file', 'src/a b.ts'), '/api/chat/projects/00000000-0000-4000-8000-000000000001/file?path=src%2Fa%20b.ts');
  assert.equal(conversationPath(panePath('00000000-0000-4000-8000-000000000001', 'file', 'src/a b.ts')).rel, 'src/a b.ts');
  for (const bad of ['..%2Fx', '%2Fetc%2Fhosts', 'a%00b']) assert.equal(conversationPath(`/api/chat/projects/00000000-0000-4000-8000-000000000001/file?path=${bad}`), null, bad);
  assert.equal(conversationPath('/api/chat/projects/00000000-0000-4000-8000-000000000001/file'), null, 'a file needs a path');
  const changes = { branch: 'main', truncated: false, changes: [{ path: 'a.ts', status: 'modified', added: 1, removed: 0 }, { path: 'x', status: 'weird' }] };
  const once = conversationResponse('/api/chat/projects/00000000-0000-4000-8000-000000000001/changes', 200, changes);
  assert.equal(once.changes.length, 1);
  assert.deepEqual(conversationResponse('/api/chat/projects/00000000-0000-4000-8000-000000000001/changes', 200, once), once, 'projection is stable when applied twice');
  assert.deepEqual(diffLines('@@ -1,2 +1,2 @@\n a\n-b\n+c\n').map(l => [l.kind, l.old ?? null, l.new ?? null]), [['hunk', null, null], ['ctx', 1, 1], ['del', 2, null], ['add', null, 2]]);

  const { c, client } = await fixture(t);
  await c.load(); await new Promise(r => setTimeout(r, 30));
  await c.createProject({ name: 'App', folder: '/fiction/app', repoUrl: '' });
  const project = c.getSnapshot().projects[0];
  const panes = new PanesController(client); t.after(() => panes.dispose());
  panes.setProject(project.id);
  await panes.loadChanges();
  await panes.toggleDiff('src/app.ts');
  await panes.toggleDiff('.env');
  let html = renderToStaticMarkup(React.createElement(ChangesPane, { panes }));
  assert.match(html, /app\.ts/); assert.match(html, /\+3/); assert.match(html, /const c = 4;/); assert.match(html, /Hidden: this file may hold secrets/);
  await panes.loadFolder(''); await panes.toggleFolder('src');
  html = renderToStaticMarkup(React.createElement(FilesPane, { panes }));
  assert.match(html, /README\.md/); assert.match(html, /app\.ts/);
  await panes.openFile('README.md');
  html = renderToStaticMarkup(React.createElement(FilesPane, { panes }));
  assert.match(html, /Fictional project/);
  panes.setProject(null);
  assert.equal(panes.getSnapshot().changes, undefined, 'switching project drops what was loaded');
});

test('GitHub card: upstream, ahead/behind, last commit and github.com links only', async t => {
  const { conversationResponse } = require('../src/conversation-contract.js');
  const id = '00000000-0000-4000-8000-000000000001';
  const gh = ['https:', '', 'github.com'].join('/');
  const projected = conversationResponse(`/api/chat/projects/${id}/git`, 200, { git: { branch: 'b', remote: null, dirty: false, upstream: 'origin/b', ahead: 2, behind: 0,
    github: { owner: 'o', repo: 'r', repoUrl: `${gh}/o/r`, branchUrl: ['https:', '', 'evil.example/x'].join('/'), compareUrl: `${gh}/o/r/compare/main...b?expand=1` } } });
  assert.equal(projected.git.github.branchUrl, null, 'a link outside github.com is dropped');
  assert.match(projected.git.github.compareUrl, /compare\/main\.\.\.b/);
  assert.deepEqual(conversationResponse(`/api/chat/projects/${id}/git`, 200, projected), projected, 'stable when projected twice');

  const { c } = await fixture(t);
  await c.load(); await new Promise(r => setTimeout(r, 30));
  await c.createProject({ name: 'App', folder: '/fiction/app', repoUrl: '' });
  await until(() => c.getSnapshot().git?.github);
  const html = renderToStaticMarkup(React.createElement(ChatView, { controller: c, mode: 'mock' }));
  assert.match(html, /example\/app/);
  assert.match(html, /↑3 ↓1/);
  assert.match(html, /Fictional commit/);
  assert.match(html, /Compare \/ pull request/);
  assert.match(html, /3 commits are only on this computer/);
});

test('task plan: the latest plan_steps call shows as a live checklist, not as tool work', async t => {
  const { turnPlan, withoutPlan } = require('../src/turns.ts');
  const call = (id, steps, isError = false) => ({ id, name: 'plan_steps', input: JSON.stringify({ steps }), running: false, isError });
  const parts = [{ kind: 'tools', step: 0, calls: [call('a', [{ title: 'One', status: 'active' }, { title: 'Two', status: 'pending' }])] },
    { kind: 'tools', step: 1, calls: [{ id: 'r', name: 'read', input: '{"path":"x.md"}', running: false }, call('b', [{ title: 'One', status: 'done' }, { title: 'Two', status: 'active' }])] },
    { kind: 'tools', step: 2, calls: [call('c', [{ title: 'broken', status: 'done' }], true)] }];
  assert.deepEqual(turnPlan(parts).map(s => s.status), ['done', 'active'], 'a refused call does not replace the last good plan');
  assert.deepEqual(withoutPlan(parts).flatMap(p => p.calls.map(c => c.name)), ['read']);

  const { c } = await fixture(t);
  await c.load(); await new Promise(r => setTimeout(r, 30));
  await c.send('Make a plan for launch week'); await until(() => !c.getSnapshot().runId);
  const html = renderToStaticMarkup(React.createElement(ChatView, { controller: c, mode: 'mock' }));
  assert.match(html, /aria-label="Task plan"/);
  assert.match(html, /2 of 3/);
  assert.match(html, /Check with the owner/);
  assert.doesNotMatch(html, /plan steps/i, 'the plan call is not listed as a tool');
});

test('team chat: "@Name" or the reply picker chooses who writes; replies show their writer', async t => {
  const { c, calls } = await fixture(t);
  await c.load(); await until(() => c.getSnapshot().agents.length === 2);
  assert.equal(c.mentioned('please @offline helper, check this')?.id, 'sample-helper');
  assert.equal(c.mentioned('mail me at x@offline helper')?.id, undefined, 'only at the start of a word');
  await c.send('Write the plan'); await until(() => !c.getSnapshot().runId);
  await c.send('@Offline helper review it'); await until(() => !c.getSnapshot().runId);
  const runs = calls.filter(x => x.method === 'POST' && /\/runs$/.test(x.path));
  assert.equal(runs.length, 2);
  await c.open(c.getSnapshot().activeId); await until(() => c.getSnapshot().threadPhase === 'ready');
  const writers = c.getSnapshot().turns.filter(x => x.role === 'assistant').map(x => x.agentId ?? null);
  assert.deepEqual(writers, [null, 'sample-helper']);
  assert.equal(c.getSnapshot().replyAgent, '', 'opening resets the picker');
  const html = renderToStaticMarkup(React.createElement(ChatView, { controller: c, mode: 'mock' }));
  assert.match(html, /class="reply-writer"[^>]*>.*Offline helper/);
  assert.match(html, /aria-label="Reply from"|>Reply from</);
  c.edit('hey @off');
  assert.match(renderToStaticMarkup(React.createElement(ChatView, { controller: c, mode: 'mock' })), /role="listbox" aria-label="Agents"/);
});
