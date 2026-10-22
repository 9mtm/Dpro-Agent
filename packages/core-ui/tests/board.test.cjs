require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { SessionClient, allowedRequest } = require('../src/session.ts');
const { BoardController, cardsIn, matches } = require('../src/board.ts');
const { TaskBoard } = require('../src/TaskBoard.tsx');
const { allowedBoard, boardResponse, validBoardEdit, validCardEdit, validNewBoard, validNewCard } = require('../src/board-contract.js');
const { createLoginMock } = require('../src/session-mock.ts');
const { allowed } = require('../scripts/application-server.cjs');

async function fixture(t, wrap = x => x) {
  const calls = []; const base = wrap(createLoginMock());
  const client = new SessionClient({ mock: async r => { calls.push(r); return base(r); } });
  client.selectMode('mock'); await client.login('demo@example.invalid', 'mock-only');
  const b = new BoardController(client); t.after(() => b.dispose());
  return { b, calls, client };
}
const markup = b => renderToStaticMarkup(React.createElement(TaskBoard, { controller: b }));
const col = (b, name) => b.getSnapshot().columns.find(c => c.name === name).id;

test('board contract (browser and bridge): exact paths, strict bodies, no other methods', () => {
  assert.equal(validNewCard({ columnId: 'c1', title: 'Write the post', priority: 'high', agents: ['agent-1'], departments: ['marketing'], dueDate: '2026-11-01' }), true);
  for (const bad of [{ columnId: 'c1', title: '' }, { columnId: 'c1', title: 'a\nb' }, { columnId: 'c1', title: 'x', priority: 'asap' }, { columnId: 'c1', title: 'x', departments: ['Marketing'] },
    { columnId: 'c1', title: 'x', extra: 1 }, { columnId: '../x', title: 'x' }, { columnId: 'c1', title: 'x', description: 'a‮b' }])
    assert.equal(validNewCard(bad), false, JSON.stringify(bad));
  assert.equal(validCardEdit({ expectedVersion: 2, columnId: 'c2', beforeCardId: null }), true);
  for (const bad of [{ expectedVersion: 2 }, { title: 'x' }, { expectedVersion: 2, beforeCardId: 'k1' }, { expectedVersion: 0, title: 'x' }, { expectedVersion: 2, archived: 'yes' }])
    assert.equal(validCardEdit(bad), false, JSON.stringify(bad));
  for (const allow of [allowedRequest, allowed]) {
    assert.equal(allow('GET', '/api/boards', undefined), true);
    assert.equal(allow('GET', '/api/boards/b1', undefined), true);
    assert.equal(allow('GET', '/api/boards/b1?archived=1', undefined), true);
    assert.equal(allow('GET', '/api/boards/b1?x=1', undefined), false);
    assert.equal(allow('POST', '/api/boards/b1/cards', { columnId: 'c1', title: 'x' }), true);
    assert.equal(allow('PUT', '/api/boards/b1/cards/k1', { expectedVersion: 1, title: 'y' }), true);
    assert.equal(allow('DELETE', '/api/boards/b1/cards/k1', undefined), false);
    assert.equal(allow('POST', '/api/boards/b1/cards/k1/comments', { body: 'hi' }), true);
    assert.equal(allow('POST', '/api/boards/b1/cards/k1/comments', { body: '' }), false);
    assert.equal(allow('PUT', '/api/boards/b1/columns/c1', { name: 'Doing' }), true);
  }
  assert.equal(allowedBoard('POST', '/api/boards/b1/columns', { name: 'x', extra: 1 }), false);
});

