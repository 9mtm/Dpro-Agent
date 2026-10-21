require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest, SessionClient } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { memoryDesktopResponse, memoryDesktopPath } = require('../src/memory-desktop-contract.js');
const { memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { MemoryDesktopController, placeScope, tileColour } = require('../src/memory-desktop.ts');
const { MemoryWindow, kindOf } = require('../src/MemoryDesktop.tsx');
const { TrashView, DesignView, DatabasesView } = require('../src/MemoryPlaces.tsx');
const { NeedsYou } = require('../src/MemoryNeeds.tsx');
const { MemoryReviewController } = require('../src/memory-review.ts');
const { AppSettings } = require('../src/AppSettings.tsx');
const { WithSwatches, ContextMenu } = require('../src/desktop-ui.tsx');
const { createLoginMock } = require('../src/session-mock.ts');

const both = (method, path, body) => { const a = allowedRequest(method, path, body), b = allowed(method, path, body); assert.equal(a, b, `${method} ${path} same at both boundaries`); return a; };

/** A fake owner backend: answers by "METHOD path", records every call. */
function backend(routes) {
  const calls = [];
  return { calls, request: async r => { calls.push(`${r.method} ${r.path}`); const h = routes[`${r.method} ${r.path}`]; const out = typeof h === 'function' ? h(r) : h; return out ?? { status: 404, body: { code: 'not_found' } }; } };
}
const flush = () => new Promise(r => setImmediate(r));

test('Trash, groups, design and databases pass both boundaries only with exact bodies', () => {
  for (const [m, p, b] of [
    ['GET', '/api/memory/trash'], ['POST', '/api/memory/m-1/restore'], ['POST', '/api/memory/trash/empty', { confirm: 'EMPTY' }],
    ['POST', '/api/memory/trash/empty', { confirm: 'EMPTY', ids: ['m-1', 'project:old-shop'] }],
    ['GET', '/api/memory/groups'], ['POST', '/api/memory/groups', { name: 'Flowxtra GmbH', projects: ['flowxtra', 'landing'] }],
    ['PATCH', '/api/memory/groups/g-1', { shareWithin: true }], ['DELETE', '/api/memory/groups/g-1'], ['PUT', '/api/memory/groups/g-1/projects', { projects: [] }],
    ['GET', '/api/memory/projects/flowxtra/design'], ['PATCH', '/api/memory/projects/flowxtra/design', { mainLogo: 'assets/brand/logo.svg' }], ['PATCH', '/api/memory/projects/flowxtra/design', { mainLogo: null }],
    ['GET', '/api/memory/projects/flowxtra/databases'], ['PATCH', '/api/memory/projects/flowxtra/databases', { databaseId: 'db-1', level: 'tables' }],
    ['POST', '/api/memory/scopes/projects/flowxtra/trash'], ['POST', '/api/memory/scopes/projects/flowxtra/restore'],
    ['PUT', '/api/memory/retention', { trashDays: 30 }], ['DELETE', '/api/memory/7f591e42-00c6-40dd-863f-38ad847eea3d'],
  ]) assert.equal(both(m, p, b), true, `${m} ${p}`);
  for (const [m, p, b] of [
    ['POST', '/api/memory/trash/empty', {}], ['POST', '/api/memory/trash/empty', { confirm: true }], ['POST', '/api/memory/trash/empty', { confirm: 'EMPTY', ids: [] }],
    ['POST', '/api/memory/trash/empty', { confirm: 'EMPTY', ids: ['a', 'a'] }], ['POST', '/api/memory/m-1/restore', {}], ['GET', '/api/memory/trash?all=1'],
    ['POST', '/api/memory/groups', { name: ' ' }], ['POST', '/api/memory/groups', { name: 'x', projects: ['Flow'] }], ['POST', '/api/memory/groups', { name: 'x', owner: 'y' }],
    ['PATCH', '/api/memory/groups/g-1', {}], ['PUT', '/api/memory/groups/g-1/projects', { projects: ['a', 'a'] }],
    ['PATCH', '/api/memory/projects/flowxtra/design', { notLogo: '../../etc/passwd' }], ['PATCH', '/api/memory/projects/flowxtra/design', { colour: '#fff' }],
    ['PATCH', '/api/memory/projects/flowxtra/databases', { databaseId: 'db-1', level: 'rows' }], ['GET', '/api/memory/projects/Flow/design'],
    ['POST', '/api/memory/scopes/projects/flowxtra/trash', { confirm: true }], ['PUT', '/api/memory/retention', { trashDays: 14 }],
  ]) assert.equal(both(m, p, b), false, `${m} ${p} ${JSON.stringify(b)}`);
});

test('responses keep reviewed fields only, the same when applied twice; refusals keep only known codes', () => {
  const trash = { items: [{ id: 'm-1', kind: 'memory', text: 'Old price 39 €', drawer: 'project:flowxtra', deletedAt: '2026-10-21T10:00:00Z', deletedBy: 'you', forgetAt: '2026-11-20T10:00:00Z', versions: 2, secret: 'x' },
    { id: 'project:old-shop', kind: 'project', text: 'old-shop', drawer: '', deletedAt: '2026-10-18T10:00:00Z', deletedBy: 'you', forgetAt: null, count: 41 }, { id: '../x' }], trashDays: 30 };
  const once = memoryDesktopResponse('/api/memory/trash', 200, trash);
  assert.equal(once.items.length, 2); assert.equal(once.items[0].secret, undefined); assert.equal(once.items[1].count, 41);
  assert.deepEqual(memoryDesktopResponse('/api/memory/trash', 200, once), once);
  const design = memoryDesktopResponse('/api/memory/projects/flowxtra/design', 200, { colours: [{ name: 'Teal', value: '#003f4d', role: 'main' }, { name: 'bad', value: 'url(x)' }], logos: [{ path: 'assets/brand/logo.svg', kind: 'svg', main: true }, { path: '../x' }], fonts: [{ name: 'Inter', use: 'headings' }], rules: ['8 px corners'], sources: ['tailwind.config.js'] });
  assert.equal(design.colours.length, 1); assert.equal(design.logos.length, 1); assert.deepEqual(memoryDesktopResponse('/api/memory/projects/flowxtra/design', 200, design), design);
  const dbs = memoryDesktopResponse('/api/memory/projects/flowxtra/databases', 200, { databases: [{ id: 'db-1', name: 'app.sqlite', kind: 'sqlite', tables: ['users'], tableCount: 24, level: 'exists', password: 'p' }], also: { mcp: 1, skills: 1, ssh: 1 } });
  assert.equal(dbs.databases[0].password, undefined); assert.equal(dbs.also.ssh, 1);
  assert.deepEqual(memoryDesktopResponse('/api/memory/groups', 404, { code: 'not_found', error: 'Route GET:/api/memory/groups not found' }), { code: 'not_found' });
  assert.equal(memoryDesktopResponse('/api/memory/groups', 500, { code: 'boom' }), null);
  assert.deepEqual(memoryPagesResponse('/api/memory/retention', 200, { config: { enabled: true, taskTtlDays: 30, experienceAfterDays: 90, experienceMinGroup: 3, trashDays: 7 } }).config.trashDays, 7);
  assert.equal(memoryDesktopPath('/api/memory/groups/g-1/projects').route, 'group-projects');
});

test('Move to Trash is one request with Undo; Undo restores, or says restore is not available yet', async () => {
  const b = backend({ 'DELETE /api/memory/m-1': { status: 200, body: { success: true } }, 'POST /api/memory/m-1/restore': { status: 200, body: { id: 'm-1', restored: true } } });
  const d = new MemoryDesktopController(b);
  assert.equal(await d.trash([{ id: 'm-1', text: 'Old price 39 €' }]), true);
  assert.match(d.getSnapshot().toast.text, /Moved to Trash: “Old price 39 €”/); assert.equal(d.getSnapshot().toast.undo, true); assert.equal(d.getSnapshot().undoDepth, 1);
  assert.equal(await d.undo(), true); assert.deepEqual(b.calls, ['DELETE /api/memory/m-1', 'POST /api/memory/m-1/restore']);
  assert.match(d.getSnapshot().toast.text, /^Undone/); assert.equal(d.getSnapshot().undoDepth, 0);
  // An older backend has no restore route yet: the notice says so instead of failing quietly.
  const old = backend({ 'DELETE /api/memory/m-2': { status: 200, body: {} } });
  const d2 = new MemoryDesktopController(old);
  await d2.trash([{ id: 'm-2', text: 'x' }]);
  assert.equal(await d2.undo(), false); assert.match(d2.getSnapshot().toast.text, /could not be undone/);
  assert.equal(await d2.undo(), false); assert.equal(d2.getSnapshot().toast.text, 'Nothing to undo.');
});

test('Trash: restore, Forget now and Empty Trash (the only confirmed memory actions); missing route shows "not available yet"', async () => {
  const list = { items: [{ id: 'm-1', kind: 'memory', text: 'Old logo was #0E7490', drawer: 'project:flowxtra', deletedAt: new Date().toISOString(), deletedBy: 'Writer', forgetAt: new Date(Date.now() + 30 * 86400000).toISOString() }], trashDays: 30 };
  const b = backend({ 'GET /api/memory/trash': { status: 200, body: list }, 'POST /api/memory/m-1/restore': { status: 200, body: { restored: true } }, 'POST /api/memory/trash/empty': r => ({ status: 200, body: { forgotten: r.body.ids ? r.body.ids.length : 1 } }) });
  const d = new MemoryDesktopController(b);
  d.open('trash'); await flush(); await flush();
  assert.equal(d.getSnapshot().trash.items.length, 1);
  d.openTrashItem('m-1');
  const html = renderToStaticMarkup(React.createElement(TrashView, { d, onAsk() {} }));
  assert.match(html, />Today</); assert.match(html, /Old logo was <span class="dk-inline-swatch"><span class="dk-swatch" style="background:#0E7490"/); assert.match(html, />Restore</); assert.match(html, />Forget now…</); assert.match(html, />Empty Trash…</);
  assert.equal(await d.restore(d.getSnapshot().trash.items[0]), true); assert.match(d.getSnapshot().toast.text, /Restored to Projects · flowxtra/);
  assert.equal(await d.forgetForGood(['m-1']), true); assert.match(d.getSnapshot().toast.text, /Forgot 1 memory for good/);
  assert.ok(b.calls.includes('POST /api/memory/trash/empty'));
  const none = new MemoryDesktopController(backend({}));
  await none.loadTrash();
  assert.match(renderToStaticMarkup(React.createElement(TrashView, { d: none, onAsk() {} })), /Trash arrives with the next backend update/);
});

test('groups: make by dragging, move in and out, rename, share, ungroup — each undoable; without the backend route nothing is sent', async () => {
  let groups = [{ id: 'g-1', name: 'Flowxtra GmbH', label: 'client', shareWithin: false, projects: ['flowxtra'] }];
  const b = backend({
    'GET /api/memory/groups': () => ({ status: 200, body: { groups } }),
    'POST /api/memory/groups': r => { const g = { id: 'g-2', name: r.body.name, label: null, shareWithin: !!r.body.shareWithin, projects: r.body.projects ?? [] }; groups = [...groups, g]; return { status: 201, body: { group: g } }; },
    'PUT /api/memory/groups/g-1/projects': r => { groups = groups.map(g => g.id === 'g-1' ? { ...g, projects: r.body.projects } : g); return { status: 200, body: { group: groups[0] } }; },
    'PUT /api/memory/groups/g-2/projects': r => { groups = groups.map(g => g.id === 'g-2' ? { ...g, projects: r.body.projects } : g); return { status: 200, body: { group: groups.find(g => g.id === 'g-2') } }; },
    'PATCH /api/memory/groups/g-1': r => { groups = groups.map(g => g.id === 'g-1' ? { ...g, ...r.body } : g); return { status: 200, body: { group: groups[0] } }; },
    'DELETE /api/memory/groups/g-2': () => { groups = groups.filter(g => g.id !== 'g-2'); return { status: 200, body: { id: 'g-2', deleted: true } }; },
  });
  const d = new MemoryDesktopController(b);
  await d.loadGroups();
  assert.equal(await d.createGroup('Dpro products', ['tel-agent', 'seo-agent']), true);
  assert.deepEqual(groups.find(g => g.id === 'g-2').projects, ['tel-agent', 'seo-agent']);
  assert.equal(await d.moveToGroup('tel-agent', 'g-1'), true);
  assert.deepEqual(groups.find(g => g.id === 'g-1').projects, ['flowxtra', 'tel-agent']); assert.deepEqual(groups.find(g => g.id === 'g-2').projects, ['seo-agent']);
  assert.equal(await d.undo(), true, 'undo puts it back');
  assert.deepEqual(groups.find(g => g.id === 'g-2').projects.sort(), ['seo-agent', 'tel-agent']);
  assert.equal(await d.updateGroup('g-1', { shareWithin: true }), true); assert.equal(groups[0].shareWithin, true);
  assert.equal(await d.undo(), true); assert.equal(groups[0].shareWithin, false);
  assert.equal(await d.ungroup('g-2'), true); assert.equal(groups.length, 1);
  assert.equal(await d.undo(), true); assert.equal(groups.length, 2, 'Undo makes the group again');
  const old = backend({}); const d2 = new MemoryDesktopController(old);
  await d2.loadGroups(); assert.equal(d2.getSnapshot().groups, 'missing');
  assert.equal(await d2.createGroup('X', ['a']), false); assert.match(d2.getSnapshot().toast.text, /arrive with the next backend update/);
  assert.deepEqual(old.calls, ['GET /api/memory/groups'], 'nothing is sent while the route is missing');
});

test('pin, bring back an older version and set a database level are undoable; design and databases say "not yet" without the route', async () => {
  const b = backend({
    'POST /api/memory/scopes/pinned': r => ({ status: 201, body: { fact: { id: 'pf-1', scope: r.body.scope, text: r.body.text, position: 0, createdAt: '2026-10-21T10:00:00Z', updatedAt: '2026-10-21T10:00:00Z' } } }),
    'DELETE /api/memory/scopes/pinned/pf-1': { status: 200, body: { ok: true } },
    'PUT /api/memory/m-1': { status: 200, body: { memory: {} } },
  });
  const d = new MemoryDesktopController(b);
  assert.equal(await d.pin('Brand colors: teal #003f4d', 'project:flowxtra'), true);
  assert.match(d.getSnapshot().toast.text, /Pinned for every agent of Projects · flowxtra/);
  assert.equal(await d.undo(), true); assert.ok(b.calls.includes('DELETE /api/memory/scopes/pinned/pf-1'));
  assert.equal(await d.bringBack('m-1', 'now', 'older'), true);
  assert.equal(await d.undo(), true); assert.equal(b.calls.filter(c => c === 'PUT /api/memory/m-1').length, 2);
  d.open('project:flowxtra'); d.setView('design'); d.setView('databases'); await flush(); await flush();
  assert.equal(d.getSnapshot().design, 'missing'); assert.equal(d.getSnapshot().databases, 'missing');
  assert.match(renderToStaticMarkup(React.createElement(DesignView, { d, slug: 'flowxtra' })), /arrives with the next backend update/);
  assert.match(renderToStaticMarkup(React.createElement(DatabasesView, { d, slug: 'flowxtra' })), /arrives with the next backend update/);
  assert.equal(await d.trashProject('flowxtra', 'flowxtra'), false); assert.match(d.getSnapshot().toast.text, /arrives with the next backend update/);
});

test('design shows swatches and logos; databases show kind, table names and the agent level, never a password', async () => {
  const b = backend({
    'GET /api/memory/projects/flowxtra/design': { status: 200, body: { project: 'flowxtra', colours: [{ name: 'Teal', value: '#003f4d', role: 'main' }], fonts: [{ name: 'Inter', use: 'headings' }], logos: [{ path: 'assets/brand/logo.svg', kind: 'svg', main: true, size: 4096 }], rules: ['Buttons: 8 px corners'], sources: ['tailwind.config.js'], designFile: true } },
    'GET /api/memory/projects/flowxtra/databases': { status: 200, body: { project: 'flowxtra', databases: [{ id: 'db-1', name: 'app.sqlite', kind: 'sqlite', from: '.data/app.sqlite', where: '~/flowxtra/.data/app.sqlite', size: 125829120, tables: ['users', 'campaigns'], tableCount: 24, level: 'exists' }], also: { mcp: 1, skills: 1, ssh: 1 } } },
  });
  const d = new MemoryDesktopController(b);
  d.open('project:flowxtra'); d.setView('design'); await flush(); await flush();
  d.openLogo('assets/brand/logo.svg');
  const design = renderToStaticMarkup(React.createElement(DesignView, { d, slug: 'flowxtra' }));
  assert.match(design, /background:#003f4d/); assert.match(design, /Teal \(main\)/); assert.match(design, /logo\.svg · main/); assert.match(design, /Set as the main logo/); assert.match(design, /never moved or changed/);
  d.setView('databases'); await flush(); await flush(); d.openDatabase('db-1');
  const dbs = renderToStaticMarkup(React.createElement(DatabasesView, { d, slug: 'flowxtra' }));
  assert.match(dbs, /app\.sqlite/); assert.match(dbs, /SQLite · \.data\/app\.sqlite · 120 MB · 24 tables/); assert.match(dbs, /users, campaigns/); assert.match(dbs, /Know it exists/); assert.match(dbs, /1 MCP server · 1 skill · 1 SSH host/);
});

test('places map to explorer scopes; kinds become icons and words; colour codes become swatches', () => {
  assert.equal(placeScope('all'), 'company'); assert.equal(placeScope('tasks'), 'kind:task'); assert.equal(placeScope('people'), 'kind:people');
  assert.equal(placeScope('project:flowxtra'), 'project:flowxtra'); assert.equal(placeScope('trash'), null); assert.equal(placeScope('needs'), null);
  assert.deepEqual(kindOf({ type: 'fact', source: 'chat', drawerId: 'owner', sourceAgentId: null }), { icon: 'message', word: 'From a chat' });
  assert.equal(kindOf({ type: 'fact', source: 'memory_file', drawerId: 'project:x', sourceAgentId: null }).word, 'From project notes');
  assert.equal(kindOf({ type: 'insight', source: null, drawerId: 'experience', sourceAgentId: null }).icon, 'bulb');
  assert.equal(tileColour('flowxtra'), tileColour('flowxtra'));
  assert.match(renderToStaticMarkup(React.createElement(WithSwatches, { text: 'teal #003f4d to cyan #00A8CD' })), /background:#003f4d.*background:#00A8CD/);
  assert.equal(renderToStaticMarkup(React.createElement(ContextMenu, { menu: null, onClose() {} })), '');
});

test('the Memory window renders without sending anything; Needs you teaches when empty', async () => {
  const calls = []; const base = createLoginMock();
  const client = new SessionClient({ mock: async r => { calls.push(r); return base(r); } });
  client.selectMode('mock'); await client.login('demo@example.invalid', 'mock-only');
  const before = calls.length;
  const html = renderToStaticMarkup(React.createElement(MemoryWindow, { client }));
  assert.equal(calls.length, before, 'no request from rendering');
  assert.match(html, /class="dk-mem" aria-label="Memory"/);
  const rv = new MemoryReviewController(backend({ 'GET /api/memory/proposals?status=pending': { status: 200, body: { proposals: [] } }, 'GET /api/memory/graph/links?status=pending&limit=500': { status: 200, body: { links: [] } } }));
  await rv.load();
  assert.match(renderToStaticMarkup(React.createElement(NeedsYou, { c: rv, mode: 'one' })), /Nothing needs you/);
});

test('Settings without a sidebar keeps a short row of sections; the owner sees Memory', async () => {
  const base = createLoginMock(); const client = new SessionClient({ mock: base });
  client.selectMode('mock'); await client.login('demo@example.invalid', 'mock-only');
  const html = renderToStaticMarkup(React.createElement(AppSettings, { signedIn: true, client, preference: 'system', onTheme() {}, onAccount() {} }));
  assert.match(html, /Settings sections/);
  if (client.getSnapshot().user.role === 'owner') assert.match(html, />Memory</);
  const memory = renderToStaticMarkup(React.createElement(AppSettings, { signedIn: true, client, preference: 'system', onTheme() {}, onAccount() {}, initialTab: 'memory', initialMemoryPane: 'rules' }));
  if (client.getSnapshot().user.role === 'owner') assert.match(memory, /aria-label="Memory: Rules"/);
});
