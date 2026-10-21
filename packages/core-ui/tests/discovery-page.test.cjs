// DISCOVER-01 (board M17): "Found on this computer" — projects, kinds, states,
// preview before import (with its hash), an MCP secret left out unless chosen,
// ignore / remove / keep, watch settings; the contract allows only these calls.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { discoveryRoute, discoveryResponse, allowedDiscovery } = require('../src/discovery-contract.js');
const { DiscoveryController } = require('../src/discovery-controller.ts');
const { DiscoveryView } = require('../src/Discovery.tsx');

const BASE = '/api/memory/import/discovery';
const R1 = '1'.repeat(32), I = n => String(n).repeat(32).slice(0, 32), H = c => c.repeat(64);
const items = () => [
  { id: I(1), kind: 'memory', name: 'brand-voices', from: 'Claude Code memory · feedback', rootId: R1, to: 'Lessons', state: 'new', updatedAt: '2026-10-21T10:00:00Z' },
  { id: I(2), kind: 'memory', name: 'brand-colors', from: 'Claude Code memory · project', rootId: R1, to: 'Projects · flowxtra', state: 'changed', updatedAt: '2026-10-21T10:00:00Z' },
  { id: I(3), kind: 'mcp', name: 'flowxtra-admin', from: '~/work/flowxtra/.mcp.json · 1 secret inside', rootId: R1, to: 'MCP · off · secret → Credentials', state: 'decision', updatedAt: '' },
  { id: I(4), kind: 'note', name: 'CLAUDE.md', from: 'project notes', rootId: R1, to: 'Projects · flowxtra · read by the local model', state: 'imported', updatedAt: '' },
  { id: I(5), kind: 'memory', name: 'old-server', from: 'no longer on this computer', rootId: R1, to: 'Projects · flowxtra', state: 'gone', updatedAt: '' },
  { id: I(6), kind: 'ssh', name: 'devbox', from: '~/.ssh/config', rootId: null, to: 'SSH hosts · names only', state: 'new', updatedAt: '' },
  { id: I(7), kind: 'skill', name: 'writer', from: '~/.claude/skills/writer/SKILL.md', rootId: null, to: 'Skills · off until assigned', state: 'imported', updatedAt: '' },
];
function backend() {
  const calls = []; let list = items();
  let kinds = { notes: true, tools: true, skills: true, mcp: true, ssh: true }; let groups = [];
  const P = (n, name, extra) => ({ id: String(n).repeat(32).slice(0, 32), name, path: `~/${name}`, kind: 'home', state: null, inherited: null, hasChildren: true, ...extra });
  const top = [P('a', 'Documents'), P('b', 'Desktop'), P('c', 'Work drive', { kind: 'drive', path: '/Volumes/Work drive' })];
  const kids = [P('d', 'Projects', { kind: 'folder', inherited: 'allow' }), P('e', 'Personal', { kind: 'folder', inherited: 'allow' })];
  const view = () => ({ scannedAt: new Date().toISOString(), ms: 1900, leftOut: 261, allowedFolders: 1, settings: { watch: true, intervalMinutes: 30, kinds }, file: '/secret/path',
    suggestions: [{ key: 'f'.repeat(32), a: { id: R1, name: 'flowxtra' }, b: { id: '9'.repeat(32), name: 'landdingpage_flowxtra' }, reason: 'one name is inside the other' }],
    roots: [{ id: 'computer', name: 'This computer', path: null, project: 'not a project · SSH, user skills', count: 2, fresh: 1, watch: true }, { id: R1, name: 'flowxtra', path: '~/work/flowxtra', project: 'Dpro project Flowxtra', count: 5, fresh: 3, watch: true }, { id: '9'.repeat(32), name: 'landdingpage_flowxtra', path: '~/work/landdingpage_flowxtra', project: 'Projects · landdingpage-flowxtra', count: 1, fresh: 1, watch: true }, ...groups],
    items: list });
  const client = { request: async r => {
    calls.push(r);
    assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`); assert.ok(allowed(r.method, r.path, r.body), `bridge ${r.method} ${r.path}`);
    const out = (body, status = 200) => ({ status, body: discoveryResponse(r.path, status, discoveryResponse(r.path, status, body)) });
    const path = r.path;
    if (path === BASE || path === `${BASE}/scan`) return out(view());
    const item = /items\/([a-f0-9]{32})$/.exec(path);
    if (item) { const it = list.find(x => x.id === item[1]); return out({ item: { ...it, text: it.kind === 'mcp' ? '{ "env": { "FLOWXTRA_TOKEN": "••••••••" } }' : 'Brand voices never mix.', truncated: false, secrets: it.kind === 'mcp' ? ['FLOWXTRA_TOKEN'] : [], blocked: null, previewHash: H(item[1][0]) } }); }
    if (path === `${BASE}/import`) { for (const i of r.body.items) list = list.map(x => (x.id === i.id ? { ...x, state: 'imported' } : x)); return out({ results: r.body.items.map(i => ({ id: i.id, ok: true, state: 'imported' })) }); }
    const act = /items\/([a-f0-9]{32})\/(ignore|remove|keep)$/.exec(path);
    if (act) { list = list.map(x => (x.id === act[1] ? { ...x, state: act[2] === 'keep' ? 'imported' : 'ignored' } : x)); return out(act[2] === 'ignore' ? { id: act[1], ignored: r.body.on } : act[2] === 'remove' ? { id: act[1], removed: true } : { id: act[1], kept: true }); }
    if (path === `${BASE}/settings`) return out({ settings: r.body });
    if (path === `${BASE}/places`) return out(r.method === 'GET' ? { places: top } : r.method === 'PUT' ? { allowed: (r.body.allow ?? []).length, removed: (r.body.deny ?? []).length, excluded: (r.body.exclude ?? []).length } : { place: P('z', 'Added', { kind: 'added', state: 'allow' }) });
    if (path.startsWith(`${BASE}/places?parent=`)) return out({ places: kids });
    if (/places\/[a-f0-9]{32}\/count$/.test(path)) return out({ id: path.split('/')[6], files: 18400, bytes: 12e9, capped: false });
    if (path === `${BASE}/kinds`) { kinds = { ...kinds, ...r.body }; return out({ kinds }); }
    if (/roots\/.+\/hidden$/.test(path)) return out({ id: path.split('/')[6], kind: r.body.kind, hidden: r.body.on });
    if (path === `${BASE}/groups`) { groups = [{ id: '8'.repeat(32), name: r.body.name, path: '~/a  +  ~/b', project: 'Projects · x', count: 6, fresh: 4, watch: true, group: { members: r.body.roots.map(id => ({ id, name: id.slice(0, 4), path: '~/' + id.slice(0, 4) })) } }]; return out({ group: { id: '8'.repeat(32), name: r.body.name, slug: 'x', folders: 2 } }); }
    if (/groups\/[a-f0-9]{32}$/.test(path)) { groups = []; return out({ id: path.split('/').pop(), separated: true }); }
    if (/suggestions\/[a-f0-9]{32}\/dismiss$/.test(path)) return out({ key: path.split('/')[6], dismissed: true });
    if (path.startsWith(`${BASE}/roots/`)) return out({ id: path.split('/').pop(), watch: r.body.watch });
    return { status: 404, body: null };
  } };
  return { client, calls };
}

test('contract: only these calls; responses keep reviewed fields and are stable twice', () => {
  for (const [m, p, b, ok] of [['GET', BASE, undefined, true], ['POST', `${BASE}/scan`, undefined, true], ['GET', `${BASE}/items/${I(1)}`, undefined, true], ['GET', `${BASE}/items/../etc`, undefined, false],
    ['POST', `${BASE}/import`, { items: [{ id: I(1), previewHash: H('a') }] }, true], ['POST', `${BASE}/import`, { items: [{ id: I(1), previewHash: 'x' }] }, false], ['POST', `${BASE}/import`, { items: [] }, false],
    ['POST', `${BASE}/import`, { items: [{ id: I(1), previewHash: H('a'), path: '/etc' }] }, false], ['PUT', `${BASE}/settings`, { watch: true, intervalMinutes: 45 }, false], ['PUT', `${BASE}/roots/computer`, { watch: false }, true],
    ['POST', `${BASE}/items/${I(1)}/ignore`, { on: true }, true], ['POST', `${BASE}/items/${I(1)}/remove`, { force: true }, false]])
    assert.equal(allowedDiscovery(m, p, b), ok, `${m} ${p}`);
  assert.ok(discoveryRoute(BASE) && !discoveryRoute('/api/memory/import/local'));
  const body = { scannedAt: 'x', ms: 3, settings: { watch: true, intervalMinutes: 30 }, roots: [{ id: R1, name: 'a', path: '~/a', project: 'p', count: 1, fresh: 1, file: '/x' }], items: [{ ...items()[0], file: '/secret/path' }, { id: 'bad', kind: 'memory' }] };
  const once = discoveryResponse(BASE, 200, body);
  assert.equal(once.items.length, 1); assert.ok(!JSON.stringify(once).includes('/secret/path'));
  assert.deepEqual(discoveryResponse(BASE, 200, once), once);
});

test('the page: projects with new counts, kinds and states, where each item goes (board M17)', async () => {
  const { client } = backend();
  const c = new DiscoveryController(client);
  await c.load();
  assert.equal(c.getSnapshot().rootId, R1, 'opens on the first project with something new');
  const html = renderToStaticMarkup(React.createElement(DiscoveryView, { c, active: false }));
  for (const words of ['By project folder', 'This computer', 'flowxtra', '3 new', 'Found on this computer', 'Dpro only reads; your files never change', 'Scan now', 'Watch', '30 min',
    'Memory files', 'Project notes', 'MCP servers', 'SSH hosts', 'Needs your decision', 'Gone from this computer', 'Dpro project Flowxtra', '~/work/flowxtra', 'Stop watching this project',
    'brand-voices', 'Lessons', 'Changed', 'Update', 'Review', 'Keep', 'Import selected', 'Memory files go in as they are (no model)', 'Rules of this page', '261 files were left out: copies, archives and other people', 'private SSH keys, .env files'])
    assert.ok(html.includes(words), words);
  c.setKind('memory'); assert.deepEqual(c.shown().map(i => i.name), ['brand-voices', 'brand-colors', 'old-server']);
  c.setState('changed'); assert.deepEqual(c.shown().map(i => i.name), ['brand-colors']);
  c.setKind('all'); c.setState('all'); c.setRoot('computer'); assert.deepEqual(c.shown().map(i => i.name), ['devbox', 'writer']);
});

test('import selected previews each item first and sends its hash; an MCP secret is left out unless chosen', async () => {
  const { client, calls } = backend();
  const c = new DiscoveryController(client);
  await c.load();
  c.toggle(I(1)); c.toggle(I(3));
  await c.importIds(c.getSnapshot().selected);
  const post = calls.find(r => r.path === `${BASE}/import`);
  assert.deepEqual(post.body, { items: [{ id: I(1), previewHash: H('1') }, { id: I(3), previewHash: H('3'), secret: 'leave' }] });
  assert.match(c.getSnapshot().result, /2 imported/);
  assert.equal(c.getSnapshot().selected.length, 0);
});

test('the opened MCP server: secret names only, the owner chooses Credentials, added switched off', async () => {
  const { client, calls } = backend();
  const c = new DiscoveryController(client);
  await c.load();
  await c.open(I(3));
  const html = renderToStaticMarkup(React.createElement(DiscoveryView, { c, active: false }));
  for (const words of ['A secret was found (FLOWXTRA_TOKEN)', 'Save it in Credentials (encrypted)', 'Leave it on this computer only', 'Add server (off)', 'switched off', '••••••••'])
    assert.ok(html.includes(words), words);
  c.setSecret('credentials');
  await c.importOpen();
  assert.deepEqual(calls.filter(r => r.path === `${BASE}/import`).pop().body, { items: [{ id: I(3), previewHash: H('3'), secret: 'credentials' }] });
  assert.equal(c.getSnapshot().preview, null, 'closed after import');
});

test('ignore, remove (from the opened item), keep, watch settings, stop watching a project', async () => {
  const { client, calls } = backend();
  const c = new DiscoveryController(client);
  await c.load();
  await c.ignore(I(1), true);
  assert.match(c.getSnapshot().result, /Ignored/);
  await c.open(I(4));
  let html = renderToStaticMarkup(React.createElement(DiscoveryView, { c, active: false }));
  assert.ok(html.includes('Read again') && !html.includes('>Remove from Dpro</button>'), 'notes are read again, not removed one by one');
  c.setRoot('computer'); await c.open(I(7));
  html = renderToStaticMarkup(React.createElement(DiscoveryView, { c, active: false }));
  assert.ok(html.includes('>Remove from Dpro</button>'));
  await c.remove(I(7));
  assert.match(c.getSnapshot().result, /file on this computer is unchanged/);
  await c.keep(I(5));
  await c.setWatch(true, 15);
  assert.deepEqual(calls.find(r => r.path === `${BASE}/settings`).body, { watch: true, intervalMinutes: 15 });
  await c.setRootWatch(R1, false);
  assert.deepEqual(calls.find(r => r.path === `${BASE}/roots/${R1}`).body, { watch: false });
});

test('a slow first read (504) is asked again, not shown as an error', async () => {
  const { client } = backend(); let first = true;
  const slow = { request: async r => { if (first && r.path === BASE) { first = false; return { status: 504, body: null }; } return client.request(r); } };
  const c = new DiscoveryController(slow);
  await c.load();
  assert.equal(c.getSnapshot().phase, 'ready');
});

test('folders: tick several, allow them at once; leave a subfolder out; count; what to read (board M18)', async () => {
  const { client, calls } = backend();
  const c = new DiscoveryController(client);
  await c.load(); await c.loadPlaces();
  let html = renderToStaticMarkup(React.createElement(DiscoveryView, { c, active: false }));
  for (const words of ['Folders Dpro may read', 'Documents', 'Work drive', 'drive', 'What to read', 'Agent notes (.md)', 'Agent commands and sub-agents', 'Word, PDF, Excel and images: later.', 'Never read, even in an allowed folder', '+ Add a drive or folder'])
    assert.ok(html.includes(words), words);
  const [docs, desk, work] = c.getSnapshot().places.top;
  c.tick(docs, true); c.tick(work, true);
  html = renderToStaticMarkup(React.createElement(DiscoveryView, { c, active: false }));
  assert.ok(html.includes('Allow 2 folders'));
  await c.applyPlaces();
  assert.deepEqual(calls.find(r => r.path === `${BASE}/places` && r.method === 'PUT').body, { allow: [docs.id, work.id] });
  assert.deepEqual(c.getSnapshot().places.ticks, {});
  await c.openPlace(docs.id);
  const personal = c.getSnapshot().places.children[docs.id].find(p => p.name === 'Personal');
  assert.equal(c.ticked(personal), true, 'inside an allowed folder');
  c.tick(personal, false); await c.applyPlaces();
  assert.deepEqual(calls.filter(r => r.path === `${BASE}/places` && r.method === 'PUT').pop().body, { exclude: [personal.id] });
  await c.count(desk.id);
  assert.match(c.getSnapshot().places.counts[desk.id], /18,400 files · 12\.0 GB/);
  await c.setFileKind('ssh', false);
  assert.deepEqual(calls.find(r => r.path === `${BASE}/kinds`).body, { ssh: false });
  await c.addPlace('/Volumes/Backup');
  assert.deepEqual(calls.find(r => r.path === `${BASE}/places` && r.method === 'POST').body, { path: '/Volumes/Backup' });
});

test("don't show: one item, several, a kind from a project; merge two projects and separate; suggestions", async () => {
  const { client, calls } = backend();
  const c = new DiscoveryController(client);
  await c.load();
  let html = renderToStaticMarkup(React.createElement(DiscoveryView, { c, active: false })).replace(/&#x27;/g, "'");
  for (const words of ["Don't show again", 'Merge with…', 'Suggested merges', 'flowxtra + landdingpage_flowxtra', 'Not the same']) assert.ok(html.includes(words), words);
  c.toggle(I(1)); c.toggle(I(2)); await c.ignoreMany(c.getSnapshot().selected);
  assert.equal(calls.filter(r => /\/ignore$/.test(r.path)).length, 2);
  c.setKind('memory');
  html = renderToStaticMarkup(React.createElement(DiscoveryView, { c, active: false })).replace(/&#x27;/g, "'");
  assert.ok(html.includes("Don't show memory files from this project"));
  await c.hideKind(R1, 'memory', true);
  assert.deepEqual(calls.find(r => /hidden$/.test(r.path)).body, { kind: 'memory', on: true });
  c.startMerge([R1, '9'.repeat(32)], 'Flowxtra all');
  html = renderToStaticMarkup(React.createElement(DiscoveryView, { c, active: false })).replace(/&#x27;/g, "'");
  for (const words of ['Show as one project', 'Merge 2 folders', 'The folders stay where they are', 'Merge into one project']) assert.ok(html.includes(words), words);
  await c.merge();
  assert.deepEqual(calls.find(r => r.path === `${BASE}/groups`).body, { name: 'Flowxtra all', roots: [R1, '9'.repeat(32)] });
  assert.equal(c.getSnapshot().rootId, '8'.repeat(32), 'opens the merged project');
  html = renderToStaticMarkup(React.createElement(DiscoveryView, { c, active: false })).replace(/&#x27;/g, "'");
  assert.ok(html.includes('Separate again') && html.includes('One project made of'));
  await c.separate('8'.repeat(32));
  assert.ok(calls.some(r => r.method === 'DELETE'));
  await c.dismissSuggestion(c.getSnapshot().view.suggestions[0]);
  assert.ok(calls.some(r => /dismiss$/.test(r.path)));
});