test('responses are projected; malformed ones are refused', () => {
  const card = { id: 'k1', columnId: 'c1', title: 'T', description: '', priority: 'normal', position: 1000, dueDate: null, archived: false, version: 1, agents: ['agent-1', '../bad'], departments: ['sales', 'Bad Dep'], comments: 2, updatedAt: '2026-10-15 12:00:00', taskId: 'secret', createdBy: 'owner' };
  const view = boardResponse('/api/boards/b1', 200, { id: 'b1', name: 'Company board', columns: [{ id: 'c1', name: 'To do', position: 1000 }], cards: [card], owner_id: 'x' });
  assert.deepEqual(view.cards[0].agents, ['agent-1']); assert.deepEqual(view.cards[0].departments, ['sales']);
  assert.equal(view.cards[0].taskId, undefined); assert.equal(view.owner_id, undefined);
  assert.throws(() => boardResponse('/api/boards/b1', 200, { id: 'b1', columns: [], cards: [{ ...card, priority: 'mega' }] }));
  assert.deepEqual(boardResponse('/api/boards/b1/cards/k1', 409, { code: 'version_conflict', error: 'x', card }).code, 'version_conflict');
  assert.equal(boardResponse('/api/boards/b1/cards', 400, { code: 'weird', error: 'stack…' }), null);
});

test('offline: open, add cards, edit in the panel, move, comment, archive', async t => {
  const { b, calls } = await fixture(t);
  assert.equal(calls.filter(c => c.path.startsWith('/api/boards')).length, 0, 'nothing read before Open the board');
  assert.match(markup(b), /Open the boards/);
  await b.load();
  let s = b.getSnapshot();
  assert.deepEqual(s.columns.map(c => c.name), ['Ideas', 'Backlog', 'To do', 'In progress', 'Review', 'Done']);
  assert.ok(s.agents.length >= 2, 'team loaded for assignees');
  assert.equal(await b.addCard(col(b, 'To do'), '  Write   the launch post '), true);
  assert.equal(await b.addCard(col(b, 'To do'), 'Design the banner'), true);
  assert.equal(await b.addCard(col(b, 'To do'), ''), false);
  s = b.getSnapshot();
  assert.deepEqual(cardsIn(s.cards, col(b, 'To do')).map(c => c.title), ['Write the launch post', 'Design the banner']);
  const post = s.cards.find(c => c.title === 'Write the launch post');
  await b.openCard(post.id);
  b.editDraft({ description: 'Short and friendly.', priority: 'urgent', dueDate: '2026-11-02' });
  b.toggleAgent(s.agents[0].id);
  assert.equal(b.addDepartment('  Marketing '), true);
  assert.equal(b.addDepartment('a<b>'), false);
  await b.saveCard();
  const put = calls.filter(c => c.method === 'PUT').at(-1);
  assert.deepEqual(put.body, { expectedVersion: 1, description: 'Short and friendly.', priority: 'urgent', dueDate: '2026-11-02', agents: [s.agents[0].id], departments: ['marketing'] });
  let html = markup(b);
  assert.match(html, /Urgent/); assert.match(html, /marketing/); assert.match(html, /Due 2026-11-02/);
  await b.addComment('Please keep it under 200 words.');
  assert.equal(b.getSnapshot().comments.length, 1);
  assert.equal(b.getSnapshot().cards.find(c => c.id === post.id).comments, 1);
  // Move the banner before the post in "In progress", then the post after it.
  const banner = b.getSnapshot().cards.find(c => c.title === 'Design the banner');
  await b.move(banner.id, col(b, 'In progress'), null);
  await b.move(post.id, col(b, 'In progress'), banner.id);
  assert.deepEqual(cardsIn(b.getSnapshot().cards, col(b, 'In progress')).map(c => c.title), ['Write the launch post', 'Design the banner']);
  // Filters.
  b.setFilter({ department: 'marketing' });
  assert.equal(b.getSnapshot().cards.filter(c => matches(c, b.getSnapshot().filter)).length, 1);
  b.setFilter({ department: '', text: 'banner' });
  assert.equal(b.getSnapshot().cards.filter(c => matches(c, b.getSnapshot().filter)).length, 1);
  b.setFilter({ text: '' });
  // Archive closes the panel and hides the card.
  await b.openCard(banner.id);
  await b.archiveCard();
  s = b.getSnapshot();
  assert.equal(s.open, undefined); assert.ok(!s.cards.some(c => c.id === banner.id));
  html = markup(b);
  for (const label of ['Search cards', 'Filter tasks', 'Board actions', 'New task', 'Add task']) assert.match(html, new RegExp(label.replace('+', '\\+')));
});

test('a stale card shows the latest version; nothing is sent for an unchanged card', async t => {
  let stale = true;
  const { b, calls } = await fixture(t, base => async r => {
    if (r.method === 'PUT' && /\/cards\//.test(r.path) && stale) { stale = false; const cur = await base({ ...r, body: { expectedVersion: r.body.expectedVersion, title: 'Changed elsewhere' } }); return { status: 409, body: { code: 'version_conflict', card: cur.body } }; }
    return base(r);
  });
  await b.load();
  await b.addCard(col(b, 'Backlog'), 'Original');
  const card = b.getSnapshot().cards[0];
  await b.openCard(card.id);
  await b.saveCard();
  assert.match(b.getSnapshot().notice, /Nothing changed/);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 0);
  b.editDraft({ title: 'My edit' });
  await b.saveCard();
  assert.match(b.getSnapshot().notice, /changed meanwhile/);
  assert.equal(b.getSnapshot().draft.title, 'Changed elsewhere');
});

test('not the owner: nothing to open', async () => {
  const client = new SessionClient({ mock: createLoginMock() });
  const b = new BoardController(client);
  assert.equal(b.getSnapshot().owner, false);
  await b.load();
  assert.equal(b.getSnapshot().boardId, undefined);
  b.dispose();
});

test('quick successive adds are queued, none is lost', async t => {
  const { b } = await fixture(t);
  await b.load();
  const results = await Promise.all(['One', 'Two', 'Three'].map(x => b.addCard(col(b, 'Backlog'), x)));
  assert.deepEqual(results, [true, true, true]);
  assert.deepEqual(cardsIn(b.getSnapshot().cards, col(b, 'Backlog')).map(c => c.title), ['One', 'Two', 'Three']);
});

test('boards contract: create and edit bodies; list projection with templates and colours', () => {
  assert.equal(validNewBoard({ name: 'Launch', template: 'content', color: 'pink', departments: ['marketing', 'sales'], description: 'x' }), true);
  for (const bad of [{ name: '' }, { name: 'x', color: 'gold' }, { name: 'x', template: 'Bad Id' }, { name: 'x', departments: ['Marketing'] }, { name: 'x', extra: 1 }])
    assert.equal(validNewBoard(bad), false, JSON.stringify(bad));
  assert.equal(validBoardEdit({ expectedVersion: 2, archived: true }), true);
  assert.equal(validBoardEdit({ expectedVersion: 2 }), false);
  assert.equal(validBoardEdit({ name: 'x' }), false);
  for (const allow of [allowedRequest, allowed]) {
    assert.equal(allow('POST', '/api/boards', { name: 'Launch' }), true);
    assert.equal(allow('PUT', '/api/boards/b1', { expectedVersion: 1, color: 'teal' }), true);
    assert.equal(allow('GET', '/api/boards?archived=1', undefined), true);
    assert.equal(allow('DELETE', '/api/boards/b1', undefined), false);
  }
  const list = boardResponse('/api/boards', 200, { boards: [{ id: 'b1', name: 'Company board', description: '', template: 'kanban', color: 'blue', departments: [], kind: 'company', archived: false, version: 1, cards: 3, open: 2, owner_id: 'x' }],
    templates: [{ id: 'kanban', name: 'Team workflow', description: 'd', columns: ['Ideas', 'Done'] }, { id: 'BAD' }], colors: ['blue', 'gold'] });
  assert.equal(list.boards[0].owner_id, undefined); assert.equal(list.boards[0].cards, 3);
  assert.deepEqual(list.templates.map(t => t.id), ['kanban']); assert.deepEqual(list.colors, ['blue']);
});

test('offline: create department and shared boards from templates, switch, edit settings, archive', async t => {
  const { b, calls } = await fixture(t);
  await b.load();
  assert.equal(b.getSnapshot().boards.length, 1);
  assert.ok(b.getSnapshot().templates.some(x => x.id === 'content'));
  assert.equal(await b.createBoard({ name: 'Marketing content', template: 'content', color: 'pink', departments: [' Marketing '] }), true);
  let s = b.getSnapshot();
  assert.equal(s.meta.name, 'Marketing content'); assert.equal(s.meta.kind, 'department');
  assert.deepEqual(s.columns.map(c => c.name), ['Ideas', 'Writing', 'Editing', 'Scheduled', 'Published']);
  assert.deepEqual(calls.find(c => c.method === 'POST' && c.path === '/api/boards').body, { name: 'Marketing content', template: 'content', color: 'pink', departments: ['marketing'] });
  await b.createBoard({ name: 'Product launch', template: 'kanban', color: 'orange', departments: ['marketing', 'development'] });
  s = b.getSnapshot();
  assert.equal(s.meta.kind, 'shared'); assert.equal(s.boards.length, 3);
  const html = markup(b);
  for (const label of ['Whole company', 'marketing', 'Shared by departments', 'New board', 'Board actions']) assert.match(html, new RegExp(label));
  // Switch back to the company board.
  await b.openBoard(s.boards.find(x => x.name === 'Company board').id);
  assert.equal(b.getSnapshot().meta.name, 'Company board');
  // Settings: rename + recolour; nothing changed is not sent; archive hides it.
  await b.openBoard(b.getSnapshot().boards.find(x => x.name === 'Product launch').id);
  assert.equal(await b.updateBoard({ name: 'Product launch' }), false);
  assert.match(b.getSnapshot().notice, /Nothing changed/);
  assert.equal(await b.updateBoard({ name: 'Launch 2027', color: 'teal' }), true);
  assert.deepEqual([b.getSnapshot().meta.name, b.getSnapshot().meta.color, b.getSnapshot().meta.version], ['Launch 2027', 'teal', 2]);
  const archivedId = b.getSnapshot().meta.id;
  assert.equal(await b.updateBoard({ archived: true }), true);
  s = b.getSnapshot();
  assert.ok(!s.boards.some(x => x.id === archivedId)); assert.notEqual(s.boardId, archivedId);
  assert.match(s.notice, /archived/);
});

test('richer cards: type, dates, cover, labels and checklist from the panel', async t => {
  const { b, calls } = await fixture(t);
  await b.load();
  assert.equal(b.getSnapshot().labels.length, 4);
  await b.addCard(col(b, 'To do'), 'Fix the export');
  const card = b.getSnapshot().cards[0];
  await b.openCard(card.id);
  const important = b.getSnapshot().labels.find(l => l.name === 'Important').id;
  b.editDraft({ type: 'bug', startDate: '2026-11-03', dueDate: '2026-11-01', cover: 'red' });
  b.toggleLabel(important);
  await b.saveCard();
  assert.match(b.getSnapshot().notice, /start date cannot be after/);
  b.editDraft({ dueDate: '2026-11-05' });
  await b.saveCard();
  const put = calls.filter(c => c.method === 'PUT').at(-1);
  assert.deepEqual(put.body, { expectedVersion: 1, dueDate: '2026-11-05', type: 'bug', startDate: '2026-11-03', cover: 'red', labels: [important] });
  assert.equal(await b.addLabel('Customer', 'teal'), true);
  assert.ok(b.getSnapshot().labels.some(l => l.name === 'Customer'));
  await b.addCheckItem('Find the cause');
  await b.addCheckItem('Write the fix');
  await b.updateCheckItem(b.getSnapshot().checklist[0].id, { done: true });
  assert.deepEqual(b.getSnapshot().cards[0].checklist, { done: 1, total: 2 });
  await b.updateCheckItem(b.getSnapshot().checklist[1].id, { remove: true });
  assert.deepEqual(b.getSnapshot().checklist.map(i => [i.text, i.done]), [['Find the cause', true]]);
  const html = markup(b);
  for (const label of ['Bug', 'Important', 'From 2026-11-03', '1/1', 'Checklist', 'Add label', 'Cover']) assert.match(html, new RegExp(label));
  assert.equal(validNewCard({ columnId: 'c1', title: 'x', type: 'epic' }), false);
  assert.equal(validCardEdit({ expectedVersion: 1, cover: 'gold' }), false);
  for (const allow of [allowedRequest, allowed]) {
    assert.equal(allow('POST', '/api/boards/b1/labels', { name: 'X', color: 'red' }), true);
    assert.equal(allow('PUT', '/api/boards/b1/cards/k1/checklist/i1', { done: true }), true);
    assert.equal(allow('PUT', '/api/boards/b1/cards/k1/checklist/i1', { remove: false }), false);
    assert.equal(allow('DELETE', '/api/boards/b1/cards/k1/checklist/i1', undefined), false);
  }
});

test('desktop task draft is not silently lost when another card or board is opened',async t=>{
 const {b}=await fixture(t);await b.load();const column=b.getSnapshot().columns[0].id;
 await b.addCard(column,'First draft task');await b.addCard(column,'Second draft task');
 assert.equal(b.getSnapshot().boards.find(x=>x.id===b.getSnapshot().boardId).cards,2);
 const [first,second]=b.getSnapshot().cards;
 await b.openCard(first.id);b.editDraft({description:'Unsaved acceptance criteria'});
 assert.equal(b.hasUnsavedDraft(),true);await b.openCard(second.id);
 assert.equal(b.getSnapshot().open,first.id);assert.equal(b.getSnapshot().draft.description,'Unsaved acceptance criteria');
 assert.match(b.getSnapshot().notice,/Save or close/);
 assert.equal(await b.createBoard({name:'Would lose draft',template:b.getSnapshot().templates[0].id,color:'blue',departments:[]}),false);
 assert.equal(await b.saveCard(),true);assert.equal(b.hasUnsavedDraft(),false);
 await b.openCard(second.id);assert.equal(b.getSnapshot().open,second.id);
 assert.equal(b.commentAuthor('user','another-user'),'Team member');
 const html=markup(b);assert.match(html,/Comments/);assert.match(html,/Write a comment/);assert.match(html,/Save changes/);assert.doesNotMatch(html,/<textarea/);
});

test('board timestamps preserve UTC instants across legacy and repeated bridge projections',()=>{
 const path='/api/boards/b1/cards/k1/comments';
 for(const [input,expected] of [['2026-10-22 10:30:00','2026-10-22T10:30:00.000Z'],['2026-10-22T12:30:00+02:00','2026-10-22T10:30:00.000Z']]){
  const result=boardResponse(path,200,{comments:[{id:'note-1',authorKind:'user',authorId:'owner',body:'Review update',createdAt:input}]});
  assert.equal(result.comments[0].createdAt,expected);assert.deepEqual(boardResponse(path,200,result),result);
 }
});

test('department provisioning and overview routes accept only reviewed requests and canonical references',()=>{
 for(const allow of [allowedRequest,allowed]){
  assert.equal(allow('POST','/api/boards/sync-departments',{}),true);
  assert.equal(allow('POST','/api/boards/sync-departments',{departments:['fake']}),false);
  assert.equal(allow('GET','/api/boards/sync-departments',undefined),false);
  assert.equal(allow('GET','/api/boards/b1/overview',undefined),true);
  assert.equal(allow('POST','/api/boards/b1/overview',{}),false);
 }
 const path='/api/boards/b1/overview',body={tasks:[{cardId:'k1',boardId:'source-board',boardName:'Education',title:'Teach',status:'Preparing',priority:'normal',dueDate:null,secret:'hidden'}],total:1,limited:false};
 const view=boardResponse(path,200,body);assert.equal(view.tasks[0].boardId,'source-board');assert.ok(!JSON.stringify(view).includes('hidden'));assert.deepEqual(boardResponse(path,200,view),view);
 assert.throws(()=>boardResponse(path,200,{...body,tasks:[...body.tasks,...body.tasks],total:2}));
});
